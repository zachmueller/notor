/**
 * Orchestration settings section renderer.
 *
 * Master toggle for the orchestration subsystem (feature group
 * `orchestration`). Mirrors the Memory toggle: on change it sets
 * `settings.orchestration_enabled` and reloads the extension manager so tools
 * tagged `featureGroup: "orchestration"` are registered/filtered accordingly.
 *
 * @see specs/ZZ-misc/orchestration/spec.md — FR-119
 * @see src/settings/sections/memory.ts — mirrored toggle
 */

import { Setting, normalizePath } from "obsidian";
import type { SettingsContext } from "./context";
import { materializeReferenceFlows, type ReferenceFlowFs } from "../../orchestration/reference-flows";

/**
 * Ensure `{notor_dir}/orchestrations/` exists (mirrors the memory toggle seeding
 * its folder) and materialize the first-party reference flows (POL-002) on first
 * enable, preserving any user edits (idempotent — never overwrites). Created on
 * first enable so the flow picker / hook launch have a place to discover flows.
 */
async function ensureOrchestrationsFolder(ctx: SettingsContext): Promise<void> {
	const dir = normalizePath(`${ctx.settings.notor_dir}/orchestrations`);
	const existing = ctx.app.vault.getAbstractFileByPath(dir);
	if (!existing) {
		await ctx.app.vault.createFolder(dir);
	}

	// POL-002: seed the reference flows (code-assist / research / review). The
	// materializer is edit-preserving, so re-enabling never clobbers user changes.
	const adapter = ctx.app.vault.adapter;
	const fs: ReferenceFlowFs = {
		exists: (p) => adapter.exists(normalizePath(p)),
		mkdir: async (p) => {
			const norm = normalizePath(p);
			if (!(await adapter.exists(norm))) await adapter.mkdir(norm);
		},
		write: async (p, data) => adapter.write(normalizePath(p), data),
	};
	await materializeReferenceFlows(ctx.settings.notor_dir, fs);
}

/** Render the "Orchestration" settings section. */
export function renderOrchestrationSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	new Setting(containerEl).setHeading().setName("Orchestration");
	containerEl.createEl("p", {
		text:
			"Multi-step orchestration flows: event-driven pipelines of conversation " +
			"and code steps with cascading guardrails (depth, iteration, cost, runtime). " +
			"When disabled, all orchestration tools are excluded.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Enable orchestration")
		.setDesc("Master toggle for the orchestration subsystem.")
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.orchestration_enabled)
				.onChange(async (value) => {
					ctx.settings.orchestration_enabled = value;
					await ctx.saveSettings();

					// Seed the orchestrations/ directory on first enable.
					if (value) {
						try {
							await ensureOrchestrationsFolder(ctx);
						} catch {
							// Non-fatal — discovery tolerates an absent directory.
						}
					}

					const manager = ctx.plugin.getExtensionManager();
					await manager.reload(false);

					// run_flow (INT-042) is a hand-written Tool, not a scaffold, so the
					// manager reload above does not (un)register it — re-gate it here so
					// it appears/disappears with the feature group like the scaffolds.
					ctx.plugin.syncRunFlowToolRegistration();

					ctx.redisplay();
				}),
		);
}
