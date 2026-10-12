/**
 * "Send comments" bar — appears above the chat input while inline comments
 * are pending: "n comments · Send comments · Clear".
 */

import { setIcon } from "obsidian";

export interface CommentSendBarHandlers {
	onSend: () => void;
	onClear: () => void;
}

export class CommentSendBar {
	readonly el: HTMLElement;
	private readonly labelEl: HTMLElement;
	private readonly sendBtn: HTMLButtonElement;
	private count = 0;
	private responding = false;

	constructor(parent: HTMLElement, before: Element | null, handlers: CommentSendBarHandlers) {
		this.el = parent.createDiv({ cls: "notor-comment-send-bar notor-hidden" });
		if (before && before.parentElement === parent) parent.insertBefore(this.el, before);

		const icon = this.el.createSpan({ cls: "notor-comment-send-bar-icon" });
		setIcon(icon, "message-square-text");
		this.labelEl = this.el.createSpan({ cls: "notor-comment-send-bar-label" });

		const clearBtn = this.el.createEl("button", { cls: "notor-comment-send-bar-clear", text: "Clear" });
		clearBtn.setAttribute("aria-label", "Discard all pending comments");
		clearBtn.addEventListener("click", () => handlers.onClear());

		this.sendBtn = this.el.createEl("button", { cls: "notor-comment-send-bar-send mod-cta", text: "Send comments" });
		this.sendBtn.addEventListener("click", () => {
			if (!this.sendBtn.disabled) handlers.onSend();
		});
	}

	update(count: number): void {
		this.count = count;
		this.labelEl.textContent = count === 1 ? "1 comment" : `${count} comments`;
		this.el.toggleClass("notor-hidden", count === 0);
		this.refreshDisabled();
	}

	setResponding(responding: boolean): void {
		this.responding = responding;
		this.refreshDisabled();
	}

	destroy(): void {
		this.el.remove();
	}

	private refreshDisabled(): void {
		this.sendBtn.disabled = this.responding || this.count === 0;
	}
}
