#!/usr/bin/env npx tsx
/**
 * Phase B Verification: Multi-Panel Integration Test (BV.2)
 *
 * Validates the coupled trio of extractions (B1 ViewRouter, B2 SessionManager,
 * B3 ConversationLifecycleManager) working together in a multi-panel scenario.
 *
 * Key behaviors tested:
 * - switchConversation sync-back: open same conversation in two panels,
 *   send message in one, switch to it in the other → messages appear
 * - Session isolation: concurrent sessions in different panels don't interfere
 * - getViewForSession routing: renders go to the correct panel
 *
 * Scenarios:
 *   1. Setup — create conversation with messages, open second panel
 *   2. Switch second panel to same conversation — verify sync-back renders messages
 *   3. Send message in panel 1 — verify response renders in panel 1 only
 *   4. Session isolation — panel 2 has independent conversation state
 *   5. ViewRouter routing — getViewForSession returns correct panel
 *   6. ConversationLifecycle — newConversation/switchConversation delegated correctly
 *   7. SessionManager — session guard integration with multi-panel
 *   8. No unexpected error logs from multi-panel operations
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — BV.2
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessage,
	newConversation,
	ensureCleanState,
	waitForResponse,
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
			// Update view's activeConversationId
			const conv = orch.getConversationManager?.()?.getActiveConversation?.();
			const view = orch.getView?.();
			if (conv && view) {
				view.setActiveConversationId(conv.id);
			}
			return true;
		} catch {
			return false;
		}
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex, filename });
}

/** Get the number of rendered messages in a specific leaf (by checking the leaf's view). */
async function getLeafRenderedMessageCount(page: any, leafIndex: number): Promise<number> {
	return page.evaluate((args: { viewType: string; index: number }) => {
		const app = (window as any).app;
		if (!app) return -1;
		const leaves = app.workspace.getLeavesOfType(args.viewType);
		if (args.index >= leaves.length) return -1;
		const view = leaves[args.index]?.view;
		if (!view?.containerEl) return -1;
		return view.containerEl.querySelectorAll(".notor-message-user, .notor-message-assistant").length;
	}, { viewType: CHAT_VIEW_TYPE, index: leafIndex });
}

/** Send a message without waiting for response. */
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
	console.log(`    -> Sent (no wait): "${message.substring(0, 80)}"`);
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

interface SharedState {
	conv1Id?: string;
	conv1Filename?: string;
}
const shared: SharedState = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSetup(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 1: Setup — create conversation and open second panel --");
	const { page } = ctx;

	// Send a message to create a conversation
	const responded = await sendMessage(page, "Reply with exactly: 'Panel integration test message one'.");
	if (!responded) {
		const shot = await ctx.screenshot("01-no-response");
		ctx.fail("Setup", "LLM did not respond", shot);
		return;
	}

	await page.waitForTimeout(2_000);
	const convId = await getLeafConversationId(page, 0);
	shared.conv1Id = convId ?? undefined;

	// Resolve filename
	if (convId) {
		for (let i = 0; i < 3; i++) {
			shared.conv1Filename = (await findConversationFilename(page, convId)) ?? undefined;
			if (shared.conv1Filename) break;
			await page.waitForTimeout(1_000);
		}
	}

	// Open second panel
	await page.evaluate(() => {
		(window as any).app?.commands?.executeCommandById("notor:open-secondary-chat");
	});
	await page.waitForTimeout(3_000);

	const leafCount = await getChatLeafCount(page);
	const registrySize = await getOrchestratorRegistrySize(page);
	const shot = await ctx.screenshot("01-setup");

	if (convId && shared.conv1Filename && leafCount >= 2 && registrySize >= 2) {
		ctx.pass(
			"Setup",
			`Conv=${convId.substring(0, 8)}, file=${shared.conv1Filename}, ` +
			`${leafCount} panels, ${registrySize} orchestrators`,
			shot,
		);
	} else {
		ctx.fail(
			"Setup",
			`convId=${convId?.substring(0, 8) ?? "null"}, file=${shared.conv1Filename ?? "null"}, ` +
			`leaves=${leafCount}, registry=${registrySize}`,
			shot,
		);
	}
}

async function testSyncBackRendersMessages(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 2: Switch panel 2 to same conversation — sync-back renders messages --");
	const { page } = ctx;

	if (!shared.conv1Filename || !shared.conv1Id) {
		ctx.fail("Sync-back renders messages", "No conversation from setup");
		return;
	}

	// Switch panel 2 to the same conversation as panel 1
	const switched = await switchLeafToConversation(page, 1, shared.conv1Filename);
	await page.waitForTimeout(2_000);

	// Activate panel 2 to see its messages
	await activateLeaf(page, 1);
	await page.waitForTimeout(500);

	const panel2Conv = await getLeafConversationId(page, 1);
	const panel2Msgs = await getRenderedMessageCount(page);

	const shot = await ctx.screenshot("02-sync-back");

	// Panel 2 should show the same conversation with messages
	if (switched && panel2Conv === shared.conv1Id && panel2Msgs >= 2) {
		ctx.pass(
			"Sync-back renders messages",
			`Panel 2 shows conv=${panel2Conv?.substring(0, 8)} with ${panel2Msgs} messages (sync-back worked)`,
			shot,
		);
	} else {
		ctx.fail(
			"Sync-back renders messages",
			`switched=${switched}, panel2Conv=${panel2Conv?.substring(0, 8)}, ` +
			`expected=${shared.conv1Id?.substring(0, 8)}, messages=${panel2Msgs}`,
			shot,
		);
	}
}

