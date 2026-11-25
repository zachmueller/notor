#!/usr/bin/env node
/**
 * Minimal stdio MCP server for the startup-timing harness
 * (e2e/scripts/startup-timing-test.ts). It stands in for a user's real MCP
 * servers so startup cost includes N real child-process spawns, handshakes and
 * tools/list round-trips, without touching any external service.
 *
 * Usage: node echo-mcp-server.mjs [toolCount=8]
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const toolCount = Number(process.argv[2] ?? 8) || 8;

const TOOLS = Array.from({ length: toolCount }, (_, i) => ({
	name: `echo_${i}`,
	description: `Echo tool #${i}: returns its input text unchanged.`,
	inputSchema: {
		type: "object",
		properties: { text: { type: "string", description: "Text to echo back" } },
		required: ["text"],
	},
	annotations: { readOnlyHint: true },
}));

const server = new Server({ name: "notor-startup-echo", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
	content: [{ type: "text", text: String(req.params.arguments?.text ?? "") }],
}));

await server.connect(new StdioServerTransport());
