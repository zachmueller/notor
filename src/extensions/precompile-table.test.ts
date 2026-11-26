/**
 * Build-time scaffold precompilation: the generated table covers the built-in
 * scaffolds as the runtime will look them up, and a populated table makes the
 * compiler skip Sucrase for exactly those sources.
 */

import { describe, expect, it, vi } from "vitest";
import { buildPrecompiledTable } from "./precompile-table";
import { precompiledKey } from "./precompiled-scaffolds";
import { extractCodeFence } from "./parser";
import { BUILTIN_TOOL_SCAFFOLDS } from "./builtin-tool-scaffolds";
import { BUILTIN_AUTOMATION_SCAFFOLDS } from "./builtin-automation-scaffolds";
import { BUILTIN_BLOCK_SCAFFOLDS } from "./builtin-block-scaffolds";
import { TemplateVariableRegistry } from "../template-vars/registry";

/** Resolve scaffold content as ExtensionManager does at runtime. */
function runtimeCode(content: string): string | null {
	const registry = new TemplateVariableRegistry();
	registry.register("notor_dir", () => "notor");
	registry.register("vault_name", () => "My Vault");
	return extractCodeFence(registry.resolve(content))?.code ?? null;
}

describe("buildPrecompiledTable", () => {
	const table = new Map(buildPrecompiledTable());

	it("covers every built-in tool, automation and block scaffold the runtime will look up", () => {
		const cases: Array<["plain" | "block", string]> = [
			...[...BUILTIN_TOOL_SCAFFOLDS.values()].map((s) => ["plain", s.scaffoldContent] as ["plain", string]),
			...[...BUILTIN_AUTOMATION_SCAFFOLDS.values()].map((s) => ["plain", s.scaffoldContent] as ["plain", string]),
			...[...BUILTIN_BLOCK_SCAFFOLDS.values()].map((s) => ["block", s.scaffoldContent] as ["block", string]),
		];
		let hits = 0;
		let withPlaceholders = 0;
		for (const [kind, content] of cases) {
			const code = runtimeCode(content);
			if (!code) continue;
			if (table.has(precompiledKey(kind, code))) hits++;
			else if (/\{(notor_dir|vault_name)\}/.test(content)) withPlaceholders++;
			else throw new Error(`missing precompiled entry for a ${kind} scaffold`);
		}
		expect(hits).toBeGreaterThan(40);
		// Scaffolds whose code uses a template variable can only miss (compiled at runtime).
		expect(hits + withPlaceholders).toBe(cases.filter(([, c]) => runtimeCode(c)).length);
	});

	it("keys by kind: the same source under the other transform is a different entry", () => {
		const anyTool = [...BUILTIN_TOOL_SCAFFOLDS.values()][0]!;
		const code = extractCodeFence(anyTool.scaffoldContent)!.code;
		expect(precompiledKey("plain", code)).not.toBe(precompiledKey("block", code));
	});
});

describe("compiler with a populated table", () => {
	it("returns the precompiled output without running Sucrase, and compiles misses normally", async () => {
		vi.resetModules();
		const transform = vi.fn((code: string) => ({ code: `/*sucrase*/${code}` }));
		vi.doMock("sucrase", () => ({ transform }));
		vi.doMock("./precompiled-scaffolds", async (orig) => {
			const actual = await orig<typeof import("./precompiled-scaffolds")>();
			return {
				...actual,
				PRECOMPILED_STRIPPED: new Map([
					[actual.precompiledKey("plain", "const a: number = 1;"), "const a = 1;"],
					[actual.precompiledKey("block", "export function render() {}"), "exports.render = function render() {}"],
				]),
			};
		});
		const { stripTypes, stripTypesForBlock } = await import("./compiler");

		expect(stripTypes("const a: number = 1;")).toBe("const a = 1;");
		expect(stripTypesForBlock("export function render() {}")).toBe("exports.render = function render() {}");
		expect(transform).not.toHaveBeenCalled();

		expect(stripTypes("const b: string = 'x';")).toBe("/*sucrase*/const b: string = 'x';");
		expect(transform).toHaveBeenCalledTimes(1);

		vi.doUnmock("sucrase");
		vi.doUnmock("./precompiled-scaffolds");
		vi.resetModules();
	});
});
