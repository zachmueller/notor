/**
 * "At most once per local calendar day" gate for housekeeping tasks that would
 * otherwise run on every launch (e.g. history retention).
 *
 * The last-run marker is a `YYYY-MM-DD` string for the local date. A missing,
 * malformed, or different-day marker means the task is due.
 */

/** Local calendar date as `YYYY-MM-DD`. */
export function localDayKey(now: Date): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/** Whether a daily task whose last run is recorded as `lastRun` is due at `now`. */
export function isDailyTaskDue(lastRun: unknown, now: Date): boolean {
	return lastRun !== localDayKey(now);
}
