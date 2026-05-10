/**
 * Popover references — extraction, injection, and tooltip rendering for
 * `<popover>` XML tags in assistant messages.
 */

export interface PopoverRef {
	index: number;
	note?: string;
	href?: string;
	title?: string;
	annotation: string;
}

export interface PopoverCallbacks {
	openNote: (path: string) => void;
	openUrl: (url: string) => void;
}

const POPOVER_RE = /<popover\s+([^>]*)>([\s\S]*?)<\/popover>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;

const PLACEHOLDER_START = "￹";
const PLACEHOLDER_END = "￻";

function makePlaceholder(index: number): string {
	return `${PLACEHOLDER_START}${index}${PLACEHOLDER_END}`;
}

const PLACEHOLDER_PATTERN = new RegExp(
	`${PLACEHOLDER_START}(\\d+)${PLACEHOLDER_END}`,
	"g"
);

function parseAttributes(attrString: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	let match: RegExpExecArray | null;
	ATTR_RE.lastIndex = 0;
	while ((match = ATTR_RE.exec(attrString)) !== null) {
		attrs[match[1]!] = match[2]!;
	}
	return attrs;
}

export function extractPopoverTags(content: string): { cleaned: string; refs: PopoverRef[] } {
	const refs: PopoverRef[] = [];
	let index = 0;

	const cleaned = content.replace(POPOVER_RE, (_match, attrStr: string, body: string) => {
		index++;
		const attrs = parseAttributes(attrStr);
		refs.push({
			index,
			note: attrs.note || undefined,
			href: attrs.href || undefined,
			title: attrs.title || undefined,
			annotation: body.trim(),
		});
		return makePlaceholder(index);
	});

	return { cleaned, refs };
}

export function stripPopoverTags(content: string): string {
	return content.replace(POPOVER_RE, "");
}

export function injectPopoverElements(
	containerEl: HTMLElement,
	refs: PopoverRef[],
	callbacks: PopoverCallbacks
): void {
	const walker = document.createTreeWalker(
		containerEl,
		NodeFilter.SHOW_TEXT,
		null
	);

	const nodesToProcess: { node: Text; matches: { index: number; start: number; end: number }[] }[] = [];

	let textNode: Text | null;
	while ((textNode = walker.nextNode() as Text | null)) {
		const text = textNode.textContent || "";
		const matches: { index: number; start: number; end: number }[] = [];
		let m: RegExpExecArray | null;
		PLACEHOLDER_PATTERN.lastIndex = 0;
		while ((m = PLACEHOLDER_PATTERN.exec(text)) !== null) {
			matches.push({
				index: parseInt(m[1]!, 10),
				start: m.index,
				end: m.index + m[0].length,
			});
		}
		if (matches.length > 0) {
			nodesToProcess.push({ node: textNode, matches });
		}
	}

	for (const { node, matches } of nodesToProcess) {
		const parent = node.parentNode;
		if (!parent) continue;

		const text = node.textContent || "";
		const fragment = document.createDocumentFragment();
		let lastEnd = 0;

		for (const { index, start, end } of matches) {
			if (start > lastEnd) {
				fragment.appendChild(document.createTextNode(text.slice(lastEnd, start)));
			}

			const ref = refs.find((r) => r.index === index);
			if (ref) {
				const sup = createPopoverSup(ref, callbacks);
				fragment.appendChild(sup);
			}

			lastEnd = end;
		}

		if (lastEnd < text.length) {
			fragment.appendChild(document.createTextNode(text.slice(lastEnd)));
		}

		parent.replaceChild(fragment, node);
	}
}

function createPopoverSup(ref: PopoverRef, callbacks: PopoverCallbacks): HTMLElement {
	const sup = document.createElement("sup");
	sup.className = "notor-popover-ref";
	sup.textContent = String(ref.index);
	sup.dataset.refIndex = String(ref.index);

	let tooltipEl: HTMLElement | null = null;

	sup.addEventListener("mouseenter", () => {
		tooltipEl = showPopoverTooltip(sup, ref);
	});

	sup.addEventListener("mouseleave", () => {
		if (tooltipEl) {
			tooltipEl.remove();
			tooltipEl = null;
		}
	});

	sup.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (ref.note) {
			callbacks.openNote(ref.note);
		} else if (ref.href) {
			callbacks.openUrl(ref.href);
		}
	});

	return sup;
}

function showPopoverTooltip(anchorEl: HTMLElement, ref: PopoverRef): HTMLElement {
	const tooltip = document.createElement("div");
	tooltip.className = "notor-popover-tooltip";

	const displayTitle = ref.title
		|| ref.note
		|| (ref.href ? truncateUrl(ref.href) : "Reference");

	const titleEl = document.createElement("div");
	titleEl.className = "notor-popover-tooltip-title";
	titleEl.textContent = displayTitle;
	tooltip.appendChild(titleEl);

	if (ref.annotation) {
		const bodyEl = document.createElement("div");
		bodyEl.className = "notor-popover-tooltip-body";
		bodyEl.textContent = ref.annotation;
		tooltip.appendChild(bodyEl);
	}

	document.body.appendChild(tooltip);
	positionTooltip(tooltip, anchorEl);

	return tooltip;
}

function positionTooltip(tooltip: HTMLElement, anchorEl: HTMLElement): void {
	const anchorRect = anchorEl.getBoundingClientRect();
	const tooltipRect = tooltip.getBoundingClientRect();

	let top = anchorRect.top - tooltipRect.height - 6;
	let left = anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;

	if (left < 8) left = 8;
	const viewportWidth = activeWindow.innerWidth;
	if (left + tooltipRect.width > viewportWidth - 8) {
		left = viewportWidth - tooltipRect.width - 8;
	}

	if (top < 8) {
		top = anchorRect.bottom + 6;
	}

	tooltip.style.top = `${top}px`;
	tooltip.style.left = `${left}px`;
}

function truncateUrl(url: string): string {
	try {
		const u = new URL(url);
		const path = u.pathname.length > 20
			? u.pathname.slice(0, 20) + "…"
			: u.pathname;
		return u.hostname + path;
	} catch {
		return url.length > 40 ? url.slice(0, 40) + "…" : url;
	}
}
