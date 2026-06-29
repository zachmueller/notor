/**
 * `OrchestrationHelper` runtime API (INT-011) — the `orchestration` object
 * injected as the sixth code-step argument, plus the read-only `event`
 * (`CodeStepEvent`) projection of the routed `OrchestrationEvent`.
 *
 * A code step (`notor-step-mode: code`) runs deterministically — no LLM, no
 * conversation, zero tokens. This module builds the orchestration-specific
 * capability surface it gets; `utils`/`libs` are the **identical** objects
 * user-defined tools receive (built by `CodeStepExecutor`, INT-010), so nothing
 * orchestration-specific is added to them — it all lives here.
 *
 * Authority for this interface + per-member semantics:
 * specs/ZZ-misc/orchestration/contracts/orchestration-helper.md. The shapes
 * (`CodeStepEvent` / `CodeStepResult` / `OrchestrationHelper`) are defined here
 * (data-model.md links here).
 *
 * The factory is **pure over injected seams** (`ScratchpadFs`, `TaskRegistry`,
 * `ToolDispatcher`, `SessionLog`) so it unit-tests with fakes and so a code
 * step in session A can only ever reach session A's scratchpad/tasks (every path
 * is closed over at build time — nothing is resolved globally).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-3-code-steps.md — INT-011
 * @see specs/ZZ-misc/orchestration/contracts/orchestration-helper.md
 */

import type { ConversationMode } from "../types";
import type { ToolDispatcher } from "../chat/dispatcher";
import type { OrchestrationToolContext, RunContext } from "../run-loop/types";
import { logger, type Logger } from "../utils/logger";
import type { SessionLog } from "./session-log";
import { TaskRegistry, type TaskNote, type TaskStatus } from "./task-registry";
import type { OrchestrationEvent } from "./types";

const log = logger("OrchestrationHelper");

// ---------------------------------------------------------------------------
// Injected shapes (authority: contracts/orchestration-helper.md)
// ---------------------------------------------------------------------------

/**
 * The incoming trigger event, injected as `event`. The read-only projection of
 * the routed {@link OrchestrationEvent} — the engine-only fields (`turn`, `ts`)
 * are not exposed. `payload` is always a string (author conventions JSON-encode
 * structured data and `JSON.parse` it in the step).
 */
export interface CodeStepEvent {
	topic: string;
	payload: string;
	/** Emitting step's name; `null` for the flow's starting event. */
	source_step: string | null;
}

/**
 * The value a code step **returns** to route the next event — the deterministic
 * analog of a conversation step's captured `emit_event`. Only
 * `orchestration.emit(...)` constructs it (authors never build it by hand).
 */
export interface CodeStepResult {
	/** Next event topic (may be terminal: FLOW_COMPLETE / FLOW_CANCELLED / FLOW_ERROR). */
	topic: string;
	/** Next event payload (defaults to ""). */
	payload: string;
	/** Optional typed return; lifted onto `RunResult.structured` by a TERMINAL emit only. */
	structured?: unknown;
}

/**
 * The orchestration-specific helper injected as `orchestration`. Single
 * authority: contracts/orchestration-helper.md.
 */
export interface OrchestrationHelper {
	/** Build the terminal {@link CodeStepResult} that routes the next event (MUST be returned). */
	emit(topic: string, payload?: string, structured?: unknown): CodeStepResult;
	/** At-least-once side-effect guard for crash recovery (FR-125). */
	once<T>(key: string, fn: () => Promise<T>): Promise<T | undefined>;
	/** The session scratchpad — shared, restriction-free working space (OVERWRITE-ONLY). */
	scratchpad: {
		read(file: string): Promise<string | null>;
		write(file: string, content: string): Promise<void>;
		list(): Promise<string[]>;
		exists(file: string): Promise<boolean>;
	};
	/** Dispatch a registered built-in tool by name (threads runContext + orchestrationContext). */
	callTool(toolName: string, params: Record<string, unknown>): Promise<string>;
	/** Dispatch a tool on a connected MCP server (`{serverName}__{toolName}` internally). */
	callMcpTool(serverName: string, toolName: string, params: Record<string, unknown>): Promise<string>;
	/** The runtime task registry for this session (same backing as the task tool scaffolds, FR-122). */
	tasks: {
		list(filter?: { status?: TaskStatus }): Promise<TaskNote[]>;
		ensure(key: string, description: string): Promise<void>;
		start(key: string): Promise<void>;
		close(key: string): Promise<void>;
	};
	/** Read-only flow/session metadata for the current turn. */
	flow: {
		name: string;
		iteration: number;
		sessionId: string;
	};
	/** Recent event history for the current session (newest last), most-recent `limit` (default: all). */
	eventHistory(limit?: number): OrchestrationEvent[];
	/**
	 * Persisted logic-path logger. Each call appends a `step.log` entry to
	 * `session-log.jsonl` (**always** — independent of the console log level) AND
	 * tees to the scoped console logger (which honors the level). The persisted
	 * logs surface in the run-tree under this code step's node, so prefer this over
	 * `utils.logger` inside a code step when you want the logic path to be visible
	 * without DevTools.
	 */
	log: Logger;
}

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

