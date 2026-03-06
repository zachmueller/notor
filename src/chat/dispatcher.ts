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
import { logger } from "../utils/logger";

const log = logger("ToolDispatcher");

/** Tool interface for the dispatcher (minimal — not the full tool registry). */
export interface DispatchableTool {
	name: string;
	mode: "read" | "write";
	execute(params: Record<string, unknown>): Promise<ToolResult>;
}

/** Callback for requesting user approval of a tool call. */
export type ApprovalCallback = (toolCall: ToolCall) => Promise<"approved" | "rejected">;

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

	/** Auto-approve settings per tool name. */
	private autoApprove: Record<string, boolean> = {};

	/** Callback for requesting user approval. */
	private approvalCallback?: ApprovalCallback;

	/** Event handlers for UI updates. */
	private events: DispatcherEvents = {};

	// -----------------------------------------------------------------------
	// Configuration
	// -----------------------------------------------------------------------

	/** Register a tool for dispatch. */
	registerTool(tool: DispatchableTool): void {
		this.tools.set(tool.name, tool);
		log.debug("Registered tool", { name: tool.name, mode: tool.mode });
	}

	/** Update auto-approve settings. */
	setAutoApprove(settings: Record<string, boolean>): void {
		this.autoApprove = { ...settings };
	}

	/** Set the approval callback for manual approval. */
	setApprovalCallback(callback: ApprovalCallback): void {
		this.approvalCallback = callback;
	}

	/** Set event handlers for UI updates. */
	setEvents(events: DispatcherEvents): void {
		this.events = events;
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
		messageId: string
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

		// 2. Check Plan/Act mode — block write tools in Plan mode
		if (mode === "plan" && tool.mode === "write") {
			toolCall.status = "error";
			this.events.onToolCallStatusChanged?.(toolCall, messageId);

			const result: ToolResult = {
				tool_name: toolName,
				success: false,
				result: "",
				error: `${toolName} is not available in Plan mode. Switch to Act mode to ${this.getWriteToolDescription(toolName)}.`,
			};

			log.info("Blocked write tool in Plan mode", { toolName });
			this.events.onToolCallResult?.(toolCall, result, messageId);
			return result;
		}

		// 3. Check auto-approve settings
		const isAutoApproved = this.autoApprove[toolName] ?? false;

		if (!isAutoApproved) {
			// Request user approval
			if (!this.approvalCallback) {
				log.warn("No approval callback set, auto-approving", { toolName });
			} else {
				const decision = await this.approvalCallback(toolCall);

				if (decision === "rejected") {
					toolCall.status = "rejected";
					this.events.onToolCallStatusChanged?.(toolCall, messageId);

					const result: ToolResult = {
						tool_name: toolName,
						success: false,
						result: "",
						error: `Tool call rejected by user. The user chose not to approve this ${toolName} operation.`,
					};

					log.info("Tool call rejected by user", { toolName });
					this.events.onToolCallResult?.(toolCall, result, messageId);
					return result;
				}
			}
		}

		// Mark as approved
		toolCall.status = "approved";
		this.events.onToolCallStatusChanged?.(toolCall, messageId);

		// 4. Execute tool
		const startTime = Date.now();
		try {
			const result = await tool.execute(parameters);
			const duration = Date.now() - startTime;
			result.duration_ms = duration;

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
		};
		return descriptions[toolName] ?? "perform write operations";
	}
}