/**
 * Trigger sources — shared collection + routing for timer-like triggers.
 *
 * `on_schedule` (cron, `VaultEventScheduler`) and `on_daily_start`
 * (`DailyStartDetector`) fire the same four kinds of target:
 *
 * 1. Settings hooks in `vault_event_hooks[event]`
 * 2. Discovered workflows with a matching `notor-trigger`
 * 3. Extension automations with a matching trigger
 * 4. Circuits that opt in via frontmatter (`notor-schedule` / `notor-daily-start`)
 *
 * `collectTriggerTargets()` gathers them (respecting the per-item enable
 * maps) and `fireTriggerTarget()` routes one to its executor, so the two
 * firing mechanisms share a single implementation of the four-way branch.
 */

import { Notice } from "obsidian";
import type { ExecutionChain, VaultEventHook, Workflow, WorkflowTrigger } from "../types";
import type { VaultEventHookContext } from "./vault-event-hook-engine";
import type { NotorSettings } from "../settings/types";
import type { AutomationTrigger, UserAutomationDefinition } from "../extensions/types";
import type { Circuit } from "../circuits/types";
import { circuitEnabledKey, circuitJobKey } from "../circuits/circuit-enabled";
import { logger } from "../utils/logger";

const log = logger("TriggerSources");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One firable target, keyed by the same ids the scheduler uses for its jobs. */
export type TriggerTarget =
	| { kind: "hook"; key: string; label: string; hook: VaultEventHook }
	| { kind: "workflow"; key: string; label: string; workflow: Workflow }
	| { kind: "automation"; key: string; label: string; automation: UserAutomationDefinition }
	| { kind: "circuit"; key: string; label: string; circuit: Circuit };

/** Vault events driven by a trigger source rather than an Obsidian event. */
export type TimerHookEvent = "on_schedule" | "on_daily_start";

/** Lazily-read data sources (each may be unset before plugin init completes). */
export interface TriggerSourceAccessors {
	getSettings: (() => NotorSettings) | null;
	getDiscoveredWorkflows: (() => Workflow[]) | null;
	getAutomations: ((trigger: AutomationTrigger) => UserAutomationDefinition[]) | null;
	getDiscoveredCircuits: (() => Circuit[]) | null;
}

/** Which targets belong to a trigger. */
export interface TriggerSourceSpec {
	hookEvent: TimerHookEvent;
	workflowTrigger: WorkflowTrigger;
	/** Circuit opt-in (e.g. has a schedule, or `dailyStart`). */
	circuitMatches: (circuit: Circuit) => boolean;
	/** Require a cron expression on hooks, workflows, and automations. */
	requireSchedule: boolean;
}

/** Dispatch callback — matches what the plugin injects into the scheduler. */
export type TriggerDispatchFn = (
	hooks: Array<VaultEventHook | Workflow>,
	context: VaultEventHookContext,
	chain: ExecutionChain | null,
) => void;

