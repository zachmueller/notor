#!/usr/bin/env npx tsx
/**
 * Title Generation E2E Test
 *
 * Validates that the title generation automation fires on conversation start,
 * uses the centralized dispatch via hook-events.ts, reads settings from the
 * per-extension settings system, and calls utils.llmCall to generate a title.
 *
 * Scenarios:
 *   1. Title generation enabled + preset configured -> first message triggers title update
 *   2. Title generation disabled -> no title generation after first message
 *   3. Second message does not re-trigger title generation (fires only once)
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
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Poll for a conversation title change from the default empty/"New conversation" state.
 * Returns the new title if detected, or null after timeout.
 */
async function waitForTitleChange(
	ctx: TestContext,
	timeoutMs = 30_000,
	pollMs = 1_000,
): Promise<string | null> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await ctx.page.waitForTimeout(pollMs);
		const title = await ctx.page.evaluate(() => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			if (!plugin) return null;
			const orch = plugin.getActiveOrchestrator?.();
			if (!orch) return null;
			const conv = orch.getConversationManager()?.getActiveConversation();
			return conv?.title ?? null;
		});
		// A generated title will be non-null and not empty
		if (title && title.length > 0) {
			return title;
		}
	}
	return null;
}

/**
 * Check if on_conversation_start dispatch logs exist in the collector.
 */
function hasDispatchLogs(ctx: TestContext): boolean {
	const logs = ctx.collector.getLogsBySource("HookEvents");
	return logs.some(
		(l) => l.message.includes("on_conversation_start") && l.message.includes("Dispatching"),
	);
}

/**
 * Check if llmCall logs exist (from the utils.llmCall recursion guard logger).
 */
function hasLlmCallActivity(ctx: TestContext): boolean {
	const logs = ctx.collector.getStructuredLogs();
	return logs.some(
		(l) => l.source === "ext:llmCall" || (l.source === "HookEvents" && l.message.includes("on_conversation_start")),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testTitleGenerationEnabled(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Title generation fires on first message when enabled");
	const { page } = ctx;

	await ensureCleanState(page);

	// Send a message that gives the LLM enough context for title generation
	const responded = await sendMessage(page, "Tell me about the history of the Roman Empire and its fall in three sentences.");
	if (!responded) {
		ctx.fail("title-gen-enabled", "LLM did not respond to the first message");
		return;
	}

	// Wait for title to update (async — title generation runs in background)
	const title = await waitForTitleChange(ctx, 20_000);
	const ss = await ctx.screenshot("01-title-gen-enabled");

	if (title) {
		ctx.pass(
			"title-gen-enabled",
			`Title was generated: "${title}"`,
			ss,
		);
	} else {
		ctx.fail(
			"title-gen-enabled",
			"No title was generated within 20s after first message",
			ss,
		);
	}

	// Check structured logs for dispatch
	if (hasDispatchLogs(ctx)) {
		ctx.pass(
			"title-gen-dispatch-logged",
			"on_conversation_start dispatch was logged by HookEvents",
		);
	} else {
		// The dispatch log may not have been emitted yet or may use a different format
		// Log all HookEvents logs for debugging
		const hookLogs = ctx.collector.getLogsBySource("HookEvents");
		console.log(`    HookEvents logs (${hookLogs.length}):`, hookLogs.map((l) => l.message).join("; "));
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

	// Clear log collector to isolate this test's logs
	const logsBefore = ctx.collector.getStructuredLogs().length;

	const responded = await sendMessage(page, "What is the capital of France?");
	if (!responded) {
		ctx.fail("title-gen-disabled", "LLM did not respond");
		return;
	}

	// Wait a bit — title generation should NOT fire
	await page.waitForTimeout(5_000);

	const title = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const orch = plugin?.getActiveOrchestrator?.();
		return orch?.getConversationManager()?.getActiveConversation()?.title ?? null;
	});

	const ss = await ctx.screenshot("02-title-gen-disabled");

	if (!title || title.length === 0) {
		ctx.pass(
			"title-gen-disabled",
			"No title was generated when automation is disabled",
			ss,
		);
	} else {
		ctx.fail(
			"title-gen-disabled",
			`Title was generated despite automation being disabled: "${title}"`,
			ss,
		);
	}
}

async function testTitleGenerationOnlyOnFirstMessage(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Title generation fires only on the first message");
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
	const responded1 = await sendMessage(page, "Explain quantum computing in simple terms.");
	if (!responded1) {
		ctx.fail("title-gen-once", "LLM did not respond to first message");
		return;
	}

	// Wait for title generation
	const title1 = await waitForTitleChange(ctx, 15_000);
	if (!title1) {
		ctx.fail("title-gen-once", "No title generated on first message");
		return;
	}
	console.log(`    Title after first message: "${title1}"`);

	// Capture dispatch logs count
	const dispatchCountBefore = ctx.collector.getLogsBySource("HookEvents").filter(
		(l) => l.message.includes("on_conversation_start"),
	).length;

	// Second message
	await ensureCleanState(page);
	const responded2 = await sendMessage(page, "Now explain it using an analogy with cats.");
	if (!responded2) {
		ctx.fail("title-gen-once", "LLM did not respond to second message");
		return;
	}

	await page.waitForTimeout(5_000);

	const title2 = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const orch = plugin?.getActiveOrchestrator?.();
		return orch?.getConversationManager()?.getActiveConversation()?.title ?? null;
	});

	const dispatchCountAfter = ctx.collector.getLogsBySource("HookEvents").filter(
		(l) => l.message.includes("on_conversation_start"),
	).length;

	const ss = await ctx.screenshot("03-title-gen-once");

	// Title should be the same (not re-generated)
	if (title2 === title1) {
		ctx.pass(
			"title-gen-once-title-stable",
			`Title remained "${title1}" after second message`,
			ss,
		);
	} else {
		// Title might change if the conversation manager updates it — that's also acceptable
		// as long as dispatch didn't re-fire
		console.log(`    Title changed from "${title1}" to "${title2}"`);
	}

	// Check that dispatch did not fire again
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
		// Connection errors from network timeouts are expected in test environments
		if (e.message.includes("ECONNREFUSED") || e.message.includes("ENOTFOUND")) return false;
		// Extension compilation errors for test fixtures
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
		{ name: "tiny", provider_type: null, model_id: null, use_extended_context: false },
		{
			name: "small",
			provider_type: "bedrock",
			model_id: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
			use_extended_context: false,
		},
		{ name: "medium", provider_type: null, model_id: null, use_extended_context: false },
		{ name: "large", provider_type: null, model_id: null, use_extended_context: false },
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

runTest({ name: "title-generation", settings }, tests);
