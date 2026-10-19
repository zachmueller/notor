import { describe, it, expect } from "vitest";
import { defaultAutoApproveFor } from "../constants";

describe("defaultAutoApproveFor", () => {
	it("read built-in tools default to auto-approved", () => {
		// Default-disabled read tools were the source of the original bug:
		// their toggle showed "on" but they still prompted.
		expect(defaultAutoApproveFor("sleep")).toBe(true);
		expect(defaultAutoApproveFor("search_chat_history")).toBe(true);
		expect(defaultAutoApproveFor("read_chat_history")).toBe(true);
		expect(defaultAutoApproveFor("read_note")).toBe(true);
	});

	it("write built-in tools default to requiring approval", () => {
		expect(defaultAutoApproveFor("write_note")).toBe(false);
		expect(defaultAutoApproveFor("execute_command")).toBe(false);
	});

	it("built-in scaffolds derive their default from their declared mode", () => {
		// The feature-gated circuit scaffolds had no TOOL_DISPLAY_NAMES entry, so
		// they fell into the MCP/user-tool branch below and every circuit step's
		// emit_event call prompted for approval in runs with no chat panel.
		expect(defaultAutoApproveFor("emit_event")).toBe(true);
		expect(defaultAutoApproveFor("submit_score")).toBe(true);
		expect(defaultAutoApproveFor("circuit_task_list")).toBe(true);
		expect(defaultAutoApproveFor("ask_user")).toBe(true);
		expect(defaultAutoApproveFor("circuit_task_ensure")).toBe(false);
		expect(defaultAutoApproveFor("invoke_workflow")).toBe(false);
		expect(defaultAutoApproveFor("import_docx")).toBe(false);
	});

	it("tools not in TOOL_DISPLAY_NAMES (MCP, user-extension) default to false", () => {
		expect(defaultAutoApproveFor("some_mcp__tool")).toBe(false);
		expect(defaultAutoApproveFor("totally_unknown_tool")).toBe(false);
	});
});
