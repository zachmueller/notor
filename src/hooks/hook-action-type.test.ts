import { describe, it, expect } from "vitest";
import { canonicalHookActionType, hookCircuitRef, isRunCircuitAction } from "./hook-action-type";

describe("hook action-type aliases", () => {
	it("treats run_circuit and legacy run_orchestration as the same action", () => {
		expect(isRunCircuitAction("run_circuit")).toBe(true);
		expect(isRunCircuitAction("run_orchestration")).toBe(true);
		expect(isRunCircuitAction("run_workflow")).toBe(false);
		expect(isRunCircuitAction(undefined)).toBe(false);
	});

	it("canonicalizes stored values", () => {
		expect(canonicalHookActionType("run_orchestration")).toBe("run_circuit");
		expect(canonicalHookActionType("run_circuit")).toBe("run_circuit");
		expect(canonicalHookActionType("run_workflow")).toBe("run_workflow");
		expect(canonicalHookActionType(undefined)).toBe("execute_command");
	});

	it("reads the circuit target, falling back to the legacy field", () => {
		expect(hookCircuitRef({ circuit: "Review" })).toBe("Review");
		expect(hookCircuitRef({ orchestration_flow: "notor/orchestrations/review" })).toBe("notor/orchestrations/review");
		expect(hookCircuitRef({ circuit: "New", orchestration_flow: "Old" })).toBe("New");
		expect(hookCircuitRef({})).toBeNull();
	});
});
