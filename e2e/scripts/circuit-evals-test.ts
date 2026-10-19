#!/usr/bin/env npx tsx
/**
 * Circuit evaluation E2E Test
 *
 * Runs a one-step circuit against a scripted mock OpenAI-compatible server,
 * then exercises the evaluation framework end to end: the opt-in automatic
 * pass (`notor-eval-auto: complete`) with one LLM judge (scoring through the
 * `submit_score` tool) and one code evaluator, the per-session report note, and
 * the manual "Evaluate circuit sessions" command re-scoring the same session as
 * a second comparable pass.
 *
 * Scenarios:
 *   1. runCircuit completes; the session log ends with exactly one run.result.
 *   2. The automatic pass writes evals.jsonl: pass_start (trigger auto), a scored
 *      LLM judge (via submit_score, with the mock model id), a scored code
 *      evaluator, pass_complete.
 *   3. A report note with flat notor-score-* frontmatter lands under evals/.
 *   4. The manual command: circuit picker → session checklist (session marked
 *      "evaluated") → Select all → Evaluate → a second pass with a new pass id
 *      and the same evaluator fingerprint.
 *   5. No unexpected plugin errors.
 *
 * @see docs/circuits.md — Evaluating runs
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants + fixtures
// ---------------------------------------------------------------------------

const MOCK_PORT = 18_742;
const MOCK_MODEL = "mock-eval-model";
const FINAL_TEXT = "MOCK-DONE";

const OUT_DIR = "eval-e2e-out";
const OUT_NOTE = `${OUT_DIR}/result.md`;
const CIRCUIT_NAME = "Eval E2E";
const CIRCUIT_DIR = "notor/circuits/eval-e2e";
// Runtime data (sessions/, evals/) lives under the install's STICKY data root —
// `circuits` on a fresh vault, the legacy `orchestrations` when that folder
// already exists (the shared e2e vault has one). Resolved from the plugin in Test 1.
let sessionsDir = "notor/circuits/sessions";
let evalsDir = "notor/circuits/evals";
const JUDGE_NAME = "Mock judge";
const SHAPE_NAME = "Shape check";

const DEFINITION_MD = `---
notor-type: circuit
notor-circuit-name: "${CIRCUIT_NAME}"
notor-circuit-description: "One-step circuit for the evaluation e2e test."
notor-starting-event: flow.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 5
notor-max-runtime-minutes: 5
notor-steps:
  - "[[only-step]]"
notor-evaluators:
  - "[[judge]]"
  - "[[shape]]"
notor-eval-auto: complete
notor-eval-max-cost-usd: 1
---
`;

const STEP_MD = `---
notor-type: circuit-step
notor-step-name: "Only step"
notor-step-triggers:
  - flow.start
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

Do what the objective says, then finish.
`;

const JUDGE_MD = `---
notor-type: circuit-evaluator
notor-eval-name: "${JUDGE_NAME}"
notor-eval-description: "LLM judge for the e2e test."
notor-eval-mode: conversation
notor-eval-rubric: "[[_rubric]]"
notor-eval-dimensions:
  - quality
  - { name: wrote_note, type: boolean }
---

Judge the run against the rubric.
`;

const RUBRIC_MD = `# Rubric

- quality: 1 (poor) to 5 (excellent).
- wrote_note: true when the run wrote the requested note.
`;

const SHAPE_MD = `---
notor-type: circuit-evaluator
notor-eval-name: "${SHAPE_NAME}"
notor-eval-mode: code
notor-eval-dimensions:
  - { name: completed, type: boolean }
  - { name: wrote_note, type: boolean }
---

\`\`\`ts
return {
  scores: {
    completed: input.outcome.status === "completed",
    wrote_note: input.notesEdited.length > 0,
  },
  rationale: "edited=" + input.notesEdited.join(","),
};
\`\`\`
`;

// ---------------------------------------------------------------------------
// Scripted mock server
//
// The latest user message drives the reply:
//   a judge prompt ("### DIMENSIONS") → a submit_score tool call,
//   "#write:<path>" → a write_note tool call, else text.
// Any request whose last message is a tool result gets the final text.
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/** User-message text of every completion request, in order. */
const userPrompts: string[] = [];

type OpenAiMessage = { role: string; content?: string | Array<{ type: string; text?: string }> | null };

function messageText(m: OpenAiMessage | undefined): string {
	if (!m?.content) return "";
	if (typeof m.content === "string") return m.content;
	return m.content.map((p) => p.text ?? "").join("\n");
}

