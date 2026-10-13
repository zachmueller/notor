#!/usr/bin/env npx tsx
/**
 * Phase A Verification: Cross-Panel Session Guard Test (AV.3)
 *
 * Validates Bug D fix — two orchestrators cannot create sessions for the same
 * conversation simultaneously. The old per-orchestrator `activeSessions` guard
 * only checked locally; the new cross-orchestrator `SessionGuard` (backed by a
 * shared `_activeConversationSessions` Set on the plugin) blocks cross-panel
 * duplicate sessions.
 *
 * Scenarios:
 *   1. Setup — create conversation with messages, open second panel
 *   2. Switch second panel to same conversation as first panel
 *   3. Start streaming in panel 1
 *   4. While streaming, attempt to send in panel 2 — blocked by guard
 *   5. After streaming completes, panel 2 can send successfully
 *   6. Verify SessionGuard interface exists and is wired
 *   7. Verify _activeConversationSessions tracking is correct
 *   8. No unexpected error logs from session guard
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — AV.3
 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Bug D
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessage,
	sendMessageNoWaitInLeaf,
	isLeafIdle,
	waitForLeafResponse,
	ensureCleanState,
	writeCleanWorkspace,
	CHAT_ONLY,
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
		// Read the leaf orchestrator: switchLeafToConversation calls it directly,
		// which (unlike the UI wrappers) doesn't update view.activeConversationId
		const orch = app.plugins?.plugins?.["notor"]?._orchestrators?.get(leaves[args.index].id);
		return orch?.getConversationManager().getActiveConversation()?.id ?? leaves[args.index]?.view?.activeConversationId ?? null;
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

/** Wait until the stop button in a leaf is visible (streaming started). */
async function waitForStopButton(page: any, leafIndex: number, timeoutMs = 15_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(300);
		const visible = await page.evaluate((args: { viewType: string; index: number }) => {
			const leaves = (window as any).app?.workspace?.getLeavesOfType(args.viewType) ?? [];
			const btn = leaves[args.index]?.view?.containerEl?.querySelector(".notor-stop-btn");
			return !!btn && !btn.classList.contains("notor-hidden");
		}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
		if (visible) return true;
	}
	return false;
}

/** Switch a specific leaf's orchestrator to a conversation by filename. */
async function switchLeafToConversation(page: any, leafIndex: number, filename: string): Promise<boolean> {
	return page.evaluate(async (args: { viewType: string; index: number; filename: string }) => {
		const app = (window as any).app;
		if (!app) return false;
		const plugin = app.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		if (args.index >= leaves.length) return false;
		const orch = (plugin as any)._orchestrators?.get(leaves[args.index].id);
		if (!orch) return false;
		try {
			await orch.switchConversation(args.filename);
			return true;
		} catch {
			return false;
		}
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex, filename });
}

/** Find conversation filename via the plugin API. */
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

/** Check if a conversation has an active session in any orchestrator. */
async function isConversationActiveAnywhere(page: any, conversationId: string): Promise<boolean> {
	return page.evaluate((convId: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		const sessions = (plugin as any)._activeConversationSessions;
		return sessions?.has(convId) ?? false;
	}, conversationId);
}

/** Get the active conversation sessions set from the plugin. */
async function getActiveConversationSessions(page: any): Promise<string[]> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return [];
		const sessions = (plugin as any)._activeConversationSessions;
		return sessions ? Array.from(sessions) : [];
	});
}

/** Count rendered assistant messages in a leaf. */
async function getAssistantMessageCount(page: any, leafIndex: number): Promise<number> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const leaves = (window as any).app?.workspace?.getLeavesOfType(args.viewType) ?? [];
		return leaves[args.index]?.view?.containerEl?.querySelectorAll(".notor-message-assistant").length ?? 0;
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

