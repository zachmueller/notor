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

import { execSync } from "child_process";

import { Platform } from "obsidian";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import type { NotorSettings } from "../settings";
import type { ToolResult } from "../types";
import type { ContentBlock, ImageMediaType } from "../media/types";
import { getMediaCapabilities } from "../media/capabilities";
import type {
	McpServerConfig,
	McpConnection,
	McpConnectionStatus,
	McpDiscoveredTool,
} from "./mcp-types";
import { mcpEnvSecretKey, mcpHeaderSecretKey } from "./mcp-types";
import type { TaskLaneQueue } from "../queue/task-lane-queue";
import { logger } from "../utils/logger";
import { sanitizeInputSchemaForBedrock } from "../utils/json-schema-sanitizer";
import type { SleepWakeDetector } from "../utils/sleep-wake-detector";

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

/** Stdio reconnect parameters (more conservative than HTTP). */
const STDIO_RECONNECT_INITIAL_DELAY_MS = 2_000;
const STDIO_RECONNECT_MAX_DELAY_MS = 120_000;
const STDIO_RECONNECT_MAX_ATTEMPTS = 5;
const STDIO_CRASH_LOOP_WINDOW_MS = 30_000;
const STDIO_CRASH_LOOP_THRESHOLD = 3;

/** Delay after sleep detection before starting reconnection (ms). */
const SLEEP_RECONNECT_DELAY_MS = 2_000;

