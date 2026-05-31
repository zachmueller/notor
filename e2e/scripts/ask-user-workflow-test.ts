#!/usr/bin/env npx tsx
/**
 * Ask User — Inside a Foreground Workflow E2E Test
 *
 * Reproduces and guards the reported regression: the `ask_user` tool works in a
 * normal chat conversation, but when the model calls it from inside a
 * MANUALLY-RUN workflow conversation it fails with
 *   "ask_user requires an interactive chat panel; no interaction channel was
 *    available in this context (e.g. a background or sub-agent run)."
 *
 * Root cause: a foreground manual workflow runs through the real (UI-bound)
 * response loop, but `WorkflowExecutor.executeWorkflow` builds its
 * ConversationSession without an `interactionCallback` — unlike
 * `ChatOrchestrator.handleUserMessage`, which snapshots the panel's interaction
 * callback. So `utils.ask` has no channel and ask_user throws.
 *
 * This test drives a live model (AWS Bedrock) through a manual workflow whose
 * body instructs it to call ask_user, then asserts:
 *   1. The inline interaction prompt (options + input) renders — NOT the
 *      no-channel error, and NOT a generic Approve/Reject gate.
 *   2. The chosen answer round-trips back into the model's reply.
 *   3. No "no interaction channel" error appears in the structured logs.
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access on that account (model from buildDefaultSettings)
 *
 * Run with:
 *   npx tsx e2e/scripts/ask-user-workflow-test.ts
 *
 * @see src/chat/workflow-executor.ts — executeWorkflow session creation
 * @see src/chat/orchestrator.ts — handleUserMessage (the working reference path)
 * @see e2e/scripts/ask-user-llm-test.ts — the non-workflow round-trip this mirrors
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	waitForResponse,
	getLastAssistantMessage,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const WORKFLOW_REL_PATH = "notor/workflows/ask-user-workflow.md";
const WORKFLOW_FILE_NAME = "ask-user-workflow.md";

/** The error string ask_user throws when no interaction channel is wired. */
const NO_CHANNEL_ERROR = "no interaction channel was available";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Programmatically run the manual workflow via the orchestrator. This mirrors
 * exactly what selecting the workflow in the picker does — it goes through
 * `ChatOrchestrator.executeWorkflow` → `WorkflowExecutor.executeWorkflow`,
 * the path that omits the interaction callback. Fire-and-forget: the response
 * loop suspends on ask_user, so we must NOT await it here.
 */
async function runAskUserWorkflow(page: Page): Promise<{ ok: boolean; error?: string }> {
	return page.evaluate(
		({ filePath, fileName }) => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			if (!plugin) return { ok: false, error: "Plugin not found" };
			const orchestrator = plugin.getActiveOrchestrator?.();
			if (!orchestrator?.executeWorkflow) return { ok: false, error: "No orchestrator.executeWorkflow" };

			// Kick off the workflow without awaiting — it suspends on ask_user.
			orchestrator
				.executeWorkflow({
					file_path: filePath,
					file_name: fileName,
					display_name: "ask-user-workflow",
					aliases: [],
					trigger: "manual",
					schedule: null,
					persona_name: null,
					mode: "act",
					model_preset: null,
					thinking_level: null,
					hook_delay: null,
					hooks: null,
					active_note_prompt: null,
					body_content: "",
				})
				.catch((e: any) => {
					(window as any).__askWorkflowError = e?.message ?? String(e);
				});
			return { ok: true };
		},
		{ filePath: WORKFLOW_REL_PATH, fileName: WORKFLOW_FILE_NAME },
	);
}

