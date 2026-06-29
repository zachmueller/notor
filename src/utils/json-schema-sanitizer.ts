/**
 * JSON Schema sanitizer.
 *
 * Normalizes arbitrary tool input schemas (notably those reported by MCP
 * servers via tools/list) into the strict JSON Schema draft-2020-12 subset
 * that AWS Bedrock's Converse API accepts. Bedrock rejects an entire
 * tool-use request if any single tool schema fails draft-2020-12 validation,
 * so we normalize defensively.
 *
 * Strategy: an **allowlist**, not a denylist. Only keywords known to be valid
 * in the draft-2020-12 validation vocabulary are kept; everything else is
 * dropped. This is robust against arbitrary/unknown keywords that MCP servers
 * emit (draft-07 `definitions`/`dependencies`, OpenAPI extensions, vendor
 * `x-*` keys, etc.) without having to enumerate every offender. On top of the
 * allowlist, a few structural fixes rewrite legacy shapes that are otherwise
 * valid keywords with an invalid 2020-12 form (tuple `items`, boolean
 * `exclusiveMinimum`, OpenAPI `nullable`, `$ref`).
 *
 * The output subset is intentionally strict enough to also be valid for the
 * Anthropic and OpenAI providers, so the sanitized schema can be shared
 * across all providers. Dropping a constraint only ever makes a schema looser,
 * which is safe for tool-input validation.
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
 * Keywords kept verbatim (after recursion) — the draft-2020-12 validation +
 * annotation vocabulary Bedrock accepts. Anything not listed here, and not
 * handled specially below, is dropped.
 *
 * Deliberately excluded: `$schema`, `$id`, `id`, `$comment`, `$anchor`,
 * `$ref`/`$defs`/`definitions` (inlined separately), `format` (exotic values),
 * `examples`, `deprecated`, `readOnly`, `writeOnly`, `contentEncoding`,
 * `contentMediaType`, `unevaluatedItems`, `unevaluatedProperties`,
 * `dependencies`/`additionalItems` (legacy; dropped or rewritten).
 */
const SCALAR_KEYWORDS = new Set<string>([
	// annotations
	"title",
	"description",
	"default",
	// generic validation
	"enum",
	"const",
	// numeric
	"multipleOf",
	"maximum",
	"minimum",
	// string
	"maxLength",
	"minLength",
	"pattern",
	// array
	"maxItems",
	"minItems",
	"uniqueItems",
	"maxContains",
	"minContains",
	// object
	"maxProperties",
	"minProperties",
	"required",
	"dependentRequired",
]);

/** Applicator keywords whose value is a single subschema → recurse. */
const SCHEMA_VALUE_KEYS = new Set<string>([
	"items",
	"contains",
	"not",
	"if",
	"then",
	"else",
	"propertyNames",
]);

/** Applicator keywords whose value is an array of subschemas → recurse each. */
const SCHEMA_ARRAY_KEYS = new Set<string>(["prefixItems", "allOf", "anyOf", "oneOf"]);

/** Applicator keywords whose value is a name→subschema map → recurse each. */
const SCHEMA_MAP_KEYS = new Set<string>([
	"properties",
	"patternProperties",
	"dependentSchemas",
]);

