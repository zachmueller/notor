#!/usr/bin/env npx tsx
/**
 * Plan Document Flow E2E Test (deterministic UI half)
 *
 * Drives a pending `submit_plan` call without a live model: a conversation is
 * imported ending on an unpaired submit_plan tool_call, and
 * `orchestrator.resumePendingToolCalls()` re-dispatches it through the real
 * dispatcher → plan-review interaction path. After each decision the
 * follow-up model turn is stopped. `plan-flow-llm-test.ts` covers the live
 * model round-trip.
 *
 * Scenarios:
 *   1. submit_plan opens the plan leaf with the rendered plan, writes the
 *      plan sidecar, and shows the review card in chat
 *   2. Selecting text in the plan shows the floating Comment button; a saved
 *      comment is highlighted and persisted on the plan file
 *   3. "Send comments" resolves the review: the tool result carries the
 *      quoted comments, the leaf shows "Changes requested", buttons disable
 *   4. The plan chat card renders and "Open plan" re-opens the leaf
 *   5. Typing a reply in chat while a review is pending is routed to the
 *      review as feedback (not blocked)
 *   6. "Approve & auto-accept edits" on the card switches to Act mode, shows
 *      the auto-accept badge, and the badge clears when the run ends
 *   7. "Open plan for current conversation" command opens the leaf
 *   8. No unexpected errors logged
 *
 * @see src/tools/submit-plan.ts, src/ui/plan-view.ts, src/ui/plan-review-interaction.ts
 * @see ai/notor/ideas — "Plan document flow with inline commenting and hand-back"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, VAULT_PATH } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants & helpers
// ---------------------------------------------------------------------------

const HISTORY_DIR = path.join(VAULT_PATH, ".obsidian/plugins/notor/history");
const PLAN_TITLE = "Reorganize project notes";
const PLAN_MD = [
	"## Context",
	"",
	"The project folder mixes meeting notes and specs.",
	"",
	"## Steps",
	"",
	"1. Create a `Meetings` subfolder.",
	"2. Move every meeting note into the new subfolder.",
	"3. Update links in the project index.",
].join("\n");

function readPlanFile(convId: string): Record<string, unknown> | null {
	const p = path.join(HISTORY_DIR, `${convId}.plan.json`);
	if (!fs.existsSync(p)) return null;
	return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

/** Import a Plan-mode conversation ending on a pending submit_plan call, switch to it and resume. */
async function startPendingPlan(ctx: TestContext, label: string): Promise<string | null> {
	const result = await ctx.page.evaluate(
		async ({ label, title, plan }) => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			if (!plugin) return { error: "Plugin not found" };
			const orchestrator = plugin.getActiveOrchestrator();
			const hm = plugin.getHistoryManager();
			const now = new Date().toISOString();
			const conv = {
				id: crypto.randomUUID(), title: `Plan flow ${label}`, created_at: now, updated_at: now,
				provider_id: "bedrock", model_id: "test-model", mode: "plan",
				total_input_tokens: 0, total_output_tokens: 0, estimated_cost: 0, is_background: false,
			};
			const filename = await hm.importConversation(conv, [
				{ id: crypto.randomUUID(), conversation_id: conv.id, role: "user", content: "Tidy up my project notes.", timestamp: now },
				{
					id: crypto.randomUUID(), conversation_id: conv.id, role: "tool_call", content: "", timestamp: now,
					tool_call: { id: `tooluse_${label}`, tool_name: "submit_plan", parameters: { title, plan }, status: "pending" },
				},
			]);
			await orchestrator.switchConversation(filename);
			void orchestrator.resumePendingToolCalls();
			return { convId: conv.id };
		},
		{ label, title: PLAN_TITLE, plan: PLAN_MD },
	);
	if (!result || "error" in result) {
		ctx.fail(`Start pending plan (${label})`, (result as any)?.error ?? "unknown");
		return null;
	}
	await ctx.page.waitForTimeout(1_500);
	return result.convId as string;
}

/** Stop any in-flight run (the follow-up model turn) and wait for sessions to end. */
async function stopRun(ctx: TestContext): Promise<void> {
	await ctx.page.evaluate(async () => {
		const orchestrator = (window as any).app.plugins.plugins["notor"].getActiveOrchestrator();
		for (let i = 0; i < 50; i++) {
			const sessions = orchestrator.getActiveSessions();
			if (sessions.length === 0) return;
			for (const s of sessions) s.abortController.abort();
			await new Promise((r) => setTimeout(r, 200));
		}
	});
	await ctx.page.waitForTimeout(500);
}

async function focusChatLeaf(ctx: TestContext): Promise<void> {
	await ctx.page.evaluate(async () => {
		await (window as any).app.plugins.plugins["notor"].openChatPanel();
	});
	await ctx.page.waitForTimeout(300);
}

