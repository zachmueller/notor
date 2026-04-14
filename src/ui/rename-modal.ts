import { ButtonComponent, Modal, type App } from "obsidian";

/**
 * A modal for renaming a conversation title.
 *
 * Usage:
 *   new RenameModal(app, "Current title", async (newTitle) => {
 *       await persistTitle(newTitle);
 *   }).open();
 */
export class RenameModal extends Modal {
	constructor(
		app: App,
		private readonly currentTitle: string,
		private readonly onSubmit: (newTitle: string) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Rename conversation" });

		const input = contentEl.createEl("input", {
			type: "text",
			cls: "notor-rename-input",
		});
		input.value = this.currentTitle;
		input.select();

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submit(input.value.trim());
			}
		});

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

		new ButtonComponent(buttonRow)
			.setButtonText("Cancel")
			.onClick(() => this.close());

		new ButtonComponent(buttonRow)
			.setButtonText("Rename")
			.setCta()
			.onClick(() => {
				this.submit(input.value.trim());
			});

		// Auto-focus the input
		setTimeout(() => input.focus(), 10);
	}

	private submit(value: string): void {
		if (!value) return;
		this.close();
		void this.onSubmit(value);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
