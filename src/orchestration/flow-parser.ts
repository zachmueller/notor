/**
 * `FlowDefinitionParser` + `StepNoteParser` (FEAT-002).
 *
 * Turns vault notes into `OrchestrationFlow` / `StepDefinition`. Mirrors the
 * existing workflow discovery/parse machinery (`discoverWorkflows()` at
 * `src/workflows/workflow-discovery.ts:73`, frontmatter read via
 * `metadataCache.getFileCache()`, body via `vault.read()` + `getFrontMatterInfo()`)
 * rather than inventing new plumbing.
 *
 * `FlowDefinitionParser` scans each `{notor_dir}/orchestrations/{flow}/definition.md`
 * (discriminator `notor-type: orchestration-flow`), resolves the `notor-steps`
 * wikilinks against `{flow-dir}/steps/`, parses each via `StepNoteParser`
 * (discriminator `notor-type: orchestration-step`), and runs two layers of
 * load-time validation:
 *
 *  1. **Trigger routing (FR-111).** Each topic maps to exactly one step unless
 *     declared in `notor-fanout-topics` (ordered fan-out).
 *  2. **Topology validation (FR-110).** Hard-errors on unreachable completion,
 *     unpublished required-events, and any published-but-unsubscribed
 *     non-terminal topic (Issue-10). Warns on a dead step.
 *
 * Plus finite-ceiling defaults (Issue-8) and the definition-lint warning
 * (Issue-13f).
 *
 * The `definition.md` body is documentation only and is never read into a
 * prompt. Step bodies become `StepDefinition.bodyContent`; `<include_note>`
 * tags are preserved verbatim (resolved later by the prompt builder).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-002
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md — frontmatter schema
 * @see specs/ZZ-misc/orchestration/contracts/event-engine.md — topology validation
 */

import {
	TFile,
	TFolder,
	getFrontMatterInfo,
	type MetadataCache,
	type Vault,
} from "obsidian";
import { logger } from "../utils/logger";
import { validateCronExpression } from "../workflows/workflow-discovery";
import {
	DEFAULT_MAX_COST_USD,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_MAX_RUNTIME_MINUTES,
} from "./constants";
import {
	FLOW_COMPLETE,
	isTerminalTopic,
	USER_INPUT_REQUIRED,
	type OrchestrationFlow,
	type StepDefinition,
} from "./types";

const log = logger("FlowParser");

// ---------------------------------------------------------------------------
// Errors / results
// ---------------------------------------------------------------------------

/** A blocking load error — the flow cannot run. */
export class FlowParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FlowParseError";
	}
}

/** A non-blocking load warning (dead step, definition-lint). */
export interface FlowParseWarning {
	kind: "dead_step" | "definition_lint";
	message: string;
}

/** The result of parsing one flow: the flow plus any non-blocking warnings. */
export interface FlowParseResult {
	flow: OrchestrationFlow;
	warnings: FlowParseWarning[];
}

/**
 * Optional predicate the runner injects so the parser can emit the Issue-13f
 * definition-lint warning (a step that publishes >1 topic AND whose persona
 * disables `emit_event`). Returns `true` when the named persona disables the
 * `emit_event` tool. When omitted, the lint is skipped (the parser stays pure /
 * vault-independent for tests).
 */
export type PersonaDisablesEmitEvent = (personaName: string) => boolean;

// ---------------------------------------------------------------------------
// Engine-synthesized / failure-channel topic recognition (validator exemptions)
// ---------------------------------------------------------------------------

/** Synthesized re-trigger topics auto-subscribed at runtime (FEAT-003 / FR-123). */
const SYNTHESIZED_TOPICS = new Set(["flow.tasks_remaining", "flow.requirements_unmet"]);

/** Runtime-only failure-channel suffixes handled by the default failure handler (Issue-10; `.stream_error` per F3). */
const FAILURE_CHANNEL_SUFFIXES = [".capped", ".no_emit", ".code_error", ".stream_error"];

