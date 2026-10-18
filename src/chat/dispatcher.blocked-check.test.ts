/**
 * Early stream stop — `makeToolCallBlockedCheck` and the dispatch it relies on.
 *
 * A stream cut off at a blocked tool call's start queues the call with `{}`
 * parameters; dispatch must then report the real block reason (not the missing
 * required parameters), so the model gets the same error as a post-hoc block.
 */

import { describe, it, expect, vi } from "vitest";
import { ToolDispatcher, type DispatchableTool } from "./dispatcher";
import type { ToolPolicyContext } from "./tool-policy";

function makeCtx(over: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
	return {
		effectiveConfig: { tools: {} },
		mode: "act",
		vaultRootPath: "/vault",
		...over,
	};
}

function makeDispatcher(): ToolDispatcher {
	const d = new ToolDispatcher();
	const tools: DispatchableTool[] = [
		{
			name: "write_note",
			mode: "write",
			input_schema: { type: "object", required: ["path", "content"] },
			execute: vi.fn(async () => ({ tool_name: "write_note", success: true, result: "ok" })),
		} as unknown as DispatchableTool,
		{
			name: "read_note",
			mode: "read",
			execute: vi.fn(async () => ({ tool_name: "read_note", success: true, result: "ok" })),
		} as unknown as DispatchableTool,
		{
			name: "run_circuit",
			mode: "write",
			execute: vi.fn(async () => ({ tool_name: "run_circuit", success: true, result: "ok" })),
		} as unknown as DispatchableTool,
	];
	for (const t of tools) d.registerTool(t);
	return d;
}

describe("ToolDispatcher.makeToolCallBlockedCheck", () => {
	it("blocks write tools in Plan mode and allows reads", () => {
		const check = makeDispatcher().makeToolCallBlockedCheck(() => makeCtx({ mode: "plan" }));
		expect(check("write_note")).toBe(true);
		expect(check("read_note")).toBe(false);
	});

	it("blocks a disabled tool in Act mode", () => {
		const ctx = makeCtx({
			effectiveConfig: { tools: { read_note: { enabled: false } as never } },
		});
		expect(makeDispatcher().makeToolCallBlockedCheck(() => ctx)("read_note")).toBe(true);
	});

	it("resolves legacy aliases to the canonical tool", () => {
		const check = makeDispatcher().makeToolCallBlockedCheck(() => makeCtx({ mode: "plan" }));
		expect(check("run_flow")).toBe(true);
	});

	it("lets unknown tools through so dispatch reports 'Tool not found'", () => {
		const check = makeDispatcher().makeToolCallBlockedCheck(() => makeCtx({ mode: "plan" }));
		expect(check("no_such_tool")).toBe(false);
	});

	it("reads the policy context on every call (live mode)", () => {
		let mode: "plan" | "act" = "plan";
		const check = makeDispatcher().makeToolCallBlockedCheck(() => makeCtx({ mode }));
		expect(check("write_note")).toBe(true);
		mode = "act";
		expect(check("write_note")).toBe(false);
	});
});

describe("dispatch of a call cut off at its start ({} parameters)", () => {
	it("reports the Plan-mode block, not the missing parameters", async () => {
		const result = await makeDispatcher().dispatch(
			"write_note", {}, "plan", "m1", undefined, undefined, makeCtx({ mode: "plan" }),
		);
		expect(result.success).toBe(false);
		expect(result.error).toBe(
			"write_note is not available in Plan mode. Switch to Act mode to create or modify notes.",
		);
	});
});
