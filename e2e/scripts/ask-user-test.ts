#!/usr/bin/env npx tsx
/**
 * Ask User / Interaction Primitive E2E Test
 *
 * Validates the `ask_user` follow-up-question tool and the underlying
 * interaction-primitive framework (utils.ask + interaction renderer + the
 * persistent `interaction` chat block).
 *
 * These tests drive the framework deterministically (no live model). Tests 1-7
 * exercise the renderer + persistence via the plugin's public surface
 * (`view.renderInteractionPrompt`, the tool/block registries, JSONL import).
 * Tests 8-9 exercise the REAL dispatch path — the route the model actually
 * uses — to guard against the auto-approve regression that made ask_user fall
 * through to the generic Approve/Reject gate (a Reject returned a blank result
 * and the questions never rendered). A separate LLM-driven test
 * (`ask-user-llm-test.ts`) covers the full model→UI→answer round-trip.
 *
 * Scenarios:
 *   1. ask_user tool is registered as a read-mode tool
 *   2. `interaction` block kind is registered in the ChatBlockRegistry
 *   3. Live prompt renders chips + free-text input; clicking a chip resolves
 *   4. Free-text submit resolves with the trimmed typed value
 *   5. allowFreeText:false hides the input (chips only)
 *   6. Aborting a pending interaction rejects and removes the prompt
 *   7. Persisted `interaction` block re-renders read-only (question + chosen
 *      answer highlighted) and survives a conversation reload
 *   8. ask_user resolves to auto_approve=true (regression guard)
 *   9. Real dispatch renders questions + returns the chosen answer (not blank),
 *      hitting the auto-approved branch rather than the manual gate
 *  10. No render errors logged
 *
 * @see src/ui/interaction-ui.ts, src/extensions/builtin-tool-scaffolds/ask-user.ts
 * @see src/extensions/builtin-block-scaffolds/interaction.ts
 * @see src/settings/defaults.ts — DEFAULT_AUTO_APPROVE.ask_user
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Render an interaction prompt into a throwaway card appended to the message
 * container, and expose the resolution promise on `window` so the test can
 * await it after driving the UI. Returns whether setup succeeded.
 */
async function startInteraction(
	ctx: TestContext,
	request: Record<string, unknown>,
	opts?: { withAbort?: boolean },
): Promise<{ ok: boolean; error?: string }> {
	return ctx.page.evaluate(
		({ request, withAbort }) => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			if (!plugin) return { ok: false, error: "Plugin not found" };
			try {
				const orchestrator = plugin.getActiveOrchestrator();
				const view = orchestrator?.getView();
				if (!view) return { ok: false, error: "View not found" };

				const container: HTMLElement = view.getMessagesContainer();
				// Fabricate a tool-call card to render into (mirrors the real path).
				const card = container.createDiv({ cls: "notor-tool-call notor-e2e-ask-card" });

				const w = window as any;
				if (withAbort) {
					w.__askAbort = new AbortController();
				}
				w.__askResult = undefined;
				w.__askError = undefined;
				view
					.renderInteractionPrompt(card, request, withAbort ? w.__askAbort.signal : undefined)
					.then((r: unknown) => {
						w.__askResult = r;
					})
					.catch((e: Error) => {
						w.__askError = e?.message ?? String(e);
					});
				return { ok: true };
			} catch (e: any) {
				return { ok: false, error: e?.message ?? String(e) };
			}
		},
		{ request, withAbort: opts?.withAbort ?? false },
	);
}

async function readResult(ctx: TestContext): Promise<{ result: any; error: string | undefined }> {
	return ctx.page.evaluate(() => {
		const w = window as any;
		return { result: w.__askResult, error: w.__askError };
	});
}

// ---------------------------------------------------------------------------
// Test 1: ask_user tool registered (read mode)
// ---------------------------------------------------------------------------

async function testToolRegistered(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: ask_user tool registered as read mode");

	const info = await ctx.page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		const registry = plugin.getToolRegistry();
		const tool = registry.get("ask_user");
		if (!tool) return { found: false };
		const schema = tool.input_schema;
		const hasQuestions = !!schema?.properties?.questions;
		return { found: true, mode: tool.mode, hasQuestions };
	});

	if ("error" in info) {
		ctx.fail("ask_user registered", info.error as string);
		return;
	}
	if (!info.found) {
		ctx.fail("ask_user registered", "Tool 'ask_user' not found in registry");
		return;
	}
	if (info.mode === "read") {
		ctx.pass("ask_user registered", "Found ask_user with mode=read");
	} else {
		ctx.fail("ask_user registered", `Expected mode=read, got mode=${info.mode}`);
	}
	if (info.hasQuestions) {
		ctx.pass("ask_user schema has questions param", "input_schema.properties.questions present");
	} else {
		ctx.fail("ask_user schema has questions param", "questions param missing from schema");
	}
}

