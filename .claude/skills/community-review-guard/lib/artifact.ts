/**
 * Check 4 — the built release assets, which the scanner reviews alongside source:
 * size (Obsidian Sync Standard can't sync files over 5 MB), ES5 helpers, WASM,
 * dynamic code, network use, and whether a clean checkout rebuilds main.js
 * byte-for-byte (the scorecard's "build verification"; a mismatch fails review).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { headSha, previousReleaseTag, run, runOk, withWorktree } from "./exec";
import type { ArtifactMetrics, CheckContext, CheckOutput, Finding } from "./types";

const SYNC_LIMIT_BYTES = 5 * 1024 * 1024;

/** Minified-safe markers for TypeScript's downlevel helpers. */
const ES5_HELPERS: Record<string, RegExp> = {
	__awaiter: /\(\w+\|\|\(\w+=Promise\)\)\(function\(\w+,\w+\)\{function \w+\(\w+\)\{try\{/g,
	__generator: /Generator is already executing\./g,
	__spreadArray: /\|\|Array\.prototype\.slice\.call\(\w+(?:,\w+)?\)\)/g,
};
const DYNAMIC_CODE: Record<string, RegExp> = {
	eval: /(?<![\w.$])eval\(/g,
	"new Function": /new Function\(/g,
	atob: /(?<![\w$])atob\(/g,
	btoa: /(?<![\w$])btoa\(/g,
};
const NETWORK_CALL = /(?<![\w$])(?:fetch|requestUrl)\(|new (?:XMLHttpRequest|WebSocket|EventSource)\(/g;
const WASM_NAME = /[`'"/}]([\w.-]*\w\.wasm)\b/g;
const HOST = /https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

function count(text: string, re: RegExp): number {
	return [...text.matchAll(re)].length;
}

export function measure(mainJs: string): ArtifactMetrics {
	const text = readFileSync(mainJs, "utf8");
	return {
		mainJsBytes: statSync(mainJs).size,
		sha256: createHash("sha256").update(readFileSync(mainJs)).digest("hex"),
		es5Helpers: Object.fromEntries(Object.entries(ES5_HELPERS).map(([k, re]) => [k, count(text, re)])),
		wasm: [...new Set([...text.matchAll(WASM_NAME)].map((m) => m[1]!))].sort(),
		dynamicCode: Object.fromEntries(Object.entries(DYNAMIC_CODE).map(([k, re]) => [k, count(text, re)])),
		networkCalls: count(text, NETWORK_CALL),
		hosts: [...new Set([...text.matchAll(HOST)].map((m) => m[1]!.toLowerCase()))].sort(),
	};
}

function build(root: string): string {
	runOk("npm", ["run", "build"], root);
	const mainJs = join(root, "build", "main.js");
	if (!existsSync(mainJs)) throw new Error(`npm run build produced no ${mainJs}`);
	return mainJs;
}

function releaseMainJs(repoRoot: string, tag: string): { size: number; digest: string | null } | null {
	const r = run("gh", ["release", "view", tag, "--json", "assets"], repoRoot);
	if (r.status !== 0) return null;
	const assets = (JSON.parse(r.stdout) as { assets: Array<{ name: string; size: number; digest?: string }> }).assets;
	const asset = assets.find((a) => a.name === "main.js");
	return asset ? { size: asset.size, digest: asset.digest?.replace(/^sha256:/, "") ?? null } : null;
}

export async function checkArtifact(
	ctx: CheckContext,
	opts: { skipBuild: boolean; repro: boolean; allowlist: { wasm: Record<string, string> }; version: string },
): Promise<CheckOutput> {
	const findings: Finding[] = [];
	const add = (f: Omit<Finding, "check">) => findings.push({ check: "artifact", ...f });
	const mainJs = opts.skipBuild ? join(ctx.root, "build", "main.js") : build(ctx.root);
	if (!existsSync(mainJs)) throw new Error("--skip-build, but build/main.js doesn't exist");
	const m = measure(mainJs);
	const base = ctx.baseline?.artifact ?? null;

	const mb = (b: number) => `${(b / 1024 / 1024).toFixed(2)} MB`;
	const prevTag = previousReleaseTag(ctx.repoRoot, opts.version);
	const prevSize = prevTag && !ctx.offline ? (releaseMainJs(ctx.repoRoot, prevTag)?.size ?? null) : null;
	const growth = prevSize ? ` (${prevTag}: ${mb(prevSize)}, ${(((m.mainJsBytes - prevSize) / prevSize) * 100).toFixed(1)}%)` : "";
	add({
		id: "main-js-size",
		severity: m.mainJsBytes > SYNC_LIMIT_BYTES ? "WARN" : "INFO",
		title: `main.js is ${mb(m.mainJsBytes)}${growth}${m.mainJsBytes > SYNC_LIMIT_BYTES ? "; over 5 MB, Sync Standard users can't sync it" : ""}`,
		detail: base ? `baseline ${mb(base.mainJsBytes)}` : undefined,
	});

	for (const [helper, n] of Object.entries(m.es5Helpers)) {
		if (n === 0) continue;
		const before = base?.es5Helpers[helper];
		add({ id: `es5-${helper}`, severity: before !== undefined && n > before ? "WARN" : "INFO", title: `ES5 helper ${helper} in main.js`, count: n, baseline: before });
	}

	const unknownWasm = m.wasm.filter((w) => !(w in opts.allowlist.wasm));
	if (unknownWasm.length > 0) {
		add({ id: "wasm-unlisted", severity: "WARN", title: "WASM not in allowlist.json; document it in the README and allowlist it", locations: unknownWasm });
	}

	for (const [kind, n] of Object.entries(m.dynamicCode)) {
		if (n === 0) continue;
		const before = base?.dynamicCode[kind];
		add({ id: `dynamic-${kind}`, severity: before !== undefined && n > before ? "WARN" : "INFO", title: `${kind}() call sites in main.js`, count: n, baseline: before });
	}

	add({ id: "network-calls", severity: "INFO", title: "Network call sites in main.js", count: m.networkCalls, baseline: base?.networkCalls });
	const newHosts = base ? m.hosts.filter((h) => !base.hosts.includes(h)) : [];
	if (newHosts.length > 0) {
		add({ id: "new-hosts", severity: "WARN", title: "Hosts not in the baseline; disclose any the plugin contacts", count: newHosts.length, locations: newHosts });
	}

	// Once released, the published asset must be exactly what the tagged source builds.
	// Only compare when this tree IS that tag: before the version bump, HEAD still
	// carries the previous (already published) version number.
	const tagCommit = run("git", ["rev-parse", "--verify", "--quiet", `${opts.version}^{commit}`], ctx.repoRoot).stdout.trim();
	const isTaggedCommit = tagCommit !== "" && tagCommit === headSha(ctx.root);
	if (tagCommit !== "" && !isTaggedCommit) {
		add({ id: "version-already-released", severity: "INFO", title: `Version ${opts.version} is already tagged at another commit; the release's version bump comes next` });
	}
	const published = ctx.offline || !isTaggedCommit ? null : releaseMainJs(ctx.repoRoot, opts.version);
	if (published?.digest) {
		const same = published.digest === m.sha256;
		add({
			id: "release-asset-match",
			severity: same ? "INFO" : "BLOCK",
			title: same
				? `Published ${opts.version} main.js matches this build byte-for-byte`
				: `Published ${opts.version} main.js differs from this build; the scanner's build verification will fail`,
			detail: same ? undefined : `${published.digest} (release) vs ${m.sha256} (build)`,
		});
	}

	if (opts.repro) {
		const ref = ctx.ref ?? "HEAD";
		const clean = await withWorktree(ctx.repoRoot, ref, { install: true }, async (dir) => measure(build(dir)).sha256);
		add({
			id: "reproducible-build",
			severity: clean === m.sha256 ? "INFO" : "BLOCK",
			title: clean === m.sha256
				? `A clean checkout of ${ref} rebuilds main.js byte-for-byte`
				: `A clean checkout of ${ref} builds a different main.js; commit everything and npm ci before releasing`,
			detail: clean === m.sha256 ? undefined : `${m.sha256} (this tree) vs ${clean} (clean ${ref})`,
		});
	}
	return { findings, measured: { artifact: m } };
}
