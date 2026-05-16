/**
 * Tool dispatcher — sits between LLM response parsing and tool execution.
 *
 * Enforces Plan/Act mode, auto-approve settings, and routes tool calls
 * to the correct tool implementation. Emits events for UI rendering.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — dispatch flow
 * @see specs/01-mvp/spec.md — FR-14 (Plan/Act), FR-15 (auto-approve)
 */

import type { ConversationMode, ToolCall, ToolResult } from "../types";
import type { StreamChunk } from "../providers/provider";
import type { NotorSettings } from "../settings";
import type { EffectiveToolConfig } from "../tool-config/types";
import type { ToolExecuteOptions, ToolSessionContext } from "../tools/tool";
import { isDomainBlocked } from "../utils/domain-denylist";
import { enforcePathConstraints } from "../tool-config/path-enforcer";
import { resolveAutoApprove } from "../personas/auto-approve-resolver";
import { isMcpTool, McpRegisteredTool } from "../mcp/mcp-tool-adapter";
import { evaluateToolPolicy, type ToolPolicyContext } from "./tool-policy";
import { logger } from "../utils/logger";

const log = logger("ToolDispatcher");

// ---------------------------------------------------------------------------
// MCP auto-approve resolution (FEAT-002)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective auto-approve decision for an MCP tool call.
 *
 * MCP auto-approve precedence:
 * 1. Server-level: raw tool name (without namespace) in `McpServerConfig.autoApprove[]` → true
 * 2. Global default: false (all MCP tools require manual approval unless configured)
 *
 * Per-persona overrides removed in Phase 4b (CLEAN-001) — now handled by
 * `<notor_tool_config>` via the effective config path.
 *
 * @param tool - The McpRegisteredTool instance (exposes server config and raw name)
 * @returns true if auto-approved, false if manual approval required
 *
 * @see specs/04-mcp/tasks.md — FEAT-002
 */
function resolveMcpAutoApprove(
	tool: McpRegisteredTool,
): boolean {
	// 1. Server-level: check McpServerConfig.autoApprove array (raw tool name)
	const config = tool.getServerConfig();
	const rawToolName = tool.getRawToolName();
	if (config.autoApprove && config.autoApprove.includes(rawToolName)) {
		return true;
	}

	// 2. Global default: require approval for all MCP tools
	return false;
}

/** Tool interface for the dispatcher (minimal — not the full tool registry). */
export interface DispatchableTool {
	name: string;
	mode: "read" | "write";
	internal?: boolean;
	execute(params: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolResult>;
}

/** Callback for requesting user approval of a tool call. */
export type ApprovalCallback = (toolCall: ToolCall, abortSignal?: AbortSignal, messageId?: string, autoApproved?: boolean) => Promise<"approved" | "rejected">;

/** Events emitted by the dispatcher for UI updates. */
export interface DispatcherEvents {
	/** A tool call has started (parsed from LLM stream). */
	onToolCallStarted?: (toolCall: ToolCall, messageId: string) => void;
	/** A tool call result has been received. */
	onToolCallResult?: (toolCall: ToolCall, result: ToolResult, messageId: string) => void;
	/** A tool call status has changed (e.g., pending → approved). */
	onToolCallStatusChanged?: (toolCall: ToolCall, messageId: string) => void;
}

/**
 * Central dispatcher for tool calls between the LLM and tool implementations.
 */
export class ToolDispatcher {
	/** Registered tools keyed by name. */
	private tools = new Map<string, DispatchableTool>();

	/** Auto-approve settings per tool name (global defaults). */
	private autoApprove: Record<string, boolean> = {};

	/** Effective tool config from `<notor_tool_config>` merge (null = use global defaults). */
	private effectiveToolConfig: EffectiveToolConfig | null = null;

	/** Currently active persona name (null = no persona). */
	private activePersonaName: string | null = null;

	/** Plugin settings (for tool-specific pre-execution checks). */
	private settings?: NotorSettings;

	/** Vault root path for working directory validation. */
	private vaultRootPath?: string;

