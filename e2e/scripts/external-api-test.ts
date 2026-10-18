#!/usr/bin/env npx tsx
/**
 * External scripting API E2E Test
 *
 * Drives `app.plugins.plugins.notor.api` (what Templater scripts call) against
 * a scripted mock OpenAI-compatible server, so every run is deterministic.
 *
 * Scenarios:
 *   1. The API is mounted, versioned, ready, and lists the fixture workflow + circuit.
 *   2. runWorkflow headless: awaited result, conversation id, linked note inlined, notesRead.
 *   3. Panel-free approval: a headless write prompts an "Approve tool call" modal;
 *      Approve writes the note (notesEdited), Reject doesn't.
 *   4. runWorkflow display "new-panel": opens a chat tab whose conversation
 *      carries the linked note as an attachment.
 *   5. runCircuit: awaited headless completion; wait:false + getRun, the
 *      already_running result, and cancelRun.
 *   6. runCircuit display "new-panel" follow mode: the tab shows the step conversation.
 *   7. runTool + gates: read succeeds, Plan mode blocks a write, approval "auto"
 *      needs the opt-in, unknown tools and a disabled API throw.
 *
 * @see docs/api.md
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

const MOCK_PORT = 18_741;
const MOCK_MODEL = "mock-model";
const FINAL_TEXT = "MOCK-DONE";

const SOURCE_NOTE = "API Source.md";
const SOURCE_MARKER = "source-note-marker-7f3a";
const OUT_DIR = "api-e2e-out";
const WORKFLOW_NAME = "api-e2e";
const CIRCUIT_NAME = "API E2E Circuit";
const CIRCUIT_DIR = "notor/circuits/api-e2e";

const WORKFLOW_MD = `---
notor-workflow: true
notor-trigger: manual
---

You are the API e2e workflow. Follow the user's directive.
`;

const DEFINITION_MD = `---
notor-type: circuit
notor-circuit-name: "${CIRCUIT_NAME}"
notor-circuit-description: "One-step circuit for the external API e2e test."
notor-starting-event: flow.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 5
notor-max-runtime-minutes: 5
notor-steps:
  - "[[only-step]]"
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

Reply briefly.
`;

// ---------------------------------------------------------------------------
// Scripted mock server
//
// The latest user message drives the reply:
//   "#write:<path>" → a write_note tool call, "#slow" → a 30s delay, else text.
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

			const write = /#write:(\S+)/.exec(prompt);
			if (write) {
				const args = JSON.stringify({ path: write[1], content: "written by the mock model" });
				sse(res, {
					choices: [{
						index: 0,
						delta: { tool_calls: [{ index: 0, id: `call_${++callSeq}`, type: "function", function: { name: "write_note", arguments: args } }] },
					}],
				});
				finish(res, "tool_calls");
				return;
			}

			const delay = prompt.includes("#slow") ? 30_000 : 100;
			const timer = setTimeout(() => {
				sse(res, { choices: [{ index: 0, delta: { content: FINAL_TEXT } }] });
				finish(res, "stop");
			}, delay);
			res.on("close", () => clearTimeout(timer));
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

/** Wait for the panel-free approval modal, then click a button in it. */
async function answerApprovalModal(page: Page, button: "Approve" | "Reject", timeoutMs = 30_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const clicked = await page.evaluate((label: string) => {
			const modal = Array.from(document.querySelectorAll(".modal"))
				.find((m) => m.querySelector("h2")?.textContent === "Approve tool call");
			const btn = modal
				? Array.from(modal.querySelectorAll("button")).find((b) => b.textContent === label)
				: undefined;
			if (!btn) return false;
			(btn as HTMLButtonElement).click();
			return true;
		}, button);
		if (clicked) return true;
		await page.waitForTimeout(250);
	}
	return false;
}

