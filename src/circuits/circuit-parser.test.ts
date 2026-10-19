/**
 * TEST-003 — `CircuitDefinitionParser` + `StepNoteParser` unit tests (FEAT-002).
 *
 * Fixtures are fed through a fake Vault + MetadataCache that mirror the real
 * `metadataCache.getFileCache()` / `vault.read()` / `getAbstractFileByPath()`
 * surfaces the parser uses — no real vault. Mirrors the workflow-discovery test
 * fixturing pattern.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — TEST-003
 */

import { describe, it, expect } from "vitest";
import { TFile, TFolder } from "obsidian";
import {
	DEFAULT_MAX_COST_USD,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_MAX_RUNTIME_MINUTES,
} from "./constants";
import { CircuitDefinitionParser, CircuitParseError } from "./circuit-parser";
import { FLOW_COMPLETE } from "./types";

// ---------------------------------------------------------------------------
// Fake vault + metadata cache
// ---------------------------------------------------------------------------

interface FileFixture {
	frontmatter: Record<string, unknown> | null;
	body: string;
}

/**
 * Build a fake Vault + MetadataCache from a `{ path → fixture }` map. Files are
 * exposed via `getAbstractFileByPath`; their containing folders are synthesized
 * (so `orchestrations/` lists its child flow directories). Frontmatter is served
 * from the cache; `vault.read()` returns frontmatter + body.
 */
function buildFakeVault(files: Record<string, FileFixture>) {
	const fileObjs = new Map<string, TFile>();
	const folderObjs = new Map<string, TFolder>();

	function ensureFolder(path: string): TFolder {
		if (path === "") path = "";
		let folder = folderObjs.get(path);
		if (!folder) {
			folder = new TFolder();
			folder.path = path;
			folder.name = path.split("/").pop() ?? path;
			folder.children = [];
			folderObjs.set(path, folder);
			if (path !== "") {
				const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
				const parent = ensureFolder(parentPath);
				if (!parent.children.includes(folder)) parent.children.push(folder);
			}
		}
		return folder;
	}

	for (const path of Object.keys(files)) {
		const file = new TFile();
		file.path = path;
		file.name = path.split("/").pop() ?? path;
		file.extension = "md";
		fileObjs.set(path, file);
		const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		const parent = ensureFolder(parentPath);
		if (!parent.children.includes(file)) parent.children.push(file);
	}

	const serialize = (fx: FileFixture): string => {
		if (!fx.frontmatter) return fx.body;
		const yaml = Object.entries(fx.frontmatter)
			.map(([k, v]) => {
				if (Array.isArray(v)) {
					return `${k}:\n${v.map((x) => `  - ${JSON.stringify(x)}`).join("\n")}`;
				}
				return `${k}: ${JSON.stringify(v)}`;
			})
			.join("\n");
		return `---\n${yaml}\n---\n${fx.body}`;
	};

	const vault = {
		getAbstractFileByPath: (path: string) => {
			const normalized = path.replace(/\/$/, "");
			return fileObjs.get(normalized) ?? folderObjs.get(normalized) ?? null;
		},
		read: async (file: TFile) => {
			const fx = files[file.path];
			if (!fx) throw new Error(`no fixture for ${file.path}`);
			return serialize(fx);
		},
	} as unknown as import("obsidian").Vault;

	const metadataCache = {
		getFileCache: (file: TFile) => {
			const fx = files[file.path];
			return fx ? { frontmatter: fx.frontmatter ?? undefined } : null;
		},
		// Resolve "[[planner]]" against the steps dir of the source flow, and
		// "[[judge]]" / "[[_rubric]]" against its evals dir (a link from an
		// evaluator note resolves relative to the circuit dir as well).
		getFirstLinkpathDest: (linkpath: string, sourcePath: string) => {
			let flowDir = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
			if (flowDir.endsWith("/steps") || flowDir.endsWith("/evals")) {
				flowDir = flowDir.slice(0, flowDir.lastIndexOf("/"));
			}
			return (
				fileObjs.get(`${flowDir}/steps/${linkpath}.md`) ??
				fileObjs.get(`${flowDir}/evals/${linkpath}.md`) ??
				null
			);
		},
	} as unknown as import("obsidian").MetadataCache;

	// Ensure the orchestrations root folder always exists.
	ensureFolder("notor/orchestrations");

	return { vault, metadataCache };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const FLOW_DIR = "notor/orchestrations/demo";

function stepFm(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		"notor-type": "orchestration-step",
		"notor-step-name": "Step",
		"notor-step-triggers": ["start"],
		"notor-step-publishes": [FLOW_COMPLETE],
		...over,
	};
}

