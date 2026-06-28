/**
 * `OrchestrationRunner` (FEAT-010) — the main loop that runs a flow end-to-end.
 *
 * `start(flow, promptText)`:
 *  - registers the `FallbackCoordinator` on `*` and subscribes each step's
 *    `triggers` on the `OrchestrationEventEngine`;
 *  - writes `session.start` and publishes the flow's `startingEvent` with the
 *    user objective as payload;
 *  - drives the event loop: resolve subscribers (in `notor-steps` order), run
 *    each via `StepTurnExecutor`, route the captured/synthesized event back
 *    through the engine, consult `LoopSafetyGuards` each turn;
 *  - owns the **breadth-first FIFO fan-out drain** (Issue-11): a fan-out topic's
 *    subscribers run in `notor-steps` order with their emissions enqueued,
 *    drained FIFO only after the fan-out set is exhausted;
 *  - seeds the **root shared `AggregateBudget` cell** from the flow's finite
 *    (parser-defaulted) `maxIterations`/`maxCostUsd`, referenced by every turn;
 *  - terminates on the flow's `completionEvent` subject to `required_events`
 *    enforcement (a premature completion is blocked and re-injected) and the
 *    **completion no-progress guard** (Issue-9); `FLOW_CANCELLED` / `FLOW_ERROR`
 *    terminate immediately.
 *
 * Full `FLOW_COMPLETE` **task** enforcement (open/running tasks) is Phase 2
 * (INT-003); the runner leaves the hook and enforces only `required_events` in
 * Phase 1. The full `OrchestrationSessionManager` (workspace/scratchpad/tasks/
 * recovery) is Phase 2 (INT-001) — Phase 1 needs only enough of a session to
 * write the log and run turns.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-010
 * @see specs/ZZ-misc/orchestration/contracts/event-engine.md
 */

import type { ConversationMode } from "../types";
import type {
	AggregateBudget,
	OrchestrationToolContext,
	RunContext,
	SubtreeConsumed,
} from "../run-loop/types";
import { newRootBudget } from "../run-loop/budget";
import { logger } from "../utils/logger";
import { FallbackCoordinator } from "./fallback-coordinator";
import { OrchestrationEventEngine } from "./event-engine";
import { LoopSafetyGuards, type ThrashingCounters } from "./safety";
import type { SessionLog } from "./session-log";
import type { RecoverableSession } from "./session-recovery";
import type { StepTurnExecutor } from "./step-turn-executor";
import {
	FLOW_CANCELLED,
	FLOW_COMPLETE,
	FLOW_ERROR,
	isTerminalTopic,
	USER_INPUT_RECEIVED,
	USER_INPUT_REQUIRED,
	type OrchestrationEvent,
	type OrchestrationFlow,
	type StepDefinition,
} from "./types";

const log = logger("OrchestrationRunner");

/** Terminal status of a flow run. */
export type OrchestrationRunStatus = "completed" | "cancelled" | "error";

export interface OrchestrationRunResult {
	status: OrchestrationRunStatus;
	/** The terminal event that ended the loop. */
	terminal: OrchestrationEvent;
	/** Total engine hops (step turns, code + conversation). */
	iterations: number;
	/**
	 * The typed return lifted verbatim from a **terminal** code step's
	 * `orchestration.emit(topic, payload?, structured?)` third arg (FR-104/173);
	 * `null` when no terminal emit carried one (a conversation step or a
	 * non-terminal emit never sets it). This is the only producer of
	 * `RunResult.structured` for flow-as-tool — `run_flow` (INT-043) consumes this,
	 * preferring it over `text`.
	 */
	structured: unknown | null;
	/**
	 * The closing text of the run — the terminal event's payload (the loose
	 * fallback a `run_flow` caller receives when no terminal code step supplied
	 * `structured`, shaped by the callee's `notor-flow-returns`).
	 */
	text: string;
	/**
	 * Aggregate **subtree** rollup for this run (INT-047 / FR-177): this run's own
	 * LLM turns + every settled descendant child flow's subtree, sourced from the
	 * run-level `subtreeConsumed` accumulator — **not** a delta of the shared
	 * `AggregateBudget` cell (which would absorb concurrent siblings' spend). The
	 * `run_flow` tool surfaces these on its `child_run_metadata` block; the
	 * run-tree header reads the root run's totals.
	 */
	subtreeConsumed: SubtreeConsumed;
	/** Aggregate token usage across this run's own turns + settled descendant subtrees. */
	tokenUsage: { input: number; output: number };
}

