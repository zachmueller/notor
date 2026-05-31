import { describe, it, expect } from "vitest";

import { BedrockProvider } from "./bedrock-provider";
import type { StreamChunk } from "./provider";
import type { App } from "obsidian";

// ---------------------------------------------------------------------------
// handleBedrockEvent — thinking (reasoningContent) wire shapes
//
// Verified against live Bedrock streams (see memory: bedrock-thinking-wire-shape):
// Bedrock emits NO contentBlockStart for thinking — reasoning arrives only as
// contentBlockDelta. Adaptive Opus 4.8 sends a signed `reasoningContent` blob
// with no `.text`; we must still surface a `thinking_start` from it.
// ---------------------------------------------------------------------------

function makeProvider(): BedrockProvider {
	return new BedrockProvider({ id: "test", region: "us-east-1" } as never, {} as App);
}

function handleDelta(provider: BedrockProvider, delta: Record<string, unknown>): StreamChunk[] {
	const handle = (provider as unknown as {
		handleBedrockEvent: (
			event: unknown,
			activeToolBlockIndices: Map<number, string>,
		) => Iterable<StreamChunk>;
	}).handleBedrockEvent.bind(provider);
	return [...handle({ contentBlockDelta: { delta, contentBlockIndex: 0 } }, new Map())];
}

describe("BedrockProvider — thinking reasoningContent deltas", () => {
	it("emits thinking_delta for reasoningContent.text (plaintext summary)", () => {
		const chunks = handleDelta(makeProvider(), { reasoningContent: { text: "Let me think" } });
		expect(chunks).toEqual([{ type: "thinking_delta", text: "Let me think" }]);
	});

	it("emits thinking_start for a signed reasoningContent blob with no text (Opus 4.8)", () => {
		const chunks = handleDelta(makeProvider(), { reasoningContent: { signature: "EoQCCm..." } });
		expect(chunks).toEqual([{ type: "thinking_start" }]);
	});

	it("emits thinking_start for a redacted reasoningContent blob", () => {
		const chunks = handleDelta(makeProvider(), { reasoningContent: { redactedContent: "…" } });
		expect(chunks).toEqual([{ type: "thinking_start" }]);
	});

	it("emits text_delta for a normal answer delta (no reasoning)", () => {
		const chunks = handleDelta(makeProvider(), { text: "answer" });
		expect(chunks).toEqual([{ type: "text_delta", text: "answer" }]);
	});
});
