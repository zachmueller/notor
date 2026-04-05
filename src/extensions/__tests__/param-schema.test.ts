import { describe, it, expect } from "vitest";
import { paramSchemaToJsonSchema, extractPathParams } from "../param-schema";
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