/** A queued routing job: an event to deliver to a specific subscriber step. */
interface RoutingJob {
	event: OrchestrationEvent;
	step: StepDefinition;
}

export interface OrchestrationRunnerDeps {
	executor: StepTurnExecutor;
	sessionLog: SessionLog;
	/** A fresh per-step orchestration carriage factory (paths + null pendingEmission). */
	makeOrchestrationContext: (conversationId: string) => OrchestrationToolContext;
	/** A fresh conversation id per turn. */
	makeConversationId: () => string;
	mode: ConversationMode;
	sessionId: string;
	/** Root abort signal (cascades into every turn). */
	abortSignal: AbortSignal;
	/** Session origin for the session.start log entry. */
	origin: "user" | "hook" | "run_flow" | "chaining";
	parentSessionId?: string | null;
	/**
	 * Inherited cascade context for a **child** run (INT-043/045/046). When set,
	 * the runner does NOT seed a fresh root `AggregateBudget` cell — it inherits
	 * the parent's **shared** cell **by reference** and the parent's `depth + 1`,
	 * so every child/successor turn draws down the same tree-wide ceiling and an
	 * `A → B → A` chaining cycle terminates at `max_depth` / the shared budget.
	 * Omitted for a root run (`origin: "user"`/`"hook"`), which seeds a fresh root
	 * cell from the flow's finite ceilings. The flow's own `maxDepth` still caps
	 * nesting *below* this run (the effective gate is `min(inherited, flow)`).
	 *
	 * @see specs/ZZ-misc/orchestration/contracts/run-loop.md — Spawn gate
	 */
	inheritedContext?: { budget: AggregateBudget; depth: number };
	/**
	 * Query the session's still-open/running tasks for `FLOW_COMPLETE` enforcement
	 * (INT-003). Returns each remaining task's key + description so the synthesized
	 * `flow.tasks_remaining` re-trigger can enumerate them. Omitted in Phase-1
	 * unit tests (and any flow with no task registry) → treated as no open tasks.
	 */
	listOpenTasks?: () => Promise<Array<{ key: string; description: string }>>;
	/** Optional progress callback surfaced per turn. */
	onProgress?: (status: string) => void;
	/**
	 * Collect user input for an interactive pause (FR-150 / INT-030). Invoked by
	 * the runner when a step emits `user.input.required`; receives the captured
	 * prompt and returns the user's answer, or `null` when the user
	 * declines/dismisses (which finalizes the run via `FLOW_CANCELLED`, reusing
	 * INT-012's terminal path). Omitted in unit tests → a `user.input.required`
	 * emission cannot be answered and the runner cancels the run (so a paused
	 * flow with no UI surface never hangs the loop). The real wiring (launch.ts)
	 * supplies a modal/input prompt.
	 */
	requestUserInput?: (prompt: string) => Promise<string | null>;
	/**
	 * Reflect the live `session.json` status while paused (FR-150 / INT-030): the
	 * runner sets `interrupted` **before** suspending the loop and restores
	 * `active` on resume, so the recovery scan classifies a crash-while-paused as
	 * a dangling `user.input.required` tail ("still paused"). Omitted in unit
	 * tests (and any flow without a session manager) → status is not mirrored
	 * mid-run (the terminal status is still written at finalize by the caller).
	 */
	setSessionStatus?: (status: "active" | "interrupted") => Promise<void>;
}

export class OrchestrationRunner {
	private readonly engine = new OrchestrationEventEngine();
	private readonly fallback = new FallbackCoordinator();
	private readonly guards = new LoopSafetyGuards();
	private readonly abandonCounts: ThrashingCounters = new Map();

