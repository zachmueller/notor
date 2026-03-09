/**
 * Notor settings tab (legacy monolithic file).
 *
 * Contains the NotorSettingTab class with all render methods.
 * Will be progressively decomposed in later phases (S-003, S-004).
 *
 * Phase 3 (SET-001, SET-002): Full settings UI implemented.
 */

import { App, Notice, PluginSettingTab, SecretComponent, Setting, TextComponent } from "obsidian";
import type NotorPlugin from "../main";
import type { AutoApproveState, ConversationMode, LLMProviderConfig, LLMProviderType, Persona, VaultEventHook, VaultEventHookConfig, VaultEventHookType } from "../types";
import { addVaultEventHook, removeVaultEventHook, reorderVaultEventHooks, toggleVaultEventHook } from "../hooks/vault-event-hook-config";
import { SECRET_IDS } from "../utils/secrets";
import { discoverPersonas } from "../personas/persona-discovery";
import {
	getStaleToolNames,
	setPersonaToolOverride,
} from "../personas/auto-approve-resolver";
import { logger } from "../utils/logger";
import type { Hook, HookConfig, ModelPricing, NotorSettings } from "./types";
import { AWS_REGIONS, TOOL_DISPLAY_NAMES } from "./constants";
import { getProvider, updateProvider, validateCronExpressionBasic } from "./helpers";

