import { describe, it, expect, beforeEach } from "vitest";
import { noteContextOverflow, parseContextOverflow } from "./context-overflow";
import { getLearnedContextWindow, resetModelLimits } from "./model-limits";

beforeEach(() => resetModelLimits());

describe("parseContextOverflow — overflow messages", () => {
	const cases: Array<[string, string, number | undefined]> = [
		[
			"Anthropic prompt too long",
			'{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 215123 tokens > 200000 maximum"}}',
			200_000,
		],
		[
			"Bedrock-wrapped Anthropic",
			"The model returned the following errors: prompt is too long: 1,050,000 tokens > 1,000,000 maximum",
			1_000_000,
		],
		[
			"Anthropic input + max_tokens",
			"input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000, decrease input length or `max_tokens` and try again",
			200_000,
		],
		["Bedrock without a number", "Input is too long for requested model.", undefined],
		[
			"OpenAI maximum context length",
			"This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
			128_000,
		],
		["OpenAI error code only", '{"error":{"code":"context_length_exceeded"}}', undefined],
		["OpenAI configured limit", "Input tokens exceed the configured limit of 272000 tokens.", 272_000],
		[
			"llama.cpp context size",
			"request (5000 tokens) exceeds the available context size (4096 tokens), try increasing it",
			4_096,
		],
		[
			"llama.cpp JSON body",
			'{"error":{"type":"exceed_context_size_error","n_prompt_tokens":9000,"n_ctx":8192}}',
			8_192,
		],
		[
			"LM Studio",
			"Trying to keep the first 9000 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens",
			4_096,
		],
	];

	for (const [name, raw, limit] of cases) {
		it(`detects: ${name}`, () => {
			expect(parseContextOverflow(raw)).toEqual(limit === undefined ? { isOverflow: true } : { isOverflow: true, limit });
		});
	}
});

describe("parseContextOverflow — not overflows", () => {
	const negatives = [
		"Too many tokens, please wait before trying again.",
		"max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for claude-opus-5-5",
		'{"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
		"ValidationException: invalid beta flag",
		"",
	];
	for (const raw of negatives) {
		it(`ignores: ${raw || "(empty)"}`, () => {
			expect(parseContextOverflow(raw).isOverflow).toBe(false);
		});
	}

	it("ignores implausible limits but still flags the overflow", () => {
		expect(parseContextOverflow("prompt is too long: 900 tokens > 500 maximum")).toEqual({ isOverflow: true });
	});

	it("handles null and undefined", () => {
		expect(parseContextOverflow(null).isOverflow).toBe(false);
		expect(parseContextOverflow(undefined).isOverflow).toBe(false);
	});
});

describe("noteContextOverflow", () => {
	it("records a limit below the model's base window", () => {
		// Default-1M model (Opus 5.5 on Bedrock).
		const r = noteContextOverflow("us.anthropic.claude-opus-5-5", false, "prompt is too long: 250000 tokens > 200000 maximum");
		expect(r).toMatchObject({ isOverflow: true, limit: 200_000, recorded: true });
		expect(getLearnedContextWindow("us.anthropic.claude-opus-5-5", false)).toBe(200_000);
	});

	it("records under the ::1m key in extended mode", () => {
		noteContextOverflow("us.anthropic.claude-sonnet-4-6", true, "prompt is too long: 950000 tokens > 900000 maximum");
		expect(getLearnedContextWindow("us.anthropic.claude-sonnet-4-6", true)).toBe(900_000);
		expect(getLearnedContextWindow("us.anthropic.claude-sonnet-4-6", false)).toBeUndefined();
	});

	it("does not record a limit at or above the base window", () => {
		const r = noteContextOverflow("us.anthropic.claude-sonnet-4-6", false, "prompt is too long: 250000 tokens > 200000 maximum");
		expect(r.recorded).toBe(false);
		expect(getLearnedContextWindow("us.anthropic.claude-sonnet-4-6", false)).toBeUndefined();
	});

	it("records nothing when the message has no number", () => {
		const r = noteContextOverflow("us.anthropic.claude-opus-5-5", false, "Input is too long for requested model.");
		expect(r).toMatchObject({ isOverflow: true, recorded: false });
		expect(getLearnedContextWindow("us.anthropic.claude-opus-5-5", false)).toBeUndefined();
	});
});