	/** Engine hop counter (every executed step, code or conversation). */
	private iteration = 0;
	/** LLM-turn counter (drives the iteration-cap guard; code steps do not advance it). */
	private llmTurns = 0;
	private startedAtMs = 0;
	/** The shared tree-wide budget cell, seeded from the flow's finite ceilings. */
	private budget!: AggregateBudget;
	/** This run's depth in the flow tree (0 = root; child/chaining runs inherit `parent + 1`). */
	private baseDepth = 0;
	/**
	 * Run-level subtree rollup (INT-047 / FR-177): this run's own turns + every
	 * settled descendant child flow's subtree. Accumulated per turn from the step
	 * result + drained `childRunResults`; surfaced on the terminal `RunResult` so
	 * a `run_flow` caller's `child_run_metadata` reflects the whole subtree.
	 */
	private readonly subtree: SubtreeConsumed = { costUsd: 0, iterations: 0, maxDepthReached: 0 };
	/** Aggregate token usage across this run's turns + settled descendant subtrees. */
	private readonly tokenUsage = { input: 0, output: 0 };
	/** The closing text of the most recent turn (the loose `run_flow` fallback return). */
	private lastText = "";

	constructor(private readonly deps: OrchestrationRunnerDeps) {}

	/**
	 * Run `flow` to a terminal event with `promptText` as the objective. Returns
	 * the terminal status + event.
	 */
	async start(flow: OrchestrationFlow, promptText: string): Promise<OrchestrationRunResult> {
		this.startedAtMs = Date.now();
		// A child / chaining run inherits the parent's SHARED budget cell by
		// reference and its depth + 1 (so the whole tree respects one ceiling); a
		// root run seeds a fresh cell from the flow's finite ceilings (INT-046).
		if (this.deps.inheritedContext) {
			this.budget = this.deps.inheritedContext.budget;
			this.baseDepth = this.deps.inheritedContext.depth;
		} else {
			this.budget = newRootBudget(flow.maxIterations, flow.maxCostUsd);
			this.baseDepth = 0;
		}

		this.wireSubscriptions(flow);

		await this.deps.sessionLog.appendSessionStart({
			session_id: this.deps.sessionId,
			flow: flow.name,
			prompt: promptText,
			origin: this.deps.origin,
			parent_session_id: this.deps.parentSessionId ?? null,
		});

		// Publish the starting event (source_step = null) with the objective.
		this.engine.setEmissionContext(this.nextIteration(), null);
		const starting = this.engine.publish(flow.startingEvent, promptText, this.deps.sessionLog);

		const result = await this.drive(flow, promptText, starting);
		await this.finalize(result);
		return result;
	}

	/**
	 * Resume an interrupted session from its classified recovery state (INT-005 /
	 * FR-125). Re-seeds the in-memory budget + safety state from the replayed log
	 * (so a `$5.00` cap is not reset to full and a near-stale loop is not zeroed),
	 * then drives the loop from the classified dangling tail:
	 *  - `re_emit_trigger` → re-emit the interrupted turn's trigger (the step
	 *    retries from fresh context);
	 *  - `re_publish_event` → re-publish the logged-but-not-routed event;
	 *  - `still_paused` → re-surface the prompt for the paused step and resume on
	 *    the user's answer (INT-030 / Risk #9): the `user.input.required` entry is
	 *    already durable, so it is NOT re-appended — re-running recovery over the
	 *    same paused tail re-surfaces the same prompt and does not double-resume;
	 *  - `none` → a terminal tail needs no action.
	 *
	 * Engine-bookkeeping replay is idempotent: it does **not** re-run already
	 * completed turns; it re-injects exactly the one dangling event. Step
	 * execution is at-least-once (the re-emitted trigger re-runs the step) — the
	 * documented recovery boundary.
	 */
	async resume(
		flow: OrchestrationFlow,
		recovered: RecoverableSession,
	): Promise<OrchestrationRunResult> {
		this.startedAtMs = Date.now();
		// Re-seed the budget from the replayed decrements (NOT reset to full).
		this.budget = {
			iterationsRemaining: recovered.budget.iterationsRemaining,
			costRemainingUsd: recovered.budget.costRemainingUsd,
		};
		// Approximate the LLM-turn count from the rehydrated history so the
		// iteration-cap guard reflects pre-crash spend.
		this.llmTurns = Math.max(
			0,
			Math.round(flow.maxIterations - recovered.budget.iterationsRemaining),
		);

		this.wireSubscriptions(flow);
		// Rehydrate the stale-window history + abandonment counters before resuming.
		this.engine.rehydrateHistory(recovered.safety.history);
		for (const [key, count] of recovered.safety.abandonCounts) {
			this.abandonCounts.set(key, count);
		}
		// Advance the hop counter past the pre-crash turns (display/sequence).
		this.iteration = recovered.meta.iteration;

		const objective = recovered.meta.prompt;
		const action = recovered.action;

		// A recovered paused tail (INT-030 / Risk #9): the `user.input.required`
		// entry is already durable in the log, so we do NOT re-append it — we
		// re-surface the prompt and resume from the user's answer. Re-running
		// recovery over the same paused tail re-surfaces the same prompt and does
		// not double-resume (no `user.input.received` is written until the user
		// actually answers — idempotent).
		if (action.kind === "still_paused") {
			const pausedStep = this.findStep(flow, action.step);
			if (!pausedStep) {
				log.warn("Paused session references an unknown step; cannot re-surface prompt", {
					sessionId: recovered.sessionId,
					pausedStep: action.step,
				});
				return this.terminalResult(
					"error",
					this.synthTerminal(FLOW_ERROR, "Paused step is no longer in the flow."),
				);
			}
			const queue: RoutingJob[] = [];
			const pauseTerminal = await this.collectInputAndResume(pausedStep, action.prompt, queue);
			const result = pauseTerminal ?? (await this.driveQueue(flow, objective, queue));
			await this.finalize(result);
			return result;
		}

		let seed: OrchestrationEvent | null = null;
		if (action.kind === "re_emit_trigger") {
			this.engine.setEmissionContext(this.nextIteration(), null);
			seed = this.engine.publish(action.topic, action.payload, this.deps.sessionLog);
		} else if (action.kind === "re_publish_event") {
			this.engine.setEmissionContext(this.nextIteration(), action.source_step);
			seed = this.engine.publish(action.topic, action.payload, this.deps.sessionLog);
		}

		if (!seed) {
			// `none` — a terminal tail needs no action.
			log.info("Resume has no replayable tail; leaving session as-is", {
				sessionId: recovered.sessionId,
				action: action.kind,
			});
			return this.terminalResult("completed", this.synthTerminal(FLOW_COMPLETE, "Nothing to resume."));
		}

		const queue: RoutingJob[] = [];
		const seedTerminal = this.enqueueRouting(flow, seed, queue);
		const result = seedTerminal ?? (await this.driveQueue(flow, objective, queue));
		await this.finalize(result);
		return result;
	}

