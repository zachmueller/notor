#!/usr/bin/env npx tsx
/**
 * Voice commands e2e — settling approvals and questions by voice.
 *
 * Same fixtures as voice-mode-test.ts (fake whisper server, fake `say`, scripted
 * mock LLM). The mock emits a tool call when the user message contains
 * "#call:<tool>:<json>", so a dictated request can produce a write_note
 * approval card or an ask_user prompt, which the built-in voice-commands
 * automation then resolves from injected transcripts. Transcripts are injected
 * as addressed (said after the wake word, which is injected rather than
 * spotted) unless a test checks the unaddressed pending-reply shortcut.
 *
 * Run: npm run e2e:voice-commands   (add --skip-build to reuse the last build)
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, ensureCleanState, isPanelIdle, waitForResponse } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Constants + fixtures
// ---------------------------------------------------------------------------

const MOCK_PORT = 18_752;
const MOCK_MODEL = "mock-model";
const FINAL_TEXT = "MOCK-DONE";
const SUMMARY_TEXT = "SPOKEN-SUMMARY";
const SLOW_DELAY_MS = 6_000;
const WHISPER_PORT = 18_761;
const OUT_DIR = "voice-out";

const FIXTURES = fileURLToPath(new URL("../fixtures/voice/", import.meta.url));
const FAKE_WHISPER = path.join(FIXTURES, "fake-whisper-server.mjs");
const FAKE_SAY = path.join(FIXTURES, "fake-say.sh");
const SAY_LOG = "/tmp/notor-e2e-say.log";
const WHISPER_LOG = "/tmp/notor-e2e-whisper.log";
const WHISPER_TEXT = "/tmp/notor-e2e-whisper-text.txt";

// ---------------------------------------------------------------------------
// Scripted mock LLM server
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const CALL_MARKER = /#call:(\w+):(\{[^\n]*\})/;

type OpenAiMessage = { role: string; content?: string | Array<{ type: string; text?: string }> | null };

/** Text of the tool result in every follow-up request, in order. */
const toolResults: string[] = [];
let callCounter = 0;

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
			const messages = (JSON.parse(body) as { messages?: OpenAiMessage[] }).messages ?? [];
			const system = messages[0]?.role === "system" ? messageText(messages[0]) : "";
			const last = messages[messages.length - 1];
			res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });

			if (/spoken summary/i.test(system)) {
				sse(res, { choices: [{ index: 0, delta: { content: SUMMARY_TEXT } }] });
				finish(res, "stop");
				return;
			}

			const call = last?.role === "user" ? CALL_MARKER.exec(messageText(last)) : null;
			if (call) {
				callCounter++;
				sse(res, {
					choices: [{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, id: `call_${callCounter}`, type: "function", function: { name: call[1], arguments: call[2] } }],
						},
					}],
				});
				finish(res, "tool_calls");
				return;
			}

			if (last?.role === "tool") toolResults.push(messageText(last));
			const delay = last?.role === "user" && messageText(last).includes("#slow") ? SLOW_DELAY_MS : 0;
			setTimeout(() => {
				sse(res, { choices: [{ index: 0, delta: { content: FINAL_TEXT } }] });
				finish(res, "stop");
			}, delay);
		});
	});
	srv.listen(MOCK_PORT, "127.0.0.1");
	return srv;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readLog(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function resetLogs(): void {
	for (const f of [SAY_LOG, WHISPER_LOG, WHISPER_TEXT]) fs.rmSync(f, { force: true });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 250): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await sleep(intervalMs);
	}
	return check();
}

async function startVoice(ctx: TestContext): Promise<{ started: boolean; leafId: string | null }> {
	return ctx.page.evaluate(`(async () => {
		const plugin = window.app.plugins.plugins["notor"];
		const orch = plugin.getActiveOrchestrator();
		const controller = await plugin.getVoiceManager().startWithoutCapture(orch);
		return { started: !!controller, leafId: orch.getView()?.leaf.id ?? null };
	})()`) as Promise<{ started: boolean; leafId: string | null }>;
}

async function voiceState(ctx: TestContext, leafId: string): Promise<string> {
	return ctx.page.evaluate((id: string) => {
		const plugin = (window as any).app.plugins.plugins["notor"];
		return plugin.getVoiceManager().getStatus(id).state;
	}, leafId);
}

async function injectTranscript(ctx: TestContext, leafId: string, text: string, addressed = true): Promise<void> {
	await ctx.page.evaluate(async (args: { leafId: string; text: string; addressed: boolean }) => {
		const plugin = (window as any).app.plugins.plugins["notor"];
		await plugin.getVoiceManager().injectTranscript(args.leafId, args.text, { addressed: args.addressed });
	}, { leafId, text, addressed });
}

async function count(ctx: TestContext, selector: string): Promise<number> {
	return ctx.page.evaluate((sel: string) => document.querySelectorAll(sel).length, selector);
}

async function userBubbleCount(ctx: TestContext): Promise<number> {
	return count(ctx, ".notor-message-user");
}

