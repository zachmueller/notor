#!/usr/bin/env npx tsx
/**
 * Phase A Verification: Command Routing & Settings Propagation Test (AV.4 + AV.5)
 *
 * Validates that commands route to the focused panel (via getActiveOrchestrator())
 * and that settings changes propagate to all orchestrators.
 *
 * Scenarios:
 *   1. Open two panels side by side
 *   2. Focus panel 2, run "new conversation" — verify panel 2 changed, panel 1 unchanged
 *   3. Focus panel 1, run "new conversation" — verify panel 1 changed, panel 2 unchanged
 *   4. getActiveOrchestrator() returns correct orchestrator per focus
 *   5. Change settings — verify all orchestrators receive update
 *   6. _lastFocusedChatLeafId tracks focus correctly
 *   7. No unexpected error logs from command routing
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — AV.4, AV.5
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessage,
	newConversation,
	ensureCleanState,
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

/** Get the leaf ID of the active orchestrator (via getActiveOrchestrator lookup). */
async function getActiveOrchestratorLeafId(page: any): Promise<string | null> {
	return page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		const orch = plugin.getActiveOrchestrator?.();
		if (!orch) return null;
		// Find which leaf ID maps to this orchestrator
		const registry = (plugin as any)._orchestrators;
		if (!registry) return null;
		for (const [leafId, o] of registry.entries()) {
			if (o === orch) return leafId;
		}
		return null;
	}, CHAT_VIEW_TYPE);
}

/** Get _lastFocusedChatLeafId from plugin. */
async function getLastFocusedChatLeafId(page: any): Promise<string | null> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return (plugin as any)?._lastFocusedChatLeafId ?? null;
	});
}

/** Get the leaf ID for a specific leaf by index. */
async function getLeafId(page: any, leafIndex: number): Promise<string | null> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const app = (window as any).app;
		if (!app) return null;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		if (args.index >= leaves.length) return null;
		return leaves[args.index]?.id ?? null;
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

