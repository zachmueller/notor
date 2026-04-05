/**
 * Extensions settings section renderer.
 *
 * Renders shared settings, per-tool settings, and per-automation settings
 * defined in user extension files, plus a "Reload extensions" button.
 *
 * @see specs/05-user-tools/tasks.md — EXT-015
 */

import { Notice, SecretComponent, Setting } from "obsidian";
import type { SettingsContext } from "./context";
import type { SettingsFieldSchema, UserToolDefinition, UserAutomationDefinition } from "../../extensions/types";
import { slugifySecretId } from "../../extensions/settings-schema";

/** Render the "Extensions" settings section. */
export function renderExtensionsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const manager = ctx.plugin.getExtensionManager();

	const sharedDef = manager.getSharedSettingsDefinition();
	const toolsWithSettings = manager.getTools().filter((t) => t.settingsSchema && t.settingsSchema.length > 0);
	const automationsWithSettings = manager.getAutomations().filter((a) => a.settingsSchema && a.settingsSchema.length > 0);

	const hasContent = sharedDef !== null || toolsWithSettings.length > 0 || automationsWithSettings.length > 0;

	if (!hasContent) {
		// Still show the reload button even when there's no settings content
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
		return;
	}

	// --- Shared settings ---
	if (sharedDef) {
		new Setting(containerEl).setHeading().setName("Shared settings");
		renderFieldList(containerEl, ctx, sharedDef.settingsSchema, {
			kind: "shared",
		});

		// Reset to defaults
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

	// --- Per-tool settings ---
	for (const tool of toolsWithSettings) {
		new Setting(containerEl).setHeading().setName(`Tool: ${tool.name}`);
		renderFieldList(containerEl, ctx, tool.settingsSchema!, {
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

	// --- Per-automation settings ---
	for (const automation of automationsWithSettings) {
		const label = automation.displayName ?? automation.filePath.split("/").pop()?.replace(/\.md$/, "") ?? automation.filePath;
		const extKey = automation.displayName ?? automation.filePath;

		new Setting(containerEl).setHeading().setName(`Automation: ${label}`);
		renderFieldList(containerEl, ctx, automation.settingsSchema!, {
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
	// Secret string field → SecretComponent
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

	// String with options → dropdown
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

	// Plain string → text input
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

	// Number → text input with validation
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

	// Boolean → toggle
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

	// string[] → dynamic list with add/remove
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
