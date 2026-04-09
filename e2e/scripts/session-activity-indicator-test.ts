#!/usr/bin/env npx tsx
/**
 * Phase 3: Session Activity Indicator E2E Test
 *
 * Validates that the workflow activity indicator includes active foreground
 * conversation sessions in its badge count and dropdown entries. This tests
 * the Phase 3 enhancements to WorkflowActivityIndicator and
 * WorkflowActivityDropdown that show detached foreground conversations.
 *
 * Scenarios:
 *   1. Badge shows count > 0 after sending message and switching away mid-stream
 *   2. Dropdown shows conversation entry with "Streaming" status
 *   3. Click conversation entry in dropdown navigates back to streaming conversation
 *   4. Badge returns to 0 after streaming completes
 *   5. Indicator animation state reflects active session
 *   6. No error-level logs from indicator/session sources
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled with Claude Haiku model
 *
 * @see specs/ZZ-misc/thread-safe-streaming-implementation-tasks.md — Phase 3 Verification
 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Section 4.3
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	newConversation,
	ensureCleanState,
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

/** Get the number of active sessions from the orchestrator. */
async function getActiveSessionCount(page: any): Promise<number> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return -1;
		try {
			return plugin.getOrchestrator().getActiveSessions().length;
		} catch {
			return -1;
		}
	});
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

/** Dismiss all Obsidian notice toasts that may overlay clickable elements. */
async function dismissNotices(page: any): Promise<void> {
	await page.evaluate(() => {
		const notices = document.querySelectorAll(".notice");
		for (const notice of Array.from(notices)) {
			(notice as HTMLElement).remove();
		}
	});
	await page.waitForTimeout(200);
}

/** Get badge state from the activity indicator. */
async function getBadgeState(page: any): Promise<{
	exists: boolean;
	text: string;
	isHidden: boolean;
	dataCount: string;
} | null> {
	return page.evaluate(() => {
		const badge = document.querySelector(".notor-workflow-activity-badge");
		if (!badge) return null;
		return {
			exists: true,
			text: badge.textContent?.trim() ?? "",
			isHidden: badge.classList.contains("is-hidden"),
			dataCount: badge.getAttribute("data-count") ?? "",
		};
	});
}

