import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { BUILTIN_TOOL_SCAFFOLDS } from "../builtin-tool-scaffolds";
import { parseExtensionFile } from "../parser";
import type { ToolPathParam } from "../../tool-config/types";
import { groupOf } from "../../tool-config/types";

/**
 * Parse a built-in scaffold through the real parser and return the path params
 * it registers into TOOL_PATH_PARAMS at load time.
 */
function pathParamsOf(toolName: string): ToolPathParam[] {
	const scaffold = BUILTIN_TOOL_SCAFFOLDS.get(toolName);
	if (!scaffold) throw new Error(`No scaffold for ${toolName}`);

	const frontmatter = {
		"notor-type": "tool",
		"notor-tool-name": scaffold.name,
		"notor-description": scaffold.description,
		"notor-mode": scaffold.mode,
	};
	const result = parseExtensionFile(
		scaffold.scaffoldContent,
		frontmatter,
		`${toolName}.md`,
		(yaml) => parseYaml(yaml),
	);
	if ("message" in result) throw new Error(`Parse failed for ${toolName}: ${result.message}`);
	if (!("pathParams" in result)) throw new Error(`${toolName} did not parse as a tool`);
	return result.pathParams;
}

const paramNamed = (params: ToolPathParam[], name: string) =>
	params.find((p) => p.paramName === name);

describe("built-in scaffold path metadata", () => {
	// Every path param must land in exactly one namespace × access group; the
	// global Settings lists are keyed on that group.
	it("assigns every registered path param to a valid group", () => {
		const valid = new Set([
			"vault-read",
			"vault-write",
			"filesystem-read",
			"filesystem-write",
		]);
		for (const name of BUILTIN_TOOL_SCAFFOLDS.keys()) {
			for (const param of pathParamsOf(name)) {
				expect(valid.has(groupOf(param)), `${name}.${param.paramName}`).toBe(true);
			}
		}
	});

	it("defaults a param's direction to the tool's mode", () => {
		// read_note is a read tool; its path param needs no explicit annotation.
		expect(paramNamed(pathParamsOf("read_note"), "path")!.access).toBe("read");
		// write_note is a write tool.
		expect(paramNamed(pathParamsOf("write_note"), "path")!.access).toBe("write");
	});

	describe("tools whose params straddle a namespace or direction boundary", () => {
		it("import_docx reads a filesystem file and writes a vault note", () => {
			const params = pathParamsOf("import_docx");
			expect(groupOf(paramNamed(params, "path")!)).toBe("filesystem-read");
			expect(groupOf(paramNamed(params, "note_path")!)).toBe("vault-write");
		});

		it("extract_docx_comments reads a filesystem file and writes a vault note", () => {
			const params = pathParamsOf("extract_docx_comments");
			expect(groupOf(paramNamed(params, "docx_path")!)).toBe("filesystem-read");
			expect(groupOf(paramNamed(params, "output_path")!)).toBe("vault-write");
		});

		it("write_docx reads a vault note and a template, and writes a filesystem file", () => {
			// note_name previously declared no path_namespace at all, so it escaped
			// enforcement entirely — a vault-read hole in the access tier.
			const params = pathParamsOf("write_docx");
			const noteName = paramNamed(params, "note_name");
			expect(noteName, "write_docx.note_name must participate in enforcement").toBeDefined();
			expect(groupOf(noteName!)).toBe("vault-read");
			expect(noteName!.resolveAs).toBe("note");

			expect(groupOf(paramNamed(params, "template_path")!)).toBe("filesystem-read");
			expect(groupOf(paramNamed(params, "output_path")!)).toBe("filesystem-write");
		});

		it("apply_template reads a template and writes into the output folder", () => {
			// output_folder previously escaped enforcement, so vault-write
			// restrictions did not govern where apply_template created notes.
			const params = pathParamsOf("apply_template");
			expect(groupOf(paramNamed(params, "template_path")!)).toBe("vault-read");

			const outputFolder = paramNamed(params, "output_folder");
			expect(outputFolder, "apply_template.output_folder must participate in enforcement")
				.toBeDefined();
			expect(groupOf(outputFolder!)).toBe("vault-write");
		});

		it("move_note treats both endpoints as writes", () => {
			const params = pathParamsOf("move_note");
			expect(groupOf(paramNamed(params, "path")!)).toBe("vault-write");
			expect(groupOf(paramNamed(params, "new_path")!)).toBe("vault-write");
		});
	});
});
