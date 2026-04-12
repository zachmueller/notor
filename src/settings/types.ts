/**
 * Notor settings type definitions.
 *
 * All interfaces and types used by the settings module. Settings are
 * persisted via Obsidian's loadData/saveData mechanism. Credentials
 * are stored separately in Obsidian's SecretStorage.
 *
 * @see specs/01-mvp/data-model.md — Plugin Settings table
 */

import type { ConversationMode, LLMProviderConfig, ModelPreset, VaultEventHookConfig } from "../types";
import type { McpServerConfig } from "../mcp/mcp-types";
import type { LogLevel } from "../utils/logger";

// ---------------------------------------------------------------------------
// Settings interface
// ---------------------------------------------------------------------------

/** Per-model pricing (cost per 1K tokens). */
export interface ModelPricing {
	input: number;
	output: number;
}

// ---------------------------------------------------------------------------
// Hook configuration interfaces
// ---------------------------------------------------------------------------

/** A single lifecycle hook — shell command tied to an event. */
export interface Hook {
	/** Unique identifier (UUID). */
	id: string;
	/** Lifecycle event this hook fires on. */
	event: HookEvent;
	/** Shell command to execute (for execute_command action). */
	command: string;
	/** Human-readable label (optional; falls back to command or workflow_path). */
	label: string;
	/** Whether this hook is active. */
	enabled: boolean;
	/**
	 * Action type for this hook. Defaults to "execute_command" for backward
	 * compatibility with hooks created before F-004.
	 *
	 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-001, F-004
	 */
	action_type?: "execute_command" | "run_workflow";
	/**
	 * Vault-relative workflow path (required when action_type is "run_workflow").
	 *
	 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-001, F-004
	 */
	workflow_path?: string | null;
}

/** Supported lifecycle hook event types. */
export type HookEvent = "pre_send" | "on_tool_call" | "on_tool_result" | "after_completion";

/** Ordered lists of hooks grouped by lifecycle event. */
export interface HookConfig {
	pre_send: Hook[];
	on_tool_call: Hook[];
	on_tool_result: Hook[];
	after_completion: Hook[];
}

/** Notor plugin settings persisted via loadData/saveData. */
export interface NotorSettings {
	/** Vault-relative path for Notor-managed files. */
	notor_dir: string;

	/** Currently active provider type. */
	active_provider: string;

	/** Per-provider configurations. */
	providers: LLMProviderConfig[];

	/** Per-tool auto-approve settings. */
	auto_approve: Record<string, boolean>;

	/** Per-tool enabled/disabled state. Tools default to enabled when absent. */
	tool_enabled: Record<string, boolean>;

	/** Per-automation enabled/disabled state. Automations default to enabled when absent. */
	automation_enabled: Record<string, boolean>;

	/** Current Plan/Act mode. */
	mode: ConversationMode;

	/** Open notes in editor when AI reads/modifies them. */
	open_notes_on_access: boolean;

	/** Set opened notes as the active tab and give them editor focus. */
	focus_notes_on_access: boolean;

	/** Chat history storage path (vault-relative). */
	history_path: string;

	/** Max total history size in MB. */
	history_max_size_mb: number;

	/** Max history age in days. */
	history_max_age_days: number;

	/** Checkpoint storage path (vault-relative). */
	checkpoint_path: string;

	/** Max checkpoints per conversation. */
	checkpoint_max_per_conversation: number;

	/** Max checkpoint age in days. */
	checkpoint_max_age_days: number;

	/** Per-model pricing (per 1K tokens), keyed by model ID. */
	model_pricing: Record<string, ModelPricing>;

	// -------------------------------------------------------------------
	// Phase 3: Auto-context settings
	// -------------------------------------------------------------------

	/** Enable open note paths auto-context. */
	auto_context_open_notes: boolean;

	/** Enable vault structure auto-context. */
	auto_context_vault_structure: boolean;

	/** Enable OS platform auto-context. */
	auto_context_os: boolean;

	// -------------------------------------------------------------------
	// Phase 3: Compaction settings
	// -------------------------------------------------------------------

