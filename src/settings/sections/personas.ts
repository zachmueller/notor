/**
 * Personas settings section renderer (UI-002).
 *
 * Provides a "Create new persona" button and lists existing personas
 * with "Open system prompt" actions. Persona discovery runs once at
 * settings-open time (not live-updated while the tab is open).
 *
 * @see specs/04b-tool-toggle/tasks.md — UI-002
 * @see specs/04b-tool-toggle/spec.md — FR-87
 */

import { Notice, Setting, normalizePath } from "obsidian";
import type { SettingsContext } from "./context";
import { discoverPersonas } from "../../personas/persona-discovery";
import { promptForName, ensureDirectory } from "./shared";
import { logger } from "../../utils/logger";

const log = logger("PersonasSection");

const SKELETON_CONTENT = `---
notor-persona-prompt-mode: replace
# notor-persona-preferred-provider: anthropic
# notor-persona-preferred-model: claude-sonnet-4-20250514
---

<!-- System prompt for this persona. -->

<notor_tool_config version="1.0">
# Customize tool behaviour for this persona.
# Unlisted tools inherit their settings from global defaults.
# Example:
# execute_command:
#   enabled: false
</notor_tool_config>
`;

/** Render the "Personas" settings section. */
export function renderPersonasSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Personas");
	containerEl.createEl("p", {
		text:
			"Personas customise the system prompt and tool behaviour per context. " +
			"Each persona lives in a subdirectory under the notor personas folder.",
		cls: "setting-item-description",
	});

	// "Create new persona" button
	new Setting(containerEl)
		.setName("Create new persona")
		.setDesc(
			"Creates a skeleton system-prompt.md with a placeholder <notor_tool_config> block."
		)
		.addButton((btn) =>
			btn.setButtonText("Create").onClick(async () => {
				const name = await promptForName(containerEl, "Persona name (e.g. researcher)");
				if (!name) return;

				const dir = normalizePath(
					`${ctx.settings.notor_dir}/personas/${name}`
				);
				const filePath = normalizePath(`${dir}/system-prompt.md`);

				// Guard: check if the file already exists
				if (ctx.app.vault.getAbstractFileByPath(filePath)) {
					new Notice(`Persona "${name}" already exists.`);
					return;
				}

				try {
					// Ensure directory exists
					await ensureDirectory(ctx, dir);
					await ctx.app.vault.create(filePath, SKELETON_CONTENT);
					new Notice(`Persona "${name}" created.`);
					// Re-render to show the new persona in the list
					ctx.redisplay();
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Failed to create persona", { name, error: msg });
					new Notice(`Failed to create persona: ${msg}`);
				}
			})
		);

	// Existing personas list (populated at settings-open time)
	const listContainer = containerEl.createDiv({
		cls: "notor-personas-list",
	});

	discoverPersonas(
		ctx.app.vault,
		ctx.app.metadataCache,
		ctx.settings.notor_dir
	)
		.then((personas) => {
			if (personas.length === 0) {
				listContainer.createEl("p", {
					text: "No personas found.",
					cls: "setting-item-description",
				});
				return;
			}

			for (const persona of personas) {
				new Setting(listContainer)
					.setName(persona.name)
					.addButton((btn) =>
						btn
							.setButtonText("Open system prompt")
							.onClick(() => {
								void ctx.app.workspace.openLinkText(
									persona.system_prompt_path,
									""
								);
							})
					);
			}
		})
		.catch((e) => {
			log.error("Failed to discover personas for settings", {
				error: String(e),
			});
			listContainer.createEl("p", {
				text: "Failed to load personas.",
				cls: "setting-item-description",
			});
		});
}

