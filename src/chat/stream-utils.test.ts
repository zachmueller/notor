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

// ---------------------------------------------------------------------------
// streaming tool calls
// ---------------------------------------------------------------------------

describe("parseStreamEvents — streaming tool calls", () => {
	it("emits tool_call_started (name only) before the finalized tool_call", async () => {
		const events = await collect([
			{ type: "tool_call_start", id: "t1", tool_name: "read_note" },
			{ type: "tool_call_delta", id: "t1", partial_json: '{"path":"a.md"}' },
			{ type: "tool_call_end", id: "t1" },
			{ type: "message_end", input_tokens: 1, output_tokens: 2 },
		]);

		const startedIdx = events.findIndex((e) => e.type === "tool_call_started");
		const callIdx = events.findIndex((e) => e.type === "tool_call");

		expect(startedIdx).toBeGreaterThanOrEqual(0);
		expect(callIdx).toBeGreaterThan(startedIdx);

		const started = events[startedIdx] as Extract<ParsedStreamEvent, { type: "tool_call_started" }>;
		expect(started).toEqual({ type: "tool_call_started", id: "t1", name: "read_note" });
		// The start event carries no parameters.
		expect("parameters" in started).toBe(false);

		const call = events[callIdx] as Extract<ParsedStreamEvent, { type: "tool_call" }>;
		expect(call).toEqual({
			type: "tool_call",
			id: "t1",
			name: "read_note",
			parameters: { path: "a.md" },
		});
	});

	it("emits a paired tool_call_started + tool_call for each of N concurrent calls", async () => {
		const events = await collect([
			{ type: "tool_call_start", id: "t1", tool_name: "read_note" },
			{ type: "tool_call_delta", id: "t1", partial_json: '{"path":"a.md"}' },
			{ type: "tool_call_end", id: "t1" },
			{ type: "tool_call_start", id: "t2", tool_name: "list_notes" },
			{ type: "tool_call_delta", id: "t2", partial_json: "{}" },
			{ type: "tool_call_end", id: "t2" },
			{ type: "message_end", input_tokens: 1, output_tokens: 2 },
		]);

		const started = events.filter(
			(e): e is Extract<ParsedStreamEvent, { type: "tool_call_started" }> => e.type === "tool_call_started",
		);
		const calls = events.filter(
			(e): e is Extract<ParsedStreamEvent, { type: "tool_call" }> => e.type === "tool_call",
		);

		expect(started.map((s) => s.id)).toEqual(["t1", "t2"]);
		expect(calls.map((c) => c.id)).toEqual(["t1", "t2"]);
		expect(calls.map((c) => c.name)).toEqual(["read_note", "list_notes"]);
	});

	it("emits tool_call_started then error (no tool_call) on malformed JSON", async () => {
		const events = await collect([
			{ type: "tool_call_start", id: "t1", tool_name: "read_note" },
			{ type: "tool_call_delta", id: "t1", partial_json: "{not valid json" },
			{ type: "tool_call_end", id: "t1" },
		]);

		const started = events.filter((e) => e.type === "tool_call_started");
		expect(started).toHaveLength(1);

		expect(events.some((e) => e.type === "tool_call")).toBe(false);
		expect(events.at(-1)?.type).toBe("error");
	});
});