	/** Fraction of context window that triggers auto-compaction (0–1). */
	compaction_threshold: number;

	/** Custom compaction system prompt (empty = use default). */
	compaction_prompt_override: string;

	// -------------------------------------------------------------------
	// Phase 3: fetch_webpage settings
	// -------------------------------------------------------------------

	/** HTTP request timeout in seconds. */
	fetch_webpage_timeout: number;

	/** Maximum raw download size in MB. */
	fetch_webpage_max_download_mb: number;

	/** Maximum output character count after conversion. */
	fetch_webpage_max_output_chars: number;

	/** Blocked domain patterns for fetch_webpage and web_search. */
	domain_denylist: string[];

	// -------------------------------------------------------------------
	// Phase 3: execute_command settings
	// -------------------------------------------------------------------

	/** Per-command timeout in seconds. */
	execute_command_timeout: number;

	/** Maximum command output character count. */
	execute_command_max_output_chars: number;

	/** Additional allowed working directory absolute paths. */
	execute_command_allowed_paths: string[];

	/** Custom shell executable (empty = platform default). */
	execute_command_shell: string;

	/** Custom shell launch arguments (empty = platform default). */
	execute_command_shell_args: string[];

	// -------------------------------------------------------------------
	// Phase 3: File attachment settings
	// -------------------------------------------------------------------

	/** File size in MB above which a confirmation dialog is shown. */
	external_file_size_threshold_mb: number;

	// -------------------------------------------------------------------
	// Phase 3: Hook settings
	// -------------------------------------------------------------------

	/** Hook configurations grouped by lifecycle event. */
	hooks: HookConfig;

	/** Global hook timeout in seconds. */
	hook_timeout: number;

	/** Max environment variable value size for hooks (chars). */
	hook_env_truncation_chars: number;

	// -------------------------------------------------------------------
	// Phase 4: Persona settings
	// -------------------------------------------------------------------

	/** Name of the currently active persona (empty string = no persona active). */
	active_persona: string;

	// -------------------------------------------------------------------
	// Group F: Vault event hook settings
	// -------------------------------------------------------------------

	/**
	 * Vault event hooks grouped by event type.
	 *
	 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-001
	 */
	vault_event_hooks: VaultEventHookConfig;

	/**
	 * Debounce cooldown in seconds for debounced vault events
	 * (on_note_open, on_save, on_manual_save). Shared across all
	 * debounced event types.
	 *
	 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-001
	 */
	vault_event_debounce_seconds: number;

	/**
	 * Maximum number of concurrent background workflow executions.
	 * Executions beyond this limit are queued (FIFO).
	 *
	 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-001
	 */
	workflow_concurrency_limit: number;

	/**
	 * Number of recent workflow executions to show in the activity
	 * indicator dropdown.
	 *
	 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-001
	 */
	workflow_activity_indicator_count: number;

	// -------------------------------------------------------------------
	// Phase 4.1: MCP server settings
	// -------------------------------------------------------------------

	/**
	 * MCP server configurations keyed by server name (slug format).
	 *
	 * @see specs/04-mcp/data-model.md — McpServerConfig
	 */
	mcp_servers: Record<string, McpServerConfig>;

	// -------------------------------------------------------------------
	// Developer escape hatch: log level filtering
	// -------------------------------------------------------------------

	/**
	 * Minimum log level. Entries below this level are silently dropped.
	 * Not exposed in the Settings UI — edit data.json directly.
	 * Default: "error" (production-quiet). Set to "debug" for development.
	 */
	log_level: LogLevel;

	// -------------------------------------------------------------------
	// Image & PDF settings
	// -------------------------------------------------------------------

	/** Maximum image dimension (width or height) in pixels before resizing. */
	image_max_dimension: number;

	/** JPEG compression quality (0–100) for the compression cascade. */
	image_compression_quality: number;

	/** Maximum PDF size in MB for native document blocks (default: 10). */
	pdf_native_max_size_mb: number;

	/** Maximum characters for PDF text extraction (default: 400000). */
	pdf_text_max_chars: number;

