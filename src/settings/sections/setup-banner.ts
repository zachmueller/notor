/**
 * "Get started" banner shown at the top of the settings tab until a
 * provider or model preset is configured. No dismiss control — it goes
 * away on its own once setup is done.
 */

import { ButtonComponent } from "obsidian";
import { needsInitialSetup } from "../setup-detection";
import { SetupWizardModal } from "../../ui/setup-wizard/setup-wizard-modal";
import type { SettingsContext } from "./context";

/** Delays (ms) for re-checking while SecretStorage loads from the OS Keychain. */
const SECRET_CACHE_RECHECK_DELAYS = [100, 500, 1500];

/** Render the guided setup banner (if needed) at the top of the settings tab. */
export function renderSetupBanner(containerEl: HTMLElement, ctx: SettingsContext): void {
	const slotEl = containerEl.createDiv({ cls: "notor-setup-banner-slot" });
	if (!needsInitialSetup(ctx.app, ctx.settings)) return;

	const bannerEl = slotEl.createDiv({ cls: "notor-setup-banner" });
	bannerEl.createDiv({ cls: "notor-setup-banner-title", text: "Get started with Notor" });
	bannerEl.createEl("p", {
		text: "Connect a provider and pick a model to start chatting. The guided setup walks you through it.",
	});
	new ButtonComponent(bannerEl)
		.setButtonText("Start guided setup")
		.setCta()
		.onClick(() => new SetupWizardModal(ctx).open());

	// API keys may not be readable yet on first render; hide the banner as soon
	// as the Keychain cache shows a configured provider.
	for (const delay of SECRET_CACHE_RECHECK_DELAYS) {
		const timer = window.setTimeout(() => {
			if (slotEl.isConnected && !needsInitialSetup(ctx.app, ctx.settings)) slotEl.empty();
		}, delay);
		ctx.addCleanup?.(() => window.clearTimeout(timer));
	}
}
