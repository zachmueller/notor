import { describe, it, expect } from "vitest";
import { evaluatorSetFingerprint } from "./evaluator-fingerprint";
import type { EvaluatorDefinition } from "../types";

function evaluator(over: Partial<EvaluatorDefinition> = {}): EvaluatorDefinition {
	return {
		name: "judge",
		description: "",
		mode: "conversation",
		persona: "critic",
		subagent: null,
		model: null,
		rubricPath: "c/evals/_rubric.md",
		dimensions: [{ name: "accuracy", type: "numeric", min: 1, max: 5, description: null }],
		timeoutSeconds: null,
		includeNoteContents: true,
		bodyContent: "Judge it.",
		notePath: "c/evals/judge.md",
		...over,
	};
}

describe("evaluatorSetFingerprint", () => {
	it("is stable and order-independent", () => {
		const a = evaluator();
		const b = evaluator({ name: "shape", mode: "code", rubricPath: null, bodyContent: "```ts\nreturn 1\n```" });
		const bodies = { "c/evals/_rubric.md": "Be strict." };
		expect(evaluatorSetFingerprint([a, b], bodies)).toBe(evaluatorSetFingerprint([b, a], bodies));
		expect(evaluatorSetFingerprint([a, b], bodies)).toMatch(/^[0-9a-f]{16}$/);
	});

	it("changes when the rubric body, instructions, dimensions, judge, or model change", () => {
		const base = evaluatorSetFingerprint([evaluator()], { "c/evals/_rubric.md": "Be strict." });
		expect(evaluatorSetFingerprint([evaluator()], { "c/evals/_rubric.md": "Be lenient." })).not.toBe(base);
		expect(evaluatorSetFingerprint([evaluator({ bodyContent: "Judge harder." })], { "c/evals/_rubric.md": "Be strict." })).not.toBe(base);
		expect(
			evaluatorSetFingerprint([evaluator({ dimensions: [{ name: "accuracy", type: "numeric", min: 1, max: 10, description: null }] })], {
				"c/evals/_rubric.md": "Be strict.",
			}),
		).not.toBe(base);
		expect(evaluatorSetFingerprint([evaluator({ persona: "other" })], { "c/evals/_rubric.md": "Be strict." })).not.toBe(base);
		expect(evaluatorSetFingerprint([evaluator({ model: "gpt-x" })], { "c/evals/_rubric.md": "Be strict." })).not.toBe(base);
	});

	it("ignores fields that do not affect judgement (description, notePath)", () => {
		const base = evaluatorSetFingerprint([evaluator()]);
		expect(evaluatorSetFingerprint([evaluator({ description: "renamed", notePath: "elsewhere.md" })])).toBe(base);
	});
});
