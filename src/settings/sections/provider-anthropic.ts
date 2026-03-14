/**
 * Anthropic provider section renderer.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { SecretComponent, Setting } from "obsidian";
import { SECRET_IDS } from "../../utils/secrets";
import { renderConnectionTestButton } from "./connection-test";
import type { SettingsContext } from "./context";

/** Render the "Anthropic" provider settings. */
export function renderAnthropicProviderSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Anthropic");

	new Setting(containerEl)
		.setName("API key")
		.setDesc("Your Anthropic API key.")
		.addComponent(
			(el) =>
				new SecretComponent(ctx.app, el)
					.setValue(SECRET_IDS.ANTHROPIC_API_KEY)
					.onChange((_value) => {
						// SecretComponent writes directly to SecretStorage.
					})
		);

	renderConnectionTestButton(containerEl, "anthropic", ctx);
}
