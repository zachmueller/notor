/**
 * `CircuitDefinitionParser` + `StepNoteParser` (FEAT-002).
 *
 * Turns vault notes into `Circuit` / `StepDefinition`. Mirrors the
 * existing workflow discovery/parse machinery (`discoverWorkflows()` at
 * `src/workflows/workflow-discovery.ts:73`, frontmatter read via
 * `metadataCache.getFileCache()`, body via `vault.read()` + `getFrontMatterInfo()`)
 * rather than inventing new plumbing.
 *
 * `CircuitDefinitionParser` scans each `{notor_dir}/orchestrations/{flow}/definition.md`
 * (discriminator `notor-type: circuit`, legacy `orchestration-flow`), resolves the `notor-steps`
 * wikilinks against `{flow-dir}/steps/`, parses each via `StepNoteParser`
 * (discriminator `notor-type: circuit-step`, legacy `orchestration-step`), and runs two layers of
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
import { extractCodeFence } from "../extensions/parser";
import {
	DEFAULT_MAX_COST_USD,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_MAX_RUNTIME_MINUTES,
} from "./constants";
import {
	canonicalTopic,
	FLOW_COMPLETE,
	isTerminalTopic,
	USER_INPUT_REQUIRED,
	type Circuit,
	type EvalAutoTrigger,
	type EvalDimension,
	type EvaluatorDefinition,
	type StepDefinition,
} from "./types";
import {
	CIRCUIT_ROOT_DIR_NAMES,
	describeAliasedKey,
	isCircuitDefinitionType,
	isCircuitEvaluatorType,
	isCircuitStepType,
	readAliasedKey,
} from "./schema-aliases";

const log = logger("FlowParser");

// ---------------------------------------------------------------------------
// Errors / results
// ---------------------------------------------------------------------------

/** A blocking load error — the flow cannot run. */
export class CircuitParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CircuitParseError";
	}
}

/** A non-blocking load warning (dead step, definition-lint, cross-root name collision, evaluator lint). */
export interface CircuitParseWarning {
	kind: "dead_step" | "definition_lint" | "name_collision" | "evaluator_lint";
	message: string;
}

