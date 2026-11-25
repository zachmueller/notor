import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MAX_ENTRIES,
	getStartupTimings,
	markStartup,
	resetStartupTimings,
	startSpan,
	summarizeStartupTimings,
	timePromise,
	timeSync,
} from "./startup-timing";

describe("startup-timing", () => {
	beforeEach(() => {
		resetStartupTimings();
		performance.mark("unrelated-mark");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetStartupTimings();
		performance.clearMarks("unrelated-mark");
	});

	it("records prefixed marks and ignores other entries", () => {
		markStartup("layoutReady", { leaves: 3 });
		const entries = getStartupTimings();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ name: "layoutReady", kind: "mark", detail: { leaves: 3 } });
	});

	it("records a span as a measure with merged detail", () => {
		const end = startSpan("history.list", { source: "restore" });
		end({ files: 12 });
		const [m] = getStartupTimings();
		expect(m).toMatchObject({ name: "history.list", kind: "measure", detail: { source: "restore", files: 12 } });
		expect(m!.duration).toBeGreaterThanOrEqual(0);
	});

	it("ends a span only once", () => {
		const end = startSpan("once");
		end();
		end();
		expect(getStartupTimings().filter((e) => e.name === "once")).toHaveLength(1);
	});

	it("measures overlapping spans with the same name independently", () => {
		const a = startSpan("overlap");
		const b = startSpan("overlap");
		b();
		a();
		expect(getStartupTimings().filter((e) => e.name === "overlap")).toHaveLength(2);
	});

	it("timeSync ends the span when the block throws", () => {
		expect(() => timeSync("boom", () => { throw new Error("x"); })).toThrow("x");
		expect(getStartupTimings().map((e) => e.name)).toContain("boom");
	});

	it("timePromise passes values through and flags rejections", async () => {
		await expect(timePromise("ok", Promise.resolve(42))).resolves.toBe(42);
		await expect(timePromise("bad", Promise.reject(new Error("nope")))).rejects.toThrow("nope");
		const bad = getStartupTimings().find((e) => e.name === "bad");
		expect(bad?.detail).toEqual({ error: true });
	});

	it("summarizes measures by name and marks by start time", () => {
		startSpan("repeat")();
		startSpan("repeat")();
		markStartup("ready");
		const s = summarizeStartupTimings();
		expect(s.measures.repeat).toHaveLength(2);
		expect(typeof s.marks.ready).toBe("number");
	});

	it("stops recording after MAX_ENTRIES and reset re-enables it", () => {
		for (let i = 0; i < MAX_ENTRIES + 5; i++) markStartup("flood");
		expect(getStartupTimings()).toHaveLength(MAX_ENTRIES);
		resetStartupTimings();
		expect(getStartupTimings()).toHaveLength(0);
		markStartup("after-reset");
		expect(getStartupTimings()).toHaveLength(1);
	});

	it("never throws when the timing API throws", () => {
		vi.spyOn(performance, "mark").mockImplementation(() => { throw new Error("mark failed"); });
		vi.spyOn(performance, "measure").mockImplementation(() => { throw new Error("measure failed"); });
		expect(() => markStartup("x")).not.toThrow();
		expect(() => startSpan("y")()).not.toThrow();
	});
});
