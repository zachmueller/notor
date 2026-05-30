import { describe, it, expect } from "vitest";
import { sanitizeInputSchemaForBedrock } from "./json-schema-sanitizer";

describe("sanitizeInputSchemaForBedrock", () => {
	// -- meta/annotation keyword stripping (allowlist) --------------------------

	it("strips a draft-07 $schema and records the modification", () => {
		const { schema, modifications } = sanitizeInputSchemaForBedrock({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { q: { type: "string" } },
		});

		expect(schema.$schema).toBeUndefined();
		expect(schema.type).toBe("object");
		expect(modifications).toContain("$schema");
	});

	it("strips examples, $comment, and id", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "object",
			id: "urn:x",
			$comment: "note",
			examples: [{ a: 1 }],
			properties: {},
		});
		expect((schema as Record<string, unknown>).id).toBeUndefined();
		expect((schema as Record<string, unknown>).$comment).toBeUndefined();
		expect((schema as Record<string, unknown>).examples).toBeUndefined();
	});

	it("drops arbitrary/unknown and vendor keywords (allowlist)", () => {
		const { schema, modifications } = sanitizeInputSchemaForBedrock({
			type: "object",
			"x-vendor-ext": { foo: 1 },
			deprecated: true,
			readOnly: true,
			contentEncoding: "base64",
			unevaluatedProperties: false,
			properties: { a: { type: "string" } },
		});
		const s = schema as Record<string, unknown>;
		expect(s["x-vendor-ext"]).toBeUndefined();
		expect(s.deprecated).toBeUndefined();
		expect(s.readOnly).toBeUndefined();
		expect(s.contentEncoding).toBeUndefined();
		expect(s.unevaluatedProperties).toBeUndefined();
		expect(modifications).toEqual(
			expect.arrayContaining([
				"x-vendor-ext",
				"deprecated",
				"readOnly",
				"contentEncoding",
				"unevaluatedProperties",
			])
		);
		// allowlisted content survives
		expect((schema.properties as Record<string, any>).a).toEqual({ type: "string" });
	});

	it("strips format keywords", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "string",
			format: "some-exotic-format",
		});
		expect((schema as Record<string, unknown>).format).toBeUndefined();
	});

	it("preserves title and description", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "object",
			title: "Widget",
			description: "A widget",
			properties: {},
		});
		expect(schema.title).toBe("Widget");
		expect(schema.description).toBe("A widget");
	});

	// -- $ref / $defs -----------------------------------------------------------

	it("inlines $ref against $defs and removes the defs container", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "object",
			properties: { name: { $ref: "#/$defs/Name" } },
			$defs: { Name: { type: "string", description: "a name" } },
		});

		const props = schema.properties as Record<string, unknown>;
		expect(props.name).toEqual({ type: "string", description: "a name" });
		expect(schema.$defs).toBeUndefined();
		expect(JSON.stringify(schema)).not.toContain("$ref");
	});

	it("inlines $ref against draft-04 definitions", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "object",
			properties: { id: { $ref: "#/definitions/Id" } },
			definitions: { Id: { type: "integer" } },
		});

		const props = schema.properties as Record<string, unknown>;
		expect(props.id).toEqual({ type: "integer" });
		expect(schema.definitions).toBeUndefined();
	});

	it("falls back to {type:object} for unresolvable/external $ref", () => {
		const { schema, modifications } = sanitizeInputSchemaForBedrock({
			type: "object",
			properties: { x: { $ref: "https://example.com/Thing" } },
		});

		const props = schema.properties as Record<string, unknown>;
		expect(props.x).toEqual({ type: "object" });
		expect(modifications).toContain("$ref->{type:object}");
	});

	it("terminates on a cyclic $ref and yields a valid schema", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "object",
			properties: { node: { $ref: "#/$defs/Node" } },
			$defs: {
				Node: {
					type: "object",
					properties: { child: { $ref: "#/$defs/Node" } },
				},
			},
		});

		const props = schema.properties as Record<string, unknown>;
		const node = props.node as Record<string, unknown>;
		expect(node.type).toBe("object");
		const inner = node.properties as Record<string, unknown>;
		expect(inner.child).toEqual({ type: "object" });
	});

	// -- numeric bounds ---------------------------------------------------------

	it("converts boolean exclusiveMinimum:true with sibling minimum to numeric", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "number",
			minimum: 0,
			exclusiveMinimum: true,
		});

		expect(schema.exclusiveMinimum).toBe(0);
		expect(schema.minimum).toBeUndefined();
	});

	it("drops exclusiveMinimum:false and keeps minimum", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "number",
			minimum: 3,
			exclusiveMinimum: false,
		});

		expect(schema.exclusiveMinimum).toBeUndefined();
		expect(schema.minimum).toBe(3);
	});

	it("drops boolean exclusiveMinimum:true with no sibling minimum", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "number",
			exclusiveMinimum: true,
		});

		expect(schema.exclusiveMinimum).toBeUndefined();
		expect(schema.minimum).toBeUndefined();
	});

	it("preserves numeric exclusiveMinimum", () => {
		const { schema, modifications } = sanitizeInputSchemaForBedrock({
			type: "number",
			exclusiveMinimum: 5,
		});

		expect(schema.exclusiveMinimum).toBe(5);
		expect(modifications).toHaveLength(0);
	});

	// -- tuple items (draft-07 → 2020-12) ---------------------------------------

	it("converts tuple items[] to prefixItems", () => {
		const { schema, modifications } = sanitizeInputSchemaForBedrock({
			type: "array",
			items: [{ type: "string" }, { type: "number" }],
		});
		expect((schema as Record<string, unknown>).items).toBeUndefined();
		expect(schema.prefixItems).toEqual([{ type: "string" }, { type: "number" }]);
		expect(modifications).toContain("items[]->prefixItems");
	});

	it("converts tuple items[] + object additionalItems to prefixItems + items", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "array",
			items: [{ type: "string" }],
			additionalItems: { type: "number" },
		});
		expect(schema.prefixItems).toEqual([{ type: "string" }]);
		expect(schema.items).toEqual({ type: "number" });
	});

	it("keeps object-form items and drops stray additionalItems", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "array",
			items: { type: "string" },
			additionalItems: { type: "number" },
		});
		expect(schema.items).toEqual({ type: "string" });
		expect((schema as Record<string, unknown>).additionalItems).toBeUndefined();
		expect(schema.prefixItems).toBeUndefined();
	});

	// -- type handling ----------------------------------------------------------

	it("normalizes non-standard type aliases", () => {
		const { schema } = sanitizeInputSchemaForBedrock({ type: "int" });
		expect(schema.type).toBe("integer");
	});

	it("drops an invalid type and defaults the root to object", () => {
		const { schema } = sanitizeInputSchemaForBedrock({ type: "frobnicate" });
		expect(schema.type).toBe("object");
	});

	it("preserves a valid type array", () => {
		const { schema, modifications } = sanitizeInputSchemaForBedrock({
			type: ["string", "null"],
		});
		expect(schema.type).toEqual(["string", "null"]);
		expect(modifications).toHaveLength(0);
	});

	it("folds nullable:true into a type array", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "string",
			nullable: true,
		});
		expect(schema.type).toEqual(["string", "null"]);
		expect((schema as Record<string, unknown>).nullable).toBeUndefined();
	});

	it("appends null to an existing type array only once", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: ["string", "null"],
			nullable: true,
		});
		expect(schema.type).toEqual(["string", "null"]);
	});

	// -- recursion / structure --------------------------------------------------

	it("sanitizes deeply nested nodes", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "object",
			properties: {
				a: {
					type: "object",
					properties: {
						b: {
							$schema: "http://json-schema.org/draft-07/schema#",
							type: "string",
							nullable: true,
						},
					},
				},
			},
		});

		const a = (schema.properties as Record<string, any>).a;
		const b = a.properties.b;
		expect(b.$schema).toBeUndefined();
		expect(b.type).toEqual(["string", "null"]);
	});

	it("recurses into prefixItems and allOf branches", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "object",
			allOf: [
				{
					$schema: "http://json-schema.org/draft-07/schema#",
					type: "object",
					properties: { a: { type: "string" } },
				},
			],
			properties: {
				tuple: {
					type: "array",
					prefixItems: [{ $comment: "x", type: "string" }],
				},
			},
		});

		const allOf = (schema as Record<string, any>).allOf;
		expect(allOf[0].$schema).toBeUndefined();
		const tuple = (schema.properties as Record<string, any>).tuple;
		expect(tuple.prefixItems[0].$comment).toBeUndefined();
		expect(tuple.prefixItems[0].type).toBe("string");
	});

	it("recurses into oneOf/anyOf/not/if-then-else", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "object",
			oneOf: [{ type: "string", format: "uri" }],
			not: { type: "null", $comment: "x" },
			if: { type: "string" },
			then: { type: "string", deprecated: true },
		});
		const s = schema as Record<string, any>;
		expect(s.oneOf[0].format).toBeUndefined();
		expect(s.not.$comment).toBeUndefined();
		expect(s.then.deprecated).toBeUndefined();
	});

	it("replaces a boolean subschema with {type:object}", () => {
		const { schema } = sanitizeInputSchemaForBedrock({
			type: "object",
			properties: { anything: true },
		});
		const props = schema.properties as Record<string, unknown>;
		expect(props.anything).toEqual({ type: "object" });
	});

	// -- defaults / edge cases --------------------------------------------------

	it("defaults a missing top-level type to object", () => {
		const { schema, modifications } = sanitizeInputSchemaForBedrock({
			properties: { q: { type: "string" } },
		});
		expect(schema.type).toBe("object");
		expect(modifications).toContain("root-type-defaulted");
	});

	it("returns {type:object} for non-object input without throwing", () => {
		for (const input of [undefined, null, "str", 42, []]) {
			const { schema } = sanitizeInputSchemaForBedrock(input);
			expect(schema).toEqual({ type: "object" });
		}
	});

	it("leaves an already-clean schema unchanged with no modifications", () => {
		const input = {
			type: "object",
			properties: {
				q: { type: "string", description: "query" },
				n: { type: "number" },
			},
			required: ["q"],
			additionalProperties: false,
		};
		const { schema, modifications } = sanitizeInputSchemaForBedrock(input);
		expect(schema).toEqual(input);
		expect(modifications).toHaveLength(0);
	});

	it("preserves a realistic clean nested schema unchanged", () => {
		const input = {
			type: "object",
			properties: {
				items: {
					type: "array",
					items: {
						type: "object",
						properties: { id: { type: "integer" }, tag: { type: "string", enum: ["a", "b"] } },
						required: ["id"],
						additionalProperties: false,
					},
					minItems: 1,
				},
			},
			required: ["items"],
		};
		const { schema, modifications } = sanitizeInputSchemaForBedrock(input);
		expect(schema).toEqual(input);
		expect(modifications).toHaveLength(0);
	});
});
