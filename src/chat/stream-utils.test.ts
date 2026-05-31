import { describe, it, expect } from "vitest";

import { parseStreamEvents, type ParsedStreamEvent } from "./stream-utils";
import type { StreamChunk } from "../providers/provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* fromChunks(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
	for (const chunk of chunks) {
		yield chunk;
	}
}

async function collect(chunks: StreamChunk[], signal?: AbortSignal): Promise<ParsedStreamEvent[]> {
	const events: ParsedStreamEvent[] = [];
	const ac = signal ? { signal } : new AbortController();
	for await (const event of parseStreamEvents(fromChunks(chunks), ac.signal)) {
		events.push(event);
	}
	return events;
}

// ---------------------------------------------------------------------------
// thinking lifecycle normalization
// ---------------------------------------------------------------------------

describe("parseStreamEvents — thinking lifecycle", () => {
	it("emits exactly one thinking_started for an explicit thinking_start with no text", async () => {
		const events = await collect([
			{ type: "thinking_start" },
			{ type: "message_end", input_tokens: 1, output_tokens: 2 },
		]);

		const started = events.filter((e) => e.type === "thinking_started");
		expect(started).toHaveLength(1);
		expect(events.some((e) => e.type === "thinking_delta")).toBe(false);
	});

	it("synthesizes a single thinking_started when only deltas arrive (no explicit start)", async () => {
		const events = await collect([
			{ type: "thinking_delta", text: "a" },
			{ type: "thinking_delta", text: "b" },
		]);

		const started = events.filter((e) => e.type === "thinking_started");
		expect(started).toHaveLength(1);

		// The synthesized start must precede the first delta.
		expect(events[0]?.type).toBe("thinking_started");

		const deltas = events.filter(
			(e): e is Extract<ParsedStreamEvent, { type: "thinking_delta" }> => e.type === "thinking_delta",
		);
		expect(deltas.map((d) => d.delta)).toEqual(["a", "b"]);
		// `text` is the accumulated thinking content.
		expect(deltas.map((d) => d.text)).toEqual(["a", "ab"]);
	});

	it("does not re-fire thinking_started when a delta follows an explicit start (latch holds)", async () => {
		const events = await collect([
			{ type: "thinking_start" },
			{ type: "thinking_delta", text: "x" },
		]);

		const started = events.filter((e) => e.type === "thinking_started");
		expect(started).toHaveLength(1);
		expect(events[0]?.type).toBe("thinking_started");
	});

	it("does not emit thinking_started when there is no thinking at all", async () => {
		const events = await collect([
			{ type: "text_delta", text: "hello" },
			{ type: "message_end", input_tokens: 1, output_tokens: 2 },
		]);

		expect(events.some((e) => e.type === "thinking_started")).toBe(false);
	});
});
