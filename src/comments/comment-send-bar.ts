/**
 * Pending-comments bar — appears above the chat input while inline comments
 * are pending: "n comments · ×". The comments go out with the next message
 * through the regular Send button / Enter; × discards them.
 */

import { setIcon } from "obsidian";

export interface CommentSendBarHandlers {
	onClear: () => void;
}

export class CommentSendBar {
	readonly el: HTMLElement;
	private readonly labelEl: HTMLElement;

	constructor(parent: HTMLElement, before: Element | null, handlers: CommentSendBarHandlers) {
		this.el = parent.createDiv({ cls: "notor-comment-send-bar notor-hidden" });
		if (before && before.parentElement === parent) parent.insertBefore(this.el, before);

		const icon = this.el.createSpan({ cls: "notor-comment-send-bar-icon" });
		setIcon(icon, "message-square-text");
		this.labelEl = this.el.createSpan({ cls: "notor-comment-send-bar-label" });

		const clearBtn = this.el.createEl("button", {
			cls: "clickable-icon notor-comment-send-bar-clear",
			attr: { "aria-label": "Discard pending comments" },
		});
		setIcon(clearBtn, "x");
		clearBtn.addEventListener("click", () => handlers.onClear());
	}

	update(count: number): void {
		this.labelEl.textContent = count === 1 ? "1 comment" : `${count} comments`;
		this.el.toggleClass("notor-hidden", count === 0);
	}

	destroy(): void {
		this.el.remove();
	}
}
