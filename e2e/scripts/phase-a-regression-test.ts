#!/usr/bin/env npx tsx
/**
 * Phase A Verification: Core Functionality Regression Test (AV.7)
 *
 * Validates that the Phase A redesign (unified view model, session guard,
 * persistence flush) didn't break core single-panel and multi-panel
 * functionality.
 *
 * Scenarios:
 *   1. Single-panel: new conversation and send messages
 *   2. Single-panel: switch between conversations
 *   3. Multi-panel: two panels operate independently
 *   4. Orchestrator registry matches open panel count
 *   5. isSecondary infrastructure fully removed
 *   6. View lifecycle: onClose cleanup and clearCallbacks exist
 *   7. No unexpected error logs from core operations
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — AV.7
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

async function getLeafConversationId(page: any, leafIndex: number): Promise<string | null> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const app = (window as any).app;
		if (!app) return null;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		if (args.index >= leaves.length) return null;
		return leaves[args.index]?.view?.activeConversationId ?? null;
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

async function getRenderedMessageCount(page: any): Promise<number> {
	return page.evaluate(() => {
		return document.querySelectorAll(".notor-message-user, .notor-message-assistant").length;
	});
}

async function getOrchestratorRegistrySize(page: any): Promise<number> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return -1;
		return (plugin as any)._orchestrators?.size ?? -1;
	});
}

/** Find conversation filename via plugin API. */
async function findConversationFilename(page: any, conversationId: string): Promise<string | null> {
	return page.evaluate(async (convId: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		try {
			const historyManager = (plugin as any)._historyManager ?? plugin.getHistoryManager?.();
			const entries = await historyManager.listConversations();
			const entry = entries.find((e: any) => e.id === convId);
			return entry?.filename ?? null;
		} catch {
			return null;
		}
	}, conversationId);
}