const log = logger("SettingsTab");

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

	/**
	 * Cached personas from the most recent discovery scan.
	 * Populated asynchronously by `triggerPersonaRescan()` when the
	 * settings tab opens. Used by `renderPersonaAutoApproveSection()`
	 * to list personas without re-scanning.
	 */
	private cachedPersonas: Persona[] = [];

	/**
	 * Container element for the persona auto-approve section.
	 * Kept as an instance field so `triggerPersonaRescan()` can replace
	 * its contents once the async discovery completes.
	 */
	private personaAutoApproveSectionEl: HTMLElement | null = null;

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
		// Phase 3: Auto-context settings (CTX-005)
		// -----------------------------------------------------------------------
		this.renderAutoContextSection(containerEl);

		// -----------------------------------------------------------------------
		// Phase 3: Web fetching settings (TOOL-013)
		// -----------------------------------------------------------------------
		this.renderFetchWebpageSection(containerEl);

		// -----------------------------------------------------------------------
		// Phase 3: Shell commands settings (TOOL-016)
		// -----------------------------------------------------------------------
		this.renderExecuteCommandSection(containerEl);

		// -----------------------------------------------------------------------
		// Phase 3: Hooks settings (HOOK-006)
		// -----------------------------------------------------------------------
		this.renderHooksSection(containerEl);

		// -----------------------------------------------------------------------
		// Group F: Vault event hooks settings (F-003, F-004)
		// -----------------------------------------------------------------------
		this.renderVaultEventHooksSection(containerEl);

		// -----------------------------------------------------------------------
		// Phase 3: File attachments settings (POLISH-001)
		// -----------------------------------------------------------------------
		this.renderFileAttachmentsSection(containerEl);

		// -----------------------------------------------------------------------
		// Phase 3: Compaction settings (COMP-003)
		// -----------------------------------------------------------------------
		this.renderCompactionSection(containerEl);

		// -----------------------------------------------------------------------
		// Phase 4: Provider & model identifier reference (A-012)
		// -----------------------------------------------------------------------
		this.renderProviderModelReferenceSection(containerEl);

		// -----------------------------------------------------------------------
		// SET-002: General settings
		// -----------------------------------------------------------------------
		this.renderGeneralSection(containerEl);

		// -----------------------------------------------------------------------
		// Phase 4: Persona rescan on settings open (A-011)
		// -----------------------------------------------------------------------
		this.renderAutoApproveSection(containerEl);

		// -----------------------------------------------------------------------
		// Phase 4: Persona auto-approve overrides (B-004, B-005)
		// -----------------------------------------------------------------------
		this.personaAutoApproveSectionEl = containerEl.createDiv();
		this.renderPersonaAutoApproveSection(this.personaAutoApproveSectionEl, this.cachedPersonas);
		this.triggerPersonaRescan();

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
	// Phase 3: Auto-context settings (CTX-005)
	// =========================================================================

	private renderAutoContextSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Auto-context" });
		containerEl.createEl("p", {
			text:
				"Ambient workspace signals automatically included with every message sent to the AI. " +
				"Each source can be individually enabled or disabled.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Include open note paths")
			.setDesc(
				"Include the vault-relative paths of all currently open notes so the AI knows your active workspace."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.auto_context_open_notes)
					.onChange(async (value) => {
						this.plugin.settings.auto_context_open_notes = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include vault structure")
			.setDesc(
				"Include the top-level folder names in your vault so the AI can navigate and suggest directories."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.auto_context_vault_structure)
					.onChange(async (value) => {
						this.plugin.settings.auto_context_vault_structure = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include operating system")
			.setDesc(
				"Include your OS platform (macOS, Windows, Linux) so the AI generates platform-appropriate commands."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.auto_context_os)
					.onChange(async (value) => {
						this.plugin.settings.auto_context_os = value;
						await this.plugin.saveSettings();
					})
			);
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
						"../providers/registry-factory"
					);
					const registry = buildProviderRegistry(
						this.app,
						this.plugin.settings
					);
					const provider = registry.getProvider(
						providerType as import("../types").LLMProviderType
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
	// Phase 3: Web fetching settings (TOOL-013)
	// =========================================================================

	private renderFetchWebpageSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Web fetching" });
		containerEl.createEl("p", {
			text:
				"Settings for the fetch_webpage tool. Controls timeouts, download limits, " +
				"and domain blocking.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Request timeout (seconds)")
			.setDesc(
				"Maximum time to wait for a webpage response before aborting."
			)
			.addText((text) =>
				text
					.setPlaceholder("15")
					.setValue(String(this.plugin.settings.fetch_webpage_timeout))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.fetch_webpage_timeout = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Maximum download size (MB)")
			.setDesc(
				"Maximum raw download size in megabytes. Requests exceeding this are aborted."
			)
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(
						String(this.plugin.settings.fetch_webpage_max_download_mb)
					)
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.fetch_webpage_max_download_mb = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Maximum output characters")
			.setDesc(
				"Maximum characters in the converted output. Content exceeding this is truncated."
			)
			.addText((text) =>
				text
					.setPlaceholder("50000")
					.setValue(
						String(this.plugin.settings.fetch_webpage_max_output_chars)
					)
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.fetch_webpage_max_output_chars = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		// Domain denylist
		containerEl.createEl("h3", { text: "Domain denylist" });
		containerEl.createEl("p", {
			text:
				"Domains blocked from being fetched. Use exact domains (e.g. example.com) or " +
				"wildcard patterns (e.g. *.example.com) to block all sub-domains.",
			cls: "setting-item-description",
		});

		const denylist = this.plugin.settings.domain_denylist;
		for (let i = 0; i < denylist.length; i++) {
			const entry = denylist[i] ?? "";
			new Setting(containerEl)
				.setName(entry || "(empty)")
				.addButton((btn) =>
					btn
						.setButtonText("Remove")
						.setWarning()
						.onClick(async () => {
							this.plugin.settings.domain_denylist.splice(i, 1);
							await this.plugin.saveSettings();
							this.display();
						})
				);
		}

		let newDomain = "";
		new Setting(containerEl)
			.setName("Add domain")
			.setDesc("Enter a domain or wildcard pattern to block.")
			.addText((text) => {
				text.setPlaceholder("example.com or *.example.com").onChange(
					(v) => {
						newDomain = v.trim();
					}
				);
			})
			.addButton((btn) =>
				btn.setButtonText("Add").onClick(async () => {
					if (!newDomain) {
						new Notice("Enter a domain pattern to add.");
						return;
					}
					if (
						!/^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(
							newDomain
						)
					) {
						new Notice(
							"Invalid domain format. Use a domain like 'example.com' or '*.example.com'."
						);
						return;
					}
					this.plugin.settings.domain_denylist.push(newDomain);
					await this.plugin.saveSettings();
					this.display();
				})
			);
	}

	// =========================================================================
	// Phase 3: Shell commands settings (TOOL-016)
	// =========================================================================

	private renderExecuteCommandSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Shell commands" });
		containerEl.createEl("p", {
			text:
				"Settings for the execute_command tool. Controls shell configuration, " +
				"timeouts, output limits, and allowed working directories. Desktop only.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Command timeout (seconds)")
			.setDesc(
				"Maximum time a command can run before it is terminated."
			)
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(
						String(this.plugin.settings.execute_command_timeout)
					)
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.execute_command_timeout = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Maximum output characters")
			.setDesc(
				"Maximum characters captured from command output. Output exceeding this is truncated."
			)
			.addText((text) =>
				text
					.setPlaceholder("50000")
					.setValue(
						String(this.plugin.settings.execute_command_max_output_chars)
					)
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.execute_command_max_output_chars = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Shell executable")
			.setDesc(
				"Custom shell executable to use instead of the platform default. " +
				"Leave empty for automatic detection ($SHELL on macOS/Linux, PowerShell on Windows)."
			)
			.addText((text) =>
				text
					.setPlaceholder("(platform default)")
					.setValue(this.plugin.settings.execute_command_shell)
					.onChange(async (value) => {
						this.plugin.settings.execute_command_shell = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Shell arguments")
			.setDesc(
				"Custom shell launch arguments (comma-separated). Leave empty for platform defaults. " +
				"Example: -l,-c for login shell."
			)
			.addText((text) =>
				text
					.setPlaceholder("(platform default)")
					.setValue(
						this.plugin.settings.execute_command_shell_args.join(", ")
					)
					.onChange(async (value) => {
						this.plugin.settings.execute_command_shell_args = value
							.split(",")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					})
			);

		// Allowed paths
		containerEl.createEl("h3", { text: "Allowed working directories" });
		containerEl.createEl("p", {
			text:
				"Additional absolute paths where commands are allowed to run. " +
				"The vault root is always allowed.",
			cls: "setting-item-description",
		});

		const allowedPaths = this.plugin.settings.execute_command_allowed_paths;
		for (let i = 0; i < allowedPaths.length; i++) {
			const entry = allowedPaths[i] ?? "";
			new Setting(containerEl)
				.setName(entry || "(empty)")
				.addButton((btn) =>
					btn
						.setButtonText("Remove")
						.setWarning()
						.onClick(async () => {
							this.plugin.settings.execute_command_allowed_paths.splice(i, 1);
							await this.plugin.saveSettings();
							this.display();
						})
				);
		}

		let newPath = "";
		new Setting(containerEl)
			.setName("Add allowed path")
			.setDesc("Enter an absolute directory path.")
			.addText((text) => {
				text.setPlaceholder("/path/to/directory").onChange((v) => {
					newPath = v.trim();
				});
			})
			.addButton((btn) =>
				btn.setButtonText("Add").onClick(async () => {
					if (!newPath) {
						new Notice("Enter a path to add.");
						return;
					}
					this.plugin.settings.execute_command_allowed_paths.push(
						newPath
					);
					await this.plugin.saveSettings();
					this.display();
				})
			);
	}

	// =========================================================================
	// Phase 3: Hooks settings (HOOK-006)
	// =========================================================================

	private renderHooksSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Hooks" });
		containerEl.createEl("p", {
			text:
				"Shell commands that run at specific points in the AI conversation lifecycle. " +
				"Pre-send hooks can inject context into messages. Desktop only.",
			cls: "setting-item-description",
		});

		// Global hook settings
		new Setting(containerEl)
			.setName("Hook timeout (seconds)")
			.setDesc("Maximum time a hook command can run before being terminated.")
			.addText((text) =>
				text
					.setPlaceholder("10")
					.setValue(String(this.plugin.settings.hook_timeout))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.hook_timeout = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Environment variable truncation (chars)")
			.setDesc(
				"Maximum character length for NOTOR_* environment variables passed to hooks. " +
				"Values exceeding this are truncated with a marker."
			)
			.addText((text) =>
				text
					.setPlaceholder("10000")
					.setValue(String(this.plugin.settings.hook_env_truncation_chars))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.hook_env_truncation_chars = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		// Per-event hook lists
		const eventLabels: Record<string, { title: string; desc: string }> = {
			pre_send: {
				title: "Pre-send hooks",
				desc: "Run before each message is sent to the AI. Stdout is captured and included in the message context.",
			},
			on_tool_call: {
				title: "On tool call hooks",
				desc: "Run after a tool call is approved, before execution. Fire-and-forget.",
			},
			on_tool_result: {
				title: "On tool result hooks",
				desc: "Run after a tool finishes execution, before the result returns to the AI. Fire-and-forget.",
			},
			after_completion: {
				title: "After completion hooks",
				desc: "Run after the AI's full response turn completes. Fire-and-forget.",
			},
		};

		for (const [event, meta] of Object.entries(eventLabels)) {
			const eventKey = event as keyof HookConfig;
			containerEl.createEl("h3", { text: meta.title });
			containerEl.createEl("p", { text: meta.desc, cls: "setting-item-description" });

			const hooks = this.plugin.settings.hooks[eventKey];

			// Render existing hooks
			for (let i = 0; i < hooks.length; i++) {
				const hook = hooks[i];
				if (!hook) continue;

				const setting = new Setting(containerEl)
					.setName(hook.label || hook.command.substring(0, 60))
					.setDesc(hook.label ? hook.command.substring(0, 80) : "");

				// Enabled toggle
				setting.addToggle((toggle) =>
					toggle.setValue(hook.enabled).onChange(async (value) => {
						hook.enabled = value;
						await this.plugin.saveSettings();
					})
				);

				// Move up
				if (i > 0) {
					setting.addButton((btn) =>
						btn.setButtonText("↑").onClick(async () => {
							hooks.splice(i, 1);
							hooks.splice(i - 1, 0, hook);
							await this.plugin.saveSettings();
							this.display();
						})
					);
				}

				// Move down
				if (i < hooks.length - 1) {
					setting.addButton((btn) =>
						btn.setButtonText("↓").onClick(async () => {
							hooks.splice(i, 1);
							hooks.splice(i + 1, 0, hook);
							await this.plugin.saveSettings();
							this.display();
						})
					);
				}

				// Delete
				setting.addButton((btn) =>
					btn
						.setButtonText("Remove")
						.setWarning()
						.onClick(async () => {
							hooks.splice(i, 1);
							await this.plugin.saveSettings();
							this.display();
						})
				);
			}

			// Add new hook
			let newCommand = "";
			let newLabel = "";
			const addSetting = new Setting(containerEl)
				.setName("Add hook")
				.setDesc("Shell command to execute.");

			addSetting.addText((text) => {
				text.setPlaceholder("Shell command").onChange((v) => {
					newCommand = v.trim();
				});
			});
			addSetting.addText((text) => {
				text.setPlaceholder("Label (optional)").onChange((v) => {
					newLabel = v.trim();
				});
				text.inputEl.style.width = "120px";
			});
			addSetting.addButton((btn) =>
				btn.setButtonText("Add").onClick(async () => {
					if (!newCommand) {
						new Notice("Enter a shell command for the hook.");
						return;
					}
					const newHook: Hook = {
						id: crypto.randomUUID?.() ?? Date.now().toString(36),
						event: eventKey,
						command: newCommand,
						label: newLabel,
						enabled: true,
					};
					this.plugin.settings.hooks[eventKey].push(newHook);
					await this.plugin.saveSettings();
					this.display();
				})
			);
		}
	}

	// =========================================================================
	// Phase 3: File attachments settings (POLISH-001)
	// =========================================================================

	private renderFileAttachmentsSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "File attachments" });
		containerEl.createEl("p", {
			text:
				"Settings for attaching external files to messages. " +
				"Vault notes can be attached without size restrictions; " +
				"external files from your filesystem are subject to size limits. Desktop only.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("External file size threshold (MB)")
			.setDesc(
				"Files larger than this threshold trigger a confirmation dialog before attaching. " +
				"This prevents accidentally attaching very large files to the context window."
			)
			.addText((text) =>
				text
					.setPlaceholder("1")
					.setValue(String(this.plugin.settings.external_file_size_threshold_mb))
					.onChange(async (value) => {
						const parsed = parseFloat(value);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.external_file_size_threshold_mb = parsed;
							await this.plugin.saveSettings();
						}
					})
			);
	}

	// =========================================================================
	// Phase 3: Compaction settings (COMP-003)
	// =========================================================================

	private renderCompactionSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Context compaction" });
		containerEl.createEl("p", {
			text:
				"When a conversation approaches the model's context window limit, " +
				"Notor can automatically summarize the conversation to reclaim space. " +
				"You can also trigger compaction manually via the command palette (Notor: Compact context).",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Compaction threshold")
			.setDesc(
				"Fraction of the model's context window (0.0–1.0) that triggers auto-compaction. " +
				"For example, 0.8 means compaction fires when 80% of the context window is used."
			)
			.addText((text) =>
				text
					.setPlaceholder("0.8")
					.setValue(String(this.plugin.settings.compaction_threshold))
					.onChange(async (value) => {
						const parsed = parseFloat(value);
						if (!isNaN(parsed) && parsed > 0 && parsed <= 1) {
							this.plugin.settings.compaction_threshold = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Custom compaction prompt")
			.setDesc(
				"Override the built-in compaction system prompt. " +
				"Leave empty to use the default prompt that produces concise, faithful summaries."
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("(using default prompt)")
					.setValue(this.plugin.settings.compaction_prompt_override)
					.onChange(async (value) => {
						this.plugin.settings.compaction_prompt_override = value;
						await this.plugin.saveSettings();
					})
			);
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

	// =========================================================================
	// Phase 4: Persona rescan on settings open (A-011)
	// =========================================================================

	/**
	 * Trigger an asynchronous persona rescan when the settings tab is opened.
	 *
	 * The rescan result is available for future settings UI elements
	 * (Group B will use this for persona auto-approve sub-page).
	 * Rescan does not block the settings UI from rendering.
	 *
	 * @see specs/03-workflows-personas/tasks/group-a-tasks.md — A-011
	 */
	private triggerPersonaRescan(): void {
		discoverPersonas(
			this.app.vault,
			this.app.metadataCache,
			this.plugin.settings.notor_dir
		)
			.then((personas) => {
				log.debug("Persona rescan on settings open complete", {
					count: personas.length,
					names: personas.map((p) => p.name),
				});

				// Cache results and re-render the persona auto-approve section
				// so it reflects the freshly discovered personas.
				this.cachedPersonas = personas;
				if (this.personaAutoApproveSectionEl) {
					this.personaAutoApproveSectionEl.empty();
					this.renderPersonaAutoApproveSection(
						this.personaAutoApproveSectionEl,
						personas
					);
				}
			})
			.catch((e) => {
				log.warn("Persona rescan on settings open failed", {
					error: String(e),
				});
			});
	}

	// =========================================================================
	// Phase 4: Persona auto-approve settings (B-004, B-005)
	// =========================================================================

	/**
	 * Render the "Persona auto-approve" section in **Settings → Notor**.
	 *
	 * Lists all discovered personas with collapsible sub-sections. Each
	 * persona sub-section shows every registered tool with a three-state
	 * dropdown ("Global default", "Auto-approve", "Require approval").
	 * Tools are grouped into "Read-only tools" and "Write tools"
	 * consistent with the global auto-approve section.
	 *
	 * Also detects stale tool names (B-005) — tools stored in overrides
	 * that no longer exist in the registry — and renders them with a
	 * warning indicator and remove button.
	 *
	 * @param containerEl - Element to render into
	 * @param personas - Discovered personas from the most recent scan
	 *
	 * @see specs/03-workflows-personas/tasks/group-b-tasks.md — B-004, B-005
	 * @see specs/03-workflows-personas/data-model.md — PersonaAutoApproveConfig
	 */
	private renderPersonaAutoApproveSection(
		containerEl: HTMLElement,
		personas: Persona[]
	): void {
		containerEl.createEl("h2", { text: "Persona auto-approve" });
		containerEl.createEl("p", {
			text:
				"Per-persona overrides for tool auto-approve settings. When a persona " +
				"is active, these overrides take precedence over global defaults.",
			cls: "setting-item-description",
		});

		// No personas discovered
		if (personas.length === 0) {
			const notorDir = this.plugin.settings.notor_dir.replace(/\/$/, "");
			containerEl.createEl("p", {
				text:
					`No personas found. Create a persona directory under ` +
					`${notorDir}/personas/ to configure per-persona auto-approve settings.`,
				cls: "notor-persona-aa-empty",
			});
			return;
		}

		// Known (registered) tool names from TOOL_DISPLAY_NAMES
		const registeredToolNames = Object.keys(TOOL_DISPLAY_NAMES);
		const readTools = Object.entries(TOOL_DISPLAY_NAMES).filter(
			([, meta]) => !meta.isWrite
		);
		const writeTools = Object.entries(TOOL_DISPLAY_NAMES).filter(
			([, meta]) => meta.isWrite
		);

		// Dropdown option labels
		const stateLabels: Record<string, string> = {
			global: "Global default",
			approve: "Auto-approve",
			deny: "Require approval",
		};

		for (const persona of personas) {
			const personaName = persona.name;

			// Collapsible sub-section per persona using <details>
			const details = containerEl.createEl("details", {
				cls: "notor-persona-aa-details",
			});
			const summary = details.createEl("summary", {
				cls: "notor-persona-aa-summary",
			});
			summary.createEl("strong", { text: personaName });

			// Count how many overrides this persona has
			const overrides = this.plugin.settings.persona_auto_approve[personaName] ?? {};
			const overrideCount = Object.keys(overrides).length;
			if (overrideCount > 0) {
				summary.createSpan({
					text: ` (${overrideCount} override${overrideCount === 1 ? "" : "s"})`,
					cls: "notor-persona-aa-count",
				});
			}

			const personaBody = details.createDiv({
				cls: "notor-persona-aa-body",
			});

			// Helper to render a tool row with a three-state dropdown
			const renderToolRow = (
				parent: HTMLElement,
				toolId: string,
				toolMeta: { name: string; desc: string }
			): void => {
				const currentState = (overrides[toolId] as AutoApproveState | undefined) ?? "global";

				new Setting(parent)
					.setName(toolMeta.name)
					.setDesc(toolMeta.desc)
					.addDropdown((dropdown) => {
						for (const [value, label] of Object.entries(stateLabels)) {
							dropdown.addOption(value, label);
						}
						dropdown.setValue(currentState);
						dropdown.onChange(async (value) => {
							setPersonaToolOverride(
								this.plugin.settings,
								personaName,
								toolId,
								value as AutoApproveState
							);
							await this.plugin.saveSettings();

							// Update the override count badge in the summary
							const updatedOverrides =
								this.plugin.settings.persona_auto_approve[personaName] ?? {};
							const updatedCount = Object.keys(updatedOverrides).length;
							const countEl = summary.querySelector(".notor-persona-aa-count");
							if (countEl) {
								if (updatedCount > 0) {
									countEl.textContent = ` (${updatedCount} override${updatedCount === 1 ? "" : "s"})`;
								} else {
									countEl.textContent = "";
								}
							} else if (updatedCount > 0) {
								summary.createSpan({
									text: ` (${updatedCount} override${updatedCount === 1 ? "" : "s"})`,
									cls: "notor-persona-aa-count",
								});
							}
						});
					});
			};

			// Read-only tools sub-group
			personaBody.createEl("h4", { text: "Read-only tools" });
			for (const [toolId, meta] of readTools) {
				renderToolRow(personaBody, toolId, meta);
			}

			// Write tools sub-group
			personaBody.createEl("h4", { text: "Write tools" });
			for (const [toolId, meta] of writeTools) {
				renderToolRow(personaBody, toolId, meta);
			}

			// -----------------------------------------------------------
			// B-005: Stale tool name detection and warning indicator
			// -----------------------------------------------------------
			const staleNames = getStaleToolNames(overrides, registeredToolNames);
			if (staleNames.length > 0) {
				personaBody.createEl("h4", {
					text: "Unknown tools",
					cls: "notor-persona-aa-stale-heading",
				});
				personaBody.createEl("p", {
					text:
						"These tool names are stored in overrides but no longer exist in the tool registry. " +
						"They have no effect at runtime and can be safely removed.",
					cls: "setting-item-description notor-persona-aa-stale-desc",
				});

				for (const staleName of staleNames) {
					const staleState = overrides[staleName] ?? "global";
					const staleLabel = stateLabels[staleState] ?? staleState;

					new Setting(personaBody)
						.setName(`⚠️ ${staleName}`)
						.setDesc(`Current override: ${staleLabel}`)
						.setClass("notor-persona-aa-stale-row")
						.addButton((btn) =>
							btn
								.setButtonText("Remove")
								.setWarning()
								.onClick(async () => {
									// Delete the stale entry by setting it to "global"
									// (which removes it from storage)
									setPersonaToolOverride(
										this.plugin.settings,
										personaName,
										staleName,
										"global"
									);
									await this.plugin.saveSettings();

									// Re-render the persona auto-approve section
									if (this.personaAutoApproveSectionEl) {
										this.personaAutoApproveSectionEl.empty();
										this.renderPersonaAutoApproveSection(
											this.personaAutoApproveSectionEl,
											this.cachedPersonas
										);
									}
								})
						);
				}
			}
		}
	}

	// =========================================================================
	// Phase 4: Provider & model identifier reference (A-012)
	// =========================================================================

	/**
	 * Render a "Provider & model identifiers" reference section in Settings.
	 *
	 * Lists each configured provider by its identifier string alongside
	 * available models with copyable identifier strings. Helps users
	 * configure `notor-preferred-provider` and `notor-preferred-model`
	 * in persona frontmatter.
	 *
	 * @see specs/03-workflows-personas/tasks/group-a-tasks.md — A-012
	 */
	private renderProviderModelReferenceSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Provider & model identifiers" });
		containerEl.createEl("p", {
			text:
				"Reference list of provider and model identifier strings for use in persona " +
				"frontmatter (notor-preferred-provider and notor-preferred-model). " +
				"Click the copy button to copy an identifier to your clipboard.",
			cls: "setting-item-description",
		});

		const providers = this.plugin.settings.providers;

		if (providers.length === 0) {
			containerEl.createEl("p", {
				text: "Configure a provider above to see available identifiers.",
				cls: "notor-provider-ref-empty",
			});
			return;
		}

		const refContainer = containerEl.createDiv({ cls: "notor-provider-ref-section" });

		for (const providerConfig of providers) {
			const group = refContainer.createDiv({ cls: "notor-provider-ref-group" });

			// Provider header: display name + identifier with copy button
			const header = group.createDiv({ cls: "notor-provider-ref-header" });
			header.createEl("strong", { text: providerConfig.display_name });
			header.createSpan({
				cls: "notor-provider-ref-id",
				text: `(${providerConfig.type})`,
			});

			const providerCopyBtn = header.createEl("button", {
				cls: "notor-copy-id-btn",
				text: "Copy",
				attr: { "aria-label": `Copy provider identifier: ${providerConfig.type}` },
			});
			providerCopyBtn.addEventListener("click", () => {
				navigator.clipboard.writeText(providerConfig.type).then(() => {
					providerCopyBtn.textContent = "Copied";
					setTimeout(() => {
						providerCopyBtn.textContent = "Copy";
					}, 1500);
				});
			});

			// Models list from cached model data in the provider config
			const cachedModels = providerConfig.model_cache;
			if (cachedModels && cachedModels.length > 0) {
				for (const model of cachedModels) {
					const item = group.createDiv({ cls: "notor-model-ref-item" });
					item.createSpan({
						cls: "notor-model-ref-name",
						text: model.display_name || model.id,
					});
					item.createSpan({
						cls: "notor-model-ref-id",
						text: model.id,
					});

					const modelCopyBtn = item.createEl("button", {
						cls: "notor-copy-id-btn",
						text: "Copy",
						attr: { "aria-label": `Copy model identifier: ${model.id}` },
					});
					modelCopyBtn.addEventListener("click", () => {
						navigator.clipboard.writeText(model.id).then(() => {
							modelCopyBtn.textContent = "Copied";
							setTimeout(() => {
								modelCopyBtn.textContent = "Copy";
							}, 1500);
						});
					});
				}
			} else if (providerConfig.model_id) {
				// Show the single configured model_id if no cache
				const item = group.createDiv({ cls: "notor-model-ref-item" });
				item.createSpan({
					cls: "notor-model-ref-name",
					text: providerConfig.model_id,
				});
				item.createSpan({
					cls: "notor-model-ref-id",
					text: providerConfig.model_id,
				});

				const modelCopyBtn = item.createEl("button", {
					cls: "notor-copy-id-btn",
					text: "Copy",
					attr: { "aria-label": `Copy model identifier: ${providerConfig.model_id}` },
				});
				modelCopyBtn.addEventListener("click", () => {
					navigator.clipboard.writeText(providerConfig.model_id!).then(() => {
						modelCopyBtn.textContent = "Copied";
						setTimeout(() => {
							modelCopyBtn.textContent = "Copy";
						}, 1500);
					});
				});
			} else {
				group.createDiv({
					cls: "notor-provider-ref-empty",
					text: "No models loaded — open the chat panel to refresh",
				});
			}
		}
	}

	// =========================================================================
	// Group F: Vault event hooks settings (F-003, F-004)
	// =========================================================================

	/**
	 * Render the "Vault event hooks" section in **Settings → Notor**.
	 *
	 * Contains one collapsible subsection per vault event type, each
	 * listing configured hooks with enable/disable toggle, reorder, and
	 * delete controls. An "Add hook" form per event type supports both
	 * `"execute_command"` and `"run_workflow"` action types (F-004).
	 *
	 * Also includes shared numeric controls for debounce cooldown and
	 * workflow concurrency limit at the top of the section.
	 *
	 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-003, F-004
	 */
	private renderVaultEventHooksSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "Vault event hooks" });
		containerEl.createEl("p", {
			text:
				"Actions that run automatically when vault events occur — note opened, " +
				"created, saved, tag changed, or on a schedule. Each event type can have " +
				"multiple hooks that run in order. Desktop only for shell command hooks.",
			cls: "setting-item-description",
		});

		// -------------------------------------------------------------------
		// Shared numeric controls
		// -------------------------------------------------------------------
		new Setting(containerEl)
			.setName("Debounce cooldown (seconds)")
			.setDesc(
				"Minimum time between repeated firings of the same hook on the same note. " +
				"Applies to on-note-open, on-save, and on-manual-save events."
			)
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.vault_event_debounce_seconds))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed >= 0) {
							this.plugin.settings.vault_event_debounce_seconds = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Workflow concurrency limit")
			.setDesc(
				"Maximum number of background workflow executions running simultaneously. " +
				"Additional executions are queued (FIFO) until a slot becomes available."
			)
			.addText((text) =>
				text
					.setPlaceholder("3")
					.setValue(String(this.plugin.settings.workflow_concurrency_limit))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.workflow_concurrency_limit = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Recent workflow entries")
			.setDesc(
				"Number of recent workflow executions shown in the activity indicator dropdown."
			)
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.workflow_activity_indicator_count))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed >= 1 && parsed <= 50) {
							this.plugin.settings.workflow_activity_indicator_count = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		// -------------------------------------------------------------------
		// Per-event-type collapsible subsections
		// -------------------------------------------------------------------
		const eventMeta: Array<{
			event: VaultEventHookType;
			title: string;
			desc: string;
			hasSchedule: boolean;
			desktopOnlyNote?: string;
		}> = [
			{
				event: "on_note_open",
				title: "On note open",
				desc: "Fires when a Markdown note is opened (activated) in the editor.",
				hasSchedule: false,
			},
			{
				event: "on_note_create",
				title: "On note create",
				desc: "Fires when a new Markdown file is created in the vault.",
				hasSchedule: false,
			},
			{
				event: "on_save",
				title: "On save",
				desc: "Fires whenever a Markdown note is saved (auto-save or manual save).",
				hasSchedule: false,
			},
			{
				event: "on_manual_save",
				title: "On manual save",
				desc: "Fires only on explicit keyboard saves (Cmd+S / Ctrl+S).",
				hasSchedule: false,
				desktopOnlyNote:
					"Desktop only — fires on Cmd+S / Ctrl+S; does not fire on mobile.",
			},
			{
				event: "on_tag_change",
				title: "On tag change",
				desc: "Fires when a note's frontmatter tags are added or removed.",
				hasSchedule: false,
			},
			{
				event: "on_schedule",
				title: "On schedule",
				desc: "Fires on a cron schedule (e.g. daily at midnight). Requires a cron expression.",
				hasSchedule: true,
			},
		];

		for (const meta of eventMeta) {
			this.renderVaultEventHookSubsection(containerEl, meta);
		}
	}

	/**
	 * Render one collapsible `<details>` subsection for a single vault event type.
	 *
	 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-003, F-004
	 */
	private renderVaultEventHookSubsection(
		containerEl: HTMLElement,
		meta: {
			event: VaultEventHookType;
			title: string;
			desc: string;
			hasSchedule: boolean;
			desktopOnlyNote?: string;
		}
	): void {
		const { event, title, desc, hasSchedule, desktopOnlyNote } = meta;
		const hooks = this.plugin.settings.vault_event_hooks[event];

		const details = containerEl.createEl("details", {
			cls: "notor-vault-hook-details",
		});
		const summary = details.createEl("summary", {
			cls: "notor-vault-hook-summary",
		});
		summary.createEl("strong", { text: title });
		const hookCount = hooks.length;
		if (hookCount > 0) {
			summary.createSpan({
				text: ` (${hookCount} hook${hookCount === 1 ? "" : "s"})`,
				cls: "notor-vault-hook-count",
			});
		}

		const body = details.createDiv({ cls: "notor-vault-hook-body" });

		body.createEl("p", { text: desc, cls: "setting-item-description" });
		if (desktopOnlyNote) {
			body.createEl("p", {
				text: `ℹ️ ${desktopOnlyNote}`,
				cls: "setting-item-description notor-vault-hook-desktop-note",
			});
		}

		// -------------------------------------------------------------------
		// Render existing hooks
		// -------------------------------------------------------------------
		for (let i = 0; i < hooks.length; i++) {
			const hook = hooks[i];
			if (!hook) continue;

			// Determine display name and description
			const actionLabel =
				(hook.action_type ?? "execute_command") === "run_workflow"
					? `▶ ${hook.workflow_path ?? "(no path)"}`
					: `$ ${hook.command ?? "(no command)"}`;
			const hookName = hook.label || actionLabel.substring(0, 60);
			const hookDesc = hook.label ? actionLabel.substring(0, 80) : "";

			// Warn if run_workflow hook has an empty path
			const isInvalidWorkflow =
				(hook.action_type ?? "execute_command") === "run_workflow" &&
				!hook.workflow_path?.trim();

			const setting = new Setting(body)
				.setName(hookName + (isInvalidWorkflow ? " ⚠️" : ""))
				.setDesc(hookDesc);

			// Enabled toggle
			setting.addToggle((toggle) =>
				toggle.setValue(hook.enabled).onChange(async (value) => {
					toggleVaultEventHook(
						this.plugin.settings.vault_event_hooks,
						hook.id
					);
					// toggleVaultEventHook mutates in place; sync saved value
					hook.enabled = value;
					await this.plugin.saveSettings();
				})
			);

			// Move up
			if (i > 0) {
				setting.addButton((btn) =>
					btn.setButtonText("↑").onClick(async () => {
						reorderVaultEventHooks(
							this.plugin.settings.vault_event_hooks,
							event,
							hook.id,
							i - 1
						);
						await this.plugin.saveSettings();
						this.display();
					})
				);
			}

			// Move down
			if (i < hooks.length - 1) {
				setting.addButton((btn) =>
					btn.setButtonText("↓").onClick(async () => {
						reorderVaultEventHooks(
							this.plugin.settings.vault_event_hooks,
							event,
							hook.id,
							i + 1
						);
						await this.plugin.saveSettings();
						this.display();
					})
				);
			}

			// Remove
			setting.addButton((btn) =>
				btn
					.setButtonText("Remove")
					.setWarning()
					.onClick(async () => {
						removeVaultEventHook(
							this.plugin.settings.vault_event_hooks,
							hook.id
						);
						await this.plugin.saveSettings();
						this.display();
					})
			);
		}

		// -------------------------------------------------------------------
		// Add hook form (F-003 + F-004)
		// -------------------------------------------------------------------
		// Local state for the form
		let newActionType: "execute_command" | "run_workflow" = "execute_command";
		let newCommandOrPath = "";
		let newLabel = "";
		let newSchedule = "";

		// Action type selector
		const actionTypeSetting = new Setting(body)
			.setName("Add hook")
			.setDesc("Action to perform when this event fires.");

		// Action type dropdown
		actionTypeSetting.addDropdown((dropdown) => {
			dropdown.addOption("execute_command", "Execute shell command");
			dropdown.addOption("run_workflow", "Run a workflow");
			dropdown.setValue(newActionType);
			dropdown.onChange((value) => {
				newActionType = value as "execute_command" | "run_workflow";
				// Update the placeholder on the command/path input
				if (commandInput) {
					commandInput.setPlaceholder(
						newActionType === "run_workflow"
							? "daily/review.md"
							: "Shell command"
					);
				}
			});
		});

		// Command / workflow path input (shared element, placeholder changes with action type)
		let commandInput: TextComponent | null = null;
		actionTypeSetting.addText((text) => {
			commandInput = text;
			text.setPlaceholder("Shell command").onChange((v) => {
				newCommandOrPath = v.trim();
			});
		});

		// Label input (optional)
		actionTypeSetting.addText((text) => {
			text.setPlaceholder("Label (optional)").onChange((v) => {
				newLabel = v.trim();
			});
			text.inputEl.style.width = "120px";
		});

		// Cron expression input (only for on_schedule)
		let scheduleErrorEl: HTMLElement | null = null;
		if (hasSchedule) {
			const scheduleSetting = new Setting(body)
				.setName("Cron expression")
				.setDesc(
					"Standard 5-field cron (minute hour day-of-month month day-of-week). " +
					"Example: 0 9 * * 1-5 (9am Mon–Fri)."
				);

			scheduleSetting.addText((text) => {
				text.setPlaceholder("0 9 * * 1-5").onChange((v) => {
					newSchedule = v.trim();
					// Live validation feedback
					if (scheduleErrorEl) {
						scheduleErrorEl.remove();
						scheduleErrorEl = null;
					}
					if (newSchedule) {
						const validation = validateCronExpressionBasic(newSchedule);
						if (!validation.valid) {
							scheduleErrorEl = body.createEl("p", {
								text: `Invalid cron expression: ${validation.error}`,
								cls: "notor-cron-error",
							});
							scheduleSetting.settingEl.after(scheduleErrorEl);
						} else if (validation.nextRun) {
							scheduleErrorEl = body.createEl("p", {
								text: `Next run: ${validation.nextRun.toLocaleString()}`,
								cls: "notor-cron-preview",
							});
							scheduleSetting.settingEl.after(scheduleErrorEl);
						}
					}
				});
			});
		}

		// Add button
		actionTypeSetting.addButton((btn) =>
			btn.setButtonText("Add").onClick(async () => {
				if (!newCommandOrPath) {
					new Notice(
						newActionType === "run_workflow"
							? "Enter a workflow path."
							: "Enter a shell command."
					);
					return;
				}
				if (hasSchedule && !newSchedule) {
					new Notice("Enter a cron expression for the schedule.");
					return;
				}
				if (hasSchedule && newSchedule) {
					const validation = validateCronExpressionBasic(newSchedule);
					if (!validation.valid) {
						new Notice(`Invalid cron expression: ${validation.error}`);
						return;
					}
				}

				try {
					addVaultEventHook(
						this.plugin.settings.vault_event_hooks,
						event,
						newActionType,
						newCommandOrPath,
						newLabel,
						hasSchedule ? newSchedule : null
					);
					await this.plugin.saveSettings();
					this.display();
				} catch (e) {
					new Notice(e instanceof Error ? e.message : String(e));
				}
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