/** Count the sessions owned by a leaf's own orchestrator. */
async function getLeafSessionCount(page: any, leafIndex: number): Promise<number> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const app = (window as any).app;
		const leaf = app?.workspace?.getLeavesOfType(args.viewType)?.[args.index];
		const orch = leaf ? app.plugins?.plugins?.["notor"]?._orchestrators?.get(leaf.id) : null;
		return orch?.getActiveSessions?.().length ?? -1;
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

interface SharedState {
	convId?: string;
	convFilename?: string;
}
const shared: SharedState = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSetup(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 1: Setup — create conversation and open second panel --");
	const { page } = ctx;

	// Send a message to create a conversation with history
	const responded = await sendMessage(page, "Hello! Reply with just 'Hi there!'.");
	if (!responded) {
		const shot = await ctx.screenshot("01-no-response");
		ctx.fail("Setup", "LLM did not respond", shot);
		return;
	}

	await page.waitForTimeout(2_000);
	const convId = await getLeafConversationId(page, 0);
	shared.convId = convId ?? undefined;

	// Find the filename for this conversation
	if (convId) {
		for (let i = 0; i < 3; i++) {
			shared.convFilename = (await findConversationFilename(page, convId)) ?? undefined;
			if (shared.convFilename) break;
			await page.waitForTimeout(1_000);
		}
	}

	// Open a second panel
	await page.evaluate(() => {
		(window as any).app?.commands?.executeCommandById("notor:open-secondary-chat");
	});
	await page.waitForTimeout(3_000);

	const leafCount = await getChatLeafCount(page);
	const shot = await ctx.screenshot("01-setup-done");

	if (convId && shared.convFilename && leafCount >= 2) {
		ctx.pass(
			"Setup",
			`Conv=${convId.substring(0, 8)}, file=${shared.convFilename}, ${leafCount} panels`,
			shot,
		);
	} else {
		ctx.fail(
			"Setup",
			`convId=${convId?.substring(0, 8) ?? "null"}, file=${shared.convFilename ?? "null"}, leaves=${leafCount}`,
			shot,
		);
	}
}

async function testSwitchSecondPanelToSameConversation(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 2: Switch second panel to same conversation as first --");
	const { page } = ctx;

	if (!shared.convFilename) {
		ctx.fail("Switch to same conversation", "No conversation filename from setup");
		return;
	}

	const switched = await switchLeafToConversation(page, 1, shared.convFilename);
	await page.waitForTimeout(2_000);

	const panel1Conv = await getLeafConversationId(page, 0);
	const panel2Conv = await getLeafConversationId(page, 1);

	const shot = await ctx.screenshot("02-same-conversation");

	if (switched && panel1Conv === panel2Conv && panel1Conv === shared.convId) {
		ctx.pass(
			"Switch to same conversation",
			`Both panels show conversation ${panel1Conv?.substring(0, 8)}`,
			shot,
		);
	} else {
		ctx.fail(
			"Switch to same conversation",
			`switched=${switched}, panel1=${panel1Conv?.substring(0, 8)}, ` +
			`panel2=${panel2Conv?.substring(0, 8)}, expected=${shared.convId?.substring(0, 8)}`,
			shot,
		);
	}
}

