/**
 * The built-in personas' `<notor_tool_config>` blocks must parse cleanly —
 * parse errors are only logged, so a broken block would silently drop the
 * persona's auto-approve set.
 */

import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { BUILTIN_PERSONA_PROFILES } from "./builtin-personas";
import { extractToolConfigs } from "../tool-config/parser";
import { TemplateVariableRegistry } from "../template-vars";

function parseBuiltin(name: string) {
	const def = BUILTIN_PERSONA_PROFILES.get(name);
	if (!def) throw new Error(`No built-in persona "${name}"`);
	const registry = new TemplateVariableRegistry();
	registry.register("notor_dir", () => "notor");
	const content = registry.resolve(def.systemPromptContent);
	return extractToolConfigs(content, "persona", `notor/personas/${name}/system-prompt.md`, undefined, parseYaml);
}

/** Tools each built-in persona auto-approves (everything else it lists must not). */
const EXPECTED_AUTO_APPROVE: Record<string, string[]> = {
	"notor-help": ["read_notor_settings"],
	"tool-creator": ["read_note", "search_vault", "list_vault"],
	"circuit-creator": ["read_note", "search_vault", "list_vault"],
	"circuit-eval-reviewer": ["read_note", "read_frontmatter", "search_vault", "list_vault", "read_file"],
};

describe("built-in persona tool configs", () => {
	it("covers every built-in persona", () => {
		expect([...BUILTIN_PERSONA_PROFILES.keys()].sort()).toEqual(Object.keys(EXPECTED_AUTO_APPROVE).sort());
	});

	for (const [name, autoApproved] of Object.entries(EXPECTED_AUTO_APPROVE)) {
		it(`${name}: parses with no errors and auto-approves ${autoApproved.join(", ")}`, () => {
			const { configs, errors } = parseBuiltin(name);
			expect(errors).toEqual([]);
			expect(configs).toHaveLength(1);

			const tools = configs[0]!.tools;
			const actual = Object.entries(tools)
				.filter(([, entry]) => entry.auto_approve === true)
				.map(([tool]) => tool);
			expect(actual.sort()).toEqual([...autoApproved].sort());
		});
	}

	it("circuit-eval-reviewer: read-only — every write tool it lists is disabled", () => {
		const { configs } = parseBuiltin("circuit-eval-reviewer");
		const tools = configs[0]!.tools;
		for (const name of ["write_note", "replace_in_note", "update_frontmatter", "delete_note", "move_note", "write_file", "replace_in_file"]) {
			expect(tools[name]?.enabled, name).toBe(false);
		}
		expect(tools.read_file?.allowed_paths).toEqual(["notor/"]);
	});

	it("circuit-creator: {notor_dir} in write_note allowed_paths resolves", () => {
		const { configs } = parseBuiltin("circuit-creator");
		expect(configs[0]!.tools.write_note?.allowed_paths).toEqual([
			"notor/circuits/",
			"notor/orchestrations/",
			"notor/personas/",
		]);
	});
});