/** Poll until an inline interaction prompt (or an approval prompt) appears. */
async function waitForInteractionUI(page: Page, timeoutMs = 60_000): Promise<boolean> {
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
 * Answer every question in the single grouped prompt, then click Submit.
 * All questions render together as `.notor-interaction-question-group`s. For each
 * group: select the "Green" option when present (deterministic assertion target),
 * else the first option; for option-less groups, type a free-text reply. Once
 * every question is answered the Submit button enables — click it to send.
 * Returns the number of question-groups answered.
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
			const options = Array.from(
				group.querySelectorAll<HTMLButtonElement>(".notor-interaction-option"),
			);
			if (options.length > 0) {
				const green = options.find((o) => (o.textContent ?? "").trim().toLowerCase() === "green");
				(green ?? options[0])!.click();
				answered += 1;
				continue;
			}
			const input = group.querySelector<HTMLInputElement>(".notor-interaction-input");
			if (input) {
				input.value = text;
				input.dispatchEvent(new Event("input", { bubbles: true }));
				answered += 1;
			}
		}
		// Every question answered → Submit is enabled → click it to send.
		const submit = prompt.querySelector<HTMLButtonElement>(".notor-interaction-submit");
		if (submit && !submit.disabled) submit.click();
		return answered;
	}, freeText);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testAskUserInsideWorkflow(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── ask_user inside a foreground workflow ──────────────────────");

	const kicked = await runAskUserWorkflow(page);
	if (!kicked.ok) {
		ctx.fail("Workflow ask_user — launch", kicked.error ?? "unknown");
		return;
	}
	console.log("    → Launched ask-user-workflow via orchestrator.executeWorkflow");

	const uiAppeared = await waitForInteractionUI(page, 75_000);
	const shot1 = await ctx.screenshot("01-workflow-interaction-ui");

	// The reported bug surfaces as a tool error instead of any prompt — check
	// the structured logs for the no-channel error explicitly.
	const noChannelLog = ctx.collector
		.getStructuredLogs()
		.find((e) => (e.message?.includes(NO_CHANNEL_ERROR) ?? false) ||
			(typeof (e.data as any)?.error === "string" && (e.data as any).error.includes(NO_CHANNEL_ERROR)));

	if (noChannelLog) {
		ctx.fail(
			"Workflow ask_user — interaction channel wired",
			`Regression: ask_user threw the no-channel error inside a workflow. log="${noChannelLog.message}" data=${JSON.stringify(noChannelLog.data)}`,
			shot1,
		);
		// Let the loop unwind so teardown is clean.
		await waitForResponse(page, 20_000);
		return;
	}

	if (!uiAppeared) {
		ctx.fail(
			"Workflow ask_user — interaction UI appears",
			"No interaction prompt within 75s (model may not have called ask_user, or it errored silently)",
			shot1,
		);
		await waitForResponse(page, 20_000);
		return;
	}
	ctx.pass(
		"Workflow ask_user — interaction channel wired",
		"Interaction prompt rendered inside a workflow conversation (no no-channel error)",
		shot1,
	);

	// It must NOT be the generic Approve/Reject gate.
	const approveBtn = await page.$(".notor-approve-btn");
	const rejectBtn = await page.$(".notor-reject-btn");
	if (!approveBtn && !rejectBtn) {
		ctx.pass("Workflow ask_user — no Approve/Reject gate", "Generic approval buttons absent (auto-approved)", shot1);
	} else {
		ctx.fail(
			"Workflow ask_user — no Approve/Reject gate",
			`Generic approval buttons present: approve=${!!approveBtn}, reject=${!!rejectBtn}`,
			shot1,
		);
		await (rejectBtn ?? approveBtn)!.click();
		await waitForResponse(page, 20_000);
		return;
	}

	// Verify prompt shape: options and a free-text input across the questions.
	const shape = await page.evaluate(() => ({
		prompts: document.querySelectorAll(".notor-interaction-prompt").length,
		options: document.querySelectorAll(".notor-interaction-option").length,
		inputs: document.querySelectorAll(".notor-interaction-input").length,
	}));
	if (shape.options > 0) {
		ctx.pass("Workflow ask_user — options rendered", `${shape.options} option(s) across ${shape.prompts} prompt(s)`);
	} else {
		ctx.fail("Workflow ask_user — options rendered", `No options rendered (prompts=${shape.prompts})`, shot1);
	}

	// Answer everything (Green for the color, free text for the rest).
	const answered = await answerAllPrompts(page, "All good, thanks!");
	if (answered > 0) {
		ctx.pass("Workflow ask_user — questions answered", `Answered ${answered} prompt(s)`);
	} else {
		ctx.fail("Workflow ask_user — questions answered", "Could not answer any interaction prompt");
	}

	// The response loop should resume and complete.
	const completed = await waitForResponse(page, 60_000);
	const shot2 = await ctx.screenshot("02-workflow-after-answers");
	if (!completed) {
		ctx.fail("Workflow ask_user — response completes", "Response did not complete within 60s after answering", shot2);
		return;
	}
	ctx.pass("Workflow ask_user — response completes", "Workflow response loop resumed and finished after answers");

	// The reply should reference the chosen color → answers flowed back.
	const reply = await getLastAssistantMessage(page);
	if (reply.toLowerCase().includes("green")) {
		ctx.pass("Workflow ask_user — answer flows back", `Reply references chosen answer: "${reply.trim().substring(0, 120)}"`, shot2);
	} else if (reply.trim().length > 0) {
		ctx.fail("Workflow ask_user — answer flows back", `Model replied but did not reference "green": "${reply.trim().substring(0, 160)}"`, shot2);
	} else {
		ctx.fail("Workflow ask_user — answer flows back", "No assistant reply after answering questions", shot2);
	}
}

async function testNoNoChannelErrors(ctx: TestContext): Promise<void> {
	console.log("\n── No 'no interaction channel' errors logged ──────────────────");
	const offending = ctx.collector.getStructuredLogs().filter((e) => {
		const inMsg = e.message?.includes(NO_CHANNEL_ERROR) ?? false;
		const inData = typeof (e.data as any)?.error === "string" && (e.data as any).error.includes(NO_CHANNEL_ERROR);
		return inMsg || inData;
	});
	if (offending.length === 0) {
		ctx.pass("No no-channel errors", "Zero 'no interaction channel' log entries");
	} else {
		ctx.fail(
			"No no-channel errors",
			`${offending.length} log(s) mention the no-channel error: ${offending.map((e) => `[${e.source}] ${e.message}`).join("; ")}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // plugin init + extension/tool/workflow load

	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chatContainer) {
		const shot = await ctx.screenshot("00-no-chat-panel");
		ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
		throw new Error("Chat panel not visible — cannot run ask_user workflow test");
	}
	ctx.pass("Chat panel ready", "Plugin loaded and chat container found");

	await testAskUserInsideWorkflow(ctx);
	await testNoNoChannelErrors(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

runTest(
	{
		name: "ask-user-workflow-test",
		settings: buildDefaultSettings(),
		setupVault: (vaultPath) => {
			const workflowsDir = path.join(vaultPath, "notor", "workflows");
			fs.mkdirSync(workflowsDir, { recursive: true });
			fs.writeFileSync(
				path.join(workflowsDir, WORKFLOW_FILE_NAME),
				`---
notor-workflow: true
notor-trigger: manual
notor-conversation-mode: act
---

You are running the ask-user workflow. Immediately use the ask_user tool to ask
me exactly two follow-up questions in a single call:
(1) my favorite color, offering the suggestions Red, Green, and Blue; and
(2) a free-text note with no suggestions.
Do not guess my answers. After I answer, reply with one sentence repeating the
color I chose.
`,
			);
			console.log("  ask-user-workflow fixture written to test vault.");
		},
		cleanupFiles: [WORKFLOW_REL_PATH],
	},
	tests,
);
