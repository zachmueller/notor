/**
 * Shared constants for the sub-agent system.
 *
 * @see specs/ZZ-misc/sub-agents-design.md
 */

/**
 * Tool name for the sub-agent invocation tool.
 *
 * This constant is the single source of truth for the tool name used in:
 * - Tool registration (Phase 5)
 * - Filtering from sub-agent tool lists (Section 3.3: no cascading sub-agents)
 * - Defense-in-depth guard in the tool's `execute()` method
 */
export const USE_SUBAGENT_TOOL_NAME = "use_subagent";

/**
 * Tools that must always be excluded from sub-agent tool lists.
 *
 * Section 3.3: `use_subagent` is always filtered out to prevent recursive
 * sub-agent spawning. The dispatcher also rejects calls from within a
 * sub-agent context as defense-in-depth.
 */
export const SUBAGENT_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
	USE_SUBAGENT_TOOL_NAME,
]);

/**
 * Filter out tools that sub-agents must never have access to.
 *
 * Applied when building the sub-agent's tool list, before intersection
 * with the parent's effective config.
 *
 * @param toolNames - Candidate tool names for the sub-agent.
 * @returns Filtered array with excluded tools removed.
 */
export function filterSubAgentTools<T extends { name: string }>(tools: T[]): T[] {
	return tools.filter((t) => !SUBAGENT_EXCLUDED_TOOLS.has(t.name));
}

/** Maximum concurrent sub-agent executions (Section 9.3). */
export const SUB_AGENT_CONCURRENCY_CAP = 3;

/** Maximum LLM turns per sub-agent invocation (Section 2.2). */
export const SUB_AGENT_ITERATION_CAP = 20;

/** Maximum total tokens (input + output) per sub-agent. 0 = no limit. */
export const SUB_AGENT_TOKEN_LIMIT = 0;
