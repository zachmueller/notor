#!/usr/bin/env npx tsx
/**
 * Plan-mode early stream stop E2E Test
 *
 * A scripted mock OpenAI-compatible server streams a write_note call whose
 * `content` argument trickles in slowly. In Plan mode the plugin must stop the
 * stream the moment the call opens and close the HTTP request, so the model
 * stops generating (and billing) arguments that could never run.
 *
 * Scenarios:
 *   1. A lone blocked write: the server sees the connection close before its
 *      argument deltas finish, the card shows the Plan-mode error, the next
 *      request carries that error as the tool result, and no file is written.
 *   2. read_note then write_note in one response (OpenAI sends every
 *      tool_call_end at the end): the earlier read still runs, the write is
 *      blocked, and the stream is still cut early.
 *   3. No unexpected plugin errors.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, ensureCleanState, newConversation, sendMessage } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants + fixtures
// ---------------------------------------------------------------------------

const MOCK_PORT = 18_742;
const MOCK_MODEL = "mock-model";
const FINAL_TEXT = "MOCK-PLANNED";
const PLAN_ERROR = "write_note is not available in Plan mode";

const READ_NOTE = "Early Stop Source.md";
const READ_MARKER = "early-stop-read-marker-41c9";
const BLOCKED_PATH = "early-stop-out/blocked.md";

/** Argument deltas per blocked write, one every DELTA_INTERVAL_MS (~8s total). */
const DELTA_COUNT = 160;
const DELTA_INTERVAL_MS = 50;

// ---------------------------------------------------------------------------
// Scripted mock server
//
// "#write" → text, then a write_note call whose content streams slowly.
// "#readwrite" → a complete read_note call, then the slow write_note call.
// Any request whose last message is a tool result gets FINAL_TEXT.
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

type OpenAiMessage = {
	role: string;
	content?: string | Array<{ type: string; text?: string }> | null;
	tool_call_id?: string;
};

interface StreamRecord {
	prompt: string;
	deltasSent: number;
	/** True when the client closed the connection before the server ended it. */
	closedEarly: boolean;
}

/** One record per slow-write stream, in order. */
const writeStreams: StreamRecord[] = [];
/** Tool-result messages of every follow-up request, in order. */
const toolResults: OpenAiMessage[][] = [];

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

function toolCallDelta(index: number, extra: Record<string, unknown>): unknown {
	return { choices: [{ index: 0, delta: { tool_calls: [{ index, ...extra }] } }] };
}

/** Stream a write_note call at `index` whose arguments trickle in. */
function streamSlowWrite(res: http.ServerResponse, index: number, record: StreamRecord): void {
	sse(res, toolCallDelta(index, { id: `call_write_${writeStreams.length}`, type: "function", function: { name: "write_note", arguments: "" } }));
	const chunks = [`{"path":"${BLOCKED_PATH}","content":"`, ...Array.from({ length: DELTA_COUNT }, (_, i) => `line ${i} of a long note\\n`), `"}`];
	let i = 0;
	const timer = setInterval(() => {
		if (res.destroyed || res.writableEnded) {
			clearInterval(timer);
			return;
		}
		if (i < chunks.length) {
			sse(res, toolCallDelta(index, { function: { arguments: chunks[i] } }));
			i++;
			record.deltasSent = i;
			return;
		}
		clearInterval(timer);
		finish(res, "tool_calls");
	}, DELTA_INTERVAL_MS);
	res.on("close", () => {
		clearInterval(timer);
		if (!res.writableEnded) record.closedEarly = true;
	});
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
			const last = messages[messages.length - 1];
			const prompt = messageText([...messages].reverse().find((m) => m.role === "user"));

			res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });

			if (last?.role === "tool") {
				// Collect the trailing run of tool results.
				const trailing: OpenAiMessage[] = [];
				for (let k = messages.length - 1; k >= 0 && messages[k]?.role === "tool"; k--) trailing.unshift(messages[k]!);
				toolResults.push(trailing);
				sse(res, { choices: [{ index: 0, delta: { content: FINAL_TEXT } }] });
				finish(res, "stop");
				return;
			}

			if (prompt.includes("#readwrite")) {
				const record: StreamRecord = { prompt, deltasSent: 0, closedEarly: false };
				writeStreams.push(record);
				sse(res, toolCallDelta(0, {
					id: `call_read_${writeStreams.length}`,
					type: "function",
					function: { name: "read_note", arguments: JSON.stringify({ path: READ_NOTE }) },
				}));
				streamSlowWrite(res, 1, record);
				return;
			}

			if (prompt.includes("#write")) {
				const record: StreamRecord = { prompt, deltasSent: 0, closedEarly: false };
				writeStreams.push(record);
				sse(res, { choices: [{ index: 0, delta: { content: "Saving the note now." } }] });
				streamSlowWrite(res, 0, record);
				return;
			}

			sse(res, { choices: [{ index: 0, delta: { content: FINAL_TEXT } }] });
			finish(res, "stop");
		});
	});
	srv.listen(MOCK_PORT, "127.0.0.1");
	return srv;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Text of every tool-result summary in the chat, in order. */
