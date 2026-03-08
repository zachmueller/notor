/**
 * Vault event scheduler — cron-based scheduler for on_schedule hooks.
 *
 * Implements FR-50 using `croner` v10.x. Manages cron jobs dynamically —
 * creating, and stopping jobs based on hook configuration. Per R-1 research
 * findings.
 *
 * Scheduled workflows execute in the same background pipeline as other
 * vault event hooks. If Obsidian is not running at the scheduled time,
 * execution is skipped (no catch-up — inherent behaviour of in-process cron).
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-013
 * @see specs/03-workflows-personas/research/research-r1-bundle-test.mjs
 */

import { Cron } from "croner";
import type { VaultEventHook, Workflow } from "../types";
import type { VaultEventHookContext } from "./vault-event-hook-engine";
import type { ExecutionChain } from "../types";
import { logger } from "../utils/logger";

const log = logger("VaultEventScheduler");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Dispatch callback signature — matches what F-023 injects via `setDispatch()`.
 * Must be set before `syncJobs()` is called.
 */
export type SchedulerDispatchFn = (
	hooks: Array<VaultEventHook | Workflow>,
	context: VaultEventHookContext,
	chain: ExecutionChain | null
) => void;

// ---------------------------------------------------------------------------
// VaultEventScheduler
// ---------------------------------------------------------------------------

/**
 * Manages cron jobs for `on_schedule` vault event hooks.
 *
 * Jobs are keyed by hook ID in an internal Map for individual management.
 * `syncJobs()` reconciles the live job set against the current hook
 * configuration — creating jobs for newly added hooks and stopping jobs
 * for removed hooks.
 *
 * Default timezone: local system time (no `timezone` option per R-1
 * recommendation to avoid IANA timezone database shipping overhead).
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-013
 */
export class VaultEventScheduler {
	/** Active cron jobs keyed by hook ID. */
	private readonly jobs = new Map<string, Cron>();

	/**
	 * Dispatch function injected from the vault event dispatcher (F-018).
	 * Set via `setDispatch()` during plugin initialization (F-023).
	 */
	private dispatchFn: SchedulerDispatchFn | null = null;

	/**
	 * Accessor for currently discovered workflows.
	 * Used to collect workflow triggers for `on_schedule` events.
	 */
	private getDiscoveredWorkflows: (() => Workflow[]) | null = null;

	// ---------------------------------------------------------------------------
	// Initialization
	// ---------------------------------------------------------------------------

	/**
	 * Inject the dispatch function and workflow discovery accessor.
	 *
	 * Must be called before `syncJobs()`.
	 *
	 * @param dispatchFn            - Vault event hook dispatch function.
	 * @param getDiscoveredWorkflows - Returns the currently discovered workflows.
	 */
	setDispatch(
		dispatchFn: SchedulerDispatchFn,
		getDiscoveredWorkflows: () => Workflow[]
	): void {
		this.dispatchFn = dispatchFn;
		this.getDiscoveredWorkflows = getDiscoveredWorkflows;
	}

	// ---------------------------------------------------------------------------
	// Job synchronization
	// ---------------------------------------------------------------------------

	/**
	 * Synchronize cron jobs with the current list of enabled `on_schedule` hooks.
	 *
	 * - Creates new `Cron` jobs for hooks that have been added.
	 * - Stops and removes jobs for hooks that have been removed.
	 * - Leaves unchanged jobs running (identified by hook ID).
	 *
	 * Also reconciles scheduled workflow triggers (discovered workflows with
	 * `notor-trigger: "scheduled"`). Each scheduled workflow gets its own
	 * cron job keyed by its file path + schedule string.
	 *
	 * @param hooks - Current list of enabled `on_schedule` hooks from settings.
	 */
	syncJobs(hooks: VaultEventHook[]): void {
		// Build the desired job set: settings hooks + scheduled workflow triggers
		const desiredJobs = new Map<string, { schedule: string; label: string; isWorkflow: boolean; hook?: VaultEventHook; workflow?: Workflow }>();

		// Settings-configured hooks
		for (const hook of hooks) {
			if (hook.event !== "on_schedule" || !hook.enabled) continue;
			if (!hook.schedule?.trim()) {
				log.warn("on_schedule hook has no schedule expression, skipping", {
					hookId: hook.id,
					label: hook.label,
				});
				continue;
			}
			desiredJobs.set(hook.id, {
				schedule: hook.schedule.trim(),
				label: hook.label || hook.id,
				isWorkflow: false,
				hook,
			});
		}

		// Discovered workflow triggers with "scheduled" trigger
		if (this.getDiscoveredWorkflows) {
			const scheduledWorkflows = this.getDiscoveredWorkflows().filter(
				(w) => w.trigger === "scheduled" && w.schedule
			);
			for (const workflow of scheduledWorkflows) {
				// Key: file path (unique per workflow)
				const key = `workflow:${workflow.file_path}`;
				desiredJobs.set(key, {
					schedule: workflow.schedule!,
					label: workflow.display_name,
					isWorkflow: true,
					workflow,
				});
			}
		}

		// Stop jobs that are no longer desired
		for (const [id, job] of this.jobs) {
			if (!desiredJobs.has(id)) {
				this.stopJob(id, job);
			}
		}

		// Start jobs that are new
		for (const [id, desired] of desiredJobs) {
			if (!this.jobs.has(id)) {
				this.startJob(id, desired.schedule, desired.label, desired.hook, desired.workflow);
			}
		}

		log.debug("on_schedule jobs synchronized", {
			active: this.jobs.size,
			desired: desiredJobs.size,
		});
	}

