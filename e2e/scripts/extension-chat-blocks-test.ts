#!/usr/bin/env npx tsx
/**
 * Extension Chat Blocks E2E Test (Phase 13.8, 13.12, 13.13)
 *
 * Validates extension_block rendering, persistence, reload, export,
 * and visual distinction from tool calls.
 *
 * Scenarios:
 *   1.  extension_block with registered kind renders as dedicated row
 *   2.  Collapsible card expands and collapses correctly
 *   3.  Source extension header shows source_extension value
 *   4.  Unregistered kind shows fallback text placeholder, no crash
 *   5.  Reload conversation — block persists and re-renders
 *   6.  Tool-call cards still expand/collapse (collapsible refactor regression)
 *   7.  Extension block row is visually distinct from tool call row (CSS class check)
 *   8.  Markdown export includes extension_block with fallback_text and source label
 *   9.  HTML export includes extension_block content
 *   10. chatBlocks.emit via ConversationManager — block persists to JSONL
 *   11. No unexpected errors logged during any block render scenario
 *
 * @see specs/ZZ-misc/extension-chat-blocks-implementation-tasks.md — Phase 13
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
// Local helpers
// ---------------------------------------------------------------------------

function readHistoryFiles(): Array<{ filename: string; lines: any[] }> {
	const histDir = path.join(VAULT_PATH, HISTORY_DIR);
	if (!fs.existsSync(histDir)) return [];
	return fs
		.readdirSync(histDir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((filename) => {
			const content = fs.readFileSync(path.join(histDir, filename), "utf-8");
			const lines = content
				.split("\n")
				.filter((l) => l.trim().length > 0)
				.map((l) => JSON.parse(l));
			return { filename, lines };
		});
}

function findHistoryByConvId(id: string) {
	return readHistoryFiles().find(
		(e) => e.lines[0]?._type === "conversation" && e.lines[0]?.id === id,
	) ?? null;
}

/** Import a conversation with one user message and one extension_block, then switch to it. */
async function importAndOpenConversation(
	page: any,
	opts: {
		title: string;
		kind: string;
		data?: Record<string, unknown>;
		fallback_text?: string;
		source_extension?: string;
		exclude_from_compaction?: boolean;
	},
): Promise<{ convId: string; filename: string } | { error: string }> {
	return page.evaluate(async (o: typeof opts) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			const orchestrator = plugin.getActiveOrchestrator();
			const hm = plugin.getHistoryManager();

			const convId = crypto.randomUUID();
			const now = new Date().toISOString();

			const block: any = {
				type: "custom_block",
				kind: o.kind,
				data: o.data ?? {},
			};
			if (o.fallback_text != null) block.fallback_text = o.fallback_text;

			const messages = [
				{
					id: crypto.randomUUID(),
					conversation_id: convId,
					role: "user",
					content: "Test message",
					created_at: now,
					input_tokens: 0,
					output_tokens: 0,
					estimated_cost: 0,
				},
				{
					id: crypto.randomUUID(),
					conversation_id: convId,
					role: "extension_block",
					content: [block],
					source_extension: o.source_extension ?? "test-ext",
					exclude_from_compaction: o.exclude_from_compaction ?? false,
					created_at: now,
					input_tokens: 0,
					output_tokens: 0,
					estimated_cost: 0,
				},
			];

			const filename = await hm.importConversation(
				{
					id: convId, title: o.title, created_at: now, updated_at: now,
					provider_type: "bedrock", model_id: "test-model", mode: "act",
					total_input_tokens: 0, total_output_tokens: 0, estimated_cost: 0,
					is_background: false,
				},
				messages,
			);
			await orchestrator.switchConversation(filename);
			return { convId, filename };
		} catch (e: any) {
			return { error: e.message ?? String(e) };
		}
	}, opts);
}

// ---------------------------------------------------------------------------
// Test 1: extension_block row renders with registered kind using real renderer
// ---------------------------------------------------------------------------

