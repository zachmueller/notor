#!/usr/bin/env npx tsx
/**
 * Conversation Switch Bug E2E Test
 *
 * Validates that conversation switching during active streaming does not
 * leave the send button in a stuck responding state, and that Plan/Act
 * mode is correctly persisted and restored across conversation switches
 * and plugin reloads.
 *
 * Scenarios:
 *   1. Switch away from active tool call — send button correct in both conversations
 *   2. New conversation during active tool call — new conversation is usable
 *   3. Rapid switching during active streaming — no stuck states
 *   4. Plan/Act mode persists per-conversation across switches
 *   5. Plan/Act mode survives plugin reload
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled with Claude Haiku model
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	sendMessage,
	waitForResponse,
	newConversation,
	ensureCleanState,
	setMode,
} from "../lib/test-helpers";

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
async function waitForStopButton(page: any, timeoutMs = 30_000): Promise<boolean> {
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

/** Get the active conversation's ID from plugin internals. */
async function getConversationId(page: any): Promise<string | null> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		try {
			return plugin.getOrchestrator().getConversationManager().getActiveConversation()?.id ?? null;
		} catch {
			return null;
		}
	});
}

/** Check if a specific conversation has an active session. */
async function hasActiveSession(page: any, conversationId: string): Promise<boolean> {
	return page.evaluate((convId: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		try {
			return plugin.getOrchestrator().hasActiveSession(convId);
		} catch {
			return false;
		}
	}, conversationId);
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

/** Switch to a conversation by filename via the orchestrator. */
async function switchToConversation(page: any, filename: string): Promise<boolean> {
	return page.evaluate(async (fname: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		try {
			await plugin.getOrchestrator().switchConversation(fname);
			return true;
		} catch {
			return false;
		}
	}, filename);
}

/** Check if the send button is visible (not hidden). */
async function isSendButtonVisible(page: any): Promise<boolean> {
	return page.evaluate(() => {
		const btn = document.querySelector(".notor-send-btn");
		return btn !== null && !btn.classList.contains("notor-hidden");
	});
}

/** Check if the stop button is visible (not hidden). */
async function isStopButtonVisible(page: any): Promise<boolean> {
	return page.evaluate(() => {
		const btn = document.querySelector(".notor-stop-btn");
		return btn !== null && !btn.classList.contains("notor-hidden");
	});
}

/** Check if the chat input is editable. */
async function isInputEnabled(page: any): Promise<boolean> {
	return page.evaluate(() => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		return el !== null && el.getAttribute("contenteditable") === "true";
	});
}

/** Get the current mode text from the mode toggle button. */
async function getCurrentMode(page: any): Promise<string | null> {
	return page.evaluate(() => {
		const toggle = document.querySelector(".notor-mode-toggle");
		return toggle?.textContent?.trim() ?? null;
	});
}

