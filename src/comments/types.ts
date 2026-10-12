/**
 * Inline comment layer — shared data model.
 *
 * A comment is anchored to a passage of rendered text by a text-quote
 * selector (exact text + surrounding context + occurrence index) scoped to a
 * host-defined region (a chat message id, or the plan body). DOM `Range`s are
 * not serializable, so anchors are re-resolved against the rendered text
 * after every render.
 *
 * @see ai/notor/ideas — "Inline comment annotations on AI responses with batch follow-up"
 */

/** Text-quote selector locating a commented passage inside one scope. */
export interface CommentAnchor {
	/** Chat host: the assistant message id. Plan host: the fixed id "plan". */
	scopeId: string;
	/** The selected text, exactly as it appears in the scope's flattened text. */
	exact: string;
	/** Up to ~32 characters immediately before the selection, for disambiguation. */
	prefix: string;
	/** Up to ~32 characters immediately after the selection. */
	suffix: string;
	/** Zero-based index of this match among all occurrences of `exact` in the scope. */
	occurrence: number;
}

/** One user comment attached to an anchored passage. */
export interface AnchoredComment {
	id: string;
	anchor: CommentAnchor;
	/**
	 * Human-readable quote of the selection (from `Selection.toString()`, which
	 * preserves line breaks between blocks). Used in the compiled batch and as
	 * the fallback when the anchor can no longer be resolved.
	 */
	quote: string;
	/** The comment text. */
	body: string;
	created_at: string;
	updated_at?: string;
}

/** Host-supplied persistence for a comment layer. */
export interface CommentStorageAdapter {
	load(): AnchoredComment[] | Promise<AnchoredComment[]>;
	save(comments: AnchoredComment[]): void | Promise<void>;
}

/** A commentable region inside the host root. */
export interface CommentScope {
	scopeId: string;
	/** Element whose flattened text the anchor is computed against. */
	el: HTMLElement;
}
