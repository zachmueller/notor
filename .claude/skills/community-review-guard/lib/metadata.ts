/**
 * Check 6 — release metadata. A mismatch here makes the release uninstallable
 * (Obsidian resolves the GitHub release from manifest.json's version), which the
 * directory treats like a failed review: the plugin drops out of search.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitTrackedFiles, run } from "./exec";
import type { CheckContext, CheckOutput, Finding } from "./types";

const SEMVER = /^\d+\.\d+\.\d+$/;
const REQUIRED_MANIFEST_FIELDS = ["id", "name", "version", "minAppVersion", "description", "author", "isDesktopOnly"];
const NODE_ONLY_IMPORT = /(?:from\s+|require\()\s*["'](?:node:[\w/]+|fs|fs\/promises|child_process|path|os|net|http|https|crypto|electron)["']/;

function readJson(root: string, file: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(root, file), "utf8")) as Record<string, unknown>;
}

export function checkMetadata(ctx: CheckContext, opts: { tag: string | null }): CheckOutput {
	const findings: Finding[] = [];
	const block = (id: string, title: string, detail?: string) =>
		findings.push({ check: "metadata", id, severity: "BLOCK", title, detail });

	const manifest = readJson(ctx.root, "manifest.json");
	const pkg = readJson(ctx.root, "package.json");
	const versions = readJson(ctx.root, "versions.json");
	const version = String(manifest.version ?? "");

	for (const field of REQUIRED_MANIFEST_FIELDS) {
		if (manifest[field] === undefined || manifest[field] === "") block(`manifest-${field}`, `manifest.json is missing "${field}"`);
	}
	if (!SEMVER.test(version)) block("manifest-semver", `manifest.json version "${version}" is not x.y.z (no leading v)`);
	if (pkg.version !== version) block("package-version", `package.json version ${String(pkg.version)} ≠ manifest.json ${version}`);

	const lastKey = Object.keys(versions).at(-1);
	if (lastKey !== version) block("versions-last-key", `versions.json's last key is ${String(lastKey)}, expected ${version}`);
	if (versions[version] !== manifest.minAppVersion) {
		block("versions-min-app", `versions.json["${version}"] = ${String(versions[version])}, but minAppVersion is ${String(manifest.minAppVersion)}`);
	}
	if (opts.tag !== null && opts.tag !== version) block("tag-version", `Tag ${opts.tag} ≠ manifest.json version ${version}`);

	if (manifest.isDesktopOnly !== true) {
		const nodeUsers = gitTrackedFiles(ctx.root)
			.filter((f) => f.startsWith("src/") && /\.ts$/.test(f) && !/\.test\.ts$|__tests__|__mocks__/.test(f))
			.filter((f) => NODE_ONLY_IMPORT.test(readFileSync(join(ctx.root, f), "utf8")));
		if (nodeUsers.length > 0) {
			findings.push({
				check: "metadata",
				id: "desktop-only",
				severity: "BLOCK",
				title: "isDesktopOnly is not true, but src imports Node/Electron modules",
				count: nodeUsers.length,
				locations: nodeUsers,
			});
		}
	}

	// Once a GitHub release exists for this version, the assets must be there and published.
	if (!ctx.offline && SEMVER.test(version)) {
		const r = run("gh", ["release", "view", version, "--json", "assets,isDraft"], ctx.repoRoot);
		if (r.status === 0) {
			const rel = JSON.parse(r.stdout) as { isDraft: boolean; assets: Array<{ name: string }> };
			const names = new Set(rel.assets.map((a) => a.name));
			for (const asset of ["main.js", "manifest.json"]) {
				if (!names.has(asset)) block(`release-asset-${asset}`, `GitHub release ${version} has no ${asset} asset`);
			}
			if (rel.isDraft) {
				findings.push({ check: "metadata", id: "release-draft", severity: "INFO", title: `GitHub release ${version} is still a draft` });
			}
		}
	}
	return { findings };
}
