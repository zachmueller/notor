/**
 * MCP connection hub — manages all MCP server connections.
 *
 * Singleton class responsible for:
 * - Connecting/disconnecting MCP servers
 * - Transport factory (stdio/SSE/Streamable HTTP)
 * - Credential resolution from secrets manager
 * - Tool discovery via tools/list
 * - Connection status tracking and notifications
 * - Process lifecycle management for stdio
 * - Reconnection logic for HTTP transports
 *
 * Implementation will be added in Phase 1 (ARCH-002, ARCH-003).
 *
 * @see specs/04-mcp/plan.md — Group A: MCP Core Infrastructure
 * @see specs/04-mcp/data-model.md — McpConnection, McpHub
 */