/** The result of parsing one flow: the flow plus any non-blocking warnings. */
export interface CircuitParseResult {
	flow: Circuit;
	warnings: CircuitParseWarning[];
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

function canonicalTopicOrNull(topic: string | null): string | null {
	return topic === null ? null : canonicalTopic(topic);
}

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
	throw new CircuitParseError(
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
function parseSchedule(value: unknown, flowName: string, key = "notor-schedule"): string | null {
	const raw = parseStringOrNull(value);
	if (raw === null) return null;
	const result = validateCronExpression(raw);
	if (!result.valid) {
		log.warn(`Flow '${flowName}' has invalid '${key}' cron expression`, {
			schedule: raw,
			error: result.error,
		});
		return null;
	}
	return raw;
}

/** Parse `notor-eval-auto`: one of the four triggers; absent or unrecognized → `none` (with a warning). */
function parseEvalAuto(value: unknown, flowName: string): EvalAutoTrigger {
	const raw = parseStringOrNull(value);
	if (raw === null) return "none";
	if (raw === "none" || raw === "complete" || raw === "error" || raw === "both") return raw;
	log.warn(`Flow '${flowName}' has unrecognized 'notor-eval-auto'; using 'none'`, { value: raw });
	return "none";
}

/** Parse `notor-eval-max-cost-usd`: a positive finite number, or `null` (fall back to the circuit ceiling). */
function parseEvalMaxCostUsd(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return value;
	}
	return null;
}

/** Numeric-dimension defaults for the bare-string shorthand (`- accuracy` ⇒ scored 1–5). */
const DEFAULT_DIMENSION_MIN = 1;
const DEFAULT_DIMENSION_MAX = 5;

/**
 * Parse `notor-eval-dimensions`. Each item is a bare string (numeric 1–5) or a
 * map `{ name, type?: numeric | boolean, min?, max?, description? }`. Throws a
 * `CircuitParseError` on an empty list, a missing name, an unknown type, a
 * non-increasing numeric range, or a duplicate name — the caller downgrades it
 * to an `evaluator_lint` warning and drops the evaluator.
 */
function parseEvalDimensions(value: unknown, evaluatorLabel: string): EvalDimension[] {
	const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
	if (items.length === 0) {
		throw new CircuitParseError(`Evaluator '${evaluatorLabel}' declares no 'notor-eval-dimensions'.`);
	}
	const dimensions: EvalDimension[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		let dim: EvalDimension;
		if (typeof item === "string" || typeof item === "number") {
			const name = String(item).trim();
			if (!name) throw new CircuitParseError(`Evaluator '${evaluatorLabel}' has an empty dimension name.`);
			dim = { name, type: "numeric", min: DEFAULT_DIMENSION_MIN, max: DEFAULT_DIMENSION_MAX, description: null };
		} else if (item && typeof item === "object") {
			const rec = item as Record<string, unknown>;
			const name = parseStringOrNull(rec["name"]);
			if (!name) throw new CircuitParseError(`Evaluator '${evaluatorLabel}' has a dimension without a 'name'.`);
			const rawType = parseStringOrNull(rec["type"]) ?? "numeric";
			if (rawType !== "numeric" && rawType !== "boolean") {
				throw new CircuitParseError(
					`Evaluator '${evaluatorLabel}': dimension '${name}' has unknown type '${rawType}' (numeric | boolean).`,
				);
			}
			const description = parseStringOrNull(rec["description"]);
			if (rawType === "boolean") {
				dim = { name, type: "boolean", min: 0, max: 1, description };
			} else {
				const min = typeof rec["min"] === "number" && Number.isFinite(rec["min"]) ? rec["min"] : DEFAULT_DIMENSION_MIN;
				const max = typeof rec["max"] === "number" && Number.isFinite(rec["max"]) ? rec["max"] : DEFAULT_DIMENSION_MAX;
				if (!(min < max)) {
					throw new CircuitParseError(
						`Evaluator '${evaluatorLabel}': dimension '${name}' needs min < max (got ${min}..${max}).`,
					);
				}
				dim = { name, type: "numeric", min, max, description };
			}
		} else {
			throw new CircuitParseError(`Evaluator '${evaluatorLabel}' has an unrecognized dimension entry.`);
		}
		if (seen.has(dim.name)) {
			throw new CircuitParseError(`Evaluator '${evaluatorLabel}' declares dimension '${dim.name}' twice.`);
		}
		seen.add(dim.name);
		dimensions.push(dim);
	}
	return dimensions;
}

// ---------------------------------------------------------------------------
// StepNoteParser
// ---------------------------------------------------------------------------

/**
 * Parses a single step note (discriminator `notor-type: circuit-step`, legacy `orchestration-step`)
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
		const fm: Record<string, unknown> | undefined = cache?.frontmatter;
		if (!fm || !isCircuitStepType(fm["notor-type"])) {
			log.warn("Step note missing circuit-step discriminator", { path: file.path });
			return null;
		}

		const name = parseStringOrNull(fm["notor-step-name"]);
		if (!name) {
			throw new CircuitParseError(
				`Step note '${file.path}' is missing required 'notor-step-name'.`,
			);
		}

		// Topic fields are canonicalized (CIRCUIT_* → FLOW_*) so routing and the
		// static validators compare one spelling.
		const triggers = parseStringArray(fm["notor-step-triggers"]).map(canonicalTopic);
		const publishes = parseStringArray(fm["notor-step-publishes"]).map(canonicalTopic);

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
			throw new CircuitParseError(
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
			defaultPublishes: canonicalTopicOrNull(parseStringOrNull(fm["notor-step-default-publishes"])),
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
// EvaluatorNoteParser
// ---------------------------------------------------------------------------

/**
 * Parses a single evaluator note (discriminator `notor-type: circuit-evaluator`)
 * into an `EvaluatorDefinition`. Same plumbing as `StepNoteParser`: frontmatter
 * via `metadataCache.getFileCache()`, body via `vault.read()` +
 * `getFrontMatterInfo()`. Every problem is thrown as a `CircuitParseError`; the
 * circuit parser downgrades it to an `evaluator_lint` warning and drops the
 * evaluator (an evaluator problem never blocks the circuit).
 */
export class EvaluatorNoteParser {
	constructor(
		private readonly vault: Vault,
		private readonly metadataCache: MetadataCache,
	) {}

