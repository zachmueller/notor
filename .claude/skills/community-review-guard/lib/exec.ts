/** Process and git helpers shared by the checks. */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
}

/** Run a command without a shell; never throws on a non-zero exit. */
export function run(cmd: string, args: string[], cwd: string, opts: { env?: Record<string, string> } = {}): RunResult {
	const r = spawnSync(cmd, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 512 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...opts.env },
	});
	if (r.error) throw r.error;
	return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Run and throw with stderr when the command fails. */
export function runOk(cmd: string, args: string[], cwd: string): string {
	const r = run(cmd, args, cwd);
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}):\n${r.stderr || r.stdout}`);
	return r.stdout;
}

export function gitTrackedFiles(root: string): string[] {
	return runOk("git", ["ls-files", "-z"], root).split("\0").filter(Boolean);
}

export function headSha(root: string): string {
	return runOk("git", ["rev-parse", "HEAD"], root).trim();
}

export function isDirty(root: string): boolean {
	return runOk("git", ["status", "--porcelain"], root).trim() !== "";
}

const SEMVER = /^\d+\.\d+\.\d+$/;

function compareSemver(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
	return 0;
}

/** Highest release tag strictly below `version` (the release the next one is compared to). */
export function previousReleaseTag(repoRoot: string, version: string): string | null {
	const tags = runOk("git", ["tag", "--list"], repoRoot).split("\n").filter((t) => SEMVER.test(t));
	const older = tags.filter((t) => compareSemver(t, version) < 0).sort(compareSemver);
	return older.at(-1) ?? null;
}

/**
 * Check out `ref` into a temporary worktree, optionally `npm ci` it, and run `fn`.
 * The worktree is always removed afterwards.
 */
export async function withWorktree<T>(
	repoRoot: string,
	ref: string,
	opts: { install: boolean },
	fn: (dir: string) => Promise<T>,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "notor-guard-wt-"));
	runOk("git", ["worktree", "add", "--detach", "--force", dir, ref], repoRoot);
	try {
		if (opts.install) {
			process.stderr.write(`[guard] npm ci in worktree at ${ref}…\n`);
			runOk("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], dir);
		}
		return await fn(dir);
	} finally {
		run("git", ["worktree", "remove", "--force", dir], repoRoot);
		rmSync(dir, { recursive: true, force: true });
		run("git", ["worktree", "prune"], repoRoot);
	}
}
