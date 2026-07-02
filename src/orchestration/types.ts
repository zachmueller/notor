/**
 * Orchestration domain types (design Phase 1, FEAT-001).
 *
 * The shapes the orchestration engine is built on. Imported by every other
 * Phase-1 module (`flow-parser`, `event-engine`, `step-prompt-builder`,
 * `step-turn-executor`, `safety`, `runner`, …), so they land first.
 *
 * Shape authority: specs/ZZ-misc/orchestration/data-model.md (Orchestration
 * Domain Types). Frontmatter schema: contracts/vault-schema.md. Routing/terminal
 * behavior: contracts/event-engine.md.
 *
 * The run-loop substrate types (`RunContext`, `RunResult`, `RunLoopOptions`,
 * `RunLoopHooks`, `OrchestrationToolContext`) are owned by `src/run-loop/types.ts`
 * (ARCH-001) and are **imported, never redeclared** here.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-001
 */

// ---------------------------------------------------------------------------
// OrchestrationFlow — parsed from definition.md
// ---------------------------------------------------------------------------

/**
 * A parsed orchestration flow (`definition.md`). The composition fields
 * (`invocable`, `flowInputs`, …) are declared now so the parser (FEAT-002) and
 * runner (FEAT-010) share one shape, but they are **inert** until the Phase-7
 * composition feature group lands (INT-040).
 *
 * Every flow is bounded by construction (FR-117 / FR-119a): `maxIterations`,
 * `maxRuntimeMinutes`, and `maxCostUsd` are optional in frontmatter but the
 * `FlowDefinitionParser` injects finite engine defaults
 * (`DEFAULT_MAX_ITERATIONS` / `DEFAULT_MAX_RUNTIME_MINUTES` /
 * `DEFAULT_MAX_COST_USD`, never `Infinity`) when omitted. `maxDepth` stays
 * `null`-able (unlimited depth is acceptable — the three ceilings still bound
 * total work).
 *
 * @see specs/ZZ-misc/orchestration/data-model.md — OrchestrationFlow
 */
export interface OrchestrationFlow {
	/** `notor-flow-name`. */
	name: string;
	/** `notor-flow-description`. */
	description: string;
	/** `{notor_dir}/orchestrations/{flow-name}/`. */
	flowDir: string;
	/** `notor-starting-event` — first event published when the flow starts. */
	startingEvent: string;
	/** `notor-completion-event` (default `FLOW_COMPLETE`). */
	completionEvent: string;
	/** `notor-max-iterations` — aggregate LLM-turn ceiling. Parser default `100` when omitted (never `Infinity`). */
	maxIterations: number;
	/** `notor-max-runtime-minutes` — wall-clock cap. Parser default `60` when omitted. */
	maxRuntimeMinutes: number;
	/** `notor-required-events` — topics that must be seen before completion is accepted. */
	requiredEvents: string[];
	/** `notor-fanout-topics` (default `[]`) — topics that MAY route to >1 step (ordered fan-out). */
	fanoutTopics: string[];
	/** Resolved from `notor-steps` wikilinks under `steps/`, in declaration order. */
	steps: StepDefinition[];
	/** `notor-guardrails` (default `[]`) — injected into every step prompt. */
	guardrails: string[];
	/**
	 * `notor-schedule` — validated 5-field cron expression (`null` when absent or
	 * invalid). When set, the flow is launched on this schedule by the
	 * `VaultEventScheduler` and surfaced in the Automation settings section under
	 * "Scheduled", mirroring scheduled workflows.
	 */
	schedule: string | null;