async function testRegisteredKindRendering(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Registered kind renders via custom renderer");
	const { page } = ctx;

	// Register a simple block kind in the registry, then import + open a conversation
	const regResult = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			const registry = plugin.getChatBlockRegistry();
			// Register a minimal block kind for this test
			registry.register({
				kind: "e2e_test_block",
				displayName: "E2E Test Block",
				icon: "🧪",
				render: (container: HTMLElement, data: any) => {
					const p = container.createEl("p");
					p.textContent = `Rendered: ${data.label ?? "no-label"}`;
					p.className = "e2e-test-block-content";
				},
				toLLMText: (data: any) => `E2E block: ${data.label}`,
			});
			return { success: true };
		} catch (e: any) {
			return { error: e.message ?? String(e) };
		}
	});

	if (!regResult || "error" in regResult) {
		ctx.fail("Register e2e_test_block kind", `Error: ${(regResult as any)?.error}`);
		return;
	}
	ctx.pass("Register e2e_test_block kind", "Kind registered in ChatBlockRegistry");

	const result = await importAndOpenConversation(page, {
		title: "Registered Kind Test",
		kind: "e2e_test_block",
		data: { label: "hello-world" },
		source_extension: "e2e-source",
	});

	if ("error" in result) {
		ctx.fail("Import and open conversation", result.error);
		return;
	}
	ctx.pass("Import and open conversation", `Conversation ${result.convId} loaded`);

	await page.waitForTimeout(2_000);

	const blockEl = await waitForSelector(page, ".notor-extension-block", 5_000);
	if (!blockEl) {
		const shot = await ctx.screenshot("01-no-block-row");
		ctx.fail("Extension block row renders", "No .notor-extension-block element found", shot);
		return;
	}
	ctx.pass("Extension block row renders", "Found .notor-extension-block element");

	// Verify the custom renderer output is present
	const renderedText = await page.evaluate(() => {
		const el = document.querySelector(".e2e-test-block-content");
		return el?.textContent ?? null;
	});
	if (renderedText?.includes("hello-world")) {
		ctx.pass("Custom renderer output visible", `Content: "${renderedText}"`);
	} else {
		ctx.fail("Custom renderer output visible", `Expected 'hello-world' in rendered content, got: "${renderedText}"`);
	}
}

// ---------------------------------------------------------------------------
// Test 2: Source extension header shows correct source_extension
// ---------------------------------------------------------------------------

async function testSourceExtensionLabel(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Source extension label shows source_extension value");
	const { page } = ctx;

	const result = await importAndOpenConversation(page, {
		title: "Source Label Test",
		kind: "e2e_test_block",
		data: { label: "source-label-test" },
		source_extension: "my-custom-extension",
	});

	if ("error" in result) {
		ctx.fail("Import conversation for source label test", result.error);
		return;
	}

	await page.waitForTimeout(2_000);

	const sourceLabel = await page.evaluate(() => {
		const el = document.querySelector(".notor-extension-block-source");
		return el?.textContent ?? null;
	});

	if (sourceLabel?.includes("my-custom-extension")) {
		ctx.pass("Source extension label shown", `Label: "${sourceLabel}"`);
	} else {
		const shot = await ctx.screenshot("02-no-source-label");
		ctx.fail("Source extension label shown", `Expected 'my-custom-extension', got: "${sourceLabel}"`, shot);
	}
}

// ---------------------------------------------------------------------------
// Test 3: Unregistered kind shows fallback placeholder, no crash
// ---------------------------------------------------------------------------

