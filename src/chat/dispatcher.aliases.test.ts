/**
 * Legacy tool-name aliases at dispatch (orchestrations → circuits rename).
 *
 * The LLM only sees canonical names (`run_circuit`, `circuit_task_*`), but old
 * step prompts may still call `run_flow` / `orchestration_task_*`. Those must
 * resolve to the canonical tool, obey the canonical tool's config, and echo the
 * name the model actually called.
 */

import { describe, it, expect, vi } from "vitest";
import { ToolDispatcher, type DispatchableTool } from "./dispatcher";
import type { ToolPolicyContext } from "./tool-policy";

function entry(over: { enabled?: boolean; auto_approve?: boolean } = {}) {
	return {
		enabled: over.enabled ?? true,
		auto_approve: over.auto_approve ?? true,
		allowed_paths: [],
		blocked_paths: [],
		allowed_command_patterns: [],
		blocked_command_patterns: [],
		auto_approve_paths: [],
		never_auto_approve_paths: [],
		path_scopes: {},
	};
}

function ctxWith(tools: Record<string, ReturnType<typeof entry>>): ToolPolicyContext {
	return { effectiveConfig: { tools }, mode: "act", vaultRootPath: "/vault" };
}

function runCircuitTool(): DispatchableTool {
	return {
		name: "run_circuit",
		mode: "write",
		// The real tool stamps its own canonical name on the result.
		execute: vi.fn(async () => ({ tool_name: "run_circuit", success: true, result: "child done" })),
	};
}

describe("ToolDispatcher — legacy tool-name aliases", () => {
	it("dispatches a legacy name to the canonical tool and echoes the requested name", async () => {
		const d = new ToolDispatcher();
		const tool = runCircuitTool();
		d.registerTool(tool);
		const onStarted = vi.fn();
		d.setEvents({ onToolCallStarted: onStarted });

		const result = await d.dispatch(
			"run_flow",
			{ flow: "Alpha", payload: "x" },
			"act",
			"m1",
			undefined,
			undefined,
			ctxWith({ run_circuit: entry() }),
		);

		expect(tool.execute).toHaveBeenCalledOnce();
		expect(result.success).toBe(true);
		expect(result.tool_name).toBe("run_flow");
		expect(onStarted.mock.calls[0]![0]).toMatchObject({ tool_name: "run_flow" });
	});

	it("applies the canonical tool's config to a legacy-named call (disabled blocks it)", async () => {
		const d = new ToolDispatcher();
		const tool = runCircuitTool();
		d.registerTool(tool);

		const result = await d.dispatch(
			"run_flow",
			{ payload: "x" },
			"act",
			"m1",
			undefined,
			undefined,
			ctxWith({ run_circuit: entry({ enabled: false }) }),
		);

		expect(tool.execute).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(result.tool_name).toBe("run_flow");
	});

	it("auto-approves a legacy-named call when the canonical tool is auto-approved", async () => {
		const d = new ToolDispatcher();
		d.registerTool(runCircuitTool());
		const approvalCb = vi.fn(async () => "rejected" as const);

		const result = await d.dispatch(
			"run_flow",
			{ payload: "x" },
			"act",
			"m1",
			undefined,
			undefined,
			ctxWith({ run_circuit: entry({ auto_approve: true }) }),
			approvalCb,
		);

		// Auto-approved: the callback is only invoked for the after-the-fact render.
		expect(result.success).toBe(true);
		expect(approvalCb).toHaveBeenCalledWith(expect.anything(), undefined, "m1", true);
	});

	it("introspection treats legacy names as their canonical tool", () => {
		const d = new ToolDispatcher();
		d.registerTool(runCircuitTool());
		expect(d.hasTool("run_flow")).toBe(true);
		expect(d.isWriteTool("run_flow")).toBe(true);
		expect(d.hasTool("orchestration_task_close")).toBe(false);
		expect(d.getRegisteredToolNames()).toEqual(["run_circuit"]);
	});

	it("still reports an unknown name as not found, with the requested name", async () => {
		const d = new ToolDispatcher();
		const result = await d.dispatch("no_such_tool", {}, "act", "m1", undefined, undefined, ctxWith({}));
		expect(result.success).toBe(false);
		expect(result.tool_name).toBe("no_such_tool");
	});
});
