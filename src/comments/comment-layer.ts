/**
 * Host-agnostic inline comment layer.
 *
 * Handles select → inline textarea → highlight → accumulate → compile →
 * persist for any host that renders text into a root element:
 *
 * - **Chat panel** (`trigger: "contextmenu"`): the host adds a "Comment on
 *   selection" context-menu item and calls {@link CommentLayer.addFromRange}.
 * - **Plan leaf** (`trigger: "selection"`): the layer itself shows a floating
 *   "Comment" button as soon as text is selected inside the root.
 *
 * Highlights are `<mark class="notor-comment-highlight" data-comment-id>`.
 * The layer only ever unwraps its own marks and collects text nodes fresh on
 * every operation, so it coexists with find-in-messages highlights.
 */

import { buildFlatText, collectTextNodes, unwrapMarks, wrapRange } from "../ui/highlight-ranges";
import { captureAnchor, resolveAnchor } from "./anchor";
import { compileComments, type CompileGroup, type CompileOptions } from "./compile";
import { CommentPopover } from "./comment-popover";
import type { AnchoredComment, CommentScope, CommentStorageAdapter } from "./types";

export const COMMENT_HIGHLIGHT_CLASS = "notor-comment-highlight";
const PENDING_CLASS = "notor-comment-highlight--pending";

export interface CommentLayerOptions {
	/** Root element containing every commentable scope. */
	root: HTMLElement;
	trigger: "contextmenu" | "selection";
	/** Map a node inside the root to its commentable scope, or null if not commentable. */
	resolveScope: (node: Node) => CommentScope | null;
	/** Look up a currently rendered scope element by id (null when not rendered). */
	getScopeEl: (scopeId: string) => HTMLElement | null;
	/** Rendered scopes in document order — drives compile ordering and full re-apply. */
	listScopes: () => CommentScope[];
	/** Subtrees excluded from scope text (thinking blocks, token footers, buttons…). */
	skip?: (el: Element) => boolean;
	storage: CommentStorageAdapter;
	/** Fired whenever the comment list changes (add/edit/remove/clear/load). */
	onChange?: (comments: AnchoredComment[]) => void;
	/** Fired after highlights are (re)applied, e.g. to refresh find-in-messages. */
	onHighlightsApplied?: () => void;
	/** Header for a scope in the compiled batch (shown only when >1 scope). */
	scopeLabel?: (scopeId: string) => string | undefined;
	/** Compile intro line; receives whether comments span several scopes. */
	compileIntro?: (multiScope: boolean) => string;
	/** Orphan note override for compile. */
	orphanNote?: string;
	placeholder?: string;
}

/** Selector for one comment's marks (ids are UUIDs, so no escaping is needed). */
function markSelector(id: string): string {
	return `mark.${COMMENT_HIGHLIGHT_CLASS}[data-comment-id="${id.replace(/["\\]/g, "")}"]`;
}

function generateId(): string {
	return crypto.randomUUID();
}

export class CommentLayer {
	private comments: AnchoredComment[] = [];
	private loaded = false;
	private loadPromise: Promise<void> | null = null;
	/** Bumped by reset(); stale async loads compare against it and bail. */
	private generation = 0;
	private readonly popover: CommentPopover;
	private readonly doc: Document;
	private floatBtn: HTMLElement | null = null;
	private readonly cleanups: Array<() => void> = [];

	constructor(private readonly opts: CommentLayerOptions) {
		this.doc = opts.root.ownerDocument;
		this.popover = new CommentPopover(this.doc);

		const onClick = (e: MouseEvent) => this.handleMarkClick(e);
		opts.root.addEventListener("click", onClick);
		this.cleanups.push(() => opts.root.removeEventListener("click", onClick));

		if (opts.trigger === "selection") this.installSelectionTrigger();
	}

	// -- Public API ---------------------------------------------------------------

	/** Current comments (a copy). */
	getComments(): AnchoredComment[] {
		return [...this.comments];
	}

	get count(): number {
		return this.comments.length;
	}

