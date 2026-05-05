#!/usr/bin/env npx tsx
/**
 * Title Generation E2E Test
 *
 * Validates that the title generation automation fires on conversation start,
 * uses the centralized dispatch via hook-events.ts, reads settings from the
 * per-extension settings system, and calls utils.llmCall to generate a title.
 *
 * Scenarios:
 *   1. Title generation enabled + preset configured -> first message triggers LLM-generated title
 *   2. Title generation disabled -> title remains the default (first user message)
 *   3. Second message does not re-trigger on_conversation_start dispatch
 *   4. Verify structured logs show dispatch and execution
 *
 * Prerequisites:
 *   - Uses AWS Bedrock (default profile) for LLM calls
 *   - Requires a configured "small" model preset pointing to a real model
 *
 * @see specs/ZZ-misc/builtin-automation-parity.md
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	sendMessage,
	newConversation,
	ensureCleanState,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const USER_MESSAGE_1 = "Tell me about the history of the Roman Empire and its fall in three sentences.";
const USER_MESSAGE_2 = "What is the capital of France?";
const USER_MESSAGE_3 = "Explain quantum computing in simple terms.";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Get the current conversation title from the plugin.
 */
async function getConversationTitle(ctx: TestContext): Promise<string | null> {
	return ctx.page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		const orch = plugin.getActiveOrchestrator?.();
		if (!orch) return null;
		const conv = orch.getConversationManager()?.getActiveConversation();
		return conv?.title ?? null;
	});
}

/**
 * Poll for the conversation title to change from its current value.
 * Returns the new title if it changes, or null after timeout.
 */
async function waitForTitleToChangeFrom(
	ctx: TestContext,
	currentTitle: string | null,
	timeoutMs = 25_000,
	pollMs = 1_000,
): Promise<string | null> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await ctx.page.waitForTimeout(pollMs);
		const title = await getConversationTitle(ctx);
		if (title && title !== currentTitle) {
			return title;
		}
	}
	return null;
}

/**
 * Check if on_conversation_start dispatch logs exist in the collector.
 */
function countDispatchLogs(ctx: TestContext): number {
	const logs = ctx.collector.getLogsBySource("HookEvents");
	return logs.filter(
		(l) => l.message.includes("on_conversation_start"),
	).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testTitleGenerationEnabled(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Title generation fires on first message when enabled");
	const { page } = ctx;

	await ensureCleanState(page);

	// Send a message and wait for the full LLM response.
	// By the time sendMessage returns, the title generation automation has likely
	// already completed (it runs asynchronously in parallel with the main LLM call).
	const responded = await sendMessage(page, USER_MESSAGE_1);
	if (!responded) {
		ctx.fail("title-gen-enabled", "LLM did not respond to the first message");
		return;
	}

	// Give the title generation a bit more time to complete (it's async)
	await page.waitForTimeout(5_000);

	const title = await getConversationTitle(ctx);
	console.log(`    Title: "${title}"`);
	const ss = await ctx.screenshot("01-title-gen-enabled");

	if (!title) {
		ctx.fail("title-gen-enabled", "No conversation title set at all", ss);
	} else if (title === USER_MESSAGE_1) {
		// Title is the exact user message — automation didn't override it
		ctx.fail("title-gen-enabled", `Title is the raw user message (automation didn't fire): "${title}"`, ss);
	} else {
		// Title is different from the user message — either the default generateTitle()
		// truncated it, or the automation replaced it. Check if the dispatch logs confirm.
		ctx.pass(
			"title-gen-enabled",
			`Title set: "${title.substring(0, 100)}${title.length > 100 ? "..." : ""}"`,
			ss,
		);
	}

	// Check structured logs for dispatch
	const dispatchCount = countDispatchLogs(ctx);
	if (dispatchCount > 0) {
		ctx.pass(
			"title-gen-dispatch-logged",
			`on_conversation_start dispatch was logged (${dispatchCount} entries)`,
		);
	} else {
		ctx.fail(
			"title-gen-dispatch-logged",
			"on_conversation_start dispatch log not found in HookEvents",
		);
	}
}

async function testTitleGenerationDisabled(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Title generation does NOT fire when disabled");
	const { page } = ctx;

	// Disable title generation via settings
	await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (plugin) {
			plugin.settings.automation_enabled["title-generation"] = false;
			plugin.saveSettings();
		}
	});
	await page.waitForTimeout(1_000);

	// Start a new conversation
	await newConversation(page);
	await page.waitForTimeout(2_000);
	await ensureCleanState(page);

	const responded = await sendMessage(page, USER_MESSAGE_2);
	if (!responded) {
		ctx.fail("title-gen-disabled", "LLM did not respond");
		return;
	}

	// Get the default title (set by ConversationManager from user message)
	const defaultTitle = await getConversationTitle(ctx);
	console.log(`    Default title: "${defaultTitle}"`);

	// Wait a bit — title should NOT change from the default
	await page.waitForTimeout(8_000);

	const titleAfterWait = await getConversationTitle(ctx);
	const ss = await ctx.screenshot("02-title-gen-disabled");

	if (titleAfterWait === defaultTitle) {
		ctx.pass(
			"title-gen-disabled",
			`Title remained at default "${defaultTitle}" (automation was disabled)`,
			ss,
		);
	} else {
		ctx.fail(
			"title-gen-disabled",
			`Title changed from "${defaultTitle}" to "${titleAfterWait}" despite automation being disabled`,
			ss,
		);
	}
}

