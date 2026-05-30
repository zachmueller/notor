/**
 * JSON Schema sanitizer.
 *
 * Normalizes arbitrary tool input schemas (notably those reported by MCP
 * servers via tools/list) into the strict JSON Schema draft-2020-12 subset
 * that AWS Bedrock's Converse API accepts. Bedrock rejects an entire
 * tool-use request if any single tool schema contains an unsupported
 * keyword/construct, so we normalize defensively.
 *
 * The output subset is intentionally strict enough to also be valid for the
 * Anthropic and OpenAI providers, so the sanitized schema can be shared
 * across all providers without losing anything load-bearing.
 *
 * Design: pure (returns the list of modifications instead of logging),
 * non-mutating, and never throws — it always returns a valid schema.
 */

import type { JSONSchema } from "../tools/tool";

export interface SanitizeResult {
	schema: JSONSchema;
	/** Keywords/constructs removed or rewritten; empty if unchanged. */
	modifications: string[];
}

/**
 * Meta/identifier/annotation keywords that Bedrock's validator rejects.
 * Dropped wherever they appear in the schema tree.
 */
const STRIP_KEYWORDS = new Set<string>([
	"$schema",
	"$id",
	"id",
	"$comment",
	"$anchor",
	"$dynamicAnchor",
	"$dynamicRef",
	"$recursiveRef",
	"$recursiveAnchor",
	"$vocabulary",
	"examples",
	// `format` is annotation-only in draft 2020-12 and MCP servers emit exotic
	// values; dropping it entirely is the lowest-risk choice.
	"format",
]);

/** Subschema keys whose values are themselves a single schema. */
const SCHEMA_VALUE_KEYS = ["items", "not"];

/** Subschema keys whose values are an array of schemas. */
const SCHEMA_ARRAY_KEYS = ["prefixItems", "allOf", "anyOf", "oneOf"];

/** Subschema keys whose values are a map of name -> schema. */
const SCHEMA_MAP_KEYS = ["properties", "patternProperties"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value)
	);
}

/**
 * Extract the local definition name from a `$ref` pointer of the form
 * `#/$defs/Name` or `#/definitions/Name`. Returns null for anything else
 * (external refs, deep JSON pointers, etc.).
 */
function localRefName(ref: string): string | null {
	const match = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(ref);
	return match && match[1] !== undefined ? decodeURIComponent(match[1]) : null;
}

interface Context {
	/** name -> raw definition schema, gathered from top-level $defs/definitions. */
	defs: Map<string, Record<string, unknown>>;
	mods: Set<string>;
}

/**
 * Recursively sanitize a single schema node, returning a fresh object.
 *
 * @param seenRefs ref pointers currently being resolved (cycle guard).
 */
function sanitizeNode(
	node: unknown,
	ctx: Context,
	seenRefs: Set<string>
): Record<string, unknown> {
	if (!isPlainObject(node)) {
		ctx.mods.add("non-object-node->{type:object}");
		return { type: "object" };
	}

	// Handle $ref by inlining a sanitized copy of the local definition.
	if (typeof node["$ref"] === "string") {
		const ref = node["$ref"];
		const name = localRefName(ref);
		const target = name !== undefined && name !== null ? ctx.defs.get(name) : undefined;
		if (!target || seenRefs.has(ref)) {
			// External, unresolvable, or cyclic ref — conservative fallback.
			ctx.mods.add("$ref->{type:object}");
			return { type: "object" };
		}
		ctx.mods.add("$ref->inlined");
		const nextSeen = new Set(seenRefs);
		nextSeen.add(ref);
		return sanitizeNode(target, ctx, nextSeen);
	}

	const out: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(node)) {
		if (STRIP_KEYWORDS.has(key)) {
			ctx.mods.add(key);
			continue;
		}

		// Definition containers are inlined at use sites and removed here.
		if (key === "$defs" || key === "definitions") {
			ctx.mods.add(`${key}-removed`);
			continue;
		}

		// nullable is handled after the loop (needs to merge with `type`).
		if (key === "nullable") continue;

		if (SCHEMA_MAP_KEYS.includes(key) && isPlainObject(value)) {
			const mapped: Record<string, unknown> = {};
			for (const [propName, propSchema] of Object.entries(value)) {
				mapped[propName] = sanitizeNode(propSchema, ctx, seenRefs);
			}
			out[key] = mapped;
			continue;
		}

		if (SCHEMA_ARRAY_KEYS.includes(key) && Array.isArray(value)) {
			out[key] = value.map((entry) => sanitizeNode(entry, ctx, seenRefs));
			continue;
		}

		if (SCHEMA_VALUE_KEYS.includes(key) && isPlainObject(value)) {
			out[key] = sanitizeNode(value, ctx, seenRefs);
			continue;
		}

		if (key === "additionalProperties") {
			// boolean stays as-is; object form is a nested schema.
			out[key] = isPlainObject(value)
				? sanitizeNode(value, ctx, seenRefs)
				: value;
			continue;
		}

		out[key] = value;
	}

	normalizeExclusiveBounds(out, ctx);
	applyNullable(node, out, ctx);

	return out;
}

