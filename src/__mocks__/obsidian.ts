/**
 * Minimal mock of the `obsidian` module for unit tests.
 *
 * Only exports stubs for APIs actually used in the test suite.
 * Individual tests can override these via `vi.mocked()`.
 */

import { vi } from "vitest";

export const requestUrl = vi.fn();

/**
 * Minimal `Notice` stub. Records the most recent message so a suite can assert on
 * it, but is otherwise inert (no DOM). Construction is the side effect Obsidian
 * code relies on; tests rarely need to inspect it.
 */
export class Notice {
	static last: string | number | DocumentFragment | null = null;
	constructor(message: string | number | DocumentFragment, _duration?: number) {
		Notice.last = message;
	}
	setMessage(_message: string | DocumentFragment): this {
		return this;
	}
	hide(): void {}
}

/**
 * Normalize a vault path the way Obsidian does: collapse backslashes to forward
 * slashes, collapse duplicate slashes, strip a leading slash. Pure utility —
 * safe to expose to every suite.
 */
export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\//, "");
}

export function getFrontMatterInfo(content: string): { exists: boolean; contentStart: number } {
	const match = content.match(/^---\n[\s\S]*?\n---\n?/);
	if (!match) return { exists: false, contentStart: 0 };
	return { exists: true, contentStart: match[0].length };
}

/**
 * Minimal abstract-file hierarchy so `instanceof TFile` / `instanceof TFolder`
 * checks work in unit tests (the parser/discovery code branches on these).
 * Tests construct these directly and register them in a fake Vault.
 */
export class TAbstractFile {
	path = "";
	name = "";
}

export class TFile extends TAbstractFile {
	extension = "md";
	stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

/**
 * Minimal `Modal` / `FuzzySuggestModal` / `ButtonComponent` stubs. Inert — they
 * only need to exist as constructable base classes so modules that `extends` them
 * (e.g. the orchestration command UI) load under the mock. Tests that exercise a
 * modal's behavior construct it and call its methods directly.
 */
export class Modal {
	app: unknown;
	contentEl: unknown = {};
	constructor(app?: unknown) {
		this.app = app;
	}
	open(): void {}
	close(): void {}
	onOpen(): void {}
	onClose(): void {}
}

export class FuzzySuggestModal<T> {
	app: unknown;
	resultContainerEl: unknown = {};
	constructor(app?: unknown) {
		this.app = app;
	}
	setPlaceholder(_placeholder: string): void {}
	getItems(): T[] {
		return [];
	}
	getItemText(_item: T): string {
		return "";
	}
	onChooseItem(_item: T): void {}
	open(): void {}
	close(): void {}
}

export class ButtonComponent {
	constructor(_containerEl?: unknown) {}
	setButtonText(_text: string): this {
		return this;
	}
	setCta(): this {
		return this;
	}
	onClick(_cb: () => void): this {
		return this;
	}
}
