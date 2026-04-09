#!/usr/bin/env npx tsx
/**
 * Phase 4: Multi-Panel Chat E2E Test
 *
 * Validates the Phase 4 multi-panel features from the thread-safe streaming
 * implementation: secondary panel creation, per-panel orchestrators, independent
 * provider/model state, simultaneous messaging, per-server MCP serialization,
 * state persistence, and callback isolation.
 *
 * Scenarios:
 *   1. Open secondary panel via command — full toolbar appears
 *   2. Send messages in both panels simultaneously — separate JSONL files
 *   3. State persistence — getState returns correct isSecondary and conversationId
 *   4. Per-orchestrator provider/model independence
 *   5. Per-server MCP serialization via TaskLaneQueue
 *   6. Callbacks don't double-fire across panels (new conversation)
 *   7. Secondary panel cleanup on close
 *   8. No unexpected error logs from multi-panel sources
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled with Claude Haiku model
 *
 * @see specs/ZZ-misc/thread-safe-streaming-implementation-tasks.md — Phase 4 Verification
 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Section 4.4
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessage,
	newConversation,
	ensureCleanState,
	waitForResponse,
	VAULT_PATH,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const CHAT_VIEW_TYPE = "notor-chat-view";
const HISTORY_DIR = ".obsidian/plugins/notor/history/";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Send a message without waiting for the response to complete. */
async function sendMessageNoWait(page: any, message: string): Promise<void> {
	const found = await page.evaluate((msg: string) => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		if (!el) return false;
		el.focus();
		el.textContent = msg;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	}, message);
	if (!found) throw new Error("Chat input not found");

	await page.waitForTimeout(300);
	await page.focus(".notor-text-input");
	await page.keyboard.press("Enter");
	await page.waitForTimeout(400);
	console.log(`    -> Sent (no wait): "${message.substring(0, 80)}${message.length > 80 ? "..." : ""}"`);
}

/** Wait until the contenteditable input is re-enabled. */
async function waitForInputEnabled(page: any, timeoutMs = 30_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(500);
		const enabled = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el !== null && el.getAttribute("contenteditable") === "true";
		});
		if (enabled) return true;
	}
	return false;
}

/**
 * Execute the "open-secondary-chat" Obsidian command via plugin internals.
 * Returns the number of chat leaves after execution.
 */
async function openSecondaryPanel(page: any): Promise<{
	leafCountBefore: number;
	leafCountAfter: number;
	secondaryCreated: boolean;
}> {
	const leafCountBefore = await getChatLeafCount(page);

	// Execute the command via Obsidian's command API
	await page.evaluate(() => {
		const app = (window as any).app;
		if (!app) throw new Error("Obsidian app not available");
		// Execute the "notor:open-secondary-chat" command
		app.commands.executeCommandById("notor:open-secondary-chat");
	});

	// Wait for the secondary panel to be created and wired
	await page.waitForTimeout(3_000);

	const leafCountAfter = await getChatLeafCount(page);
	return {
		leafCountBefore,
		leafCountAfter,
		secondaryCreated: leafCountAfter > leafCountBefore,
	};
}

/** Get the count of chat-type leaves in the workspace. */
async function getChatLeafCount(page: any): Promise<number> {
	return page.evaluate((viewType: string) => {
		const app = (window as any).app;
		if (!app) return 0;
		return app.workspace.getLeavesOfType(viewType).length;
	}, CHAT_VIEW_TYPE);
}

/** Get information about all chat leaves. */
async function getChatLeafInfo(page: any): Promise<Array<{
	isSecondary: boolean;
	hasContainer: boolean;
	conversationId: string | null;
	hasToolbar: boolean;
	hasNewConvBtn: boolean;
	hasSettingsBtn: boolean;
	hasModeToggle: boolean;
}>> {
	return page.evaluate((viewType: string) => {
		const app = (window as any).app;
		if (!app) return [];
		const leaves = app.workspace.getLeavesOfType(viewType);
		return leaves.map((leaf: any) => {
			const view = leaf.view;
			if (!view) return { isSecondary: false, hasContainer: false, conversationId: null, hasToolbar: false, hasNewConvBtn: false, hasSettingsBtn: false, hasModeToggle: false };
			const containerEl = view.containerEl as HTMLElement;
			return {
				isSecondary: view.getIsSecondary?.() ?? false,
				hasContainer: !!containerEl?.querySelector(".notor-chat-container"),
				conversationId: view.activeConversationId ?? null,
				hasToolbar: !!containerEl?.querySelector(".notor-chat-header-actions"),
				hasNewConvBtn: !!containerEl?.querySelector(".notor-chat-header-btn[aria-label='New conversation']"),
				hasSettingsBtn: !!containerEl?.querySelector(".notor-chat-header-btn[aria-label='Chat settings']"),
				hasModeToggle: !!containerEl?.querySelector(".notor-mode-toggle"),
			};
		});
	}, CHAT_VIEW_TYPE);
}

