/**
 * Minimal mock of the `obsidian` module for unit tests.
 *
 * Only exports stubs for APIs actually used in the test suite.
 * Individual tests can override these via `vi.mocked()`.
 */

import { vi } from "vitest";

export const requestUrl = vi.fn();
