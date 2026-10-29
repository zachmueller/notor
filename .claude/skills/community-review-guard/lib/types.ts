/**
 * Shared shapes for the community-review-guard checks.
 *
 * Severity follows what Obsidian's automated review does with a finding:
 *   BLOCK — fails review (the release is pulled from the directory) or breaks install.
 *   WARN  — shown as a warning on the scorecard; doesn't block, but we track the delta.
 *   INFO  — disclosure-level signal; reported for awareness.
 */

export type Severity = "BLOCK" | "WARN" | "INFO";

export interface Finding {
	/** Check that produced it, e.g. "lint", "restricted-disables". */
	check: string;
	/** Stable key within the check (rule id, metric name); used for baseline deltas. */
	id: string;
	severity: Severity;
	title: string;
	count?: number;
	/** Count at the baseline ref, when the check tracks one. */
	baseline?: number;
	/** `file:line` locations (capped by the reporter). */
	locations?: string[];
	detail?: string;
}

export interface Baseline {
	ref: string;
	version: string;
	measuredAt: string;
	tools: Record<string, string>;
	lint: Record<string, number>;
	artifact: ArtifactMetrics | null;
	advisories: string[];
}

export interface ArtifactMetrics {
	mainJsBytes: number;
	sha256: string;
	es5Helpers: Record<string, number>;
	wasm: string[];
	dynamicCode: Record<string, number>;
	networkCalls: number;
	hosts: string[];
}

/** Everything a check needs to know about the tree it inspects. */
export interface CheckContext {
	/** Directory being checked: the repo itself, or a temporary worktree at `ref`. */
	root: string;
	/** Main repository (where this skill and its toolchain cache live). */
	repoRoot: string;
	/** Git ref under review; null means the working tree. */
	ref: string | null;
	offline: boolean;
	baseline: Baseline | null;
}

export interface CheckOutput {
	findings: Finding[];
	/** Partial baseline data this check measured, merged by `--write-baseline`. */
	measured?: Partial<Baseline>;
}
