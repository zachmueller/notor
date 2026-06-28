/**
 * POL-004 — the unified activity tracker's typed `flow-run` source.
 *
 * Asserts the tracker carries flow runs as a SECOND source of truth alongside
 * background workflows (one indicator, typed entries — not a parallel indicator):
 * the flow-run source is session-file-backed (injected), active-first ordered,
 * bounded by maxEntries, and empty when unwired.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — POL-004
 */

import { describe, it, expect, vi } from "vitest";
import { WorkflowActivityTracker, type FlowRunEntry } from "./workflow-activity-tracker";
import type { WorkflowConcurrencyManager } from "./workflow-concurrency";

function fakeConcurrencyManager(): WorkflowConcurrencyManager {
	return {
		getActiveExecutions: vi.fn(() => []),
		getRecentExecutions: vi.fn(() => []),
	} as unknown as WorkflowConcurrencyManager;
}

function tracker(maxEntries = 5): WorkflowActivityTracker {
	return new WorkflowActivityTracker(fakeConcurrencyManager(), maxEntries);
}

const run = (over: Partial<FlowRunEntry>): FlowRunEntry => ({
	type: "flow-run",
	sessionId: "s",
	flowName: "F",
	status: "active",
	startedAt: "2026-06-29T00:00:00Z",
	...over,
});

describe("WorkflowActivityTracker — flow-run source (POL-004)", () => {
	it("returns no flow-run entries when no source is wired", () => {
		expect(tracker().getFlowRunEntries()).toEqual([]);
	});

	it("returns the wired flow-run source's entries", () => {
		const t = tracker();
		const entries = [run({ sessionId: "a", flowName: "Alpha" })];
		t.setFlowRunSource(() => entries);
		expect(t.getFlowRunEntries().map((e) => e.flowName)).toEqual(["Alpha"]);
	});

	it("orders active/interrupted before terminal, newest-first within a group", () => {
		const t = tracker();
		t.setFlowRunSource(() => [
			run({ sessionId: "done", status: "completed", startedAt: "2026-06-29T03:00:00Z" }),
			run({ sessionId: "old-active", status: "active", startedAt: "2026-06-29T01:00:00Z" }),
			run({ sessionId: "new-active", status: "active", startedAt: "2026-06-29T02:00:00Z" }),
		]);
		expect(t.getFlowRunEntries().map((e) => e.sessionId)).toEqual([
			"new-active",
			"old-active",
			"done",
		]);
	});

	it("bounds flow-run entries by maxEntries", () => {
		const t = tracker(2);
		t.setFlowRunSource(() => [
			run({ sessionId: "a" }),
			run({ sessionId: "b" }),
			run({ sessionId: "c" }),
		]);
		expect(t.getFlowRunEntries()).toHaveLength(2);
	});
});
