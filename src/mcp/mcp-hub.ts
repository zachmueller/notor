/**
 * MCP connection hub — manages all MCP server connections.
 *
 * Singleton class responsible for:
 * - Connecting/disconnecting MCP servers (ARCH-002)
 * - Transport factory (stdio/Streamable HTTP)
 * - Credential resolution from secrets manager
 * - Connection status tracking and notifications
 * - Process lifecycle management for stdio
 * - Reconnection logic for HTTP transports
 * - Tool discovery via tools/list (ARCH-003)
 * - callTool with _meta.notor_mode injection (ARCH-003)
 *
 * @see specs/04-mcp/contracts/mcp-connection-lifecycle.md
 * @see specs/04-mcp/data-model.md — McpConnection, McpHub
 */

import { Platform } from "obsidian";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import type { NotorSettings } from "../settings";
import type { ToolResult } from "../types";
import type {
	McpServerConfig,
	McpConnection,
	McpConnectionStatus,
	McpDiscoveredTool,
} from "./mcp-types";
import { mcpEnvSecretKey, mcpHeaderSecretKey } from "./mcp-types";
import { logger } from "../utils/logger";

const log = logger("McpHub");

/** Handshake timeout in milliseconds (30 seconds per spec). */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** Default tool call timeout in seconds if not configured per-server. */
const DEFAULT_TIMEOUT_SECONDS = 60;

/** HTTP reconnect backoff parameters. */
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_BACKOFF_FACTOR = 2;
const RECONNECT_MAX_CONSECUTIVE_FAILURES = 5;

/** Obsidian SecretStorage interface (minimal — just what we need). */
interface SecretStorage {
	get(key: string): Promise<string | undefined>;
}

/** Status change callback signature. */
export type StatusChangeCallback = (
	serverName: string,
	status: McpConnectionStatus,
	error?: string
) => void;

/**
 * Central MCP connection manager.
 *
 * Manages all MCP server connections — connect, disconnect, tool discovery,
 * tool calls, and lifecycle cleanup. Instantiated once per plugin lifecycle.
 *
 * @see specs/04-mcp/contracts/mcp-connection-lifecycle.md
 */
export class McpHub {
	/** Active connections keyed by server name. */
	private connections = new Map<string, McpConnection>();

	/** Status change callbacks. */
	private statusCallbacks: StatusChangeCallback[] = [];

	/** Plugin settings reference (read-only). */
	private settings: NotorSettings | null = null;

	/** Obsidian SecretStorage for credential resolution. */
	private secretStorage: SecretStorage | null = null;

	/** Plugin version string for MCP client info. */
	private pluginVersion: string;

	/** Vault root path for stdio cwd default. */
	private vaultRootPath: string;

	/** Per-server reconnect state (for HTTP transports). */
	private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private reconnectAttempts = new Map<string, number>();

	constructor(pluginVersion: string, vaultRootPath: string) {
		this.pluginVersion = pluginVersion;
		this.vaultRootPath = vaultRootPath;
	}

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------

	/**
	 * Initialize hub and connect to all enabled servers.
	 *
	 * Non-blocking — fires off connections asynchronously so plugin load
	 * completes immediately.
	 */
	initialize(settings: NotorSettings, secretStorage: SecretStorage): Promise<void> {
		this.settings = settings;
		this.secretStorage = secretStorage;

		const servers = settings.mcp_servers ?? {};
		const enabledServers = Object.entries(servers).filter(
			([, config]) => !config.disabled
		);

		log.info("Initializing McpHub", {
			totalServers: Object.keys(servers).length,
			enabledServers: enabledServers.length,
		});

		// Fire off all connections asynchronously — do NOT await
		for (const [serverName] of enabledServers) {
			this.connectServer(serverName).catch((e) => {
				log.error("Failed to connect server during initialization", {
					serverName,
					error: String(e),
				});
			});
		}
		return Promise.resolve();
	}

