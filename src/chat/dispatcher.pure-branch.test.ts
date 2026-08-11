/**
 * F2 Phase C — pure-branch dispatcher behavior locks.
 *
 * These guard the two behavior-preservation seams the reconciliation touches on
 * the pure (policyCtx-provided) path:
 *  - C.1: an auto-approved INTERNAL tool must NOT fire the collapsed-diff render
 *    (update_tasks stays invisible) — matching the legacy `tool.internal` bypass.
 *  - C.2: approval resolution falls back to the instance callback
 *    (`setApprovalCallback`) when no per-call callback is passed — the sub-agent
 *    seam — so it keeps working once the pure branch is the only branch (Phase D).
 */

import { describe, it, expect, vi } from "vitest";
import { ToolDispatcher, type DispatchableTool, type ApprovalCallback } from "./dispatcher";
import type { ToolPolicyContext } from "./tool-policy";

function makeCtx(over: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
	return {
		effectiveConfig: { tools: {} },
		mode: "act",
		vaultRootPath: "/vault",
		...over,
	};
}

function registerTool(d: ToolDispatcher, tool: DispatchableTool): void {
	d.registerTool(tool);
}

describe("ToolDispatcher pure branch — C.1 internal-tool render suppression", () => {
	it("does not invoke the approval callback for an auto-approved internal tool", async () => {
		const d = new ToolDispatcher();
		const internalTool: DispatchableTool = {
			name: "update_tasks",
			mode: "write",
			internal: true,
			execute: vi.fn(async () => ({ tool_name: "update_tasks", success: true, result: "ok" })),
		};
		registerTool(d, internalTool);

		const approvalCb: ApprovalCallback = vi.fn(async () => "approved" as const);
		await d.dispatch("update_tasks", {}, "act", "m1", undefined, undefined, makeCtx(), approvalCb);

		// Internal tool is auto-approved (evaluateToolPolicy returns autoApproved)
		// but the render must be suppressed — no after-the-fact card.
		expect(approvalCb).not.toHaveBeenCalled();
		expect(internalTool.execute).toHaveBeenCalledOnce();
	});

	it("DOES fire the render for an auto-approved NON-internal tool", async () => {
		const d = new ToolDispatcher();
		const tool: DispatchableTool = {
			name: "search_vault",
			mode: "read",
			execute: vi.fn(async () => ({ tool_name: "search_vault", success: true, result: "ok" })),
		};
		registerTool(d, tool);

		const approvalCb: ApprovalCallback = vi.fn(async () => "approved" as const);
		// auto_approve:true so the tool is auto-approved and the render path is hit.
		const ctx = makeCtx({
			effectiveConfig: {
				tools: {
					search_vault: {
						enabled: true,
						auto_approve: true,
						allowed_paths: [],
						blocked_paths: [],
						allowed_command_patterns: [],
						blocked_command_patterns: [],
						auto_approve_paths: [],
						never_auto_approve_paths: [],
						path_scopes: {},
					},
				},
			},
		});
		await d.dispatch("search_vault", {}, "act", "m1", undefined, undefined, ctx, approvalCb);

		expect(approvalCb).toHaveBeenCalledWith(expect.anything(), undefined, "m1", true);
	});
});

