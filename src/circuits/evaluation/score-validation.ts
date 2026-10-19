/**
 * Score validation against an evaluator's declared dimensions. Shared by the
 * judge runner (post-turn, in case a customized `submit_score` scaffold let a
 * bad value through) and the code-evaluator runner (the snippet's return value).
 */

import type { EvalDimension } from "../types";
import type { SubmittedScore } from "./types";

export type ScoreValidation = { ok: true; value: SubmittedScore } | { ok: false; errors: string[] };

export function validateScores(dimensions: readonly EvalDimension[], submitted: unknown): ScoreValidation {
	const errors: string[] = [];
	if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
		return { ok: false, errors: ["expected an object with `scores` and `rationale`"] };
	}
	const rec = submitted as Record<string, unknown>;
	const scores = rec["scores"];
	if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
		errors.push("`scores` must be an object mapping dimension name to value");
	}
	const rationale = rec["rationale"];
	if (typeof rationale !== "string" || rationale.trim() === "") {
		errors.push("`rationale` must be a non-empty string");
	}
	const overall = rec["overall"];
	if (overall !== undefined && overall !== null && (typeof overall !== "number" || !Number.isFinite(overall))) {
		errors.push("`overall` must be a finite number when provided");
	}
	if (errors.length > 0) return { ok: false, errors };

	const scoreMap = scores as Record<string, unknown>;
	const byName = new Map(dimensions.map((d) => [d.name, d]));
	const out: Record<string, number | boolean> = {};
	for (const [name, value] of Object.entries(scoreMap)) {
		const dim = byName.get(name);
		if (!dim) {
			errors.push(`unknown dimension '${name}'`);
			continue;
		}
		if (dim.type === "boolean") {
			if (typeof value !== "boolean") errors.push(`'${name}' must be true or false`);
			else out[name] = value;
		} else if (typeof value !== "number" || !Number.isFinite(value)) {
			errors.push(`'${name}' must be a number`);
		} else if (value < dim.min || value > dim.max) {
			errors.push(`'${name}' must be within ${dim.min}..${dim.max} (got ${value})`);
		} else {
			out[name] = value;
		}
	}
	for (const dim of dimensions) {
		if (!Object.prototype.hasOwnProperty.call(scoreMap, dim.name)) errors.push(`missing dimension '${dim.name}'`);
	}
	if (errors.length > 0) return { ok: false, errors };

	const value: SubmittedScore = { scores: out, rationale: (rationale as string).trim() };
	if (typeof overall === "number") value.overall = overall;
	return { ok: true, value };
}
