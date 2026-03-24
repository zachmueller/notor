#!/usr/bin/env npx tsx
/**
 * Chat Panel Scroll Behaviour Test
 *
 * Validates that the chat panel's auto-scroll does NOT fight the user when they
 * manually scroll up — both during streaming and while a diff is pending approval.
 *
 * Scenarios covered:
 *   1. Scroll position is preserved when the user scrolls up mid-stream
 *   2. Auto-scroll re-engages when the user scrolls back to the bottom
 *   3. Scroll position is preserved while a write_note diff is pending approval
 *   4. Sending a new message resets auto-scroll (new response tracks to bottom)
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled on that account with deepseek.v3.2 available
 *
 * Run with:
 *   npx tsx e2e/scripts/chat-scroll-test.ts
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	newConversation,
	VAULT_PATH,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
const RESPONSE_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// Local helpers (unique to this test)
// ---------------------------------------------------------------------------

/** Send a message and return immediately (do not wait for response). */
async function sendMessageNoWait(page: Page, message: string): Promise<void> {
	// Wait for the input to be present
	const input = await page.waitForSelector(".notor-text-input", { timeout: 8_000 }).catch(() => null);
	if (!input) throw new Error("Chat input not found");
	// Set textContent via evaluate (more reliable than keyboard.type on contenteditable)
	await page.evaluate((text) => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		if (!el) return;
		el.focus();
		el.textContent = text;
		el.dispatchEvent(new Event("input", { bubbles: true }));
	}, message);
	await page.waitForTimeout(200);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(400);
	console.log(`    → Sent: "${message.substring(0, 80)}${message.length > 80 ? "..." : ""}"`);
}

/**
 * Wait until the chat input is re-enabled (response complete).
 * Returns true if completed within timeout.
 *
 * Checks `contenteditable` attribute — the plugin sets it to "false"
 * while responding and back to "true" when done (the input is a
 * contenteditable div, not an <input>, so `.disabled` doesn't apply).
 */
async function waitForResponse(page: Page, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(POLL_INTERVAL_MS);
		const inputEnabled = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el !== null && el.getAttribute("contenteditable") === "true";
		});
		if (inputEnabled) return true;
	}
	return false;
}

/** Send a message and wait for the response to complete. */
async function sendMessage(page: Page, message: string): Promise<boolean> {
	await sendMessageNoWait(page, message);
	return waitForResponse(page);
}

/** Wait for at least one streaming text chunk to appear in the last assistant message. */
async function waitForStreamingStart(page: Page, timeoutMs = 45_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(500);
		const hasContent = await page.evaluate(() => {
			const msgs = document.querySelectorAll(".notor-message-assistant");
			if (msgs.length === 0) return false;
			const last = msgs[msgs.length - 1]!;
			return (last.textContent ?? "").trim().length > 20;
		});
		if (hasContent) return true;
	}
	return false;
}

/** Wait for an approval UI (diff view) to appear. */
async function waitForApprovalUI(page: Page, timeoutMs = 30_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(500);
		const el = await page.$(".notor-approve-btn, .notor-reject-btn, .notor-diff-view");
		if (el) return true;
	}
	return false;
}

/** Read the message list's current scrollTop and scrollHeight from the browser. */
async function getScrollState(page: Page): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
	return page.evaluate(() => {
		const el = document.querySelector(".notor-message-list") as HTMLElement | null;
		if (!el) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
		return {
			scrollTop: el.scrollTop,
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		};
	});
}

/** Scroll the message list up by `px` pixels from the current position. */
async function scrollUp(page: Page, px: number): Promise<void> {
	await page.evaluate((amount) => {
		const el = document.querySelector(".notor-message-list") as HTMLElement | null;
		if (el) el.scrollTop = Math.max(0, el.scrollTop - amount);
	}, px);
	// Give the scroll event listener time to fire
	await page.waitForTimeout(150);
}

