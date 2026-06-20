#!/usr/bin/env npx tsx
/**
 * Streaming Tool-Call Cards E2E Test
 *
 * Validates the in-progress streaming tool-call placeholder lifecycle in
 * MessageRenderer, driven through the ChatView pass-throughs
 * (renderStreamingToolCall / finalizeStreamingToolCall / clearStreamingToolCalls).
 *
 * The model renders a placeholder card the moment it begins emitting a tool
 * call (name + "streaming" badge, no parameters panel), then mutates that SAME
 * card in place when the full tool call arrives — appending the parameters panel
 * and flipping the badge to the real status. These tests drive that path
 * deterministically (no live model) via the view's public methods.
 *
 * Scenarios:
 *   1. renderStreamingToolCall shows the tool name + a "streaming" badge and NO
 *      parameters panel
 *   2. renderStreamingToolCall is idempotent — a duplicate start for the same id
 *      returns the SAME element (no second card)
 *   3. finalizeStreamingToolCall reuses the SAME element, appends the parameters
 *      panel, and flips the badge streaming → pending (class + text)
 *   4. finalizeStreamingToolCall on an unknown id returns null (caller falls back)
 *   5. clearStreamingToolCalls removes leftover streaming cards but leaves
 *      finalized cards intact
 *   6. No render errors logged
 *
 * @see src/ui/message-renderer.ts — renderStreamingToolCall / finalizeStreamingToolCall / clearStreamingToolCalls
 * @see src/ui/chat-view.ts — pass-through methods
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector, writeCleanWorkspace } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Test 1: streaming placeholder renders (name + badge, no params) + idempotency
// ---------------------------------------------------------------------------

async function testStreamingRender(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: streaming placeholder renders with badge + no params; render is idempotent");
	const { page } = ctx;

	// Render + idempotency check in ONE evaluate (element identity can't cross
	// evaluate boundaries, and the streaming map is private). Tag the returned
	// element with a marker class so later evaluates can re-query it by DOM.
	const setup = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { ok: false, error: "Plugin not found" };
		const view = plugin.getActiveOrchestrator?.()?.getView?.();
		if (!view) return { ok: false, error: "View not found" };

		const el1 = view.renderStreamingToolCall("e2e-tc-1", "read_note");
		if (el1) el1.classList.add("notor-e2e-stream-1");
		const el2 = view.renderStreamingToolCall("e2e-tc-1", "read_note"); // dup id
		return {
			ok: true,
			rendered: !!el1,
			sameElement: el1 === el2,
			cardCount: document.querySelectorAll(".notor-e2e-stream-1").length,
		};
	});

	if (!setup.ok) {
		ctx.fail("Streaming card renders", setup.error ?? "unknown");
		return;
	}

	const card = await waitForSelector(page, ".notor-e2e-stream-1", 4_000);
	if (!card) {
		const shot = await ctx.screenshot("01-no-streaming-card");
		ctx.fail("Streaming card renders", "No .notor-e2e-stream-1 card rendered", shot);
		return;
	}

	if (setup.rendered) {
		ctx.pass("Streaming card renders", "renderStreamingToolCall returned an element");
	} else {
		ctx.fail("Streaming card renders", "renderStreamingToolCall returned null");
	}

	if (setup.sameElement && setup.cardCount === 1) {
		ctx.pass("Render is idempotent", "Duplicate start for the same id returned the same element (1 card)");
	} else {
		ctx.fail("Render is idempotent", `sameElement=${setup.sameElement}, cardCount=${setup.cardCount}`);
	}

	const dom = await page.evaluate(() => {
		const c = document.querySelector(".notor-e2e-stream-1");
		const status = c?.querySelector(".notor-tool-call-status");
		return {
			name: c?.querySelector(".notor-tool-call-name")?.textContent ?? null,
			badgeText: status?.textContent ?? null,
			badgeStreaming: !!c?.querySelector(".notor-tool-call-status.notor-tool-status-streaming"),
			hasParams: !!c?.querySelector(".notor-tool-call-params"),
		};
	});

	if (dom.name === "read_note") {
		ctx.pass("Streaming card shows tool name", `name="${dom.name}"`);
	} else {
		ctx.fail("Streaming card shows tool name", `Expected "read_note", got "${dom.name}"`);
	}

	if (dom.badgeStreaming && dom.badgeText === "streaming") {
		ctx.pass("Streaming badge present", 'Badge has notor-tool-status-streaming and text "streaming"');
	} else {
		ctx.fail("Streaming badge present", `badgeStreaming=${dom.badgeStreaming}, badgeText="${dom.badgeText}"`);
	}

	const shot = await ctx.screenshot("01-streaming-card");
	if (!dom.hasParams) {
		ctx.pass("No parameters panel while streaming", "Parameters panel absent on the placeholder", shot);
	} else {
		ctx.fail("No parameters panel while streaming", "Parameters panel present before finalize", shot);
	}
}

// ---------------------------------------------------------------------------
// Test 2: finalize reuses the same element in place + unknown id returns null
// ---------------------------------------------------------------------------

async function testFinalize(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: finalize mutates the placeholder in place; unknown id returns null");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const view = plugin?.getActiveOrchestrator?.()?.getView?.();
		if (!view) return { ok: false, error: "View not found" };

		const before = document.querySelector(".notor-e2e-stream-1");
		const finalized = view.finalizeStreamingToolCall("e2e-tc-1", {
			id: "msg-stream-1",
			tool_call: {
				tool_name: "read_note",
				parameters: { path: "Notes/Streaming.md" },
				status: "pending",
			},
		});
		const unknown = view.finalizeStreamingToolCall("e2e-tc-does-not-exist", {
			id: "msg-unknown",
			tool_call: { tool_name: "x", parameters: {}, status: "pending" },
		});
		return {
			ok: true,
			finalizedOk: !!finalized,
			stillSameElement: finalized === before, // in-place, no new card
			unknownIsNull: unknown === null,
		};
	});

	if (!result.ok) {
		ctx.fail("Finalize streaming card", result.error ?? "unknown");
		return;
	}

	if (result.finalizedOk && result.stillSameElement) {
		ctx.pass("Finalize reuses the same element", "Returned the existing placeholder node (no flicker, no second card)");
	} else {
		ctx.fail("Finalize reuses the same element", `finalizedOk=${result.finalizedOk}, stillSameElement=${result.stillSameElement}`);
	}

	if (result.unknownIsNull) {
		ctx.pass("Finalize unknown id returns null", "Caller can fall back to renderToolCall");
	} else {
		ctx.fail("Finalize unknown id returns null", "Expected null for an unknown tool-call id");
	}

	const dom = await page.evaluate(() => {
		const c = document.querySelector(".notor-e2e-stream-1");
		const status = c?.querySelector(".notor-tool-call-status");
		return {
			cardCount: document.querySelectorAll(".notor-e2e-stream-1").length,
			hasParams: !!c?.querySelector(".notor-tool-call-params"),
			paramsText: c?.querySelector(".notor-tool-call-params pre code")?.textContent ?? null,
			badgeText: status?.textContent ?? null,
			badgePending: !!c?.querySelector(".notor-tool-call-status.notor-tool-status-pending"),
			badgeStillStreaming: !!c?.querySelector(".notor-tool-call-status.notor-tool-status-streaming"),
		};
	});

	if (dom.cardCount === 1) {
		ctx.pass("No duplicate card after finalize", "Exactly one card with the marker class");
	} else {
		ctx.fail("No duplicate card after finalize", `Expected 1 card, found ${dom.cardCount}`);
	}

	const shot = await ctx.screenshot("02-finalized-card");
	if (dom.hasParams && dom.paramsText?.includes("Notes/Streaming.md")) {
		ctx.pass("Parameters panel appended on finalize", "Params panel present and contains the path", shot);
	} else {
		ctx.fail("Parameters panel appended on finalize", `hasParams=${dom.hasParams}, paramsText=${JSON.stringify(dom.paramsText)}`, shot);
	}

	if (dom.badgePending && !dom.badgeStillStreaming && dom.badgeText === "pending") {
		ctx.pass("Badge flips streaming → pending", 'Badge now notor-tool-status-pending with text "pending"');
	} else {
		ctx.fail("Badge flips streaming → pending", `badgePending=${dom.badgePending}, stillStreaming=${dom.badgeStillStreaming}, text="${dom.badgeText}"`);
	}
}

// ---------------------------------------------------------------------------
// Test 3: clearStreamingToolCalls removes un-finalized cards, keeps finalized
// ---------------------------------------------------------------------------

async function testClear(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: clearStreamingToolCalls removes streaming cards, keeps finalized ones");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const view = plugin?.getActiveOrchestrator?.()?.getView?.();
		if (!view) return { ok: false, error: "View not found" };

		// Two fresh placeholders.
		const elA = view.renderStreamingToolCall("e2e-tc-A", "search_vault");
		if (elA) elA.classList.add("notor-e2e-stream-A");
		const elB = view.renderStreamingToolCall("e2e-tc-B", "list_vault");
		if (elB) elB.classList.add("notor-e2e-stream-B");

		// Finalize only A — it migrates out of the streaming map and must survive clear.
		view.finalizeStreamingToolCall("e2e-tc-A", {
			id: "msg-stream-A",
			tool_call: { tool_name: "search_vault", parameters: { query: "x" }, status: "pending" },
		});

		const beforeStreamingCount = document.querySelectorAll(".notor-tool-status-streaming").length;

		view.clearStreamingToolCalls();

		return {
			ok: true,
			beforeStreamingCount,
			finalizedASurvives: !!document.querySelector(".notor-e2e-stream-A"),
			unfinalizedBGone: !document.querySelector(".notor-e2e-stream-B"),
			streamingCountAfter: document.querySelectorAll(".notor-tool-status-streaming").length,
		};
	});

	if (!result.ok) {
		ctx.fail("Clear streaming cards", result.error ?? "unknown");
		return;
	}

	const shot = await ctx.screenshot("03-after-clear");

	if (result.beforeStreamingCount >= 1) {
		ctx.pass("Streaming card present before clear", `${result.beforeStreamingCount} streaming badge(s) before clear`);
	} else {
		ctx.fail("Streaming card present before clear", "Expected at least one un-finalized streaming card (tc-B)");
	}

	if (result.finalizedASurvives) {
		ctx.pass("Finalized card survives clear", "tc-A (finalized) remains in the DOM", shot);
	} else {
		ctx.fail("Finalized card survives clear", "Finalized card was removed by clearStreamingToolCalls", shot);
	}

	if (result.unfinalizedBGone && result.streamingCountAfter === 0) {
		ctx.pass("Un-finalized cards removed on clear", "tc-B removed; zero streaming badges remain", shot);
	} else {
		ctx.fail("Un-finalized cards removed on clear", `unfinalizedBGone=${result.unfinalizedBGone}, streamingCountAfter=${result.streamingCountAfter}`, shot);
	}
}

// ---------------------------------------------------------------------------
// Test 4: no render errors logged
// ---------------------------------------------------------------------------

async function testNoErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: no render errors logged for streaming tool cards");
	const errors = ctx.collector.getLogsByLevel("error");
	const relevant = errors.filter(
		(e) =>
			e.source === "ChatView" ||
			e.source === "MessageRenderer" ||
			e.message?.toLowerCase().includes("streaming") ||
			e.message?.toLowerCase().includes("tool call"),
	);
	if (relevant.length === 0) {
		ctx.pass("No streaming render errors", "Zero relevant error-level logs");
	} else {
		ctx.fail("No streaming render errors", `${relevant.length}: ${relevant.map((e) => e.message).join("; ")}`);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // plugin init

	// tsx/esbuild injects __name() into serialized evaluate bodies; it's undefined
	// in the Obsidian context. Polyfill as a no-op so inline arrows work.
	await page.evaluate(() => {
		if (typeof (window as any).__name === "undefined") {
			(window as any).__name = (fn: unknown, _name: string) => fn;
		}
	});

	await testStreamingRender(ctx);
	await testFinalize(ctx);
	await testClear(ctx);
	await testNoErrors(ctx);

	// Clean up the throwaway cards so the final screenshot is clean.
	await page.evaluate(() => {
		for (const sel of [".notor-e2e-stream-1", ".notor-e2e-stream-A", ".notor-e2e-stream-B"]) {
			document.querySelectorAll(sel).forEach((el) => el.remove());
		}
	});
}

runTest(
	{
		name: "streaming-tool-cards-test",
		settings: buildDefaultSettings(),
		// Obsidian 1.12 defers non-active views, so the chat panel only mounts
		// (.notor-chat-container) when its leaf is the active one. Pin a clean
		// workspace with the notor-chat-view leaf active so the panel renders
		// regardless of leftover workspace state from prior runs.
		setupVault: (vaultPath) => writeCleanWorkspace(vaultPath),
	},
	tests,
);
