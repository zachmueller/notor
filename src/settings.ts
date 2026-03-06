/**
 * Notor plugin settings: interface, defaults, and setting tab.
 *
 * Settings are persisted via Obsidian's loadData/saveData mechanism.
 * Credentials are stored separately in Obsidian's SecretStorage —
 * only secret *names* (IDs) appear in settings.
 *
 * All fields sourced from the Plugin Settings table in
 * specs/01-mvp/data-model.md.
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type NotorPlugin from "./main";
import type { ConversationMode, LLMProviderConfig } from "./types";

// ---------------------------------------------------------------------------
// Settings interface
// ---------------------------------------------------------------------------

/** Per-model pricing (cost per 1K tokens). */
export interface ModelPricing {
	input: number;
	output: number;
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

	/** Current Plan/Act mode. */
	mode: ConversationMode;

	/** Open notes in editor when AI reads/modifies them. */
	open_notes_on_access: boolean;

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
}

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------

/** Default provider configurations. */
const DEFAULT_PROVIDERS: LLMProviderConfig[] = [
	{
		type: "local",
		enabled: true,
		display_name: "Local (OpenAI-compatible)",
		endpoint: "http://localhost:11434/v1",
	},
	{
		type: "anthropic",
		enabled: false,
		display_name: "Anthropic",
		endpoint: "https://api.anthropic.com",
	},
	{
		type: "openai",
		enabled: false,
		display_name: "OpenAI",
		endpoint: "https://api.openai.com",
	},
	{
		type: "bedrock",
		enabled: false,
		display_name: "AWS Bedrock",
		aws_auth_method: "profile",
		aws_profile: "default",
	},
];

/** Default auto-approve settings per tool. */
const DEFAULT_AUTO_APPROVE: Record<string, boolean> = {
	read_note: true,
	search_vault: true,
	list_vault: true,
	read_frontmatter: true,
	write_note: false,
	replace_in_note: false,
	update_frontmatter: false,
	manage_tags: false,
};

/** Sensible defaults for all Notor settings. */
export const DEFAULT_SETTINGS: NotorSettings = {
	notor_dir: "notor/",
	active_provider: "local",
	providers: DEFAULT_PROVIDERS,
	auto_approve: DEFAULT_AUTO_APPROVE,
	mode: "plan",
	open_notes_on_access: true,
	history_path: ".obsidian/plugins/notor/history/",
	history_max_size_mb: 500,
	history_max_age_days: 90,
	checkpoint_path: ".obsidian/plugins/notor/checkpoints/",
	checkpoint_max_per_conversation: 100,
	checkpoint_max_age_days: 30,
	model_pricing: {},
};

// ---------------------------------------------------------------------------
// Setting tab (stub — full UI implemented in SET-001 / SET-002)
// ---------------------------------------------------------------------------

/**
 * Notor setting tab registered in Obsidian's Settings panel.
 *
 * This is a minimal placeholder that will be expanded in Phase 3
 * (SET-001 / SET-002) with full provider configuration, auto-approve
 * toggles, history/checkpoint settings, etc.
 */
export class NotorSettingTab extends PluginSettingTab {
	plugin: NotorPlugin;

	constructor(app: App, plugin: NotorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Notor settings" });

		new Setting(containerEl)
			.setName("Notor directory")
			.setDesc(
				"Vault-relative path for Notor-managed files (system prompt, rules, etc.)."
			)
			.addText((text) =>
				text
					.setPlaceholder("notor/")
					.setValue(this.plugin.settings.notor_dir)
					.onChange(async (value) => {
						this.plugin.settings.notor_dir = value;
						await this.plugin.saveSettings();
					})
			);
	}
}