function vaultFileExists(ctx: TestContext, rel: string): boolean {
	return fs.existsSync(path.join(ctx.vaultPath, rel));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testMounted(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: API is mounted, ready, and lists fixtures");
	const { page } = ctx;
	const shape = await callApi<Outcome<{ version: number; frozen: boolean }>>(
		page,
		"api.ready.then(() => ({ version: api.version, frozen: Object.isFrozen(api) }))",
	);
	if (shape.ok && shape.value.version === 1 && shape.value.frozen) ctx.pass("API mounted", "version 1, frozen, ready resolved");
	else ctx.fail("API mounted", JSON.stringify(shape));

	const workflows = await callApi<Outcome<Array<{ name: string }>>>(page, "api.listWorkflows()");
	const circuits = await callApi<Outcome<Array<{ name: string; path: string }>>>(page, "api.listCircuits()");
	if (workflows.ok && workflows.value.some((w) => w.name === WORKFLOW_NAME)) ctx.pass("listWorkflows", WORKFLOW_NAME);
	else ctx.fail("listWorkflows", JSON.stringify(workflows));
	if (circuits.ok && circuits.value.some((c) => c.name === CIRCUIT_NAME && c.path === CIRCUIT_DIR)) ctx.pass("listCircuits", CIRCUIT_NAME);
	else ctx.fail("listCircuits", JSON.stringify(circuits));
}

async function testHeadlessWorkflow(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: runWorkflow headless");
	const before = userPrompts.length;
	const run = await callApi<Outcome<Record<string, unknown>>>(
		ctx.page,
		`api.runWorkflow(${JSON.stringify(WORKFLOW_NAME)}, { prompt: "Summarize [[API Source]].", include: ["conversation", "text", "notes"] })`,
	);
	if (!run.ok) {
		ctx.fail("Headless workflow ran", run.message);
		return;
	}
	const r = run.value;
	if (r.status === "completed" && r.text === FINAL_TEXT && typeof r.conversationId === "string") {
		ctx.pass("Headless workflow completed", `conversation ${String(r.conversationId)}`);
	} else {
		ctx.fail("Headless workflow completed", JSON.stringify(r));
	}

	const sent = userPrompts.slice(before).join("\n");
	if (sent.includes(SOURCE_MARKER)) ctx.pass("Linked note inlined into the prompt", "marker found in request");
	else ctx.fail("Linked note inlined into the prompt", "source note content missing from the request");

	const read = (r.notesRead as string[] | undefined) ?? [];
	if (read.includes(SOURCE_NOTE)) ctx.pass("notesRead reports the attached note", read.join(", "));
	else ctx.fail("notesRead reports the attached note", JSON.stringify(r.notesRead));
}

async function testApprovalModal(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Panel-free approval modal");
	const { page } = ctx;
	for (const [button, file, shouldExist] of [
		["Approve", `${OUT_DIR}/approved.md`, true],
		["Reject", `${OUT_DIR}/rejected.md`, false],
	] as const) {
		const started = await callApi<Outcome<string>>(
			page,
			`api.runWorkflow(${JSON.stringify(WORKFLOW_NAME)}, { prompt: "#write:${file}", wait: false, include: ["notes"] })
				.then((run) => { window.__notorApiRun = run; return run.runId; })`,
		);
		if (!started.ok) {
			ctx.fail(`${button}: run started`, started.message);
			continue;
		}
		await page.waitForSelector(".modal .notor-tool-approval-params", { timeout: 30_000 }).catch(() => undefined);
		const shot = await ctx.screenshot(`approval-${button.toLowerCase()}`);
		const answered = await answerApprovalModal(page, button);
		if (!answered) {
			ctx.fail(`${button}: approval modal shown`, "No 'Approve tool call' modal appeared", shot);
			continue;
		}
		ctx.pass(`${button}: approval modal shown`, "clicked " + button, shot);

		const done = await callApi<Outcome<Record<string, unknown>>>(page, "window.__notorApiRun.done");
		const edited = done.ok ? ((done.value.notesEdited as string[] | undefined) ?? []) : [];
		const exists = vaultFileExists(ctx, file);
		if (done.ok && done.value.status === "completed" && exists === shouldExist && edited.includes(file) === shouldExist) {
			ctx.pass(`${button}: write outcome`, `file exists=${exists}, notesEdited=${JSON.stringify(edited)}`);
		} else {
			ctx.fail(`${button}: write outcome`, `exists=${exists} result=${JSON.stringify(done)}`);
		}
	}
}

async function testNewPanelWorkflow(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: runWorkflow in a new panel");
	const { page } = ctx;
	const leavesBefore = await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("notor-chat-view").length as number);
	const run = await callApi<Outcome<Record<string, unknown>>>(
		page,
		`api.runWorkflow(${JSON.stringify(WORKFLOW_NAME)}, { prompt: "Look at [[API Source]].", display: "new-panel" })`,
	);
	const shot = await ctx.screenshot("workflow-new-panel");
	if (!run.ok || run.value.status !== "completed") {
		ctx.fail("New-panel workflow completed", JSON.stringify(run), shot);
		return;
	}
	const conversationId = String(run.value.conversationId);
	const state = await page.evaluate((id: string) => {
		const plugin = (window as any).app.plugins.plugins["notor"];
		const leaves = (window as any).app.workspace.getLeavesOfType("notor-chat-view");
		const owners = leaves
			.map((leaf: any) => plugin.getOrchestratorForView(leaf.view))
			.filter((o: any) => o && o.getConversationManager().getActiveConversation()?.id === id);
		const messages = owners[0]?.getConversationManager().getMessages() ?? [];
		const firstUser = messages.find((m: any) => m.role === "user");
		return {
			leaves: leaves.length,
			showing: owners.length,
			attachmentPaths: (firstUser?.attachments ?? []).map((a: any) => a.path),
		};
	}, conversationId);

	if (state.leaves === leavesBefore + 1 && state.showing === 1) ctx.pass("New chat tab shows the run", `${state.leaves} chat leaves`, shot);
	else ctx.fail("New chat tab shows the run", JSON.stringify({ leavesBefore, ...state }), shot);

	if (state.attachmentPaths.includes(SOURCE_NOTE)) ctx.pass("Linked note attached as a chip", state.attachmentPaths.join(", "));
	else ctx.fail("Linked note attached as a chip", JSON.stringify(state.attachmentPaths));
}

