/**
 * Step definitions for the guided setup wizard.
 *
 * Key settings are summarized with a few inline controls; everything else
 * links to the full settings tab via `host.openInSettings()`.
 */

import { Setting } from "obsidian";
import type { ConversationMode } from "../../types";
import type { SettingsContext } from "../../settings/sections/context";
import { TOOLS_DEFAULT_DISABLED } from "../../settings/constants";
import { renderWorkspaceBehaviorSettings } from "../../settings/sections/general";
import { isPresetConfigured, isProviderConfigured } from "../../settings/setup-detection";
import { renderModelStep, renderProvidersStep } from "./provider-steps";
import type { SetupStep, SetupWizardHost } from "./types";

function renderWelcomeStep(containerEl: HTMLElement): void {
	containerEl.createEl("p", {
		text:
			"Notor needs two things before you can chat: an AI provider and a model to use. " +
			"This guide sets those up, then points out a few settings worth knowing about.",
	});
	const listEl = containerEl.createEl("ul");
	for (const item of [
		"Connect one or more providers",
		"Pick a model for your default preset",
		"Review safety and tool settings",
		"Choose how Notor works with your notes",
		"Learn where to add MCP servers",
	]) {
		listEl.createEl("li", { text: item });
	}
	containerEl.createEl("p", {
		text: "Every change saves immediately. You can close this guide at any time and pick up in the settings below.",
		cls: "setting-item-description",
	});
}

function renderSafetyStep(containerEl: HTMLElement, ctx: SettingsContext, host: SetupWizardHost): void {
	containerEl.createEl("p", {
		text:
			"In Plan mode the AI can only read your vault and propose changes. In Act mode it can also " +
			"edit notes and run tools. Switch modes any time with the Plan / Act toggle in the chat panel.",
	});

	new Setting(containerEl)
		.setName("Default mode for new chats")
		.addDropdown((dropdown) => {
			dropdown.addOption("plan", "Plan (read-only)");
			dropdown.addOption("act", "Act");
			dropdown.setValue(ctx.settings.mode);
			dropdown.onChange(async (value) => {
				ctx.settings.mode = value as ConversationMode;
				await ctx.saveSettings();
			});
		});

	new Setting(containerEl)
		.setName("Allow shell commands")
		.setDesc(
			"Lets the AI run shell commands on your computer with the execute_command tool. " +
				"Each command still asks for your approval."
		)
		.addToggle((toggle) =>
			toggle
				.setValue(
					ctx.settings.tool_enabled["execute_command"] ??
						!TOOLS_DEFAULT_DISABLED.has("execute_command")
				)
				.onChange(async (value) => {
					ctx.settings.tool_enabled["execute_command"] = value;
					await ctx.saveSettings();
				})
		);

	containerEl.createEl("p", {
		text:
			"By default, read-only tools (reading and searching notes, fetching web pages) run without asking. " +
			"Tools that change your notes or files ask for approval first and show a diff before applying.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("All tools")
		.setDesc("Turn individual tools on or off and choose which ones skip approval.")
		.addButton((btn) =>
			btn.setButtonText("Review all tools →").onClick(() => host.openInSettings("Tools"))
		);
}

function renderWorkspaceStep(containerEl: HTMLElement, ctx: SettingsContext): void {
	containerEl.createEl("p", {
		text: "Choose where Notor keeps its own files and how it shows the notes the AI works with.",
	});
	renderWorkspaceBehaviorSettings(containerEl, ctx);
}

function renderMcpStep(containerEl: HTMLElement, _ctx: SettingsContext, host: SetupWizardHost): void {
	containerEl.createEl("p", {
		text:
			"MCP (Model Context Protocol) servers give the AI extra tools, such as access to calendars, " +
			"issue trackers, or databases. Notor connects to local (stdio) and remote (HTTP) servers.",
	});
	containerEl.createEl("p", {
		text: "This is optional. The MCP servers guide in the Notor docs walks through connecting your first server.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("MCP servers")
		.setDesc("Add a server, then enable the tools it provides.")
		.addButton((btn) =>
			btn.setButtonText("Configure MCP servers →").onClick(() => host.openInSettings("MCP servers"))
		);
}

function renderDoneStep(containerEl: HTMLElement, ctx: SettingsContext): void {
	const { settings } = ctx;
	const providers = settings.providers.filter((p) =>
		isProviderConfigured(ctx.app, p, settings.model_presets)
	);
	const preset = settings.model_presets.find((p) => p.name === settings.default_preset);
	const presetReady = !!preset && isPresetConfigured(preset);

	const listEl = containerEl.createEl("ul", { cls: "notor-setup-wizard-checklist" });
	const addItem = (done: boolean, text: string) =>
		listEl.createEl("li", {
			text: `${done ? "✓" : "✗"} ${text}`,
			cls: `notor-setup-wizard-check ${done ? "is-done" : "is-missing"}`,
		});

	addItem(
		providers.length > 0,
		providers.length > 0
			? `Providers: ${providers.map((p) => p.display_name).join(", ")}`
			: "No provider configured"
	);
	addItem(
		presetReady,
		presetReady
			? `Default preset "${preset.name}": ${preset.model_id}`
			: "Default preset has no model yet"
	);
	addItem(true, `New chats start in ${settings.mode === "act" ? "Act" : "Plan"} mode`);

	containerEl.createEl("p", {
		text:
			providers.length > 0 && presetReady
				? "You're ready. Run the Open chat panel command from the command palette to start chatting."
				: "Select Back to finish the missing items, or configure them in the settings below.",
		cls: "setting-item-description",
	});
}

export const SETUP_STEPS: SetupStep[] = [
	{ title: "Welcome", render: (el) => renderWelcomeStep(el) },
	{ title: "Providers", render: renderProvidersStep },
	{ title: "Model", render: renderModelStep },
	{ title: "Safety and tools", render: renderSafetyStep },
	{ title: "Workspace", render: (el, ctx) => renderWorkspaceStep(el, ctx) },
	{ title: "MCP servers", render: renderMcpStep },
	{ title: "Done", render: (el, ctx) => renderDoneStep(el, ctx) },
];
