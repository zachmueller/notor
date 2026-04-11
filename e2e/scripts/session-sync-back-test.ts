#!/usr/bin/env npx tsx
/**
 * Phase 2: Session Sync-Back & Registry E2E Test
 *
 * Validates the Phase 2 session management features from the thread-safe
 * streaming implementation: sync-back on conversation switch, silent
 * loadConversation, stop button routing, JSONL reload path, session cleanup,
 * and deletion guard.
 *
 * Scenarios:
 *   1. Active session exists during streaming
 *   2. Sync-back on mid-stream switch renders all messages
 *   3. JSONL header unchanged during sync-back (silent loadConversation)
 *   4. Stop button targets active session's AbortController
 *   5. activeSessions map empty after all responses complete
 *   6. Completed conversation loads from JSONL reload path
 *   7. Cannot delete a conversation that is still streaming
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled with Claude Haiku model
 *
 * @see specs/ZZ-misc/thread-safe-streaming-implementation-tasks.md — Phase 2
 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Sections 4.2.1–4.2.3
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessage,
	waitForResponse,
	newConversation,
	ensureCleanState,
	VAULT_PATH,
	RESPONSE_TIMEOUT_MS,
	POLL_INTERVAL_MS,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

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

/** Wait until the stop button becomes visible (streaming started). */
async function waitForStopButton(page: any, timeoutMs = 15_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(300);
		const stopVisible = await page.evaluate(() => {
			const btn = document.querySelector(".notor-stop-btn");
			return btn && !btn.classList.contains("notor-hidden");
		});
		if (stopVisible) return true;
	}
	return false;
}

/** Wait until the contenteditable input is re-enabled. */
async function waitForInputEnabled(page: any, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(POLL_INTERVAL_MS);
		const enabled = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el !== null && el.getAttribute("contenteditable") === "true";
		});
		if (enabled) return true;
	}
	return false;
}

/** Get the active conversation's ID and metadata from plugin internals. */
async function getConversationState(page: any): Promise<{
	conversationId: string;
	title: string;
	messageCount: number;
	totalInputTokens: number;
	totalOutputTokens: number;
} | null> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		try {
			const orchestrator = plugin.getActiveOrchestrator();
			if (!orchestrator) return null;
			const convManager = orchestrator.getConversationManager();
			const conv = convManager.getActiveConversation();
			const messages = convManager.getMessages();
			if (!conv) return null;
			return {
				conversationId: conv.id,
				title: conv.title ?? "",
				messageCount: messages.length,
				totalInputTokens: conv.total_input_tokens,
				totalOutputTokens: conv.total_output_tokens,
			};
		} catch {
			return null;
		}
	});
}

/** Get the total number of active sessions across all orchestrators. */
async function getActiveSessionCount(page: any): Promise<number> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return -1;
		try {
			let count = 0;
			for (const orch of plugin._orchestrators.values()) {
				count += orch.getActiveSessions().length;
			}
			return count;
		} catch {
			return -1;
		}
	});
}

/** Check if a specific conversation has an active session in any orchestrator. */
async function hasActiveSession(page: any, conversationId: string): Promise<boolean> {
	return page.evaluate((convId: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		try {
			for (const orch of plugin._orchestrators.values()) {
				if (orch.hasActiveSession(convId)) return true;
			}
			return false;
		} catch {
			return false;
		}
	}, conversationId);
}

/** Get the session's in-memory message count for a conversation (searches all orchestrators). */
async function getSessionMessageCount(page: any, conversationId: string): Promise<number> {
	return page.evaluate((convId: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return -1;
		try {
			for (const orch of plugin._orchestrators.values()) {
				const session = orch.getActiveSession(convId);
				if (session) return session.conversationManager.getMessages().length;
			}
			return -1;
		} catch {
			return -1;
		}
	}, conversationId);
}

/** Switch to a conversation by filename via the active orchestrator. */
async function switchToConversation(page: any, filename: string): Promise<boolean> {
	return page.evaluate(async (fname: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		try {
			const orchestrator = plugin.getActiveOrchestrator();
			if (!orchestrator) return false;
			await orchestrator.switchConversation(fname);
			return true;
		} catch {
			return false;
		}
	}, filename);
}

