/**
 * The scorecard also lints styles.css ("Avoid !important — override styles by
 * increasing selector specificity or using CSS variables instead."). Only
 * `!important` is mirrored here. Its browser-compatibility check ("… is only
 * partially supported by Obsidian <minAppVersion>") isn't; calibrate.ts lists any
 * such finding as uncovered.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitTrackedFiles } from "./exec";
import type { CheckContext, CheckOutput } from "./types";

export function checkCss(ctx: CheckContext): CheckOutput {
	const locations: string[] = [];
	for (const file of gitTrackedFiles(ctx.root).filter((f) => f.endsWith(".css") && !f.includes("/"))) {
		// Blank out comments but keep newlines, so line numbers survive.
		const text = readFileSync(join(ctx.root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
		text.split("\n").forEach((line, i) => {
			if (/!\s*important/i.test(line)) locations.push(`${file}:${i + 1}`);
		});
	}
	const id = "css/no-important";
	if (locations.length === 0) return { findings: [], measured: { lint: {} } };
	return {
		findings: [{
			check: "lint",
			id,
			severity: "WARN",
			title: "Avoid !important; override styles with selector specificity or CSS variables instead",
			count: locations.length,
			baseline: ctx.baseline?.lint[id],
			locations,
		}],
		measured: { lint: { [id]: locations.length } },
	};
}
