/**
 * esbuild plugin: precompile the built-in extension scaffolds at build time.
 *
 * At startup the ExtensionManager strips TypeScript from every built-in tool,
 * automation and block scaffold with Sucrase (~44 tools today). The result only
 * depends on the scaffold source, so the build computes it once:
 *
 *  1. bundle `src/extensions/precompile-table.ts` (scaffolds + parser + the same
 *     compiler the plugin uses) for Node and evaluate it in memory (no temp files);
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
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compileFunction } from "node:vm";

export const PRECOMPILED_FILTER = /src[\\/]extensions[\\/]precompiled-scaffolds\.ts$/;

/** The exact initializer replaced in precompiled-scaffolds.ts. */
export const EMPTY_TABLE = "PRECOMPILED_STRIPPED: ReadonlyMap<string, string> = new Map();";

/** Run the generator from source and return its `[key, stripped]` entries. */
export async function generatePrecompiledTable(projectRoot) {
	const entry = resolve(projectRoot, "src/extensions/precompile-table.ts");
	const result = await esbuild.build({
		absWorkingDir: projectRoot,
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "es2018",
		write: false,
		logLevel: "silent",
		external: ["obsidian", ...builtinModules],
	});
	// Evaluate the CJS bundle in memory: a scan or CI sandbox may have no writable
	// temp directory, and writing one there failed the whole build. The virtual
	// filename sits next to the entry so require() resolves externals from the repo.
	const filename = join(dirname(entry), "precompile-table.bundle.cjs");
	const mod = { exports: {} };
	const wrapper = compileFunction(result.outputFiles[0].text, ["exports", "require", "module", "__filename", "__dirname"], {
		filename,
	});
	wrapper(mod.exports, createRequire(filename), mod, filename, dirname(filename));
	return mod.exports.buildPrecompiledTable();
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
