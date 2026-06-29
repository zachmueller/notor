/**
 * TEST-002 (part 3) — `LoopSafetyGuards` unit tests (FEAT-008).
 *
 * Pure predicates over event history + counters: stale-loop (payload-independent),
 * runtime cap, iteration cap, thrashing. The detectors take the window/counters
 * as inputs, so they work identically whether state was accumulated live or
 * rehydrated on reload.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — TEST-002
 */

import { describe, it, expect } from "vitest";
import {
	STALE_REPEAT_THRESHOLD,
	THRASHING_ABANDON_THRESHOLD,
} from "./constants";
import { LoopSafetyGuards, isStale } from "./safety";
import type { OrchestrationEvent, OrchestrationFlow } from "./types";

function ev(topic: string, source: string | null, payload = "x"): OrchestrationEvent {
	return { topic, payload, source_step: source, turn: 0, ts: "2026-06-28T00:00:00Z" };
}

function flow(over: Partial<OrchestrationFlow> = {}): OrchestrationFlow {
	return {
		name: "Demo",
		description: "",
		flowDir: "d",
		startingEvent: "start",
		completionEvent: "FLOW_COMPLETE",
		maxIterations: 10,
		maxRuntimeMinutes: 60,
		requiredEvents: [],
		fanoutTopics: [],
		steps: [],
		guardrails: [],
		schedule: null,
		invocable: false,
		flowInputs: null,
		flowReturns: null,
		onCompleteFlow: null,
		handoffIsolation: "isolated",
		maxDepth: null,
		maxCostUsd: 5,
		openNotesInEditor: null,
		...over,
	};
}

describe("isStale", () => {
	it("is true when the last 4 events share the same (topic, source_step) pair", () => {
		const history = [
			ev("other", "Z"),
			ev("loop", "A", "p1"),
			ev("loop", "A", "p2"), // payload varies — must NOT matter
			ev("loop", "A", "p3"),
			ev("loop", "A", "p4"),
		];
		expect(isStale(history)).toBe(true);
	});

	it("is payload-independent (varying payloads on the same pair still stale)", () => {
		const history = Array.from({ length: STALE_REPEAT_THRESHOLD }, (_, i) => ev("t", "S", `payload-${i}`));
		expect(isStale(history)).toBe(true);
	});

	it("is false with fewer than the threshold of events", () => {
		const history = [ev("t", "S"), ev("t", "S"), ev("t", "S")];
		expect(history.length).toBeLessThan(STALE_REPEAT_THRESHOLD);
		expect(isStale(history)).toBe(false);
	});

	it("is false when the recent window varies the (topic, source_step) pair", () => {
		const history = [ev("t", "A"), ev("t", "B"), ev("t", "A"), ev("t", "A")];
		expect(isStale(history)).toBe(false);
	});

	it("distinguishes same topic from different source steps", () => {
		const history = [ev("t", "A"), ev("t", "A"), ev("t", "B"), ev("t", "B")];
		expect(isStale(history)).toBe(false);
	});
});

describe("LoopSafetyGuards", () => {
	const guards = new LoopSafetyGuards();

	it("checkIteration fires when LLM turns reach maxIterations", () => {
		const f = flow({ maxIterations: 5 });
		expect(guards.checkIteration(4, f)).toBe(false);
		expect(guards.checkIteration(5, f)).toBe(true);
	});

	it("checkRuntime fires when wall-clock exceeds maxRuntimeMinutes", () => {
		const f = flow({ maxRuntimeMinutes: 10 });
		const started = 1_000_000;
		expect(guards.checkRuntime(started, f, started + 9 * 60_000)).toBe(false);
		expect(guards.checkRuntime(started, f, started + 11 * 60_000)).toBe(true);
	});

	it("isThrashing fires at the abandonment threshold", () => {
		const counts = new Map<string, number>();
		counts.set("task-1", THRASHING_ABANDON_THRESHOLD - 1);
		expect(guards.isThrashing("task-1", counts)).toBe(false);
		counts.set("task-1", THRASHING_ABANDON_THRESHOLD);
		expect(guards.isThrashing("task-1", counts)).toBe(true);
		expect(guards.isThrashing("unknown", counts)).toBe(false);
	});

	it("evaluate returns the firing guard's terminal verdict (iteration cap)", () => {
		const result = guards.evaluate({
			flow: flow({ maxIterations: 2 }),
			llmTurns: 2,
			startedAtMs: Date.now(),
			history: [],
		});
		expect(result?.guard).toBe("iteration_cap");
	});

	it("evaluate returns the stale-loop verdict over a self-looping history", () => {
		const history = Array.from({ length: STALE_REPEAT_THRESHOLD }, () => ev("loop", "A"));
		const result = guards.evaluate({
			flow: flow({ maxIterations: 100 }),
			llmTurns: 1,
			startedAtMs: Date.now(),
			history,
		});
		expect(result?.guard).toBe("stale_loop");
	});

	it("evaluate returns null for a healthy flow", () => {
		const result = guards.evaluate({
			flow: flow({ maxIterations: 100 }),
			llmTurns: 1,
			startedAtMs: Date.now(),
			history: [ev("a", "A"), ev("b", "B")],
		});
		expect(result).toBeNull();
	});
});
