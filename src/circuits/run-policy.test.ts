import { describe, it, expect, vi } from "vitest";
import { CircuitRunRegistry } from "./run-registry";
import { resolveRunPolicy, type CircuitRunPolicy } from "./run-policy";
import type { CircuitHost } from "./host";

function host(over: Partial<CircuitHost> = {}): CircuitHost {
	const registry = new CircuitRunRegistry();
	return {
		settings: { mode: "plan" },
		getCircuitRunRegistry: () => registry,
		...over,
	} as unknown as CircuitHost;
}

describe("resolveRunPolicy", () => {
	it("builds a default from the host's mode and approval channel", () => {
		const callback = vi.fn();
		const hook = vi.fn();
		const getRunApproval = vi.fn(() => ({ callback, hook }));
		const policy = resolveRunPolicy(host({ getRunApproval }), "Wrap-up", {});

		expect(getRunApproval).toHaveBeenCalledWith("Circuit 'Wrap-up'");
		expect(policy).toEqual({ mode: "plan", approvalCallback: callback, approvalHook: hook });
	});

	it("leaves approval unset for hosts with no channel", () => {
		expect(resolveRunPolicy(host(), "F", { mode: "act" })).toEqual({
			mode: "act",
			approvalCallback: undefined,
			approvalHook: undefined,
		});
	});

	it("inherits a live parent's policy, with an explicit mode overriding it", () => {
		const h = host({ getRunApproval: vi.fn() });
		const parent: CircuitRunPolicy = { mode: "act", approvalCallback: vi.fn() };
		h.getCircuitRunRegistry().setPolicy("sess-parent", parent);

		expect(resolveRunPolicy(h, "Child", { parentSessionId: "sess-parent" })).toBe(parent);
		expect(resolveRunPolicy(h, "Child", { parentSessionId: "sess-parent", mode: "plan" })).toEqual({
			...parent,
			mode: "plan",
		});
		expect(h.getRunApproval).not.toHaveBeenCalled();
	});

	it("prefers an explicit policy", () => {
		const explicit: CircuitRunPolicy = { mode: "act" };
		expect(resolveRunPolicy(host(), "F", { policy: explicit, mode: "plan" })).toBe(explicit);
	});
});

describe("CircuitRunRegistry policies", () => {
	it("sets, gets, and clears a session policy", () => {
		const reg = new CircuitRunRegistry();
		const policy: CircuitRunPolicy = { mode: "plan" };
		reg.setPolicy("s1", policy);
		expect(reg.getPolicy("s1")).toBe(policy);
		reg.clearPolicy("s1");
		expect(reg.getPolicy("s1")).toBeUndefined();
	});
});