async function testCircuits(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: runCircuit headless, getRun, already_running, cancelRun");
	const { page } = ctx;

	const awaited = await callApi<Outcome<Record<string, unknown>>>(
		page,
		`api.runCircuit(${JSON.stringify(CIRCUIT_NAME)}, { prompt: "Wrap up [[API Source]]." })`,
	);
	if (awaited.ok && awaited.value.status === "completed" && String(awaited.value.sessionId).startsWith("sess-")) {
		ctx.pass("Headless circuit completed", `session ${String(awaited.value.sessionId)}`);
	} else {
		ctx.fail("Headless circuit completed", JSON.stringify(awaited));
	}

	const started = await callApi<Outcome<string>>(
		page,
		`api.runCircuit(${JSON.stringify(CIRCUIT_NAME)}, { prompt: "#slow", wait: false })
			.then((run) => { window.__notorApiCircuit = run; return run.runId; })`,
	);
	if (!started.ok) {
		ctx.fail("Slow circuit started", started.message);
		return;
	}
	const runId = started.value;
	await page.waitForTimeout(1_500);

	const live = await callApi<Outcome<{ status: string }>>(page, `api.getRun(${JSON.stringify(runId)})`);
	if (live.ok && live.value?.status === "running") ctx.pass("getRun reports running", runId);
	else ctx.fail("getRun reports running", JSON.stringify(live));

	const second = await callApi<Outcome<{ status: string; errorCode?: string }>>(
		page,
		`api.runCircuit(${JSON.stringify(CIRCUIT_NAME)}, { wait: false })`,
	);
	if (second.ok && second.value.status === "failed" && second.value.errorCode === "already_running") {
		ctx.pass("Second run reports already_running", "single-instance guard surfaced");
	} else {
		ctx.fail("Second run reports already_running", JSON.stringify(second));
	}

	const cancelled = await callApi<Outcome<boolean>>(page, `api.cancelRun(${JSON.stringify(runId)})`);
	const done = await callApi<Outcome<{ status: string }>>(page, "window.__notorApiCircuit.done");
	if (cancelled.ok && cancelled.value === true && done.ok && done.value.status === "cancelled") {
		ctx.pass("cancelRun cancels the circuit", "status cancelled");
	} else {
		ctx.fail("cancelRun cancels the circuit", JSON.stringify({ cancelled, done }));
	}
}

async function testCircuitFollowMode(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: runCircuit follow mode in a new panel");
	const { page } = ctx;
	const run = await callApi<Outcome<Record<string, unknown>>>(
		page,
		`api.runCircuit(${JSON.stringify(CIRCUIT_NAME)}, { prompt: "Follow me.", display: "new-panel" })`,
	);
	await page.waitForTimeout(1_500);
	const shot = await ctx.screenshot("circuit-follow-mode");
	if (!run.ok || run.value.status !== "completed" || typeof run.value.conversationId !== "string") {
		ctx.fail("Follow-mode circuit completed", JSON.stringify(run), shot);
		return;
	}
	const showing = await page.evaluate((id: string) => {
		const plugin = (window as any).app.plugins.plugins["notor"];
		return (window as any).app.workspace.getLeavesOfType("notor-chat-view")
			.map((leaf: any) => plugin.getOrchestratorForView(leaf.view))
			.some((o: any) => o && o.getConversationManager().getActiveConversation()?.id === id);
	}, run.value.conversationId);
	const treeOpen = await page.evaluate(() =>
		(window as any).app.workspace.getLeavesOfType("notor-run-tree-view").length > 0);
	if (showing) ctx.pass("Panel shows the step conversation", String(run.value.conversationId), shot);
	else ctx.fail("Panel shows the step conversation", "no chat panel is showing the step conversation", shot);
	if (treeOpen) ctx.pass("Run-tree view opened", "follow mode opened the run tree");
	else ctx.fail("Run-tree view opened", "no run-tree leaf");
}