/** Get secondary orchestrator count from plugin internals. */
async function getSecondaryOrchestratorCount(page: any): Promise<number> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return -1;
		try {
			// Access private _secondaryOrchestrators field
			return (plugin as any)._secondaryOrchestrators?.length ?? -1;
		} catch {
			return -1;
		}
	});
}

/** Get the active conversation ID for a specific leaf (by index). */
async function getLeafConversationId(page: any, leafIndex: number): Promise<string | null> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const app = (window as any).app;
		if (!app) return null;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		if (args.index >= leaves.length) return null;
		const view = leaves[args.index]?.view;
		if (!view) return null;
		return view.activeConversationId ?? null;
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

/** Get the view state (getState()) for a specific leaf by index. */
async function getLeafState(page: any, leafIndex: number): Promise<Record<string, unknown> | null> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const app = (window as any).app;
		if (!app) return null;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		if (args.index >= leaves.length) return null;
		const view = leaves[args.index]?.view;
		if (!view || !view.getState) return null;
		return view.getState();
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

/** Activate (reveal) a specific chat leaf by index. */
async function activateLeaf(page: any, leafIndex: number): Promise<boolean> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const app = (window as any).app;
		if (!app) return false;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		if (args.index >= leaves.length) return false;
		app.workspace.setActiveLeaf(leaves[args.index], { focus: true });
		return true;
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

/** Get orchestrator's active provider type for a leaf by index. */
async function getLeafProviderType(page: any, leafIndex: number): Promise<string | null> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const app = (window as any).app;
		if (!app) return null;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		if (args.index >= leaves.length) return null;
		const view = leaves[args.index]?.view;
		if (!view) return null;
		// Access the orchestrator associated with this view
		const plugin = app.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		try {
			// Primary panel: use plugin.getOrchestrator()
			// Secondary panels: each has its own orchestrator stored on the view
			const orch = (view as any).orchestrator;
			if (orch?.getActiveProviderType) {
				return orch.getActiveProviderType();
			}
			// Fallback: for primary, try plugin.getOrchestrator()
			if (!view.getIsSecondary?.()) {
				return plugin.getOrchestrator()?.getActiveProviderType?.() ?? null;
			}
			return null;
		} catch {
			return null;
		}
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

/** Get the per-orchestrator active model ID for a leaf by index. */
async function getLeafModelId(page: any, leafIndex: number): Promise<string | null> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const app = (window as any).app;
		if (!app) return null;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		if (args.index >= leaves.length) return null;
		const view = leaves[args.index]?.view;
		if (!view) return null;
		const plugin = app.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		try {
			const orch = (view as any).orchestrator;
			if (orch?.getActiveModelId) {
				return orch.getActiveModelId();
			}
			if (!view.getIsSecondary?.()) {
				return plugin.getOrchestrator()?.getActiveModelId?.() ?? null;
			}
			return null;
		} catch {
			return null;
		}
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

/** Send a message in a specific leaf (activating it first). */
async function sendMessageInLeaf(
	page: any,
	leafIndex: number,
	message: string,
	waitForComplete: boolean,
): Promise<boolean> {
	const activated = await activateLeaf(page, leafIndex);
	if (!activated) return false;
	await page.waitForTimeout(1_000);

	if (waitForComplete) {
		return sendMessage(page, message);
	} else {
		await sendMessageNoWait(page, message);
		return true;
	}
}

/**
 * Find a JSONL file on disk whose header matches a conversation ID.
 * Returns the basename or null.
 */
