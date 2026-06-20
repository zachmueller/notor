#!/usr/bin/env npx tsx
/**
 * Ask User — Multi-Select E2E Test
 *
 * Covers the MULTI-SELECT (checkbox) branch of the interaction renderer, which
 * the existing single-select `ask-user-test.ts` does not exercise. A question
 * with `multiSelect: true` renders its options as toggleable checkboxes that
 * accumulate, free text is appended as an extra selection (not mutually
 * exclusive), and the question's answer comes back as a `string[]`. The
 * persisted `interaction` block replays an array answer as multiple highlighted
 * chips with a comma-joined answer value.
 *
 * These tests drive the framework deterministically (no live model) via the
 * plugin's public `view.renderInteractionPrompt` surface and the history
 * manager's import path — the same approach as `ask-user-test.ts`.
 *
 * Scenarios:
 *   1. multiSelect options TOGGLE `--checked` (not single-select `--selected`);
 *      re-clicking a checked option un-checks it
 *   2. Multiple checks accumulate simultaneously and gate-enable Submit
 *   3. Free text is APPENDED to the checked options (cumulative, not exclusive)
 *   4. Submit resolves with a `string[]` for the multi-select question and a
 *      `string` for a co-rendered single-select question
 *   5. Replay: a persisted interaction block with an array answer renders
 *      MULTIPLE `--chosen` chips and joins the answer value with ", "
 *   6. No render errors logged
 *
 * @see src/ui/interaction-ui.ts — multi-select renderer logic
 * @see src/extensions/builtin-block-scaffolds/interaction.ts — array-answer replay
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector, writeCleanWorkspace } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local helpers (mirrors ask-user-test.ts startInteraction / readResult)
// ---------------------------------------------------------------------------

async function startInteraction(
	ctx: TestContext,
	request: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
	return ctx.page.evaluate((request) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { ok: false, error: "Plugin not found" };
		try {
			const view = plugin.getActiveOrchestrator()?.getView();
			if (!view) return { ok: false, error: "View not found" };

			const container: HTMLElement = view.getMessagesContainer();
			const card = container.createDiv({ cls: "notor-tool-call notor-e2e-ms-card" });

			const w = window as any;
			w.__msResult = undefined;
			w.__msError = undefined;
			view
				.renderInteractionPrompt(card, request, undefined)
				.then((r: unknown) => {
					w.__msResult = r;
				})
				.catch((e: Error) => {
					w.__msError = e?.message ?? String(e);
				});
			return { ok: true };
		} catch (e: any) {
			return { ok: false, error: e?.message ?? String(e) };
		}
	}, request);
}

async function readResult(ctx: TestContext): Promise<{ result: any; error: string | undefined }> {
	return ctx.page.evaluate(() => {
		const w = window as any;
		return { result: w.__msResult, error: w.__msError };
	});
}

// ---------------------------------------------------------------------------
// Test 1-4: multi-select toggle, accumulate, free-text append, array resolve
// ---------------------------------------------------------------------------

async function testMultiSelect(ctx: TestContext): Promise<void> {
	console.log("\nTest 1-4: multi-select toggling, accumulation, free-text append, array resolve");
	const { page } = ctx;

	const setup = await startInteraction(ctx, {
		type: "ask",
		id: "q-multi-select",
		questions: [
			{ question: "Pick toppings", suggestions: ["Cheese", "Onion", "Olives"], multiSelect: true },
			{ question: "Crust?", suggestions: ["Thin", "Thick"] }, // single-select
		],
	});
	if (!setup.ok) {
		ctx.fail("Render multi-select prompt", setup.error ?? "unknown");
		return;
	}

	const prompt = await waitForSelector(page, ".notor-e2e-ms-card .notor-interaction-prompt", 4_000);
	if (!prompt) {
		const shot = await ctx.screenshot("01-no-prompt");
		ctx.fail("Render multi-select prompt", "No .notor-interaction-prompt rendered", shot);
		return;
	}

	// Check Cheese (index 0) and Olives (index 2) in group 0.
	await page.evaluate(() => {
		const g = document.querySelectorAll(".notor-e2e-ms-card .notor-interaction-question-group");
		const opts = g[0]!.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		opts[0]?.click(); // Cheese
		opts[2]?.click(); // Olives
	});
	await page.waitForTimeout(200);

	const afterChecks = await page.evaluate(() => {
		const g = document.querySelectorAll(".notor-e2e-ms-card .notor-interaction-question-group");
		const opts = Array.from(g[0]!.querySelectorAll(".notor-interaction-option"));
		const submit = document.querySelector<HTMLButtonElement>(".notor-e2e-ms-card .notor-interaction-submit");
		return {
			cheeseChecked: opts[0]?.classList.contains("notor-interaction-option--checked") ?? false,
			onionChecked: opts[1]?.classList.contains("notor-interaction-option--checked") ?? false,
			olivesChecked: opts[2]?.classList.contains("notor-interaction-option--checked") ?? false,
			anySelectedClass: opts.some((o) => o.classList.contains("notor-interaction-option--selected")),
			// Q1 (multi) is answered; Q2 (single) is not → Submit must still be disabled.
			submitDisabled: submit?.disabled ?? true,
		};
	});

	if (afterChecks.cheeseChecked && afterChecks.olivesChecked && !afterChecks.onionChecked) {
		ctx.pass("Multi-select toggles --checked", "Cheese + Olives checked, Onion not");
	} else {
		ctx.fail("Multi-select toggles --checked", `cheese=${afterChecks.cheeseChecked}, olives=${afterChecks.olivesChecked}, onion=${afterChecks.onionChecked}`);
	}

	if (!afterChecks.anySelectedClass) {
		ctx.pass("Uses --checked not --selected", "No single-select --selected class on multi-select options");
	} else {
		ctx.fail("Uses --checked not --selected", "A multi-select option carried the single-select --selected class");
	}

	// Toggle Cheese off then on again → confirms toggle behavior + final state.
	const toggleCheck = await page.evaluate(() => {
		const g = document.querySelectorAll(".notor-e2e-ms-card .notor-interaction-question-group");
		const opts = g[0]!.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		opts[0]?.click(); // un-check Cheese
		const offState = opts[0]?.classList.contains("notor-interaction-option--checked") ?? true;
		opts[0]?.click(); // re-check Cheese
		const onState = opts[0]?.classList.contains("notor-interaction-option--checked") ?? false;
		return { offState, onState };
	});
	if (!toggleCheck.offState && toggleCheck.onState) {
		ctx.pass("Re-clicking toggles a check off/on", "Cheese un-checked then re-checked");
	} else {
		ctx.fail("Re-clicking toggles a check off/on", `offState=${toggleCheck.offState}, onState=${toggleCheck.onState}`);
	}

	const shot = await ctx.screenshot("01-multi-checked");

	// Append free text in the multi-select group's input.
	await page.evaluate(() => {
		const g = document.querySelectorAll(".notor-e2e-ms-card .notor-interaction-question-group");
		const input = g[0]!.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		input.value = "Mushroom";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await page.waitForTimeout(150);

	const afterFreeText = await page.evaluate(() => {
		const g = document.querySelectorAll(".notor-e2e-ms-card .notor-interaction-question-group");
		const opts = Array.from(g[0]!.querySelectorAll(".notor-interaction-option"));
		return {
			cheeseStillChecked: opts[0]?.classList.contains("notor-interaction-option--checked") ?? false,
			olivesStillChecked: opts[2]?.classList.contains("notor-interaction-option--checked") ?? false,
		};
	});
	if (afterFreeText.cheeseStillChecked && afterFreeText.olivesStillChecked) {
		ctx.pass("Free text does not clear checks", "Checked options remain after typing free text (cumulative)");
	} else {
		ctx.fail("Free text does not clear checks", `cheese=${afterFreeText.cheeseStillChecked}, olives=${afterFreeText.olivesStillChecked}`);
	}

	// Answer the single-select question (group 1) → Submit enables.
	const enabled = await page.evaluate(() => {
		const g = document.querySelectorAll(".notor-e2e-ms-card .notor-interaction-question-group");
		const opts = g[1]!.querySelectorAll<HTMLButtonElement>(".notor-interaction-option");
		opts[0]?.click(); // Thin
		const submit = document.querySelector<HTMLButtonElement>(".notor-e2e-ms-card .notor-interaction-submit");
		return {
			thinSelected: opts[0]?.classList.contains("notor-interaction-option--selected") ?? false,
			submitEnabled: !(submit?.disabled ?? true),
		};
	});
	if (enabled.thinSelected) {
		ctx.pass("Single-select uses --selected", "'Thin' got --selected (single-select branch)");
	} else {
		ctx.fail("Single-select uses --selected", "Single-select option did not gain --selected");
	}
	if (enabled.submitEnabled) {
		ctx.pass("Submit enables once all answered", "Submit enabled after both questions answered");
	} else {
		ctx.fail("Submit enables once all answered", "Submit still disabled after answering both questions");
	}

	// Submit and read back the resolved values.
	await page.evaluate(() => {
		document.querySelector<HTMLButtonElement>(".notor-e2e-ms-card .notor-interaction-submit")?.click();
	});
	await page.waitForTimeout(400);

	const { result, error } = await readResult(ctx);
	if (error) {
		ctx.fail("Submit returns array + string answers", `Promise rejected: ${error}`, shot);
	} else if (!result) {
		ctx.fail("Submit returns array + string answers", "No result resolved", shot);
	} else {
		const v0 = result.values?.[0];
		const v1 = result.values?.[1];
		// The multi-select answer is an array of the checked options plus the free
		// text appended LAST (interaction-ui.ts recomputeMulti). The relative order
		// of the two checked options follows Set insertion order — and our toggle
		// off/on of Cheese moves it after Olives — so assert membership + free-text-last
		// rather than a brittle exact order.
		const v0Ok =
			Array.isArray(v0) &&
			v0.length === 3 &&
			v0.includes("Cheese") &&
			v0.includes("Olives") &&
			v0[2] === "Mushroom"; // free text appended last
		if (result.id === "q-multi-select" && v0Ok && v1 === "Thin") {
			ctx.pass("Submit returns array + string answers", `multi=${JSON.stringify(v0)} (free text last), single="${v1}"`, shot);
		} else {
			ctx.fail("Submit returns array + string answers", `Unexpected result: ${JSON.stringify(result)}`, shot);
		}
	}

	await page.evaluate(() => document.querySelector(".notor-e2e-ms-card")?.remove());
}

// ---------------------------------------------------------------------------
// Test 5: multi-select replay — multiple --chosen chips + comma-joined answer
// ---------------------------------------------------------------------------

async function testMultiSelectReplay(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: persisted multi-select block replays multiple chosen chips + joined answer");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			const orchestrator = plugin.getActiveOrchestrator();
			const hm = plugin.getHistoryManager();
			const now = new Date().toISOString();

			const conv = {
				id: crypto.randomUUID(),
				title: "Multi-Select Replay Test",
				created_at: now,
				updated_at: now,
				provider_id: "bedrock",
				model_id: "test-model",
				mode: "act",
				total_input_tokens: 0,
				total_output_tokens: 0,
				estimated_cost: 0,
				is_background: false,
			};
			const messages = [
				{
					id: crypto.randomUUID(), conversation_id: conv.id, role: "user",
					content: "pick", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
				},
				{
					id: crypto.randomUUID(), conversation_id: conv.id, role: "extension_block",
					content: [{
						type: "custom_block",
						kind: "interaction",
						data: {
							items: [
								{ question: "Pick toppings", suggestions: ["Cheese", "Onion", "Olives"], answer: ["Cheese", "Olives"] },
							],
						},
					}],
					source_extension: "ask_user",
					created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
				},
			];
			const filename = await hm.importConversation(conv, messages);
			await orchestrator.switchConversation(filename);
			return { ok: true, filename };
		} catch (e: any) {
			return { error: e?.message ?? String(e) };
		}
	});

	if (!result || "error" in result) {
		ctx.fail("Setup multi-select replay conversation", (result as any)?.error ?? "unknown");
		return;
	}
	await page.waitForTimeout(2_000);

	const replay = await page.evaluate(() => {
		const block = document.querySelector(".notor-interaction-block");
		if (!block) return { found: false };
		const chosen = Array.from(block.querySelectorAll(".notor-interaction-chip--chosen")).map((e) => e.textContent);
		const allChips = Array.from(block.querySelectorAll(".notor-interaction-chip")).map((e) => e.textContent);
		const answerValue = block.querySelector(".notor-interaction-a-value")?.textContent ?? null;
		return { found: true, chosen, allChips, answerValue };
	});

	if (!replay.found) {
		const shot = await ctx.screenshot("05-no-replay-block");
		ctx.fail("Multi-select block renders", "No .notor-interaction-block found", shot);
		return;
	}
	const shot = await ctx.screenshot("05-replay-block");

	if (replay.chosen?.length === 2 && replay.chosen.includes("Cheese") && replay.chosen.includes("Olives")) {
		ctx.pass("Multiple chips highlighted on replay", `Chosen chips = ${JSON.stringify(replay.chosen)}`, shot);
	} else {
		ctx.fail("Multiple chips highlighted on replay", `Expected ["Cheese","Olives"], got ${JSON.stringify(replay.chosen)} (all: ${JSON.stringify(replay.allChips)})`, shot);
	}

	if (replay.answerValue === "Cheese, Olives") {
		ctx.pass("Array answer joined with ', '", `Answer value = "${replay.answerValue}"`, shot);
	} else {
		ctx.fail("Array answer joined with ', '", `Expected "Cheese, Olives", got "${replay.answerValue}"`, shot);
	}
}

// ---------------------------------------------------------------------------
// Test 6: no render errors logged
// ---------------------------------------------------------------------------

async function testNoErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: no render errors logged for multi-select interaction");
	const errors = ctx.collector.getLogsByLevel("error");
	const relevant = errors.filter(
		(e) =>
			e.source === "ChatView" ||
			e.message?.toLowerCase().includes("interaction") ||
			e.message?.toLowerCase().includes("ask"),
	);
	if (relevant.length === 0) {
		ctx.pass("No interaction render errors", "Zero relevant error-level logs");
	} else {
		ctx.fail("No interaction render errors", `${relevant.length}: ${relevant.map((e) => e.message).join("; ")}`);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // plugin init + extension/tool load

	await page.evaluate(() => {
		if (typeof (window as any).__name === "undefined") {
			(window as any).__name = (fn: unknown, _name: string) => fn;
		}
	});

	await testMultiSelect(ctx);
	await testMultiSelectReplay(ctx);
	await testNoErrors(ctx);
}

runTest(
	{
		name: "ask-user-multiselect-test",
		settings: buildDefaultSettings(),
		// Pin a clean workspace so the chat panel (deferred view in Obsidian 1.12)
		// mounts regardless of leftover workspace state from prior runs.
		setupVault: (vaultPath) => writeCleanWorkspace(vaultPath),
	},
	tests,
);