	/** True while the inline editor is open. */
	get isEditing(): boolean {
		return this.popover.isOpen;
	}

	/** Load comments from storage (once per reset) and notify listeners. */
	load(): Promise<void> {
		if (this.loaded) return Promise.resolve();
		if (this.loadPromise) return this.loadPromise;
		const gen = this.generation;
		this.loadPromise = (async () => {
			let stored: AnchoredComment[] = [];
			try {
				stored = (await this.opts.storage.load()) ?? [];
			} catch {
				stored = [];
			}
			if (gen !== this.generation) return;
			this.comments = Array.isArray(stored) ? [...stored] : [];
			this.loaded = true;
			this.loadPromise = null;
			this.opts.onChange?.(this.getComments());
		})();
		return this.loadPromise;
	}

	/**
	 * Begin a comment on `range`: captures the anchor and opens the inline
	 * editor. A range spanning several scopes is clipped to the scope where it
	 * starts.
	 *
	 * @param quote - Display text for the passage (defaults to `range.toString()`).
	 * @returns false when the range is not commentable.
	 */
	addFromRange(range: Range, quote?: string): boolean {
		const scope = this.opts.resolveScope(range.startContainer);
		if (!scope) return false;

		const clipped = range.cloneRange();
		if (!scope.el.contains(range.endContainer)) {
			clipped.setEnd(scope.el, scope.el.childNodes.length);
		}

		const anchor = captureAnchor(clipped, scope.el, scope.scopeId, this.opts.skip);
		if (!anchor) return false;

		const rect = clipped.getBoundingClientRect();
		const displayQuote = (quote && scope.el.contains(range.endContainer) ? quote : clipped.toString()).trim() || anchor.exact;
		this.doc.getSelection()?.removeAllRanges();

		// Show a pending highlight while the editor is open.
		const pending = this.wrapAnchor(scope.el, anchor, PENDING_CLASS, "pending");

		this.popover.open({
			rect,
			quote: displayQuote,
			mode: "new",
			placeholder: this.opts.placeholder,
			onSave: (body) => {
				unwrapMarks(pending);
				void this.load().then(() => {
					const now = new Date().toISOString();
					this.comments.push({ id: generateId(), anchor, quote: displayQuote, body, created_at: now });
					this.commit();
					this.reapplyScope(scope.scopeId);
					this.opts.onHighlightsApplied?.();
				});
			},
			onCancel: () => unwrapMarks(pending),
		});
		return true;
	}

	/** Edit a comment's body. */
	edit(id: string, body: string): void {
		const c = this.comments.find((x) => x.id === id);
		if (!c || !body.trim()) return;
		c.body = body.trim();
		c.updated_at = new Date().toISOString();
		this.commit();
	}

	/** Delete one comment and its highlight. */
	remove(id: string): void {
		const idx = this.comments.findIndex((x) => x.id === id);
		if (idx === -1) return;
		const [removed] = this.comments.splice(idx, 1);
		this.unwrapComment(removed!.id);
		this.commit();
	}

	/** Delete every comment (e.g. after the batch was sent). */
	async clear(): Promise<void> {
		await this.load();
		for (const c of this.comments) this.unwrapComment(c.id);
		this.comments = [];
		this.popover.close();
		this.commit();
	}

	/**
	 * Re-resolve anchors and re-highlight after a (re)render.
	 *
	 * @param scopeId - Limit to one scope; omit to re-apply every rendered scope.
	 */
	async reapply(scopeId?: string): Promise<void> {
		const gen = this.generation;
		await this.load();
		if (gen !== this.generation) return;
		if (scopeId) {
			this.reapplyScope(scopeId);
		} else {
			for (const scope of this.opts.listScopes()) this.reapplyScope(scope.scopeId);
		}
		this.opts.onHighlightsApplied?.();
	}