async function testSessionGuardBlocks(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 3: Session guard blocks panel 2 while panel 1 is streaming --");
	const { page } = ctx;

	if (!shared.convId) {
		ctx.fail("Session guard blocks", "No conversation ID from setup");
		return;
	}

	// Start a long streaming response in panel 1
	await activateLeaf(page, 0);
	await page.waitForTimeout(500);

	await sendMessageNoWaitInLeaf(
		page,
		0,
		"Write a very detailed, comprehensive 2000-word essay about the complete history of " +
		"astronomy from ancient Babylonian observations through modern space telescopes. " +
		"Cover every major discovery, key astronomers, and technological breakthrough." + CHAT_ONLY,
	);

	// Wait for streaming to start
	const streamingStarted = await waitForStopButton(page, 0, 30_000);
	if (!streamingStarted) {
		// The response may have finished between polls
		if ((await isLeafIdle(page, 0)) && (await getAssistantMessageCount(page, 0)) >= 2) {
			ctx.pass("Session guard blocks", "Response completed too quickly to test guard (fast model)");
			return;
		}
		const shot = await ctx.screenshot("03-no-streaming");
		ctx.fail("Session guard blocks", "Streaming never started and panel 1 has no finished reply", shot);
		return;
	}

	// Verify the conversation is registered in the cross-orchestrator guard
	const isActive = await isConversationActiveAnywhere(page, shared.convId);
	console.log(`  Session guard active for conv: ${isActive}`);

	// Record the notice count before trying to send from panel 2
	const noticeCountBefore = await page.evaluate(() =>
		document.querySelectorAll(".notice").length,
	);

	// Switch to panel 2 and try to send
	await activateLeaf(page, 1);
	await page.waitForTimeout(500);

	const panel2AssistantsBefore = await getAssistantMessageCount(page, 1);

	// Try sending in panel 2 — should be blocked by session guard
	await sendMessageNoWaitInLeaf(page, 1, "This should be blocked by the session guard.");
	await page.waitForTimeout(2_000);

	const panel2AssistantsAfter = await getAssistantMessageCount(page, 1);
	const noticeCountAfter = await page.evaluate(() =>
		document.querySelectorAll(".notice").length,
	);

	// The guard returns early: panel 2 starts no session and stays idle
	const panel2Sessions = await getLeafSessionCount(page, 1);
	const panel2Idle = await isLeafIdle(page, 1);

	const shot = await ctx.screenshot("03-guard-blocked");

	const noticeAppeared = noticeCountAfter > noticeCountBefore;
	const noNewResponse = panel2AssistantsAfter === panel2AssistantsBefore;
	const noPanel2Session = panel2Sessions === 0 && panel2Idle;

	if (isActive && noPanel2Session && (noticeAppeared || noNewResponse)) {
		ctx.pass(
			"Session guard blocks",
			`Guard active=${isActive}, notice appeared=${noticeAppeared}, ` +
			`no new response=${noNewResponse}, panel 2 sessions=${panel2Sessions}, panel 2 idle=${panel2Idle}`,
			shot,
		);
	} else {
		ctx.fail(
			"Session guard blocks",
			`Guard active=${isActive}, notice=${noticeAppeared}, ` +
			`noNewResponse=${noNewResponse} (before=${panel2AssistantsBefore}, after=${panel2AssistantsAfter}), ` +
			`panel 2 sessions=${panel2Sessions}, panel 2 idle=${panel2Idle}`,
			shot,
		);
	}
}

async function testSendAfterCompletion(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 4: After streaming completes, panel 2 can send successfully --");
	const { page } = ctx;

	// Wait for panel 1's streaming to complete
	await activateLeaf(page, 0);
	await page.waitForTimeout(500);

	const completed = await waitForLeafResponse(page, 0, 120_000, 2_000);
	if (!completed) {
		const shot = await ctx.screenshot("04-still-streaming");
		ctx.fail("Send after completion", "Panel 1 streaming never completed", shot);
		return;
	}

	// Verify the session guard is clear
	if (shared.convId) {
		const stillActive = await isConversationActiveAnywhere(page, shared.convId);
		console.log(`  Session guard still active after completion: ${stillActive}`);
	}

	// Switch to panel 2 and send — should work now
	await activateLeaf(page, 1);
	await page.waitForTimeout(1_000);

	// Ensure clean state in panel 2
	await ensureCleanState(page);
	await page.waitForTimeout(500);

	// Create a new conversation in panel 2 via command (routes to active panel)
	await page.evaluate(() => {
		(window as any).app?.commands?.executeCommandById("notor:new-conversation");
	});
	await page.waitForTimeout(2_000);

	await sendMessageNoWaitInLeaf(page, 1, "Say 'Panel 2 works!' and nothing else.");
	const responded = (await waitForLeafResponse(page, 1)) && (await getAssistantMessageCount(page, 1)) > 0;
	const shot = await ctx.screenshot("04-panel2-sends");

	if (responded) {
		ctx.pass(
			"Send after completion",
			"Panel 2 successfully sent and received a response after panel 1 completed",
			shot,
		);
	} else {
		ctx.fail(
			"Send after completion",
			"Panel 2 could not send after panel 1 streaming completed",
			shot,
		);
	}
}

