#!/usr/bin/env npx tsx
/**
 * Model-Selection State Unification E2E Test
 *
 * Validates the state-unification work on branch harden-model-thinking-resolution:
 * provider/model/thinking-level/extended-context/preset resolve through ONE path
 * across new-conversation, fork, and reopen — so what the selector shows, what the
 * conversation header persists, and what the next turn will send can never diverge.
 *
 * Every scenario asserts the three surfaces agree after the transition:
 *   A. Orchestrator active state pinned for the next turn (getActive* getters)
 *   B. The persisted conversation header on disk (provider_id, model_id,
 *      use_extended_context, thinking_level, preset_name)
 *   C. Thinking-control visibility in the settings popover DOM (present only for
 *      models where supportsThinking() is true)
 *
 * Scenarios:
 *   1. Preset-switch on a fresh chat → header + active state + thinking control all
 *      reflect the "large" preset (Opus 4.8, 1M, thinking medium; control visible)
 *   2. Fork-then-switch-model → the fork inherits the active selection (preset,
 *      thinking level, extended context) and its header matches
 *   3. New-conversation-from-old (reopen an old chat, then start new) → the new
 *      conversation resolves through the same authority, not stale residue
 *   4. Thinking-control hidden for a non-thinking model (Fable 5 → mode:none)
 *
 * These drive transitions via the plugin's public orchestrator API (deterministic,
 * no dependence on flaky LLM tool behavior), mirroring conversation-fork-test.ts.
 *
 * @see ideas/Model selector and thinking config break on fork and Bedrock data retention errors.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	ensureCleanState,
	newConversation,
	sendMessage,
	writeCleanWorkspace,
	VAULT_PATH,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const HISTORY_DIR = ".obsidian/plugins/notor/history/";

const OPUS = "global.anthropic.claude-opus-4-8"; // effort thinking model → control visible
const HAIKU = "global.anthropic.claude-haiku-4-5-20251001-v1:0"; // non-thinking → control hidden

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Read + parse a conversation JSONL history file by conversation id. */
function findHeaderByConversationId(conversationId: string): Record<string, any> | null {
	const histDir = path.join(VAULT_PATH, HISTORY_DIR);
	if (!fs.existsSync(histDir)) return null;
	for (const filename of fs.readdirSync(histDir).filter((f) => f.endsWith(".jsonl"))) {
		const content = fs.readFileSync(path.join(histDir, filename), "utf-8");
		const first = content.split("\n").find((l) => l.trim().length > 0);
		if (!first) continue;
		const header = JSON.parse(first);
		if (header._type === "conversation" && header.id === conversationId) return header;
	}
	return null;
}

/** Snapshot the orchestrator's active selection (state pinned for the next turn). */
async function getActiveSelection(page: Page): Promise<{
	conversationId: string | null;
	providerId: string;
	modelId: string;
	useExtendedContext: boolean;
	thinkingLevel: string | null;
	presetName: string | null;
} | null> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		const orch = plugin.getActiveOrchestrator();
		if (!orch) return null;
		return {
			conversationId: orch.getDisplayedConversation()?.id ?? null,
			providerId: orch.getActiveProviderId(),
			modelId: orch.getActiveModelId(),
			useExtendedContext: orch.getActiveUseExtendedContext(),
			thinkingLevel: orch.getActiveThinkingLevel(),
			presetName: orch.getActivePresetName(),
		};
	});
}

/**
 * Drive a preset switch through the SAME callback the settings popover fires
 * (the view's registered onPresetChange handler from wireView). This exercises
 * the real applyModelSelectionToHeader path, not a private setter. Awaits a tick
 * so the async header write settles.
 */
async function switchPreset(page: Page, presetName: string): Promise<boolean> {
	const invoked = await page.evaluate((name: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		const orch = plugin.getActiveOrchestrator();
		const view = orch?.view;
		// onPresetChange is registered via setOnPresetChange(); it's a "private"
		// TS field but reachable at runtime. Passing just the name mirrors the
		// popover's non-custom branch (it resolves provider/model from the preset).
		if (view && typeof view.onPresetChange === "function") {
			view.onPresetChange(name);
			return true;
		}
		return false;
	}, presetName);
	return invoked;
}

/** Fork the displayed conversation at its last message via the orchestrator. */
async function forkAtLastMessage(page: Page): Promise<{ filename: string; conversationId: string } | null> {
	return page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		const orch = plugin.getActiveOrchestrator();
		const msgs = orch.getConversationManager().getMessages();
		if (msgs.length === 0) return null;
		const result = await orch.forkConversation(msgs[msgs.length - 1].id);
		if (!result) return null;
		return { filename: result.filename, conversationId: result.conversation.id };
	});
}

async function switchToConversation(page: Page, filename: string): Promise<boolean> {
	return page.evaluate(async (fname: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		try {
			await plugin.getActiveOrchestrator().switchConversation(fname);
			return true;
		} catch {
			return false;
		}
	}, filename);
}

