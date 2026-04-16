/**
 * Fuzzy-search modal for switching the active persona from the chat panel.
 *
 * Modelled after {@link WorkflowPickerModal} in workflow-executor.ts.
 * Includes a "None (deactivate)" sentinel so users can clear the active
 * persona without opening the settings popover.
 *
 * Opened by clicking the persona chip in the input toolbar.
 */

import { App, FuzzySuggestModal } from "obsidian";
import type { Persona } from "../types";
import type { PersonaManager } from "../personas/persona-manager";
import { logger } from "../utils/logger";

const log = logger("PersonaPickerModal");

/**
 * A `null` item represents the "None (deactivate)" option at the top of
 * the list.  Every other item is a discovered {@link Persona}.
 */
type PersonaPickerItem = Persona | null;

class PersonaPickerModal extends FuzzySuggestModal<PersonaPickerItem> {
	private readonly emptyMessage: string;

	constructor(
		app: App,
		private readonly personas: Persona[],
		private readonly onSelect: (persona: Persona | null) => void,
		placeholder?: string,
		emptyMessage?: string,
	) {
		super(app);
		this.setPlaceholder(placeholder ?? "Switch persona\u2026");
		this.emptyMessage = emptyMessage ?? "No personas found.";
	}

	getItems(): PersonaPickerItem[] {
		// "None" sentinel first, then alphabetically sorted personas
		const sorted = [...this.personas].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		return [null, ...sorted];
	}

	getItemText(item: PersonaPickerItem): string {
		if (!item) return "None (deactivate)";
		return item.chip_emoji ? `${item.chip_emoji} ${item.name}` : item.name;
	}

	onChooseItem(item: PersonaPickerItem): void {
		this.onSelect(item);
	}

	/** Show an informational empty state when no personas exist. */
	onNoSuggestion(): void {
		if (this.personas.length === 0) {
			this.resultContainerEl.empty();
			const msg = this.resultContainerEl.createDiv({
				cls: "notor-persona-picker-empty",
			});
			msg.textContent = this.emptyMessage;
		}
	}
}

/**
 * Discover personas and open the picker modal.
 *
 * @param app - Obsidian App instance
 * @param personaManager - PersonaManager for discovery and activation
 * @param onSelect - Callback fired with the chosen persona (or null to deactivate)
 */
export async function openPersonaPickerModal(
	app: App,
	personaManager: PersonaManager,
	onSelect: (persona: Persona | null) => void,
): Promise<void> {
	try {
		const personas = await personaManager.getDiscoveredPersonas();
		new PersonaPickerModal(app, personas, onSelect).open();
	} catch (e) {
		log.error("Failed to open persona picker modal", { error: String(e) });
	}
}
