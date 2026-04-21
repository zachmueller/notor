/**
 * Memory settings section renderer.
 *
 * Master toggle for the knowledge memory subsystem plus memory folder config.
 * When toggled on, validates that required model presets (`tiny`, `large`) are
 * configured, creates the memory folder if needed, and enables the
 * `capture_memory` tool.
 *
 * @see specs/ZZ-misc/knowledge-memory-design.md — §9
 */

import { Notice, Setting, normalizePath } from "obsidian";
import type { SettingsContext } from "./context";
import { resolvePreset } from "../../presets/preset-resolver";

/** Presets required by memory sub-agent profiles and the scaffolds that reference them. */
const REQUIRED_PRESETS: { preset: string; usedBy: string }[] = [
	{ preset: "tiny", usedBy: "memory-search, memory-resolver, memory-capture" },
	{ preset: "large", usedBy: "memory-dream" },
];

/** Render the "Memory" settings section. */
export function renderMemorySection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	new Setting(containerEl).setHeading().setName("Memory");
	containerEl.createEl("p", {
		text:
			"Persistent knowledge memory across conversations. " +
			"When enabled, the assistant recalls relevant memories at the start of each conversation, " +
			"captures new insights after each turn, and consolidates memories on a schedule.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Enable memory")
		.setDesc(
			"Master toggle for the memory subsystem. " +
				"Requires the 'tiny' and 'large' model presets to be configured.",
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.memory_enabled)
				.onChange(async (value) => {
					if (value) {
						const missing = validatePresets(ctx);
						if (missing.length > 0) {
							toggle.setValue(false);
							const lines = missing.map(
								(m) => `• Preset "${m.preset}" (used by ${m.usedBy})`,
							);
							new Notice(
								`Cannot enable memory — the following model presets are not configured:\n${lines.join("\n")}\n\nConfigure them in Settings → Models.`,
								10000,
							);
							return;
						}

						await ensureMemoryFolder(ctx);
						ctx.settings.tool_enabled["capture_memory"] = true;
					} else {
						ctx.settings.tool_enabled["capture_memory"] = false;
					}

					ctx.settings.memory_enabled = value;
					await ctx.saveSettings();

					const manager = ctx.plugin.getExtensionManager();
					await manager.reload(false);

					ctx.redisplay();
				}),
		);

	new Setting(containerEl)
		.setName("Memory folder")
		.setDesc(
			"Subfolder under the Notor directory for Evergreen memory notes. " +
				"Vault-relative path is {notor_dir}/{folder}.",
		)
		.addText((text) =>
			text
				.setPlaceholder("memory")
				.setValue(ctx.settings.memory_folder)
				.onChange(async (value) => {
					ctx.settings.memory_folder = value.trim() || "memory";
					await ctx.saveSettings();
				}),
		);
}

function validatePresets(ctx: SettingsContext): { preset: string; usedBy: string }[] {
	const missing: { preset: string; usedBy: string }[] = [];
	for (const req of REQUIRED_PRESETS) {
		const resolved = resolvePreset(req.preset, ctx.settings.model_presets);
		if (!resolved) {
			missing.push(req);
		}
	}
	return missing;
}

async function ensureMemoryFolder(ctx: SettingsContext): Promise<void> {
	const folder = ctx.settings.memory_folder || "memory";
	const memoryDir = normalizePath(`${ctx.settings.notor_dir}/${folder}`);
	const existing = ctx.app.vault.getAbstractFileByPath(memoryDir);
	if (!existing) {
		await ctx.app.vault.createFolder(memoryDir);
	}
}
