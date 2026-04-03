/**
 * Tool interface and result types for Notor's tool system.
 *
 * All built-in tools implement the Tool interface. The registry provides
 * lookup, schema generation, and mode classification.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — Tool Registry Interface
 * @see design/tools.md — tool classification table
 */

import type { ConversationMode, ToolResult } from "../types";

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
export interface ToolExecuteOptions {
	/** Progress callback for long-running tools. */
	onProgress?: (status: string) => void;
	/** Current conversation mode — tools like use_subagent propagate this to child contexts. */
	mode?: ConversationMode;
	/** Abort signal — tools like use_subagent pass this to SubAgentRunner. */
	abortSignal?: AbortSignal;
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
	 * Execute the tool with the given parameters.
	 * @param params - Validated parameters from the LLM
	 * @param options - Optional execution options (progress, mode, abort)
	 * @returns Tool result (success or failure)
	 */
	execute(params: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolResult>;
}