function sse(res: http.ServerResponse, payload: unknown): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function finish(res: http.ServerResponse, reason: "stop" | "tool_calls"): void {
	sse(res, { choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
	res.write("data: [DONE]\n\n");
	res.end();
}

function toolCall(res: http.ServerResponse, id: string, name: string, args: Record<string, unknown>): void {
	sse(res, {
		choices: [{
			index: 0,
			delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
		}],
	});
	finish(res, "tool_calls");
}

function startMockServer(): http.Server {
	let callSeq = 0;
	const srv = http.createServer((req, res) => {
		if (req.method === "OPTIONS") {
			res.writeHead(204, CORS_HEADERS);
			res.end();
			return;
		}
		if (req.url?.endsWith("/models")) {
			res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: MOCK_MODEL, object: "model" }] }));
			return;
		}
		if (!req.url?.endsWith("/chat/completions")) {
			res.writeHead(404, CORS_HEADERS);
			res.end();
			return;
		}

		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const parsed = JSON.parse(body) as { messages: OpenAiMessage[] };
			const messages = parsed.messages ?? [];
			const last = messages[messages.length - 1];
			const lastUser = [...messages].reverse().find((m) => m.role === "user");
			const prompt = messageText(lastUser);
			userPrompts.push(prompt);

			res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });

			if (last?.role === "tool") {
				sse(res, { choices: [{ index: 0, delta: { content: `${FINAL_TEXT} after tool` } }] });
				finish(res, "stop");
				return;
			}

			// A judge prompt: score through submit_score (checked before #write:,
			// because the judge prompt quotes the circuit objective).
			if (prompt.includes("### DIMENSIONS")) {
				toolCall(res, `call_${++callSeq}`, "submit_score", {
					scores: { quality: 4, wrote_note: true },
					rationale: "mock judge: the note was written",
				});
				return;
			}

			const write = /#write:(\S+)/.exec(prompt);
			if (write) {
				toolCall(res, `call_${++callSeq}`, "write_note", { path: write[1], content: "written by the mock model" });
				return;
			}

			setTimeout(() => {
				sse(res, { choices: [{ index: 0, delta: { content: FINAL_TEXT } }] });
				finish(res, "stop");
			}, 100);
		});
	});
	srv.listen(MOCK_PORT, "127.0.0.1");
	return srv;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Run an async API expression in the page; `api` is in scope. Returns JSON-safe data. */
async function callApi<T>(page: Page, expr: string): Promise<T> {
	return page.evaluate(`(async () => {
		const api = window.app.plugins.plugins["notor"].api;
		try {
			const value = await (${expr});
			return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
		} catch (e) {
			return { ok: false, code: e && e.code, message: String(e && e.message || e) };
		}
	})()`) as Promise<T>;
}

type Outcome<V> = { ok: true; value: V } | { ok: false; code?: string; message: string };

type EvalEntry = Record<string, unknown> & { type: string; pass_id?: string };

function readJsonl(ctx: TestContext, rel: string): EvalEntry[] {
	const file = path.join(ctx.vaultPath, rel);
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.flatMap((l) => {
			try {
				return [JSON.parse(l) as EvalEntry];
			} catch {
				return [];
			}
		});
}

/** Poll the session's evals.jsonl until it holds `passes` completed passes. */
async function waitForPasses(ctx: TestContext, sessionId: string, passes: number, timeoutMs = 60_000): Promise<EvalEntry[]> {
	const rel = `${sessionsDir}/${sessionId}/evals.jsonl`;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const entries = readJsonl(ctx, rel);
		if (entries.filter((e) => e.type === "eval.pass_complete").length >= passes) return entries;
		await ctx.page.waitForTimeout(500);
	}
	return readJsonl(ctx, rel);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let sessionId = "";
let autoPassId = "";
let fingerprint = "";

