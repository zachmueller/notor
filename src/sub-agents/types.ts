/**
 * Type definitions for the sub-agent profile system.
 *
 * Sub-agent profiles define isolated child conversations that the main LLM
 * can spawn via the `use_subagent` tool. Each profile specifies a system
 * prompt, tool access, and optional provider/model overrides.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 2.4 (Sub-Agent Profiles)
 */

import type { ParsedToolConfig } from "../tool-config/types";

/**
 * In-memory representation of a discovered sub-agent profile, loaded from
 * a subdirectory under `{notor_dir}/sub-agents/`.
 *
 * Not persisted as structured data — profiles are discovered at runtime
 * by scanning the sub-agents directory. Built-in profiles are merged
 * with user-created ones during discovery.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 2.4
 */
export interface SubAgentProfile {
	/** Profile name, derived from subdirectory name (e.g., `"search-vault"`). */
	name: string;
	/** Vault-relative path to the profile directory (e.g., `"notor/sub-agents/search-vault/"`). */
	directory_path: string;
	/** Vault-relative path to `system-prompt.md` (e.g., `"notor/sub-agents/search-vault/system-prompt.md"`). */
	system_prompt_path: string;
	/** Body content of `system-prompt.md` after stripping frontmatter and tool config blocks. */
	prompt_content: string;
	/** Short description of what the sub-agent does. Injected into `use_subagent` tool context. */
	description: string | null;
	/** Override LLM provider identifier (null = use parent's provider). */
	preferred_provider: string | null;
	/** Override model identifier (null = use parent's model). */
	preferred_model: string | null;
	/** Parsed tool config blocks from the profile's system prompt. */
	tool_configs: ParsedToolConfig[];
	/** Whether this profile is a built-in shipped with the plugin. */
	is_builtin: boolean;
}