/** A minimal valid two-step flow: planner (start → work) + finisher (work → FLOW_COMPLETE). */
function validFlowFiles(flowOver: Record<string, unknown> = {}): Record<string, FileFixture> {
	return {
		[`${FLOW_DIR}/definition.md`]: {
			frontmatter: {
				"notor-type": "orchestration-flow",
				"notor-flow-name": "Demo",
				"notor-flow-description": "A demo flow",
				"notor-starting-event": "start",
				"notor-steps": ["[[planner]]", "[[finisher]]"],
				...flowOver,
			},
			body: "# Demo\nThis body is documentation only and must never be a prompt.",
		},
		[`${FLOW_DIR}/steps/planner.md`]: {
			frontmatter: stepFm({
				"notor-step-name": "Planner",
				"notor-step-triggers": ["start"],
				"notor-step-publishes": ["work"],
				"notor-step-default-publishes": "work",
			}),
			body: "Plan the work.\n<include_note>orchestrations/demo/steps/_rubric</include_note>",
		},
		[`${FLOW_DIR}/steps/finisher.md`]: {
			frontmatter: stepFm({
				"notor-step-name": "Finisher",
				"notor-step-triggers": ["work"],
				"notor-step-publishes": [FLOW_COMPLETE],
				"notor-step-default-publishes": FLOW_COMPLETE,
			}),
			body: "Finish and emit FLOW_COMPLETE.",
		},
	};
}

