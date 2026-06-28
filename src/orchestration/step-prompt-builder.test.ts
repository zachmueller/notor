/**
 * Phase-1 gate — `StepPromptBuilder` must-publish injection (FEAT-005).
 *
 * The must-publish rule is present in the output EVEN WHEN the step body carries
 * its own custom instructions (asserted across empty-body and custom-body steps).
 * Also asserts objective / incoming event / history / scratchpad-overwrite rule /
 * per-turn guardrails / body-embedded-only-in-EXECUTE.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-005 / Phase-1 Exit Gate
 */

import { describe, it, expect } from "vitest";
import { StepPromptBuilder } from "./step-prompt-builder";
import type { OrchestrationEvent, OrchestrationFlow, StepDefinition } from "./types";

function flow(over: Partial<OrchestrationFlow> = {}): OrchestrationFlow {
	return {
		name: "Demo",
		description: "",
		flowDir: "d",
		startingEvent: "start",
		completionEvent: "FLOW_COMPLETE",
		maxIterations: 100,
		maxRuntimeMinutes: 60,
		requiredEvents: [],
		fanoutTopics: [],
		steps: [],
		guardrails: [],
		invocable: false,
		flowInputs: null,
		flowReturns: null,
		onCompleteFlow: null,
		handoffIsolation: "isolated",
		maxDepth: null,
		maxCostUsd: 5,
		...over,
	};
}

function step(bodyContent: string, over: Partial<StepDefinition> = {}): StepDefinition {
	return {
		name: "Planner",
		description: "",
		triggers: ["start"],
		publishes: ["tasks.ready", "FLOW_COMPLETE"],
		defaultPublishes: "tasks.ready",
		persona: null,
		model: null,
		mode: "conversation",
		mcpServers: null,
		timeoutSeconds: null,
		bodyContent,
		notePath: "steps/planner.md",
		...over,
	};
}

function event(): OrchestrationEvent {
	return { topic: "start", payload: "objective payload", source_step: null, turn: 1, ts: "2026-06-28T00:00:00Z" };
}

const builder = new StepPromptBuilder();

function build(bodyContent: string, flowOver: Partial<OrchestrationFlow> = {}) {
	return builder.build({
		step: step(bodyContent),
		flow: flow(flowOver),
		event: event(),
		eventHistory: [],
		objective: "Implement the --verbose flag",
		scratchpadPath: "sessions/s1/scratchpad",
		tasksPath: "sessions/s1/tasks",
		iteration: 3,
	});
}

describe("StepPromptBuilder — must-publish gate", () => {
	it("injects the must-publish rule for an EMPTY-body step", () => {
		const out = build("");
		expect(out).toMatch(/MUST call .*emit_event/i);
		expect(out).toContain("tasks.ready");
	});

	it("injects the must-publish rule even when the body has CUSTOM instructions", () => {
		const out = build("Do something entirely custom. Never mention tools.");
		expect(out).toMatch(/MUST call .*emit_event/i);
		expect(out).toContain("Do something entirely custom.");
	});

	it("states that narrative text does NOT count as an emission", () => {
		const out = build("custom");
		expect(out).toMatch(/narrative.*does NOT count|does NOT count.*emission/i);
	});
});

describe("StepPromptBuilder — always-injected sections", () => {
	it("injects the objective, incoming event (topic + payload), and scratchpad/tasks paths", () => {
		const out = build("body");
		expect(out).toContain("Implement the --verbose flag");
		expect(out).toContain("topic: start");
		expect(out).toContain("payload: objective payload");
		expect(out).toContain("sessions/s1/scratchpad");
		expect(out).toContain("sessions/s1/tasks");
	});

	it("states the overwrite-only scratchpad rule (recovery safety)", () => {
		const out = build("body");
		expect(out).toMatch(/OVERWRITE-ONLY|never incrementally append/i);
	});

	it("injects flow guardrails into the GUARDRAILS section on every turn", () => {
		const out = build("body", { guardrails: ["Verification is mandatory.", "YAGNI ruthlessly."] });
		expect(out).toContain("### GUARDRAILS");
		expect(out).toContain("Verification is mandatory.");
		expect(out).toContain("YAGNI ruthlessly.");
	});

	it("embeds the raw step body only inside ### 1. EXECUTE", () => {
		const out = build("UNIQUE_BODY_MARKER");
		const executeIdx = out.indexOf("### 1. EXECUTE");
		const bodyIdx = out.indexOf("UNIQUE_BODY_MARKER");
		expect(executeIdx).toBeGreaterThanOrEqual(0);
		expect(bodyIdx).toBeGreaterThan(executeIdx);
		// The body marker appears exactly once (not duplicated standalone).
		expect(out.split("UNIQUE_BODY_MARKER")).toHaveLength(2);
	});

	it("injects recent event history", () => {
		const history: OrchestrationEvent[] = [
			{ topic: "start", payload: "p", source_step: null, turn: 1, ts: "t" },
			{ topic: "tasks.ready", payload: "q", source_step: "Planner", turn: 2, ts: "t" },
		];
		const out = builder.build({
			step: step("body"),
			flow: flow(),
			event: event(),
			eventHistory: history,
			objective: "obj",
			scratchpadPath: "sp",
			tasksPath: "tp",
			iteration: 3,
		});
		expect(out).toContain("EVENT HISTORY");
		expect(out).toContain("tasks.ready");
	});

	it("uses the resolvedBody (post-include) when provided instead of the raw body", () => {
		const out = builder.build({
			step: step("<include_note>x</include_note>"),
			flow: flow(),
			event: event(),
			eventHistory: [],
			objective: "obj",
			scratchpadPath: "sp",
			tasksPath: "tp",
			iteration: 1,
			resolvedBody: "RESOLVED CONTENT",
		});
		expect(out).toContain("RESOLVED CONTENT");
		expect(out).not.toContain("<include_note>x</include_note>");
	});
});
