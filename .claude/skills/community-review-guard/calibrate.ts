#!/usr/bin/env npx tsx
/**
 * Compare the guard against Obsidian's real scanner.
 *
 * Fetches Notor's public scorecard (or reads a saved page), finds the commit it
 * scanned, lints that commit with the guard in a temporary worktree, and matches
 * findings by file:line. Reports:
 *   - scorecard Risks the guard doesn't BLOCK   → the guard would let a delisting through (fix the guard)
 *   - guard BLOCKs that aren't scorecard Risks  → the guard is over-strict
 *   - scorecard locations the guard never flags → missing rule or scope
 *   - guard rules the scorecard never shows     → candidates for NOT_ON_SCORECARD in lib/lint.ts
 * Non-lint scorecard findings (dependencies, size, WASM, attestations) are listed
 * with the preflight check that covers them, if any.
 *
 * Usage: npx tsx .claude/skills/community-review-guard/calibrate.ts [--html saved-page.html] [--plugin notor]
 * The public page may cap long location lists, so "scanner-only" counts are exact
 * but "guard-only" counts are an upper bound.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withWorktree } from "./lib/exec";
import { checkCss } from "./lib/css";
import { checkLint, resolveToolchain, runScannerLint } from "./lib/lint";
import { directiveProblems, readRestrictedRules } from "./lib/restricted-disables";
import { fetchScorecard, parseScorecard, type ScorecardFinding } from "./lib/scorecard";
import { gitTrackedFiles } from "./lib/exec";
import { inScannerScope } from "./lib/scope";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const argv = process.argv.slice(2);
const value = (name: string) => {
	const i = argv.indexOf(name);
	return i >= 0 ? (argv[i + 1] ?? null) : null;
};

/** Scorecard findings that aren't lint, and the preflight check that covers each. */
const NON_LINT_COVERAGE: Array<[RegExp, string]> = [
	[/scan not available/i, "(scanner status line, nothing to check)"],
	[/^Vault (Read|Write)\b/i, "(capability, passed)"],
	[/vulnerability advisory/i, "audit (Check 5)"],
	[/larger than 5 MB/i, "artifact: main-js-size"],
	[/WASM/i, "artifact: wasm-unlisted"],
	[/transpilation helpers/i, "artifact: es5-*"],
	[/base64/i, "artifact: dynamic-atob/btoa"],
	[/network request/i, "artifact: network-calls"],
	[/byte-for-byte|reproduc/i, "artifact: reproducible-build"],
	[/attestation/i, "(not covered: add actions/attest-build-provenance to release.yaml)"],
	[/Filesystem Access|Shell Execution|Vault Enumeration|Clipboard|Dynamic Code/i, "(capability disclosure: README)"],
];

const pluginId = value("--plugin") ?? "notor";
const htmlPath = value("--html");
const html = htmlPath ? readFileSync(htmlPath, "utf8") : await fetchScorecard(pluginId);
const card = parseScorecard(html);
if (!card.commit) throw new Error("No source locations on the scorecard, so its commit is unknown");
process.stderr.write(`[calibrate] scorecard: ${card.findings.length} findings at ${card.commit.slice(0, 7)}\n`);

const guard = await withWorktree(repoRoot, card.commit, { install: true }, async (dir) => {
	const tc = resolveToolchain(repoRoot, false);
	const ctx = { root: dir, repoRoot, ref: card.commit, offline: false, baseline: null };
	const findings = [...checkLint(ctx, runScannerLint(dir, tc)).findings, ...checkCss(ctx).findings];
	const { rules } = readRestrictedRules(join(repoRoot, "node_modules", "eslint-plugin-obsidianmd"));
	for (const file of gitTrackedFiles(dir).filter(inScannerScope)) {
		for (const p of directiveProblems(file, readFileSync(join(dir, file), "utf8"), rules)) {
			findings.push({ check: "restricted-disables", id: `eslint-comments/${p.id}`, severity: "BLOCK", title: p.title, count: 1, locations: [p.at] });
		}
	}
	return { findings, versions: tc.versions };
});

// file:line → guard rule ids / severities
const guardAt = new Map<string, Array<{ id: string; severity: string }>>();
for (const f of guard.findings) for (const loc of f.locations ?? []) guardAt.set(loc, [...(guardAt.get(loc) ?? []), { id: f.id, severity: f.severity }]);
const scorecardLocs = new Set(card.findings.flatMap((f) => f.locations));

const out: string[] = [`# Calibration: guard vs scorecard @ ${card.commit.slice(0, 7)}`, ""];
out.push(`Guard toolchain: ${Object.entries(guard.versions).map(([k, v]) => `${k} ${v}`).join(" · ")}`, "");

const lintFindings = card.findings.filter((f) => f.locations.length > 0);
const missedRisks = lintFindings.filter((f) => f.severity === "high" && !f.locations.every((l) => guardAt.get(l)?.some((g) => g.severity === "BLOCK")));
out.push(`## Scorecard Risks the guard doesn't BLOCK: ${missedRisks.length}${missedRisks.length ? " ← fix the guard" : " ✓"}`, "");
for (const f of missedRisks) out.push(`- ${f.title} (${f.locations.join(", ")})`);

const riskLocs = new Set(lintFindings.filter((f) => f.severity === "high").flatMap((f) => f.locations));
const overStrict = guard.findings.filter((f) => f.severity === "BLOCK" && (f.locations ?? []).some((l) => !riskLocs.has(l)));
out.push("", `## Guard BLOCKs that aren't scorecard Risks: ${overStrict.length}${overStrict.length ? " ← over-strict?" : " ✓"}`, "");
for (const f of overStrict) out.push(`- ${f.id}: ${f.title} (${(f.locations ?? []).filter((l) => !riskLocs.has(l)).slice(0, 5).join(", ")})`);

out.push("", "## Scorecard lint findings vs guard", "", "| Scorecard | Sev | Locs | Matched | Guard rules at those lines |", "|---|---|---:|---:|---|");
const describe = (f: ScorecardFinding) => {
	const matched = f.locations.filter((l) => guardAt.has(l));
	const rules = [...new Set(matched.flatMap((l) => guardAt.get(l)!.map((g) => g.id)))];
	return `| ${f.title.replace(/\|/g, "\\|").slice(0, 90)} | ${f.severity} | ${f.locations.length} | ${matched.length} | ${rules.slice(0, 3).join(", ")} |`;
};
for (const f of lintFindings) out.push(describe(f));

out.push("", "## Guard rules with no scorecard location (candidates for NOT_ON_SCORECARD)", "", "| Rule | Guard count | On scorecard |", "|---|---:|---:|");
for (const f of guard.findings.sort((a, b) => (b.count ?? 0) - (a.count ?? 0))) {
	const on = (f.locations ?? []).filter((l) => scorecardLocs.has(l)).length;
	if (on < (f.count ?? 0)) out.push(`| ${f.id} | ${f.count} | ${on} |`);
}

out.push("", "## Non-lint scorecard findings", "");
for (const f of card.findings.filter((x) => x.locations.length === 0)) {
	const cover = NON_LINT_COVERAGE.find(([re]) => re.test(f.title))?.[1] ?? "(uncovered: consider a new check)";
	out.push(`- [${f.severity}] ${f.title.slice(0, 110)} → ${cover}`);
}
console.log(out.join("\n"));
