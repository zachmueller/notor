#!/usr/bin/env npx tsx
/**
 * Find In Messages E2E Test
 *
 * Validates the Cmd+F / Ctrl+F text-search feature in Notor chat panels.
 * The find bar allows users to locate and navigate matching text within
 * the message history.
 *
 * Scenarios:
 *   1. Find bar is initially hidden before any shortcut is pressed
 *   2. Cmd+F (macOS) / Ctrl+F (Win/Linux) opens the bar and focuses the input
 *   3. Command palette "Find in messages" also opens the bar (alternate path)
 *   4. Typing a search term highlights all matches and shows the correct count
 *   5. Enter key navigates to the next match; count display updates
 *   6. Shift+Enter retreats to the previous match
 *   7. "Next match" and "Previous match" buttons navigate correctly
 *   8. A non-matching query shows "0 results"
 *   9. Clearing the query clears the count display
 *  10. Escape key closes the bar and removes all highlights
 *  11. Close button (✕) also closes the bar
 *
 * @see src/ui/find-in-messages.ts
 */

import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

// "fox" appears 3 times across both injected messages (case-insensitive)
const SEARCH_TERM = "fox";
const EXPECTED_MATCH_COUNT = 3;

// A term that doesn't appear in the injected messages
const NO_MATCH_TERM = "xyzzy-no-match";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Inject fake message elements with known content into the message list.
 * Returns an async cleanup function that removes the injected nodes.
 *
 * "fox" appears 3 times total:
 *   - user msg:      "The quick brown fox jumps over the lazy dog."      → 1
 *   - assistant msg: "A fox is clever and a fox is quick."               → 2
 */
async function injectTestMessages(page: Page): Promise<() => Promise<void>> {
	await page.evaluate(() => {
		const list = document.querySelector(".notor-message-list") as HTMLElement | null;
		if (!list) return;

		const userMsg = document.createElement("div");
		userMsg.className = "notor-message-user e2e-find-injected";
		const userContent = document.createElement("div");
		userContent.className = "notor-message-content";
		userContent.textContent = "The quick brown fox jumps over the lazy dog.";
		userMsg.appendChild(userContent);
		list.appendChild(userMsg);

		const assistantMsg = document.createElement("div");
		assistantMsg.className = "notor-message-assistant e2e-find-injected";
		// Must have data-message-id so FindInMessages does not treat it as streaming
		assistantMsg.setAttribute("data-message-id", "e2e-find-test-1");
		const assistantContent = document.createElement("div");
		assistantContent.className = "notor-message-content";
		assistantContent.textContent = "A fox is clever and a fox is quick.";
		assistantMsg.appendChild(assistantContent);
		list.appendChild(assistantMsg);
	});

	return async () => {
		await page.evaluate(() => {
			document.querySelectorAll(".e2e-find-injected").forEach((el) => el.remove());
		});
	};
}

/** True if the find bar element exists in the DOM and is not hidden. */
async function isFindBarVisible(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const bar = document.querySelector(".notor-find-bar");
		if (!bar) return false;
		return !bar.classList.contains("notor-hidden");
	});
}

/** Count <mark> elements currently wrapping highlighted matches. */
async function countHighlights(page: Page): Promise<number> {
	return page.evaluate(
		() => document.querySelectorAll(".notor-find-highlight").length,
	);
}

/** Read the text of the count display element (e.g. "1 of 3", "0 results", ""). */
async function getCountText(page: Page): Promise<string> {
	return page.evaluate(() => {
		const el = document.querySelector(".notor-find-count");
		return el?.textContent ?? "";
	});
}

/** True if at least one highlight has the "current" class. */
async function hasCurrentHighlight(page: Page): Promise<boolean> {
	return page.evaluate(
		() => document.querySelectorAll(".notor-find-highlight-current").length > 0,
	);
}

/** Index (0-based) of the currently active highlight in DOM order, or -1 if none. */
async function getCurrentHighlightIndex(page: Page): Promise<number> {
	return page.evaluate(() => {
		const marks = Array.from(document.querySelectorAll(".notor-find-highlight"));
		return marks.findIndex((m) => m.classList.contains("notor-find-highlight-current"));
	});
}

/**
 * Parse the 1-based current match number from a count string like "2 of 3".
 * Returns -1 if the string cannot be parsed.
 */
function parseCurrentMatchIndex(countText: string): number {
	const match = countText.match(/^(\d+) of \d+$/);
	return match ? parseInt(match[1]!, 10) : -1;
}