async function lastToolResult(ctx: TestContext): Promise<string | null> {
	return ctx.page.evaluate(() => {
		const msgs = (window as any).app.plugins.plugins["notor"].getActiveOrchestrator().getConversationManager().getMessages();
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (m.role === "tool_result" && m.tool_result?.tool_name === "submit_plan") {
				const r = m.tool_result.result;
				return typeof r === "string" ? r : JSON.stringify(r);
			}
		}
		return null;
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testLeafOpens(ctx: TestContext, convId: string): Promise<void> {
	console.log("\nTest 1: submit_plan opens the plan leaf and the review card");
	const state = await ctx.page.evaluate(() => {
		const leaf = document.querySelector('.workspace-leaf-content[data-type="notor-plan-view"]');
		return {
			leaf: !!leaf,
			title: leaf?.querySelector(".notor-plan-title")?.textContent ?? "",
			status: leaf?.querySelector(".notor-plan-status")?.textContent ?? "",
			body: leaf?.querySelector(".notor-plan-body")?.textContent ?? "",
			card: !!document.querySelector(".notor-plan-review-prompt"),
		};
	});
	const shot = await ctx.screenshot("01-plan-leaf");
	if (state.leaf && state.title === PLAN_TITLE && state.body.includes("Move every meeting note")) {
		ctx.pass("Plan leaf renders the plan", `status="${state.status}"`, shot);
	} else {
		ctx.fail("Plan leaf renders the plan", JSON.stringify(state).slice(0, 300), shot);
	}
	if (state.status === "Awaiting review") ctx.pass("Plan status is 'Awaiting review'", state.status);
	else ctx.fail("Plan status is 'Awaiting review'", state.status);

	const file = readPlanFile(convId);
	if (file && file.markdown === PLAN_MD && file.status === "pending-review") {
		ctx.pass("Plan sidecar written", `${convId}.plan.json`);
	} else {
		ctx.fail("Plan sidecar written", JSON.stringify(file)?.slice(0, 200) ?? "missing");
	}

	if (state.card) ctx.pass("Review card shown on the tool call", "found .notor-plan-review-prompt");
	else ctx.fail("Review card shown on the tool call", "no .notor-plan-review-prompt in chat");
}

async function testCommentInLeaf(ctx: TestContext, convId: string): Promise<void> {
	console.log("\nTest 2: Select text in the plan → Comment → highlight + persisted");
	const selected = await ctx.page.evaluate((needle) => {
		const body = document.querySelector('.workspace-leaf-content[data-type="notor-plan-view"] .notor-plan-body') as HTMLElement | null;
		if (!body) return false;
		const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode() as Text | null;
		while (node && !node.data.includes(needle)) node = walker.nextNode() as Text | null;
		if (!node) return false;
		const idx = node.data.indexOf(needle);
		const range = document.createRange();
		range.setStart(node, idx);
		range.setEnd(node, idx + needle.length);
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		sel.addRange(range);
		body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		return true;
	}, "every meeting note");
	if (!selected) {
		ctx.fail("Select plan text", "Could not find 'every meeting note' in the plan body");
		return;
	}
	await ctx.page.waitForTimeout(400);
	const hasBtn = await ctx.page.evaluate(() => !!document.querySelector(".notor-comment-float-btn"));
	if (!hasBtn) {
		const shot = await ctx.screenshot("02-no-float-btn");
		ctx.fail("Floating Comment button appears on selection", "no .notor-comment-float-btn", shot);
		return;
	}
	ctx.pass("Floating Comment button appears on selection", "found .notor-comment-float-btn");

	await ctx.page.evaluate(() => (document.querySelector(".notor-comment-float-btn") as HTMLButtonElement).click());
	await ctx.page.waitForTimeout(300);
	await ctx.page.evaluate(() => {
		const ta = document.querySelector<HTMLTextAreaElement>(".notor-comment-popover-input")!;
		ta.value = "Including the ones from 2023?";
		ta.dispatchEvent(new Event("input", { bubbles: true }));
		document.querySelector<HTMLButtonElement>(".notor-comment-popover-save")!.click();
	});
	await ctx.page.waitForTimeout(800);

	const ui = await ctx.page.evaluate(() => {
		const leaf = document.querySelector('.workspace-leaf-content[data-type="notor-plan-view"]')!;
		return {
			marks: Array.from(leaf.querySelectorAll("mark.notor-comment-highlight")).map((m) => m.textContent),
			listed: leaf.querySelectorAll(".notor-plan-comment").length,
			send: leaf.querySelector(".notor-plan-send")?.textContent ?? "",
		};
	});
	const shot = await ctx.screenshot("02-plan-comment");
	if (ui.marks.join("") === "every meeting note" && ui.listed === 1 && ui.send === "Send comments (1)") {
		ctx.pass("Plan comment highlighted and listed", JSON.stringify(ui), shot);
	} else {
		ctx.fail("Plan comment highlighted and listed", JSON.stringify(ui), shot);
	}

	const file = readPlanFile(convId);
	const comments = (file?.comments ?? []) as Array<{ body: string }>;
	if (comments.length === 1 && comments[0]!.body === "Including the ones from 2023?") {
		ctx.pass("Plan comment persisted on the plan file", comments[0]!.body);
	} else {
		ctx.fail("Plan comment persisted on the plan file", JSON.stringify(file?.comments));
	}
}

async function testSendComments(ctx: TestContext, convId: string): Promise<void> {
	console.log("\nTest 3: Send comments hands the feedback back to the model");
	await ctx.page.evaluate(() => {
		(document.querySelector('.workspace-leaf-content[data-type="notor-plan-view"] .notor-plan-send') as HTMLButtonElement).click();
	});
	await ctx.page.waitForTimeout(1_000);
	const leafState = await ctx.page.evaluate(() => {
		const leaf = document.querySelector('.workspace-leaf-content[data-type="notor-plan-view"]')!;
		return {
			status: leaf.querySelector(".notor-plan-status")?.textContent ?? "",
			approveDisabled: (leaf.querySelector(".notor-plan-approve") as HTMLButtonElement | null)?.disabled ?? null,
			footerHidden: getComputedStyle(leaf.querySelector(".notor-plan-footer")!).display === "none",
			marks: leaf.querySelectorAll("mark.notor-comment-highlight").length,
		};
	});
	await stopRun(ctx);
	await focusChatLeaf(ctx);

	const result = await lastToolResult(ctx);
	if (result && result.includes("requested changes") && result.includes('> "every meeting note"\nIncluding the ones from 2023?')) {
		ctx.pass("Tool result carries the quoted comments", result.replace(/\n/g, "⏎").slice(0, 200));
	} else {
		ctx.fail("Tool result carries the quoted comments", String(result).slice(0, 400));
	}
	if (leafState.status === "Changes requested" && leafState.approveDisabled === true && leafState.footerHidden && leafState.marks === 0) {
		ctx.pass("Leaf shows 'Changes requested' and becomes read-only", JSON.stringify(leafState));
	} else {
		ctx.fail("Leaf shows 'Changes requested' and becomes read-only", JSON.stringify(leafState));
	}
	const file = readPlanFile(convId);
	if (file?.status === "changes-requested" && Array.isArray(file.comments) && file.comments.length === 0) {
		ctx.pass("Plan file status updated and comments cleared", String(file.status));
	} else {
		ctx.fail("Plan file status updated and comments cleared", JSON.stringify(file).slice(0, 200));
	}
}

async function testPlanCard(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Plan card in chat re-opens the leaf");
	await ctx.page.waitForTimeout(500);
	const card = await ctx.page.evaluate(() => {
		const el = document.querySelector(".notor-plan-block");
		return el ? { title: el.querySelector(".notor-plan-block-title")?.textContent, status: el.querySelector(".notor-plan-block-status")?.textContent } : null;
	});
	if (!card) {
		const shot = await ctx.screenshot("04-no-plan-card");
		ctx.fail("Plan card rendered in chat", "no .notor-plan-block", shot);
		return;
	}
	ctx.pass("Plan card rendered in chat", JSON.stringify(card));
	// Close plan leaves, then reopen via the card.
	await ctx.page.evaluate(() => {
		(window as any).app.workspace.detachLeavesOfType("notor-plan-view");
	});
	await ctx.page.waitForTimeout(300);
	await ctx.page.evaluate(() => (document.querySelector(".notor-plan-block-open") as HTMLButtonElement).click());
	await ctx.page.waitForTimeout(1_000);
	const reopened = await ctx.page.evaluate(() => !!document.querySelector('.workspace-leaf-content[data-type="notor-plan-view"] .notor-plan-body'));
	const shot = await ctx.screenshot("04-reopened");
	if (reopened) ctx.pass("Open plan re-opens the leaf", "plan leaf present", shot);
	else ctx.fail("Open plan re-opens the leaf", "no plan leaf after click", shot);
}

async function testTypedReply(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Typed reply while a review is pending becomes feedback");
	const convId = await startPendingPlan(ctx, "typed");
	if (!convId) return;
	await focusChatLeaf(ctx);
	const before = await ctx.page.evaluate(() => ({
		placeholder: document.querySelector(".notor-text-input")?.getAttribute("data-placeholder"),
		sendVisible: !document.querySelector(".notor-send-btn")?.classList.contains("notor-hidden"),
	}));
	if (before.placeholder?.startsWith("Reply to request changes") && before.sendVisible) {
		ctx.pass("Input invites plan feedback while pending", JSON.stringify(before));
	} else {
		ctx.fail("Input invites plan feedback while pending", JSON.stringify(before));
	}
	await ctx.page.evaluate(() => {
		const el = document.querySelector(".notor-text-input") as HTMLElement;
		el.focus();
		el.textContent = "Please keep the 2022 notes where they are.";
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await ctx.page.focus(".notor-text-input");
	await ctx.page.keyboard.press("Enter");
	await ctx.page.waitForTimeout(800);
	await stopRun(ctx);
	const result = await lastToolResult(ctx);
	if (result && result.includes("Please keep the 2022 notes where they are.")) {
		ctx.pass("Typed reply resolved the review", result.replace(/\n/g, "⏎").slice(0, 160));
	} else {
		ctx.fail("Typed reply resolved the review", String(result).slice(0, 300));
	}
}

async function testApproveAutoAccept(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: Approve & auto-accept switches to Act and shows the badge");
	const convId = await startPendingPlan(ctx, "approve");
	if (!convId) return;
	await focusChatLeaf(ctx);
	const clicked = await ctx.page.evaluate(() => {
		const btn = document.querySelector(".notor-plan-review-approve-auto") as HTMLButtonElement | null;
		btn?.click();
		return !!btn;
	});
	if (!clicked) {
		ctx.fail("Approve & auto-accept button on the card", "button not found");
		return;
	}
	await ctx.page.waitForTimeout(400);
	const during = await ctx.page.evaluate(() => {
		const orchestrator = (window as any).app.plugins.plugins["notor"].getActiveOrchestrator();
		const session = orchestrator.getActiveSessions()[0];
		return {
			toggle: document.querySelector(".notor-mode-toggle")?.textContent,
			badge: !document.querySelector(".notor-auto-accept-badge")?.classList.contains("notor-hidden"),
			sessionFlag: session?.autoAcceptWrites ?? null,
			mode: orchestrator.getConversationManager().getMode(),
		};
	});
	const shot = await ctx.screenshot("06-auto-accept");
	if (during.toggle === "Act" && during.mode === "act") {
		ctx.pass("Approval switches the conversation to Act mode", JSON.stringify(during), shot);
	} else {
		ctx.fail("Approval switches the conversation to Act mode", JSON.stringify(during), shot);
	}
	if (during.badge && during.sessionFlag === true) {
		ctx.pass("Auto-accept badge and session flag set", JSON.stringify(during));
	} else {
		ctx.fail("Auto-accept badge and session flag set", JSON.stringify(during));
	}
	await stopRun(ctx);
	const after = await ctx.page.evaluate(() => !document.querySelector(".notor-auto-accept-badge")?.classList.contains("notor-hidden"));
	if (!after) ctx.pass("Auto-accept badge clears when the run ends", "badge hidden");
	else ctx.fail("Auto-accept badge clears when the run ends", "badge still visible");
	const result = await lastToolResult(ctx);
	if (result?.includes("approved the plan")) ctx.pass("Tool result reports approval", result.slice(0, 120));
	else ctx.fail("Tool result reports approval", String(result));
}

async function testOpenPlanCommand(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: Open plan command");
	await ctx.page.evaluate(() => (window as any).app.workspace.detachLeavesOfType("notor-plan-view"));
	await focusChatLeaf(ctx);
	await ctx.page.evaluate(() => (window as any).app.commands.executeCommandById("notor:open-plan"));
	await ctx.page.waitForTimeout(1_000);
	const status = await ctx.page.evaluate(
		() => document.querySelector('.workspace-leaf-content[data-type="notor-plan-view"] .notor-plan-status')?.textContent ?? null,
	);
	if (status === "Approved") ctx.pass("Command opens the plan leaf (read-only after approval)", status);
	else ctx.fail("Command opens the plan leaf (read-only after approval)", String(status));
}

async function testNoErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: No unexpected errors logged");
	// The follow-up model turns are deliberately aborted; ignore abort/provider noise.
	const errors = ctx.collector.getLogsByLevel("error").filter((e) => {
		const text = JSON.stringify(e);
		return !/abort|cancel|credential|provider|bedrock|model/i.test(text);
	});
	if (errors.length === 0) ctx.pass("No unexpected errors", "0 unexpected error-level logs");
	else ctx.fail("No unexpected errors", errors.map((e) => JSON.stringify(e)).join("\n").slice(0, 1_000));
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(5_000);
	const convId = await startPendingPlan(ctx, "comments");
	if (!convId) return;
	await testLeafOpens(ctx, convId);
	await testCommentInLeaf(ctx, convId);
	await testSendComments(ctx, convId);
	await testPlanCard(ctx);
	await testTypedReply(ctx);
	await testApproveAutoAccept(ctx);
	await testOpenPlanCommand(ctx);
	await testNoErrors(ctx);
}

runTest({ name: "plan-flow-test", settings: buildDefaultSettings() }, tests);
