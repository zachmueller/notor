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
import { Notice } from "obsidian";
import type { VaultEventHook, Workflow } from "../types";
import type { VaultEventHookContext } from "./vault-event-hook-engine";
import type { ExecutionChain } from "../types";
import type { NotorSettings } from "../settings/types";
import type { AutomationTrigger, UserAutomationDefinition } from "../extensions/types";
import type { OrchestrationFlow } from "../orchestration/types";
import { flowEnabledKey, flowJobKey } from "../orchestration/flow-enabled";
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
	private getDiscoveredFlows: (() => OrchestrationFlow[]) | null = null;

	/**
	 * Launcher for a scheduled orchestration flow. Encapsulates resolving the
	 * runtime + calling `launchOrchestration(..., { origin: "schedule" })`.
	 * Set via `setDiscoveredFlows()`.
	 */
	private flowLaunchExecutor: ((flow: OrchestrationFlow) => Promise<void>) | null = null;

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
		getFlows: () => OrchestrationFlow[],
		launchFlow: (flow: OrchestrationFlow) => Promise<void>,
	): void {
		this.getDiscoveredFlows = getFlows;
		this.flowLaunchExecutor = launchFlow;
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
		// Build the desired job set: settings hooks + scheduled workflow triggers + extension automations + scheduled flows
		const desiredJobs = new Map<string, { schedule: string; label: string; isWorkflow: boolean; hook?: VaultEventHook; workflow?: Workflow; automation?: UserAutomationDefinition; flow?: OrchestrationFlow }>();

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

		// Discovered workflow triggers with "on-schedule" trigger
		if (this.getDiscoveredWorkflows) {
			const workflowEnabled = this.getSettings?.()?.workflow_enabled;
			const scheduledWorkflows = this.getDiscoveredWorkflows().filter(
				(w) => w.trigger === "on-schedule" && w.schedule && workflowEnabled?.[w.file_path] !== false
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

		// EXT-014: Extension automations with on_schedule trigger
		if (this.extensionAutomationsAccessor) {
			const scheduledAutomations = this.extensionAutomationsAccessor("on_schedule");
			for (const automation of scheduledAutomations) {
				if (!automation.schedule?.trim()) {
					log.warn("on_schedule automation has no schedule expression, skipping", {
						filePath: automation.filePath,
					});
					continue;
				}
				const key = `ext-auto:${automation.filePath}`;
				desiredJobs.set(key, {
					schedule: automation.schedule.trim(),
					label: automation.displayName ?? automation.filePath,
					isWorkflow: false,
					automation,
				});
			}
		}

		// Scheduled orchestration flows (flows whose definition.md declares a valid
		// `notor-schedule`). Each flow gets its own cron job keyed by `orch:{flowDir}`.
		if (this.getDiscoveredFlows) {
			const flowEnabled = this.getSettings?.()?.flow_enabled;
			const scheduledFlows = this.getDiscoveredFlows().filter(
				(f) => f.schedule && flowEnabled?.[flowEnabledKey(f.flowDir)] !== false,
			);
			for (const flow of scheduledFlows) {
				const key = flowJobKey(flow.flowDir);
				desiredJobs.set(key, {
					schedule: flow.schedule!,
					label: flow.name,
					isWorkflow: false,
					flow,
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
				this.startJob(id, desired.schedule, desired.label, desired.hook, desired.workflow, desired.automation, desired.flow);
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
		this.getDiscoveredFlows = null;
		this.flowLaunchExecutor = null;
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
	 * @param id       - Unique job key (hook ID, `workflow:{filePath}`, or `orch:{flowDir}`).
	 * @param schedule - Cron expression.
	 * @param label    - Human-readable label for logging.
	 * @param hook     - Settings hook (if this is a settings-configured hook).
	 * @param workflow - Discovered workflow (if this is a workflow trigger).
	 * @param automation - Extension automation (if this is an automation trigger).
	 * @param flow     - Orchestration flow (if this is a scheduled-flow trigger).
	 */
	private startJob(
		id: string,
		schedule: string,
		label: string,
		hook?: VaultEventHook,
		workflow?: Workflow,
		automation?: UserAutomationDefinition,
		flow?: OrchestrationFlow,
	): void {
		try {
			const job = new Cron(schedule, () => {
				this.onJobFire(id, label, hook, workflow, automation, flow);
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
	 * @param automation - Extension automation, if applicable.
	 * @param flow     - Scheduled orchestration flow, if applicable.
	 */
	private onJobFire(
		id: string,
		label: string,
		hook?: VaultEventHook,
		workflow?: Workflow,
		automation?: UserAutomationDefinition,
		flow?: OrchestrationFlow,
	): void {
		log.debug("on_schedule job fired", { id, label });

		// Scheduled orchestration flow — launch directly via the flow executor.
		if (flow) {
			if (!this.flowLaunchExecutor) {
				log.warn("on_schedule flow job fired but no flow launcher set — skipping", { id });
				return;
			}

			void (async () => {
				try {
					await this.flowLaunchExecutor!(flow);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Scheduled orchestration launch failed", { id, error: msg });
					new Notice(`Scheduled orchestration '${label}' failed to launch: ${msg}`);
				}
			})();
			return;
		}

		// EXT-014: Extension automation — execute directly via the executor callback
		if (automation) {
			if (!this.extensionAutomationExecutor) {
				log.warn("on_schedule automation job fired but no executor set — skipping", { id });
				return;
			}

			const context: Record<string, unknown> = {
				hookEvent: "on_schedule",
				timestamp: new Date().toISOString(),
				schedule: automation.schedule,
			};

			void (async () => {
				try {
					await this.extensionAutomationExecutor!(automation, context);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Extension automation on_schedule execution failed", { id, error: msg });
					new Notice(`Automation error in ${label}: ${msg}`);
				}
			})();
			return;
		}

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
