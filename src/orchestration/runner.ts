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
import type { AggregateBudget, OrchestrationToolContext, RunContext } from "../run-loop/types";
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
	 * Query the session's still-open/running tasks for `FLOW_COMPLETE` enforcement
	 * (INT-003). Returns each remaining task's key + description so the synthesized
	 * `flow.tasks_remaining` re-trigger can enumerate them. Omitted in Phase-1
	 * unit tests (and any flow with no task registry) → treated as no open tasks.
	 */
	listOpenTasks?: () => Promise<Array<{ key: string; description: string }>>;
	/** Optional progress callback surfaced per turn. */
	onProgress?: (status: string) => void;
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

	constructor(private readonly deps: OrchestrationRunnerDeps) {}

	/**
	 * Run `flow` to a terminal event with `promptText` as the objective. Returns
	 * the terminal status + event.
	 */
	async start(flow: OrchestrationFlow, promptText: string): Promise<OrchestrationRunResult> {
		this.startedAtMs = Date.now();
		this.budget = newRootBudget(flow.maxIterations, flow.maxCostUsd);

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
	 *  - `still_paused` / `none` → nothing to drive (INT-030 handles the pause;
	 *    a terminal tail needs no action).
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

		let seed: OrchestrationEvent | null = null;
		if (action.kind === "re_emit_trigger") {
			this.engine.setEmissionContext(this.nextIteration(), null);
			seed = this.engine.publish(action.topic, action.payload, this.deps.sessionLog);
		} else if (action.kind === "re_publish_event") {
			this.engine.setEmissionContext(this.nextIteration(), action.source_step);
			seed = this.engine.publish(action.topic, action.payload, this.deps.sessionLog);
		}

		if (!seed) {
			// still_paused / none — nothing to drive in Phase 2.
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
			if (terminal) return terminal;
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

	private missingRequiredEvents(flow: OrchestrationFlow): string[] {
		const seen = new Set(this.engine.getEventHistory().map((e) => e.topic));
		return flow.requiredEvents.filter((topic) => !seen.has(topic));
	}

	private makeRunContext(flow: OrchestrationFlow): RunContext {
		return {
			depth: 0,
			maxDepth: flow.maxDepth ?? Infinity,
			budget: this.budget,
			subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: 0 },
			abort: this.deps.abortSignal,
		};
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
		return { status, terminal, iterations: this.iteration };
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