// ---------------------------------------------------------------------------
// Test 2: interaction block kind registered
// ---------------------------------------------------------------------------

async function testBlockRegistered(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: interaction block kind registered");

	const has = await ctx.page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		const registry = plugin.getChatBlockRegistry();
		return { has: registry.has("interaction") };
	});

	if ("error" in has) {
		ctx.fail("interaction block registered", has.error as string);
		return;
	}
	if (has.has) {
		ctx.pass("interaction block registered", "ChatBlockRegistry.has('interaction') === true");
	} else {
		ctx.fail("interaction block registered", "Block kind 'interaction' not registered");
	}
}

// ---------------------------------------------------------------------------
// Test 3: multi-question prompt — all stay visible; selecting one does NOT
// submit; re-selection works; the set auto-submits only after the LAST answer.
// ---------------------------------------------------------------------------

async function testChipResolves(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: multi-question prompt persists until all answered, then auto-submits");
	const { page } = ctx;

	const setup = await startInteraction(ctx, {
		type: "ask",
		id: "q-multi",
		questions: [
			{ question: "Which color?", suggestions: ["Red", "Green", "Blue"] },
			{ question: "Anything else?" },
		],
	});
	if (!setup.ok) {
		ctx.fail("Render interaction prompt", setup.error ?? "unknown");
		return;
	}

	const prompt = await waitForSelector(page, ".notor-e2e-ask-card .notor-interaction-prompt", 4_000);
	if (!prompt) {
		const shot = await ctx.screenshot("03-no-prompt");
		ctx.fail("Render interaction prompt", "No .notor-interaction-prompt rendered", shot);
		return;
	}

	const counts = await page.evaluate(() => {
		const card = document.querySelector(".notor-e2e-ask-card");
		return {
			groups: card?.querySelectorAll(".notor-interaction-question-group").length ?? 0,
			chips: card?.querySelectorAll(".notor-interaction-chip").length ?? 0,
			inputs: card?.querySelectorAll(".notor-interaction-input").length ?? 0,
		};
	});

	if (counts.groups === 2) {
		ctx.pass("All questions rendered together", "2 question groups present");
	} else {
		ctx.fail("All questions rendered together", `Expected 2 groups, got ${counts.groups}`);
	}
	if (counts.chips === 3) {
		ctx.pass("Suggestion chips rendered", "3 chips present in Q1");
	} else {
		ctx.fail("Suggestion chips rendered", `Expected 3 chips, got ${counts.chips}`);
	}
	if (counts.inputs >= 1) {
		ctx.pass("Free-text input rendered", `${counts.inputs} input(s) present`);
	} else {
		ctx.fail("Free-text input rendered", "No free-text input found");
	}

	const shot = await ctx.screenshot("03-prompt-rendered");

	// Answer Q1 by clicking "Green" — must NOT submit (Q2 still unanswered).
	await page.evaluate(() => {
		const g = document.querySelectorAll(".notor-e2e-ask-card .notor-interaction-question-group");
		const chips = g[0]!.querySelectorAll<HTMLButtonElement>(".notor-interaction-chip");
		chips[1]?.click(); // Green
	});
	await page.waitForTimeout(300);

	const afterQ1 = await page.evaluate(() => {
		const g = document.querySelectorAll(".notor-e2e-ask-card .notor-interaction-question-group");
		const chips = Array.from(g[0]!.querySelectorAll(".notor-interaction-chip"));
		return {
			greenChosen: chips[1]?.classList.contains("notor-interaction-chip--chosen") ?? false,
			promptStillThere: !!document.querySelector(".notor-e2e-ask-card .notor-interaction-prompt"),
			result: (window as any).__askResult,
		};
	});
	if (afterQ1.greenChosen) {
		ctx.pass("Selected chip highlighted", "'Green' has --chosen after click");
	} else {
		ctx.fail("Selected chip highlighted", "Clicked chip did not gain --chosen");
	}
	if (afterQ1.promptStillThere && afterQ1.result === undefined) {
		ctx.pass("No submit until all answered", "Prompt remains and no result after answering only Q1");
	} else {
		ctx.fail("No submit until all answered", `promptStillThere=${afterQ1.promptStillThere}, result=${JSON.stringify(afterQ1.result)}`);
	}

	// Re-select Q1 → "Blue". Highlight should move; still no submit.
	await page.evaluate(() => {
		const g = document.querySelectorAll(".notor-e2e-ask-card .notor-interaction-question-group");
		const chips = g[0]!.querySelectorAll<HTMLButtonElement>(".notor-interaction-chip");
		chips[2]?.click(); // Blue
	});
	await page.waitForTimeout(300);

	const afterReselect = await page.evaluate(() => {
		const g = document.querySelectorAll(".notor-e2e-ask-card .notor-interaction-question-group");
		const chips = Array.from(g[0]!.querySelectorAll(".notor-interaction-chip"));
		return {
			greenChosen: chips[1]?.classList.contains("notor-interaction-chip--chosen") ?? false,
			blueChosen: chips[2]?.classList.contains("notor-interaction-chip--chosen") ?? false,
			result: (window as any).__askResult,
		};
	});
	if (!afterReselect.greenChosen && afterReselect.blueChosen && afterReselect.result === undefined) {
		ctx.pass("Re-selection moves highlight", "'Blue' now chosen, 'Green' cleared, still no submit");
	} else {
		ctx.fail("Re-selection moves highlight", `green=${afterReselect.greenChosen}, blue=${afterReselect.blueChosen}, result=${JSON.stringify(afterReselect.result)}`);
	}

	// Answer Q2 via free text + Enter → now all answered → auto-submit.
	await page.evaluate(() => {
		const g = document.querySelectorAll(".notor-e2e-ask-card .notor-interaction-question-group");
		const input = g[1]!.querySelector<HTMLInputElement>(".notor-interaction-input")!;
		input.value = "  done  ";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	});
	await page.waitForTimeout(400);

	const { result, error } = await readResult(ctx);
	if (error) {
		ctx.fail("Auto-submit returns all answers", `Promise rejected: ${error}`);
	} else if (result && result.id === "q-multi" && Array.isArray(result.values) && result.values[0] === "Blue" && result.values[1] === "done") {
		ctx.pass("Auto-submit returns all answers", `Resolved with values ["Blue","done"]`, shot);
	} else {
		ctx.fail("Auto-submit returns all answers", `Unexpected result: ${JSON.stringify(result)}`);
	}

	const promptGone = await page.evaluate(() => !document.querySelector(".notor-e2e-ask-card .notor-interaction-prompt"));
	if (promptGone) {
		ctx.pass("Prompt removed after final answer", "No .notor-interaction-prompt remains");
	} else {
		ctx.fail("Prompt removed after final answer", "Prompt still in DOM after all answered");
	}

	// Clean up the throwaway card
	await page.evaluate(() => document.querySelector(".notor-e2e-ask-card")?.remove());
}