/** Image MIME types that can be converted to ContentBlock. */
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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

	/** Per-server exit timestamps for stdio crash-loop detection. */
	private stdioExitTimestamps = new Map<string, number[]>();

	/**
	 * Cached PATH from the user's login shell.
	 *
	 * Obsidian is a GUI app and doesn't inherit the user's full shell PATH,
	 * so tools installed via nvm, Homebrew, etc. are not found when spawning
	 * stdio MCP servers. Populated lazily on first stdio spawn.
	 * Null means "not yet resolved"; empty string means "resolution failed".
	 */
	private _loginShellPath: string | null = null;

	/**
	 * Per-lane FIFO serialization queue for cross-session MCP dispatch.
	 *
	 * When provided, `callTool()` wraps execution via the queue using
	 * `"mcp:{serverName}"` lane keys with `delayMs = 0` (pure serialization).
	 * This prevents concurrent JSON-RPC requests to the same MCP server
	 * from multiple panels.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4c
	 */
	private readonly taskQueue?: TaskLaneQueue;

	constructor(pluginVersion: string, vaultRootPath: string, taskQueue?: TaskLaneQueue) {
		this.pluginVersion = pluginVersion;
		this.vaultRootPath = vaultRootPath;
		this.taskQueue = taskQueue;
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
			serverNames: Object.keys(servers),
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

	/**
	 * Update the settings reference held by McpHub.
	 *
	 * Must be called whenever the plugin replaces its settings object
	 * (e.g. after loadSettings() on new-conversation or after saveSettings()
	 * adds a newly-configured server). Without this, McpHub would hold a
	 * stale reference and fail to find servers added after the last reload.
	 */
	updateSettings(settings: NotorSettings): void {
		log.debug("McpHub settings reference updated", {
			serverNames: Object.keys(settings.mcp_servers ?? {}),
		});
		this.settings = settings;
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

		log.debug("connectServer called", {
			serverName,
			knownServers: Object.keys(this.settings.mcp_servers ?? {}),
		});

		const config = this.settings.mcp_servers?.[serverName];
		if (!config) {
			log.error("Server config not found", {
				serverName,
				knownServers: Object.keys(this.settings.mcp_servers ?? {}),
			});
			return;
		}

		log.info("Connecting to MCP server", {
			serverName,
			type: config.type,
			command: config.command,
			url: config.url,
		});

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

		// Collect stderr lines for error reporting. For stdio servers,
		// transport.stderr is a PassThrough stream available immediately
		// after transport construction. The SDK pipes the process's stderr
		// into it and the 'close' event (which triggers "Connection closed")
		// only fires after all stdio streams have finished — so by the time
		// the catch block runs, any stderr output is already in this buffer.
		const stderrLines: string[] = [];

		try {
			// 1. Create transport
			log.debug("Creating transport", { serverName, type: config.type });
			const transport = await this.createTransport(config);
			log.debug("Transport created", { serverName, type: config.type });

			// 2. Create MCP Client
			const client = new Client(
				{ name: "Notor", version: this.pluginVersion },
				{ capabilities: {} }
			);

			connection.client = client;
			connection.transport = transport;

			// 3. Wire transport close/error handlers + stderr capture
			transport.onclose = () => {
				if (connection.status === "connected") {
					log.info("Transport closed for connected server", { serverName });
					this.handleTransportClose(connection);
				}
			};
			transport.onerror = (error: Error) => {
				log.warn("Transport error", { serverName, error: error.message });
			};

			// Attach stderr listener now (transport.stderr is a PassThrough stream
			// that is non-null immediately for stdio servers configured with
			// stderr: "pipe"). Buffering here allows error messages to include
			// the process's own output when the connection attempt fails.
			if (config.type === "stdio") {
				const stderrStream = (transport as unknown as { stderr?: { on?: (event: string, handler: (data: Buffer) => void) => void } }).stderr;
				if (stderrStream?.on) {
					stderrStream.on("data", (data: Buffer) => {
						const text = data.toString().trim();
						if (text) {
							stderrLines.push(text);
							log.debug("stdio stderr", { serverName, text });
						}
					});
				}
			}

			// 4. Connect client to transport (performs initialize handshake)
			log.info("Starting MCP handshake", { serverName, timeoutMs: HANDSHAKE_TIMEOUT_MS });
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
			this.stdioExitTimestamps.delete(serverName);

			log.info("Server connected", {
				serverName,
				toolCount: connection.tools.length,
			});
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : String(e);
			const stderrSuffix = stderrLines.length > 0
				? `; process output: ${stderrLines.join(" | ")}`
				: "";
			const fullError = errorMsg + stderrSuffix;
			log.error("Connection failed", { serverName, error: fullError });

			// Clean up partial connection
			await this.cleanupConnection(connection);

			this.setStatus(connection, "error", fullError);

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

			connection.tools = (result.tools ?? []).map((tool) => {
				// Normalize MCP-provided schemas into the strict JSON Schema
				// draft-2020-12 subset that Bedrock accepts. A single offending
				// schema otherwise rejects the entire tool-use request.
				const { schema, modifications } = sanitizeInputSchemaForBedrock(
					tool.inputSchema
				);
				if (modifications.length > 0) {
					log.warn("MCP tool schema sanitized for provider compatibility", {
						serverName: connection.serverName,
						toolName: tool.name,
						modifications,
					});
				}
				return {
					name: tool.name,
					description: tool.description ?? "",
					inputSchema: schema as Record<string, unknown>,
					annotations: tool.annotations as McpDiscoveredTool["annotations"],
				};
			});

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
	 * When a `TaskLaneQueue` is injected, tool calls to the same server are
	 * serialized via `"mcp:{serverName}"` lane keys to prevent concurrent
	 * JSON-RPC requests. Returns ToolResult — never throws.
	 *
	 * @see specs/04-mcp/contracts/mcp-tool-dispatch.md
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4c
	 */
	async callTool(
		serverName: string,
		toolName: string,
		toolArguments: Record<string, unknown> | undefined,
		mode: "plan" | "act"
	): Promise<ToolResult> {
		// Validation checks run outside the queue — fast-fail without
		// waiting for other tool calls in the lane.
		const connection = this.connections.get(serverName);

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

		const tool = connection.tools.find((t) => t.name === toolName);
		if (!tool) {
			return {
				tool_name: `${serverName}__${toolName}`,
				success: false,
				result: "",
				error: `Tool '${toolName}' not found on MCP server '${serverName}'.`,
			};
		}

		const execute = () => this.executeCallTool(serverName, toolName, toolArguments, mode, connection);

		return this.taskQueue
			? this.taskQueue.enqueue(`mcp:${serverName}`, execute, 0)
			: execute();
	}

	/**
	 * Execute the actual MCP tool call (connection lookup, timeout, client.callTool,
	 * result extraction). Separated from `callTool()` so the queue wraps only the
	 * network-bound portion.
	 */
	private async executeCallTool(
		serverName: string,
		toolName: string,
		toolArguments: Record<string, unknown> | undefined,
		mode: "plan" | "act",
		connection: McpConnection,
	): Promise<ToolResult> {
		const namespacedName = `${serverName}__${toolName}`;
		const timeoutMs = (connection.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

		// Re-check connection state inside the queue — it may have changed
		// while waiting for the lane.
		if (connection.status !== "connected" || !connection.client) {
			return {
				tool_name: namespacedName,
				success: false,
				result: "",
				error: `MCP server '${serverName}' is unavailable (${connection.status}${connection.error ? `: ${connection.error}` : ""}).`,
			};
		}

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

			return this.extractToolResult(namespacedName, result);
		} catch (e) {
			const errorMsg = e instanceof Error ? e.message : String(e);

			if (errorMsg.includes("timed out") || errorMsg.includes("timeout") || errorMsg.includes("aborted")) {
				log.warn("Tool call timed out", { namespacedName, timeoutMs });
				return {
					tool_name: namespacedName,
					success: false,
					result: "",
					error: `Tool call to '${namespacedName}' timed out after ${connection.config.timeout ?? DEFAULT_TIMEOUT_SECONDS} seconds.`,
				};
			}

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
	 * Extract content from an MCP tool call result.
	 *
	 * Converts MCP ImageContent items to ContentBlock objects when the
	 * active provider supports images. Resources are still omitted with
	 * a notice.
	 *
	 * @see specs/04-mcp/contracts/mcp-tool-dispatch.md — Response Processing
	 */
	private extractToolResult(
		namespacedName: string,
		result: {
			[key: string]: unknown;
			content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			isError?: boolean;
		}
	): ToolResult {
		const textParts: string[] = [];
		const contentBlocks: ContentBlock[] = [];
		let omittedResources = 0;

		const activeId = this.settings?.active_provider ?? "local";
		const providerType = this.settings?.providers.find((p) => p.id === activeId)?.type ?? "local";
		const capabilities = getMediaCapabilities(providerType);

		const content = result.content ?? [];
		for (const item of content) {
			if (item.type === "text") {
				textParts.push(item.text ?? "");
			} else if (item.type === "image") {
				if (capabilities.supportsImages && item.data && item.mimeType && SUPPORTED_IMAGE_MIME_TYPES.has(item.mimeType)) {
					contentBlocks.push({
						type: "image",
						media_type: item.mimeType as ImageMediaType,
						data: item.data,
					});
				} else {
					// Unsupported mime type or provider — append text notice
					textParts.push(`[image: ${item.mimeType ?? "unknown type"} — not supported by current provider]`);
				}
			} else if (item.type === "resource") {
				omittedResources++;
			}
		}

		let output = textParts.join("\n");

		if (contentBlocks.length > 0) {
			output += output ? "\n" : "";
			output += `[${contentBlocks.length} image${contentBlocks.length > 1 ? "s" : ""} included]`;
		}

		// Append omission notices
		if (omittedResources > 0) {
			output += output ? "\n" : "";
			output += `[${omittedResources} resource${omittedResources > 1 ? "s" : ""} omitted]`;
		}

		if (!output) {
			output = "(empty result)";
		}

		return {
			tool_name: namespacedName,
			success: !result.isError,
			result: output,
			...(contentBlocks.length > 0 ? { content_blocks: contentBlocks } : {}),
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
	 * Resolve the user's login shell PATH once and cache it.
	 *
	 * macOS (and Linux) GUI apps like Obsidian launch without running a login
	 * shell, so `process.env.PATH` is a minimal system PATH that omits
	 * Homebrew, nvm, pyenv, and other user-installed runtimes. MCP server
	 * binaries (e.g. `#!/usr/bin/env node`) fail with "No such file or
	 * directory" because `node` isn't on that stripped PATH.
	 *
	 * By running `$SHELL -l -c 'echo $PATH'` once we get the same PATH the
	 * user sees in their terminal, which we then prepend to every stdio spawn.
	 *
	 * Only called on macOS/Linux desktop; Windows GUI apps inherit PATH normally.
	 */
	private resolveLoginShellPath(): string {
		if (this._loginShellPath !== null) {
			return this._loginShellPath;
		}

		try {
			const shell = process.env.SHELL || "/bin/sh";
			const output = execSync(`${shell} -l -c 'echo $PATH'`, {
				encoding: "utf8",
				timeout: 5000,
				// Suppress shell startup output (e.g. from .bashrc echo statements)
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();

			// Use only the last non-empty line — some login shells print
			// banner text before the PATH value.
			const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
			this._loginShellPath = lines[lines.length - 1] ?? process.env.PATH ?? "";

			log.info("Resolved login shell PATH", { shell, path: this._loginShellPath });
		} catch (e) {
			log.warn("Could not resolve login shell PATH — using process PATH", {
				error: String(e),
			});
			this._loginShellPath = process.env.PATH ?? "";
		}

		return this._loginShellPath;
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

		log.debug("Resolving stdio environment", {
			serverName: config.name,
			configuredEnvKeys: (config.env ?? []).map((e) => e.key),
		});

		// Resolve environment variables (system + config + secrets)
		const env = await this.resolveEnvironment(config);

		// Resolve the user's login shell PATH so tools installed via
		// Homebrew, nvm, pyenv, etc. are found when spawning the process.
		// Obsidian is a GUI app and doesn't inherit the full shell PATH.
		const loginPath = this.resolveLoginShellPath();

		// Merge system environment with config env. Filter out undefined values
		// from process.env to satisfy Record<string, string> type.
		const mergedEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v !== undefined) mergedEnv[k] = v;
		}
		// Prepend the login shell PATH so user-installed runtimes take priority.
		// The per-server config env is applied after so it can override PATH too.
		if (loginPath) {
			mergedEnv.PATH = loginPath;
		}
		Object.assign(mergedEnv, env);

		const effectiveCwd = config.cwd || this.vaultRootPath;
		log.info("Spawning stdio process", {
			serverName: config.name,
			command: config.command,
			args: config.args ?? [],
			cwd: effectiveCwd,
			extraEnvKeys: Object.keys(env),
		});

		const transport = new StdioClientTransport({
			command: config.command,
			args: config.args ?? [],
			cwd: effectiveCwd,
			env: mergedEnv,
			stderr: "pipe",
		});

		// Note: stderr listener is attached in connectServer after transport
		// creation so that stderrLines can be included in error messages.
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

		log.debug("Creating streamable HTTP transport", {
			serverName: config.name,
			url: config.url,
			headerKeys: Object.keys(headers),
		});

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
			this.setStatus(connection, "disconnected");
			if (wasConnected) {
				log.info("stdio server disconnected (process exited)", { serverName });

				// Crash-loop detection: if too many exits in a short window, stop retrying
				const timestamps = this.stdioExitTimestamps.get(serverName) ?? [];
				timestamps.push(Date.now());
				const cutoff = Date.now() - STDIO_CRASH_LOOP_WINDOW_MS;
				const recent = timestamps.filter(t => t > cutoff);
				this.stdioExitTimestamps.set(serverName, recent);

				if (recent.length >= STDIO_CRASH_LOOP_THRESHOLD) {
					log.warn("stdio server crash loop detected", {
						serverName,
						exitsInWindow: recent.length,
					});
					this.setStatus(connection, "error",
						`Process exited ${recent.length} times in ${STDIO_CRASH_LOOP_WINDOW_MS / 1000}s — suspected crash loop.`
					);
				} else {
					this.scheduleStdioReconnect(serverName);
				}
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
	 * Schedule auto-reconnect for a stdio server with conservative backoff.
	 */
	private scheduleStdioReconnect(serverName: string): void {
		const attempts = this.reconnectAttempts.get(serverName) ?? 0;

		if (attempts >= STDIO_RECONNECT_MAX_ATTEMPTS) {
			log.warn("stdio server max reconnect attempts reached", { serverName, attempts });
			const connection = this.connections.get(serverName);
			if (connection) {
				this.setStatus(connection, "error",
					`Process exited — failed to reconnect after ${attempts} attempts.`
				);
			}
			return;
		}

		const delay = Math.min(
			STDIO_RECONNECT_INITIAL_DELAY_MS * Math.pow(RECONNECT_BACKOFF_FACTOR, attempts),
			STDIO_RECONNECT_MAX_DELAY_MS
		);

		log.debug("Scheduling stdio reconnect", { serverName, attempt: attempts + 1, delayMs: delay });

		const timer = setTimeout(() => {
			void (async () => {
				this.reconnectTimers.delete(serverName);

				const config = this.settings?.mcp_servers?.[serverName];
				if (!config || config.disabled) {
					log.debug("stdio reconnect cancelled — server disabled or removed", { serverName });
					return;
				}

				const currentConnection = this.connections.get(serverName);
				if (currentConnection?.status === "connected") {
					log.debug("stdio reconnect cancelled — already connected", { serverName });
					return;
				}

				this.reconnectAttempts.set(serverName, attempts + 1);

				try {
					await this.connectServer(serverName);
				} catch (e) {
					log.warn("stdio reconnect attempt failed", {
						serverName,
						attempt: attempts + 1,
						error: String(e),
					});
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
	// Sleep/wake detection
	// -----------------------------------------------------------------------

	/**
	 * Subscribe MCP reconnection to a shared {@link SleepWakeDetector}.
	 *
	 * On a detected wake, eligible servers are reconnected after a short settle
	 * delay (so the network stack can come back first). The detector owns the
	 * heartbeat timer; this only registers the response.
	 */
	startSleepDetection(detector: SleepWakeDetector): void {
		detector.onWake(() => {
			setTimeout(() => this._reconnectAllAfterSleep(), SLEEP_RECONNECT_DELAY_MS);
		});
	}

	private _reconnectAllAfterSleep(): void {
		if (!this.settings) return;

		const servers = this.settings.mcp_servers ?? {};
		const eligible: string[] = [];

		for (const [serverName, config] of Object.entries(servers)) {
			if (config.disabled) continue;
			const status = this.connections.get(serverName)?.status ?? "disconnected";
			if (status === "disconnected" || status === "error") {
				eligible.push(serverName);
			}
		}

		if (eligible.length === 0) return;

		log.info("Reconnecting MCP servers after sleep/wake", { servers: eligible });

		for (const serverName of eligible) {
			this.cancelReconnect(serverName);
			this.connectServer(serverName).catch((e) => {
				log.warn("Post-wake reconnect failed", { serverName, error: String(e) });
			});
		}
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
		this.stdioExitTimestamps.clear();
		this.statusCallbacks = [];
		this.settings = null;
		this.secretStorage = null;

		log.info("McpHub disposed");
	}
}
