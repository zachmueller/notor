/**
 * Parameter schema conversion for user-defined tools.
 *
 * Converts simplified YAML param schemas into JSON Schema for LLM tool
 * definitions, and extracts path parameter descriptors for path enforcement.
 */

import type { JSONSchema, JSONSchemaProperty } from "../tools/tool";
import type { ToolPathParam } from "../tool-config/types";
import type { ParamSchema } from "./types";

/**
 * Convert a simplified YAML param schema to JSON Schema for LLM tool definitions.
 *
 * Conversion rules:
 * - Each param key becomes a `properties` entry
 * - Params without `default` are added to `required[]`
 * - `type: "string[]"` maps to `{ type: "array", items: { type: "string" } }`
 * - `enum` field maps to JSON Schema `enum`
 * - `description` and `default` are passed through
 * - `path_namespace` is stripped (consumed by runtime, not sent to LLM)
 */
export function paramSchemaToJsonSchema(params: ParamSchema): JSONSchema {
	const properties: Record<string, JSONSchemaProperty> = {};
	const required: string[] = [];

	for (const [key, param] of Object.entries(params)) {
		const prop: JSONSchemaProperty = {};

		// Map type
		if (param.type === "string[]") {
			prop.type = "array";
			prop.items = { type: "string" };
		} else {
			prop.type = param.type;
		}

		// Pass through description
		if (param.description !== undefined) {
			prop.description = param.description;
		}

		// Pass through default
		if (param.default !== undefined) {
			prop.default = param.default;
		}

		// Map enum
		if (param.enum !== undefined) {
			prop.enum = param.enum;
		}

		// path_namespace is intentionally NOT included — consumed by runtime only

		properties[key] = prop;

		// Params without default are required
		if (param.default === undefined) {
			required.push(key);
		}
	}

	const schema: JSONSchema = {
		type: "object",
		properties,
	};

	if (required.length > 0) {
		schema.required = required;
	}

	return schema;
}

/**
 * Extract path parameter descriptors from params that have `path_namespace`.
 *
 * These are registered in `TOOL_PATH_PARAMS` so `enforcePathConstraints()`
 * applies at dispatch time.
 *
 * Note: The YAML field `path_namespace` maps to `ToolPathParam.namespace`
 * (the `path_` prefix is dropped).
 */
export function extractPathParams(toolName: string, params: ParamSchema): ToolPathParam[] {
	const pathParams: ToolPathParam[] = [];

	for (const [key, param] of Object.entries(params)) {
		if (param.path_namespace) {
			pathParams.push({
				paramName: key,
				namespace: param.path_namespace,
			});
		}
	}

	return pathParams;
}
