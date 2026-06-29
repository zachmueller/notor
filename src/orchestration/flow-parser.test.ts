/**
 * TEST-003 — `FlowDefinitionParser` + `StepNoteParser` unit tests (FEAT-002).
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
import { FlowDefinitionParser, FlowParseError } from "./flow-parser";
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
		// Resolve "[[planner]]" against the steps dir of the source flow.
		getFirstLinkpathDest: (linkpath: string, sourcePath: string) => {
			const flowDir = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
			const candidate = `${flowDir}/steps/${linkpath}.md`;
			return fileObjs.get(candidate) ?? null;
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
	return new FlowDefinitionParser(vault, metadataCache, "notor", personaDisablesEmit);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FlowDefinitionParser", () => {
	it("parses a valid flow with every field populated + documented defaults", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseFlowByDir(FLOW_DIR);

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
		const { flow } = await parserFor(validFlowFiles()).parseFlowByDir(FLOW_DIR);
		const planner = flow.steps[0]!;
		expect(planner.mode).toBe("conversation");
		expect(planner.bodyContent).toContain("Plan the work.");
	});

	it("preserves <include_note> tags verbatim in bodyContent (resolution is the prompt builder's job)", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseFlowByDir(FLOW_DIR);
		expect(flow.steps[0]!.bodyContent).toContain(
			"<include_note>orchestrations/demo/steps/_rubric</include_note>",
		);
	});

	it("never surfaces the definition.md body as flow data", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseFlowByDir(FLOW_DIR);
		const serialized = JSON.stringify(flow);
		expect(serialized).not.toContain("documentation only");
	});

	it("injects FINITE ceiling defaults when the three ceiling fields are omitted (never Infinity)", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseFlowByDir(FLOW_DIR);
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
		const { flow } = await parserFor(files).parseFlowByDir(FLOW_DIR);
		expect(flow.maxIterations).toBe(7);
		expect(flow.maxRuntimeMinutes).toBe(30);
		expect(flow.maxCostUsd).toBe(2.5);
	});

	it("raises a clear error for an unresolved notor-steps wikilink", async () => {
		const files = validFlowFiles({ "notor-steps": ["[[planner]]", "[[ghost]]"] });
		await expect(parserFor(files).parseFlowByDir(FLOW_DIR)).rejects.toThrow(/ghost/);
	});

	it("rejects an undeclared multi-subscriber topic at load (naming the topic + both steps)", async () => {
		const files = validFlowFiles();
		// Make finisher ALSO trigger on "start" → two subscribers, no fanout decl.
		files[`${FLOW_DIR}/steps/finisher.md`]!.frontmatter!["notor-step-triggers"] = ["start", "work"];
		await expect(parserFor(files).parseFlowByDir(FLOW_DIR)).rejects.toThrow(/start.*Planner|Planner.*start/);
	});

	it("accepts a declared notor-fanout-topics topic with >1 subscriber", async () => {
		const files = validFlowFiles({ "notor-fanout-topics": ["start"] });
		files[`${FLOW_DIR}/steps/finisher.md`]!.frontmatter!["notor-step-triggers"] = ["start", "work"];
		const { flow } = await parserFor(files).parseFlowByDir(FLOW_DIR);
		expect(flow.fanoutTopics).toEqual(["start"]);
	});

	it("hard-errors when the completion event is unreachable from the starting event", async () => {
		const files = validFlowFiles();
		// Break the chain: planner publishes a topic no one triggers / leads nowhere terminal.
		files[`${FLOW_DIR}/steps/planner.md`]!.frontmatter!["notor-step-publishes"] = ["dead"];
		files[`${FLOW_DIR}/steps/planner.md`]!.frontmatter!["notor-step-default-publishes"] = "dead";
		// finisher still triggers on "work" (never published now) → completion unreachable.
		await expect(parserFor(files).parseFlowByDir(FLOW_DIR)).rejects.toThrow(/not reachable|unreachable|orphan/i);
	});

	it("hard-errors on a published-but-unsubscribed non-terminal topic (Issue-10)", async () => {
		const files = validFlowFiles();
		// planner publishes both "work" (handled) and "stray" (orphan, non-terminal).
		files[`${FLOW_DIR}/steps/planner.md`]!.frontmatter!["notor-step-publishes"] = ["work", "stray"];
		await expect(parserFor(files).parseFlowByDir(FLOW_DIR)).rejects.toThrow(/stray/);
	});

	it("exempts terminal + failure-channel topics from the static-orphan rule", async () => {
		const files = validFlowFiles();
		// finisher publishing a {step}.capped channel must NOT be a load error.
		files[`${FLOW_DIR}/steps/finisher.md`]!.frontmatter!["notor-step-publishes"] = [
			FLOW_COMPLETE,
			"Finisher.capped",
		];
		const { flow } = await parserFor(files).parseFlowByDir(FLOW_DIR);
		expect(flow.steps).toHaveLength(2);
	});

	it("requires a required-event to be published by some step", async () => {
		const files = validFlowFiles({ "notor-required-events": ["never.published"] });
		await expect(parserFor(files).parseFlowByDir(FLOW_DIR)).rejects.toThrow(/never\.published/);
	});

	it("emits the definition-lint warning when a step publishes >1 topic AND its persona disables emit_event (Issue-13f)", async () => {
		const files = validFlowFiles();
		// planner publishes two topics (work + a second wired topic) with a persona that disables emit.
		files[`${FLOW_DIR}/steps/planner.md`]!.frontmatter!["notor-step-publishes"] = ["work", "work2"];
		files[`${FLOW_DIR}/steps/planner.md`]!.frontmatter!["notor-step-persona"] = "readonly";
		// Wire work2 to the finisher so it is not a static orphan.
		files[`${FLOW_DIR}/steps/finisher.md`]!.frontmatter!["notor-step-triggers"] = ["work", "work2"];
		const { warnings } = await parserFor(files, (n) => n === "readonly").parseFlowByDir(FLOW_DIR);
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
		const { flow } = await parserFor(files).parseFlowByDir(FLOW_DIR);
		expect(flow.invocable).toBe(true);
		expect(flow.flowInputs).toBe("a description");
		expect(flow.flowReturns).toBe("a summary");
		expect(flow.handoffIsolation).toBe("shared");
		expect(flow.maxDepth).toBe(3);
	});

	it("rejects an invalid notor-handoff-isolation with a clear load error (INT-040)", async () => {
		const files = validFlowFiles({ "notor-handoff-isolation": "sandboxed" });
		await expect(parserFor(files).parseFlowByDir(FLOW_DIR)).rejects.toThrow(
			/notor-handoff-isolation.*isolated.*shared/i,
		);
	});

	it("throws a FlowParseError (not a generic Error) on a missing flow name", async () => {
		const files = validFlowFiles();
		delete files[`${FLOW_DIR}/definition.md`]!.frontmatter!["notor-flow-name"];
		await expect(parserFor(files).parseFlowByDir(FLOW_DIR)).rejects.toBeInstanceOf(FlowParseError);
	});

	it("discovers flows under orchestrations/ and skips non-flow directories", async () => {
		const files = validFlowFiles();
		// A sibling directory with a non-flow note must be skipped.
		files["notor/orchestrations/sessions/readme.md"] = {
			frontmatter: { "notor-type": "something-else" },
			body: "not a flow",
		};
		const results = await parserFor(files).discoverFlows();
		expect(results).toHaveLength(1);
		expect(results[0]!.flow.name).toBe("Demo");
	});

	// notor-schedule (direct flow scheduling) -------------------------------

	it("defaults schedule to null when notor-schedule is absent", async () => {
		const { flow } = await parserFor(validFlowFiles()).parseFlowByDir(FLOW_DIR);
		expect(flow.schedule).toBeNull();
	});

	it("populates schedule with a valid notor-schedule cron expression", async () => {
		const files = validFlowFiles({ "notor-schedule": "0 9 * * 1-5" });
		const { flow } = await parserFor(files).parseFlowByDir(FLOW_DIR);
		expect(flow.schedule).toBe("0 9 * * 1-5");
	});

	it("drops an invalid notor-schedule to null (does not hard-error the flow)", async () => {
		const files = validFlowFiles({ "notor-schedule": "not a cron" });
		const { flow } = await parserFor(files).parseFlowByDir(FLOW_DIR);
		expect(flow.schedule).toBeNull();
		// The rest of the flow still parses.
		expect(flow.name).toBe("Demo");
		expect(flow.steps).toHaveLength(2);
	});
});
