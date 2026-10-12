#!/usr/bin/env npx tsx
/**
 * Inline Comments E2E Test
 *
 * Validates the chat-panel host of the inline comment layer, deterministically
 * (no live model — the send callback is stubbed to capture the batch).
 *
 * Scenarios:
 *   1. Right-click a selection in an assistant message → "Comment on selection"
 *      → inline textarea → Save → passage highlighted
 *   2. A second comment (on another response) → send bar shows "2 comments"
 *   3. Comments persist in the JSONL header (pending_comments)
 *   4. Switch away and back → highlights restored, send bar still shows 2
 *   5. "Send comments" sends the quoted-text batch (plus typed note) through
 *      the normal send path, then clears highlights, bar and header field
 *   6. "Comment on selection" is not offered for user messages
 *   7. No errors logged
 *
 * @see src/comments/comment-layer.ts, src/ui/chat-view.ts
 * @see ai/notor/ideas — "Inline comment annotations on AI responses with batch follow-up"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, VAULT_PATH } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface Fixture {
	convId: string;
	filename: string;
	filename2: string;
}

const HISTORY_DIR = path.join(VAULT_PATH, ".obsidian/plugins/notor/history");

function readHeader(convId: string): Record<string, unknown> | null {
	if (!fs.existsSync(HISTORY_DIR)) return null;
	const file = fs.readdirSync(HISTORY_DIR).find((f) => f.endsWith(`_${convId}.jsonl`));
	if (!file) return null;
	const first = fs.readFileSync(path.join(HISTORY_DIR, file), "utf8").split("\n")[0] ?? "{}";
	return JSON.parse(first) as Record<string, unknown>;
}

/** Select `text` inside the Nth assistant message (0-based) and right-click it. */
async function rightClickSelection(ctx: TestContext, messageIndex: number, text: string, role = "assistant"): Promise<boolean> {
	return ctx.page.evaluate(
		({ messageIndex, text, role }) => {
			const msgs = document.querySelectorAll(`.notor-message-${role}[data-message-id] .notor-message-content`);
			const content = msgs[messageIndex] as HTMLElement | undefined;
			if (!content) return false;
			const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode() as Text | null;
			while (node && !node.data.includes(text)) node = walker.nextNode() as Text | null;
			if (!node) return false;
			const idx = node.data.indexOf(text);
			const range = document.createRange();
			range.setStart(node, idx);
			range.setEnd(node, idx + text.length);
			const sel = window.getSelection()!;
			sel.removeAllRanges();
			sel.addRange(range);
			const rect = range.getBoundingClientRect();
			node.parentElement!.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 2, clientY: rect.top + 2 }),
			);
			return true;
		},
		{ messageIndex, text, role },
	);
}

async function menuTitles(ctx: TestContext): Promise<string[]> {
	return ctx.page.evaluate(() =>
		Array.from(document.querySelectorAll(".menu .menu-item-title")).map((e) => e.textContent ?? ""),
	);
}

async function clickMenuItem(ctx: TestContext, title: string): Promise<boolean> {
	return ctx.page.evaluate((title) => {
		const item = Array.from(document.querySelectorAll(".menu .menu-item")).find(
			(e) => e.querySelector(".menu-item-title")?.textContent === title,
		) as HTMLElement | undefined;
		if (!item) return false;
		item.click();
		return true;
	}, title);
}

async function closeMenu(ctx: TestContext): Promise<void> {
	await ctx.page.keyboard.press("Escape");
	await ctx.page.waitForTimeout(200);
}

async function savePopover(ctx: TestContext, body: string): Promise<boolean> {
	return ctx.page.evaluate((body) => {
		const ta = document.querySelector<HTMLTextAreaElement>(".notor-comment-popover-input");
		const save = document.querySelector<HTMLButtonElement>(".notor-comment-popover-save");
		if (!ta || !save) return false;
		ta.value = body;
		ta.dispatchEvent(new Event("input", { bubbles: true }));
		save.click();
		return true;
	}, body);
}