	/**
	 * Register the mandatory wildcard fallback (cannot be overridden) and subscribe
	 * each step's triggers in `notor-steps` order. Shared by `start` and `resume`.
	 */
	private wireSubscriptions(flow: OrchestrationFlow): void {
		this.engine.subscribe("*", this.fallbackSentinel());
		for (const step of flow.steps) {
			for (const topic of step.triggers) {
				this.engine.subscribe(topic, step);
			}
		}
	}

	// -- The event loop ------------------------------------------------------

	/**
	 * Drive the loop from the starting event. Uses a FIFO queue of routing jobs;
	 * a fan-out topic enqueues every subscriber before any of their consequences
	 * are routed (breadth-first FIFO drain, Issue-11).
	 */
	private async drive(
		flow: OrchestrationFlow,
		objective: string,
		starting: OrchestrationEvent,
	): Promise<OrchestrationRunResult> {
		const queue: RoutingJob[] = [];

		// Seed the queue from the starting event's subscribers.
		const seedTerminal = this.enqueueRouting(flow, starting, queue);
		if (seedTerminal) return seedTerminal;

		return this.driveQueue(flow, objective, queue);
	}

	/**
	 * Drain an already-seeded routing queue to a terminal event. Shared by `drive`
	 * (fresh start) and `resume` (recovery), so both honor the breadth-first FIFO
	 * fan-out drain, the per-turn safety guards, and terminal handling identically.
	 */
	private async driveQueue(
		flow: OrchestrationFlow,
		objective: string,
		queue: RoutingJob[],
	): Promise<OrchestrationRunResult> {
		while (queue.length > 0) {
			if (this.deps.abortSignal.aborted) {
				return this.terminalResult("cancelled", this.synthTerminal(FLOW_CANCELLED, "Run aborted."));
			}

			const job = queue.shift()!;
			const turn = this.nextIteration();

			// Run the step turn.
			const conversationId = this.deps.makeConversationId();
			const ctx = this.deps.makeOrchestrationContext(conversationId);
			// INT-043: expose the calling step's conversation id so a `run_flow` call
			// can write the `child` edge (calling step → child entry conversation)
			// onto this turn's carriage; conversation steps persist it.
			ctx.conversationId = conversationId;
			const runContext = this.makeRunContext(flow);

			this.deps.onProgress?.(`${flow.name}: ${job.step.name} (iteration ${turn})`);

			const turnResult = await this.deps.executor.execute({
				step: job.step,
				flow,
				event: job.event,
				eventHistory: this.engine.getEventHistory(),
				objective,
				iteration: turn,
				orchestrationContext: ctx,
				runContext,
				mode: this.deps.mode,
				conversationId,
				onProgress: this.deps.onProgress,
			});

			if (job.step.mode === "conversation") this.llmTurns += 1;

			// INT-047: fold this turn into the run-level subtree rollup. The turn's
			// own cost/iteration is what RunLoop accrued into runContext.subtreeConsumed
			// (a fresh per-turn accumulator); plus the per-turn cost/tokens the executor
			// surfaced. Then drain any child flows this turn spawned (run_flow) and fold
			// their whole subtrees in — attribution only (their turns already drew down
			// the SHARED budget cell, so we never re-decrement it here).
			this.subtree.costUsd += turnResult.costUsd;
			this.subtree.iterations += job.step.mode === "conversation" ? 1 : 0;
			this.tokenUsage.input += turnResult.tokenUsage.input;
			this.tokenUsage.output += turnResult.tokenUsage.output;
			if (runContext.subtreeConsumed.maxDepthReached > this.subtree.maxDepthReached) {
				this.subtree.maxDepthReached = runContext.subtreeConsumed.maxDepthReached;
			}
			this.foldChildRunResults(ctx);
			this.lastText = turnResult.emission.payload;

			// Publish the captured/synthesized emission (write-before-route).
			this.engine.setEmissionContext(turn, job.step.name);
			const emitted = this.engine.publish(
				turnResult.emission.topic,
				turnResult.emission.payload,
				this.deps.sessionLog,
			);

			// Consult the safety guards each turn (over the post-publish history).
			const guard = this.guards.evaluate({
				flow,
				llmTurns: this.llmTurns,
				startedAtMs: this.startedAtMs,
				history: this.engine.getEventHistory(),
				abandonCounts: this.abandonCounts,
				nowMs: Date.now(),
			});
			if (guard) {
				log.warn("Safety guard fired", { guard: guard.guard, reason: guard.reason });
				return this.terminalResult("error", this.synthTerminal(FLOW_ERROR, guard.reason));
			}

			// Route the emission (terminal handling / fan-out enqueue).
			const terminal = await this.routeEmission(flow, emitted, job.step, queue);
			if (terminal) {
				// Lift a TERMINAL code step's `structured` onto the run result verbatim
				// (FR-173) — only when this turn's emission was terminal and carried one
				// (a non-terminal emit's structured is ignored; event.payload stays the
				// routing string). The terminal we return is for THIS emitted event.
				if (
					isTerminalTopic(emitted.topic) &&
					turnResult.emission.structured !== undefined &&
					terminal.terminal.topic === emitted.topic
				) {
					return { ...terminal, structured: turnResult.emission.structured };
				}
				return terminal;
			}
		}

		// Queue drained with no terminal event — the flow stalled structurally.
		// (Should be unreachable: every emission either terminates, routes to a
		// step, or orphans to the fallback → FLOW_ERROR.)
		return this.terminalResult(
			"error",
			this.synthTerminal(FLOW_ERROR, `Flow '${flow.name}' drained its event queue without terminating.`),
		);
	}

