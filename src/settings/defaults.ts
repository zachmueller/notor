/**
 * Notor settings default values.
 *
 * Sensible defaults for all settings fields. Sub-defaults for
 * providers, auto-approve, hooks, and vault event hooks are exported
 * for use in tests and reset logic.
 *
 * @see specs/01-mvp/data-model.md — Plugin Settings table
 */

import type { LLMProviderConfig, ModelPreset, VaultEventHookConfig } from "../types";
import type { HookConfig, NotorSettings } from "./types";

// ---------------------------------------------------------------------------
// Sub-defaults
// ---------------------------------------------------------------------------

/** Default provider configurations. */
export const DEFAULT_PROVIDERS: LLMProviderConfig[] = [
	{
		id: "local",
		type: "local",
		enabled: true,
		display_name: "Local (OpenAI-compatible)",
		endpoint: "",
	},
	{
		id: "anthropic",
		type: "anthropic",
		enabled: false,
		display_name: "Anthropic",
		endpoint: "https://api.anthropic.com",
	},
	{
		id: "openai",
		type: "openai",
		enabled: false,
		display_name: "OpenAI",
		endpoint: "https://api.openai.com",
	},
	{
		id: "bedrock",
		type: "bedrock",
		enabled: false,
		display_name: "AWS Bedrock",
		aws_auth_method: "profile",
		aws_profile: "default",
	},
];

/** Default tool enabled state — empty means all tools enabled. */
export const DEFAULT_TOOL_ENABLED: Record<string, boolean> = {};

/** Default auto-approve settings per tool. */
export const DEFAULT_AUTO_APPROVE: Record<string, boolean> = {
	read_note: true,
	search_vault: true,
	list_vault: true,
	read_frontmatter: true,
	get_backlinks: true,
	get_outlinks: true,
	fetch_webpage: true,
	web_search: true,
	write_note: false,
	replace_in_note: false,
	update_frontmatter: false,
	manage_tags: false,
	execute_command: false,
	read_file: false,
	read_docx: false,
	write_docx: false,
	move_note: false,
	write_file: false,
	replace_in_file: false,
	extract_docx_comments: false,
	use_subagent: false,
	capture_memory: true,
	read_notor_settings: false,
	edit_notor_settings: false,
};

/** Default empty hook configuration. */
export const DEFAULT_HOOKS: HookConfig = {
	pre_send: [],
	on_tool_call: [],
	on_tool_result: [],
	after_completion: [],
};

/** Default model presets (all unconfigured — user must assign provider+model). */
export const DEFAULT_MODEL_PRESETS: ModelPreset[] = [
	{ name: "tiny", provider_id: null, model_id: null, use_extended_context: false },
	{ name: "small", provider_id: null, model_id: null, use_extended_context: false },
	{ name: "medium", provider_id: null, model_id: null, use_extended_context: false },
	{ name: "large", provider_id: null, model_id: null, use_extended_context: false },
];

/** Default empty vault event hook configuration. */
export const DEFAULT_VAULT_EVENT_HOOKS: VaultEventHookConfig = {
	on_note_open: [],
	on_note_create: [],
	on_save: [],
	on_manual_save: [],
	on_tag_change: [],
	on_schedule: [],
};

// ---------------------------------------------------------------------------
// Main default settings
// ---------------------------------------------------------------------------

/**
 * Create sensible defaults for all Notor settings.
 *
 * @param configDir - The vault config directory. Pass `app.vault.configDir`
 *   to respect user-configured vault layouts (e.g. sandbox vaults).
 */
export function createDefaultSettings(configDir: string): NotorSettings {
	return {
	notor_dir: "notor/",
	active_provider: "local",
	providers: DEFAULT_PROVIDERS,
	auto_approve: DEFAULT_AUTO_APPROVE,
	approval_timeout: 0,
	tool_enabled: DEFAULT_TOOL_ENABLED,
	automation_enabled: {},
	workflow_enabled: {},
	mode: "plan",
	open_notes_on_access: true,
	focus_notes_on_access: false,
	chat_input_max_lines: 3,
	chat_input_max_height_pct: 10,
	history_path: `${configDir}/plugins/notor/history/`,
	history_max_size_mb: 500,
	history_max_age_days: 90,
	checkpoint_path: `${configDir}/plugins/notor/checkpoints/`,
	checkpoint_max_per_conversation: 100,
	checkpoint_max_age_days: 30,
	model_pricing: {},

	// Phase 3: Auto-context
	auto_context_open_notes: true,
	auto_context_vault_structure: true,
	auto_context_os: true,

	// Phase 3: Compaction
	compaction_threshold: 0.8,
	compaction_prompt_override: "",

	// Phase 3: fetch_webpage
	fetch_webpage_timeout: 15,
	fetch_webpage_max_download_mb: 5,
	fetch_webpage_max_output_chars: 50000,
	domain_denylist: [],

	// Phase 3: execute_command
	execute_command_timeout: 30,
	execute_command_max_output_chars: 50000,
	execute_command_allowed_paths: [],
	execute_command_shell: "",
	execute_command_shell_args: [],

	// Phase 3: File attachments
	external_file_size_threshold_mb: 1,

	// Phase 3: Hooks
	hooks: DEFAULT_HOOKS,
	hook_timeout: 10,
	hook_env_truncation_chars: 10000,

	// Phase 4: Personas
	active_persona: "",

	// Group F: Vault event hooks
	vault_event_hooks: DEFAULT_VAULT_EVENT_HOOKS,
	vault_event_debounce_seconds: 5,
	workflow_concurrency_limit: 3,
	workflow_activity_indicator_count: 5,

	// Phase 4.1: MCP servers
	mcp_servers: {},

	// Model presets
	model_presets: [...DEFAULT_MODEL_PRESETS],
	default_preset: "medium",
	title_generation_enabled: false,
	title_generation_preset: "small",

	// Sub-agents
	sub_agent_visibility: {},
	sub_agent_auto_approve_reads: true,
	sub_agent_concurrency_cap: 3,
	sub_agent_iteration_cap: 20,
	sub_agent_token_limit: 0,

	// Phase 5: User-defined extensions
	user_extension_settings: {},
	user_shared_settings: {},

	// Settings UI state
	settings_collapsed_sections: {},

	// Knowledge Memory
	memory_enabled: false,
	memory_folder: "memory",
	memory_approval_mode: "auto",

	// Phase 12: Extension block rate limiting
	extension_block_max_emits_per_window: 10,
	extension_block_rate_window_seconds: 60,

	// Developer escape hatch
	log_level: "error",

	// Image & PDF
	image_max_dimension: 2000,
	image_compression_quality: 80,
	pdf_native_max_size_mb: 10,
	pdf_text_max_chars: 400000,
	pdf_prefer_native: true,

	// Phase 4c: docx & file tools
	read_file_allowed_paths: [],
	write_docx_default_output_dir: "",
	write_docx_default_template_path: "",
	};
}
