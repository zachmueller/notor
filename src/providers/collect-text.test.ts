import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { collectText } from "./collect-text";
import type { LLMProvider, StreamChunk } from "./provider";
import type { NotorSettings } from "../settings";

const settings = { network_retry_max_retries: 1, network_retry_max_delay_ms: 1_000, network_offline_wait_max_ms: 0 } as unknown as NotorSettings;

function provider(attempts: StreamChunk[][]): LLMProvider {
	let call = 0;
	return {
		sendMessage: vi.fn(() => {
			const chunks = attempts[Math.min(call, attempts.length - 1)]!;
			call++;
			return (async function* () {
				for (const c of chunks) yield c;
			})();
		}),
	} as unknown as LLMProvider;
}

describe("collectText", () => {
	it("concatenates text deltas and records token counts", async () => {
		const p = provider([[
			{ type: "text_delta", text: "Hel" },
			{ type: "thinking_delta", text: "ignored" },
			{ type: "text_delta", text: "lo" },
			{ type: "message_end", input_tokens: 12, output_tokens: 3 },
		]]);
		const result = await collectText(p, [{ role: "user", content: "hi" }], { model: "m" }, settings, { label: "t" });
		expect(result).toEqual({ text: "Hello", inputTokens: 12, outputTokens: 3 });
		const [messages, tools, options] = (p.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(messages).toEqual([{ role: "user", content: "hi" }]);
		expect(tools).toEqual([]);
		expect(options).toMatchObject({ model: "m" });
	});

	it("returns a non-retryable stream error as `failure` with the partial text", async () => {
		const p = provider([[
			{ type: "text_delta", text: "partial" },
			{ type: "error", error: "bad request", retryable: false },
		]]);
		const result = await collectText(p, [], { model: "m" }, settings, { label: "t" });
		expect(result.text).toBe("partial");
		expect(result.failure).toMatchObject({ type: "error", error: "bad request" });
		expect(p.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("retries a retryable stream error and succeeds on the next attempt", async () => {
		vi.useFakeTimers();
		try {
			const p = provider([
				[{ type: "error", error: "overloaded", code: "RATE_LIMITED", retryable: true }],
				[{ type: "text_delta", text: "ok" }, { type: "message_end", input_tokens: 1, output_tokens: 1 }],
			]);
			const pending = collectText(p, [], { model: "m" }, settings, { label: "t" });
			await vi.runAllTimersAsync();
			const result = await pending;
			expect(result.text).toBe("ok");
			expect(result.failure).toBeUndefined();
			expect(p.sendMessage).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("propagates thrown provider errors", async () => {
		const p = { sendMessage: () => { throw new Error("down"); } } as unknown as LLMProvider;
		await expect(collectText(p, [], { model: "m" }, settings, { label: "t" })).rejects.toThrow("down");
	});
});
