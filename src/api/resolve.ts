/**
 * Name → definition lookup for circuits and workflows, shared by the external
 * API, the `run_circuit` hook action, and step→workflow invocation.
 *
 * Matching runs in tiers, most specific first, and returns every match in the
 * first tier that has any. A caller treats more than one match as ambiguous
 * (the API) or takes the first (legacy call sites).
 */

import type { Circuit } from "../circuits/types";
import type { Workflow } from "../types";

/** Circuits matching `ref` by name, then directory path, then a trailing directory segment. */
export function matchCircuits(circuits: readonly Circuit[], ref: string): Circuit[] {
	const r = ref.trim().replace(/\/+$/, "");
	if (!r) return [];
	return firstTier<Circuit>([
		circuits.filter((c) => c.name === r),
		circuits.filter((c) => c.flowDir === r),
		circuits.filter((c) => c.flowDir.endsWith(`/${r}`)),
	]);
}

/**
 * Workflows matching `ref` by display name (`daily/review`), then vault path,
 * then file name (with or without `.md`), then an `aliases` entry.
 */
export function matchWorkflows(workflows: readonly Workflow[], ref: string): Workflow[] {
	const r = ref.trim();
	if (!r) return [];
	const withMd = r.endsWith(".md") ? r : `${r}.md`;
	return firstTier<Workflow>([
		workflows.filter((w) => w.display_name === r),
		workflows.filter((w) => w.file_path === r || w.file_path === withMd),
		workflows.filter((w) => w.file_name === r || w.file_name === withMd),
		workflows.filter((w) => w.aliases.includes(r)),
	]);
}

function firstTier<T>(tiers: T[][]): T[] {
	return tiers.find((t) => t.length > 0) ?? [];
}