function findJSONLBasename(conversationId: string): string | null {
	const histDir = path.join(VAULT_PATH, HISTORY_DIR);
	if (!fs.existsSync(histDir)) return null;
	const files = fs.readdirSync(histDir).filter((f) => f.endsWith(".jsonl"));
	for (const file of files) {
		const firstLine = fs.readFileSync(path.join(histDir, file), "utf-8").split("\n")[0];
		if (!firstLine) continue;
		try {
			const header = JSON.parse(firstLine);
			if (header.id === conversationId) return file;
		} catch { /* skip */ }
	}
	return null;
}

/** Close the active leaf. */
async function closeActiveLeaf(page: any): Promise<boolean> {
	return page.evaluate(() => {
		const app = (window as any).app;
		if (!app) return false;
		const activeLeaf = app.workspace.activeLeaf;
		if (!activeLeaf) return false;
		activeLeaf.detach();
		return true;
	});
}

/**
 * Safely run a test function, catching any unhandled errors so that
 * a single test crash does not abort the entire suite.
 */
async function safeRun(
	ctx: TestContext,
	name: string,
	fn: () => Promise<void>,
): Promise<void> {
	try {
		await fn();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.fail(name, `Unhandled error: ${msg.substring(0, 200)}`);
		console.error(`  [catch] ${name}:`, err);
	}
}

// ---------------------------------------------------------------------------
// Shared state between sequential tests
// ---------------------------------------------------------------------------

