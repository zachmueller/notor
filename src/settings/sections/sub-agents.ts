/**
 * Sub-agents settings section renderer.
 *
 * Provides a "Create new sub-agent" button and lists existing sub-agent
 * profiles with visibility toggles, open buttons, and built-in badges.
 * Follows the Personas section pattern.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 7
 * @see specs/ZZ-misc/sub-agents-implementation-plan.md — Phase 7
 */

import { Notice, Setting, normalizePath } from "obsidian";
import type { SettingsContext } from "./context";
import { promptForName, ensureDirectory } from "./shared";
import { BUILTIN_SUBAGENT_PROFILES } from "../../sub-agents/builtin-profiles";
import type { SubAgentProfile } from "../../sub-agents/types";
import { logger } from "../../utils/logger";

const log = logger("SubAgentsSection");

const SKELETON_CONTENT = `---
notor-description: ""
# notor-preferred-provider: anthropic
# notor-preferred-model: claude-sonnet-4-20250514
---

<!-- Describe this sub-agent's purpose and behavior. -->

<notor_tool_config version="1.0">
# Enable tools for this sub-agent (default-deny: unlisted tools are disabled).
# Example:
# search_vault:
#   enabled: true
# read_note:
#   enabled: true
</notor_tool_config>
`;

/** Render the "Sub-agents" settings section. */
export function renderSubAgentsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	new Setting(containerEl).setHeading().setName("Sub-agents");
	containerEl.createEl("p", {
		text:
			"Sub-agents are focused child conversations that the LLM can spawn " +
			"to handle specific tasks (vault search, web lookup, etc.) without " +
			"cluttering the main context window.",
		cls: "setting-item-description",
	});

	// Iteration cap setting
	new Setting(containerEl)
		.setName("Iteration cap")
		.setDesc(
			"Maximum number of LLM turns per sub-agent invocation. " +
			"Sub-agents that hit this limit return partial results. (1\u2013100)",
		)
		.addText((text) =>
			text
				.setPlaceholder("20")
				.setValue(String(ctx.settings.sub_agent_iteration_cap))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed >= 1 && parsed <= 100) {
						ctx.settings.sub_agent_iteration_cap = parsed;
						await ctx.saveSettings();
					}
				}),
		);

	// "Create new sub-agent" button
	new Setting(containerEl)
		.setName("Create new sub-agent")
		.setDesc(
			"Creates a skeleton system-prompt.md with a placeholder <notor_tool_config> block.",
		)
		.addButton((btn) =>
			btn.setButtonText("Create").onClick(async () => {
				const name = await promptForName(
					containerEl,
					"Sub-agent name (e.g. research-assistant)",
				);
				if (!name) return;

				const dir = normalizePath(
					`${ctx.settings.notor_dir}/sub-agents/${name}`,
				);
				const filePath = normalizePath(`${dir}/system-prompt.md`);

				// Guard: check if the file already exists
				if (ctx.app.vault.getAbstractFileByPath(filePath)) {
					new Notice(`Sub-agent "${name}" already exists.`);
					return;
				}

				try {
					await ensureDirectory(ctx, dir);
					await ctx.app.vault.create(filePath, SKELETON_CONTENT);
					new Notice(`Sub-agent "${name}" created.`);
					// Open the new file for immediate editing
					await ctx.app.workspace.openLinkText(filePath, "");
					ctx.redisplay();
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Failed to create sub-agent", { name, error: msg });
					new Notice(`Failed to create sub-agent: ${msg}`);
				}
			}),
		);

	// Existing profiles list (populated asynchronously)
	const listContainer = containerEl.createDiv({
		cls: "notor-subagents-list",
	});

	const manager = ctx.plugin.getSubAgentManager();
	manager
		.discoverProfiles()
		.then((profiles) => {
			if (profiles.length === 0) {
				listContainer.createEl("p", {
					text: "No sub-agent profiles found.",
					cls: "setting-item-description",
				});
				return;
			}

			for (const profile of profiles) {
				renderProfileEntry(listContainer, ctx, profile);
			}
		})
		.catch((e) => {
			log.error("Failed to discover sub-agent profiles for settings", {
				error: String(e),
			});
			listContainer.createEl("p", {
				text: "Failed to load sub-agent profiles.",
				cls: "setting-item-description",
			});
		});
}

/**
 * Render a single sub-agent profile entry with visibility toggle,
 * open button, and optional built-in badge / reset action.
 */
function renderProfileEntry(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	profile: SubAgentProfile,
): void {
	const manager = ctx.plugin.getSubAgentManager();
	const isVisible = manager.isVisible(profile.name);

	// Build display name with optional "Built-in" badge
	const displayName = profile.is_builtin
		? `${profile.name}`
		: profile.name;

	const setting = new Setting(containerEl).setName(displayName);

	if (profile.description) {
		setting.setDesc(profile.description);
	}

	// Add "Built-in" badge for built-in profiles
	if (profile.is_builtin) {
		const nameEl = setting.nameEl;
		const badge = nameEl.createSpan({
			text: "Built-in",
			cls: "notor-subagent-badge-builtin",
		});
		badge.style.marginLeft = "8px";
		badge.style.fontSize = "0.75em";
		badge.style.opacity = "0.7";
		badge.style.fontStyle = "italic";
	}

	// Visibility toggle
	setting.addToggle((toggle) =>
		toggle
			.setValue(isVisible)
			.setTooltip(isVisible ? "Visible to LLM" : "Hidden from LLM")
			.onChange(async (value) => {
				await manager.setVisibility(profile.name, value);
				toggle.setTooltip(value ? "Visible to LLM" : "Hidden from LLM");
			}),
	);

	// Open button (square-arrow-out-up-right icon)
	setting.addButton((btn) =>
		btn
			.setIcon("square-arrow-out-up-right")
			.setTooltip("Open system prompt")
			.onClick(async () => {
				try {
					let pathToOpen = profile.system_prompt_path;
					// For built-in profiles, ensure the vault file exists first
					if (profile.is_builtin) {
						pathToOpen = await manager.ensureBuiltinVaultFile(
							profile.name,
						);
					}
					await ctx.app.workspace.openLinkText(pathToOpen, "");
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Failed to open sub-agent profile", {
						name: profile.name,
						error: msg,
					});
					new Notice(`Failed to open profile: ${msg}`);
				}
			}),
	);

	// "Reset to default" button for built-in profiles
	// Visible only if the vault file exists (user may have customized it)
	if (profile.is_builtin) {
		const vaultFilePath = normalizePath(
			`${ctx.settings.notor_dir}/sub-agents/${profile.name}/system-prompt.md`,
		);
		const vaultFileExists =
			ctx.app.vault.getAbstractFileByPath(vaultFilePath) !== null;

		if (vaultFileExists) {
			setting.addButton((btn) =>
				btn
					.setButtonText("Reset to default")
					.setTooltip(
						"Restore the built-in system prompt (overwrites customizations)",
					)
					.onClick(async () => {
						try {
							await manager.resetToDefault(profile.name);
							new Notice(
								`Sub-agent "${profile.name}" reset to default.`,
							);
							ctx.redisplay();
						} catch (e) {
							const msg =
								e instanceof Error ? e.message : String(e);
							log.error("Failed to reset sub-agent profile", {
								name: profile.name,
								error: msg,
							});
							new Notice(`Failed to reset profile: ${msg}`);
						}
					}),
			);
		}
	}
}
