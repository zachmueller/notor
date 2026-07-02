/**
 * `FallbackCoordinator` (FEAT-004) — the mandatory `*` wildcard subscriber.
 *
 * A **pure, synchronous backstop** — no LLM call, no fuzzy/string-distance
 * "steering." On an orphaned event it (1) logs a warning with the unmatched
 * topic + payload, and (2) terminates the flow by returning a terminal
 * `FLOW_ERROR` event carrying the orphan as context. There is deliberately no
 * payload-based intent inference (a synchronous handler could only do arbitrary
 * edit-distance matching, which risks silently mis-routing).
 *
 * Orphan-prone topologies are caught earlier by the FEAT-002 load-time
 * validator; this coordinator is the loud, deterministic last line of defense.
 * It also exposes a **default failure handler** for the recognized failure
 * channels (`{step}.capped` / `{step}.no_emit` / `{step}.code_error` /
 * `{step}.stream_error`, Issue-10 + F3), producing a *diagnosable* `FLOW_ERROR`
 * naming the originating step rather than an anonymous orphan.
 *
 * The coordinator is registered by the runner against the engine's `*` slot and
 * cannot be overridden (a concrete subscriber for a topic always wins).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-004
 * @see specs/ZZ-misc/orchestration/contracts/event-engine.md — FallbackCoordinator
 */

import { logger } from "../utils/logger";
import { FLOW_ERROR, type OrchestrationEvent, type OrchestrationFlow } from "./types";

const log = logger("FallbackCoordinator");

/** Runtime-only failure-channel suffixes (Issue-10; `.stream_error` per F3). */
const FAILURE_CHANNEL_SUFFIXES = [".capped", ".no_emit", ".code_error", ".stream_error"];

function isFailureChannelTopic(topic: string): boolean {
	return FAILURE_CHANNEL_SUFFIXES.some((suffix) => topic.endsWith(suffix));
}

export class FallbackCoordinator {
	/**
	 * Invoked by the runner when an event has no concrete (and no auto-subscribed)
	 * step subscriber. Logs the orphan and returns a terminal `FLOW_ERROR`
	 * carrying the orphan as context. Deterministic and synchronous — no LLM, no
	 * payload-based intent inference.
	 *
	 * A **failure-channel** topic (`{step}.capped` / `.no_emit` / `.code_error` /
	 * `.stream_error`) is recognized and produces a *diagnosable* `FLOW_ERROR`
	 * that names the originating step, rather than an anonymous orphan.
	 */
	handle(event: OrchestrationEvent, flow: OrchestrationFlow): OrchestrationEvent {
		const stamp = (payload: string): OrchestrationEvent => ({
			topic: FLOW_ERROR,
			payload,
			source_step: event.source_step,
			turn: event.turn,
			ts: new Date().toISOString(),
		});

		if (isFailureChannelTopic(event.topic)) {
			// Recognized failure channel with no explicit subscriber: diagnosable
			// FLOW_ERROR naming the failing step + channel.
			log.warn("Unhandled failure channel; terminating flow", {
				flow: flow.name,
				topic: event.topic,
				source_step: event.source_step,
				payload: truncate(event.payload),
			});
			return stamp(
				`Step failure channel '${event.topic}' (from step '${event.source_step ?? "unknown"}') ` +
					`had no handler. Failure context: ${event.payload}`,
			);
		}

		// Genuine orphan: a topic with no subscriber that the static validator
		// could not pre-block (e.g. a runtime-only topic name).
		log.warn("Orphaned event; terminating flow with FLOW_ERROR", {
			flow: flow.name,
			topic: event.topic,
			source_step: event.source_step,
			payload: truncate(event.payload),
		});
		return stamp(
			`Orphaned event '${event.topic}' (from step '${event.source_step ?? "starting event"}') ` +
				`had no subscriber. Payload: ${event.payload}`,
		);
	}
}

function truncate(s: string, max = 200): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}
