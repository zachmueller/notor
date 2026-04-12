/**
 * NoteOpener utility — opens notes in the Obsidian editor after tool access.
 *
 * When Notor reads or modifies a note, it optionally opens the note in an
 * editor leaf so the user can follow along. Respects the `open_notes_on_access`
 * and `focus_notes_on_access` settings. Avoids opening duplicate tabs for the
 * same note.
 *
 * @see specs/01-mvp/spec.md — FR-13
 * @see design/ux.md — note opening, editor behavior
 */

import { TFile } from "obsidian";
import type { App, WorkspaceLeaf } from "obsidian";
import { logger } from "../utils/logger";

const log = logger("NoteOpener");

/**
 * Utility for opening notes in the Obsidian editor after tool reads/writes.
 *
 * Behaviour:
 * - If opening is disabled (`open_notes_on_access` = false), all calls are
 *   no-ops.
 * - If focusing is disabled (`focus_notes_on_access` = false), notes open in
 *   background tabs without stealing focus from the chat panel.
 * - If focusing is enabled, notes are activated and given editor focus.
 * - If the note is already open in a leaf and focus is disabled, the call is a
 *   no-op. If focus is enabled, the existing leaf is activated.
 * - Does nothing for non-existent files (safe to call before creation).
 */
export class NoteOpener {
	/** Whether to open notes on access (mirrors `open_notes_on_access` setting). */
	private openEnabled: boolean;

	/** Whether to focus opened notes (mirrors `focus_notes_on_access` setting). */
	private focusEnabled: boolean;

	constructor(
		private readonly app: App,
		openEnabled: boolean,
		focusEnabled: boolean
	) {
		this.openEnabled = openEnabled;
		this.focusEnabled = focusEnabled;
	}

	/**
	 * Update the open-enabled state when settings change.
	 */
	setEnabled(enabled: boolean): void {
		this.openEnabled = enabled;
	}

	/**
	 * Update the focus-enabled state when settings change.
	 */
	setFocusEnabled(enabled: boolean): void {
		this.focusEnabled = enabled;
	}

	/**
	 * Open a note in the editor after a tool read or write.
	 *
	 * @param notePath - Vault-relative path to the note
	 */
	async openNote(notePath: string): Promise<void> {
		if (!this.openEnabled) return;

		// Resolve the file — skip if it doesn't exist yet (e.g., before creation)
		const file = this.app.vault.getFileByPath(notePath);
		if (!file || !(file instanceof TFile)) {
			log.debug("File not found, skipping open", { notePath });
			return;
		}

		try {
			// Check if the file is already open in any leaf
			const existingLeaf = this.findExistingLeaf(file);

			if (existingLeaf) {
				if (this.focusEnabled) {
					// User opted in to focus — activate and focus the existing leaf
					this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
					log.debug("Focused existing leaf", { notePath });
				}
				// When focus is disabled and the note is already open, do nothing —
				// it's already visible in a tab somewhere.
				log.debug("Note already open, skipping (focus disabled)", { notePath });
			} else if (this.focusEnabled) {
				// Open in a new leaf and make it active + focused.
				// Pass newLeaf=true so Obsidian creates a fresh tab rather than
				// replacing whatever the user currently has open in the active leaf.
				await this.app.workspace.openLinkText(notePath, "", true);
				log.debug("Opened note in new leaf (focused)", { notePath });
			} else {
				// Open in a background tab — don't steal focus from the chat panel.
				const leaf = this.app.workspace.getLeaf("tab");
				await leaf.openFile(file, { active: false });
				log.debug("Opened note in background tab", { notePath });
			}
		} catch (e) {
			// Non-fatal — log and continue
			log.warn("Failed to open note in editor", {
				notePath,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Find an existing leaf that has the given file open.
	 * Returns null if the file is not currently open in any leaf.
	 */
	private findExistingLeaf(file: TFile) {
		return findExistingLeaf(this.app, file);
	}
}

/**
 * Find an existing workspace leaf that has the given file open.
 * Returns null if the file is not currently open in any leaf.
 */
export function findExistingLeaf(app: App, file: TFile): WorkspaceLeaf | null {
	let found: WorkspaceLeaf | null = null;
	app.workspace.iterateAllLeaves((leaf) => {
		const view = leaf.view;
		if ("file" in view && (view as { file?: TFile }).file === file) {
			found = leaf;
		}
	});
	return found;
}
