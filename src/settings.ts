/**
 * Notor plugin settings: interface, defaults, and setting tab.
 *
 * Settings are persisted via Obsidian's loadData/saveData mechanism.
 * Credentials are stored separately in Obsidian's SecretStorage —
 * only secret *names* (IDs) appear in settings.
 *
 * All fields sourced from the Plugin Settings table in
 * specs/01-mvp/data-model.md.
 *
 * Phase 3 (SET-001, SET-002): Full settings UI implemented.
 */

import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type NotorPlugin from "./main";
import type { ConversationMode, LLMProviderConfig } from "./types";
import { SECRET_IDS } from "./utils/secrets";

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
// AWS regions for Bedrock dropdown
// ---------------------------------------------------------------------------

const AWS_REGIONS: Array<{ value: string; label: string }> = [
	{ value: "us-east-1", label: "US East (N. Virginia)" },
	{ value: "us-east-2", label: "US East (Ohio)" },
	{ value: "us-west-2", label: "US West (Oregon)" },
	{ value: "eu-central-1", label: "Europe (Frankfurt)" },
	{ value: "eu-west-1", label: "Europe (Ireland)" },
	{ value: "eu-west-3", label: "Europe (Paris)" },
	{ value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
	{ value: "ap-northeast-2", label: "Asia Pacific (Seoul)" },
	{ value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
	{ value: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
	{ value: "ap-south-1", label: "Asia Pacific (Mumbai)" },
	{ value: "sa-east-1", label: "South America (São Paulo)" },
	{ value: "ca-central-1", label: "Canada (Central)" },
];

// ---------------------------------------------------------------------------
// Tool display names for auto-approve section
// ---------------------------------------------------------------------------

const TOOL_DISPLAY_NAMES: Record<string, { name: string; desc: string; isWrite: boolean }> = {
	read_note: {
		name: "Read note",
		desc: "Read the full content of a note.",
		isWrite: false,
	},
	search_vault: {
		name: "Search vault",
		desc: "Search across notes using regex or text patterns.",
		isWrite: false,
	},
	list_vault: {
		name: "List vault",
		desc: "List files and folders in the vault.",
		isWrite: false,
	},
	read_frontmatter: {
		name: "Read frontmatter",
		desc: "Read parsed YAML frontmatter from a note.",
		isWrite: false,
	},
	write_note: {
		name: "Write note",
		desc: "Create a new note or overwrite an existing note's full content.",
		isWrite: true,
	},
	replace_in_note: {
		name: "Replace in note",
		desc: "Make targeted edits using SEARCH/REPLACE blocks.",
		isWrite: true,
	},
	update_frontmatter: {
		name: "Update frontmatter",
		desc: "Add, modify, or remove frontmatter properties.",
		isWrite: true,
	},
	manage_tags: {
		name: "Manage tags",
		desc: "Add or remove tags on a note.",
		isWrite: true,
	},
};

// ---------------------------------------------------------------------------
// Helper to get/set provider config by type
// ---------------------------------------------------------------------------

function getProvider(settings: NotorSettings, type: string): LLMProviderConfig {
	return (
		settings.providers.find((p) => p.type === type) ?? {
			type: type as LLMProviderConfig["type"],
			enabled: false,
			display_name: type,
		}
	);
}

function updateProvider(settings: NotorSettings, updated: LLMProviderConfig): void {
	const idx = settings.providers.findIndex((p) => p.type === updated.type);
	if (idx >= 0) {
		settings.providers[idx] = updated;
	} else {
		settings.providers.push(updated);
	}
}

// ---------------------------------------------------------------------------
// Setting tab
// ---------------------------------------------------------------------------

/**
 * Notor settings tab registered in Obsidian's Settings panel.
 *
 * SET-001: Provider configuration per provider type with connection testing.
 * SET-002: General settings — notor_dir, auto-approve, history, checkpoints,
 *          open-notes-on-access, model pricing.
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

		// -----------------------------------------------------------------------
		// Page header
		// -----------------------------------------------------------------------
		containerEl.createEl("h1", { text: "Notor" });

		// -----------------------------------------------------------------------
		// Active provider selection
		// -----------------------------------------------------------------------
		this.renderActiveProviderSection(containerEl);

		// -----------------------------------------------------------------------
		// SET-001: Provider sections
		// -----------------------------------------------------------------------
		this.renderLocalProviderSection(containerEl);
		this.renderAnthropicProviderSection(containerEl);
		this.renderOpenAIProviderSection(containerEl);
		this.renderBedrockProviderSection(containerEl);

		// -----------------------------------------------------------------------
		// SET-002: General settings
		// -----------------------------------------------------------------------
		this.renderGeneralSection(containerEl);
		this.renderAutoApproveSection(containerEl);
		this.renderHistorySection(containerEl);
		this.renderCheckpointSection(containerEl);
		this.renderModelPricingSection(containerEl);
	}

	// =========================================================================
	// Active provider selection
	// =========================================================================

	private renderActiveProviderSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Active provider" });

		new Setting(containerEl)
			.setName("Active provider")
			.setDesc("The LLM provider used for all chat conversations.")
			.addDropdown((dropdown) => {
				const providerLabels: Record<string, string> = {
					local: "Local (OpenAI-compatible)",
					anthropic: "Anthropic",
					openai: "OpenAI",
					bedrock: "AWS Bedrock",
				};
				for (const [value, label] of Object.entries(providerLabels)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.plugin.settings.active_provider);
				dropdown.onChange(async (value) => {
					this.plugin.settings.active_provider = value;
					await this.plugin.saveSettings();
				});
			});
	}

	// =========================================================================
	// SET-001: Local provider
	// =========================================================================

	private renderLocalProviderSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Local (OpenAI-compatible)" });

		const provider = getProvider(this.plugin.settings, "local");

		new Setting(containerEl)
			.setName("Endpoint URL")
			.setDesc(
				"Base URL of the local OpenAI-compatible API server (e.g. Ollama, LM Studio)."
			)
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:11434/v1")
					.setValue(provider.endpoint ?? "http://localhost:11434/v1")
					.onChange(async (value) => {
						const updated = { ...getProvider(this.plugin.settings, "local") };
						updated.endpoint = value.trim() || "http://localhost:11434/v1";
						updateProvider(this.plugin.settings, updated);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API key")
			.setDesc(
				"Optional API key for local servers that require authentication."
			)
			.addComponent(
				(el) =>
					new SecretComponent(this.app, el)
						.setValue(SECRET_IDS.LOCAL_API_KEY)
						.onChange((_value) => {
							// SecretComponent writes directly to SecretStorage;
							// no additional save needed.
						})
			);

		this.renderConnectionTestButton(containerEl, "local");
	}

	// =========================================================================
	// SET-001: Anthropic provider
	// =========================================================================

	private renderAnthropicProviderSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Anthropic" });

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Your Anthropic API key.")
			.addComponent(
				(el) =>
					new SecretComponent(this.app, el)
						.setValue(SECRET_IDS.ANTHROPIC_API_KEY)
						.onChange((_value) => {
							// SecretComponent writes directly to SecretStorage.
						})
			);

		this.renderConnectionTestButton(containerEl, "anthropic");
	}

	// =========================================================================
	// SET-001: OpenAI provider
	// =========================================================================

	private renderOpenAIProviderSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "OpenAI" });

		const provider = getProvider(this.plugin.settings, "openai");

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Your OpenAI API key.")
			.addComponent(
				(el) =>
					new SecretComponent(this.app, el)
						.setValue(SECRET_IDS.OPENAI_API_KEY)
						.onChange((_value) => {
							// SecretComponent writes directly to SecretStorage.
						})
			);

		new Setting(containerEl)
			.setName("Custom endpoint URL")
			.setDesc(
				"Override the default OpenAI endpoint. Leave blank to use api.openai.com. " +
					"Useful for Azure OpenAI or other compatible services."
			)
			.addText((text) =>
				text
					.setPlaceholder("https://api.openai.com")
					.setValue(
						provider.endpoint && provider.endpoint !== "https://api.openai.com"
							? provider.endpoint
							: ""
					)
					.onChange(async (value) => {
						const updated = { ...getProvider(this.plugin.settings, "openai") };
						updated.endpoint = value.trim() || "https://api.openai.com";
						updateProvider(this.plugin.settings, updated);
						await this.plugin.saveSettings();
					})
			);

		this.renderConnectionTestButton(containerEl, "openai");
	}

	// =========================================================================
	// SET-001: AWS Bedrock provider
	// =========================================================================

	private renderBedrockProviderSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "AWS Bedrock" });

		// IAM policy note
		containerEl.createEl("p", {
			text:
				"Required IAM permissions: bedrock:InvokeModelWithResponseStream " +
				"(for sending messages) and bedrock:ListInferenceProfiles " +
				"(for listing available models). " +
				"bedrock:ListFoundationModels is no longer needed.",
			cls: "setting-item-description",
		});

		const getBedrockProvider = () => getProvider(this.plugin.settings, "bedrock");

		// Region dropdown
		new Setting(containerEl)
			.setName("AWS region")
			.setDesc("The AWS region where your Bedrock models are available.")
			.addDropdown((dropdown) => {
				for (const { value, label } of AWS_REGIONS) {
					dropdown.addOption(value, label);
				}
				const current = getBedrockProvider().region ?? "us-east-1";
				dropdown.setValue(current);
				dropdown.onChange(async (value) => {
					const updated = { ...getBedrockProvider() };
					updated.region = value;
					updateProvider(this.plugin.settings, updated);
					await this.plugin.saveSettings();
				});
			});

		// Auth method toggle
		new Setting(containerEl)
			.setName("Authentication method")
			.setDesc(
				"Choose how to authenticate with AWS. " +
					"'AWS profile' delegates to the AWS credential chain (~/.aws/credentials, env vars, SSO). " +
					"'Access keys' stores credentials directly in Obsidian's secret storage."
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("profile", "AWS profile");
				dropdown.addOption("keys", "Access keys");
				const method = getBedrockProvider().aws_auth_method ?? "profile";
				dropdown.setValue(method);
				dropdown.onChange(async (value: string) => {
					const updated = { ...getBedrockProvider() };
					updated.aws_auth_method = value as "profile" | "keys";
					updateProvider(this.plugin.settings, updated);
					await this.plugin.saveSettings();
					// Re-render to show/hide the relevant credential fields
					this.display();
				});
			});

		const authMethod = getBedrockProvider().aws_auth_method ?? "profile";

		if (authMethod === "profile") {
			// Profile name text field
			new Setting(containerEl)
				.setName("AWS profile name")
				.setDesc(
					"The AWS named profile to use from ~/.aws/credentials or ~/.aws/config. " +
						"Uses the 'default' profile if left blank."
				)
				.addText((text) =>
					text
						.setPlaceholder("default")
						.setValue(getBedrockProvider().aws_profile ?? "default")
						.onChange(async (value) => {
							const updated = { ...getBedrockProvider() };
							updated.aws_profile = value.trim() || "default";
							updateProvider(this.plugin.settings, updated);
							await this.plugin.saveSettings();
						})
				);
		} else {
			// Access key ID
			new Setting(containerEl)
				.setName("Access key ID")
				.setDesc("Your AWS access key ID.")
				.addComponent(
					(el) =>
						new SecretComponent(this.app, el)
							.setValue(SECRET_IDS.BEDROCK_ACCESS_KEY_ID)
							.onChange((_value) => {
								// SecretComponent writes directly to SecretStorage.
							})
				);

			// Secret access key
			new Setting(containerEl)
				.setName("Secret access key")
				.setDesc("Your AWS secret access key.")
				.addComponent(
					(el) =>
						new SecretComponent(this.app, el)
							.setValue(SECRET_IDS.BEDROCK_SECRET_ACCESS_KEY)
							.onChange((_value) => {
								// SecretComponent writes directly to SecretStorage.
							})
				);
		}

		this.renderConnectionTestButton(containerEl, "bedrock");
	}

	// =========================================================================
	// Connection test button (shared across provider sections)
	// =========================================================================

	private renderConnectionTestButton(
		containerEl: HTMLElement,
		providerType: string
	): void {
		const setting = new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify that the provider is reachable and credentials are valid.");

		// Bedrock uses Node.js-only AWS SDK credential providers that cannot
		// be bundled in the settings test helper. Testing is available once
		// the plugin is fully loaded and the main provider registry is wired.
		if (providerType === "bedrock") {
			setting.setDesc(
				"AWS Bedrock connection can be tested from the chat panel " +
					"once the plugin is loaded. Save your settings and open " +
					"the Notor chat panel to verify connectivity."
			);
			return;
		}

		let statusEl: HTMLElement | null = null;

		setting.addButton((button) => {
			button.setButtonText("Test connection").onClick(async () => {
				button.setDisabled(true);
				button.setButtonText("Testing…");
				if (statusEl) statusEl.remove();

				// Inline status element rendered below the setting row
				statusEl = containerEl.createEl("p", {
					cls: "notor-connection-status notor-connection-status--pending",
					text: "Connecting…",
				});
				setting.settingEl.after(statusEl);

				try {
					// Dynamically import the provider registry to avoid
					// circular dependency at module load time.
					const { buildProviderRegistry } = await import(
						"./providers/registry-factory"
					);
					const registry = buildProviderRegistry(
						this.app,
						this.plugin.settings
					);
					const provider = registry.getProvider(
						providerType as import("./types").LLMProviderType
					);
					await provider.validateConnection();

					statusEl.textContent = "✓ Connection successful";
					statusEl.className =
						"notor-connection-status notor-connection-status--success";
				} catch (e) {
					const message =
						e instanceof Error ? e.message : String(e);
					statusEl.textContent = `✗ ${message}`;
					statusEl.className =
						"notor-connection-status notor-connection-status--error";
				} finally {
					button.setDisabled(false);
					button.setButtonText("Test connection");
				}
			});
		});
	}

	// =========================================================================
	// SET-002: General settings
	// =========================================================================

	private renderGeneralSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "General" });

		new Setting(containerEl)
			.setName("Notor directory")
			.setDesc(
				"Vault-relative path for Notor-managed files (system prompts, rules, etc.). " +
					"This folder is visible in the file explorer."
			)
			.addText((text) =>
				text
					.setPlaceholder("notor/")
					.setValue(this.plugin.settings.notor_dir)
					.onChange(async (value) => {
						this.plugin.settings.notor_dir =
							value.trim() || "notor/";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Open notes on access")
			.setDesc(
				"Automatically open notes in the editor when the AI reads or modifies them."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.open_notes_on_access)
					.onChange(async (value) => {
						this.plugin.settings.open_notes_on_access = value;
						await this.plugin.saveSettings();
					})
			);
	}

	// =========================================================================
	// SET-002: Auto-approve settings
	// =========================================================================

	private renderAutoApproveSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Auto-approve" });
		containerEl.createEl("p", {
			text:
				"When auto-approve is on for a tool, it executes immediately without " +
				"an inline approval prompt. Read-only tools default to auto-approved; " +
				"write tools default to requiring approval.",
			cls: "setting-item-description",
		});

		const readTools = Object.entries(TOOL_DISPLAY_NAMES).filter(
			([, meta]) => !meta.isWrite
		);
		const writeTools = Object.entries(TOOL_DISPLAY_NAMES).filter(
			([, meta]) => meta.isWrite
		);

		// Read-only tools
		containerEl.createEl("h3", { text: "Read-only tools" });
		for (const [toolId, meta] of readTools) {
			new Setting(containerEl)
				.setName(meta.name)
				.setDesc(meta.desc)
				.addToggle((toggle) =>
					toggle
						.setValue(
							this.plugin.settings.auto_approve[toolId] ?? true
						)
						.onChange(async (value) => {
							this.plugin.settings.auto_approve[toolId] = value;
							await this.plugin.saveSettings();
						})
				);
		}

		// Write tools
		containerEl.createEl("h3", { text: "Write tools" });
		for (const [toolId, meta] of writeTools) {
			new Setting(containerEl)
				.setName(meta.name)
				.setDesc(meta.desc)
				.addToggle((toggle) =>
					toggle
						.setValue(
							this.plugin.settings.auto_approve[toolId] ?? false
						)
						.onChange(async (value) => {
							this.plugin.settings.auto_approve[toolId] = value;
							await this.plugin.saveSettings();
						})
				);
		}
	}

	// =========================================================================
	// SET-002: Chat history settings
	// =========================================================================

	private renderHistorySection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Chat history" });

		new Setting(containerEl)
			.setName("Storage path")
			.setDesc(
				"Path where conversation history is stored. " +
					"Relative to the vault root. JSONL files are not shown as vault notes."
			)
			.addText((text) =>
				text
					.setPlaceholder(".obsidian/plugins/notor/history/")
					.setValue(this.plugin.settings.history_path)
					.onChange(async (value) => {
						this.plugin.settings.history_path =
							value.trim() ||
							".obsidian/plugins/notor/history/";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Maximum size (MB)")
			.setDesc(
				"Maximum total size of stored history in megabytes. " +
					"Oldest conversations are pruned when this limit is exceeded."
			)
			.addText((text) =>
				text
					.setPlaceholder("500")
					.setValue(
						String(this.plugin.settings.history_max_size_mb)
					)
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.history_max_size_mb = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Maximum age (days)")
			.setDesc(
				"Conversations older than this many days are automatically pruned."
			)
			.addText((text) =>
				text
					.setPlaceholder("90")
					.setValue(
						String(this.plugin.settings.history_max_age_days)
					)
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.history_max_age_days = parsed;
							await this.plugin.saveSettings();
						}
					})
			);
	}

	// =========================================================================
	// SET-002: Checkpoint settings
	// =========================================================================

	private renderCheckpointSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Checkpoints" });

		new Setting(containerEl)
			.setName("Storage path")
			.setDesc(
				"Path where note snapshots are stored before write operations. " +
					"Relative to the vault root."
			)
			.addText((text) =>
				text
					.setPlaceholder(".obsidian/plugins/notor/checkpoints/")
					.setValue(this.plugin.settings.checkpoint_path)
					.onChange(async (value) => {
						this.plugin.settings.checkpoint_path =
							value.trim() ||
							".obsidian/plugins/notor/checkpoints/";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Maximum per conversation")
			.setDesc(
				"Maximum number of checkpoints retained per conversation. " +
					"Oldest checkpoints are pruned when this limit is exceeded."
			)
			.addText((text) =>
				text
					.setPlaceholder("100")
					.setValue(
						String(
							this.plugin.settings
								.checkpoint_max_per_conversation
						)
					)
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.checkpoint_max_per_conversation =
								parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Maximum age (days)")
			.setDesc(
				"Checkpoints older than this many days are automatically pruned."
			)
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(
						String(this.plugin.settings.checkpoint_max_age_days)
					)
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.checkpoint_max_age_days =
								parsed;
							await this.plugin.saveSettings();
						}
					})
			);
	}

	// =========================================================================
	// SET-002: Model pricing
	// =========================================================================

	private renderModelPricingSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Model pricing" });
		containerEl.createEl("p", {
			text:
				"Optional per-model pricing for token cost estimates. " +
				"If not configured, token counts are still shown but costs are omitted. " +
				"Enter costs in USD per 1,000 tokens.",
			cls: "setting-item-description",
		});

		const pricing = this.plugin.settings.model_pricing;

		// Render existing entries
		const existingModelIds = Object.keys(pricing);
		for (const modelId of existingModelIds) {
			const entry = pricing[modelId];
			if (entry) {
				this.renderModelPricingRow(containerEl, modelId, entry);
			}
		}

		// Add new entry form
		let newModelId = "";
		let newInputPrice = "";
		let newOutputPrice = "";

		const addSetting = new Setting(containerEl)
			.setName("Add model pricing")
			.setDesc(
				"Model ID (e.g. gpt-4o, claude-sonnet-4-5), input price per 1K tokens, output price per 1K tokens."
			);

		addSetting.addText((text) => {
			text.setPlaceholder("Model ID").onChange((v) => {
				newModelId = v.trim();
			});
			text.inputEl.style.width = "160px";
		});
		addSetting.addText((text) => {
			text.setPlaceholder("Input $").onChange((v) => {
				newInputPrice = v.trim();
			});
			text.inputEl.style.width = "80px";
		});
		addSetting.addText((text) => {
			text.setPlaceholder("Output $").onChange((v) => {
				newOutputPrice = v.trim();
			});
			text.inputEl.style.width = "80px";
		});
		addSetting.addButton((btn) =>
			btn.setButtonText("Add").onClick(async () => {
				if (!newModelId) {
					new Notice("Model ID is required.");
					return;
				}
				const input = parseFloat(newInputPrice);
				const output = parseFloat(newOutputPrice);
				if (isNaN(input) || isNaN(output)) {
					new Notice("Enter valid numeric prices.");
					return;
				}
				this.plugin.settings.model_pricing[newModelId] = {
					input,
					output,
				};
				await this.plugin.saveSettings();
				this.display();
			})
		);
	}

	private renderModelPricingRow(
		containerEl: HTMLElement,
		modelId: string,
		pricing: ModelPricing
	): void {
		new Setting(containerEl)
			.setName(modelId)
			.setDesc(
				`Input: $${pricing.input}/1K tokens · Output: $${pricing.output}/1K tokens`
			)
			.addButton((btn) =>
				btn
					.setButtonText("Remove")
					.setWarning()
					.onClick(async () => {
						delete this.plugin.settings.model_pricing[modelId];
						await this.plugin.saveSettings();
						this.display();
					})
			);
	}
}