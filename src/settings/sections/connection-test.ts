/**
 * Connection test button renderer, shared across provider sections.
 *
 * Uses a dynamic `import()` for the provider registry to avoid
 * circular dependencies at module load time (same pattern as the
 * original code).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/**
 * Render a "Test connection" button for a provider section.
 *
 * Bedrock renders an informational message instead of a button
 * because it requires Node.js-only AWS SDK credential providers.
 */
export function renderConnectionTestButton(
	containerEl: HTMLElement,
	providerType: string,
	ctx: SettingsContext
): void {
	const setting = new Setting(containerEl)
		.setName("Test connection")
		.setDesc("Verify that the provider is reachable and credentials are valid.");

	// Bedrock uses Node.js-only AWS SDK credential providers that cannot
	// be bundled in the settings test helper. Testing is available once
	// the plugin is fully loaded and the main provider registry is wired.
	if (providerType === "bedrock") {
		setting.setDesc(
			"AWS Bedrock connection can be tested from the chat panel " +
				"once the plugin is loaded. Save your settings and open " +
				"the Notor chat panel to verify connectivity."
		);
		return;
	}

	let statusEl: HTMLElement | null = null;

	setting.addButton((button) => {
		button.setButtonText("Test connection").onClick(async () => {
			button.setDisabled(true);
			button.setButtonText("Testing…");
			if (statusEl) statusEl.remove();

			// Inline status element rendered below the setting row
			statusEl = containerEl.createEl("p", {
				cls: "notor-connection-status notor-connection-status--pending",
				text: "Connecting…",
			});
			setting.settingEl.after(statusEl);

			try {
				// Dynamically import the provider registry to avoid
				// circular dependency at module load time.
				const { buildProviderRegistry } = await import(
					"../../providers/registry-factory"
				);
				const registry = buildProviderRegistry(
					ctx.app,
					ctx.settings
				);
				const provider = registry.getProvider(
					providerType as import("../../types").LLMProviderType
				);
				await provider.validateConnection();

				statusEl.textContent = "✓ Connection successful";
				statusEl.className =
					"notor-connection-status notor-connection-status--success";
			} catch (e) {
				const message =
					e instanceof Error ? e.message : String(e);
				statusEl.textContent = `✗ ${message}`;
				statusEl.className =
					"notor-connection-status notor-connection-status--error";
			} finally {
				button.setDisabled(false);
				button.setButtonText("Test connection");
			}
		});
	});
}