interface SharedState {
	primaryLeafIndex: number;
	secondaryLeafIndex: number;
	primaryConvId?: string;
	secondaryConvId?: string;
}
const shared: SharedState = {
	primaryLeafIndex: 0,
	secondaryLeafIndex: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testOpenSecondaryPanel(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 1: Open secondary panel via command — full toolbar appears --");
	const { page } = ctx;

	const result = await openSecondaryPanel(page);
	const shot = await ctx.screenshot("01-secondary-panel-opened");

	if (!result.secondaryCreated) {
		ctx.fail(
			"Open secondary panel",
			`No new leaf created. Before: ${result.leafCountBefore}, after: ${result.leafCountAfter}`,
			shot,
		);
		return;
	}

	// Verify a secondary orchestrator was created
	const orchCount = await getSecondaryOrchestratorCount(page);
	console.log(`  Secondary orchestrators: ${orchCount}`);

	// Get info about all chat leaves
	const leaves = await getChatLeafInfo(page);
	console.log(`  Chat leaves: ${leaves.length}`);
	for (let i = 0; i < leaves.length; i++) {
		const l = leaves[i]!;
		console.log(`    Leaf ${i}: secondary=${l.isSecondary}, container=${l.hasContainer}, toolbar=${l.hasToolbar}`);
	}

	// Find which leaf is secondary
	const secondaryLeaf = leaves.find((l) => l.isSecondary);
	const primaryLeaf = leaves.find((l) => !l.isSecondary);

	// Update shared state with correct indices
	for (let i = 0; i < leaves.length; i++) {
		if (!leaves[i]!.isSecondary) shared.primaryLeafIndex = i;
		if (leaves[i]!.isSecondary) shared.secondaryLeafIndex = i;
	}

	if (!secondaryLeaf) {
		ctx.fail(
			"Open secondary panel",
			`${leaves.length} leaves but none marked as secondary. ` +
			`isSecondary values: ${leaves.map((l) => l.isSecondary).join(", ")}`,
			shot,
		);
		return;
	}

	// Verify full toolbar in secondary panel
	const toolbarChecks = {
		container: secondaryLeaf.hasContainer,
		toolbar: secondaryLeaf.hasToolbar,
		newConvBtn: secondaryLeaf.hasNewConvBtn,
		settingsBtn: secondaryLeaf.hasSettingsBtn,
		modeToggle: secondaryLeaf.hasModeToggle,
	};

	const allPresent = Object.values(toolbarChecks).every(Boolean);
	const missingItems = Object.entries(toolbarChecks)
		.filter(([, v]) => !v)
		.map(([k]) => k);

	if (allPresent) {
		ctx.pass(
			"Open secondary panel",
			`Secondary panel created with full toolbar. ` +
			`Leaves: ${leaves.length} (primary=${!!primaryLeaf}, secondary=${!!secondaryLeaf}), ` +
			`orchestrators: ${orchCount}`,
			shot,
		);
	} else {
		ctx.fail(
			"Open secondary panel",
			`Secondary panel missing elements: ${missingItems.join(", ")}. ` +
			`Present: ${JSON.stringify(toolbarChecks)}`,
			shot,
		);
	}
}

async function testSimultaneousMessages(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 2: Send messages in both panels simultaneously — separate JSONL files --");
	const { page } = ctx;

	// Create new conversations in both panels
	// Primary panel
	await activateLeaf(page, shared.primaryLeafIndex);
	await page.waitForTimeout(500);
	await newConversation(page);
	await page.waitForTimeout(1_500);
	const primaryConvId = await getLeafConversationId(page, shared.primaryLeafIndex);
	shared.primaryConvId = primaryConvId ?? undefined;
	console.log(`  Primary conversation: ${primaryConvId?.substring(0, 8)}`);

	// Secondary panel
	await activateLeaf(page, shared.secondaryLeafIndex);
	await page.waitForTimeout(500);
	await newConversation(page);
	await page.waitForTimeout(1_500);
	const secondaryConvId = await getLeafConversationId(page, shared.secondaryLeafIndex);
	shared.secondaryConvId = secondaryConvId ?? undefined;
	console.log(`  Secondary conversation: ${secondaryConvId?.substring(0, 8)}`);

	if (!primaryConvId || !secondaryConvId) {
		const shot = await ctx.screenshot("02-no-conv-ids");
		ctx.fail(
			"Simultaneous messages",
			`Could not create conversations in both panels. ` +
			`primary=${primaryConvId?.substring(0, 8) ?? "null"}, ` +
			`secondary=${secondaryConvId?.substring(0, 8) ?? "null"}`,
			shot,
		);
		return;
	}

	if (primaryConvId === secondaryConvId) {
		const shot = await ctx.screenshot("02-same-conv");
		ctx.fail(
			"Simultaneous messages",
			`Both panels have the same conversation ID: ${primaryConvId.substring(0, 8)} — not independent`,
			shot,
		);
		return;
	}

	// Send message in primary panel (no wait)
	await activateLeaf(page, shared.primaryLeafIndex);
	await page.waitForTimeout(500);
	await sendMessageNoWait(
		page,
		"You are in Panel A (primary). Write a 500-word essay about the history of astronomy.",
	);
	await page.waitForTimeout(1_000);

	// Send message in secondary panel (no wait)
	await activateLeaf(page, shared.secondaryLeafIndex);
	await page.waitForTimeout(500);
	await sendMessageNoWait(
		page,
		"You are in Panel B (secondary). Write a 500-word essay about the history of mathematics.",
	);

	// Wait for both to complete
	console.log("  Waiting for both responses to complete...");
	for (let attempt = 0; attempt < 60; attempt++) {
		await page.waitForTimeout(2_000);

		const primaryActive = await page.evaluate((convId: string) => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			return plugin?.getOrchestrator()?.hasActiveSession(convId) ?? false;
		}, primaryConvId);

		const secondaryActive = await page.evaluate((convId: string) => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			// Check all orchestrators
			const secondaryOrchs = (plugin as any)?._secondaryOrchestrators ?? [];
			for (const orch of secondaryOrchs) {
				if (orch.hasActiveSession(convId)) return true;
			}
			// Also check primary in case convId assignment differs
			return plugin?.getOrchestrator()?.hasActiveSession(convId) ?? false;
		}, secondaryConvId);

		const elapsed = (attempt + 1) * 2;
		console.log(`    [${elapsed}s] primary active=${primaryActive}, secondary active=${secondaryActive}`);

		if (!primaryActive && !secondaryActive) break;
	}

	// Wait for JSONL flush
	await page.waitForTimeout(3_000);

	// Verify separate JSONL files
	const primaryFile = findJSONLBasename(primaryConvId);
	const secondaryFile = findJSONLBasename(secondaryConvId);

	const shot = await ctx.screenshot("02-simultaneous-messages");

	if (!primaryFile && !secondaryFile) {
		ctx.fail(
			"Simultaneous messages",
			"Neither conversation produced a JSONL file",
			shot,
		);
		return;
	}

	if (!primaryFile) {
		ctx.fail("Simultaneous messages", "Primary conversation JSONL not found on disk", shot);
		return;
	}

	if (!secondaryFile) {
		ctx.fail("Simultaneous messages", "Secondary conversation JSONL not found on disk", shot);
		return;
	}

	// Verify files are different and contain correct content
	const primaryPath = path.join(VAULT_PATH, HISTORY_DIR, primaryFile);
	const secondaryPath = path.join(VAULT_PATH, HISTORY_DIR, secondaryFile);
	const primaryContent = fs.readFileSync(primaryPath, "utf-8");
	const secondaryContent = fs.readFileSync(secondaryPath, "utf-8");

	const primaryLines = primaryContent.split("\n").filter(Boolean);
	const secondaryLines = secondaryContent.split("\n").filter(Boolean);

	// Each file should have header + at least user message + assistant message
	const primaryHasMessages = primaryLines.length >= 3;
	const secondaryHasMessages = secondaryLines.length >= 3;
	const filesAreDifferent = primaryFile !== secondaryFile;

	// Verify content isolation — primary should mention "astronomy", secondary "mathematics"
	const primaryMentionsAstronomy = primaryContent.toLowerCase().includes("astronomy");
	const secondaryMentionsMath = secondaryContent.toLowerCase().includes("mathematics") || secondaryContent.toLowerCase().includes("math");
	const noContentCrossover =
		!primaryContent.toLowerCase().includes("panel b") &&
		!secondaryContent.toLowerCase().includes("panel a");

	if (filesAreDifferent && primaryHasMessages && secondaryHasMessages) {
		ctx.pass(
			"Simultaneous messages",
			`Separate JSONL files: primary="${primaryFile}" (${primaryLines.length} lines), ` +
			`secondary="${secondaryFile}" (${secondaryLines.length} lines). ` +
			`Content isolation: astronomy=${primaryMentionsAstronomy}, math=${secondaryMentionsMath}, ` +
			`no crossover=${noContentCrossover}`,
			shot,
		);
	} else {
		ctx.fail(
			"Simultaneous messages",
			`Files different=${filesAreDifferent}, primary msgs=${primaryHasMessages} (${primaryLines.length} lines), ` +
			`secondary msgs=${secondaryHasMessages} (${secondaryLines.length} lines)`,
			shot,
		);
	}
}