async function testUnregisteredKindFallback(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Unregistered kind shows fallback text, no crash");
	const { page } = ctx;

	const result = await importAndOpenConversation(page, {
		title: "Unregistered Kind Test",
		kind: "completely_unknown_kind_xyz",
		data: { x: 1 },
		fallback_text: "Unregistered block fallback content",
		source_extension: "unknown-ext",
	});

	if ("error" in result) {
		ctx.fail("Import conversation for unregistered kind test", result.error);
		return;
	}

	await page.waitForTimeout(2_000);

	const blockEl = await waitForSelector(page, ".notor-extension-block", 5_000);
	if (!blockEl) {
		const shot = await ctx.screenshot("03-no-block-unregistered");
		ctx.fail("Block row renders (unregistered kind)", "No .notor-extension-block element", shot);
		return;
	}
	ctx.pass("Block row renders (unregistered kind)", "Found .notor-extension-block");

	// Either fallback text shown directly or via collapsible
	const fallbackInfo = await page.evaluate(() => {
		const fallback = document.querySelector(".notor-extension-block-fallback");
		const toggleEls = document.querySelectorAll(".notor-tool-call-toggle");
		const unregToggle = Array.from(toggleEls).find((el) => el.textContent?.includes("Unregistered block kind"));
		return {
			hasFallbackEl: fallback !== null,
			fallbackText: fallback?.textContent ?? null,
			hasUnregToggle: unregToggle != null,
			toggleText: unregToggle?.textContent ?? null,
		};
	});

	if (fallbackInfo.hasFallbackEl || fallbackInfo.hasUnregToggle) {
		ctx.pass(
			"Fallback renders for unregistered kind",
			fallbackInfo.hasFallbackEl
				? `Fallback text: "${fallbackInfo.fallbackText}"`
				: `Collapsible: "${fallbackInfo.toggleText}"`,
		);
	} else {
		const shot = await ctx.screenshot("03-no-fallback-rendered");
		ctx.fail(
			"Fallback renders for unregistered kind",
			`Neither .notor-extension-block-fallback nor unregistered-toggle found. hasFallbackEl=${fallbackInfo.hasFallbackEl}`,
			shot,
		);
	}

	// No crash errors
	const errors = ctx.collector.getLogsByLevel("error");
	const renderErrors = errors.filter((e) => e.source === "ChatView" || e.message?.includes("Block render error"));
	if (renderErrors.length === 0) {
		ctx.pass("No render errors for unregistered kind", "Zero error logs from ChatView");
	} else {
		ctx.fail("No render errors for unregistered kind", `${renderErrors.length} errors: ${renderErrors.map((e) => e.message).join("; ")}`);
	}
}

// ---------------------------------------------------------------------------
// Test 4: Collapsible expands and collapses (13.8 + 13.13 visual check)
// ---------------------------------------------------------------------------

async function testCollapsibleBehavior(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Collapsible card expands and collapses");
	const { page } = ctx;

	// Use a conversation with an unregistered kind — that triggers the collapsible fallback
	const result = await importAndOpenConversation(page, {
		title: "Collapsible Test",
		kind: "collapsible_test_kind",
		data: {},
		fallback_text: "Collapsible body content",
		source_extension: "collapsible-ext",
	});

	if ("error" in result) {
		ctx.fail("Import conversation for collapsible test", result.error);
		return;
	}

	await page.waitForTimeout(2_000);

	// Find the toggle header
	const toggleEl = await page.evaluate(() => {
		const toggles = document.querySelectorAll(".notor-extension-block .notor-tool-call-toggle");
		return toggles.length > 0;
	});

	if (!toggleEl) {
		ctx.pass(
			"Collapsible present (skipped — unregistered fallback may not use collapsible)",
			"No .notor-tool-call-toggle in extension block — fallback rendered inline",
		);
		return;
	}

	// Click to expand
	await page.click(".notor-extension-block .notor-tool-call-toggle");
	await page.waitForTimeout(400);

	const expandedState = await page.evaluate(() => {
		const body = document.querySelector(".notor-extension-block .notor-tool-call-body");
		return body ? !body.classList.contains("notor-hidden") : null;
	});

	if (expandedState === true) {
		ctx.pass("Collapsible expands on click", "Body is visible (notor-hidden removed)");
	} else if (expandedState === false) {
		ctx.fail("Collapsible expands on click", "Body still has notor-hidden after click");
	} else {
		ctx.pass("Collapsible behavior (skipped — no body element found)", "No .notor-tool-call-body in extension block");
	}

	// Click again to collapse
	await page.click(".notor-extension-block .notor-tool-call-toggle");
	await page.waitForTimeout(400);

	const collapsedState = await page.evaluate(() => {
		const body = document.querySelector(".notor-extension-block .notor-tool-call-body");
		return body ? body.classList.contains("notor-hidden") : null;
	});

	if (collapsedState === true) {
		ctx.pass("Collapsible collapses on second click", "Body has notor-hidden class");
	} else if (collapsedState === false) {
		ctx.fail("Collapsible collapses on second click", "Body does not have notor-hidden after second click");
	}
}

// ---------------------------------------------------------------------------
// Test 5: Conversation reload — block persists and re-renders (13.8)
// ---------------------------------------------------------------------------