	/**
	 * Comment ids whose anchors cannot be resolved in the current render —
	 * either the scope is no longer rendered or the passage changed.
	 */
	getOrphanedIds(): Set<string> {
		const orphaned = new Set<string>();
		for (const c of this.comments) {
			const el = this.opts.getScopeEl(c.anchor.scopeId);
			if (!el) {
				orphaned.add(c.id);
				continue;
			}
			const text = buildFlatText(collectTextNodes(el, this.opts.skip)).text;
			if (!resolveAnchor(c.anchor, text)) orphaned.add(c.id);
		}
		return orphaned;
	}

	/** Compile the batch message ("" when there are no comments). */
	compile(overrides: CompileOptions = {}): string {
		if (this.comments.length === 0) return "";
		const orphaned = this.getOrphanedIds();
		const scopeOrder = this.opts.listScopes().map((s) => s.scopeId);
		const byScope = new Map<string, AnchoredComment[]>();
		for (const c of this.comments) {
			const list = byScope.get(c.anchor.scopeId) ?? [];
			list.push(c);
			byScope.set(c.anchor.scopeId, list);
		}
		// Unrendered scopes (e.g. compacted messages) go first: they are older.
		const ids = [...byScope.keys()].sort((a, b) => {
			const ia = scopeOrder.indexOf(a);
			const ib = scopeOrder.indexOf(b);
			return ia - ib;
		});

		const groups: CompileGroup[] = ids.map((id) => {
			const list = byScope.get(id)!;
			const el = this.opts.getScopeEl(id);
			const text = el ? buildFlatText(collectTextNodes(el, this.opts.skip)).text : "";
			const pos = (c: AnchoredComment) => (el ? resolveAnchor(c.anchor, text)?.start ?? Infinity : Infinity);
			const sorted = [...list].sort((a, b) => pos(a) - pos(b) || a.created_at.localeCompare(b.created_at));
			return {
				scopeId: id,
				label: this.opts.scopeLabel?.(id),
				items: sorted.map((comment) => ({ comment, orphaned: orphaned.has(comment.id) })),
			};
		});

		return compileComments(groups, {
			intro: this.opts.compileIntro?.(groups.length > 1),
			orphanNote: this.opts.orphanNote,
			...overrides,
		});
	}

	/** Open the editor for an existing comment (e.g. from a comment list). */
	openEditor(id: string, anchorEl?: HTMLElement): void {
		const c = this.comments.find((x) => x.id === id);
		if (!c) return;
		const mark = anchorEl ?? this.opts.root.querySelector<HTMLElement>(markSelector(id));
		const rect = (mark ?? this.opts.root).getBoundingClientRect();
		this.popover.open({
			rect,
			quote: c.quote,
			mode: "edit",
			initialBody: c.body,
			placeholder: this.opts.placeholder,
			onSave: (body) => this.edit(id, body),
			onCancel: () => {},
			onDelete: () => this.remove(id),
		});
	}

	/** Scroll the first highlight of a comment into view. Returns false if not rendered. */
	scrollTo(id: string): boolean {
		const mark = this.opts.root.querySelector<HTMLElement>(markSelector(id));
		if (!mark) return false;
		mark.scrollIntoView({ block: "center", behavior: "smooth" });
		return true;
	}

	/**
	 * Forget in-memory state (host switched to another conversation/plan). The
	 * next {@link load}/{@link reapply} reads storage again. Does not touch
	 * storage.
	 */
	reset(): void {
		this.generation++;
		this.comments = [];
		this.loaded = false;
		this.loadPromise = null;
		this.popover.close();
		this.hideFloatButton();
		this.opts.onChange?.([]);
	}

	destroy(): void {
		this.popover.close();
		this.hideFloatButton();
		for (const fn of this.cleanups.splice(0)) fn();
	}

	// -- Internals ----------------------------------------------------------------

	private commit(): void {
		const snapshot = this.getComments();
		void Promise.resolve(this.opts.storage.save(snapshot)).catch(() => {});
		this.opts.onChange?.(snapshot);
	}