/**
 * Open the find bar via Cmd+F (macOS) / Ctrl+F (Win/Linux).
 * Focuses the chat container first so the capture keydown listener fires.
 */
async function openViaKeyboard(page: Page): Promise<void> {
	// Click inside the message list so the chat container has focus and the
	// container-level capture listener (chat-view.ts) can intercept the key.
	await page.click(".notor-message-list");
	await page.waitForTimeout(200);

	const isMac = process.platform === "darwin";
	if (isMac) {
		await page.keyboard.press("Meta+f");
	} else {
		await page.keyboard.press("Control+f");
	}
	await page.waitForTimeout(400);
}

/**
 * Open the find bar via the Obsidian command palette API.
 * Clicks inside the chat container first to ensure the Notor view is the
 * active leaf — the command's checkCallback uses getActiveViewOfType().
 */
async function openViaCommand(page: Page): Promise<void> {
	// Activate the Notor view so getActiveViewOfType(NotorChatView) succeeds
	await page.click(".notor-message-list");
	await page.waitForTimeout(200);
	await page.evaluate(() => {
		(window as any).app?.commands?.executeCommandById?.("notor:find-in-messages");
	});
	await page.waitForTimeout(400);
}

/** Type text into the find input (a real <input> element — keyboard.type is safe here). */
async function typeSearch(page: Page, text: string): Promise<void> {
	// page.$() finds elements regardless of visibility; the input is always in the DOM
	// but inside the (possibly hidden) find bar.
	const input = await page.$(".notor-find-input");
	if (!input) throw new Error(".notor-find-input not found in DOM");
	await input.focus();
	await page.keyboard.type(text);
	await page.waitForTimeout(400); // 150 ms debounce + render time
}

