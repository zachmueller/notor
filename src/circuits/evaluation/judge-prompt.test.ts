import { describe, it, expect } from "vitest";
import { buildJudgePrompt } from "./judge-prompt";
import type { EvaluatorDefinition } from "../types";
import type { EvalInput } from "./types";

const evaluator: EvaluatorDefinition = {
	name: "Report quality",
	description: "",
	mode: "conversation",
	persona: null,
	subagent: null,
	model: null,
	rubricPath: null,
	dimensions: [
		{ name: "accuracy", type: "numeric", min: 1, max: 5, description: "Facts check out" },
		{ name: "cited", type: "boolean", min: 0, max: 1, description: null },
	],
	timeoutSeconds: null,
	includeNoteContents: true,
	bodyContent: "",
	notePath: "c/evals/judge.md",
};

const input: EvalInput = {
	circuit: { name: "Research", description: "Looks things up" },
	session: { sessionId: "s1", startedAt: "2026-10-18T09:00:00Z", origin: "user", sessionDir: "d" },
	objective: "Find out about X",
	outcome: {
		status: "completed",
		terminalTopic: "FLOW_COMPLETE",
		text: "Here is the report.",
		structured: { findings: ["a"] },
		costUsd: 0.1234,
		tokenUsage: { input: 1, output: 1 },
		iterations: 3,
		source: "run.result",
	},
	notesEdited: ["out/report.md"],
	noteContents: [{ path: "out/report.md", content: "# Report\nbody", truncated: true, mtimeAfterRun: true }],
	evaluator: { name: "Report quality", dimensions: evaluator.dimensions },
};

describe("buildJudgePrompt", () => {
	it("lays out every section the evaluator was promised, and the submit_score contract", () => {
		const prompt = buildJudgePrompt({ evaluator, resolvedBody: "Judge against the rubric.", rubric: "# Rubric\nBe strict.", input });
		for (const heading of ["## CIRCUIT EVALUATION", "### EVALUATION TASK", "### RUBRIC", "### DIMENSIONS", "### CIRCUIT OBJECTIVE", "### RUN OUTCOME", "### NOTES EDITED", "### HOW TO REPORT"]) {
			expect(prompt).toContain(heading);
		}
		expect(prompt).toContain("`accuracy`: 1–5 (number) — Facts check out");
		expect(prompt).toContain("`cited`: true / false");
		expect(prompt).toContain("Find out about X");
		expect(prompt).toContain("Status: **completed**");
		expect(prompt).toContain('"findings"');
		expect(prompt).toContain("`out/report.md`");
		expect(prompt).toContain("truncated; changed after the run finished");
		expect(prompt).toContain("CURRENT state");
		expect(prompt).toContain("`submit_score` tool exactly once");
		expect(prompt).not.toContain("### REMINDER");
	});

	it("omits empty task/rubric sections, notes the legacy fallback, and appends the reminder on retry", () => {
		const prompt = buildJudgePrompt({
			evaluator,
			resolvedBody: "   ",
			rubric: null,
			input: { ...input, outcome: { ...input.outcome, structured: null, source: "fallback" }, notesEdited: [], noteContents: [] },
			reminder: true,
		});
		expect(prompt).not.toContain("### EVALUATION TASK");
		expect(prompt).not.toContain("### RUBRIC");
		expect(prompt).not.toContain("Structured return");
		expect(prompt).toContain("predates the run.result record");
		expect(prompt).toContain("edited no vault notes");
		expect(prompt).toContain("### REMINDER");
	});
});
