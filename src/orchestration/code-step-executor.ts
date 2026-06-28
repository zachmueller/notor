/**
 * `CodeStepExecutor` (INT-010) — the deterministic code-step execution path.
 *
 * When `StepTurnExecutor` (FEAT-007) sees a step with `notor-step-mode: code`, it
 * delegates here instead of the conversation path: this executor **skips**
 * persona activation, `ConversationSession` creation, and prompt assembly, and
 * runs the step's TypeScript code fence through the **existing** Sucrase pipeline
 * (`stripTypes()` + `new AsyncFunction(...names, code)` from
 * `src/extensions/compiler.ts`) — there is **no second compiler**. The fence is
 * compiled with {@link CODE_STEP_ARG_NAMES}
 * (`["app", "obsidian", "utils", "libs", "event", "orchestration"]`).
 *
 * A code step creates **no conversation and consumes zero tokens**; it is **not
 * an LLM turn**, so it draws on neither half of the shared `RunContext.budget`
 * cell. It **does** advance the engine step-turn counter, participate in
 * stale-loop detection (it emits an event), and elapse wall-clock runtime — the
 * engine (FEAT-008), not this executor, owns those guards.
 *
 * Pipeline (authority: contracts/orchestration-helper.md):
 *  1. extract the first `ts`/`typescript`/`js`/`javascript` fence from the step
 *     note `bodyContent`;
 *  2. strip types + compile;
 *  3. execute the async function under a **timeout guard** (default 300 s,
 *     overridable via `notor-step-timeout-seconds`);
 *  4. capture the returned {@link CodeStepResult} and hand `{topic, payload,
 *     structured}` back to the engine for write-before-route routing.
 *
 * **Error handling (FR-130).** A code step must **never crash the plugin**. On a
 * missing fence, compile error, runtime throw, unhandled rejection, or timeout,
 * the executor synthesizes a **`{step}.code_error`** emission whose payload
 * carries the error message + stack, shows an error `Notice`, and **still** writes
 * `turn.start` / `turn.complete` to `session-log.jsonl` for audit + crash
 * recovery.
 *
 * **Known limitation (Issue-7).** Code steps run as `new AsyncFunction(...)` on
 * the main event-loop thread — no Worker/VM isolation in v1. The `setTimeout`
 * guard can only preempt at an `await` boundary: an unbounded **synchronous**
 * loop never yields and freezes the plugin. Mitigation is authoring guidance
 * (INT-013 / the `orchestration-creator` persona): never write an unbounded sync
 * loop; insert `await` yield points in long loops.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-3-code-steps.md — INT-010
 * @see specs/ZZ-misc/orchestration/contracts/orchestration-helper.md
 */

import { stripTypes, compileFunction } from "../extensions/compiler";
import { extractCodeFence } from "../extensions/parser";
import { logger } from "../utils/logger";
import { DEFAULT_CODE_STEP_TIMEOUT_SECONDS } from "./constants";
import {
	buildOrchestrationHelper,
	projectCodeStepEvent,
	type CodeStepResult,
	type ScratchpadFs,
} from "./orchestration-helper";
import type { SessionLog } from "./session-log";
import type { StepTurnRequest, StepTurnResult } from "./step-turn-executor";
import type { TaskRegistry } from "./task-registry";
import { CODE_STEP_ARG_NAMES } from "./types";

const log = logger("CodeStepExecutor");

/**
 * The per-turn runtime a code step executes against. The `app`/`obsidian`/
 * `utils`/`libs` objects are the **identical** ones user-defined tools receive
 * (`buildUtils()` / `buildLibs()` / `buildObsidianExports()`) — nothing
 * orchestration-specific is added to them. The remaining members are the seams
 * the `orchestration` helper closes over.
 */
