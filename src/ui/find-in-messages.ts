import { setIcon } from "obsidian";

interface FindCallbacks {
	onClose: () => void;
	setAutoScroll: (value: boolean) => void;
}

export class FindInMessages {
	private containerEl: HTMLElement;
	private messageListEl: HTMLElement;
	private callbacks: FindCallbacks;

	private barEl!: HTMLElement;
	private inputEl!: HTMLInputElement;
	private countEl!: HTMLElement;

	private highlightMarks: HTMLElement[] = [];
	private currentIndex = -1;
	private query = "";
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _isOpen = false;

	constructor(containerEl: HTMLElement, messageListEl: HTMLElement, callbacks: FindCallbacks) {
		this.containerEl = containerEl;
		this.messageListEl = messageListEl;
		this.callbacks = callbacks;
		this.buildBar();
	}

	get isOpen(): boolean {
		return this._isOpen;
	}

	open(): void {
		if (this.messageListEl.hasClass("notor-hidden")) return;
		this._isOpen = true;
		this.barEl.removeClass("notor-hidden");
		this.inputEl.focus();
		if (this.inputEl.value) {
			this.inputEl.select();
		}
	}

	close(): void {
		if (!this._isOpen) return;
		this._isOpen = false;
		this.barEl.addClass("notor-hidden");
		this.clearHighlights();
		this.query = "";
		this.inputEl.value = "";
		this.countEl.textContent = "";
		this.callbacks.onClose();
	}

	destroy(): void {
		this.close();
		this.barEl.remove();
	}

	// -- Bar construction -------------------------------------------------------