function parserFor(files: Record<string, FileFixture>, personaDisablesEmit?: (n: string) => boolean) {
	const { vault, metadataCache } = buildFakeVault(files);
	return new CircuitDefinitionParser(vault, metadataCache, "notor", personaDisablesEmit);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CircuitDefinitionParser", () => {
	it("parses a valid flow with every field populated + documented defaults", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseCircuitByDir(FLOW_DIR);

		expect(flow.name).toBe("Demo");
		expect(flow.description).toBe("A demo flow");
		expect(flow.flowDir).toBe(FLOW_DIR);
		expect(flow.startingEvent).toBe("start");
		expect(flow.completionEvent).toBe(FLOW_COMPLETE); // default
		expect(flow.handoffIsolation).toBe("isolated"); // default
		expect(flow.invocable).toBe(false); // default
		expect(flow.fanoutTopics).toEqual([]); // default
		expect(flow.steps).toHaveLength(2);
		expect(flow.steps[0]!.name).toBe("Planner");
		expect(flow.steps[1]!.name).toBe("Finisher");
	});

	it("defaults notor-step-mode to conversation and captures the body verbatim", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseCircuitByDir(FLOW_DIR);
		const planner = flow.steps[0]!;
		expect(planner.mode).toBe("conversation");
		expect(planner.bodyContent).toContain("Plan the work.");
	});

	it("preserves <include_note> tags verbatim in bodyContent (resolution is the prompt builder's job)", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseCircuitByDir(FLOW_DIR);
		expect(flow.steps[0]!.bodyContent).toContain(
			"<include_note>orchestrations/demo/steps/_rubric</include_note>",
		);
	});

	it("never surfaces the definition.md body as flow data", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseCircuitByDir(FLOW_DIR);
		const serialized = JSON.stringify(flow);
		expect(serialized).not.toContain("documentation only");
	});

	it("injects FINITE ceiling defaults when the three ceiling fields are omitted (never Infinity)", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseCircuitByDir(FLOW_DIR);
		expect(flow.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
		expect(flow.maxRuntimeMinutes).toBe(DEFAULT_MAX_RUNTIME_MINUTES);
		expect(flow.maxCostUsd).toBe(DEFAULT_MAX_COST_USD);
		expect(Number.isFinite(flow.maxIterations)).toBe(true);
		expect(Number.isFinite(flow.maxCostUsd)).toBe(true);
		expect(flow.maxDepth).toBeNull(); // depth may remain null
	});

	it("uses authored ceilings when present", async () => {
		const files = validFlowFiles({
			"notor-max-iterations": 7,
			"notor-max-runtime-minutes": 30,
			"notor-max-cost-usd": 2.5,
		});
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.maxIterations).toBe(7);
		expect(flow.maxRuntimeMinutes).toBe(30);
		expect(flow.maxCostUsd).toBe(2.5);
	});

	it("raises a clear error for an unresolved notor-steps wikilink", async () => {
		const files = validFlowFiles({ "notor-steps": ["[[planner]]", "[[ghost]]"] });
		await expect(parserFor(files).parseCircuitByDir(FLOW_DIR)).rejects.toThrow(/ghost/);
	});

	it("rejects an undeclared multi-subscriber topic at load (naming the topic + both steps)", async () => {
		const files = validFlowFiles();
		// Make finisher ALSO trigger on "start" → two subscribers, no fanout decl.
		files[`${FLOW_DIR}/steps/finisher.md`]!.frontmatter!["notor-step-triggers"] = ["start", "work"];
		await expect(parserFor(files).parseCircuitByDir(FLOW_DIR)).rejects.toThrow(/start.*Planner|Planner.*start/);
	});

	it("accepts a declared notor-fanout-topics topic with >1 subscriber", async () => {
		const files = validFlowFiles({ "notor-fanout-topics": ["start"] });
		files[`${FLOW_DIR}/steps/finisher.md`]!.frontmatter!["notor-step-triggers"] = ["start", "work"];
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.fanoutTopics).toEqual(["start"]);
	});

	it("hard-errors when the completion event is unreachable from the starting event", async () => {
		const files = validFlowFiles();
		// Break the chain: planner publishes a topic no one triggers / leads nowhere terminal.
		files[`${FLOW_DIR}/steps/planner.md`]!.frontmatter!["notor-step-publishes"] = ["dead"];
		files[`${FLOW_DIR}/steps/planner.md`]!.frontmatter!["notor-step-default-publishes"] = "dead";
		// finisher still triggers on "work" (never published now) → completion unreachable.
		await expect(parserFor(files).parseCircuitByDir(FLOW_DIR)).rejects.toThrow(/not reachable|unreachable|orphan/i);
	});

	it("hard-errors on a published-but-unsubscribed non-terminal topic (Issue-10)", async () => {
		const files = validFlowFiles();
		// planner publishes both "work" (handled) and "stray" (orphan, non-terminal).
		files[`${FLOW_DIR}/steps/planner.md`]!.frontmatter!["notor-step-publishes"] = ["work", "stray"];
		await expect(parserFor(files).parseCircuitByDir(FLOW_DIR)).rejects.toThrow(/stray/);
	});

	it("exempts terminal + failure-channel topics from the static-orphan rule", async () => {
		const files = validFlowFiles();
		// finisher publishing a {step}.capped channel must NOT be a load error.
		files[`${FLOW_DIR}/steps/finisher.md`]!.frontmatter!["notor-step-publishes"] = [
			FLOW_COMPLETE,
			"Finisher.capped",
		];
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.steps).toHaveLength(2);
	});

	it("exempts .stream_error from the static-orphan rule so a step may subscribe to it (F3)", async () => {
		const files = validFlowFiles();
		// planner publishes a {step}.stream_error channel and finisher subscribes to
		// it — neither the publish nor the subscribe is a static orphan / load error.
		files[`${FLOW_DIR}/steps/planner.md`]!.frontmatter!["notor-step-publishes"] = [
			"work",
			"Planner.stream_error",
		];
		files[`${FLOW_DIR}/steps/finisher.md`]!.frontmatter!["notor-step-triggers"] = [
			"work",
			"Planner.stream_error",
		];
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.steps).toHaveLength(2);
	});

	it("requires a required-event to be published by some step", async () => {
		const files = validFlowFiles({ "notor-required-events": ["never.published"] });
		await expect(parserFor(files).parseCircuitByDir(FLOW_DIR)).rejects.toThrow(/never\.published/);
	});

	it("emits the definition-lint warning when a step publishes >1 topic AND its persona disables emit_event (Issue-13f)", async () => {
		const files = validFlowFiles();
		// planner publishes two topics (work + a second wired topic) with a persona that disables emit.
		files[`${FLOW_DIR}/steps/planner.md`]!.frontmatter!["notor-step-publishes"] = ["work", "work2"];
		files[`${FLOW_DIR}/steps/planner.md`]!.frontmatter!["notor-step-persona"] = "readonly";
		// Wire work2 to the finisher so it is not a static orphan.
		files[`${FLOW_DIR}/steps/finisher.md`]!.frontmatter!["notor-step-triggers"] = ["work", "work2"];
		const { warnings } = await parserFor(files, (n) => n === "readonly").parseCircuitByDir(FLOW_DIR);
		expect(warnings.some((w) => w.kind === "definition_lint")).toBe(true);
	});

	it("parses composition frontmatter into the inert fields without affecting Phase-1 behavior", async () => {
		const files = validFlowFiles({
			"notor-flow-invocable": true,
			"notor-flow-inputs": "a description",
			"notor-flow-returns": "a summary",
			"notor-handoff-isolation": "shared",
			"notor-max-depth": 3,
		});
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.invocable).toBe(true);
		expect(flow.flowInputs).toBe("a description");
		expect(flow.flowReturns).toBe("a summary");
		expect(flow.handoffIsolation).toBe("shared");
		expect(flow.maxDepth).toBe(3);
	});

	it("defaults notor-open-notes-in-editor to null when absent (inherit global setting)", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseCircuitByDir(FLOW_DIR);
		expect(flow.openNotesInEditor).toBeNull();
	});

	it("parses notor-open-notes-in-editor: true into an explicit override", async () => {
		const files = validFlowFiles({ "notor-open-notes-in-editor": true });
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.openNotesInEditor).toBe(true);
	});

	it("parses notor-open-notes-in-editor: false into an explicit override", async () => {
		const files = validFlowFiles({ "notor-open-notes-in-editor": false });
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.openNotesInEditor).toBe(false);
	});

	it("defaults notor-flow-allow-concurrent to false when absent (F1 Fix 4)", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseCircuitByDir(FLOW_DIR);
		expect(flow.allowConcurrent).toBe(false);
	});

	it("parses notor-flow-allow-concurrent: true to opt out of the single-instance guard (F1 Fix 4)", async () => {
		const files = validFlowFiles({ "notor-flow-allow-concurrent": true });
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.allowConcurrent).toBe(true);
	});

	it("rejects an invalid notor-handoff-isolation with a clear load error (INT-040)", async () => {
		const files = validFlowFiles({ "notor-handoff-isolation": "sandboxed" });
		await expect(parserFor(files).parseCircuitByDir(FLOW_DIR)).rejects.toThrow(
			/notor-handoff-isolation.*isolated.*shared/i,
		);
	});

	it("throws a CircuitParseError (not a generic Error) on a missing flow name", async () => {
		const files = validFlowFiles();
		delete files[`${FLOW_DIR}/definition.md`]!.frontmatter!["notor-flow-name"];
		await expect(parserFor(files).parseCircuitByDir(FLOW_DIR)).rejects.toBeInstanceOf(CircuitParseError);
	});

	it("discovers flows under orchestrations/ and skips non-flow directories", async () => {
		const files = validFlowFiles();
		// A sibling directory with a non-flow note must be skipped.
		files["notor/orchestrations/sessions/readme.md"] = {
			frontmatter: { "notor-type": "something-else" },
			body: "not a flow",
		};
		const results = await parserFor(files).discoverCircuits();
		expect(results).toHaveLength(1);
		expect(results[0]!.flow.name).toBe("Demo");
	});

	// notor-schedule (direct flow scheduling) -------------------------------

	it("defaults schedule to null when notor-schedule is absent", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseCircuitByDir(FLOW_DIR);
		expect(flow.schedule).toBeNull();
	});

	it("populates schedule with a valid notor-schedule cron expression", async () => {
		const files = validFlowFiles({ "notor-schedule": "0 9 * * 1-5" });
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.schedule).toBe("0 9 * * 1-5");
	});

	it("drops an invalid notor-schedule to null (does not hard-error the flow)", async () => {
		const files = validFlowFiles({ "notor-schedule": "not a cron" });
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.schedule).toBeNull();
		// The rest of the flow still parses.
		expect(flow.name).toBe("Demo");
		expect(flow.steps).toHaveLength(2);
	});

	// notor-daily-start (on_daily_start trigger opt-in) ----------------------

	it("defaults dailyStart to false when notor-daily-start is absent", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseCircuitByDir(FLOW_DIR);
		expect(flow.dailyStart).toBe(false);
	});

	it("sets dailyStart when notor-daily-start is true", async () => {
		const files = validFlowFiles({ "notor-daily-start": true });
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.dailyStart).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Evaluators (notor-evaluators + evals/*.md)
// ---------------------------------------------------------------------------

function evaluatorFm(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		"notor-type": "circuit-evaluator",
		"notor-eval-name": "Report quality",
		"notor-eval-dimensions": ["accuracy", "completeness"],
		...over,
	};
}

/** The valid two-step flow plus one LLM evaluator (with a rubric) and one code evaluator. */
function flowWithEvaluators(
	flowOver: Record<string, unknown> = {},
	judgeOver: Record<string, unknown> = {},
	judgeBody = "Judge the report against the rubric.",
): Record<string, FileFixture> {
	const files = validFlowFiles({
		"notor-evaluators": ["[[judge]]", "[[shape]]"],
		...flowOver,
	});
	files[`${FLOW_DIR}/evals/judge.md`] = {
		frontmatter: evaluatorFm({
			"notor-eval-description": "Scores the report.",
			"notor-eval-persona": "critic",
			"notor-eval-rubric": "[[_rubric]]",
			"notor-eval-dimensions": [
				"accuracy",
				{ name: "completeness", type: "numeric", min: 0, max: 10, description: "Covers every ask" },
				{ name: "cited_sources", type: "boolean" },
			],
			...judgeOver,
		}),
		body: judgeBody,
	};
	files[`${FLOW_DIR}/evals/_rubric.md`] = { frontmatter: null, body: "# Rubric\nBe strict." };
	files[`${FLOW_DIR}/evals/shape.md`] = {
		frontmatter: evaluatorFm({
			"notor-eval-name": "Shape",
			"notor-eval-mode": "code",
			"notor-eval-timeout-seconds": 30,
			"notor-eval-dimensions": [{ name: "completed", type: "boolean" }],
		}),
		body: "```ts\nreturn { scores: { completed: input.outcome.status === 'completed' }, rationale: 'status' };\n```",
	};
	return files;
}

describe("CircuitDefinitionParser — evaluators", () => {
	it("defaults to no evaluators / no auto-eval / no eval schedule / null eval budget", async () => {
		const { flow, warnings } = await parserFor(validFlowFiles()).parseCircuitByDir(FLOW_DIR);
		expect(flow.evaluators).toEqual([]);
		expect(flow.evalAuto).toBe("none");
		expect(flow.evalSchedule).toBeNull();
		expect(flow.evalMaxCostUsd).toBeNull();
		expect(warnings).toEqual([]);
	});

	it("parses conversation + code evaluators with resolved rubric, typed dimensions, and shorthand defaults", async () => {
		const { flow, warnings } = await parserFor(flowWithEvaluators()).parseCircuitByDir(FLOW_DIR);
		expect(warnings).toEqual([]);
		expect(flow.evaluators).toHaveLength(2);

		const judge = flow.evaluators[0]!;
		expect(judge).toMatchObject({
			name: "Report quality",
			description: "Scores the report.",
			mode: "conversation",
			persona: "critic",
			subagent: null,
			model: null,
			rubricPath: `${FLOW_DIR}/evals/_rubric.md`,
			timeoutSeconds: null,
			includeNoteContents: true,
			notePath: `${FLOW_DIR}/evals/judge.md`,
		});
		expect(judge.bodyContent).toContain("Judge the report against the rubric.");
		expect(judge.dimensions).toEqual([
			{ name: "accuracy", type: "numeric", min: 1, max: 5, description: null },
			{ name: "completeness", type: "numeric", min: 0, max: 10, description: "Covers every ask" },
			{ name: "cited_sources", type: "boolean", min: 0, max: 1, description: null },
		]);

		const shape = flow.evaluators[1]!;
		expect(shape).toMatchObject({ name: "Shape", mode: "code", timeoutSeconds: 30, rubricPath: null });
		expect(shape.dimensions).toEqual([{ name: "completed", type: "boolean", min: 0, max: 1, description: null }]);
		expect(shape.bodyContent).toContain("return { scores:");
	});

	it("parses notor-eval-auto, notor-eval-schedule, and notor-eval-max-cost-usd", async () => {
		const files = flowWithEvaluators({
			"notor-eval-auto": "both",
			"notor-eval-schedule": "0 6 * * *",
			"notor-eval-max-cost-usd": 0.75,
		});
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.evalAuto).toBe("both");
		expect(flow.evalSchedule).toBe("0 6 * * *");
		expect(flow.evalMaxCostUsd).toBe(0.75);
	});

	it("coerces an unknown notor-eval-auto to none, an invalid eval cron to null, and a non-positive eval budget to null", async () => {
		const files = flowWithEvaluators({
			"notor-eval-auto": "sometimes",
			"notor-eval-schedule": "not a cron",
			"notor-eval-max-cost-usd": -2,
		});
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.evalAuto).toBe("none");
		expect(flow.evalSchedule).toBeNull();
		expect(flow.evalMaxCostUsd).toBeNull();
	});

	it("an unresolvable notor-evaluators link is an evaluator_lint warning, not a load error", async () => {
		const files = validFlowFiles({ "notor-evaluators": ["[[missing]]"] });
		const { flow, warnings } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.evaluators).toEqual([]);
		expect(flow.steps).toHaveLength(2);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]!.kind).toBe("evaluator_lint");
		expect(warnings[0]!.message).toMatch(/missing.*could not be resolved/);
	});

	it.each([
		["wrong notor-type", { "notor-type": "circuit-step" }, /missing 'notor-type: circuit-evaluator'/],
		["missing name", { "notor-eval-name": "" }, /missing required 'notor-eval-name'/],
		["unknown mode", { "notor-eval-mode": "python" }, /invalid 'notor-eval-mode: python'/],
		["persona AND subagent", { "notor-eval-subagent": "grader" }, /both 'notor-eval-persona' and 'notor-eval-subagent'/],
		["zero dimensions", { "notor-eval-dimensions": [] }, /declares no 'notor-eval-dimensions'/],
		["duplicate dimension", { "notor-eval-dimensions": ["a", "a"] }, /dimension 'a' twice/],
		["unknown dimension type", { "notor-eval-dimensions": [{ name: "x", type: "ordinal" }] }, /unknown type 'ordinal'/],
		["non-increasing range", { "notor-eval-dimensions": [{ name: "x", min: 5, max: 5 }] }, /needs min < max/],
		["unresolved rubric", { "notor-eval-rubric": "[[nowhere]]" }, /rubric '\[\[nowhere\]\]' could not be resolved/],
	])("drops the evaluator with an evaluator_lint warning on %s", async (_label, judgeOver, pattern) => {
		const { flow, warnings } = await parserFor(flowWithEvaluators({}, judgeOver)).parseCircuitByDir(FLOW_DIR);
		// The judge is dropped; the code evaluator and the circuit survive.
		expect(flow.evaluators.map((e) => e.name)).toEqual(["Shape"]);
		expect(flow.steps).toHaveLength(2);
		const lint = warnings.filter((w) => w.kind === "evaluator_lint");
		expect(lint).toHaveLength(1);
		expect(lint[0]!.message).toMatch(pattern);
	});

	it("drops a code evaluator whose body has no ts/js fence", async () => {
		const files = flowWithEvaluators();
		files[`${FLOW_DIR}/evals/shape.md`]!.body = "No fence here.";
		const { flow, warnings } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.evaluators.map((e) => e.name)).toEqual(["Report quality"]);
		expect(warnings.some((w) => w.kind === "evaluator_lint" && /no ts\/js code fence/.test(w.message))).toBe(true);
	});

	it("drops a second evaluator that reuses a name", async () => {
		const files = flowWithEvaluators();
		files[`${FLOW_DIR}/evals/shape.md`]!.frontmatter!["notor-eval-name"] = "Report quality";
		const { flow, warnings } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.evaluators).toHaveLength(1);
		expect(warnings.some((w) => /declared twice/.test(w.message))).toBe(true);
	});

	it("ignores persona/subagent/model on a code evaluator", async () => {
		const files = flowWithEvaluators();
		Object.assign(files[`${FLOW_DIR}/evals/shape.md`]!.frontmatter!, {
			"notor-eval-persona": "critic",
			"notor-eval-model": "gpt-x",
		});
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.evaluators[1]).toMatchObject({ mode: "code", persona: null, subagent: null, model: null });
	});

	it("does not treat the evals/ folder or its notes as circuits during discovery", async () => {
		const results = await parserFor(flowWithEvaluators()).discoverCircuits();
		expect(results).toHaveLength(1);
		expect(results[0]!.flow.evaluators).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Circuit vocabulary aliases + dual roots (orchestrations -> circuits reframe)
// ---------------------------------------------------------------------------

/** Re-home the two-step fixture under `toDir`, optionally converting it to the circuit vocabulary. */
function rehome(
	toDir: string,
	opts: { circuitVocabulary?: boolean; name?: string } = {},
): Record<string, FileFixture> {
	const out: Record<string, FileFixture> = {};
	for (const [path, fx] of Object.entries(validFlowFiles())) {
		const fm = { ...(fx.frontmatter ?? {}) };
		if (opts.circuitVocabulary) {
			if (fm["notor-type"] === "orchestration-flow") {
				fm["notor-type"] = "circuit";
				fm["notor-circuit-name"] = fm["notor-flow-name"];
				fm["notor-circuit-description"] = fm["notor-flow-description"];
				delete fm["notor-flow-name"];
				delete fm["notor-flow-description"];
			} else if (fm["notor-type"] === "orchestration-step") {
				fm["notor-type"] = "circuit-step";
			}
		}
		if (opts.name && ("notor-flow-name" in fm || "notor-circuit-name" in fm)) {
			fm[opts.circuitVocabulary ? "notor-circuit-name" : "notor-flow-name"] = opts.name;
		}
		out[path.replace(FLOW_DIR, toDir)] = { ...fx, frontmatter: fm };
	}
	return out;
}

describe("CircuitDefinitionParser — circuit vocabulary aliases", () => {
	it("parses a circuit-vocabulary definition (notor-type: circuit, circuit-step, notor-circuit-*)", async () => {
		const files = rehome("notor/circuits/demo", { circuitVocabulary: true });
		const [result, ...rest] = await parserFor(files).discoverCircuits();
		expect(rest).toHaveLength(0);
		expect(result!.flow.name).toBe("Demo");
		expect(result!.flow.description).toBe("A demo flow");
		expect(result!.flow.flowDir).toBe("notor/circuits/demo");
		expect(result!.flow.steps.map((s) => s.name)).toEqual(["Planner", "Finisher"]);
	});

	it("still parses a legacy-vocabulary flow under orchestrations/", async () => {
		const results = await parserFor(validFlowFiles()).discoverCircuits();
		expect(results.map((r) => r.flow.flowDir)).toEqual([FLOW_DIR]);
	});

	it("discovers both roots, circuits/ first", async () => {
		const files = {
			...validFlowFiles(), // notor/orchestrations/demo, name "Demo"
			...rehome("notor/circuits/other", { circuitVocabulary: true, name: "Other" }),
		};
		const results = await parserFor(files).discoverCircuits();
		expect(results.map((r) => r.flow.name)).toEqual(["Other", "Demo"]);
	});

	it("new key wins when both new and legacy keys are present", async () => {
		const files = validFlowFiles({
			"notor-circuit-name": "New name",
			"notor-flow-name": "Old name",
			"notor-circuit-invocable": true,
			"notor-flow-invocable": false,
			"notor-on-complete-circuit": "[[Next]]",
			"notor-on-complete-flow": "[[Old next]]",
		});
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.name).toBe("New name");
		expect(flow.invocable).toBe(true);
		expect(flow.onCompleteFlow).toBe("Next");
	});

	it("reads every aliased legacy key when only legacy keys are present", async () => {
		const files = validFlowFiles({
			"notor-flow-invocable": true,
			"notor-flow-inputs": "a topic",
			"notor-flow-returns": "a summary",
			"notor-flow-allow-concurrent": true,
		});
		const { flow } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.invocable).toBe(true);
		expect(flow.flowInputs).toBe("a topic");
		expect(flow.flowReturns).toBe("a summary");
		expect(flow.allowConcurrent).toBe(true);
	});

	it("names both spellings when the name key is missing", async () => {
		const files = validFlowFiles({ "notor-flow-name": undefined });
		await expect(parserFor(files).parseCircuitByDir(FLOW_DIR)).rejects.toThrow(
			/'notor-circuit-name' \(or legacy 'notor-flow-name'\)/,
		);
	});

	it("keeps the circuits/ definition on a cross-root name collision and warns", async () => {
		const files = {
			...validFlowFiles(), // orchestrations/demo, "Demo"
			...rehome("notor/circuits/demo", { circuitVocabulary: true }), // circuits/demo, "Demo"
		};
		const results = await parserFor(files).discoverCircuits();
		expect(results).toHaveLength(1);
		expect(results[0]!.flow.flowDir).toBe("notor/circuits/demo");
		const collision = results[0]!.warnings.filter((w) => w.kind === "name_collision");
		expect(collision).toHaveLength(1);
		expect(collision[0]!.message).toContain("notor/orchestrations/demo");
	});

	it("dedupes same-name circuits within one root by folder order", async () => {
		const files = {
			...rehome("notor/circuits/a", { circuitVocabulary: true, name: "Same" }),
			...rehome("notor/circuits/b", { circuitVocabulary: true, name: "Same" }),
		};
		const results = await parserFor(files).discoverCircuits();
		expect(results.map((r) => r.flow.flowDir)).toEqual(["notor/circuits/a"]);
		expect(results[0]!.warnings.some((w) => w.kind === "name_collision")).toBe(true);
	});
});