	/**
	 * Route an emitted event: handle terminals (with completion enforcement) or
	 * enqueue the next subscriber(s). Returns a terminal result when the loop
	 * should end, else `null` (work was enqueued).
	 */
	private async routeEmission(
		flow: OrchestrationFlow,
		emitted: OrchestrationEvent,
		sourceStep: StepDefinition,
		queue: RoutingJob[],
	): Promise<OrchestrationRunResult | null> {
		// Terminal short-circuits.
		if (emitted.topic === FLOW_CANCELLED) {
			return this.terminalResult("cancelled", emitted);
		}
		if (emitted.topic === FLOW_ERROR) {
			return this.terminalResult("error", emitted);
		}
		if (emitted.topic === flow.completionEvent || emitted.topic === FLOW_COMPLETE) {
			return this.handleCompletion(flow, emitted, sourceStep, queue);
		}

		// Interactive-pause short-circuit (FR-150 / INT-030). `user.input.required`
		// is NOT routed to a subscriber step — the runner intercepts it as a pause
		// signal, suspends, collects input, and resumes by re-triggering the
		// paused step. (Engine stays UI-agnostic: this is the runner's reading of
		// the captured topic, not an engine routing rule.)
		if (emitted.topic === USER_INPUT_REQUIRED) {
			return this.handlePause(flow, emitted, sourceStep, queue);
		}

		return this.enqueueRouting(flow, emitted, queue, sourceStep);
	}