/**
 * Convert draft-04 boolean `exclusiveMinimum`/`exclusiveMaximum` into the
 * draft-2020-12 numeric form. Already-numeric values are left untouched.
 */
function normalizeExclusiveBounds(out: Record<string, unknown>, ctx: Context): void {
	for (const [exclusiveKey, boundKey] of [
		["exclusiveMinimum", "minimum"],
		["exclusiveMaximum", "maximum"],
	] as const) {
		const exclusive = out[exclusiveKey];
		if (typeof exclusive !== "boolean") continue;

		if (exclusive === true && typeof out[boundKey] === "number") {
			out[exclusiveKey] = out[boundKey];
			delete out[boundKey];
			ctx.mods.add(`${exclusiveKey}->numeric`);
		} else {
			// `true` without a sibling bound, or `false` — drop the boolean.
			delete out[exclusiveKey];
			ctx.mods.add(`${exclusiveKey}-dropped`);
		}
	}
}

/**
 * Fold OpenAPI `nullable: true` into the `type` array form.
 */
function applyNullable(
	node: Record<string, unknown>,
	out: Record<string, unknown>,
	ctx: Context
): void {
	if (node["nullable"] !== true) return;
	ctx.mods.add("nullable->type[]");

	const type = out["type"];
	if (typeof type === "string") {
		out["type"] = type === "null" ? type : [type, "null"];
	} else if (Array.isArray(type)) {
		if (!type.includes("null")) out["type"] = [...type, "null"];
	} else {
		// No usable type to attach null to — leave as-is (root gets defaulted).
	}
}

/**
 * Normalize an arbitrary input schema into the Bedrock-accepted JSON Schema
 * draft-2020-12 subset. Conservative: always returns a valid schema, never
 * throws, never mutates the input.
 */
export function sanitizeInputSchemaForBedrock(input: unknown): SanitizeResult {
	if (!isPlainObject(input)) {
		return {
			schema: { type: "object" },
			modifications: input === undefined ? [] : ["non-object->{type:object}"],
		};
	}

	const defs = new Map<string, Record<string, unknown>>();
	for (const container of ["$defs", "definitions"] as const) {
		const value = input[container];
		if (isPlainObject(value)) {
			for (const [name, def] of Object.entries(value)) {
				if (isPlainObject(def) && !defs.has(name)) defs.set(name, def);
			}
		}
	}

	const ctx: Context = { defs, mods: new Set<string>() };
	const sanitized = sanitizeNode(input, ctx, new Set<string>());

	// Guarantee the root schema declares a type.
	if (typeof sanitized["type"] !== "string" && !Array.isArray(sanitized["type"])) {
		sanitized["type"] = "object";
		ctx.mods.add("root-type-defaulted");
	}

	return {
		schema: sanitized as JSONSchema,
		modifications: Array.from(ctx.mods),
	};
}
