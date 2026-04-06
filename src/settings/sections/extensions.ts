/**
 * Extensions settings section renderer.
 *
 * Renders built-in tools with customize/open/reset actions, shared settings,
 * per-tool settings, and per-automation settings defined in user extension
 * files, plus a "Reload extensions" button.
 *
 * @see specs/05-user-tools/tasks.md — EXT-015
 */

import { Notice, SecretComponent, Setting, normalizePath } from "obsidian";
import type { SettingsContext } from "./context";
import type { SettingsFieldSchema } from "../../extensions/types";
import { slugifySecretId } from "../../extensions/settings-schema";
import { ConfirmModal } from "../../ui/confirm-modal";

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

// ---------------------------------------------------------------------------
// User automations section
// ---------------------------------------------------------------------------

/**
 * Render a listing of all user-defined automations.
 */
function renderUserAutomationsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const manager = ctx.plugin.getExtensionManager();
	const automations = manager.getAutomations();

	if (automations.length === 0) return;

	new Setting(containerEl).setHeading().setName("User automations");

	for (const automation of automations) {
		const label = automation.displayName
			?? automation.filePath.split("/").pop()?.replace(/\.md$/, "")
			?? automation.filePath;
		const extKey = automation.displayName ?? automation.filePath;

		const setting = new Setting(containerEl)
			.setName(label)
			.setDesc(`Trigger: ${automation.trigger}`);

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
					await ctx.app.workspace.openLinkText(automation.filePath, "", true);
				}),
		);

		// Inline settings if present
		if (automation.settingsSchema && automation.settingsSchema.length > 0) {
			renderFieldList(containerEl, ctx, automation.settingsSchema, {
				kind: "extension",
				extensionName: extKey,
			});

			new Setting(containerEl).addButton((btn) =>
				btn
					.setButtonText("Reset to defaults")
					.setWarning()
					.onClick(async () => {
						delete ctx.settings.user_extension_settings[extKey];
						await ctx.saveSettings();
						ctx.redisplay();
					}),
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Field rendering
// ---------------------------------------------------------------------------

type FieldTarget =
	| { kind: "shared" }
	| { kind: "extension"; extensionName: string };

/**
 * Render a list of settings fields using the appropriate UI component for each type.
 */
function renderFieldList(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	schemas: SettingsFieldSchema[],
	target: FieldTarget,
): void {
	for (const field of schemas) {
		renderField(containerEl, ctx, field, target);
	}
}

/** Get the current persisted value for a field. */
function getPersistedValue(
	ctx: SettingsContext,
	field: SettingsFieldSchema,
	target: FieldTarget,
): string | number | boolean | string[] | undefined {
	if (target.kind === "shared") {
		return ctx.settings.user_shared_settings[field.key];
	}
	return ctx.settings.user_extension_settings[target.extensionName]?.[field.key];
}

/** Save a value for a field. */
async function saveFieldValue(
	ctx: SettingsContext,
	field: SettingsFieldSchema,
	target: FieldTarget,
	value: string | number | boolean | string[],
): Promise<void> {
	if (target.kind === "shared") {
		ctx.settings.user_shared_settings[field.key] = value;
	} else {
		const extSettings = ctx.settings.user_extension_settings[target.extensionName] ??= {};
		extSettings[field.key] = value;
	}
	await ctx.saveSettings();
}

/** Render a single settings field using the appropriate UI component. */
function renderField(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	field: SettingsFieldSchema,
	target: FieldTarget,
): void {
	// Secret string field -> SecretComponent
	if (field.type === "string" && field.secret) {
		const secretId = target.kind === "shared"
			? slugifySecretId("notor-shared", field.key)
			: slugifySecretId("notor-ext", target.extensionName, field.key);

		const setting = new Setting(containerEl).setName(field.name);
		if (field.description) setting.setDesc(field.description);
		setting.addComponent(
			(el) =>
				new SecretComponent(ctx.app, el)
					.setValue(secretId)
					.onChange((_value) => {
						// SecretComponent writes directly to SecretStorage.
					}),
		);
		return;
	}

	// String with options -> dropdown
	if (field.type === "string" && field.options && field.options.length > 0) {
		const persisted = getPersistedValue(ctx, field, target);
		const currentValue = persisted !== undefined ? String(persisted) : (field.default !== undefined ? String(field.default) : "");

		const setting = new Setting(containerEl).setName(field.name);
		if (field.description) setting.setDesc(field.description);
		setting.addDropdown((dropdown) => {
			for (const option of field.options!) {
				dropdown.addOption(option, option);
			}
			dropdown.setValue(currentValue).onChange(async (value) => {
				await saveFieldValue(ctx, field, target, value);
			});
		});
		return;
	}

	// Plain string -> text input
	if (field.type === "string") {
		const persisted = getPersistedValue(ctx, field, target);
		const currentValue = persisted !== undefined ? String(persisted) : (field.default !== undefined ? String(field.default) : "");

		const setting = new Setting(containerEl).setName(field.name);
		if (field.description) setting.setDesc(field.description);
		setting.addText((text) =>
			text
				.setValue(currentValue)
				.onChange(async (value) => {
					await saveFieldValue(ctx, field, target, value);
				}),
		);
		return;
	}

	// Number -> text input with validation
	if (field.type === "number") {
		const persisted = getPersistedValue(ctx, field, target);
		const currentValue = persisted !== undefined ? String(persisted) : (field.default !== undefined ? String(field.default) : "");

		const setting = new Setting(containerEl).setName(field.name);
		if (field.description) setting.setDesc(field.description);
		setting.addText((text) =>
			text
				.setValue(currentValue)
				.onChange(async (value) => {
					const parsed = parseFloat(value);
					if (isNaN(parsed)) return;
					if (field.min !== undefined && parsed < field.min) return;
					if (field.max !== undefined && parsed > field.max) return;
					await saveFieldValue(ctx, field, target, parsed);
				}),
		);
		return;
	}

	// Boolean -> toggle
	if (field.type === "boolean") {
		const persisted = getPersistedValue(ctx, field, target);
		const currentValue = persisted !== undefined ? Boolean(persisted) : (field.default !== undefined ? Boolean(field.default) : false);

		const setting = new Setting(containerEl).setName(field.name);
		if (field.description) setting.setDesc(field.description);
		setting.addToggle((toggle) =>
			toggle.setValue(currentValue).onChange(async (value) => {
				await saveFieldValue(ctx, field, target, value);
			}),
		);
		return;
	}

	// string[] -> dynamic list with add/remove
	if (field.type === "string[]") {
		const persisted = getPersistedValue(ctx, field, target);
		const currentList: string[] = Array.isArray(persisted)
			? (persisted as string[])
			: Array.isArray(field.default)
				? [...(field.default as string[])]
				: [];

		const setting = new Setting(containerEl).setName(field.name);
		if (field.description) setting.setDesc(field.description);

		// Render existing entries with Remove button
		for (let i = 0; i < currentList.length; i++) {
			const entry = currentList[i] ?? "";
			new Setting(containerEl)
				.setName(entry || "(empty)")
				.addButton((btn) =>
					btn
						.setButtonText("Remove")
						.setWarning()
						.onClick(async () => {
							currentList.splice(i, 1);
							await saveFieldValue(ctx, field, target, currentList);
							ctx.redisplay();
						}),
				);
		}

		// Add new entry input
		let newValue = "";
		new Setting(containerEl)
			.setName(`Add to ${field.name}`)
			.addText((text) => {
				text.setPlaceholder("Enter value").onChange((v) => {
					newValue = v.trim();
				});
			})
			.addButton((btn) =>
				btn.setButtonText("Add").onClick(async () => {
					if (!newValue) {
						new Notice("Enter a value to add.");
						return;
					}
					currentList.push(newValue);
					await saveFieldValue(ctx, field, target, currentList);
					ctx.redisplay();
				}),
			);
	}
}