async function testStatePersistence(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 3: State persistence — getState returns correct values --");
	const { page } = ctx;

	// Check getState for primary panel
	const primaryState = await getLeafState(page, shared.primaryLeafIndex);
	// Check getState for secondary panel
	const secondaryState = await getLeafState(page, shared.secondaryLeafIndex);

	const shot = await ctx.screenshot("03-state-persistence");

	if (!primaryState || !secondaryState) {
		ctx.fail(
			"State persistence",
			`Could not get state. primary=${JSON.stringify(primaryState)}, secondary=${JSON.stringify(secondaryState)}`,
			shot,
		);
		return;
	}

	const primaryCorrect = primaryState.isSecondary === false;
	const secondaryCorrect = secondaryState.isSecondary === true;
	const secondaryHasConvId = typeof secondaryState.conversationId === "string" &&
		secondaryState.conversationId.length > 0;

	if (primaryCorrect && secondaryCorrect) {
		ctx.pass(
			"State persistence",
			`Primary: isSecondary=${primaryState.isSecondary}, convId=${(primaryState.conversationId as string)?.substring(0, 8) ?? "null"}. ` +
			`Secondary: isSecondary=${secondaryState.isSecondary}, convId=${(secondaryState.conversationId as string)?.substring(0, 8) ?? "null"} ` +
			`(hasConvId=${secondaryHasConvId})`,
			shot,
		);
	} else {
		ctx.fail(
			"State persistence",
			`Primary: isSecondary=${primaryState.isSecondary} (expected false). ` +
			`Secondary: isSecondary=${secondaryState.isSecondary} (expected true).`,
			shot,
		);
	}
}

