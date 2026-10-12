import { describe, it, expect, vi, afterEach } from "vitest";

import { AnthropicProvider } from "./anthropic-provider";
import type { StreamChunk } from "./provider";
import type { App } from "obsidian";
import { getApiContextWindow, getLearnedContextWindow, resetModelLimits } from "./model-limits";
import { getContextWindow } from "./model-metadata";

// ---------------------------------------------------------------------------
// handleAnthropicEvent — thinking lifecycle on content_block_start
//
// The provider must emit a `thinking_start` boundary signal even when the
// thinking block carries no text (Opus 4.8+ hidden thinking), so the UI can
// show a "thinking" indicator. Text deltas follow only when present.
// ---------------------------------------------------------------------------

function makeProvider(): AnthropicProvider {
	// The constructor only stores config; handleAnthropicEvent uses no `this`
	// state beyond what we pass in, so a stub app is sufficient.
	return new AnthropicProvider({ id: "test", endpoint: "" } as never, {} as App);
}

function handleEvent(
	provider: AnthropicProvider,
	eventType: string,
	data: Record<string, unknown>,
	streamState: { pendingInputTokens: number } = { pendingInputTokens: 0 },
): StreamChunk[] {
	// handleAnthropicEvent is private; access via cast for a focused unit test.
	const handle = (provider as unknown as {
		handleAnthropicEvent: (
			eventType: string,
			data: Record<string, unknown>,
			streamState: { pendingInputTokens: number },
		) => Iterable<StreamChunk>;
	}).handleAnthropicEvent.bind(provider);
	return [...handle(eventType, data, streamState)];
}

function blockStart(provider: AnthropicProvider, contentBlock: Record<string, unknown>): StreamChunk[] {
	return handleEvent(provider, "content_block_start", { content_block: contentBlock });
}

describe("AnthropicProvider — thinking block lifecycle", () => {
	it("emits thinking_start (only) for a thinking block with no text", () => {
		const chunks = blockStart(makeProvider(), { type: "thinking" });
		expect(chunks).toEqual([{ type: "thinking_start" }]);
	});

	it("emits thinking_start then thinking_delta when text is present", () => {
		const chunks = blockStart(makeProvider(), { type: "thinking", thinking: "reasoning…" });
		expect(chunks).toEqual([
			{ type: "thinking_start" },
			{ type: "thinking_delta", text: "reasoning…" },
		]);
	});

	it("emits thinking_start (only) for a redacted_thinking block", () => {
		const chunks = blockStart(makeProvider(), { type: "redacted_thinking", data: "encrypted" });
		expect(chunks).toEqual([{ type: "thinking_start" }]);
	});

	it("still emits tool_call_start for tool_use blocks", () => {
		const chunks = blockStart(makeProvider(), { type: "tool_use", id: "tu_1", name: "read_note" });
		expect(chunks).toEqual([{ type: "tool_call_start", id: "tu_1", tool_name: "read_note" }]);
	});
});

describe("AnthropicProvider — stop_reason on message_end", () => {
	it("surfaces stop_reason=max_tokens with the output token count", () => {
		const chunks = handleEvent(
			makeProvider(),
			"message_delta",
			{ stop_reason: "max_tokens", usage: { output_tokens: 4096 } },
			{ pendingInputTokens: 12 },
		);
		expect(chunks).toEqual([
			{ type: "message_end", input_tokens: 12, output_tokens: 4096, stop_reason: "max_tokens" },
		]);
	});

	it("passes through a normal end_turn stop reason", () => {
		const chunks = handleEvent(
			makeProvider(),
			"message_delta",
			{ stop_reason: "end_turn", usage: { output_tokens: 10 } },
			{ pendingInputTokens: 5 },
		);
		expect(chunks).toEqual([
			{ type: "message_end", input_tokens: 5, output_tokens: 10, stop_reason: "end_turn" },
		]);
	});
});

// ---------------------------------------------------------------------------
// Live limits from /v1/models and context-overflow classification
// ---------------------------------------------------------------------------

describe("AnthropicProvider — model limits", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		resetModelLimits();
	});

	function makeKeyedProvider(): AnthropicProvider {
		const app = { secretStorage: { getSecret: () => "sk-test" } } as unknown as App;
		return new AnthropicProvider({ id: "test", endpoint: "https://api.example.com" } as never, app);
	}

	it("maps max_input_tokens onto ModelInfo and records it as an API limit", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				data: [
					{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 1_000_000, max_tokens: 128_000 },
					{ id: "claude-legacy", display_name: "Legacy" },
				],
				has_more: false,
			}),
		})));

		const models = await makeKeyedProvider().listModels();
		expect(models.map((m) => m.context_window)).toEqual([1_000_000, null]);
		expect(getApiContextWindow("claude-opus-5-5")).toBe(1_000_000);
		expect(getContextWindow("claude-opus-5-5")).toBe(1_000_000);
	});

	it("classifies 'prompt is too long' as CONTEXT_LENGTH_EXCEEDED and learns the limit", async () => {
		const body = '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}';
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, text: async () => body })));

		const consume = async () => {
			for await (const _chunk of makeKeyedProvider().sendMessage([{ role: "user", content: "hi" }], [], { model: "claude-opus-5-5" })) {
				// drain
			}
		};
		await expect(consume()).rejects.toMatchObject({
			code: "CONTEXT_LENGTH_EXCEEDED",
			details: { rawMessage: body },
		});
		expect(getLearnedContextWindow("claude-opus-5-5")).toBe(200_000);
	});
});

