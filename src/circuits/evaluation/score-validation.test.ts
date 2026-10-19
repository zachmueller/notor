import { describe, it, expect } from "vitest";
import { validateScores } from "./score-validation";
import type { EvalDimension } from "../types";

const DIMS: EvalDimension[] = [
	{ name: "accuracy", type: "numeric", min: 1, max: 5, description: null },
	{ name: "cited", type: "boolean", min: 0, max: 1, description: null },
];

describe("validateScores", () => {
	it("accepts a complete, in-range submission and normalizes it", () => {
		const v = validateScores(DIMS, { scores: { accuracy: 4, cited: true }, rationale: "  solid  ", overall: 4.2 });
		expect(v).toEqual({ ok: true, value: { scores: { accuracy: 4, cited: true }, rationale: "solid", overall: 4.2 } });
	});

	it("omits overall when not provided", () => {
		const v = validateScores(DIMS, { scores: { accuracy: 1, cited: false }, rationale: "r" });
		expect(v.ok && v.value.overall).toBeUndefined();
	});

	it("rejects non-object, missing scores, empty rationale, non-numeric overall", () => {
		expect(validateScores(DIMS, null)).toMatchObject({ ok: false });
		expect(validateScores(DIMS, "x")).toMatchObject({ ok: false });
		expect(validateScores(DIMS, { rationale: "r" })).toMatchObject({ ok: false, errors: [expect.stringMatching(/`scores`/)] });
		expect(validateScores(DIMS, { scores: {}, rationale: "" })).toMatchObject({ ok: false, errors: [expect.stringMatching(/rationale/)] });
		expect(validateScores(DIMS, { scores: { accuracy: 3, cited: true }, rationale: "r", overall: "high" })).toMatchObject({
			ok: false,
			errors: [expect.stringMatching(/overall/)],
		});
	});

	it("reports range, type, unknown, and missing dimension problems together", () => {
		const v = validateScores(DIMS, { scores: { accuracy: 9, cited: "yes", extra: 1 }, rationale: "r" });
		expect(v.ok).toBe(false);
		if (!v.ok) {
			expect(v.errors).toEqual(
				expect.arrayContaining([
					expect.stringMatching(/'accuracy' must be within 1\.\.5/),
					expect.stringMatching(/'cited' must be true or false/),
					expect.stringMatching(/unknown dimension 'extra'/),
				]),
			);
		}
		expect(validateScores(DIMS, { scores: { accuracy: 3 }, rationale: "r" })).toMatchObject({
			ok: false,
			errors: [expect.stringMatching(/missing dimension 'cited'/)],
		});
		expect(validateScores(DIMS, { scores: { accuracy: NaN, cited: true }, rationale: "r" })).toMatchObject({
			ok: false,
			errors: [expect.stringMatching(/'accuracy' must be a number/)],
		});
	});
});
