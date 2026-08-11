import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { BUILTIN_TOOL_SCAFFOLDS } from "../builtin-tool-scaffolds";
import { parseExtensionFile } from "../parser";
import { paramSchemaToJsonSchema } from "../param-schema";

/**
 * Guard on the required-param set every built-in tool advertises to the LLM.
 *
 * `required[]` is *derived* — `paramSchemaToJsonSchema()` marks any param that
 * has neither a `default` nor `optional: true`. That derivation used to be
 * cosmetic, so five scaffolds drifted into declaring conditionally-required
 * params as mandatory (`webview.url`, all five `write_docx` params,
 * `write_xlsx.output_path`/`filename`, `read_file.pages`,
 * `orchestration_task_list.filter`). Now that a missing required param
 * auto-fails the call at dispatch (`src/chat/param-validation.ts`), that drift
 * would break the tool outright — so the expected set is pinned here, and a new
 * or edited scaffold must update this table deliberately.
 *
 * Runs the real fence through the real parser and converter, so it also covers
 * `optional: true` surviving the YAML → ParamSchema → JSON Schema round trip.
 */
function requiredParamsOf(toolName: string): string[] {
	const scaffold = BUILTIN_TOOL_SCAFFOLDS.get(toolName);
	if (!scaffold) throw new Error(`No scaffold for ${toolName}`);

	const result = parseExtensionFile(
		scaffold.scaffoldContent,
		{
			"notor-type": "tool",
			"notor-tool-name": scaffold.name,
			"notor-description": scaffold.description,
			"notor-mode": scaffold.mode,
		},
		`${toolName}.md`,
		(yaml) => parseYaml(yaml),
	);
	if ("message" in result) throw new Error(`Parse failed for ${toolName}: ${result.message}`);
	if (!("params" in result)) throw new Error(`${toolName} did not parse as a tool`);

	return [...(paramSchemaToJsonSchema(result.params).required ?? [])].sort();
}

/** Tool name → the params the model MUST supply. Order-insensitive. */
const EXPECTED_REQUIRED: Record<string, string[]> = {
	apply_template: ["template_path"],
	ask_user: ["questions"],
	capture_memory: ["content"],
	delete_note: ["path"],
	edit_notor_settings: ["key_path", "value"],
	emit_event: ["payload", "topic"],
	execute_command: ["command"],
	extract_docx_comments: ["docx_path", "output_path"],
	fetch_webpage: ["url"],
	get_backlinks: ["path"],
	get_outlinks: ["path"],
	import_docx: ["note_path", "path"],
	import_xlsx: ["note_path", "path"],
	invoke_workflow: ["task", "workflow"],
	list_templates: [],
	list_vault: [],
	list_xlsx_sheets: ["path"],
	manage_tags: ["path"],
	move_note: ["new_path", "path"],
	orchestration_task_close: ["key"],
	orchestration_task_ensure: ["description", "key"],
	// `filter` is optional — the scaffold used to express that with a top-level
	// `required: []`, which the parser silently ignores (it reads only `params`).
	orchestration_task_list: [],
	orchestration_task_start: ["key"],
	read_chat_history: ["conversation_id"],
	read_docx: ["path"],
	// `pages` is a PDF-only page range.
	read_file: ["path"],
	read_frontmatter: ["path"],
	read_note: ["path"],
	read_notor_settings: [],
	read_xlsx: ["path"],
	replace_in_file: ["changes", "path"],
	replace_in_note: ["changes", "path"],
	search_chat_history: [],
	search_vault: ["query"],
	sleep: ["duration_seconds"],
	update_frontmatter: ["path"],
	web_search: ["query"],
	// `text` is click-only, `url` is navigate-only.
	webview: ["action"],
	word_count: ["path"],
	// content XOR note_name, output_path XOR filename, template optional — no
	// single param is unconditionally required.
	write_docx: [],
	write_file: ["content", "path"],
	write_note: ["content", "path"],
	// output_path XOR filename.
	write_xlsx: ["content"],
};

describe("built-in scaffold required params", () => {
	it("covers every built-in scaffold", () => {
		expect(Object.keys(EXPECTED_REQUIRED).sort()).toEqual([...BUILTIN_TOOL_SCAFFOLDS.keys()].sort());
	});

	for (const [toolName, expected] of Object.entries(EXPECTED_REQUIRED)) {
		it(`${toolName} requires [${expected.join(", ")}]`, () => {
			expect(requiredParamsOf(toolName)).toEqual([...expected].sort());
		});
	}
});

describe("built-in scaffolds — conditionally-required params opt out via `optional: true`", () => {
	// Locks the specific regressions that motivated the flag: each of these params
	// is legitimately absent on a large share of real calls, so advertising it as
	// required would auto-fail those calls at dispatch.
	it.each([
		["webview", "text"],
		["webview", "url"],
		["write_docx", "note_name"],
		["write_docx", "content"],
		["write_docx", "output_path"],
		["write_docx", "filename"],
		["write_docx", "template_path"],
		["write_xlsx", "output_path"],
		["write_xlsx", "filename"],
		["read_file", "pages"],
		["orchestration_task_list", "filter"],
	])("%s.%s is not required", (toolName, param) => {
		expect(requiredParamsOf(toolName)).not.toContain(param);
	});
});
