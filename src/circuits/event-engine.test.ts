/**
 * TEST-002 (part 1) — `OrchestrationEventEngine` unit tests (FEAT-003).
 *
 * No LLM, no real vault — a fake `SessionLog` records the order of appends vs.
 * subscriber resolution to prove write-before-route.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — TEST-002
 */

import { describe, it, expect, vi } from "vitest";
import { COMPLETION_NOPROGRESS_THRESHOLD } from "./constants";
import { OrchestrationEventEngine } from "./event-engine";
import type { SessionLog } from "./session-log";
import type { StepDefinition } from "./types";

function step(name: string, triggers: string[], publishes: string[] = []): StepDefinition {
	return {
		name,
		description: "",
		triggers,
		publishes,
		defaultPublishes: null,
		persona: null,
		model: null,
		mode: "conversation",
		mcpServers: null,
		timeoutSeconds: null,
		bodyContent: "",
		notePath: `steps/${name}.md`,
	};
}

/** A fake SessionLog recording the order of `event.emitted` appends. */
function fakeLog(order: string[]): SessionLog {
	return {
		appendEventEmitted: vi.fn((entry: { topic: string }) => {
			order.push(`append:${entry.topic}`);
			return Promise.resolve();
		}),
	} as unknown as SessionLog;
}

describe("OrchestrationEventEngine", () => {
	it("publish() appends event.emitted BEFORE the caller resolves subscribers (write-before-route)", () => {
		const order: string[] = [];
		const engine = new OrchestrationEventEngine();
		const a = step("A", ["t"]);
		engine.subscribe("t", a);

		engine.setEmissionContext(1, null);
		engine.publish("t", "payload", fakeLog(order));
		// The runner resolves subscribers AFTER publish returns.
		const subs = engine.getSubscribers("t");
		order.push(`route:${subs.map((s) => s.name).join(",")}`);

		expect(order).toEqual(["append:t", "route:A"]);
	});

	it("getSubscribers returns the single subscriber for a normal topic", () => {
		const engine = new OrchestrationEventEngine();
		const a = step("A", ["t"]);
		engine.subscribe("t", a);
		expect(engine.getSubscribers("t").map((s) => s.name)).toEqual(["A"]);
	});

	it("returns fan-out subscribers in subscribe (notor-steps) order", () => {
		const engine = new OrchestrationEventEngine();
		const a = step("A", ["fan"]);
		const b = step("B", ["fan"]);
		const c = step("C", ["fan"]);
		engine.subscribe("fan", a);
		engine.subscribe("fan", b);
		engine.subscribe("fan", c);
		expect(engine.getSubscribers("fan").map((s) => s.name)).toEqual(["A", "B", "C"]);
	});

	it("auto-subscribes a synthesized re-trigger topic to the completing step when none is declared", () => {
		const engine = new OrchestrationEventEngine();
		const completing = step("Closer", ["work"], ["FLOW_COMPLETE"]);
		// No explicit subscriber for flow.tasks_remaining.
		const subs = engine.getSubscribers("flow.tasks_remaining", completing);
		expect(subs.map((s) => s.name)).toEqual(["Closer"]);
	});

	it("lets an explicit subscriber override the synthesized-topic auto-subscription", () => {
		const engine = new OrchestrationEventEngine();
		const handler = step("Handler", ["flow.requirements_unmet"]);
		const completing = step("Closer", ["work"]);
		engine.subscribe("flow.requirements_unmet", handler);
		const subs = engine.getSubscribers("flow.requirements_unmet", completing);
		expect(subs.map((s) => s.name)).toEqual(["Handler"]);
	});

	it("does NOT auto-subscribe an ordinary topic to the completing step", () => {
		const engine = new OrchestrationEventEngine();
		const completing = step("Closer", ["work"]);
		expect(engine.getSubscribers("not.synthesized", completing)).toEqual([]);
	});

	it("rejects a second '*' wildcard subscription (cannot be overridden)", () => {
		const engine = new OrchestrationEventEngine();
		engine.subscribe("*", step("Fallback1", ["*"]));
		expect(() => engine.subscribe("*", step("Fallback2", ["*"]))).toThrow(/wildcard/i);
	});

	it("getEventHistory returns events in publish order with the full shape", () => {
		const engine = new OrchestrationEventEngine();
		const order: string[] = [];
		const log = fakeLog(order);
		engine.setEmissionContext(1, null);
		engine.publish("a", "p1", log);
		engine.setEmissionContext(2, "StepA");
		engine.publish("b", "p2", log);

		const history = engine.getEventHistory();
		expect(history).toHaveLength(2);
		expect(history[0]).toMatchObject({ topic: "a", payload: "p1", source_step: null, turn: 1 });
		expect(history[1]).toMatchObject({ topic: "b", payload: "p2", source_step: "StepA", turn: 2 });
		expect(typeof history[0]!.ts).toBe("string");
	});

	describe("completion no-progress guard (Issue-9)", () => {
		it("terminates after N consecutive blocked completions from the same step with a non-shrinking set", () => {
			const engine = new OrchestrationEventEngine();
			let verdict = { terminate: false, count: 0 };
			for (let i = 0; i < COMPLETION_NOPROGRESS_THRESHOLD; i++) {
				verdict = engine.recordBlockedCompletion("Closer", ["taskA"]);
			}
			expect(verdict.terminate).toBe(true);
			expect(verdict.count).toBe(COMPLETION_NOPROGRESS_THRESHOLD);
		});

		it("resets the counter when the blocking set shrinks (real progress)", () => {
			const engine = new OrchestrationEventEngine();
			engine.recordBlockedCompletion("Closer", ["taskA", "taskB"]);
			engine.recordBlockedCompletion("Closer", ["taskA", "taskB"]);
			// Set shrank → reset.
			const after = engine.recordBlockedCompletion("Closer", ["taskA"]);
			expect(after.terminate).toBe(false);
			expect(after.count).toBe(1);
		});

		it("resets the counter when a different step blocks", () => {
			const engine = new OrchestrationEventEngine();
			engine.recordBlockedCompletion("Closer", ["taskA"]);
			engine.recordBlockedCompletion("Closer", ["taskA"]);
			const other = engine.recordBlockedCompletion("Other", ["taskA"]);
			expect(other.terminate).toBe(false);
			expect(other.count).toBe(1);
		});
	});
});
