/**
 * Export modal — lets the user choose a destination folder and format
 * (Markdown or HTML) before exporting a conversation.
 */

import { ButtonComponent, Modal, TFolder, type App } from "obsidian";
import type { Conversation } from "../types";

export type ExportFormat = "markdown" | "html";

export class ExportModal extends Modal {
	constructor(
		app: App,
		private readonly conversation: Conversation,
		private readonly onExport: (format: ExportFormat, folderPath: string) => Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("notor-export-modal");

		// Title
		contentEl.createEl("h2", { text: "Export conversation" });

		// Conversation info
		const title = this.conversation.title ?? "Untitled conversation";
		const date = new Date(this.conversation.created_at).toLocaleString();
		contentEl.createEl("p", {
			cls: "notor-export-modal-info",
			text: `${title} — ${date}`,
		});

		// Folder picker
		const folderRow = contentEl.createDiv({ cls: "notor-export-modal-row" });
		folderRow.createEl("label", { text: "Save to folder:" });
		const folderSelect = folderRow.createEl("select", { cls: "notor-export-modal-select" });

		// Populate with vault folders
		const folders = this.getAllFolders();
		// Add vault root first
		const rootOption = folderSelect.createEl("option", { text: "/ (vault root)", value: "" });
		rootOption.selected = true;
		for (const folder of folders) {
			folderSelect.createEl("option", { text: folder.path, value: folder.path });
		}

		// Format buttons
		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

		new ButtonComponent(buttonRow)
			.setButtonText("Cancel")
			.onClick(() => this.close());

		new ButtonComponent(buttonRow)
			.setButtonText("Markdown")
			.setCta()
			.onClick(async () => {
				this.close();
				await this.onExport("markdown", folderSelect.value);
			});

		new ButtonComponent(buttonRow)
			.setButtonText("HTML")
			.setCta()
			.onClick(async () => {
				this.close();
				await this.onExport("html", folderSelect.value);
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private getAllFolders(): TFolder[] {
		const folders: TFolder[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					folders.push(child);
					walk(child);
				}
			}
		};
		walk(this.app.vault.getRoot());
		folders.sort((a, b) => a.path.localeCompare(b.path));
		return folders;
	}
}
