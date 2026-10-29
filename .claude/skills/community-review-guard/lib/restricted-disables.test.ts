import { describe, expect, it } from "vitest";
import { directiveProblems } from "./restricted-disables";
import { inScannerScope } from "./scope";

const RESTRICTED = ["obsidianmd/*", "no-console", "@typescript-eslint/no-deprecated", "@typescript-eslint/no-explicit-any"];
const ids = (text: string, file = "src/a.ts") => directiveProblems(file, text, RESTRICTED).map((p) => `${p.id}@${p.at.split(":")[1]}`);

describe("directiveProblems", () => {
	it("reproduces both 0.12.0 dashboard errors for a whole-file restricted disable", () => {
		const text = [
			"/** header */",
			"",
			"/* eslint-disable @typescript-eslint/no-deprecated -- ScriptProcessorNode is used on purpose. */",
			"import type { X } from './x';",
		].join("\n");
		expect(ids(text)).toEqual(["no-restricted-disable@3", "disable-enable-pair@3"]);
	});

	it("still rejects a restricted rule disabled for one line", () => {
		expect(ids("// eslint-disable-next-line no-console -- debugging\nconsole.log(1);")).toEqual(["no-restricted-disable@1"]);
	});

	it("matches wildcard entries like obsidianmd/*", () => {
		expect(ids("// eslint-disable-next-line obsidianmd/prefer-window-timers -- test\nsetTimeout(f);")).toEqual(["no-restricted-disable@1"]);
	});

	it("accepts a described per-line disable of an unrestricted rule", () => {
		expect(ids("// eslint-disable-next-line @typescript-eslint/no-require-imports -- fs needs require()\nconst fs = require('fs');")).toEqual([]);
	});

	it("requires a description", () => {
		expect(ids("// eslint-disable-next-line @typescript-eslint/no-require-imports\nconst fs = require('fs');")).toEqual(["require-description@1"]);
	});

	it("flags a bare disable as unlimited and unpaired", () => {
		expect(ids("/* eslint-disable -- everything */\nlet a;")).toEqual(["no-unlimited-disable@1", "disable-enable-pair@1"]);
	});

	it("accepts a block disable closed by a matching enable", () => {
		const text = "/* eslint-disable no-empty -- legacy */\ntry {} catch {}\n/* eslint-enable no-empty */";
		expect(ids(text)).toEqual([]);
	});

	it("ignores directive text inside strings and template literals", () => {
		const text = "const a = '// eslint-disable no-console';\nconst b = `/* eslint-disable @typescript-eslint/no-explicit-any */`;";
		expect(ids(text)).toEqual([]);
	});

	it("finds directives in an otherwise empty block, before the closing brace", () => {
		const text = "function f() {\n\t// eslint-disable-next-line no-console -- x\n}";
		expect(ids(text)).toEqual(["no-restricted-disable@2"]);
	});
});

describe("inScannerScope", () => {
	it.each([
		["src/voice/audio/audio-capture.ts", true],
		["e2e/lib/test-helpers.ts", true],
		["e2e/run-and-collect.ts", true],
		["src/voice/voice-controller.test.ts", false],
		["src/__mocks__/obsidian.ts", false],
		["src/foo/__tests__/fixture.ts", false],
		["e2e/scripts/setup-vault.ts", false],
		["e2e/scripts/voice-mode-test.ts", false],
		[".claude/skills/x/preflight.ts", false],
		["esbuild.config.mjs", false],
		["src/types.d.ts", false],
	])("%s → %s", (path, expected) => {
		expect(inScannerScope(path)).toBe(expected);
	});
});