async function testRunCircuit(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: runCircuit completes and persists run.result");
	const run = await callApi<Outcome<Record<string, unknown>>>(
		ctx.page,
		`api.runCircuit(${JSON.stringify(CIRCUIT_NAME)}, { prompt: "#write:${OUT_NOTE}" })`,
	);
	if (!run.ok || run.value.status !== "completed" || typeof run.value.sessionId !== "string") {
		ctx.fail("Circuit completed", JSON.stringify(run));
		return;
	}
	sessionId = run.value.sessionId;
	ctx.pass("Circuit completed", `session ${sessionId}`);

	const root = await ctx.page.evaluate(`(() => {
		const plugin = window.app.plugins.plugins["notor"];
		return plugin.getCircuitDataRootName ? plugin.getCircuitDataRootName() : "orchestrations";
	})()`) as string;
	sessionsDir = `notor/${root}/sessions`;
	evalsDir = `notor/${root}/evals`;
	console.log(`  (data root: ${root})`);

	const noteExists = fs.existsSync(path.join(ctx.vaultPath, OUT_NOTE));
	if (noteExists) ctx.pass("Step wrote the note", OUT_NOTE);
	else ctx.fail("Step wrote the note", `${OUT_NOTE} missing`);

	const log = readJsonl(ctx, `${sessionsDir}/${sessionId}/session-log.jsonl`);
	const results = log.filter((e) => e.type === "run.result");
	if (results.length === 1 && results[0]!.status === "completed" && results[0]!.terminal_topic === "FLOW_COMPLETE") {
		ctx.pass("session-log has one run.result", JSON.stringify({ text: results[0]!.text, cost_usd: results[0]!.cost_usd }));
	} else {
		ctx.fail("session-log has one run.result", JSON.stringify(results));
	}
}

async function testAutoEvaluation(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: notor-eval-auto scores the finished run");
	if (!sessionId) {
		ctx.fail("Automatic pass", "no session from Test 1");
		return;
	}
	const entries = await waitForPasses(ctx, sessionId, 1);
	const types = entries.map((e) => e.type);
	const start = entries.find((e) => e.type === "eval.pass_start");
	if (!start) {
		ctx.fail("Automatic pass recorded", `evals.jsonl: ${JSON.stringify(types)}`);
		return;
	}
	autoPassId = String(start.pass_id);
	fingerprint = String(start.evaluator_fingerprint);
	if (start.trigger === "auto" && JSON.stringify(start.evaluators) === JSON.stringify([JUDGE_NAME, SHAPE_NAME]) && start.max_cost_usd === 1) {
		ctx.pass("eval.pass_start", `pass ${autoPassId}, trigger auto, fingerprint ${fingerprint}`);
	} else {
		ctx.fail("eval.pass_start", JSON.stringify(start));
	}

	const judge = entries.find((e) => e.type === "eval.scored" && e.evaluator === JUDGE_NAME);
	const judgeScores = judge?.scores as Record<string, unknown> | undefined;
	if (judge && judge.model_id === MOCK_MODEL && judgeScores?.quality === 4 && judgeScores?.wrote_note === true) {
		ctx.pass("LLM judge scored via submit_score", JSON.stringify({ scores: judgeScores, rationale: judge.rationale }));
	} else {
		const failed = entries.find((e) => e.type === "eval.failed" && e.evaluator === JUDGE_NAME);
		ctx.fail("LLM judge scored via submit_score", JSON.stringify(judge ?? failed ?? types));
	}

	const judgePrompt = userPrompts.find((p) => p.includes("### DIMENSIONS"));
	if (judgePrompt && judgePrompt.includes("### RUBRIC") && judgePrompt.includes(OUT_NOTE)) {
		ctx.pass("Judge prompt carries rubric + edited note", "RUBRIC section and note path present");
	} else {
		ctx.fail("Judge prompt carries rubric + edited note", (judgePrompt ?? "(no judge prompt)").slice(0, 300));
	}

	const shape = entries.find((e) => e.type === "eval.scored" && e.evaluator === SHAPE_NAME);
	const shapeScores = shape?.scores as Record<string, unknown> | undefined;
	if (shape && shapeScores?.completed === true && shapeScores?.wrote_note === true && shape.cost_usd === 0) {
		ctx.pass("Code evaluator scored", JSON.stringify({ scores: shapeScores, rationale: shape.rationale }));
	} else {
		const failed = entries.find((e) => e.type === "eval.failed" && e.evaluator === SHAPE_NAME);
		ctx.fail("Code evaluator scored", JSON.stringify(shape ?? failed ?? types));
	}

	const complete = entries.find((e) => e.type === "eval.pass_complete");
	if (complete && complete.scored === 2 && complete.failed === 0) ctx.pass("eval.pass_complete", "2 scored, 0 failed");
	else ctx.fail("eval.pass_complete", JSON.stringify(complete ?? types));
}