	// ---------------------------------------------------------------------------
	// Cron expression validation (exported for settings UI — F-003)
	// ---------------------------------------------------------------------------

	/**
	 * Validate a cron expression using croner's `Cron` constructor in dry-run mode.
	 *
	 * Wraps `new Cron(expr, { paused: true })` in a try/catch per R-1 findings.
	 * The constructed job is immediately stopped and discarded.
	 *
	 * @param expr - Cron expression string to validate.
	 * @returns `{ valid: true }` on success or `{ valid: false, error: string }` on failure.
	 */
	validateCronExpression(expr: string): { valid: boolean; error?: string } {
		const trimmed = expr.trim();
		if (!trimmed) {
			return { valid: false, error: "Cron expression is empty." };
		}

		try {
			const job = new Cron(trimmed, { paused: true });
			job.stop();
			return { valid: true };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { valid: false, error: msg };
		}
	}

	/**
	 * Get the next scheduled run time for a cron expression.
	 *
	 * Creates a temporary paused `Cron` job, calls `nextRun()`, then stops it.
	 * Used for the settings UI next-run preview (F-003).
	 *
	 * @param expr - Cron expression string.
	 * @returns The next `Date` on which the expression would fire, or `null`
	 *   if the expression is invalid or has no future run.
	 */
	getNextRun(expr: string): Date | null {
		const trimmed = expr.trim();
		if (!trimmed) return null;

		try {
			const job = new Cron(trimmed, { paused: true });
			const next = job.nextRun();
			job.stop();
			return next ?? null;
		} catch {
			return null;
		}
	}

	// ---------------------------------------------------------------------------
	// Cleanup
	// ---------------------------------------------------------------------------

	/**
	 * Stop all active cron jobs and clear internal state.
	 *
	 * Called on plugin unload.
	 */
	destroy(): void {
		for (const [id, job] of this.jobs) {
			this.stopJob(id, job);
		}
		this.jobs.clear();
		this.dispatchFn = null;
		this.getDiscoveredWorkflows = null;
		log.debug("VaultEventScheduler destroyed");
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	/**
	 * Create and start a new cron job for the given hook or workflow.
	 *
	 * Each job fires the vault event dispatch pipeline with the `on_schedule`
	 * event context. No note path is provided (scheduled events are not
	 * note-specific).
	 *
	 * @param id       - Unique job key (hook ID or `workflow:{filePath}`).
	 * @param schedule - Cron expression.
	 * @param label    - Human-readable label for logging.
	 * @param hook     - Settings hook (if this is a settings-configured hook).
	 * @param workflow - Discovered workflow (if this is a workflow trigger).
	 */
	private startJob(
		id: string,
		schedule: string,
		label: string,
		hook?: VaultEventHook,
		workflow?: Workflow
	): void {
		try {
			const job = new Cron(schedule, () => {
				this.onJobFire(id, label, hook, workflow);
			});

			this.jobs.set(id, job);

			const nextRun = job.nextRun();
			log.info("Scheduled cron job started", {
				id,
				label,
				schedule,
				nextRun: nextRun?.toISOString() ?? "none",
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log.error("Failed to start cron job", { id, label, schedule, error: msg });
		}
	}

	/**
	 * Stop and remove a cron job.
	 *
	 * @param id  - Job key.
	 * @param job - `Cron` instance to stop.
	 */
	private stopJob(id: string, job: Cron): void {
		try {
			job.stop();
		} catch (e) {
			log.warn("Error stopping cron job", { id, error: String(e) });
		}
		this.jobs.delete(id);
		log.info("Scheduled cron job stopped", { id });
	}

	/**
	 * Called by a cron job when it fires.
	 *
	 * Assembles the event context and dispatches to the hook pipeline.
	 *
	 * @param id       - Job key (for logging).
	 * @param label    - Human-readable label (for logging).
	 * @param hook     - Settings hook, if applicable.
	 * @param workflow - Workflow trigger, if applicable.
	 */
	private onJobFire(
		id: string,
		label: string,
		hook?: VaultEventHook,
		workflow?: Workflow
	): void {
		log.debug("on_schedule job fired", { id, label });

		if (!this.dispatchFn) {
			log.warn("on_schedule job fired but no dispatch function set — skipping", { id });
			return;
		}

		const context: VaultEventHookContext = {
			hookEvent: "on_schedule",
			timestamp: new Date().toISOString(),
			notePath: null,
			tagsAdded: null,
			tagsRemoved: null,
		};

		// Collect hooks to dispatch: either the settings hook or the workflow trigger
		const hooksToDispatch: Array<VaultEventHook | Workflow> = [];

		if (hook) {
			hooksToDispatch.push(hook);
		} else if (workflow) {
			hooksToDispatch.push(workflow);
		}

		if (hooksToDispatch.length === 0) {
			log.warn("on_schedule job fired but no hooks to dispatch", { id });
			return;
		}

		// Fire-and-forget
		this.dispatchFn(hooksToDispatch, context, null);
	}
}
