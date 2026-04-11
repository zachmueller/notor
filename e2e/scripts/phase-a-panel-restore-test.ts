#!/usr/bin/env npx tsx
/**
 * Phase A Verification: Panel Restore Test (AV.1)
 *
 * Validates Bug A fix — reopening a closed panel doesn't destroy the primary
 * panel's conversation state. In the old primary/secondary model, the
 * registerView factory called wireView() before setState(), which overwrote
 * the primary orchestrator's view pointer and loaded history into the wrong
 * panel. The unified view model (Phase A) eliminates this structurally — each
 * panel gets its own orchestrator from creation.
 *
 * Scenarios:
 *   1. Create conversation with messages in the first panel
 *   2. Open second panel — verify independent orchestrators in registry
 *   3. Close second panel — verify first panel state preserved
 *   4. Reopen panel via workspace restore — verify first panel STILL preserved
 *   5. Restored panel loaded independently with correct conversation
 *   6. Orchestrator registry consistent after restore cycle
 *   7. No unexpected error logs from panel lifecycle
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — AV.1
 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Bug A
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessage,
	newConversation,
	ensureCleanState,
	writeCleanWorkspace,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const CHAT_VIEW_TYPE = "notor-chat-view";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

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

async function getChatLeafCount(page: any): Promise<number> {
	return page.evaluate((viewType: string) => {
		const app = (window as any).app;
		if (!app) return 0;
		return app.workspace.getLeavesOfType(viewType).length;
	}, CHAT_VIEW_TYPE);
}

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

/** Get conversation ID for a specific leaf by index using the new unified registry. */
async function getLeafConversationId(page: any, leafIndex: number): Promise<string | null> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const app = (window as any).app;
		if (!app) return null;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		if (args.index >= leaves.length) return null;
		const view = leaves[args.index]?.view;
		return view?.activeConversationId ?? null;
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

/** Get orchestrator registry size from plugin internals. */
async function getOrchestratorRegistrySize(page: any): Promise<number> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return -1;
		return (plugin as any)._orchestrators?.size ?? -1;
	});
}

/** Verify a leaf has its own orchestrator in the registry. */
async function leafHasOrchestrator(page: any, leafIndex: number): Promise<boolean> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const app = (window as any).app;
		if (!app) return false;
		const plugin = app.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		if (args.index >= leaves.length) return false;
		const orch = (plugin as any)._orchestrators?.get(leaves[args.index].id);
		return !!orch;
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

/** Count rendered messages in the active panel. */
async function getRenderedMessageCount(page: any): Promise<number> {
	return page.evaluate(() => {
		const user = document.querySelectorAll(".notor-message-user").length;
		const assistant = document.querySelectorAll(".notor-message-assistant").length;
		return user + assistant;
	});
}

/** Open a new chat panel by executing the command. */
async function openSecondaryPanel(page: any): Promise<boolean> {
	const before = await getChatLeafCount(page);
	await page.evaluate(() => {
		(window as any).app?.commands?.executeCommandById("notor:open-secondary-chat");
	});
	await page.waitForTimeout(3_000);
	const after = await getChatLeafCount(page);
	return after > before;
}

/**
 * Simulate workspace restore by creating a new leaf with a saved view state.
 * This mimics what Obsidian does when reopening a closed panel (Cmd+Shift+T).
 */
