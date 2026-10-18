/**
 * Guided first-run setup wizard.
 *
 * Opened from the "Start guided setup" banner at the top of the Notor
 * settings tab. Walks the user through providers, a default model preset,
 * and the key safety/workspace/MCP settings.
 *
 * Section renderers are reused unchanged by handing them a wizard-scoped
 * `SettingsContext` whose `redisplay` re-renders only the current step.
 */

import { ButtonComponent, Modal } from "obsidian";
import type { SettingsContext } from "../../settings/sections/context";
import { SETUP_STEPS } from "./steps";
import type { SetupWizardHost } from "./types";

/** Delays (ms) for follow-up renders while SecretStorage loads from the OS Keychain. */
const SECRET_CACHE_RERENDER_DELAYS = [100, 500, 1500];

export class SetupWizardModal extends Modal implements SetupWizardHost {
	activeProviderId: string | null = null;
	readonly touchedProviderIds = new Set<string>();

	private stepIndex = 0;
	private renderedStepIndex = -1;
	private stepCleanups: Array<() => void> = [];
	private readonly wizardCtx: SettingsContext;

	constructor(private readonly parentCtx: SettingsContext) {
		super(parentCtx.app);
		this.wizardCtx = {
			...parentCtx,
			redisplay: () => this.rerender(),
			addCleanup: (fn) => this.stepCleanups.push(fn),
			scrollToGroup: (groupTitle, subsection) => this.openInSettings(groupTitle, subsection),
		};
	}

	onOpen(): void {
		this.modalEl.addClass("notor-setup-wizard");
		this.setTitle("Set up Notor");
		this.rerender();
		// Configured-provider checkmarks depend on secrets, which SecretStorage
		// populates asynchronously. Skip the refresh while the user is typing so
		// focus and in-progress input aren't lost.
		for (const delay of SECRET_CACHE_RERENDER_DELAYS) {
			setTimeout(() => {
				if (this.containerEl.isConnected && !this.hasFocusedInput()) this.rerender();
			}, delay);
		}
	}

	onClose(): void {
		this.runStepCleanups();
		this.contentEl.empty();
		this.parentCtx.redisplay();
	}

	rerender(): void {
		this.runStepCleanups();
		const { contentEl } = this;
		const sameStep = this.renderedStepIndex === this.stepIndex;
		const scrollTop = sameStep ? this.modalEl.scrollTop : 0;
		contentEl.empty();

		const step = SETUP_STEPS[this.stepIndex]!;
		contentEl.createDiv({
			cls: "notor-setup-wizard-progress",
			text: `Step ${this.stepIndex + 1} of ${SETUP_STEPS.length} · ${step.title}`,
		});

		const bodyEl = contentEl.createDiv({ cls: "notor-setup-wizard-body" });
		step.render(bodyEl, this.wizardCtx, this);

		this.renderFooter(contentEl);
		this.renderedStepIndex = this.stepIndex;
		this.modalEl.scrollTop = scrollTop;
	}

	openInSettings(groupTitle: string, subsection?: string): void {
		// Closing redisplays the settings tab; scroll once the new DOM is in place.
		this.close();
		requestAnimationFrame(() => this.parentCtx.scrollToGroup?.(groupTitle, subsection));
	}

	private renderFooter(containerEl: HTMLElement): void {
		const footerEl = containerEl.createDiv({
			cls: "modal-button-container notor-setup-wizard-footer",
		});

		if (this.stepIndex > 0) {
			new ButtonComponent(footerEl)
				.setButtonText("Back")
				.onClick(() => this.goToStep(this.stepIndex - 1));
		}

		const isLast = this.stepIndex === SETUP_STEPS.length - 1;
		new ButtonComponent(footerEl)
			.setButtonText(isLast ? "Finish" : "Next")
			.setCta()
			.onClick(() => (isLast ? this.close() : this.goToStep(this.stepIndex + 1)));
	}

	private goToStep(index: number): void {
		this.stepIndex = Math.max(0, Math.min(index, SETUP_STEPS.length - 1));
		this.rerender();
	}

	private runStepCleanups(): void {
		for (const fn of this.stepCleanups) fn();
		this.stepCleanups = [];
	}

	private hasFocusedInput(): boolean {
		const active = this.contentEl.ownerDocument.activeElement;
		return (
			!!active &&
			this.contentEl.contains(active) &&
			["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)
		);
	}
}