/** Common non-standard `type` spellings mapped to valid ones. */
const TYPE_ALIASES: Record<string, string> = {
	int: "integer",
	integer: "integer",
	long: "integer",
	float: "number",
	double: "number",
	decimal: "number",
	number: "number",
	bool: "boolean",
	boolean: "boolean",
	str: "string",
	string: "string",
	object: "object",
	array: "array",
	null: "null",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * Normalize a `type` value into a valid string or array of valid strings.
 * Returns undefined if nothing usable remains (caller drops the keyword).
 */
function normalizeType(type: unknown, ctx: Context): string | string[] | undefined {
	const mapOne = (t: unknown): string | undefined => {
		if (typeof t !== "string") return undefined;
		const mapped = TYPE_ALIASES[t.toLowerCase()];
		if (mapped) {
			if (mapped !== t) ctx.mods.add("type-alias");
			return mapped;
		}
		ctx.mods.add("type-dropped-invalid");
		return undefined;
	};

	if (typeof type === "string") return mapOne(type);

	if (Array.isArray(type)) {
		const out: string[] = [];
		for (const entry of type) {
			const mapped = mapOne(entry);
			if (mapped && !out.includes(mapped)) out.push(mapped);
		}
		if (out.length === 0) return undefined;
		return out.length === 1 ? out[0] : out;
	}

	if (type !== undefined) ctx.mods.add("type-dropped-invalid");
	return undefined;
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
	if (typeof node === "boolean") {
		// Boolean schemas are valid in 2020-12, but Bedrock expects an object.
		ctx.mods.add("boolean-schema->{type:object}");
		return { type: "object" };
	}
	if (!isPlainObject(node)) {
		ctx.mods.add("non-object-node->{type:object}");
		return { type: "object" };
	}

	// Inline $ref by resolving against the local definition map.
	if (typeof node["$ref"] === "string") {
		const ref = node["$ref"];
		const name = localRefName(ref);
		const target = name !== null ? ctx.defs.get(name) : undefined;
		if (!target || seenRefs.has(ref)) {
			ctx.mods.add("$ref->{type:object}");
			return { type: "object" };
		}
		ctx.mods.add("$ref->inlined");
		const nextSeen = new Set(seenRefs);
		nextSeen.add(ref);
		return sanitizeNode(target, ctx, nextSeen);
	}

	const out: Record<string, unknown> = {};
	const nullable = node["nullable"] === true;

	// A draft-04 boolean `exclusiveMinimum:true` with a numeric sibling
	// `minimum` becomes a numeric `exclusiveMinimum`, and the plain `minimum`
	// is dropped. Precompute which plain bound keys are consumed so they are
	// suppressed regardless of key order.
	const consumedBounds = new Set<string>();
	for (const [exclusiveKey, boundKey] of [
		["exclusiveMinimum", "minimum"],
		["exclusiveMaximum", "maximum"],
	] as const) {
		if (node[exclusiveKey] === true && typeof node[boundKey] === "number") {
			consumedBounds.add(boundKey);
		}
	}

	// Keys are processed in their original order so that an already-clean
	// schema passes through byte-identical (minimal downstream diff). The few
	// cross-keyword transforms (tuple items, boolean exclusive bounds, nullable
	// folding) place their result at the originating key's position.
	for (const [key, value] of Object.entries(node)) {
		if (key === "nullable") continue; // folded into `type` below

		if (key === "type") {
			let type = normalizeType(value, ctx);
			if (nullable) {
				ctx.mods.add("nullable->type[]");
				if (typeof type === "string") {
					type = type === "null" ? type : [type, "null"];
				} else if (Array.isArray(type) && !type.includes("null")) {
					type = [...type, "null"];
				}
			}
			if (type !== undefined) out[key] = type;
			continue;
		}

		if (key === "items") {
			normalizeItems(node, out, ctx, seenRefs);
			continue;
		}
		if (key === "additionalItems") {
			// Emitted (as `items`) alongside a tuple `items`; otherwise dropped.
			// Handled within normalizeItems; nothing to place here.
			continue;
		}

		if (key === "exclusiveMinimum" || key === "exclusiveMaximum") {
			placeExclusiveBound(key, node, out, ctx);
			continue;
		}

		if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(value)) {
			const mapped: Record<string, unknown> = {};
			for (const [propName, propSchema] of Object.entries(value)) {
				mapped[propName] = sanitizeNode(propSchema, ctx, seenRefs);
			}
			out[key] = mapped;
			continue;
		}

		if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
			out[key] = value.map((entry) => sanitizeNode(entry, ctx, seenRefs));
			continue;
		}

		if (SCHEMA_VALUE_KEYS.has(key) && (isPlainObject(value) || typeof value === "boolean")) {
			out[key] = sanitizeNode(value, ctx, seenRefs);
			continue;
		}

		if (key === "additionalProperties") {
			// boolean stays as-is; object form is a nested schema.
			out[key] = isPlainObject(value) ? sanitizeNode(value, ctx, seenRefs) : value;
			continue;
		}

		if (SCALAR_KEYWORDS.has(key)) {
			// A plain bound consumed by a boolean exclusive sibling is dropped;
			// placeExclusiveBound records the transform.
			if (consumedBounds.has(key)) continue;
			out[key] = value;
			continue;
		}

		// Unknown / disallowed keyword — drop it.
		ctx.mods.add(key);
	}

	return out;
}

/**
 * Convert draft-07 tuple `items` (an array) into 2020-12 `prefixItems`, and
 * draft-07 `additionalItems` into 2020-12 `items`. Object-form `items` is
 * recursed as a normal single subschema.
 */
function normalizeItems(
	node: Record<string, unknown>,
	out: Record<string, unknown>,
	ctx: Context,
	seenRefs: Set<string>
): void {
	const items = node["items"];
	const additionalItems = node["additionalItems"];

	if (Array.isArray(items)) {
		out["prefixItems"] = items.map((entry) => sanitizeNode(entry, ctx, seenRefs));
		ctx.mods.add("items[]->prefixItems");
		if (isPlainObject(additionalItems) || typeof additionalItems === "boolean") {
			if (isPlainObject(additionalItems)) {
				out["items"] = sanitizeNode(additionalItems, ctx, seenRefs);
			}
			ctx.mods.add("additionalItems->items");
		}
	} else if (isPlainObject(items) || typeof items === "boolean") {
		out["items"] = sanitizeNode(items, ctx, seenRefs);
		if (additionalItems !== undefined) ctx.mods.add("additionalItems-dropped");
	} else if (additionalItems !== undefined) {
		ctx.mods.add("additionalItems-dropped");
	}
}

/**
 * Place a single `exclusiveMinimum`/`exclusiveMaximum` keyword into `out` in
 * draft-2020-12 form. Numeric values pass through; draft-04 boolean `true`
 * with a numeric sibling bound becomes that number (the plain bound is
 * suppressed by the caller); anything else is dropped.
 */
function placeExclusiveBound(
	exclusiveKey: "exclusiveMinimum" | "exclusiveMaximum",
	node: Record<string, unknown>,
	out: Record<string, unknown>,
	ctx: Context
): void {
	const exclusive = node[exclusiveKey];
	const boundKey = exclusiveKey === "exclusiveMinimum" ? "minimum" : "maximum";

	if (typeof exclusive === "number") {
		out[exclusiveKey] = exclusive;
		return;
	}
	if (exclusive === true && typeof node[boundKey] === "number") {
		out[exclusiveKey] = node[boundKey];
		ctx.mods.add(`${exclusiveKey}->numeric`);
		return;
	}
	// `true` without a sibling bound, `false`, or a non-numeric value — drop.
	ctx.mods.add(`${exclusiveKey}-dropped`);
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

	// Guarantee the root schema declares a type (Bedrock tool schemas are objects).
	const rootType = sanitized["type"];
	if (typeof rootType !== "string" && !Array.isArray(rootType)) {
		sanitized["type"] = "object";
		ctx.mods.add("root-type-defaulted");
	}

	return {
		schema: sanitized as JSONSchema,
		modifications: Array.from(ctx.mods),
	};
}
