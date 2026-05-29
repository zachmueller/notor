#!/usr/bin/env npx tsx
/**
 * Opus 4.8 Thinking (Adaptive + Effort) E2E Test
 *
 * Live-Bedrock smoke test for the Opus 4.8 thinking fix. Opus 4.8 rejects
 * `thinking.type=enabled` and requires `thinking.type=adaptive` plus
 * `output_config.effort`. This test confirms the real Bedrock round-trip is
 * accepted (no rejection error) and that thinking renders, while Opus 4.6
 * (adaptive-only, no effort) keeps working.
 *
 * Scenarios:
 *   1. Opus 4.8 + thinking High → no "thinking.type.enabled is not supported"
 *      rejection error from Bedrock (the bug being fixed)
 *   2. Opus 4.8 + thinking High → a substantive, on-topic answer to a hard
 *      multi-step reasoning prompt (request accepted AND fully processed)
 *   3. Orchestrator active thinking level is propagated as "high" from the preset
 *   4. Regression: switching to an Opus 4.6 preset still works (adaptive-only,
 *      no rejection error)
 *
 * Note: the wire-level shape (thinking:{type:"adaptive"} + output_config.effort)
 * is covered by unit tests in src/providers/thinking-config.test.ts — it is not
 * inspectable from the renderer. This test verifies the live behavior instead.
 *
 * Observed: in adaptive mode Opus 4.8 returns its reasoning as a *signed
 * (encrypted) reasoningContent block* with no plaintext text deltas, so no
 * thinking block renders in the UI even though the model genuinely reasoned.
 * That is why Test 2 asserts a substantive answer rather than a rendered
 * thinking block. (Opus 4.6 returns plaintext reasoning, which does render.)
 *
 * @see src/providers/thinking-config.ts — resolveAnthropicThinking
 * @see src/providers/bedrock-provider.ts — output_config injection
 * @see src/providers/model-metadata.ts — supportsEffortThinking
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	sendMessage,
	newConversation,
	ensureCleanState,
	writeCleanWorkspace,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const OPUS_48_MODEL_ID = "global.anthropic.claude-opus-4-8";
const OPUS_46_MODEL_ID = "us.anthropic.claude-opus-4-6-v1";

const THINKING_BLOCK_SELECTOR = ".notor-thinking-block";
const CHAT_ERROR_SELECTOR = ".notor-chat-error";
const SETTINGS_BTN_SELECTOR = ".notor-chat-header-btn[aria-label='Chat settings']";
const PRESET_SELECT_SELECTOR = ".notor-preset-section select.notor-settings-select";

// Substrings that identify the specific Opus 4.8 thinking-config rejection.
const REJECTION_MARKERS = [
	"thinking.type.enabled",
	"is not supported for this model",
];

// ---------------------------------------------------------------------------
// Local helpers (test-specific only)
// ---------------------------------------------------------------------------

/** Collect the text of every chat error currently rendered in the DOM. */
async function getChatErrorTexts(ctx: TestContext): Promise<string[]> {
	return ctx.page.$$eval(CHAT_ERROR_SELECTOR, (els) =>
		els.map((e) => (e.textContent ?? "").trim()).filter((t) => t.length > 0),
	);
}

/** Find any rendered error that matches the Opus 4.8 thinking rejection. */
function findRejectionError(errorTexts: string[]): string | undefined {
	return errorTexts.find((t) =>
		REJECTION_MARKERS.some((m) => t.toLowerCase().includes(m.toLowerCase())),
	);
}

/**
 * Switch the active model preset via the chat settings popover. Returns true if
 * the preset option was found and selected. Mirrors the popover DOM in
 * src/ui/settings-popover.ts (option value === preset name).
 */
async function selectPreset(ctx: TestContext, presetName: string): Promise<boolean> {
	const { page } = ctx;
	const settingsBtn = await page.$(SETTINGS_BTN_SELECTOR);
	if (!settingsBtn) return false;

	await settingsBtn.click();
	await page.waitForTimeout(1_500);

	const selected = await page.evaluate(
		({ selector, name }) => {
			const select = document.querySelector(selector) as HTMLSelectElement | null;
			if (!select) return false;
			const opt = Array.from(select.options).find((o) => o.value === name);
			if (!opt || opt.disabled) return false;
			select.value = opt.value;
			select.dispatchEvent(new Event("change", { bubbles: true }));
			return true;
		},
		{ selector: PRESET_SELECT_SELECTOR, name: presetName },
	);

	await page.waitForTimeout(1_500);

	// Close popover
	await settingsBtn.click();
	await page.waitForTimeout(500);

	return selected;
}

