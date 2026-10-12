/**
 * Test-only polyfill for Obsidian's HTMLElement DOM-builder extensions
 * (createEl / createDiv / createSpan / addClass / removeClass / toggleClass /
 * setCssProps / empty). Import from jsdom tests in `beforeAll`.
 */
type CreateOpts = { cls?: string; text?: string; type?: string; attr?: Record<string, string> };

export function installObsidianDomPolyfill(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	function createEl(this: HTMLElement, tag: string, opts?: CreateOpts | string): HTMLElement {
		const el = document.createElement(tag);
		const o = typeof opts === "string" ? { cls: opts } : opts;
		if (o?.cls) el.className = o.cls;
		if (o?.text) el.textContent = o.text;
		if (o?.type) el.setAttribute("type", o.type);
		if (o?.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
		this.appendChild(el);
		return el;
	}
	proto.createEl = createEl;
	proto.createDiv = function (this: HTMLElement, opts?: CreateOpts) {
		return createEl.call(this, "div", opts);
	};
	proto.createSpan = function (this: HTMLElement, opts?: CreateOpts) {
		return createEl.call(this, "span", opts);
	};
	proto.addClass = function (this: HTMLElement, ...cls: string[]) {
		this.classList.add(...cls);
	};
	proto.removeClass = function (this: HTMLElement, ...cls: string[]) {
		this.classList.remove(...cls);
	};
	proto.hasClass = function (this: HTMLElement, cls: string) {
		return this.classList.contains(cls);
	};
	proto.toggleClass = function (this: HTMLElement, cls: string, on: boolean) {
		this.classList.toggle(cls, on);
	};
	proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
		for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
	};
	proto.empty = function (this: HTMLElement) {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
}