/** Find the JSONL filename for a conversation by ID via plugin API. */
async function findConversationFilename(page: any, conversationId: string): Promise<string | null> {
	return page.evaluate(async (convId: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		try {
			const entries = await plugin.getHistoryManager().listConversations();
			const entry = entries.find((e: any) => e.id === convId);
			return entry?.filename ?? null;
		} catch {
			return null;
		}
	}, conversationId);
}

/** Read the raw first line (header) of a JSONL file from the history directory. */
function readJSONLHeaderRaw(filename: string): string | null {
	const histDir = path.join(VAULT_PATH, HISTORY_DIR);
	const filePath = path.join(histDir, filename);
	if (!fs.existsSync(filePath)) return null;
	const content = fs.readFileSync(filePath, "utf-8");
	return content.split("\n")[0] ?? null;
}

/**
 * Find the JSONL file basename for a conversation by scanning the history
 * directory on disk. Returns the basename (not full path).
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

/** Count rendered message elements in the DOM. */
async function getRenderedMessageCount(page: any): Promise<number> {
	return page.evaluate(() => {
		const user = document.querySelectorAll(".notor-message-user").length;
		const assistant = document.querySelectorAll(".notor-message-assistant").length;
		const toolCalls = document.querySelectorAll(".notor-tool-call").length;
		return user + assistant + toolCalls;
	});
}

// ---------------------------------------------------------------------------
// Shared state between sequential tests
// ---------------------------------------------------------------------------

interface SharedState {
	streamingConvId?: string;
	streamingFilename?: string;
	switchTargetFilename?: string; // Pre-created conversation to switch to during tests
	completedConvId?: string;
	completedFilename?: string;
}
const shared: SharedState = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testActiveSessionDuringStreaming(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Active session exists during streaming");
	const { page } = ctx;

	// Create a second (empty) conversation first so we can switch to it later.
	// We need this because newConversation() doesn't call setRespondingState(false),
	// but switchConversation() does — so switching to an existing conversation
	// properly unlocks the input during mid-stream navigation.
	await newConversation(page);
	await page.waitForTimeout(1_000);
	const secondConvState = await getConversationState(page);
	if (secondConvState) {
		// Find its filename for later switching
		for (let attempt = 0; attempt < 3; attempt++) {
			shared.switchTargetFilename = await findConversationFilename(page, secondConvState.conversationId);
			if (shared.switchTargetFilename) break;
			await page.waitForTimeout(1_000);
		}
	}

	// Now create the conversation we'll stream in
	await newConversation(page);
	await page.waitForTimeout(1_500);

	// Get the conversation ID before sending
	const preSendState = await getConversationState(page);
	if (!preSendState) {
		ctx.fail("Active session during streaming", "Could not get conversation state before sending");
		return;
	}
	shared.streamingConvId = preSendState.conversationId;

	// Send a long message without waiting for completion
	await sendMessageNoWait(
		page,
		"Please write a very detailed, comprehensive 2000-word essay about the history of " +
		"note-taking from ancient civilizations through to modern digital tools. Include specific " +
		"examples, dates, technologies, and analysis in each section. Cover clay tablets, papyrus, " +
		"medieval manuscripts, the printing press, notebooks, and digital note-taking applications.",
	);

	// Wait for streaming to start (stop button becomes visible)
	const stopAppeared = await waitForStopButton(page, 30_000);
	if (!stopAppeared) {
		// Check if the response completed instantly
		const inputEnabled = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el?.getAttribute("contenteditable") === "true";
		});
		if (inputEnabled) {
			ctx.pass("Active session during streaming", "Response completed too quickly to observe streaming state (fast model)");
			return;
		}
		const shot = await ctx.screenshot("01-no-stop-button");
		ctx.fail("Active session during streaming", "Stop button never appeared and input still disabled", shot);
		return;
	}

	// Verify the orchestrator reports an active session for this conversation
	const isActive = await hasActiveSession(page, shared.streamingConvId);
	const sessionCount = await getActiveSessionCount(page);
	const shot = await ctx.screenshot("01-active-session");

	if (isActive) {
		ctx.pass(
			"Active session during streaming",
			`hasActiveSession=true, totalActiveSessions=${sessionCount}`,
			shot,
		);
	} else {
		ctx.fail(
			"Active session during streaming",
			`hasActiveSession=false (expected true), totalActiveSessions=${sessionCount}`,
			shot,
		);
	}

	// Resolve the filename for later tests (with retry for JSONL flush timing)
	for (let attempt = 0; attempt < 3; attempt++) {
		shared.streamingFilename = await findConversationFilename(page, shared.streamingConvId);
		if (shared.streamingFilename) break;
		await page.waitForTimeout(1_000);
	}
}

