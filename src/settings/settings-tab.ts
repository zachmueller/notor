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
import type { Persona } from "../types";
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
import { renderHooksSection } from "./sections/hooks";
import { renderVaultEventHooksSection } from "./sections/vault-event-hooks";
import { renderFileAttachmentsSection } from "./sections/file-attachments";
import { renderCompactionSection } from "./sections/compaction";
import { renderProviderModelReferenceSection } from "./sections/provider-reference";
import { renderGeneralSection } from "./sections/general";
import { renderAutoApproveSection } from "./sections/auto-approve";
import { renderPersonaAutoApproveSection, triggerPersonaRescan } from "./sections/persona-auto-approve";
import { renderHistorySection } from "./sections/history";
import { renderCheckpointSection } from "./sections/checkpoints";
import { renderModelPricingSection } from "./sections/model-pricing";
import { renderMcpServersSection } from "./sections/mcp-servers";

/**
 * Notor settings tab registered in Obsidian's Settings panel.
 *
 * Thin orchestrator — all rendering logic is delegated to per-section
 * functions in `src/settings/sections/`.
 */
export class NotorSettingTab extends PluginSettingTab {
	plugin: NotorPlugin;

	/** Cached personas from the most recent discovery scan. */
	private cachedPersonas: Persona[] = [];

	/** Container element for the persona auto-approve section. */
	private personaAutoApproveSectionEl: HTMLElement | null = null;

	constructor(app: App, plugin: NotorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const ctx: SettingsContext = {
			app: this.app,
			plugin: this.plugin,
			settings: this.plugin.settings,
			saveSettings: () => this.plugin.saveSettings(),
			redisplay: () => this.display(),
		};

		containerEl.createEl("h1", { text: "Notor" });

		renderActiveProviderSection(containerEl, ctx);
		renderLocalProviderSection(containerEl, ctx);
		renderAnthropicProviderSection(containerEl, ctx);
		renderOpenAIProviderSection(containerEl, ctx);
		renderBedrockProviderSection(containerEl, ctx);
		renderAutoContextSection(containerEl, ctx);
		renderFetchWebpageSection(containerEl, ctx);
		renderExecuteCommandSection(containerEl, ctx);
		renderHooksSection(containerEl, ctx);
		renderVaultEventHooksSection(containerEl, ctx);
		renderFileAttachmentsSection(containerEl, ctx);
		renderCompactionSection(containerEl, ctx);
		renderProviderModelReferenceSection(containerEl, ctx);
		renderGeneralSection(containerEl, ctx);
		renderAutoApproveSection(containerEl, ctx);

		// Persona auto-approve section with async rescan
		this.personaAutoApproveSectionEl = containerEl.createDiv();
		const rerenderPersonaSection = (personas: Persona[]) => {
			this.cachedPersonas = personas;
			if (this.personaAutoApproveSectionEl) {
				this.personaAutoApproveSectionEl.empty();
				renderPersonaAutoApproveSection(
					this.personaAutoApproveSectionEl,
					personas,
					ctx,
					rerenderPersonaSection
				);
			}
		};
		renderPersonaAutoApproveSection(
			this.personaAutoApproveSectionEl,
			this.cachedPersonas,
			ctx,
			rerenderPersonaSection
		);
		triggerPersonaRescan(ctx, rerenderPersonaSection);

		renderMcpServersSection(containerEl, ctx);
		renderHistorySection(containerEl, ctx);
		renderCheckpointSection(containerEl, ctx);
		renderModelPricingSection(containerEl, ctx);
	}
}
