/**
 * Type definitions for the `<notor_tool_config>` XML tag system.
 *
 * These types support per-tool configuration embedded in persona system prompts,
 * workflow notes, and vault rule files. The config is extracted, merged by
 * precedence, and applied to the tool registry and dispatcher per-message.
 *
 * @see specs/04b-tool-toggle/spec.md
 */

// ---------------------------------------------------------------------------
// Source Classification
// ---------------------------------------------------------------------------

/** The source context type that a tool config block was extracted from. */
export type ToolConfigSource = "persona" | "workflow" | "rule" | "subagent";

// ---------------------------------------------------------------------------
// Parsed Tool Config (per-block output from the parser)
// ---------------------------------------------------------------------------

/**
 * A single parsed `<notor_tool_config>` block, as extracted from a source file.
 *
 * Multiple blocks may exist per file; they are merged in document order
 * within the same source before cross-source precedence merge runs.
 */
export interface ParsedToolConfig {
	/** Which source context type this config was extracted from. */
	source: ToolConfigSource;
	/** Vault-relative path of the file this config was extracted from. */
	sourceFile: string;
	/** Zero-based character offset of the block within the source file, used for within-file ordering. */
	documentPosition: number;
	/** Per-tool configuration entries extracted from this block. */
	tools: Record<string, ToolConfigEntry>;
	/**
	 * Server-level defaults extracted from `serverName__*` wildcard keys.
	 * Keyed by MCP server name (without the `__*` suffix).
	 * Applied to all tools on that server as a base, overridden by specific
	 * tool entries in the same or higher-precedence block.
	 */
	serverDefaults?: Record<string, ToolConfigEntry>;
}

/**
 * Per-tool configuration fields as authored in a `<notor_tool_config>` block.
 *
 * All fields are optional — omitted fields do not override lower-priority
 * values during the precedence merge (sparse merge semantics).
 */
export interface ToolConfigEntry {
	/** Whether the tool is included in the LLM's tool list. */
	enabled?: boolean;
	/** Whether tool calls are auto-approved without user confirmation. */
	auto_approve?: boolean;
	/** Path prefixes the tool is permitted to operate on (empty = no restriction). */
	allowed_paths?: string[];
	/** Path prefixes explicitly forbidden; takes precedence over `allowed_paths`. */
	blocked_paths?: string[];
	/** Command patterns that are auto-approved when auto_approve is false (execute_command only). */
	allowed_command_patterns?: string[];
	/** Command patterns that are NEVER auto-approved even when auto_approve is true (execute_command only). */
	blocked_command_patterns?: string[];
	/**
	 * Path prefixes whose calls skip the approval prompt when `auto_approve` is
	 * false. **Ergonomics, not a security boundary** — the call still runs either
	 * way; this only decides whether a human sees the prompt. Use
	 * `allowed_paths` / `blocked_paths` to actually gate access.
	 */
	auto_approve_paths?: string[];
	/** Path prefixes that ALWAYS require approval, even when `auto_approve` is true. */
	never_auto_approve_paths?: string[];
}

// ---------------------------------------------------------------------------
// Effective Tool Config (merged output from the merger)
// ---------------------------------------------------------------------------

/**
 * The fully resolved tool configuration after precedence merge.
 *
 * Every registered tool has an entry with all fields non-optional.
 * This is the single source of truth for the dispatcher and tool registry
 * for the current message.
 */
export interface EffectiveToolConfig {
	/** Fully resolved per-tool configuration. Keyed by tool name (namespaced `server__tool` for MCP). */
	tools: Record<string, ResolvedToolConfigEntry>;
}

/**
 * Fully resolved per-tool configuration after merge and default fill.
 *
 * All fields are required — no undefined values remain after merge.
 */
export interface ResolvedToolConfigEntry {
	/** Whether the tool is included in the LLM's tool list. */
	enabled: boolean;
	/** Whether tool calls are auto-approved without user confirmation. */
	auto_approve: boolean;
	/** Path prefixes the tool is permitted to operate on (empty = no restriction). */
	allowed_paths: string[];
	/** Path prefixes explicitly forbidden; takes precedence over `allowed_paths`. */
	blocked_paths: string[];
	/** Command patterns that are auto-approved when auto_approve is false (execute_command only). */
	allowed_command_patterns: string[];
	/** Command patterns that are NEVER auto-approved even when auto_approve is true (execute_command only). */
	blocked_command_patterns: string[];
	/**
	 * Path prefixes whose calls skip the approval prompt when `auto_approve` is
	 * false. Ergonomics only — see {@link ToolConfigEntry.auto_approve_paths}.
	 */
	auto_approve_paths: string[];
	/** Path prefixes that ALWAYS require approval, even when `auto_approve` is true. */
	never_auto_approve_paths: string[];
	/**
	 * Global path lists scoped by `namespace × access` group, from Settings.
	 *
	 * The flat lists above are authored per-context and apply to every path
	 * parameter of the tool; these apply only to parameters in the matching
	 * group, which is what lets one tool's read and write parameters obey
	 * different rules. Combination happens at enforcement time: access-tier
	 * lists intersect/union with the flat lists (global is a floor), while
	 * approval-tier lists are consulted only when the flat list is empty
	 * (global is a default).
	 */
	path_scopes: Partial<Record<PathGroup, PathListSet>>;
}

// ---------------------------------------------------------------------------
// Path Enforcement
// ---------------------------------------------------------------------------

/** Namespace for path parameter resolution. */
export type PathNamespace = "vault" | "filesystem";

/** Whether a path parameter is read from or written to. */
export type PathAccess = "read" | "write";

/**
 * Scope key for the global path-scoping settings: `namespace × access`.
 *
 * Grouping on both axes — rather than per tool — is what makes the common
 * "read wide open, write narrowed" configuration expressible even for tools
 * whose parameters straddle a namespace or direction boundary (`import_docx`
 * reads a filesystem file and writes a vault note).
 */
export type PathGroup = "vault-read" | "vault-write" | "filesystem-read" | "filesystem-write";

/**
 * Descriptor for a tool's path parameter(s), used by the path enforcer
 * to locate and validate path arguments at dispatch time.
 */
export interface ToolPathParam {
	/** Name of the tool parameter that contains the path value. */
	paramName: string;
	/** Whether the path is vault-relative or an absolute filesystem path. */
	namespace: PathNamespace;
	/** If "note", resolve via resolveNote() before constraint checking. */
	resolveAs?: "note";
	/** Read vs write direction; defaults to the tool's declared `mode`. */
	access: PathAccess;
}

/** The four path lists that make up one group's scope. */
export interface PathListSet {
	allowed_paths: string[];
	blocked_paths: string[];
	auto_approve_paths: string[];
	never_auto_approve_paths: string[];
}

/** The global settings group a path parameter belongs to. */
export function groupOf(param: ToolPathParam): PathGroup {
	return `${param.namespace}-${param.access}`;
}

// ---------------------------------------------------------------------------
// Validation Errors
// ---------------------------------------------------------------------------

/**
 * Structured validation error from the parser.
 *
 * The parser is a pure data-processing module with no Obsidian dependency.
 * Callers iterate returned errors and surface them as Obsidian Notices
 * via the shared `showToolConfigError()` helper.
 */
export interface ToolConfigValidationError {
	/** Vault-relative path of the source file containing the invalid config. */
	sourceFile: string;
	/** Human-readable description of the validation error. */
	detail: string;
}