export interface CodeStepRuntime {
	/** Obsidian `App` — identical to user tools. */
	app: unknown;
	/** The `obsidian` module exports — identical to user tools. */
	obsidian: unknown;
	/** `ExtensionUtils` — IDENTICAL to user-defined tools (inherits executeShellCommand/notify/…). */
	utils: unknown;
	/** Bundled libs — IDENTICAL to user-defined tools. */
	libs: unknown;
	/** The dispatcher `orchestration.callTool`/`callMcpTool` route through. */
	dispatcher: import("../chat/dispatcher").ToolDispatcher;
	/** Scratchpad filesystem surface (auto-allowed session path). */
	scratchpadFs: ScratchpadFs;
	/** Shared task backing (INT-002). */
	taskRegistry: TaskRegistry;
	/**
	 * `side_effect.committed` keys recorded this session — SHARED across the whole
	 * run (seeded from recovery), so `orchestration.once(...)` dedupes across turns
	 * and across a crash. Mutated in place when a guarded effect commits.
	 */
	committedKeys: Set<string>;
}

/** Builds the per-turn {@link CodeStepRuntime} for a code step. */
export interface CodeStepRuntimeFactory {
	build(args: {
		step: StepTurnRequest["step"];
		orchestrationContext: StepTurnRequest["orchestrationContext"];
		abortSignal: AbortSignal;
	}): Promise<CodeStepRuntime>;
}

export interface CodeStepExecutorDeps {
	runtimeFactory: CodeStepRuntimeFactory;
	/**
	 * Show an error `Notice` on a code-step failure — the one non-silent UI path
	 * besides explicit `utils.notify` (FR-130). Omitted in unit tests (the error
	 * still routes via `{step}.code_error`).
	 */
	notifyError?: (message: string) => void;
}

/** Thrown internally when the outer timeout guard fires (at an `await` boundary). */
class CodeStepTimeoutError extends Error {
	constructor(timeoutSeconds: number) {
		super(
			`Code step exceeded its ${timeoutSeconds}s timeout. (Note: the guard fires only at an ` +
				`await boundary — an unbounded synchronous loop is not interruptible; insert await yield points.)`,
		);
		this.name = "CodeStepTimeoutError";
	}
}

export class CodeStepExecutor {
	constructor(
		private readonly deps: CodeStepExecutorDeps,
		private readonly sessionLog: SessionLog,
	) {}

	/**
	 * Execute one code-step turn. Always writes `turn.start` / `turn.complete`
	 * (even on error) and returns the captured/synthesized emission for the runner
	 * to route. Never throws — every failure becomes a `{step}.code_error` emission.
	 */
	async execute(req: StepTurnRequest): Promise<StepTurnResult> {
		const { step, event } = req;

		// turn.start BEFORE execution (recovery anchor); conversation_id null (no conversation).
		await this.sessionLog.appendTurnStart({
			turn: req.iteration,
			step: step.name,
			trigger_topic: event.topic,
			conversation_id: null,
		});

		const emission = await this.runCodeStep(req);

		// turn.complete is written EVEN on error (audit + recovery). Zero cost/tokens.
		await this.sessionLog.appendTurnComplete({
			turn: req.iteration,
			step: step.name,
			emitted_topic: emission.topic,
			conversation_id: null,
			cost_usd: 0,
			token_usage: { input: 0, output: 0 },
		});

		const stopReason = emission.topic === `${step.name}.code_error` ? "error" : "completed";
		return { emission, stopReason, costUsd: 0, tokenUsage: { input: 0, output: 0 } };
	}

