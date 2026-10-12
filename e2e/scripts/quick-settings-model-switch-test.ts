#!/usr/bin/env npx tsx
/**
 * Quick Settings Model Switching E2E Test
 *
 * Validates that a Quick Settings model change is strict and predictable:
 * what the selector shows is what the next LLM call uses, it reaches the
 * JSONL header promptly, and it never touches global defaults or other panels.
 *
 * Scenarios:
 *   1. Switching the preset in the popover shows a Notice, updates the JSONL
 *      header, and leaves settings.active_provider / the provider's default
 *      model_id (and the registry's active provider) unchanged
 *   2. A thinking tweak under a preset keeps the preset label; close/reopen
 *      restores exactly the recorded selection
 *   3. Two panels are independent — a switch in one doesn't change the other
 *   4. A switch while a turn is running (paused on a write approval) applies
 *      from the next LLM call: the tool-call turn records the old model, the
 *      final reply records the new one, and the header keeps the new selection
 *
 * @see ideas/Make Quick Settings model switching robust across providers.md
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
	waitForResponse,
	VAULT_PATH,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const HISTORY_DIR = ".obsidian/plugins/notor/history/";
const CHAT_VIEW_TYPE = "notor-chat-view";

const HAIKU = "global.anthropic.claude-haiku-4-5-20251001-v1:0"; // provider default + "small"
const OPUS = "global.anthropic.claude-opus-4-8"; // "large"

const SWITCH_NOTE = "e2e-model-switch.md";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Find a conversation's JSONL file by id; returns filename + parsed lines. */
function readConversationFile(conversationId: string): { filename: string; header: Record<string, any>; messages: Record<string, any>[] } | null {
	const histDir = path.join(VAULT_PATH, HISTORY_DIR);
	if (!fs.existsSync(histDir)) return null;
	for (const filename of fs.readdirSync(histDir).filter((f) => f.endsWith(".jsonl"))) {
		const lines = fs.readFileSync(path.join(histDir, filename), "utf-8")
			.split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
		const header = lines[0];
		if (header?._type === "conversation" && header.id === conversationId) {
			return { filename, header, messages: lines.slice(1) };
		}
	}
	return null;
}

type Selection = {
	conversationId: string | null;
	providerId: string;
	modelId: string;
	useExtendedContext: boolean;
	thinkingLevel: string | null;
	presetName: string | null;
};

/** The active selection of the chat leaf at `index` (0 = first panel). */
async function getSelection(page: Page, index = 0): Promise<Selection | null> {
	return page.evaluate(({ viewType, idx }: { viewType: string; idx: number }) => {
		const app = (window as any).app;
		const plugin = app?.plugins?.plugins?.["notor"];
		const leaf = app?.workspace.getLeavesOfType(viewType)[idx];
		const orch = leaf ? plugin?._orchestrators?.get(leaf.id) : null;
		if (!orch) return null;
		return {
			conversationId: orch.getDisplayedConversation()?.id ?? null,
			providerId: orch.getActiveProviderId(),
			modelId: orch.getActiveModelId(),
			useExtendedContext: orch.getActiveUseExtendedContext(),
			thinkingLevel: orch.getActiveThinkingLevel(),
			presetName: orch.getActivePresetName(),
		};
	}, { viewType: CHAT_VIEW_TYPE, idx: index });
}

/** Global provider state that Quick Settings must never change. */
async function getGlobalProviderState(page: Page): Promise<{ activeProvider: string; bedrockModel: string | null; registryActive: string; registryModel: string | null } | null> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		const registry = plugin.getProviderRegistry();
		const bedrock = plugin.settings.providers.find((p: { id: string }) => p.id === "bedrock");
		return {
			activeProvider: plugin.settings.active_provider,
			bedrockModel: bedrock?.model_id ?? null,
			registryActive: registry.getActiveId(),
			registryModel: registry.getConfig("bedrock")?.model_id ?? null,
		};
	});
}

