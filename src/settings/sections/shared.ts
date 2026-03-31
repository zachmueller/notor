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
