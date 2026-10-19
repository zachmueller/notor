/**
 * Evaluator-set fingerprint — identifies WHICH evaluators (and which rubric /
 * instruction text) produced a pass, so two passes are only compared when they
 * ran the same evaluators. Any edit to an evaluator's dimensions, mode, judge,
 * body, or rubric changes the fingerprint; an older pass then shows as stale in
 * the picker, and the scheduler re-evaluates. Order-independent.
 */

import type { EvaluatorDefinition } from "../types";

/** 32-bit FNV-1a over a UTF-16 string, as unsigned. */
function fnv1a(text: string, seed: number): number {
	let hash = seed >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

/**
 * Hex fingerprint of an evaluator set. `rubricBodies` maps a rubric note path to
 * its body text (so a rubric edit changes the fingerprint even though the path
 * does not).
 */
export function evaluatorSetFingerprint(
	evaluators: readonly EvaluatorDefinition[],
	rubricBodies: Readonly<Record<string, string>> = {},
): string {
	const canonical = [...evaluators]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((e) =>
			JSON.stringify([
				e.name,
				e.mode,
				e.persona,
				e.subagent,
				e.model,
				e.dimensions,
				e.rubricPath,
				e.rubricPath ? (rubricBodies[e.rubricPath] ?? "") : "",
				e.bodyContent,
				e.includeNoteContents,
			]),
		)
		.join("\n");
	const a = fnv1a(canonical, 0x811c9dc5).toString(16).padStart(8, "0");
	const b = fnv1a(canonical, 0x9747b28c).toString(16).padStart(8, "0");
	return a + b;
}