/** Drive a view callback (the same one the popover fires) on the leaf at `index`. */
async function invokeViewCallback(page: Page, callback: "onPresetChange" | "onThinkingLevelChange", arg: string | null, index = 0): Promise<boolean> {
	return page.evaluate(({ viewType, idx, cb, value }: { viewType: string; idx: number; cb: string; value: string | null }) => {
		const leaf = (window as any).app?.workspace.getLeavesOfType(viewType)[idx];
		const fn = leaf?.view?.[cb];
		if (typeof fn !== "function") return false;
		fn(value);
		return true;
	}, { viewType: CHAT_VIEW_TYPE, idx: index, cb: callback, value: arg });
}

/** Text of all currently visible Notices. */
async function getNoticeTexts(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		Array.from(document.querySelectorAll(".notice")).map((n) => n.textContent?.trim() ?? ""),
	);
}

async function dismissNotices(page: Page): Promise<void> {
	await page.evaluate(() => {
		document.querySelectorAll(".notice-container .notice").forEach((n) => (n as HTMLElement).click());
	});
}

async function switchToConversation(page: Page, filename: string): Promise<boolean> {
	return page.evaluate(async (fname: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		try {
			await plugin.getActiveOrchestrator().switchConversation(fname);
			return true;
		} catch {
			return false;
		}
	}, filename);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Conversation created in Test 1, reopened in Test 2. */
let test1ConversationId: string | null = null;

async function testPopoverPresetSwitch(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Popover preset switch → Notice + JSONL header, globals untouched");
	const { page } = ctx;

	await newConversation(page);
	await page.waitForTimeout(1_500);
	await sendMessage(page, "Say hi in one word.");
	await waitForResponse(page);
	await page.waitForTimeout(1_000);

	const globalsBefore = await getGlobalProviderState(page);
	await dismissNotices(page);

	// Drive the real popover: open it and change the preset <select>.
	const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
	if (!settingsBtn) {
		ctx.fail("Popover preset switch", "Chat settings button not found");
		return;
	}
	await settingsBtn.click();
	await page.waitForTimeout(800);
	const changed = await page.evaluate(() => {
		const select = document.querySelector(".notor-settings-popover .notor-preset-section select") as HTMLSelectElement | null;
		if (!select) return false;
		select.value = "large";
		select.dispatchEvent(new Event("change"));
		return true;
	});
	await page.waitForTimeout(600);
	const notices = await getNoticeTexts(page);
	const shot = await ctx.screenshot("01-popover-preset-switch");
	await settingsBtn.click(); // close
	await page.waitForTimeout(1_000);

	if (!changed) {
		ctx.fail("Popover preset switch", "Preset <select> not found in the popover", shot);
		return;
	}

	const sel = await getSelection(page);
	test1ConversationId = sel?.conversationId ?? null;
	const file = sel?.conversationId ? readConversationFile(sel.conversationId) : null;
	const globalsAfter = await getGlobalProviderState(page);

	const noticeOk = notices.some((t) => t.startsWith("Model:") && t.includes(OPUS) && t.includes("(large)"));
	const headerOk = !!file
		&& file.header.preset_name === "large"
		&& file.header.model_id === OPUS
		&& file.header.use_extended_context === true
		&& file.header.thinking_level === "medium";
	const globalsOk = !!globalsBefore && !!globalsAfter
		&& globalsAfter.activeProvider === globalsBefore.activeProvider
		&& globalsAfter.bedrockModel === HAIKU
		&& globalsAfter.registryActive === globalsBefore.registryActive
		&& globalsAfter.registryModel === HAIKU;

	if (noticeOk && headerOk && globalsOk) {
		ctx.pass("Popover preset switch", "Notice shown, header = large/Opus/1M/medium, global provider defaults unchanged", shot);
	} else {
		ctx.fail(
			"Popover preset switch",
			`noticeOk=${noticeOk} (${JSON.stringify(notices)}), headerOk=${headerOk} (${JSON.stringify(file?.header && { preset_name: file.header.preset_name, model_id: file.header.model_id, use_extended_context: file.header.use_extended_context, thinking_level: file.header.thinking_level })}), globalsOk=${globalsOk} (before=${JSON.stringify(globalsBefore)} after=${JSON.stringify(globalsAfter)})`,
			shot,
		);
	}
}

async function testReopenRestoresRecordedSelection(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Thinking tweak keeps preset label; reopen restores the recorded selection");
	const { page } = ctx;

	if (!test1ConversationId) {
		ctx.fail("Reopen restores recorded selection", "Test 1 did not produce a conversation");
		return;
	}

	// Tweak thinking under the "large" preset (preset definition says medium).
	await invokeViewCallback(page, "onThinkingLevelChange", "high");
	await page.waitForTimeout(1_000);

	// Leave the conversation (the new chat inherits the panel selection), then
	// move the panel away to "small" so a stale-residue bug would show.
	await newConversation(page);
	await page.waitForTimeout(1_200);
	await invokeViewCallback(page, "onPresetChange", "small");
	await page.waitForTimeout(1_000);

	const file = readConversationFile(test1ConversationId);
	if (!file) {
		ctx.fail("Reopen restores recorded selection", "Test 1 conversation file not found");
		return;
	}
	const switched = await switchToConversation(page, file.filename);
	await page.waitForTimeout(1_800);
	const sel = await getSelection(page);
	const reread = readConversationFile(test1ConversationId);

	const headerOk = reread?.header.preset_name === "large" && reread.header.thinking_level === "high" && reread.header.model_id === OPUS;
	const activeOk = switched && !!sel
		&& sel.conversationId === test1ConversationId
		&& sel.presetName === "large"
		&& sel.modelId === OPUS
		&& sel.useExtendedContext === true
		&& sel.thinkingLevel === "high";

	const shot = await ctx.screenshot("02-reopen");
	if (headerOk && activeOk) {
		ctx.pass("Reopen restores recorded selection", "header + panel = large/Opus/1M with the tweaked thinking=high (preset label kept)", shot);
	} else {
		ctx.fail(
			"Reopen restores recorded selection",
			`headerOk=${headerOk} (${JSON.stringify(reread?.header && { preset_name: reread.header.preset_name, model_id: reread.header.model_id, thinking_level: reread.header.thinking_level })}), activeOk=${activeOk} (${JSON.stringify(sel)})`,
			shot,
		);
	}
}

async function testPanelsAreIndependent(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Two panels are independent");
	const { page } = ctx;

	await ensureCleanState(page);
	await newConversation(page);
	await page.waitForTimeout(1_000);
	await invokeViewCallback(page, "onPresetChange", "small", 0);
	await page.waitForTimeout(800);

	await page.evaluate(() => {
		(window as any).app.commands.executeCommandById("notor:open-secondary-chat");
	});
	await page.waitForTimeout(3_000);

	const leafCount = await page.evaluate((viewType: string) =>
		(window as any).app.workspace.getLeavesOfType(viewType).length, CHAT_VIEW_TYPE);
	if (leafCount < 2) {
		ctx.fail("Panels are independent", `Secondary chat panel did not open (leaves=${leafCount})`);
		return;
	}

	const panel1Before = await getSelection(page, 0);
	await invokeViewCallback(page, "onPresetChange", "large", 1);
	await page.waitForTimeout(1_200);
	const panel1After = await getSelection(page, 0);
	const panel2 = await getSelection(page, 1);
	const panel1Header = panel1After?.conversationId ? readConversationFile(panel1After.conversationId)?.header : null;
	const globals = await getGlobalProviderState(page);

	const shot = await ctx.screenshot("03-two-panels");
	const ok = panel2?.presetName === "large" && panel2.modelId === OPUS
		&& panel1After?.presetName === "small" && panel1After.modelId === HAIKU
		&& panel1Before?.modelId === panel1After.modelId
		&& (!panel1Header || panel1Header.model_id === HAIKU)
		&& globals?.bedrockModel === HAIKU;
	if (ok) {
		ctx.pass("Panels are independent", "panel 2 → large/Opus; panel 1 stays small/Haiku; global default unchanged", shot);
	} else {
		ctx.fail(
			"Panels are independent",
			`panel1Before=${JSON.stringify(panel1Before)} panel1After=${JSON.stringify(panel1After)} panel2=${JSON.stringify(panel2)} panel1Header.model_id=${panel1Header?.model_id} globals=${JSON.stringify(globals)}`,
			shot,
		);
	}

	// Close the secondary panel so later tests target a single panel.
	await page.evaluate((viewType: string) => {
		const leaves = (window as any).app.workspace.getLeavesOfType(viewType);
		leaves.slice(1).forEach((l: { detach: () => void }) => l.detach());
	}, CHAT_VIEW_TYPE);
	await page.waitForTimeout(1_500);
}

async function testMidTurnSwitchAppliesNextCall(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Mid-turn switch applies from the next LLM call");
	const { page } = ctx;

	await ensureCleanState(page);
	await newConversation(page);
	await page.waitForTimeout(1_000);
	await invokeViewCallback(page, "onPresetChange", "small");
	await page.waitForTimeout(800);

	// write_note requires approval (auto_approve false) → the turn pauses
	// between LLM calls, a deterministic window for a mid-turn switch.
	await sendMessage(
		page,
		`Use the write_note tool to create a note at "${SWITCH_NOTE}" with the content "hello". After it succeeds, reply with just the word done.`,
	);
	const approveVisible = await page.waitForSelector(".notor-approve-btn", { timeout: 90_000 }).then(() => true).catch(() => false);
	if (!approveVisible) {
		ctx.fail("Mid-turn switch", "write_note approval prompt never appeared", await ctx.screenshot("04-no-approval"));
		return;
	}

	await dismissNotices(page);
	await invokeViewCallback(page, "onPresetChange", "large");
	await page.waitForTimeout(500);
	const notices = await getNoticeTexts(page);
	const runningNoticeOk = notices.some((t) => t.includes("(large)") && t.includes("applies from next step"));

	await page.click(".notor-approve-btn");
	await waitForResponse(page);
	await page.waitForTimeout(1_500);

	const sel = await getSelection(page);
	const file = sel?.conversationId ? readConversationFile(sel.conversationId) : null;
	const assistant = (file?.messages ?? []).filter((m) => m.role === "assistant" && m.model_id);
	const first = assistant[0];
	const last = assistant[assistant.length - 1];

	const shot = await ctx.screenshot("04-mid-turn-switch");
	const ok = runningNoticeOk
		&& assistant.length >= 2
		&& first?.model_id === HAIKU
		&& last?.model_id === OPUS
		&& file?.header.preset_name === "large"
		&& file.header.model_id === OPUS;
	if (ok) {
		ctx.pass("Mid-turn switch", "Notice said 'applies from next step'; tool-call turn ran on Haiku, final reply on Opus; header kept large", shot);
	} else {
		ctx.fail(
			"Mid-turn switch",
			`runningNoticeOk=${runningNoticeOk} (${JSON.stringify(notices)}), assistant model_ids=${JSON.stringify(assistant.map((m) => m.model_id))}, header=${JSON.stringify(file?.header && { preset_name: file.header.preset_name, model_id: file.header.model_id })}`,
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

	await testPopoverPresetSwitch(ctx);
	await testReopenRestoresRecordedSelection(ctx);
	await testPanelsAreIndependent(ctx);
	await testMidTurnSwitchAppliesNextCall(ctx);
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
		name: "quick-settings-model-switch",
		settings,
		cleanupFiles: [SWITCH_NOTE],
	},
	tests,
);
