/**
 * Orchestration settings section renderer.
 *
 * Master toggle for the orchestration subsystem (feature group
 * `orchestration`). Mirrors the Memory toggle: on change it sets
 * `settings.circuits_enabled` and reloads the extension manager so tools
 * tagged `featureGroup: "orchestration"` are registered/filtered accordingly.
 *
 * @see specs/ZZ-misc/orchestration/spec.md — FR-119
 * @see src/settings/sections/memory.ts — mirrored toggle
 */

import { Setting, normalizePath } from "obsidian";
import type { SettingsContext } from "./context";
import { materializeReferenceCircuits, type ReferenceCircuitFs } from "../../circuits/reference-circuits";

/**
 * Materialize the first-party reference circuits (POL-002) under
 * `{notor_dir}/circuits/` on enable, preserving any user edits (idempotent —
 * never overwrites) and skipping any the user already has under the legacy
 * `{notor_dir}/orchestrations/`. Discovery tolerates absent directories, so no
 * empty folder is created when nothing needs seeding.
 */
async function seedReferenceCircuits(ctx: SettingsContext): Promise<void> {
	// POL-002: seed the reference flows (code-assist / research / review). The
	// materializer is edit-preserving, so re-enabling never clobbers user changes.
	const adapter = ctx.app.vault.adapter;
	const fs: ReferenceCircuitFs = {
		exists: (p) => adapter.exists(normalizePath(p)),
		mkdir: async (p) => {
			const norm = normalizePath(p);
			if (!(await adapter.exists(norm))) await adapter.mkdir(norm);
		},
		write: async (p, data) => adapter.write(normalizePath(p), data),
	};
	await materializeReferenceCircuits(ctx.settings.notor_dir, fs);
}

/** Render the "Orchestration" settings section. */
export function renderCircuitsSection(
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
				.setValue(ctx.settings.circuits_enabled)
				.onChange(async (value) => {
					ctx.settings.circuits_enabled = value;
					await ctx.saveSettings();

					// Seed the reference circuits on enable.
					if (value) {
						try {
							await seedReferenceCircuits(ctx);
						} catch {
							// Non-fatal — discovery tolerates an absent directory.
						}
					}

					const manager = ctx.plugin.getExtensionManager();
					await manager.reload(false);

					// run_flow (INT-042) is a hand-written Tool, not a scaffold, so the
					// manager reload above does not (un)register it — re-gate it here so
					// it appears/disappears with the feature group like the scaffolds.
					ctx.plugin.syncRunCircuitToolRegistration();

					// Refresh the scheduled-flow cache + cron jobs: enabling discovers
					// `notor-schedule` flows, disabling clears them.
					await ctx.plugin.rescanCircuits();

					ctx.redisplay();
				}),
		);

	// Failed-run debug notes (Part B). Read at finalize time, so toggling needs no
	// extension reload — just persist. Only meaningful while orchestration is on.
	new Setting(containerEl)
		.setName("Write failed-run debug notes")
		.setDesc(
			"On a failed orchestration run, write a Markdown debug report under " +
				"orchestrations/failures/ (the objective, failure reason, failing step + stack, " +
				"and event timeline) that you can open or point Notor at to debug.",
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.circuits_write_failure_notes)
				.onChange(async (value) => {
					ctx.settings.circuits_write_failure_notes = value;
					await ctx.saveSettings();
				}),
		);

	// Whether orchestration reads/writes open notes in the editor. Read at launch
	// time, so toggling needs no extension reload — just persist. Independent of
	// the General "Open notes on access" setting; a flow can override it per-run
	// via the `notor-open-notes-in-editor` frontmatter key.
	new Setting(containerEl)
		.setName("Open notes in editor")
		.setDesc(
			"When a flow's steps read or write notes, open each one in the editor so " +
				"you can follow along. Off by default so a flow that touches many notes " +
				"doesn't spray tabs across your workspace. A flow can override this with " +
				"'notor-open-notes-in-editor' in its frontmatter. Independent of the " +
				"General \"Open notes on access\" setting.",
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.circuits_open_notes_in_editor)
				.onChange(async (value) => {
					ctx.settings.circuits_open_notes_in_editor = value;
					await ctx.saveSettings();
				}),
		);
}