/** Executors for each target kind. */
export interface TriggerExecutors {
	dispatchFn: TriggerDispatchFn | null;
	executeAutomation: ((automation: UserAutomationDefinition, context: Record<string, unknown>) => Promise<unknown>) | null;
	launchCircuit: ((circuit: Circuit) => Promise<void>) | null;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Collect every target for a trigger.
 *
 * @param spec      - Which trigger to collect for.
 * @param hooks     - Settings hooks to consider (only enabled hooks whose
 *                    `event` matches `spec.hookEvent` are kept).
 * @param accessors - Data sources for workflows, automations, and circuits.
 */
export function collectTriggerTargets(
	spec: TriggerSourceSpec,
	hooks: VaultEventHook[],
	accessors: TriggerSourceAccessors,
): TriggerTarget[] {
	const targets: TriggerTarget[] = [];
	const settings = accessors.getSettings?.();

	// Settings-configured hooks
	for (const hook of hooks) {
		if (hook.event !== spec.hookEvent || !hook.enabled) continue;
		if (spec.requireSchedule && !hook.schedule?.trim()) {
			log.warn(`${spec.hookEvent} hook has no schedule expression, skipping`, {
				hookId: hook.id,
				label: hook.label,
			});
			continue;
		}
		targets.push({ kind: "hook", key: hook.id, label: hook.label || hook.id, hook });
	}

	// Discovered workflows with a matching trigger
	if (accessors.getDiscoveredWorkflows) {
		const workflowEnabled = settings?.workflow_enabled;
		const workflows = accessors.getDiscoveredWorkflows().filter(
			(w) => w.trigger === spec.workflowTrigger
				&& (!spec.requireSchedule || !!w.schedule)
				&& workflowEnabled?.[w.file_path] !== false,
		);
		for (const workflow of workflows) {
			targets.push({
				kind: "workflow",
				key: `workflow:${workflow.file_path}`,
				label: workflow.display_name,
				workflow,
			});
		}
	}

	// EXT-014: Extension automations with a matching trigger
	if (accessors.getAutomations) {
		for (const automation of accessors.getAutomations(spec.hookEvent)) {
			if (spec.requireSchedule && !automation.schedule?.trim()) {
				log.warn(`${spec.hookEvent} automation has no schedule expression, skipping`, {
					filePath: automation.filePath,
				});
				continue;
			}
			targets.push({
				kind: "automation",
				key: `ext-auto:${automation.filePath}`,
				label: automation.displayName ?? automation.filePath,
				automation,
			});
		}
	}

	// Circuits that opt in to this trigger
	if (accessors.getDiscoveredCircuits) {
		const flowEnabled = settings?.flow_enabled;
		const circuits = accessors.getDiscoveredCircuits().filter(
			(c) => spec.circuitMatches(c) && flowEnabled?.[circuitEnabledKey(c.flowDir)] !== false,
		);
		for (const circuit of circuits) {
			targets.push({ kind: "circuit", key: circuitJobKey(circuit.flowDir), label: circuit.name, circuit });
		}
	}

	return targets;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Fire one target. Fire-and-forget: launch failures surface as Notices.
 *
 * @param target      - Target to fire.
 * @param hookEvent   - Trigger event stamped on the run context.
 * @param noticeLabel - Prefix for failure Notices (e.g. "Scheduled").
 * @param executors   - Per-kind executors.
 */
export function fireTriggerTarget(
	target: TriggerTarget,
	hookEvent: TimerHookEvent,
	noticeLabel: string,
	executors: TriggerExecutors,
): void {
	const { key, label } = target;
	const timestamp = new Date().toISOString();

	switch (target.kind) {
		case "circuit": {
			const launch = executors.launchCircuit;
			if (!launch) {
				log.warn(`${hookEvent} circuit fired but no circuit launcher set — skipping`, { key });
				return;
			}
			void (async () => {
				try {
					await launch(target.circuit);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error(`${noticeLabel} circuit launch failed`, { key, error: msg });
					new Notice(`${noticeLabel} circuit '${label}' failed to launch: ${msg}`);
				}
			})();
			return;
		}

		case "automation": {
			const execute = executors.executeAutomation;
			if (!execute) {
				log.warn(`${hookEvent} automation fired but no executor set — skipping`, { key });
				return;
			}
			const { automation } = target;
			const context: Record<string, unknown> = { hookEvent, timestamp };
			if (automation.schedule) context.schedule = automation.schedule;
			void (async () => {
				try {
					await execute(automation, context);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error(`Extension automation ${hookEvent} execution failed`, { key, error: msg });
					new Notice(`Automation error in ${label}: ${msg}`);
				}
			})();
			return;
		}

		case "hook":
		case "workflow": {
			if (!executors.dispatchFn) {
				log.warn(`${hookEvent} target fired but no dispatch function set — skipping`, { key });
				return;
			}
			const context: VaultEventHookContext = {
				hookEvent,
				timestamp,
				notePath: null,
				tagsAdded: null,
				tagsRemoved: null,
			};
			// Fire-and-forget
			executors.dispatchFn([target.kind === "hook" ? target.hook : target.workflow], context, null);
			return;
		}
	}
}