	// -----------------------------------------------------------------------
	// Connection management (ARCH-002)
	// -----------------------------------------------------------------------

	/**
	 * Connect to a single server by name.
	 *
	 * Idempotent — disconnects first if already connected.
	 */
	async connectServer(serverName: string): Promise<void> {
		if (!this.settings) {
			log.error("Cannot connect — McpHub not initialized", { serverName });
			return;
		}

		const config = this.settings.mcp_servers?.[serverName];
		if (!config) {
			log.error("Server config not found", { serverName });
			return;
		}

		// Disconnect first if already connected
		const existing = this.connections.get(serverName);
		if (existing && existing.status !== "disconnected") {
			await this.disconnectServer(serverName);
		}

		// Cancel any pending reconnect
		this.cancelReconnect(serverName);

		// Create connection record
		const connection: McpConnection = {
			serverName,
			config,
			status: "disconnected",
			client: null,
			transport: null,
			tools: [],
			error: null,
		};
		this.connections.set(serverName, connection);

		// Set status to connecting
		this.setStatus(connection, "connecting");

		try {
			// 1. Create transport
			const transport = await this.createTransport(config);

			// 2. Create MCP Client
			const client = new Client(
				{ name: "Notor", version: this.pluginVersion },
				{ capabilities: {} }
			);

			connection.client = client;
			connection.transport = transport;

			// 3. Wire transport close/error handlers
			transport.onclose = () => {
				if (connection.status === "connected") {
					log.info("Transport closed for connected server", { serverName });
					this.handleTransportClose(connection);
				}
			};
			transport.onerror = (error: Error) => {
				log.warn("Transport error", { serverName, error: error.message });
			};

			// 4. Connect client to transport (performs initialize handshake)
			await client.connect(transport, { timeout: HANDSHAKE_TIMEOUT_MS });

			log.info("MCP handshake complete", {
				serverName,
				serverInfo: client.getServerVersion(),
			});

			// 5. Discover tools
			await this.discoverTools(connection);

			// 6. Set connected
			this.setStatus(connection, "connected");
			this.reconnectAttempts.delete(serverName);

			log.info("Server connected", {
				serverName,
				toolCount: connection.tools.length,
			});
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : String(e);
			log.error("Connection failed", { serverName, error: errorMsg });

			// Clean up partial connection
			await this.cleanupConnection(connection);

			this.setStatus(connection, "error", errorMsg);

			// Schedule auto-reconnect for HTTP transports
			if (config.type === "sse" || config.type === "streamableHttp") {
				this.scheduleReconnect(serverName);
			}
		}
	}

	/**
	 * Disconnect a single server by name.
	 *
	 * Safe to call if already disconnected.
	 */
	async disconnectServer(serverName: string): Promise<void> {
		const connection = this.connections.get(serverName);
		if (!connection || connection.status === "disconnected") {
			return;
		}

		this.cancelReconnect(serverName);

		await this.cleanupConnection(connection);

		connection.tools = [];
		connection.status = "disconnected";
		connection.error = null;

		this.emitStatusChange(serverName, "disconnected");

		log.info("Server disconnected", { serverName });
	}

	/**
	 * Get connection state for a server.
	 */
	getConnection(serverName: string): McpConnection | undefined {
		return this.connections.get(serverName);
	}

	/**
	 * Get all connections (for UI display).
	 */
	getAllConnections(): McpConnection[] {
		return Array.from(this.connections.values());
	}

	// -----------------------------------------------------------------------
	// Tool discovery (ARCH-003)
	// -----------------------------------------------------------------------

