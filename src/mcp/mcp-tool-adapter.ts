/**
 * MCP tool adapter — wraps MCP discovered tools as Notor Tool instances.
 *
 * The McpRegisteredTool class adapts an McpDiscoveredTool to implement
 * Notor's Tool interface, enabling uniform registration in the ToolRegistry
 * alongside built-in tools.
 *
 * Includes:
 * - Namespaced naming ({serverName}__{toolName})
 * - Read/write classification logic
 * - execute() delegation to McpHub.callTool()
 * - Helper functions: isMcpTool(), parseMcpToolName()
 *
 * Implementation will be added in Phase 1 (ARCH-004).
 *
 * @see specs/04-mcp/plan.md — Group B: Tool Registration and Dispatch
 * @see specs/04-mcp/data-model.md — McpRegisteredTool
 */