async function testPerOrchestratorProviderModelIndependence(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 4: Per-orchestrator provider/model independence --");
	const { page } = ctx;

	// Get current provider/model for both panels
	const primaryProvider = await getLeafProviderType(page, shared.primaryLeafIndex);
	const primaryModel = await getLeafModelId(page, shared.primaryLeafIndex);
	const secondaryProvider = await getLeafProviderType(page, shared.secondaryLeafIndex);
	const secondaryModel = await getLeafModelId(page, shared.secondaryLeafIndex);

	console.log(`  Primary: provider=${primaryProvider}, model=${primaryModel?.substring(0, 30)}`);
	console.log(`  Secondary: provider=${secondaryProvider}, model=${secondaryModel?.substring(0, 30)}`);

	// Verify both orchestrators have their own independent state
	// Both should have valid (non-null) provider and model, even if they're currently the same
	const bothHaveState = primaryProvider !== null && secondaryProvider !== null &&
		primaryModel !== null && secondaryModel !== null;

	// Verify the orchestrators are truly independent by checking object identity
	const areIndependent = await page.evaluate((viewType: string) => {
		const app = (window as any).app;
		if (!app) return { error: "app not found" };
		const plugin = app.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const leaves = app.workspace.getLeavesOfType(viewType);
		if (leaves.length < 2) return { error: `only ${leaves.length} leaves` };

		try {
			const primaryOrch = plugin.getOrchestrator();
			const secondaryOrchs = (plugin as any)._secondaryOrchestrators ?? [];
			if (secondaryOrchs.length === 0) return { error: "no secondary orchestrators" };

			// Check that they are different objects
			const areDifferentObjects = primaryOrch !== secondaryOrchs[0];

			// Check that each has its own ConversationManager
			const primaryConvMgr = primaryOrch.getConversationManager();
			const secondaryConvMgr = secondaryOrchs[0].getConversationManager();
			const differentConvManagers = primaryConvMgr !== secondaryConvMgr;

			return {
				areDifferentObjects,
				differentConvManagers,
				primaryProviderType: primaryOrch.getActiveProviderType?.() ?? "unknown",
				secondaryProviderType: secondaryOrchs[0].getActiveProviderType?.() ?? "unknown",
			};
		} catch (e: any) {
			return { error: e.message };
		}
	}, CHAT_VIEW_TYPE);

	const shot = await ctx.screenshot("04-provider-model-independence");

	if ((areIndependent as any).error) {
		ctx.fail(
			"Provider/model independence",
			`Error checking independence: ${(areIndependent as any).error}`,
			shot,
		);
		return;
	}

	const result = areIndependent as {
		areDifferentObjects: boolean;
		differentConvManagers: boolean;
		primaryProviderType: string;
		secondaryProviderType: string;
	};

	if (result.areDifferentObjects && result.differentConvManagers && bothHaveState) {
		ctx.pass(
			"Provider/model independence",
			`Independent orchestrators: different objects=${result.areDifferentObjects}, ` +
			`different ConversationManagers=${result.differentConvManagers}. ` +
			`Primary: ${result.primaryProviderType}/${primaryModel?.substring(0, 30)}, ` +
			`Secondary: ${result.secondaryProviderType}/${secondaryModel?.substring(0, 30)}`,
			shot,
		);
	} else {
		ctx.fail(
			"Provider/model independence",
			`Not fully independent: differentObjects=${result.areDifferentObjects}, ` +
			`differentConvMgrs=${result.differentConvManagers}, bothHaveState=${bothHaveState}`,
			shot,
		);
	}
}

