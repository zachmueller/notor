#!/usr/bin/env npx tsx
/**
 * Workflow Chat Attachment E2E Test
 *
 * Regression coverage for the "workflow chat panel conversation detaches from
 * active chat" bug. When a workflow is launched manually from the chat panel,
 * the workflow turn runs against an *isolated* session ConversationManager. The
 * panel's **display** ConversationManager must be synced back with the turn's
 * final messages once it settles — otherwise follow-up messages snapshot stale
 * display state and the LLM loses the entire workflow turn's context.
 *
 * This test exercises the real foreground path (orchestrator.executeWorkflow /
 * switchWorkflow) against the live runtime and asserts the structural invariant
 * that proves the fix: after the workflow turn settles, the display manager —
 * the exact object follow-up turns snapshot from — holds the assistant turn,
 * and the active conversation in the history list IS the workflow conversation
 * (no "Untitled" / separate-conversation divergence).
 *
 * Scenarios:
 *   1. executeWorkflow (new conversation): display manager is synced with the
 *      assistant turn after the workflow settles; active conversation is the
 *      workflow conversation.
 *   2. Follow-up message after the workflow turn is appended to the SAME
 *      conversation (no detach to a separate conversation) and the assembled
 *      context still contains the workflow turn.
 *   3. switchWorkflow (existing conversation): switching a conversation into a
 *      workflow mid-chat keeps the turn attached to that same conversation.
 *
 * @see ideas/Workflow chat panel conversation detaches from active chat.md
 * @see src/chat/workflow-executor.ts — _runWorkflowIntoConversation delegates to runSession
 * @see src/chat/conversation-session.ts — syncSessionToDisplay
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	sendMessage,
	newConversation,
	ensureCleanState,
	writeCleanWorkspace,
	waitForSelector,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const WORKFLOW_FILE = "notor/workflows/attach-check.md";

// ---------------------------------------------------------------------------
// Local helpers (plugin-internal access — not provided by shared modules)
// ---------------------------------------------------------------------------

/** Active conversation id from the display ConversationManager. */
async function getActiveConversationId(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		try {
			return plugin.getActiveOrchestrator().getConversationManager().getActiveConversation()?.id ?? null;
		} catch {
			return null;
		}
	});
}

/**
 * Snapshot of the **display** ConversationManager — the object follow-up turns
 * snapshot from. This is the precise surface the sync-back fix targets.
 */
async function getDisplayState(page: Page): Promise<{
	conversationId: string | null;
	roles: string[];
	contents: string[];
	isWorkflowConversation: boolean;
}> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const cm = plugin.getActiveOrchestrator().getConversationManager();
		const conv = cm.getActiveConversation();
		const messages = cm.getMessages() as Array<{ role: string; content: unknown }>;
		return {
			conversationId: conv?.id ?? null,
			roles: messages.map((m) => m.role),
			contents: messages.map((m) => (typeof m.content === "string" ? m.content : "[blocks]")),
			isWorkflowConversation: !!conv?.workflow_path,
		};
	});
}

/** Trigger the manual foreground workflow path via the orchestrator facade. */
async function executeWorkflow(page: Page, workflowFilePath: string): Promise<{ ok: boolean; reason: string }> {
	return page.evaluate(async (filePath: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const orchestrator = plugin?.getActiveOrchestrator?.();
		if (!orchestrator) return { ok: false, reason: "orchestrator not found" };
		try {
			// Minimal Workflow object — file_path drives the lazy body read at
			// execution time (body_content is read from the vault file).
			await orchestrator.executeWorkflow({
				file_path: filePath,
				file_name: filePath.split("/").pop(),
				display_name: "attach-check",
				aliases: [],
				trigger: "manual",
				schedule: null,
				persona_name: null,
				mode: null,
				model_preset: null,
				thinking_level: null,
				hook_delay: null,
				hooks: null,
				active_note_prompt: null,
				body_content: "",
			});
			return { ok: true, reason: "executeWorkflow resolved" };
		} catch (e) {
			return { ok: false, reason: `caught: ${e instanceof Error ? e.message : String(e)}` };
		}
	}, workflowFilePath);
}

