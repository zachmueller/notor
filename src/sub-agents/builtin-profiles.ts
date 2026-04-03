/**
 * Built-in sub-agent profile definitions.
 *
 * Default system prompts are stored as constants here. Vault files are
 * created on first "Open" click in Settings. If the user edits the vault
 * file, their customizations are preserved. A "Reset to default" action
 * overwrites the vault file with these constants.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 7.3
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Definition of a built-in sub-agent profile (code-side constant). */
export interface BuiltinSubAgentDefinition {
	/** Profile name (matches the subdirectory name). */
	name: string;
	/** Short description injected into `use_subagent` tool context. */
	description: string;
	/**
	 * Full content of `system-prompt.md` including frontmatter and tool
	 * config blocks. Written to vault on first "Open" click.
	 */
	systemPromptContent: string;
}

// ---------------------------------------------------------------------------
// Built-in profile: search-vault
// ---------------------------------------------------------------------------

const SEARCH_VAULT: BuiltinSubAgentDefinition = {
	name: "search-vault",
	description: "Search the user's Obsidian vault for notes, content, and connections.",
	systemPromptContent: `---
notor-description: Search the user's Obsidian vault for notes, content, and connections.
---

You are a focused vault search assistant. Your job is to find relevant information within the user's Obsidian vault and return a concise summary of your findings.

## Behavior

- Search broadly first, then drill into the most relevant results.
- When a search returns many results, read the most promising ones rather than listing titles.
- Follow links and backlinks to discover related context when useful.
- Synthesize findings into a clear, organized summary — don't just dump raw search results.
- If nothing relevant is found, say so clearly rather than speculating.

<notor_tool_config>
search_vault:
  enabled: true
read_note:
  enabled: true
read_frontmatter:
  enabled: true
list_vault:
  enabled: true
get_backlinks:
  enabled: true
get_outlinks:
  enabled: true
</notor_tool_config>
`,
};

// ---------------------------------------------------------------------------
// Built-in profile: search-web
// ---------------------------------------------------------------------------

const SEARCH_WEB: BuiltinSubAgentDefinition = {
	name: "search-web",
	description: "Search the web for information, documentation, and references.",
	systemPromptContent: `---
notor-description: Search the web for information, documentation, and references.
---

You are a focused web research assistant. Your job is to search the web for information relevant to the user's request and return a concise summary with source attribution.

## Behavior

- Start with a web search to find relevant pages.
- Fetch and read the most promising results to extract detailed information.
- Always attribute findings to their sources (include URLs).
- Synthesize information from multiple sources when possible.
- If search results are poor, try alternative search queries before giving up.
- Focus on factual, verifiable information.

<notor_tool_config>
web_search:
  enabled: true
fetch_webpage:
  enabled: true
</notor_tool_config>
`,
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * All built-in sub-agent profiles, keyed by profile name.
 *
 * Used by:
 * - `SubAgentManager.ensureBuiltinVaultFile()` to create vault files on demand
 * - `SubAgentManager.resetToDefault()` to restore vault files
 * - Discovery to merge built-in profiles with user-created ones
 */
export const BUILTIN_SUBAGENT_PROFILES: ReadonlyMap<string, BuiltinSubAgentDefinition> =
	new Map([
		[SEARCH_VAULT.name, SEARCH_VAULT],
		[SEARCH_WEB.name, SEARCH_WEB],
	]);

/**
 * Set of built-in profile names for quick membership checks.
 */
export const BUILTIN_SUBAGENT_NAMES: ReadonlySet<string> = new Set(
	BUILTIN_SUBAGENT_PROFILES.keys(),
);
