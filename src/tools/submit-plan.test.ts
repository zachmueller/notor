import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

import { SubmitPlanTool, SUBMIT_PLAN_TOOL_NAME } from "./submit-plan";
import { PlanStore } from "../plans/plan-store";
import type { ToolExecuteOptions, ToolSessionContext } from "./tool";
import type { InteractionRequest, InteractionResponse } from "../ui/interaction-ui";
import type { PlanReviewOutcome } from "../plans/plan-review-controller";

function makeStore(): PlanStore {
	const files = new Map<string, string>();
	return new PlanStore(
		{
			exists: async (p: string) => files.has(p),
			read: async (p: string) => files.get(p) ?? "",
			write: async (p: string, d: string) => {
				files.set(p, d);
			},
			remove: async (p: string) => {
				files.delete(p);
			},
			mkdir: async () => {},
		},
		() => "history/",
	);
}

function makeSession(): ToolSessionContext & { mode?: string; autoAccept?: boolean } {
	const ctx: ToolSessionContext & { mode?: string; autoAccept?: boolean } = {
		getEffectiveToolConfig: () => null,
		getActiveConversation: () => null,
		getSessionConversationId: () => "conv1",
		setConversationMode: (m) => {
			ctx.mode = m;
		},
		setAutoAcceptWrites: (on) => {
			ctx.autoAccept = on;
		},
	};
	return ctx;
}

function setup(outcome: PlanReviewOutcome | Error, settings = { auto_skip_user_input_prompts: false, extension_execution_timeout_seconds: 0 }) {
	const store = makeStore();
	const opened: string[] = [];
	const tool = new SubmitPlanTool({ planStore: store, openPlanView: (id) => void opened.push(id), getSettings: () => settings });
	const requests: InteractionRequest[] = [];
	const interactionCallback = vi.fn(async (req: InteractionRequest): Promise<InteractionResponse> => {
		requests.push(req);
		if (outcome instanceof Error) throw outcome;
		return { id: req.id, values: [], outcome };
	});
	const session = makeSession();
	const options: ToolExecuteOptions = { sessionContext: session, interactionCallback };
	return { store, opened, tool, requests, session, options };
}

const PARAMS = { title: "Tidy notes", plan: "1. Move notes\n2. Fix links" };

describe("SubmitPlanTool", () => {
	it("is a read-mode, non-internal tool named submit_plan", () => {
		const { tool } = setup({ kind: "approve" });
		expect(tool.name).toBe(SUBMIT_PLAN_TOOL_NAME);
		expect(tool.mode).toBe("read");
		expect((tool as { internal?: boolean }).internal).toBeUndefined();
	});

	it("validates parameters", async () => {
		const { tool, options } = setup({ kind: "approve" });
		expect((await tool.execute({ title: "", plan: "x" }, options)).success).toBe(false);
		expect((await tool.execute({ title: "t", plan: "  " }, options)).success).toBe(false);
	});

	it("errors cleanly without an interaction channel (headless / sub-agent)", async () => {
		const { tool, session } = setup({ kind: "approve" });
		const r = await tool.execute(PARAMS, { sessionContext: session });
		expect(r.success).toBe(false);
		expect(r.error).toMatch(/requires an interactive chat panel/);
	});

	it("stores the plan, opens the leaf and suspends on a plan-review request", async () => {
		const { tool, options, store, opened, requests } = setup({ kind: "approve" });
		await tool.execute(PARAMS, options);
		expect(opened).toEqual(["conv1"]);
		expect(requests[0]).toMatchObject({ type: "plan-review", conversationId: "conv1", title: "Tidy notes" });
		expect((await store.load("conv1"))?.markdown).toBe(PARAMS.plan);
	});

	it("approve switches to Act mode", async () => {
		const { tool, options, session, store } = setup({ kind: "approve" });
		const r = await tool.execute(PARAMS, options);
		expect(r.success).toBe(true);
		expect(r.result).toMatch(/approved the plan/);
		expect(session.mode).toBe("act");
		expect(session.autoAccept).toBeUndefined();
		expect((await store.load("conv1"))?.status).toBe("approved");
		expect(r.content_blocks?.[0]).toMatchObject({ type: "custom_block", kind: "plan", data: { conversationId: "conv1", status: "approved" } });
	});

	it("approve-auto-accept also enables auto-accepted writes", async () => {
		const { tool, options, session } = setup({ kind: "approve-auto-accept" });
		const r = await tool.execute(PARAMS, options);
		expect(r.result).toMatch(/auto-approved/);
		expect(session.mode).toBe("act");
		expect(session.autoAccept).toBe(true);
	});

	it("request-changes returns the feedback and keeps Plan mode", async () => {
		const feedback = 'Comments on the plan:\n\n> "Move notes"\nWhich folder?';
		const { tool, options, session, store } = setup({ kind: "request-changes", feedback });
		const r = await tool.execute(PARAMS, options);
		expect(r.success).toBe(true);
		expect(r.result).toContain("call submit_plan again");
		expect(r.result).toContain(feedback);
		expect(session.mode).toBeUndefined();
		expect((await store.load("conv1"))?.status).toBe("changes-requested");
	});

	it("reject stays in Plan mode and includes the reason", async () => {
		const { tool, options, session } = setup({ kind: "reject", reason: "too risky" });
		const r = await tool.execute(PARAMS, options);
		expect(r.result).toMatch(/rejected the plan: too risky/);
		expect(session.mode).toBeUndefined();
	});

	it("a cancelled interaction returns an error result", async () => {
		const { tool, options } = setup(new Error("Interaction cancelled by user."));
		const r = await tool.execute(PARAMS, options);
		expect(r).toMatchObject({ success: false, error: "Plan review cancelled." });
	});

	it("times out only when auto_skip_user_input_prompts is on", async () => {
		vi.useFakeTimers();
		try {
			const store = makeStore();
			const tool = new SubmitPlanTool({
				planStore: store,
				openPlanView: () => {},
				getSettings: () => ({ auto_skip_user_input_prompts: true, extension_execution_timeout_seconds: 5 }),
			});
			const interactionCallback = vi.fn(
				(_req: InteractionRequest, signal?: AbortSignal) =>
					new Promise<InteractionResponse>((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("Interaction cancelled by user.")));
					}),
			);
			const p = tool.execute(PARAMS, { sessionContext: makeSession(), interactionCallback });
			await vi.advanceTimersByTimeAsync(5_000);
			const r = await p;
			expect(r.success).toBe(false);
			expect(r.error).toMatch(/timed out/);
		} finally {
			vi.useRealTimers();
		}
	});
});