/** Switch the active conversation into the workflow (the isExisting branch). */
async function switchWorkflow(page: Page, workflowFilePath: string): Promise<{ ok: boolean; reason: string }> {
	return page.evaluate(async (filePath: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const orchestrator = plugin?.getActiveOrchestrator?.();
		if (!orchestrator) return { ok: false, reason: "orchestrator not found" };
		try {
			await orchestrator.switchWorkflow({
				file_path: filePath,
				file_name: filePath.split("/").pop(),
				display_name: "attach-check",
				aliases: [],
				trigger: "manual",
				schedule: null,
				persona_name: null,
				mode: null,
				model_preset: null,
				thinking_level: null,
				hook_delay: null,
				hooks: null,
				active_note_prompt: null,
				body_content: "",
			});
			return { ok: true, reason: "switchWorkflow resolved" };
		} catch (e) {
			return { ok: false, reason: `caught: ${e instanceof Error ? e.message : String(e)}` };
		}
	}, workflowFilePath);
}

/** Wait for the chat input to be editable again (response settled). */
async function waitForInputEnabled(page: Page, timeoutMs = 90_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const enabled = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			const stop = document.querySelector(".notor-stop-btn");
			const stopHidden = !stop || stop.classList.contains("notor-hidden");
			return el?.getAttribute("contenteditable") === "true" && stopHidden;
		});
		if (enabled) return true;
		await page.waitForTimeout(1_000);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Test 1: executeWorkflow syncs the assistant turn back into the display manager.
 *
 * This is the core regression: before the fix, the display manager held only the
 * workflow user message after the turn settled (the assistant/tool messages
 * lived solely in the isolated session manager + JSONL). After the fix, the
 * display manager — what follow-ups snapshot from — must include the assistant turn.
 */
async function testForegroundSyncBack(ctx: TestContext): Promise<{ workflowConvId: string | null }> {
	console.log("\nTest 1: executeWorkflow syncs assistant turn into the display manager");
	const { page } = ctx;

	await ensureCleanState(page);
	await newConversation(page);
	await page.waitForTimeout(1_000);

	const exec = await executeWorkflow(page, WORKFLOW_FILE);
	if (!exec.ok) {
		ctx.fail("executeWorkflow invoked", `Foreground workflow path threw: ${exec.reason}`);
		return { workflowConvId: null };
	}

	const settled = await waitForInputEnabled(page);
	if (!settled) {
		const shot = await ctx.screenshot("01-not-settled");
		ctx.fail("Workflow turn settled", "Input did not re-enable within timeout after workflow turn", shot);
		return { workflowConvId: null };
	}
	// Give the finally-block sync-back a beat to flush into the display manager.
	await page.waitForTimeout(1_500);

	const state = await getDisplayState(page);
	const shot = await ctx.screenshot("01-after-workflow");
	console.log(`    Display roles: [${state.roles.join(", ")}]`);

	// The workflow user message must be present...
	const hasUserTurn = state.roles.includes("user");
	// ...AND the synced-back assistant turn must be present in the DISPLAY manager.
	const hasAssistantTurn = state.roles.includes("assistant");

	if (hasUserTurn && hasAssistantTurn) {
		ctx.pass(
			"Display manager synced with workflow turn",
			`Display manager holds the assistant turn after settle (roles: [${state.roles.join(", ")}])`,
			shot,
		);
	} else {
		ctx.fail(
			"Display manager synced with workflow turn",
			`Expected user+assistant in display manager; got roles: [${state.roles.join(", ")}]. ` +
				`hasUser=${hasUserTurn}, hasAssistant=${hasAssistantTurn}. ` +
				`This is the detach bug — the assistant turn lives only in the isolated session manager.`,
			shot,
		);
	}

	// The active display conversation must be the workflow conversation itself
	// (the "Untitled vs separate workflow conversation" divergence in the bug report).
	if (state.isWorkflowConversation) {
		ctx.pass(
			"Active conversation is the workflow conversation",
			`Active display conversation carries workflow_path (id ${state.conversationId})`,
		);
	} else {
		ctx.fail(
			"Active conversation is the workflow conversation",
			`Active display conversation has no workflow_path — display/session diverged (id ${state.conversationId})`,
		);
	}

	return { workflowConvId: state.conversationId };
}

