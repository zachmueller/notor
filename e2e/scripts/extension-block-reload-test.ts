#!/usr/bin/env npx tsx
/**
 * Extension Block Reload Persistence E2E Test (Task 6.5)
 *
 * Verifies that extension_block messages:
 *   1. Render as .notor-extension-block rows in the chat UI
 *   2. Show the source_extension label
 *   3. Persist in JSONL and re-render after plugin reload
 *   4. Render fallback_text when the block kind is unregistered
 *   5. Do not crash when the block kind is unknown (no registered renderer)
 *
 * @see specs/ZZ-misc/extension-chat-blocks-implementation-tasks.md — 6.5
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	VAULT_PATH,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_DIR = ".obsidian/plugins/notor/history/";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readHistoryFiles(): Array<{ filename: string; lines: any[] }> {
	const histDir = path.join(VAULT_PATH, HISTORY_DIR);
	if (!fs.existsSync(histDir)) return [];

	const files = fs.readdirSync(histDir).filter((f) => f.endsWith(".jsonl"));
	return files.map((filename) => {
		const content = fs.readFileSync(path.join(histDir, filename), "utf-8");
		const lines = content
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l));
		return { filename, lines };
	});
}

function findHistoryByConversationId(conversationId: string): { filename: string; lines: any[] } | null {
	const entries = readHistoryFiles();
	return entries.find((e) => e.lines[0]?._type === "conversation" && e.lines[0]?.id === conversationId) ?? null;
}

// ---------------------------------------------------------------------------
// Test 1: Render extension_block with registered kind (fallback via no registry entry)
// ---------------------------------------------------------------------------

async function testExtensionBlockRendering(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: extension_block renders as .notor-extension-block row");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };

		try {
			const orchestrator = plugin.getActiveOrchestrator();
			const hm = plugin.getHistoryManager();

			const convId = crypto.randomUUID();
			const now = new Date().toISOString();
			const blockMsgId = crypto.randomUUID();

			const conversation = {
				id: convId,
				title: "Extension Block Render Test",
				created_at: now,
				updated_at: now,
				provider_type: "bedrock",
				model_id: "test-model",
				mode: "act",
				total_input_tokens: 0,
				total_output_tokens: 0,
				estimated_cost: 0,
				is_background: false,
			};

			const messages = [
				{
					id: crypto.randomUUID(),
					conversation_id: convId,
					role: "user",
					content: "Hello",
					created_at: now,
					input_tokens: 0,
					output_tokens: 0,
					estimated_cost: 0,
				},
				{
					id: blockMsgId,
					conversation_id: convId,
					role: "extension_block",
					content: [
						{
							type: "custom_block",
							kind: "test_kind_unregistered",
							data: { message: "hello from block", count: 42 },
							fallback_text: "Test block fallback content",
						},
					],
					source_extension: "test-extension",
					created_at: now,
					input_tokens: 0,
					output_tokens: 0,
					estimated_cost: 0,
					exclude_from_compaction: false,
				},
			];

			const filename = await hm.importConversation(conversation, messages);
			await orchestrator.switchConversation(filename);

			return { success: true, convId, blockMsgId, filename };
		} catch (e: any) {
			return { error: e.message ?? String(e) };
		}
	});

	if (!result || "error" in result) {
		ctx.fail("Create and switch to conversation", `Error: ${(result as any)?.error}`);
		return;
	}

	ctx.pass("Create and switch to conversation", `Conversation ${result.convId} loaded`);

	await page.waitForTimeout(2_000);

	// Check the extension block row renders
	const blockEl = await waitForSelector(page, ".notor-extension-block", 5_000);
	if (blockEl) {
		ctx.pass("Extension block row renders", "Found .notor-extension-block element in chat");
	} else {
		const shot = await ctx.screenshot("01-no-extension-block-row");
		ctx.fail("Extension block row renders", "No .notor-extension-block element found", shot);
		return;
	}

	// Check source label is shown
	const sourceText = await page.evaluate(() => {
		const el = document.querySelector(".notor-extension-block-source");
		return el?.textContent ?? null;
	});
	if (sourceText === "test-extension") {
		ctx.pass("Source label renders", `Source label shows: "${sourceText}"`);
	} else {
		ctx.fail("Source label renders", `Expected "test-extension", got: "${sourceText}"`);
	}

	// Check unregistered kind shows fallback via collapsible
	const fallbackText = await page.evaluate(() => {
		const el = document.querySelector(".notor-extension-block-fallback");
		return el?.textContent ?? null;
	});
	if (fallbackText === "Test block fallback content") {
		ctx.pass("Fallback text renders for unregistered kind", `Fallback: "${fallbackText}"`);
	} else {
		// Also accept the toggle header showing "Unregistered block kind"
		const toggleText = await page.evaluate(() => {
			const el = document.querySelector(".notor-tool-call-toggle");
			return el?.textContent ?? null;
		});
		if (toggleText?.includes("Unregistered block kind")) {
			ctx.pass("Fallback collapsible renders for unregistered kind", `Toggle: "${toggleText}"`);
		} else {
			ctx.fail("Fallback text renders", `Expected fallback text, got: "${fallbackText}", toggle: "${toggleText}"`);
		}
	}
}

// ---------------------------------------------------------------------------
// Test 2: JSONL persistence — extension_block message written to disk
// ---------------------------------------------------------------------------

async function testExtensionBlockPersistence(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: extension_block message persists in JSONL");

	const result = await ctx.page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };

		try {
			const orchestrator = plugin.getActiveOrchestrator();
			const hm = plugin.getHistoryManager();

			const convId = crypto.randomUUID();
			const now = new Date().toISOString();

			const conversation = {
				id: convId,
				title: "Extension Block Persistence Test",
				created_at: now,
				updated_at: now,
				provider_type: "bedrock",
				model_id: "test-model",
				mode: "act",
				total_input_tokens: 0,
				total_output_tokens: 0,
				estimated_cost: 0,
				is_background: false,
			};

			const messages = [
				{
					id: crypto.randomUUID(),
					conversation_id: convId,
					role: "user",
					content: "Test persistence",
					created_at: now,
					input_tokens: 0,
					output_tokens: 0,
					estimated_cost: 0,
				},
				{
					id: crypto.randomUUID(),
					conversation_id: convId,
					role: "extension_block",
					content: [
						{
							type: "custom_block",
							kind: "memory_recalled",
							data: { memories: ["fact one", "fact two"] },
							fallback_text: "Recalled 2 memories",
						},
					],
					source_extension: "memory",
					created_at: now,
					input_tokens: 0,
					output_tokens: 0,
					estimated_cost: 0,
					exclude_from_compaction: true,
				},
			];

			await hm.importConversation(conversation, messages);
			return { success: true, convId };
		} catch (e: any) {
			return { error: e.message ?? String(e) };
		}
	});

	if (!result || "error" in result) {
		ctx.fail("Create persistence conversation", `Error: ${(result as any)?.error}`);
		return;
	}

	await ctx.page.waitForTimeout(1_000);

	// Verify JSONL on disk contains the extension_block
	const histEntry = findHistoryByConversationId(result.convId);
	if (!histEntry) {
		ctx.fail("JSONL written to disk", `No history file found for conversation ${result.convId}`);
		return;
	}
	ctx.pass("JSONL written to disk", `Found ${histEntry.filename}`);

	const blockLines = histEntry.lines.filter((l) => l._type === "message" && l.role === "extension_block");
	if (blockLines.length === 1) {
		ctx.pass("extension_block in JSONL", "Found 1 extension_block message in JSONL");
	} else {
		ctx.fail("extension_block in JSONL", `Expected 1 extension_block, found ${blockLines.length}`);
		return;
	}

	const blockLine = blockLines[0];
	const hasCustomBlock = Array.isArray(blockLine.content) &&
		blockLine.content.some((b: any) => b.type === "custom_block" && b.kind === "memory_recalled");
	if (hasCustomBlock) {
		ctx.pass("custom_block data persisted", "JSONL contains custom_block with correct kind");
	} else {
		ctx.fail("custom_block data persisted", `content: ${JSON.stringify(blockLine.content)}`);
	}

	const hasSourceExtension = blockLine.source_extension === "memory";
	if (hasSourceExtension) {
		ctx.pass("source_extension persisted", `source_extension = "${blockLine.source_extension}"`);
	} else {
		ctx.fail("source_extension persisted", `source_extension = "${blockLine.source_extension}"`);
	}

	const hasExcludeFlag = blockLine.exclude_from_compaction === true;
	if (hasExcludeFlag) {
		ctx.pass("exclude_from_compaction persisted", "exclude_from_compaction = true");
	} else {
		ctx.fail("exclude_from_compaction persisted", `exclude_from_compaction = ${blockLine.exclude_from_compaction}`);
	}
}

// ---------------------------------------------------------------------------
// Test 3: Reload — switch away and back, block re-renders from JSONL
// ---------------------------------------------------------------------------

async function testExtensionBlockReloadPersistence(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: extension_block re-renders after conversation reload");
	const { page } = ctx;

	// Create a fresh conversation with an extension_block
	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };

		try {
			const orchestrator = plugin.getActiveOrchestrator();
			const hm = plugin.getHistoryManager();

			const convId = crypto.randomUUID();
			const now = new Date().toISOString();

			const conversation = {
				id: convId,
				title: "Extension Block Reload Test",
				created_at: now,
				updated_at: now,
				provider_type: "bedrock",
				model_id: "test-model",
				mode: "act",
				total_input_tokens: 0,
				total_output_tokens: 0,
				estimated_cost: 0,
				is_background: false,
			};

			const messages = [
				{
					id: crypto.randomUUID(),
					conversation_id: convId,
					role: "user",
					content: "Test reload",
					created_at: now,
					input_tokens: 0,
					output_tokens: 0,
					estimated_cost: 0,
				},
				{
					id: crypto.randomUUID(),
					conversation_id: convId,
					role: "extension_block",
					content: [
						{
							type: "custom_block",
							kind: "reload_test_block",
							data: { value: "reload-check" },
							fallback_text: "Reload test block — should persist",
						},
					],
					source_extension: "reload-tester",
					created_at: now,
					input_tokens: 0,
					output_tokens: 0,
					estimated_cost: 0,
				},
			];

			const filename = await hm.importConversation(conversation, messages);

			// Load a second conversation so we can switch back
			const convId2 = crypto.randomUUID();
			const conversation2 = {
				id: convId2,
				title: "Temp conversation",
				created_at: now,
				updated_at: now,
				provider_type: "bedrock",
				model_id: "test-model",
				mode: "act",
				total_input_tokens: 0,
				total_output_tokens: 0,
				estimated_cost: 0,
				is_background: false,
			};
			const messages2 = [
				{
					id: crypto.randomUUID(),
					conversation_id: convId2,
					role: "user",
					content: "Temp",
					created_at: now,
					input_tokens: 0,
					output_tokens: 0,
					estimated_cost: 0,
				},
			];
			const filename2 = await hm.importConversation(conversation2, messages2);

			// Switch to temp, then switch back to main conversation
			await orchestrator.switchConversation(filename2);
			await new Promise((r) => setTimeout(r, 500));
			await orchestrator.switchConversation(filename);

			return { success: true, convId, filename };
		} catch (e: any) {
			return { error: e.message ?? String(e) };
		}
	});

	if (!result || "error" in result) {
		ctx.fail("Setup reload test conversation", `Error: ${(result as any)?.error}`);
		return;
	}
	ctx.pass("Setup reload test conversation", `Switched away and back to ${result.filename}`);

	await page.waitForTimeout(2_000);

	// Verify extension block row is present after reload
	const blockEl = await waitForSelector(page, ".notor-extension-block", 5_000);
	if (blockEl) {
		ctx.pass("Extension block persists after reload", "Found .notor-extension-block after switching back");
	} else {
		const shot = await ctx.screenshot("03-reload-missing-block");
		ctx.fail("Extension block persists after reload", "No .notor-extension-block after conversation reload", shot);
		return;
	}

	// Verify fallback text is shown (kind is unregistered, should fall back)
	const fallbackVisible = await page.evaluate(() => {
		// Either fallback text paragraph or the unregistered-kind collapsible header
		const fallback = document.querySelector(".notor-extension-block-fallback");
		const toggle = document.querySelector(".notor-tool-call-toggle");
		const toggleText = toggle?.textContent ?? "";
		return {
			hasFallback: fallback !== null,
			fallbackText: fallback?.textContent ?? null,
			hasToggle: toggleText.includes("Unregistered block kind"),
			toggleText,
		};
	});

	if (fallbackVisible.hasFallback || fallbackVisible.hasToggle) {
		ctx.pass(
			"Fallback renders after reload",
			fallbackVisible.hasFallback
				? `Fallback text: "${fallbackVisible.fallbackText}"`
				: `Toggle: "${fallbackVisible.toggleText}"`,
		);
	} else {
		ctx.fail("Fallback renders after reload", "Neither fallback text nor unregistered-kind header found");
	}
}

// ---------------------------------------------------------------------------
// Test 4: No crash on unknown block kind with no fallback_text
// ---------------------------------------------------------------------------

async function testNoFallbackTextNocrash(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: No crash when kind is unregistered and fallback_text is absent");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };

		try {
			const orchestrator = plugin.getActiveOrchestrator();
			const hm = plugin.getHistoryManager();

			const convId = crypto.randomUUID();
			const now = new Date().toISOString();

			const conversation = {
				id: convId,
				title: "No Fallback Text Test",
				created_at: now,
				updated_at: now,
				provider_type: "bedrock",
				model_id: "test-model",
				mode: "act",
				total_input_tokens: 0,
				total_output_tokens: 0,
				estimated_cost: 0,
				is_background: false,
			};

			const messages = [
				{
					id: crypto.randomUUID(),
					conversation_id: convId,
					role: "user",
					content: "Test no fallback",
					created_at: now,
					input_tokens: 0,
					output_tokens: 0,
					estimated_cost: 0,
				},
				{
					id: crypto.randomUUID(),
					conversation_id: convId,
					role: "extension_block",
					content: [
						{
							type: "custom_block",
							kind: "unknown_kind_no_fallback",
							data: { x: 1 },
							// no fallback_text
						},
					],
					source_extension: "some-ext",
					created_at: now,
					input_tokens: 0,
					output_tokens: 0,
					estimated_cost: 0,
				},
			];

			const filename = await hm.importConversation(conversation, messages);
			await orchestrator.switchConversation(filename);

			return { success: true, convId };
		} catch (e: any) {
			return { error: e.message ?? String(e) };
		}
	});

	if (!result || "error" in result) {
		ctx.fail("Setup no-fallback conversation", `Error: ${(result as any)?.error}`);
		return;
	}

	await page.waitForTimeout(2_000);

	// Verify the row renders without crashing
	const blockEl = await waitForSelector(page, ".notor-extension-block", 5_000);
	if (blockEl) {
		ctx.pass("Renders without crash (no fallback_text)", "Found .notor-extension-block with no fallback_text");
	} else {
		const shot = await ctx.screenshot("04-no-fallback-no-block");
		ctx.fail("Renders without crash (no fallback_text)", "No .notor-extension-block element found", shot);
	}

	// Verify no JS errors caused by the missing fallback
	const errors = ctx.collector.getLogsByLevel("error");
	const blockErrors = errors.filter((e) => e.source === "ChatView" || e.message?.includes("extension_block"));
	if (blockErrors.length === 0) {
		ctx.pass("No render errors logged", "Zero error-level logs from ChatView");
	} else {
		ctx.fail("No render errors logged", `${blockErrors.length} errors: ${blockErrors.map((e) => e.message).join("; ")}`);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	await testExtensionBlockRendering(ctx);
	await testExtensionBlockPersistence(ctx);
	await testExtensionBlockReloadPersistence(ctx);
	await testNoFallbackTextNocrash(ctx);
}

runTest(
	{
		name: "extension-block-reload-test",
		settings: buildDefaultSettings(),
	},
	tests,
);
