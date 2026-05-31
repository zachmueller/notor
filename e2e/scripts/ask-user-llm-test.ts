#!/usr/bin/env npx tsx
/**
 * Ask User — LLM-Driven Full-UX E2E Test
 *
 * Exercises the complete model → UI → answer round-trip for the `ask_user`
 * follow-up-question tool against a real model (AWS Bedrock). This is the
 * scenario the deterministic ask-user-test.ts cannot cover: a live model
 * actually calling the tool, the user answering inline, and the answers
 * flowing back into the model's reply.
 *
 * This guards the original bug end-to-end: ask_user was not auto-approved, so
 * it rendered a generic "Approve this action?" prompt and a Reject returned a
 * blank result — the questions never appeared. Here we assert the interaction
 * prompt (chips + free-text input) renders directly, NO Approve/Reject buttons
 * appear, the chosen answer round-trips into the model's response, and a
 * replayable `interaction` block is persisted.
 *
 * Scenarios:
 *   1. Chat panel ready
 *   2. Model calls ask_user → interaction prompt renders (chips + input),
 *      and NO generic Approve/Reject buttons appear
 *   3. Answering each question (chip + free-text) lets the response complete
 *      and the model's reply references the chosen answer
 *   4. A persistent `interaction` block is rendered in the thread
 *   5. No interaction render errors logged
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access on that account (model from buildDefaultSettings)
 *
 * Run with:
 *   npx tsx e2e/scripts/ask-user-llm-test.ts
 *
 * @see e2e/scripts/diff-approval-test.ts — the LLM + approval-UI pattern this mirrors
 * @see e2e/scripts/ask-user-test.ts — deterministic renderer/dispatch coverage
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	waitForSelector,
	waitForResponse,
	getLastAssistantMessage,
	setMode,
	buildDefaultSettings,
} from "../lib/test-helpers";
import type { Page } from "playwright-core";

// ---------------------------------------------------------------------------
// Local helpers (mirrors diff-approval-test.ts — not in shared test-helpers)
// ---------------------------------------------------------------------------

/**
 * Send a chat message without waiting for the full response, so the caller can
 * intercept the inline interaction prompt mid-flight (the response loop pauses,
 * input stays disabled, while ask_user awaits answers).
 */
async function sendMessageNoWait(page: Page, message: string): Promise<void> {
	const found = await page.evaluate((msg) => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		if (!el) return false;
		el.focus();
		el.textContent = msg;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	}, message);
	if (!found) throw new Error("Chat input not found");

	await page.waitForTimeout(300);

	const sendBtn = await page.$(".notor-send-btn");
	if (sendBtn) await sendBtn.click();
	else await page.keyboard.press("Enter");

	await page.waitForTimeout(600);
	console.log(`    → Sent: "${message.substring(0, 80)}${message.length > 80 ? "..." : ""}"`);
}

/** Poll until an inline interaction prompt (or approval prompt) appears. */
async function waitForInteractionUI(page: Page, timeoutMs = 45_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(500);
		const prompt = await page.$(".notor-interaction-prompt");
		const approve = await page.$(".notor-approve-btn");
		if (prompt || approve) return true;
	}
	return false;
}

/**
 * Answer every question in the single grouped prompt, then let it auto-submit.
 * All questions render together as `.notor-interaction-question-group`s. For each
 * group: click the "Green" chip when present (deterministic assertion target),
 * else the first chip; for chip-less groups, type a free-text reply and commit
 * with Enter. The set auto-submits once the last question is answered — no
 * Submit button. Returns the number of question-groups answered.
 */
