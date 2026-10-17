/**
 * `OrchestrationEventEngine` (FEAT-003) — the pub/sub routing core of a flow run.
 *
 * Steps communicate only by publishing named events; the engine routes each
 * event to the next step(s) by trigger subscription. It owns:
 *
 *  - **Write-before-route** (FR-112): `publish()` appends `event.emitted` to the
 *    session log (via {@link SessionLog}) **before** the event is exposed to any
 *    subscriber. The append is enqueued synchronously on the log's serialized
 *    write chain, so it is ordered ahead of the next turn's `turn.start`.
 *  - **Subscriber resolution** in `notor-steps` order; a `*` wildcard slot
 *    reserved for the `FallbackCoordinator` that cannot be overridden.
 *  - **Synthesized-topic auto-subscription** (FR-123): `flow.tasks_remaining` /
 *    `flow.requirements_unmet` route to the completing step when no explicit
 *    subscriber exists.
 *  - **Completion no-progress delta** (Issue-9): tracks consecutive blocked
 *    `FLOW_COMPLETE` from the same step whose blocking set did not shrink; the
 *    runner reads the verdict and terminates with `FLOW_ERROR` at the threshold.
 *  - The in-session **event history** the safety detectors read.
 *
 * The engine does **not** execute steps and performs **no mid-turn routing** —
 * the `OrchestrationRunner` (FEAT-010) drives execution and owns the
 * breadth-first FIFO fan-out drain.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-003
 * @see specs/ZZ-misc/orchestration/contracts/event-engine.md
 */

import { logger } from "../utils/logger";
import { COMPLETION_NOPROGRESS_THRESHOLD } from "./constants";
import type { SessionLog } from "./session-log";
import type { OrchestrationEvent, StepDefinition } from "./types";

const log = logger("EventEngine");

/** Handle returned by `subscribe()`; calling it removes the subscription. */
export type Unsubscribe = () => void;

/** The wildcard topic reserved for the `FallbackCoordinator`. */
const WILDCARD = "*";

/** Synthesized re-trigger topics auto-subscribed to the completing step (FR-123). */
const SYNTHESIZED_TOPICS = new Set(["flow.tasks_remaining", "flow.requirements_unmet"]);

export class OrchestrationEventEngine {
	/** Concrete topic → ordered subscriber list (in subscribe / notor-steps order). */
	private readonly subscribers = new Map<string, StepDefinition[]>();
	/** The single wildcard subscriber (the FallbackCoordinator's step sentinel). */
	private wildcard: StepDefinition | null = null;
	/** Ordered in-session event history (newest last). */
	private readonly history: OrchestrationEvent[] = [];

	/** Emission context the runner sets before each `publish()` (for stamping). */
	private currentTurn = 0;
	private currentSourceStep: string | null = null;

	/** Completion no-progress tracking (Issue-9). */
	private noProgressStep: string | null = null;
	private noProgressCount = 0;
	private lastBlockingSetSize = 0;

	// -- Subscription --------------------------------------------------------

	/**
	 * Register `step` to receive events on `topic`, or `"*"` for the catch-all
	 * wildcard (reserved for the `FallbackCoordinator`). A second `"*"` subscribe
	 * is rejected — the wildcard cannot be overridden. Returns an unsubscribe
	 * handle.
	 */
	subscribe(topic: string, step: StepDefinition): Unsubscribe {
		if (topic === WILDCARD) {
			if (this.wildcard !== null) {
				throw new Error(
					"OrchestrationEventEngine: the '*' wildcard subscriber cannot be overridden.",
				);
			}
			this.wildcard = step;
			return () => {
				this.wildcard = null;
			};
		}

		const list = this.subscribers.get(topic) ?? [];
		list.push(step);
		this.subscribers.set(topic, list);
		return () => {
			const current = this.subscribers.get(topic);
			if (!current) return;
			const idx = current.indexOf(step);
			if (idx >= 0) current.splice(idx, 1);
			if (current.length === 0) this.subscribers.delete(topic);
		};
	}

	/** True if a `*` subscriber is registered. */
	hasWildcard(): boolean {
		return this.wildcard !== null;
	}

	/** The registered wildcard step sentinel (or `null`). */
	getWildcard(): StepDefinition | null {
		return this.wildcard;
	}

	// -- Emission context ----------------------------------------------------