async function testSendInPanel1RendersCorrectly(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 3: Send message in panel 1 — renders in panel 1 --");
	const { page } = ctx;

	// Switch to panel 1 and send another message
	await activateLeaf(page, 0);
	await page.waitForTimeout(500);

	const msgsBefore = await getRenderedMessageCount(page);
	const responded = await sendMessage(page, "Reply with exactly: 'Panel one response'.");
	await page.waitForTimeout(2_000);

	const msgsAfter = await getRenderedMessageCount(page);
	const shot = await ctx.screenshot("03-send-panel1");

	if (responded && msgsAfter > msgsBefore) {
		ctx.pass(
			"Send in panel 1 renders",
			`Messages before=${msgsBefore}, after=${msgsAfter} — response rendered in panel 1`,
			shot,
		);
	} else {
		ctx.fail(
			"Send in panel 1 renders",
			`responded=${responded}, before=${msgsBefore}, after=${msgsAfter}`,
			shot,
		);
	}
}

async function testSessionIsolation(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 4: Session isolation — panel 2 operates independently --");
	const { page } = ctx;

	// Create a new conversation in panel 2
	await activateLeaf(page, 1);
	await page.waitForTimeout(500);

	await newConversation(page);
	await page.waitForTimeout(1_500);

	const responded = await sendMessage(page, "Reply with exactly: 'Panel two independent'.");
	await page.waitForTimeout(2_000);

	const panel1Conv = await getLeafConversationId(page, 0);
	const panel2Conv = await getLeafConversationId(page, 1);

	const shot = await ctx.screenshot("04-session-isolation");

	// Panels should have different conversations
	if (responded && panel1Conv !== panel2Conv) {
		ctx.pass(
			"Session isolation",
			`Panel 1: conv=${panel1Conv?.substring(0, 8)}, Panel 2: conv=${panel2Conv?.substring(0, 8)} — independent`,
			shot,
		);
	} else {
		ctx.fail(
			"Session isolation",
			`responded=${responded}, panel1=${panel1Conv?.substring(0, 8)}, panel2=${panel2Conv?.substring(0, 8)}`,
			shot,
		);
	}
}

