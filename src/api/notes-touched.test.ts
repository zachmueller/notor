import { describe, it, expect } from "vitest";
import { classifyNotesTouched, toolCallsFromChatMessages, toolCallsFromMessages } from "./notes-touched";
import type { ToolPathParam } from "../tool-config/types";
import type { Message } from "../types";
import type { ChatMessage } from "../providers/provider";

const PARAMS: Record<string, ToolPathParam[]> = {
	read_note: [{ paramName: "path", namespace: "vault", resolveAs: "note", access: "read" }],
	write_note: [{ paramName: "path", namespace: "vault", resolveAs: "note", access: "write" }],
	move_note: [
		{ paramName: "source", namespace: "vault", access: "write" },
		{ paramName: "destination", namespace: "vault", access: "write" },
	],
	read_file: [{ paramName: "path", namespace: "filesystem", access: "read" }],
};
const existing = new Set(["A.md", "B.md", "C.md", "D.md"]);
const resolve = (p: string) => (existing.has(p) ? p : existing.has(`${p}.md`) ? `${p}.md` : null);

describe("classifyNotesTouched", () => {
	it("classifies vault path params by access and skips failures and filesystem paths", () => {
		const touched = classifyNotesTouched(
			[
				{ toolName: "read_note", parameters: { path: "A" }, success: true },
				{ toolName: "write_note", parameters: { path: "B.md" }, success: true },
				{ toolName: "write_note", parameters: { path: "C.md" }, success: false },
				{ toolName: "move_note", parameters: { source: "missing.md", destination: "D.md" }, success: true },
				{ toolName: "read_file", parameters: { path: "A.md" }, success: true },
				{ toolName: "unknown_tool", parameters: { path: "C.md" }, success: true },
			],
			(t) => PARAMS[t],
			resolve,
		);
		expect(touched).toEqual({ notesRead: ["A.md"], notesEdited: ["B.md", "D.md"] });
	});

	it("reports a note that was read and edited only as edited", () => {
		const touched = classifyNotesTouched(
			[
				{ toolName: "read_note", parameters: { path: "A.md" }, success: true },
				{ toolName: "write_note", parameters: { path: "A.md" }, success: true },
			],
			(t) => PARAMS[t],
			resolve,
		);
		expect(touched).toEqual({ notesRead: [], notesEdited: ["A.md"] });
	});
});

describe("tool call extraction", () => {
	it("pairs chat tool_call and tool_result messages by id, then by order", () => {
		const messages = [
			{ role: "tool_call", tool_call: { id: "t1", tool_name: "read_note", parameters: { path: "A.md" }, status: "success" } },
			{ role: "tool_call", tool_call: { tool_name: "write_note", parameters: { path: "B.md" }, status: "success" } },
			{ role: "tool_result", tool_result: { tool_name: "write_note", success: false, result: "" } },
			{ role: "tool_result", tool_result: { tool_name: "read_note", tool_call_id: "t1", success: true, result: "" } },
		] as unknown as Message[];
		const calls = toolCallsFromMessages(messages);
		expect(calls.map((c) => [c.toolName, c.success])).toEqual([["read_note", true], ["write_note", false]]);
	});

	it("reads provider-format step messages", () => {
		const messages: ChatMessage[] = [
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{ id: "a", tool_name: "read_note", parameters: { path: "A.md" } },
					{ id: "b", tool_name: "write_note", parameters: { path: "B.md" } },
					{ id: "c", tool_name: "write_note", parameters: { path: "C.md" } },
				],
			},
			{
				role: "tool_result",
				content: "",
				tool_results: [
					{ tool_call_id: "a", tool_name: "read_note", result: "", is_error: false },
					{ tool_call_id: "b", tool_name: "write_note", result: "", is_error: true },
				],
			},
		];
		expect(toolCallsFromChatMessages(messages).map((c) => c.success)).toEqual([true, false, false]);
	});
});
