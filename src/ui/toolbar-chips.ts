/**
 * Toolbar chip placement — positions the persona / workflow chips in the
 * chat input toolbar without assuming how the anchor is nested.
 *
 * The mode toggle lives inside `.notor-input-toolbar-left` (alongside the
 * auto-accept badge), so its `nextSibling` is not a toolbar child and can't
 * be passed to `toolbar.insertBefore` directly.
 */

/**
 * Place `el` in `toolbar` directly after the toolbar's top-level child that
 * contains `anchor` (the anchor itself may be nested). Appends when no anchor
 * is found. Never throws.
 */
export function insertToolbarChipAfter(toolbar: HTMLElement, el: HTMLElement, anchor: Element | null): void {
	let top = anchor;
	while (top && top.parentElement !== toolbar) top = top.parentElement;
	toolbar.insertBefore(el, top ? top.nextSibling : null);
}
