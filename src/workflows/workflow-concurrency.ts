/**
 * Workflow concurrency manager — bounded pool of background workflow executions.
 *
 * Limits the number of simultaneously running event-triggered (background)
 * workflow executions to `settings.workflow_concurrency_limit` (default 3).
 * Executions beyond that limit are queued in FIFO order and started as slots
 * become available.
 *
 * Tracks `WorkflowExecution` state for the activity indicator (Group H).
 *
 * Key guarantees:
 * - `submit()` starts the run function immediately if a slot is free;
 *   otherwise queues it (status → "queued").
 * - `onComplete()` advances the status, records completion time, and
 *   starts the next queued item.
 * - `isWorkflowRunning()` provides a single-instance guard: returns `true`
 *   if the same `workflowPath` is already active or queued.
 * - State is in-memory only — lost on plugin reload (acceptable per plan.md).
 * - Manually triggered (foreground) workflows are NOT managed here.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-020
 * @see specs/03-workflows-personas/data-model.md — WorkflowExecution entity
 */

import type { WorkflowExecution, WorkflowExecutionStatus } from "../types";
import { logger } from "../utils/logger";

const log = logger("WorkflowConcurrencyManager");

// ---------------------------------------------------------------------------
// Internal queue item
// ---------------------------------------------------------------------------

interface QueueItem {
	execution: WorkflowExecution;
	runFn: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// WorkflowConcurrencyManager
// ---------------------------------------------------------------------------

/**
 * Global concurrency limiter for background (event-triggered) workflow executions.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-020
 */
export class WorkflowConcurrencyManager {
	/**
	 * Map of execution ID → execution record for all active and queued executions.
	 * Completed executions move to `recentExecutions`.
	 */
	private readonly active = new Map<string, WorkflowExecution>();

	/** FIFO queue for overflow executions (beyond the concurrency limit). */
	private readonly queue: QueueItem[] = [];

	/**
	 * Bounded list of recently completed executions for the activity indicator.
	 * Newest first. Capped at `MAX_RECENT` entries.
	 */
	private recentExecutions: WorkflowExecution[] = [];

	/** Maximum completed executions to retain for the activity indicator. */
	private static readonly MAX_RECENT = 20;

	constructor(private limit: number = 3) {}

	// -----------------------------------------------------------------------
	// Submission
	// -----------------------------------------------------------------------

	/**
	 * Submit a workflow execution for background processing.
	 *
	 * If the active count is below the limit, the run function is started
	 * immediately (execution status → `"running"`). Otherwise the item is
	 * queued in FIFO order (status remains `"queued"`).
	 *
	 * @param execution - The execution record to track.
	 * @param runFn     - Async function that drives the background workflow pipeline.
	 */
	submit(execution: WorkflowExecution, runFn: () => Promise<void>): void {
		// Register the execution record
		this.active.set(execution.id, execution);

		if (this._activeRunningCount() < this.limit) {
			log.info("Starting background workflow immediately", {
				id: execution.id,
				workflow: execution.workflow_name,
				activeCount: this._activeRunningCount(),
				limit: this.limit,
			});
			this._start(execution, runFn);
		} else {
			log.info("Queuing background workflow (concurrency limit reached)", {
				id: execution.id,
				workflow: execution.workflow_name,
				queueLength: this.queue.length,
				limit: this.limit,
			});
			// Status already "queued" from caller
			execution.status = "queued";
			this.queue.push({ execution, runFn });
		}
	}

	// -----------------------------------------------------------------------
	// Completion
	// -----------------------------------------------------------------------

	/**
	 * Mark an execution as complete and advance the queue.
	 *
	 * Called by `executeBackgroundWorkflow()` (F-021) when the workflow
	 * finishes (success, error, or stop).
	 *
	 * @param executionId - The execution to complete.
	 * @param status      - Final status (`"completed"`, `"errored"`, `"stopped"`).
	 * @param error       - Error message (only for `"errored"` status).
	 */
	onComplete(
		executionId: string,
		status: WorkflowExecutionStatus,
		error?: string
	): void {
		const execution = this.active.get(executionId);
		if (!execution) {
			log.warn("onComplete called for unknown execution", { executionId });
			return;
		}

		execution.status = status;
		execution.completed_at = new Date().toISOString();
		if (error) {
			execution.error_message = error;
		}

		// Move to recent list (newest first, capped)
		this.recentExecutions.unshift({ ...execution });
		if (this.recentExecutions.length > WorkflowConcurrencyManager.MAX_RECENT) {
			this.recentExecutions = this.recentExecutions.slice(
				0,
				WorkflowConcurrencyManager.MAX_RECENT
			);
		}

		this.active.delete(executionId);

		log.info("Background workflow completed", {
			id: executionId,
			status,
			workflow: execution.workflow_name,
		});

		// Advance the queue: start the next queued item if one exists
		if (this.queue.length > 0) {
			const next = this.queue.shift()!;
			log.info("Advancing queue — starting next workflow", {
				id: next.execution.id,
				workflow: next.execution.workflow_name,
				remainingQueue: this.queue.length,
			});
			this._start(next.execution, next.runFn);
		}
	}