// ---------------------------------------------------------------------------
// Test 4: single free-text question auto-submits on Enter (trimmed value)
// ---------------------------------------------------------------------------

async function testFreeTextResolves(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: single free-text question auto-submits on Enter with trimmed value");
	const { page } = ctx;

	const setup = await startInteraction(ctx, {
		type: "ask",
		id: "q-text",
		questions: [{ question: "Anything else?" }],
	});
	if (!setup.ok) {
		ctx.fail("Render free-text prompt", setup.error ?? "unknown");
		return;
	}

	const input = await waitForSelector(page, ".notor-e2e-ask-card .notor-interaction-input", 4_000);
	if (!input) {
		ctx.fail("Free-text input present", "No input rendered");
		return;
	}

	await page.evaluate(() => {
		const el = document.querySelector<HTMLInputElement>(".notor-e2e-ask-card .notor-interaction-input")!;
		el.value = "  hello world  ";
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	});
	await page.waitForTimeout(400);

	const { result, error } = await readResult(ctx);
	if (error) {
		ctx.fail("Free-text submit resolves", `Promise rejected: ${error}`);
	} else if (result && result.id === "q-text" && Array.isArray(result.values) && result.values[0] === "hello world") {
		ctx.pass("Free-text submit resolves", `Resolved with trimmed value "hello world"`);
	} else {
		ctx.fail("Free-text submit resolves", `Unexpected result: ${JSON.stringify(result)}`);
	}

	await page.evaluate(() => document.querySelector(".notor-e2e-ask-card")?.remove());
}

// ---------------------------------------------------------------------------
// Test 5: allowFreeText:false hides the input
// ---------------------------------------------------------------------------

