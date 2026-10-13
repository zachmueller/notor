#!/usr/bin/env npx tsx
/**
 * Draft Switch-Back E2E Test (deterministic, no model)
 *
 * Leaving a conversation with unsent text saves it as a draft and shows a
 * "Draft saved" notice; right-clicking the notice switches back. That
 * switch-back goes straight through the orchestrator (not the panel's UI
 * handlers), so it must still update the view's conversation id (persisted
 * for workspace restore), header title and favorite star.
 *
 * Scenarios:
 *   1. Chat panel ready; two conversations imported (A is a favorite)
 *   2. Switching A → B with a draft shows the notice and the header shows B
 *   3. Right-clicking the notice switches back: the orchestrator, view id,
 *      header title and favorite star all show A, and the draft is restored
 *
 * Run with:
 *   npx tsx e2e/scripts/draft-switch-back-test.ts
 *
 * @see src/chat/conversation-lifecycle.ts — maybeSaveDraft
 * @see src/tool-config/notices.ts — showDraftSavedNotice
 */

import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector } from "../lib/test-helpers";

const TITLE_A = "Draft switch-back A";
const TITLE_B = "Draft switch-back B";
const DRAFT = "unsent draft for A";

/** The panel's state as the orchestrator, the view and the header see it. */
async function panelState(page: Page): Promise<{
	orchestratorConv: string | null;
	viewConv: string | null;
	headerTitle: string | null;
	favoriteShown: boolean;
	input: string;
}> {
	return page.evaluate(() => {
		const app = (window as any).app;
		const orchestrator = app.plugins.plugins["notor"].getActiveOrchestrator();
		const view = app.workspace.getLeavesOfType("notor-chat-view")[0]?.view;
		const title = document.querySelector(".notor-header-conversation-title");
		const star = document.querySelector(".notor-header-favorite-icon");
		return {
			orchestratorConv: orchestrator?.getConversationManager().getActiveConversation()?.id ?? null,
			viewConv: view?.getActiveConversationId?.() ?? null,
			headerTitle: title && !title.classList.contains("notor-hidden") ? title.textContent : null,
			favoriteShown: !!star && !star.classList.contains("notor-hidden"),
			input: document.querySelector(".notor-text-input")?.textContent ?? "",
		};
	});
}

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	console.log("\nTest 1: Chat panel ready and conversations imported");
	if (!(await waitForSelector(page, ".notor-chat-container", 15_000))) {
		ctx.fail("Chat panel ready", ".notor-chat-container not found");
		return;
	}
	const imported = await page.evaluate(async ({ titleA, titleB }) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		const hm = plugin.getHistoryManager();
		const now = new Date().toISOString();
		const base = {
			created_at: now, updated_at: now, provider_id: "bedrock", model_id: "test-model", mode: "act",
			total_input_tokens: 0, total_output_tokens: 0, estimated_cost: 0, is_background: false,
		};
		const convA = { ...base, id: crypto.randomUUID(), title: titleA, is_favorite: true };
		const convB = { ...base, id: crypto.randomUUID(), title: titleB };
		const fileA = await hm.importConversation(convA, [
			{ id: crypto.randomUUID(), conversation_id: convA.id, role: "user", content: "Hello A", timestamp: now },
			{ id: crypto.randomUUID(), conversation_id: convA.id, role: "assistant", content: "Hi from A", timestamp: now },
		]);
		const fileB = await hm.importConversation(convB, [
			{ id: crypto.randomUUID(), conversation_id: convB.id, role: "user", content: "Hello B", timestamp: now },
			{ id: crypto.randomUUID(), conversation_id: convB.id, role: "assistant", content: "Hi from B", timestamp: now },
		]);
		await plugin.getActiveOrchestrator().switchConversation(fileA);
		return { idA: convA.id, idB: convB.id, fileB };
	}, { titleA: TITLE_A, titleB: TITLE_B });
	if (!imported || "error" in imported) {
		ctx.fail("Conversations imported", (imported as any)?.error ?? "unknown");
		return;
	}
	await page.waitForTimeout(1_000);
	ctx.pass("Chat panel ready", "two conversations imported, A opened");

	console.log("\nTest 2: Leaving A with a draft shows the notice");
	await page.evaluate((text) => {
		const el = document.querySelector(".notor-text-input") as HTMLElement;
		el.textContent = text;
		el.dispatchEvent(new Event("input", { bubbles: true }));
	}, DRAFT);
	await page.evaluate(async (fileB) => {
		await (window as any).app.plugins.plugins["notor"].getActiveOrchestrator().switchConversation(fileB);
	}, imported.fileB);
	await page.waitForTimeout(1_000);
	const onB = await panelState(page);
	const notice = page.locator(".notice", { hasText: `Draft saved in "${TITLE_A}"` });
	const noticeShown = (await notice.count()) > 0;
	const shotB = await ctx.screenshot("02-on-b");
	if (noticeShown && onB.viewConv === imported.idB && onB.headerTitle === TITLE_B && !onB.favoriteShown) {
		ctx.pass("Switch to B shows the draft notice and B's header", JSON.stringify(onB), shotB);
	} else {
		ctx.fail("Switch to B shows the draft notice and B's header", JSON.stringify({ noticeShown, ...onB }), shotB);
		return;
	}

	console.log("\nTest 3: Right-clicking the notice switches back to A");
	await notice.first().click({ button: "right" });
	await page.waitForTimeout(1_500);
	const back = await panelState(page);
	const shotA = await ctx.screenshot("03-back-on-a");
	if (back.orchestratorConv === imported.idA) ctx.pass("Orchestrator switched back to A", back.orchestratorConv, shotA);
	else ctx.fail("Orchestrator switched back to A", String(back.orchestratorConv), shotA);
	if (back.viewConv === imported.idA) ctx.pass("View conversation id follows the switch-back", back.viewConv);
	else ctx.fail("View conversation id follows the switch-back", `view=${back.viewConv}, expected=${imported.idA}`);
	if (back.headerTitle === TITLE_A && back.favoriteShown) ctx.pass("Header shows A's title and favorite star", `"${back.headerTitle}"`);
	else ctx.fail("Header shows A's title and favorite star", JSON.stringify(back));
	if (back.input.trim() === DRAFT) ctx.pass("Draft restored into the input", `"${back.input.trim()}"`);
	else ctx.fail("Draft restored into the input", `"${back.input}"`);
}

runTest({ name: "draft-switch-back-test", settings: buildDefaultSettings() }, tests);
