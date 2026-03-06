/**
 * Tool registry — manages all built-in tools.
 *
 * Provides tool lookup, schema generation for LLM context, and mode
 * classification. Populated at plugin load time.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — Tool Registry Interface
 * @see design/tools.md — tool classification table
 */

import type { Tool, ToolDefinition } from "./tool";
import { logger } from "../utils/logger";

const log = logger("ToolRegistry");

/**
 * Registry for all built-in tools.
 *
 * Single source of truth for tool lookup, schema generation, and
 * Plan/Act mode enforcement.
 */
export class ToolRegistry {
	/** Registered tools keyed by name. */
	private tools = new Map<string, Tool>();

	// -----------------------------------------------------------------------
	// Registration
	// -----------------------------------------------------------------------

	/**
	 * Register a tool. Overwrites any existing tool with the same name.
	 */
	register(tool: Tool): void {
		this.tools.set(tool.name, tool);
		log.debug("Registered tool", { name: tool.name, mode: tool.mode });
	}

	/**
	 * Register multiple tools at once.
	 */
	registerAll(tools: Tool[]): void {
		for (const tool of tools) {
			this.register(tool);
		}
	}

	// -----------------------------------------------------------------------
	// Lookup
	// -----------------------------------------------------------------------

	/**
	 * Look up a tool by name.
	 * @returns The tool, or undefined if not found.
	 */
	get(name: string): Tool | undefined {
		return this.tools.get(name);
	}

	/**
	 * Check whether a tool is registered.
	 */
	has(name: string): boolean {
		return this.tools.has(name);
	}

	/**
	 * Get all registered tools.
	 */
	getAll(): Tool[] {
		return Array.from(this.tools.values());
	}

	/**
	 * Get all registered tool names.
	 */
	getNames(): string[] {
		return Array.from(this.tools.keys());
	}

	// -----------------------------------------------------------------------
	// Schema generation
	// -----------------------------------------------------------------------

	/**
	 * Get tool definitions for the LLM system prompt / function calling.
	 *
	 * Returns ToolDefinition[] — the format passed to the provider's
	 * sendMessage call and included in the system prompt.
	 */
	getToolDefinitions(): ToolDefinition[] {
		return Array.from(this.tools.values()).map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.input_schema,
		}));
	}

	// -----------------------------------------------------------------------
	// Mode classification
	// -----------------------------------------------------------------------

	/**
	 * Check if a tool is a write tool (Act mode only).
	 *
	 * Used by the dispatcher to enforce Plan/Act mode restrictions.
	 */
	isWriteTool(name: string): boolean {
		const tool = this.tools.get(name);
		return tool?.mode === "write";
	}

	/**
	 * Get all read-only tools.
	 */
	getReadTools(): Tool[] {
		return Array.from(this.tools.values()).filter((t) => t.mode === "read");
	}

	/**
	 * Get all write tools.
	 */
	getWriteTools(): Tool[] {
		return Array.from(this.tools.values()).filter((t) => t.mode === "write");
	}

	// -----------------------------------------------------------------------
	// Diagnostics
	// -----------------------------------------------------------------------

	/** Number of registered tools. */
	get size(): number {
		return this.tools.size;
	}
}