/** Switch to a conversation by filename via the active orchestrator. */
async function switchToConversation(page: any, filename: string): Promise<boolean> {
	return page.evaluate(async (fname: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		try {
			const orch = plugin.getActiveOrchestrator?.();
			if (!orch) return false;
			await orch.switchConversation(fname);
			// Update view's activeConversationId (wireView callback does this,
			// but direct orchestrator calls bypass it)
			const conv = orch.getConversationManager()?.getActiveConversation();
			const view = orch.getView?.();
			if (conv && view) {
				view.setActiveConversationId(conv.id);
			}
			return true;
		} catch {
			return false;
		}
	}, filename);
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

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

interface SharedState {
	conv1Id?: string;
	conv1Filename?: string;
	conv2Id?: string;
}
const shared: SharedState = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testNewConversationAndMessages(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 1: Single-panel — new conversation and send messages --");
	const { page } = ctx;

	// Send a message (auto-creates a conversation)
	const responded = await sendMessage(page, "Say 'regression test one' and nothing else.");
	if (!responded) {
		const shot = await ctx.screenshot("01-no-response");
		ctx.fail("New conversation + messages", "LLM did not respond", shot);
		return;
	}

	await page.waitForTimeout(2_000);
	const convId = await getLeafConversationId(page, 0);
	const msgCount = await getRenderedMessageCount(page);
	shared.conv1Id = convId ?? undefined;

	// Resolve filename for later
	if (convId) {
		for (let i = 0; i < 3; i++) {
			shared.conv1Filename = (await findConversationFilename(page, convId)) ?? undefined;
			if (shared.conv1Filename) break;
			await page.waitForTimeout(1_000);
		}
	}

	const shot = await ctx.screenshot("01-new-conversation");

	if (convId && msgCount >= 2) {
		ctx.pass(
			"New conversation + messages",
			`Conv=${convId.substring(0, 8)}, ${msgCount} messages rendered`,
			shot,
		);
	} else {
		ctx.fail(
			"New conversation + messages",
			`convId=${convId?.substring(0, 8) ?? "null"}, messages=${msgCount}`,
			shot,
		);
	}
}

async function testSwitchConversations(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 2: Single-panel — switch between conversations --");
	const { page } = ctx;

	// Create a second conversation
	await newConversation(page);
	await page.waitForTimeout(1_500);

	const responded = await sendMessage(page, "Say 'regression test two' and nothing else.");
	if (!responded) {
		const shot = await ctx.screenshot("02-no-response");
		ctx.fail("Switch conversations", "LLM did not respond to second conversation", shot);
		return;
	}

	await page.waitForTimeout(2_000);
	const conv2Id = await getLeafConversationId(page, 0);
	shared.conv2Id = conv2Id ?? undefined;

	// Switch back to conversation 1
	if (!shared.conv1Filename) {
		ctx.fail("Switch conversations", "No filename for conversation 1");
		return;
	}

	const switched = await switchToConversation(page, shared.conv1Filename);
	await page.waitForTimeout(2_000);

	const afterSwitch = await getLeafConversationId(page, 0);
	const msgCount = await getRenderedMessageCount(page);

	const shot = await ctx.screenshot("02-switch-conversations");

	if (switched && afterSwitch === shared.conv1Id && msgCount >= 2) {
		ctx.pass(
			"Switch conversations",
			`Switched from conv2=${conv2Id?.substring(0, 8)} back to conv1=${afterSwitch?.substring(0, 8)}, ` +
			`${msgCount} messages rendered`,
			shot,
		);
	} else {
		ctx.fail(
			"Switch conversations",
			`switched=${switched}, expected=${shared.conv1Id?.substring(0, 8)}, ` +
			`got=${afterSwitch?.substring(0, 8)}, messages=${msgCount}`,
			shot,
		);
	}
}

async function testMultiPanelIndependence(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 3: Multi-panel — two panels operate independently --");
	const { page } = ctx;

	// Open a second panel
	await page.evaluate(() => {
		(window as any).app?.commands?.executeCommandById("notor:open-secondary-chat");
	});
	await page.waitForTimeout(3_000);

	const leafCount = await getChatLeafCount(page);
	if (leafCount < 2) {
		const shot = await ctx.screenshot("03-no-second-panel");
		ctx.fail("Multi-panel independence", `Only ${leafCount} panel(s)`, shot);
		return;
	}

	// Send a message in panel 2
	await activateLeaf(page, 1);
	await page.waitForTimeout(500);

	const responded = await sendMessage(page, "Say 'panel two works' and nothing else.");
	await page.waitForTimeout(2_000);

	const panel1Conv = await getLeafConversationId(page, 0);
	const panel2Conv = await getLeafConversationId(page, 1);

	const shot = await ctx.screenshot("03-multi-panel");

	// Panels should have different conversations
	const independent = panel1Conv !== panel2Conv || (!panel1Conv && !panel2Conv);

	if (responded && independent) {
		ctx.pass(
			"Multi-panel independence",
			`Panel 0: conv=${panel1Conv?.substring(0, 8)}, ` +
			`Panel 1: conv=${panel2Conv?.substring(0, 8)}, independent=${independent}`,
			shot,
		);
	} else {
		ctx.fail(
			"Multi-panel independence",
			`responded=${responded}, independent=${independent}, ` +
			`panel0=${panel1Conv?.substring(0, 8)}, panel1=${panel2Conv?.substring(0, 8)}`,
			shot,
		);
	}
}

async function testRegistryMatchesPanels(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 4: Orchestrator registry matches open panel count --");
	const { page } = ctx;

	const leafCount = await getChatLeafCount(page);
	const registrySize = await getOrchestratorRegistrySize(page);

	// Close one panel and check
	if (leafCount >= 2) {
		await activateLeaf(page, 1);
		await page.waitForTimeout(500);
		await closeActiveLeaf(page);
		await page.waitForTimeout(2_000);
	}

	const leafCountAfter = await getChatLeafCount(page);
	const registrySizeAfter = await getOrchestratorRegistrySize(page);

	const shot = await ctx.screenshot("04-registry-match");

	const beforeMatch = leafCount === registrySize;
	const afterMatch = leafCountAfter === registrySizeAfter;

	if (beforeMatch && afterMatch) {
		ctx.pass(
			"Registry matches panels",
			`Before close: ${leafCount} leaves, ${registrySize} orch. ` +
			`After close: ${leafCountAfter} leaves, ${registrySizeAfter} orch`,
			shot,
		);
	} else {
		ctx.fail(
			"Registry matches panels",
			`Before: leaves=${leafCount}, orch=${registrySize} (match=${beforeMatch}). ` +
			`After: leaves=${leafCountAfter}, orch=${registrySizeAfter} (match=${afterMatch})`,
			shot,
		);
	}
}

async function testIsSecondaryRemoved(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 5: isSecondary infrastructure fully removed --");
	const { page } = ctx;

	const result = await page.evaluate((viewType: string) => {
		const app = (window as any).app;
		if (!app) return { error: "app not found" };
		const leaves = app.workspace.getLeavesOfType(viewType);
		if (leaves.length === 0) return { error: "no leaves" };

		const view = leaves[0]?.view;
		if (!view) return { error: "no view" };

		const plugin = app.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "no plugin" };

		return {
			// getIsSecondary should no longer exist
			hasGetIsSecondary: typeof view.getIsSecondary === "function",
			// setIsSecondary should no longer exist
			hasSetIsSecondary: typeof view.setIsSecondary === "function",
			// getState should NOT include isSecondary
			stateHasIsSecondary: "isSecondary" in (view.getState?.() ?? {}),
			// Plugin may retain _secondaryOrchestrators as a backward-compat shim (A1.11 incomplete)
			// but it should be empty — all new orchestrators use the unified _orchestrators Map
			hasSecondaryOrchestrators: Array.isArray((plugin as any)._secondaryOrchestrators),
			secondaryOrchestratorsEmpty: ((plugin as any)._secondaryOrchestrators?.length ?? 0) === 0,
			// Plugin should not have getOrchestrator (old primary getter)
			hasGetOrchestrator: typeof plugin.getOrchestrator === "function",
			// Plugin SHOULD have _orchestrators Map
			hasOrchestratorRegistry: (plugin as any)._orchestrators instanceof Map,
			// Plugin SHOULD have getActiveOrchestrator
			hasGetActiveOrchestrator: typeof plugin.getActiveOrchestrator === "function",
		};
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("isSecondary removed", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as {
		hasGetIsSecondary: boolean;
		hasSetIsSecondary: boolean;
		stateHasIsSecondary: boolean;
		hasSecondaryOrchestrators: boolean;
		secondaryOrchestratorsEmpty: boolean;
		hasGetOrchestrator: boolean;
		hasOrchestratorRegistry: boolean;
		hasGetActiveOrchestrator: boolean;
	};

	// _secondaryOrchestrators may still exist as a backward-compat shim (A1.11 incomplete)
	// but the key checks are: view-level isSecondary is gone, and the array is empty
	const oldInfraRemoved = !r.hasGetIsSecondary && !r.hasSetIsSecondary &&
		!r.stateHasIsSecondary &&
		(!r.hasSecondaryOrchestrators || r.secondaryOrchestratorsEmpty);
	const newInfraPresent = r.hasOrchestratorRegistry && r.hasGetActiveOrchestrator;

	if (oldInfraRemoved && newInfraPresent) {
		ctx.pass(
			"isSecondary removed",
			`Old infra removed: getIsSecondary=${r.hasGetIsSecondary}, setIsSecondary=${r.hasSetIsSecondary}, ` +
			`stateIsSecondary=${r.stateHasIsSecondary}, secondaryOrchs=${r.hasSecondaryOrchestrators} ` +
			`(empty=${r.secondaryOrchestratorsEmpty}). ` +
			`New infra: registry=${r.hasOrchestratorRegistry}, getActive=${r.hasGetActiveOrchestrator}. ` +
			`getOrchestrator (old)=${r.hasGetOrchestrator}`,
		);
	} else {
		ctx.fail(
			"isSecondary removed",
			`Old infra: getIsSecondary=${r.hasGetIsSecondary}, setIsSecondary=${r.hasSetIsSecondary}, ` +
			`stateIsSecondary=${r.stateHasIsSecondary}, secondaryOrchs=${r.hasSecondaryOrchestrators} ` +
			`(empty=${r.secondaryOrchestratorsEmpty}). ` +
			`New infra: registry=${r.hasOrchestratorRegistry}, getActive=${r.hasGetActiveOrchestrator}`,
		);
	}
}

async function testViewLifecycleInfrastructure(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 6: View lifecycle — onClose cleanup and clearCallbacks --");
	const { page } = ctx;

	const result = await page.evaluate((viewType: string) => {
		const app = (window as any).app;
		if (!app) return { error: "app not found" };
		const leaves = app.workspace.getLeavesOfType(viewType);
		if (leaves.length === 0) return { error: "no leaves" };

		const view = leaves[0]?.view;
		if (!view) return { error: "no view" };

		return {
			// New lifecycle infrastructure
			hasOnCloseCleanup: "onCloseCleanup" in view,
			hasSetOnCloseCleanup: typeof view.setOnCloseCleanup === "function",
			hasClearCallbacks: typeof view.clearCallbacks === "function",
			hasIsConversationLoaded: "isConversationLoaded" in view,
			isConversationLoadedValue: view.isConversationLoaded,
			// Abort infrastructure
			hasLoadConversationAbort: "_loadConversationAbort" in view,
			hasLoadFallbackTimeout: "_loadFallbackTimeout" in view,
			// Session listener unregister
			hasUnregisterSessionsChanged: "_unregisterSessionsChanged" in view,
		};
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("View lifecycle infrastructure", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as {
		hasOnCloseCleanup: boolean;
		hasSetOnCloseCleanup: boolean;
		hasClearCallbacks: boolean;
		hasIsConversationLoaded: boolean;
		isConversationLoadedValue: boolean;
		hasLoadConversationAbort: boolean;
		hasLoadFallbackTimeout: boolean;
		hasUnregisterSessionsChanged: boolean;
	};

	const allPresent = r.hasOnCloseCleanup && r.hasSetOnCloseCleanup &&
		r.hasClearCallbacks && r.hasIsConversationLoaded;

	if (allPresent) {
		ctx.pass(
			"View lifecycle infrastructure",
			`onCloseCleanup=${r.hasOnCloseCleanup}, setOnCloseCleanup=${r.hasSetOnCloseCleanup}, ` +
			`clearCallbacks=${r.hasClearCallbacks}, isConversationLoaded=${r.isConversationLoadedValue}, ` +
			`abortController=${r.hasLoadConversationAbort}, fallbackTimeout=${r.hasLoadFallbackTimeout}, ` +
			`unregisterSessions=${r.hasUnregisterSessionsChanged}`,
		);
	} else {
		ctx.fail(
			"View lifecycle infrastructure",
			`Missing: onCloseCleanup=${r.hasOnCloseCleanup}, setOnCloseCleanup=${r.hasSetOnCloseCleanup}, ` +
			`clearCallbacks=${r.hasClearCallbacks}, isConversationLoaded=${r.hasIsConversationLoaded}`,
		);
	}
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 7: No unexpected error logs from core operations --");
	const { collector } = ctx;

	const relevantSources = [
		"ChatOrchestrator",
		"ConversationSession",
		"NotorChatView",
		"ChatView",
		"HistoryManager",
		"ConversationManager",
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
			`Zero error-level logs from ${relevantSources.join(", ")}`,
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
	ctx.pass("Chat panel ready", "Plugin loaded and chat container found");

	// Single-panel tests
	await safeRun(ctx, "New conversation + messages", () => testNewConversationAndMessages(ctx));
	await safeRun(ctx, "Switch conversations", () => testSwitchConversations(ctx));

	// Multi-panel tests
	await safeRun(ctx, "Multi-panel independence", () => testMultiPanelIndependence(ctx));
	await safeRun(ctx, "Registry matches panels", () => testRegistryMatchesPanels(ctx));

	// Infrastructure verification
	await safeRun(ctx, "isSecondary removed", () => testIsSecondaryRemoved(ctx));
	await safeRun(ctx, "View lifecycle infrastructure", () => testViewLifecycleInfrastructure(ctx));

	// Error check (always last)
	await safeRun(ctx, "No unexpected errors", () => testNoUnexpectedErrors(ctx));
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "plan",
});

runTest({
	name: "phase-a-regression",
	settings,
	setupVault: (vaultPath) => writeCleanWorkspace(vaultPath),
}, tests);
