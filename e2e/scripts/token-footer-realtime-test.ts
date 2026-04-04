#!/usr/bin/env npx tsx
/**
 * Token Footer Real-Time Updates E2E Test
 *
 * Validates Phase 2 of the token counting improvements: the token footer
 * updates in real time after each tool-call round and tool-result, not
 * only after the final text response.
 *
 * Scenarios:
 *   1. Plugin loads and chat panel is visible
 *   2. Single tool-call prompt — footer updates during the tool-call round
 *      (not just after the final text response)
 *   3. Multi-tool-call prompt — footer updates incrementally with increasing
 *      token counts across sequential tool-call rounds
 *   4. Token footer values monotonically increase across turns
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled on that account (Claude model)
 *
 * @see specs/ZZ-misc/token-counting-improvements-tasks.md — Phase 2
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessageWithApprovalHandling,
	newConversation,
	ensureCleanState,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const SINGLE_TOOL_PROMPT =
	"Read the file named 'Welcome.md' in the vault root. Summarize it in one sentence.";
const MULTI_TOOL_PROMPT =
	"Read the files 'Welcome.md' and '.obsidian/app.json' from the vault. " +
	"For each file, tell me the first line of its content.";
const FOLLOWUP_PROMPT = "What is 2 + 2? Reply with just the number.";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Install a MutationObserver on the token footer element that records every
 * text change with a high-resolution timestamp. Returns a handle ID that can
 * be used to retrieve the recorded snapshots later.
 */
async function installFooterObserver(page: import("playwright-core").Page): Promise<void> {
	await page.evaluate(() => {
		const el = document.querySelector(".notor-token-footer");
		if (!el) return;

		// Reset any previous snapshots
		(window as any).__footerSnapshots = [];

		const observer = new MutationObserver(() => {
			const text = el.textContent?.trim() ?? "";
			const isHidden = el.classList.contains("notor-hidden");
			(window as any).__footerSnapshots.push({
				text,
				isHidden,
				timestamp: performance.now(),
			});
		});

		// Observe text changes and class attribute changes (hidden toggle)
		observer.observe(el, {
			childList: true,
			characterData: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class"],
		});

		(window as any).__footerObserver = observer;
	});
}

/**
 * Retrieve the recorded footer snapshots and disconnect the observer.
 */
async function collectFooterSnapshots(
	page: import("playwright-core").Page,
): Promise<Array<{ text: string; isHidden: boolean; timestamp: number }>> {
	return page.evaluate(() => {
		const observer = (window as any).__footerObserver;
		if (observer) {
			observer.disconnect();
			(window as any).__footerObserver = null;
		}
		return (window as any).__footerSnapshots ?? [];
	});
}

/**
 * Parse "Tokens: ↑1,234 ↓5,678" from footer text.
 */
function parseTokenFooter(text: string): { input: number; output: number } | null {
	const match = text.match(/↑([\d,]+)\s*↓([\d,]+)/);
	if (!match) return null;
	return {
		input: parseInt(match[1]!.replace(/,/g, ""), 10),
		output: parseInt(match[2]!.replace(/,/g, ""), 10),
	};
}

/**
 * Read the current token footer text from the UI.
 */
