import { describe, it, expect } from "vitest";
import { LEGACY_TOOL_NAMES, canonicalToolName, legacyToolNamesFor } from "./tool-aliases";

describe("tool-aliases", () => {
	it("maps every legacy circuit tool name to its canonical name", () => {
		expect(canonicalToolName("run_flow")).toBe("run_circuit");
		for (const verb of ["ensure", "start", "close", "list"]) {
			expect(canonicalToolName(`orchestration_task_${verb}`)).toBe(`circuit_task_${verb}`);
		}
	});

	it("is the identity for canonical and unrelated names", () => {
		for (const name of ["run_circuit", "circuit_task_list", "emit_event", "invoke_workflow", "read_note", "toString", "__proto__"]) {
			expect(canonicalToolName(name)).toBe(name);
		}
	});

	it("legacyToolNamesFor inverts the table", () => {
		expect(legacyToolNamesFor("run_circuit")).toEqual(["run_flow"]);
		expect(legacyToolNamesFor("read_note")).toEqual([]);
		expect(Object.keys(LEGACY_TOOL_NAMES)).toHaveLength(5);
	});
});
