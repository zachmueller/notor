/**
 * Shared key helpers for scheduled orchestration flows.
 *
 * Both the `VaultEventScheduler` (job registration) and the Automation settings
 * section (enable toggle + status dot) must agree on:
 *
 *  - the **enable key** used in `NotorSettings.flow_enabled` (keyed by flow dir,
 *    which is stable and collision-free against `workflow_enabled` file paths), and
 *  - the **cron job key** used in the scheduler's job map.
 *
 * Keeping both in one place avoids the two surfaces drifting apart.
 */

/** Settings `flow_enabled` map key for a scheduled flow (its vault directory). */
export function flowEnabledKey(flowDir: string): string {
	return flowDir;
}

/** Scheduler job-map key for a scheduled flow's cron job. */
export function flowJobKey(flowDir: string): string {
	return `orch:${flowDir}`;
}