	/**
	 * Set the `(turn, sourceStep)` the next `publish()` stamps onto the event.
	 * The runner calls this before publishing — the starting event uses
	 * `sourceStep = null`.
	 */
	setEmissionContext(turn: number, sourceStep: string | null): void {
		this.currentTurn = turn;
		this.currentSourceStep = sourceStep;
	}

	// -- Publish (write-before-route) ---------------------------------------

	/**
	 * Publish an event. **Write-before-route:** the constructed
	 * `OrchestrationEvent` is appended to `session-log.jsonl` (via the serialized
	 * SessionLog write chain) **before** it is pushed to history and exposed to
	 * subscribers. The runner resolves subscribers and executes them *after* this
	 * returns — there is no mid-turn routing here.
	 */
	publish(topic: string, payload: string, sessionLog: SessionLog): OrchestrationEvent {
		const event: OrchestrationEvent = {
			topic,
			payload,
			source_step: this.currentSourceStep,
			turn: this.currentTurn,
			ts: new Date().toISOString(),
		};

		// WRITE-BEFORE-ROUTE: enqueue the durable append on the SessionLog's
		// serialized chain first (ordered ahead of the next turn.start), then
		// record history. The runner routes only after publish() returns.
		void sessionLog.appendEventEmitted({
			turn: event.turn,
			topic: event.topic,
			payload: event.payload,
			source_step: event.source_step,
		});

		this.history.push(event);
		return event;
	}

	// -- Subscriber resolution ----------------------------------------------

	/**
	 * Steps whose `notor-step-triggers` include `topic`, in `notor-steps`
	 * declaration order. Empty ⇒ orphaned topic ⇒ the runner consults the
	 * fallback. Does NOT return the wildcard.
	 *
	 * For a synthesized re-trigger topic (`flow.tasks_remaining` /
	 * `flow.requirements_unmet`) with no explicit subscriber, pass
	 * `completingStep` to receive the auto-subscription target (FR-123); an
	 * explicit subscriber always wins.
	 */
	getSubscribers(topic: string, completingStep?: StepDefinition | null): StepDefinition[] {
		const explicit = this.subscribers.get(topic);
		if (explicit && explicit.length > 0) {
			return [...explicit];
		}
		if (completingStep && SYNTHESIZED_TOPICS.has(topic)) {
			return [completingStep];
		}
		return [];
	}

	/** The full ordered event history for the current session (newest last). */
	getEventHistory(): OrchestrationEvent[] {
		return [...this.history];
	}

	// -- Completion no-progress guard (Issue-9) ------------------------------

	/**
	 * Record a blocked `FLOW_COMPLETE` from `step` whose remaining blocking set
	 * (open/running task keys, or missing required-events) is `blockingSet`.
	 * Tracks **consecutive** blocks from the same step whose set did **not**
	 * shrink; a shrinking set (real progress) resets the counter.
	 *
	 * @returns `{ terminate: true }` once `COMPLETION_NOPROGRESS_THRESHOLD`
	 *   consecutive non-shrinking blocks accrue — the runner then terminates with
	 *   `FLOW_ERROR`.
	 */
	recordBlockedCompletion(
		step: string,
		blockingSet: string[],
	): { terminate: boolean; count: number } {
		const size = blockingSet.length;
		if (this.noProgressStep === step && size >= this.lastBlockingSetSize) {
			// Same step, set did not shrink → no progress.
			this.noProgressCount += 1;
		} else {
			// Different step, or the set shrank → real progress; reset.
			this.noProgressStep = step;
			this.noProgressCount = 1;
		}
		this.lastBlockingSetSize = size;

		const terminate = this.noProgressCount >= COMPLETION_NOPROGRESS_THRESHOLD;
		if (terminate) {
			log.warn("Completion no-progress guard fired", {
				step,
				count: this.noProgressCount,
				blockingSet,
			});
		}
		return { terminate, count: this.noProgressCount };
	}

	/** Reset the no-progress tracking (e.g. when a completion finally succeeds). */
	resetNoProgress(): void {
		this.noProgressStep = null;
		this.noProgressCount = 0;
		this.lastBlockingSetSize = 0;
	}

	/**
	 * Rehydrate the event history from a replayed log (FR-125 / INT-005). The
	 * safety detectors' rolling window is derived from this history, so replaying
	 * it before a resumed run continues keeps a near-stale loop from being reset
	 * by a reload. Appends in order; does not write to the session log.
	 */
	rehydrateHistory(events: OrchestrationEvent[]): void {
		this.history.push(...events);
	}
}