	/**
	 * Completion enforcement (FR-123). A premature completion is blocked and
	 * re-injected via a synthesized topic auto-subscribed to the completing step;
	 * the no-progress guard (Issue-9) bounds the alternation.
	 *
	 * Two coexisting blocking conditions, kept as a **discrete branch** so INT-012's
	 * `FLOW_CANCELLED` can bypass it without duplicating logic (and it already does —
	 * `FLOW_CANCELLED` short-circuits in {@link routeEmission} before reaching here):
	 *  - **`required_events` unmet** (Phase-1 condition) → re-inject `flow.requirements_unmet`.
	 *  - **open/running tasks** (INT-003) → re-inject `flow.tasks_remaining` whose
	 *    payload enumerates the remaining task keys + descriptions.
	 *
	 * Tasks are queried via the injected `listOpenTasks` (the session's task
	 * registry, INT-002). When both conditions block, the missing required events
	 * are surfaced first.
	 */
	private async handleCompletion(
		flow: OrchestrationFlow,
		emitted: OrchestrationEvent,
		sourceStep: StepDefinition,
		queue: RoutingJob[],
	): Promise<OrchestrationRunResult | null> {
		const missing = this.missingRequiredEvents(flow);

		// INT-003: query the session task registry for still-open/running tasks.
		let openTasks: Array<{ key: string; description: string }> = [];
		if (this.deps.listOpenTasks) {
			try {
				openTasks = await this.deps.listOpenTasks();
			} catch (e) {
				log.warn("listOpenTasks failed during completion enforcement", { error: String(e) });
			}
		}
		const openTaskKeys = openTasks.map((t) => t.key);
		const blockingSet = [...missing, ...openTaskKeys];

		if (blockingSet.length === 0) {
			this.engine.resetNoProgress();
			return this.terminalResult("completed", emitted);
		}

		// Blocked completion — apply the no-progress guard.
		const verdict = this.engine.recordBlockedCompletion(sourceStep.name, blockingSet);
		if (verdict.terminate) {
			return this.terminalResult(
				"error",
				this.synthTerminal(
					FLOW_ERROR,
					`Step '${sourceStep.name}' re-emitted ${flow.completionEvent} ${verdict.count} times ` +
						`without closing the remaining work: [${blockingSet.join(", ")}].`,
				),
			);
		}

		// Choose the re-trigger topic + payload. Missing required events take
		// precedence; otherwise enumerate the remaining tasks (FR-123 payload).
		const reTopic = missing.length > 0 ? "flow.requirements_unmet" : "flow.tasks_remaining";
		const payload =
			missing.length > 0
				? JSON.stringify({ missing })
				: JSON.stringify({ remaining_tasks: openTasks });

		this.engine.setEmissionContext(this.iteration, sourceStep.name);
		const reEvent = this.engine.publish(reTopic, payload, this.deps.sessionLog);
		const subs = this.engine.getSubscribers(reTopic, sourceStep);
		for (const step of subs) {
			queue.push({ event: reEvent, step });
		}
		return null;
	}

	// -- Interactive pause (FR-150 / INT-030) --------------------------------

