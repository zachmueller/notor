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