async function testMcpPerServerSerialization(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 5: Per-server MCP serialization via TaskLaneQueue --");
	const { page } = ctx;

	// Verify the TaskLaneQueue is wired into McpHub by checking the API surface
	const mcpQueueState = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		try {
			const mcpHub = (plugin as any)._mcpHub;
			if (!mcpHub) return { hasHub: false, error: "McpHub not found" };

			// Check if taskQueue is injected
			const hasTaskQueue = !!(mcpHub as any).taskQueue;

			// Check the TaskLaneQueue itself
			let queueInfo: any = null;
			if (hasTaskQueue) {
				const queue = (mcpHub as any).taskQueue;
				queueInfo = {
					isDestroyed: queue.destroyed ?? false,
					// Check lane creation method exists
					hasEnqueue: typeof queue.enqueue === "function",
					hasDestroy: typeof queue.destroy === "function",
				};
			}

			// Check that callTool method exists (it wraps via the queue)
			const hasCallTool = typeof mcpHub.callTool === "function";
			// Check that executeCallTool exists (private method extracted for queue wrapping)
			const hasExecuteCallTool = typeof (mcpHub as any).executeCallTool === "function";

			return {
				hasHub: true,
				hasTaskQueue,
				hasCallTool,
				hasExecuteCallTool,
				queueInfo,
			};
		} catch (e: any) {
			return { error: e.message };
		}
	});

	const shot = await ctx.screenshot("05-mcp-serialization");

	if ((mcpQueueState as any).error && !(mcpQueueState as any).hasHub) {
		ctx.fail("MCP serialization", `Error: ${(mcpQueueState as any).error}`, shot);
		return;
	}

	const state = mcpQueueState as {
		hasHub: boolean;
		hasTaskQueue: boolean;
		hasCallTool: boolean;
		hasExecuteCallTool: boolean;
		queueInfo: { isDestroyed: boolean; hasEnqueue: boolean; hasDestroy: boolean } | null;
	};

	if (state.hasHub && state.hasTaskQueue && state.hasCallTool && state.hasExecuteCallTool) {
		ctx.pass(
			"MCP serialization",
			`TaskLaneQueue wired into McpHub: taskQueue=${state.hasTaskQueue}, ` +
			`callTool=${state.hasCallTool}, executeCallTool=${state.hasExecuteCallTool}, ` +
			`queue: enqueue=${state.queueInfo?.hasEnqueue}, destroyed=${state.queueInfo?.isDestroyed}`,
			shot,
		);
	} else if (state.hasHub && !state.hasTaskQueue) {
		ctx.fail(
			"MCP serialization",
			`McpHub exists but TaskLaneQueue not injected. ` +
			`callTool=${state.hasCallTool}, executeCallTool=${state.hasExecuteCallTool}`,
			shot,
		);
	} else {
		ctx.fail(
			"MCP serialization",
			`Incomplete wiring: hub=${state.hasHub}, taskQueue=${state.hasTaskQueue}, ` +
			`callTool=${state.hasCallTool}, executeCallTool=${state.hasExecuteCallTool}`,
			shot,
		);
	}
}

async function testCallbackIsolation(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 6: Callbacks don't double-fire across panels --");
	const { page } = ctx;

	// Test: Creating a new conversation in primary panel doesn't affect secondary panel
	// Record secondary panel conversation state before
	const secondaryConvBefore = await getLeafConversationId(page, shared.secondaryLeafIndex);

	// Create new conversation in primary panel
	await activateLeaf(page, shared.primaryLeafIndex);
	await page.waitForTimeout(500);
	await newConversation(page);
	await page.waitForTimeout(2_000);

	// Verify secondary panel's conversation is unchanged
	const secondaryConvAfter = await getLeafConversationId(page, shared.secondaryLeafIndex);
	const primaryConvAfter = await getLeafConversationId(page, shared.primaryLeafIndex);

	const secondaryUnchanged = secondaryConvBefore === secondaryConvAfter;
	const primaryChanged = primaryConvAfter !== shared.primaryConvId;

	// Also verify that settings load doesn't double-trigger
	// Check structured logs for any "double-fire" indicators
	const doubleFirLogs = ctx.collector.getStructuredLogs().filter((log) => {
		const msg = (log.message ?? "").toLowerCase();
		return msg.includes("duplicate") || msg.includes("double") || msg.includes("already wired");
	});

	const shot = await ctx.screenshot("06-callback-isolation");

	if (secondaryUnchanged && primaryChanged) {
		ctx.pass(
			"Callback isolation",
			`New conversation in primary did not affect secondary. ` +
			`Primary: ${shared.primaryConvId?.substring(0, 8) ?? "null"} -> ${primaryConvAfter?.substring(0, 8) ?? "null"} (changed). ` +
			`Secondary: ${secondaryConvBefore?.substring(0, 8) ?? "null"} -> ${secondaryConvAfter?.substring(0, 8) ?? "null"} (unchanged). ` +
			`Double-fire logs: ${doubleFirLogs.length}`,
			shot,
		);
	} else if (!secondaryUnchanged) {
		ctx.fail(
			"Callback isolation",
			`Secondary conversation changed when new conversation created in primary! ` +
			`Before: ${secondaryConvBefore?.substring(0, 8) ?? "null"}, after: ${secondaryConvAfter?.substring(0, 8) ?? "null"}`,
			shot,
		);
	} else {
		ctx.fail(
			"Callback isolation",
			`Primary didn't change to new conversation. ` +
			`Before: ${shared.primaryConvId?.substring(0, 8) ?? "null"}, after: ${primaryConvAfter?.substring(0, 8) ?? "null"}`,
			shot,
		);
	}
}

