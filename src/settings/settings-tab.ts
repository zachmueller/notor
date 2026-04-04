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
import { renderWebSearchSection } from "./sections/web-search";
import { renderExecuteCommandSection } from "./sections/execute-command";
import { renderDocxToolsSection } from "./sections/docx-tools";
import { renderHooksSection } from "./sections/hooks";
import { renderVaultEventHooksSection } from "./sections/vault-event-hooks";
import { renderFileAttachmentsSection } from "./sections/file-attachments";
import { renderCompactionSection } from "./sections/compaction";
import { renderProviderModelReferenceSection } from "./sections/provider-reference";
import { renderGeneralSection } from "./sections/general";
import { renderToolsSection } from "./sections/tools";
import { renderHistorySection } from "./sections/history";
import { renderCheckpointSection } from "./sections/checkpoints";
import { renderModelPricingSection } from "./sections/model-pricing";
import { renderMcpServersSection } from "./sections/mcp-servers";
import { renderPersonasSection } from "./sections/personas";
import { renderSubAgentsSection } from "./sections/sub-agents";
import { renderRulesAndWorkflowsSection } from "./sections/rules-and-workflows";
import { createSettingsGroup, snapshotDetailsState, restoreDetailsState } from "./helpers";

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

	/** Guard to suppress toggle persistence during programmatic state restoration. */
	private isRestoring = false;

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

	/**
	 * Scroll to and expand a specific settings group by title.
	 * Used by settings deep-links from chat messages.
	 */
	scrollToGroup(groupTitle: string): void {
		const details = this.containerEl.querySelector<HTMLDetailsElement>(
			`details[data-notor-group="${CSS.escape(groupTitle)}"]`
		);
		if (!details) return;
		details.open = true;
		details.scrollIntoView({ behavior: "smooth", block: "start" });

		// Restart animation if re-navigating to same group
		details.classList.remove("notor-settings-group-highlight");
		void details.offsetWidth; // force reflow
		details.classList.add("notor-settings-group-highlight");

		// Remove class after animation. Timeout fallback for prefers-reduced-motion
		// (animation: none → animationend never fires).
		const cleanup = () => details.classList.remove("notor-settings-group-highlight");
		details.addEventListener("animationend", cleanup, { once: true });
		setTimeout(cleanup, 2000);
	}

	display(): void {
		this.runCleanups();
		const { containerEl } = this;
		const detailsState = snapshotDetailsState(containerEl);
		containerEl.empty();

		const ctx: SettingsContext = {
			app: this.app,
			plugin: this.plugin,
			settings: this.plugin.settings,
			saveSettings: () => this.plugin.saveSettings(),
			redisplay: () => this.display(),
			addCleanup: (fn) => this.cleanupFns.push(fn),
		};

		const persisted = ctx.settings.settings_collapsed_sections;

		// Migrate persisted collapsed-section key from old name to new
		if ("Built-in tools" in persisted && !("Tools" in persisted)) {
			persisted["Tools"] = persisted["Built-in tools"];
			delete persisted["Built-in tools"];
			ctx.saveSettings();
		}

		const onToggle = (title: string, open: boolean) => {
			if (this.isRestoring) return;
			ctx.settings.settings_collapsed_sections[title] = open;
			ctx.saveSettings();
		};

		// --- Provider Setup (expanded by default) ---
		const providerGroup = createSettingsGroup(containerEl, "Provider setup", true, persisted, onToggle);
		renderActiveProviderSection(providerGroup, ctx);
		renderLocalProviderSection(providerGroup, ctx);
		renderAnthropicProviderSection(providerGroup, ctx);
		renderOpenAIProviderSection(providerGroup, ctx);
		renderBedrockProviderSection(providerGroup, ctx);

		// --- Conversation (expanded by default) ---
		const conversationGroup = createSettingsGroup(containerEl, "Conversation", true, persisted, onToggle);
		renderGeneralSection(conversationGroup, ctx);
		renderAutoContextSection(conversationGroup, ctx);
		renderCompactionSection(conversationGroup, ctx);

		// --- Personas (collapsed by default) ---
		const personasGroup = createSettingsGroup(containerEl, "Personas", false, persisted, onToggle);
		renderPersonasSection(personasGroup, ctx);

		// --- Sub-agents (collapsed by default) ---
		const subAgentsGroup = createSettingsGroup(containerEl, "Sub-agents", false, persisted, onToggle);
		renderSubAgentsSection(subAgentsGroup, ctx);

		// --- Rules and workflows (collapsed by default) ---
		const rulesWorkflowsGroup = createSettingsGroup(containerEl, "Rules and workflows", false, persisted, onToggle);
		renderRulesAndWorkflowsSection(rulesWorkflowsGroup, ctx);

		// --- Tools (expanded by default) ---
		const toolsGroup = createSettingsGroup(containerEl, "Tools", true, persisted, onToggle);
		renderToolsSection(toolsGroup, ctx);

		// --- MCP Servers (expanded by default) ---
		const mcpGroup = createSettingsGroup(containerEl, "MCP servers", true, persisted, onToggle);
		renderMcpServersSection(mcpGroup, ctx);

		// --- Tool Configuration (collapsed by default) ---
		const toolConfigGroup = createSettingsGroup(containerEl, "Tool configuration", false, persisted, onToggle);
		renderFetchWebpageSection(toolConfigGroup, ctx);
		renderWebSearchSection(toolConfigGroup, ctx);
		renderExecuteCommandSection(toolConfigGroup, ctx);
		renderDocxToolsSection(toolConfigGroup, ctx);
		renderFileAttachmentsSection(toolConfigGroup, ctx);

		// --- Automation (collapsed by default) ---
		const automationGroup = createSettingsGroup(containerEl, "Automation", false, persisted, onToggle);
		renderHooksSection(automationGroup, ctx);
		renderVaultEventHooksSection(automationGroup, ctx);

		// --- Storage (collapsed by default) ---
		const storageGroup = createSettingsGroup(containerEl, "Storage", false, persisted, onToggle);
		renderHistorySection(storageGroup, ctx);
		renderCheckpointSection(storageGroup, ctx);

		// --- Reference (collapsed by default) ---
		const referenceGroup = createSettingsGroup(containerEl, "Reference", false, persisted, onToggle);
		renderProviderModelReferenceSection(referenceGroup, ctx);
		renderModelPricingSection(referenceGroup, ctx);

		this.isRestoring = true;
		restoreDetailsState(containerEl, detailsState);
		this.isRestoring = false;
	}
}
