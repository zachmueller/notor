/**
 * Persona picker UI component for the chat panel settings popover.
 *
 * Renders a dropdown listing all discovered personas plus a "None" option.
 * Triggers a rescan of the personas directory each time it is opened,
 * ensuring newly created or deleted personas are reflected without a
 * plugin reload.
 *
 * @see specs/03-workflows-personas/spec.md — FR-37, FR-38
 * @see specs/03-workflows-personas/tasks/group-a-tasks.md — A-009
 */

import type { Persona } from "../types";
import type { PersonaManager } from "../personas/persona-manager";
import { logger } from "../utils/logger";

const log = logger("PersonaPicker");

/** Value used for the "None" option in the persona dropdown. */
const NONE_VALUE = "__none__";

/**
 * Build the persona picker section inside a settings popover container.
 *
 * Triggers an async rescan of the personas directory on render, so
 * newly created or deleted personas appear immediately.
 *
 * @param container - Parent container element for the picker section
 * @param personaManager - PersonaManager instance for discovery and activation
 * @returns The created section element (for cleanup if needed)
 */
export function buildPersonaPicker(
	container: HTMLElement,
	personaManager: PersonaManager
): HTMLElement {
	const section = container.createDiv({ cls: "notor-settings-section" });
	section.createDiv({ cls: "notor-settings-label", text: "Persona" });

	const selectWrapper = section.createDiv({ cls: "notor-persona-select-wrapper" });

	// Start with a loading placeholder
	const loadingEl = selectWrapper.createEl("select", {
		cls: "notor-settings-select",
		attr: { disabled: "true" },
	});
	loadingEl.createEl("option", { text: "Loading…" });

	// Trigger a rescan and populate the dropdown
	personaManager
		.getDiscoveredPersonas()
		.then((personas) => {
			renderPersonaSelect(selectWrapper, loadingEl, personas, personaManager);
		})
		.catch((e) => {
			log.warn("Failed to discover personas for picker", { error: String(e) });
			// Replace loading with an error-state dropdown showing only "None"
			renderPersonaSelect(selectWrapper, loadingEl, [], personaManager);
		});

	return section;
}

/**
 * Render the persona <select> dropdown, replacing the loading placeholder.
 */
function renderPersonaSelect(
	wrapper: HTMLElement,
	loadingEl: HTMLElement,
	personas: Persona[],
	personaManager: PersonaManager
): void {
	loadingEl.remove();

	const select = wrapper.createEl("select", { cls: "notor-settings-select" });
	const activePersona = personaManager.getActivePersona();

	// "None" option at the top
	const noneOpt = select.createEl("option", {
		text: "None",
		attr: { value: NONE_VALUE },
	});
	if (!activePersona) {
		noneOpt.selected = true;
	}

	// Persona options, sorted alphabetically
	const sorted = [...personas].sort((a, b) => a.name.localeCompare(b.name));
	for (const p of sorted) {
		const opt = select.createEl("option", {
			text: p.name,
			attr: { value: p.name },
		});
		if (activePersona && activePersona.name === p.name) {
			opt.selected = true;
		}
	}

	select.addEventListener("change", () => {
		const value = select.value;
		if (value === NONE_VALUE) {
			personaManager.deactivatePersona();
			log.info("Persona deactivated via picker");
		} else {
			personaManager.activatePersona(value).then((success) => {
				if (!success) {
					log.warn("Failed to activate persona from picker", { name: value });
				}
			});
		}
	});
}