async function testChipsOnly(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: allowFreeText:false renders chips only (no input)");
	const { page } = ctx;

	const setup = await startInteraction(ctx, {
		type: "ask",
		id: "q-chips-only",
		questions: [{ question: "Confirm?", suggestions: ["Yes", "No"], allowFreeText: false }],
	});
	if (!setup.ok) {
		ctx.fail("Render chips-only prompt", setup.error ?? "unknown");
		return;
	}

	await waitForSelector(page, ".notor-e2e-ask-card .notor-interaction-prompt", 4_000);
	const state = await page.evaluate(() => {
		const card = document.querySelector(".notor-e2e-ask-card");
		return {
			chips: card?.querySelectorAll(".notor-interaction-chip").length ?? 0,
			hasInput: !!card?.querySelector(".notor-interaction-input"),
		};
	});

	if (state.chips === 2 && !state.hasInput) {
		ctx.pass("Chips-only prompt", "2 chips, no free-text input");
	} else {
		ctx.fail("Chips-only prompt", `chips=${state.chips}, hasInput=${state.hasInput}`);
	}

	// Resolve and clean up
	await page.evaluate(() => {
		document.querySelector<HTMLButtonElement>(".notor-e2e-ask-card .notor-interaction-chip")?.click();
		document.querySelector(".notor-e2e-ask-card")?.remove();
	});
}

// ---------------------------------------------------------------------------
// Test 6: abort rejects the pending interaction and removes the prompt
// ---------------------------------------------------------------------------

async function testAbort(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: aborting a pending interaction rejects + cleans up");
	const { page } = ctx;

	const setup = await startInteraction(
		ctx,
		{ type: "ask", id: "q-abort", questions: [{ question: "Waiting…" }] },
		{ withAbort: true },
	);
	if (!setup.ok) {
		ctx.fail("Render abortable prompt", setup.error ?? "unknown");
		return;
	}

	await waitForSelector(page, ".notor-e2e-ask-card .notor-interaction-prompt", 4_000);

	await page.evaluate(() => {
		(window as any).__askAbort.abort();
	});
	await page.waitForTimeout(400);

	const { result, error } = await readResult(ctx);
	if (error && /cancelled/i.test(error)) {
		ctx.pass("Abort rejects interaction", `Promise rejected: "${error}"`);
	} else {
		ctx.fail("Abort rejects interaction", `Expected rejection; result=${JSON.stringify(result)}, error=${error}`);
	}

	const promptGone = await page.evaluate(() => !document.querySelector(".notor-e2e-ask-card .notor-interaction-prompt"));
	if (promptGone) {
		ctx.pass("Prompt removed on abort", "No prompt remains after abort");
	} else {
		ctx.fail("Prompt removed on abort", "Prompt still present after abort");
	}

	await page.evaluate(() => document.querySelector(".notor-e2e-ask-card")?.remove());
}

// ---------------------------------------------------------------------------
// Test 7: interaction block persists + replays read-only across reload
// ---------------------------------------------------------------------------

