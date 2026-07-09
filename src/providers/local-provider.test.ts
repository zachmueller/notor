import { describe, it, expect, vi, afterEach } from "vitest";

import { LocalProvider } from "./local-provider";
import type { LLMProviderConfig } from "../types";
import type { App } from "obsidian";
import type { ChatMessage, SendMessageOptions } from "./provider";

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