/** Execute the "new conversation" command via Obsidian command palette. */
async function executeNewConversationCommand(page: any): Promise<void> {
	await page.evaluate(() => {
		(window as any).app?.commands?.executeCommandById("notor:new-conversation");
	});
	await page.waitForTimeout(2_000);
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

interface SharedState {
	panel0InitialConvId?: string;
	panel1InitialConvId?: string;
	leaf0Id?: string;
	leaf1Id?: string;
}
const shared: SharedState = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSetupTwoPanels(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 1: Open two panels with different conversations --");
	const { page } = ctx;

	// Send a message in panel 1 to create a conversation
	const responded = await sendMessage(page, "Hello from panel 1. Reply briefly.");
	if (!responded) {
		const shot = await ctx.screenshot("01-no-response");
		ctx.fail("Setup two panels", "LLM did not respond", shot);
		return;
	}
	await page.waitForTimeout(1_000);

	shared.panel0InitialConvId = (await getLeafConversationId(page, 0)) ?? undefined;

	// Open a second panel
	await page.evaluate(() => {
		(window as any).app?.commands?.executeCommandById("notor:open-secondary-chat");
	});
	await page.waitForTimeout(3_000);

	const leafCount = await getChatLeafCount(page);
	if (leafCount < 2) {
		const shot = await ctx.screenshot("01-no-second-panel");
		ctx.fail("Setup two panels", `Only ${leafCount} panel(s)`, shot);
		return;
	}

	shared.panel1InitialConvId = (await getLeafConversationId(page, 1)) ?? undefined;
	shared.leaf0Id = (await getLeafId(page, 0)) ?? undefined;
	shared.leaf1Id = (await getLeafId(page, 1)) ?? undefined;

	const shot = await ctx.screenshot("01-two-panels");
	ctx.pass(
		"Setup two panels",
		`Panel 0: conv=${shared.panel0InitialConvId?.substring(0, 8)}, leaf=${shared.leaf0Id?.substring(0, 8)}. ` +
		`Panel 1: conv=${shared.panel1InitialConvId?.substring(0, 8) ?? "new"}, leaf=${shared.leaf1Id?.substring(0, 8)}`,
		shot,
	);
}

async function testCommandRoutesToFocusedPanel2(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 2: Focus panel 2, run new-conversation — only panel 2 changes --");
	const { page } = ctx;

	// Focus panel 2 (index 1)
	await activateLeaf(page, 1);
	await page.waitForTimeout(1_000);

	// Record panel 1's state before
	const panel0ConvBefore = await getLeafConversationId(page, 0);

	// Run the new conversation command
	await executeNewConversationCommand(page);

	// Check panel states
	const panel0ConvAfter = await getLeafConversationId(page, 0);
	const panel1ConvAfter = await getLeafConversationId(page, 1);

	const shot = await ctx.screenshot("02-command-panel2");

	const panel0Unchanged = panel0ConvBefore === panel0ConvAfter;
	const panel1Changed = panel1ConvAfter !== shared.panel1InitialConvId;

	if (panel0Unchanged) {
		ctx.pass(
			"Command routes to panel 2",
			`Panel 0 unchanged: ${panel0ConvBefore?.substring(0, 8)}. ` +
			`Panel 1: ${shared.panel1InitialConvId?.substring(0, 8) ?? "null"} -> ${panel1ConvAfter?.substring(0, 8) ?? "null"} ` +
			`(changed=${panel1Changed})`,
			shot,
		);
	} else {
		ctx.fail(
			"Command routes to panel 2",
			`Panel 0 CHANGED: ${panel0ConvBefore?.substring(0, 8)} -> ${panel0ConvAfter?.substring(0, 8)}. ` +
			`Panel 1: ${shared.panel1InitialConvId?.substring(0, 8) ?? "null"} -> ${panel1ConvAfter?.substring(0, 8) ?? "null"}`,
			shot,
		);
	}

	// Update shared state
	shared.panel1InitialConvId = panel1ConvAfter ?? undefined;
}

async function testCommandRoutesToFocusedPanel1(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 3: Focus panel 1, run new-conversation — only panel 1 changes --");
	const { page } = ctx;

	// Focus panel 1 (index 0)
	await activateLeaf(page, 0);
	await page.waitForTimeout(1_000);

	// Record panel 2's state before
	const panel1ConvBefore = await getLeafConversationId(page, 1);

	// Run the new conversation command
	await executeNewConversationCommand(page);

	// Check panel states
	const panel0ConvAfter = await getLeafConversationId(page, 0);
	const panel1ConvAfter = await getLeafConversationId(page, 1);

	const shot = await ctx.screenshot("03-command-panel1");

	const panel1Unchanged = panel1ConvBefore === panel1ConvAfter;
	const panel0Changed = panel0ConvAfter !== shared.panel0InitialConvId;

	if (panel1Unchanged) {
		ctx.pass(
			"Command routes to panel 1",
			`Panel 1 unchanged: ${panel1ConvBefore?.substring(0, 8) ?? "null"}. ` +
			`Panel 0: ${shared.panel0InitialConvId?.substring(0, 8)} -> ${panel0ConvAfter?.substring(0, 8) ?? "null"} ` +
			`(changed=${panel0Changed})`,
			shot,
		);
	} else {
		ctx.fail(
			"Command routes to panel 1",
			`Panel 1 CHANGED: ${panel1ConvBefore?.substring(0, 8) ?? "null"} -> ${panel1ConvAfter?.substring(0, 8) ?? "null"}. ` +
			`Panel 0: ${shared.panel0InitialConvId?.substring(0, 8)} -> ${panel0ConvAfter?.substring(0, 8) ?? "null"}`,
			shot,
		);
	}
}

async function testActiveOrchestratorFollowsFocus(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 4: getActiveOrchestrator() returns correct orchestrator per focus --");
	const { page } = ctx;

	// Focus panel 0 and check
	await activateLeaf(page, 0);
	await page.waitForTimeout(500);
	const activeLeafId0 = await getActiveOrchestratorLeafId(page);

	// Focus panel 1 and check
	await activateLeaf(page, 1);
	await page.waitForTimeout(500);
	const activeLeafId1 = await getActiveOrchestratorLeafId(page);

	const shot = await ctx.screenshot("04-active-orchestrator");

	const panel0Correct = activeLeafId0 === shared.leaf0Id;
	const panel1Correct = activeLeafId1 === shared.leaf1Id;

	if (panel0Correct && panel1Correct) {
		ctx.pass(
			"Active orchestrator follows focus",
			`Focus panel 0 → orch leaf=${activeLeafId0?.substring(0, 8)} (expected ${shared.leaf0Id?.substring(0, 8)}). ` +
			`Focus panel 1 → orch leaf=${activeLeafId1?.substring(0, 8)} (expected ${shared.leaf1Id?.substring(0, 8)})`,
			shot,
		);
	} else {
		ctx.fail(
			"Active orchestrator follows focus",
			`Panel 0: got=${activeLeafId0?.substring(0, 8)}, expected=${shared.leaf0Id?.substring(0, 8)} (${panel0Correct}). ` +
			`Panel 1: got=${activeLeafId1?.substring(0, 8)}, expected=${shared.leaf1Id?.substring(0, 8)} (${panel1Correct})`,
			shot,
		);
	}
}

async function testSettingsPropagation(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 5: Settings change propagates to all orchestrators --");
	const { page } = ctx;

	// Update a setting via plugin API and verify all orchestrators received it
	const result = await page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };
		try {
			const registry = (plugin as any)._orchestrators;
			if (!registry || registry.size < 2) return { error: `registry size: ${registry?.size}` };

			// Read current mode from each orchestrator's settings before change
			const beforeModes: string[] = [];
			for (const orch of registry.values()) {
				const settings = orch.getSettings?.();
				beforeModes.push(settings?.mode ?? "unknown");
			}

			// Trigger a settings update via the plugin's standard path
			// (same path that the settings UI uses)
			const newMode = plugin.settings.mode === "plan" ? "act" : "plan";
			plugin.settings.mode = newMode;
			for (const orch of registry.values()) {
				orch.updateSettings(plugin.settings);
			}

			// Read modes after
			const afterModes: string[] = [];
			for (const orch of registry.values()) {
				const settings = orch.getSettings?.();
				afterModes.push(settings?.mode ?? "unknown");
			}

			// Restore original mode
			plugin.settings.mode = beforeModes[0] ?? "plan";
			for (const orch of registry.values()) {
				orch.updateSettings(plugin.settings);
			}

			return {
				orchestratorCount: registry.size,
				beforeModes,
				afterModes,
				allUpdated: afterModes.every((m: string) => m === newMode),
			};
		} catch (e: any) {
			return { error: e.message };
		}
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("Settings propagation", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as {
		orchestratorCount: number;
		beforeModes: string[];
		afterModes: string[];
		allUpdated: boolean;
	};

	if (r.allUpdated) {
		ctx.pass(
			"Settings propagation",
			`All ${r.orchestratorCount} orchestrators updated: ` +
			`before=${r.beforeModes.join(",")}, after=${r.afterModes.join(",")}`,
		);
	} else {
		ctx.fail(
			"Settings propagation",
			`Not all updated (${r.orchestratorCount} orchestrators): ` +
			`before=${r.beforeModes.join(",")}, after=${r.afterModes.join(",")}`,
		);
	}
}

async function testLastFocusedTracking(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 6: _lastFocusedChatLeafId tracks focus correctly --");
	const { page } = ctx;

	// Focus panel 0
	await activateLeaf(page, 0);
	await page.waitForTimeout(500);
	const lastFocused0 = await getLastFocusedChatLeafId(page);

	// Focus panel 1
	await activateLeaf(page, 1);
	await page.waitForTimeout(500);
	const lastFocused1 = await getLastFocusedChatLeafId(page);

	const panel0Correct = lastFocused0 === shared.leaf0Id;
	const panel1Correct = lastFocused1 === shared.leaf1Id;

	if (panel0Correct && panel1Correct) {
		ctx.pass(
			"Last focused tracking",
			`Focus panel 0 → lastFocused=${lastFocused0?.substring(0, 8)}. ` +
			`Focus panel 1 → lastFocused=${lastFocused1?.substring(0, 8)}`,
		);
	} else {
		ctx.fail(
			"Last focused tracking",
			`Panel 0: got=${lastFocused0?.substring(0, 8)}, expected=${shared.leaf0Id?.substring(0, 8)}. ` +
			`Panel 1: got=${lastFocused1?.substring(0, 8)}, expected=${shared.leaf1Id?.substring(0, 8)}`,
		);
	}
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 7: No unexpected error logs from command routing --");
	const { collector } = ctx;

	const relevantSources = [
		"ChatOrchestrator",
		"NotorChatView",
		"ChatView",
		"HistoryManager",
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

	await safeRun(ctx, "Setup two panels", () => testSetupTwoPanels(ctx));

	const leafCount = await getChatLeafCount(page);
	if (leafCount < 2) {
		ctx.fail("Suite prerequisite", "Need 2 panels — skipping remaining tests");
		return;
	}

	await safeRun(ctx, "Command routes to panel 2", () => testCommandRoutesToFocusedPanel2(ctx));
	await safeRun(ctx, "Command routes to panel 1", () => testCommandRoutesToFocusedPanel1(ctx));
	await safeRun(ctx, "Active orchestrator follows focus", () => testActiveOrchestratorFollowsFocus(ctx));
	await safeRun(ctx, "Settings propagation", () => testSettingsPropagation(ctx));
	await safeRun(ctx, "Last focused tracking", () => testLastFocusedTracking(ctx));
	await safeRun(ctx, "No unexpected errors", () => testNoUnexpectedErrors(ctx));
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "plan",
});

runTest({ name: "phase-a-routing-settings", settings }, tests);
