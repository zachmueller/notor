import type { DataAdapter } from "obsidian";

/**
 * Atomically read, mutate, and write a plaintext file via `DataAdapter.process`.
 *
 * `adapter.process` is documented as atomic (obsidian.d.ts:1649) — it is the
 * preferred alternative to read → mutate → write for header-surgery rewrites where
 * a crash mid-write could truncate the file.
 *
 * Returns the new file content (the return value of `mutate`).
 */
export function atomicRewrite(
	adapter: DataAdapter,
	path: string,
	mutate: (content: string) => string,
): Promise<string> {
	return adapter.process(path, mutate);
}