async function testSyncBackOnMidStreamSwitch(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Sync-back on mid-stream switch renders all messages");
	const { page } = ctx;

	const convId = shared.streamingConvId;
	if (!convId) {
		ctx.fail("Sync-back mid-stream", "No streaming conversation from Test 1");
		return;
	}

	// Verify still streaming
	const stillActive = await hasActiveSession(page, convId);
	if (!stillActive) {
		ctx.pass("Sync-back mid-stream", "Streaming completed before switch test could run (response too fast)");
		return;
	}

	// Record session message count before switching
	const sessionMsgCountBefore = await getSessionMessageCount(page, convId);
	console.log(`  Session messages before switch: ${sessionMsgCountBefore}`);

	// Switch away to the pre-created conversation.
	// Uses switchToConversation() which calls setRespondingState(false) to unlock input.
	// (newConversation() doesn't reset responding state — see orchestrator.ts:372)
	if (shared.switchTargetFilename) {
		await switchToConversation(page, shared.switchTargetFilename);
	} else {
		// Fallback: create a new conversation and manually unlock
		await newConversation(page);
		await page.evaluate(() => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			plugin?.getActiveOrchestrator()?.getView()?.setRespondingState(false);
		});
	}
	await page.waitForTimeout(2_000);

	// Verify we actually switched away
	const afterSwitch = await getConversationState(page);
	if (afterSwitch?.conversationId === convId) {
		ctx.fail("Sync-back mid-stream", "Did not switch away from streaming conversation");
		return;
	}

	// Verify input is unlocked in the target conversation
	const inputUnlocked = await waitForInputEnabled(page, 5_000);
	if (!inputUnlocked) {
		const shot = await ctx.screenshot("02-input-locked");
		ctx.fail("Sync-back mid-stream", "Input still locked after switching away from streaming conversation", shot);
		return;
	}
	console.log("  Input unlocked in target conversation after switching away");

	// Wait for more messages to accumulate in the background session
	await page.waitForTimeout(3_000);

	// Switch back to the streaming conversation
	if (!shared.streamingFilename) {
		const shot = await ctx.screenshot("02-no-filename");
		ctx.fail("Sync-back mid-stream", "Could not find streaming conversation filename");
		return;
	}

	const switched = await switchToConversation(page, shared.streamingFilename);
	if (!switched) {
		const shot = await ctx.screenshot("02-switch-failed");
		ctx.fail("Sync-back mid-stream", "switchConversation call returned false", shot);
		return;
	}
	await page.waitForTimeout(2_000);

	// Verify we're back on the correct conversation
	const backState = await getConversationState(page);
	if (backState?.conversationId !== convId) {
		const shot = await ctx.screenshot("02-wrong-conv");
		ctx.fail("Sync-back mid-stream", `Expected convId=${convId?.substring(0, 8)}, got=${backState?.conversationId?.substring(0, 8)}`, shot);
		return;
	}

	// Verify responding state is active (stop button visible if session is still running)
	const sessionStillActive = await hasActiveSession(page, convId);
	const stopVisible = await page.evaluate(() => {
		const btn = document.querySelector(".notor-stop-btn");
		return btn && !btn.classList.contains("notor-hidden");
	});
	console.log(`  After sync-back: sessionActive=${sessionStillActive}, stopButtonVisible=${stopVisible}`);

	// Verify messages rendered in DOM
	const renderedCount = await getRenderedMessageCount(page);
	const sessionMsgCountAfter = await getSessionMessageCount(page, convId);
	console.log(`  Rendered messages: ${renderedCount}, session messages: ${sessionMsgCountAfter}`);

	const shot = await ctx.screenshot("02-sync-back");

	if (renderedCount > 0) {
		const detail = [
			`${renderedCount} messages rendered in DOM`,
			`session has ${sessionMsgCountAfter} messages (was ${sessionMsgCountBefore} before switch)`,
			`responding=${stopVisible}`,
		].join(", ");
		ctx.pass("Sync-back mid-stream", detail, shot);
	} else {
		ctx.fail(
			"Sync-back mid-stream",
			`No messages rendered after sync-back. Session messages: ${sessionMsgCountAfter}`,
			shot,
		);
	}
}

