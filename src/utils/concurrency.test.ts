import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./concurrency";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
	it("preserves input order even when later items finish first", async () => {
		const out = await mapWithConcurrency([30, 5, 15, 1], 4, async (ms, i) => {
			await delay(ms);
			return `${i}:${ms}`;
		});
		expect(out).toEqual(["0:30", "1:5", "2:15", "3:1"]);
	});

	it("never exceeds the concurrency limit", async () => {
		let active = 0;
		let peak = 0;
		await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
			active++;
			peak = Math.max(peak, active);
			await delay(2);
			active--;
		});
		expect(peak).toBe(3);
	});

	it("handles an empty list and a limit larger than the list", async () => {
		expect(await mapWithConcurrency([], 8, async (x) => x)).toEqual([]);
		expect(await mapWithConcurrency([1, 2], 50, async (x) => x * 2)).toEqual([2, 4]);
	});

	it("treats a non-positive limit as 1", async () => {
		let active = 0;
		let peak = 0;
		await mapWithConcurrency([1, 2, 3], 0, async () => {
			active++;
			peak = Math.max(peak, active);
			await delay(1);
			active--;
		});
		expect(peak).toBe(1);
	});

	it("rejects when a call rejects", async () => {
		await expect(
			mapWithConcurrency([1, 2, 3], 2, async (x) => {
				if (x === 2) throw new Error("boom");
				return x;
			}),
		).rejects.toThrow("boom");
	});
});
