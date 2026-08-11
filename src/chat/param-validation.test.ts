import { describe, it, expect } from "vitest";
import { validateRequiredParams } from "./param-validation";
import type { JSONSchema } from "../tools/tool";

function schema(required: unknown): JSONSchema {
	return { type: "object", properties: {}, required } as unknown as JSONSchema;
}

describe("validateRequiredParams — missing detection", () => {
	it("reports an absent key", () => {
		expect(validateRequiredParams(schema(["path", "content"]), { content: "x" }))
			.toEqual({ missing: ["path"] });
	});

	it("reports an explicit undefined", () => {
		expect(validateRequiredParams(schema(["path"]), { path: undefined }))
			.toEqual({ missing: ["path"] });
	});

	it("reports an explicit null", () => {
		expect(validateRequiredParams(schema(["path"]), { path: null }))
			.toEqual({ missing: ["path"] });
	});

	it("reports every missing name, in schema order", () => {
		expect(validateRequiredParams(schema(["path", "changes", "mode"]), {}))
			.toEqual({ missing: ["path", "changes", "mode"] });
	});

	it("reports nothing when all required params are present", () => {
		expect(validateRequiredParams(schema(["path", "content"]), { path: "a.md", content: "hi" }))
			.toEqual({ missing: [] });
	});
});

describe("validateRequiredParams — falsy-but-present values", () => {
	// Presence, never emptiness: write_note deliberately accepts content: "" to
	// create an empty note, so folding blank strings into "missing" would break it.
	it.each([
		["empty string", ""],
		["whitespace-only string", "   "],
		["zero", 0],
		["false", false],
		["empty array", []],
		["empty object", {}],
		["NaN", Number.NaN],
	])("treats %s as present", (_label, value) => {
		expect(validateRequiredParams(schema(["value"]), { value })).toEqual({ missing: [] });
	});
});

describe("validateRequiredParams — untrusted / absent schemas", () => {
	it("no schema at all → nothing missing", () => {
		expect(validateRequiredParams(undefined, {})).toEqual({ missing: [] });
	});

	it("the MCP `{ type: 'object' }` fallback → nothing missing", () => {
		expect(validateRequiredParams({ type: "object" }, {})).toEqual({ missing: [] });
	});

	it("empty required array → nothing missing", () => {
		expect(validateRequiredParams(schema([]), {})).toEqual({ missing: [] });
	});

	it.each([
		["a string", "path"],
		["an object", { path: true }],
		["null", null],
		["a number", 3],
	])("malformed required (%s) → nothing missing, never throws", (_label, required) => {
		expect(validateRequiredParams(schema(required), {})).toEqual({ missing: [] });
	});

	it("skips non-string entries inside required", () => {
		expect(validateRequiredParams(schema([42, "path", null]), {}))
			.toEqual({ missing: ["path"] });
	});
});

describe("validateRequiredParams — presence only, top level only", () => {
	it("ignores declared types entirely (a wrong-typed value is present)", () => {
		expect(validateRequiredParams(
			{ type: "object", properties: { changes: { type: "array" } }, required: ["changes"] },
			{ changes: "not an array" },
		)).toEqual({ missing: [] });
	});

	it("ignores nested required inside array item schemas", () => {
		// replace_in_note.changes[].old_text is the scaffold's own guard, not ours.
		const nested: JSONSchema = {
			type: "object",
			properties: {
				changes: { type: "array", items: { type: "object", required: ["old_text", "new_text"] } },
			},
			required: ["changes"],
		};
		expect(validateRequiredParams(nested, { changes: [{}] })).toEqual({ missing: [] });
	});
});