	/**
	 * Handle a `user.input.required` emission: pause the loop, collect input, and
	 * resume by re-triggering the paused step. The pause is the runner's reading
	 * of the captured topic at its routing boundary (the engine stays UI-agnostic;
	 * [event-engine.md]). Returns a terminal result when the user declines
	 * (`FLOW_CANCELLED`), else `null` (the resume re-trigger was enqueued).
	 *
	 * Write order (vault-schema item 7 / recovery invariant): the
	 * `user.input.required` entry is appended **before** the loop suspends, so a
	 * crash between "asked" and "answered" leaves a dangling `user.input.required`
	 * tail that `INT-005` recovery classifies as "still paused" (not a dangling
	 * `turn.start` that re-emits a trigger). `session.json` `status` is set to
	 * `interrupted` while paused — the same status the recovery scan looks for.
	 */
	private async handlePause(
		flow: OrchestrationFlow,
		emitted: OrchestrationEvent,
		sourceStep: StepDefinition,
		queue: RoutingJob[],
	): Promise<OrchestrationRunResult | null> {
		// Durable pause entry BEFORE suspending (recovery anchor).
		await this.deps.sessionLog.appendUserInputRequired({
			turn: emitted.turn,
			step: sourceStep.name,
			prompt: emitted.payload,
		});
		await this.setSessionStatusSafe("interrupted");
		this.deps.onProgress?.(`${flow.name}: paused awaiting input (${sourceStep.name})`);

		// Suspend the loop: await the user's answer. No further events are consumed
		// until this settles (the driveQueue loop is blocked here).
		return this.collectInputAndResume(sourceStep, emitted.payload, queue);
	}

	/**
	 * Collect user input for a paused step and resume the loop, or finalize with
	 * `FLOW_CANCELLED` when the user declines. Shared by the live pause path
	 * ({@link handlePause}) and a recovered paused tail ({@link resume}); the
	 * caller owns writing the `user.input.required` entry (the live path writes it;
	 * a recovered tail already has it durably in the log — re-running recovery must
	 * NOT re-append it, which is what keeps re-resume idempotent).
	 *
	 * On input it writes `user.input.received` **before** publishing the resume
	 * event (write-before-route), restores `status: active`, then re-triggers the
	 * paused step with the user's answer as the event payload (the resume routes
	 * directly to the paused step — author declares no trigger for it, mirroring
	 * the completion re-trigger auto-subscription).
	 */
	private async collectInputAndResume(
		pausedStep: StepDefinition,
		prompt: string,
		queue: RoutingJob[],
	): Promise<OrchestrationRunResult | null> {
		const userInput = this.deps.requestUserInput
			? await this.deps.requestUserInput(prompt)
			: null;

		if (userInput === null) {
			// Declined / dismissed (or no input channel) → finalize via FLOW_CANCELLED
			// (INT-012), bypassing task enforcement. Open tasks do not block the cancel.
			return this.terminalResult(
				"cancelled",
				this.synthTerminal(
					FLOW_CANCELLED,
					`User declined the input prompt from step '${pausedStep.name}'.`,
				),
			);
		}

		// Resume: user.input.received BEFORE the resume event is routed.
		await this.deps.sessionLog.appendUserInputReceived({
			turn: this.iteration,
			payload: userInput,
		});
		await this.setSessionStatusSafe("active");

		// Publish the resume event (write-before-route) and re-trigger the paused
		// step directly with the user's payload.
		this.engine.setEmissionContext(this.iteration, null);
		const resumeEvent = this.engine.publish(USER_INPUT_RECEIVED, userInput, this.deps.sessionLog);
		queue.push({ event: resumeEvent, step: pausedStep });
		return null;
	}

	/** Mirror `session.json` status while paused/resumed; never throws into the loop. */
	private async setSessionStatusSafe(status: "active" | "interrupted"): Promise<void> {
		if (!this.deps.setSessionStatus) return;
		try {
			await this.deps.setSessionStatus(status);
		} catch (e) {
			log.warn("Failed to mirror session status during pause/resume", {
				status,
				error: String(e),
			});
		}
	}

	/**
	 * Resolve subscribers for `event` and enqueue routing jobs (breadth-first:
	 * all subscribers of a fan-out topic enqueued together). An orphaned event
	 * (no concrete subscriber) goes to the fallback → terminal `FLOW_ERROR`.
	 */
	private enqueueRouting(
		flow: OrchestrationFlow,
		event: OrchestrationEvent,
		queue: RoutingJob[],
		completingStep?: StepDefinition,
	): OrchestrationRunResult | null {
		const subscribers = this.engine.getSubscribers(event.topic, completingStep ?? null);
		if (subscribers.length === 0) {
			// Orphan → fallback (pure backstop → diagnosable FLOW_ERROR).
			const terminal = this.fallback.handle(event, flow);
			return this.terminalResult("error", terminal);
		}
		for (const step of subscribers) {
			queue.push({ event, step });
		}
		return null;
	}

	// -- Finalization --------------------------------------------------------

