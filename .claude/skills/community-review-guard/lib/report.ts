/** Markdown report and verdict for preflight. */

import type { Finding } from "./types";

export type Mode = "full" | "ci" | "quick";

export function verdict(findings: Finding[], mode: Mode): string {
	const blocks = findings.filter((f) => f.severity === "BLOCK").length;
	if (blocks > 0) return `BLOCKED (${blocks})`;
	return mode === "full" ? "NEEDS PREVIEW-SCAN CONFIRMATION" : `${mode.toUpperCase()} CHECKS PASSED`;
}

function cell(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function where(f: Finding, max: number): string {
	const locs = f.locations ?? [];
	if (locs.length === 0) return f.detail ?? "";
	const shown = locs.slice(0, max).map((l) => `\`${l}\``).join(", ");
	return locs.length > max ? `${shown} … +${locs.length - max} more` : shown;
}

function delta(f: Finding): string {
	if (f.count === undefined || f.baseline === undefined) return f.count === undefined ? "" : "new";
	const d = f.count - f.baseline;
	return d > 0 ? `▲ +${d}` : d < 0 ? `▼ ${d}` : "=";
}

function increased(f: Finding): boolean {
	return f.count !== undefined && (f.baseline === undefined ? f.check === "lint" : f.count > f.baseline);
}

export function renderReport(opts: {
	findings: Finding[];
	mode: Mode;
	subject: string;
	toolchain: Record<string, string> | null;
	baselineRef: string | null;
}): string {
	const { findings, mode } = opts;
	const lines: string[] = [];
	lines.push(`# community-review-guard: ${opts.subject}`, "");
	if (opts.toolchain) lines.push(`Lint toolchain: ${Object.entries(opts.toolchain).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
	lines.push(`Baseline: ${opts.baselineRef ?? "none (run --ref <last release> --write-baseline)"}`, "");
	lines.push(`## Verdict: ${verdict(findings, mode)}`, "");

	const blocks = findings.filter((f) => f.severity === "BLOCK");
	if (blocks.length > 0) {
		lines.push(`## Blocking (${blocks.length}): these fail Obsidian's review`, "", "| Check | Finding | Count | Where |", "|---|---|---:|---|");
		for (const f of blocks) lines.push(`| ${f.check} | ${cell(f.title)} | ${f.count ?? ""} | ${cell(where(f, 10))} |`);
		lines.push("");
	}

	const warns = findings
		.filter((f) => f.severity === "WARN")
		.sort((a, b) => Number(increased(b)) - Number(increased(a)) || (b.count ?? 0) - (a.count ?? 0));
	if (warns.length > 0) {
		lines.push(`## Warnings (${warns.length}): scorecard warnings, rising ones first`, "", "| Check | Finding | Count | Δ baseline | Example |", "|---|---|---:|---|---|");
		for (const f of warns) lines.push(`| ${f.check} | ${cell(`${f.id}: ${f.title}`)} | ${f.count ?? ""} | ${delta(f)} | ${cell(where(f, 2))} |`);
		lines.push("");
	}

	const infos = findings.filter((f) => f.severity === "INFO");
	if (infos.length > 0) {
		lines.push("## Info", "");
		for (const f of infos) lines.push(`- ${f.check}: ${f.title}${f.count !== undefined ? ` (${f.count})` : ""}${f.baseline !== undefined ? `, baseline ${f.baseline}` : ""}`);
		lines.push("");
	}
	return lines.join("\n");
}

export function previewScanPrompt(sha: string, branch: string | null): string {
	return [
		"## Next: dashboard preview scan (required before tagging)",
		"",
		"The scan reads GitHub, so push first. Then:",
		"1. Sign in at https://community.obsidian.md → **Plugins** → **Notor** (under **Your entries**).",
		`2. Select **Review branch**, enter \`${sha}\`${branch ? ` (or \`${branch}\`)` : ""}, and select **Run preview scan**.`,
		"3. Confirm it reports **no errors**. If it disagrees with this report, run `calibrate.ts` and fix the guard first.",
	].join("\n");
}
