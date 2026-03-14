import { ButtonComponent, Modal, type App } from "obsidian";

/**
 * A reusable confirmation modal for destructive or cautionary actions.
 *
 * Usage:
 *   new ConfirmModal(app, "Remove server", "Are you sure?", async () => {
 *       await doSomething();
 *   }, "Remove", true).open();
 *
 * @param onConfirm - Called when the user clicks the confirm button.
 * @param onDismiss - Optional. Called when the modal closes (confirm OR cancel).
 *                   Useful for chaining sequential modals.
 */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly onConfirm: () => void | Promise<void>,
		private readonly confirmLabel: string = "Confirm",
		private readonly destructive: boolean = false,
		private readonly onDismiss?: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: this.title });
		contentEl.createEl("p", { text: this.message });

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });

		new ButtonComponent(buttonRow)
			.setButtonText("Cancel")
			.onClick(() => this.close());

		const confirmBtn = new ButtonComponent(buttonRow)
			.setButtonText(this.confirmLabel)
			.onClick(async () => {
				this.close();
				await this.onConfirm();
			});

		if (this.destructive) {
			confirmBtn.setWarning();
		} else {
			confirmBtn.setCta();
		}
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDismiss?.();
	}
}