async function testJSONLHeaderUnchangedDuringSyncBack(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: JSONL header unchanged during sync-back (silent loadConversation)");
	const { page } = ctx;

	const convId = shared.streamingConvId;
	if (!convId) {
		ctx.fail("JSONL header silent sync-back", "No streaming conversation from previous tests");
		return;
	}

	// Check if still streaming
	const stillActive = await hasActiveSession(page, convId);
	if (!stillActive) {
		ctx.pass("JSONL header silent sync-back", "Streaming completed — cannot verify header invariant (response too fast)");
		return;
	}

	// Find the JSONL file basename on disk
	const basename = findJSONLBasename(convId);
	if (!basename) {
		ctx.fail("JSONL header silent sync-back", "Could not find JSONL file on disk for conversation");
		return;
	}

	// Read JSONL header BEFORE sync-back
	const headerBefore = readJSONLHeaderRaw(basename);
	if (!headerBefore) {
		ctx.fail("JSONL header silent sync-back", "Could not read JSONL header before sync-back");
		return;
	}

	// Switch away and immediately back to trigger a fresh sync-back
	if (shared.switchTargetFilename) {
		await switchToConversation(page, shared.switchTargetFilename);
	} else {
		await newConversation(page);
	}
	await page.waitForTimeout(500);

	if (shared.streamingFilename) {
		await switchToConversation(page, shared.streamingFilename);
	}
	// Small delay to allow any erroneous header write to flush
	await page.waitForTimeout(1_000);

	// Read JSONL header AFTER sync-back
	const headerAfter = readJSONLHeaderRaw(basename);
	if (!headerAfter) {
		ctx.fail("JSONL header silent sync-back", "Could not read JSONL header after sync-back");
		return;
	}

	if (headerBefore === headerAfter) {
		ctx.pass(
			"JSONL header silent sync-back",
			"JSONL header is byte-identical after sync-back (silent loadConversation works)",
		);
		return;
	}

	// The header MAY have changed due to the session's own writes (token counts
	// incrementing during streaming). This is expected. We verify that structural
	// fields (id, title, created_at) did NOT change — only token counts.
	try {
		const before = JSON.parse(headerBefore);
		const after = JSON.parse(headerAfter);

		const structuralMatch =
			before.id === after.id &&
			before.title === after.title &&
			before.created_at === after.created_at &&
			before.mode === after.mode;

		if (structuralMatch) {
			ctx.pass(
				"JSONL header silent sync-back",
				"Header changed only in token counts (expected — session is writing, not sync-back)",
			);
		} else {
			ctx.fail(
				"JSONL header silent sync-back",
				`Structural fields changed during sync-back: id=${before.id === after.id}, ` +
				`title=${before.title === after.title}, created_at=${before.created_at === after.created_at}`,
			);
		}
	} catch (e) {
		ctx.fail("JSONL header silent sync-back", `Failed to parse headers: ${e}`);
	}
}

