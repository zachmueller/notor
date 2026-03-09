/**
 * Hooks settings section renderer (HOOK-006).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Notice, Setting } from "obsidian";
import type { Hook, HookConfig } from "../types";
import type { SettingsContext } from "./context";

/** Render the "Hooks" settings section. */
export function renderHooksSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	containerEl.createEl("h2", { text: "Hooks" });
	containerEl.createEl("p", {
		text:
			"Shell commands that run at specific points in the AI conversation lifecycle. " +
			"Pre-send hooks can inject context into messages. Desktop only.",
		cls: "setting-item-description",
	});

	// Global hook settings
	new Setting(containerEl)
		.setName("Hook timeout (seconds)")
		.setDesc("Maximum time a hook command can run before being terminated.")
		.addText((text) =>
			text
				.setPlaceholder("10")
				.setValue(String(ctx.settings.hook_timeout))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.hook_timeout = parsed;
						await ctx.saveSettings();
					}
				})
		);

	new Setting(containerEl)
		.setName("Environment variable truncation (chars)")
		.setDesc(
			"Maximum character length for NOTOR_* environment variables passed to hooks. " +
			"Values exceeding this are truncated with a marker."
		)
		.addText((text) =>
			text
				.setPlaceholder("10000")
				.setValue(String(ctx.settings.hook_env_truncation_chars))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.hook_env_truncation_chars = parsed;
						await ctx.saveSettings();
					}
				})
		);

	// Per-event hook lists
	const eventLabels: Record<string, { title: string; desc: string }> = {
		pre_send: {
			title: "Pre-send hooks",
			desc: "Run before each message is sent to the AI. Stdout is captured and included in the message context.",
		},
		on_tool_call: {
			title: "On tool call hooks",
			desc: "Run after a tool call is approved, before execution. Fire-and-forget.",
		},
		on_tool_result: {
			title: "On tool result hooks",
			desc: "Run after a tool finishes execution, before the result returns to the AI. Fire-and-forget.",
		},
		after_completion: {
			title: "After completion hooks",
			desc: "Run after the AI's full response turn completes. Fire-and-forget.",
		},
	};

	for (const [event, meta] of Object.entries(eventLabels)) {
		const eventKey = event as keyof HookConfig;
		containerEl.createEl("h3", { text: meta.title });
		containerEl.createEl("p", { text: meta.desc, cls: "setting-item-description" });

		const hooks = ctx.settings.hooks[eventKey];

		// Render existing hooks
		for (let i = 0; i < hooks.length; i++) {
			const hook = hooks[i];
			if (!hook) continue;

			const setting = new Setting(containerEl)
				.setName(hook.label || hook.command.substring(0, 60))
				.setDesc(hook.label ? hook.command.substring(0, 80) : "");

			// Enabled toggle
			setting.addToggle((toggle) =>
				toggle.setValue(hook.enabled).onChange(async (value) => {
					hook.enabled = value;
					await ctx.saveSettings();
				})
			);

			// Move up
			if (i > 0) {
				setting.addButton((btn) =>
					btn.setButtonText("↑").onClick(async () => {
						hooks.splice(i, 1);
						hooks.splice(i - 1, 0, hook);
						await ctx.saveSettings();
						ctx.redisplay();
					})
				);
			}

			// Move down
			if (i < hooks.length - 1) {
				setting.addButton((btn) =>
					btn.setButtonText("↓").onClick(async () => {
						hooks.splice(i, 1);
						hooks.splice(i + 1, 0, hook);
						await ctx.saveSettings();
						ctx.redisplay();
					})
				);
			}

			// Delete
			setting.addButton((btn) =>
				btn
					.setButtonText("Remove")
					.setWarning()
					.onClick(async () => {
						hooks.splice(i, 1);
						await ctx.saveSettings();
						ctx.redisplay();
					})
			);
		}

		// Add new hook
		let newCommand = "";
		let newLabel = "";
		const addSetting = new Setting(containerEl)
			.setName("Add hook")
			.setDesc("Shell command to execute.");

		addSetting.addText((text) => {
			text.setPlaceholder("Shell command").onChange((v) => {
				newCommand = v.trim();
			});
		});
		addSetting.addText((text) => {
			text.setPlaceholder("Label (optional)").onChange((v) => {
				newLabel = v.trim();
			});
			text.inputEl.style.width = "120px";
		});
		addSetting.addButton((btn) =>
			btn.setButtonText("Add").onClick(async () => {
				if (!newCommand) {
					new Notice("Enter a shell command for the hook.");
					return;
				}
				const newHook: Hook = {
					id: crypto.randomUUID?.() ?? Date.now().toString(36),
					event: eventKey,
					command: newCommand,
					label: newLabel,
					enabled: true,
				};
				ctx.settings.hooks[eventKey].push(newHook);
				await ctx.saveSettings();
				ctx.redisplay();
			})
		);
	}
}
