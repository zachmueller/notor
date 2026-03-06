/**
 * Tool interface and result types for Notor's tool system.
 *
 * All built-in tools implement the Tool interface. The registry provides
 * lookup, schema generation, and mode classification.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — Tool Registry Interface
 * @see design/tools.md — tool classification table
 */

import type { ToolResult } from "../types";

// Re-export ToolResult for tool implementations
export type { ToolResult };

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
	 * @returns Tool result (success or failure)
	 */
	execute(params: Record<string, unknown>): Promise<ToolResult>;
}