	/**
	 * The extract → compile → execute → capture core. Returns the emission
	 * (captured `CodeStepResult`, synthesized `default_publishes`/`{step}.no_emit`,
	 * or a `{step}.code_error` on any failure). Never throws.
	 */
	private async runCodeStep(
		req: StepTurnRequest,
	): Promise<{ topic: string; payload: string; structured?: unknown }> {
		const { step } = req;
		try {
			// (1) Extract the first ts/typescript/js/javascript fence.
			const fence = extractCodeFence(step.bodyContent);
			if (!fence) {
				return this.codeError(
					step.name,
					new Error(
						`Code step '${step.name}' has no executable code fence ` +
							"(expected ```ts / ```typescript / ```js / ```javascript).",
					),
				);
			}

			// (2) Strip types + (3) compile to an AsyncFunction with CODE_STEP_ARG_NAMES.
			const stripped = stripTypes(fence.code);
			const fn = compileFunction(CODE_STEP_ARG_NAMES, stripped);

			// Build the per-turn runtime (identical utils/libs + helper seams).
			const runtime = await this.deps.runtimeFactory.build({
				step,
				orchestrationContext: req.orchestrationContext,
				abortSignal: req.runContext.abort,
			});

			const helper = buildOrchestrationHelper({
				flowName: req.flow.name,
				iteration: req.iteration,
				stepName: step.name,
				mcpServers: step.mcpServers,
				orchestrationContext: req.orchestrationContext,
				runContext: req.runContext,
				mode: req.mode,
				dispatcher: runtime.dispatcher,
				scratchpadFs: runtime.scratchpadFs,
				taskRegistry: runtime.taskRegistry,
				sessionLog: this.sessionLog,
				committedKeys: runtime.committedKeys,
				eventHistory: req.eventHistory,
			});

			const codeEvent = projectCodeStepEvent(req.event);

			// (4) Execute under the timeout guard (whole async function).
			const timeoutSeconds = step.timeoutSeconds ?? DEFAULT_CODE_STEP_TIMEOUT_SECONDS;
			const returned = await this.runWithTimeout(
				() =>
					fn(
						runtime.app,
						runtime.obsidian,
						runtime.utils,
						runtime.libs,
						codeEvent,
						helper,
					),
				timeoutSeconds,
			);

			return this.resolveEmission(step, returned);
		} catch (e) {
			return this.codeError(step.name, e);
		}
	}

	/**
	 * Resolve the next event from the code step's return value:
	 *  - a returned {@link CodeStepResult} (the only thing `orchestration.emit`
	 *    constructs) wins;
	 *  - otherwise (returned nothing / a bare un-`return`ed emit) synthesize the
	 *    step's `default_publishes`, or `{step}.no_emit` when none is declared
	 *    (parity with a no-emit conversation turn, FR-115).
	 */
	private resolveEmission(
		step: StepTurnRequest["step"],
		returned: unknown,
	): { topic: string; payload: string; structured?: unknown } {
		if (isCodeStepResult(returned)) {
			const emission: { topic: string; payload: string; structured?: unknown } = {
				topic: returned.topic,
				payload: typeof returned.payload === "string" ? returned.payload : "",
			};
			if (returned.structured !== undefined) emission.structured = returned.structured;
			return emission;
		}
		if (step.defaultPublishes) {
			return { topic: step.defaultPublishes, payload: "" };
		}
		return {
			topic: `${step.name}.no_emit`,
			payload: `Code step '${step.name}' returned no orchestration.emit(...) result and declares no default_publishes.`,
		};
	}

	/**
	 * Build the `{step}.code_error` emission, show an error Notice, and log. The
	 * payload carries the error message + stack so the failure is diagnosable
	 * (Issue-10) — a subscribing step, or the engine's default failure handler,
	 * routes it to a *named* `FLOW_ERROR` rather than an anonymous orphan.
	 */
	private codeError(
		stepName: string,
		error: unknown,
	): { topic: string; payload: string } {
		const message = error instanceof Error ? error.message : String(error);
		const stack = error instanceof Error ? error.stack : undefined;
		log.warn("Code step errored", { step: stepName, error: message });
		this.deps.notifyError?.(`Code step '${stepName}' failed: ${message}`);
		return {
			topic: `${stepName}.code_error`,
			payload: JSON.stringify({ step: stepName, error: message, stack: stack ?? null }),
		};
	}

	/**
	 * Race the compiled function against a `setTimeout`. The guard fires only at an
	 * `await` boundary (Issue-7) — a synchronous loop is not interruptible. The
	 * timer is always cleared so a fast step does not leak a pending timeout.
	 */
	private async runWithTimeout(
		invoke: () => Promise<unknown>,
		timeoutSeconds: number,
	): Promise<unknown> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new CodeStepTimeoutError(timeoutSeconds)), timeoutSeconds * 1000);
		});
		try {
			// `invoke()` returns the AsyncFunction's promise; a synchronous throw
			// inside it surfaces as a rejected promise (async-function semantics).
			return await Promise.race([Promise.resolve().then(invoke), timeout]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
}

/** True if `value` is a {@link CodeStepResult} (an object with a string `topic`). */
function isCodeStepResult(value: unknown): value is CodeStepResult {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { topic?: unknown }).topic === "string"
	);
}
