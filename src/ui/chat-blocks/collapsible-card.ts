export interface CollapsibleCardOpts {
	headerText: string;
	icon?: string;
	defaultExpanded?: boolean;
	rootClass?: string;
}

export interface CollapsibleCard {
	root: HTMLElement;
	header: HTMLElement;
	body: HTMLElement;
}

export function renderCollapsibleCard(
	container: HTMLElement,
	opts: CollapsibleCardOpts,
): CollapsibleCard {
	const { headerText, icon, defaultExpanded = false, rootClass } = opts;

	const root = container.createDiv(rootClass ? { cls: rootClass } : {});

	const header = root.createDiv({ cls: "notor-tool-call-toggle" });
	const chevron = defaultExpanded ? "▼" : "▶";
	header.textContent = icon
		? `${chevron} ${icon} ${headerText}`
		: `${chevron} ${headerText}`;

	const body = root.createDiv();
	if (!defaultExpanded) {
		body.addClass("notor-hidden");
	}

	header.addEventListener("click", () => {
		const isHidden = body.hasClass("notor-hidden");
		body.toggleClass("notor-hidden", !isHidden);
		const newChevron = isHidden ? "▼" : "▶";
		header.textContent = icon
			? `${newChevron} ${icon} ${headerText}`
			: `${newChevron} ${headerText}`;
	});

	return { root, header, body };
}