/** Clear the find input by setting its value to "" and dispatching an input event. */
async function clearSearch(page: Page): Promise<void> {
	await page.evaluate(() => {
		const el = document.querySelector(".notor-find-input") as HTMLInputElement | null;
		if (!el) return;
		el.value = "";
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await page.waitForTimeout(400); // 150 ms debounce + render time
}

// ---------------------------------------------------------------------------
// Test functions
// ---------------------------------------------------------------------------

async function testFindBarInitiallyHidden(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Find bar is initially hidden");
	const { page } = ctx;

	const barExists = await page.evaluate(
		() => document.querySelector(".notor-find-bar") !== null,
	);
	if (!barExists) {
		const shot = await ctx.screenshot("01-no-find-bar");
		ctx.fail("find bar exists in DOM", ".notor-find-bar element not found — FindInMessages may not have been initialized", shot);
		return;
	}

	const visible = await isFindBarVisible(page);
	const shot = await ctx.screenshot("01-initial-state");
	if (visible) {
		ctx.fail("find bar hidden on load", "Find bar is visible before any shortcut was pressed", shot);
	} else {
		ctx.pass("find bar hidden on load", "Find bar has .notor-hidden on load", shot);
	}
}

async function testKeyboardShortcutOpensBar(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Cmd+F / Ctrl+F keyboard shortcut opens the bar");
	const { page } = ctx;

	await openViaKeyboard(page);

	const visible = await isFindBarVisible(page);
	const inputFocused = await page.evaluate(
		() => document.activeElement?.classList.contains("notor-find-input") ?? false,
	);
	const shot = await ctx.screenshot("02-keyboard-shortcut");

	if (!visible) {
		ctx.fail(
			"keyboard shortcut opens find bar",
			"Find bar is still hidden after Cmd+F / Ctrl+F — the shortcut may be intercepted by Obsidian before the plugin's capture listener fires",
			shot,
		);
	} else {
		ctx.pass("keyboard shortcut opens find bar", "Find bar is visible after Cmd+F / Ctrl+F", shot);
	}

	if (visible && !inputFocused) {
		ctx.fail("find input focused on open", "Find bar opened but input is not focused", shot);
	} else if (visible) {
		ctx.pass("find input focused on open", "Find input has focus after bar opens", shot);
	}

	// Close so subsequent tests start clean
	if (visible) {
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
	}
}

async function testCommandPaletteOpensBar(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Command API opens the bar (alternate activation path)");
	const { page } = ctx;

	await openViaCommand(page);

	const visible = await isFindBarVisible(page);
	const shot = await ctx.screenshot("03-command-palette");

	if (!visible) {
		ctx.fail(
			"command API opens find bar",
			"Find bar not visible after executing notor:find-in-messages — command may be missing or openFindBar() is broken",
			shot,
		);
	} else {
		ctx.pass("command API opens find bar", "Find bar opened via command API", shot);
	}

	if (visible) {
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
	}
}

async function testSearchHighlightsMatches(ctx: TestContext, cleanup: () => Promise<void>): Promise<void> {
	console.log("\nTest 4: Typing a search term highlights matches and shows count");
	const { page } = ctx;

	// Open the bar (use command API — more reliable than keyboard shortcut)
	await openViaCommand(page);
	const barOpen = await isFindBarVisible(page);
	if (!barOpen) {
		ctx.fail("search highlights — bar opens", "Cannot test search: bar did not open via command API");
		return;
	}

	await typeSearch(page, SEARCH_TERM);

	const highlightCount = await countHighlights(page);
	const countText = await getCountText(page);
	const hasCurrent = await hasCurrentHighlight(page);
	const shot = await ctx.screenshot("04-search-highlights");

	if (highlightCount !== EXPECTED_MATCH_COUNT) {
		ctx.fail(
			"search highlights — correct match count",
			`Expected ${EXPECTED_MATCH_COUNT} highlights for "${SEARCH_TERM}" but found ${highlightCount}`,
			shot,
		);
	} else {
		ctx.pass(
			"search highlights — correct match count",
			`Found ${highlightCount} highlight(s) for "${SEARCH_TERM}"`,
			shot,
		);
	}

	const expectedCountText = `1 of ${EXPECTED_MATCH_COUNT}`;
	if (countText !== expectedCountText) {
		ctx.fail(
			"search highlights — count display",
			`Expected count display "${expectedCountText}" but got "${countText}"`,
			shot,
		);
	} else {
		ctx.pass("search highlights — count display", `Count shows "${countText}"`, shot);
	}

	if (!hasCurrent) {
		ctx.fail("search highlights — first match active", "No highlight has .notor-find-highlight-current after search", shot);
	} else {
		ctx.pass("search highlights — first match active", "First match is marked as current", shot);
	}
}

async function testForwardNavigation(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Enter key advances to the next match");
	const { page } = ctx;

	// Bar should already be open with results from previous test
	const barOpen = await isFindBarVisible(page);
	if (!barOpen) {
		ctx.fail("forward navigation — bar open", "Find bar not open — skipping navigation test");
		return;
	}

	// Parse the current "N of M" display to know which match we're on
	const countBefore = await getCountText(page);
	const matchBefore = parseCurrentMatchIndex(countBefore); // 1-based
	if (matchBefore < 0) {
		ctx.fail("forward navigation — count readable", `Could not parse count "${countBefore}"`);
		return;
	}

	// Press Enter to go to next match
	await page.focus(".notor-find-input");
	await page.keyboard.press("Enter");
	await page.waitForTimeout(300);

	const countAfter = await getCountText(page);
	const matchAfter = parseCurrentMatchIndex(countAfter); // 1-based
	const shot = await ctx.screenshot("05-forward-navigation");

	const expectedMatch = (matchBefore % EXPECTED_MATCH_COUNT) + 1; // wraparound
	if (matchAfter !== expectedMatch) {
		ctx.fail(
			"forward navigation — Enter advances match",
			`Expected match ${expectedMatch} of ${EXPECTED_MATCH_COUNT} after Enter but got "${countAfter}" (was "${countBefore}")`,
			shot,
		);
	} else {
		ctx.pass(
			"forward navigation — Enter advances match",
			`Count advanced from "${countBefore}" to "${countAfter}"`,
			shot,
		);
	}

	// A current highlight must exist
	const hasCurrent = await hasCurrentHighlight(page);
	if (!hasCurrent) {
		ctx.fail("forward navigation — active highlight present", "No .notor-find-highlight-current after navigation", shot);
	} else {
		ctx.pass("forward navigation — active highlight present", "Current highlight class present after navigation", shot);
	}
}

async function testBackwardNavigation(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: Shift+Enter retreats to the previous match");
	const { page } = ctx;

	const barOpen = await isFindBarVisible(page);
	if (!barOpen) {
		ctx.fail("backward navigation — bar open", "Find bar not open — skipping backward navigation test");
		return;
	}

	const countBefore = await getCountText(page);
	const matchBefore = parseCurrentMatchIndex(countBefore); // 1-based
	if (matchBefore < 0) {
		ctx.fail("backward navigation — count readable", `Could not parse count "${countBefore}"`);
		return;
	}

	await page.focus(".notor-find-input");
	await page.keyboard.press("Shift+Enter");
	await page.waitForTimeout(300);

	const countAfter = await getCountText(page);
	const matchAfter = parseCurrentMatchIndex(countAfter); // 1-based
	const shot = await ctx.screenshot("06-backward-navigation");

	const expectedMatch = matchBefore === 1 ? EXPECTED_MATCH_COUNT : matchBefore - 1;
	if (matchAfter !== expectedMatch) {
		ctx.fail(
			"backward navigation — Shift+Enter retreats match",
			`Expected match ${expectedMatch} of ${EXPECTED_MATCH_COUNT} after Shift+Enter but got "${countAfter}" (was "${countBefore}")`,
			shot,
		);
	} else {
		ctx.pass(
			"backward navigation — Shift+Enter retreats match",
			`Count retreated from "${countBefore}" to "${countAfter}"`,
			shot,
		);
	}
}

async function testButtonNavigation(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: Navigation buttons advance and retreat the match");
	const { page } = ctx;

	const barOpen = await isFindBarVisible(page);
	if (!barOpen) {
		ctx.fail("button navigation — bar open", "Find bar not open — skipping button navigation test");
		return;
	}

	const countBefore = await getCountText(page);
	const matchBefore = parseCurrentMatchIndex(countBefore); // 1-based
	if (matchBefore < 0) {
		ctx.fail("button navigation — count readable", `Could not parse count "${countBefore}"`);
		return;
	}

	// Click "Next match" button
	const nextBtn = await page.$(".notor-find-nav-btn[aria-label='Next match']");
	if (!nextBtn) {
		ctx.fail("button navigation — next button exists", ".notor-find-nav-btn[aria-label='Next match'] not found");
		return;
	}
	await nextBtn.click();
	await page.waitForTimeout(300);

	const countAfterNext = await getCountText(page);
	const matchAfterNext = parseCurrentMatchIndex(countAfterNext);
	const shotNext = await ctx.screenshot("07a-next-button");

	const expectedAfterNext = (matchBefore % EXPECTED_MATCH_COUNT) + 1;
	if (matchAfterNext !== expectedAfterNext) {
		ctx.fail(
			"button navigation — Next button advances match",
			`Expected match ${expectedAfterNext} after Next but got "${countAfterNext}" (was "${countBefore}")`,
			shotNext,
		);
	} else {
		ctx.pass(
			"button navigation — Next button advances match",
			`Next button advanced from "${countBefore}" to "${countAfterNext}"`,
			shotNext,
		);
	}

	// Click "Previous match" button
	const prevBtn = await page.$(".notor-find-nav-btn[aria-label='Previous match']");
	if (!prevBtn) {
		ctx.fail("button navigation — prev button exists", ".notor-find-nav-btn[aria-label='Previous match'] not found");
		return;
	}
	await prevBtn.click();
	await page.waitForTimeout(300);

	const countAfterPrev = await getCountText(page);
	const matchAfterPrev = parseCurrentMatchIndex(countAfterPrev);
	const shotPrev = await ctx.screenshot("07b-prev-button");

	if (matchAfterPrev !== matchBefore) {
		ctx.fail(
			"button navigation — Previous button retreats match",
			`Expected match ${matchBefore} after Previous but got "${countAfterPrev}" (was "${countAfterNext}")`,
			shotPrev,
		);
	} else {
		ctx.pass(
			"button navigation — Previous button retreats match",
			`Previous button retreated from "${countAfterNext}" back to "${countAfterPrev}"`,
			shotPrev,
		);
	}
}

async function testNoMatchQuery(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: Non-matching query shows '0 results'");
	const { page } = ctx;

	const barOpen = await isFindBarVisible(page);
	if (!barOpen) {
		ctx.fail("no match — bar open", "Find bar not open — skipping no-match test");
		return;
	}

	await clearSearch(page);
	await typeSearch(page, NO_MATCH_TERM);

	const highlightCount = await countHighlights(page);
	const countText = await getCountText(page);
	const shot = await ctx.screenshot("08-no-match");

	if (highlightCount !== 0) {
		ctx.fail(
			"no match — zero highlights",
			`Expected 0 highlights for "${NO_MATCH_TERM}" but found ${highlightCount}`,
			shot,
		);
	} else {
		ctx.pass("no match — zero highlights", `Correctly found no highlights for "${NO_MATCH_TERM}"`, shot);
	}

	if (countText !== "0 results") {
		ctx.fail(
			"no match — count shows '0 results'",
			`Expected "0 results" but got "${countText}"`,
			shot,
		);
	} else {
		ctx.pass("no match — count shows '0 results'", `Count display shows "${countText}"`, shot);
	}
}

async function testClearQueryClearsCount(ctx: TestContext): Promise<void> {
	console.log("\nTest 9: Clearing the query empties the count display");
	const { page } = ctx;

	const barOpen = await isFindBarVisible(page);
	if (!barOpen) {
		ctx.fail("clear query — bar open", "Find bar not open — skipping clear-query test");
		return;
	}

	await clearSearch(page);

	const countText = await getCountText(page);
	const shot = await ctx.screenshot("09-clear-query");

	if (countText !== "") {
		ctx.fail(
			"clear query — count display empty",
			`Expected empty count after clearing query but got "${countText}"`,
			shot,
		);
	} else {
		ctx.pass("clear query — count display empty", "Count display is empty when query is cleared", shot);
	}
}

async function testEscapeClosesFindBar(ctx: TestContext): Promise<void> {
	console.log("\nTest 10: Escape key closes the bar and removes highlights");
	const { page } = ctx;

	// Re-open and type something so there are highlights to verify removal
	await openViaCommand(page);
	await typeSearch(page, SEARCH_TERM);

	const highlightsBefore = await countHighlights(page);
	if (highlightsBefore === 0) {
		ctx.fail("escape closes — highlights present before close", "No highlights present before pressing Escape");
	}

	await page.focus(".notor-find-input");
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);

	const visible = await isFindBarVisible(page);
	const highlightsAfter = await countHighlights(page);
	const shot = await ctx.screenshot("10-escape-close");

	if (visible) {
		ctx.fail("escape closes — bar hidden", "Find bar is still visible after Escape", shot);
	} else {
		ctx.pass("escape closes — bar hidden", "Find bar hidden after Escape", shot);
	}

	if (highlightsAfter !== 0) {
		ctx.fail(
			"escape closes — highlights cleared",
			`${highlightsAfter} highlight(s) remain in DOM after closing with Escape`,
			shot,
		);
	} else {
		ctx.pass("escape closes — highlights cleared", "All highlights removed from DOM on close", shot);
	}
}

async function testCloseButtonClosesFindBar(ctx: TestContext): Promise<void> {
	console.log("\nTest 11: Close button (✕) closes the bar");
	const { page } = ctx;

	await openViaCommand(page);
	const barOpen = await isFindBarVisible(page);
	if (!barOpen) {
		ctx.fail("close button — bar opens", "Find bar did not open via command API");
		return;
	}

	const closeBtn = await page.$(".notor-find-nav-btn[aria-label='Close search']");
	if (!closeBtn) {
		ctx.fail("close button — button exists", ".notor-find-nav-btn[aria-label='Close search'] not found");
		return;
	}

	await closeBtn.click();
	await page.waitForTimeout(300);

	const visible = await isFindBarVisible(page);
	const shot = await ctx.screenshot("11-close-button");

	if (visible) {
		ctx.fail("close button — bar hidden after click", "Find bar still visible after clicking close button", shot);
	} else {
		ctx.pass("close button — bar hidden after click", "Find bar hidden after clicking ✕", shot);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	// Wait for plugin to fully initialize
	await page.waitForTimeout(5_000);

	// Verify the chat panel loaded
	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chatContainer) {
		const shot = await ctx.screenshot("00-no-chat-panel");
		ctx.fail("chat panel visible", ".notor-chat-container not found", shot);
		throw new Error("Chat panel not visible — cannot run find-in-messages tests");
	}
	const initShot = await ctx.screenshot("00-chat-ready");
	ctx.pass("chat panel visible", "Plugin loaded and chat container found", initShot);

	// Inject known-content messages so there is searchable text in the panel
	const cleanup = await injectTestMessages(page);

	try {
		await testFindBarInitiallyHidden(ctx);
		await testKeyboardShortcutOpensBar(ctx);
		await testCommandPaletteOpensBar(ctx);
		await testSearchHighlightsMatches(ctx, cleanup);
		await testForwardNavigation(ctx);
		await testBackwardNavigation(ctx);
		await testButtonNavigation(ctx);
		await testNoMatchQuery(ctx);
		await testClearQueryClearsCount(ctx);
		await testEscapeClosesFindBar(ctx);
		await testCloseButtonClosesFindBar(ctx);
	} finally {
		// Close bar if still open, then remove injected messages
		const barStillOpen = await isFindBarVisible(page);
		if (barStillOpen) {
			await page.evaluate(() => {
				(window as any).app?.commands?.executeCommandById?.("notor:find-in-messages");
			});
			await page.waitForTimeout(200);
		}
		await cleanup();
	}
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings();

runTest({ name: "find-in-messages", settings }, tests);
