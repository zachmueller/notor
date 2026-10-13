import { describe, it, expect } from "vitest";
import { filterToolsForMode } from "./config-resolver";
import type { ToolDefinition } from "../providers/provider";

const defs = ["read_note", "submit_plan", "write_note"].map(
	(name): ToolDefinition => ({ name, description: name, input_schema: { type: "object", properties: {} } }),
);

describe("filterToolsForMode", () => {
	it("drops submit_plan in Act mode", () => {
		expect(filterToolsForMode(defs, "act").map((t) => t.name)).toEqual(["read_note", "write_note"]);
	});

	it("keeps submit_plan in Plan mode", () => {
		expect(filterToolsForMode(defs, "plan").map((t) => t.name)).toEqual(["read_note", "submit_plan", "write_note"]);
	});

	it("leaves the list untouched when no mode is given", () => {
		expect(filterToolsForMode(defs)).toBe(defs);
	});
});
