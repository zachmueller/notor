/**
 * Build-time precompiled TypeScript-stripping results for the built-in
 * extension scaffolds (tools, automations, blocks).
 *
 * This module is intentionally empty in source: the production/dev esbuild
 * build replaces its contents with the generated table (see
 * `esbuild/precompile-scaffolds.mjs`, which runs `buildPrecompiledTable()` from
 * `./precompile-table.ts`). Under vitest it stays empty, so every compile goes
 * through Sucrase as before.
 *
 * Entries are keyed by a hash of the exact code-fence source, so a lookup
 * never returns output for different code: a vault override, a template-variable
 * substitution, or a scaffold edited since the build simply misses and is
 * compiled normally.
 */

import { createHash } from "crypto";

/** Which Sucrase transform produced an entry (see compiler.ts). */
export type PrecompiledKind = "plain" | "block";

/**
 * Table key for a code-fence source compiled with the given transform: a
 * SHA-256 of kind + exact source, so the bundle doesn't carry each scaffold's
 * source a second time.
 */
export function precompiledKey(kind: PrecompiledKind, code: string): string {
	return createHash("sha256").update(kind).update("\u0000").update(code).digest("hex");
}

/** key → Sucrase output. Populated at build time; empty in source and tests. */
export const PRECOMPILED_STRIPPED: ReadonlyMap<string, string> = new Map();