	private async finalize(result: OrchestrationRunResult): Promise<void> {
		if (result.status === "cancelled") {
			await this.deps.sessionLog.appendSessionCancelled({ reason: result.terminal.payload });
		} else if (result.status === "error") {
			// FLOW_ERROR is recorded as a cancellation-style terminal with the
			// error reason; a dedicated session.error entry is Phase 2 (INT-001).
			await this.deps.sessionLog.appendSessionCancelled({ reason: result.terminal.payload });
		} else {
			await this.deps.sessionLog.appendSessionComplete();
		}
	}

	// -- Helpers -------------------------------------------------------------

	private nextIteration(): number {
		this.iteration += 1;
		return this.iteration;
	}

	/** Resolve a step by name within the flow (or `null`). */
	private findStep(flow: OrchestrationFlow, name: string | null): StepDefinition | null {
		if (!name) return null;
		return flow.steps.find((s) => s.name === name) ?? null;
	}

	private missingRequiredEvents(flow: OrchestrationFlow): string[] {
		const seen = new Set(this.engine.getEventHistory().map((e) => e.topic));
		return flow.requiredEvents.filter((topic) => !seen.has(topic));
	}

	private makeRunContext(flow: OrchestrationFlow): RunContext {
		return {
			depth: this.baseDepth,
			// The effective spawn ceiling below this run is the tighter of the
			// inherited tree depth budget and the flow's own `notor-max-depth`
			// (offset by where this run sits in the tree), so a callee can only
			// *narrow* nesting, never widen it past an ancestor's `max_depth`.
			maxDepth:
				flow.maxDepth !== null && flow.maxDepth !== undefined
					? this.baseDepth + flow.maxDepth
					: Infinity,
			budget: this.budget,
			// A fresh per-turn accumulator: the step turn (and any child it spawns
			// via run_flow) folds its spend here; the runner then folds it into the
			// run-level `subtree` rollup after the turn.
			subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: this.baseDepth },
			abort: this.deps.abortSignal,
		};
	}

	/**
	 * Drain a turn's `childRunResults` carriage and fold each settled child flow's
	 * subtree into the run-level rollup (INT-047 / FR-177). Attribution only — the
	 * child's turns already decremented the shared `AggregateBudget` cell by
	 * reference, so this must NOT re-decrement the budget. `maxDepthReached` takes
	 * the deepest child subtree.
	 */
	private foldChildRunResults(ctx: OrchestrationToolContext): void {
		const children = ctx.childRunResults;
		if (!children || children.length === 0) return;
		for (const child of children) {
			this.subtree.costUsd += child.costUsd;
			this.subtree.iterations += child.iterations;
			this.tokenUsage.input += child.tokenUsage.input;
			this.tokenUsage.output += child.tokenUsage.output;
			if (child.maxDepthReached > this.subtree.maxDepthReached) {
				this.subtree.maxDepthReached = child.maxDepthReached;
			}
		}
		// Drained — never folded twice (mirrors the workflowInvocations drain).
		ctx.childRunResults = [];
	}

	private synthTerminal(topic: string, payload: string): OrchestrationEvent {
		return {
			topic,
			payload,
			source_step: null,
			turn: this.iteration,
			ts: new Date().toISOString(),
		};
	}

	private terminalResult(
		status: OrchestrationRunStatus,
		terminal: OrchestrationEvent,
	): OrchestrationRunResult {
		return {
			status,
			terminal,
			iterations: this.iteration,
			structured: null,
			// The loose `run_flow` fallback return: prefer the terminal event's own
			// payload, else the most recent turn's closing text.
			text: terminal.payload || this.lastText,
			subtreeConsumed: { ...this.subtree },
			tokenUsage: { ...this.tokenUsage },
		};
	}

	/**
	 * The fallback's `*` registration uses a sentinel step (the engine's wildcard
	 * slot stores a `StepDefinition`); the runner never executes it — it consults
	 * the `FallbackCoordinator` directly when `getSubscribers` is empty.
	 */
	private fallbackSentinel(): StepDefinition {
		return {
			name: "__fallback__",
			description: "Mandatory wildcard fallback (FallbackCoordinator).",
			triggers: ["*"],
			publishes: [FLOW_ERROR],
			defaultPublishes: null,
			persona: null,
			model: null,
			mode: "code",
			mcpServers: null,
			timeoutSeconds: null,
			bodyContent: "",
			notePath: "",
		};
	}
}
