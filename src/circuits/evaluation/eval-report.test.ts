import { describe, it, expect } from "vitest";
import type { SessionFs } from "../session-manager";
import { buildEvalReportMarkdown, evalReportPath, overallKey, scoreKey, writeEvalReport } from "./eval-report";
import type { EvalSessionResult } from "./types";

class FakeFs implements SessionFs {
	files = new Map<string, string>();
	async exists(p: string) {
		return this.files.has(p);
	}
	async mkdir() {}
	async write(p: string, data: string) {
		this.files.set(p, data);
	}
	async read(p: string) {
		const v = this.files.get(p);
		if (v === undefined) throw new Error(`ENOENT: ${p}`);
		return v;
	}
}

const pass = { passId: "pass-abc", circuit: "Research Flow", trigger: "manual" as const, fingerprint: "fp1", finishedAt: "2026-10-18T12:00:00.000Z" };

const session: EvalSessionResult = {
	sessionId: "sess-1",
	meta: {
		session_id: "sess-1",
		flow_name: "Research Flow",
		status: "completed",
		iteration: 4,
		active_step: null,
		started_at: "2026-10-18T11:00:00.000Z",
		prompt: "Research X",
		parent_session_id: null,
		origin: "user",
	},
	outcome: {
		status: "completed",
		terminalTopic: "FLOW_COMPLETE",
		text: "Report written.",
		structured: { report: "out/report.md" },
		costUsd: 0.5,
		tokenUsage: { input: 10, output: 5 },
		iterations: 4,
		source: "run.result",
	},
	outcomes: [
		{ evaluator: "Report quality", mode: "conversation", ok: true, scores: { accuracy: 4, "cited sources": true }, rationale: "Well cited.", overall: 4.5, costUsd: 0.12, modelId: "m1" },
		{ evaluator: "Shape", mode: "code", ok: true, scores: { completed: true }, rationale: "status ok", overall: null, costUsd: 0, modelId: null },
		{ evaluator: "Slow judge", mode: "conversation", ok: false, reason: "budget", detail: "exhausted", costUsd: 0.03, modelId: "m2" },
	],
	skipped: null,
	reportPath: null,
};

describe("eval report", () => {
	it("builds the path under the sticky data root with circuit slug, session, and pass", () => {
		expect(evalReportPath("notor/", "circuits", "Research Flow", "sess-1", "pass-abc")).toBe("notor/circuits/evals/research-flow-sess-1-pass-abc.md");
		expect(evalReportPath("notor", "orchestrations", "X", "s", "p")).toBe("notor/orchestrations/evals/x-s-p.md");
		expect(scoreKey("Report quality", "cited sources")).toBe("notor-score-report-quality-cited-sources");
		expect(overallKey("Report quality")).toBe("notor-overall-report-quality");
	});

	it("writes flat frontmatter scores plus pass/run metadata, and a readable body", () => {
		const md = buildEvalReportMarkdown({ pass, session });
		const fm = md.slice(0, md.indexOf("\n---\n", 4) + 5);
		for (const line of [
			"notor-type: circuit-eval-report",
			'notor-circuit: "Research Flow"',
			'notor-session-id: "sess-1"',
			'notor-eval-pass-id: "pass-abc"',
			'notor-eval-trigger: "manual"',
			'notor-eval-fingerprint: "fp1"',
			'notor-eval-evaluators: ["Report quality", "Shape", "Slow judge"]',
			'notor-eval-failed: ["Slow judge"]',
			'notor-eval-models: ["m1", "m2"]',
			"notor-eval-cost-usd: 0.1500",
			'notor-run-status: "completed"',
			'notor-run-origin: "user"',
			"notor-run-iterations: 4",
			"notor-run-cost-usd: 0.5000",
			"notor-score-report-quality-accuracy: 4",
			"notor-score-report-quality-cited-sources: true",
			"notor-overall-report-quality: 4.5",
			"notor-score-shape-completed: true",
		]) {
			expect(fm).toContain(line);
		}
		expect(fm).not.toContain("notor-overall-shape");

		expect(md).toContain("# Circuit evaluation: Research Flow");
		expect(md).toContain("## Objective\n\nResearch X");
		expect(md).toContain("Status:** completed (terminal event `FLOW_COMPLETE`)");
		expect(md).toContain('"report": "out/report.md"');
		expect(md).toContain("| Report quality | accuracy | 4 |");
		expect(md).toContain("| Report quality | _overall_ | 4.5 |");
		expect(md).toContain("### Report quality (`m1`)\n\nWell cited.");
		expect(md).toContain("| Slow judge | `budget` | exhausted |");
		expect(md).toContain("sessions/sess-1/evals.jsonl");
	});

	it("notes the legacy fallback and handles a session with no scores", () => {
		const md = buildEvalReportMarkdown({
			pass,
			session: { ...session, outcome: { ...session.outcome!, structured: null, source: "fallback" }, outcomes: [session.outcomes[2]!] },
		});
		expect(md).toContain("predates the run.result record");
		expect(md).toContain("_(no evaluator produced a score)_");
		expect(md).not.toContain("Structured return");
	});

	it("writeEvalReport writes to the computed path", async () => {
		const fs = new FakeFs();
		const path = await writeEvalReport({ notorDir: "notor", fs, rootName: "circuits", pass, session });
		expect(path).toBe("notor/circuits/evals/research-flow-sess-1-pass-abc.md");
		expect(fs.files.get(path)).toContain("notor-type: circuit-eval-report");
	});
});
