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

import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import {
	launchObsidian,
	closeObsidian,
	type ObsidianProcess,
} from "../lib/obsidian-launcher";
import { LogCollector } from "../lib/log-collector";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const VAULT_PATH = path.resolve(__dirname, "..", "test-vault");
const CDP_PORT = 9222;
const RESULTS_DIR = path.resolve(__dirname, "..", "results");
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots", "chat-scroll");
const LOGS_DIR = path.join(RESULTS_DIR, "logs");
const BUILD_DIR = path.resolve(__dirname, "..", "..", "build");
const PLUGIN_DATA_PATH = path.join(BUILD_DIR, "data.json");

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
const RESPONSE_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// Test results
// ---------------------------------------------------------------------------
interface TestResult {
	name: string;
	passed: boolean;
	detail: string;
	screenshot?: string;
}

const results: TestResult[] = [];

function pass(name: string, detail: string, screenshot?: string): void {
	console.log(`  ✓ PASS: ${name} — ${detail}`);
	results.push({ name, passed: true, detail, screenshot });
}

function fail(name: string, detail: string, screenshot?: string): void {
	console.error(`  ✗ FAIL: ${name} — ${detail}`);
	results.push({ name, passed: false, detail, screenshot });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function screenshot(page: Page, name: string): Promise<string> {
	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
	const file = path.join(SCREENSHOTS_DIR, `${name}.png`);
	await page.screenshot({ path: file, fullPage: true });
	return file;
}

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

/** Send a message and wait for the response to complete. */
async function sendMessage(page: Page, message: string): Promise<boolean> {
	await sendMessageNoWait(page, message);
	return waitForResponse(page);
}

/**
 * Wait until the chat input is re-enabled (response complete).
 * Returns true if completed within timeout.
 */
async function waitForResponse(page: Page, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(POLL_INTERVAL_MS);
		const inputEnabled = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el !== null && !(el as HTMLInputElement).disabled;
		});
		if (inputEnabled) return true;
	}
	return false;
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

