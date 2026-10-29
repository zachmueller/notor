/**
 * Checks 1 + 2 — lint the tree the way Obsidian's scanner does.
 *
 * Check 1 (freshness): the scanner applies the *latest* eslint-plugin-obsidianmd and
 * typescript-eslint; 0.12.0 shipped because we linted with a stale pin. So lint runs
 * from a cached toolchain dir with the newest versions inside the plugin's peer
 * ranges, and a stale repo pin is reported (CI's `npm run lint` would disagree).
 *
 * Check 2 (lint): scanner-equivalent config over the scanner's file scope, with
 * findings mapped to the scanner's severities. The 0.12.0 dashboard showed lint
 * *errors* from typescript-eslint and no-console as warnings, and only
 * eslint-comments/* as release-blocking errors.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gitTrackedFiles, run, runOk } from "./exec";
import { inScannerScope } from "./scope";
import type { CheckContext, CheckOutput, Finding, Severity } from "./types";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_NAME = "scanner.eslint.config.mjs";

/** Confirmed blocking: both 0.12.0 dashboard errors came from this family. */
const CONFIRMED_BLOCK = /^eslint-comments\//;
/** Security and obsidianmd errors are presumed blocking until a scorecard says otherwise. */
const PRESUMED_BLOCK = [/^no-unsanitized\//, /^no-eval$/, /^no-implied-eval$/, /^obsidianmd\/(?!ui\/sentence-case|rule-custom-message)/];
/**
 * Rules the recommended config reports but the scorecard never shows. In the 0.12.0
 * calibration these had 52 and 2 hits and 0 scorecard locations. They're reported
 * as INFO, not WARN, so the warning list mirrors the scorecard.
 */
const NOT_ON_SCORECARD = new Set(["obsidianmd/ui/sentence-case", "@typescript-eslint/no-deprecated"]);

interface EslintMessage {
	ruleId: string | null;
	severity: 1 | 2;
	message: string;
	line?: number;
	fatal?: boolean;
}

export interface Toolchain {
	/** Directory whose node_modules hold eslint + the plugin. */
	dir: string;
	versions: Record<string, string>;
	configPath: string;
}

function installedVersion(dir: string, pkg: string): string | null {
	const p = join(dir, "node_modules", pkg, "package.json");
	return existsSync(p) ? String((JSON.parse(readFileSync(p, "utf8")) as { version: string }).version) : null;
}

function npmView(spec: string, field: string, cwd: string): string {
	const out = runOk("npm", ["view", spec, field, "--json"], cwd).trim();
	const v = JSON.parse(out) as string | string[];
	return Array.isArray(v) ? v.at(-1)! : v;
}

/** Resolve (and cache) a toolchain with the scanner's likely versions. */
export function resolveToolchain(repoRoot: string, offline: boolean): Toolchain {
	if (offline) {
		return {
			dir: repoRoot,
			configPath: join(SKILL_DIR, CONFIG_NAME),
			versions: {
				"eslint-plugin-obsidianmd": installedVersion(repoRoot, "eslint-plugin-obsidianmd") ?? "?",
				"typescript-eslint": installedVersion(repoRoot, "typescript-eslint") ?? "?",
			},
		};
	}
	const plugin = npmView("eslint-plugin-obsidianmd@latest", "version", repoRoot);
	const tseslint = npmView("typescript-eslint@latest", "version", repoRoot);
	const tsRange = npmView(`typescript-eslint@${tseslint}`, "peerDependencies.typescript", repoRoot);
	const typescript = npmView(`typescript@${tsRange}`, "version", repoRoot);
	const dir = join(tmpdir(), "notor-review-guard", `toolchain-${plugin}-${tseslint}-${typescript}`);
	if (!existsSync(join(dir, "node_modules", "eslint-plugin-obsidianmd"))) {
		process.stderr.write(`[guard] installing lint toolchain (obsidianmd ${plugin}, typescript-eslint ${tseslint}, typescript ${typescript})…\n`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }));
		runOk("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "eslint@^9",
			`eslint-plugin-obsidianmd@${plugin}`, `typescript-eslint@${tseslint}`, `typescript@${typescript}`], dir);
	}
	copyFileSync(join(SKILL_DIR, CONFIG_NAME), join(dir, CONFIG_NAME));
	return {
		dir,
		configPath: join(dir, CONFIG_NAME),
		versions: { "eslint-plugin-obsidianmd": plugin, "typescript-eslint": tseslint, typescript, eslint: installedVersion(dir, "eslint") ?? "?" },
	};
}

