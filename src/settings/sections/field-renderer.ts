/**
 * Shared field-rendering infrastructure for extension settings.
 *
 * Extracted from `extensions.ts` so that `ToolSettingsModal`, the Automation
 * section, and the shared-settings sub-section can all reuse the same
 * renderers without importing from the (soon-to-be-deleted) extensions
 * section file.
 *
 * @see specs/ZZ-misc/settings-reorganization-design.md — Section 5
 */

import { Notice, SecretComponent, Setting } from "obsidian";
import type { SettingsContext } from "./context";
import type { SettingsFieldSchema } from "../../extensions/types";
import { slugifySecretId } from "../../utils/secrets";
import { getSecret } from "../../utils/secrets";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** @internal Exported for tests. */
export type FieldTarget =
	| { kind: "shared" }
	| { kind: "extension"; extensionName: string };

// ---------------------------------------------------------------------------
// Field list renderer
// ---------------------------------------------------------------------------

/**
 * Render a list of settings fields using the appropriate UI component for each type.
 *
 * @param onSecretChange - Called when any secret field changes. Use to re-render
 *   the container so fields gated by `requiresSecret` update immediately.
 */
export function renderFieldList(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	schemas: SettingsFieldSchema[],
	target: FieldTarget,
	onSecretChange?: () => void,
): void {
	for (const field of schemas) {
		renderField(containerEl, ctx, field, target, onSecretChange);
	}
}

// ---------------------------------------------------------------------------
// Persisted value helpers
// ---------------------------------------------------------------------------

/** Get the current persisted value for a field. */
export function getPersistedValue(
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
export async function saveFieldValue(
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

// ---------------------------------------------------------------------------
// Single-field renderer
// ---------------------------------------------------------------------------

/** @internal Render a single settings field using the appropriate UI component. Exported for tests. */
export function renderField(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	field: SettingsFieldSchema,
	target: FieldTarget,
	onSecretChange?: () => void,
): void {
	// Hide field when its required secret is absent
	if (field.requiresSecret) {
		const secretId = target.kind === "shared"
			? slugifySecretId("notor-shared", field.requiresSecret)
			: slugifySecretId("notor-ext", target.extensionName, field.requiresSecret);
		const secretValue = getSecret(ctx.app, secretId);
		if (!secretValue) return;
	}

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
						onSecretChange?.();
					}),
		);
		return;
	}

	// Resolve dynamic options source before checking for dropdown
	if (field.optionsSource && !field.options?.length) {
		if (field.optionsSource === "model_presets") {
			const presetNames = ctx.settings.model_presets
				.filter((p) => p.provider_id !== null && p.model_id !== null)
				.map((p) => p.name);
			field = { ...field, options: presetNames };
		}
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

	// string[] -> dynamic list with add/remove/reorder
	if (field.type === "string[]") {
		const persisted = getPersistedValue(ctx, field, target);
		let currentList: string[] = Array.isArray(persisted)
			? persisted
			: Array.isArray(field.default)
				? [...field.default]
				: [];

		// When options are constrained, drop any existing entries that are no longer valid.
		// This handles the case where an API key is removed after a provider was added to the list.
		if (field.options && field.options.length > 0) {
			const filtered = currentList.filter((item) => field.options!.includes(item));
			if (filtered.length !== currentList.length) {
				currentList = filtered;
				void saveFieldValue(ctx, field, target, currentList);
			}
		}

		const setting = new Setting(containerEl).setName(field.name);
		if (field.description) setting.setDesc(field.description);

		// Render existing entries with reorder + remove buttons
		for (let i = 0; i < currentList.length; i++) {
			const entry = currentList[i] ?? "";
			const entrySetting = new Setting(containerEl).setName(entry || "(empty)");

			// Up button (hidden for first entry)
			if (i > 0) {
				entrySetting.addButton((btn) =>
					btn.setButtonText("\u25B2").onClick(async () => {
						const tmp = currentList[i - 1]!;
						currentList[i - 1] = currentList[i]!;
						currentList[i] = tmp;
						await saveFieldValue(ctx, field, target, currentList);
						ctx.redisplay();
					}),
				);
			}

			// Down button (hidden for last entry)
			if (i < currentList.length - 1) {
				entrySetting.addButton((btn) =>
					btn.setButtonText("\u25BC").onClick(async () => {
						const tmp = currentList[i + 1]!;
						currentList[i + 1] = currentList[i]!;
						currentList[i] = tmp;
						await saveFieldValue(ctx, field, target, currentList);
						ctx.redisplay();
					}),
				);
			}

			entrySetting.addButton((btn) =>
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

		// Add new entry — dropdown when field.options present, free text otherwise
		const hasOptions = field.options && field.options.length > 0;
		if (hasOptions) {
			const unusedOptions = field.options!.filter((o) => !currentList.includes(o));
			if (unusedOptions.length > 0) {
				let selectedOption = unusedOptions[0]!;
				new Setting(containerEl)
					.setName(`Add to ${field.name}`)
					.addDropdown((dropdown) => {
						for (const option of unusedOptions) {
							dropdown.addOption(option, option);
						}
						dropdown.setValue(selectedOption).onChange((v) => {
							selectedOption = v;
						});
					})
					.addButton((btn) =>
						btn.setButtonText("Add").onClick(async () => {
							currentList.push(selectedOption);
							await saveFieldValue(ctx, field, target, currentList);
							ctx.redisplay();
						}),
					);
			}
		} else {
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
}
