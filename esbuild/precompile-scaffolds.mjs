/**
 * esbuild plugin: precompile the built-in extension scaffolds at build time.
 *
 * At startup the ExtensionManager strips TypeScript from every built-in tool,
 * automation and block scaffold with Sucrase (~44 tools today). The result only
 * depends on the scaffold source, so the build computes it once:
 *
 *  1. bundle `src/extensions/precompile-table.ts` (scaffolds + parser + the same
 *     compiler the plugin uses) for Node into a temp file and require it;
 *  2. call `buildPrecompiledTable()` → `[sha256(kind + code), strippedCode]` pairs;
 *  3. serve `src/extensions/precompiled-scaffolds.ts` with its empty
 *     `new Map()` replaced by those entries.
 *
 * Runtime lookups are keyed by a hash of the exact code-fence source, so a stale
 * or overridden scaffold can only miss (and compile normally), never get wrong
 * output. Under vitest the module keeps its empty source table.
 */

import esbuild from "esbuild";
import { builtinModules, createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PRECOMPILED_FILTER = /src[\\/]extensions[\\/]precompiled-scaffolds\.ts$/;

/** The exact initializer replaced in precompiled-scaffolds.ts. */
export const EMPTY_TABLE = "PRECOMPILED_STRIPPED: ReadonlyMap<string, string> = new Map();";

/** Run the generator from source and return its `[key, stripped]` entries. */
export async function generatePrecompiledTable(projectRoot) {
	const result = await esbuild.build({
		absWorkingDir: projectRoot,
		entryPoints: [resolve(projectRoot, "src/extensions/precompile-table.ts")],
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "es2018",
		write: false,
		logLevel: "silent",
		external: ["obsidian", ...builtinModules],
	});
	const dir = mkdtempSync(join(tmpdir(), "notor-precompile-"));
	try {
		const file = join(dir, "precompile-table.cjs");
		writeFileSync(file, result.outputFiles[0].text);
		const { buildPrecompiledTable } = createRequire(file)(file);
		return buildPrecompiledTable();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** precompiled-scaffolds.ts source with the empty table replaced by `entries`. */
export function renderPrecompiledModule(source, entries) {
	const count = source.split(EMPTY_TABLE).length - 1;
	if (count !== 1) {
		throw new Error(
			`[precompile-scaffolds] expected exactly one "${EMPTY_TABLE}" in precompiled-scaffolds.ts, found ${count}`,
		);
	}
	// A replacer function: the table holds compiled code with `$` sequences that a
	// replacement *string* would interpret as substitution patterns.
	return source.replace(
		EMPTY_TABLE,
		() => `PRECOMPILED_STRIPPED: ReadonlyMap<string, string> = new Map(${JSON.stringify(entries)});`,
	);
}

export function precompileScaffoldsPlugin(projectRoot) {
	return {
		name: "precompile-scaffolds",
		setup(build) {
			build.onLoad({ filter: PRECOMPILED_FILTER }, async (args) => {
				const entries = await generatePrecompiledTable(projectRoot);
				const contents = renderPrecompiledModule(readFileSync(args.path, "utf8"), entries);
				return { contents, loader: "ts" };
			});
		},
	};
}
