import { describe, it, expect } from "vitest";
import { performCompaction } from "./compaction";
import type { LLMProvider, SendMessageOptions, StreamChunk } from "../providers/provider";
import type { Message } from "../types";
import type { NotorSettings } from "../settings";

/** A provider that records the options it was called with and returns a summary. */
function captureProvider(): { provider: LLMProvider; calls: SendMessageOptions[] } {
	const calls: SendMessageOptions[] = [];
	const provider = {
		async *sendMessage(_messages: unknown, _tools: unknown, options: SendMessageOptions): AsyncIterable<StreamChunk> {
			calls.push(options);
			yield { type: "text_delta", text: "summary" } as StreamChunk;
		},
	} as unknown as LLMProvider;
	return { provider, calls };
}

const messages = [
	{ id: "1", conversation_id: "c", role: "user", content: "hello", timestamp: "t" },
	{ id: "2", conversation_id: "c", role: "assistant", content: "hi", timestamp: "t" },
] as Message[];

const settings = { compaction_threshold: 0.8, compaction_prompt_override: "" } as NotorSettings;

describe("performCompaction — summarizer request", () => {
	it("carries the 1M selection so Bedrock sends the beta header", async () => {
		const { provider, calls } = captureProvider();
		const result = await performCompaction(messages, provider, settings, "us.anthropic.claude-sonnet-4-6", "c", "automatic", true);
		expect(result.success).toBe(true);
		expect(calls[0]).toMatchObject({ model: "us.anthropic.claude-sonnet-4-6", use_extended_context: true });
	});

	it("leaves extended context off when not selected", async () => {
		const { provider, calls } = captureProvider();
		await performCompaction(messages, provider, settings, "us.anthropic.claude-sonnet-4-6", "c", "manual");
		expect(calls[0]?.use_extended_context).toBeUndefined();
	});
});