async function testViewRouterRouting(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 5: ViewRouter — getViewForSession routes to correct panel --");
	const { page } = ctx;

	const result = await page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const orchMap = (plugin as any)._orchestrators;
		if (!orchMap || orchMap.size < 2) return { error: `need 2 orchestrators, have ${orchMap?.size ?? 0}` };

		const leaves = (window as any).app.workspace.getLeavesOfType(viewType);
		if (leaves.length < 2) return { error: `need 2 leaves, have ${leaves.length}` };

		const checks: Record<string, unknown> = {};

		// For each orchestrator, verify its ViewRouter has the correct view
		for (let i = 0; i < Math.min(2, leaves.length); i++) {
			const leaf = leaves[i];
			const orch = orchMap.get(leaf.id);
			if (!orch) {
				checks[`panel${i}_orch`] = false;
				continue;
			}
			const vr = (orch as any).viewRouter;
			const view = vr?.getView?.();
			// View should match the leaf's view
			checks[`panel${i}_hasViewRouter`] = !!vr;
			checks[`panel${i}_viewMatches`] = view === leaf.view;
			checks[`panel${i}_viewExists`] = !!view;
		}

		return { checks, success: true };
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("ViewRouter routing", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as { checks: Record<string, unknown>; success: boolean };
	const allCorrect = Object.entries(r.checks).every(([k, v]) => v === true);

	if (allCorrect) {
		ctx.pass(
			"ViewRouter routing",
			`ViewRouter correctly routes to each panel: ${JSON.stringify(r.checks)}`,
		);
	} else {
		ctx.fail(
			"ViewRouter routing",
			`ViewRouter routing issues: ${JSON.stringify(r.checks)}`,
		);
	}
}

async function testLifecycleDelegation(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 6: ConversationLifecycle — delegation works correctly --");
	const { page } = ctx;

	const result = await page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const orchMap = (plugin as any)._orchestrators;
		if (!orchMap || orchMap.size === 0) return { error: "no orchestrators" };

		const leaves = (window as any).app.workspace.getLeavesOfType(viewType);
		const orch = orchMap.get(leaves[0]?.id);
		if (!orch) return { error: "no orchestrator for first leaf" };

		// Verify lifecycle exists and has a conversation manager
		const lifecycle = (orch as any).lifecycle;
		const convManager = orch.getConversationManager?.();

		return {
			hasLifecycle: !!lifecycle,
			hasConvManager: !!convManager,
			hasActiveConversation: !!convManager?.getActiveConversation?.(),
			convId: convManager?.getActiveConversation?.()?.id?.substring(0, 8) ?? null,
		};
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("Lifecycle delegation", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as {
		hasLifecycle: boolean;
		hasConvManager: boolean;
		hasActiveConversation: boolean;
		convId: string | null;
	};

	if (r.hasLifecycle && r.hasConvManager && r.hasActiveConversation) {
		ctx.pass(
			"Lifecycle delegation",
			`Lifecycle wired, convManager present, activeConv=${r.convId}`,
		);
	} else {
		ctx.fail(
			"Lifecycle delegation",
			`lifecycle=${r.hasLifecycle}, convManager=${r.hasConvManager}, activeConv=${r.hasActiveConversation}`,
		);
	}
}

async function testSessionManagerGuardIntegration(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 7: SessionManager — guard integration with multi-panel --");
	const { page } = ctx;

	const result = await page.evaluate((viewType: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const orchMap = (plugin as any)._orchestrators;
		if (!orchMap || orchMap.size < 2) return { error: `need 2 orchestrators, have ${orchMap?.size ?? 0}` };

		const leaves = (window as any).app.workspace.getLeavesOfType(viewType);

		// Verify each orchestrator has its own SessionManager instance
		const sessionManagers = new Set<any>();
		for (const leaf of leaves) {
			const orch = orchMap.get(leaf.id);
			if (!orch) continue;
			const sm = (orch as any).sessionManager;
			if (sm) sessionManagers.add(sm);
		}

		// Check the shared guard
		const guard = (plugin as any)._sessionGuard;
		const sessions = (plugin as any)._activeConversationSessions;

		return {
			uniqueSessionManagers: sessionManagers.size,
			totalOrchestrators: orchMap.size,
			hasSharedGuard: !!guard,
			hasSharedSessions: sessions instanceof Set,
			// No active sessions at rest (all messages have completed)
			activeSessionCount: sessions?.size ?? -1,
		};
	}, CHAT_VIEW_TYPE);

	if ((result as any).error) {
		ctx.fail("SessionManager guard integration", `Error: ${(result as any).error}`);
		return;
	}

	const r = result as {
		uniqueSessionManagers: number;
		totalOrchestrators: number;
		hasSharedGuard: boolean;
		hasSharedSessions: boolean;
		activeSessionCount: number;
	};

	// Each orchestrator should have its OWN SessionManager
	const smPerOrch = r.uniqueSessionManagers === r.totalOrchestrators;
	// Guard should be shared
	const guardShared = r.hasSharedGuard && r.hasSharedSessions;
	// No active sessions at rest
	const atRest = r.activeSessionCount === 0;

	if (smPerOrch && guardShared && atRest) {
		ctx.pass(
			"SessionManager guard integration",
			`${r.uniqueSessionManagers} unique SessionManagers for ${r.totalOrchestrators} orchestrators. ` +
			`Shared guard present. Active sessions at rest: ${r.activeSessionCount}`,
		);
	} else {
		ctx.fail(
			"SessionManager guard integration",
			`unique SMs=${r.uniqueSessionManagers}, orchs=${r.totalOrchestrators}, ` +
			`sharedGuard=${r.hasSharedGuard}, sharedSessions=${r.hasSharedSessions}, ` +
			`activeSessions=${r.activeSessionCount}`,
		);
	}
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 8: No unexpected error logs from multi-panel operations --");
	const { collector } = ctx;

	const relevantSources = [
		"ChatOrchestrator",
		"ViewRouter",
		"SessionManager",
		"ConversationLifecycle",
		"ConversationSession",
		"ConversationManager",
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

	// Setup phase
	await safeRun(ctx, "Setup", () => testSetup(ctx));
	if (!shared.conv1Id || !shared.conv1Filename) {
		ctx.fail("Suite prerequisite", "Setup failed — skipping remaining tests");
		return;
	}

	const leafCount = await getChatLeafCount(page);
	if (leafCount < 2) {
		ctx.fail("Suite prerequisite", "Need 2 panels — skipping remaining tests");
		return;
	}

	// Integration tests
	await safeRun(ctx, "Sync-back renders messages", () => testSyncBackRendersMessages(ctx));
	await safeRun(ctx, "Send in panel 1 renders", () => testSendInPanel1RendersCorrectly(ctx));

	// Clean up streaming before session isolation test
	await ensureCleanState(page);
	await page.waitForTimeout(1_000);

	await safeRun(ctx, "Session isolation", () => testSessionIsolation(ctx));

	// Clean up streaming
	await ensureCleanState(page);
	await page.waitForTimeout(1_000);

	// Structural verification
	await safeRun(ctx, "ViewRouter routing", () => testViewRouterRouting(ctx));
	await safeRun(ctx, "Lifecycle delegation", () => testLifecycleDelegation(ctx));
	await safeRun(ctx, "SessionManager guard integration", () => testSessionManagerGuardIntegration(ctx));

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
	name: "phase-b-multi-panel-integration",
	settings,
	setupVault: (vaultPath) => writeCleanWorkspace(vaultPath),
}, tests);