async function restorePanelWithState(
	page: any,
	savedConversationId: string | null,
): Promise<boolean> {
	return page.evaluate(async (args: { viewType: string; convId: string | null }) => {
		const app = (window as any).app;
		if (!app) return false;
		const leaf = app.workspace.getLeaf("split");
		await leaf.setViewState({
			type: args.viewType,
			state: args.convId ? { conversationId: args.convId } : {},
		});
		return true;
	}, { viewType: CHAT_VIEW_TYPE, convId: savedConversationId });
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

interface SharedState {
	primaryConvId?: string;
	primaryMessageCount?: number;
	secondaryConvId?: string;
}
const shared: SharedState = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSetupConversation(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 1: Create conversation with messages in first panel --");
	const { page } = ctx;

	const responded = await sendMessage(page, "Hello! This is conversation A. Reply briefly.");
	if (!responded) {
		const shot = await ctx.screenshot("01-no-response");
		ctx.fail("Setup conversation", "LLM did not respond within timeout", shot);
		return;
	}

	await page.waitForTimeout(2_000);

	const convId = await getLeafConversationId(page, 0);
	const msgCount = await getRenderedMessageCount(page);
	shared.primaryConvId = convId ?? undefined;
	shared.primaryMessageCount = msgCount;

	const shot = await ctx.screenshot("01-conversation-created");

	if (convId && msgCount >= 2) {
		ctx.pass(
			"Setup conversation",
			`Conversation A created: id=${convId.substring(0, 8)}, ${msgCount} messages rendered`,
			shot,
		);
	} else {
		ctx.fail(
			"Setup conversation",
			`convId=${convId?.substring(0, 8) ?? "null"}, messages=${msgCount} (expected >=2)`,
			shot,
		);
	}
}

async function testOpenSecondPanel(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 2: Open second panel — independent orchestrators --");
	const { page } = ctx;

	const opened = await openSecondaryPanel(page);
	if (!opened) {
		const shot = await ctx.screenshot("02-no-secondary");
		ctx.fail("Open second panel", "Failed to open second chat panel", shot);
		return;
	}

	const leafCount = await getChatLeafCount(page);
	const registrySize = await getOrchestratorRegistrySize(page);
	const leaf0HasOrch = await leafHasOrchestrator(page, 0);
	const leaf1HasOrch = await leafHasOrchestrator(page, 1);

	// Check that orchestrators are distinct objects
	const orchestratorsDistinct = await page.evaluate((viewType: string) => {
		const app = (window as any).app;
		if (!app) return false;
		const plugin = app.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		const leaves = app.workspace.getLeavesOfType(viewType);
		if (leaves.length < 2) return false;
		const orch0 = (plugin as any)._orchestrators?.get(leaves[0].id);
		const orch1 = (plugin as any)._orchestrators?.get(leaves[1].id);
		return !!orch0 && !!orch1 && orch0 !== orch1;
	}, CHAT_VIEW_TYPE);

	// Record secondary conversation ID
	const secondaryConvId = await getLeafConversationId(page, 1);
	shared.secondaryConvId = secondaryConvId ?? undefined;

	const shot = await ctx.screenshot("02-second-panel-opened");

	if (leafCount === 2 && registrySize === 2 && leaf0HasOrch && leaf1HasOrch && orchestratorsDistinct) {
		ctx.pass(
			"Open second panel",
			`${leafCount} leaves, ${registrySize} orchestrators in registry, all distinct. ` +
			`Secondary convId=${secondaryConvId?.substring(0, 8) ?? "new"}`,
			shot,
		);
	} else {
		ctx.fail(
			"Open second panel",
			`leaves=${leafCount}, registry=${registrySize}, leaf0Orch=${leaf0HasOrch}, ` +
			`leaf1Orch=${leaf1HasOrch}, distinct=${orchestratorsDistinct}`,
			shot,
		);
	}
}

async function testCloseSecondPanel(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 3: Close second panel — first panel state preserved --");
	const { page } = ctx;

	// Activate and close the second panel
	await activateLeaf(page, 1);
	await page.waitForTimeout(500);
	await closeActiveLeaf(page);
	await page.waitForTimeout(2_000);

	const leafCount = await getChatLeafCount(page);
	const registrySize = await getOrchestratorRegistrySize(page);

	// Verify first panel still shows conversation A
	await activateLeaf(page, 0);
	await page.waitForTimeout(500);
	const convId = await getLeafConversationId(page, 0);
	const msgCount = await getRenderedMessageCount(page);

	const shot = await ctx.screenshot("03-after-close");

	const convPreserved = convId === shared.primaryConvId;
	const msgsPreserved = msgCount >= (shared.primaryMessageCount ?? 2);

	if (convPreserved && msgsPreserved && leafCount === 1) {
		ctx.pass(
			"Close second panel — state preserved",
			`Panel 1 still shows convA (${convId?.substring(0, 8)}), ` +
			`${msgCount} messages. Registry: ${registrySize} orchestrator(s)`,
			shot,
		);
	} else {
		ctx.fail(
			"Close second panel — state preserved",
			`convPreserved=${convPreserved} (${convId?.substring(0, 8)} vs ${shared.primaryConvId?.substring(0, 8)}), ` +
			`msgsPreserved=${msgsPreserved} (${msgCount} vs ${shared.primaryMessageCount}), leaves=${leafCount}`,
			shot,
		);
	}
}

async function testRestorePanel(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 4: Restore panel via workspace restore — first panel STILL preserved --");
	const { page } = ctx;

	// Simulate workspace restore: create a new leaf with saved state
	// This triggers the registerView factory → setState flow that caused Bug A
	const restored = await restorePanelWithState(page, shared.secondaryConvId ?? null);
	if (!restored) {
		const shot = await ctx.screenshot("04-restore-failed");
		ctx.fail("Restore panel", "Failed to restore panel via setViewState", shot);
		return;
	}

	// Wait for factory + setState + loadConversation to complete
	await page.waitForTimeout(5_000);

	const leafCount = await getChatLeafCount(page);
	const registrySize = await getOrchestratorRegistrySize(page);

	// THE CRITICAL CHECK: panel 1 must still show conversation A
	// In the old model, this is where the primary panel's state was destroyed
	await activateLeaf(page, 0);
	await page.waitForTimeout(1_000);
	const panel1ConvId = await getLeafConversationId(page, 0);
	const panel1Msgs = await getRenderedMessageCount(page);

	const shot = await ctx.screenshot("04-after-restore");

	const panel1Preserved = panel1ConvId === shared.primaryConvId;
	const panel1MsgsOk = panel1Msgs >= (shared.primaryMessageCount ?? 2);

	if (panel1Preserved && panel1MsgsOk && leafCount === 2) {
		ctx.pass(
			"Restore panel — first panel preserved",
			`Panel 1 still shows convA (${panel1ConvId?.substring(0, 8)}), ` +
			`${panel1Msgs} messages. ${leafCount} leaves, ${registrySize} orchestrators`,
			shot,
		);
	} else {
		ctx.fail(
			"Restore panel — first panel preserved",
			`panel1Preserved=${panel1Preserved} (${panel1ConvId?.substring(0, 8)} vs ${shared.primaryConvId?.substring(0, 8)}), ` +
			`msgs=${panel1Msgs} (expected >=${shared.primaryMessageCount}), leaves=${leafCount}`,
			shot,
		);
	}
}

async function testRestoredPanelIndependent(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 5: Restored panel loaded independently --");
	const { page } = ctx;

	const leafCount = await getChatLeafCount(page);
	if (leafCount < 2) {
		ctx.fail("Restored panel independent", "Less than 2 panels exist — restore may have failed");
		return;
	}

	// Check the restored panel (index 1) has its own orchestrator
	const leaf1HasOrch = await leafHasOrchestrator(page, 1);
	const leaf1ConvId = await getLeafConversationId(page, 1);
	const panel0ConvId = await getLeafConversationId(page, 0);

	// Verify the two panels have different orchestrator instances
	const orchestratorsDistinct = await page.evaluate((viewType: string) => {
		const app = (window as any).app;
		if (!app) return false;
		const plugin = app.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		const leaves = app.workspace.getLeavesOfType(viewType);
		if (leaves.length < 2) return false;
		const orch0 = (plugin as any)._orchestrators?.get(leaves[0].id);
		const orch1 = (plugin as any)._orchestrators?.get(leaves[1].id);
		return !!orch0 && !!orch1 && orch0 !== orch1;
	}, CHAT_VIEW_TYPE);

	const shot = await ctx.screenshot("05-restored-independent");

	if (leaf1HasOrch && orchestratorsDistinct) {
		ctx.pass(
			"Restored panel independent",
			`Restored panel has own orchestrator (distinct=${orchestratorsDistinct}). ` +
			`Panel 0 conv=${panel0ConvId?.substring(0, 8)}, ` +
			`Panel 1 conv=${leaf1ConvId?.substring(0, 8) ?? "loading"}`,
			shot,
		);
	} else {
		ctx.fail(
			"Restored panel independent",
			`leaf1HasOrch=${leaf1HasOrch}, distinct=${orchestratorsDistinct}`,
			shot,
		);
	}
}

async function testRegistryConsistency(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 6: Orchestrator registry consistent --");
	const { page } = ctx;

	const result = await page.evaluate((viewType: string) => {
		const app = (window as any).app;
		if (!app) return { error: "app not found" };
		const plugin = app.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const leaves = app.workspace.getLeavesOfType(viewType);
		const registry = (plugin as any)._orchestrators;
		if (!registry) return { error: "no registry" };

		const leafIds = leaves.map((l: any) => l.id);
		const registryIds = Array.from(registry.keys());

		// Every leaf should have an orchestrator
		const allLeavesHaveOrch = leafIds.every((id: string) => registry.has(id));
		// Registry should not have stale entries for non-existent leaves
		const allRegistryIdsExist = registryIds.every((id: string) =>
			leaves.some((l: any) => l.id === id),
		);

		return {
			leafCount: leaves.length,
			registrySize: registry.size,
			allLeavesHaveOrch,
			allRegistryIdsExist,
			leafIds,
			registryIds,
		};
	}, CHAT_VIEW_TYPE);

	const shot = await ctx.screenshot("06-registry-consistency");

	if ((result as any).error) {
		ctx.fail("Registry consistency", `Error: ${(result as any).error}`, shot);
		return;
	}

	const r = result as {
		leafCount: number;
		registrySize: number;
		allLeavesHaveOrch: boolean;
		allRegistryIdsExist: boolean;
	};

	if (r.allLeavesHaveOrch && r.allRegistryIdsExist && r.leafCount === r.registrySize) {
		ctx.pass(
			"Registry consistency",
			`${r.leafCount} leaves, ${r.registrySize} orchestrators — 1:1 mapping verified`,
			shot,
		);
	} else {
		ctx.fail(
			"Registry consistency",
			`leaves=${r.leafCount}, registry=${r.registrySize}, ` +
			`allHaveOrch=${r.allLeavesHaveOrch}, noStale=${r.allRegistryIdsExist}`,
			shot,
		);
	}
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 7: No unexpected error logs from panel lifecycle --");
	const { collector } = ctx;

	const relevantSources = [
		"ChatOrchestrator",
		"NotorChatView",
		"ChatView",
		"HistoryManager",
		"ConversationSession",
	];

	const errorLogs = collector.getStructuredLogs().filter(
		(e) =>
			e.level === "error" &&
			relevantSources.some((src) => e.source.includes(src)) &&
			!e.message.includes("Provider error") &&
			!e.message.includes("AUTH_FAILED") &&
			!e.message.includes("API key not configured") &&
			!e.message.includes("RATE_LIMITED") &&
			!e.message.includes("connection") &&
			!e.message.includes("timeout"),
	);

	if (errorLogs.length === 0) {
		ctx.pass(
			"No unexpected errors",
			`Zero error-level logs from ${relevantSources.join(", ")} during panel lifecycle`,
		);
	} else {
		ctx.fail(
			"No unexpected errors",
			`${errorLogs.length} error(s): ` +
			errorLogs.slice(0, 5).map((e) => `[${e.source}] "${e.message}"`).join("; "),
		);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chatContainer) throw new Error("Chat panel not visible — cannot run tests");
	const initShot = await ctx.screenshot("00-chat-ready");
	ctx.pass("Chat panel ready", "Plugin loaded and chat container found", initShot);

	await safeRun(ctx, "Setup conversation", () => testSetupConversation(ctx));
	if (!shared.primaryConvId) {
		ctx.fail("Suite prerequisite", "No conversation created — skipping remaining tests");
		return;
	}

	await safeRun(ctx, "Open second panel", () => testOpenSecondPanel(ctx));
	await safeRun(ctx, "Close second panel", () => testCloseSecondPanel(ctx));
	await safeRun(ctx, "Restore panel", () => testRestorePanel(ctx));
	await safeRun(ctx, "Restored panel independent", () => testRestoredPanelIndependent(ctx));
	await safeRun(ctx, "Registry consistency", () => testRegistryConsistency(ctx));
	await safeRun(ctx, "No unexpected errors", () => testNoUnexpectedErrors(ctx));
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "plan",
});

runTest({
	name: "phase-a-panel-restore",
	settings,
	setupVault: (vaultPath) => writeCleanWorkspace(vaultPath),
}, tests);