	// --- Composition (design Phase 7; inert unless the feature group is enabled) ---
	/** `notor-flow-invocable` (default `false`). */
	invocable: boolean;
	/** `notor-flow-inputs` (freeform NL; `null` when absent). */
	flowInputs: string | null;
	/** `notor-flow-returns` (freeform NL; `null` when absent). */
	flowReturns: string | null;
	/** `notor-on-complete-flow` (chaining successor wikilink; `null` when absent). */
	onCompleteFlow: string | null;
	/** `notor-handoff-isolation` (default `"isolated"`). */
	handoffIsolation: "isolated" | "shared";
	/** `notor-max-depth` (`null` = unlimited nesting depth). */
	maxDepth: number | null;
	/** `notor-max-cost-usd` — aggregate USD ceiling. Parser default `5.00` when omitted (never `Infinity`). */
	maxCostUsd: number;
	/**
	 * `notor-open-notes-in-editor` — whether notes this flow's steps read/write are
	 * opened in the editor. `null` (default, when absent) inherits the global
	 * `orchestration_open_notes_in_editor` setting; `true`/`false` force the
	 * behavior for this flow regardless of the setting.
	 */
	openNotesInEditor: boolean | null;
}

// ---------------------------------------------------------------------------
// StepDefinition — parsed from a step note
// ---------------------------------------------------------------------------

/**
 * A parsed orchestration step (a note under `{flow-dir}/steps/`).
 *
 * @see specs/ZZ-misc/orchestration/data-model.md — StepDefinition
 */
export interface StepDefinition {
	/** `notor-step-name` (may include an emoji). */
	name: string;
	/** `notor-step-description` (default `""`). */
	description: string;
	/** `notor-step-triggers` — event topics that activate this step. */
	triggers: string[];
	/** `notor-step-publishes` — event topics this step may emit. */
	publishes: string[];
	/** `notor-step-default-publishes` — synthesized when a step ends without an emission (`null` = none). */
	defaultPublishes: string | null;
	/** `notor-step-persona` (`null` = none; ignored in code mode). */
	persona: string | null;
	/** `notor-step-model` — overrides the persona model (`null` = inherit). */
	model: string | null;
	/** `notor-step-mode` (default `"conversation"`). */
	mode: "conversation" | "code";
	/** `notor-step-mcp-servers` (`null` = inherit all connected). */
	mcpServers: string[] | null;
	/** `notor-step-timeout-seconds` — code steps only (`null` → 300s at execution time, Phase 3). */
	timeoutSeconds: number | null;
	/** Markdown body (instructions) OR code fence (mode: code); `<include_note>` tags preserved verbatim. */
	bodyContent: string;
	/** Vault-relative path to the step note. */
	notePath: string;
}

// ---------------------------------------------------------------------------
// OrchestrationSessionMeta — persisted session.json
// ---------------------------------------------------------------------------

/**
 * The per-session metadata note (`sessions/{id}/session.json`), owned by the
 * `OrchestrationSessionManager` (INT-001). `status` is the recovery entry point
 * (the scan filters on `active`/`interrupted`); the authoritative replay source
 * is `session-log.jsonl`.
 *
 * **`origin` is always set at creation and is never null** — it is the
 * load-bearing recovery discriminator (Issue-4b): a command / `Run Orchestration`
 * launch stamps `"user"`, a hook-triggered launch (FR-119b) stamps `"hook"`, a
 * scheduled launch (`notor-schedule` on the flow definition) stamps `"schedule"`,
 * and Phase-7 composition stamps `"run_flow"` / `"chaining"`. `parent_session_id`
 * is `null` for a root (`user` / `hook` / `schedule`) and set for a composition child.
 *
 * @see specs/ZZ-misc/orchestration/data-model.md — OrchestrationSessionMeta
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md — session.json
 */
export interface OrchestrationSessionMeta {
	/** Matches the session directory name. */
	session_id: string;
	/** The flow's `notor-flow-name`. */
	flow_name: string;
	/** Recovery scans for `active`/`interrupted`. */
	status: "active" | "interrupted" | "completed" | "cancelled" | "error";
	/** Current step-turn / hop count (display/sequence; includes code steps). */
	iteration: number;
	/** Step currently executing (or last, on crash). */
	active_step: string | null;
	/** ISO timestamp at creation. */
	started_at: string;
	/** The original user objective (injected into every step turn). */
	prompt: string;
	/** Composition linkage (`null` for a root). */
	parent_session_id: string | null;
	/** Always set at creation — the recovery discriminator. */
	origin: "user" | "hook" | "schedule" | "run_flow" | "chaining";
	/** Format version — stamped at creation, default-on-read for legacy files. */
	schema_version?: number;
}