function isFailureChannelTopic(topic: string): boolean {
	return FAILURE_CHANNEL_SUFFIXES.some((suffix) => topic.endsWith(suffix));
}

/** A topic the static topology validator must NOT treat as a static orphan. */
function isValidatorExemptTopic(topic: string): boolean {
	return (
		isTerminalTopic(topic) ||
		SYNTHESIZED_TOPICS.has(topic) ||
		isFailureChannelTopic(topic) ||
		// `user.input.required` is a runtime-intercepted pause signal (FR-150 /
		// INT-030): the runner suspends on it and resumes by re-triggering the
		// paused step — it is never routed to a subscriber, so a step publishing
		// it with no subscriber is NOT a static orphan.
		topic === USER_INPUT_REQUIRED
	);
}

// ---------------------------------------------------------------------------
// Frontmatter coercion helpers (mirror workflow-discovery.ts)
// ---------------------------------------------------------------------------

function parseStringOrNull(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
		return null;
	}
	const str = String(value).trim();
	return str.length > 0 ? str : null;
}

function parseStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.map((v) => parseStringOrNull(v))
			.filter((v): v is string => v !== null);
	}
	const single = parseStringOrNull(value);
	return single !== null ? [single] : [];
}

/** Strip `[[ ]]` wikilink wrapping from a value, leaving the bare link text. */
function stripWikilink(value: string): string {
	return value.replace(/^\[\[|\]\]$/g, "").trim();
}

/**
 * Parse an optional positive number; returns the injected `fallback` (a finite
 * engine default) when the field is absent or not a positive finite number.
 */
function parseFiniteNumberOrDefault(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	return fallback;
}

/** Parse `notor-max-depth`: a positive integer, or `null` (unlimited depth). */
function parseMaxDepth(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		return value;
	}
	return null;
}

/**
 * Parse `notor-handoff-isolation` (INT-040). Absent → the `isolated` default; an
 * explicit `isolated` / `shared` is honored; **any other value is a hard load
 * error** (FR-174 AC) rather than a silent coercion — a typo'd isolation mode
 * must surface at author time, not quietly run isolated.
 */
function parseHandoffIsolation(value: unknown, flowName: string): "isolated" | "shared" {
	const raw = parseStringOrNull(value);
	if (raw === null) return "isolated";
	if (raw === "isolated" || raw === "shared") return raw;
	throw new FlowParseError(
		`Flow '${flowName}': invalid 'notor-handoff-isolation: ${raw}' — must be 'isolated' or 'shared'.`,
	);
}

function parseBool(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
}

/**
 * Parse an optional tri-state boolean: an explicit `true`/`false` (incl. the
 * `"true"`/`"false"` string forms) is honored; absent or unrecognized → `null`
 * (inherit the global default). Used by `notor-open-notes-in-editor`.
 */
function parseBoolOrNull(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return null;
}

/**
 * Parse `notor-schedule` into a validated cron expression (or `null`). Mirrors
 * the workflow-discovery cron handling (`workflow-discovery.ts:378`): an invalid
 * expression is dropped to `null` with a logged warning rather than a hard load
 * error — a typo'd schedule must not make the whole flow unparseable.
 */
function parseSchedule(value: unknown, flowName: string): string | null {
	const raw = parseStringOrNull(value);
	if (raw === null) return null;
	const result = validateCronExpression(raw);
	if (!result.valid) {
		log.warn(`Flow '${flowName}' has invalid 'notor-schedule' cron expression`, {
			schedule: raw,
			error: result.error,
		});
		return null;
	}
	return raw;
}

// ---------------------------------------------------------------------------
// StepNoteParser
// ---------------------------------------------------------------------------

/**
 * Parses a single step note (discriminator `notor-type: orchestration-step`)
 * into a `StepDefinition`. Frontmatter via `metadataCache.getFileCache()`; body
 * via `vault.read()` + `getFrontMatterInfo()` (mirrors `readWorkflowBody`).
 */
export class StepNoteParser {
	constructor(
		private readonly vault: Vault,
		private readonly metadataCache: MetadataCache,
	) {}

