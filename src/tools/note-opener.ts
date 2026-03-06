/**
 * NoteOpener utility — opens notes in the Obsidian editor after tool access.
 *
 * When Notor reads or modifies a note, it optionally opens the note in an
 * editor leaf so the user can follow along. Respects the `open_notes_on_access`
 * setting. Avoids opening duplicate tabs for the same note.
 *
 * @see specs/01-mvp/spec.md — FR-13
 * @see design/ux.md — note opening, editor behavior
 */

import { TFile } from "obsidian";
import type { App } from "obsidian";
import { logger } from "../utils/logger";

const log = logger("NoteOpener");

/**
 * Utility for opening notes in the Obsidian editor after tool reads/writes.
 *
 * Behaviour:
 * - If the note is already open in a leaf, that leaf is activated (brought
 *   to the front) rather than opening a new tab.
 * - If the note is not open, it is opened in a new leaf using the workspace
 *   `openLinkText` method.
 * - Does nothing for non-existent files (safe to call before creation).
 * - Does nothing when `open_notes_on_access` is false.
 */
export class NoteOpener {
	/** Whether to open notes on access (mirrors `open_notes_on_access` setting). */
	private enabled: boolean;

	constructor(
		private readonly app: App,
		enabled: boolean
	) {
		this.enabled = enabled;
	}

	/**
	 * Update the enabled state when settings change.
	 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	/**
	 * Open a note in the editor after a tool read or write.
	 *
	 * @param notePath - Vault-relative path to the note
	 */
	async openNote(notePath: string): Promise<void> {
		if (!this.enabled) return;

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
				// Activate the existing leaf rather than opening a duplicate
				this.app.workspace.setActiveLeaf(existingLeaf, { focus: false });
				log.debug("Activated existing leaf", { notePath });
			} else {
				// Open in a new leaf (background, don't steal focus from chat panel).
				// Pass newLeaf=true so Obsidian creates a fresh tab rather than
				// replacing whatever the user currently has open in the active leaf.
				await this.app.workspace.openLinkText(notePath, "", true);
				log.debug("Opened note in new leaf", { notePath });
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
		let found = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			// Check if this leaf has a file view with our target file
			if ("file" in view && (view as { file?: TFile }).file === file) {
				found = leaf;
			}
		});
		return found;
	}
}