// ---------------------------------------------------------------------------
// OrchestrationEvent
// ---------------------------------------------------------------------------

/**
 * A routed event in a flow run. Constructed by `OrchestrationEventEngine.publish()`
 * (which stamps `source_step`, `turn`, `ts`) and read by the safety detectors and
 * recovery replay.
 *
 * @see specs/ZZ-misc/orchestration/data-model.md — OrchestrationEvent
 */
export interface OrchestrationEvent {
	topic: string;
	payload: string;
	/** Emitting step's name; `null` for the flow's starting event. */
	source_step: string | null;
	/** Engine hop/turn counter at emission time. */
	turn: number;
	/** ISO timestamp. */
	ts: string;
}

// ---------------------------------------------------------------------------
// Terminal event constants
// ---------------------------------------------------------------------------

/** Terminal: subject to task-completion enforcement (FR-123). */
export const FLOW_COMPLETE = "FLOW_COMPLETE";
/** Terminal: bypasses task enforcement (FR-132). */
export const FLOW_CANCELLED = "FLOW_CANCELLED";
/** Terminal: emitted by the `FallbackCoordinator` / failure handler on an unrecoverable orphan. */
export const FLOW_ERROR = "FLOW_ERROR";

/** The three terminal topics, as a readonly tuple. */
export const TERMINAL_TOPICS = [FLOW_COMPLETE, FLOW_CANCELLED, FLOW_ERROR] as const;

/** True if `topic` is one of the three terminal constants. */
export function isTerminalTopic(topic: string): boolean {
	return topic === FLOW_COMPLETE || topic === FLOW_CANCELLED || topic === FLOW_ERROR;
}

// ---------------------------------------------------------------------------
// Interactive-pause topics (FR-150 / INT-030)
// ---------------------------------------------------------------------------

/**
 * The pause signal a step emits (via `emit_event` / `orchestration.emit`) to
 * suspend the loop awaiting user input (FR-150). It is an **ordinary topic at
 * the engine layer** (write-before-route applies); the *pause* is the
 * `OrchestrationRunner`'s interpretation of it at its routing boundary, not an
 * engine routing rule. The payload carries the question shown to the user.
 *
 * @see specs/ZZ-misc/orchestration/contracts/event-engine.md — Event Routing Rules
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md — Enforced write order (item 7)
 */
export const USER_INPUT_REQUIRED = "user.input.required";

/**
 * The synthesized **resume** topic the runner publishes once the user supplies
 * input. Its payload is the user's answer; the runner re-triggers the paused
 * step with it (write-before-route). Authors do not declare it as a trigger —
 * the runner routes the resume directly to the paused step.
 */
export const USER_INPUT_RECEIVED = "user.input.received";

// ---------------------------------------------------------------------------
// Code-step argument signature (consumed in Phase 3 INT-010; declared here)
// ---------------------------------------------------------------------------

/**
 * The argument list a code step's compiled `AsyncFunction` receives — mirrors
 * `TOOL_ARG_NAMES` but swaps the last two args (`settings`, `shared`/`params`)
 * for `event` and `orchestration`. Declared here as the single source; consumed
 * by the `CodeStepExecutor` (Phase 3, INT-010).
 *
 * @see specs/ZZ-misc/orchestration/contracts/orchestration-helper.md
 */
export const CODE_STEP_ARG_NAMES = [
	"app",
	"obsidian",
	"utils",
	"libs",
	"event",
	"orchestration",
] as const;