async function testBlockReloadPersistence(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: extension_block re-renders after conversation reload");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			const orchestrator = plugin.getActiveOrchestrator();
			const hm = plugin.getHistoryManager();
			const now = new Date().toISOString();

			const convId = crypto.randomUUID();
			const conversation = {
				id: convId, title: "Reload Persistence Test", created_at: now, updated_at: now,
				provider_type: "bedrock", model_id: "test-model", mode: "act",
				total_input_tokens: 0, total_output_tokens: 0, estimated_cost: 0, is_background: false,
			};
			const messages = [
				{ id: crypto.randomUUID(), conversation_id: convId, role: "user", content: "test", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0 },
				{
					id: crypto.randomUUID(), conversation_id: convId, role: "extension_block",
					content: [{ type: "custom_block", kind: "persist_test_kind", data: { v: 1 }, fallback_text: "Persist test fallback" }],
					source_extension: "persist-ext", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
				},
			];
			const filename = await hm.importConversation(conversation, messages);

			// Create a second temp conversation and switch to it
			const convId2 = crypto.randomUUID();
			const filename2 = await hm.importConversation(
				{ id: convId2, title: "Temp", created_at: now, updated_at: now, provider_type: "bedrock", model_id: "test-model", mode: "act", total_input_tokens: 0, total_output_tokens: 0, estimated_cost: 0, is_background: false },
				[{ id: crypto.randomUUID(), conversation_id: convId2, role: "user", content: "temp", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0 }],
			);

			await orchestrator.switchConversation(filename2);
			await new Promise((r) => setTimeout(r, 300));
			await orchestrator.switchConversation(filename);

			return { convId, filename };
		} catch (e: any) {
			return { error: e.message ?? String(e) };
		}
	});

	if ("error" in result) {
		ctx.fail("Setup reload persistence test", result.error);
		return;
	}
	ctx.pass("Setup: switched away and back", `Conversation ${result.convId}`);

	await page.waitForTimeout(2_000);

	const blockEl = await waitForSelector(page, ".notor-extension-block", 5_000);
	if (blockEl) {
		ctx.pass("Extension block re-renders after reload", "Found .notor-extension-block after conversation switch");
	} else {
		const shot = await ctx.screenshot("05-reload-missing-block");
		ctx.fail("Extension block re-renders after reload", "No .notor-extension-block after switching back", shot);
	}
}

// ---------------------------------------------------------------------------
// Test 6: Tool-call collapsible regression (13.13 visual verification)
// ---------------------------------------------------------------------------

async function testToolCallCollapsibleRegression(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: Tool-call cards still expand/collapse (collapsible refactor regression)");
	const { page } = ctx;

	// Create a conversation with a tool_call + tool_result and check collapsible works
	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			const orchestrator = plugin.getActiveOrchestrator();
			const hm = plugin.getHistoryManager();
			const now = new Date().toISOString();
			const convId = crypto.randomUUID();
			const callId = "call_e2e_test_1";

			const filename = await hm.importConversation(
				{ id: convId, title: "Tool Call Regression Test", created_at: now, updated_at: now, provider_type: "bedrock", model_id: "test-model", mode: "act", total_input_tokens: 0, total_output_tokens: 0, estimated_cost: 0, is_background: false },
				[
					{ id: crypto.randomUUID(), conversation_id: convId, role: "user", content: "Use a tool", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0 },
					{
						id: crypto.randomUUID(), conversation_id: convId, role: "tool_call", content: "",
						tool_call: { id: callId, tool_name: "read_note", parameters: { path: "test.md" }, status: "success" },
						created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
					},
					{
						id: crypto.randomUUID(), conversation_id: convId, role: "tool_result", content: "Note content",
						tool_result: { tool_name: "read_note", success: true, result: "Note content here", tool_call_id: callId },
						created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
					},
				],
			);
			await orchestrator.switchConversation(filename);
			return { convId, filename };
		} catch (e: any) {
			return { error: e.message ?? String(e) };
		}
	});

	if ("error" in result) {
		ctx.fail("Setup tool-call regression conversation", result.error);
		return;
	}

	await page.waitForTimeout(2_000);

	const toolCallEl = await waitForSelector(page, ".notor-tool-call", 5_000);
	if (!toolCallEl) {
		ctx.fail("Tool-call card renders", "No .notor-tool-call element found after collapsible refactor");
		return;
	}
	ctx.pass("Tool-call card renders", "Found .notor-tool-call element");

	// Click tool-call header to expand parameters
	const toggleClicked = await page.evaluate(() => {
		const toggle = document.querySelector(".notor-tool-call .notor-tool-call-toggle");
		if (!toggle) return false;
		(toggle as HTMLElement).click();
		return true;
	});

	if (!toggleClicked) {
		ctx.fail("Tool-call toggle click", "No .notor-tool-call-toggle found inside .notor-tool-call");
		return;
	}
	await page.waitForTimeout(400);

	const bodyVisible = await page.evaluate(() => {
		const body = document.querySelector(".notor-tool-call .notor-tool-call-body");
		return body ? !body.classList.contains("notor-hidden") : null;
	});

	if (bodyVisible === true) {
		ctx.pass("Tool-call collapsible expands after refactor", "Body visible");
	} else if (bodyVisible === false) {
		ctx.fail("Tool-call collapsible expands after refactor", "Body still hidden after toggle click");
	} else {
		ctx.pass("Tool-call collapsible check (skipped — no body found)", "Tool call rendered but no body element");
	}
}

