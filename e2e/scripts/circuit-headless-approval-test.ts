#!/usr/bin/env npx tsx
/**
 * Circuit headless approval E2E Test
 *
 * Proves that a circuit's own control-flow tools never wait on the panel-free
 * **Approve tool call** dialog with default settings. Two one-step circuits run
 * against a scripted mock OpenAI-compatible server. No circuit tool is seeded
 * in `auto_approve`, so every call relies on the shipped defaults.
 *
 * Scenarios:
 *   1. The effective config auto-approves emit_event (no saved key, default
 *      from the scaffold's read mode) and circuit_task_ensure (seeded default).
 *   2. Plan mode: a step whose only tool call is emit_event completes with no
 *      approval dialog, and its terminal payload is the one the model emitted.
 *   3. Act mode: a step that ensures and closes a task, then emits, completes
 *      with no approval dialog and leaves a closed task note.
 *   4. Settings → Tools lists "Emit circuit event" while circuits are on.
 *   5. No unexpected plugin errors.
 *
 * A short approval timeout makes a regression fail fast: a prompted
 * emit_event is skipped after the timeout, the engine synthesizes the
 * default-publish topic with an empty payload, and the payload check fails.
 *
 * @see docs/safety.md — Runs with no chat panel
 * @see docs/circuits.md — Running a circuit
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, openPluginSettings, expandSettingsGroup } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants + fixtures
// ---------------------------------------------------------------------------

const MOCK_PORT = 18_744;
const MOCK_MODEL = "mock-headless-approval-model";
const FINAL_TEXT = "MOCK-DONE";
const MARKER = `HEADLESS-OK-${Math.random().toString(36).slice(2, 8)}`;

const PLAN_MARKER = "HEADLESS-PLAN-STEP";
const ACT_MARKER = "HEADLESS-ACT-STEP";
const TASK_KEY = "e2e-task";

const PLAN_CIRCUIT = { name: "Headless Approval Plan", dir: "notor/circuits/headless-approval-plan", step: "headless-plan-step" };
const ACT_CIRCUIT = { name: "Headless Approval Act", dir: "notor/circuits/headless-approval-act", step: "headless-act-step" };

// Resolved from the plugin in Test 1 (sticky data root: circuits or the legacy orchestrations).
let sessionsDir = "notor/circuits/sessions";

function definitionMd(c: typeof PLAN_CIRCUIT): string {
	return `---
notor-type: circuit
notor-circuit-name: "${c.name}"
notor-circuit-description: "One-step circuit for the headless approval e2e test."
notor-starting-event: flow.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 5
notor-max-runtime-minutes: 5
notor-steps:
  - "[[${c.step}]]"
---
`;
}

function stepMd(marker: string): string {
	return `---
notor-type: circuit-step
notor-step-name: "${marker}"
notor-step-triggers:
  - flow.start
notor-step-publishes:
  - FLOW_COMPLETE
notor-step-default-publishes: FLOW_COMPLETE
---

${marker}: do the work, then emit FLOW_COMPLETE with your result.
`;
}

// ---------------------------------------------------------------------------
// Scripted mock server
//
// The step body marker in the request picks the script; the number of tool
// results already in the conversation picks the next move:
//   plan step: emit_event → text
//   act step:  circuit_task_ensure → circuit_task_close → emit_event → text
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

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

function text(res: http.ServerResponse, content: string): void {
	sse(res, { choices: [{ index: 0, delta: { content } }] });
	finish(res, "stop");
}

const EMIT = { topic: "FLOW_COMPLETE", payload: MARKER };

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
			const all = messages.map(messageText).join("\n");
			const toolResults = messages.filter((m) => m.role === "tool").length;
			const id = `call_${++callSeq}`;

			res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });

			if (all.includes(ACT_MARKER)) {
				if (toolResults === 0) return toolCall(res, id, "circuit_task_ensure", { key: TASK_KEY, description: "e2e task" });
				if (toolResults === 1) return toolCall(res, id, "circuit_task_close", { key: TASK_KEY });
				if (toolResults === 2) return toolCall(res, id, "emit_event", EMIT);
				return text(res, FINAL_TEXT);
			}
			if (all.includes(PLAN_MARKER)) {
				if (toolResults === 0) return toolCall(res, id, "emit_event", EMIT);
				return text(res, FINAL_TEXT);
			}
			text(res, FINAL_TEXT);
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

type LogEntry = Record<string, unknown> & { type: string };

function readJsonl(ctx: TestContext, rel: string): LogEntry[] {
	const file = path.join(ctx.vaultPath, rel);
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.flatMap((l) => {
			try {
				return [JSON.parse(l) as LogEntry];
			} catch {
				return [];
			}
		});
}

/**
 * Start an in-page watcher that latches `window.__notorApprovalSeen` when an
 * "Approve tool call" dialog appears. In-page so it keeps polling while the
 * awaited runCircuit evaluate is blocking the test side.
 */