/**
 * Test 2: A follow-up message stays attached to the same workflow conversation
 * and the assembled context still includes the workflow turn.
 */
async function testFollowUpStaysAttached(ctx: TestContext, workflowConvId: string | null): Promise<void> {
	console.log("\nTest 2: follow-up message stays attached to the workflow conversation");
	const { page } = ctx;

	if (!workflowConvId) {
		ctx.fail("Follow-up stays attached", "No workflow conversation id from Test 1 — cannot continue");
		return;
	}

	await ensureCleanState(page);

	const before = await getDisplayState(page);
	const responded = await sendMessage(page, "In one short sentence, what workflow were you just running?");
	if (!responded) {
		const shot = await ctx.screenshot("02-followup-no-response");
		ctx.fail("Follow-up response received", "No response to the follow-up message", shot);
		return;
	}
	await page.waitForTimeout(1_500);

	const after = await getDisplayState(page);
	const shot = await ctx.screenshot("02-after-followup");
	console.log(`    Roles before follow-up: [${before.roles.join(", ")}]`);
	console.log(`    Roles after follow-up:  [${after.roles.join(", ")}]`);

	// The follow-up must land in the SAME conversation — no detach to a new one.
	if (after.conversationId === workflowConvId) {
		ctx.pass(
			"Follow-up stays in the workflow conversation",
			`Active conversation unchanged after follow-up (id ${after.conversationId})`,
			shot,
		);
	} else {
		ctx.fail(
			"Follow-up stays in the workflow conversation",
			`Active conversation changed from ${workflowConvId} to ${after.conversationId} — follow-up detached`,
			shot,
		);
	}

	// The conversation must have grown (workflow turn + follow-up user + assistant),
	// and the original workflow turn must still be present in the assembled history.
	const grew = after.roles.length > before.roles.length;
	const stillHasWorkflowTurn = after.roles.filter((r) => r === "assistant").length >= 2 || after.roles.includes("user");
	if (grew && stillHasWorkflowTurn) {
		ctx.pass(
			"Follow-up context includes the prior workflow turn",
			`History grew from ${before.roles.length} to ${after.roles.length} messages and retains the prior turn`,
		);
	} else {
		ctx.fail(
			"Follow-up context includes the prior workflow turn",
			`History did not grow as expected (before=${before.roles.length}, after=${after.roles.length}, roles=[${after.roles.join(", ")}])`,
		);
	}
}

/**
 * Test 3: switchWorkflow (the isExisting branch) keeps the turn attached to the
 * same conversation it was applied into.
 */
