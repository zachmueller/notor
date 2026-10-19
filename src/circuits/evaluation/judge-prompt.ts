/**
 * The user prompt an LLM judge receives. Pure (string in, string out) so it is
 * unit-testable and so the judge runner stays small.
 *
 * Deliberately NOT the step prompt scaffold (`StepPromptBuilder`): a judge is
 * not advancing a circuit, must not call `emit_event`, and reports through
 * `submit_score`. The sections mirror what the evaluator was promised ("option
 * a"): the objective, the terminal outcome, the structured return, and the
 * notes the run edited — never the step transcripts.
 */

import { codeFence } from "../failure-report";
import type { EvaluatorDefinition } from "../types";
import type { EvalInput } from "./types";

export interface BuildJudgePromptArgs {
	evaluator: EvaluatorDefinition;
	/** The evaluator body with `<include_note>` tags already resolved. */
	resolvedBody: string;
	/** The rubric note's body (frontmatter stripped), or `null` when none. */
	rubric: string | null;
	input: EvalInput;
	/** Appended on the single retry when the first turn ended without a `submit_score` call. */
	reminder?: boolean;
}

function describeDimension(d: EvaluatorDefinition["dimensions"][number]): string {
	const scale = d.type === "boolean" ? "true / false" : `${d.min}–${d.max} (number)`;
	const desc = d.description ? ` — ${d.description}` : "";
	return `- \`${d.name}\`: ${scale}${desc}`;
}

function fencedJson(value: unknown): string {
	try {
		return codeFence(JSON.stringify(value, null, 2) ?? "null");
	} catch {
		return codeFence("(unserializable)");
	}
}

export function buildJudgePrompt(args: BuildJudgePromptArgs): string {
	const { evaluator, resolvedBody, rubric, input } = args;
	const sections: string[] = [];

	sections.push(
		`## CIRCUIT EVALUATION\n\n` +
			`You are the evaluator **${evaluator.name}** for the circuit **${input.circuit.name}**` +
			(input.circuit.description ? ` (${input.circuit.description})` : "") +
			`. Score ONE finished run of this circuit. Do not redo the run's work, do not edit anything; ` +
			`read what you need, judge, and report.`,
	);

	const body = resolvedBody.trim();
	if (body) sections.push(`### EVALUATION TASK\n\n${body}`);

	if (rubric && rubric.trim()) sections.push(`### RUBRIC\n\n${rubric.trim()}`);

	sections.push(`### DIMENSIONS\n\nScore every dimension below:\n\n${evaluator.dimensions.map(describeDimension).join("\n")}`);

	sections.push(`### CIRCUIT OBJECTIVE\n\n${input.objective.trim() || "_(none recorded)_"}`);

	const o = input.outcome;
	const outcomeLines = [
		`- Status: **${o.status}** (terminal event \`${o.terminalTopic}\`)`,
		`- Session: \`${input.session.sessionId}\` started ${input.session.startedAt} (origin: ${input.session.origin})`,
		`- Step-turns: ${o.iterations}; run cost: $${o.costUsd.toFixed(4)}`,
	];
	if (o.source === "fallback") {
		outcomeLines.push(`- Note: this session predates the run.result record; the structured return is unavailable.`);
	}
	sections.push(
		`### RUN OUTCOME\n\n${outcomeLines.join("\n")}\n\n**Closing text:**\n\n${codeFence(o.text || "(empty)")}` +
			(o.structured !== null && o.structured !== undefined ? `\n\n**Structured return:**\n\n${fencedJson(o.structured)}` : ""),
	);

	if (input.notesEdited.length === 0) {
		sections.push(`### NOTES EDITED\n\n_(the run's steps edited no vault notes, or the record is unavailable)_`);
	} else {
		const list = input.notesEdited.map((p) => `- \`${p}\``).join("\n");
		const contents = input.noteContents
			.map((n) => {
				const flags: string[] = [];
				if (n.truncated) flags.push("truncated");
				if (n.mtimeAfterRun === true) flags.push("changed after the run finished");
				const flag = flags.length ? ` _(${flags.join("; ")})_` : "";
				return `#### \`${n.path}\`${flag}\n\n${codeFence(n.content)}`;
			})
			.join("\n\n");
		sections.push(
			`### NOTES EDITED\n\n${list}\n\n` +
				`The contents below are the notes' CURRENT state, which may differ from what the run wrote. ` +
				`Read any note directly with your tools if you need more than is shown.` +
				(contents ? `\n\n${contents}` : ""),
		);
	}

	sections.push(
		`### HOW TO REPORT\n\n` +
			`You MUST call the \`submit_score\` tool exactly once, with EVERY dimension listed above in \`scores\` ` +
			`and a concise \`rationale\` that cites evidence. Text alone is not a score. Do not call \`emit_event\`.`,
	);

	if (args.reminder) {
		sections.push(
			`### REMINDER\n\nYour previous attempt ended WITHOUT calling \`submit_score\`. Call it now with every dimension, then stop.`,
		);
	}

	return sections.join("\n\n");
}
