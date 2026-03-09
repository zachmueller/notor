/**
 * MCP tool handler — executes MCP tool calls via McpHub.
 *
 * Handles:
 * - Server connection resolution
 * - tools/call request with _meta.notor_mode injection
 * - Text-only result extraction (images/resources omitted with notice)
 * - Error handling (disconnected, timeout, malformed response)
 * - Per-server request timeout enforcement
 *
 * Implementation will be added in Phase 2 (FEAT-001).
 *
 * @see specs/04-mcp/plan.md — Group B: Tool Registration and Dispatch
 * @see specs/04-mcp/data-model.md — McpToolCallResult
 */