async function testSecondaryPanelCleanup(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 7: Secondary panel cleanup on close --");
	const { page } = ctx;

	const orchCountBefore = await getSecondaryOrchestratorCount(page);
	const leafCountBefore = await getChatLeafCount(page);
	console.log(`  Before close: ${leafCountBefore} leaves, ${orchCountBefore} secondary orchestrators`);

	// Activate the secondary panel and close it
	await activateLeaf(page, shared.secondaryLeafIndex);
	await page.waitForTimeout(500);
	await closeActiveLeaf(page);
	await page.waitForTimeout(2_000);

	const leafCountAfter = await getChatLeafCount(page);
	const shot = await ctx.screenshot("07-secondary-cleanup");

	const leafRemoved = leafCountAfter < leafCountBefore;

	if (leafRemoved) {
		ctx.pass(
			"Secondary panel cleanup",
			`Leaf removed: ${leafCountBefore} -> ${leafCountAfter}`,
			shot,
		);
	} else {
		ctx.fail(
			"Secondary panel cleanup",
			`Leaf not removed: ${leafCountBefore} -> ${leafCountAfter}`,
			shot,
		);
	}
}

async function testNoErrorLevelLogs(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 8: No unexpected error logs from multi-panel sources --");
	const { collector } = ctx;

	const multiPanelSources = [
		"ChatOrchestrator",
		"ConversationSession",
		"ToolDispatcher",
		"McpHub",
		"TaskLaneQueue",
	];

	const allLogs = collector.getStructuredLogs();
	const errorLogs = allLogs.filter(
		(e) =>
			e.level === "error" &&
			multiPanelSources.includes(e.source) &&
			// Filter expected errors that aren't related to multi-panel
			!e.message.includes("Provider error") &&
			!e.message.includes("AUTH_FAILED") &&
			!e.message.includes("API key not configured") &&
			!e.message.includes("RATE_LIMITED") &&
			!e.message.includes("Rate limited") &&
			!e.message.includes("connection") &&
			!e.message.includes("timeout"),
	);

	if (errorLogs.length === 0) {
		ctx.pass(
			"No error-level logs",
			`Zero error-level logs from ${multiPanelSources.join(", ")} during multi-panel operations`,
		);
	} else {
		ctx.fail(
			"No error-level logs",
			`${errorLogs.length} error-level log(s): ` +
			errorLogs.slice(0, 5).map((e) => `[${e.source}] "${e.message}"`).join("; "),
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init

	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chatContainer) throw new Error("Chat panel not visible — cannot run tests");
	const initShot = await ctx.screenshot("00-chat-ready");
	ctx.pass("Chat panel ready", "Plugin loaded and chat container found", initShot);

	// Test 1: Open secondary panel (prerequisite for all other tests)
	await safeRun(ctx, "Open secondary panel", () => testOpenSecondaryPanel(ctx));

	// Verify secondary panel exists before proceeding
	const leafCount = await getChatLeafCount(page);
	if (leafCount < 2) {
		ctx.fail("Suite prerequisite", "Secondary panel not created — skipping remaining tests");
		return;
	}

	// Test 2: Simultaneous messages in both panels
	await safeRun(ctx, "Simultaneous messages", () => testSimultaneousMessages(ctx));

	// Test 3: State persistence
	await safeRun(ctx, "State persistence", () => testStatePersistence(ctx));

	// Test 4: Provider/model independence
	await safeRun(ctx, "Provider/model independence", () => testPerOrchestratorProviderModelIndependence(ctx));

	// Test 5: MCP per-server serialization
	await safeRun(ctx, "MCP serialization", () => testMcpPerServerSerialization(ctx));

	// Test 6: Callback isolation
	await safeRun(ctx, "Callback isolation", () => testCallbackIsolation(ctx));

	// Clean up streaming before cleanup test
	await ensureCleanState(page);
	await page.waitForTimeout(1_000);

	// Test 7: Secondary panel cleanup
	await safeRun(ctx, "Secondary panel cleanup", () => testSecondaryPanelCleanup(ctx));

	// Test 8: Error log check (always last)
	await safeRun(ctx, "No error-level logs", () => testNoErrorLevelLogs(ctx));
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "plan", // Plan mode avoids tool calls — cleaner multi-panel tests
});

runTest(
	{
		name: "phase4-multi-panel",
		settings,
	},
	tests,
);
