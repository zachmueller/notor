/**
 * Extensions settings section renderer.
 *
 * Renders built-in tools with customize/open/reset actions, shared settings,
 * per-tool settings, and per-automation settings defined in user extension
 * files, plus a "Reload extensions" button.
 *
 * @see specs/05-user-tools/tasks.md — EXT-015
 */

import { Notice, Setting, normalizePath } from "obsidian";
import type { SettingsContext } from "./context";
import { ConfirmModal } from "../../ui/confirm-modal";
import {
	type FieldTarget,
	renderFieldList,
	renderField,
} from "./field-renderer";
import { renderUserAutomationsSection } from "./user-automations";

// Re-export for backward compatibility (temporary — removed in Phase 7)
export { type FieldTarget, renderField };

/** Render the "Extensions" settings section. */
export function renderExtensionsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const manager = ctx.plugin.getExtensionManager();

	// --- Built-in tools ---
	renderBuiltinToolsSection(containerEl, ctx);

	// --- Shared settings ---
	const sharedDef = manager.getSharedSettingsDefinition();
	if (sharedDef) {
		new Setting(containerEl).setHeading().setName("Shared settings");
		renderFieldList(containerEl, ctx, sharedDef.settingsSchema, {
			kind: "shared",
		});

		new Setting(containerEl).addButton((btn) =>
			btn
				.setButtonText("Reset to defaults")
				.setWarning()
				.onClick(async () => {
					ctx.settings.user_shared_settings = {};
					await ctx.saveSettings();
					ctx.redisplay();
				}),
		);
	}

	// --- User tools ---
	renderUserToolsSection(containerEl, ctx);

	// --- User automations ---
	renderUserAutomationsSection(containerEl, ctx);

	// --- Reload button ---
	new Setting(containerEl)
		.setName("Reload extensions")
		.setDesc("Re-discover and re-compile all user tools and automations.")
		.addButton((btn) =>
			btn.setButtonText("Reload").onClick(async () => {
				const result = await manager.reload(false);
				const summary =
					`Extensions reloaded: ${result.toolCount} tool${result.toolCount !== 1 ? "s" : ""}, ` +
					`${result.automationCount} automation${result.automationCount !== 1 ? "s" : ""}` +
					(result.errors.length > 0 ? ` (${result.errors.length} error${result.errors.length !== 1 ? "s" : ""})` : "");
				new Notice(summary);
				ctx.redisplay();
			}),
		);
}

// ---------------------------------------------------------------------------
// Built-in tools section
// ---------------------------------------------------------------------------

/**
 * Render a listing of all built-in tools with customize/open/reset actions.
 */
function renderBuiltinToolsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const manager = ctx.plugin.getExtensionManager();
	const registry = ctx.plugin.getToolRegistry();
	const builtinNames = manager.getBuiltinToolNames();

	new Setting(containerEl).setHeading().setName("Built-in tools");
	containerEl.createEl("p", {
		text:
			"Create customizable copies of built-in tools. " +
			"Customized tools override the built-in implementation after reload.",
		cls: "setting-item-description",
	});

	const toolDefsByName = new Map(
		manager.getTools().map((t) => [t.name, t]),
	);

	for (const toolName of builtinNames) {
		const tool = registry.get(toolName);

		const setting = new Setting(containerEl).setName(toolName);

		if (tool) {
			setting.setDesc(tool.description);
		}

		// "Built-in" badge
		const badge = setting.nameEl.createSpan({
			text: "Built-in",
			cls: "notor-extension-badge-builtin",
		});
		badge.style.marginLeft = "8px";
		badge.style.fontSize = "0.75em";
		badge.style.opacity = "0.7";
		badge.style.fontStyle = "italic";

		const vaultFilePath = normalizePath(
			`${ctx.settings.notor_dir}/tools/${toolName}.md`,
		);
		const vaultFileExists =
			ctx.app.vault.getAbstractFileByPath(vaultFilePath) !== null;

		if (vaultFileExists) {
			// Open button
			setting.addButton((btn) =>
				btn
					.setIcon("square-arrow-out-up-right")
					.setTooltip("Open extension file")
					.onClick(async () => {
						await ctx.app.workspace.openLinkText(vaultFilePath, "", true);
					}),
			);

			// Reset to default button
			setting.addButton((btn) =>
				btn
					.setButtonText("Reset to default")
					.setTooltip(
						"Delete customized file and restore built-in default",
					)
					.onClick(() => {
						new ConfirmModal(
							ctx.app,
							"Reset to default?",
							`This will delete your customized "${toolName}" file and restore the built-in default. Any custom logic will be lost.`,
							async () => {
								try {
									await manager.resetBuiltinToolToDefault(toolName);
									await manager.reload(false);
									new Notice(`Tool "${toolName}" reset to default.`);
									ctx.redisplay();
								} catch (e) {
									const msg = e instanceof Error ? e.message : String(e);
									new Notice(`Failed to reset tool: ${msg}`);
								}
							},
							"Reset to default",
							true,
						).open();
					}),
			);
		} else {
			// Customize button
			setting.addButton((btn) =>
				btn
					.setButtonText("Customize")
					.setTooltip("Create a vault file to customize this tool")
					.onClick(async () => {
						try {
							const path = await manager.ensureBuiltinToolVaultFile(toolName);
							await ctx.app.workspace.openLinkText(path, "", true);
							new Notice(
								`Created ${path} — reload extensions to activate.`,
							);
							ctx.redisplay();
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							new Notice(`Failed to create tool file: ${msg}`);
						}
					}),
			);
		}

		// Inline settings if present
		const toolDef = toolDefsByName.get(toolName);
		if (toolDef?.settingsSchema && toolDef.settingsSchema.length > 0) {
			renderFieldList(containerEl, ctx, toolDef.settingsSchema, {
				kind: "extension",
				extensionName: toolName,
			});

			new Setting(containerEl).addButton((btn) =>
				btn
					.setButtonText("Reset to defaults")
					.setWarning()
					.onClick(async () => {
						delete ctx.settings.user_extension_settings[toolName];
						await ctx.saveSettings();
						ctx.redisplay();
					}),
			);
		}
	}
}

// ---------------------------------------------------------------------------
// User tools section
// ---------------------------------------------------------------------------

/**
 * Render a listing of all user-defined tools (excluding built-in overrides,
 * which are already shown in the Built-in tools section).
 */
function renderUserToolsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const manager = ctx.plugin.getExtensionManager();
	const builtinNames = new Set(manager.getBuiltinToolNames());
	const userTools = manager.getTools().filter((t) => !builtinNames.has(t.name));

	if (userTools.length === 0) return;

	new Setting(containerEl).setHeading().setName("User tools");

	for (const tool of userTools) {
		const setting = new Setting(containerEl)
			.setName(tool.name)
			.setDesc(tool.description);

		// "User" badge
		const badge = setting.nameEl.createSpan({
			text: "User",
			cls: "notor-extension-badge-user",
		});
		badge.style.marginLeft = "8px";
		badge.style.fontSize = "0.75em";
		badge.style.opacity = "0.7";
		badge.style.fontStyle = "italic";

		// Open button
		setting.addButton((btn) =>
			btn
				.setIcon("square-arrow-out-up-right")
				.setTooltip("Open extension file")
				.onClick(async () => {
					await ctx.app.workspace.openLinkText(tool.filePath, "", true);
				}),
		);

		// Inline settings if present
		if (tool.settingsSchema && tool.settingsSchema.length > 0) {
			renderFieldList(containerEl, ctx, tool.settingsSchema, {
				kind: "extension",
				extensionName: tool.name,
			});

			new Setting(containerEl).addButton((btn) =>
				btn
					.setButtonText("Reset to defaults")
					.setWarning()
					.onClick(async () => {
						delete ctx.settings.user_extension_settings[tool.name];
						await ctx.saveSettings();
						ctx.redisplay();
					}),
			);
		}
	}
}

// User automations — imported from ./user-automations (Phase 5 extraction)