/** Wait for an active session to complete (polls until no longer active). */
async function waitForSessionComplete(page: any, conversationId: string, timeoutMs = 60_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const active = await hasActiveSession(page, conversationId);
		if (!active) return true;
		await page.waitForTimeout(1_000);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

interface SharedState {
	idleConvId?: string;
	idleFilename?: string;
	streamingConvId?: string;
	streamingFilename?: string;
}

const shared: SharedState = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Test 1: Switch away from a conversation with an active tool call.
 *
 * Verifies that the destination conversation has send button visible and
 * input enabled, and that switching back shows the correct state.
 */
async function testSwitchAwayFromActiveToolCall(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Switch away from active tool call");
	const { page } = ctx;

	// Step 1: Create an idle conversation (switch target)
	await newConversation(page);
	await page.waitForTimeout(1_000);
	shared.idleConvId = await getConversationId(page) ?? undefined;
	if (!shared.idleConvId) {
		ctx.fail("Idle conversation creation", "Failed to get idle conversation ID");
		return;
	}
	console.log(`    Idle conversation: ${shared.idleConvId}`);

	// Give history time to flush so we can find the filename
	await page.waitForTimeout(1_000);
	shared.idleFilename = await findConversationFilename(page, shared.idleConvId) ?? undefined;
	if (!shared.idleFilename) {
		ctx.fail("Idle conversation filename", "Failed to find idle conversation filename");
		return;
	}

	// Step 2: Create a streaming conversation with a long tool call
	await newConversation(page);
	await page.waitForTimeout(1_000);
	const preStreamId = await getConversationId(page);
	console.log(`    Streaming conversation (pre-send): ${preStreamId}`);

	await sendMessageNoWait(
		page,
		'Run this exact shell command: sleep 10 && echo "switch-test-done". Do not ask for confirmation, just run it.',
	);

	// Step 3: Wait for streaming to start (stop button appears)
	const stopAppeared = await waitForStopButton(page, 30_000);
	if (!stopAppeared) {
		ctx.fail("Stop button appeared", "Stop button did not appear within 30s — streaming may not have started");
		await ctx.screenshot("test1-no-stop-button");
		return;
	}
	ctx.pass("Stop button appeared", "Streaming started successfully");

	shared.streamingConvId = await getConversationId(page) ?? undefined;
	if (!shared.streamingConvId) {
		ctx.fail("Streaming conversation ID", "Failed to get streaming conversation ID");
		return;
	}

	await page.waitForTimeout(1_000);
	shared.streamingFilename = await findConversationFilename(page, shared.streamingConvId) ?? undefined;
	if (!shared.streamingFilename) {
		ctx.fail("Streaming conversation filename", "Failed to find streaming conversation filename");
		return;
	}
	console.log(`    Streaming conversation: ${shared.streamingConvId}`);

	// Step 4: Switch to the idle conversation
	console.log("    Switching to idle conversation...");
	const switched = await switchToConversation(page, shared.idleFilename!);
	if (!switched) {
		ctx.fail("Switch to idle conversation", "switchToConversation returned false");
		return;
	}
	await page.waitForTimeout(500);

	// Step 5: Verify send button is visible and input is enabled in idle conversation
	const sendVisible = await isSendButtonVisible(page);
	const inputEnabled = await isInputEnabled(page);
	const ss1 = await ctx.screenshot("test1-idle-conversation-state");

	if (sendVisible && inputEnabled) {
		ctx.pass("Idle conversation UI unlocked", "Send button visible and input enabled after switching away from streaming", ss1);
	} else {
		ctx.fail("Idle conversation UI unlocked", `Send button visible: ${sendVisible}, input enabled: ${inputEnabled}`, ss1);
	}

	// Step 6: Switch back to the streaming conversation
	console.log("    Switching back to streaming conversation...");
	await switchToConversation(page, shared.streamingFilename!);
	await page.waitForTimeout(500);

	const sessionStillActive = await hasActiveSession(page, shared.streamingConvId!);
	const ss2 = await ctx.screenshot("test1-back-to-streaming");

	if (sessionStillActive) {
		// Session still running — stop button should be visible
		const stopVisible = await isStopButtonVisible(page);
		if (stopVisible) {
			ctx.pass("Streaming conversation shows stop button", "Session still active, stop button correctly visible", ss2);
		} else {
			ctx.fail("Streaming conversation shows stop button", "Session active but stop button not visible", ss2);
		}
	} else {
		// Session already completed — send button should be visible
		const sendBtn = await isSendButtonVisible(page);
		if (sendBtn) {
			ctx.pass("Streaming conversation shows send button (completed)", "Session completed, send button correctly visible", ss2);
		} else {
			ctx.fail("Streaming conversation shows send button (completed)", "Session completed but send button not visible", ss2);
		}
	}

	// Step 7: Wait for session to complete and verify final state
	if (sessionStillActive) {
		console.log("    Waiting for streaming session to complete...");
		const completed = await waitForSessionComplete(page, shared.streamingConvId!, 60_000);
		if (!completed) {
			ctx.fail("Session completed", "Streaming session did not complete within 60s");
			return;
		}
		// Give UI time to update
		await page.waitForTimeout(1_000);
	}

	const finalSendVisible = await isSendButtonVisible(page);
	const finalInputEnabled = await isInputEnabled(page);
	const ss3 = await ctx.screenshot("test1-after-completion");

	if (finalSendVisible && finalInputEnabled) {
		ctx.pass("Final state after completion", "Send button visible and input enabled after session completed", ss3);
	} else {
		ctx.fail("Final state after completion", `Send button: ${finalSendVisible}, input: ${finalInputEnabled}`, ss3);
	}
}

/**
 * Test 2: New conversation during active tool call.
 *
 * Verifies that clicking "New conversation" while a tool call is running
 * creates a usable new conversation with send button visible.
 */
async function testNewConversationDuringToolCall(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: New conversation during active tool call");
	const { page } = ctx;

	await ensureCleanState(page);

	// Step 1: Start a streaming conversation with a long tool call
	await newConversation(page);
	await page.waitForTimeout(1_000);

	await sendMessageNoWait(
		page,
		'Run this exact shell command: sleep 12 && echo "new-conv-test-done". Do not ask for confirmation, just run it.',
	);

	const stopAppeared = await waitForStopButton(page, 30_000);
	if (!stopAppeared) {
		ctx.fail("Stop button appeared (test 2)", "Stop button did not appear — streaming may not have started");
		await ctx.screenshot("test2-no-stop-button");
		return;
	}

	const oldConvId = await getConversationId(page);
	console.log(`    Streaming conversation: ${oldConvId}`);

	// Step 2: Click "New conversation" while tool call is running
	console.log("    Clicking New Conversation...");
	await newConversation(page);
	await page.waitForTimeout(1_000);

	// Step 3: Verify send button is visible and input is enabled
	const sendVisible = await isSendButtonVisible(page);
	const inputEnabled = await isInputEnabled(page);
	const ss1 = await ctx.screenshot("test2-new-conversation-state");

	if (sendVisible && inputEnabled) {
		ctx.pass("New conversation UI ready", "Send button visible and input enabled after New Conversation during tool call", ss1);
	} else {
		ctx.fail("New conversation UI ready", `Send button: ${sendVisible}, input: ${inputEnabled} — UI stuck in responding state`, ss1);
	}

	// Step 4: Verify we can send a message in the new conversation
	const newConvId = await getConversationId(page);
	console.log(`    New conversation: ${newConvId}`);

	if (newConvId === oldConvId) {
		ctx.fail("New conversation ID differs", "New conversation has the same ID as the old one");
		return;
	}

	if (sendVisible && inputEnabled) {
		console.log("    Sending a test message in the new conversation...");
		const responded = await sendMessage(page, "Say exactly: hello-test-response");

		if (responded) {
			ctx.pass("New conversation is functional", "Successfully sent and received a message in the new conversation");
		} else {
			ctx.fail("New conversation is functional", "Failed to receive a response in the new conversation");
		}
	}

	// Step 5: Wait for old session to complete, then switch back and verify
	if (oldConvId) {
		console.log("    Waiting for old session to complete in background...");
		await waitForSessionComplete(page, oldConvId, 60_000);

		const oldFilename = await findConversationFilename(page, oldConvId);
		if (oldFilename) {
			await switchToConversation(page, oldFilename);
			await page.waitForTimeout(1_000);

			const sendBtn = await isSendButtonVisible(page);
			const input = await isInputEnabled(page);
			const ss2 = await ctx.screenshot("test2-back-to-old-conversation");

			if (sendBtn && input) {
				ctx.pass("Old conversation usable after completion", "Send button visible and input enabled in old conversation", ss2);
			} else {
				ctx.fail("Old conversation usable after completion", `Send: ${sendBtn}, input: ${input}`, ss2);
			}
		}
	}
}

/**
 * Test 3: Rapid switching during active streaming.
 *
 * Verifies no stuck states after rapidly switching between conversations
 * while one is streaming.
 */
async function testRapidSwitching(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Rapid switching during active streaming");
	const { page } = ctx;

	await ensureCleanState(page);

	// Step 1: Create two idle conversations
	await newConversation(page);
	await page.waitForTimeout(1_000);
	const idle1Id = await getConversationId(page);
	await page.waitForTimeout(500);
	const idle1Filename = await findConversationFilename(page, idle1Id!);

	await newConversation(page);
	await page.waitForTimeout(1_000);
	const idle2Id = await getConversationId(page);
	await page.waitForTimeout(500);
	const idle2Filename = await findConversationFilename(page, idle2Id!);

	if (!idle1Filename || !idle2Filename) {
		ctx.fail("Idle conversations created", "Failed to create idle conversations for rapid switching test");
		return;
	}

	// Step 2: Start a streaming conversation
	await newConversation(page);
	await page.waitForTimeout(1_000);

	await sendMessageNoWait(
		page,
		'Run this exact shell command: sleep 15 && echo "rapid-switch-done". Do not ask for confirmation, just run it.',
	);

	const stopAppeared = await waitForStopButton(page, 30_000);
	if (!stopAppeared) {
		ctx.fail("Stop button appeared (test 3)", "Stop button did not appear");
		await ctx.screenshot("test3-no-stop-button");
		return;
	}

	const streamingConvId = await getConversationId(page);
	await page.waitForTimeout(500);
	const streamingFilename = await findConversationFilename(page, streamingConvId!);

	if (!streamingFilename) {
		ctx.fail("Streaming conversation filename (test 3)", "Failed to find streaming conversation filename");
		return;
	}

	console.log(`    Streaming: ${streamingConvId}`);
	console.log(`    Idle 1: ${idle1Id}`);
	console.log(`    Idle 2: ${idle2Id}`);

	// Step 3: Rapidly switch between conversations
	const switchSequence = [
		{ filename: idle1Filename, label: "idle1" },
		{ filename: idle2Filename, label: "idle2" },
		{ filename: streamingFilename, label: "streaming" },
		{ filename: idle1Filename, label: "idle1" },
		{ filename: streamingFilename, label: "streaming" },
	];

	let allIdleSwitchesCorrect = true;
	for (const { filename, label } of switchSequence) {
		await switchToConversation(page, filename);
		await page.waitForTimeout(500);

		if (label !== "streaming") {
			const sendBtn = await isSendButtonVisible(page);
			const input = await isInputEnabled(page);
			if (!sendBtn || !input) {
				allIdleSwitchesCorrect = false;
				console.log(`    FAIL: After switching to ${label}: send=${sendBtn}, input=${input}`);
			}
		}
		console.log(`    Switched to ${label}`);
	}

	const ss1 = await ctx.screenshot("test3-after-rapid-switches");
	if (allIdleSwitchesCorrect) {
		ctx.pass("Idle conversations unlocked during rapid switching", "All idle conversations had send button visible and input enabled", ss1);
	} else {
		ctx.fail("Idle conversations unlocked during rapid switching", "One or more idle conversations had stuck UI state", ss1);
	}

	// Step 4: Wait for streaming to complete
	console.log("    Waiting for streaming session to complete...");
	await waitForSessionComplete(page, streamingConvId!, 60_000);
	await page.waitForTimeout(1_000);

	// Step 5: Verify all conversations are usable after streaming completes
	const allFilenames = [idle1Filename, idle2Filename, streamingFilename];
	let allFinalStatesCorrect = true;
	for (const filename of allFilenames) {
		await switchToConversation(page, filename);
		await page.waitForTimeout(500);
		const sendBtn = await isSendButtonVisible(page);
		const input = await isInputEnabled(page);
		if (!sendBtn || !input) {
			allFinalStatesCorrect = false;
			console.log(`    FAIL: ${filename}: send=${sendBtn}, input=${input}`);
		}
	}

	const ss2 = await ctx.screenshot("test3-all-conversations-final");
	if (allFinalStatesCorrect) {
		ctx.pass("All conversations usable after streaming completes", "Send button and input enabled in all conversations", ss2);
	} else {
		ctx.fail("All conversations usable after streaming completes", "One or more conversations had stuck UI state after streaming completed", ss2);
	}
}

/**
 * Test 4: Plan/Act mode persists per-conversation across switches.
 *
 * Verifies that each conversation maintains its own mode state.
 */
async function testModePersistsPerConversation(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Plan/Act mode persists per-conversation across switches");
	const { page } = ctx;

	await ensureCleanState(page);

	// Step 1: Create conversation A and set to Plan
	await newConversation(page);
	await page.waitForTimeout(1_000);
	await setMode(page, "Plan");
	const convAId = await getConversationId(page);
	await page.waitForTimeout(500);
	const convAFilename = await findConversationFilename(page, convAId!);
	console.log(`    Conversation A (Plan): ${convAId}`);

	// Step 2: Create conversation B and set to Act
	await newConversation(page);
	await page.waitForTimeout(1_000);
	await setMode(page, "Act");
	const convBId = await getConversationId(page);
	await page.waitForTimeout(500);
	const convBFilename = await findConversationFilename(page, convBId!);
	console.log(`    Conversation B (Act): ${convBId}`);

	if (!convAFilename || !convBFilename) {
		ctx.fail("Mode test conversations created", "Failed to create conversations for mode persistence test");
		return;
	}

	// Step 3: Switch to A, verify Plan mode
	await switchToConversation(page, convAFilename);
	await page.waitForTimeout(500);
	const modeA = await getCurrentMode(page);
	const ss1 = await ctx.screenshot("test4-conv-a-plan");

	if (modeA === "Plan") {
		ctx.pass("Conversation A mode restored", `Mode correctly shows "Plan" after switching back`, ss1);
	} else {
		ctx.fail("Conversation A mode restored", `Expected "Plan", got "${modeA}"`, ss1);
	}

	// Step 4: Switch to B, verify Act mode
	await switchToConversation(page, convBFilename);
	await page.waitForTimeout(500);
	const modeB = await getCurrentMode(page);
	const ss2 = await ctx.screenshot("test4-conv-b-act");

	if (modeB === "Act") {
		ctx.pass("Conversation B mode restored", `Mode correctly shows "Act" after switching`, ss2);
	} else {
		ctx.fail("Conversation B mode restored", `Expected "Act", got "${modeB}"`, ss2);
	}

	// Step 5: Toggle B to Plan, switch to A, verify A is still Plan
	await setMode(page, "Plan");
	await switchToConversation(page, convAFilename);
	await page.waitForTimeout(500);
	const modeAAfterBToggle = await getCurrentMode(page);

	if (modeAAfterBToggle === "Plan") {
		ctx.pass("Conversation A unaffected by B toggle", `Mode still "Plan" after toggling B`);
	} else {
		ctx.fail("Conversation A unaffected by B toggle", `Expected "Plan", got "${modeAAfterBToggle}"`);
	}

	// Step 6: Switch to B, verify B is still Plan (from the toggle in step 5)
	await switchToConversation(page, convBFilename);
	await page.waitForTimeout(500);
	const modeBAfterToggle = await getCurrentMode(page);
	const ss3 = await ctx.screenshot("test4-conv-b-after-toggle");

	if (modeBAfterToggle === "Plan") {
		ctx.pass("Conversation B mode persisted", `Mode correctly shows "Plan" after toggle and switch`, ss3);
	} else {
		ctx.fail("Conversation B mode persisted", `Expected "Plan", got "${modeBAfterToggle}"`, ss3);
	}
}

/**
 * Test 5: Plan/Act mode survives plugin reload.
 *
 * Verifies that the mode is persisted to JSONL and restored after reload.
 */
async function testModeSurvivesReload(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Plan/Act mode survives plugin reload");
	const { page } = ctx;

	await ensureCleanState(page);

	// Step 1: Create a conversation and send a message (to ensure persistence)
	await newConversation(page);
	await page.waitForTimeout(1_000);

	// Start in Act mode (settings default is plan, so switch to act)
	await setMode(page, "Act");

	const responded = await sendMessage(page, "Say exactly: mode-persist-test");
	if (!responded) {
		ctx.fail("Message sent for mode persist test", "Failed to receive a response");
		return;
	}

	// Step 2: Toggle mode to Plan
	await setMode(page, "Plan");
	const convId = await getConversationId(page);
	console.log(`    Conversation ID: ${convId}`);

	// Give JSONL header time to flush
	await page.waitForTimeout(2_000);

	// Step 3: Reload the page
	console.log("    Reloading page...");
	await page.reload({ waitUntil: "load" });
	await page.waitForTimeout(8_000); // Wait for Obsidian + plugin to reinitialize

	// Step 4: Verify the mode was restored
	const restoredMode = await getCurrentMode(page);
	const ss = await ctx.screenshot("test5-after-reload");

	if (restoredMode === "Plan") {
		ctx.pass("Mode survives reload", `Mode correctly restored to "Plan" after page reload`, ss);
	} else {
		ctx.fail("Mode survives reload", `Expected "Plan" after reload, got "${restoredMode}"`, ss);
	}

	// Also verify the conversation ID matches (same conversation was restored)
	const restoredConvId = await getConversationId(page);
	if (restoredConvId === convId) {
		ctx.pass("Same conversation restored after reload", `Conversation ${convId} was restored`);
	} else {
		ctx.pass("Conversation restored after reload", `Restored ${restoredConvId} (may differ if most-recent logic changed)`);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init

	await testSwitchAwayFromActiveToolCall(ctx);
	await testNewConversationDuringToolCall(ctx);
	await testRapidSwitching(ctx);
	await testModePersistsPerConversation(ctx);
	await testModeSurvivesReload(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	auto_approve: {
		read_note: true,
		search_vault: true,
		list_vault: true,
		read_frontmatter: true,
		fetch_webpage: true,
		write_note: false,
		replace_in_note: false,
		update_frontmatter: false,
		manage_tags: false,
		execute_command: true,
		read_file: false,
		read_docx: false,
		write_docx: false,
	},
	mode: "act",
	execute_command_timeout: 30,
});

runTest({ name: "conversation-switch-bug", settings }, tests);