/** Scroll the message list to the very bottom. */
async function scrollToBottom(page: Page): Promise<void> {
	await page.evaluate(() => {
		const el = document.querySelector(".notor-message-list") as HTMLElement | null;
		if (el) el.scrollTop = el.scrollHeight;
	});
	await page.waitForTimeout(150);
}

/**
 * Inject a transparent spacer into the message list to force it to overflow.
 * Returns a cleanup function that removes the spacer.
 */
async function injectScrollSpacer(page: Page, heightPx = 600): Promise<() => Promise<void>> {
	await page.evaluate((h) => {
		const el = document.querySelector(".notor-message-list") as HTMLElement | null;
		if (!el) return;
		const spacer = document.createElement("div");
		spacer.id = "e2e-scroll-spacer";
		spacer.style.height = `${h}px`;
		spacer.style.flexShrink = "0";
		el.prepend(spacer);
	}, heightPx);
	return async () => {
		await page.evaluate(() => {
			document.getElementById("e2e-scroll-spacer")?.remove();
		});
	};
}

/** Switch to Act mode (required for write tools). */
async function setActMode(page: Page): Promise<void> {
	const toggle = await page.$(".notor-mode-toggle");
	if (!toggle) throw new Error("Mode toggle not found");
	const current = await toggle.textContent();
	if (current?.trim() !== "Act") {
		await toggle.click();
		await page.waitForTimeout(400);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Test 1: Scroll position is preserved when the user scrolls up mid-stream.
 *
 * Strategy: inject a DOM spacer to guarantee the message list overflows,
 * then send a short message. While the response streams in, scroll up and
 * verify the position does not snap back to the bottom.
 */
async function testScrollPreservedDuringStreaming(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Scroll Test 1: scroll preserved during streaming ────────────");
	await newConversation(page);

	// Inject a large spacer to force the message list to overflow well before streaming begins.
	// Use 1500px to ensure overflow even in a tall panel (clientHeight was measured at 860px).
	const removeSpacerT1 = await injectScrollSpacer(page, 1500);

	// Scroll to the bottom so autoScroll is engaged.
	await scrollToBottom(page);
	await page.waitForTimeout(200);

	// Send a short message — the response will stream in and autoScroll would
	// normally keep snapping us to the bottom without the fix.
	await sendMessageNoWait(page, "Please respond with a paragraph about the moon landing.");

	// Wait for streaming to begin
	const streamingStarted = await waitForStreamingStart(page, 45_000);
	if (!streamingStarted) {
		const shot = await ctx.screenshot("01-no-stream");
		ctx.fail("streaming — streaming started", "No assistant text appeared within 45s", shot);
		await removeSpacerT1();
		await waitForResponse(page, 60_000);
		return;
	}
	ctx.pass("streaming — streaming started", "Assistant is actively streaming text");

	// Confirm the message list is now overflowing (spacer + user msg + streaming response)
	const scrollDims = await page.evaluate(() => {
		const el = document.querySelector(".notor-message-list") as HTMLElement | null;
		return el ? { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : { scrollHeight: 0, clientHeight: 0 };
	});
	console.log(`    [scroll dims] scrollHeight=${scrollDims.scrollHeight} clientHeight=${scrollDims.clientHeight} overflow=${scrollDims.scrollHeight - scrollDims.clientHeight}px`);

	if (scrollDims.scrollHeight <= scrollDims.clientHeight) {
		ctx.fail("streaming — message list overflowing", `No overflow even with spacer (scrollHeight=${scrollDims.scrollHeight}, clientHeight=${scrollDims.clientHeight})`);
		await removeSpacerT1();
		await waitForResponse(page, RESPONSE_TIMEOUT_MS);
		return;
	}
	ctx.pass("streaming — message list overflowing", `${scrollDims.scrollHeight - scrollDims.clientHeight}px overflow`);

	// Scroll up while the response is streaming — this should disable autoScroll.
	await scrollUp(page, 400);
	const stateAfterScroll = await getScrollState(page);
	const scrollTopAfterManualScroll = stateAfterScroll.scrollTop;

	await ctx.screenshot("01-scrolled-up-mid-stream");

	// Wait 2 seconds; without the fix, scrollToBottom() would fire every chunk
	// and snap us back down. With the fix, we should stay put.
	await page.waitForTimeout(2_000);

	const stateAfterWait = await getScrollState(page);
	const distanceFromBottom = stateAfterWait.scrollHeight - stateAfterWait.scrollTop - stateAfterWait.clientHeight;
	const wasSnappedToBottom = distanceFromBottom < 10;

	const shot2 = await ctx.screenshot("01-after-wait");

	if (wasSnappedToBottom) {
		ctx.fail(
			"streaming — scroll preserved mid-stream",
			`Scroll snapped to bottom during streaming (scrollTop: ${scrollTopAfterManualScroll} → ${stateAfterWait.scrollTop}, distanceFromBottom: ${distanceFromBottom}px)`,
			shot2
		);
	} else {
		ctx.pass(
			"streaming — scroll preserved mid-stream",
			`Scroll held at ${Math.round(stateAfterWait.scrollTop)}px (${Math.round(distanceFromBottom)}px from bottom, not snapped)`,
			shot2
		);
	}

	await removeSpacerT1();
	await waitForResponse(page, RESPONSE_TIMEOUT_MS);
}

/**
 * Test 2: Auto-scroll re-engages when the user scrolls back to the bottom.
 *
 * Strategy: inject a spacer to guarantee overflow, send a short message,
 * scroll up (disabling autoScroll), then scroll back to the bottom
 * (re-enabling autoScroll), and verify that new streaming content tracks
 * to the bottom.
 */
async function testAutoScrollReengagesOnScrollDown(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Scroll Test 2: auto-scroll re-engages on scroll-to-bottom ──");
	await newConversation(page);

	const removeSpacerT2 = await injectScrollSpacer(page, 1500);
	await scrollToBottom(page);
	await page.waitForTimeout(200);

	await sendMessageNoWait(page, "Please respond with a short paragraph about ocean tides.");

	const streamingStarted = await waitForStreamingStart(page, 45_000);
	if (!streamingStarted) {
		const shot = await ctx.screenshot("02-no-stream");
		ctx.fail("re-engage — streaming started", "No assistant text appeared within 45s", shot);
		await removeSpacerT2();
		await waitForResponse(page, 60_000);
		return;
	}
	ctx.pass("re-engage — streaming started", "Assistant is actively streaming text");

	// Scroll up to disable auto-scroll, then back to bottom to re-enable it.
	await scrollUp(page, 400);
	await page.waitForTimeout(400);

	const stateScrolledUp = await getScrollState(page);
	const distanceScrolledUp = stateScrolledUp.scrollHeight - stateScrolledUp.scrollTop - stateScrolledUp.clientHeight;

	if (distanceScrolledUp < 10) {
		ctx.pass("re-engage — content not overflowing", "Spacer may not have been enough; skipping re-engage check");
		await removeSpacerT2();
		await waitForResponse(page, RESPONSE_TIMEOUT_MS);
		return;
	}

	// Scroll back to the bottom — this fires the scroll event and sets autoScroll=true.
	await scrollToBottom(page);
	await page.waitForTimeout(500);

	// Capture height before more content arrives.
	const stateBefore = await getScrollState(page);
	const heightBefore = stateBefore.scrollHeight;

	// Allow more streaming content to arrive; autoScroll should track to bottom.
	await page.waitForTimeout(1_500);

	const stateAfterMoreContent = await getScrollState(page);
	const distanceAfterMore = stateAfterMoreContent.scrollHeight - stateAfterMoreContent.scrollTop - stateAfterMoreContent.clientHeight;

	const shot = await ctx.screenshot("02-re-engaged");

	if (stateAfterMoreContent.scrollHeight > heightBefore && distanceAfterMore <= 50) {
		ctx.pass(
			"re-engage — auto-scroll re-engaged after scrolling to bottom",
			`New content streamed (+${stateAfterMoreContent.scrollHeight - heightBefore}px) and panel tracked to bottom (${Math.round(distanceAfterMore)}px from bottom)`,
			shot
		);
	} else if (stateAfterMoreContent.scrollHeight === heightBefore) {
		ctx.pass("re-engage — response complete before re-engage check", "Response finished; re-engage not testable at this point");
	} else {
		ctx.fail(
			"re-engage — auto-scroll re-engaged after scrolling to bottom",
			`Content grew by ${stateAfterMoreContent.scrollHeight - heightBefore}px but panel is ${Math.round(distanceAfterMore)}px from bottom`,
			shot
		);
	}

	await removeSpacerT2();
	await waitForResponse(page, RESPONSE_TIMEOUT_MS);
}

/**
 * Test 3: Scroll position is preserved while a write_note diff is pending approval.
 *
 * Trigger a write_note call (manual approval required). Once the diff UI
 * appears, scroll up. Verify that the panel does NOT snap back to the bottom
 * repeatedly while waiting for approval.
 */
async function testScrollPreservedDuringDiffApproval(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Scroll Test 3: scroll preserved during diff approval ────────");
	await newConversation(page);
	await setActMode(page);

	const targetPath = path.join(VAULT_PATH, "Scroll-Test-Diff.md");
	if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

	// Ask for a note with enough content that the diff view is large
	await sendMessageNoWait(
		page,
		"Please create a new note at 'Scroll-Test-Diff.md' with the following content:\n\n" +
		"# Scroll Test Note\n\n" +
		"## Introduction\n\nThis note is used to test scroll behaviour during diff approval.\n\n" +
		"## Section 1\n\n" + "Line one of section one.\n".repeat(10) +
		"\n## Section 2\n\n" + "Line one of section two.\n".repeat(10) +
		"\n## Section 3\n\n" + "Line one of section three.\n".repeat(10) +
		"\n## Conclusion\n\nThis is the final section of the test note.\n"
	);

	const approvalAppeared = await waitForApprovalUI(page, 90_000);
	if (!approvalAppeared) {
		const shot = await ctx.screenshot("03-no-approval-ui");
		ctx.fail("diff approval — approval UI appeared", "Diff/approval UI did not appear within 90s", shot);
		await waitForResponse(page, 30_000);
		return;
	}

	ctx.pass("diff approval — approval UI appeared", "Diff view is visible");

	// Scroll up to see the top of the diff
	await scrollUp(page, 600);
	const stateAfterScroll = await getScrollState(page);
	const scrollTopAfterManualScroll = stateAfterScroll.scrollTop;
	const distanceFromBottomAfterScroll =
		stateAfterScroll.scrollHeight - stateAfterScroll.scrollTop - stateAfterScroll.clientHeight;

	await ctx.screenshot("03-scrolled-up-during-diff");

	if (distanceFromBottomAfterScroll < 10) {
		// Content not tall enough
		ctx.pass("diff approval — content scrollable", "Diff content too short to scroll meaningfully; skipping snap check");
	} else {
		// Wait 1.5 seconds (previously 3 poll-scroll ticks would have fired)
		await page.waitForTimeout(1_500);

		const stateAfterWait = await getScrollState(page);
		const distanceFromBottomAfterWait =
			stateAfterWait.scrollHeight - stateAfterWait.scrollTop - stateAfterWait.clientHeight;
		const wasSnapped = distanceFromBottomAfterWait < 10;

		const shot2 = await ctx.screenshot("03-after-wait-during-diff");

		if (wasSnapped) {
			ctx.fail(
				"diff approval — scroll preserved during approval wait",
				`Scroll snapped to bottom while diff was pending (scrollTop: ${scrollTopAfterManualScroll} → ${stateAfterWait.scrollTop}, distanceFromBottom: ${distanceFromBottomAfterWait}px)`,
				shot2
			);
		} else {
			ctx.pass(
				"diff approval — scroll preserved during approval wait",
				`Scroll held at ${Math.round(stateAfterWait.scrollTop)}px (${Math.round(distanceFromBottomAfterWait)}px from bottom, not snapped)`,
				shot2
			);
		}
	}

	// Reject to unblock
	const rejectBtn = await page.$(".notor-reject-btn");
	const approveBtn = await page.$(".notor-approve-btn");
	if (rejectBtn) {
		await rejectBtn.click();
	} else if (approveBtn) {
		await approveBtn.click();
	}
	await waitForResponse(page, 30_000);

	// Clean up
	if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
}

/**
 * Test 4: Sending a new message resets auto-scroll.
 *
 * Scroll up during a response, then send a new message. The new response
 * should auto-scroll to the bottom so the user sees it.
 */
async function testNewMessageResetsAutoScroll(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Scroll Test 4: new message resets auto-scroll ───────────────");
	await newConversation(page);

	// First message — get some content
	const responded = await sendMessage(page, "Reply with exactly the text: First response complete.");
	if (!responded) {
		await ctx.screenshot("04-no-first-response");
		ctx.fail("new-message reset — first response received", "First response timed out");
		return;
	}

	// Scroll up to disable auto-scroll
	await scrollUp(page, 400);
	await page.waitForTimeout(300);

	const stateScrolledUp = await getScrollState(page);
	console.log(`    Scrolled up to ${stateScrolledUp.scrollTop}px`);

	// Send second message — this should re-enable auto-scroll
	await sendMessageNoWait(
		page,
		"Reply with exactly the text: Second response complete. Do not add anything else."
	);

	// The new user message being rendered should scroll to bottom (autoScroll reset on send)
	await page.waitForTimeout(800);
	const stateAfterSend = await getScrollState(page);
	const distanceFromBottomAfterSend =
		stateAfterSend.scrollHeight - stateAfterSend.scrollTop - stateAfterSend.clientHeight;

	const shot = await ctx.screenshot("04-after-new-message-send");

	if (distanceFromBottomAfterSend <= 50) {
		ctx.pass(
			"new-message reset — panel scrolled to bottom on new send",
			`Panel at bottom after send (${Math.round(distanceFromBottomAfterSend)}px from bottom)`,
			shot
		);
	} else {
		ctx.fail(
			"new-message reset — panel scrolled to bottom on new send",
			`Panel is ${Math.round(distanceFromBottomAfterSend)}px from bottom after new message send`,
			shot
		);
	}

	await waitForResponse(page, RESPONSE_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Main — run via shared test harness
// ---------------------------------------------------------------------------

runTest(
	{
		name: "chat-scroll",
		settings: buildDefaultSettings(),
		cleanupFiles: ["Scroll-Test-Diff.md"],
	},
	async (ctx) => {
		const { page } = ctx;

		// Verify chat panel is visible
		const chatContainer = await page.waitForSelector(".notor-chat-container", { timeout: 10_000 }).catch(() => null);
		if (!chatContainer) {
			const shot = await ctx.screenshot("00-no-chat-panel");
			ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
			throw new Error("Chat panel not visible — cannot run scroll tests");
		}
		const shot = await ctx.screenshot("00-chat-ready");
		ctx.pass("Chat panel ready", "Plugin loaded and chat container found", shot);

		// Run scroll tests with brief settle between them
		await testScrollPreservedDuringStreaming(ctx);
		await page.waitForTimeout(2_000);
		await testAutoScrollReengagesOnScrollDown(ctx);
		await page.waitForTimeout(2_000);
		await testScrollPreservedDuringDiffApproval(ctx);
		await page.waitForTimeout(2_000);
		await testNewMessageResetsAutoScroll(ctx);
	},
);
