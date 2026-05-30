/**
 * Tool interface and result types for Notor's tool system.
 *
 * All built-in tools implement the Tool interface. The registry provides
 * lookup, schema generation, and mode classification.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — Tool Registry Interface
 * @see design/tools.md — tool classification table
 */

import type { Conversation, ConversationMode, TaskItem, ToolResult } from "../types";
import type { EffectiveToolConfig } from "../tool-config/types";

// Re-export ToolResult for tool implementations
export type { ToolResult };

/**
 * Options passed to `Tool.execute()` for long-running or context-aware tools.
 *
 * All fields are optional — existing tools ignore them. Tools like
 * `use_subagent` use `onProgress`, `mode`, and `abortSignal` to drive
 * sub-agent execution.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 9.5
 */
/**
 * Session-scoped context for tools that need to read the current
 * orchestrator's effective config or active conversation.
 *
 * Passed through the dispatch chain so tools like `use_subagent` can
 * read the correct orchestrator's state without closure-based fallbacks.
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — A4.4a
 */
export interface ToolSessionContext {
	getEffectiveToolConfig(): EffectiveToolConfig | null;
	getActiveConversation(): Conversation | null;
	setConversationTasks?(tasks: TaskItem[] | null): void;
}

export interface ToolExecuteOptions {
	/** Progress callback for long-running tools. */
	onProgress?: (status: string) => void;
	/** Current conversation mode — tools like use_subagent propagate this to child contexts. */
	mode?: ConversationMode;
	/** Abort signal — tools like use_subagent pass this to SubAgentRunner. */
	abortSignal?: AbortSignal;
	/** Session-scoped context — tools use this to read the dispatching orchestrator's state. */
	sessionContext?: ToolSessionContext;
	/** Suppress editor-open side effects (e.g. noteOpener) — used by background/silent sub-agents. */
	silentNoteOpener?: boolean;
	/**
	 * Callback for requesting a user interaction (e.g. follow-up question) from
	 * inside a tool. Bridged into the extension sandbox as `utils.ask`. Type is
	 * `InteractionCallback` from `../chat/dispatcher`; declared structurally here
	 * to avoid a tools→chat import cycle.
	 */
	interactionCallback?: (
		request: import("../ui/interaction-ui").InteractionRequest,
		abortSignal?: AbortSignal,
		messageId?: string,
	) => Promise<import("../ui/interaction-ui").InteractionResponse>;
}

/**
 * JSON Schema definition as passed to LLMs for tool calling.
 */
export interface JSONSchema {
	type: string;
	properties?: Record<string, JSONSchemaProperty>;
	required?: string[];
	[key: string]: unknown;
}

export interface JSONSchemaProperty {
	type?: string;
	description?: string;
	default?: unknown;
	enum?: string[];
	items?: JSONSchemaProperty;
	properties?: Record<string, JSONSchemaProperty>;
	required?: string[];
	additionalProperties?: boolean | JSONSchemaProperty;
	minItems?: number;
	[key: string]: unknown;
}

/**
 * Tool definition as provided to the LLM (in the function calling / tools API).
 */
export interface ToolDefinition {
	name: string;
	description: string;
	input_schema: JSONSchema;
	mode?: "read" | "write";
}

/**
 * A built-in tool that the AI can invoke.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md
 */
export interface Tool {
	/** Unique tool name (stable identifier, never renamed after release). */
	name: string;
	/** Human-readable description sent to the LLM. */
	description: string;
	/** JSON Schema for tool input parameters. */
	input_schema: JSONSchema;
	/**
	 * Tool mode classification.
	 * - "read": safe for Plan and Act modes
	 * - "write": Act mode only, blocked in Plan mode
	 */
	mode: "read" | "write";
	/**
	 * Internal tools are always included in definitions, always auto-approved,
	 * and hidden from the settings UI. Cannot be disabled by users.
	 */
	internal?: boolean;
	/**
	 * Execute the tool with the given parameters.
	 * @param params - Validated parameters from the LLM
	 * @param options - Optional execution options (progress, mode, abort)
	 * @returns Tool result (success or failure)
	 */
	execute(params: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolResult>;
}