	/** Optional resolver for vault note paths (used by path enforcement). */
	private resolveVaultPath?: (path: string) => string | null;

	/**
	 * Callback for requesting user approval.
	 *
	 * Used by sub-agent dispatchers (each sub-agent run creates its own
	 * ToolDispatcher with its own approval callback). For the shared
	 * plugin-level dispatcher, approval is passed per-call via sessions —
	 * this field is not set by main.ts.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4e
	 */
	private approvalCallback?: ApprovalCallback;

	/** Event handlers for UI updates. */
	private events: DispatcherEvents = {};

	/** When true, tools execute with note-opener side effects suppressed. */
	private silentMode = false;

	/** Temp output spiller for dispatcher-level spillover of large tool results. */
	private spiller?: import("../shell/temp-output-spiller").TempOutputSpiller;

	// -----------------------------------------------------------------------
	// Configuration
	// -----------------------------------------------------------------------

	/** Register a tool for dispatch. */
	registerTool(tool: DispatchableTool): void {
		this.tools.set(tool.name, tool);
		log.debug("Registered tool", { name: tool.name, mode: tool.mode });
	}

	/**
	 * Unregister a tool by name.
	 *
	 * Used to remove MCP tools when servers disconnect or tools are
	 * removed on refresh. Safe to call if the tool is not registered.
	 *
	 * @returns true if the tool was found and removed, false otherwise
	 * @see specs/04-mcp/tasks.md — FEAT-004
	 */
	unregisterTool(name: string): boolean {
		const existed = this.tools.delete(name);
		if (existed) {
			log.debug("Unregistered tool", { name });
		}
		return existed;
	}

	/** Update auto-approve settings. */
	setAutoApprove(settings: Record<string, boolean>): void {
		this.autoApprove = { ...settings };
	}

	/** Update plugin settings reference. */
	setSettings(settings: NotorSettings): void {
		this.settings = settings;
	}

	/** Set the vault root path for working directory validation. */
	setVaultRootPath(path: string): void {
		this.vaultRootPath = path;
	}

	/** Set the vault path resolver for path constraint enforcement. */
	setResolveVaultPath(fn: (path: string) => string | null): void {
		this.resolveVaultPath = fn;
	}

	/**
	 * Set the approval callback for manual approval.
	 *
	 * Used by sub-agent dispatchers (each sub-agent creates its own
	 * ToolDispatcher per-run). The shared plugin-level dispatcher does
	 * NOT use this — approval is passed per-call via sessions.
	 */
	setApprovalCallback(callback: ApprovalCallback): void {
		this.approvalCallback = callback;
	}

	/** Set event handlers for UI updates. */
	setEvents(events: DispatcherEvents): void {
		this.events = events;
	}

	/** Suppress editor-open side effects on all tools dispatched through this instance. */
	setSilentMode(silent: boolean): void {
		this.silentMode = silent;
	}

	/** Set the temp output spiller for dispatcher-level spillover of large results. */
	setSpiller(spiller: import("../shell/temp-output-spiller").TempOutputSpiller | undefined): void {
		this.spiller = spiller;
	}

	/**
	 * Set the currently active persona name.
	 *
	 * Called on plugin load with `settings.active_persona` (or null if
	 * empty), and whenever the user switches personas via the persona picker.
	 * Changes take effect on the next `dispatch()` call.
	 *
	 * @param name - Active persona name, or null for "no persona"
	 * @see specs/03-workflows-personas/tasks/group-b-tasks.md — B-003
	 */
	setActivePersonaName(name: string | null): void {
		this.activePersonaName = name;
		log.debug("Updated active persona for auto-approve", { persona: name });
	}

	/**
	 * Set the effective tool config from `<notor_tool_config>` merge.
	 *
	 * When set, the dispatcher uses this config for enabled checks,
	 * auto-approve resolution, and path enforcement. When null, the
	 * dispatcher falls back to existing global defaults.
	 *
	 * @param config - Merged effective config, or null to revert to defaults
	 * @see specs/04b-tool-toggle/spec.md — FR-83, FR-84
	 */
	setEffectiveToolConfig(config: EffectiveToolConfig | null): void {
		this.effectiveToolConfig = config;
		log.debug("Updated effective tool config", {
			active: config !== null,
			toolCount: config ? Object.keys(config.tools).length : 0,
		});
	}

