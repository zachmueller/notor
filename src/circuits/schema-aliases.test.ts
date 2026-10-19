import { describe, it, expect } from "vitest";
import {
	CIRCUIT_KEY_ALIASES,
	CIRCUIT_ROOT_DIR_NAMES,
	isCircuitDefinitionType,
	isCircuitEvaluatorType,
	isCircuitStepType,
	readAliasedKey,
} from "./schema-aliases";

describe("schema-aliases", () => {
	it("scans circuits/ before the legacy orchestrations/ root", () => {
		expect(CIRCUIT_ROOT_DIR_NAMES).toEqual(["circuits", "orchestrations"]);
	});

	it("accepts both definition discriminators and nothing else", () => {
		expect(isCircuitDefinitionType("circuit")).toBe(true);
		expect(isCircuitDefinitionType("orchestration-flow")).toBe(true);
		expect(isCircuitDefinitionType("orchestration-step")).toBe(false);
		expect(isCircuitDefinitionType(undefined)).toBe(false);
	});

	it("accepts both step discriminators and nothing else", () => {
		expect(isCircuitStepType("circuit-step")).toBe(true);
		expect(isCircuitStepType("orchestration-step")).toBe(true);
		expect(isCircuitStepType("circuit")).toBe(false);
	});

	it("accepts only the circuit-evaluator discriminator (no legacy spelling)", () => {
		expect(isCircuitEvaluatorType("circuit-evaluator")).toBe(true);
		expect(isCircuitEvaluatorType("orchestration-evaluator")).toBe(false);
		expect(isCircuitEvaluatorType("circuit-step")).toBe(false);
		expect(isCircuitEvaluatorType(undefined)).toBe(false);
	});

	it("every alias pair maps a notor-*circuit* key to its notor-*flow* legacy key", () => {
		for (const [newKey, legacyKey] of Object.values(CIRCUIT_KEY_ALIASES)) {
			expect(newKey).toMatch(/circuit/);
			expect(legacyKey).toBe(newKey.replace("circuit", "flow"));
		}
	});

	it("readAliasedKey prefers the new key, falls back to legacy, and treats false/null as present", () => {
		expect(readAliasedKey({ "notor-flow-name": "Old" }, "name")).toBe("Old");
		expect(readAliasedKey({ "notor-circuit-name": "New", "notor-flow-name": "Old" }, "name")).toBe("New");
		expect(readAliasedKey({ "notor-circuit-invocable": false, "notor-flow-invocable": true }, "invocable")).toBe(false);
		expect(readAliasedKey({ "notor-circuit-inputs": null, "notor-flow-inputs": "x" }, "inputs")).toBeNull();
		expect(readAliasedKey({}, "name")).toBeUndefined();
	});
});