	private buildBar(): void {
		this.barEl = this.containerEl.createDiv({ cls: "notor-find-bar notor-hidden" });
		this.containerEl.insertBefore(this.barEl, this.messageListEl);

		this.inputEl = this.barEl.createEl("input", {
			cls: "notor-find-input",
			attr: { type: "text", placeholder: "Find in messages..." },
		});

		this.countEl = this.barEl.createSpan({ cls: "notor-find-count" });

		const prevBtn = this.barEl.createEl("button", {
			cls: "notor-find-nav-btn",
			attr: { "aria-label": "Previous match" },
		});
		setIcon(prevBtn, "chevron-up");

		const nextBtn = this.barEl.createEl("button", {
			cls: "notor-find-nav-btn",
			attr: { "aria-label": "Next match" },
		});
		setIcon(nextBtn, "chevron-down");

		const closeBtn = this.barEl.createEl("button", {
			cls: "notor-find-nav-btn",
			attr: { "aria-label": "Close search" },
		});
		setIcon(closeBtn, "x");

		this.inputEl.addEventListener("input", () => this.scheduleSearch());
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && e.shiftKey) {
				e.preventDefault();
				this.goToPrev();
			} else if (e.key === "Enter") {
				e.preventDefault();
				this.goToNext();
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.close();
			}
		});
		prevBtn.addEventListener("click", () => this.goToPrev());
		nextBtn.addEventListener("click", () => this.goToNext());
		closeBtn.addEventListener("click", () => this.close());
	}

	// -- Search scheduling ------------------------------------------------------

	private scheduleSearch(): void {
		if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.performSearch();
		}, 150);
	}

	// -- Core search + highlight ------------------------------------------------

	private performSearch(): void {
		this.clearHighlights();
		this.query = this.inputEl.value.toLowerCase();
		if (!this.query) {
			this.countEl.textContent = "";
			return;
		}

		const containers = this.getSearchableContainers();
		for (const container of containers) {
			this.highlightInContainer(container);
		}

		this.currentIndex = this.highlightMarks.length > 0 ? 0 : -1;
		this.updateCountDisplay();
		if (this.currentIndex >= 0) {
			this.focusCurrent();
		}
	}

	private getSearchableContainers(): HTMLElement[] {
		const selectors = [
			".notor-message-content",
			".notor-tool-call-name",
			".notor-tool-result-summary",
			".notor-extension-block-text",
		];
		const elements: HTMLElement[] = [];
		for (const sel of selectors) {
			const nodes = this.messageListEl.querySelectorAll<HTMLElement>(sel);
			for (const node of nodes) {
				if (this.isInsideCollapsedDetails(node)) continue;
				if (this.isInsideStreamingMessage(node)) continue;
				elements.push(node);
			}
		}
		return elements;
	}

	private isInsideCollapsedDetails(el: HTMLElement): boolean {
		let current: HTMLElement | null = el;
		while (current && current !== this.messageListEl) {
			if (current.tagName === "DETAILS" && !current.hasAttribute("open")) {
				return true;
			}
			current = current.parentElement;
		}
		return false;
	}

	private isInsideStreamingMessage(el: HTMLElement): boolean {
		const msg = el.closest(".notor-message-assistant");
		if (!msg) return false;
		return !msg.hasAttribute("data-message-id");
	}

	private highlightInContainer(container: HTMLElement): void {
		const textNodes: Text[] = [];
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			if (node.nodeValue && node.nodeValue.length > 0) {
				textNodes.push(node);
			}
		}

		if (textNodes.length === 0) return;

		// Build flat string and offset map
		let flatStr = "";
		const nodeOffsets: { node: Text; start: number }[] = [];
		for (const tn of textNodes) {
			nodeOffsets.push({ node: tn, start: flatStr.length });
			flatStr += tn.nodeValue!;
		}
		const flatLower = flatStr.toLowerCase();

		// Find all match positions in the flat string
		const matchPositions: { start: number; end: number }[] = [];
		let searchFrom = 0;
		while (searchFrom < flatLower.length) {
			const idx = flatLower.indexOf(this.query, searchFrom);
			if (idx === -1) break;
			matchPositions.push({ start: idx, end: idx + this.query.length });
			searchFrom = idx + 1;
		}

		if (matchPositions.length === 0) return;

		// Wrap matches in <mark> elements, processing from last to first
		// to avoid invalidating earlier offsets
		for (let i = matchPositions.length - 1; i >= 0; i--) {
			const pos = matchPositions[i]!;
			const marks = this.wrapRange(nodeOffsets, pos.start, pos.end);
			// Prepend so that after reversing we get document order
			this.highlightMarks.unshift(...marks);
		}
	}

	private wrapRange(
		nodeOffsets: { node: Text; start: number }[],
		matchStart: number,
		matchEnd: number,
	): HTMLElement[] {
		const marks: HTMLElement[] = [];

		for (let i = nodeOffsets.length - 1; i >= 0; i--) {
			const entry = nodeOffsets[i]!;
			const { node, start: nodeStart } = entry;
			const nodeEnd = nodeStart + node.length;

			// Skip nodes entirely outside the match
			if (nodeEnd <= matchStart || nodeStart >= matchEnd) continue;

			const overlapStart = Math.max(matchStart, nodeStart) - nodeStart;
			const overlapEnd = Math.min(matchEnd, nodeEnd) - nodeStart;

			// Split the text node to isolate the matched portion
			let targetNode = node;
			if (overlapEnd < targetNode.length) {
				targetNode.splitText(overlapEnd);
			}
			if (overlapStart > 0) {
				targetNode = targetNode.splitText(overlapStart);
			}

			const mark = document.createElement("mark");
			mark.className = "notor-find-highlight";
			targetNode.parentNode!.insertBefore(mark, targetNode);
			mark.appendChild(targetNode);
			marks.unshift(mark);
		}

		return marks;
	}

	// -- Highlight cleanup ------------------------------------------------------

	private clearHighlights(): void {
		const parents = new Set<Node>();
		for (const mark of this.highlightMarks) {
			const parent = mark.parentNode;
			if (parent) {
				while (mark.firstChild) {
					parent.insertBefore(mark.firstChild, mark);
				}
				parent.removeChild(mark);
				parents.add(parent);
			}
		}
		for (const parent of parents) {
			parent.normalize();
		}
		this.highlightMarks = [];
		this.currentIndex = -1;
	}

	// -- Navigation -------------------------------------------------------------

	private goToNext(): void {
		if (this.highlightMarks.length === 0) return;
		this.currentIndex = (this.currentIndex + 1) % this.highlightMarks.length;
		this.focusCurrent();
	}

	private goToPrev(): void {
		if (this.highlightMarks.length === 0) return;
		this.currentIndex = (this.currentIndex - 1 + this.highlightMarks.length) % this.highlightMarks.length;
		this.focusCurrent();
	}

	private focusCurrent(): void {
		for (const mark of this.highlightMarks) {
			mark.classList.remove("notor-find-highlight-current");
		}
		const current = this.highlightMarks[this.currentIndex];
		if (current) {
			current.classList.add("notor-find-highlight-current");
			current.scrollIntoView({ block: "center", behavior: "smooth" });
			this.callbacks.setAutoScroll(false);
		}
		this.updateCountDisplay();
	}

	private updateCountDisplay(): void {
		const total = this.highlightMarks.length;
		if (total === 0) {
			this.countEl.textContent = this.query ? "0 results" : "";
		} else {
			this.countEl.textContent = `${this.currentIndex + 1} of ${total}`;
		}
	}
}