	// -----------------------------------------------------------------------
	// Tool call parsing from LLM stream
	// -----------------------------------------------------------------------

	/**
	 * Parse tool call requests from accumulated StreamChunk events.
	 *
	 * The LLM stream emits tool_call_start, tool_call_delta, and
	 * tool_call_end events. This method accumulates the partial JSON
	 * from deltas and returns the completed tool call.
	 */
	parseToolCallFromChunks(chunks: StreamChunk[]): {
		id: string;
		toolName: string;
		parameters: Record<string, unknown>;
	} | null {
		let id = "";
		let toolName = "";
		let jsonAccumulator = "";
		let ended = false;

		for (const chunk of chunks) {
			if (chunk.type === "tool_call_start") {
				id = chunk.id;
				toolName = chunk.tool_name;
			} else if (chunk.type === "tool_call_delta") {
				jsonAccumulator += chunk.partial_json;
			} else if (chunk.type === "tool_call_end") {
				ended = true;
			}
		}

		if (!ended || !id || !toolName) {
			return null;
		}

		let parameters: Record<string, unknown> = {};
		try {
			if (jsonAccumulator.trim()) {
				parameters = JSON.parse(jsonAccumulator);
			}
		} catch (e) {
			log.warn("Failed to parse tool call parameters", {
				toolName,
				json: jsonAccumulator,
				error: String(e),
			});
			return null;
		}

		return { id, toolName, parameters };
	}

	// -----------------------------------------------------------------------
	// Dispatch
	// -----------------------------------------------------------------------

