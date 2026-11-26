/**
 * Generator for the build-time scaffold table (see precompiled-scaffolds.ts).
 *
 * Run by `esbuild/precompile-scaffolds.mjs` during the build: for every built-in
 * tool, automation and block scaffold it extracts the code fence exactly as the
 * extension parser does (`extractCodeFence` on the scaffold content) and runs
 * the same Sucrase transform the runtime would (`stripTypes` /
 * `stripTypesForBlock`). Runtime template-variable substitution happens before
 * parsing, so a scaffold whose code contains a substituted placeholder simply
 * misses the table and compiles normally.
 */

import { BUILTIN_TOOL_SCAFFOLDS } from "./builtin-tool-scaffolds";
import { BUILTIN_AUTOMATION_SCAFFOLDS } from "./builtin-automation-scaffolds";
import { BUILTIN_BLOCK_SCAFFOLDS } from "./builtin-block-scaffolds";
import { extractCodeFence } from "./parser";
import { stripTypes, stripTypesForBlock } from "./compiler";
import { precompiledKey } from "./precompiled-scaffolds";

/** `[key, strippedCode]` pairs for every built-in scaffold whose code compiles. */
export function buildPrecompiledTable(): Array<[string, string]> {
	const entries = new Map<string, string>();
	const add = (kind: "plain" | "block", content: string) => {
		const fence = extractCodeFence(content);
		if (!fence) return;
		try {
			const stripped = kind === "plain" ? stripTypes(fence.code) : stripTypesForBlock(fence.code);
			entries.set(precompiledKey(kind, fence.code), stripped);
		} catch {
			// A scaffold that fails to strip is reported at runtime as before.
		}
	};
	for (const s of BUILTIN_TOOL_SCAFFOLDS.values()) add("plain", s.scaffoldContent);
	for (const s of BUILTIN_AUTOMATION_SCAFFOLDS.values()) add("plain", s.scaffoldContent);
	for (const s of BUILTIN_BLOCK_SCAFFOLDS.values()) add("block", s.scaffoldContent);
	return [...entries];
}