	/**
	 * Discover tools from a connected server via tools/list.
	 *
	 * Called after successful handshake and on refreshTools().
	 * If tools/list fails, the server remains connected with an empty
	 * tool list and a warning — does not block connection.
	 */
	private async discoverTools(connection: McpConnection): Promise<void> {
		if (!connection.client) return;

		try {
			const timeoutMs = (connection.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
			const result = await connection.client.listTools(
				{},
				{ timeout: timeoutMs }
			);

			connection.tools = (result.tools ?? []).map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
				annotations: tool.annotations as McpDiscoveredTool["annotations"],
			}));

			log.debug("Tools discovered", {
				serverName: connection.serverName,
				tools: connection.tools.map((t) => t.name),
			});
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : String(e);
			log.warn("Tool discovery failed — server connected with empty tool list", {
				serverName: connection.serverName,
				error: errorMsg,
			});
			connection.tools = [];
			// Set error message but don't change status — server is still connected
			connection.error = `Tool discovery failed: ${errorMsg}`;
		}
	}

	/**
	 * Re-fetch tool list for a connected server.
	 */
	async refreshTools(serverName: string): Promise<void> {
		const connection = this.connections.get(serverName);
		if (!connection || connection.status !== "connected" || !connection.client) {
			log.warn("Cannot refresh tools — server not connected", { serverName });
			return;
		}

		const oldTools = connection.tools;
		await this.discoverTools(connection);

		// Emit status change so listeners can update tool registrations
		this.emitStatusChange(serverName, "connected");

		log.info("Tools refreshed", {
			serverName,
			oldCount: oldTools.length,
			newCount: connection.tools.length,
		});
	}

	/**
	 * Get all discovered tools across all connected servers.
	 */
	getAllDiscoveredTools(): { serverName: string; tool: McpDiscoveredTool }[] {
		const result: { serverName: string; tool: McpDiscoveredTool }[] = [];
		for (const connection of this.connections.values()) {
			if (connection.status === "connected") {
				for (const tool of connection.tools) {
					result.push({ serverName: connection.serverName, tool });
				}
			}
		}
		return result;
	}

	// -----------------------------------------------------------------------
	// Tool calling (ARCH-003)
	// -----------------------------------------------------------------------

	/**
	 * Call a tool on a connected server.
	 *
	 * Injects `_meta.notor_mode` on every request per FR-58.
	 * Returns ToolResult — never throws.
	 *
	 * @see specs/04-mcp/contracts/mcp-tool-dispatch.md
	 */
	async callTool(
		serverName: string,
		toolName: string,
		toolArguments: Record<string, unknown> | undefined,
		mode: "plan" | "act"
	): Promise<ToolResult> {
		const connection = this.connections.get(serverName);

		// Validate connection state
		if (!connection) {
			return {
				tool_name: `${serverName}__${toolName}`,
				success: false,
				result: "",
				error: `MCP server '${serverName}' is not configured.`,
			};
		}
		if (connection.status !== "connected" || !connection.client) {
			return {
				tool_name: `${serverName}__${toolName}`,
				success: false,
				result: "",
				error: `MCP server '${serverName}' is unavailable (${connection.status}${connection.error ? `: ${connection.error}` : ""}).`,
			};
		}

		// Validate tool exists on this server
		const tool = connection.tools.find((t) => t.name === toolName);
		if (!tool) {
			return {
				tool_name: `${serverName}__${toolName}`,
				success: false,
				result: "",
				error: `Tool '${toolName}' not found on MCP server '${serverName}'.`,
			};
		}

		const namespacedName = `${serverName}__${toolName}`;
		const timeoutMs = (connection.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

		try {
			// Send tools/call with _meta.notor_mode injection (FR-58)
			const result = await connection.client.callTool(
				{
					name: toolName,
					arguments: toolArguments ?? {},
					_meta: {
						notor_mode: mode,
					},
				},
				CallToolResultSchema,
				{ timeout: timeoutMs }
			);

			// Extract text-only result
			return this.extractToolResult(namespacedName, result);
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : String(e);

			// Check for timeout
			if (errorMsg.includes("timed out") || errorMsg.includes("timeout") || errorMsg.includes("aborted")) {
				log.warn("Tool call timed out", { namespacedName, timeoutMs });
				return {
					tool_name: namespacedName,
					success: false,
					result: "",
					error: `Tool call to '${namespacedName}' timed out after ${connection.config.timeout ?? DEFAULT_TIMEOUT_SECONDS} seconds.`,
				};
			}

			// Check for transport error
			log.error("Tool call failed", { namespacedName, error: errorMsg });
			return {
				tool_name: namespacedName,
				success: false,
				result: "",
				error: `MCP server '${serverName}' connection error: ${errorMsg}`,
			};
		}
	}

	/**
	 * Extract text-only content from an MCP tool call result.
	 *
	 * Phase 4.1: only TextContent items extracted. Images and resources
	 * counted and a notice appended.
	 *
	 * @see specs/04-mcp/contracts/mcp-tool-dispatch.md — Response Processing
	 */
	private extractToolResult(
		namespacedName: string,
		result: { [key: string]: unknown; content?: Array<{ type: string; text?: string }>; isError?: boolean }
	): ToolResult {
		const textParts: string[] = [];
		let omittedImages = 0;
		let omittedResources = 0;

		const content = result.content ?? [];
		for (const item of content) {
			if (item.type === "text") {
				textParts.push(item.text ?? "");
			} else if (item.type === "image") {
				omittedImages++;
			} else if (item.type === "resource") {
				omittedResources++;
			}
		}

		let output = textParts.join("\n");

		// Append omission notices
		const omissions: string[] = [];
		if (omittedImages > 0) {
			omissions.push(`${omittedImages} image${omittedImages > 1 ? "s" : ""} omitted`);
		}
		if (omittedResources > 0) {
			omissions.push(`${omittedResources} resource${omittedResources > 1 ? "s" : ""} omitted`);
		}
		if (omissions.length > 0) {
			output += `\n[${omissions.join(", ")}]`;
		}

		if (!output) {
			output = "(empty result)";
		}

		return {
			tool_name: namespacedName,
			success: !result.isError,
			result: output,
		};
	}

	// -----------------------------------------------------------------------
	// Status change notifications
	// -----------------------------------------------------------------------

	/**
	 * Register a callback for connection status changes.
	 *
	 * @returns An unsubscribe function. Call it to remove the callback and
	 *          prevent accumulation across repeated render/destroy cycles
	 *          (e.g. McpStatusIndicator open/close).
	 */
	onStatusChange(callback: StatusChangeCallback): () => void {
		this.statusCallbacks.push(callback);
		return () => {
			const idx = this.statusCallbacks.indexOf(callback);
			if (idx !== -1) {
				this.statusCallbacks.splice(idx, 1);
			}
		};
	}

	/**
	 * Set connection status and emit change event.
	 */
	private setStatus(
		connection: McpConnection,
		status: McpConnectionStatus,
		error?: string
	): void {
		connection.status = status;
		connection.error = error ?? null;
		this.emitStatusChange(connection.serverName, status, error);
	}

	/**
	 * Emit a status change event to all registered callbacks.
	 */
	private emitStatusChange(
		serverName: string,
		status: McpConnectionStatus,
		error?: string
	): void {
		for (const callback of this.statusCallbacks) {
			try {
				callback(serverName, status, error);
			} catch (e) {
				log.error("Status change callback error", { serverName, error: String(e) });
			}
		}
	}

	// -----------------------------------------------------------------------
	// Transport factory
	// -----------------------------------------------------------------------

	/**
	 * Create the appropriate transport based on server config type.
	 */
	private async createTransport(config: McpServerConfig): Promise<import("@modelcontextprotocol/sdk/shared/transport.js").Transport> {
		switch (config.type) {
			case "stdio":
				return this.createStdioTransport(config);
			case "sse":
				return this.createStreamableHttpTransport(config);
			case "streamableHttp":
				return this.createStreamableHttpTransport(config);
			default:
				throw new Error(`Unsupported transport type: ${config.type as string}`);
		}
	}

	/**
	 * Create an stdio transport.
	 *
	 * Guarded behind Platform.isDesktopApp — returns error on mobile.
	 */
	private async createStdioTransport(config: McpServerConfig): Promise<StdioClientTransport> {
		if (!Platform.isDesktopApp) {
			throw new Error("stdio MCP servers require the Obsidian desktop app.");
		}

		if (!config.command) {
			throw new Error("stdio transport requires a command.");
		}

		// Resolve environment variables (system + config + secrets)
		const env = await this.resolveEnvironment(config);

		// Merge system environment with config env. Filter out undefined values
		// from process.env to satisfy Record<string, string> type.
		const mergedEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v !== undefined) mergedEnv[k] = v;
		}
		Object.assign(mergedEnv, env);

		const transport = new StdioClientTransport({
			command: config.command,
			args: config.args ?? [],
			cwd: config.cwd || this.vaultRootPath,
			env: mergedEnv,
			stderr: "pipe",
		});

		// Capture stderr for logging once transport is started
		const serverName = config.name;
		const stderrStream = transport.stderr;
		if (stderrStream) {
			stderrStream.on("data", (data: Buffer) => {
				const text = data.toString().trim();
				if (text) {
					log.debug("stdio stderr", { serverName, text });
				}
			});
		}

		return transport;
	}

	/**
	 * Create a Streamable HTTP transport.
	 *
	 * Includes Cline's 404→405 compatibility shim for servers that
	 * incorrectly return 404 instead of 405 when they don't support
	 * SSE streaming on the GET endpoint.
	 */
	private async createStreamableHttpTransport(config: McpServerConfig): Promise<StreamableHTTPClientTransport> {
		if (!config.url) {
			throw new Error("Streamable HTTP transport requires a URL.");
		}

		const headers = await this.resolveHeaders(config);

		return new StreamableHTTPClientTransport(new URL(config.url), {
			requestInit: { headers },
		});
	}

	// -----------------------------------------------------------------------
	// Credential resolution
	// -----------------------------------------------------------------------

	/**
	 * Resolve environment variables for an stdio server.
	 *
	 * Non-sensitive values come from config; sensitive values from SecretStorage.
	 */
	private async resolveEnvironment(config: McpServerConfig): Promise<Record<string, string>> {
		const env: Record<string, string> = {};

		for (const envVar of config.env ?? []) {
			if (envVar.sensitive && this.secretStorage) {
				const value = await this.secretStorage.get(
					mcpEnvSecretKey(config.name, envVar.key)
				);
				if (value) {
					env[envVar.key] = value;
				}
			} else {
				env[envVar.key] = envVar.value;
			}
		}

		return env;
	}

	/**
	 * Resolve HTTP headers for an HTTP-transport server.
	 *
	 * Non-sensitive values come from config; sensitive values from SecretStorage.
	 */
	private async resolveHeaders(config: McpServerConfig): Promise<Record<string, string>> {
		const headers: Record<string, string> = {};

		for (const header of config.headers ?? []) {
			if (header.sensitive && this.secretStorage) {
				const value = await this.secretStorage.get(
					mcpHeaderSecretKey(config.name, header.key)
				);
				if (value) {
					headers[header.key] = value;
				}
			} else {
				headers[header.key] = header.value;
			}
		}

		return headers;
	}

	// -----------------------------------------------------------------------
	// Reconnection logic (HTTP transports)
	// -----------------------------------------------------------------------

	/**
	 * Handle transport close for a connected server.
	 *
	 * stdio: mark as disconnected, no auto-reconnect.
	 * HTTP: schedule auto-reconnect with exponential backoff.
	 */
	private handleTransportClose(connection: McpConnection): void {
		const serverName = connection.serverName;
		const wasConnected = connection.status === "connected";

		// Clean up client state
		connection.client = null;
		connection.transport = null;

		if (connection.config.type === "stdio") {
			// stdio: mark as disconnected, no auto-reconnect
			this.setStatus(connection, "disconnected");
			if (wasConnected) {
				log.info("stdio server disconnected (process exited)", { serverName });
			}
		} else {
			// HTTP: auto-reconnect
			this.setStatus(connection, "disconnected");
			this.scheduleReconnect(serverName);
		}
	}

	/**
	 * Schedule an auto-reconnect attempt with exponential backoff.
	 */
	private scheduleReconnect(serverName: string): void {
		const attempts = this.reconnectAttempts.get(serverName) ?? 0;
		const delay = Math.min(
			RECONNECT_INITIAL_DELAY_MS * Math.pow(RECONNECT_BACKOFF_FACTOR, attempts),
			RECONNECT_MAX_DELAY_MS
		);

		log.debug("Scheduling reconnect", { serverName, attempt: attempts + 1, delayMs: delay });

		const timer = setTimeout(() => {
			void (async () => {
				this.reconnectTimers.delete(serverName);

				// Check server is still configured and not manually disabled
				const config = this.settings?.mcp_servers?.[serverName];
				if (!config || config.disabled) {
					log.debug("Reconnect cancelled — server disabled or removed", { serverName });
					return;
				}

				const currentConnection = this.connections.get(serverName);
				if (currentConnection?.status === "connected") {
					log.debug("Reconnect cancelled — already connected", { serverName });
					return;
				}

				this.reconnectAttempts.set(serverName, attempts + 1);

				try {
					await this.connectServer(serverName);
				} catch (e) {
					log.warn("Reconnect attempt failed", {
						serverName,
						attempt: attempts + 1,
						error: String(e),
					});

					// After N consecutive failures, set to error state
					// (reconnection continues in background)
					if (attempts + 1 >= RECONNECT_MAX_CONSECUTIVE_FAILURES) {
						const connection = this.connections.get(serverName);
						if (connection && connection.status !== "connected") {
							this.setStatus(
								connection,
								"error",
								`Connection failed after ${attempts + 1} attempts. Retrying in background.`
							);
						}
					}
				}
			})();
		}, delay);

		this.reconnectTimers.set(serverName, timer);
	}

	/**
	 * Cancel any pending reconnect timer for a server.
	 */
	private cancelReconnect(serverName: string): void {
		const timer = this.reconnectTimers.get(serverName);
		if (timer) {
			clearTimeout(timer);
			this.reconnectTimers.delete(serverName);
		}
		this.reconnectAttempts.delete(serverName);
	}

	// -----------------------------------------------------------------------
	// Cleanup
	// -----------------------------------------------------------------------

	/**
	 * Clean up a single connection's resources.
	 *
	 * Closes transport (triggers process termination for stdio).
	 */
	private async cleanupConnection(connection: McpConnection): Promise<void> {
		try {
			if (connection.transport) {
				await connection.transport.close();
			}
		} catch (e) {
			log.debug("Transport close error (ignored)", {
				serverName: connection.serverName,
				error: String(e),
			});
		}
		connection.client = null;
		connection.transport = null;
	}

	/**
	 * Clean up all connections and resources. Called on plugin unload.
	 */
	async dispose(): Promise<void> {
		log.info("Disposing McpHub", { connectionCount: this.connections.size });

		// Cancel all pending reconnect timers
		for (const [serverName] of this.reconnectTimers) {
			this.cancelReconnect(serverName);
		}

		// Disconnect all servers in parallel
		await Promise.allSettled(
			Array.from(this.connections.keys()).map((name) => this.disconnectServer(name))
		);

		this.connections.clear();
		this.statusCallbacks = [];
		this.settings = null;
		this.secretStorage = null;

		log.info("McpHub disposed");
	}
}