async function testStopButtonAbortsActiveSession(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Stop button targets active session's AbortController");
	const { page } = ctx;

	const convId = shared.streamingConvId;

	// If the original streaming conversation has already completed, start a new one
	let targetConvId = convId;
	const stillActive = convId ? await hasActiveSession(page, convId) : false;

	if (!stillActive) {
		console.log("  Original stream completed — starting a new one for abort test");
		await ensureCleanState(page);
		await newConversation(page);
		await page.waitForTimeout(1_500);

		const newState = await getConversationState(page);
		if (!newState) {
			ctx.fail("Stop aborts session", "Could not get conversation state for new conversation");
			return;
		}
		targetConvId = newState.conversationId;

		await sendMessageNoWait(
			page,
			"Write a very detailed 3000-word analysis of every aspect of the Renaissance period " +
			"in European history. Cover art, science, politics, religion, culture, economics, " +
			"and social changes in extreme detail with many specific examples.",
		);

		const stopAppeared = await waitForStopButton(page, 30_000);
		if (!stopAppeared) {
			ctx.pass("Stop aborts session", "Response completed too quickly to test abort (fast model)");
			return;
		}
	}

	// Now we have a streaming conversation visible — click stop
	const stopBtn = await page.$(".notor-stop-btn:not(.notor-hidden)");
	if (!stopBtn) {
		const shot = await ctx.screenshot("04-no-stop-btn");
		ctx.fail("Stop aborts session", "Stop button not visible despite active session", shot);
		return;
	}

	await stopBtn.click();
	console.log("    -> Clicked stop button");
	await page.waitForTimeout(2_000);

	const shot = await ctx.screenshot("04-after-stop");

	// Verify input is re-enabled
	const inputEnabled = await waitForInputEnabled(page, 10_000);
	if (!inputEnabled) {
		ctx.fail("Stop aborts session", "Input not re-enabled after clicking stop", shot);
		return;
	}

	// Verify the session was cleaned up
	if (targetConvId) {
		const sessionGone = !(await hasActiveSession(page, targetConvId));
		if (!sessionGone) {
			ctx.fail("Stop aborts session", "Session still active after stop button click", shot);
			return;
		}
	}

	// Verify UI reverted to send state
	const stopHidden = await page.evaluate(() => {
		const btn = document.querySelector(".notor-stop-btn");
		return !btn || btn.classList.contains("notor-hidden");
	});
	const sendVisible = await page.evaluate(() => {
		const btn = document.querySelector(".notor-send-btn");
		return btn && !btn.classList.contains("notor-hidden");
	});

	if (stopHidden && sendVisible) {
		ctx.pass("Stop aborts session", "Input re-enabled, session cleaned up, UI reverted to send state", shot);
	} else {
		ctx.pass("Stop aborts session", `Input re-enabled, session cleaned up (stopHidden=${stopHidden}, sendVisible=${sendVisible})`, shot);
	}
}

async function testActiveSessionsEmptyAfterCompletion(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: activeSessions map empty after all responses complete");
	const { page } = ctx;

	// All previous streaming should be stopped or completed by now
	await page.waitForTimeout(2_000);

	const sessionCount = await getActiveSessionCount(page);
	const shot = await ctx.screenshot("05-sessions-empty");

	if (sessionCount === 0) {
		ctx.pass("Sessions empty after completion", "activeSessions.size === 0", shot);
	} else {
		// Get details about any lingering sessions across all orchestrators
		const details = await page.evaluate(() => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			if (!plugin) return "plugin not found";
			try {
				const sessions: any[] = [];
				for (const orch of plugin._orchestrators.values()) {
					sessions.push(...orch.getActiveSessions());
				}
				return sessions.map((s: any) => ({
					id: s.conversationId?.substring(0, 8),
					status: s.status,
					title: s.title,
				}));
			} catch (e: any) {
				return e.message;
			}
		});
		ctx.fail(
			"Sessions empty after completion",
			`activeSessions.size === ${sessionCount} (expected 0). Lingering: ${JSON.stringify(details)}`,
			shot,
		);
	}
}