async function testPersistenceReplay(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: interaction block re-renders read-only and survives reload");
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
				title: "Ask User Persistence Test",
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
								{ question: "Which color?", suggestions: ["Red", "Green", "Blue"], answer: "Green" },
								{ question: "Free answer?", suggestions: [], answer: "typed reply" },
							],
						},
					}],
					source_extension: "ask_user",
					created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
				},
			];
			const filename = await hm.importConversation(conv, messages);

			// Second conversation to switch away to, then back.
			const conv2 = {
				id: crypto.randomUUID(),
				title: "Temp",
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
			const filename2 = await hm.importConversation(conv2, [{
				id: crypto.randomUUID(), conversation_id: conv2.id, role: "user",
				content: "temp", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
			}]);

			await orchestrator.switchConversation(filename);
			return { ok: true, filename, filename2 };
		} catch (e: any) {
			return { error: e?.message ?? String(e) };
		}
	});

	if (!result || "error" in result) {
		ctx.fail("Setup interaction block conversation", (result as any)?.error ?? "unknown");
		return;
	}
	await page.waitForTimeout(2_000);

	// Verify read-only replay rendering
	const replay = await page.evaluate(() => {
		const block = document.querySelector(".notor-interaction-block");
		if (!block) return { found: false };
		const questions = Array.from(block.querySelectorAll(".notor-interaction-q")).map((e) => e.textContent);
		const chosen = Array.from(block.querySelectorAll(".notor-interaction-chip--chosen")).map((e) => e.textContent);
		const answers = Array.from(block.querySelectorAll(".notor-interaction-a-value")).map((e) => e.textContent);
		return { found: true, questions, chosen, answers };
	});

	if (!replay.found) {
		const shot = await ctx.screenshot("07-no-replay-block");
		ctx.fail("Interaction block renders", "No .notor-interaction-block found", shot);
		return;
	}
	const shot = await ctx.screenshot("07-replay-block");
	ctx.pass("Interaction block renders", `Found block with ${replay.questions?.length} question(s)`, shot);

	const qsOk = replay.questions?.includes("Which color?") && replay.questions?.includes("Free answer?");
	if (qsOk) {
		ctx.pass("Questions replayed", `${JSON.stringify(replay.questions)}`);
	} else {
		ctx.fail("Questions replayed", `Got ${JSON.stringify(replay.questions)}`);
	}

	if (replay.chosen?.length === 1 && replay.chosen[0] === "Green") {
		ctx.pass("Chosen chip highlighted", "Only 'Green' has --chosen class");
	} else {
		ctx.fail("Chosen chip highlighted", `chosen chips = ${JSON.stringify(replay.chosen)}`);
	}

	if (replay.answers?.includes("Green") && replay.answers?.includes("typed reply")) {
		ctx.pass("Answers replayed", `${JSON.stringify(replay.answers)}`);
	} else {
		ctx.fail("Answers replayed", `Got ${JSON.stringify(replay.answers)}`);
	}

	// Reload: switch away and back
	await page.evaluate(async (filenames) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const orchestrator = plugin.getActiveOrchestrator();
		await orchestrator.switchConversation(filenames.filename2);
		await new Promise((r) => setTimeout(r, 500));
		await orchestrator.switchConversation(filenames.filename);
	}, { filename: result.filename, filename2: result.filename2 });
	await page.waitForTimeout(2_000);

	const afterReload = await page.evaluate(() => {
		const block = document.querySelector(".notor-interaction-block");
		if (!block) return { found: false };
		const chosen = Array.from(block.querySelectorAll(".notor-interaction-chip--chosen")).map((e) => e.textContent);
		return { found: true, chosen };
	});

	if (afterReload.found && afterReload.chosen?.[0] === "Green") {
		ctx.pass("Interaction block survives reload", "Block re-rendered with chosen chip after switch-away-and-back");
	} else {
		const shot2 = await ctx.screenshot("07-reload-missing");
		ctx.fail("Interaction block survives reload", `found=${afterReload.found}, chosen=${JSON.stringify(afterReload.chosen)}`, shot2);
	}
}

// ---------------------------------------------------------------------------
// Test 8: ask_user is auto-approved (regression guard)
//
// The original bug: ask_user was absent from DEFAULT_AUTO_APPROVE, so it fell
// through to the generic Approve/Reject gate and a Reject returned a blank
// result — the questions never rendered. This asserts the effective tool
// config resolves ask_user to auto_approve=true.
// ---------------------------------------------------------------------------

async function testAutoApproved(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: ask_user resolves to auto_approve=true");
	const { page } = ctx;

	// getEffectiveToolConfig() is only published during a response loop, so on an
	// idle panel it's null. Resolve the effective config the same way the loop
	// does (ConfigResolver.resolveEffectiveConfig, orchestrator.ts:950) — this
	// runs the real merge over settings.auto_approve without sending a message.
	const info = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		const orchestrator = plugin.getActiveOrchestrator?.();
		if (!orchestrator) return { error: "No active orchestrator" };
		const resolver = orchestrator.configResolver;
		if (!resolver?.resolveEffectiveConfig) return { error: "No config resolver" };
		const { effective } = await resolver.resolveEffectiveConfig(undefined, null, null);
		const entry = effective?.tools?.["ask_user"];
		return {
			settingValue: plugin.settings?.auto_approve?.["ask_user"] ?? null,
			effectiveAutoApprove: entry ? entry.auto_approve : null,
			enabled: entry ? entry.enabled : null,
		};
	});

	if ("error" in info) {
		ctx.fail("ask_user auto-approved", info.error as string);
		return;
	}

	if (info.settingValue === true) {
		ctx.pass("ask_user auto-approve setting", "settings.auto_approve.ask_user === true");
	} else {
		ctx.fail("ask_user auto-approve setting", `Expected true, got ${JSON.stringify(info.settingValue)}`);
	}

	if (info.effectiveAutoApprove === true) {
		ctx.pass("ask_user effective auto-approve", "Effective config resolves ask_user → auto_approve=true (no approval gate)");
	} else {
		ctx.fail(
			"ask_user effective auto-approve",
			`Expected effective auto_approve=true, got ${JSON.stringify(info.effectiveAutoApprove)} — ask_user would hit the manual Approve/Reject gate`,
		);
	}

	if (info.enabled !== false) {
		ctx.pass("ask_user enabled", "ask_user is enabled in the effective config");
	} else {
		ctx.fail("ask_user enabled", "ask_user is disabled in the effective config");
	}
}