/** Read the orchestrator's active thinking level via the plugin instance. */
async function getActiveThinkingLevel(
	ctx: TestContext,
): Promise<{ level: string | null } | { error: string }> {
	return ctx.page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "PLUGIN_NOT_FOUND" };
		const orchestrators = plugin._orchestrators;
		if (!orchestrators || orchestrators.size === 0) return { error: "NO_ORCHESTRATORS" };
		const orch = orchestrators.values().next().value;
		if (!orch || typeof orch.getActiveThinkingLevel !== "function") {
			return { error: "GETTER_NOT_FOUND" };
		}
		return { level: orch.getActiveThinkingLevel() };
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testOpus48NoRejectionError(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Opus 4.8 + High thinking — no thinking.type.enabled rejection");
	const { page } = ctx;

	await ensureCleanState(page);
	await newConversation(page);
	await page.waitForTimeout(1_000);

	// A genuinely hard, multi-step reasoning prompt so adaptive thinking actually
	// engages at effort=high — a trivial prompt would let the model skip thinking.
	const responded = await sendMessage(
		page,
		"Solve this step by step and show your reasoning: I have three boxes labeled " +
			"'Apples', 'Oranges', and 'Apples & Oranges'. Every label is wrong. You may " +
			"draw one fruit from one box without looking inside. Which box do you draw from, " +
			"and how can you correctly relabel all three boxes from that single draw? Then, " +
			"separately, compute the 12th Fibonacci number by hand and verify it.",
	);
	await page.waitForTimeout(1_000);
	const screenshot = await ctx.screenshot("01-opus48-response");

	// Check both the rendered DOM errors and the captured structured logs for the
	// specific rejection the fix targets.
	const domErrors = await getChatErrorTexts(ctx);
	const logErrors = ctx.collector
		.getLogsByLevel("error")
		.map((e) => `${e.message} ${JSON.stringify(e.data ?? "")}`);
	const allErrors = [...domErrors, ...logErrors];

	const rejection = findRejectionError(allErrors);
	if (rejection) {
		ctx.fail(
			"Opus 4.8 no thinking rejection",
			`Bedrock rejected the thinking config: "${rejection}"`,
			screenshot,
		);
		return;
	}

	if (!responded) {
		// No response and no rejection — likely an environment issue (credentials,
		// model access). Surface any other error rather than silently passing.
		const other = domErrors[0] ?? logErrors[0] ?? "(no error captured)";
		ctx.fail(
			"Opus 4.8 no thinking rejection",
			`No response within timeout and no rejection error. Other error: "${other}". ` +
				"Check Bedrock credentials / Opus 4.8 model access in us-east-1.",
			screenshot,
		);
		return;
	}

	ctx.pass(
		"Opus 4.8 no thinking rejection",
		"Opus 4.8 responded with thinking High and Bedrock did not reject thinking.type.enabled",
		screenshot,
	);
}

async function testOpus48ProducesSubstantiveAnswer(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Opus 4.8 produces a substantive reasoned answer (request fully processed)");
	const { page } = ctx;

	// Re-use the response from Test 1 (a hard multi-step puzzle). A long, on-topic
	// answer proves the adaptive+effort request was accepted AND fully processed —
	// i.e. the model actually did the reasoning work, not just opened a stream.
	//
	// We deliberately do NOT assert a rendered thinking block here: in adaptive
	// mode Opus 4.8 returns its reasoning as a signed (encrypted) reasoningContent
	// block with no plaintext text deltas, so nothing renders in the UI even
	// though the model genuinely reasoned. The provider already renders plaintext
	// reasoning when Bedrock returns it (Format 4, reasoningContent.text), as
	// Opus 4.6 does. Thinking-block rendering is covered by thinking-rendering-test.ts;
	// wire-shape (adaptive + effort) is covered by thinking-config.test.ts.
	const answer = (await page.evaluate(() => {
		const msgs = document.querySelectorAll(
			".notor-message-assistant .notor-message-content",
		);
		const last = msgs[msgs.length - 1];
		return last?.textContent ?? "";
	})).trim();

	const screenshot = await ctx.screenshot("02-opus48-answer");
	console.log(`    Answer length: ${answer.length} chars`);

	// The classic mislabeled-boxes answer is "Apples & Oranges"; require a
	// substantive response that engages the prompt.
	const substantive = answer.length > 150;
	const onTopic = /apples|oranges|box|fibonacci|\b144\b/i.test(answer);

	if (substantive && onTopic) {
		ctx.pass(
			"Opus 4.8 substantive answer",
			`Opus 4.8 (adaptive + effort:high) returned a ${answer.length}-char on-topic answer`,
			screenshot,
		);
	} else {
		ctx.fail(
			"Opus 4.8 substantive answer",
			`Response was not substantive/on-topic (len=${answer.length}, onTopic=${onTopic}): "${answer.substring(0, 120)}"`,
			screenshot,
		);
	}
}

