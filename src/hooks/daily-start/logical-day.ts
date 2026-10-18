/**
 * Logical-day arithmetic for the `on_daily_start` trigger.
 *
 * A logical day starts at the user's reset time (local, `"HH:MM"`) instead
 * of midnight: with a 04:00 reset, activity at 02:00 still belongs to the
 * previous day. All arithmetic is done on local calendar fields, never on
 * millisecond offsets, so DST transitions don't shift the boundary.
 */

/** A parsed reset time (24-hour local clock). */
export interface ResetTime {
	hours: number;
	minutes: number;
}

/** Used when the configured reset time is missing or malformed. */
export const DEFAULT_RESET_TIME: ResetTime = { hours: 4, minutes: 0 };

const RESET_TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** True for a valid `"H:MM"` / `"HH:MM"` 24-hour time. */
export function isValidResetTime(value: string): boolean {
	return RESET_TIME_PATTERN.test(value.trim());
}

/** Parse `"HH:MM"`; falls back to {@link DEFAULT_RESET_TIME} when invalid. */
export function parseResetTime(value: string | null | undefined): ResetTime {
	const match = RESET_TIME_PATTERN.exec((value ?? "").trim());
	if (!match) return DEFAULT_RESET_TIME;
	return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/**
 * The logical day (`"YYYY-MM-DD"`, local) that `now` belongs to: the local
 * calendar date, minus one day when the local time is before the reset time.
 */
export function logicalDay(now: Date, reset: ResetTime): string {
	const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const minutesNow = now.getHours() * 60 + now.getMinutes();
	if (minutesNow < reset.hours * 60 + reset.minutes) {
		day.setDate(day.getDate() - 1);
	}
	return formatLocalDate(day);
}

function formatLocalDate(d: Date): string {
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${mm}-${dd}`;
}
