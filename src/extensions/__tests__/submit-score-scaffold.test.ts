import { describe, it, expect } from "vitest";
import { SUBMIT_SCORE } from "../builtin-tool-scaffolds/submit-score";
import { extractCodeFence } from "../parser";
import { compileExtension } from "../compiler";

// Compile the real submit_score scaffold body and run it against a fake carriage.
// Invocation order: fn(app, obsidian, utils, libs, settings, shared, params).

function compileScaffold() {
	const fence = extractCodeFence(SUBMIT_SCORE.scaffoldContent);
	if (!fence) throw new Error("No code fence found in scaffold");
	const compiled = compileExtension(fence.code, "tool");
	if ("error" in compiled) throw new Error(compiled.error);
	return compiled.fn;
}

interface Evaluation {
	evaluatorName: string;
	dimensions: Array<{ name: string; type: "numeric" | "boolean"; min: number; max: number }>;
	pendingScore: unknown;
}

function evaluation(): Evaluation {
	return {
		evaluatorName: "Judge",
		dimensions: [
			{ name: "accuracy", type: "numeric", min: 1, max: 5 },
			{ name: "cited", type: "boolean", min: 0, max: 1 },
		],
		pendingScore: null,
	};
}

async function submit(ctx: { evaluation?: Evaluation } | null, params: Record<string, unknown>): Promise<unknown> {
	const fn = compileScaffold();
	return fn({}, {}, { orchestrationContext: ctx }, {}, {}, {}, params);
}

describe("submit_score scaffold", () => {
	it("is a read-mode circuits tool", () => {
		expect(SUBMIT_SCORE.mode).toBe("read");
		expect(SUBMIT_SCORE.featureGroup).toBe("circuits");
		expect(SUBMIT_SCORE.scaffoldContent).toContain("required: [scores, rationale]");
	});

	it("refuses outside an evaluator turn", async () => {
		expect(await submit(null, { scores: {}, rationale: "r" })).toMatchObject({ __toolError: true });
		expect(await submit({}, { scores: {}, rationale: "r" })).toMatchObject({ __toolError: true, error: expect.stringMatching(/evaluator turn/) });
	});

	it("records a valid submission (with optional overall) on the carriage", async () => {
		const ev = evaluation();
		const result = await submit({ evaluation: ev }, { scores: { accuracy: 4, cited: true }, rationale: "good", overall: 4.5 });
		expect(typeof result).toBe("string");
		expect(result).toContain("Judge");
		expect(ev.pendingScore).toEqual({ scores: { accuracy: 4, cited: true }, rationale: "good", overall: 4.5 });
		await submit({ evaluation: ev }, { scores: { accuracy: 2, cited: false }, rationale: "revised" });
		expect(ev.pendingScore).toEqual({ scores: { accuracy: 2, cited: false }, rationale: "revised" });
	});

	it("rejects missing scores / rationale", async () => {
		const ev = evaluation();
		expect(await submit({ evaluation: ev }, { rationale: "r" })).toMatchObject({ __toolError: true, error: expect.stringMatching(/scores/) });
		expect(await submit({ evaluation: ev }, { scores: { accuracy: 3, cited: true }, rationale: "" })).toMatchObject({ __toolError: true, error: expect.stringMatching(/rationale/) });
		expect(ev.pendingScore).toBeNull();
	});

	it("names every problem and lists the declared dimensions so the model can retry", async () => {
		const ev = evaluation();
		const result = (await submit({ evaluation: ev }, { scores: { accuracy: 7, cited: "yes", bogus: 1 }, rationale: "r", overall: "x" })) as { error: string };
		expect(result).toMatchObject({ __toolError: true });
		expect(result.error).toMatch(/'accuracy' must be within 1\.\.5/);
		expect(result.error).toMatch(/'cited' must be true or false/);
		expect(result.error).toMatch(/unknown dimension 'bogus'/);
		expect(result.error).toMatch(/'overall' must be a number/);
		expect(result.error).toMatch(/Declared dimensions: accuracy \(1\.\.5\), cited \(true\/false\)/);
		expect(ev.pendingScore).toBeNull();
	});

	it("rejects a submission missing a declared dimension", async () => {
		const ev = evaluation();
		const result = (await submit({ evaluation: ev }, { scores: { accuracy: 3 }, rationale: "r" })) as { error: string };
		expect(result.error).toMatch(/missing dimension 'cited'/);
	});
});
