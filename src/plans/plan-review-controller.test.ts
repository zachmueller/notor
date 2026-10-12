import { describe, it, expect, vi } from "vitest";
import { PlanReviewController, type PlanReviewOutcome } from "./plan-review-controller";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

describe("PlanReviewController", () => {
	it("resolves a registered review once and clears it", () => {
		const c = new PlanReviewController();
		const settled: PlanReviewOutcome[] = [];
		c.register("conv", (o) => settled.push(o));
		expect(c.hasPending("conv")).toBe(true);
		expect(c.resolve("conv", { kind: "approve" })).toBe(true);
		expect(c.hasPending("conv")).toBe(false);
		expect(c.resolve("conv", { kind: "reject" })).toBe(false);
		expect(settled).toEqual([{ kind: "approve" }]);
	});

	it("a stale unregister does not remove a newer registration", () => {
		const c = new PlanReviewController();
		const first = vi.fn();
		const second = vi.fn();
		const unregisterFirst = c.register("conv", first);
		c.register("conv", second); // re-render after a view switch
		unregisterFirst(); // original prompt's cleanup runs late
		expect(c.hasPending("conv")).toBe(true);
		c.resolve("conv", { kind: "request-changes", feedback: "x" });
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledWith({ kind: "request-changes", feedback: "x" });
	});

	it("clear drops a pending review without settling", () => {
		const c = new PlanReviewController();
		const settle = vi.fn();
		c.register("conv", settle);
		c.clear("conv");
		expect(c.hasPending("conv")).toBe(false);
		expect(settle).not.toHaveBeenCalled();
	});

	it("notifies listeners on register, resolve, unregister and clear", () => {
		const c = new PlanReviewController();
		const seen: string[] = [];
		const off = c.onChange((id) => seen.push(id));
		const un = c.register("a", () => {});
		un();
		c.register("b", () => {});
		c.resolve("b", { kind: "approve" });
		c.register("c", () => {});
		c.clear("c");
		off();
		c.register("d", () => {});
		expect(seen).toEqual(["a", "a", "b", "b", "c", "c"]);
	});

	it("keeps conversations independent", () => {
		const c = new PlanReviewController();
		const a = vi.fn();
		const b = vi.fn();
		c.register("a", a);
		c.register("b", b);
		c.resolve("a", { kind: "approve-auto-accept" });
		expect(a).toHaveBeenCalled();
		expect(b).not.toHaveBeenCalled();
		expect(c.hasPending("b")).toBe(true);
	});
});
