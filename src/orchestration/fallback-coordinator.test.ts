/**
 * TEST-002 (part 2) — `FallbackCoordinator` unit tests (FEAT-004).
 *
 * The coordinator is a pure synchronous backstop: orphan → logged → terminal
 * `FLOW_ERROR` (no steering, no LLM, no silent drop). Recognized failure
 * channels get a diagnosable `FLOW_ERROR` naming the step.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — TEST-002
 */

import { describe, it, expect } from "vitest";
import { FallbackCoordinator } from "./fallback-coordinator";
import { FLOW_ERROR, type OrchestrationEvent, type OrchestrationFlow } from "./types";

function fakeFlow(): OrchestrationFlow {
	return {
		name: "Demo",
		description: "",
		flowDir: "notor/orchestrations/demo",
		startingEvent: "start",
		completionEvent: "FLOW_COMPLETE",
		maxIterations: 100,
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
	};
}

function event(topic: string, sourceStep: string | null = "StepA"): OrchestrationEvent {
	return { topic, payload: "ctx", source_step: sourceStep, turn: 3, ts: "2026-06-28T00:00:00Z" };
}

describe("FallbackCoordinator", () => {
	it("converts an orphaned event into a terminal FLOW_ERROR carrying the orphan as context", () => {
		const coordinator = new FallbackCoordinator();
		const result = coordinator.handle(event("typo.topic"), fakeFlow());
		expect(result.topic).toBe(FLOW_ERROR);
		expect(result.payload).toContain("typo.topic");
		expect(result.payload).toContain("ctx");
	});

	it("names the originating step for a {step}.capped failure channel (Issue-10, diagnosable not anonymous)", () => {
		const coordinator = new FallbackCoordinator();
		const result = coordinator.handle(event("Builder.capped", "Builder"), fakeFlow());
		expect(result.topic).toBe(FLOW_ERROR);
		expect(result.payload).toContain("Builder.capped");
		expect(result.payload).toContain("Builder");
	});

	it("recognizes .no_emit and .code_error as failure channels", () => {
		const coordinator = new FallbackCoordinator();
		expect(coordinator.handle(event("X.no_emit", "X"), fakeFlow()).payload).toContain("X.no_emit");
		expect(coordinator.handle(event("Y.code_error", "Y"), fakeFlow()).payload).toContain("Y.code_error");
	});

	it("is pure + synchronous — returns a FLOW_ERROR event directly (no promise, no LLM)", () => {
		const coordinator = new FallbackCoordinator();
		const result = coordinator.handle(event("orphan"), fakeFlow());
		// Synchronous: a plain object, not a Promise.
		expect(result).not.toBeInstanceOf(Promise);
		expect(result.topic).toBe(FLOW_ERROR);
	});

	it("never silently drops an orphan — every orphan yields a FLOW_ERROR", () => {
		const coordinator = new FallbackCoordinator();
		for (const topic of ["a", "b.c", "weird/topic"]) {
			expect(coordinator.handle(event(topic), fakeFlow()).topic).toBe(FLOW_ERROR);
		}
	});
});