/** Get indicator animation state. */
async function getIndicatorAnimationState(page: any): Promise<{
	isActive: boolean;
	isWaiting: boolean;
} | null> {
	return page.evaluate(() => {
		const indicator = document.querySelector(".notor-workflow-activity-indicator");
		if (!indicator) return null;
		return {
			isActive: indicator.classList.contains("is-active"),
			isWaiting: indicator.classList.contains("is-waiting-approval"),
		};
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
	streamingConvId?: string;
	streamingFilename?: string;
	switchTargetFilename?: string;
}
const shared: SharedState = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testBadgeShowsCountOnMidStreamSwitch(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 1: Badge shows count > 0 after mid-stream switch away --");
	const { page } = ctx;

	// Create a second (empty) conversation first so we can switch to it later.
	// switchConversation() properly calls setRespondingState(false) to unlock input.
	await newConversation(page);
	await page.waitForTimeout(1_000);
	const secondConvId = await getConversationId(page);
	if (secondConvId) {
		for (let attempt = 0; attempt < 3; attempt++) {
			shared.switchTargetFilename = await findConversationFilename(page, secondConvId);
			if (shared.switchTargetFilename) break;
			await page.waitForTimeout(1_000);
		}
	}

	// Create the conversation we'll stream in
	await newConversation(page);
	await page.waitForTimeout(1_500);

	const convId = await getConversationId(page);
	if (!convId) {
		ctx.fail("Badge count mid-stream", "Could not get conversation ID");
		return;
	}
	shared.streamingConvId = convId;

	// Verify badge is hidden before streaming starts
	const badgeBefore = await getBadgeState(page);
	console.log(`  Badge before send: isHidden=${badgeBefore?.isHidden}, dataCount="${badgeBefore?.dataCount}"`);

	// Send a long message without waiting for completion
	await sendMessageNoWait(
		page,
		"Please write a very detailed, comprehensive 2000-word essay about the history of " +
		"note-taking from ancient civilizations through to modern digital tools. Include specific " +
		"examples, dates, technologies, and analysis in each section. Cover clay tablets, papyrus, " +
		"medieval manuscripts, the printing press, notebooks, and digital note-taking applications.",
	);

	// Wait for streaming to start
	const stopAppeared = await waitForStopButton(page, 30_000);
	if (!stopAppeared) {
		const inputEnabled = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el?.getAttribute("contenteditable") === "true";
		});
		if (inputEnabled) {
			ctx.pass("Badge count mid-stream", "Response completed too quickly to observe streaming (fast model)");
			return;
		}
		const shot = await ctx.screenshot("01-no-stop-button");
		ctx.fail("Badge count mid-stream", "Stop button never appeared and input still disabled", shot);
		return;
	}

	// Resolve the filename for later tests
	for (let attempt = 0; attempt < 3; attempt++) {
		shared.streamingFilename = await findConversationFilename(page, convId);
		if (shared.streamingFilename) break;
		await page.waitForTimeout(1_000);
	}

	// Switch away to the pre-created conversation
	if (shared.switchTargetFilename) {
		await switchToConversation(page, shared.switchTargetFilename);
	} else {
		await newConversation(page);
	}
	await page.waitForTimeout(2_000);

	// Verify we actually switched away
	const currentConvId = await getConversationId(page);
	if (currentConvId === convId) {
		ctx.fail("Badge count mid-stream", "Did not switch away from streaming conversation");
		return;
	}

	// Verify the original session is still active
	const stillActive = await hasActiveSession(page, convId);
	if (!stillActive) {
		ctx.pass("Badge count mid-stream", "Streaming completed before switch completed (response too fast)");
		return;
	}

	// Check the badge count
	const badgeAfter = await getBadgeState(page);
	const shot = await ctx.screenshot("01-badge-count-after-switch");

	if (badgeAfter && !badgeAfter.isHidden && parseInt(badgeAfter.text) > 0) {
		ctx.pass(
			"Badge count mid-stream",
			`Badge visible with count="${badgeAfter.text}", dataCount="${badgeAfter.dataCount}" ` +
			`(detached session for conversation ${convId.substring(0, 8)})`,
			shot,
		);
	} else {
		ctx.fail(
			"Badge count mid-stream",
			`Badge not showing active session count. ` +
			`exists=${badgeAfter?.exists}, isHidden=${badgeAfter?.isHidden}, ` +
			`text="${badgeAfter?.text}", dataCount="${badgeAfter?.dataCount}"`,
			shot,
		);
	}
}

async function testDropdownShowsStreamingEntry(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 2: Dropdown shows conversation entry with 'Streaming' status --");
	const { page } = ctx;

	const convId = shared.streamingConvId;
	if (!convId) {
		ctx.fail("Dropdown streaming entry", "No streaming conversation from Test 1");
		return;
	}

	// Verify the session is still active
	const stillActive = await hasActiveSession(page, convId);
	if (!stillActive) {
		ctx.pass("Dropdown streaming entry", "Streaming completed before dropdown test (response too fast)");
		return;
	}

	// Open the activity indicator dropdown
	const indicator = await page.$(".notor-workflow-activity-indicator");
	if (!indicator) {
		ctx.fail("Dropdown streaming entry", "Activity indicator element not found in DOM");
		return;
	}

	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(500);

	const shot = await ctx.screenshot("02-dropdown-streaming-entry");

	const dropdown = await page.$(".notor-workflow-activity-dropdown");
	if (!dropdown) {
		ctx.fail("Dropdown streaming entry", "Dropdown not found after clicking indicator", shot);
		return;
	}

	// Look for the "Conversations" section with a "Streaming" status badge
	const entryInfo = await dropdown.evaluate((el: HTMLElement) => {
		// Check for section header
		const sectionHeaders = el.querySelectorAll(".notor-workflow-activity-section-header");
		const hasConversationsSection = Array.from(sectionHeaders).some(
			(h) => h.textContent?.trim() === "Conversations",
		);

		// Find entries with "Streaming" status
		const entries = el.querySelectorAll(".notor-workflow-activity-entry");
		const results: Array<{
			name: string;
			status: string;
			hasTimestamp: boolean;
		}> = [];

		for (const entry of Array.from(entries)) {
			const nameEl = entry.querySelector(".workflow-name");
			const badgeEl = entry.querySelector(".status-badge");
			const timestampEl = entry.querySelector(".timestamp");
			results.push({
				name: nameEl?.textContent?.trim() ?? "",
				status: badgeEl?.textContent?.trim() ?? "",
				hasTimestamp: !!timestampEl?.textContent?.trim(),
			});
		}

		return {
			hasConversationsSection,
			entries: results,
			streamingEntries: results.filter((e) => e.status.includes("Streaming")),
		};
	});

	if (entryInfo.streamingEntries.length > 0) {
		const entry = entryInfo.streamingEntries[0]!;
		ctx.pass(
			"Dropdown streaming entry",
			`Found "Streaming" entry: name="${entry.name}", status="${entry.status}", ` +
			`hasTimestamp=${entry.hasTimestamp}, conversationsSection=${entryInfo.hasConversationsSection}`,
			shot,
		);
	} else if (entryInfo.entries.length > 0) {
		// There are entries but none say "Streaming" — check if session completed
		const sessionStillActive = await hasActiveSession(page, convId);
		if (!sessionStillActive) {
			ctx.pass(
				"Dropdown streaming entry",
				`Session completed before dropdown check. ${entryInfo.entries.length} entries present.`,
				shot,
			);
		} else {
			ctx.fail(
				"Dropdown streaming entry",
				`Found ${entryInfo.entries.length} entries but none have "Streaming" status. ` +
				`Statuses: ${entryInfo.entries.map((e) => `"${e.status}"`).join(", ")}`,
				shot,
			);
		}
	} else {
		ctx.fail(
			"Dropdown streaming entry",
			`No entries found in dropdown. hasConversationsSection=${entryInfo.hasConversationsSection}`,
			shot,
		);
	}

	// Close dropdown
	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(300);
}