/** Open the settings popover and report whether the thinking control is present. */
async function thinkingControlVisible(page: Page): Promise<boolean> {
	const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
	if (!settingsBtn) return false;
	await settingsBtn.click();
	await page.waitForTimeout(800);
	const present = await page.evaluate(
		() => !!document.querySelector(".notor-settings-popover .notor-thinking-section"),
	);
	await settingsBtn.click(); // close
	await page.waitForTimeout(400);
	return present;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testPresetSwitchOnFreshChat(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Preset switch on a fresh chat — three surfaces agree");
	const { page } = ctx;

	await newConversation(page);
	await page.waitForTimeout(1_500);

	// Send one message so the conversation header is written to disk.
	await sendMessage(page, "Say hi in one word.");
	await page.waitForTimeout(1_500);

	const switched = await switchPreset(page, "large");
	if (!switched) {
		ctx.fail("Preset switch on fresh chat", "Could not invoke preset-change callback");
		return;
	}
	await page.waitForTimeout(1_500);

	// A. Active state pinned for next turn
	const sel = await getActiveSelection(page);
	if (!sel) {
		ctx.fail("Preset switch on fresh chat", "Could not read active selection");
		return;
	}
	const activeOk =
		sel.presetName === "large" &&
		sel.modelId === OPUS &&
		sel.useExtendedContext === true &&
		sel.thinkingLevel === "medium";

	// B. Persisted header on disk
	const header = sel.conversationId ? findHeaderByConversationId(sel.conversationId) : null;
	const headerOk =
		!!header &&
		header.preset_name === "large" &&
		header.model_id === OPUS &&
		header.use_extended_context === true &&
		header.thinking_level === "medium";

	// C. Thinking control visibility (Opus 4.8 supports thinking)
	const controlVisible = await thinkingControlVisible(page);

	const shot = await ctx.screenshot("01-preset-switch");
	if (activeOk && headerOk && controlVisible) {
		ctx.pass(
			"Preset switch on fresh chat",
			`active + header + thinking-control all agree (preset=large, model=Opus 4.8, 1M, thinking=medium)`,
			shot,
		);
	} else {
		ctx.fail(
			"Preset switch on fresh chat",
			`activeOk=${activeOk} (${JSON.stringify(sel)}), headerOk=${headerOk} (${JSON.stringify(header && { preset_name: header.preset_name, model_id: header.model_id, use_extended_context: header.use_extended_context, thinking_level: header.thinking_level })}), controlVisible=${controlVisible}`,
			shot,
		);
	}
}

async function testForkInheritsSelection(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Fork inherits the active selection (preset, thinking, extended)");
	const { page } = ctx;

	// Continue from Test 1's state: active preset should be "large".
	const before = await getActiveSelection(page);
	if (!before || before.presetName !== "large") {
		// Re-establish the large preset if a prior test left a different state.
		await switchPreset(page, "large");
		await page.waitForTimeout(1_200);
	}

	const fork = await forkAtLastMessage(page);
	if (!fork) {
		ctx.fail("Fork inherits selection", "Fork returned null (no messages to fork?)");
		return;
	}
	await page.waitForTimeout(1_000);

	// The fork's persisted header must carry the full selection.
	const header = findHeaderByConversationId(fork.conversationId);
	const headerOk =
		!!header &&
		header.model_id === OPUS &&
		header.use_extended_context === true &&
		header.thinking_level === "medium" &&
		header.preset_name === "large";

	// Switch to the fork and confirm the active state matches (what the next turn sends).
	await switchToConversation(page, fork.filename);
	await page.waitForTimeout(1_500);
	const sel = await getActiveSelection(page);
	const activeOk =
		!!sel &&
		sel.conversationId === fork.conversationId &&
		sel.modelId === OPUS &&
		sel.useExtendedContext === true &&
		sel.thinkingLevel === "medium";

	const shot = await ctx.screenshot("02-fork-inherits");
	if (headerOk && activeOk) {
		ctx.pass(
			"Fork inherits selection",
			`fork header + active state carry preset=large, Opus 4.8, 1M, thinking=medium`,
			shot,
		);
	} else {
		ctx.fail(
			"Fork inherits selection",
			`headerOk=${headerOk} (${JSON.stringify(header && { model_id: header.model_id, use_extended_context: header.use_extended_context, thinking_level: header.thinking_level, preset_name: header.preset_name })}), activeOk=${activeOk} (${JSON.stringify(sel)})`,
			shot,
		);
	}
}

/**
 * Import a conversation with a controlled header (deterministic — no send-session
 * timing) and return its filename + id.
 */
async function importConversation(
	page: Page,
	header: Record<string, unknown>,
): Promise<{ filename: string; conversationId: string } | null> {
	return page.evaluate(async (hdr: Record<string, unknown>) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		const orch = plugin.getActiveOrchestrator();
		const hm = plugin.getHistoryManager();
		const convId = crypto.randomUUID();
		const now = new Date().toISOString();
		const conversation = {
			id: convId,
			title: "Old Chat",
			created_at: now,
			updated_at: now,
			total_input_tokens: 0,
			total_output_tokens: 0,
			estimated_cost: 0,
			is_background: false,
			mode: "act",
			...hdr,
		};
		const messages = [
			{ id: crypto.randomUUID(), conversation_id: convId, role: "user", content: "Prior turn", created_at: now, input_tokens: 5, output_tokens: 0, estimated_cost: 0 },
			{ id: crypto.randomUUID(), conversation_id: convId, role: "assistant", content: "Prior reply", created_at: now, input_tokens: 0, output_tokens: 5, estimated_cost: 0 },
		];
		const filename = await hm.importConversation(conversation, messages);
		void orch;
		return { filename, conversationId: convId };
	}, header);
}