// ---------------------------------------------------------------------------
// Test 9: full dispatch round-trip — questions render and answers flow back
//
// Drives the REAL dispatcher (the path the model uses), not renderInteractionPrompt
// directly. Asserts the call is auto-approved (approval callback sees
// autoApproved=true rather than the manual gate) and that the user's chosen
// answer is returned in the tool result — i.e. NOT the blank result the bug
// produced.
// ---------------------------------------------------------------------------

async function testRealDispatchRoundTrip(ctx: TestContext): Promise<void> {
	console.log("\nTest 9: real dispatch renders questions + returns chosen answer");
	const { page } = ctx;

	// Kick off the dispatch in the page. The interaction callback renders into a
	// real tool-call card via view.renderInteractionPrompt and resolves when we
	// click the chip below. Result + diagnostics are stashed on window.
	const setup = await page.evaluate(async () => {
		const w = window as any;
		const plugin = w.app?.plugins?.plugins?.["notor"];
		if (!plugin) return { ok: false, error: "Plugin not found" };

		const orchestrator = plugin.getActiveOrchestrator?.();
		const view = orchestrator?.getView?.();
		const dispatcher = plugin.getToolDispatcher?.();
		if (!orchestrator || !view || !dispatcher) {
			return { ok: false, error: "Missing orchestrator/view/dispatcher" };
		}

		// Resolve the effective config the way the response loop does, so the
		// dispatcher's policy check sees the real merged auto_approve for ask_user.
		const resolver = orchestrator.configResolver;
		if (!resolver?.resolveEffectiveConfig) return { ok: false, error: "No config resolver" };
		const { effective } = await resolver.resolveEffectiveConfig(undefined, null, null);
		if (!effective) return { ok: false, error: "No effective tool config" };

		const vaultRootPath = orchestrator.getVaultRootPath?.() ?? "";
		const policyCtx = {
			effectiveConfig: effective,
			mode: "act",
			domainDenylist: plugin.settings?.domain_denylist ?? [],
			vaultRootPath,
			resolveVaultPath: (p: string) => p,
		};

		// Fabricate a real tool-call card to render the prompt into.
		const container: HTMLElement = view.getMessagesContainer();
		const card = container.createDiv({ cls: "notor-tool-call notor-e2e-dispatch-card" });

		w.__dispatchAutoApprovedArg = undefined;
		w.__dispatchApprovalCalls = 0;
		w.__dispatchInteractionCalls = 0;
		w.__dispatchResult = undefined;
		w.__dispatchError = undefined;

		// Per-call approval callback — records whether it was invoked on the
		// auto-approved branch (4th arg true). Resolves "approved" either way.
		const approvalCb = (_toolCall: any, _signal: any, _messageId: any, autoApproved: any) => {
			w.__dispatchApprovalCalls += 1;
			w.__dispatchAutoApprovedArg = autoApproved === true;
			return Promise.resolve("approved");
		};

		// Per-call interaction callback — renders the prompt (TWO questions, so the
		// whole set renders in ONE card) and, on the next tick, answers both: click
		// "Green" for Q1 and type + Enter a free-text answer for Q2. The set
		// auto-submits only once both are answered.
		const interactionCb = (request: any, signal: any) => {
			w.__dispatchInteractionCalls += 1;
			const promise = view.renderInteractionPrompt(card, request, signal);
			window.setTimeout(() => {
				const groups = Array.from(
					card.querySelectorAll(".notor-interaction-question-group"),
				) as HTMLElement[];
				// Q1: click Green.
				const q1Chips = Array.from(
					groups[0]?.querySelectorAll(".notor-interaction-chip") ?? [],
				) as HTMLButtonElement[];
				const green = q1Chips.find((c) => (c.textContent ?? "").trim() === "Green");
				(green ?? q1Chips[0])?.click();
				// Q2: type + Enter to commit (this is the final answer → auto-submit).
				const q2Input = groups[1]?.querySelector(".notor-interaction-input") as HTMLInputElement | undefined;
				if (q2Input) {
					q2Input.value = "no thanks";
					q2Input.dispatchEvent(new Event("input", { bubbles: true }));
					q2Input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
				}
			}, 50);
			return promise;
		};

		dispatcher
			.dispatch(
				"ask_user",
				{
					questions: [
						{ question: "Pick a color", suggestions: ["Red", "Green"] },
						{ question: "Any notes?" },
					],
				},
				"act",
				"msg-ask-real-dispatch",
				undefined, // abortSignal
				undefined, // onProgress
				policyCtx,
				approvalCb,
				orchestrator, // sessionContext
				undefined, // approvalHookDispatcher
				interactionCb,
			)
			.then((r: any) => {
				w.__dispatchResult = r;
			})
			.catch((e: any) => {
				w.__dispatchError = e?.message ?? String(e);
			});

		return { ok: true };
	});

	if (!setup.ok) {
		ctx.fail("Real dispatch setup", setup.error ?? "unknown");
		return;
	}

	// Wait for the prompt to render, then for the dispatch to settle.
	const prompt = await waitForSelector(page, ".notor-e2e-dispatch-card .notor-interaction-prompt", 5_000);
	if (prompt) {
		ctx.pass("Dispatch renders interaction prompt", "Questions rendered via real dispatch (not an approval prompt)");
	} else {
		const shot = await ctx.screenshot("09-no-dispatch-prompt");
		ctx.fail("Dispatch renders interaction prompt", "No .notor-interaction-prompt rendered during real dispatch", shot);
	}

	// No generic Approve/Reject prompt should appear on our card.
	const approvalButtons = await page.evaluate(() => {
		const card = document.querySelector(".notor-e2e-dispatch-card");
		return {
			approve: !!card?.querySelector(".notor-approve-btn"),
			reject: !!card?.querySelector(".notor-reject-btn"),
		};
	});
	if (!approvalButtons.approve && !approvalButtons.reject) {
		ctx.pass("No Approve/Reject gate on dispatch", "Generic approval buttons absent (auto-approved)");
	} else {
		ctx.fail("No Approve/Reject gate on dispatch", `Approve=${approvalButtons.approve}, Reject=${approvalButtons.reject}`);
	}

	const shot = await ctx.screenshot("09-dispatch-prompt");

	// Poll for the dispatch to resolve (chip auto-clicked after ~50ms).
	let outcome: { result?: any; error?: string; autoApproved?: boolean; approvalCalls?: number; interactionCalls?: number } = {};
	for (let i = 0; i < 20; i++) {
		await page.waitForTimeout(250);
		outcome = await page.evaluate(() => {
			const w = window as any;
			return {
				result: w.__dispatchResult,
				error: w.__dispatchError,
				autoApproved: w.__dispatchAutoApprovedArg,
				approvalCalls: w.__dispatchApprovalCalls,
				interactionCalls: w.__dispatchInteractionCalls,
			};
		});
		if (outcome.result !== undefined || outcome.error !== undefined) break;
	}

	if (outcome.error) {
		ctx.fail("Dispatch resolves with answer", `Dispatch threw: ${outcome.error}`, shot);
	} else if (!outcome.result) {
		ctx.fail("Dispatch resolves with answer", "Dispatch did not settle within timeout", shot);
	} else {
		const result = outcome.result;
		const answers = result?.result?.answers;
		const a0 = answers?.[0]?.answer;
		const a1 = answers?.[1]?.answer;
		if (result.success === true && a0 === "Green" && a1 === "no thanks") {
			ctx.pass("Dispatch resolves with answers", `Both answers flowed back (["Green","no thanks"]) from one batched prompt`, shot);
		} else if (result.success === true && (a0 === "" || a0 == null)) {
			ctx.fail("Dispatch resolves with answers", `Regression: success but BLANK answer (${JSON.stringify(a0)}) — interaction did not flow back`, shot);
		} else {
			ctx.fail("Dispatch resolves with answers", `Unexpected result: ${JSON.stringify(result)?.substring(0, 200)}`, shot);
		}
	}

	// The approval callback must have run on the auto-approved branch.
	if (outcome.autoApproved === true) {
		ctx.pass("Dispatch hit auto-approved branch", "Approval callback invoked with autoApproved=true (not the manual gate)");
	} else {
		ctx.fail(
			"Dispatch hit auto-approved branch",
			`Expected autoApproved=true; approvalCalls=${outcome.approvalCalls}, autoApprovedArg=${JSON.stringify(outcome.autoApproved)}`,
		);
	}

	if (outcome.interactionCalls === 1) {
		ctx.pass("Interaction callback fired once", `One batched interaction call for the whole set (got ${outcome.interactionCalls})`);
	} else {
		ctx.fail("Interaction callback fired once", `Expected exactly 1 interaction call (one render for all questions), got ${outcome.interactionCalls}`);
	}

	// Clean up the throwaway card.
	await page.evaluate(() => document.querySelector(".notor-e2e-dispatch-card")?.remove());
}

