/**
 * Workflow activity tracker — UI-oriented view of background workflow execution state.
 *
 * Wraps the {@link WorkflowConcurrencyManager} (F-020) to provide:
 * - Sorted, filtered, bounded entry lists for the activity indicator dropdown
 * - Active/waiting counts for the numeric badge
 * - Change notification callbacks for reactive DOM updates
 *
 * The tracker does NOT duplicate execution state — it delegates all queries
 * to the concurrency manager and adds UI-focused filtering and ordering.
 *
 * @see specs/03-workflows-personas/tasks/group-h-tasks.md — H-001
 * @see specs/03-workflows-personas/data-model.md — WorkflowExecution, WorkflowExecutionStatus
 */

import type { WorkflowExecution } from "../types";
import type { WorkflowConcurrencyManager } from "./workflow-concurrency";
import { logger } from "../utils/logger";

const log = logger("WorkflowActivityTracker");

/**
 * In-memory tracker providing UI-focused views of background workflow
 * execution state for the activity indicator (Group H).
 *
 * @see specs/03-workflows-personas/tasks/group-h-tasks.md — H-001
 */
export class WorkflowActivityTracker {
	private readonly concurrencyManager: WorkflowConcurrencyManager;
	private maxEntries: number;
	private readonly callbacks: Set<() => void> = new Set();

	/**
	 * @param concurrencyManager - The concurrency manager providing source execution state.
	 * @param maxEntries - Maximum entries to return from {@link getIndicatorEntries}.
	 *                     Sourced from `settings.workflow_activity_indicator_count` (default 5).
	 */
	constructor(concurrencyManager: WorkflowConcurrencyManager, maxEntries: number = 5) {
		this.concurrencyManager = concurrencyManager;
		this.maxEntries = maxEntries;
	}

	// -----------------------------------------------------------------------
	// Queries
	// -----------------------------------------------------------------------

	/**
	 * Return up to `maxEntries` entries for the activity indicator dropdown.
	 *
	 * Ordering: currently running/waiting workflows first (sorted by
	 * `started_at` descending), then completed/errored/stopped workflows
	 * (sorted by `completed_at` descending).
	 *
	 * Delegates to `concurrencyManager.getActiveExecutions()` and
	 * `concurrencyManager.getRecentExecutions(maxEntries)`.
	 */
	getIndicatorEntries(): WorkflowExecution[] {
		const active = this.concurrencyManager.getActiveExecutions();
		const recent = this.concurrencyManager.getRecentExecutions(this.maxEntries);

		// Separate active (running/waiting/queued) from completed
		const activeSet = new Set(active.map((e) => e.id));
		const activeEntries = active.sort(
			(a, b) => b.started_at.localeCompare(a.started_at)
		);
		const completedEntries = recent
			.filter((e) => !activeSet.has(e.id))
			.sort((a, b) => {
				const aTime = a.completed_at ?? a.started_at;
				const bTime = b.completed_at ?? b.started_at;
				return bTime.localeCompare(aTime);
			});

		return [...activeEntries, ...completedEntries].slice(0, this.maxEntries);
	}

	/**
	 * Return the count of executions with status `"running"` or `"waiting_approval"`.
	 *
	 * Used by the numeric badge (H-002).
	 */
	getActiveCount(): number {
		const active = this.concurrencyManager.getActiveExecutions();
		return active.filter(
			(e) => e.status === "running" || e.status === "waiting_approval"
		).length;
	}

	/**
	 * Return `true` if any execution is in `"running"` or `"waiting_approval"` status.
	 *
	 * Used to toggle the animated indicator state (H-003).
	 */
	hasActiveWorkflows(): boolean {
		return this.getActiveCount() > 0;
	}

	/**
	 * Return `true` if any execution has status `"waiting_approval"`.
	 *
	 * Used for prominent approval-needed indicator styling (H-003).
	 */
	hasWaitingApproval(): boolean {
		const active = this.concurrencyManager.getActiveExecutions();
		return active.some((e) => e.status === "waiting_approval");
	}

	// -----------------------------------------------------------------------
	// Change notifications
	// -----------------------------------------------------------------------

	/**
	 * Register a listener that fires whenever execution state changes.
	 *
	 * @param callback - Function to invoke on state change.
	 * @returns An unregister function that removes the callback.
	 */
	onChange(callback: () => void): () => void {
		this.callbacks.add(callback);
		return () => {
			this.callbacks.delete(callback);
		};
	}

	/**
	 * Called by the concurrency manager (or wiring layer) whenever execution
	 * state changes. Fires all registered `onChange` callbacks.
	 */
	notifyChange(): void {
		for (const cb of this.callbacks) {
			try {
				cb();
			} catch (e) {
				log.error("onChange callback error", { error: String(e) });
			}
		}
	}

	// -----------------------------------------------------------------------
	// Runtime configuration
	// -----------------------------------------------------------------------

	/**
	 * Update the `maxEntries` limit at runtime (for settings changes
	 * without plugin reload).
	 *
	 * @param n - New maximum entry count.
	 */
	updateMaxEntries(n: number): void {
		this.maxEntries = n;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Clear all registered callbacks. Called on plugin unload.
	 */
	destroy(): void {
		this.callbacks.clear();
		log.info("WorkflowActivityTracker destroyed");
	}
}