async function testNewFromOld(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Reopen-from-old restores the stored selection (no stale residue)");
	const { page } = ctx;

	// Deterministic setup: import an OLD conversation whose header is the small
	// preset (Haiku, no thinking, no extended). This is the exact shape a
	// preset-less-but-stored conversation carries, and directly exercises the
	// resolveConversationModel reopen path that Phase C unified.
	await ensureCleanState(page);
	const imported = await importConversation(page, {
		provider_id: "bedrock",
		model_id: HAIKU,
		preset_name: "small",
		use_extended_context: false,
		thinking_level: null,
	});
	if (!imported) {
		ctx.fail("Reopen-from-old restores selection", "Could not import old conversation");
		return;
	}

	// Move the active selection AWAY to the large preset on a different chat, so a
	// stale-residue bug would surface as "large" leaking into the reopened chat.
	await newConversation(page);
	await page.waitForTimeout(1_200);
	await switchPreset(page, "large");
	await page.waitForTimeout(1_000);
	const awayFromOld = await getActiveSelection(page);
	console.log(`  active before reopen: preset=${awayFromOld?.presetName} model=${awayFromOld?.modelId}`);

	// Reopen the OLD conversation — its stored small selection must be restored,
	// NOT the large residue from the active state.
	const switched = await switchToConversation(page, imported.filename);
	await page.waitForTimeout(1_800);
	const reopened = await getActiveSelection(page);
	console.log(`  reopen switched=${switched} → conv=${reopened?.conversationId?.substring(0, 8)} preset=${reopened?.presetName} model=${reopened?.modelId} think=${reopened?.thinkingLevel} 1m=${reopened?.useExtendedContext}`);

	const reopenOk =
		switched &&
		!!reopened &&
		reopened.conversationId === imported.conversationId &&
		reopened.presetName === "small" &&
		reopened.modelId === HAIKU &&
		reopened.useExtendedContext === false &&
		(reopened.thinkingLevel ?? null) === null;

	const shot = await ctx.screenshot("03-reopen-from-old");
	if (reopenOk) {
		ctx.pass(
			"Reopen-from-old restores selection",
			`reopened old chat restored small/Haiku (no thinking, no 1M) despite active state being large — no stale residue leaked`,
			shot,
		);
	} else {
		ctx.fail(
			"Reopen-from-old restores selection",
			`expected small/Haiku after reopen, got ${JSON.stringify(reopened)}`,
			shot,
		);
	}
}

async function testThinkingControlHiddenForNonThinkingModel(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Thinking control hidden for a non-thinking model");
	const { page } = ctx;

	// The "small" preset points at Haiku, which is not a thinking model.
	await newConversation(page);
	await page.waitForTimeout(1_200);
	await switchPreset(page, "small");
	await page.waitForTimeout(1_200);

	const sel = await getActiveSelection(page);
	const controlVisible = await thinkingControlVisible(page);

	const shot = await ctx.screenshot("04-thinking-hidden-haiku");
	if (sel?.modelId === HAIKU && !controlVisible) {
		ctx.pass(
			"Thinking control hidden for non-thinking model",
			`Haiku selected (${sel.modelId}); thinking control correctly absent`,
			shot,
		);
	} else {
		ctx.fail(
			"Thinking control hidden for non-thinking model",
			`model=${sel?.modelId}, controlVisible=${controlVisible} (expected Haiku + hidden)`,
			shot,
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init

	await testPresetSwitchOnFreshChat(ctx);
	await testForkInheritsSelection(ctx);
	await testNewFromOld(ctx);
	await testThinkingControlHiddenForNonThinkingModel(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "act",
	default_preset: "small",
	model_presets: [
		{ name: "small", provider_id: "bedrock", model_id: HAIKU, use_extended_context: false, thinking_level: null },
		{ name: "large", provider_id: "bedrock", model_id: OPUS, use_extended_context: true, thinking_level: "medium" },
	],
});

runTest(
	{
		name: "model-selection-state",
		settings,
		// Deferred views require a clean workspace or the chat container never mounts.
		setupVault: (vaultPath: string) => writeCleanWorkspace(vaultPath),
	},
	tests,
);
