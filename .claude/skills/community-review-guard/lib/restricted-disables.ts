/**
 * Check 3 — eslint directive comments the scanner rejects.
 *
 * This is the 0.12.0 failure mode: one `/* eslint-disable @typescript-eslint/no-deprecated *\/`
 * produced both dashboard errors. Mirrors the `eslint-comments/*` block of
 * eslint-plugin-obsidianmd's recommended config without needing eslint:
 *   no-restricted-disable   disabling a rule on the plugin's restricted list
 *   no-unlimited-disable    a disable directive with no rule list
 *   disable-enable-pair     a block-level disable with no later matching enable
 *   require-description     a disable directive without a `-- reason`
 * Comments are read from the TypeScript AST, so directive-looking text inside
 * strings or fixtures is ignored.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { gitTrackedFiles } from "./exec";
import { inScannerScope, SOURCE_FILE } from "./scope";
import type { CheckContext, CheckOutput, Finding } from "./types";

/** Copy of the 0.4.2 list, used only if the installed plugin can't be parsed. */
const FALLBACK_RESTRICTED = [
	"obsidianmd/*",
	"no-console",
	"no-restricted-globals",
	"@typescript-eslint/no-restricted-imports",
	"no-alert",
	"@typescript-eslint/no-deprecated",
	"@typescript-eslint/no-explicit-any",
	"@microsoft/sdl/no-document-write",
	"no-eval",
	"@microsoft/sdl/no-inner-html",
	"obsidianmd/no-nodejs-modules",
];

export function readRestrictedRules(pluginDir: string): { rules: string[]; fromPlugin: boolean } {
	const index = join(pluginDir, "dist", "lib", "index.js");
	if (existsSync(index)) {
		const m = /"eslint-comments\/no-restricted-disable":\s*\[\s*"error",([\s\S]*?)\]/.exec(readFileSync(index, "utf8"));
		const rules = m ? [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!) : [];
		if (rules.length > 0) return { rules, fromPlugin: true };
	}
	return { rules: FALLBACK_RESTRICTED, fromPlugin: false };
}

interface Directive {
	file: string;
	line: number;
	kind: "disable" | "disable-line" | "disable-next-line" | "enable";
	rules: string[];
	described: boolean;
}

const DIRECTIVE = /^eslint-(disable-next-line|disable-line|disable|enable)(?=\s|$)([\s\S]*)$/;

function scriptKind(file: string): ts.ScriptKind {
	if (/\.[cm]?tsx?$/.test(file)) return file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	return file.endsWith("x") ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
}

function directivesIn(file: string, text: string): Directive[] {
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
	const seen = new Set<number>();
	const out: Directive[] = [];
	const collect = (ranges: ts.CommentRange[] | undefined) => {
		for (const r of ranges ?? []) {
			if (seen.has(r.pos)) continue;
			seen.add(r.pos);
			const raw = text.slice(r.pos, r.end);
			const body = (r.kind === ts.SyntaxKind.MultiLineCommentTrivia ? raw.slice(2, -2) : raw.slice(2)).trim();
			const m = DIRECTIVE.exec(body);
			if (!m) continue;
			const [rulePart, ...description] = m[2]!.split(/\s-{2,}\s/);
			out.push({
				file,
				line: sf.getLineAndCharacterOfPosition(r.pos).line + 1,
				kind: m[1] as Directive["kind"],
				rules: (rulePart ?? "").split(",").map((s) => s.trim()).filter(Boolean),
				described: description.join("").trim() !== "",
			});
		}
	};
	// getChildren() includes tokens, so comments before `}` and at EOF are reached too.
	const visit = (node: ts.Node) => {
		collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
		collect(ts.getTrailingCommentRanges(text, node.getEnd()));
		for (const child of node.getChildren(sf)) visit(child);
	};
	visit(sf);
	return out.sort((a, b) => a.line - b.line);
}

function matchesRestricted(rule: string, restricted: string[]): boolean {
	return restricted.some((r) => (r.endsWith("/*") ? rule.startsWith(r.slice(0, -1)) : rule === r));
}

/** Pure core, exported for tests: problems in one file's directives. */
export function directiveProblems(file: string, text: string, restricted: string[]): Array<{ id: string; title: string; at: string }> {
	const problems: Array<{ id: string; title: string; at: string }> = [];
	const directives = directivesIn(file, text);
	directives.forEach((d, i) => {
		const at = `${d.file}:${d.line}`;
		if (d.kind === "enable") return;
		if (d.rules.length === 0) problems.push({ id: "no-unlimited-disable", title: "Disable directive without a rule list", at });
		for (const rule of d.rules) {
			if (matchesRestricted(rule, restricted)) problems.push({ id: "no-restricted-disable", title: `Disabling '${rule}' is not allowed`, at });
		}
		if (!d.described) problems.push({ id: "require-description", title: "Disable directive without a `-- reason`", at });
		if (d.kind === "disable") {
			const enabled = directives
				.slice(i + 1)
				.some((e) => e.kind === "enable" && (e.rules.length === 0 || d.rules.every((r) => e.rules.includes(r))));
			if (!enabled) problems.push({ id: "disable-enable-pair", title: `Requires 'eslint-enable' directive for '${d.rules.join(", ") || "all rules"}'`, at });
		}
	});
	return problems;
}

export function checkRestrictedDisables(ctx: CheckContext, pluginDir: string): CheckOutput {
	const { rules: restricted, fromPlugin } = readRestrictedRules(pluginDir);
	const grouped = new Map<string, Finding>();
	for (const file of gitTrackedFiles(ctx.root).filter((f) => SOURCE_FILE.test(f))) {
		const text = readFileSync(join(ctx.root, file), "utf8");
		if (!text.includes("eslint-")) continue;
		const scanned = inScannerScope(file);
		for (const p of directiveProblems(file, text, restricted)) {
			const key = `${p.id}:${scanned ? "scanned" : "unscanned"}`;
			const f = grouped.get(key) ?? {
				check: "restricted-disables",
				id: scanned ? `eslint-comments/${p.id}` : `eslint-comments/${p.id} (outside scanner scope)`,
				severity: scanned ? "BLOCK" : "WARN",
				title: scanned ? p.title : `${p.title} — outside today's scanner scope; fix anyway`,
				count: 0,
				locations: [],
			};
			f.count! += 1;
			f.locations!.push(p.at);
			grouped.set(key, f);
		}
	}
	const findings = [...grouped.values()];
	if (!fromPlugin) {
		findings.push({
			check: "restricted-disables",
			id: "restricted-list-fallback",
			severity: "WARN",
			title: "Couldn't read the restricted-rule list from eslint-plugin-obsidianmd; used the 0.4.2 copy",
		});
	}
	return { findings };
}