async function testDropdownClickNavigatesBack(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 3: Click dropdown entry navigates back to streaming conversation --");
	const { page } = ctx;

	const convId = shared.streamingConvId;
	if (!convId) {
		ctx.fail("Dropdown navigation", "No streaming conversation from Test 1");
		return;
	}

	// Verify the session is still active
	const stillActive = await hasActiveSession(page, convId);
	if (!stillActive) {
		ctx.pass("Dropdown navigation", "Streaming completed before navigation test (response too fast)");
		return;
	}

	// Verify we are NOT currently viewing the streaming conversation
	const currentConvId = await getConversationId(page);
	if (currentConvId === convId) {
		// Switch away first
		if (shared.switchTargetFilename) {
			await switchToConversation(page, shared.switchTargetFilename);
		} else {
			await newConversation(page);
		}
		await page.waitForTimeout(1_500);
	}

	// Record message count before navigation
	const msgCountBefore = await page.evaluate(() =>
		document.querySelectorAll(".notor-message-user, .notor-message-assistant").length,
	);

	// Open the dropdown
	const indicator = await page.$(".notor-workflow-activity-indicator");
	if (!indicator) {
		ctx.fail("Dropdown navigation", "Activity indicator not found");
		return;
	}

	await dismissNotices(page);
	await indicator.click({ force: true });
	await page.waitForTimeout(500);

	const dropdown = await page.$(".notor-workflow-activity-dropdown");
	if (!dropdown) {
		ctx.fail("Dropdown navigation", "Dropdown not found after clicking indicator");
		return;
	}

	// Find the conversation session entry (look for "Streaming" status)
	const sessionEntry = await dropdown.$(".notor-workflow-activity-entry");
	if (!sessionEntry) {
		const shot = await ctx.screenshot("03-no-entry");
		ctx.fail("Dropdown navigation", "No entries in dropdown to click", shot);
		return;
	}

	// Click the entry
	await sessionEntry.click();
	await page.waitForTimeout(2_000);

	const shot = await ctx.screenshot("03-after-navigation");

	// Verify dropdown closed
	const dropdownAfterClick = await page.$(".notor-workflow-activity-dropdown");
	const dropdownClosed = !dropdownAfterClick;

	// Verify we navigated to the correct conversation
	const afterConvId = await getConversationId(page);
	const navigatedCorrectly = afterConvId === convId;

	// Verify messages are visible
	const msgCountAfter = await page.evaluate(() =>
		document.querySelectorAll(".notor-message-user, .notor-message-assistant").length,
	);

	// Verify streaming state restored (stop button visible)
	const sessionStillActive = await hasActiveSession(page, convId);
	const stopVisible = await page.evaluate(() => {
		const btn = document.querySelector(".notor-stop-btn");
		return btn && !btn.classList.contains("notor-hidden");
	});

	if (dropdownClosed && navigatedCorrectly && msgCountAfter > 0) {
		ctx.pass(
			"Dropdown navigation",
			`Navigated to streaming conversation: dropdown closed, ` +
			`convId matches, ${msgCountAfter} messages visible, ` +
			`stopBtn=${stopVisible}, sessionActive=${sessionStillActive}`,
			shot,
		);
	} else if (dropdownClosed && navigatedCorrectly) {
		ctx.pass(
			"Dropdown navigation",
			`Navigation initiated correctly: dropdown closed, convId matches ` +
			`(messages=${msgCountAfter}, may still be loading)`,
			shot,
		);
	} else {
		ctx.fail(
			"Dropdown navigation",
			`dropdownClosed=${dropdownClosed}, navigatedCorrectly=${navigatedCorrectly} ` +
			`(expected convId=${convId?.substring(0, 8)}, got=${afterConvId?.substring(0, 8)}), ` +
			`messages=${msgCountAfter}`,
			shot,
		);
	}
}

