/**
 * Parameter schema conversion for user-defined tools.
 *
 * Converts simplified YAML param schemas into JSON Schema for LLM tool
 * definitions, and extracts path parameter descriptors for path enforcement.
 */

import type { JSONSchema, JSONSchemaProperty } from "../tools/tool";
import type { PathAccess, ToolPathParam } from "../tool-config/types";
import type { ParamSchema } from "./types";
import { logger } from "../utils/logger";

const log = logger("param-schema");

/**
 * Convert a simplified YAML param schema to JSON Schema for LLM tool definitions.
 *
 * Conversion rules:
 * - Each param key becomes a `properties` entry
 * - Params without `default` are added to `required[]`, unless they declare
 *   `optional: true` (for conditionally-required params that have no meaningful
 *   fallback value, e.g. `webview.url`)
 * - `type: "string[]"` maps to `{ type: "array", items: { type: "string" } }`
 * - `type: "object[]"` maps to `{ type: "array", items: { type: "object", properties, required } }`
 *   using `properties` and `required_items` from the param definition
 * - `enum` field maps to JSON Schema `enum`
 * - `description` and `default` are passed through
 * - `path_namespace`, `properties`, `required_items` are stripped (consumed by runtime/converter, not sent raw to LLM)
 */
export function paramSchemaToJsonSchema(params: ParamSchema): JSONSchema {
	const properties: Record<string, JSONSchemaProperty> = {};
	const required: string[] = [];

	for (const [key, param] of Object.entries(params)) {
		const prop: JSONSchemaProperty = {};

		// Map type
		if (param.type === "object[]") {
			prop.type = "array";
			const itemSchema: JSONSchemaProperty = { type: "object" };
			if (param.properties) {
				const itemProps: Record<string, JSONSchemaProperty> = {};
				for (const [propKey, propDef] of Object.entries(param.properties)) {
					const p: JSONSchemaProperty = { type: propDef.type };
					if (propDef.description !== undefined) p.description = propDef.description;
					itemProps[propKey] = p;
				}
				itemSchema.properties = itemProps;
			}
			if (param.required_items && param.required_items.length > 0) {
				itemSchema.required = param.required_items;
			}
			prop.items = itemSchema;
		} else if (param.type === "string[]") {
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

		// path_namespace / optional are intentionally NOT included — consumed by
		// the runtime and this converter respectively, never sent to the LLM

		properties[key] = prop;

		// Params without a default are required, unless explicitly opted out.
		// `optional: true` exists for conditionally-required params where no single
		// default is meaningful — without it, dispatch-time validation would
		// auto-fail legitimate calls that omit them.
		if (param.default === undefined && param.optional !== true) {
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
 *
 * @param toolMode - The tool's declared `notor-mode`, used as the default
 *   direction for params that omit `path_access`. Only tools whose params
 *   straddle the read/write boundary need to declare it explicitly.
 */
export function extractPathParams(
	toolName: string,
	params: ParamSchema,
	toolMode: PathAccess = "write",
): ToolPathParam[] {
	const pathParams: ToolPathParam[] = [];

	for (const [key, param] of Object.entries(params)) {
		if (param.path_namespace) {
			pathParams.push({
				paramName: key,
				namespace: param.path_namespace,
				resolveAs: param.path_resolve_as,
				access: param.path_access ?? toolMode,
			});
		}
	}

	// A tool spanning both namespaces almost certainly spans both directions too
	// (read a file, write a note). Without an explicit `path_access` its read
	// params silently inherit write restrictions — the exact confusion the
	// per-param grouping exists to prevent.
	const namespaces = new Set(pathParams.map((p) => p.namespace));
	if (namespaces.size > 1 && pathParams.some((p) => params[p.paramName]?.path_access === undefined)) {
		log.debug(
			`Tool "${toolName}" has path params in both namespaces but not all declare path_access; ` +
				`those params default to the tool mode "${toolMode}".`,
		);
	}

	return pathParams;
}
