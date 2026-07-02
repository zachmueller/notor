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
					},
				},
			},
		});
		await d.dispatch("search_vault", {}, "act", "m1", undefined, undefined, ctx, approvalCb);

		expect(approvalCb).toHaveBeenCalledWith(expect.anything(), undefined, "m1", true);
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
					},
				},
			},
		});
		const result = await d.dispatch("write_note", {}, "act", "m1", undefined, undefined, ctx);

		expect(result.success).toBe(false);
		expect(tool.execute).not.toHaveBeenCalled();
	});
});
