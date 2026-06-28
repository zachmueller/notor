/**
 * Minimal mock of the `obsidian` module for unit tests.
 *
 * Only exports stubs for APIs actually used in the test suite.
 * Individual tests can override these via `vi.mocked()`.
 */

import { vi } from "vitest";

export const requestUrl = vi.fn();

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
