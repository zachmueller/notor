import { describe, it, expect, beforeEach } from "vitest";
import { recoverFromContextOverflow } from "./context-overflow-recovery";
import { getLearnedContextWindow, initModelLimits, resetModelLimits } from "../providers/model-limits";
import type { Message } from "../types";
import type { NotorSettings } from "../settings";

const settings = { compaction_threshold: 0.8 } as NotorSettings;

/** A conversation whose last assistant turn reported `inputTokens` of context. */
function conversation(inputTokens: number): Message[] {
	return [
		{ id: "1", conversation_id: "c", role: "user", content: "hi", timestamp: "t" },
		{ id: "2", conversation_id: "c", role: "assistant", content: "ok", timestamp: "t", input_tokens: inputTokens, output_tokens: 0 },
	] as Message[];
}

function recover(rawMessage: string, modelId: string, inputTokens: number, useExtendedContext = false) {
	return recoverFromContextOverflow({
		rawMessage,
		modelId,
		useExtendedContext,
		messages: conversation(inputTokens),
		settings,
	});
}

beforeEach(() => resetModelLimits());

describe("recoverFromContextOverflow", () => {
	it("returns no suggestion for non-overflow errors", () => {
		expect(recover("Too many tokens, please wait before trying again.", "m", 1_000)).toEqual({
			isOverflow: false,
			suggestion: "",
		});
	});

	it("learns 90% of the estimate when the message has no number", () => {
		// Inferred 1M model; the request (~300K) overflowed, so the real limit is lower.
		const r = recover("Input is too long for requested model.", "us.anthropic.claude-opus-5-5", 300_000);
		expect(r.recorded).toEqual({ tokens: 270_000, source: "estimate" });
		expect(getLearnedContextWindow("us.anthropic.claude-opus-5-5")).toBe(270_000);
		expect(r.suggestion).toContain("about 270,000 tokens");
		expect(r.suggestion).toContain("next message will compact");
	});

	it("learns nothing when the estimate already exceeds the window", () => {
		const r = recover("Input is too long for requested model.", "us.anthropic.claude-sonnet-4-6", 250_000);
		expect(r.recorded).toBeUndefined();
		expect(getLearnedContextWindow("us.anthropic.claude-sonnet-4-6")).toBeUndefined();
		expect(r.suggestion).toContain("next message will compact");
	});

	it("learns nothing below the minimum learned limit", () => {
		const r = recover("Input is too long for requested model.", "us.anthropic.claude-sonnet-4-6", 1_000);
		expect(r.recorded).toBeUndefined();
		expect(r.suggestion).toContain("Compact context");
	});

	it("does not re-record when the provider message carried a number", () => {
		const r = recover("prompt is too long: 250000 tokens > 200000 maximum", "us.anthropic.claude-opus-5-5", 250_000);
		expect(r.isOverflow).toBe(true);
		expect(r.recorded).toBeUndefined();
		expect(getLearnedContextWindow("us.anthropic.claude-opus-5-5")).toBeUndefined();
	});

	it("points at an oversized override instead of learning", () => {
		initModelLimits({ getOverrides: () => ({ "my-model": 2_000_000 }), persist: () => {} });
		const r = recover("Input is too long for requested model.", "my-model", 300_000);
		expect(r.recorded).toBeUndefined();
		expect(getLearnedContextWindow("my-model")).toBeUndefined();
		expect(r.suggestion).toContain("override");
	});
});