describe("CircuitDefinitionParser — circuit topic aliases", () => {
	it("canonicalizes CIRCUIT_* in completion event, publishes, and default publishes", async () => {
		const files = validFlowFiles({ "notor-completion-event": "CIRCUIT_COMPLETE" });
		const finisher = files[`${FLOW_DIR}/steps/finisher.md`]!;
		finisher.frontmatter = {
			...finisher.frontmatter,
			"notor-step-publishes": ["CIRCUIT_COMPLETE"],
			"notor-step-default-publishes": "CIRCUIT_COMPLETE",
		};
		const { flow, warnings } = await parserFor(files).parseCircuitByDir(FLOW_DIR);
		expect(flow.completionEvent).toBe(FLOW_COMPLETE);
		expect(flow.steps[1]!.publishes).toEqual([FLOW_COMPLETE]);
		expect(flow.steps[1]!.defaultPublishes).toBe(FLOW_COMPLETE);
		expect(warnings).toEqual([]);
	});

	it("a step publishing CIRCUIT_COMPLETE in a FLOW_COMPLETE circuit is not a false orphan", async () => {
		const files = validFlowFiles(); // completion defaults to FLOW_COMPLETE
		const finisher = files[`${FLOW_DIR}/steps/finisher.md`]!;
		finisher.frontmatter = { ...finisher.frontmatter, "notor-step-publishes": ["CIRCUIT_COMPLETE"] };
		await expect(parserFor(files).parseCircuitByDir(FLOW_DIR)).resolves.toMatchObject({ warnings: [] });
	});

	it("a circuit.tasks_remaining trigger parses exactly like flow.tasks_remaining", async () => {
		const withTrigger = (trigger: string) => {
			const files = validFlowFiles();
			files[`${FLOW_DIR}/steps/retry.md`] = {
				frontmatter: stepFm({
					"notor-step-name": "Retry",
					"notor-step-triggers": [trigger],
					"notor-step-publishes": ["work"],
				}),
				body: "Finish remaining tasks.",
			};
			const def = files[`${FLOW_DIR}/definition.md`]!;
			def.frontmatter = {
				...def.frontmatter,
				"notor-steps": ["[[planner]]", "[[finisher]]", "[[retry]]"],
			};
			return parserFor(files).parseCircuitByDir(FLOW_DIR);
		};
		const alias = await withTrigger("circuit.tasks_remaining");
		const canonical = await withTrigger("flow.tasks_remaining");
		expect(alias.flow.steps[2]!.triggers).toEqual(["flow.tasks_remaining"]);
		expect(alias.warnings).toEqual(canonical.warnings);
	});
});