async function uiState(ctx: TestContext): Promise<{ marks: string[]; barHidden: boolean; barLabel: string }> {
	return ctx.page.evaluate(() => {
		const bar = document.querySelector(".notor-comment-send-bar");
		return {
			marks: Array.from(document.querySelectorAll("mark.notor-comment-highlight")).map((m) => m.textContent ?? ""),
			barHidden: !bar || bar.classList.contains("notor-hidden"),
			barLabel: bar?.querySelector(".notor-comment-send-bar-label")?.textContent ?? "",
		};
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function setup(ctx: TestContext): Promise<Fixture | null> {
	console.log("\nSetup: import a conversation with two assistant responses");
	const result = await ctx.page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		// macOS defaults to native menus, which never reach the DOM — use DOM
		// menus so the test can read and click context-menu items.
		(window as any).app.vault.setConfig("nativeMenus", false);
		const orchestrator = plugin.getActiveOrchestrator();
		const hm = plugin.getHistoryManager();
		const now = new Date().toISOString();
		const base = {
			created_at: now, updated_at: now, provider_id: "bedrock", model_id: "test-model", mode: "act",
			total_input_tokens: 0, total_output_tokens: 0, estimated_cost: 0, is_background: false,
		};
		const conv = { ...base, id: crypto.randomUUID(), title: "Inline Comments Test" };
		const rows: Array<[string, string]> = [
			["user", "Describe the fox."],
			["assistant", "The quick brown fox jumps over the lazy dog.\n\nIt does this **every single day** before breakfast."],
			["user", "And the dog?"],
			["assistant", "The dog sleeps through it all, dreaming of bones."],
		];
		const filename = await hm.importConversation(
			conv,
			rows.map(([role, content]) => ({ id: crypto.randomUUID(), conversation_id: conv.id, role, content, timestamp: now })),
		);
		const conv2 = { ...base, id: crypto.randomUUID(), title: "Temp" };
		const filename2 = await hm.importConversation(conv2, [
			{ id: crypto.randomUUID(), conversation_id: conv2.id, role: "user", content: "temp", timestamp: now },
		]);
		await orchestrator.switchConversation(filename);
		return { convId: conv.id, filename, filename2 };
	});
	if (!result || "error" in result) {
		ctx.fail("Setup fixture conversation", (result as any)?.error ?? "unknown");
		return null;
	}
	await ctx.page.waitForTimeout(1_500);
	ctx.pass("Setup fixture conversation", `Imported ${result.filename}`);
	return result as Fixture;
}

async function testCommentViaContextMenu(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Comment on selection via the context menu");
	if (!(await rightClickSelection(ctx, 0, "quick brown fox"))) {
		ctx.fail("Select assistant text", "Could not find 'quick brown fox' in the first response");
		return;
	}
	await ctx.page.waitForTimeout(300);
	const titles = await menuTitles(ctx);
	if (!titles.includes("Comment on selection")) {
		const shot = await ctx.screenshot("01-no-menu-item");
		ctx.fail("Context menu offers 'Comment on selection'", `Items: ${JSON.stringify(titles)}`, shot);
		await closeMenu(ctx);
		return;
	}
	ctx.pass("Context menu offers 'Comment on selection'", JSON.stringify(titles));

	await clickMenuItem(ctx, "Comment on selection");
	await ctx.page.waitForTimeout(300);
	const popoverShown = await ctx.page.evaluate(() => !!document.querySelector(".notor-comment-popover"));
	if (!popoverShown) {
		ctx.fail("Inline textarea opens", "No .notor-comment-popover");
		return;
	}
	const shotPopover = await ctx.screenshot("01-popover");
	ctx.pass("Inline textarea opens", "Popover rendered", shotPopover);

	await savePopover(ctx, "Is it really quick?");
	await ctx.page.waitForTimeout(500);
	const state = await uiState(ctx);
	if (state.marks.join("") === "quick brown fox") {
		ctx.pass("Commented passage is highlighted", JSON.stringify(state.marks));
	} else {
		ctx.fail("Commented passage is highlighted", `marks=${JSON.stringify(state.marks)}`);
	}
}

async function testSecondComment(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Second comment on another response shows the send bar");
	await rightClickSelection(ctx, 1, "dreaming of bones");
	await ctx.page.waitForTimeout(300);
	await clickMenuItem(ctx, "Comment on selection");
	await ctx.page.waitForTimeout(300);
	await savePopover(ctx, "What kind of bones?");
	await ctx.page.waitForTimeout(500);
	const state = await uiState(ctx);
	const shot = await ctx.screenshot("02-send-bar");
	if (!state.barHidden && state.barLabel === "2 comments" && state.marks.length === 2) {
		ctx.pass("Send bar shows two comments", state.barLabel, shot);
	} else {
		ctx.fail("Send bar shows two comments", JSON.stringify(state), shot);
	}
}

async function testPersistedHeader(ctx: TestContext, fx: Fixture): Promise<void> {
	console.log("\nTest 3: Comments persist on the JSONL header");
	await ctx.page.waitForTimeout(1_000);
	const header = readHeader(fx.convId);
	const comments = (header?.pending_comments ?? []) as Array<{ body: string; anchor: { exact: string } }>;
	if (comments.length === 2 && comments.some((c) => c.anchor.exact === "quick brown fox")) {
		ctx.pass("pending_comments persisted", comments.map((c) => c.body).join(" | "));
	} else {
		ctx.fail("pending_comments persisted", `header.pending_comments=${JSON.stringify(header?.pending_comments)}`);
	}
}

async function testSurvivesSwitch(ctx: TestContext, fx: Fixture): Promise<void> {
	console.log("\nTest 4: Highlights restored after switching away and back");
	await ctx.page.evaluate(async (fx) => {
		const orchestrator = (window as any).app.plugins.plugins["notor"].getActiveOrchestrator();
		await orchestrator.switchConversation(fx.filename2);
		await new Promise((r) => setTimeout(r, 500));
		await orchestrator.switchConversation(fx.filename);
	}, fx);
	await ctx.page.waitForTimeout(2_000);
	const state = await uiState(ctx);
	const shot = await ctx.screenshot("04-after-switch");
	if (state.marks.length === 2 && state.barLabel === "2 comments" && !state.barHidden) {
		ctx.pass("Comments survive conversation switch", JSON.stringify(state.marks), shot);
	} else {
		ctx.fail("Comments survive conversation switch", JSON.stringify(state), shot);
	}
}

async function testUserMessageHasNoItem(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: No comment item on user messages");
	await rightClickSelection(ctx, 0, "Describe", "user");
	await ctx.page.waitForTimeout(300);
	const titles = await menuTitles(ctx);
	await closeMenu(ctx);
	if (titles.length > 0 && !titles.includes("Comment on selection")) {
		ctx.pass("User messages are not commentable", JSON.stringify(titles));
	} else {
		ctx.fail("User messages are not commentable", JSON.stringify(titles));
	}
}

async function testSendBatch(ctx: TestContext, fx: Fixture): Promise<void> {
	console.log("\nTest 5: Send comments compiles the batch and clears state");
	await ctx.page.evaluate(() => {
		const view = (window as any).app.plugins.plugins["notor"].getActiveOrchestrator().getView();
		(window as any).__sentContent = null;
		view.setOnSendMessage(async (content: string) => {
			(window as any).__sentContent = content;
		});
		const input = document.querySelector(".notor-text-input") as HTMLElement;
		input.textContent = "Overall this reads well.";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		(document.querySelector(".notor-comment-send-bar-send") as HTMLButtonElement).click();
	});
	await ctx.page.waitForTimeout(1_000);
	const sent = await ctx.page.evaluate(() => (window as any).__sentContent as string | null);
	if (!sent) {
		ctx.fail("Batch sent through the send path", "onSendMessage was not called");
		return;
	}
	const expectedParts = [
		"Comments on your previous responses:",
		'> "quick brown fox"\nIs it really quick?',
		'> "dreaming of bones"\nWhat kind of bones?',
		"Overall this reads well.",
	];
	const missing = expectedParts.filter((p) => !sent.includes(p));
	const ordered = sent.indexOf("quick brown fox") < sent.indexOf("dreaming of bones") && sent.trimEnd().endsWith("Overall this reads well.");
	if (missing.length === 0 && ordered) {
		ctx.pass("Batch uses the quoted-text format", sent.replace(/\n/g, "⏎").slice(0, 200));
	} else {
		ctx.fail("Batch uses the quoted-text format", `missing=${JSON.stringify(missing)} ordered=${ordered}\n${sent}`);
	}

	const state = await uiState(ctx);
	if (state.marks.length === 0 && state.barHidden) {
		ctx.pass("Highlights and send bar cleared", JSON.stringify(state));
	} else {
		ctx.fail("Highlights and send bar cleared", JSON.stringify(state));
	}

	await ctx.page.waitForTimeout(1_000);
	const header = readHeader(fx.convId);
	if (!header?.pending_comments) {
		ctx.pass("Header pending_comments cleared", String(header?.pending_comments));
	} else {
		ctx.fail("Header pending_comments cleared", JSON.stringify(header.pending_comments));
	}
}

async function testNoErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: No errors logged");
	const errors = ctx.collector.getLogsByLevel("error");
	if (errors.length === 0) {
		ctx.pass("No errors logged", "0 error-level logs");
	} else {
		ctx.fail("No errors logged", errors.map((e) => JSON.stringify(e)).join("\n").slice(0, 1_000));
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(5_000);
	const fx = await setup(ctx);
	if (!fx) return;
	await testCommentViaContextMenu(ctx);
	await testSecondComment(ctx);
	await testPersistedHeader(ctx, fx);
	await testSurvivesSwitch(ctx, fx);
	await testUserMessageHasNoItem(ctx);
	await testSendBatch(ctx, fx);
	await testNoErrors(ctx);
}

runTest({ name: "inline-comments-test", settings: buildDefaultSettings() }, tests);