	/**
	 * Dispatch a tool call through the approval and execution pipeline.
	 *
	 * Follows the dispatch flow from contracts/tool-schemas.md:
	 * 1. Look up tool by name
	 * 2. Check Plan/Act mode
	 * 3. Check auto-approve
	 * 4. Execute and return result
	 *
	 * @param toolName - Name of the tool to invoke
	 * @param parameters - Tool parameters from the LLM
	 * @param mode - Current Plan/Act mode
	 * @param messageId - ID of the tool_call message (for events)
	 * @returns Tool result to send back to the LLM
	 */
	async dispatch(
		toolName: string,
		parameters: Record<string, unknown>,
		mode: ConversationMode,
		messageId: string,
		abortSignal?: AbortSignal,
		onProgress?: (status: string) => void,
		policyCtx?: ToolPolicyContext,
		perCallApprovalCallback?: ApprovalCallback,
		sessionContext?: ToolSessionContext,
	): Promise<ToolResult> {
		// 1. Look up tool in registry
		const tool = this.tools.get(toolName);
		if (!tool) {
			log.warn("Tool not found", { toolName });
			return {
				tool_name: toolName,
				success: false,
				result: "",
				error: `Tool not found: ${toolName}. Available tools: ${Array.from(this.tools.keys()).join(", ")}`,
			};
		}

		// Create the tool call record
		const toolCall: ToolCall = {
			tool_name: toolName,
			parameters,
			status: "pending",
		};

		// Emit started event
		this.events.onToolCallStarted?.(toolCall, messageId);

		// --- Policy evaluation ---
		// When policyCtx is provided (session-scoped), use the pure evaluateToolPolicy()
		// function. Otherwise, fall back to inline checks reading from shared state
		// (backward compat during migration to per-session policy).
		if (policyCtx) {
			const decision = evaluateToolPolicy(toolName, parameters, tool, policyCtx);

			if (!decision.allowed) {
				toolCall.status = "error";
				this.events.onToolCallStatusChanged?.(toolCall, messageId);

				const result: ToolResult = {
					tool_name: toolName,
					success: false,
					result: "",
					error: decision.error ?? "Tool call blocked by policy.",
				};

				log.info("Tool blocked by policy", { toolName, error: decision.error });
				this.events.onToolCallResult?.(toolCall, result, messageId);
				return result;
			}

			if (!decision.autoApproved) {
				const approvalCb = perCallApprovalCallback;
				if (!approvalCb) {
					log.warn("No approval callback set, auto-approving", { toolName });
				} else {
					const approvalTimeout = this.settings?.approval_timeout ?? 0;
					const userDecision = await (approvalTimeout > 0
						? Promise.race([
							approvalCb(toolCall, abortSignal, messageId),
							new Promise<"timed_out">((resolve) =>
								setTimeout(() => resolve("timed_out"), approvalTimeout * 1000)
							),
						])
						: approvalCb(toolCall, abortSignal, messageId));

					if (userDecision === "rejected" || userDecision === "timed_out") {
						toolCall.status = "rejected";
						this.events.onToolCallStatusChanged?.(toolCall, messageId);

						const error = userDecision === "timed_out"
							? `Tool call '${toolName}' was not approved within ${approvalTimeout} seconds and was automatically skipped. The user may be away — proceed without this tool's output.`
							: `Tool call rejected by user. The user chose not to approve this ${toolName} operation.`;

						const result: ToolResult = {
							tool_name: toolName,
							success: false,
							result: "",
							error,
						};

						log.info(userDecision === "timed_out" ? "Tool call timed out waiting for approval" : "Tool call rejected by user", { toolName });
						this.events.onToolCallResult?.(toolCall, result, messageId);
						return result;
					}
				}
			} else if (perCallApprovalCallback) {
				void perCallApprovalCallback(toolCall, abortSignal, messageId, true);
			}

			// Mark as approved
			toolCall.status = "approved";
			this.events.onToolCallStatusChanged?.(toolCall, messageId);
		} else if (tool.internal) {
			// Internal tools bypass all legacy checks
			toolCall.status = "approved";
			this.events.onToolCallStatusChanged?.(toolCall, messageId);
		} else {
			// --- Legacy inline policy checks (no policyCtx provided) ---

			// 2. Enabled check — block disabled tools before any other check (FR-83)
			if (this.effectiveToolConfig) {
				const toolEntry = this.effectiveToolConfig.tools[toolName];
				if (toolEntry && !toolEntry.enabled) {
					toolCall.status = "error";
					this.events.onToolCallStatusChanged?.(toolCall, messageId);

					const result: ToolResult = {
						tool_name: toolName,
						success: false,
						result: "",
						error: `Tool '${toolName}' is disabled and cannot be used in this context.`,
					};

					log.info("Blocked disabled tool", { toolName });
					this.events.onToolCallResult?.(toolCall, result, messageId);
					return result;
				}
			}

			// 3. Check Plan/Act mode — block write tools in Plan mode
			if (mode === "plan" && tool.mode === "write") {
				toolCall.status = "error";
				this.events.onToolCallStatusChanged?.(toolCall, messageId);

				// FEAT-001: MCP tools get a specific error message format per spec FR-59
				const planModeError = isMcpTool(toolName)
					? `Tool '${toolName}' is write-only and blocked in Plan mode. Switch to Act mode to use this tool.`
					: `${toolName} is not available in Plan mode. Switch to Act mode to ${this.getWriteToolDescription(toolName)}.`;

				const result: ToolResult = {
					tool_name: toolName,
					success: false,
					result: "",
					error: planModeError,
				};

				log.info("Blocked write tool in Plan mode", { toolName });
				this.events.onToolCallResult?.(toolCall, result, messageId);
				return result;
			}

			// 3a. fetch_webpage: domain denylist check
			if (toolName === "fetch_webpage" && this.settings) {
				const url = parameters["url"] as string;
				if (url) {
					const denyCheck = isDomainBlocked(url, this.settings.domain_denylist);
					if (denyCheck.blocked) {
						let hostname: string;
						try {
							hostname = new URL(url).hostname;
						} catch {
							hostname = url;
						}
						toolCall.status = "error";
						this.events.onToolCallStatusChanged?.(toolCall, messageId);

						const result: ToolResult = {
							tool_name: toolName,
							success: false,
							result: "",
							error: `Domain ${hostname} is blocked by your denylist.`,
						};

						log.info("Domain blocked by denylist", { toolName, url, pattern: denyCheck.pattern });
						this.events.onToolCallResult?.(toolCall, result, messageId);
						return result;
					}
				}
			}

			// 4. Check auto-approve settings
			// When effectiveToolConfig is active, use its merged auto_approve as unified early-return
			// before consulting legacy MCP/built-in branching (DISP-004)
			let isAutoApproved: boolean;
			if (this.effectiveToolConfig) {
				const toolEntry = this.effectiveToolConfig.tools[toolName];
				isAutoApproved = toolEntry?.auto_approve ?? false;
			} else {
				// Fallback: legacy MCP/built-in branching when no effective config
				// For MCP tools: server-level per-tool → default false (FEAT-002)
				// For built-in tools: global setting
				if (isMcpTool(toolName) && tool instanceof McpRegisteredTool) {
					isAutoApproved = resolveMcpAutoApprove(tool);
				} else {
					isAutoApproved = resolveAutoApprove(toolName, this.autoApprove);
				}
			}

			const approvalCb = perCallApprovalCallback ?? this.approvalCallback;

			if (!isAutoApproved) {
				// Request user approval.
				// Legacy path: falls back to instance-level callback (used by sub-agent
				// dispatchers which set approval via setApprovalCallback on their own
				// ToolDispatcher instance). The shared plugin-level dispatcher passes
				// per-call approval from sessions.
				if (!approvalCb) {
					log.warn("No approval callback set, auto-approving", { toolName });
				} else {
					const approvalTimeout = this.settings?.approval_timeout ?? 0;
					const decision = await (approvalTimeout > 0
						? Promise.race([
							approvalCb(toolCall, abortSignal, messageId),
							new Promise<"timed_out">((resolve) =>
								setTimeout(() => resolve("timed_out"), approvalTimeout * 1000)
							),
						])
						: approvalCb(toolCall, abortSignal, messageId));

					if (decision === "rejected" || decision === "timed_out") {
						toolCall.status = "rejected";
						this.events.onToolCallStatusChanged?.(toolCall, messageId);

						const error = decision === "timed_out"
							? `Tool call '${toolName}' was not approved within ${approvalTimeout} seconds and was automatically skipped. The user may be away — proceed without this tool's output.`
							: `Tool call rejected by user. The user chose not to approve this ${toolName} operation.`;

						const result: ToolResult = {
							tool_name: toolName,
							success: false,
							result: "",
							error,
						};

						log.info(decision === "timed_out" ? "Tool call timed out waiting for approval" : "Tool call rejected by user", { toolName });
						this.events.onToolCallResult?.(toolCall, result, messageId);
						return result;
					}
				}
			} else if (approvalCb) {
				// Auto-approved: render collapsed diff for after-the-fact review.
				// The callback resolves immediately when autoApproved=true.
				void approvalCb(toolCall, abortSignal, messageId, true);
			}

			// Mark as approved
			toolCall.status = "approved";
			this.events.onToolCallStatusChanged?.(toolCall, messageId);

			// 5. Path enforcement — check allowed_paths/blocked_paths (FR-84)
			if (this.effectiveToolConfig) {
				const toolEntry = this.effectiveToolConfig.tools[toolName];
				if (toolEntry) {
					const pathError = enforcePathConstraints(
						toolName,
						parameters,
						toolEntry,
						this.vaultRootPath ?? "",
						this.resolveVaultPath,
					);
					if (pathError) {
						toolCall.status = "error";
						this.events.onToolCallStatusChanged?.(toolCall, messageId);

						const result: ToolResult = {
							tool_name: toolName,
							success: false,
							result: "",
							error: pathError,
						};

						log.info("Blocked tool by path constraint", { toolName, error: pathError });
						this.events.onToolCallResult?.(toolCall, result, messageId);
						return result;
					}
				}
			}
		}

		// 6. Execute tool — race against abort signal so the user is unblocked
		//    immediately when they click Stop. The tool may continue running in
		//    the background but its result is discarded.
		const startTime = Date.now();
		try {
			const executeOptions: ToolExecuteOptions = { onProgress, mode, abortSignal, sessionContext, silentNoteOpener: this.silentMode || undefined };
			const executePromise = tool.execute(parameters, executeOptions);

			let result: ToolResult;
			if (abortSignal) {
				const abortPromise = new Promise<ToolResult>((resolve) => {
					if (abortSignal.aborted) {
						resolve({
							tool_name: toolName, success: false, result: "",
							error: "Tool call cancelled by user.",
						});
						return;
					}
					abortSignal.addEventListener("abort", () => {
						resolve({
							tool_name: toolName, success: false, result: "",
							error: "Tool call cancelled by user.",
						});
					}, { once: true });
				});
				result = await Promise.race([executePromise, abortPromise]);
			} else {
				result = await executePromise;
			}

			const duration = Date.now() - startTime;
			result.duration_ms = duration;

			// Dispatcher-level spillover: catches MCP tools and extension tools
			// whose results exceed the output cap. Built-in tools (execute_command,
			// fetch_webpage) handle spillover internally and return short results.
			if (this.spiller && result.success && typeof result.result === "string") {
				const threshold = (this.settings?.output_spillover_threshold ?? 50_000);
				if (result.result.length > threshold) {
					const truncated = result.result.substring(0, threshold);
					try {
						result = {
							...result,
							result: await this.spiller.spillToFile(toolName, result.result, truncated, threshold),
						};
					} catch (e) {
						log.warn("Dispatcher spillover failed", { toolName, error: String(e) });
					}
				}
			}

			toolCall.status = result.success ? "success" : "error";
			this.events.onToolCallStatusChanged?.(toolCall, messageId);
			this.events.onToolCallResult?.(toolCall, result, messageId);

			log.info("Tool executed", {
				toolName,
				success: result.success,
				durationMs: duration,
			});

			return result;
		} catch (e) {
			const duration = Date.now() - startTime;
			toolCall.status = "error";
			this.events.onToolCallStatusChanged?.(toolCall, messageId);

			const result: ToolResult = {
				tool_name: toolName,
				success: false,
				result: "",
				error: `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`,
				duration_ms: duration,
			};

			log.error("Tool execution failed", {
				toolName,
				error: String(e),
				durationMs: duration,
			});

			this.events.onToolCallResult?.(toolCall, result, messageId);
			return result;
		}
	}