async function testReportNote(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: report note with flat score frontmatter");
	if (!autoPassId) {
		ctx.fail("Report note", "no automatic pass");
		return;
	}
	const rel = `${evalsDir}/eval-e2e-${sessionId}-${autoPassId}.md`;
	const file = path.join(ctx.vaultPath, rel);
	const deadline = Date.now() + 15_000;
	while (!fs.existsSync(file) && Date.now() < deadline) await ctx.page.waitForTimeout(250);
	if (!fs.existsSync(file)) {
		ctx.fail("Report note written", `${rel} missing`);
		return;
	}
	const md = fs.readFileSync(file, "utf8");
	const expected = [
		"notor-type: circuit-eval-report",
		`notor-circuit: "${CIRCUIT_NAME}"`,
		`notor-session-id: "${sessionId}"`,
		`notor-eval-pass-id: "${autoPassId}"`,
		'notor-eval-trigger: "auto"',
		'notor-run-status: "completed"',
		"notor-score-mock-judge-quality: 4",
		"notor-score-mock-judge-wrote-note: true",
		"notor-score-shape-check-completed: true",
		"notor-score-shape-check-wrote-note: true",
		`notor-eval-models: ["${MOCK_MODEL}"]`,
	];
	const missing = expected.filter((line) => !md.includes(line));
	if (missing.length === 0) ctx.pass("Report note written", rel);
	else ctx.fail("Report note written", `missing: ${JSON.stringify(missing)}`);
	if (md.includes("## Scores") && md.includes(`| ${JUDGE_NAME} | quality | 4 |`)) ctx.pass("Report body has the scores table", "found judge row");
	else ctx.fail("Report body has the scores table", md.slice(0, 400));
}