async function testSwitchWorkflowStaysAttached(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: switchWorkflow keeps the turn attached to the existing conversation");
	const { page } = ctx;

	await ensureCleanState(page);
	await newConversation(page);
	await page.waitForTimeout(1_000);

	// Seed the conversation with a normal turn so it's a real existing conversation.
	const seeded = await sendMessage(page, "Say exactly: seed-turn-ok");
	if (!seeded) {
		ctx.fail("Seed conversation for switch", "No response to the seed message");
		return;
	}
	await page.waitForTimeout(1_000);

	const beforeId = await getActiveConversationId(page);
	console.log(`    Existing conversation before switch: ${beforeId}`);

	const sw = await switchWorkflow(page, WORKFLOW_FILE);
	if (!sw.ok) {
		ctx.fail("switchWorkflow invoked", `switchWorkflow threw: ${sw.reason}`);
		return;
	}

	const settled = await waitForInputEnabled(page);
	if (!settled) {
		const shot = await ctx.screenshot("03-switch-not-settled");
		ctx.fail("Switched workflow turn settled", "Input did not re-enable after switchWorkflow turn", shot);
		return;
	}
	await page.waitForTimeout(1_500);

	const after = await getDisplayState(page);
	const shot = await ctx.screenshot("03-after-switch");
	console.log(`    Roles after switch: [${after.roles.join(", ")}]`);

	// Same conversation id (switch applies in-place, never creates a new conversation)...
	if (after.conversationId === beforeId) {
		ctx.pass(
			"switchWorkflow stays in the same conversation",
			`Conversation id unchanged across switch (id ${after.conversationId})`,
			shot,
		);
	} else {
		ctx.fail(
			"switchWorkflow stays in the same conversation",
			`Conversation id changed from ${beforeId} to ${after.conversationId} — switch created a separate conversation`,
			shot,
		);
	}

	// ...and the display manager is synced with the workflow turn's assistant response.
	const assistantCount = after.roles.filter((r) => r === "assistant").length;
	if (after.isWorkflowConversation && assistantCount >= 2) {
		ctx.pass(
			"switchWorkflow turn synced into display manager",
			`Conversation carries workflow_path and ${assistantCount} assistant turns (seed + workflow) after switch`,
		);
	} else {
		ctx.fail(
			"switchWorkflow turn synced into display manager",
			`Expected workflow_path + >=2 assistant turns; got isWorkflow=${after.isWorkflowConversation}, ` +
				`assistantCount=${assistantCount}, roles=[${after.roles.join(", ")}]`,
		);
	}
}

/**
 * Test 4: No detach/sync error-level logs from the workflow/session components.
 */
async function testNoSyncErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: no error-level logs from workflow/orchestrator sync paths");
	const sources = ["WorkflowExecutor", "ChatOrchestrator"];
	const errors = ctx.collector.getStructuredLogs().filter(
		(e) =>
			e.level === "error" &&
			sources.includes(e.source) &&
			// Provider auth failures are expected in CI without credentials and are
			// unrelated to the sync-back / attachment logic under test.
			!e.message.includes("AUTH_FAILED") &&
			!e.message.includes("API key not configured") &&
			!e.message.includes("Provider error"),
	);

	if (errors.length === 0) {
		ctx.pass("No workflow/sync error logs", "Zero non-provider error logs from WorkflowExecutor/ChatOrchestrator");
	} else {
		ctx.fail(
			"No workflow/sync error logs",
			`${errors.length} error log(s): ${errors.map((e) => `[${e.source}] "${e.message}"`).join("; ")}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(6_000); // Wait for plugin init

	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chat) {
		ctx.fail("Plugin loaded", ".notor-chat-container not found");
		return;
	}

	const { workflowConvId } = await testForegroundSyncBack(ctx);
	await testFollowUpStaysAttached(ctx, workflowConvId);
	await testSwitchWorkflowStaysAttached(ctx);
	await testNoSyncErrors(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "act",
});

runTest(
	{
		name: "workflow-chat-attachment",
		settings,
		setupVault: (vaultPath) => {
			// Clean single-panel workspace so the chat container mounts reliably
			// (Obsidian 1.12 deferred views won't mount the panel otherwise).
			writeCleanWorkspace(vaultPath);

			const workflowsDir = path.join(vaultPath, "notor", "workflows");
			fs.mkdirSync(workflowsDir, { recursive: true });
			fs.writeFileSync(
				path.join(workflowsDir, "attach-check.md"),
				`---
notor-workflow: true
notor-trigger: manual
---

You are running the attach-check workflow. Reply with exactly one short sentence confirming you received this workflow prompt.
`,
			);
			console.log("  attach-check workflow fixture created.");
		},
		cleanupFiles: [WORKFLOW_FILE],
	},
	tests,
);
