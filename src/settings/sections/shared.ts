/**
 * Shared helpers for settings section renderers.
 *
 * Extracted from personas.ts to be reused by rules-and-workflows.ts.
 */

import { normalizePath } from "obsidian";
import type { SettingsContext } from "./context";

/**
 * Prompt the user for a name using a simple inline input.
 *
 * Returns the trimmed name, or null if the user cancelled.
 */
export function promptForName(
	containerEl: HTMLElement,
	placeholder: string
): Promise<string | null> {
	return new Promise((resolve) => {
		const wrapper = containerEl.createDiv({
			cls: "notor-persona-name-prompt",
		});
		const input = wrapper.createEl("input", {
			type: "text",
			placeholder,
		});

		const ok = wrapper.createEl("button", { text: "OK" });
		const cancel = wrapper.createEl("button", { text: "Cancel" });

		const cleanup = (value: string | null) => {
			wrapper.remove();
			resolve(value);
		};

		ok.addEventListener("click", () => {
			const val = input.value.trim();
			cleanup(val || null);
		});
		cancel.addEventListener("click", () => cleanup(null));
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				const val = input.value.trim();
				cleanup(val || null);
			} else if (e.key === "Escape") {
				cleanup(null);
			}
		});

		input.focus();
	});
}

// ---------------------------------------------------------------------------
// Multi-field creation prompt
// ---------------------------------------------------------------------------

/** Describes a single field in the creation prompt. */
export interface CreationField {
	type: "text" | "select";
	key: string;
	placeholder?: string;
	options?: Array<{ value: string; label: string }>;
	/** Only show this field when another field has a specific value. */
	showWhen?: { key: string; value: string };
}

/**
 * Prompt the user with multiple inline fields (text inputs and dropdowns).
 *
 * Returns a `Record<string, string>` of field values keyed by `field.key`,
 * or `null` if the user cancelled. The "name" field (first text field) must
 * be non-empty for OK to succeed.
 */
export function promptForCreation(
	containerEl: HTMLElement,
	fields: CreationField[]
): Promise<Record<string, string> | null> {
	return new Promise((resolve) => {
		const wrapper = containerEl.createDiv({
			cls: "notor-persona-name-prompt",
		});

		const elements = new Map<string, HTMLInputElement | HTMLSelectElement>();
		const conditionalRows = new Map<string, HTMLElement>();

		for (const field of fields) {
			const row = wrapper.createDiv({ cls: "notor-creation-field-row" });

			if (field.showWhen) {
				row.style.display = "none";
				conditionalRows.set(field.key, row);
			}

			if (field.type === "select" && field.options) {
				const select = row.createEl("select");
				for (const opt of field.options) {
					const optEl = select.createEl("option", { text: opt.label });
					optEl.value = opt.value;
				}
				elements.set(field.key, select);

				// Drive conditional visibility of dependent fields
				select.addEventListener("change", () => updateVisibility());
			} else {
				const input = row.createEl("input", {
					type: "text",
					placeholder: field.placeholder ?? "",
				});
				elements.set(field.key, input);
			}
		}

		const buttonRow = wrapper.createDiv({ cls: "notor-creation-field-row" });
		const ok = buttonRow.createEl("button", { text: "OK" });
		const cancel = buttonRow.createEl("button", { text: "Cancel" });

		function updateVisibility(): void {
			for (const field of fields) {
				if (!field.showWhen) continue;
				const row = conditionalRows.get(field.key);
				const dep = elements.get(field.showWhen.key);
				if (row && dep) {
					row.style.display =
						dep.value === field.showWhen.value ? "" : "none";
				}
			}
		}

		function collectValues(): Record<string, string> {
			const result: Record<string, string> = {};
			for (const [key, el] of elements) {
				result[key] = el.value.trim();
			}
			return result;
		}

		const cleanup = (values: Record<string, string> | null) => {
			wrapper.remove();
			resolve(values);
		};

		const submit = () => {
			const values = collectValues();
			// The "name" field must be non-empty
			if (!values["name"]) {
				cleanup(null);
				return;
			}
			cleanup(values);
		};

		ok.addEventListener("click", submit);
		cancel.addEventListener("click", () => cleanup(null));

		// Allow Enter/Escape on any text input
		for (const el of elements.values()) {
			if (el instanceof HTMLInputElement) {
				el.addEventListener("keydown", (e) => {
					if (e.key === "Enter") submit();
					else if (e.key === "Escape") cleanup(null);
				});
			}
		}

		// Focus the first text input
		const firstInput = elements.get("name");
		if (firstInput) firstInput.focus();

		// Initial visibility pass
		updateVisibility();
	});
}

/** Ensure a directory path exists, creating intermediate folders as needed. */
export async function ensureDirectory(
	ctx: SettingsContext,
	dirPath: string
): Promise<void> {
	const parts = dirPath.split("/");
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const normalized = normalizePath(current);
		if (!ctx.app.vault.getAbstractFileByPath(normalized)) {
			await ctx.app.vault.createFolder(normalized);
		}
	}
}
