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

import { Notice, Setting, TFile, normalizePath } from "obsidian";
import type { SettingsContext } from "./context";
import type { Persona } from "../../types";
import { discoverPersonas } from "../../personas/persona-discovery";
import { BUILTIN_PERSONA_NAMES } from "../../personas/builtin-personas";
import { promptForCreation, ensureDirectory, type CreationField } from "./shared";
import { logger } from "../../utils/logger";

const log = logger("PersonasSection");

/** Build skeleton system-prompt.md content with the chosen prompt mode. */
function buildSkeletonContent(promptMode: string): string {
	return `---
notor-persona-prompt-mode: ${promptMode}
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
}

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
				const fields: CreationField[] = [
					{ type: "text", key: "name", placeholder: "Persona name (e.g. researcher)" },
					{
						type: "select",
						key: "prompt_mode",
						options: [
							{ value: "append", label: "Append (extend global prompt)" },
							{ value: "replace", label: "Replace (override global prompt)" },
						],
					},
				];
				const values = await promptForCreation(containerEl, fields);
				if (!values) return;

				const name = values.name;
				const promptMode = values.prompt_mode || "append";

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
					await ctx.app.vault.create(filePath, buildSkeletonContent(promptMode));
					new Notice(`Persona "${name}" created.`);
					// Allow metadata cache to index the new file before re-discovery
					setTimeout(() => ctx.redisplay(), 250);
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
				renderPersonaEntry(listContainer, ctx, persona);
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

/**
 * Render a single persona entry with controls.
 *
 * Built-in personas get a badge, and use the PersonaManager for
 * vault file creation / reset. User-created personas get inline
 * color picker and emoji controls.
 */
function renderPersonaEntry(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	persona: Persona,
): void {
	const isBuiltin = BUILTIN_PERSONA_NAMES.has(persona.name);
	const personaManager = ctx.plugin.getPersonaManager();

	const setting = new Setting(containerEl).setName(persona.name);

	if (isBuiltin) {
		const nameEl = setting.nameEl;
		nameEl.createSpan({
			text: "Built-in",
			cls: "notor-extension-badge-builtin",
		});
	}

	// Color picker and emoji text for all personas
	setting
		.addColorPicker((cp) =>
			cp
				.setValue(persona.chip_color ?? "#4482ff")
				.onChange(async (value) => {
					if (isBuiltin) {
						await personaManager.ensureBuiltinPersonaVaultFile(persona.name);
					}
					await updatePersonaFrontmatter(
						ctx, persona.system_prompt_path, "notor-persona-chip-color", value
					);
				})
		)
		.addText((text) =>
			text
				.setPlaceholder("🎭")
				.setValue(persona.chip_emoji ?? "")
				.onChange(async (value) => {
					if (isBuiltin) {
						await personaManager.ensureBuiltinPersonaVaultFile(persona.name);
					}
					await updatePersonaFrontmatter(
						ctx, persona.system_prompt_path, "notor-persona-chip-emoji", value
					);
				})
		);

	// Open button
	setting.addButton((btn) =>
		btn
			.setIcon("square-arrow-out-up-right")
			.setTooltip("Open system prompt")
			.onClick(async () => {
				try {
					let pathToOpen = persona.system_prompt_path;
					if (isBuiltin) {
						pathToOpen = await personaManager.ensureBuiltinPersonaVaultFile(persona.name);
					}
					await ctx.app.workspace.openLinkText(pathToOpen, "", true);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Failed to open persona", { name: persona.name, error: msg });
					new Notice(`Failed to open persona: ${msg}`);
				}
			})
	);

	// "Reset to default" button for built-in personas (only when vault file exists)
	if (isBuiltin) {
		const vaultFilePath = normalizePath(
			`${ctx.settings.notor_dir}/personas/${persona.name}/system-prompt.md`,
		);
		const vaultFileExists = ctx.app.vault.getAbstractFileByPath(vaultFilePath) !== null;

		if (vaultFileExists) {
			setting.addButton((btn) =>
				btn
					.setButtonText("Reset to default")
					.setTooltip("Restore the built-in system prompt (overwrites customizations)")
					.onClick(async () => {
						try {
							await personaManager.resetBuiltinPersonaToDefault(persona.name);
							new Notice(`Persona "${persona.name}" reset to default.`);
							ctx.redisplay();
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							log.error("Failed to reset persona", { name: persona.name, error: msg });
							new Notice(`Failed to reset persona: ${msg}`);
						}
					})
			);
		}
	}
}

/**
 * Write a single frontmatter key to a persona's system-prompt.md file.
 *
 * Uses Obsidian's `processFrontMatter` so the rest of the file is untouched.
 * Deletes the key when `value` is falsy/empty.
 */
async function updatePersonaFrontmatter(
	ctx: SettingsContext,
	systemPromptPath: string,
	key: string,
	value: string,
): Promise<void> {
	const file = ctx.app.vault.getAbstractFileByPath(systemPromptPath);
	if (!file || !(file instanceof TFile)) return;
	await ctx.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (value) {
			fm[key] = value;
		} else {
			delete fm[key];
		}
	});
}

