import { describe, expect, it } from "vitest";
import { isDailyTaskDue, localDayKey } from "./daily-gate";

describe("daily-gate", () => {
	it("formats the local calendar date with zero padding", () => {
		expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
		expect(localDayKey(new Date(2026, 10, 26, 0, 0))).toBe("2026-11-26");
	});

	it("is due when there is no valid marker", () => {
		const now = new Date(2026, 10, 26, 9, 0);
		expect(isDailyTaskDue(null, now)).toBe(true);
		expect(isDailyTaskDue(undefined, now)).toBe(true);
		expect(isDailyTaskDue(12345, now)).toBe(true);
		expect(isDailyTaskDue("garbage", now)).toBe(true);
	});

	it("is not due again on the same local day, and due the next day", () => {
		const morning = new Date(2026, 10, 26, 8, 0);
		const marker = localDayKey(morning);
		expect(isDailyTaskDue(marker, new Date(2026, 10, 26, 23, 59))).toBe(false);
		expect(isDailyTaskDue(marker, new Date(2026, 10, 27, 0, 1))).toBe(true);
	});
});
