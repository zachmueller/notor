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
import type { NotorSettings } from "../settings/types";
import type { AutomationTrigger, UserAutomationDefinition } from "../extensions/types";
import type { Circuit } from "../circuits/types";
import {
	collectTriggerTargets,
	fireTriggerTarget,
	type TriggerDispatchFn,
	type TriggerSourceAccessors,
	type TriggerSourceSpec,
	type TriggerTarget,
} from "./trigger-sources";
import { logger } from "../utils/logger";

const log = logger("VaultEventScheduler");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Dispatch callback signature — matches what F-023 injects via `setDispatch()`.
 * Must be set before `syncJobs()` is called.
 */
export type SchedulerDispatchFn = TriggerDispatchFn;

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

	/**
	 * Accessor for current plugin settings (for workflow_enabled filtering).
	 * Set via `setSettingsAccessor()` during plugin initialization.
	 */
	private getSettings: (() => NotorSettings) | null = null;

	/**
	 * EXT-014: Accessor for user-defined automations with `on_schedule` trigger.
	 * Set via `setExtensionAutomations()` during plugin initialization.
	 */
	private extensionAutomationsAccessor: ((trigger: AutomationTrigger) => UserAutomationDefinition[]) | null = null;

	/**
	 * EXT-014: Executor for user-defined automations.
	 * Encapsulates runtime context building and compiled function invocation.
	 */
	private extensionAutomationExecutor: ((automation: UserAutomationDefinition, context: Record<string, unknown>) => Promise<unknown>) | null = null;

	/**
	 * Accessor for currently discovered orchestration flows.
	 * Used to collect flows with a `notor-schedule` cron expression.
	 * Set via `setDiscoveredFlows()` during plugin initialization.
	 */
	private getDiscoveredCircuits: (() => Circuit[]) | null = null;

	/**
	 * Launcher for a scheduled orchestration flow. Encapsulates resolving the
	 * runtime + calling `launchCircuit(..., { origin: "schedule" })`.
	 * Set via `setDiscoveredFlows()`.
	 */
	private flowLaunchExecutor: ((flow: Circuit) => Promise<void>) | null = null;

	/**
	 * Evaluator for a circuit's scheduled evaluation (`notor-eval-schedule`):
	 * scores the circuit's finished sessions the current evaluators have not
	 * scored yet. Set via `setCircuitEvaluator()`.
	 */
	private circuitEvalExecutor: ((flow: Circuit) => Promise<void>) | null = null;

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

	/**
	 * EXT-014: Inject the extension automation accessor and executor.
	 *
	 * Separate from `setDispatch()` — each data source has its own injection
	 * point. Must be called before `syncJobs()` for automation schedules to
	 * be picked up.
	 *
	 * @param getAutomations    - Returns automations matching the given trigger.
	 * @param executeAutomation - Executes an automation with runtime context.
	 */
	setExtensionAutomations(
		getAutomations: (trigger: AutomationTrigger) => UserAutomationDefinition[],
		executeAutomation: (automation: UserAutomationDefinition, context: Record<string, unknown>) => Promise<unknown>,
	): void {
		this.extensionAutomationsAccessor = getAutomations;
		this.extensionAutomationExecutor = executeAutomation;
	}

	/**
	 * Inject the settings accessor for workflow_enabled filtering.
	 */
	setSettingsAccessor(getSettings: () => NotorSettings): void {
		this.getSettings = getSettings;
	}

	/**
	 * Inject the orchestration-flow accessor + launcher.
	 *
	 * Mirrors `setDispatch()` for flows: `getFlows` returns the currently
	 * discovered flows (so `syncJobs()` can pick up those with `notor-schedule`),
	 * and `launchFlow` launches one with `origin: "schedule"`. Must be called
	 * before `syncJobs()` for scheduled flows to be registered.
	 */
	setDiscoveredFlows(
		getFlows: () => Circuit[],
		launchFlow: (flow: Circuit) => Promise<void>,
	): void {
		this.getDiscoveredCircuits = getFlows;
		this.flowLaunchExecutor = launchFlow;
	}

	/**
	 * Set the executor for scheduled circuit evaluations (`notor-eval-schedule`).
	 * Uses the circuit accessor from `setDiscoveredFlows()`; a circuit with an
	 * eval schedule gets its own `eval:{flowDir}` job alongside any run schedule.
	 */
	setCircuitEvaluator(evaluate: (flow: Circuit) => Promise<void>): void {
		this.circuitEvalExecutor = evaluate;
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
	 * `notor-trigger: "on-schedule"`). Each scheduled workflow gets its own
	 * cron job keyed by its file path + schedule string.
	 *
	 * @param hooks - Current list of enabled `on_schedule` hooks from settings.
	 */
	syncJobs(hooks: VaultEventHook[]): void {
		// Desired job set: settings hooks + scheduled workflow triggers + extension automations + scheduled circuits
		const desiredJobs = new Map<string, TriggerTarget>();
		for (const target of collectTriggerTargets(SCHEDULE_TRIGGER_SPEC, hooks, this.sourceAccessors())) {
			desiredJobs.set(target.key, target);
		}

		// Stop jobs that are no longer desired
		for (const [id, job] of this.jobs) {
			if (!desiredJobs.has(id)) {
				this.stopJob(id, job);
			}
		}

		// Start jobs that are new
		for (const [id, target] of desiredJobs) {
			if (!this.jobs.has(id)) {
				this.startJob(target);
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

	/**
	 * Check whether a job with the given key is currently active.
	 * Used by the settings UI to show active/inactive status indicators.
	 */
	isJobActive(key: string): boolean {
		return this.jobs.has(key);
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
		this.extensionAutomationsAccessor = null;
		this.extensionAutomationExecutor = null;
		this.getDiscoveredCircuits = null;
		this.flowLaunchExecutor = null;
		log.debug("VaultEventScheduler destroyed");
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	/**
	 * Create and start a new cron job for the given target.
	 *
	 * Each job fires the target with the `on_schedule` event context. No note
	 * path is provided (scheduled events are not note-specific).
	 *
	 * @param target - Hook, workflow, automation, or circuit to schedule. Its
	 *                 key (hook ID, `workflow:{filePath}`, `ext-auto:{filePath}`,
	 *                 `orch:{flowDir}`, or `eval:{flowDir}`) identifies the job.
	 */
	private startJob(target: TriggerTarget): void {
		const { key: id, label } = target;
		const schedule = scheduleOf(target);
		try {
			const job = new Cron(schedule, () => {
				this.onJobFire(target);
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
	 * Called by a cron job when it fires: routes the target to its executor.
	 */
	private onJobFire(target: TriggerTarget): void {
		log.debug("on_schedule job fired", { id: target.key, label: target.label });
		fireTriggerTarget(target, "on_schedule", "Scheduled", {
			dispatchFn: this.dispatchFn,
			executeAutomation: this.extensionAutomationExecutor,
			launchCircuit: this.flowLaunchExecutor,
			evaluateCircuit: this.circuitEvalExecutor,
		});
	}

	/** Data sources for `collectTriggerTargets()`. */
	private sourceAccessors(): TriggerSourceAccessors {
		return {
			getSettings: this.getSettings,
			getDiscoveredWorkflows: this.getDiscoveredWorkflows,
			getAutomations: this.extensionAutomationsAccessor,
			getDiscoveredCircuits: this.getDiscoveredCircuits,
		};
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `on_schedule` sources: every target needs a cron expression. */
const SCHEDULE_TRIGGER_SPEC: TriggerSourceSpec = {
	hookEvent: "on_schedule",
	workflowTrigger: "on-schedule",
	circuitMatches: (circuit) => !!circuit.schedule,
	// An eval schedule with nothing to run is inert.
	circuitEvalMatches: (circuit) => !!circuit.evalSchedule && circuit.evaluators.length > 0,
	requireSchedule: true,
};

/** The cron expression for a collected `on_schedule` target. */
function scheduleOf(target: TriggerTarget): string {
	switch (target.kind) {
		case "hook": return target.hook.schedule?.trim() ?? "";
		case "workflow": return target.workflow.schedule ?? "";
		case "automation": return target.automation.schedule?.trim() ?? "";
		case "circuit": return target.circuit.schedule ?? "";
		case "circuit_eval": return target.circuit.evalSchedule ?? "";
	}
}