describe("AnthropicProvider — thinking request body", () => {
	afterEach(() => vi.unstubAllGlobals());

	/** Send one message and return the parsed request body (the fetch is rejected after capture). */
	async function captureBody(model: string, thinkingLevel: string): Promise<Record<string, unknown>> {
		let body: Record<string, unknown> = {};
		vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
			body = JSON.parse(init.body) as Record<string, unknown>;
			return { ok: false, status: 400, text: async () => "{}" };
		}));
		const app = { secretStorage: { getSecret: () => "sk-test" } } as unknown as App;
		const provider = new AnthropicProvider({ id: "test", endpoint: "https://api.example.com" } as never, app);
		try {
			for await (const _chunk of provider.sendMessage([{ role: "user", content: "hi" }], [], {
				model,
				thinking_level: thinkingLevel,
			})) {
				// drain
			}
		} catch {
			// expected — the stubbed response is an error
		}
		return body;
	}

	it("requests summarized adaptive thinking for effort models", async () => {
		const body = await captureBody("claude-opus-4-8", "high");
		expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(body.output_config).toEqual({ effort: "high" });
	});

	it("leaves legacy budget thinking without a display field", async () => {
		const body = await captureBody("claude-opus-4-6", "high");
		expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
	});
});

describe("AnthropicProvider — cross-provider tool-call ids", () => {
	afterEach(() => vi.unstubAllGlobals());

	// History from another provider (e.g. an OpenAI-compatible server) can carry
	// ids Anthropic rejects; they must be rewritten identically on both sides.
	it("sanitizes foreign tool_use / tool_result ids consistently", async () => {
		let body: { messages: Array<{ content: Array<Record<string, unknown>> }> } = { messages: [] };
		vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
			body = JSON.parse(init.body) as typeof body;
			return { ok: false, status: 400, text: async () => "{}" };
		}));
		const app = { secretStorage: { getSecret: () => "sk-test" } } as unknown as App;
		const provider = new AnthropicProvider({ id: "test", endpoint: "https://api.example.com" } as never, app);
		try {
			for await (const _chunk of provider.sendMessage([
				{ role: "user", content: "hi" },
				{ role: "tool_call", content: "", tool_calls: [{ id: "call:1.a", tool_name: "read_note", parameters: {} }] },
				{ role: "tool_result", content: "", tool_results: [{ tool_call_id: "call:1.a", tool_name: "read_note", result: "ok", is_error: false }] },
			], [], { model: "claude-opus-5-5" })) {
				// drain
			}
		} catch {
			// expected — the stubbed response is an error
		}
		const useId = body.messages[1]!.content.find((b) => b.type === "tool_use")!.id as string;
		const resultId = body.messages[2]!.content[0]!.tool_use_id as string;
		expect(useId).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(resultId).toBe(useId);
	});
});

// ---------------------------------------------------------------------------
// Transient network / server failures
// ---------------------------------------------------------------------------

describe("AnthropicProvider — transient failure classification", () => {
	afterEach(() => vi.unstubAllGlobals());

	function makeKeyedProvider(): AnthropicProvider {
		const app = { secretStorage: { getSecret: () => "sk-test" } } as unknown as App;
		return new AnthropicProvider({ id: "test", endpoint: "https://api.example.com" } as never, app);
	}

	async function collect(): Promise<{ chunks: StreamChunk[]; thrown?: unknown }> {
		const chunks: StreamChunk[] = [];
		try {
			for await (const chunk of makeKeyedProvider().sendMessage([{ role: "user", content: "hi" }], [], { model: "claude-opus-5-5" })) {
				chunks.push(chunk);
			}
			return { chunks };
		} catch (thrown) {
			return { chunks, thrown };
		}
	}

	it("yields a CONNECTION_FAILED error chunk when the body drops mid-stream", async () => {
		const encoder = new TextEncoder();
		let sent = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!sent) {
					sent = true;
					controller.enqueue(encoder.encode(
						'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
					));
					return;
				}
				controller.error(new TypeError("network error"));
			},
		});
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, body })));

		const { chunks, thrown } = await collect();
		expect(thrown).toBeUndefined();
		expect(chunks[0]).toEqual({ type: "text_delta", text: "partial" });
		expect(chunks.at(-1)).toMatchObject({ type: "error", code: "CONNECTION_FAILED" });
	});

	it("maps 529 overloaded to SERVICE_UNAVAILABLE", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 529, text: async () => "overloaded" })));
		expect((await collect()).thrown).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	});

	it("tags an SSE overloaded_error event as SERVICE_UNAVAILABLE", () => {
		const chunks = handleEvent(makeProvider(), "error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
		expect(chunks).toEqual([{ type: "error", error: "Overloaded", code: "SERVICE_UNAVAILABLE" }]);
	});
});