async function testManualCommand(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Evaluate circuit sessions command re-scores the session");
	const { page } = ctx;
	if (!sessionId) {
		ctx.fail("Manual pass", "no session from Test 1");
		return;
	}

	await page.evaluate(() => {
		(window as any).app?.commands?.executeCommandById?.("notor:evaluate-circuit-sessions");
	});
	await page.waitForTimeout(1_000);
	const picker = await page.$(".prompt-input");
	if (!picker) {
		ctx.fail("Circuit picker opened", "no fuzzy picker after notor:evaluate-circuit-sessions");
		return;
	}
	await page.evaluate((name: string) => {
		const input = document.querySelector(".prompt-input") as HTMLInputElement | null;
		if (input) {
			input.value = name;
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
	}, CIRCUIT_NAME);
	await page.waitForTimeout(500);
	await page.keyboard.press("Enter");

	await page.waitForSelector(".modal-content.notor-circuit-eval-modal", { timeout: 15_000 }).catch(() => undefined);
	const shot = await ctx.screenshot("eval-session-checklist");
	const state = await page.evaluate(`(() => {
		const modal = document.querySelector(".modal-content.notor-circuit-eval-modal");
		if (!modal) return { modal: false };
		const rows = Array.from(modal.querySelectorAll(".notor-circuit-eval-session"));
		const badges = rows.map((r) => Array.from(r.querySelectorAll(".notor-circuit-eval-badge")).map((b) => b.textContent));
		const checked = rows.filter((r) => r.classList.contains("notor-circuit-eval-session--checked")).length;
		const evaluate = Array.from(modal.querySelectorAll("button")).find((b) => b.textContent === "Evaluate");
		return { modal: true, rows: rows.length, badges, checked, evaluateDisabled: evaluate ? evaluate.disabled : null,
			ids: rows.map((r) => r.getAttribute("data-session-id")) };
	})()`) as { modal: boolean; rows?: number; badges?: string[][]; checked?: number; evaluateDisabled?: boolean | null; ids?: string[] };
	if (!state.modal) {
		ctx.fail("Session checklist opened", "modal not found", shot);
		return;
	}
	if (state.rows === 1 && state.ids?.[0] === sessionId && state.badges?.[0]?.includes("evaluated")) {
		ctx.pass("Checklist lists the evaluated session", JSON.stringify(state), shot);
	} else {
		ctx.fail("Checklist lists the evaluated session", JSON.stringify(state), shot);
	}
	if (state.checked === 0 && state.evaluateDisabled === true) ctx.pass("Already-evaluated session starts unselected", "Evaluate disabled");
	else ctx.fail("Already-evaluated session starts unselected", JSON.stringify(state));

	const clicked = await page.evaluate(`(() => {
		const modal = document.querySelector(".modal-content.notor-circuit-eval-modal");
		const buttons = Array.from(modal.querySelectorAll("button"));
		const selectAll = buttons.find((b) => b.textContent === "Select all");
		if (!selectAll) return "no select-all";
		selectAll.click();
		const evaluate = buttons.find((b) => b.textContent === "Evaluate");
		if (!evaluate || evaluate.disabled) return "evaluate disabled after select-all";
		evaluate.click();
		return "ok";
	})()`);
	if (clicked !== "ok") {
		ctx.fail("Select all + Evaluate", String(clicked));
		return;
	}

	const entries = await waitForPasses(ctx, sessionId, 2);
	const starts = entries.filter((e) => e.type === "eval.pass_start");
	const manual = starts.find((e) => e.trigger === "manual");
	const completes = entries.filter((e) => e.type === "eval.pass_complete");
	if (manual && manual.pass_id !== autoPassId && manual.evaluator_fingerprint === fingerprint && completes.length === 2) {
		ctx.pass("Manual pass recorded as a second comparable pass", `pass ${String(manual.pass_id)} (same fingerprint)`);
	} else {
		ctx.fail("Manual pass recorded as a second comparable pass", JSON.stringify({ starts, completes: completes.length }));
	}
	const manualScored = entries.filter((e) => e.type === "eval.scored" && e.pass_id === manual?.pass_id);
	if (manualScored.length === 2) ctx.pass("Manual pass scored both evaluators", manualScored.map((e) => e.evaluator).join(", "));
	else ctx.fail("Manual pass scored both evaluators", JSON.stringify(entries.filter((e) => e.pass_id === manual?.pass_id)));

	const reports = fs.existsSync(path.join(ctx.vaultPath, evalsDir))
		? fs.readdirSync(path.join(ctx.vaultPath, evalsDir)).filter((f) => f.startsWith(`eval-e2e-${sessionId}-`))
		: [];
	if (reports.length === 2) ctx.pass("Two report notes (one per pass)", reports.join(", "));
	else ctx.fail("Two report notes (one per pass)", JSON.stringify(reports));
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: No unexpected plugin errors");
	const errors = ctx.collector.getLogsByLevel("error");
	if (errors.length === 0) ctx.pass("No unexpected errors", "clean error log");
	else ctx.fail("No unexpected errors", JSON.stringify(errors.slice(0, 3)).slice(0, 600));
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const srv = startMockServer();
	try {
		await ctx.page.waitForTimeout(5_000);
		await testRunCircuit(ctx);
		await testAutoEvaluation(ctx);
		await testReportNote(ctx);
		await testManualCommand(ctx);
		await testNoUnexpectedErrors(ctx);
	} finally {
		srv.close();
	}
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	active_provider: "local",
	providers: [
		{ id: "local", type: "local", enabled: true, display_name: "Mock local", endpoint: `http://127.0.0.1:${MOCK_PORT}/v1`, model_id: MOCK_MODEL },
	],
	model_presets: [
		{ name: "tiny", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
		{ name: "small", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
		{ name: "medium", provider_id: "local", model_id: MOCK_MODEL, use_extended_context: false, thinking_level: null },
		{ name: "large", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
	],
	default_preset: "medium",
	model_context_overrides: { [MOCK_MODEL]: 128_000 },
	mode: "act",
	circuits_enabled: true,
	circuits_write_eval_reports: true,
	// The step's write is auto-approved so the headless run never prompts.
	auto_approve: { write_note: true, read_note: true },
});

runTest(
	{
		name: "circuit-evals",
		settings,
		setupVault: (vaultPath) => {
			const circuitDir = path.join(vaultPath, CIRCUIT_DIR);
			fs.mkdirSync(path.join(circuitDir, "steps"), { recursive: true });
			fs.mkdirSync(path.join(circuitDir, "evals"), { recursive: true });
			fs.writeFileSync(path.join(circuitDir, "definition.md"), DEFINITION_MD);
			fs.writeFileSync(path.join(circuitDir, "steps", "only-step.md"), STEP_MD);
			fs.writeFileSync(path.join(circuitDir, "evals", "judge.md"), JUDGE_MD);
			fs.writeFileSync(path.join(circuitDir, "evals", "_rubric.md"), RUBRIC_MD);
			fs.writeFileSync(path.join(circuitDir, "evals", "shape.md"), SHAPE_MD);
		},
		// Sessions are left in place like every other circuit e2e; the report notes are removed from both roots.
		cleanupFiles: [OUT_DIR, CIRCUIT_DIR, "notor/circuits/evals", "notor/orchestrations/evals"],
	},
	tests,
);