async function testRunToolAndGates(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: runTool and gates");
	const { page } = ctx;

	const read = await callApi<Outcome<{ success: boolean; toolName: string; result: unknown }>>(
		page,
		`api.runTool("read_note", { path: ${JSON.stringify(SOURCE_NOTE)} })`,
	);
	if (read.ok && read.value.success && JSON.stringify(read.value.result).includes(SOURCE_MARKER)) {
		ctx.pass("runTool read_note", "returned the note content");
	} else {
		ctx.fail("runTool read_note", JSON.stringify(read).slice(0, 400));
	}

	const blocked = await callApi<Outcome<{ success: boolean; error?: string }>>(
		page,
		`api.runTool("write_note", { path: "${OUT_DIR}/plan.md", content: "x" }, { mode: "plan" })`,
	);
	if (blocked.ok && !blocked.value.success && /plan/i.test(blocked.value.error ?? "") && !vaultFileExists(ctx, `${OUT_DIR}/plan.md`)) {
		ctx.pass("Plan mode blocks a write", blocked.value.error ?? "");
	} else {
		ctx.fail("Plan mode blocks a write", JSON.stringify(blocked));
	}

	for (const [label, expr, code] of [
		["approval auto needs opt-in", `api.runTool("read_note", { path: "x.md" }, { approval: "auto" })`, "auto_approve_not_allowed"],
		["unknown tool", `api.runTool("no_such_tool", {})`, "not_found"],
		["session-only tool", `api.runTool("ask_user", {})`, "unsupported_tool"],
		["unknown workflow", `api.runWorkflow("no-such-workflow")`, "not_found"],
	] as const) {
		const out = await callApi<Outcome<unknown>>(page, expr);
		if (!out.ok && out.code === code) ctx.pass(`Throws ${code}: ${label}`, out.message);
		else ctx.fail(`Throws ${code}: ${label}`, JSON.stringify(out));
	}

	const disabled = await callApi<Outcome<unknown>>(
		page,
		`(async () => {
			const plugin = window.app.plugins.plugins["notor"];
			plugin.settings.external_api_enabled = false;
			try { return await api.listWorkflows(); } finally { plugin.settings.external_api_enabled = true; }
		})()`,
	);
	if (!disabled.ok && disabled.code === "api_disabled") ctx.pass("Disabled API throws api_disabled", disabled.message);
	else ctx.fail("Disabled API throws api_disabled", JSON.stringify(disabled));
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: No unexpected plugin errors");
	const errors = ctx.collector.getLogsByLevel("error")
		// The rejected write and the cancelled circuit log expected errors.
		.filter((e) => !/rejected|abort|cancel/i.test(JSON.stringify(e)));
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
		await testMounted(ctx);
		await testHeadlessWorkflow(ctx);
		await testApprovalModal(ctx);
		await testNewPanelWorkflow(ctx);
		await testCircuits(ctx);
		await testCircuitFollowMode(ctx);
		await testRunToolAndGates(ctx);
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
	// write_note stays non-auto-approved so headless writes must prompt.
	auto_approve: { write_note: false, read_note: true },
});

runTest(
	{
		name: "external-api",
		settings,
		setupVault: (vaultPath) => {
			fs.writeFileSync(path.join(vaultPath, SOURCE_NOTE), `# API Source\n\n${SOURCE_MARKER}\n`);
			const workflowsDir = path.join(vaultPath, "notor", "workflows");
			fs.mkdirSync(workflowsDir, { recursive: true });
			fs.writeFileSync(path.join(workflowsDir, `${WORKFLOW_NAME}.md`), WORKFLOW_MD);
			const circuitDir = path.join(vaultPath, CIRCUIT_DIR);
			fs.mkdirSync(circuitDir, { recursive: true });
			fs.writeFileSync(path.join(circuitDir, "definition.md"), DEFINITION_MD);
			fs.writeFileSync(path.join(circuitDir, "only-step.md"), STEP_MD);
		},
		cleanupFiles: [SOURCE_NOTE, OUT_DIR, `notor/workflows/${WORKFLOW_NAME}.md`, CIRCUIT_DIR],
	},
	tests,
);