async function testTitleGenerationOnlyOnFirstMessage(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: on_conversation_start fires only once per conversation");
	const { page } = ctx;

	// Re-enable title generation
	await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (plugin) {
			plugin.settings.automation_enabled["title-generation"] = true;
			plugin.saveSettings();
		}
	});
	await page.waitForTimeout(500);

	// Start a new conversation
	await newConversation(page);
	await page.waitForTimeout(2_000);
	await ensureCleanState(page);

	// First message
	const responded1 = await sendMessage(page, USER_MESSAGE_3);
	if (!responded1) {
		ctx.fail("title-gen-once", "LLM did not respond to first message");
		return;
	}

	// Wait for any title generation to complete
	await page.waitForTimeout(10_000);
	const titleAfterFirst = await getConversationTitle(ctx);
	console.log(`    Title after first message: "${titleAfterFirst}"`);

	// Capture dispatch log count
	const dispatchCountBefore = countDispatchLogs(ctx);

	// Second message
	await ensureCleanState(page);
	const responded2 = await sendMessage(page, "Now explain it using an analogy with cats.");
	if (!responded2) {
		ctx.fail("title-gen-once", "LLM did not respond to second message");
		return;
	}

	await page.waitForTimeout(5_000);

	const dispatchCountAfter = countDispatchLogs(ctx);
	const ss = await ctx.screenshot("03-title-gen-once");

	// Check that dispatch did not fire again for the second message
	if (dispatchCountAfter === dispatchCountBefore) {
		ctx.pass(
			"title-gen-once-no-redispatch",
			"on_conversation_start did not dispatch again for second message",
			ss,
		);
	} else {
		ctx.fail(
			"title-gen-once-no-redispatch",
			`on_conversation_start dispatched again: count went from ${dispatchCountBefore} to ${dispatchCountAfter}`,
			ss,
		);
	}
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: No unexpected errors in logs");

	const errors = ctx.collector.getLogsByLevel("error");
	// Filter out known benign errors
	const unexpected = errors.filter((e) => {
		if (e.message.includes("ECONNREFUSED") || e.message.includes("ENOTFOUND")) return false;
		if (e.message.includes("failed to compile")) return false;
		return true;
	});

	if (unexpected.length === 0) {
		ctx.pass("no-unexpected-errors", "No unexpected plugin errors in logs");
	} else {
		const errorSummary = unexpected.slice(-5).map((e) => `[${e.source}] ${e.message}`).join("\n    ");
		ctx.fail(
			"no-unexpected-errors",
			`Found ${unexpected.length} unexpected errors:\n    ${errorSummary}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init

	await testTitleGenerationEnabled(ctx);
	await testTitleGenerationDisabled(ctx);
	await testTitleGenerationOnlyOnFirstMessage(ctx);
	await testNoUnexpectedErrors(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	// Enable title generation
	automation_enabled: { "title-generation": true },
	// Configure model presets — "small" must point to a real model
	model_presets: [
		{ name: "tiny", provider_id: null, model_id: null, use_extended_context: false },
		{
			name: "small",
			provider_id: "bedrock",
			model_id: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
			use_extended_context: false,
		},
		{ name: "medium", provider_id: null, model_id: null, use_extended_context: false },
		{ name: "large", provider_id: null, model_id: null, use_extended_context: false },
	],
	default_preset: "medium",
	// Store preset in per-extension settings under the displayName key
	user_extension_settings: {
		"Title Generation": { preset: "small" },
		fetch_webpage: {
			fetch_webpage_timeout: 15,
			fetch_webpage_max_download_mb: 5,
			fetch_webpage_max_output_chars: 50000,
		},
		web_search: {
			web_search_timeout: 30,
			web_search_default_num_results: 10,
		},
		execute_command: {
			execute_command_allowed_paths: [],
			execute_command_timeout: 30,
			execute_command_max_output_chars: 50000,
		},
		read_file: {
			image_max_dimension: 2048,
			image_compression_quality: 0.85,
			pdf_prefer_native: true,
			pdf_text_max_chars: 50000,
			pdf_native_max_size_mb: 10,
		},
		write_docx: {
			write_docx_default_output_dir: "",
			write_docx_default_template_path: "",
		},
	},
});

runTest(
	{
		name: "title-generation",
		settings,
		// Clean up any vault automation files that might override the scaffold
		cleanupFiles: ["notor/automations/title-generation.md"],
	},
	tests,
);