// ---------------------------------------------------------------------------
// Test 11: no interaction channel → clear error, NOT blank answers
//
// This is the exact reported regression: ask_user dispatched in a context with
// no interaction channel (headless / background / sub-agent) used to coerce the
// null answers from utils.ask into "" and return success — so the model saw a
// populated answers array of empty strings and mistook it for the user's reply.
// Dispatch with interactionCallback=undefined and assert the tool now FAILS
// with an explanatory error instead of fabricating blank answers.
// ---------------------------------------------------------------------------

async function testNoChannelErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 11: no interaction channel → error (not blank answers)");
	const { page } = ctx;

	const outcome = await page.evaluate(async () => {
		const w = window as any;
		const plugin = w.app?.plugins?.plugins?.["notor"];
		if (!plugin) return { ok: false, error: "Plugin not found" };

		const orchestrator = plugin.getActiveOrchestrator?.();
		const dispatcher = plugin.getToolDispatcher?.();
		if (!orchestrator || !dispatcher) return { ok: false, error: "Missing orchestrator/dispatcher" };

		const resolver = orchestrator.configResolver;
		if (!resolver?.resolveEffectiveConfig) return { ok: false, error: "No config resolver" };
		const { effective } = await resolver.resolveEffectiveConfig(undefined, null, null);
		if (!effective) return { ok: false, error: "No effective tool config" };

		const vaultRootPath = orchestrator.getVaultRootPath?.() ?? "";
		const policyCtx = {
			effectiveConfig: effective,
			mode: "act",
			domainDenylist: plugin.settings?.domain_denylist ?? [],
			vaultRootPath,
			resolveVaultPath: (p: string) => p,
		};

		try {
			// NOTE: interactionCallback intentionally omitted (undefined) to mirror
			// a headless / sub-agent context with no UI channel.
			const result = await dispatcher.dispatch(
				"ask_user",
				{ questions: [{ question: "Pick a color", suggestions: ["Red", "Green"] }] },
				"act",
				"msg-ask-no-channel",
				undefined, // abortSignal
				undefined, // onProgress
				policyCtx,
				() => Promise.resolve("approved"), // approvalCb (auto-approved anyway)
				orchestrator, // sessionContext
				undefined, // approvalHookDispatcher
				undefined, // interactionCallback — the point of this test
			);
			return { ok: true, result };
		} catch (e: any) {
			return { ok: true, threw: e?.message ?? String(e) };
		}
	});

	if (!outcome.ok) {
		ctx.fail("No-channel ask_user errors", outcome.error ?? "unknown");
		return;
	}

	const result = (outcome as any).result;
	const blankAnswers =
		result?.success === true &&
		Array.isArray(result?.result?.answers) &&
		result.result.answers.length > 0 &&
		result.result.answers.every((a: any) => a?.answer === "" || a?.answer == null);

	if (blankAnswers) {
		ctx.fail(
			"No-channel ask_user errors",
			`Regression: returned success with BLANK answers (${JSON.stringify(result.result.answers)}) instead of erroring`,
		);
	} else if (result?.success === false || (outcome as any).threw) {
		ctx.pass(
			"No-channel ask_user errors",
			`Tool failed cleanly with no interaction channel (error="${result?.error ?? (outcome as any).threw}")`,
		);
	} else {
		ctx.fail(
			"No-channel ask_user errors",
			`Unexpected outcome: ${JSON.stringify(outcome).substring(0, 200)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Test 10: no render errors logged
// ---------------------------------------------------------------------------

async function testNoErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: no render errors logged for interaction UI/block");
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
	await ctx.page.waitForTimeout(5_000); // plugin init + extension/tool load

	// tsx/esbuild injects __name() for function-name tracking into serialized
	// page.evaluate() bodies, but it's undefined in the Obsidian browser context.
	// Define a no-op polyfill so inline arrow functions inside evaluate() work.
	await ctx.page.evaluate(() => {
		if (typeof (window as any).__name === "undefined") {
			(window as any).__name = (fn: unknown, _name: string) => fn;
		}
	});

	await testToolRegistered(ctx);
	await testBlockRegistered(ctx);
	await testChipResolves(ctx);
	await testFreeTextResolves(ctx);
	await testChipsOnly(ctx);
	await testAbort(ctx);
	await testPersistenceReplay(ctx);
	await testAutoApproved(ctx);
	await testRealDispatchRoundTrip(ctx);
	await testNoChannelErrors(ctx);
	await testNoErrors(ctx);
}

runTest({ name: "ask-user-test", settings: buildDefaultSettings() }, tests);