function writeCall(notePath: string): string {
	return `Please #call:write_note:${JSON.stringify({ path: notePath, content: `# ${notePath}\n` })}`;
}

function askCall(question: string, suggestions: string[]): string {
	return `Please #call:ask_user:${JSON.stringify({ questions: [{ question, suggestions }] })}`;
}

function noteExists(ctx: TestContext, notePath: string): boolean {
	return fs.existsSync(path.join(ctx.vaultPath, notePath));
}

function sayLogHas(text: string): boolean {
	return readLog(SAY_LOG).includes(text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const srv = startMockServer();
	try {
		await ensureCleanState(ctx.page);
		resetLogs();

		const { started, leafId } = await startVoice(ctx);
		if (!started || !leafId) {
			ctx.fail("Voice mode started", `started=${started} leafId=${leafId}`, await ctx.screenshot("vc-start-failed"));
			return;
		}
		if (!(await waitFor(async () => (await voiceState(ctx, leafId)) === "armed", 20_000))) {
			ctx.fail("Voice mode armed", await voiceState(ctx, leafId), await ctx.screenshot("vc-not-armed"));
			return;
		}
		ctx.pass("Voice mode armed", leafId);

		// --- Test 1: approve a tool call by voice ---
		console.log("\nTest 1: 'Hey Notor, approve' settles a pending write_note approval");
		const noteA = `${OUT_DIR}/approved-by-voice.md`;
		await injectTranscript(ctx, leafId, writeCall(noteA));
		const approvalShown = await waitFor(async () => (await count(ctx, ".notor-approve-btn")) > 0, 20_000);
		if (approvalShown) ctx.pass("Approval card rendered", "write_note awaiting approval");
		else ctx.fail("Approval card rendered", "no .notor-approve-btn appeared", await ctx.screenshot("vc-no-approval"));
		if (await waitFor(() => sayLogHas("Approval needed"), 10_000)) ctx.pass("Approval announced", "fake say received the announcement");
		else ctx.fail("Approval announced", `say log: ${readLog(SAY_LOG).slice(-300)}`);

		await injectTranscript(ctx, leafId, "Hey Notor, approve");
		const approvedTurnDone = await waitForResponse(ctx.page, 30_000, 500);
		const approveButtonsLeft = await count(ctx, ".notor-approve-btn");
		if (approvedTurnDone && noteExists(ctx, noteA)) ctx.pass("Approved by voice", `${noteA} written`, await ctx.screenshot("vc-approved"));
		else ctx.fail("Approved by voice", `done=${approvedTurnDone} exists=${noteExists(ctx, noteA)} lastToolResult=${toolResults[toolResults.length - 1] ?? "(none)"}`,
			await ctx.screenshot("vc-approve-failed"));
		if (approveButtonsLeft === 0) ctx.pass("Approval card dismissed", "no .notor-approve-btn remains");
		else ctx.fail("Approval card dismissed", `${approveButtonsLeft} approve button(s) remain`);
		if (await waitFor(() => sayLogHas("Approved."), 5_000)) ctx.pass("Approval confirmed aloud", "'Approved.' spoken");
		else ctx.fail("Approval confirmed aloud", `say log: ${readLog(SAY_LOG).slice(-300)}`);

		// --- Test 2: a bare "no" rejects while an approval is pending ---
		console.log("\nTest 2: A bare 'no' rejects the pending approval without the wake word");
		const noteB = `${OUT_DIR}/rejected-by-voice.md`;
		await injectTranscript(ctx, leafId, writeCall(noteB));
		await waitFor(async () => (await count(ctx, ".notor-approve-btn")) > 0, 20_000);
		await injectTranscript(ctx, leafId, "no", false);
		const rejectedTurnDone = await waitForResponse(ctx.page, 30_000, 500);
		if (rejectedTurnDone && !noteExists(ctx, noteB)) ctx.pass("Rejected by a bare no", `${noteB} not written`);
		else ctx.fail("Rejected by a bare no", `done=${rejectedTurnDone} exists=${noteExists(ctx, noteB)}`, await ctx.screenshot("vc-reject-failed"));
		if (await waitFor(() => sayLogHas("Rejected."), 5_000)) ctx.pass("Rejection confirmed aloud", "'Rejected.' spoken");
		else ctx.fail("Rejection confirmed aloud", `say log: ${readLog(SAY_LOG).slice(-300)}`);

		// --- Test 3: answer a follow-up question by voice ---
		console.log("\nTest 3: 'Hey Notor, answer …' resolves an ask_user prompt");
		await injectTranscript(ctx, leafId, askCall("Which folder?", ["Inbox", "Archive"]));
		const promptShown = await waitFor(async () => (await count(ctx, ".notor-interaction-prompt")) > 0, 20_000);
		if (promptShown) ctx.pass("Question prompt rendered", "ask_user awaiting an answer");
		else ctx.fail("Question prompt rendered", "no .notor-interaction-prompt appeared", await ctx.screenshot("vc-no-question"));
		if (await waitFor(() => sayLogHas("Which folder?"), 10_000)) ctx.pass("Question announced", "question text spoken with options");
		else ctx.fail("Question announced", `say log: ${readLog(SAY_LOG).slice(-300)}`);

		await injectTranscript(ctx, leafId, "Hey Notor, answer the Inbox");
		const answeredTurnDone = await waitForResponse(ctx.page, 30_000, 500);
		const lastToolResult = toolResults[toolResults.length - 1] ?? "";
		if (answeredTurnDone && lastToolResult.includes("Inbox")) ctx.pass("Answered by voice", `tool result: ${lastToolResult.slice(0, 120)}`);
		else ctx.fail("Answered by voice", `done=${answeredTurnDone} result=${lastToolResult.slice(0, 200)}`, await ctx.screenshot("vc-answer-failed"));
		const promptsLeft = await count(ctx, ".notor-interaction-prompt");
		if (promptsLeft === 0) ctx.pass("Question prompt dismissed", "no .notor-interaction-prompt remains");
		else ctx.fail("Question prompt dismissed", `${promptsLeft} prompt(s) remain`);

		// --- Test 4: an addressed prompt that is not a command reaches the conversation ---
		console.log("\nTest 4: 'Hey Notor, make me some tea' is sent as a message");
		await waitFor(async () => (await voiceState(ctx, leafId)) === "armed", 15_000);
		const bubblesBefore = await userBubbleCount(ctx);
		await injectTranscript(ctx, leafId, "Hey Notor, make me some tea");
		const promptDone = await waitForResponse(ctx.page, 30_000, 500);
		const bubblesAfter = await userBubbleCount(ctx);
		const spokeUnknown = sayLogHas("Unknown voice command");
		if (promptDone && bubblesAfter === bubblesBefore + 1 && !spokeUnknown) ctx.pass("Prompt sent to the conversation", "one new user bubble");
		else ctx.fail("Prompt sent to the conversation", `done=${promptDone} bubbles ${bubblesBefore}→${bubblesAfter} unknownSpoken=${spokeUnknown}`,
			await ctx.screenshot("vc-prompt"));
		await waitFor(async () => (await voiceState(ctx, leafId)) === "armed", 15_000);

		// --- Test 4b: unaddressed speech with nothing pending is dropped ---
		console.log("\nTest 4b: A bare 'yes' with nothing pending is ignored");
		const beforeBare = await userBubbleCount(ctx);
		await injectTranscript(ctx, leafId, "yes", false);
		await sleep(1_000);
		if ((await userBubbleCount(ctx)) === beforeBare) ctx.pass("Unaddressed speech dropped", "no message sent");
		else ctx.fail("Unaddressed speech dropped", "a user bubble appeared");

		// --- Test 5: status ---
		console.log("\nTest 5: 'Hey Notor, status' describes the state");
		await injectTranscript(ctx, leafId, "Hey Notor, status");
		if (await waitFor(() => sayLogHas("Idle. Say Hey Notor to talk."), 10_000)) ctx.pass("Status spoken", "'Idle. Say Hey Notor to talk.'");
		else ctx.fail("Status spoken", `say log: ${readLog(SAY_LOG).slice(-300)}`);

		// --- Test 6: cancel a running turn ---
		console.log("\nTest 6: 'Hey Notor, cancel' aborts the running turn");
		await injectTranscript(ctx, leafId, "think about this for a while #slow");
		await sleep(800);
		const startedAt = Date.now();
		await injectTranscript(ctx, leafId, "Hey Notor, cancel");
		const idleSoon = await waitFor(() => isPanelIdle(ctx.page), 4_000);
		const elapsed = Date.now() - startedAt;
		if (idleSoon && elapsed < SLOW_DELAY_MS) ctx.pass("Turn cancelled by voice", `panel idle after ${elapsed} ms`);
		else ctx.fail("Turn cancelled by voice", `idle=${idleSoon} after ${elapsed} ms`, await ctx.screenshot("vc-cancel"));
		if (await waitFor(() => sayLogHas("Cancelled."), 5_000)) ctx.pass("Cancellation spoken", "'Cancelled.'");
		else ctx.fail("Cancellation spoken", `say log: ${readLog(SAY_LOG).slice(-300)}`);
		if (await waitFor(async () => (await voiceState(ctx, leafId)) === "armed", 5_000)) ctx.pass("Still armed after cancel", "voice mode stays on");
		else ctx.fail("Still armed after cancel", await voiceState(ctx, leafId));
	} finally {
		srv.close();
		resetLogs();
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
	auto_approve: { write_note: false, ask_user: true },
	voice_enabled: true,
	voice_whisper_server_path: FAKE_WHISPER,
	voice_whisper_model_path: FAKE_WHISPER,
	voice_whisper_server_port: WHISPER_PORT,
	voice_tts_command: FAKE_SAY,
	voice_input_cleanup_enabled: false,
	voice_progress_verbosity: "needs_me",
});

runTest(
	{
		name: "voice-commands",
		settings,
		setupVault: (vaultPath) => {
			resetLogs();
			fs.rmSync(path.join(vaultPath, OUT_DIR), { recursive: true, force: true });
		},
		cleanupFiles: [OUT_DIR],
	},
	tests,
);