async function startApprovalWatcher(page: Page): Promise<void> {
	await page.evaluate(`(() => {
		window.__notorApprovalSeen = false;
		if (window.__notorApprovalWatcher) clearInterval(window.__notorApprovalWatcher);
		window.__notorApprovalWatcher = setInterval(() => {
			const seen = Array.from(document.querySelectorAll(".modal h2"))
				.some((h) => h.textContent === "Approve tool call");
			if (seen) window.__notorApprovalSeen = true;
		}, 100);
	})()`);
}

async function stopApprovalWatcher(page: Page): Promise<boolean> {
	return page.evaluate(`(() => {
		clearInterval(window.__notorApprovalWatcher);
		window.__notorApprovalWatcher = undefined;
		return window.__notorApprovalSeen === true;
	})()`) as Promise<boolean>;
}

/** Run a circuit with the watcher on; returns the session id, or null after recording a failure. */
async function runWatched(ctx: TestContext, label: string, circuitName: string, mode: "plan" | "act"): Promise<string | null> {
	await startApprovalWatcher(ctx.page);
	const run = await callApi<Outcome<Record<string, unknown>>>(
		ctx.page,
		`api.runCircuit(${JSON.stringify(circuitName)}, { prompt: "go", mode: ${JSON.stringify(mode)} })`,
	);
	const modalSeen = await stopApprovalWatcher(ctx.page);
	const shot = modalSeen ? await ctx.screenshot(`${label}-approval-modal`) : undefined;

	if (!modalSeen) ctx.pass(`${label}: no approval dialog`, "no 'Approve tool call' modal appeared");
	else ctx.fail(`${label}: no approval dialog`, "an 'Approve tool call' modal appeared", shot);

	if (!run.ok || run.value.status !== "completed" || typeof run.value.sessionId !== "string") {
		ctx.fail(`${label}: circuit completed`, JSON.stringify(run));
		return null;
	}
	ctx.pass(`${label}: circuit completed`, `session ${run.value.sessionId}`);
	return run.value.sessionId;
}