async function toolResultSummaries(ctx: TestContext): Promise<string[]> {
	return ctx.page.evaluate(() =>
		Array.from(document.querySelectorAll(".notor-tool-result-summary")).map((el) => el.textContent ?? ""),
	);
}

function stoppedLogCount(ctx: TestContext): number {
	return ctx.collector.getStructuredLogs()
		.filter((e) => e.message === "Stopped stream at blocked tool call").length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testLoneBlockedWrite(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: A lone blocked write stops the stream early");
	await ensureCleanState(ctx.page);
	await newConversation(ctx.page);

	const started = Date.now();
	const responded = await sendMessage(ctx.page, "Please #write the note");
	const elapsedMs = Date.now() - started;
	const shot = await ctx.screenshot("lone-blocked-write");
	if (!responded) {
		ctx.fail("Turn completed", "response never finished", shot);
		return;
	}

	const record = writeStreams[writeStreams.length - 1];
	const totalChunks = DELTA_COUNT + 2;
	if (record?.closedEarly && record.deltasSent < totalChunks) {
		ctx.pass("Request closed before the arguments finished", `${record.deltasSent}/${totalChunks} deltas sent, ${elapsedMs}ms`);
	} else {
		ctx.fail("Request closed before the arguments finished", JSON.stringify(record));
	}

	const summaries = await toolResultSummaries(ctx);
	if (summaries.some((s) => s.includes(PLAN_ERROR))) ctx.pass("Card shows the Plan-mode error", summaries.join(" | "), shot);
	else ctx.fail("Card shows the Plan-mode error", JSON.stringify(summaries), shot);

	const followUp = toolResults[toolResults.length - 1] ?? [];
	if (followUp.length === 1 && messageText(followUp[0]).includes(PLAN_ERROR)) {
		ctx.pass("Next request carries the error tool result", messageText(followUp[0]));
	} else {
		ctx.fail("Next request carries the error tool result", JSON.stringify(followUp));
	}

	const assistantText = await ctx.page.evaluate(() =>
		Array.from(document.querySelectorAll(".notor-message-assistant")).map((el) => el.textContent ?? "").join(" | "),
	);
	if (assistantText.includes("Saving the note now.") && assistantText.includes(FINAL_TEXT)) {
		ctx.pass("Pre-call text and follow-up reply both shown", assistantText.slice(0, 200));
	} else {
		ctx.fail("Pre-call text and follow-up reply both shown", assistantText.slice(0, 400));
	}

	if (!fs.existsSync(path.join(ctx.vaultPath, BLOCKED_PATH))) ctx.pass("No file written", BLOCKED_PATH);
	else ctx.fail("No file written", `${BLOCKED_PATH} exists`);

	if (stoppedLogCount(ctx) >= 1) ctx.pass("Stop is logged", "Stopped stream at blocked tool call");
	else ctx.fail("Stop is logged", "no 'Stopped stream at blocked tool call' log entry");
}

async function testReadThenBlockedWrite(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: An earlier read still runs when a later write is blocked");
	await ensureCleanState(ctx.page);
	await newConversation(ctx.page);

	const responded = await sendMessage(ctx.page, "Please #readwrite the notes");
	const shot = await ctx.screenshot("read-then-blocked-write");
	if (!responded) {
		ctx.fail("Turn completed", "response never finished", shot);
		return;
	}

	const record = writeStreams[writeStreams.length - 1];
	if (record?.prompt.includes("#readwrite") && record.closedEarly) {
		ctx.pass("Request closed early", `${record.deltasSent} deltas sent`);
	} else {
		ctx.fail("Request closed early", JSON.stringify(record));
	}

	const followUp = toolResults[toolResults.length - 1] ?? [];
	const texts = followUp.map(messageText);
	const readRan = texts.some((t) => t.includes(READ_MARKER));
	const writeBlocked = texts.some((t) => t.includes(PLAN_ERROR));
	if (followUp.length === 2 && readRan && writeBlocked) {
		ctx.pass("Read ran and write was blocked", "both tool results present", shot);
	} else {
		ctx.fail("Read ran and write was blocked", JSON.stringify(texts).slice(0, 600), shot);
	}
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: No unexpected plugin errors");
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
		await testLoneBlockedWrite(ctx);
		await testReadThenBlockedWrite(ctx);
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
});

runTest(
	{
		name: "plan-mode-early-stop",
		settings,
		setupVault: (vaultPath) => {
			fs.writeFileSync(path.join(vaultPath, READ_NOTE), `# Source\n\n${READ_MARKER}\n`);
		},
		cleanupFiles: [READ_NOTE, BLOCKED_PATH],
	},
	tests,
);
