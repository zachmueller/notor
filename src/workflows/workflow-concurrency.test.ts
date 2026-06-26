import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WorkflowConcurrencyManager } from "./workflow-concurrency";
import type { WorkflowExecution, WorkflowExecutionStatus } from "../types";

function makeExecution(
	id: string,
	overrides: Partial<WorkflowExecution> = {}
): WorkflowExecution {
	return {
		id,
		workflow_path: `workflows/${id}.md`,
		workflow_name: id,
		conversation_id: `conv-${id}`,
		trigger_event: "on_schedule",
		trigger_source: null,
		status: "queued",
		started_at: new Date().toISOString(),
		completed_at: null,
		error_message: null,
		...overrides,
	};
}

/** A run function that never resolves — keeps the execution "running". */
const neverResolves = () => new Promise<void>(() => {});

describe("WorkflowConcurrencyManager.reconcileAfterWake", () => {
	let mgr: WorkflowConcurrencyManager;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		// High limit so submitted executions start immediately (status → running).
		mgr = new WorkflowConcurrencyManager(10);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("clears a stranded streaming execution and aborts its socket", () => {
		const exec = makeExecution("stranded");
		mgr.submit(exec, neverResolves);
		const abort = new AbortController();
		const abortSpy = vi.spyOn(abort, "abort");
		mgr.markStreaming(exec.id, abort); // lastStreamEventAt = now (1_000_000)

		// 5 minutes pass with no stream activity (the sleep gap).
		const gap = 5 * 60_000;
		vi.setSystemTime(1_000_000 + gap);

		const result = mgr.reconcileAfterWake(gap);

		expect(result).toEqual({ cleared: 1, waitingApproval: 0 });
		expect(abortSpy).toHaveBeenCalledTimes(1);
		// Cleared via onComplete → removed from active, guard freed.
		expect(mgr.isWorkflowRunning(exec.workflow_path)).toBe(false);
		expect(mgr.getActiveExecutions()).toHaveLength(0);
		const recent = mgr.getRecentExecutions(5);
		expect(recent[0]!.status).toBe("errored");
		expect(recent[0]!.error_message).toMatch(/stranded/i);
	});

	it("never clears an execution mid tool call", () => {
		const exec = makeExecution("long-tool");
		mgr.submit(exec, neverResolves);
		const abort = new AbortController();
		const abortSpy = vi.spyOn(abort, "abort");
		mgr.markStreaming(exec.id, abort);
		mgr.markInToolCall(exec.id); // legitimate long-running tool call

		const gap = 60 * 60_000; // an hour
		vi.setSystemTime(1_000_000 + gap);

		const result = mgr.reconcileAfterWake(gap);

		expect(result).toEqual({ cleared: 0, waitingApproval: 0 });
		expect(abortSpy).not.toHaveBeenCalled();
		expect(mgr.isWorkflowRunning(exec.workflow_path)).toBe(true);
	});

	it("exempts and counts waiting_approval executions", () => {
		const exec = makeExecution("pending-approval");
		mgr.submit(exec, neverResolves);
		const abort = new AbortController();
		mgr.markStreaming(exec.id, abort);
		mgr.updateStatus(exec.id, "waiting_approval");

		const gap = 10 * 60_000;
		vi.setSystemTime(1_000_000 + gap);

		const result = mgr.reconcileAfterWake(gap);

		expect(result).toEqual({ cleared: 0, waitingApproval: 1 });
		expect(mgr.getActiveExecutions()).toHaveLength(1);
	});

	it("leaves an execution that streamed after wake", () => {
		const exec = makeExecution("fresh");
		mgr.submit(exec, neverResolves);
		const abort = new AbortController();
		mgr.markStreaming(exec.id, abort);

		const gap = 5 * 60_000;
		// Clock advances past the gap, but the stream produced an event *after*
		// wake (just now), proving it is alive.
		vi.setSystemTime(1_000_000 + gap);
		mgr.touchStreamActivity(exec.id);

		const result = mgr.reconcileAfterWake(gap);

		expect(result).toEqual({ cleared: 0, waitingApproval: 0 });
		expect(mgr.isWorkflowRunning(exec.workflow_path)).toBe(true);
	});

	it("does not touch queued executions", () => {
		const limited = new WorkflowConcurrencyManager(1);
		const running = makeExecution("running");
		const queued = makeExecution("queued");
		limited.submit(running, neverResolves); // starts → running
		limited.submit(queued, neverResolves); // over limit → queued

		const gap = 5 * 60_000;
		vi.setSystemTime(1_000_000 + gap);
		// running has no liveness record → treated as alive (no clear).
		const result = limited.reconcileAfterWake(gap);

		expect(result).toEqual({ cleared: 0, waitingApproval: 0 });
		const statuses: WorkflowExecutionStatus[] = limited
			.getActiveExecutions()
			.map((e) => e.status);
		expect(statuses).toContain("running");
		expect(statuses).toContain("queued");
	});

	it("treats a running execution with no liveness record as alive", () => {
		const exec = makeExecution("no-liveness");
		mgr.submit(exec, neverResolves);
		// No markStreaming call.

		const gap = 5 * 60_000;
		vi.setSystemTime(1_000_000 + gap);
		const result = mgr.reconcileAfterWake(gap);

		expect(result).toEqual({ cleared: 0, waitingApproval: 0 });
		expect(mgr.isWorkflowRunning(exec.workflow_path)).toBe(true);
	});
});