	/** Whether to prefer native PDF blocks when the provider supports them (default: true). */
	pdf_prefer_native: boolean;

	// Phase 4c: docx & file tools

	/**
	 * Additional filesystem paths allowed for `read_file`, `read_docx`, and `write_docx`.
	 * Vault root is always implicitly allowed.
	 */
	read_file_allowed_paths: string[];

	/** Default output directory for `write_docx`. Vault-relative or absolute. */
	write_docx_default_output_dir: string;

	/** Default template `.docx` path for `write_docx`. Vault-relative or absolute. */
	write_docx_default_template_path: string;

	// -------------------------------------------------------------------
	// Sub-agent settings
	// -------------------------------------------------------------------

	/**
	 * Per-profile visibility toggle for sub-agents.
	 * Keys are profile names, values are whether the profile is available
	 * to the LLM via the `use_subagent` tool. Profiles not present default
	 * to visible (true).
	 *
	 * @see specs/ZZ-misc/sub-agents-design.md — Section 7.2
	 */
	sub_agent_visibility: Record<string, boolean>;

	/**
	 * Whether read-only tools in sub-agents are auto-approved without
	 * user confirmation. Default: true.
	 *
	 * @see specs/ZZ-misc/sub-agents-design.md — Section 9.7
	 */
	sub_agent_auto_approve_reads: boolean;

	/**
	 * Maximum concurrent sub-agent executions. Executions beyond this
	 * limit wait until a slot is available.
	 *
	 * @see specs/ZZ-misc/sub-agents-design.md — Section 9.3
	 */
	sub_agent_concurrency_cap: number;

	/**
	 * Maximum LLM turns per sub-agent invocation. Sub-agents that exceed
	 * this limit return partial results.
	 *
	 * @see specs/ZZ-misc/sub-agents-design.md — Section 2.2
	 */
	sub_agent_iteration_cap: number;

	/**
	 * Maximum total tokens (input + output) per sub-agent invocation.
	 * 0 means no token limit (only iteration cap applies).
	 */
	sub_agent_token_limit: number;

	// -------------------------------------------------------------------
	// Model presets
	// -------------------------------------------------------------------

	/**
	 * Ordered list of model presets. Order determines display order in chat panel dropdown.
	 *
	 * @see specs/ZZ-misc/model-presets-design.md — Section 3.2
	 */
	model_presets: ModelPreset[];

	/**
	 * Name of the default preset for new conversations (must reference a configured preset).
	 *
	 * @see specs/ZZ-misc/model-presets-design.md — Section 3.2
	 */
	default_preset: string;

	/**
	 * Whether the built-in title generation automation is enabled. Default: false.
	 *
	 * @see specs/ZZ-misc/model-presets-design.md — Section 12
	 */
	title_generation_enabled: boolean;

	/**
	 * Preset name to use for title generation LLM calls. Default: "small".
	 *
	 * @see specs/ZZ-misc/model-presets-design.md — Section 12
	 */
	title_generation_preset: string;

	// -------------------------------------------------------------------
	// Phase 5: User-defined extension settings
	// -------------------------------------------------------------------

	/**
	 * Per-extension settings, keyed by extension name then setting key.
	 * Values are persisted via loadData/saveData. Secret fields use
	 * SecretStorage instead and are not stored here.
	 *
	 * @see specs/05-user-tools/plan.md — EXT-004
	 */
	user_extension_settings: Record<string, Record<string, string | number | boolean | string[]>>;

	/**
	 * Global shared extension settings from `notor/settings.md`, keyed
	 * by setting key. Shared across all extensions.
	 *
	 * @see specs/05-user-tools/plan.md — EXT-004
	 */
	user_shared_settings: Record<string, string | number | boolean | string[]>;

	// -------------------------------------------------------------------
	// Settings UI state
	// -------------------------------------------------------------------

	/**
	 * Persisted expand/collapse state for top-level settings groups.
	 * Keys are group titles, values are `true` (open) / `false` (collapsed).
	 * Groups not present in this record use their hardcoded defaults.
	 */
	settings_collapsed_sections: Record<string, boolean>;
}
