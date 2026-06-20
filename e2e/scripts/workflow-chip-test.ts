#!/usr/bin/env npx tsx
/**
 * Active-Workflow Chip E2E Test
 *
 * Validates the active-workflow chip in the chat toolbar (ChatView):
 * `updateWorkflowLabel(conv)` shows the workflow name when a conversation was
 * created/switched into a workflow and the user has not deactivated it; the
 * chip is hidden for non-workflow conversations and after deactivation. Clicking
 * the chip opens a context menu whose "Deactivate workflow" item invokes the
 * deactivate callback.
 *
 * Driven deterministically (no live model, no real workflow execution) via the
 * view's public `updateWorkflowLabel` / `setOnDeactivateWorkflow` surface and
 * minimal conversation-header literals (the method reads only workflow_path /
 * workflow_name / workflow_deactivated).
 *
 * Scenarios:
 *   1. A conversation with workflow_path + workflow_name (not deactivated) shows
 *      `.notor-workflow-label` (not hidden) with text === workflow_name
 *   2. workflow_deactivated === true → label hidden (`.notor-hidden`)
 *   3. Absent workflow_path (and conv === null) → label hidden
 *   4. Clicking the chip → context menu "Deactivate workflow" invokes the
 *      deactivate callback
 *   5. No render errors logged
 *
 * @see src/ui/chat-view.ts — updateWorkflowLabel / showWorkflowContextMenu / setOnDeactivateWorkflow
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector, writeCleanWorkspace } from "../lib/test-helpers";

const WF_PATH = "notor/workflows/daily/review.md";
const WF_NAME = "daily/review";

// ---------------------------------------------------------------------------
// Test 1-3: chip visibility from the conversation header
// ---------------------------------------------------------------------------

async function testChipVisibility(ctx: TestContext): Promise<void> {
	console.log("\nTest 1-3: workflow chip visibility from the conversation header");
	const { page } = ctx;

	// Scenario 1 — active workflow, not deactivated.
	const active = await page.evaluate((args) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const view = plugin?.getActiveOrchestrator?.()?.getView?.();
		if (!view) return { ok: false, error: "View not found" };
		view.updateWorkflowLabel({
			workflow_path: args.path,
			workflow_name: args.name,
			workflow_deactivated: false,
		});
		const label = document.querySelector(".notor-workflow-label");
		return {
			ok: true,
			present: !!label,
			hidden: label?.classList.contains("notor-hidden") ?? null,
			text: label?.textContent ?? null,
		};
	}, { path: WF_PATH, name: WF_NAME });

	if (!active.ok) {
		ctx.fail("Workflow chip shows for active workflow", active.error ?? "unknown");
		return;
	}

	const label = await waitForSelector(page, ".notor-workflow-label", 4_000);
	if (!label) {
		const shot = await ctx.screenshot("01-no-chip");
		ctx.fail("Workflow chip shows for active workflow", "No .notor-workflow-label in the toolbar", shot);
		return;
	}

	const shot = await ctx.screenshot("01-chip-active");
	if (active.present && active.hidden === false && active.text === WF_NAME) {
		ctx.pass("Workflow chip shows for active workflow", `Chip visible with text "${active.text}"`, shot);
	} else {
		ctx.fail("Workflow chip shows for active workflow", `present=${active.present}, hidden=${active.hidden}, text="${active.text}"`, shot);
	}

	// Scenario 2 — deactivated workflow hides the chip.
	const deactivated = await page.evaluate((args) => {
		const view = (window as any).app?.plugins?.plugins?.["notor"]?.getActiveOrchestrator?.()?.getView?.();
		view.updateWorkflowLabel({
			workflow_path: args.path,
			workflow_name: args.name,
			workflow_deactivated: true,
		});
		const label = document.querySelector(".notor-workflow-label");
		return { hidden: label?.classList.contains("notor-hidden") ?? null };
	}, { path: WF_PATH, name: WF_NAME });

	if (deactivated.hidden === true) {
		ctx.pass("Deactivated workflow hides chip", "Chip has .notor-hidden when workflow_deactivated=true");
	} else {
		ctx.fail("Deactivated workflow hides chip", `Expected hidden=true, got ${deactivated.hidden}`);
	}

	// Scenario 3 — no workflow_path, and null conversation, both hide the chip.
	const noWorkflow = await page.evaluate(() => {
		const view = (window as any).app?.plugins?.plugins?.["notor"]?.getActiveOrchestrator?.()?.getView?.();
		view.updateWorkflowLabel({ workflow_path: null });
		const afterNoPath = document.querySelector(".notor-workflow-label")?.classList.contains("notor-hidden") ?? null;
		view.updateWorkflowLabel(null);
		const afterNull = document.querySelector(".notor-workflow-label")?.classList.contains("notor-hidden") ?? null;
		return { afterNoPath, afterNull };
	});

	if (noWorkflow.afterNoPath === true && noWorkflow.afterNull === true) {
		ctx.pass("Non-workflow conversation hides chip", "Chip hidden for missing workflow_path and for null conversation");
	} else {
		ctx.fail("Non-workflow conversation hides chip", `afterNoPath=${noWorkflow.afterNoPath}, afterNull=${noWorkflow.afterNull}`);
	}
}

// ---------------------------------------------------------------------------
// Test 4: clicking the chip → "Deactivate workflow" menu item fires callback
// ---------------------------------------------------------------------------

async function testDeactivateMenu(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: chip click opens the workflow menu; deactivate flips the header + hides the chip");
	const { page } = ctx;

	// Obsidian's transient `Menu` neither renders DOM nor exposes its class in the
	// CDP/Electron page context (verified: 0 `.menu` nodes even on a trusted click,
	// `require('obsidian')` unresolvable). So assert the contract in two observable
	// halves instead of the unrenderable menu:
	//   (a) clicking the chip invokes showWorkflowContextMenu (chip → menu wiring),
	//   (b) the REAL production deactivate callback (installed by wireView) flips
	//       workflow_deactivated on the header and hides the chip.
	const result = await page.evaluate(async (args) => {
		const w = window as any;
		const plugin = w.app?.plugins?.plugins?.["notor"];
		const orchestrator = plugin?.getActiveOrchestrator?.();
		const view = orchestrator?.getView?.();
		if (!view || !orchestrator) return { ok: false, error: "Missing view/orchestrator" };

		// (a) Spy on showWorkflowContextMenu (private, but reachable at runtime) to
		// confirm the chip's click handler opens the menu. Stub it to a no-op during
		// the spy so the unrenderable real menu doesn't run.
		view.updateWorkflowLabel({
			workflow_path: args.path,
			workflow_name: args.name,
			workflow_deactivated: false,
		});
		const origShow = view.showWorkflowContextMenu;
		let menuOpened = false;
		view.showWorkflowContextMenu = function () { menuOpened = true; };
		try {
			(document.querySelector(".notor-workflow-label") as HTMLElement | null)?.click();
		} finally {
			view.showWorkflowContextMenu = origShow;
		}

		// (b) Drive the REAL deactivate callback the menu item would invoke. It is
		// installed by wireView via setOnDeactivateWorkflow; capture it by setting a
		// wrapper is not possible (it's already set), so invoke the production effect
		// the same way the menu item does — through the active conversation. First
		// make a workflow conversation active so the callback has a target.
		const hm = plugin.getHistoryManager();
		const now = new Date().toISOString();
		const conv = {
			id: crypto.randomUUID(), title: "Deactivate Test", created_at: now, updated_at: now,
			provider_id: "bedrock", model_id: "test-model", mode: "act",
			workflow_path: args.path, workflow_name: args.name,
			total_input_tokens: 0, total_output_tokens: 0, estimated_cost: 0, is_background: false,
		};
		const filename = await hm.importConversation(conv, [{
			id: crypto.randomUUID(), conversation_id: conv.id, role: "user",
			content: "hi", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
		}]);
		await orchestrator.switchConversation(filename);
		await new Promise((r) => setTimeout(r, 1_200));

		const convManager = orchestrator.getConversationManager();
		const beforeFlag = convManager.getActiveConversation()?.workflow_deactivated ?? null;
		const chipBefore = document.querySelector(".notor-workflow-label");
		const chipVisibleBefore = !!chipBefore && !chipBefore.classList.contains("notor-hidden");

		// Invoke the REAL production deactivate callback installed by wireView
		// (private field, reachable at runtime like configResolver). This is exactly
		// what the menu item's onClick calls — it flips workflow_deactivated on the
		// active conversation header and updates the chip.
		const hasRealCallback = typeof view.onDeactivateWorkflow === "function";
		if (hasRealCallback) view.onDeactivateWorkflow();

		const afterFlag = convManager.getActiveConversation()?.workflow_deactivated ?? null;
		const chipAfter = document.querySelector(".notor-workflow-label");
		const chipHiddenAfter = !!chipAfter && chipAfter.classList.contains("notor-hidden");

		return {
			ok: true,
			menuOpened,
			hasRealCallback,
			beforeFlag,
			afterFlag,
			chipVisibleBefore,
			chipHiddenAfter,
		};
	}, { path: WF_PATH, name: WF_NAME });

	const shot = await ctx.screenshot("04-deactivate");

	if (!result.ok) {
		ctx.fail("Chip click opens workflow menu", result.error ?? "unknown", shot);
		return;
	}

	if (result.menuOpened) {
		ctx.pass("Chip click opens workflow menu", "Clicking the chip invoked showWorkflowContextMenu", shot);
	} else {
		ctx.fail("Chip click opens workflow menu", "Clicking the chip did not invoke showWorkflowContextMenu", shot);
	}

	if (result.hasRealCallback) {
		ctx.pass("Deactivate callback wired", "view.onDeactivateWorkflow is installed (by wireView)");
	} else {
		ctx.fail("Deactivate callback wired", "No production onDeactivateWorkflow callback was installed on the view");
	}

	if (result.chipVisibleBefore && result.beforeFlag !== true) {
		ctx.pass("Workflow active before deactivate", "Chip visible and workflow_deactivated not set");
	} else {
		ctx.fail("Workflow active before deactivate", `chipVisibleBefore=${result.chipVisibleBefore}, beforeFlag=${result.beforeFlag}`);
	}

	if (result.afterFlag === true && result.chipHiddenAfter) {
		ctx.pass("Deactivate flips header + hides chip", "Production callback set workflow_deactivated=true and hid the chip", shot);
	} else {
		ctx.fail("Deactivate flips header + hides chip", `afterFlag=${result.afterFlag}, chipHiddenAfter=${result.chipHiddenAfter}`, shot);
	}
}

// ---------------------------------------------------------------------------
// Test 5: no render errors logged
// ---------------------------------------------------------------------------

async function testNoErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: no render errors logged for workflow chip");
	const errors = ctx.collector.getLogsByLevel("error");
	const relevant = errors.filter(
		(e) => e.source === "ChatView" || e.message?.toLowerCase().includes("workflow"),
	);
	if (relevant.length === 0) {
		ctx.pass("No workflow chip render errors", "Zero relevant error-level logs");
	} else {
		ctx.fail("No workflow chip render errors", `${relevant.length}: ${relevant.map((e) => e.message).join("; ")}`);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // plugin init

	await page.evaluate(() => {
		if (typeof (window as any).__name === "undefined") {
			(window as any).__name = (fn: unknown, _name: string) => fn;
		}
	});

	await testChipVisibility(ctx);
	await testDeactivateMenu(ctx);
	await testNoErrors(ctx);

	// Dismiss any open menu and hide the chip so the final screenshot is clean.
	await page.keyboard.press("Escape");
	await page.evaluate(() => {
		const view = (window as any).app?.plugins?.plugins?.["notor"]?.getActiveOrchestrator?.()?.getView?.();
		view?.updateWorkflowLabel?.(null);
	});
}

runTest(
	{
		name: "workflow-chip-test",
		settings: buildDefaultSettings(),
		// Pin a clean workspace so the chat panel (deferred view in Obsidian 1.12)
		// mounts regardless of leftover workspace state from prior runs.
		setupVault: (vaultPath) => writeCleanWorkspace(vaultPath),
	},
	tests,
);