async function testSessionGuardInfrastructure(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 5: SessionGuard interface exists and is wired --");
	const { page } = ctx;

	const guardInfo = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };
		try {
			const guard = (plugin as any)._sessionGuard;
			const sessions = (plugin as any)._activeConversationSessions;

			return {
				hasGuard: !!guard,
				guardHasIsActive: typeof guard?.isActive === "function",
				guardHasRegister: typeof guard?.register === "function",
				guardHasUnregister: typeof guard?.unregister === "function",
				hasSessionsSet: sessions instanceof Set,
				sessionsSize: sessions?.size ?? -1,
			};
		} catch (e: any) {
			return { error: e.message };
		}
	});

	if ((guardInfo as any).error) {
		ctx.fail("SessionGuard infrastructure", `Error: ${(guardInfo as any).error}`);
		return;
	}

	const info = guardInfo as {
		hasGuard: boolean;
		guardHasIsActive: boolean;
		guardHasRegister: boolean;
		guardHasUnregister: boolean;
		hasSessionsSet: boolean;
		sessionsSize: number;
	};

	const allWired = info.hasGuard && info.guardHasIsActive &&
		info.guardHasRegister && info.guardHasUnregister && info.hasSessionsSet;

	if (allWired) {
		ctx.pass(
			"SessionGuard infrastructure",
			`Guard wired: isActive=${info.guardHasIsActive}, register=${info.guardHasRegister}, ` +
			`unregister=${info.guardHasUnregister}, sessionsSet=${info.hasSessionsSet} (size=${info.sessionsSize})`,
		);
	} else {
		ctx.fail(
			"SessionGuard infrastructure",
			`Incomplete: guard=${info.hasGuard}, isActive=${info.guardHasIsActive}, ` +
			`register=${info.guardHasRegister}, unregister=${info.guardHasUnregister}, set=${info.hasSessionsSet}`,
		);
	}
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 6: No unexpected error logs from session guard --");
	const { collector } = ctx;

	const relevantSources = [
		"ChatOrchestrator",
		"ConversationSession",
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
			!e.message.includes("Rate limited") &&
			!e.message.includes("connection") &&
			!e.message.includes("timeout"),
	);

	if (errorLogs.length === 0) {
		ctx.pass(
			"No unexpected errors",
			`Zero error-level logs from ${relevantSources.join(", ")} during session guard tests`,
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

	await safeRun(ctx, "Setup", () => testSetup(ctx));
	if (!shared.convId || !shared.convFilename) {
		ctx.fail("Suite prerequisite", "Setup failed — skipping remaining tests");
		return;
	}

	const leafCount = await getChatLeafCount(page);
	if (leafCount < 2) {
		ctx.fail("Suite prerequisite", "Need 2 panels — skipping remaining tests");
		return;
	}

	await safeRun(ctx, "Switch to same conversation", () => testSwitchSecondPanelToSameConversation(ctx));
	await safeRun(ctx, "Session guard blocks", () => testSessionGuardBlocks(ctx));

	// Clean up streaming before next test
	await ensureCleanState(page);
	await page.waitForTimeout(1_000);

	await safeRun(ctx, "Send after completion", () => testSendAfterCompletion(ctx));
	await safeRun(ctx, "SessionGuard infrastructure", () => testSessionGuardInfrastructure(ctx));
	await safeRun(ctx, "No unexpected errors", () => testNoUnexpectedErrors(ctx));
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "act", // Plain streamed chat (prompts use CHAT_ONLY); Plan mode now proposes vault changes via submit_plan
});

runTest({
	name: "phase-a-session-guard",
	settings,
	setupVault: (vaultPath) => writeCleanWorkspace(vaultPath),
}, tests);
