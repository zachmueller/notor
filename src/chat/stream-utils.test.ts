import { describe, it, expect, vi } from "vitest";

import { parseStreamEvents, type ParsedStreamEvent, type ParseStreamOpts } from "./stream-utils";
import type { StreamChunk } from "../providers/provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* fromChunks(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
	for (const chunk of chunks) {
		yield chunk;
	}
}

async function collect(
	chunks: StreamChunk[],
	signal?: AbortSignal,
	opts?: ParseStreamOpts,
): Promise<ParsedStreamEvent[]> {
	const events: ParsedStreamEvent[] = [];
	const ac = signal ? { signal } : new AbortController();
	for await (const event of parseStreamEvents(fromChunks(chunks), ac.signal, opts)) {
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

// ---------------------------------------------------------------------------
// partial tool-call content preservation (diagnostic stage)
// ---------------------------------------------------------------------------

describe("parseStreamEvents — partial tool-call preservation", () => {
	it("spills the accumulated JSON and surfaces the path on a parse failure", async () => {
		const onPartialToolCall = vi.fn().mockResolvedValue("/tmp/notor-spillover/x.txt");
		const events = await collect(
			[
				{ type: "tool_call_start", id: "t1", tool_name: "write_note" },
				{ type: "tool_call_delta", id: "t1", partial_json: '{"path":"a.md","content":"hello' },
				{ type: "tool_call_end", id: "t1" },
			],
			undefined,
			{ onPartialToolCall },
		);

		expect(onPartialToolCall).toHaveBeenCalledTimes(1);
		expect(onPartialToolCall).toHaveBeenCalledWith({
			toolName: "write_note",
			partialJson: '{"path":"a.md","content":"hello',
			reason: "parse_failure",
		});

		expect(events.some((e) => e.type === "tool_call")).toBe(false);
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		expect((last as Extract<ParsedStreamEvent, { type: "error" }>).message).toContain(
			"/tmp/notor-spillover/x.txt",
		);
	});

	it("still errors (without throwing) on a parse failure when no spill callback is given", async () => {
		const events = await collect([
			{ type: "tool_call_start", id: "t1", tool_name: "write_note" },
			{ type: "tool_call_delta", id: "t1", partial_json: "{not valid" },
			{ type: "tool_call_end", id: "t1" },
		]);

		expect(events.some((e) => e.type === "tool_call")).toBe(false);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("preserves an unfinished tool call when the stream ends with stop_reason=length and no tool_call_end", async () => {
		const onPartialToolCall = vi.fn().mockResolvedValue("/tmp/spill.txt");
		const events = await collect(
			[
				{ type: "tool_call_start", id: "t1", tool_name: "write_note" },
				{ type: "tool_call_delta", id: "t1", partial_json: '{"path":"a.md","content":"abc' },
				{ type: "message_end", input_tokens: 1, output_tokens: 2, stop_reason: "length" },
				// NOTE: no tool_call_end — provider hit the output ceiling mid-call.
			],
			undefined,
			{ onPartialToolCall },
		);

		expect(onPartialToolCall).toHaveBeenCalledWith({
			toolName: "write_note",
			partialJson: '{"path":"a.md","content":"abc',
			reason: "max_tokens",
		});
		expect(events.some((e) => e.type === "tool_call")).toBe(false);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("classifies an unfinished call with no stop reason as truncated_stream", async () => {
		const onPartialToolCall = vi.fn().mockResolvedValue(undefined);
		const events = await collect(
			[
				{ type: "tool_call_start", id: "t1", tool_name: "write_note" },
				{ type: "tool_call_delta", id: "t1", partial_json: '{"path":"a.md"' },
				// stream simply ends — no message_end, no tool_call_end.
			],
			undefined,
			{ onPartialToolCall },
		);

		expect(onPartialToolCall).toHaveBeenCalledWith({
			toolName: "write_note",
			partialJson: '{"path":"a.md"',
			reason: "truncated_stream",
		});
		expect(events.at(-1)?.type).toBe("error");
	});

	it("does NOT treat a user abort as truncation (cancelled, no spill)", async () => {
		const onPartialToolCall = vi.fn();
		const ac = new AbortController();
		ac.abort();

		const events = await collect(
			[
				{ type: "tool_call_start", id: "t1", tool_name: "write_note" },
				{ type: "tool_call_delta", id: "t1", partial_json: '{"path":"a.md"' },
			],
			ac.signal,
			{ onPartialToolCall },
		);

		expect(onPartialToolCall).not.toHaveBeenCalled();
		expect(events.some((e) => e.type === "error")).toBe(false);
		expect(events.at(-1)?.type).toBe("cancelled");
	});

	it("does not leak a finalized call's JSON into a later truncated call's spill", async () => {
		const onPartialToolCall = vi.fn().mockResolvedValue("/tmp/spill.txt");
		const events = await collect(
			[
				// First call parses cleanly.
				{ type: "tool_call_start", id: "t1", tool_name: "read_note" },
				{ type: "tool_call_delta", id: "t1", partial_json: '{"path":"a.md"}' },
				{ type: "tool_call_end", id: "t1" },
				// Second call is truncated.
				{ type: "tool_call_start", id: "t2", tool_name: "write_note" },
				{ type: "tool_call_delta", id: "t2", partial_json: '{"path":"b.md","content":"xyz' },
				{ type: "message_end", input_tokens: 1, output_tokens: 2, stop_reason: "length" },
			],
			undefined,
			{ onPartialToolCall },
		);

		// The first call still finalizes normally.
		expect(events.some((e) => e.type === "tool_call")).toBe(true);
		// The spill carries ONLY the second call's JSON — no leakage from the first.
		expect(onPartialToolCall).toHaveBeenCalledTimes(1);
		expect(onPartialToolCall).toHaveBeenCalledWith({
			toolName: "write_note",
			partialJson: '{"path":"b.md","content":"xyz',
			reason: "max_tokens",
		});
	});
});

// ---------------------------------------------------------------------------
// recovered-path guidance (turns preservation into actionable steering)
// ---------------------------------------------------------------------------

/** Pull the final `error` event's message out of a collected stream. */
function lastErrorMessage(events: ParsedStreamEvent[]): string {
	const last = events.at(-1);
	expect(last?.type).toBe("error");
	return (last as Extract<ParsedStreamEvent, { type: "error" }>).message;
}

describe("parseStreamEvents — recovered-path guidance", () => {
	it("recovers the path and includes skeleton-first steps for a truncated write_note", async () => {
		const events = await collect([
			{ type: "tool_call_start", id: "t1", tool_name: "write_note" },
			{
				type: "tool_call_delta",
				id: "t1",
				partial_json: '{"path":"Notes/Big note.md","content":"# Heading\\n\\nlots of text',
			},
			{ type: "tool_call_end", id: "t1" },
		]);

		const message = lastErrorMessage(events);
		expect(message).toContain("Recovered target path: Notes/Big note.md.");
		// Steers toward the skeleton → replace_in_note → update_frontmatter workaround.
		expect(message).toContain("write_note a skeleton");
		expect(message).toContain("replace_in_note");
		expect(message).toContain("update_frontmatter");
	});

	it("recovers the path from a max_tokens-truncated stream (no tool_call_end)", async () => {
		const events = await collect([
			{ type: "tool_call_start", id: "t1", tool_name: "write_note" },
			{ type: "tool_call_delta", id: "t1", partial_json: '{"path":"a.md","content":"abc' },
			{ type: "message_end", input_tokens: 1, output_tokens: 2, stop_reason: "length" },
		]);

		expect(lastErrorMessage(events)).toContain("Recovered target path: a.md.");
	});

	it("un-escapes an escaped quote in the recovered path", async () => {
		const events = await collect([
			{ type: "tool_call_start", id: "t1", tool_name: "write_note" },
			{
				type: "tool_call_delta",
				id: "t1",
				partial_json: '{"path":"weird\\"name.md","content":"x',
			},
			{ type: "tool_call_end", id: "t1" },
		]);

		expect(lastErrorMessage(events)).toContain('Recovered target path: weird"name.md.');
	});

	it("names the path but omits skeleton steps for a non-write tool", async () => {
		const events = await collect([
			{ type: "tool_call_start", id: "t1", tool_name: "read_note" },
			{ type: "tool_call_delta", id: "t1", partial_json: '{"path":"a.md","extra":"trunc' },
			{ type: "tool_call_end", id: "t1" },
		]);

		const message = lastErrorMessage(events);
		expect(message).toContain("Recovered target path: a.md.");
		expect(message).not.toContain("write_note a skeleton");
	});

	it("omits the recovered-path line when path itself was cut off mid-value", async () => {
		const events = await collect([
			{ type: "tool_call_start", id: "t1", tool_name: "write_note" },
			{ type: "tool_call_delta", id: "t1", partial_json: '{"path":"Notes/unfini' },
			{ type: "tool_call_end", id: "t1" },
		]);

		expect(lastErrorMessage(events)).not.toContain("Recovered target path");
	});
});