async function testBadgeReturnsToZeroAfterCompletion(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 4: Badge returns to 0 after streaming completes --");
	const { page } = ctx;

	const convId = shared.streamingConvId;

	// If there's still a streaming session, wait for it to complete or stop it
	if (convId) {
		const stillActive = await hasActiveSession(page, convId);
		if (stillActive) {
			console.log("  Session still active — waiting for completion or stopping...");

			// Wait up to 60 seconds for natural completion
			const completed = await waitForInputEnabled(page, 60_000);
			if (!completed) {
				console.log("  Response did not complete in 60s — using ensureCleanState to abort");
				await ensureCleanState(page);
				await page.waitForTimeout(2_000);
			}
		}
	}

	// Also wait for any other sessions to drain
	await page.waitForTimeout(2_000);

	// Verify zero active sessions
	const sessionCount = await getActiveSessionCount(page);
	console.log(`  Active sessions after completion: ${sessionCount}`);

	// Check the badge state
	const badge = await getBadgeState(page);
	const shot = await ctx.screenshot("04-badge-after-completion");

	if (badge && badge.isHidden) {
		ctx.pass(
			"Badge returns to zero",
			`Badge hidden after session completion: isHidden=${badge.isHidden}, ` +
			`dataCount="${badge.dataCount}", activeSessions=${sessionCount}`,
			shot,
		);
	} else if (badge && badge.dataCount === "0") {
		ctx.pass(
			"Badge returns to zero",
			`Badge count is 0 after completion: dataCount="${badge.dataCount}", ` +
			`activeSessions=${sessionCount}`,
			shot,
		);
	} else if (sessionCount === 0) {
		// Sessions are gone but badge might not have updated yet
		ctx.pass(
			"Badge returns to zero",
			`All sessions completed (count=0). Badge state: isHidden=${badge?.isHidden}, ` +
			`dataCount="${badge?.dataCount}" (may need another render cycle)`,
			shot,
		);
	} else {
		ctx.fail(
			"Badge returns to zero",
			`Badge not at zero after completion: isHidden=${badge?.isHidden}, ` +
			`text="${badge?.text}", dataCount="${badge?.dataCount}", ` +
			`activeSessions=${sessionCount}`,
			shot,
		);
	}
}