async function answerAllPrompts(page: Page, freeText: string): Promise<number> {
	const prompt = await page.$(".notor-interaction-prompt");
	if (!prompt) return 0;

	return page.evaluate((text) => {
		const prompt = document.querySelector(".notor-interaction-prompt");
		if (!prompt) return 0;
		const groups = Array.from(prompt.querySelectorAll(".notor-interaction-question-group"));
		let answered = 0;
		for (const group of groups) {
			const chips = Array.from(
				group.querySelectorAll<HTMLButtonElement>(".notor-interaction-chip"),
			);
			if (chips.length > 0) {
				const green = chips.find((c) => (c.textContent ?? "").trim().toLowerCase() === "green");
				(green ?? chips[0])!.click();
				answered += 1;
				continue;
			}
			const input = group.querySelector<HTMLInputElement>(".notor-interaction-input");
			if (input) {
				input.value = text;
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
				answered += 1;
			}
		}
		return answered;
	}, freeText);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

async function testAskUserRoundTrip(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── ask_user LLM round-trip ────────────────────────────────────");

	await setMode(page, "Act");

	await sendMessageNoWait(
		page,
		"Use the ask_user tool to ask me exactly two follow-up questions in a single call: " +
			"(1) my favorite color, offering the suggestions Red, Green, and Blue; and " +
			"(2) a free-text note with no suggestions. Do not guess my answers. " +
			"After I answer, reply with one sentence repeating the color I chose.",
	);

	const uiAppeared = await waitForInteractionUI(page, 60_000);
	const shot1 = await ctx.screenshot("01-interaction-ui");

	if (!uiAppeared) {
		ctx.fail("ask_user — interaction UI appears", "No interaction prompt within 60s (model may not have called ask_user)", shot1);
		await waitForResponse(page, 30_000);
		return;
	}

	// Core regression: the generic Approve/Reject gate must NOT appear.
	const approveBtn = await page.$(".notor-approve-btn");
	const rejectBtn = await page.$(".notor-reject-btn");
	if (!approveBtn && !rejectBtn) {
		ctx.pass("ask_user — no Approve/Reject gate", "Generic approval buttons absent (tool auto-approved)", shot1);
	} else {
		ctx.fail(
			"ask_user — no Approve/Reject gate",
			`Generic approval buttons present (regression): approve=${!!approveBtn}, reject=${!!rejectBtn}`,
			shot1,
		);
		// Unblock the loop so teardown is clean.
		await (rejectBtn ?? approveBtn)!.click();
		await waitForResponse(page, 30_000);
		return;
	}

	// Verify the interaction prompt shape: a SINGLE prompt holding all questions
	// as groups, with chips and at least one free-text input across them.
	const shape = await page.evaluate(() => {
		const prompts = Array.from(document.querySelectorAll(".notor-interaction-prompt"));
		return {
			prompts: prompts.length,
			groups: document.querySelectorAll(".notor-interaction-question-group").length,
			chips: document.querySelectorAll(".notor-interaction-chip").length,
			inputs: document.querySelectorAll(".notor-interaction-input").length,
		};
	});

	if (shape.prompts === 1 && shape.groups >= 2) {
		ctx.pass("ask_user — questions grouped in one prompt", `1 prompt with ${shape.groups} question groups (all visible together)`);
	} else {
		ctx.fail("ask_user — questions grouped in one prompt", `Expected 1 prompt with ≥2 groups, got prompts=${shape.prompts}, groups=${shape.groups}`, shot1);
	}
	if (shape.chips > 0) {
		ctx.pass("ask_user — suggestion chips rendered", `${shape.chips} chip(s) across ${shape.groups} group(s)`);
	} else {
		ctx.fail("ask_user — suggestion chips rendered", `No chips rendered (prompts=${shape.prompts})`, shot1);
	}
	if (shape.inputs > 0) {
		ctx.pass("ask_user — free-text input rendered", `${shape.inputs} input(s) present`);
	} else {
		ctx.fail("ask_user — free-text input rendered", "No free-text input rendered", shot1);
	}

	// Answer everything: pick "Green" for the color, type a note for the rest.
	const answered = await answerAllPrompts(page, "All good, thanks!");
	if (answered > 0) {
		ctx.pass("ask_user — questions answered", `Answered ${answered} prompt(s) (chip + free-text)`);
	} else {
		ctx.fail("ask_user — questions answered", "Could not answer any interaction prompt");
	}

	// The response loop should now resume and complete.
	const completed = await waitForResponse(page, 45_000);
	const shot2 = await ctx.screenshot("02-after-answers");

	if (!completed) {
		ctx.fail("ask_user — response completes after answers", "Response did not complete within 45s after answering", shot2);
		return;
	}
	ctx.pass("ask_user — response completes after answers", "Response loop resumed and finished after answers");

	// The model's reply should reference the chosen color → answers flowed back.
	const reply = await getLastAssistantMessage(page);
	if (reply.toLowerCase().includes("green")) {
		ctx.pass("ask_user — answer flows back to model", `Reply references chosen answer: "${reply.trim().substring(0, 120)}"`, shot2);
	} else if (reply.trim().length > 0) {
		// Soft signal: the model replied but didn't echo the color. Still better
		// than a blank result, but not the full proof we want — fail so it's visible.
		ctx.fail(
			"ask_user — answer flows back to model",
			`Model replied but did not reference "green": "${reply.trim().substring(0, 160)}"`,
			shot2,
		);
	} else {
		ctx.fail("ask_user — answer flows back to model", "No assistant reply after answering questions", shot2);
	}

	// A persistent interaction block should be rendered (ask_user emits it).
	const block = await waitForSelector(page, ".notor-interaction-block", 5_000);
	if (block) {
		ctx.pass("ask_user — interaction block persisted", "Read-only .notor-interaction-block present in thread", shot2);
	} else {
		ctx.fail("ask_user — interaction block persisted", "No .notor-interaction-block rendered after the Q&A", shot2);
	}
}

async function testNoInteractionErrors(ctx: TestContext): Promise<void> {
	console.log("\n── No interaction render errors ───────────────────────────────");
	const errors = ctx.collector.getLogsByLevel("error").filter((e) => {
		const msg = e.message?.toLowerCase() ?? "";
		return e.source === "ChatView" || msg.includes("interaction") || msg.includes("ask_user");
	});
	if (errors.length === 0) {
		ctx.pass("No interaction render errors", "Zero relevant error-level logs");
	} else {
		ctx.fail("No interaction render errors", `${errors.length}: ${errors.map((e) => `[${e.source}] ${e.message}`).join("; ")}`);
	}
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function allTests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chatContainer) {
		const shot = await ctx.screenshot("00-no-chat-panel");
		ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
		throw new Error("Chat panel not visible — cannot run ask_user LLM test");
	}
	ctx.pass("Chat panel ready", "Plugin loaded and chat container found");

	await testAskUserRoundTrip(ctx);
	await testNoInteractionErrors(ctx);
}

runTest(
	{
		name: "ask-user-llm-test",
		settings: buildDefaultSettings(),
	},
	allTests,
);
