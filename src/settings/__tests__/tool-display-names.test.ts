import { describe, it, expect } from "vitest";
import { BUILTIN_TOOL_SCAFFOLDS } from "../../extensions/builtin-tool-scaffolds";
import { TOOL_DISPLAY_NAMES, defaultAutoApproveFor } from "../constants";
import { DEFAULT_AUTO_APPROVE } from "../defaults";

/**
 * Built-in scaffolds with no settings row. ask_user is inherently interactive
 * (the user is already being prompted), so it has nothing to toggle; it is
 * auto-approved through DEFAULT_AUTO_APPROVE.
 */
const DISPLAY_EXEMPT = ["ask_user"];

describe("TOOL_DISPLAY_NAMES ↔ built-in scaffolds", () => {
	it("every built-in scaffold has a settings row unless explicitly exempt", () => {
		const missing = [...BUILTIN_TOOL_SCAFFOLDS.keys()].filter((k) => !(k in TOOL_DISPLAY_NAMES)).sort();
		expect(missing).toEqual(DISPLAY_EXEMPT);
	});

	for (const [name, scaffold] of BUILTIN_TOOL_SCAFFOLDS) {
		it(`${name}: default auto-approve follows its declared mode (${scaffold.mode})`, () => {
			expect(defaultAutoApproveFor(name)).toBe(scaffold.mode === "read");
		});

		const meta = TOOL_DISPLAY_NAMES[name];
		if (meta) {
			it(`${name}: isWrite matches its declared mode`, () => {
				expect(meta.isWrite).toBe(scaffold.mode === "write");
			});
		}
	}
});

describe("DEFAULT_AUTO_APPROVE", () => {
	it("only names known tools (a typo key would silently no-op)", () => {
		const unknown = Object.keys(DEFAULT_AUTO_APPROVE).filter(
			(k) => !(k in TOOL_DISPLAY_NAMES) && !BUILTIN_TOOL_SCAFFOLDS.has(k),
		);
		expect(unknown).toEqual([]);
	});

	it("auto-approves the circuit task tools so unattended Act-mode circuits never stall", () => {
		expect(DEFAULT_AUTO_APPROVE.circuit_task_ensure).toBe(true);
		expect(DEFAULT_AUTO_APPROVE.circuit_task_start).toBe(true);
		expect(DEFAULT_AUTO_APPROVE.circuit_task_close).toBe(true);
	});

	it("does not seed read-mode circuit tools (their default comes from defaultAutoApproveFor)", () => {
		expect("emit_event" in DEFAULT_AUTO_APPROVE).toBe(false);
		expect("submit_score" in DEFAULT_AUTO_APPROVE).toBe(false);
		expect("circuit_task_list" in DEFAULT_AUTO_APPROVE).toBe(false);
	});
});
