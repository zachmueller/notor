/**
 * MCP tool adapter — wraps MCP discovered tools as Notor Tool instances.
 *
 * The McpRegisteredTool class adapts an McpDiscoveredTool to implement
 * Notor's Tool interface, enabling uniform registration in the ToolRegistry
 * alongside built-in tools.
 *
 * Includes:
 * - Namespaced naming ({serverName}__{toolName})
 * - Read/write classification logic (user override → readOnlyHint → default write)
 * - execute() delegation to McpHub.callTool()
 * - Helper functions: isMcpTool(), parseMcpToolName()
 *
 * @see specs/04-mcp/data-model.md — McpRegisteredTool
 * @see specs/04-mcp/contracts/mcp-tool-dispatch.md — Tool Name Parsing
 */

import type { Tool, JSONSchema } from "../tools/tool";
import type { ToolResult } from "../types";
import type { McpDiscoveredTool, McpServerConfig } from "./mcp-types";
import type { McpHub } from "./mcp-hub";

// ---------------------------------------------------------------------------
// Helper functions (exported for use by dispatcher and other modules)
// ---------------------------------------------------------------------------

/**
 * Check if a tool name is an MCP tool (contains `__` double underscore).
 *
 * @see specs/04-mcp/contracts/mcp-tool-dispatch.md — Identifying MCP Tools
 */
export function isMcpTool(toolName: string): boolean {
	return toolName.includes("__");
}

/**
 * Parse a namespaced MCP tool name into server name and tool name.
 *
 * Splits on the **first** `__` occurrence. This is safe because server
 * names are slugs (`[a-z0-9-]`) that never contain `__`.
 *
 * @see specs/04-mcp/contracts/mcp-tool-dispatch.md — Extracting Server and Tool Name
 */
export function parseMcpToolName(namespacedName: string): {
	serverName: string;
	toolName: string;
} {
	const idx = namespacedName.indexOf("__");
	if (idx === -1) {
		return { serverName: "", toolName: namespacedName };
	}
	return {
		serverName: namespacedName.substring(0, idx),
		toolName: namespacedName.substring(idx + 2),
	};
}

// ---------------------------------------------------------------------------
// McpRegisteredTool
// ---------------------------------------------------------------------------

/**
 * Adapter that wraps an McpDiscoveredTool to implement Notor's Tool interface.
 *
 * Enables MCP tools to be registered in the ToolRegistry alongside
 * built-in tools with uniform dispatch through the ToolDispatcher.
 *
 * @see specs/04-mcp/data-model.md — McpRegisteredTool entity
 */
export class McpRegisteredTool implements Tool {
	/** Server name this tool belongs to. */
	private serverName: string;

	/** The discovered tool from the MCP server. */
	private discoveredTool: McpDiscoveredTool;

	/** Server configuration for classification/auto-approve lookups. */
	private serverConfig: McpServerConfig;

	/** McpHub reference for callTool delegation. */
	private mcpHub: McpHub;

	/** Callback to get the current conversation mode ("plan" | "act"). */
	private getModeCallback: () => "plan" | "act";

	constructor(
		serverName: string,
		discoveredTool: McpDiscoveredTool,
		serverConfig: McpServerConfig,
		mcpHub: McpHub,
		getModeCallback: () => "plan" | "act"
	) {
		this.serverName = serverName;
		this.discoveredTool = discoveredTool;
		this.serverConfig = serverConfig;
		this.mcpHub = mcpHub;
		this.getModeCallback = getModeCallback;
	}

	// -----------------------------------------------------------------------
	// Tool interface implementation
	// -----------------------------------------------------------------------

	/**
	 * Namespaced tool name: `{serverName}__{toolName}`.
	 *
	 * @example "my-db-server__query"
	 */
	get name(): string {
		return `${this.serverName}__${this.discoveredTool.name}`;
	}

	/**
	 * Tool description passed through from the MCP server.
	 */
	get description(): string {
		return this.discoveredTool.description;
	}

	/**
	 * JSON Schema for tool input parameters.
	 *
	 * Passed through from the MCP server. Defaults to `{ type: "object" }`
	 * if the server did not provide an input schema.
	 */
	get input_schema(): JSONSchema {
		return (this.discoveredTool.inputSchema as JSONSchema) ?? { type: "object" };
	}

	/**
	 * Tool mode classification (read or write).
	 *
	 * Precedence per data-model.md:
	 * 1. User override in McpServerConfig.toolClassifications
	 * 2. Server-reported ToolAnnotations.readOnlyHint === true → "read"
	 * 3. Default → "write" (conservative)
	 */
	get mode(): "read" | "write" {
		// 1. Check user override
		const rawToolName = this.discoveredTool.name;
		const userOverride = this.serverConfig.toolClassifications?.[rawToolName];
		if (userOverride) {
			return userOverride;
		}

		// 2. Check server-reported readOnlyHint
		if (this.discoveredTool.annotations?.readOnlyHint === true) {
			return "read";
		}

		// 3. Default to write (conservative — blocks in Plan mode)
		return "write";
	}

	/**
	 * Execute the tool by delegating to McpHub.callTool().
	 *
	 * Obtains the current conversation mode from the mode accessor callback
	 * so the correct `_meta.notor_mode` is sent with each invocation.
	 */
	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const currentMode = this.getModeCallback();
		return this.mcpHub.callTool(
			this.serverName,
			this.discoveredTool.name,
			params,
			currentMode
		);
	}
}
