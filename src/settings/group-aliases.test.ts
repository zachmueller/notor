import { describe, it, expect } from "vitest";
import { canonicalSettingsGroup } from "./group-aliases";

describe("settings group aliases", () => {
	it("resolves the renamed Orchestration group to Circuits", () => {
		expect(canonicalSettingsGroup("Orchestration")).toBe("Circuits");
	});

	it("leaves current titles untouched", () => {
		for (const t of ["Circuits", "General", "Tools", "constructor"]) expect(canonicalSettingsGroup(t)).toBe(t);
	});
});