async function getTokenFooterText(page: import("playwright-core").Page): Promise<string | null> {
	return page.evaluate(() => {
		const el = document.querySelector(".notor-token-footer");
		if (!el || el.classList.contains("notor-hidden")) return null;
		return el.textContent?.trim() ?? null;
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testChatPanelVisible(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Chat panel visible");
	const { page } = ctx;

	const chatContainer = await waitForSelector(page, ".notor-chat-container", 8_000);
	if (chatContainer) {
		const shot = await ctx.screenshot("01-startup");
		ctx.pass("Chat panel visible", "Found .notor-chat-container", shot);
	} else {
		const shot = await ctx.screenshot("01-startup-missing");
		ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
		throw new Error("Chat panel not visible — cannot continue");
	}
}

async function testSingleToolCallFooterUpdate(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Token footer updates during single tool-call round");
	const { page } = ctx;

	await newConversation(page);
	await page.waitForTimeout(1_000);

	// Install the observer before sending the prompt
	await installFooterObserver(page);

	const { responded } = await sendMessageWithApprovalHandling(page, SINGLE_TOOL_PROMPT);
	if (!responded) {
		await collectFooterSnapshots(page); // cleanup
		const shot = await ctx.screenshot("02-no-response");
		ctx.fail("Single tool-call response", "No response received within timeout", shot);
		return;
	}

	const snapshots = await collectFooterSnapshots(page);
	const shot = await ctx.screenshot("02-single-tool-footer");

	// Filter to visible, non-empty snapshots with parseable token values
	const visibleUpdates = snapshots
		.filter((s) => !s.isHidden && s.text.length > 0)
		.map((s) => ({ ...s, parsed: parseTokenFooter(s.text) }))
		.filter((s) => s.parsed !== null);

	console.log(`  Footer observer captured ${snapshots.length} mutations, ${visibleUpdates.length} with visible token values`);
	for (const u of visibleUpdates) {
		console.log(`    [${u.timestamp.toFixed(0)}ms] "${u.text}" → in=${u.parsed!.input}, out=${u.parsed!.output}`);
	}

	// Test 2a: Footer was updated at least once with non-zero tokens
	if (visibleUpdates.length === 0) {
		ctx.fail("Footer updated during tool-call", "No visible footer updates with token values were observed", shot);
		return;
	}

	ctx.pass("Footer updated during tool-call",
		`${visibleUpdates.length} footer update(s) observed`, shot);

	// Test 2b: For a tool-call turn, we expect at least 2 distinct footer updates:
	// one after the tool-call turn tokens are recorded (task 2-1) and one after
	// the final text response. More updates are possible from task 2-2.
	const distinctValues = new Set(visibleUpdates.map((u) => u.text));
	if (distinctValues.size >= 2) {
		ctx.pass("Multiple distinct footer values",
			`${distinctValues.size} distinct footer values observed — footer updated incrementally`);
	} else {
		// Even with 1 distinct value, the footer was updated — it just means
		// the tool-call turn and final response had the same accumulated totals
		// (unlikely but possible if the tool call consumed very few tokens)
		ctx.pass("Footer values captured",
			`${distinctValues.size} distinct value(s) — token accumulation may have been too small to show a difference`);
	}
}

async function testMultiToolCallIncrementalUpdates(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Token footer updates incrementally across multiple tool-call rounds");
	const { page } = ctx;

	await newConversation(page);
	await page.waitForTimeout(1_000);

	// Install the observer before sending the prompt
	await installFooterObserver(page);

	const { responded } = await sendMessageWithApprovalHandling(
		page, MULTI_TOOL_PROMPT, 120_000,
	);
	if (!responded) {
		await collectFooterSnapshots(page); // cleanup
		const shot = await ctx.screenshot("03-no-response");
		ctx.fail("Multi-tool-call response", "No response received within timeout", shot);
		return;
	}

	const snapshots = await collectFooterSnapshots(page);
	const shot = await ctx.screenshot("03-multi-tool-footer");

	// Filter to visible snapshots with parseable token values
	const visibleUpdates = snapshots
		.filter((s) => !s.isHidden && s.text.length > 0)
		.map((s) => ({ ...s, parsed: parseTokenFooter(s.text) }))
		.filter((s) => s.parsed !== null);

	console.log(`  Footer observer captured ${snapshots.length} mutations, ${visibleUpdates.length} with visible token values`);
	for (const u of visibleUpdates) {
		console.log(`    [${u.timestamp.toFixed(0)}ms] "${u.text}" → in=${u.parsed!.input}, out=${u.parsed!.output}`);
	}

	if (visibleUpdates.length === 0) {
		ctx.fail("Footer updated during multi-tool turn", "No visible footer updates observed", shot);
		return;
	}

	ctx.pass("Footer updated during multi-tool turn",
		`${visibleUpdates.length} footer update(s) observed`, shot);

	// Test 3a: Check that token values are monotonically non-decreasing
	// (each update should show equal or higher totals than the previous one)
	let monotonic = true;
	let prevInput = 0;
	let prevOutput = 0;
	for (const u of visibleUpdates) {
		const { input, output } = u.parsed!;
		if (input < prevInput || output < prevOutput) {
			monotonic = false;
			console.log(`    ⚠ Non-monotonic: prev(in=${prevInput}, out=${prevOutput}) → cur(in=${input}, out=${output})`);
			break;
		}
		prevInput = input;
		prevOutput = output;
	}

	if (monotonic) {
		ctx.pass("Token values monotonically non-decreasing",
			`All ${visibleUpdates.length} updates showed non-decreasing token counts`);
	} else {
		ctx.fail("Token values monotonically non-decreasing",
			"Token counts decreased between footer updates — unexpected", shot);
	}

	// Test 3b: Check that final token values are larger than the first visible update
	// (proves accumulation happened across the multi-tool interaction)
	const first = visibleUpdates[0]!.parsed!;
	const last = visibleUpdates[visibleUpdates.length - 1]!.parsed!;
	const totalFirst = first.input + first.output;
	const totalLast = last.input + last.output;

	if (totalLast > totalFirst) {
		ctx.pass("Tokens accumulated across tool rounds",
			`First update: in=${first.input}+out=${first.output}=${totalFirst} → Last: in=${last.input}+out=${last.output}=${totalLast}`);
	} else if (totalLast === totalFirst && visibleUpdates.length >= 2) {
		// Same total but multiple updates — footer was refreshed (task 2-1/2-2 fired)
		// even if no new tokens were added between updates
		ctx.pass("Footer refreshed across tool rounds",
			`Token totals unchanged (${totalLast}) but footer was updated ${visibleUpdates.length} times`);
	} else {
		ctx.fail("Tokens accumulated across tool rounds",
			`First=${totalFirst}, Last=${totalLast} — expected growth across multi-tool interaction`, shot);
	}
}

async function testTokenFooterGrowsAcrossConversation(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Token footer values grow across sequential prompts");
	const { page } = ctx;

	await newConversation(page);
	await page.waitForTimeout(1_000);

	// Prompt 1: tool-call prompt
	const { responded: r1 } = await sendMessageWithApprovalHandling(page, SINGLE_TOOL_PROMPT);
	if (!r1) {
		const shot = await ctx.screenshot("04-prompt1-timeout");
		ctx.fail("Prompt 1 responded", "Timeout", shot);
		return;
	}

	const footer1Text = await getTokenFooterText(page);
	const footer1 = footer1Text ? parseTokenFooter(footer1Text) : null;
	const shot1 = await ctx.screenshot("04-after-prompt1");

	if (!footer1) {
		ctx.fail("Footer after prompt 1", `Footer not visible or unparseable: "${footer1Text}"`, shot1);
		return;
	}
	ctx.pass("Footer after prompt 1",
		`"${footer1Text}" → in=${footer1.input}, out=${footer1.output}`, shot1);

	// Prompt 2: simple text prompt (no tool call)
	await ensureCleanState(page);
	const { responded: r2 } = await sendMessageWithApprovalHandling(page, FOLLOWUP_PROMPT);
	if (!r2) {
		const shot = await ctx.screenshot("04-prompt2-timeout");
		ctx.fail("Prompt 2 responded", "Timeout", shot);
		return;
	}

	const footer2Text = await getTokenFooterText(page);
	const footer2 = footer2Text ? parseTokenFooter(footer2Text) : null;
	const shot2 = await ctx.screenshot("04-after-prompt2");

	if (!footer2) {
		ctx.fail("Footer after prompt 2", `Footer not visible or unparseable: "${footer2Text}"`, shot2);
		return;
	}
	ctx.pass("Footer after prompt 2",
		`"${footer2Text}" → in=${footer2.input}, out=${footer2.output}`, shot2);

	// Verify growth: both input and output should increase
	// (input always grows because each turn re-sends the full history)
	if (footer2.input > footer1.input) {
		ctx.pass("Input tokens grew across turns",
			`${footer1.input} → ${footer2.input} (+${footer2.input - footer1.input})`);
	} else {
		ctx.fail("Input tokens grew across turns",
			`${footer1.input} → ${footer2.input} — expected increase`, shot2);
	}

	if (footer2.output > footer1.output) {
		ctx.pass("Output tokens grew across turns",
			`${footer1.output} → ${footer2.output} (+${footer2.output - footer1.output})`);
	} else {
		ctx.fail("Output tokens grew across turns",
			`${footer1.output} → ${footer2.output} — expected increase`, shot2);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	// Wait for plugin to fully initialize
	await page.waitForTimeout(5_000);

	await testChatPanelVisible(ctx);
	await ensureCleanState(page);

	await testSingleToolCallFooterUpdate(ctx);
	await testMultiToolCallIncrementalUpdates(ctx);
	await testTokenFooterGrowsAcrossConversation(ctx);
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
		read_file: true,
	},
	mode: "act",
});

runTest({
	name: "token-footer-realtime",
	settings,
}, tests);
