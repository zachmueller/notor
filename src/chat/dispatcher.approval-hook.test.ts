/**
 * Approval race seams used by panel-free runs: the instance-level
 * `on_approval_required` hook fallback, and the settle signal that lets a
 * losing approval prompt (e.g. a modal) close itself.
 */

import { describe, it, expect, vi } from "vitest";
import { ToolDispatcher, type ApprovalCallback, type DispatchableTool } from "./dispatcher";
import type { ToolPolicyContext } from "./tool-policy";

const ctx: ToolPolicyContext = { effectiveConfig: { tools: {} }, mode: "act", vaultRootPath: "/vault" };

function makeDispatcher(): { d: ToolDispatcher; tool: DispatchableTool } {
	const d = new ToolDispatcher();
	const tool: DispatchableTool = {
		name: "write_note",
		mode: "write",
		execute: vi.fn(async () => ({ tool_name: "write_note", success: true, result: "ok" })),
	};
	d.registerTool(tool);
	return { d, tool };
}

describe("ToolDispatcher approval race", () => {
	it("falls back to the instance hook when no per-call hook is passed", async () => {
		const { d, tool } = makeDispatcher();
		const pending: ApprovalCallback = () => new Promise(() => {});
		d.setApprovalCallback(pending);
		d.setApprovalHookDispatcher(async () => "rejected");

		const result = await d.dispatch("write_note", {}, "act", "m1", undefined, undefined, ctx);

		expect(result.success).toBe(false);
		expect(result.error).toContain("rejected");
		expect(tool.execute).not.toHaveBeenCalled();
	});

	it("aborts the callback's signal once another racer wins", async () => {
		const { d, tool } = makeDispatcher();
		let seen: AbortSignal | undefined;
		d.setApprovalCallback((_call, signal) => {
			seen = signal;
			return new Promise(() => {});
		});
		d.setApprovalHookDispatcher(async () => "approved");

		await d.dispatch("write_note", {}, "act", "m1", undefined, undefined, ctx);

		expect(tool.execute).toHaveBeenCalledOnce();
		expect(seen?.aborted).toBe(true);
	});

	it("forwards a caller abort to the callback's signal", async () => {
		const { d } = makeDispatcher();
		const caller = new AbortController();
		let seen: AbortSignal | undefined;
		d.setApprovalCallback((_call, signal) => {
			seen = signal;
			return new Promise((resolve) => signal?.addEventListener("abort", () => resolve("rejected")));
		});

		const pending = d.dispatch("write_note", {}, "act", "m1", caller.signal, undefined, ctx);
		caller.abort();
		const result = await pending;

		expect(seen?.aborted).toBe(true);
		expect(result.success).toBe(false);
	});
});