async function testThinkingLevelPropagated(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Active thinking level propagated as 'high' from preset");

	const result = await getActiveThinkingLevel(ctx);
	if ("error" in result) {
		ctx.fail("Thinking level propagated", `Could not read orchestrator state: ${result.error}`);
		return;
	}

	if (result.level === "high") {
		ctx.pass("Thinking level propagated", 'activeThinkingLevel = "high"');
	} else {
		ctx.fail(
			"Thinking level propagated",
			`Expected "high" but got ${JSON.stringify(result.level)}`,
		);
	}
}

async function testOpus46Regression(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Regression — Opus 4.6 (adaptive-only) still works");
	const { page } = ctx;

	await ensureCleanState(page);

	const switched = await selectPreset(ctx, "large");
	if (!switched) {
		ctx.fail(
			"Opus 4.6 regression",
			"Could not select the 'large' (Opus 4.6) preset in the settings popover",
		);
		return;
	}

	// Confirm the switch took effect at the orchestrator level.
	const active = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const orch = plugin?._orchestrators?.values?.().next?.().value;
		return {
			model: orch?.getActiveModelId?.() ?? null,
			level: orch?.getActiveThinkingLevel?.() ?? null,
		};
	});
	console.log(`    Active after switch: model=${active.model}, level=${active.level}`);

	await newConversation(page);
	await page.waitForTimeout(1_000);

	const responded = await sendMessage(page, "What is 5+7? Think step by step.");
	await page.waitForTimeout(1_000);
	const screenshot = await ctx.screenshot("04-opus46-response");

	const domErrors = await getChatErrorTexts(ctx);
	const rejection = findRejectionError(domErrors);
	if (rejection) {
		ctx.fail("Opus 4.6 regression", `Opus 4.6 unexpectedly rejected: "${rejection}"`, screenshot);
		return;
	}

	if (!responded) {
		const other = domErrors[0] ?? "(no error captured)";
		ctx.fail(
			"Opus 4.6 regression",
			`Opus 4.6 did not respond within timeout. Other error: "${other}".`,
			screenshot,
		);
		return;
	}

	const thinkingBlock = await page.$(
		".notor-message-assistant:last-child " + THINKING_BLOCK_SELECTOR,
	);
	if (!thinkingBlock) {
		ctx.fail(
			"Opus 4.6 regression",
			"Opus 4.6 responded without a thinking block — adaptive thinking not active",
			screenshot,
		);
		return;
	}

	ctx.pass(
		"Opus 4.6 regression",
		"Opus 4.6 responded with adaptive thinking and no rejection error",
		screenshot,
	);
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init

	await testOpus48NoRejectionError(ctx);
	await testOpus48ProducesSubstantiveAnswer(ctx);
	await testThinkingLevelPropagated(ctx);
	await testOpus46Regression(ctx);
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
			region: "us-east-1", model_id: OPUS_48_MODEL_ID,
		},
	],
	model_presets: [
		{ name: "tiny", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
		{ name: "small", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
		{
			name: "medium",
			provider_id: "bedrock",
			model_id: OPUS_48_MODEL_ID,
			use_extended_context: false,
			thinking_level: "high",
		},
		{
			name: "large",
			provider_id: "bedrock",
			model_id: OPUS_46_MODEL_ID,
			use_extended_context: false,
			thinking_level: "high",
		},
	],
	default_preset: "medium",
});

runTest(
	{
		name: "opus-48-thinking",
		settings,
		// Seed a clean single-panel workspace so the chat view is open at launch.
		setupVault: writeCleanWorkspace,
	},
	tests,
);
