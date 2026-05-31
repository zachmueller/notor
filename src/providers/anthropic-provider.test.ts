import { describe, it, expect } from "vitest";

import { AnthropicProvider } from "./anthropic-provider";
import type { StreamChunk } from "./provider";
import type { App } from "obsidian";

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

function blockStart(provider: AnthropicProvider, contentBlock: Record<string, unknown>): StreamChunk[] {
	// handleAnthropicEvent is private; access via cast for a focused unit test.
	const handle = (provider as unknown as {
		handleAnthropicEvent: (
			eventType: string,
			data: Record<string, unknown>,
			streamState: { pendingInputTokens: number },
		) => Iterable<StreamChunk>;
	}).handleAnthropicEvent.bind(provider);
	return [...handle("content_block_start", { content_block: contentBlock }, { pendingInputTokens: 0 })];
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
