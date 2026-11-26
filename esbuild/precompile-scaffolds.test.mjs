import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_TABLE, generatePrecompiledTable, renderPrecompiledModule } from "./precompile-scaffolds.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(projectRoot, "src/extensions/precompiled-scaffolds.ts"), "utf8");

describe("precompile-scaffolds esbuild plugin", () => {
	it("source module carries exactly one empty table to replace", () => {
		expect(source.split(EMPTY_TABLE).length - 1).toBe(1);
	});

	it("generates sha256-keyed entries for the built-in scaffolds", async () => {
		const entries = await generatePrecompiledTable(projectRoot);
		expect(entries.length).toBeGreaterThan(40);
		for (const [key, value] of entries) {
			expect(key).toMatch(/^[0-9a-f]{64}$/);
			expect(typeof value).toBe("string");
		}
	}, 60_000);

	it("embeds entries verbatim even when they contain $-substitution patterns", () => {
		const tricky = [["k", "const re = `^${x}$`; s.replace(/a/, \"$&$1$`$'\");"]];
		const out = renderPrecompiledModule(source, tricky);
		expect(out).toContain(JSON.stringify(tricky));
		expect(out).not.toContain(EMPTY_TABLE);
	});

	it("fails loudly if the placeholder table is missing or duplicated", () => {
		expect(() => renderPrecompiledModule("no table here", [])).toThrow(/expected exactly one/);
		expect(() => renderPrecompiledModule(source + source, [])).toThrow(/expected exactly one/);
	});
});