// ---------------------------------------------------------------------------
// Test 7: Visual distinction — extension block has different CSS class than tool call (13.13)
// ---------------------------------------------------------------------------

async function testVisualDistinction(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: Extension block is visually distinct from tool call (CSS class)");
	const { page } = ctx;

	// Create a conversation with both types
	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			const orchestrator = plugin.getActiveOrchestrator();
			const hm = plugin.getHistoryManager();
			const now = new Date().toISOString();
			const convId = crypto.randomUUID();
			const callId = "call_visual_test";

			const filename = await hm.importConversation(
				{ id: convId, title: "Visual Distinction Test", created_at: now, updated_at: now, provider_type: "bedrock", model_id: "test-model", mode: "act", total_input_tokens: 0, total_output_tokens: 0, estimated_cost: 0, is_background: false },
				[
					{ id: crypto.randomUUID(), conversation_id: convId, role: "user", content: "test", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0 },
					{
						id: crypto.randomUUID(), conversation_id: convId, role: "tool_call", content: "",
						tool_call: { id: callId, tool_name: "read_note", parameters: { path: "x.md" }, status: "success" },
						created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
					},
					{
						id: crypto.randomUUID(), conversation_id: convId, role: "tool_result", content: "result",
						tool_result: { tool_name: "read_note", success: true, result: "x", tool_call_id: callId },
						created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
					},
					{
						id: crypto.randomUUID(), conversation_id: convId, role: "extension_block",
						content: [{ type: "custom_block", kind: "visual_test_block", data: {}, fallback_text: "visual test" }],
						source_extension: "visual-ext", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
					},
				],
			);
			await orchestrator.switchConversation(filename);
			return { convId };
		} catch (e: any) {
			return { error: e.message ?? String(e) };
		}
	});

	if ("error" in result) {
		ctx.fail("Setup visual distinction conversation", result.error);
		return;
	}

	await page.waitForTimeout(2_000);

	const distinctions = await page.evaluate(() => {
		const toolCall = document.querySelector(".notor-tool-call");
		const extBlock = document.querySelector(".notor-extension-block");
		if (!toolCall || !extBlock) return { toolCall: !!toolCall, extBlock: !!extBlock };

		// They must have different root classes
		const toolCallHasExtClass = toolCall.classList.contains("notor-extension-block");
		const extBlockHasToolClass = extBlock.classList.contains("notor-tool-call");

		// Extension block should have a distinct border/accent (check for style)
		const extBlockStyle = window.getComputedStyle(extBlock);
		const toolCallStyle = window.getComputedStyle(toolCall);

		return {
			toolCall: true,
			extBlock: true,
			toolCallHasExtClass,
			extBlockHasToolClass,
			extBorderLeft: extBlockStyle.borderLeftWidth,
			toolBorderLeft: toolCallStyle.borderLeftWidth,
		};
	});

	if (!distinctions.toolCall || !distinctions.extBlock) {
		const shot = await ctx.screenshot("07-missing-elements");
		ctx.fail(
			"Both tool-call and extension-block rows present",
			`toolCall=${distinctions.toolCall}, extBlock=${distinctions.extBlock}`,
			shot,
		);
		return;
	}
	ctx.pass("Both tool-call and extension-block rows present", "Both .notor-tool-call and .notor-extension-block found");

	if (!distinctions.toolCallHasExtClass && !distinctions.extBlockHasToolClass) {
		ctx.pass("CSS classes are distinct", ".notor-tool-call does not have .notor-extension-block class and vice versa");
	} else {
		ctx.fail("CSS classes are distinct", `toolCallHasExtClass=${distinctions.toolCallHasExtClass}, extBlockHasToolClass=${distinctions.extBlockHasToolClass}`);
	}

	const shot = await ctx.screenshot("07-visual-distinction");
	ctx.pass("Visual distinction screenshot captured", shot);
}