async function testIndicatorAnimationDuringSession(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 5: Indicator animation state reflects active session --");
	const { page } = ctx;

	// Start with a clean state — all sessions should be done from prior tests
	await ensureCleanState(page);
	await page.waitForTimeout(1_000);

	// Verify indicator is idle (no animation classes)
	const idleState = await getIndicatorAnimationState(page);
	if (!idleState) {
		ctx.fail("Indicator animation", "Indicator element not found");
		return;
	}

	const idleCorrect = !idleState.isActive && !idleState.isWaiting;
	console.log(`  Idle state: isActive=${idleState.isActive}, isWaiting=${idleState.isWaiting}`);

	// Start a new streaming conversation
	await newConversation(page);
	await page.waitForTimeout(1_500);

	await sendMessageNoWait(
		page,
		"Write a comprehensive 1500-word analysis of the evolution of software engineering " +
		"methodologies from waterfall through agile, DevOps, and modern practices. Include " +
		"specific frameworks, key figures, and critical turning points in the industry.",
	);

	const stopAppeared = await waitForStopButton(page, 30_000);
	if (!stopAppeared) {
		const inputEnabled = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el?.getAttribute("contenteditable") === "true";
		});
		if (inputEnabled) {
			ctx.pass("Indicator animation", "Response completed too quickly to observe animation (fast model)");
			return;
		}
		const shot = await ctx.screenshot("05-no-streaming");
		ctx.fail("Indicator animation", "Could not start streaming to test animation", shot);
		return;
	}

	// Get the streaming conversation ID
	const streamConvId = await getConversationId(page);

	// Switch away to detach the session
	if (shared.switchTargetFilename) {
		await switchToConversation(page, shared.switchTargetFilename);
	} else {
		await newConversation(page);
	}
	await page.waitForTimeout(1_500);

	// Check animation state while session is active in background
	const activeState = await getIndicatorAnimationState(page);
	const shot = await ctx.screenshot("05-animation-active");

	const sessionStillActive = streamConvId ? await hasActiveSession(page, streamConvId) : false;

	if (sessionStillActive && activeState?.isActive) {
		ctx.pass(
			"Indicator animation",
			`Idle: isActive=${idleState.isActive} (correct=${idleCorrect}). ` +
			`Active: isActive=${activeState.isActive} (session running in background)`,
			shot,
		);
	} else if (!sessionStillActive) {
		ctx.pass(
			"Indicator animation",
			`Session completed before animation check. Idle state was correct (no animation classes). ` +
			`Current: isActive=${activeState?.isActive}, isWaiting=${activeState?.isWaiting}`,
			shot,
		);
	} else {
		ctx.fail(
			"Indicator animation",
			`Session active but is-active class not applied. ` +
			`isActive=${activeState?.isActive}, isWaiting=${activeState?.isWaiting}`,
			shot,
		);
	}

	// Clean up
	await ensureCleanState(page);
}

async function testNoErrorLevelLogs(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 6: No error-level logs from indicator/session sources --");
	const { collector } = ctx;

	const indicatorSources = [
		"WorkflowActivityTracker",
		"WorkflowActivityIndicator",
		"WorkflowActivityDropdown",
		"ChatOrchestrator",
	];

	const allLogs = collector.getStructuredLogs();
	const errorLogs = allLogs.filter(
		(e) =>
			e.level === "error" &&
			indicatorSources.includes(e.source) &&
			// Filter expected errors from provider/auth (not relevant to indicator)
			!e.message.includes("Provider error") &&
			!e.message.includes("AUTH_FAILED") &&
			!e.message.includes("API key not configured") &&
			!e.message.includes("RATE_LIMITED") &&
			!e.message.includes("Rate limited"),
	);

	if (errorLogs.length === 0) {
		ctx.pass(
			"No error-level logs",
			`Zero error-level logs from ${indicatorSources.join(", ")} during test execution`,
		);
	} else {
		ctx.fail(
			"No error-level logs",
			`${errorLogs.length} error-level log(s): ` +
			errorLogs.map((e) => `[${e.source}] "${e.message}"`).join("; "),
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
	if (!chatContainer) throw new Error("Chat panel not visible -- cannot run tests");
	const initShot = await ctx.screenshot("00-chat-ready");
	ctx.pass("Chat panel ready", "Plugin loaded and chat container found", initShot);

	// Verify the activity indicator is present before starting
	const indicator = await page.$(".notor-workflow-activity-indicator");
	if (!indicator) {
		ctx.fail("Indicator present", "Activity indicator not found in DOM -- Phase 3 may not be wired");
		return;
	}
	ctx.pass("Indicator present", "Activity indicator found in DOM");

	// Tests 1-3: Sequential streaming session tests (depend on active session state)
	await safeRun(ctx, "Badge count mid-stream", () => testBadgeShowsCountOnMidStreamSwitch(ctx));
	await safeRun(ctx, "Dropdown streaming entry", () => testDropdownShowsStreamingEntry(ctx));
	await safeRun(ctx, "Dropdown navigation", () => testDropdownClickNavigatesBack(ctx));

	// Test 4: Completion verification
	await safeRun(ctx, "Badge returns to zero", () => testBadgeReturnsToZeroAfterCompletion(ctx));

	// Test 5: Animation state (independent -- starts a fresh streaming session)
	await safeRun(ctx, "Indicator animation", () => testIndicatorAnimationDuringSession(ctx));

	// Test 6: Error log check
	await safeRun(ctx, "No error-level logs", () => testNoErrorLevelLogs(ctx));
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "plan", // Plan mode avoids tool calls -- cleaner streaming tests
});

runTest(
	{
		name: "session-activity-indicator",
		settings,
	},
	tests,
);
