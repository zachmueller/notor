#!/usr/bin/env node
/**
 * Test-only stdio MCP server that exposes tools whose input schemas contain
 * constructs AWS Bedrock rejects (it requires strict JSON Schema draft 2020-12).
 *
 * Used by e2e/scripts/mcp-schema-sanitization-test.ts to verify that Notor's
 * schema sanitizer (src/utils/json-schema-sanitizer.ts) normalizes these into
 * the Bedrock-accepted subset at MCP discovery time.
 *
 * The low-level Server API is used (not McpServer) so we can return arbitrary,
 * unsanitized schemas verbatim — McpServer would coerce them through zod.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Tools whose `inputSchema` deliberately violates the draft-2020-12 subset
 * Bedrock accepts. Each targets a distinct failure mode.
 */
const TOOLS = [
	{
		name: "draft07_meta",
		description: "Schema carrying draft-07 meta keywords and a vendor extension.",
		inputSchema: {
			$schema: "http://json-schema.org/draft-07/schema#",
			$id: "urn:test:draft07",
			$comment: "internal note",
			type: "object",
			"x-internal": { team: "test" },
			properties: {
				q: { type: "string", description: "query", examples: ["hello"] },
			},
			required: ["q"],
		},
	},
	{
		name: "ref_and_defs",
		description: "Schema using $ref + definitions (draft-07 references).",
		inputSchema: {
			type: "object",
			properties: {
				user: { $ref: "#/definitions/User" },
				tags: { type: "array", items: { $ref: "#/definitions/Tag" } },
			},
			definitions: {
				User: {
					type: "object",
					properties: { id: { type: "integer" }, name: { type: "string" } },
				},
				Tag: { type: "string" },
			},
		},
	},
	{
		name: "tuple_items",
		description: "Schema using draft-07 tuple `items` (array form) + additionalItems.",
		inputSchema: {
			type: "object",
			properties: {
				pair: {
					type: "array",
					items: [{ type: "string" }, { type: "number" }],
					additionalItems: { type: "boolean" },
				},
			},
		},
	},
	{
		name: "nullable_and_bounds",
		description: "Schema using OpenAPI nullable + draft-04 boolean exclusiveMinimum.",
		inputSchema: {
			type: "object",
			properties: {
				score: { type: "number", minimum: 0, exclusiveMinimum: true },
				note: { type: "string", nullable: true },
			},
		},
	},
	{
		name: "exotic_format_and_unknown",
		description: "Schema with exotic format and unknown/legacy keywords.",
		inputSchema: {
			type: "object",
			properties: {
				when: { type: "string", format: "some-vendor-format" },
				blob: { type: "string", contentEncoding: "base64", contentMediaType: "image/png" },
			},
			unevaluatedProperties: false,
			deprecated: true,
		},
	},
	{
		name: "clean_tool",
		description: "An already-clean schema that must pass through unchanged.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "A path" },
				count: { type: "integer", minimum: 1 },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
];

const server = new Server(
	{ name: "nasty-schema-server", version: "1.0.0" },
	{ capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
	content: [{ type: "text", text: `called ${req.params.name}` }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
