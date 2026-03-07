/**
 * Attachment chip display and management — renders attached items
 * as labeled chips/tags in the chat input area with removal capability.
 *
 * Chip types:
 *   - Vault notes: show filename
 *   - Vault note sections: show "Filename § Section"
 *   - External files: show filename with distinct visual indicator
 *
 * @see specs/02-context-intelligence/tasks.md — ATT-007
 */

import type { Attachment } from "../context/attachment";

// ---------------------------------------------------------------------------
// ATT-007: Attachment chip display and management
// ---------------------------------------------------------------------------

/**
 * Manages the attachment chip container in the chat input area.
 *
 * Renders chips for each attachment, handles removal, and clears
 * chips after the message is sent.
 */
export class AttachmentChipManager {
	private containerEl: HTMLElement;
	private onRemove: (attachmentId: string) => void;

	constructor(containerEl: HTMLElement, onRemove: (attachmentId: string) => void) {
		this.containerEl = containerEl;
		this.onRemove = onRemove;
	}

	/**
	 * Render all attachment chips, replacing any existing ones.
	 *
	 * @param attachments - Current list of attachments.
	 */
	render(attachments: Attachment[]): void {
		this.containerEl.empty();

		if (attachments.length === 0) {
			this.containerEl.addClass("notor-hidden");
			return;
		}

		this.containerEl.removeClass("notor-hidden");

		for (const att of attachments) {
			this.renderChip(att);
		}
	}

	/**
	 * Add a single chip for a new attachment without re-rendering all.
	 *
	 * @param attachment - The attachment to add a chip for.
	 */
	addChip(attachment: Attachment): void {
		this.containerEl.removeClass("notor-hidden");
		this.renderChip(attachment);
	}

	/**
	 * Remove a single chip by attachment ID.
	 *
	 * @param attachmentId - The ID of the attachment to remove.
	 */
	removeChip(attachmentId: string): void {
		const chipEl = this.containerEl.querySelector(
			`[data-attachment-id="${attachmentId}"]`
		);
		chipEl?.remove();

		// Hide container if empty
		if (this.containerEl.childElementCount === 0) {
			this.containerEl.addClass("notor-hidden");
		}
	}

	/**
	 * Clear all chips (called after message is sent).
	 */
	clear(): void {
		this.containerEl.empty();
		this.containerEl.addClass("notor-hidden");
	}

	/**
	 * Render a single attachment chip.
	 */
	private renderChip(attachment: Attachment): void {
		const chipEl = this.containerEl.createDiv({
			cls: "notor-attachment-chip",
			attr: { "data-attachment-id": attachment.id },
		});

		// Type-specific visual indicator
		if (attachment.type === "external_file") {
			chipEl.addClass("notor-attachment-chip--external");
			chipEl.createSpan({
				cls: "notor-attachment-chip-icon",
				text: "📎",
			});
		} else if (attachment.type === "vault_note_section") {
			chipEl.createSpan({
				cls: "notor-attachment-chip-icon",
				text: "§",
			});
		} else {
			chipEl.createSpan({
				cls: "notor-attachment-chip-icon",
				text: "📄",
			});
		}

		// Display name
		chipEl.createSpan({
			cls: "notor-attachment-chip-label",
			text: attachment.display_name,
		});

		// Remove button
		const removeBtn = chipEl.createSpan({
			cls: "notor-attachment-chip-remove",
			attr: { "aria-label": `Remove ${attachment.display_name}` },
		});
		removeBtn.textContent = "×";
		removeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.onRemove(attachment.id);
		});
	}
}

/**
 * Create the attachment chip container element.
 *
 * @param parentEl - The parent element to insert the container before.
 * @returns The container element for attachment chips.
 */
export function createAttachmentChipContainer(parentEl: HTMLElement): HTMLElement {
	return parentEl.createDiv({
		cls: "notor-attachment-chips notor-hidden",
	});
}