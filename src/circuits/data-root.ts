/**
 * Where circuit runtime data (sessions/, failures/, memories.md) lives.
 *
 * Circuit *definitions* are discovered under both `{notor_dir}/circuits/` and
 * the legacy `{notor_dir}/orchestrations/` (see `schema-aliases.ts`). Runtime
 * data, by contrast, lives under exactly ONE root per install, chosen by a pure
 * rule and never migrated, so crash recovery, the run tree, chaining, and child
 * ledgers never have to look in two places:
 *
 *   1. `circuits/sessions/` exists     → "circuits"        (data already landed there)
 *   2. else `orchestrations/` exists   → "orchestrations"  (legacy install: nothing moves)
 *   3. else                            → "circuits"        (fresh install)
 *
 * Rule 1 makes the choice sticky: once a run has written to `circuits/`, a
 * later hand-made `orchestrations/<slug>/` never flips it back.
 */

import type { CircuitHost } from "./host";

export type CircuitDataRootName = "circuits" | "orchestrations";

/** Legacy default, used when no host-level decision is available (keeps old behavior). */
export const LEGACY_CIRCUIT_DATA_ROOT: CircuitDataRootName = "orchestrations";

function trimSlash(p: string): string {
	return p.replace(/\/+$/, "");
}

/**
 * Apply the sticky single-root rule. `folderExists` receives vault-relative
 * paths such as `notor/circuits/sessions`.
 */
export function resolveCircuitDataRootName(
	notorDir: string,
	folderExists: (vaultPath: string) => boolean,
): CircuitDataRootName {
	const base = trimSlash(notorDir);
	if (folderExists(`${base}/circuits/sessions`)) return "circuits";
	if (folderExists(`${base}/orchestrations`)) return "orchestrations";
	return "circuits";
}

/** `{notor_dir}/{rootName}` as a vault-relative path. */
export function circuitDataRootPath(notorDir: string, rootName: CircuitDataRootName): string {
	return `${trimSlash(notorDir)}/${rootName}`;
}

/** The host's data-root decision, defaulting to the legacy root for hosts that predate it. */
export function circuitDataRootOf(host: Pick<CircuitHost, "getCircuitDataRootName">): CircuitDataRootName {
	return host.getCircuitDataRootName?.() ?? LEGACY_CIRCUIT_DATA_ROOT;
}