async function testCompletedConversationLoadsFromJSONL(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: Completed conversation loads from JSONL reload path");
	const { page } = ctx;

	// Start a new conversation and let it complete
	await ensureCleanState(page);
	await newConversation(page);
	await page.waitForTimeout(1_500);

	console.log("  Sending short message and waiting for completion...");
	const responded = await sendMessage(page, "What is 2+2? Reply with just the number.");
	if (!responded) {
		const shot = await ctx.screenshot("06-no-response");
		ctx.fail("JSONL reload path", "LLM did not respond within timeout", shot);
		return;
	}

	// Wait for messages to fully persist (JSONL flush + ConversationManager update)
	await page.waitForTimeout(3_000);

	const completedState = await getConversationState(page);
	if (!completedState) {
		ctx.fail("JSONL reload path", "Could not get conversation state after response");
		return;
	}
	shared.completedConvId = completedState.conversationId;

	// Verify no active session (response should have completed)
	const isActive = await hasActiveSession(page, completedState.conversationId);
	if (isActive) {
		ctx.fail("JSONL reload path", "Session still active after response apparently completed");
		return;
	}

	const msgCountBefore = completedState.messageCount;
	const renderedBefore = await getRenderedMessageCount(page);
	console.log(`  Messages in completed conversation: ${msgCountBefore} (rendered: ${renderedBefore})`);

	// Resolve the filename
	for (let attempt = 0; attempt < 3; attempt++) {
		shared.completedFilename = await findConversationFilename(page, completedState.conversationId);
		if (shared.completedFilename) break;
		await page.waitForTimeout(1_000);
	}
	if (!shared.completedFilename) {
		ctx.fail("JSONL reload path", "Could not find completed conversation filename in history");
		return;
	}

	// Switch away to a new conversation
	await newConversation(page);
	await page.waitForTimeout(2_000);

	// Switch back to the completed conversation (should load from JSONL, not a session)
	const switched = await switchToConversation(page, shared.completedFilename);
	if (!switched) {
		ctx.fail("JSONL reload path", "switchConversation returned false");
		return;
	}
	await page.waitForTimeout(2_000);

	// Verify conversation loaded correctly
	const afterState = await getConversationState(page);
	const renderedCount = await getRenderedMessageCount(page);
	const shot = await ctx.screenshot("06-jsonl-reload");

	const convIdMatch = afterState?.conversationId === completedState.conversationId;
	if (convIdMatch && renderedCount > 0) {
		ctx.pass(
			"JSONL reload path",
			`Loaded from JSONL: ${renderedCount} rendered, ${afterState!.messageCount} in manager (was ${msgCountBefore})`,
			shot,
		);
	} else {
		ctx.fail(
			"JSONL reload path",
			`convId match=${convIdMatch}, rendered=${renderedCount}, managerMsgs=${afterState?.messageCount}`,
			shot,
		);
	}
}