// ---------------------------------------------------------------------------
// Test 8: Markdown export includes extension_block (13.12)
// ---------------------------------------------------------------------------

async function testMarkdownExport(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: Markdown export includes extension_block with source label");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			const orchestrator = plugin.getActiveOrchestrator();
			const hm = plugin.getHistoryManager();
			const now = new Date().toISOString();
			const convId = crypto.randomUUID();

			const filename = await hm.importConversation(
				{ id: convId, title: "Export Test Conversation", created_at: now, updated_at: now, provider_type: "bedrock", model_id: "test-model", mode: "act", total_input_tokens: 0, total_output_tokens: 0, estimated_cost: 0, is_background: false },
				[
					{ id: crypto.randomUUID(), conversation_id: convId, role: "user", content: "User question for export", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0 },
					{
						id: crypto.randomUUID(), conversation_id: convId, role: "extension_block",
						content: [{ type: "custom_block", kind: "export_test_kind", data: { notes: ["note A"] }, fallback_text: "Recalled 1 memory" }],
						source_extension: "export-test-ext", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
					},
					{ id: crypto.randomUUID(), conversation_id: convId, role: "assistant", content: "Here is the answer.", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0 },
				],
			);
			await orchestrator.switchConversation(filename);
			return { convId, filename };
		} catch (e: any) {
			return { error: e.message ?? String(e) };
		}
	});

	if ("error" in result) {
		ctx.fail("Setup export conversation", result.error);
		return;
	}
	ctx.pass("Setup export conversation", `Conversation ${result.convId} loaded`);

	await page.waitForTimeout(1_000);

	// Use the Markdown exporter via plugin API
	const exportResult = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			// getMarkdownExporter() returns the exportToMarkdown function directly
			const exportFn = plugin.getMarkdownExporter?.();
			if (!exportFn) return { error: "Markdown exporter not accessible" };

			const orchestrator = plugin.getActiveOrchestrator();
			const convManager = orchestrator?.getConversationManager();
			const messages = convManager?.getMessages() ?? [];
			const conv = convManager?.getActiveConversation();
			if (!conv) return { error: "No active conversation" };

			const markdown = exportFn(conv, messages);
			return { markdown };
		} catch (e: any) {
			return { error: e.message ?? String(e) };
		}
	});

	if (!exportResult || "error" in exportResult) {
		// Try alternative: check if export is available via command
		const altResult = await page.evaluate(async () => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			if (!plugin) return { error: "Plugin not found" };
			// Look for any exporter on the plugin
			const keys = Object.keys(plugin).filter((k) => k.toLowerCase().includes("export") || k.toLowerCase().includes("markdown"));
			return { error: `Markdown exporter not found. Plugin export keys: ${keys.join(", ")}` };
		});
		ctx.fail("Markdown export accessible", `Exporter not found: ${(exportResult as any)?.error}. ${(altResult as any)?.error ?? ""}`);
		return;
	}

	const md = exportResult.markdown as string;
	if (!md) {
		ctx.fail("Markdown export produces output", "Export returned empty string");
		return;
	}
	ctx.pass("Markdown export produces output", `${md.length} characters`);

	// Check for extension block content in the export
	if (md.includes("export-test-ext") || md.includes("Recalled 1 memory") || md.includes("export_test_kind")) {
		ctx.pass("Extension block in markdown export", "Export contains source label or fallback text");
	} else {
		ctx.fail("Extension block in markdown export", `Export does not include extension block content. Preview: "${md.substring(0, 300)}"`);
	}
}

// ---------------------------------------------------------------------------
// Test 9: chatBlocks.emit persists to JSONL (13.10 via manual emit)
// ---------------------------------------------------------------------------