	/**
	 * Parse one step note. Returns `null` (with a logged warning) when the note
	 * lacks the discriminator or required fields — the caller raises a clear
	 * load error naming the missing step.
	 */
	async parse(file: TFile): Promise<StepDefinition | null> {
		const cache = this.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter as Record<string, unknown> | undefined;
		if (!fm || fm["notor-type"] !== "orchestration-step") {
			log.warn("Step note missing orchestration-step discriminator", { path: file.path });
			return null;
		}

		const name = parseStringOrNull(fm["notor-step-name"]);
		if (!name) {
			throw new FlowParseError(
				`Step note '${file.path}' is missing required 'notor-step-name'.`,
			);
		}

		const triggers = parseStringArray(fm["notor-step-triggers"]);
		const publishes = parseStringArray(fm["notor-step-publishes"]);

		const rawMode = fm["notor-step-mode"];
		const mode: "conversation" | "code" = rawMode === "code" ? "code" : "conversation";

		const rawTimeout = fm["notor-step-timeout-seconds"];
		const timeoutSeconds =
			typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
				? rawTimeout
				: null;

		const rawMcp = fm["notor-step-mcp-servers"];
		const mcpServers = rawMcp === undefined || rawMcp === null ? null : parseStringArray(rawMcp);

		// Body: raw markdown minus frontmatter. <include_note> tags are preserved
		// verbatim — the prompt builder (FEAT-005) resolves them, not the parser.
		let rawContent: string;
		try {
			rawContent = await this.vault.read(file);
		} catch (err) {
			throw new FlowParseError(
				`Failed to read step note '${file.path}': ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const fmInfo = getFrontMatterInfo(rawContent);
		const bodyContent = rawContent.slice(fmInfo.contentStart);

		return {
			name,
			description: parseStringOrNull(fm["notor-step-description"]) ?? "",
			triggers,
			publishes,
			defaultPublishes: parseStringOrNull(fm["notor-step-default-publishes"]),
			persona: parseStringOrNull(fm["notor-step-persona"]),
			model: parseStringOrNull(fm["notor-step-model"]),
			mode,
			mcpServers,
			timeoutSeconds,
			bodyContent,
			notePath: file.path,
		};
	}
}

// ---------------------------------------------------------------------------
// FlowDefinitionParser
// ---------------------------------------------------------------------------

/**
 * Discovers and parses orchestration flows. Stateless — each call re-scans
 * (mirrors `discoverWorkflows`'s no-active-state pattern).
 */
export class FlowDefinitionParser {
	private readonly stepParser: StepNoteParser;

	constructor(
		private readonly vault: Vault,
		private readonly metadataCache: MetadataCache,
		private readonly notorDir: string,
		private readonly personaDisablesEmitEvent?: PersonaDisablesEmitEvent,
	) {
		this.stepParser = new StepNoteParser(vault, metadataCache);
	}

	/** `{notor_dir}/orchestrations`. */
	private orchestrationsRootPath(): string {
		return `${this.notorDir.replace(/\/$/, "")}/orchestrations`;
	}

	/**
	 * Discover every flow under `{notor_dir}/orchestrations/`. Each child
	 * directory containing a `definition.md` with `notor-type:
	 * orchestration-flow` is a flow; `sessions/`, `memories.md`, and step dirs
	 * are skipped. A flow that fails to parse is logged and excluded (one bad
	 * flow never blocks discovery of the rest).
	 */
	async discoverFlows(): Promise<FlowParseResult[]> {
		const rootPath = this.orchestrationsRootPath();
		const root = this.vault.getAbstractFileByPath(rootPath);
		if (!(root instanceof TFolder)) {
			log.debug("Orchestrations directory does not exist", { path: rootPath });
			return [];
		}

		const results: FlowParseResult[] = [];
		for (const child of root.children) {
			if (!(child instanceof TFolder)) continue;
			const defPath = `${child.path}/definition.md`;
			const defFile = this.vault.getAbstractFileByPath(defPath);
			if (!(defFile instanceof TFile)) continue;

			// Only directories whose definition.md carries the discriminator.
			const cache = this.metadataCache.getFileCache(defFile);
			if (cache?.frontmatter?.["notor-type"] !== "orchestration-flow") continue;

			try {
				results.push(await this.parseFlowDir(child));
			} catch (e) {
				log.warn("Failed to parse orchestration flow, skipping", {
					path: child.path,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
		return results;
	}

	/** Parse a single flow by its directory path (used by the picker / runner). */
	async parseFlowByDir(flowDir: string): Promise<FlowParseResult> {
		const dir = this.vault.getAbstractFileByPath(flowDir.replace(/\/$/, ""));
		if (!(dir instanceof TFolder)) {
			throw new FlowParseError(`Flow directory not found: '${flowDir}'.`);
		}
		return this.parseFlowDir(dir);
	}

	/** Parse a flow directory containing `definition.md` + `steps/`. */
	private async parseFlowDir(dir: TFolder): Promise<FlowParseResult> {
		const defPath = `${dir.path}/definition.md`;
		const defFile = this.vault.getAbstractFileByPath(defPath);
		if (!(defFile instanceof TFile)) {
			throw new FlowParseError(`Flow '${dir.path}' has no definition.md.`);
		}

		const cache = this.metadataCache.getFileCache(defFile);
		const fm = cache?.frontmatter as Record<string, unknown> | undefined;
		if (!fm || fm["notor-type"] !== "orchestration-flow") {
			throw new FlowParseError(
				`definition.md in '${dir.path}' is missing 'notor-type: orchestration-flow'.`,
			);
		}

		const name = parseStringOrNull(fm["notor-flow-name"]);
		if (!name) {
			throw new FlowParseError(`Flow '${dir.path}' is missing required 'notor-flow-name'.`);
		}
		const startingEvent = parseStringOrNull(fm["notor-starting-event"]);
		if (!startingEvent) {
			throw new FlowParseError(`Flow '${name}' is missing required 'notor-starting-event'.`);
		}

		// Resolve step wikilinks under {flow-dir}/steps/.
		const stepLinks = parseStringArray(fm["notor-steps"]);
		if (stepLinks.length === 0) {
			throw new FlowParseError(`Flow '${name}' declares no 'notor-steps'.`);
		}
		const steps = await this.resolveSteps(stepLinks, dir, defFile.path, name);

		const flow: OrchestrationFlow = {
			name,
			description: parseStringOrNull(fm["notor-flow-description"]) ?? "",
			flowDir: dir.path,
			startingEvent,
			completionEvent: parseStringOrNull(fm["notor-completion-event"]) ?? FLOW_COMPLETE,
			maxIterations: parseFiniteNumberOrDefault(
				fm["notor-max-iterations"],
				DEFAULT_MAX_ITERATIONS,
			),
			maxRuntimeMinutes: parseFiniteNumberOrDefault(
				fm["notor-max-runtime-minutes"],
				DEFAULT_MAX_RUNTIME_MINUTES,
			),
			requiredEvents: parseStringArray(fm["notor-required-events"]),
			fanoutTopics: parseStringArray(fm["notor-fanout-topics"]),
			steps,
			guardrails: parseStringArray(fm["notor-guardrails"]),
			schedule: parseSchedule(fm["notor-schedule"], name),
			// Composition (Phase 7; inert).
			invocable: parseBool(fm["notor-flow-invocable"], false),
			flowInputs: parseStringOrNull(fm["notor-flow-inputs"]),
			flowReturns: parseStringOrNull(fm["notor-flow-returns"]),
			onCompleteFlow: (() => {
				const raw = parseStringOrNull(fm["notor-on-complete-flow"]);
				return raw ? stripWikilink(raw) : null;
			})(),
			handoffIsolation: parseHandoffIsolation(fm["notor-handoff-isolation"], name),
			maxDepth: parseMaxDepth(fm["notor-max-depth"]),
			maxCostUsd: parseFiniteNumberOrDefault(fm["notor-max-cost-usd"], DEFAULT_MAX_COST_USD),
			openNotesInEditor: parseBoolOrNull(fm["notor-open-notes-in-editor"]),
		};

		// Two layers of load-time validation.
		this.validateTriggerRouting(flow);
		const warnings = this.validateTopology(flow);

		return { flow, warnings };
	}

	/** Resolve `notor-steps` wikilinks to step notes under `{flow-dir}/steps/`. */
	private async resolveSteps(
		stepLinks: string[],
		dir: TFolder,
		definitionPath: string,
		flowName: string,
	): Promise<StepDefinition[]> {
		const stepsDir = `${dir.path}/steps`;
		const steps: StepDefinition[] = [];

		for (const link of stepLinks) {
			const linkText = stripWikilink(link);
			const file = this.resolveStepFile(linkText, stepsDir, definitionPath);
			if (!file) {
				throw new FlowParseError(
					`Flow '${flowName}': step '${linkText}' could not be resolved under '${stepsDir}/'.`,
				);
			}
			const step = await this.stepParser.parse(file);
			if (!step) {
				throw new FlowParseError(
					`Flow '${flowName}': note '${file.path}' is not a valid orchestration step.`,
				);
			}
			steps.push(step);
		}
		return steps;
	}

	/**
	 * Resolve a step wikilink to a `TFile`. Tries the metadata-cache link
	 * resolver first (handles `[[planner]]` shortnames), then an explicit path
	 * under `{flow-dir}/steps/` (with/without `.md`).
	 */
	private resolveStepFile(
		linkText: string,
		stepsDir: string,
		definitionPath: string,
	): TFile | null {
		// 1. Metadata-cache resolution (shortname or path), scoped to the
		//    definition note for disambiguation.
		const viaCache = this.metadataCache.getFirstLinkpathDest(linkText, definitionPath);
		if (viaCache instanceof TFile && viaCache.path.startsWith(`${stepsDir}/`)) {
			return viaCache;
		}

		// 2. Explicit path under steps/ (exact, then with .md).
		const base = linkText.endsWith(".md") ? linkText.slice(0, -3) : linkText;
		const candidate = base.includes("/") ? base : `${stepsDir}/${base}`;
		const exact = this.vault.getAbstractFileByPath(`${candidate}.md`);
		if (exact instanceof TFile) return exact;
		const noExt = this.vault.getAbstractFileByPath(candidate);
		if (noExt instanceof TFile) return noExt;

		// 3. Fall back to a cache hit even outside steps/ (better than nothing).
		if (viaCache instanceof TFile) return viaCache;
		return null;
	}

	// -- Layer 1: trigger routing (FR-111) ----------------------------------

	/**
	 * Each topic maps to exactly one step by default; a topic with >1 subscriber
	 * is rejected unless declared in `notor-fanout-topics`.
	 */
	private validateTriggerRouting(flow: OrchestrationFlow): void {
		const fanout = new Set(flow.fanoutTopics);
		const subscribers = new Map<string, string[]>();
		for (const step of flow.steps) {
			for (const topic of step.triggers) {
				const list = subscribers.get(topic) ?? [];
				list.push(step.name);
				subscribers.set(topic, list);
			}
		}
		for (const [topic, steps] of subscribers) {
			if (steps.length > 1 && !fanout.has(topic)) {
				throw new FlowParseError(
					`Flow '${flow.name}': topic '${topic}' is triggered by multiple steps ` +
						`(${steps.join(", ")}) but is not declared in 'notor-fanout-topics'. ` +
						`Declare it as fan-out or give it a single subscriber.`,
				);
			}
		}
	}

	// -- Layer 2: topology validation (FR-110, Issue-10/13f) ----------------

	/**
	 * Topic-graph validation. Hard-errors on unreachable completion, unpublished
	 * required-events, and any published-but-unsubscribed non-terminal topic
	 * (Issue-10). Warns on a dead step and on the definition-lint case (Issue-13f).
	 */
	private validateTopology(flow: OrchestrationFlow): FlowParseWarning[] {
		const warnings: FlowParseWarning[] = [];

		const triggeredTopics = new Set<string>();
		const publishedTopics = new Set<string>();
		for (const step of flow.steps) {
			for (const t of step.triggers) triggeredTopics.add(t);
			for (const p of step.publishes) publishedTopics.add(p);
			// A no-emit step's default_publishes is also a "published" topic.
			if (step.defaultPublishes) publishedTopics.add(step.defaultPublishes);
		}
		// The starting event is published by the runner, not a step.
		publishedTopics.add(flow.startingEvent);

		// (a) Completion must be reachable from the starting event.
		this.assertCompletionReachable(flow, triggeredTopics, publishedTopics);

		// (b) Every required-events topic must be published by some step.
		for (const required of flow.requiredEvents) {
			if (!publishedTopics.has(required) && !triggeredTopics.has(required)) {
				throw new FlowParseError(
					`Flow '${flow.name}': required event '${required}' is published by no step — ` +
						`the flow could never legitimately complete.`,
				);
			}
		}

		// (c) Issue-10 — any published-but-unsubscribed NON-TERMINAL topic is a
		//     hard error (synthesized / failure-channel topics exempt).
		for (const step of flow.steps) {
			const candidates = new Set(step.publishes);
			if (step.defaultPublishes) candidates.add(step.defaultPublishes);
			for (const topic of candidates) {
				if (isValidatorExemptTopic(topic)) continue;
				if (topic === flow.completionEvent) continue;
				if (!triggeredTopics.has(topic)) {
					throw new FlowParseError(
						`Flow '${flow.name}': step '${step.name}' publishes '${topic}' but no step ` +
							`triggers on it (a static orphan). Wire it to a step, declare it terminal, ` +
							`or remove it.`,
					);
				}
			}
		}

		// (d) Dead step — a trigger topic never published (warning).
		for (const step of flow.steps) {
			for (const topic of step.triggers) {
				if (!publishedTopics.has(topic)) {
					warnings.push({
						kind: "dead_step",
						message:
							`Flow '${flow.name}': step '${step.name}' triggers on '${topic}', ` +
							`which no step (or the starting event) publishes — the step is dead.`,
					});
				}
			}
		}

		// (e) Issue-13f definition-lint — >1 publish AND persona disables emit_event.
		if (this.personaDisablesEmitEvent) {
			for (const step of flow.steps) {
				if (
					step.mode === "conversation" &&
					step.publishes.length > 1 &&
					step.persona &&
					this.personaDisablesEmitEvent(step.persona)
				) {
					warnings.push({
						kind: "definition_lint",
						message:
							`Flow '${flow.name}': step '${step.name}' publishes ${step.publishes.length} ` +
							`topics but its persona '${step.persona}' disables emit_event — all but the ` +
							`default_publishes branch are unreachable.`,
					});
				}
			}
		}

		return warnings;
	}

	/**
	 * Forward-reachability check: BFS over the topic graph from the starting
	 * event; a step is reachable if any of its triggers is reachable, and a
	 * reachable step makes its `publishes`/`default_publishes` reachable. The
	 * completion event must end up reachable.
	 */
	private assertCompletionReachable(
		flow: OrchestrationFlow,
		_triggeredTopics: Set<string>,
		_publishedTopics: Set<string>,
	): void {
		const reachableTopics = new Set<string>([flow.startingEvent]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const step of flow.steps) {
				const triggered = step.triggers.some((t) => reachableTopics.has(t));
				if (!triggered) continue;
				const emits = [...step.publishes];
				if (step.defaultPublishes) emits.push(step.defaultPublishes);
				for (const topic of emits) {
					if (!reachableTopics.has(topic)) {
						reachableTopics.add(topic);
						changed = true;
					}
				}
			}
		}
		if (!reachableTopics.has(flow.completionEvent)) {
			throw new FlowParseError(
				`Flow '${flow.name}': completion event '${flow.completionEvent}' is not reachable ` +
					`from the starting event '${flow.startingEvent}'.`,
			);
		}
	}
}