/**
 * The minimal durable scratchpad surface the helper needs (vault adapter in
 * production; a fake in tests). Paths are vault-relative, forward-slash. `read`
 * returns `null` for an absent file; `write` is overwrite-only.
 */
export interface ScratchpadFs {
	read(path: string): Promise<string | null>;
	write(path: string, content: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	/** List file names (relative to `dir`) directly under `dir`. Empty if absent. */
	list(dir: string): Promise<string[]>;
}

export interface BuildOrchestrationHelperArgs {
	/** Owning flow's `notor-flow-name` (for `flow.name`). */
	flowName: string;
	/** Engine step-turn / HOP counter for this turn (`flow.iteration`; includes code steps). */
	iteration: number;
	/** The owning step's name (for `side_effect.committed` audit + error context). */
	stepName: string;
	/** `notor-step-mcp-servers` filter (null = inherit all connected). */
	mcpServers: string[] | null;
	/** The per-step session carriage (sessionId + scratchpad/tasks paths + abort propagation). */
	orchestrationContext: OrchestrationToolContext;
	/** Depth + SHARED aggregate-budget cell + parent abort — threaded onto tool dispatch. */
	runContext: RunContext;
	/** Conversation mode (Plan / Act) — threaded onto tool dispatch. */
	mode: ConversationMode;
	/** The dispatcher `callTool`/`callMcpTool` route through (same seam as LLM tool calls). */
	dispatcher: ToolDispatcher;
	/** Scratchpad filesystem surface. */
	scratchpadFs: ScratchpadFs;
	/** Shared task backing (INT-002) — the `tasks` member delegates to it. */
	taskRegistry: TaskRegistry;
	/** Session log (for `once()` `side_effect.committed` appends). */
	sessionLog: SessionLog;
	/** `side_effect.committed` keys already recorded this session (seeded from recovery). */
	committedKeys: Set<string>;
	/** Event history snapshot for `eventHistory()` (newest last). */
	eventHistory: OrchestrationEvent[];
	/** Optional message-id generator for dispatch event correlation (default: deterministic counter). */
	makeMessageId?: () => string;
}

// ---------------------------------------------------------------------------
// CodeStepEvent projection
// ---------------------------------------------------------------------------

/** Project the routed {@link OrchestrationEvent} into the read-only {@link CodeStepEvent}. */
export function projectCodeStepEvent(event: OrchestrationEvent): CodeStepEvent {
	return { topic: event.topic, payload: event.payload, source_step: event.source_step };
}

/**
 * Build the `orchestration.log` {@link Logger}. Each level tees the call to the
 * scoped console logger (which respects the configured console log level) AND
 * appends a `step.log` entry to the session log **unconditionally** (so the
 * run-tree shows the logic path even when the console is gated to `error`). The
 * append is fire-and-forget (`void`) on the session log's serialized write chain;
 * a failed/unserializable append is swallowed there, never crashing the step.
 */
function makeStepLogger(sessionLog: SessionLog, stepName: string, iteration: number): Logger {
	const console = logger(`code-step:${stepName}`);
	const tee =
		(level: "debug" | "info" | "warn" | "error") =>
		(message: string, data?: unknown): void => {
			console[level](message, data);
			void sessionLog.appendStepLog({ turn: iteration, step: stepName, level, message, data });
		};
	return { debug: tee("debug"), info: tee("info"), warn: tee("warn"), error: tee("error") };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the `orchestration` helper for one code-step turn. Every path/registry
 * is closed over — the returned object resolves nothing globally.
 */
export function buildOrchestrationHelper(args: BuildOrchestrationHelperArgs): OrchestrationHelper {
	const {
		flowName,
		iteration,
		stepName,
		mcpServers,
		orchestrationContext,
		runContext,
		mode,
		dispatcher,
		scratchpadFs,
		taskRegistry,
		sessionLog,
		committedKeys,
		eventHistory,
	} = args;

	const scratchpadDir = orchestrationContext.scratchpadPath.replace(/\/+$/, "");
	const tasksDir = orchestrationContext.tasksPath;
	const sessionId = orchestrationContext.sessionId;

	let msgSeq = 0;
	const makeMessageId =
		args.makeMessageId ?? (() => `code-step:${stepName}:${iteration}:${msgSeq++}`);

	/** Resolve a scratchpad file name to its vault-relative path (forbid traversal out of the dir). */
	const scratchpadPathFor = (file: string): string => {
		const clean = file.replace(/^\/+/, "");
		if (clean.split("/").some((seg) => seg === "..")) {
			throw new Error(`Invalid scratchpad file name (path traversal): "${file}"`);
		}
		return `${scratchpadDir}/${clean}`;
	};

	const callTool = async (
		toolName: string,
		params: Record<string, unknown>,
	): Promise<string> => {
		const result = await dispatcher.dispatch(
			toolName,
			params,
			mode,
			makeMessageId(),
			runContext.abort, // abortSignal — observe parent abort at await boundaries
			undefined, // onProgress
			undefined, // policyCtx
			undefined, // perCallApprovalCallback
			undefined, // sessionContext
			undefined, // approvalHookDispatcher
			undefined, // interactionCallback
			runContext, // thread the spawn gate (depth + shared budget + abort)
			orchestrationContext, // thread the per-step session carriage
		);
		if (!result.success) {
			// A dispatch failure rejects so INT-010 surfaces it as {step}.code_error.
			throw new Error(
				`Tool '${toolName}' failed: ${result.error ?? "unknown dispatch error"}`,
			);
		}
		return typeof result.result === "string"
			? result.result
			: JSON.stringify(result.result);
	};

	const callMcpTool = async (
		serverName: string,
		toolName: string,
		params: Record<string, unknown>,
	): Promise<string> => {
		// Respect the step's notor-step-mcp-servers filter (null = inherit all).
		if (mcpServers !== null && !mcpServers.includes(serverName)) {
			throw new Error(
				`MCP server '${serverName}' is not permitted for step '${stepName}' ` +
					`(notor-step-mcp-servers filter).`,
			);
		}
		return callTool(`${serverName}__${toolName}`, params);
	};

	return {
		emit(topic: string, payload?: string, structured?: unknown): CodeStepResult {
			const result: CodeStepResult = { topic, payload: payload ?? "" };
			if (structured !== undefined) result.structured = structured;
			return result;
		},

		async once<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
			if (committedKeys.has(key)) {
				log.debug("once() skipped — already committed", { key, step: stepName });
				return undefined;
			}
			const value = await fn();
			// Record the commit AFTER fn() lands (best-effort, not exactly-once — a
			// crash between fn() and this append re-runs the effect on recovery).
			committedKeys.add(key);
			await sessionLog.appendSideEffectCommitted({ turn: iteration, step: stepName, key });
			return value;
		},

		scratchpad: {
			read: async (file) => scratchpadFs.read(scratchpadPathFor(file)),
			write: async (file, content) => scratchpadFs.write(scratchpadPathFor(file), content),
			exists: async (file) => scratchpadFs.exists(scratchpadPathFor(file)),
			list: async () => {
				const paths = await scratchpadFs.list(scratchpadDir);
				return paths.map((p) => p.split("/").pop() ?? p);
			},
		},

		callTool,
		callMcpTool,

		tasks: {
			list: (filter) => taskRegistry.list(tasksDir, filter),
			ensure: async (key, description) => {
				await taskRegistry.ensure(tasksDir, key, description);
			},
			start: async (key) => {
				await taskRegistry.start(tasksDir, key);
			},
			close: async (key) => {
				await taskRegistry.close(tasksDir, key);
			},
		},

		flow: { name: flowName, iteration, sessionId },

		eventHistory(limit?: number): OrchestrationEvent[] {
			if (limit === undefined || limit >= eventHistory.length) return [...eventHistory];
			if (limit <= 0) return [];
			return eventHistory.slice(eventHistory.length - limit);
		},

		log: makeStepLogger(sessionLog, stepName, iteration),
	};
}