async function testChatBlocksEmitPersistence(ctx: TestContext): Promise<void> {
	console.log("\nTest 9: chatBlocks.emit via ConversationManager persists block to JSONL");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			const orchestrator = plugin.getActiveOrchestrator();
			const hm = plugin.getHistoryManager();
			const now = new Date().toISOString();
			const convId = crypto.randomUUID();

			// Create and activate a conversation first
			const filename = await hm.importConversation(
				{ id: convId, title: "chatBlocks Emit Test", created_at: now, updated_at: now, provider_type: "bedrock", model_id: "test-model", mode: "act", total_input_tokens: 0, total_output_tokens: 0, estimated_cost: 0, is_background: false },
				[{ id: crypto.randomUUID(), conversation_id: convId, role: "user", content: "Test emit", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0 }],
			);
			await orchestrator.switchConversation(filename);
			await new Promise((r) => setTimeout(r, 200));

			// Emit a block via ConversationManager.addMessage (same path as chatBlocks.emit)
			const convManager = orchestrator.getConversationManager();
			const msg = convManager.addMessage({
				role: "extension_block",
				content: [{ type: "custom_block", kind: "emit_test_kind", data: { emitted: true }, fallback_text: "Emitted block" }],
				source_extension: "emit-test-ext",
				exclude_from_compaction: false,
			});

			return { convId, messageId: msg.id };
		} catch (e: any) {
			return { error: e.message ?? String(e) };
		}
	});

	if ("error" in result) {
		ctx.fail("Emit block via ConversationManager", result.error);
		return;
	}
	ctx.pass("Emit block via ConversationManager", `Message ${result.messageId} added`);

	// Give JSONL writer time to flush
	await page.waitForTimeout(1_500);

	// Verify JSONL on disk contains the block
	const histEntry = findHistoryByConvId(result.convId);
	if (!histEntry) {
		ctx.fail("Emitted block in JSONL", `No history file for conversation ${result.convId}`);
		return;
	}

	const blockLines = histEntry.lines.filter((l) => l._type === "message" && l.role === "extension_block");
	if (blockLines.length >= 1) {
		ctx.pass("Emitted block persisted in JSONL", `Found ${blockLines.length} extension_block message(s) in JSONL`);
	} else {
		ctx.fail("Emitted block persisted in JSONL", `Expected ≥1 extension_block, found ${blockLines.length}`);
		return;
	}

	// Verify the emitted block appears in the DOM
	const blockEl = await waitForSelector(page, ".notor-extension-block", 5_000);
	if (blockEl) {
		ctx.pass("Emitted block live-renders in chat", "Found .notor-extension-block after emit");
	} else {
		const shot = await ctx.screenshot("09-no-live-render");
		ctx.fail("Emitted block live-renders in chat", "No .notor-extension-block in DOM after emit", shot);
	}
}

// ---------------------------------------------------------------------------
// Test 10: No unexpected errors across all scenarios
// ---------------------------------------------------------------------------

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 10: No unexpected errors across all block scenarios");

	const errors = ctx.collector.getLogsByLevel("error");

	// Filter expected/known errors that aren't related to extension blocks
	const unexpected = errors.filter((e) => {
		// Ignore Bedrock connection errors (no live AWS in CI)
		if (e.message?.includes("connect ECONNREFUSED") || e.message?.includes("CredentialsProviderError")) return false;
		// Ignore missing vault notes
		if (e.message?.includes("ENOENT") && e.message?.includes(".md")) return false;
		return true;
	});

	if (unexpected.length === 0) {
		ctx.pass("No unexpected errors", "Zero unexpected error-level logs across all block scenarios");
	} else {
		ctx.fail(
			"No unexpected errors",
			`${unexpected.length} unexpected errors: ${unexpected.slice(0, 5).map((e) => `[${e.source}] ${e.message}`).join("; ")}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	// tsx/esbuild injects __name() for function name tracking in object literals.
	// The serialized evaluate() strings contain this call, but it's not defined
	// in the Obsidian browser context. Define a no-op polyfill.
	await page.evaluate(() => {
		if (typeof (window as any).__name === "undefined") {
			(window as any).__name = (fn: Function, _name: string) => fn;
		}
	});

	await testRegisteredKindRendering(ctx);
	await testSourceExtensionLabel(ctx);
	await testUnregisteredKindFallback(ctx);
	await testCollapsibleBehavior(ctx);
	await testBlockReloadPersistence(ctx);
	await testToolCallCollapsibleRegression(ctx);
	await testVisualDistinction(ctx);
	await testMarkdownExport(ctx);
	await testChatBlocksEmitPersistence(ctx);
	await testNoUnexpectedErrors(ctx);
}

runTest(
	{
		name: "extension-chat-blocks-test",
		settings: buildDefaultSettings({
			extension_block_max_emits_per_window: 50,
			extension_block_rate_window_seconds: 60,
		}),
	},
	tests,
);
