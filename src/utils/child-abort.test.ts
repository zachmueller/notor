import { describe, it, expect } from "vitest";
import { openChildAbort } from "./child-abort";

describe("openChildAbort", () => {
	it("close() aborts the child without aborting the parent", () => {
		const parent = new AbortController();
		const child = openChildAbort(parent.signal);
		child.close();
		expect(child.signal.aborted).toBe(true);
		expect(parent.signal.aborted).toBe(false);
	});

	it("a parent abort cascades to the child", () => {
		const parent = new AbortController();
		const child = openChildAbort(parent.signal);
		parent.abort();
		expect(child.signal.aborted).toBe(true);
	});

	it("starts aborted when the parent already is", () => {
		const parent = new AbortController();
		parent.abort();
		expect(openChildAbort(parent.signal).signal.aborted).toBe(true);
	});
});
