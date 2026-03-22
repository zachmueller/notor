/**
 * Notor settings tab — thin orchestrator.
 *
 * Creates a `SettingsContext` and delegates rendering to standalone
 * section functions under `src/settings/sections/`. The class retains
 * only `display()`, the constructor, and persona state fields.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-004
 */

import { App, PluginSettingTab } from "obsidian";
import type NotorPlugin from "../main";
import type { SettingsContext } from "./sections/context";

// Section renderers
import { renderActiveProviderSection } from "./sections/active-provider";
import { renderLocalProviderSection } from "./sections/provider-local";
import { renderAnthropicProviderSection } from "./sections/provider-anthropic";
import { renderOpenAIProviderSection } from "./sections/provider-openai";
import { renderBedrockProviderSection } from "./sections/provider-bedrock";
import { renderAutoContextSection } from "./sections/auto-context";
import { renderFetchWebpageSection } from "./sections/fetch-webpage";
import { renderExecuteCommandSection } from "./sections/execute-command";
import { renderDocxToolsSection } from "./sections/docx-tools";
import { renderHooksSection } from "./sections/hooks";
import { renderVaultEventHooksSection } from "./sections/vault-event-hooks";
import { renderFileAttachmentsSection } from "./sections/file-attachments";
import { renderCompactionSection } from "./sections/compaction";
import { renderProviderModelReferenceSection } from "./sections/provider-reference";
import { renderGeneralSection } from "./sections/general";
import { renderAutoApproveSection } from "./sections/auto-approve";
import { renderHistorySection } from "./sections/history";
import { renderCheckpointSection } from "./sections/checkpoints";
import { renderModelPricingSection } from "./sections/model-pricing";
import { renderMcpServersSection } from "./sections/mcp-servers";
import { createSettingsGroup } from "./helpers";

/**
 * Notor settings tab registered in Obsidian's Settings panel.
 *
 * Thin orchestrator — all rendering logic is delegated to per-section
 * functions in `src/settings/sections/`.
 */
export class NotorSettingTab extends PluginSettingTab {
	plugin: NotorPlugin;

	/** Cleanup functions registered by section renderers (e.g. McpHub subscriptions). */
	private cleanupFns: Array<() => void> = [];

	constructor(app: App, plugin: NotorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private runCleanups(): void {
		for (const fn of this.cleanupFns) fn();
		this.cleanupFns = [];
	}

	hide(): void {
		this.runCleanups();
	}

	display(): void {
		this.runCleanups();
		const { containerEl } = this;
		containerEl.empty();

		const ctx: SettingsContext = {
			app: this.app,
			plugin: this.plugin,
			settings: this.plugin.settings,
			saveSettings: () => this.plugin.saveSettings(),
			redisplay: () => this.display(),
			addCleanup: (fn) => this.cleanupFns.push(fn),
		};

		// --- Provider Setup (expanded by default) ---
		const providerGroup = createSettingsGroup(containerEl, "Provider setup", true);
		renderActiveProviderSection(providerGroup, ctx);
		renderLocalProviderSection(providerGroup, ctx);
		renderAnthropicProviderSection(providerGroup, ctx);
		renderOpenAIProviderSection(providerGroup, ctx);
		renderBedrockProviderSection(providerGroup, ctx);

		// --- Conversation (expanded by default) ---
		const conversationGroup = createSettingsGroup(containerEl, "Conversation", true);
		renderGeneralSection(conversationGroup, ctx);
		renderAutoContextSection(conversationGroup, ctx);
		renderCompactionSection(conversationGroup, ctx);

		// --- Tools & Permissions (expanded by default) ---
		const toolsGroup = createSettingsGroup(containerEl, "Tools & permissions", true);
		renderAutoApproveSection(toolsGroup, ctx);

		renderMcpServersSection(toolsGroup, ctx);

		// --- Tool Configuration (collapsed by default) ---
		const toolConfigGroup = createSettingsGroup(containerEl, "Tool configuration");
		renderFetchWebpageSection(toolConfigGroup, ctx);
		renderExecuteCommandSection(toolConfigGroup, ctx);
		renderDocxToolsSection(toolConfigGroup, ctx);
		renderFileAttachmentsSection(toolConfigGroup, ctx);

		// --- Automation (collapsed by default) ---
		const automationGroup = createSettingsGroup(containerEl, "Automation");
		renderHooksSection(automationGroup, ctx);
		renderVaultEventHooksSection(automationGroup, ctx);

		// --- Storage (collapsed by default) ---
		const storageGroup = createSettingsGroup(containerEl, "Storage");
		renderHistorySection(storageGroup, ctx);
		renderCheckpointSection(storageGroup, ctx);

		// --- Reference (collapsed by default) ---
		const referenceGroup = createSettingsGroup(containerEl, "Reference");
		renderProviderModelReferenceSection(referenceGroup, ctx);
		renderModelPricingSection(referenceGroup, ctx);
	}
}
