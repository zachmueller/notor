#!/usr/bin/env npx tsx
/**
 * Ask User / Interaction Primitive E2E Test
 *
 * Validates the `ask_user` follow-up-question tool and the underlying
 * interaction-primitive framework (utils.ask + interaction renderer + the
 * persistent `interaction` chat block).
 *
 * Because the tool depends on the LLM choosing to call it, these tests drive
 * the UI + framework deterministically via the plugin's public surface
 * (`view.renderInteractionPrompt`, the tool/block registries, and JSONL import)
 * rather than relying on a live model invocation.
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
 *   8. No render errors logged
 *
 * @see src/ui/interaction-ui.ts, src/extensions/builtin-tool-scaffolds/ask-user.ts
 * @see src/extensions/builtin-block-scaffolds/interaction.ts
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
// Test 3: live prompt — chips + free-text; chip click resolves
// ---------------------------------------------------------------------------

async function testChipResolves(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: live prompt renders chips + input; chip click resolves");
	const { page } = ctx;

	const setup = await startInteraction(ctx, {
		type: "ask",
		id: "q-chip",
		question: "Which color?",
		suggestions: ["Red", "Green", "Blue"],
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
			question: card?.querySelector(".notor-interaction-question")?.textContent ?? null,
			chips: card?.querySelectorAll(".notor-interaction-chip").length ?? 0,
			hasInput: !!card?.querySelector(".notor-interaction-input"),
		};
	});

	if (counts.question === "Which color?") {
		ctx.pass("Question text rendered", `"${counts.question}"`);
	} else {
		ctx.fail("Question text rendered", `Got "${counts.question}"`);
	}
	if (counts.chips === 3) {
		ctx.pass("Suggestion chips rendered", "3 chips present");
	} else {
		ctx.fail("Suggestion chips rendered", `Expected 3 chips, got ${counts.chips}`);
	}
	if (counts.hasInput) {
		ctx.pass("Free-text input rendered", "Input present (allowFreeText default)");
	} else {
		ctx.fail("Free-text input rendered", "No free-text input found");
	}

	const shot = await ctx.screenshot("03-prompt-rendered");

	// Click the second chip ("Green")
	await page.evaluate(() => {
		const chips = document.querySelectorAll<HTMLButtonElement>(".notor-e2e-ask-card .notor-interaction-chip");
		chips[1]?.click();
	});
	await page.waitForTimeout(400);

	const { result, error } = await readResult(ctx);
	if (error) {
		ctx.fail("Chip click resolves", `Promise rejected: ${error}`);
	} else if (result && result.id === "q-chip" && result.value === "Green") {
		ctx.pass("Chip click resolves", `Resolved with {id: q-chip, value: Green}`, shot);
	} else {
		ctx.fail("Chip click resolves", `Unexpected result: ${JSON.stringify(result)}`);
	}

	const promptGone = await page.evaluate(() => !document.querySelector(".notor-e2e-ask-card .notor-interaction-prompt"));
	if (promptGone) {
		ctx.pass("Prompt removed after resolve", "No .notor-interaction-prompt remains");
	} else {
		ctx.fail("Prompt removed after resolve", "Prompt still in DOM after chip click");
	}

	// Clean up the throwaway card
	await page.evaluate(() => document.querySelector(".notor-e2e-ask-card")?.remove());
}

// ---------------------------------------------------------------------------
// Test 4: free-text submit resolves with trimmed value
// ---------------------------------------------------------------------------

async function testFreeTextResolves(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: free-text submit resolves with trimmed value");
	const { page } = ctx;

	const setup = await startInteraction(ctx, {
		type: "ask",
		id: "q-text",
		question: "Anything else?",
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
		const submit = document.querySelector<HTMLButtonElement>(".notor-e2e-ask-card .notor-interaction-submit")!;
		submit.click();
	});
	await page.waitForTimeout(400);

	const { result, error } = await readResult(ctx);
	if (error) {
		ctx.fail("Free-text submit resolves", `Promise rejected: ${error}`);
	} else if (result && result.id === "q-text" && result.value === "hello world") {
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
		question: "Confirm?",
		suggestions: ["Yes", "No"],
		allowFreeText: false,
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
		{ type: "ask", id: "q-abort", question: "Waiting…" },
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
// Test 8: no render errors logged
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
	await testToolRegistered(ctx);
	await testBlockRegistered(ctx);
	await testChipResolves(ctx);
	await testFreeTextResolves(ctx);
	await testChipsOnly(ctx);
	await testAbort(ctx);
	await testPersistenceReplay(ctx);
	await testNoErrors(ctx);
}

runTest({ name: "ask-user-test", settings: buildDefaultSettings() }, tests);
