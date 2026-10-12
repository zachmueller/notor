/**
 * Floating inline-comment editor anchored near a selection.
 *
 * Appended to the owning document's body with `position: fixed` (so it
 * escapes scroll containers), positioned below the selection rect and flipped
 * above when it would overflow the viewport. Cmd/Ctrl+Enter saves, Escape
 * cancels; an outside click cancels only while the textarea is empty so typed
 * text is never silently lost.
 */

export interface CommentPopoverOptions {
	/** Viewport rect of the selection or mark the popover anchors to. */
	rect: DOMRect;
	/** The quoted passage, shown above the textarea. */
	quote: string;
	mode: "new" | "edit";
	initialBody?: string;
	placeholder?: string;
	onSave: (body: string) => void;
	onCancel: () => void;
	onDelete?: () => void;
}

const MARGIN = 8;
const GAP = 6;

export class CommentPopover {
	private el: HTMLElement | null = null;
	private textarea: HTMLTextAreaElement | null = null;
	private teardown: (() => void) | null = null;

	constructor(private readonly doc: Document) {}

	get isOpen(): boolean {
		return this.el !== null;
	}

	/** The textarea, exposed for focus management and tests. */
	get inputEl(): HTMLTextAreaElement | null {
		return this.textarea;
	}

	open(opts: CommentPopoverOptions): void {
		this.close();

		const el = this.doc.body.createDiv({ cls: "notor-comment-popover" });
		this.el = el;

		const quote = opts.quote.trim().replace(/\s+/g, " ");
		el.createDiv({
			cls: "notor-comment-popover-quote",
			text: quote.length > 160 ? `${quote.slice(0, 157)}…` : quote,
		});

		const textarea = el.createEl("textarea", { cls: "notor-comment-popover-input" });
		textarea.placeholder = opts.placeholder ?? "Add a comment…";
		textarea.rows = 3;
		textarea.value = opts.initialBody ?? "";
		this.textarea = textarea;

		const actions = el.createDiv({ cls: "notor-comment-popover-actions" });
		if (opts.mode === "edit" && opts.onDelete) {
			const del = actions.createEl("button", { cls: "notor-comment-popover-delete mod-warning", text: "Delete" });
			del.addEventListener("click", () => {
				const cb = opts.onDelete!;
				this.close();
				cb();
			});
		}
		actions.createDiv({ cls: "notor-comment-popover-spacer" });
		const cancel = actions.createEl("button", { cls: "notor-comment-popover-cancel", text: "Cancel" });
		const save = actions.createEl("button", { cls: "notor-comment-popover-save mod-cta", text: "Save" });

		const updateSave = () => {
			save.disabled = textarea.value.trim().length === 0;
		};
		updateSave();
		textarea.addEventListener("input", updateSave);

		const doSave = () => {
			const body = textarea.value.trim();
			if (!body) return;
			this.close();
			opts.onSave(body);
		};
		const doCancel = () => {
			this.close();
			opts.onCancel();
		};
		save.addEventListener("click", doSave);
		cancel.addEventListener("click", doCancel);

		textarea.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				e.stopPropagation();
				doSave();
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				doCancel();
			}
		});

		const onOutside = (e: MouseEvent) => {
			if (!this.el || this.el.contains(e.target as Node)) return;
			if (textarea.value.trim().length === 0) doCancel();
		};
		// Defer so the click that opened the popover doesn't immediately close it.
		const win = this.doc.defaultView ?? window;
		const timer = win.setTimeout(() => this.doc.addEventListener("mousedown", onOutside, true), 0);
		this.teardown = () => {
			win.clearTimeout(timer);
			this.doc.removeEventListener("mousedown", onOutside, true);
		};

		this.position(opts.rect);
		textarea.focus();
	}

	close(): void {
		this.teardown?.();
		this.teardown = null;
		this.el?.remove();
		this.el = null;
		this.textarea = null;
	}

	private position(rect: DOMRect): void {
		const el = this.el;
		if (!el) return;
		const win = this.doc.defaultView ?? window;
		const box = el.getBoundingClientRect();
		const width = box.width || 300;
		const height = box.height || 140;

		let top = rect.bottom + GAP;
		if (top + height > win.innerHeight - MARGIN) top = rect.top - height - GAP;
		if (top < MARGIN) top = MARGIN;

		let left = rect.left;
		if (left + width > win.innerWidth - MARGIN) left = win.innerWidth - width - MARGIN;
		if (left < MARGIN) left = MARGIN;

		el.setCssProps({ "--notor-comment-top": `${Math.round(top)}px`, "--notor-comment-left": `${Math.round(left)}px` });
	}
}