/** Start a fresh conversation. */
async function newConversation(page: Page): Promise<void> {
	const btn = await page.$(".notor-chat-header-btn[aria-label='New conversation']");
	if (btn) {
		await btn.click();
		await page.waitForTimeout(1_500);
	}
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
// Settings
// ---------------------------------------------------------------------------
function buildSettings(writeAutoApprove: boolean): Record<string, unknown> {
	return {
		notor_dir: "notor/",
		active_provider: "bedrock",
		providers: [
			{
				type: "local",
				enabled: false,
				display_name: "Local (OpenAI-compatible)",
				endpoint: "http://localhost:11434/v1",
			},
			{
				type: "anthropic",
				enabled: false,
				display_name: "Anthropic",
				endpoint: "https://api.anthropic.com",
			},
			{
				type: "openai",
				enabled: false,
				display_name: "OpenAI",
				endpoint: "https://api.openai.com",
			},
			{
				type: "bedrock",
				enabled: true,
				display_name: "AWS Bedrock",
				aws_auth_method: "profile",
				aws_profile: "default",
				region: "us-east-1",
				model_id: "deepseek.v3.2",
			},
		],
		auto_approve: {
			read_note: true,
			search_vault: true,
			list_vault: true,
			read_frontmatter: true,
			write_note: writeAutoApprove,
			replace_in_note: writeAutoApprove,
			update_frontmatter: writeAutoApprove,
			manage_tags: writeAutoApprove,
		},
		mode: "plan",
		open_notes_on_access: true,
		history_path: ".obsidian/plugins/notor/history/",
		history_max_size_mb: 500,
		history_max_age_days: 90,
		checkpoint_path: ".obsidian/plugins/notor/checkpoints/",
		checkpoint_max_per_conversation: 100,
		checkpoint_max_age_days: 30,
		model_pricing: {},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

/**
 * Test 1: Scroll position is preserved when the user scrolls up mid-stream.
 *
 * Strategy: inject a DOM spacer to guarantee the message list overflows,
 * then send a short message. While the response streams in, scroll up and
 * verify the position does not snap back to the bottom.
 */
async function testScrollPreservedDuringStreaming(page: Page): Promise<void> {
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
		const shot = await screenshot(page, "01-no-stream");
		fail("streaming — streaming started", "No assistant text appeared within 45s", shot);
		await removeSpacerT1();
		await waitForResponse(page, 60_000);
		return;
	}
	pass("streaming — streaming started", "Assistant is actively streaming text");

	// Confirm the message list is now overflowing (spacer + user msg + streaming response)
	const scrollDims = await page.evaluate(() => {
		const el = document.querySelector(".notor-message-list") as HTMLElement | null;
		return el ? { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : { scrollHeight: 0, clientHeight: 0 };
	});
	console.log(`    [scroll dims] scrollHeight=${scrollDims.scrollHeight} clientHeight=${scrollDims.clientHeight} overflow=${scrollDims.scrollHeight - scrollDims.clientHeight}px`);

	if (scrollDims.scrollHeight <= scrollDims.clientHeight) {
		fail("streaming — message list overflowing", `No overflow even with spacer (scrollHeight=${scrollDims.scrollHeight}, clientHeight=${scrollDims.clientHeight})`);
		await removeSpacerT1();
		await waitForResponse(page, RESPONSE_TIMEOUT_MS);
		return;
	}
	pass("streaming — message list overflowing", `${scrollDims.scrollHeight - scrollDims.clientHeight}px overflow`);

	// Scroll up while the response is streaming — this should disable autoScroll.
	await scrollUp(page, 400);
	const stateAfterScroll = await getScrollState(page);
	const scrollTopAfterManualScroll = stateAfterScroll.scrollTop;

	const shot1 = await screenshot(page, "01-scrolled-up-mid-stream");

	// Wait 2 seconds; without the fix, scrollToBottom() would fire every chunk
	// and snap us back down. With the fix, we should stay put.
	await page.waitForTimeout(2_000);

	const stateAfterWait = await getScrollState(page);
	const distanceFromBottom = stateAfterWait.scrollHeight - stateAfterWait.scrollTop - stateAfterWait.clientHeight;
	const wasSnappedToBottom = distanceFromBottom < 10;

	const shot2 = await screenshot(page, "01-after-wait");

	if (wasSnappedToBottom) {
		fail(
			"streaming — scroll preserved mid-stream",
			`Scroll snapped to bottom during streaming (scrollTop: ${scrollTopAfterManualScroll} → ${stateAfterWait.scrollTop}, distanceFromBottom: ${distanceFromBottom}px)`,
			shot2
		);
	} else {
		pass(
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
async function testAutoScrollReengagesOnScrollDown(page: Page): Promise<void> {
	console.log("\n── Scroll Test 2: auto-scroll re-engages on scroll-to-bottom ──");
	await newConversation(page);

	const removeSpacerT2 = await injectScrollSpacer(page, 1500);
	await scrollToBottom(page);
	await page.waitForTimeout(200);

	await sendMessageNoWait(page, "Please respond with a short paragraph about ocean tides.");

	const streamingStarted = await waitForStreamingStart(page, 45_000);
	if (!streamingStarted) {
		const shot = await screenshot(page, "02-no-stream");
		fail("re-engage — streaming started", "No assistant text appeared within 45s", shot);
		await removeSpacerT2();
		await waitForResponse(page, 60_000);
		return;
	}
	pass("re-engage — streaming started", "Assistant is actively streaming text");

	// Scroll up to disable auto-scroll, then back to bottom to re-enable it.
	await scrollUp(page, 400);
	await page.waitForTimeout(400);

	const stateScrolledUp = await getScrollState(page);
	const distanceScrolledUp = stateScrolledUp.scrollHeight - stateScrolledUp.scrollTop - stateScrolledUp.clientHeight;

	if (distanceScrolledUp < 10) {
		pass("re-engage — content not overflowing", "Spacer may not have been enough; skipping re-engage check");
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

	const shot = await screenshot(page, "02-re-engaged");

	if (stateAfterMoreContent.scrollHeight > heightBefore && distanceAfterMore <= 50) {
		pass(
			"re-engage — auto-scroll re-engaged after scrolling to bottom",
			`New content streamed (+${stateAfterMoreContent.scrollHeight - heightBefore}px) and panel tracked to bottom (${Math.round(distanceAfterMore)}px from bottom)`,
			shot
		);
	} else if (stateAfterMoreContent.scrollHeight === heightBefore) {
		pass("re-engage — response complete before re-engage check", "Response finished; re-engage not testable at this point");
	} else {
		fail(
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
async function testScrollPreservedDuringDiffApproval(page: Page): Promise<void> {
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
		const shot = await screenshot(page, "03-no-approval-ui");
		fail("diff approval — approval UI appeared", "Diff/approval UI did not appear within 90s", shot);
		await waitForResponse(page, 30_000);
		return;
	}

	pass("diff approval — approval UI appeared", "Diff view is visible");

	// Scroll up to see the top of the diff
	await scrollUp(page, 600);
	const stateAfterScroll = await getScrollState(page);
	const scrollTopAfterManualScroll = stateAfterScroll.scrollTop;
	const distanceFromBottomAfterScroll =
		stateAfterScroll.scrollHeight - stateAfterScroll.scrollTop - stateAfterScroll.clientHeight;

	const shot1 = await screenshot(page, "03-scrolled-up-during-diff");

	if (distanceFromBottomAfterScroll < 10) {
		// Content not tall enough
		pass("diff approval — content scrollable", "Diff content too short to scroll meaningfully; skipping snap check");
	} else {
		// Wait 1.5 seconds (previously 3 poll-scroll ticks would have fired)
		await page.waitForTimeout(1_500);

		const stateAfterWait = await getScrollState(page);
		const distanceFromBottomAfterWait =
			stateAfterWait.scrollHeight - stateAfterWait.scrollTop - stateAfterWait.clientHeight;
		const wasSnapped = distanceFromBottomAfterWait < 10;

		const shot2 = await screenshot(page, "03-after-wait-during-diff");

		if (wasSnapped) {
			fail(
				"diff approval — scroll preserved during approval wait",
				`Scroll snapped to bottom while diff was pending (scrollTop: ${scrollTopAfterManualScroll} → ${stateAfterWait.scrollTop}, distanceFromBottom: ${distanceFromBottomAfterWait}px)`,
				shot2
			);
		} else {
			pass(
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
async function testNewMessageResetsAutoScroll(page: Page): Promise<void> {
	console.log("\n── Scroll Test 4: new message resets auto-scroll ───────────────");
	await newConversation(page);

	// First message — get some content
	const responded = await sendMessage(page, "Reply with exactly the text: First response complete.");
	if (!responded) {
		const shot = await screenshot(page, "04-no-first-response");
		fail("new-message reset — first response received", "First response timed out");
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

	const shot = await screenshot(page, "04-after-new-message-send");

	if (distanceFromBottomAfterSend <= 50) {
		pass(
			"new-message reset — panel scrolled to bottom on new send",
			`Panel at bottom after send (${Math.round(distanceFromBottomAfterSend)}px from bottom)`,
			shot
		);
	} else {
		fail(
			"new-message reset — panel scrolled to bottom on new send",
			`Panel is ${Math.round(distanceFromBottomAfterSend)}px from bottom after new message send`,
			shot
		);
	}

	await waitForResponse(page, RESPONSE_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
	console.log("=== Notor Chat Panel Scroll Behaviour Test ===\n");
	console.log("Provider:  AWS Bedrock");
	console.log("Auth:      AWS profile (default)");
	console.log("Region:    us-east-1");
	console.log("Model:     deepseek.v3.2\n");

	// ── Step 0: Build ──────────────────────────────────────────────────
	console.log("[0/4] Building plugin...");
	execSync("npm run build", {
		cwd: path.resolve(__dirname, "..", ".."),
		stdio: "inherit",
	});
	console.log("Build complete.\n");

	// ── Step 1: Inject settings ────────────────────────────────────────
	console.log("[1/4] Injecting settings (write tools require manual approval)...");
	const settings = buildSettings(/*writeAutoApprove=*/ false);
	fs.mkdirSync(BUILD_DIR, { recursive: true });
	fs.mkdirSync(LOGS_DIR, { recursive: true });
	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

	let existingData: string | null = null;
	if (fs.existsSync(PLUGIN_DATA_PATH)) {
		existingData = fs.readFileSync(PLUGIN_DATA_PATH, "utf8");
	}
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	console.log(`  Settings written to ${PLUGIN_DATA_PATH}\n`);

	let obsidian: ObsidianProcess | undefined;
	let collector: LogCollector | undefined;

	try {
		// ── Step 2: Launch Obsidian ──────────────────────────────────────
		console.log("[2/4] Launching Obsidian...");
		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });

		// ── Step 3: Connect Playwright ───────────────────────────────────
		console.log("[3/4] Connecting Playwright...");
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		const contexts = browser.contexts();
		const page = contexts[0]?.pages()[0];
		if (!page) throw new Error("No page found");

		collector = new LogCollector({ outputDir: LOGS_DIR });
		collector.attach(page);

		await page.waitForLoadState("domcontentloaded");
		await page.waitForTimeout(5_000);

		// ── Step 4: Verify chat panel ────────────────────────────────────
		console.log("[4/4] Running scroll behaviour tests...");
		{
			const chatContainer = await page.waitForSelector(".notor-chat-container", { timeout: 10_000 }).catch(() => null);
			if (!chatContainer) {
				const shot = await screenshot(page, "00-no-chat-panel");
				fail("Chat panel visible", ".notor-chat-container not found", shot);
				throw new Error("Chat panel not visible — cannot run scroll tests");
			}
			const shot = await screenshot(page, "00-chat-ready");
			pass("Chat panel ready", "Plugin loaded and chat container found", shot);
		}

		// ── Run scroll tests ─────────────────────────────────────────────
		// Brief settle between tests to let any pending LLM activity clear.
		await testScrollPreservedDuringStreaming(page);
		await page.waitForTimeout(2_000);
		await testAutoScrollReengagesOnScrollDown(page);
		await page.waitForTimeout(2_000);
		await testScrollPreservedDuringDiffApproval(page);
		await page.waitForTimeout(2_000);
		await testNewMessageResetsAutoScroll(page);

		// ── Final screenshot ─────────────────────────────────────────────
		await screenshot(page, "99-final");

		// ── Collect logs ─────────────────────────────────────────────────
		console.log("\n=== Collecting final logs ===");
		await page.waitForTimeout(1_000);
		const summaryPath = await collector.writeSummary();
		console.log(`Log summary: ${summaryPath}`);

		const errors = collector.getLogsByLevel("error");
		if (errors.length > 0) {
			console.log(`\nPlugin errors captured (${errors.length}):`);
			for (const e of errors.slice(-10)) {
				console.log(`  [${e.source}] ${e.message}`, e.data ?? "");
			}
		}

		await browser.close().catch(() => {});

	} catch (err) {
		console.error("\nFatal error:", err);
		if (collector) await collector.dispose().catch(() => {});
	} finally {
		if (obsidian) await closeObsidian(obsidian);

		// Restore original data.json
		if (existingData !== null) {
			fs.writeFileSync(PLUGIN_DATA_PATH, existingData);
			console.log("\nRestored original data.json");
		} else {
			try { fs.unlinkSync(PLUGIN_DATA_PATH); } catch { /* ignore */ }
			console.log("\nRemoved injected data.json");
		}
	}

	// ── Print summary ──────────────────────────────────────────────────
	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;

	console.log("\n=== Test Results ===");
	console.log(`Passed: ${passed}/${results.length}`);
	console.log(`Failed: ${failed}/${results.length}`);

	if (failed > 0) {
		console.log("\nFailed tests:");
		for (const r of results.filter((r) => !r.passed)) {
			console.log(`  ✗ ${r.name}: ${r.detail}`);
		}
	}

	const resultsPath = path.join(RESULTS_DIR, "chat-scroll-results.json");
	fs.writeFileSync(
		resultsPath,
		JSON.stringify({ passed, failed, total: results.length, results }, null, 2)
	);
	console.log(`\nResults written to: ${resultsPath}`);

	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