	async parse(file: TFile, evalsDir: string): Promise<EvaluatorDefinition> {
		const cache = this.metadataCache.getFileCache(file);
		const fm: Record<string, unknown> | undefined = cache?.frontmatter;
		if (!fm || !isCircuitEvaluatorType(fm["notor-type"])) {
			throw new CircuitParseError(
				`Note '${file.path}' is missing 'notor-type: circuit-evaluator'.`,
			);
		}
		const name = parseStringOrNull(fm["notor-eval-name"]);
		if (!name) {
			throw new CircuitParseError(`Evaluator note '${file.path}' is missing required 'notor-eval-name'.`);
		}

		const rawMode = parseStringOrNull(fm["notor-eval-mode"]) ?? "conversation";
		if (rawMode !== "conversation" && rawMode !== "code") {
			throw new CircuitParseError(
				`Evaluator '${name}': invalid 'notor-eval-mode: ${rawMode}' — must be 'conversation' or 'code'.`,
			);
		}
		const mode: "conversation" | "code" = rawMode;

		const persona = parseStringOrNull(fm["notor-eval-persona"]);
		const subagent = parseStringOrNull(fm["notor-eval-subagent"]);
		if (persona && subagent) {
			throw new CircuitParseError(
				`Evaluator '${name}' sets both 'notor-eval-persona' and 'notor-eval-subagent'; choose one.`,
			);
		}

		const dimensions = parseEvalDimensions(fm["notor-eval-dimensions"], name);

		const rawTimeout = fm["notor-eval-timeout-seconds"];
		const timeoutSeconds =
			typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : null;

		let rawContent: string;
		try {
			rawContent = await this.vault.read(file);
		} catch (err) {
			throw new CircuitParseError(
				`Failed to read evaluator note '${file.path}': ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const fmInfo = getFrontMatterInfo(rawContent);
		const bodyContent = rawContent.slice(fmInfo.contentStart);
		if (mode === "code" && extractCodeFence(bodyContent) === null) {
			throw new CircuitParseError(
				`Evaluator '${name}' is 'notor-eval-mode: code' but its body has no ts/js code fence.`,
			);
		}

		// Rubric: a wikilink resolved via the metadata cache (scoped to the
		// evaluator note), then an explicit path under evals/.
		let rubricPath: string | null = null;
		const rawRubric = parseStringOrNull(fm["notor-eval-rubric"]);
		if (rawRubric) {
			const rubricFile = resolveLinkedNote(this.vault, this.metadataCache, stripWikilink(rawRubric), evalsDir, file.path);
			if (!rubricFile) {
				throw new CircuitParseError(
					`Evaluator '${name}': rubric '${rawRubric}' could not be resolved under '${evalsDir}/'.`,
				);
			}
			rubricPath = rubricFile.path;
		}

		return {
			name,
			description: parseStringOrNull(fm["notor-eval-description"]) ?? "",
			mode,
			persona: mode === "code" ? null : persona,
			subagent: mode === "code" ? null : subagent,
			model: mode === "code" ? null : parseStringOrNull(fm["notor-eval-model"]),
			rubricPath,
			dimensions,
			timeoutSeconds,
			includeNoteContents: parseBool(fm["notor-eval-include-note-contents"], true),
			bodyContent,
			notePath: file.path,
		};
	}
}

/**
 * Resolve a wikilink to a `TFile` under a circuit sub-directory (`steps/`,
 * `evals/`). Tries the metadata-cache link resolver first (handles `[[planner]]`
 * shortnames), then an explicit path under `subDir` (with/without `.md`), then
 * falls back to any cache hit.
 */
function resolveLinkedNote(
	vault: Vault,
	metadataCache: MetadataCache,
	linkText: string,
	subDir: string,
	fromPath: string,
): TFile | null {
	// 1. Metadata-cache resolution (shortname or path), scoped to the source
	//    note for disambiguation.
	const viaCache = metadataCache.getFirstLinkpathDest(linkText, fromPath);
	if (viaCache instanceof TFile && viaCache.path.startsWith(`${subDir}/`)) {
		return viaCache;
	}

	// 2. Explicit path under subDir (exact, then with .md).
	const base = linkText.endsWith(".md") ? linkText.slice(0, -3) : linkText;
	const candidate = base.includes("/") ? base : `${subDir}/${base}`;
	const exact = vault.getAbstractFileByPath(`${candidate}.md`);
	if (exact instanceof TFile) return exact;
	const noExt = vault.getAbstractFileByPath(candidate);
	if (noExt instanceof TFile) return noExt;

	// 3. Fall back to a cache hit even outside subDir (better than nothing).
	if (viaCache instanceof TFile) return viaCache;
	return null;
}

// ---------------------------------------------------------------------------
// CircuitDefinitionParser
// ---------------------------------------------------------------------------

/**
 * Discovers and parses orchestration flows. Stateless — each call re-scans
 * (mirrors `discoverWorkflows`'s no-active-state pattern).
 */
export class CircuitDefinitionParser {
	private readonly stepParser: StepNoteParser;
	private readonly evaluatorParser: EvaluatorNoteParser;

	constructor(
		private readonly vault: Vault,
		private readonly metadataCache: MetadataCache,
		private readonly notorDir: string,
		private readonly personaDisablesEmitEvent?: PersonaDisablesEmitEvent,
	) {
		this.stepParser = new StepNoteParser(vault, metadataCache);
		this.evaluatorParser = new EvaluatorNoteParser(vault, metadataCache);
	}

	/** `{notor_dir}/circuits` then legacy `{notor_dir}/orchestrations`, in precedence order. */
	private rootPaths(): string[] {
		const base = this.notorDir.replace(/\/$/, "");
		return CIRCUIT_ROOT_DIR_NAMES.map((dirName) => `${base}/${dirName}`);
	}

	/**
	 * Discover every circuit under `{notor_dir}/circuits/` and the legacy
	 * `{notor_dir}/orchestrations/`. Each child directory containing a
	 * `definition.md` whose `notor-type` is `circuit` (or legacy
	 * `orchestration-flow`) is a circuit; `sessions/`, `failures/`,
	 * `memories.md`, and step dirs are skipped. A circuit that fails to parse is
	 * logged and excluded (one bad circuit never blocks discovery of the rest).
	 *
	 * Circuit names must be unique across both roots. On a collision the first
	 * definition wins (`circuits/` before `orchestrations/`, then folder order),
	 * the others are dropped so every name-keyed consumer agrees, and the winner
	 * carries a `name_collision` warning.
	 */
	async discoverCircuits(): Promise<CircuitParseResult[]> {
		const results: CircuitParseResult[] = [];
		for (const rootPath of this.rootPaths()) {
			const root = this.vault.getAbstractFileByPath(rootPath);
			if (!(root instanceof TFolder)) {
				log.debug("Circuit directory does not exist", { path: rootPath });
				continue;
			}

			for (const child of root.children) {
				if (!(child instanceof TFolder)) continue;
				const defPath = `${child.path}/definition.md`;
				const defFile = this.vault.getAbstractFileByPath(defPath);
				if (!(defFile instanceof TFile)) continue;

				// Only directories whose definition.md carries the discriminator.
				const cache = this.metadataCache.getFileCache(defFile);
				if (!isCircuitDefinitionType(cache?.frontmatter?.["notor-type"])) continue;

				try {
					results.push(await this.parseFlowDir(child));
				} catch (e) {
					log.warn("Failed to parse circuit, skipping", {
						path: child.path,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
		}
		return dedupeByName(results);
	}

	/** Parse a single flow by its directory path (used by the picker / runner). */
	async parseCircuitByDir(flowDir: string): Promise<CircuitParseResult> {
		const dir = this.vault.getAbstractFileByPath(flowDir.replace(/\/$/, ""));
		if (!(dir instanceof TFolder)) {
			throw new CircuitParseError(`Flow directory not found: '${flowDir}'.`);
		}
		return this.parseFlowDir(dir);
	}

	/** Parse a flow directory containing `definition.md` + `steps/`. */
	private async parseFlowDir(dir: TFolder): Promise<CircuitParseResult> {
		const defPath = `${dir.path}/definition.md`;
		const defFile = this.vault.getAbstractFileByPath(defPath);
		if (!(defFile instanceof TFile)) {
			throw new CircuitParseError(`Flow '${dir.path}' has no definition.md.`);
		}

		const cache = this.metadataCache.getFileCache(defFile);
		const fm: Record<string, unknown> | undefined = cache?.frontmatter;
		if (!fm || !isCircuitDefinitionType(fm["notor-type"])) {
			throw new CircuitParseError(
				`definition.md in '${dir.path}' is missing 'notor-type: circuit' (or legacy 'orchestration-flow').`,
			);
		}

		const name = parseStringOrNull(readAliasedKey(fm, "name"));
		if (!name) {
			throw new CircuitParseError(
				`Circuit '${dir.path}' is missing required ${describeAliasedKey("name")}.`,
			);
		}
		const startingEvent = canonicalTopicOrNull(parseStringOrNull(fm["notor-starting-event"]));
		if (!startingEvent) {
			throw new CircuitParseError(`Flow '${name}' is missing required 'notor-starting-event'.`);
		}

		// Resolve step wikilinks under {flow-dir}/steps/.
		const stepLinks = parseStringArray(fm["notor-steps"]);
		if (stepLinks.length === 0) {
			throw new CircuitParseError(`Flow '${name}' declares no 'notor-steps'.`);
		}
		const steps = await this.resolveSteps(stepLinks, dir, defFile.path, name);

		// Evaluators are optional and never block the circuit: each problem is
		// collected as an `evaluator_lint` warning and that evaluator is dropped.
		const evaluatorWarnings: CircuitParseWarning[] = [];
		const evaluators = await this.resolveEvaluators(
			parseStringArray(fm["notor-evaluators"]),
			dir,
			defFile.path,
			name,
			evaluatorWarnings,
		);

		const flow: Circuit = {
			name,
			description: parseStringOrNull(readAliasedKey(fm, "description")) ?? "",
			flowDir: dir.path,
			startingEvent,
			completionEvent: canonicalTopicOrNull(parseStringOrNull(fm["notor-completion-event"])) ?? FLOW_COMPLETE,
			maxIterations: parseFiniteNumberOrDefault(
				fm["notor-max-iterations"],
				DEFAULT_MAX_ITERATIONS,
			),
			maxRuntimeMinutes: parseFiniteNumberOrDefault(
				fm["notor-max-runtime-minutes"],
				DEFAULT_MAX_RUNTIME_MINUTES,
			),
			requiredEvents: parseStringArray(fm["notor-required-events"]).map(canonicalTopic),
			fanoutTopics: parseStringArray(fm["notor-fanout-topics"]).map(canonicalTopic),
			steps,
			guardrails: parseStringArray(fm["notor-guardrails"]),
			schedule: parseSchedule(fm["notor-schedule"], name),
			dailyStart: parseBool(fm["notor-daily-start"], false),
			// Composition (Phase 7; inert).
			invocable: parseBool(readAliasedKey(fm, "invocable"), false),
			flowInputs: parseStringOrNull(readAliasedKey(fm, "inputs")),
			flowReturns: parseStringOrNull(readAliasedKey(fm, "returns")),
			onCompleteFlow: (() => {
				const raw = parseStringOrNull(readAliasedKey(fm, "onComplete"));
				return raw ? stripWikilink(raw) : null;
			})(),
			handoffIsolation: parseHandoffIsolation(fm["notor-handoff-isolation"], name),
			maxDepth: parseMaxDepth(fm["notor-max-depth"]),
			maxCostUsd: parseFiniteNumberOrDefault(fm["notor-max-cost-usd"], DEFAULT_MAX_COST_USD),
			openNotesInEditor: parseBoolOrNull(fm["notor-open-notes-in-editor"]),
			allowConcurrent: parseBool(readAliasedKey(fm, "allowConcurrent"), false),
			// Evaluation.
			evaluators,
			evalAuto: parseEvalAuto(fm["notor-eval-auto"], name),
			evalSchedule: parseSchedule(fm["notor-eval-schedule"], name, "notor-eval-schedule"),
			evalMaxCostUsd: parseEvalMaxCostUsd(fm["notor-eval-max-cost-usd"]),
		};

		// Two layers of load-time validation.
		this.validateTriggerRouting(flow);
		const warnings = [...this.validateTopology(flow), ...evaluatorWarnings];

		return { flow, warnings };
	}

	/**
	 * Resolve `notor-evaluators` wikilinks to evaluator notes under
	 * `{circuit-dir}/evals/`. Unlike steps, a bad evaluator is a warning
	 * (`evaluator_lint`) and is dropped — the circuit itself still loads.
	 */
	private async resolveEvaluators(
		links: string[],
		dir: TFolder,
		definitionPath: string,
		flowName: string,
		warnings: CircuitParseWarning[],
	): Promise<EvaluatorDefinition[]> {
		const evalsDir = `${dir.path}/evals`;
		const evaluators: EvaluatorDefinition[] = [];
		const seen = new Set<string>();
		for (const link of links) {
			const linkText = stripWikilink(link);
			try {
				const file = resolveLinkedNote(this.vault, this.metadataCache, linkText, evalsDir, definitionPath);
				if (!file) {
					throw new CircuitParseError(
						`evaluator '${linkText}' could not be resolved under '${evalsDir}/'.`,
					);
				}
				const evaluator = await this.evaluatorParser.parse(file, evalsDir);
				if (seen.has(evaluator.name)) {
					throw new CircuitParseError(`evaluator name '${evaluator.name}' is declared twice.`);
				}
				seen.add(evaluator.name);
				evaluators.push(evaluator);
			} catch (e) {
				const message = `Flow '${flowName}': ${e instanceof Error ? e.message : String(e)}`;
				warnings.push({ kind: "evaluator_lint", message });
				log.warn("Dropping invalid circuit evaluator", { flow: flowName, link: linkText, error: message });
			}
		}
		return evaluators;
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
			const file = resolveLinkedNote(this.vault, this.metadataCache, linkText, stepsDir, definitionPath);
			if (!file) {
				throw new CircuitParseError(
					`Flow '${flowName}': step '${linkText}' could not be resolved under '${stepsDir}/'.`,
				);
			}
			const step = await this.stepParser.parse(file);
			if (!step) {
				throw new CircuitParseError(
					`Flow '${flowName}': note '${file.path}' is not a valid circuit step.`,
				);
			}
			steps.push(step);
		}
		return steps;
	}

	// -- Layer 1: trigger routing (FR-111) ----------------------------------

	/**
	 * Each topic maps to exactly one step by default; a topic with >1 subscriber
	 * is rejected unless declared in `notor-fanout-topics`.
	 */
	private validateTriggerRouting(flow: Circuit): void {
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
				throw new CircuitParseError(
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
	private validateTopology(flow: Circuit): CircuitParseWarning[] {
		const warnings: CircuitParseWarning[] = [];

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
				throw new CircuitParseError(
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
					throw new CircuitParseError(
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
		flow: Circuit,
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
			throw new CircuitParseError(
				`Flow '${flow.name}': completion event '${flow.completionEvent}' is not reachable ` +
					`from the starting event '${flow.startingEvent}'.`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Cross-root name collisions
// ---------------------------------------------------------------------------

/**
 * Keep the first circuit per name and drop the rest. The winner gets one
 * `name_collision` warning per dropped duplicate. Order of `results` is the
 * precedence order (circuits/ before orchestrations/).
 */
export function dedupeByName(results: CircuitParseResult[]): CircuitParseResult[] {
	const winners = new Map<string, CircuitParseResult>();
	for (const result of results) {
		const winner = winners.get(result.flow.name);
		if (!winner) {
			winners.set(result.flow.name, result);
			continue;
		}
		const message =
			`Circuit name '${result.flow.name}' is defined in both '${winner.flow.flowDir}' and ` +
			`'${result.flow.flowDir}'; using '${winner.flow.flowDir}'. Rename one of them to run both.`;
		winner.warnings.push({ kind: "name_collision", message });
		log.warn("Duplicate circuit name; keeping the first definition", {
			name: result.flow.name,
			kept: winner.flow.flowDir,
			dropped: result.flow.flowDir,
		});
	}
	return [...winners.values()];
}