	// -----------------------------------------------------------------------
	// Introspection
	// -----------------------------------------------------------------------

	/**
	 * Check if a tool name is a write tool.
	 */
	isWriteTool(toolName: string): boolean {
		const tool = this.tools.get(toolName);
		return tool?.mode === "write";
	}

	/**
	 * Check if an MCP tool has an explicit user classification of "read".
	 *
	 * Used by tool orchestration to allow concurrency for MCP tools that
	 * the user has explicitly marked as read-only (via toolClassifications
	 * in the MCP server config). Without an explicit override, MCP tools
	 * are conservatively treated as non-concurrent.
	 */
	hasExplicitUserReadClassification(toolName: string): boolean {
		const tool = this.tools.get(toolName);
		if (!(tool instanceof McpRegisteredTool)) return false;
		const config = tool.getServerConfig();
		const rawName = tool.getRawToolName();
		return config.toolClassifications?.[rawName] === "read";
	}

	/**
	 * Get all registered tool names.
	 */
	getRegisteredToolNames(): string[] {
		return Array.from(this.tools.keys());
	}

	/**
	 * Check if a tool is registered.
	 */
	hasTool(toolName: string): boolean {
		return this.tools.has(toolName);
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Get a human-readable description of what a write tool does.
	 * Used in Plan mode error messages.
	 */
	private getWriteToolDescription(toolName: string): string {
		const descriptions: Record<string, string> = {
			write_note: "create or modify notes",
			replace_in_note: "edit notes",
			update_frontmatter: "modify note frontmatter",
			manage_tags: "modify note tags",
			execute_command: "run shell commands",
		};
		return descriptions[toolName] ?? "perform write operations";
	}
}