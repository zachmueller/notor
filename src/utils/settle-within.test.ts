// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleWithin } from "./settle-within";

describe("settleWithin", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("resolves immediately for no promises", async () => {
		await expect(settleWithin([], 1000)).resolves.toBe("settled");
	});

	it("resolves when all promises settle, including rejections", async () => {
		const p = settleWithin([Promise.resolve(1), Promise.reject(new Error("x"))], 1000);
		await expect(p).resolves.toBe("settled");
	});

	it("gives up after the cap when a promise never settles", async () => {
		const p = settleWithin([new Promise(() => undefined)], 2000);
		await vi.advanceTimersByTimeAsync(2000);
		await expect(p).resolves.toBe("timeout");
	});
});
