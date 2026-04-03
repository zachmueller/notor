import { describe, it, expect } from "vitest";
import {
	filterSubAgentTools,
	SUBAGENT_EXCLUDED_TOOLS,
	USE_SUBAGENT_TOOL_NAME,
} from "./constants";

describe("filterSubAgentTools", () => {
	it("removes use_subagent from tool list", () => {
		const tools = [
			{ name: "read_note" },
			{ name: "use_subagent" },
			{ name: "search_vault" },
		];

		const filtered = filterSubAgentTools(tools);

		expect(filtered.map((t) => t.name)).toEqual(["read_note", "search_vault"]);
	});

	it("returns all tools when use_subagent is not present", () => {
		const tools = [{ name: "read_note" }, { name: "write_note" }];

		const filtered = filterSubAgentTools(tools);

		expect(filtered).toEqual(tools);
	});

	it("returns empty array for empty input", () => {
		expect(filterSubAgentTools([])).toEqual([]);
	});

	it("preserves additional properties on tool objects", () => {
		const tools = [
			{ name: "read_note", description: "Reads a note", mode: "read" as const },
			{ name: "use_subagent", description: "Sub-agent", mode: "read" as const },
		];

		const filtered = filterSubAgentTools(tools);

		expect(filtered).toEqual([
			{ name: "read_note", description: "Reads a note", mode: "read" },
		]);
	});
});

describe("SUBAGENT_EXCLUDED_TOOLS", () => {
	it("contains use_subagent", () => {
		expect(SUBAGENT_EXCLUDED_TOOLS.has(USE_SUBAGENT_TOOL_NAME)).toBe(true);
	});
});
