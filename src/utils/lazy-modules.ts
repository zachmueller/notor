/**
 * Deferred loaders for heavy document libraries (docx, mammoth, PizZip,
 * Turndown + domino, xmldom). Only npm packages are loaded here (a bare
 * `require` of a package also resolves under vitest); local modules that use
 * these libraries call the loaders inside their functions instead.
 *
 * Everything is still bundled into main.js, but a static `import` makes esbuild
 * evaluate the module (and its dependency tree, ~2.4 MB unminified) while the
 * plugin loads — on every launch, before onload runs. A `require()` inside a
 * memoized loader keeps the bundled module behind esbuild's lazy wrapper until
 * the first call, typically when an extension first touches `libs.docx` etc.
 * Callers keep a synchronous API.
 */

import type MammothModule from "mammoth";
import type TurndownService from "turndown";
import type * as DocxModule from "docx";
import type PizZipModule from "pizzip";
import type * as XmldomModule from "@xmldom/xmldom";

/** Unwrap a CommonJS-interop default export (`import X from` semantics). */
export function interopDefault<T>(mod: unknown): T {
	const m = mod as { __esModule?: boolean; default?: unknown } | null;
	return (m && m.__esModule && m.default !== undefined ? m.default : m) as T;
}

/** Memoize a loader so every caller sees the same module object. */
export function once<T>(load: () => T): () => T {
	let loaded = false;
	let value: T;
	return () => {
		if (!loaded) {
			value = load();
			loaded = true;
		}
		return value;
	};
}

/* Each require() below is resolved and bundled by esbuild; it only defers evaluation. */

export const loadMammoth = once(() =>
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred evaluation of a bundled module (see file header)
	interopDefault<typeof MammothModule>(require("mammoth")),
);

export const loadTurndown = once(() =>
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred evaluation of a bundled module (see file header)
	interopDefault<typeof TurndownService>(require("turndown")),
);

export const loadDocx = once(() =>
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred evaluation of a bundled module (see file header)
	require("docx") as typeof DocxModule,
);

export const loadPizZip = once(() =>
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred evaluation of a bundled module (see file header)
	interopDefault<typeof PizZipModule>(require("pizzip")),
);

export const loadXmldom = once(() =>
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred evaluation of a bundled module (see file header)
	require("@xmldom/xmldom") as typeof XmldomModule,
);
