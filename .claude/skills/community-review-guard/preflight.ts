#!/usr/bin/env npx tsx
/**
 * community-review-guard preflight — would Obsidian's automated review fail this
 * release, and what got worse since the last one?
 *
 * Usage (from repo root; `npm run review:guard -- <flags>`):
 *   npx tsx .claude/skills/community-review-guard/preflight.ts            # full, working tree
 *   … --ref 0.12.0                    # a committed ref, in a temporary worktree (npm ci)
 *   … --ci --tag "$GITHUB_REF_NAME"   # release workflow: no build, no human step
 *   … --quick                         # restricted disables + metadata only; seconds, no network
 *   … --ref 0.12.1 --write-baseline   # after publishing: record the new delta origin
 *
 * Flags: --offline (use the repo's pinned lint plugin, skip npm/gh), --skip-build
 * (reuse build/main.js), --no-repro (skip the clean-checkout rebuild), --json.
 * Exit status 1 when anything BLOCKs.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkArtifact } from "./lib/artifact";
import { checkAudit } from "./lib/audit";
import { checkCss } from "./lib/css";
import { headSha, isDirty, run, withWorktree } from "./lib/exec";
import { checkFreshness, checkLint, resolveToolchain, runScannerLint } from "./lib/lint";
import { checkMetadata } from "./lib/metadata";
import { previewScanPrompt, renderReport, verdict, type Mode } from "./lib/report";
import { checkRestrictedDisables } from "./lib/restricted-disables";
import type { Baseline, CheckContext, CheckOutput, Finding } from "./lib/types";

const here = dirname(fileURLToPath(import.meta.url));
// .claude/skills/community-review-guard/ -> repo root is three levels up.
const repoRoot = resolve(here, "..", "..", "..");
const BASELINE = join(here, "baseline.json");
const ALLOWLIST = join(here, "allowlist.json");

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : null;
};

const mode: Mode = flag("--quick") ? "quick" : flag("--ci") ? "ci" : "full";
const ref = value("--ref");
const offline = flag("--offline");
const baseline = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline) : null;
const allowlist = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as { wasm: Record<string, string> };

async function inspect(root: string): Promise<{ findings: Finding[]; measured: Partial<Baseline>; toolchain: Record<string, string> | null }> {
	const ctx: CheckContext = { root, repoRoot, ref, offline, baseline };
	const version = String((JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { version: string }).version);
	const outputs: CheckOutput[] = [];
	const step = (name: string) => process.stderr.write(`[guard] ${name}…\n`);

	step("restricted eslint directives");
	outputs.push(checkRestrictedDisables(ctx, join(repoRoot, "node_modules", "eslint-plugin-obsidianmd")));
	step("release metadata");
	outputs.push(checkMetadata(ctx, { tag: value("--tag") }));

	let toolchain: Record<string, string> | null = null;
	if (mode !== "quick") {
		step("resolving the scanner's lint toolchain");
		const tc = resolveToolchain(repoRoot, offline);
		toolchain = tc.versions;
		outputs.push({ findings: checkFreshness(repoRoot, tc, offline) });
		step("scanner-equivalent lint");
		outputs.push(checkLint(ctx, runScannerLint(root, tc)));
		outputs.push(checkCss(ctx));
		step("npm audit");
		outputs.push(checkAudit(ctx));
	}
	if (mode === "full") {
		step("built artifact");
		const repro = !flag("--no-repro") && !(ref === null && isDirty(root));
		outputs.push(await checkArtifact(ctx, { skipBuild: flag("--skip-build"), repro, allowlist, version }));
		if (!repro && !flag("--no-repro")) {
			outputs.push({ findings: [{ check: "artifact", id: "repro-skipped", severity: "WARN", title: "Working tree has uncommitted changes; skipped the clean-checkout rebuild. Commit, then rerun." }] });
		}
	}
	const measured = Object.assign({}, ...outputs.map((o) => o.measured ?? {})) as Partial<Baseline>;
	// Several checks contribute per-rule counts; merge them rather than letting the last win.
	measured.lint = Object.assign({}, ...outputs.map((o) => o.measured?.lint ?? {})) as Record<string, number>;
	// Check 3 and the lint run both see eslint-comments problems; report each location once.
	const findings = outputs.flatMap((o) => o.findings);
	const directiveLocs = new Set(findings.filter((f) => f.check === "restricted-disables").flatMap((f) => f.locations ?? []));
	const deduped = findings.filter(
		(f) => !(f.check === "lint" && f.id.startsWith("eslint-comments/") && (f.locations ?? []).every((l) => directiveLocs.has(l))),
	);
	return { findings: deduped, measured, toolchain };
}

const sha = ref ? run("git", ["rev-parse", `${ref}^{commit}`], repoRoot).stdout.trim() : headSha(repoRoot);
const result = ref ? await withWorktree(repoRoot, ref, { install: mode !== "quick" }, inspect) : await inspect(repoRoot);
const version = String((JSON.parse(run("git", ["show", `${sha}:manifest.json`], repoRoot).stdout) as { version: string }).version);

if (flag("--write-baseline")) {
	if (mode !== "full") throw new Error("--write-baseline needs a full run (drop --ci/--quick)");
	const next: Baseline = {
		ref: ref ?? sha,
		version,
		measuredAt: new Date().toISOString(),
		tools: result.toolchain ?? {},
		lint: result.measured.lint ?? {},
		artifact: result.measured.artifact ?? null,
		advisories: result.measured.advisories ?? [],
	};
	writeFileSync(BASELINE, JSON.stringify(next, null, "\t") + "\n");
	process.stderr.write(`[guard] wrote ${BASELINE} (ref ${next.ref})\n`);
}

if (flag("--json")) {
	console.log(JSON.stringify({ verdict: verdict(result.findings, mode), sha, version, toolchain: result.toolchain, findings: result.findings }, null, 2));
} else {
	const subject = `${ref ?? "working tree"} @ ${sha.slice(0, 7)} (version ${version})`;
	console.log(renderReport({ findings: result.findings, mode, subject, toolchain: result.toolchain, baselineRef: baseline?.ref ?? null }));
	if (mode === "full" && !result.findings.some((f) => f.severity === "BLOCK")) {
		const branch = ref ? null : run("git", ["branch", "--show-current"], repoRoot).stdout.trim() || null;
		console.log(previewScanPrompt(sha, branch));
	}
}
process.exitCode = result.findings.some((f) => f.severity === "BLOCK") ? 1 : 0;
