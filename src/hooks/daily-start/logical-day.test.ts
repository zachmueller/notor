import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RESET_TIME, isValidResetTime, logicalDay, parseResetTime } from "./logical-day";

const FOUR_AM = { hours: 4, minutes: 0 };

describe("parseResetTime", () => {
	it("parses HH:MM and H:MM", () => {
		expect(parseResetTime("04:30")).toEqual({ hours: 4, minutes: 30 });
		expect(parseResetTime("7:05")).toEqual({ hours: 7, minutes: 5 });
		expect(parseResetTime(" 23:59 ")).toEqual({ hours: 23, minutes: 59 });
	});

	it("falls back to 04:00 for invalid input", () => {
		for (const bad of ["", "24:00", "4", "04:60", "four", null, undefined]) {
			expect(parseResetTime(bad)).toEqual(DEFAULT_RESET_TIME);
		}
		expect(isValidResetTime("24:00")).toBe(false);
		expect(isValidResetTime("00:00")).toBe(true);
	});
});

describe("logicalDay", () => {
	it("counts activity before the reset time as the previous day", () => {
		expect(logicalDay(new Date(2026, 9, 18, 2, 0), FOUR_AM)).toBe("2026-10-17");
		expect(logicalDay(new Date(2026, 9, 18, 3, 59), FOUR_AM)).toBe("2026-10-17");
	});

	it("starts the new day at the reset time", () => {
		expect(logicalDay(new Date(2026, 9, 18, 4, 0), FOUR_AM)).toBe("2026-10-18");
		expect(logicalDay(new Date(2026, 9, 18, 23, 59), FOUR_AM)).toBe("2026-10-18");
	});

	it("treats a midnight reset as the calendar date", () => {
		const midnight = { hours: 0, minutes: 0 };
		expect(logicalDay(new Date(2026, 9, 18, 0, 0), midnight)).toBe("2026-10-18");
		expect(logicalDay(new Date(2026, 9, 17, 23, 59), midnight)).toBe("2026-10-17");
	});

	it("rolls back across month and year boundaries", () => {
		expect(logicalDay(new Date(2026, 10, 1, 1, 0), FOUR_AM)).toBe("2026-10-31");
		expect(logicalDay(new Date(2027, 0, 1, 1, 0), FOUR_AM)).toBe("2026-12-31");
	});

	describe("across DST transitions (America/New_York)", () => {
		const originalTz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = originalTz;
		});

		it("keeps the boundary on spring-forward and fall-back days", () => {
			process.env.TZ = "America/New_York";
			// 2026-03-08: clocks jump 02:00 → 03:00.
			expect(logicalDay(new Date(2026, 2, 8, 3, 30), FOUR_AM)).toBe("2026-03-07");
			expect(logicalDay(new Date(2026, 2, 8, 4, 0), FOUR_AM)).toBe("2026-03-08");
			// 2026-11-01: clocks fall back 02:00 → 01:00.
			expect(logicalDay(new Date(2026, 10, 1, 1, 30), FOUR_AM)).toBe("2026-10-31");
			expect(logicalDay(new Date(2026, 10, 1, 4, 0), FOUR_AM)).toBe("2026-11-01");
		});
	});
});
