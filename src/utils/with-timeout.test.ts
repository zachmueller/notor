import { describe, it, expect } from "vitest";
import { withTimeout, ExtensionTimeoutError } from "./with-timeout";

describe("withTimeout", () => {
	it("passes a fast resolution through unchanged", async () => {
		const value = await withTimeout(async () => ({ ok: true, n: 42 }), 1000);
		expect(value).toEqual({ ok: true, n: 42 });
	});

	it("rejects with ExtensionTimeoutError when the invocation exceeds the timeout at an await boundary", async () => {
		// Awaits a longer timer than the guard; the guard wins on the next macrotask.
		const slow = () => new Promise((r) => setTimeout(r, 5000));
		await expect(withTimeout(slow, 1)).rejects.toBeInstanceOf(ExtensionTimeoutError);
	});

	it("propagates the invocation's own rejection when it fails before the timeout", async () => {
		const boom = () => Promise.reject(new Error("boom"));
		await expect(withTimeout(boom, 1000)).rejects.toThrow("boom");
	});

	it("surfaces a synchronous throw inside invoke as a rejection", async () => {
		const throws = () => {
			throw new Error("sync boom");
		};
		await expect(withTimeout(throws as () => Promise<never>, 1000)).rejects.toThrow("sync boom");
	});

	it("ExtensionTimeoutError message carries the await-boundary caveat", () => {
		const err = new ExtensionTimeoutError(300_000);
		expect(err.name).toBe("ExtensionTimeoutError");
		expect(err.message).toMatch(/await boundary/i);
		expect(err.message).toContain("300s");
	});
});
