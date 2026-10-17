/**
 * `OrchestrationRunRegistry` unit tests (F1 Fix 1).
 *
 * The registry is the in-memory owner of live orchestration runs: register /
 * unregister / get / isFlowRunning / abort / abortAll / touch semantics that the
 * Stop UI, the single-instance guard, and onunload teardown depend on.
 *
 * @see specs/ZZ-misc/arch-review-july-2026/F1-orchestration-run-lifecycle.md — Fix 1
 */

import { describe, it, expect } from "vitest";
import { OrchestrationRunRegistry, type OrchestrationRunHandle } from "./run-registry";

function handle(over: Partial<OrchestrationRunHandle> = {}): OrchestrationRunHandle {
	return {
		sessionId: "sess-1",
		flowName: "Flow A",
		controller: new AbortController(),
		lastProgressAt: 1000,
		...over,
	};
}

describe("OrchestrationRunRegistry", () => {
	it("registers and gets a handle by session id", () => {
		const reg = new OrchestrationRunRegistry();
		const h = handle();
		reg.register(h);
		expect(reg.get("sess-1")).toBe(h);
		expect(reg.get("nope")).toBeUndefined();
	});

	it("unregisters a handle", () => {
		const reg = new OrchestrationRunRegistry();
		reg.register(handle());
		reg.unregister("sess-1");
		expect(reg.get("sess-1")).toBeUndefined();
	});

	it("isFlowRunning reflects live runs of a named flow", () => {
		const reg = new OrchestrationRunRegistry();
		expect(reg.isFlowRunning("Flow A")).toBe(false);
		reg.register(handle({ sessionId: "s1", flowName: "Flow A" }));
		expect(reg.isFlowRunning("Flow A")).toBe(true);
		expect(reg.isFlowRunning("Flow B")).toBe(false);
		reg.unregister("s1");
		expect(reg.isFlowRunning("Flow A")).toBe(false);
	});

	it("abort aborts the matching controller and reports whether one was found", () => {
		const reg = new OrchestrationRunRegistry();
		const controller = new AbortController();
		reg.register(handle({ sessionId: "s1", controller }));
		expect(controller.signal.aborted).toBe(false);
		expect(reg.abort("s1")).toBe(true);
		expect(controller.signal.aborted).toBe(true);
		// Unknown / already-finished session → false, no throw.
		expect(reg.abort("ghost")).toBe(false);
	});

	it("abortAll aborts every live controller and returns them (without unregistering)", () => {
		const reg = new OrchestrationRunRegistry();
		const c1 = new AbortController();
		const c2 = new AbortController();
		reg.register(handle({ sessionId: "s1", controller: c1 }));
		reg.register(handle({ sessionId: "s2", controller: c2 }));
		const aborted = reg.abortAll();
		expect(aborted).toHaveLength(2);
		expect(c1.signal.aborted).toBe(true);
		expect(c2.signal.aborted).toBe(true);
		// abortAll does not unregister — each run's own finally does that.
		expect(reg.get("s1")).toBeDefined();
		expect(reg.get("s2")).toBeDefined();
	});

	it("listActive returns a snapshot of every live handle", () => {
		const reg = new OrchestrationRunRegistry();
		reg.register(handle({ sessionId: "s1" }));
		reg.register(handle({ sessionId: "s2" }));
		expect(reg.listActive().map((h) => h.sessionId).sort()).toEqual(["s1", "s2"]);
	});

	it("touch refreshes lastProgressAt for a live run and no-ops for an unknown one", () => {
		const reg = new OrchestrationRunRegistry();
		const h = handle({ sessionId: "s1", lastProgressAt: 0 });
		reg.register(h);
		const before = Date.now();
		reg.touch("s1");
		expect(h.lastProgressAt).toBeGreaterThanOrEqual(before);
		// No throw for an unknown session.
		expect(() => reg.touch("ghost")).not.toThrow();
	});
});