/** The emitted terminal payload must be the model's, not a synthesized empty default. */
function checkTerminalPayload(ctx: TestContext, label: string, sessionId: string): void {
	const log = readJsonl(ctx, `${sessionsDir}/${sessionId}/session-log.jsonl`);
	const emitted = log.find((e) => e.type === "event.emitted" && e.topic === "FLOW_COMPLETE");
	if (emitted?.payload === MARKER) ctx.pass(`${label}: emit_event ran`, `FLOW_COMPLETE payload ${MARKER}`);
	else ctx.fail(`${label}: emit_event ran`, `event.emitted: ${JSON.stringify(emitted ?? null)}`);

	const results = log.filter((e) => e.type === "run.result");
	if (results.length === 1 && results[0]!.terminal_topic === "FLOW_COMPLETE" && results[0]!.text === MARKER) {
		ctx.pass(`${label}: run.result carries the emitted payload`, String(results[0]!.text));
	} else {
		ctx.fail(`${label}: run.result carries the emitted payload`, JSON.stringify(results));
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testEffectiveDefaults(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Effective config auto-approves circuit tools by default");
	const info = await ctx.page.evaluate(`(async () => {
		const plugin = window.app.plugins.plugins["notor"];
		const root = plugin.getCircuitDataRootName ? plugin.getCircuitDataRootName() : "orchestrations";
		const orchestrator = plugin.getActiveOrchestrator && plugin.getActiveOrchestrator();
		const resolver = orchestrator && orchestrator.configResolver;
		if (!resolver) return { root, error: "No config resolver" };
		const { effective } = await resolver.resolveEffectiveConfig(undefined, null, null);
		const pick = (n) => {
			const e = effective.tools[n];
			return e ? { enabled: e.enabled, auto_approve: e.auto_approve } : null;
		};
		return {
			root,
			savedEmit: plugin.settings.auto_approve.emit_event === undefined ? "unset" : plugin.settings.auto_approve.emit_event,
			emit: pick("emit_event"),
			ensure: pick("circuit_task_ensure"),
		};
	})()`) as { root: string; error?: string; savedEmit?: unknown; emit?: { enabled: boolean; auto_approve: boolean } | null; ensure?: { enabled: boolean; auto_approve: boolean } | null };

	sessionsDir = `notor/${info.root}/sessions`;
	console.log(`  (data root: ${info.root})`);
	if (info.error) {
		ctx.fail("Effective config resolved", info.error);
		return;
	}
	if (info.savedEmit === "unset") ctx.pass("emit_event has no saved setting", "relies on the default");
	else ctx.fail("emit_event has no saved setting", `saved value ${JSON.stringify(info.savedEmit)}`);

	if (info.emit?.enabled && info.emit.auto_approve === true) ctx.pass("emit_event auto-approves by default", JSON.stringify(info.emit));
	else ctx.fail("emit_event auto-approves by default", JSON.stringify(info.emit));

	if (info.ensure?.enabled && info.ensure.auto_approve === true) ctx.pass("circuit_task_ensure auto-approves by default", JSON.stringify(info.ensure));
	else ctx.fail("circuit_task_ensure auto-approves by default", JSON.stringify(info.ensure));
}

async function testPlanModeRun(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Plan-mode step emits with no approval dialog");
	const sessionId = await runWatched(ctx, "Plan", PLAN_CIRCUIT.name, "plan");
	if (sessionId) checkTerminalPayload(ctx, "Plan", sessionId);
}

async function testActModeRun(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Act-mode step tracks a task and emits with no approval dialog");
	const sessionId = await runWatched(ctx, "Act", ACT_CIRCUIT.name, "act");
	if (!sessionId) return;
	checkTerminalPayload(ctx, "Act", sessionId);

	const taskFile = path.join(ctx.vaultPath, sessionsDir, sessionId, "tasks", `${TASK_KEY}.md`);
	const task = fs.existsSync(taskFile) ? fs.readFileSync(taskFile, "utf8") : "";
	if (task.includes("notor-task-status: closed")) ctx.pass("Act: task note ensured and closed", `${TASK_KEY}.md`);
	else ctx.fail("Act: task note ensured and closed", task ? task.slice(0, 300) : `${taskFile} missing`);
}

async function testSettingsRow(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Settings → Tools lists the circuit tools");
	const { page } = ctx;
	await openPluginSettings(page);
	await expandSettingsGroup(page, "Tools");
	const found = await page.evaluate(`(() => Array.from(document.querySelectorAll(".setting-item-name"))
		.some((el) => el.textContent === "Emit circuit event"))()`) as boolean;
	const shot = await ctx.screenshot("settings-tools-circuit-rows");
	if (found) ctx.pass("Emit circuit event row rendered", "Settings → Tools", shot);
	else ctx.fail("Emit circuit event row rendered", "row not found", shot);
	await page.keyboard.press("Escape");
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: No unexpected plugin errors");
	const errors = ctx.collector.getLogsByLevel("error");
	if (errors.length === 0) ctx.pass("No unexpected errors", "clean error log");
	else ctx.fail("No unexpected errors", JSON.stringify(errors.slice(0, 3)).slice(0, 600));
}

async function tests(ctx: TestContext): Promise<void> {
	const srv = startMockServer();
	try {
		await ctx.page.waitForTimeout(5_000);
		await testEffectiveDefaults(ctx);
		await testPlanModeRun(ctx);
		await testActModeRun(ctx);
		await testSettingsRow(ctx);
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
	mode: "plan",
	circuits_enabled: true,
	// A prompted call is skipped after 5 s, so a regression fails fast instead of hanging.
	approval_timeout: 5,
	// Deliberately no circuit tool in auto_approve: the shipped defaults are under test.
});

runTest(
	{
		name: "circuit-headless-approval",
		settings,
		setupVault: (vaultPath) => {
			for (const [c, marker] of [[PLAN_CIRCUIT, PLAN_MARKER], [ACT_CIRCUIT, ACT_MARKER]] as const) {
				const dir = path.join(vaultPath, c.dir);
				fs.mkdirSync(path.join(dir, "steps"), { recursive: true });
				fs.writeFileSync(path.join(dir, "definition.md"), definitionMd(c));
				fs.writeFileSync(path.join(dir, "steps", `${c.step}.md`), stepMd(marker));
			}
		},
		// Sessions are left in place like every other circuit e2e.
		cleanupFiles: [PLAN_CIRCUIT.dir, ACT_CIRCUIT.dir],
	},
	tests,
);