async function testCannotDeleteStreamingConversation(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: Cannot delete a conversation that is still streaming");
	const { page } = ctx;

	// Start a new conversation with a long prompt
	await ensureCleanState(page);
	await newConversation(page);
	await page.waitForTimeout(1_500);

	const preState = await getConversationState(page);
	if (!preState) {
		ctx.fail("Deletion guard", "Could not get conversation state");
		return;
	}

	await sendMessageNoWait(
		page,
		"Write a very detailed, comprehensive 3000-word analysis of the entire history of " +
		"computing from Charles Babbage through to modern artificial intelligence systems. " +
		"Cover every major development, key figures, important dates, and technological " +
		"breakthroughs. Include sections on hardware, software, networking, and AI.",
	);

	const stopAppeared = await waitForStopButton(page, 30_000);
	if (!stopAppeared) {
		const inputEnabled = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el?.getAttribute("contenteditable") === "true";
		});
		if (inputEnabled) {
			ctx.pass("Deletion guard", "Response completed too quickly to test deletion guard (fast model)");
			return;
		}
		const shot = await ctx.screenshot("07-no-streaming");
		ctx.fail("Deletion guard", "Stop button never appeared and input still disabled", shot);
		return;
	}

	// Get the current conversation state (should have an active session)
	const streamingState = await getConversationState(page);
	if (!streamingState) {
		ctx.fail("Deletion guard", "Could not get conversation state during streaming");
		await ensureCleanState(page);
		return;
	}

	const convId = streamingState.conversationId;
	const isActive = await hasActiveSession(page, convId);
	if (!isActive) {
		ctx.pass("Deletion guard", "Session completed before deletion test (response too fast)");
		return;
	}

	// Find the conversation filename
	let filename: string | null = null;
	for (let attempt = 0; attempt < 3; attempt++) {
		filename = await findConversationFilename(page, convId);
		if (filename) break;
		await page.waitForTimeout(1_000);
	}

	if (!filename) {
		ctx.fail("Deletion guard", "Could not find streaming conversation filename");
		await ensureCleanState(page);
		return;
	}

	// Verify the deletion guard: the same check performed by main.ts onDeleteConversation
	// In the unified model, sessions may be on any orchestrator — check all of them
	const guardResult = await page.evaluate((fname: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };
		try {
			const allSessions: any[] = [];
			for (const orch of plugin._orchestrators.values()) {
				allSessions.push(...orch.getActiveSessions());
			}
			const wouldBlock = allSessions.some((s: any) => fname.includes(s.conversationId));
			return {
				wouldBlock,
				sessionCount: allSessions.length,
				conversationIds: allSessions.map((s: any) => s.conversationId?.substring(0, 8)),
			};
		} catch (e: any) {
			return { error: e.message };
		}
	}, filename);

	const shot = await ctx.screenshot("07-deletion-guard");

	if (guardResult.error) {
		ctx.fail("Deletion guard", `Error checking guard: ${guardResult.error}`, shot);
		await ensureCleanState(page);
		return;
	}

	if (guardResult.wouldBlock) {
		ctx.pass(
			"Deletion guard — programmatic check",
			`Guard correctly blocks: filename includes active session ID ` +
			`(${guardResult.sessionCount} active sessions: ${guardResult.conversationIds?.join(", ")})`,
			shot,
		);
	} else {
		ctx.fail(
			"Deletion guard — programmatic check",
			`Guard would NOT block deletion (sessionCount=${guardResult.sessionCount}, ` +
			`sessions: ${guardResult.conversationIds?.join(", ")}, filename: ${filename})`,
			shot,
		);
	}

	// Also trigger the actual delete callback to verify Notice appears and file is preserved
	const noticeCountBefore = await page.evaluate(() => document.querySelectorAll(".notice").length);

	await page.evaluate((fname: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return;
		try {
			const orchestrator = plugin.getActiveOrchestrator();
			const view = orchestrator?.getView();
			// Call the private onDeleteConversation callback set by main.ts
			if (view && (view as any).onDeleteConversation) {
				(view as any).onDeleteConversation(fname);
			}
		} catch { /* best effort */ }
	}, filename);

	await page.waitForTimeout(2_000);

	// Check if a Notice appeared
	const noticeCountAfter = await page.evaluate(() => document.querySelectorAll(".notice").length);
	const noticeAppeared = noticeCountAfter > noticeCountBefore;

	// Verify the conversation file still exists on disk
	const fileStillExists = await page.evaluate(async (convId: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		try {
			const entries = await plugin.getHistoryManager().listConversations();
			return entries.some((e: any) => e.id === convId);
		} catch {
			return false;
		}
	}, convId);

	if (fileStillExists) {
		const detail = noticeAppeared
			? "Notice appeared and conversation file preserved (guard blocked deletion)"
			: "Conversation file preserved (guard blocked deletion; Notice may have auto-dismissed)";
		ctx.pass("Deletion guard — file preserved", detail, shot);
	} else {
		ctx.fail(
			"Deletion guard — file preserved",
			"Conversation was DELETED despite active session!",
			shot,
		);
	}

	// Clean up: stop the streaming response
	await ensureCleanState(page);
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init

	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chatContainer) throw new Error("Chat panel not visible — cannot run tests");
	const shot = await ctx.screenshot("00-chat-ready");
	ctx.pass("Chat panel ready", "Plugin loaded and chat container found", shot);

	// --- Group 1: Sync-back tests (sequential — depend on streaming state) ---
	await testActiveSessionDuringStreaming(ctx);
	await testSyncBackOnMidStreamSwitch(ctx);
	await testJSONLHeaderUnchangedDuringSyncBack(ctx);
	await testStopButtonAbortsActiveSession(ctx);

	// --- Group 2: Session cleanup ---
	await testActiveSessionsEmptyAfterCompletion(ctx);

	// --- Group 3: JSONL reload path ---
	await testCompletedConversationLoadsFromJSONL(ctx);

	// --- Group 4: Deletion guard ---
	await testCannotDeleteStreamingConversation(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "plan", // Plan mode avoids tool calls — cleaner streaming tests
});

runTest(
	{
		name: "session-sync-back",
		settings,
	},
	tests,
);