	// -----------------------------------------------------------------------
	// Status updates (intermediate state changes)
	// -----------------------------------------------------------------------

	/**
	 * Update the status of an in-flight execution.
	 *
	 * Used by the background execution pipeline to transition states, e.g.
	 * `"running"` → `"waiting_approval"` when a tool call requires user approval.
	 *
	 * @param executionId - The execution to update.
	 * @param status      - The new intermediate status.
	 */
	updateStatus(executionId: string, status: WorkflowExecutionStatus): void {
		const execution = this.active.get(executionId);
		if (execution) {
			execution.status = status;
			log.debug("Execution status updated", { executionId, status });
		}
	}

	// -----------------------------------------------------------------------
	// Queries
	// -----------------------------------------------------------------------

	/**
	 * Check whether the same workflow is already active or queued.
	 *
	 * Returns `true` if any active or queued execution has the same
	 * `workflowPath` — the caller should skip with a Notice.
	 *
	 * @param workflowPath - Vault-relative path of the workflow to check.
	 */
	isWorkflowRunning(workflowPath: string): boolean {
		for (const exec of this.active.values()) {
			if (exec.workflow_path === workflowPath) {
				return true;
			}
		}
		for (const item of this.queue) {
			if (item.execution.workflow_path === workflowPath) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Return currently running and waiting executions.
	 *
	 * Used by the activity indicator (Group H) to show active workflows.
	 *
	 * @returns Snapshot of all active executions (running + waiting_approval + queued).
	 */
	getActiveExecutions(): WorkflowExecution[] {
		return [...this.active.values()];
	}

	/**
	 * Return the N most recent completed and active executions, sorted by
	 * recency (most recently started/completed first).
	 *
	 * Used by the activity indicator dropdown (Group H).
	 *
	 * @param n - Maximum number of entries to return.
	 * @returns Combined active + recent executions, newest first, capped at `n`.
	 */
	getRecentExecutions(n: number): WorkflowExecution[] {
		const active = [...this.active.values()].sort(
			(a, b) => b.started_at.localeCompare(a.started_at)
		);
		const combined = [...active, ...this.recentExecutions];
		return combined.slice(0, n);
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Update the concurrency limit at runtime (e.g., when settings change).
	 *
	 * If the new limit is higher than the current active count, pending
	 * queue items are started immediately.
	 *
	 * @param limit - New concurrency limit.
	 */
	updateLimit(limit: number): void {
		this.limit = limit;
		// Drain the queue if the new limit allows more concurrent runs
		while (this.queue.length > 0 && this._activeRunningCount() < this.limit) {
			const next = this.queue.shift()!;
			this._start(next.execution, next.runFn);
		}
	}

	/**
	 * Clear all state — called on plugin unload.
	 *
	 * In-flight workflows are abandoned (their run functions will eventually
	 * resolve or reject, but we no longer track them).
	 */
	destroy(): void {
		this.active.clear();
		this.queue.length = 0;
		this.recentExecutions = [];
		log.info("WorkflowConcurrencyManager destroyed");
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	/** Count active executions that are actually running (not just queued). */
	private _activeRunningCount(): number {
		let count = 0;
		for (const exec of this.active.values()) {
			if (exec.status !== "queued") {
				count++;
			}
		}
		return count;
	}

	/**
	 * Start an execution by transitioning its status to `"running"` and
	 * invoking the run function.
	 */
	private _start(execution: WorkflowExecution, runFn: () => Promise<void>): void {
		execution.status = "running";
		execution.started_at = new Date().toISOString();

		void runFn().catch((e) => {
			// Errors should be handled inside the run function itself; this
			// is a safety net to ensure onComplete is always called.
			const errMsg = e instanceof Error ? e.message : String(e);
			log.error("Unhandled error in background workflow run function", {
				id: execution.id,
				error: errMsg,
			});
			this.onComplete(execution.id, "errored", errMsg);
		});
	}
}
