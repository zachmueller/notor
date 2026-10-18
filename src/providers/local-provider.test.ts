import { describe, it, expect, vi, afterEach } from "vitest";

import { LocalProvider } from "./local-provider";
import type { LLMProviderConfig } from "../types";
import type { App } from "obsidian";
import type { ChatMessage, SendMessageOptions } from "./provider";
import { getLearnedContextWindow, resetModelLimits } from "./model-limits";

// ---------------------------------------------------------------------------
// LocalProvider — extra_body_params merge into the request body
//
// Custom parameters (e.g. Ollama's `keep_alive`) are merged top-level into the
// /chat/completions body, but the fixed protocol fields (model, messages,
// stream, stream_options) must always win over a colliding user extra.
// ---------------------------------------------------------------------------

/** A stub App whose secretStorage returns no API key. */
function makeApp(): App {
	return {
		secretStorage: { getSecret: () => null },
	} as unknown as App;
}

/** An SSE response body that immediately signals stream end. */
function doneStreamResponse(): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return {
		ok: true,
		status: 200,
		body: stream,
	} as unknown as Response;
}

/**
 * Drive sendMessage to completion against a stubbed fetch and return the
 * parsed JSON request body that was sent.
 */
async function captureRequestBody(
	config: Partial<LLMProviderConfig>
): Promise<Record<string, unknown>> {
	let capturedBody: Record<string, unknown> = {};
	const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
		capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
		return doneStreamResponse();
	});
	vi.stubGlobal("fetch", fetchMock);

	const provider = new LocalProvider(
		{ id: "local", type: "local", endpoint: "http://localhost:11434/v1", ...config } as LLMProviderConfig,
		makeApp()
	);
	const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
	const options: SendMessageOptions = { model: "llama3" };

	// Consume the stream to trigger the fetch.
	for await (const _chunk of provider.sendMessage(messages, [], options)) {
		// no-op
	}
	return capturedBody;
}

describe("LocalProvider — extra_body_params merge", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("merges extra params (e.g. keep_alive) into the request body", async () => {
		const body = await captureRequestBody({ extra_body_params: { keep_alive: "5m" } });
		expect(body.keep_alive).toBe("5m");
		// Fixed fields remain intact.
		expect(body.model).toBe("llama3");
		expect(body.stream).toBe(true);
		expect(body.stream_options).toEqual({ include_usage: true });
	});

	it("does not let extras clobber fixed protocol fields", async () => {
		const body = await captureRequestBody({
			extra_body_params: { model: "evil", stream: false, messages: "nope" },
		});
		expect(body.model).toBe("llama3");
		expect(body.stream).toBe(true);
		expect(Array.isArray(body.messages)).toBe(true);
	});

	it("produces the standard body when extras are absent", async () => {
		const body = await captureRequestBody({});
		expect(body).toEqual({
			model: "llama3",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
			stream_options: { include_usage: true },
		});
	});

	it("ignores non-object extra_body_params (array / null)", async () => {
		const bodyArray = await captureRequestBody({
			extra_body_params: [1, 2, 3] as unknown as Record<string, unknown>,
		});
		expect(bodyArray).toEqual({
			model: "llama3",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
			stream_options: { include_usage: true },
		});

		const bodyNull = await captureRequestBody({ extra_body_params: null });
		expect(bodyNull).toEqual({
			model: "llama3",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
			stream_options: { include_usage: true },
		});
	});
});

// ---------------------------------------------------------------------------
// LocalProvider — context overflow (llama.cpp returns 400/500 with n_ctx)
// ---------------------------------------------------------------------------

describe("LocalProvider — context overflow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		resetModelLimits();
	});

	it("classifies a llama.cpp overflow and learns n_ctx", async () => {
		const body = '{"error":{"code":400,"type":"exceed_context_size_error","n_prompt_tokens":9000,"n_ctx":8192}}';
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => body })));
		const provider = new LocalProvider(
			{ id: "local", type: "local", endpoint: "http://localhost:8080/v1" } as LLMProviderConfig,
			makeApp()
		);
		const consume = async () => {
			for await (const _chunk of provider.sendMessage([{ role: "user", content: "hi" }], [], { model: "qwen3:32b" })) {
				// drain
			}
		};
		await expect(consume()).rejects.toMatchObject({ code: "CONTEXT_LENGTH_EXCEEDED" });
		expect(getLearnedContextWindow("qwen3:32b")).toBe(8_192);
	});
});

describe("LocalProvider — transient failure classification", () => {
	afterEach(() => vi.unstubAllGlobals());

	function makeLocal(): LocalProvider {
		return new LocalProvider(
			{ id: "local", type: "local", endpoint: "http://localhost:11434/v1" } as LLMProviderConfig,
			makeApp()
		);
	}

	it("fails fast (non-retryable) when the server refuses the connection", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
		const consume = async () => {
			for await (const _chunk of makeLocal().sendMessage([{ role: "user", content: "hi" }], [], { model: "llama3" })) {
				// drain
			}
		};
		await expect(consume()).rejects.toMatchObject({ code: "CONNECTION_FAILED", retryable: false });
	});

	it("yields a CONNECTION_FAILED error chunk when the body drops mid-stream", async () => {
		const encoder = new TextEncoder();
		let sent = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!sent) {
					sent = true;
					controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
					return;
				}
				controller.error(new TypeError("network error"));
			},
		});
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body })));
		const chunks = [];
		for await (const chunk of makeLocal().sendMessage([{ role: "user", content: "hi" }], [], { model: "llama3" })) {
			chunks.push(chunk);
		}
		expect(chunks[0]).toEqual({ type: "text_delta", text: "partial" });
		expect(chunks.at(-1)).toMatchObject({ type: "error", code: "CONNECTION_FAILED" });
	});
});

describe("LocalProvider — tool call streaming", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("forwards arguments sent in a tool call's opening chunk", async () => {
		const sse = [
			{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write_note", arguments: '{"path":"a.md"}' } }] } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(sse));
				controller.close();
			},
		});
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body })));

		const provider = new LocalProvider(
			{ id: "local", type: "local", endpoint: "http://localhost:11434/v1" } as LLMProviderConfig,
			makeApp(),
		);
		const chunks = [];
		for await (const chunk of provider.sendMessage([{ role: "user", content: "hi" }], [], { model: "llama3" })) {
			chunks.push(chunk);
		}
		expect(chunks).toEqual([
			{ type: "tool_call_start", id: "call_1", tool_name: "write_note" },
			{ type: "tool_call_delta", id: "call_1", partial_json: '{"path":"a.md"}' },
			{ type: "tool_call_end", id: "call_1" },
		]);
	});
});
