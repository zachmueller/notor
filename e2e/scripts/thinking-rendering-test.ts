#!/usr/bin/env npx tsx
/**
 * Thinking Rendering E2E Test
 *
 * Validates that the extended thinking / reasoning feature renders correctly
 * in the chat UI when enabled on a thinking-capable model preset.
 *
 * Scenarios:
 *   1. Thinking block renders in assistant message after LLM response completes
 *   2. Thinking block contains non-empty content
 *   3. Thinking block persists in DOM (not destroyed by finalizeAssistantMessage)
 *   4. Quick settings popover shows Thinking dropdown for thinking-capable models
 *   5. Thinking level is propagated to the orchestrator state
 *
 * @see src/providers/thinking-config.ts — thinking resolution
 * @see src/ui/chat-view.ts — appendThinkingChunk, finalizeAssistantMessage
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	sendMessage,
	waitForSelector,
	newConversation,
	ensureCleanState,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const THINKING_BLOCK_SELECTOR = ".notor-thinking-block";
const THINKING_CONTENT_SELECTOR = ".notor-thinking-content";
const THINKING_SUMMARY_SELECTOR = ".notor-thinking-block > summary";
const SETTINGS_POPOVER_SELECTOR = ".notor-settings-popover";
const SETTINGS_BTN_SELECTOR = ".notor-chat-header-btn[aria-label='Chat settings']";
const THINKING_SECTION_SELECTOR = ".notor-thinking-section";

// Use Sonnet 4.6 inference profile on Bedrock — supports thinking + adaptive
const THINKING_MODEL_ID = "us.anthropic.claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testThinkingBlockRendersAfterResponse(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Thinking block renders in assistant message after response");
	const { page } = ctx;

	await ensureCleanState(page);
	await newConversation(page);
	await page.waitForTimeout(1_000);

	// Send a simple message that should trigger thinking
	const responded = await sendMessage(page, "What is 2+2? Think step by step.");

	if (!responded) {
		const screenshot = await ctx.screenshot("01-no-response");
		ctx.fail("Thinking block renders", "LLM did not respond within timeout", screenshot);
		return;
	}

	await page.waitForTimeout(1_000);
	const screenshot = await ctx.screenshot("01-after-response");


	// Check for thinking block in the last assistant message
	const thinkingBlock = await page.$(
		".notor-message-assistant:last-child " + THINKING_BLOCK_SELECTOR
	);

	if (!thinkingBlock) {
		ctx.fail(
			"Thinking block renders",
			"No .notor-thinking-block found in the last assistant message after response completed",
			screenshot,
		);
		return;
	}

	ctx.pass("Thinking block renders", "Found .notor-thinking-block in assistant message", screenshot);
}

async function testThinkingBlockHasContent(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Thinking block contains non-empty content");
	const { page } = ctx;

	// Re-use the message from test 1 (don't send a new one)
	const thinkingContent = await page.$(
		".notor-message-assistant:last-child " + THINKING_CONTENT_SELECTOR
	);

	if (!thinkingContent) {
		const screenshot = await ctx.screenshot("02-no-thinking-content");
		ctx.fail("Thinking content exists", "No .notor-thinking-content element found", screenshot);
		return;
	}

	const text = await thinkingContent.textContent();
	const screenshot = await ctx.screenshot("02-thinking-content");

	if (!text || text.trim().length === 0) {
		ctx.fail("Thinking content non-empty", "Thinking content element is empty", screenshot);
		return;
	}

	ctx.pass(
		"Thinking content non-empty",
		`Thinking content has ${text.trim().length} chars: "${text.trim().substring(0, 100)}..."`,
		screenshot,
	);
}

async function testThinkingSummaryLabel(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Thinking block summary shows finalized 'Thought for Ns' label");
	const { page } = ctx;

	const summary = await page.$(
		".notor-message-assistant:last-child " + THINKING_SUMMARY_SELECTOR
	);

	if (!summary) {
		ctx.fail("Thinking summary label", "No <summary> element found in thinking block");
		return;
	}

	// The response has finalized, so the live "Thinking Ns" timer should now read
	// "Thought for Ns" (driven by the persisted thinking_duration_ms).
	const text = (await summary.textContent())?.trim() ?? "";
	if (/^Thought for \d+m?\s?\d*s?$/.test(text)) {
		ctx.pass("Thinking summary label", `Summary text is '${text}'`);
	} else {
		ctx.fail("Thinking summary label", `Expected 'Thought for Ns' but got '${text}'`);
	}
}

async function testThinkingPersistsAfterFinalization(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Thinking block persists after message finalization (not destroyed by empty())");
	const { page } = ctx;

	// The message from test 1 has already been finalized (response complete).
	// Verify the thinking block is still in the DOM.
	const blocks = await page.$$(
		".notor-message-assistant " + THINKING_BLOCK_SELECTOR
	);

	const screenshot = await ctx.screenshot("04-persistence");

	if (blocks.length === 0) {
		ctx.fail(
			"Thinking persists after finalization",
			"No thinking blocks found — likely destroyed by contentEl.empty()",
			screenshot,
		);
		return;
	}

	ctx.pass(
		"Thinking persists after finalization",
		`Found ${blocks.length} thinking block(s) in assistant messages`,
		screenshot,
	);
}

async function testThinkingLevelInOrchestratorState(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Thinking level is propagated to orchestrator state");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "PLUGIN_NOT_FOUND" };
		const orchestrators = plugin._orchestrators;
		if (!orchestrators || orchestrators.size === 0) return { error: `NO_ORCHESTRATORS (keys: ${Object.keys(plugin).filter(k => k.includes("orch")).join(",")})` };
		const firstOrch = orchestrators.values().next().value;
		if (!firstOrch) return { error: "NO_ORCHESTRATOR" };
		const hasGetter = typeof firstOrch.getActiveThinkingLevel === "function";
		if (!hasGetter) {
			// Try to find it in prototype
			const proto = Object.getPrototypeOf(firstOrch);
			const methods = proto ? Object.getOwnPropertyNames(proto).filter(n => n.includes("hinking")).join(",") : "no-proto";
			return { error: `GETTER_NOT_FOUND (methods with 'hinking': ${methods})` };
		}
		return { level: firstOrch.getActiveThinkingLevel() };
	});

	if ("error" in result) {
		ctx.fail("Orchestrator thinking level", result.error);
		return;
	}

	const thinkingLevel = result.level;
	if (thinkingLevel !== null) {
		ctx.pass("Orchestrator thinking level", `activeThinkingLevel = "${thinkingLevel}"`);
	} else {
		ctx.fail("Orchestrator thinking level", "activeThinkingLevel is null — not propagated from preset");
	}
}

async function testQuickSettingsThinkingDropdown(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: Quick settings popover shows Thinking dropdown");
	const { page } = ctx;

	// Open settings popover
	const settingsBtn = await page.$(SETTINGS_BTN_SELECTOR);
	if (!settingsBtn) {
		ctx.fail("Quick settings thinking dropdown", "Settings button not found");
		return;
	}

	await settingsBtn.click();
	await page.waitForTimeout(2_000);

	const screenshot = await ctx.screenshot("06-settings-popover");

	// Check for thinking section
	const thinkingSection = await page.$(SETTINGS_POPOVER_SELECTOR + " " + THINKING_SECTION_SELECTOR);
	if (!thinkingSection) {
		ctx.fail(
			"Quick settings thinking dropdown",
			"No .notor-thinking-section found in settings popover — either model doesn't support thinking or section not rendered",
			screenshot,
		);
		// Close popover
		await settingsBtn.click();
		await page.waitForTimeout(500);
		return;
	}

	// Verify it has a select element with the expected options
	const options = await page.$$eval(
		SETTINGS_POPOVER_SELECTOR + " " + THINKING_SECTION_SELECTOR + " select option",
		(opts) => opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent?.trim() })),
	);

	// Close popover
	await settingsBtn.click();
	await page.waitForTimeout(500);

	if (options.length < 4) {
		ctx.fail("Quick settings thinking dropdown", `Expected at least 4 options, got ${options.length}: ${JSON.stringify(options)}`);
		return;
	}

	const expectedLabels = ["Off", "Low", "Medium", "High"];
	const labels = options.map((o) => o.text);
	const hasAll = expectedLabels.every((l) => labels.includes(l));

	if (hasAll) {
		ctx.pass("Quick settings thinking dropdown", `Dropdown has options: ${labels.join(", ")}`, screenshot);
	} else {
		ctx.fail("Quick settings thinking dropdown", `Missing expected options. Got: ${labels.join(", ")}`, screenshot);
	}
}

async function testThinkingStoredOnMessage(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: Thinking content is persisted on message object");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "PLUGIN_NOT_FOUND" };
		const orchestrators = plugin._orchestrators;
		if (!orchestrators || orchestrators.size === 0) return { error: "NO_ORCHESTRATORS" };
		const orchestrator = orchestrators.values().next().value;
		if (!orchestrator) return { error: "NO_ORCHESTRATOR" };
		const convManager = orchestrator.getConversationManager?.();
		if (!convManager) return { error: "NO_CONV_MANAGER" };
		const messages = convManager.getMessages?.() ?? [];
		const assistantMsgs = messages.filter((m: any) => m.role === "assistant");
		if (assistantMsgs.length === 0) return { error: "NO_ASSISTANT_MESSAGES" };
		const last = assistantMsgs[assistantMsgs.length - 1];
		return {
			hasThinking: !!last.thinking,
			thinkingLength: last.thinking?.length ?? 0,
			thinkingPreview: last.thinking?.substring(0, 100) ?? null,
		};
	});

	if ("error" in result) {
		ctx.fail("Thinking stored on message", `Could not access messages: ${result.error}`);
		return;
	}

	const screenshot = await ctx.screenshot("07-message-persistence");

	if (result.hasThinking && result.thinkingLength > 0) {
		ctx.pass(
			"Thinking stored on message",
			`Message.thinking has ${result.thinkingLength} chars: "${result.thinkingPreview}..."`,
			screenshot,
		);
	} else {
		ctx.fail(
			"Thinking stored on message",
			"Message.thinking is empty or null — thinking content not persisted",
			screenshot,
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init

	await testThinkingBlockRendersAfterResponse(ctx);
	await testThinkingBlockHasContent(ctx);
	await testThinkingSummaryLabel(ctx);
	await testThinkingPersistsAfterFinalization(ctx);
	await testThinkingLevelInOrchestratorState(ctx);
	await testQuickSettingsThinkingDropdown(ctx);
	await testThinkingStoredOnMessage(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	active_provider: "bedrock",
	providers: [
		{
			id: "bedrock", type: "bedrock", enabled: true, display_name: "AWS Bedrock",
			aws_auth_method: "profile", aws_profile: "default",
			region: "us-east-1", model_id: THINKING_MODEL_ID,
		},
	],
	model_presets: [
		{ name: "tiny", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
		{ name: "small", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
		{
			name: "medium",
			provider_id: "bedrock",
			model_id: THINKING_MODEL_ID,
			use_extended_context: false,
			thinking_level: "10000",
		},
		{ name: "large", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
	],
	default_preset: "medium",
});

runTest({ name: "thinking-rendering", settings }, tests);
