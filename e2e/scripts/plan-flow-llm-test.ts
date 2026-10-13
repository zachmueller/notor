#!/usr/bin/env npx tsx
/**
 * Plan Document Flow — LLM-Driven E2E Test
 *
 * The live-model half of the plan flow (see plan-flow-test.ts for the
 * deterministic UI coverage): in Plan mode the model researches, calls
 * `submit_plan` on its own, the user approves with auto-accepted edits, and
 * the model executes the plan in Act mode without any approval prompt.
 *
 * Scenarios:
 *   1. Chat panel ready
 *   2. In Plan mode the model calls submit_plan → review card + plan leaf
 *      (no generic Approve/Reject gate for submit_plan itself)
 *   3. Plan-mode system prompt instructs the model to submit a plan
 *   4. "Approve & auto-accept edits" → mode toggle shows Act and the next
 *      assembled system prompt says "Current mode: Act"
 *   5. The write tool runs without an approval prompt and creates the note
 *   6. The auto-accept badge clears when the response finishes
 *   7. No unexpected errors logged
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access on that account (model from buildDefaultSettings)
 *
 * Run with:
 *   npx tsx e2e/scripts/plan-flow-llm-test.ts
 *
 * @see e2e/scripts/plan-flow-test.ts, e2e/scripts/ask-user-llm-test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, sendMessageNoWait, setMode, VAULT_PATH, waitForResponse, waitForResponseOrPlanReview, waitForSelector } from "../lib/test-helpers";
import type { LogEntry } from "../lib/log-collector";

// ---------------------------------------------------------------------------
// Local constants & helpers
// ---------------------------------------------------------------------------

const NOTE = "Plan-Flow-LLM-Test.md";
const NOTE_LINE = "planned and done";

function systemPrompts(logs: LogEntry[]): string[] {
	return logs
		.filter((e) => e.source === "ChatOrchestrator" && e.message === "System prompt assembled")
		.map((e) => (e.data as { systemPrompt?: string } | undefined)?.systemPrompt ?? "");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testPlanRoundTrip(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\nTest 2: Model submits a plan in Plan mode");
	await setMode(page, "Plan");
	await sendMessageNoWait(
		page,
		`Create a new note at the vault root named "${NOTE}" whose entire content is the single line "${NOTE_LINE}". ` +
		"This changes the vault, so plan it first.",
	);

	const first = await waitForResponseOrPlanReview(page, 120_000);
	if (first !== "plan") {
		const shot = await ctx.screenshot("02-no-review-card");
		ctx.fail("Model calls submit_plan and the review card renders", `state=${first}`, shot);
		return;
	}
	const leaf = await waitForSelector(page, '.workspace-leaf-content[data-type="notor-plan-view"] .notor-plan-body', 5_000);
	const shot = await ctx.screenshot("02-review-card");
	ctx.pass("Model calls submit_plan and the review card renders", leaf ? "plan leaf opened" : "card only", shot);
	if (leaf) ctx.pass("Plan leaf opened automatically", "found .notor-plan-body");
	else ctx.fail("Plan leaf opened automatically", "no plan leaf");

	console.log("\nTest 3: Plan-mode prompt carries submit_plan instructions");
	const planPrompt = systemPrompts(ctx.collector.getStructuredLogs()).find((p) => p.includes("Current mode: Plan"));
	if (planPrompt?.includes("call `submit_plan` with a short title")) {
		ctx.pass("Plan-mode prompt instructs submit_plan", "found instruction");
	} else {
		ctx.fail("Plan-mode prompt instructs submit_plan", planPrompt ? "instruction missing" : "no Plan-mode prompt logged");
	}

	console.log("\nTest 4: Approve & auto-accept edits");
	const promptsBefore = systemPrompts(ctx.collector.getStructuredLogs()).length;
	await page.evaluate(async () => {
		await (window as any).app.plugins.plugins["notor"].openChatPanel();
		(document.querySelector(".notor-plan-review-approve-auto") as HTMLButtonElement).click();
	});
	await page.waitForTimeout(1_500);
	const toggle = await page.evaluate(() => document.querySelector(".notor-mode-toggle")?.textContent);
	if (toggle === "Act") ctx.pass("Mode toggle switched to Act", toggle);
	else ctx.fail("Mode toggle switched to Act", String(toggle));

	// Watch for any approval gate while the model executes.
	let sawApprovalGate = false;
	let sawBadge = false;
	const start = Date.now();
	while (Date.now() - start < 120_000) {
		const s = await page.evaluate(() => ({
			gate: !!document.querySelector(".notor-approve-btn"),
			badge: !document.querySelector(".notor-auto-accept-badge")?.classList.contains("notor-hidden"),
			idle: !document.querySelector(".notor-send-btn")?.classList.contains("notor-hidden")
				&& !!document.querySelector(".notor-stop-btn")?.classList.contains("notor-hidden"),
		}));
		if (s.badge) sawBadge = true;
		if (s.gate) {
			sawApprovalGate = true;
			await page.evaluate(() => (document.querySelector(".notor-approve-btn") as HTMLButtonElement).click());
		}
		if (s.idle) break;
		await page.waitForTimeout(500);
	}
	await waitForResponse(page, 30_000);

	const later = systemPrompts(ctx.collector.getStructuredLogs()).slice(promptsBefore);
	if (later.some((p) => p.includes("## Current mode: Act (full access)"))) {
		ctx.pass("Next system prompt is assembled in Act mode", `${later.length} prompt(s) after approval`);
	} else {
		ctx.fail("Next system prompt is assembled in Act mode", `${later.length} prompt(s) after approval, none in Act mode`);
	}
	if (sawBadge) ctx.pass("Auto-accept badge shown during execution", "badge visible");
	else ctx.fail("Auto-accept badge shown during execution", "badge never visible");

	console.log("\nTest 5: Write ran without an approval prompt");
	const notePath = path.join(VAULT_PATH, NOTE);
	const content = fs.existsSync(notePath) ? fs.readFileSync(notePath, "utf8") : null;
	const shot5 = await ctx.screenshot("05-after-execution");
	if (!sawApprovalGate) ctx.pass("No approval prompt for the write", "auto-accepted", shot5);
	else ctx.fail("No approval prompt for the write", "an Approve/Reject gate appeared", shot5);
	if (content?.includes(NOTE_LINE)) ctx.pass("Planned note was created", JSON.stringify(content.trim()));
	else ctx.fail("Planned note was created", content === null ? "note missing" : JSON.stringify(content));

	console.log("\nTest 6: Badge clears when the response finishes");
	const badge = await page.evaluate(() => !document.querySelector(".notor-auto-accept-badge")?.classList.contains("notor-hidden"));
	if (!badge) ctx.pass("Auto-accept badge cleared", "hidden after run");
	else ctx.fail("Auto-accept badge cleared", "still visible");
}

async function testNoErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: No unexpected errors");
	const errors = ctx.collector.getLogsByLevel("error");
	if (errors.length === 0) ctx.pass("No errors logged", "0 error-level logs");
	else ctx.fail("No errors logged", errors.map((e) => JSON.stringify(e)).join("\n").slice(0, 1_000));
}

async function allTests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(5_000);
	const chat = await waitForSelector(ctx.page, ".notor-chat-container", 10_000);
	if (!chat) {
		ctx.fail("Chat panel ready", ".notor-chat-container not found");
		return;
	}
	ctx.pass("Chat panel ready", "found .notor-chat-container");
	await testPlanRoundTrip(ctx);
	await testNoErrors(ctx);
}

runTest(
	{
		name: "plan-flow-llm-test",
		settings: buildDefaultSettings(),
		cleanupFiles: [NOTE],
	},
	allTests,
);
