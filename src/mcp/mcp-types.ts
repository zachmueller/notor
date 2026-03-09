/**
 * MCP subsystem type definitions.
 *
 * TypeScript interfaces and types for MCP server configuration,
 * connection state, tool discovery, and tool call results.
 * These types are imported by every other MCP module.
 *
 * @see specs/04-mcp/data-model.md
 */

// ---------------------------------------------------------------------------
// Persisted configuration types (stored in NotorSettings)
// ---------------------------------------------------------------------------

/**
 * Represents a single environment variable for an stdio MCP server.
 * Part of {@link McpServerConfig.env}.
 */
export interface McpEnvVar {
	/** Environment variable name (e.g., `API_KEY`, `NODE_ENV`). */
	key: string;
	/**
	 * The variable's value.
	 * When `sensitive` is true, this is stored as `""` in settings JSON
	 * and the actual value is resolved from SecretStorage at connection time.
	 */
	value: string;
	/**
	 * If true, the value is stored via Obsidian's SecretStorage API.
	 * @default false
	 */
	sensitive: boolean;
}

/**
 * Represents a single custom HTTP header for an HTTP-transport MCP server.
 * Part of {@link McpServerConfig.headers}.
 */
export interface McpHeader {
	/** Header name (e.g., `Authorization`). */
	key: string;
	/**
	 * Header value.
	 * When `sensitive` is true, this is stored as `""` in settings JSON
	 * and the actual value is resolved from SecretStorage at connection time.
	 */
	value: string;
	/**
	 * If true, the value is stored via Obsidian's SecretStorage API.
	 * @default false
	 */
	sensitive: boolean;
}

/**
 * Persisted MCP server configuration entry.
 * Stored in the `mcp_servers` map within NotorSettings, keyed by server name (slug).
 *
 * @see specs/04-mcp/data-model.md — McpServerConfig
 */
export interface McpServerConfig {
	/**
	 * Display name and unique key.
	 * Slug format: `[a-z0-9-]`, max 50 chars.
	 */
	name: string;

	/** Transport type for this server. */
	type: "stdio" | "sse" | "streamableHttp";

	/** Command to spawn the local process (stdio only). */
	command?: string;

	/** Command-line arguments for the spawned process (stdio only). */
	args?: string[];

	/** Working directory for the spawned process (stdio only; defaults to vault root). */
	cwd?: string;

	/**
	 * Environment variables for the spawned process (stdio only).
	 * Each has a key, value, and sensitive flag.
	 */
	env?: McpEnvVar[];

	/** Server endpoint URL (sse / streamableHttp only). */
	url?: string;

	/** Custom HTTP headers (sse / streamableHttp only). */
	headers?: McpHeader[];

	/**
	 * Whether the server is disabled.
	 * Disabled servers are not connected on plugin load.
	 * @default false
	 */
	disabled?: boolean;

	/**
	 * Request timeout in seconds for `tools/call` requests to this server.
	 * @default 60
	 */
	timeout?: number;

	/**
	 * Per-tool read/write classification overrides.
	 * Key is the raw tool name (without server namespace prefix).
	 */
	toolClassifications?: Record<string, "read" | "write">;

	/**
	 * Tool names (raw, without server namespace prefix) that are auto-approved
	 * for this server.
	 */
	autoApprove?: string[];
}

// ---------------------------------------------------------------------------
// Runtime types (in-memory only, not persisted)
// ---------------------------------------------------------------------------

/**
 * Connection status state machine.
 *
 * Transitions:
 * - disconnected → connecting (enable toggle / plugin load)
 * - connecting → connected (handshake + tool discovery succeed)
 * - connecting → error (handshake fails, timeout, spawn fails)
 * - connected → disconnected (process exit, network loss, user toggles off)
 * - error → disconnected (user toggles off)
 *
 * @see specs/04-mcp/data-model.md — McpConnectionStatus
 */
export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * MCP ToolAnnotations as defined by the MCP protocol.
 */
export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
	title?: string;
}

/**
 * Represents a single tool discovered from an MCP server via `tools/list`.
 *
 * @see specs/04-mcp/data-model.md — McpDiscoveredTool
 */
export interface McpDiscoveredTool {
	/** Raw tool name as reported by the server (e.g., `query`, `read_file`). */
	name: string;

	/** Tool description from the server. Empty string if not provided. */
	description: string;

	/** JSON Schema for tool input parameters. */
	inputSchema?: Record<string, unknown>;

	/** MCP ToolAnnotations including readOnlyHint, destructiveHint, etc. */
	annotations?: ToolAnnotations;
}

/**
 * Runtime representation of a live connection to an MCP server.
 *
 * @see specs/04-mcp/data-model.md — McpConnection
 */
export interface McpConnection {
	/** The server's slug name (matches key in mcp_servers config). */
	serverName: string;

	/** Reference to the server's persisted configuration. */
	config: McpServerConfig;

	/** Current connection state. */
	status: McpConnectionStatus;

	/** MCP SDK Client instance. Null when disconnected. */
	client: unknown | null;

	/** MCP SDK transport instance. Null when disconnected. */
	transport: unknown | null;

	/** Tools discovered via tools/list. Empty before discovery or on failure. */
	tools: McpDiscoveredTool[];

	/** Error message if status is "error". Null otherwise. */
	error: string | null;
}

/**
 * Discriminated union for MCP tool call result content items.
 * Phase 4.1 extracts only text; image and resource items are counted
 * and a notice is appended.
 *
 * @see specs/04-mcp/data-model.md — McpContentItem
 */
export type McpContentItem =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "resource"; resource: { uri: string; text?: string; blob?: string } };

/**
 * Internal representation of an MCP tools/call response before
 * conversion to ToolResult.
 */
export interface McpToolCallResult {
	content: McpContentItem[];
	isError: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Secrets manager key for an MCP server environment variable.
 * Format: `mcp_env_{serverName}_{key}`
 */
export function mcpEnvSecretKey(serverName: string, key: string): string {
	return `mcp_env_${serverName}_${key}`;
}

/**
 * Secrets manager key for an MCP server HTTP header.
 * Format: `mcp_header_{serverName}_{key}`
 */
export function mcpHeaderSecretKey(serverName: string, key: string): string {
	return `mcp_header_${serverName}_${key}`;
}

/**
 * Regex for validating MCP server names.
 * Must start with alphanumeric, contain only lowercase alphanumeric and hyphens.
 */
export const MCP_SERVER_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/** Maximum length for MCP server names. */
export const MCP_SERVER_NAME_MAX_LENGTH = 50;
