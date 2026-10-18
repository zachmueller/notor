/**
 * Shared types for the guided setup wizard steps.
 */

import type { SettingsContext } from "../../settings/sections/context";

/** Wizard state and navigation exposed to step renderers. */
export interface SetupWizardHost {
	/** Provider currently being configured in the providers step (null = show the type picker). */
	activeProviderId: string | null;
	/** Providers the user picked during this wizard session. */
	readonly touchedProviderIds: Set<string>;
	/** Re-render the current step in place. */
	rerender(): void;
	/** Close the wizard and scroll the settings tab to a group. */
	openInSettings(groupTitle: string, subsection?: string): void;
}

/** A single wizard step. */
export interface SetupStep {
	title: string;
	render(containerEl: HTMLElement, ctx: SettingsContext, host: SetupWizardHost): void;
}