	private reapplyScope(scopeId: string): void {
		const el = this.opts.getScopeEl(scopeId);
		if (!el) return;
		unwrapMarks(Array.from(el.querySelectorAll(`mark.${COMMENT_HIGHLIGHT_CLASS}:not(.${PENDING_CLASS})`)));
		for (const c of this.comments) {
			if (c.anchor.scopeId !== scopeId) continue;
			this.wrapAnchor(el, c.anchor, COMMENT_HIGHLIGHT_CLASS, c.id);
		}
	}

	private wrapAnchor(el: HTMLElement, anchor: AnchoredComment["anchor"], className: string, id: string): HTMLElement[] {
		// Fresh flat text per wrap: earlier wraps split nodes but never change text.
		const { text, offsets } = buildFlatText(collectTextNodes(el, this.opts.skip));
		const pos = resolveAnchor(anchor, text);
		if (!pos) return [];
		const cls = className === COMMENT_HIGHLIGHT_CLASS ? className : `${COMMENT_HIGHLIGHT_CLASS} ${className}`;
		return wrapRange(offsets, pos.start, pos.end, { className: cls, dataset: { commentId: id } });
	}

	private unwrapComment(id: string): void {
		const marks = this.opts.root.querySelectorAll(markSelector(id));
		unwrapMarks(Array.from(marks));
	}

	private handleMarkClick(e: MouseEvent): void {
		const mark = (e.target as Element | null)?.closest?.(`mark.${COMMENT_HIGHLIGHT_CLASS}:not(.${PENDING_CLASS})`) as HTMLElement | null;
		if (!mark || !this.opts.root.contains(mark)) return;
		const sel = this.doc.getSelection();
		if (sel && !sel.isCollapsed) return; // user is selecting, not clicking
		const id = mark.dataset.commentId;
		if (!id) return;
		e.preventDefault();
		this.openEditor(id, mark);
	}

	/** Selection trigger: floating "Comment" button whenever text is selected in a scope. */
	private installSelectionTrigger(): void {
		const win = this.doc.defaultView ?? window;
		let timer: number | null = null;
		const check = () => {
			timer = null;
			if (this.popover.isOpen) return;
			const sel = this.doc.getSelection();
			if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
				this.hideFloatButton();
				return;
			}
			const range = sel.getRangeAt(0);
			if (!this.opts.root.contains(range.commonAncestorContainer)) {
				this.hideFloatButton();
				return;
			}
			if (!this.opts.resolveScope(range.startContainer)) {
				this.hideFloatButton();
				return;
			}
			this.showFloatButton(range.cloneRange(), sel.toString());
		};
		const schedule = () => {
			if (timer !== null) win.clearTimeout(timer);
			timer = win.setTimeout(check, 50);
		};
		this.doc.addEventListener("selectionchange", schedule);
		this.opts.root.addEventListener("mouseup", schedule);
		this.opts.root.addEventListener("keyup", schedule);
		this.cleanups.push(() => {
			if (timer !== null) win.clearTimeout(timer);
			this.doc.removeEventListener("selectionchange", schedule);
			this.opts.root.removeEventListener("mouseup", schedule);
			this.opts.root.removeEventListener("keyup", schedule);
		});
	}

	private showFloatButton(range: Range, quote: string): void {
		this.hideFloatButton();
		const rect = range.getBoundingClientRect();
		const btn = this.doc.body.createEl("button", { cls: "notor-comment-float-btn", text: "Comment" });
		btn.setAttribute("aria-label", "Comment on selection");
		btn.setCssProps({
			"--notor-comment-top": `${Math.round(rect.bottom + 4)}px`,
			"--notor-comment-left": `${Math.round(rect.right - 40)}px`,
		});
		// mousedown would collapse the selection before click — keep it.
		btn.addEventListener("mousedown", (e) => e.preventDefault());
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			this.hideFloatButton();
			this.addFromRange(range, quote);
		});
		this.floatBtn = btn;
	}

	private hideFloatButton(): void {
		this.floatBtn?.remove();
		this.floatBtn = null;
	}
}
