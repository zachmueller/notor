import { describe, it, expect } from "vitest";
import { paramSchemaToJsonSchema, extractPathParams } from "../param-schema";
import { extractYamlFence } from "../parser";
import { REPLACE_IN_NOTE } from "../builtin-tool-scaffolds/replace-in-note";
import { REPLACE_IN_FILE } from "../builtin-tool-scaffolds/replace-in-file";
import type { ParamSchema } from "../types";

// ---------------------------------------------------------------------------
// paramSchemaToJsonSchema
// ---------------------------------------------------------------------------

describe("paramSchemaToJsonSchema", () => {
	it("converts string type correctly", () => {
		const params: ParamSchema = {
			query: { type: "string", description: "Search query" },
		};
		const schema = paramSchemaToJsonSchema(params);

		expect(schema.type).toBe("object");
		expect(schema.properties?.query).toEqual({
			type: "string",
			description: "Search query",
		});
		expect(schema.required).toEqual(["query"]);
	});

	it("converts number type correctly", () => {
		const params: ParamSchema = {
			count: { type: "number", description: "Number of results" },
		};
		const schema = paramSchemaToJsonSchema(params);

		expect(schema.properties?.count).toEqual({
			type: "number",
			description: "Number of results",
		});
	});

	it("converts boolean type correctly", () => {
		const params: ParamSchema = {
			verbose: { type: "boolean" },
		};
		const schema = paramSchemaToJsonSchema(params);

		expect(schema.properties?.verbose).toEqual({
			type: "boolean",
		});
	});

	it("converts string[] to array schema", () => {
		const params: ParamSchema = {
			tags: { type: "string[]", description: "Tags to filter" },
		};
		const schema = paramSchemaToJsonSchema(params);

		expect(schema.properties?.tags).toEqual({
			type: "array",
			items: { type: "string" },
			description: "Tags to filter",
		});
	});

	it("converts object[] to array of objects schema", () => {
		const params: ParamSchema = {
			changes: {
				type: "object[]",
				description: "Array of find/replace edits",
				properties: {
					old_text: { type: "string", description: "Text to find" },
					new_text: { type: "string", description: "Replacement text" },
				},
				required_items: ["old_text", "new_text"],
			},
		};
		const schema = paramSchemaToJsonSchema(params);

		expect(schema.properties?.changes).toEqual({
			type: "array",
			description: "Array of find/replace edits",
			items: {
				type: "object",
				properties: {
					old_text: { type: "string", description: "Text to find" },
					new_text: { type: "string", description: "Replacement text" },
				},
				required: ["old_text", "new_text"],
			},
		});
		expect(schema.required).toEqual(["changes"]);
	});

	it("converts object[] without required_items", () => {
		const params: ParamSchema = {
			entries: {
				type: "object[]",
				properties: {
					key: { type: "string" },
					value: { type: "string" },
				},
			},
		};
		const schema = paramSchemaToJsonSchema(params);

		expect(schema.properties?.entries?.items).toEqual({
			type: "object",
			properties: {
				key: { type: "string" },
				value: { type: "string" },
			},
		});
		// No required on items when required_items is omitted
		expect(schema.properties?.entries?.items?.required).toBeUndefined();
	});

	it("params without default are in required[]", () => {
		const params: ParamSchema = {
			required_param: { type: "string" },
			optional_param: { type: "string", default: "fallback" },
		};
		const schema = paramSchemaToJsonSchema(params);

		expect(schema.required).toEqual(["required_param"]);
	});

	it("params with default are NOT in required[]", () => {
		const params: ParamSchema = {
			opt: { type: "boolean", default: false },
		};
		const schema = paramSchemaToJsonSchema(params);

		// No required array or empty
		expect(schema.required).toBeUndefined();
	});

	it("passes through default value", () => {
		const params: ParamSchema = {
			limit: { type: "number", default: 10 },
		};
		const schema = paramSchemaToJsonSchema(params);

		expect(schema.properties?.limit?.default).toBe(10);
	});

	it("maps enum field to JSON Schema enum", () => {
		const params: ParamSchema = {
			format: { type: "string", enum: ["json", "csv", "xml"] },
		};
		const schema = paramSchemaToJsonSchema(params);

		expect(schema.properties?.format?.enum).toEqual(["json", "csv", "xml"]);
	});

	it("passes through description correctly", () => {
		const params: ParamSchema = {
			path: { type: "string", description: "Path to the note" },
		};
		const schema = paramSchemaToJsonSchema(params);

		expect(schema.properties?.path?.description).toBe("Path to the note");
	});

	it("strips path_namespace from JSON Schema output", () => {
		const params: ParamSchema = {
			path: { type: "string", path_namespace: "vault", description: "Note path" },
		};
		const schema = paramSchemaToJsonSchema(params);

		// path_namespace should not appear in the schema
		expect(schema.properties?.path).toEqual({
			type: "string",
			description: "Note path",
		});
		expect((schema.properties?.path as Record<string, unknown>).path_namespace).toBeUndefined();
	});

	it("produces valid empty schema for empty params", () => {
		const params: ParamSchema = {};
		const schema = paramSchemaToJsonSchema(params);

		expect(schema.type).toBe("object");
		expect(schema.properties).toEqual({});
		expect(schema.required).toBeUndefined();
	});

	it("handles multiple params with mixed required/optional", () => {
		const params: ParamSchema = {
			path: { type: "string" },
			format: { type: "string", default: "md" },
			depth: { type: "number" },
		};
		const schema = paramSchemaToJsonSchema(params);

		expect(schema.required).toEqual(["path", "depth"]);
		expect(Object.keys(schema.properties!)).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// Hidden-from-LLM guard: the replace_in_* scaffolds expose only old_text/
// new_text to the model. The YAML fence is the SOLE source of the LLM-facing
// schema (paramSchemaToJsonSchema reads nothing else — see the converter tests
// above, which prove keys are copied verbatim). So asserting on the fence text
// transitively guarantees the legacy search/replace aliases never reach the model.
// ---------------------------------------------------------------------------

describe("replace_in_* scaffolds — change-block schema is canonical only", () => {
	for (const { label, scaffold } of [
		{ label: "replace_in_note", scaffold: REPLACE_IN_NOTE },
		{ label: "replace_in_file", scaffold: REPLACE_IN_FILE },
	]) {
		const yamlFence = extractYamlFence(scaffold.scaffoldContent);

		it(`${label}: YAML fence exists`, () => {
			expect(yamlFence).not.toBeNull();
		});

		it(`${label}: exposes old_text/new_text and required_items, never search/replace`, () => {
			const yaml = yamlFence!;
			// Canonical property keys + required_items are present.
			expect(yaml).toContain("old_text:");
			expect(yaml).toContain("new_text:");
			expect(yaml).toMatch(/required_items:\s*\n\s*-\s*old_text\s*\n\s*-\s*new_text/);
			// Legacy aliases must NOT appear anywhere the model can see.
			expect(yaml).not.toMatch(/\bsearch:/);
			expect(yaml).not.toMatch(/\breplace:/);
			expect(yaml.toLowerCase()).not.toContain("search/replace");
		});
	}
});

// ---------------------------------------------------------------------------
// extractPathParams
// ---------------------------------------------------------------------------

describe("extractPathParams", () => {
	it("extracts entries with path_namespace correctly", () => {
		const params: ParamSchema = {
			path: { type: "string", path_namespace: "vault" },
			output: { type: "string", path_namespace: "filesystem" },
			query: { type: "string" },
		};
		const result = extractPathParams("my_tool", params);

		expect(result).toHaveLength(2);
		expect(result).toContainEqual({ paramName: "path", namespace: "vault" });
		expect(result).toContainEqual({ paramName: "output", namespace: "filesystem" });
	});

	it("returns empty array when no path params", () => {
		const params: ParamSchema = {
			query: { type: "string" },
			limit: { type: "number" },
		};
		const result = extractPathParams("my_tool", params);

		expect(result).toEqual([]);
	});

	it("returns empty array for empty params", () => {
		expect(extractPathParams("my_tool", {})).toEqual([]);
	});

	it("maps path_namespace to namespace (drops path_ prefix)", () => {
		const params: ParamSchema = {
			notePath: { type: "string", path_namespace: "vault" },
		};
		const result = extractPathParams("tool", params);

		expect(result[0].namespace).toBe("vault");
		// Verify paramName is the key
		expect(result[0].paramName).toBe("notePath");
	});
});