describe("ToolDispatcher — a call missing a required param never reaches approval", () => {
	/** replace_in_note as registered for real: path + changes are required. */
	function makeReplaceInNote(): DispatchableTool {
		return {
			name: "replace_in_note",
			mode: "write",
			input_schema: {
				type: "object",
				properties: { path: { type: "string" }, changes: { type: "array" } },
				required: ["path", "changes"],
			},
			execute: vi.fn(async () => ({ tool_name: "replace_in_note", success: true, result: "ok" })),
		} as unknown as DispatchableTool;
	}

	function writeCtx(entry: Record<string, unknown> = {}): ToolPolicyContext {
		return makeCtx({
			effectiveConfig: {
				tools: {
					replace_in_note: {
						enabled: true,
						auto_approve: false,
						allowed_paths: [],
						blocked_paths: [],
						allowed_command_patterns: [],
						blocked_command_patterns: [],
						auto_approve_paths: [],
						never_auto_approve_paths: [],
						path_scopes: {},
						...entry,
					} as any,
				},
			},
		});
	}

	it("does not prompt, does not execute, and returns a corrective error", async () => {
		// The reported bug: the model omitted `path`, so the path rules could not
		// classify the call and the run loop blocked on a human prompt for a call
		// that was always going to fail inside the tool.
		const d = new ToolDispatcher();
		const tool = makeReplaceInNote();
		registerTool(d, tool);

		const approvalCb: ApprovalCallback = vi.fn(async () => "approved" as const);
		const result = await d.dispatch(
			"replace_in_note",
			{ changes: [{ old_text: "a", new_text: "b" }] },
			"act",
			"m1",
			undefined,
			undefined,
			writeCtx({ auto_approve_paths: ["ai/"] }),
			approvalCb,
		);

		expect(approvalCb).not.toHaveBeenCalled();
		expect(tool.execute).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/missing required parameter: path/);
	});

	it("emits the failed call to the transcript as an error, not a silent drop", async () => {
		const d = new ToolDispatcher();
		registerTool(d, makeReplaceInNote());

		const onToolCallStarted = vi.fn();
		const onToolCallStatusChanged = vi.fn();
		const onToolCallResult = vi.fn();
		d.setEvents({ onToolCallStarted, onToolCallStatusChanged, onToolCallResult });

		await d.dispatch("replace_in_note", {}, "act", "m1", undefined, undefined, writeCtx());

		expect(onToolCallStarted).toHaveBeenCalledOnce();
		expect(onToolCallStatusChanged).toHaveBeenCalledWith(
			expect.objectContaining({ status: "error" }),
			"m1",
		);
		expect(onToolCallResult).toHaveBeenCalledOnce();
	});

	it("a complete call still reaches approval and executes", async () => {
		const d = new ToolDispatcher();
		const tool = makeReplaceInNote();
		registerTool(d, tool);

		const approvalCb: ApprovalCallback = vi.fn(async () => "approved" as const);
		const result = await d.dispatch(
			"replace_in_note",
			{ path: "notes/x.md", changes: [{ old_text: "a", new_text: "b" }] },
			"act",
			"m1",
			undefined,
			undefined,
			writeCtx(),
			approvalCb,
		);

		expect(approvalCb).toHaveBeenCalledOnce();
		expect(tool.execute).toHaveBeenCalledOnce();
		expect(result.success).toBe(true);
	});
});

describe("ToolDispatcher pure branch — C.2 instance-callback approval fallback", () => {
	it("uses the instance callback (setApprovalCallback) when no per-call callback is supplied", async () => {
		const d = new ToolDispatcher();
		const tool: DispatchableTool = {
			name: "write_note",
			mode: "write",
			execute: vi.fn(async () => ({ tool_name: "write_note", success: true, result: "ok" })),
		};
		registerTool(d, tool);

		const instanceCb: ApprovalCallback = vi.fn(async () => "approved" as const);
		d.setApprovalCallback(instanceCb);

		// Non-auto-approved tool, NO per-call callback → must fall back to instance.
		const ctx = makeCtx({
			effectiveConfig: {
				tools: {
					write_note: {
						enabled: true,
						auto_approve: false,
						allowed_paths: [],
						blocked_paths: [],
						allowed_command_patterns: [],
						blocked_command_patterns: [],
						auto_approve_paths: [],
						never_auto_approve_paths: [],
						path_scopes: {},
					},
				},
			},
		});
		const result = await d.dispatch("write_note", {}, "act", "m1", undefined, undefined, ctx);

		expect(instanceCb).toHaveBeenCalledOnce();
		expect(result.success).toBe(true);
	});

	it("rejection via the instance callback blocks execution", async () => {
		const d = new ToolDispatcher();
		const tool: DispatchableTool = {
			name: "write_note",
			mode: "write",
			execute: vi.fn(async () => ({ tool_name: "write_note", success: true, result: "ok" })),
		};
		registerTool(d, tool);

		d.setApprovalCallback(async () => "rejected" as const);

		const ctx = makeCtx({
			effectiveConfig: {
				tools: {
					write_note: {
						enabled: true,
						auto_approve: false,
						allowed_paths: [],
						blocked_paths: [],
						allowed_command_patterns: [],
						blocked_command_patterns: [],
						auto_approve_paths: [],
						never_auto_approve_paths: [],
						path_scopes: {},
					},
				},
			},
		});
		const result = await d.dispatch("write_note", {}, "act", "m1", undefined, undefined, ctx);

		expect(result.success).toBe(false);
		expect(tool.execute).not.toHaveBeenCalled();
	});
});