/** Check 1: is the repo's own pin behind what the scanner uses? */
export function checkFreshness(repoRoot: string, tc: Toolchain, offline: boolean): Finding[] {
	if (offline) {
		return [{ check: "freshness", id: "offline", severity: "WARN", title: "--offline: linted with the repo's pinned plugin; can't confirm the scanner's ruleset" }];
	}
	const findings: Finding[] = [];
	for (const pkg of ["eslint-plugin-obsidianmd", "typescript-eslint"]) {
		const pinned = installedVersion(repoRoot, pkg);
		if (pinned !== tc.versions[pkg]) {
			findings.push({
				check: "freshness",
				id: `${pkg}-behind`,
				severity: "WARN",
				title: `Repo has ${pkg} ${pinned ?? "(none)"}, the scanner likely uses ${tc.versions[pkg]}; bump it so npm run lint matches`,
			});
		}
	}
	return findings;
}

function classify(m: EslintMessage): { severity: Severity; presumed: boolean } {
	const rule = m.ruleId ?? "";
	if (m.fatal) return { severity: "BLOCK", presumed: false };
	if (CONFIRMED_BLOCK.test(rule)) return { severity: "BLOCK", presumed: false };
	if (m.severity === 2 && (m.ruleId === null || PRESUMED_BLOCK.some((p) => p.test(rule)))) return { severity: "BLOCK", presumed: true };
	return { severity: NOT_ON_SCORECARD.has(rule) ? "INFO" : "WARN", presumed: false };
}

export interface LintRun {
	/** Per-file messages, keyed by repo-relative path. */
	byFile: Map<string, EslintMessage[]>;
}

export function runScannerLint(root: string, tc: Toolchain): LintRun {
	const files = gitTrackedFiles(root).filter(inScannerScope);
	const out = join(tmpdir(), `notor-guard-lint-${process.pid}.json`);
	const eslintBin = join(tc.dir, "node_modules", "eslint", "bin", "eslint.js");
	const r = run(process.execPath, [eslintBin, "-c", tc.configPath, "-f", "json", "-o", out, "--no-warn-ignored", ...files], root, {
		env: { GUARD_TARGET_ROOT: root },
	});
	if (r.status === 2 || !existsSync(out)) throw new Error(`eslint crashed:\n${r.stderr || r.stdout}`);
	const results = JSON.parse(readFileSync(out, "utf8")) as Array<{ filePath: string; messages: EslintMessage[] }>;
	rmSync(out, { force: true });
	// eslint reports realpaths (/private/var/… for macOS temp worktrees).
	const realRoot = realpathSync(root);
	const byFile = new Map<string, EslintMessage[]>();
	for (const res of results) {
		if (res.messages.length > 0) byFile.set(relative(realRoot, realpathSync(res.filePath)), res.messages);
	}
	return { byFile };
}

export function checkLint(ctx: CheckContext, lint: LintRun): CheckOutput {
	const grouped = new Map<string, Finding>();
	for (const [file, messages] of lint.byFile) {
		for (const m of messages) {
			const { severity, presumed } = classify(m);
			const id = m.ruleId ?? (m.fatal ? "(parse error)" : "(eslint directive)");
			const f = grouped.get(id) ?? {
				check: "lint",
				id,
				severity,
				title: presumed
					? `${m.message} (presumed blocking)`
					: severity === "INFO" ? `${id} (not shown on the scorecard)` : m.message,
				count: 0,
				baseline: ctx.baseline?.lint[id],
				locations: [],
			};
			if (severity === "BLOCK") f.severity = "BLOCK";
			f.count! += 1;
			f.locations!.push(`${file}:${m.line ?? 0}`);
			grouped.set(id, f);
		}
	}
	const counts = Object.fromEntries([...grouped].map(([id, f]) => [id, f.count!]));
	return { findings: [...grouped.values()], measured: { lint: counts } };
}
