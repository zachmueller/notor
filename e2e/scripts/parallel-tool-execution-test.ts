#!/usr/bin/env npx tsx
/**
 * Parallel Tool Execution E2E Test
 *
 * Validates that the LLM can emit multiple tool_use blocks in a single turn
 * and that the plugin correctly collects, partitions, and executes them —
 * running read tools concurrently and write tools serially.
 *
 * Scenarios:
 *   1. Multiple read tools in one turn (should run in parallel)
 *   2. Mixed read + write tools (reads batch, write serial)
 *   3. All tool results appear in conversation and LLM can reference them
 *   4. Token counts are captured (not lost due to early stream exit)
 *   5. Conversation continues correctly after multi-tool turn
 *   6. Internal message state has correct coalesced structure
 *
 * @see specs/ZZ-misc/parallel-tool-execution.md — Phases 1-4
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	waitForSelector,
	sendMessage,
	sendMessageWithApprovalHandling,
	getLastAssistantMessage,
	getLastToolCallNames,
	newConversation,
	setMode,
	ensureCleanState,
	buildDefaultSettings,
	VAULT_PATH,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Test vault content
// ---------------------------------------------------------------------------

const VAULT_NOTES: Record<string, string> = {
	"Notes/Alpha.md": `---
title: Alpha Note
status: active
tags: [parallel, test]
---

# Alpha Note

This is the Alpha note used for parallel tool execution testing.
It contains information about the alpha project milestone.
`,

	"Notes/Beta.md": `---
title: Beta Note
status: draft
tags: [parallel, test]
---

# Beta Note

This is the Beta note used for parallel tool execution testing.
It discusses the beta release timeline and QA process.
`,

	"Notes/Gamma.md": `---
title: Gamma Note
status: complete
tags: [parallel, test]
---

# Gamma Note

This is the Gamma note used for parallel tool execution testing.
It covers the gamma deployment strategy and rollback plan.
`,

	"Notes/Delta.md": `---
title: Delta Note
priority: high
---

# Delta Note

The Delta note describes integration requirements.
Key dependency: the Alpha and Beta milestones must complete first.
`,
};

// ---------------------------------------------------------------------------
// Vault setup
// ---------------------------------------------------------------------------

function setupTestVault(vaultPath: string): void {
	console.log("  Setting up parallel-test vault notes...");
	for (const [relativePath, content] of Object.entries(VAULT_NOTES)) {
		const fullPath = path.join(vaultPath, relativePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content, "utf8");
		console.log(`    Created: ${relativePath}`);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Test 1: Multiple read tools in a single LLM turn.
 *
 * Asks the LLM to read 3 notes simultaneously. Since read_note has
 * mode="read", all 3 should be batched into one concurrent batch by
 * partitionToolCalls() and executed in parallel.
 */
async function testParallelReads(ctx: TestContext): Promise<void> {
	console.log("\n── Test 1: Parallel read_note calls ──────────────────────────");
	const { page } = ctx;
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"I need you to read three notes at once. Please use the read_note tool to read " +
		"each of these files: 'Notes/Alpha.md', 'Notes/Beta.md', and 'Notes/Gamma.md'. " +
		"After reading all three, tell me what status each note has in its frontmatter.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("01-parallel-reads-timeout");
		ctx.fail("parallel reads — response", "No response within timeout", shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const shot = await ctx.screenshot("01-parallel-reads");

	// Verify multiple tool calls appeared
	const readCalls = toolNames.filter(
		(n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note"),
	);

	if (readCalls.length >= 3) {
		ctx.pass(
			"parallel reads — 3 read_note calls",
			`Found ${readCalls.length} read_note tool cards: ${toolNames.join(", ")}`,
			shot,
		);
	} else if (readCalls.length >= 2) {
		ctx.pass(
			"parallel reads — multiple read_note calls",
			`Found ${readCalls.length} read_note calls (expected 3): ${toolNames.join(", ")}`,
			shot,
		);
	} else if (readCalls.length === 1) {
		// LLM may have done them across turns instead of one turn — still functional
		ctx.fail(
			"parallel reads — multiple calls in one turn",
			`Only 1 read_note call found; LLM may have serialized across turns. Tool names: [${toolNames.join(", ")}]`,
			shot,
		);
	} else {
		ctx.fail(
			"parallel reads — read_note calls",
			`No read_note tool cards found. Tool names: [${toolNames.join(", ")}]`,
			shot,
		);
	}

	// Verify the LLM can reference all three results in its response
	const lower = response.toLowerCase();
	const mentionsAlpha = lower.includes("alpha") && lower.includes("active");
	const mentionsBeta = lower.includes("beta") && lower.includes("draft");
	const mentionsGamma = lower.includes("gamma") && lower.includes("complete");

	const mentionCount = [mentionsAlpha, mentionsBeta, mentionsGamma].filter(Boolean).length;
	if (mentionCount === 3) {
		ctx.pass(
			"parallel reads — all 3 statuses in response",
			"Response correctly identifies Alpha=active, Beta=draft, Gamma=complete",
		);
	} else if (mentionCount >= 1) {
		ctx.pass(
			"parallel reads — partial status coverage",
			`Response mentions ${mentionCount}/3 note statuses`,
		);
	} else {
		ctx.fail(
			"parallel reads — note statuses in response",
			`Response does not reference expected statuses. Response: "${response.trim().substring(0, 150)}"`,
			shot,
		);
	}
}

/**
 * Test 2: Mixed read + write tools in one turn.
 *
 * Asks the LLM to read a note and then create a summary note. The read_note
 * call is concurrency-safe (mode="read") and write_note is not (mode="write"),
 * so partitionToolCalls should create separate batches with the write
 * executing after the read.
 */
async function testMixedReadWrite(ctx: TestContext): Promise<void> {
	console.log("\n── Test 2: Mixed read + write tool calls ─────────────────────");
	const { page } = ctx;
	await ensureCleanState(page);
	await newConversation(page);
	await setMode(page, "Act");

	const summaryPath = path.join(VAULT_PATH, "E2E-Parallel-Summary.md");
	if (fs.existsSync(summaryPath)) fs.unlinkSync(summaryPath);

	const prompt =
		"Read the note 'Notes/Alpha.md' using read_note, then create a new note at " +
		"'E2E-Parallel-Summary.md' using write_note that contains a one-paragraph " +
		"summary of what the Alpha note is about.";

	const { responded } = await sendMessageWithApprovalHandling(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("02-mixed-rw-timeout");
		ctx.fail("mixed read/write — response", "No response within timeout", shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const shot = await ctx.screenshot("02-mixed-rw");

	const calledRead = toolNames.some(
		(n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note"),
	);
	const calledWrite = toolNames.some(
		(n) => n.toLowerCase().includes("write_note") || n.toLowerCase().includes("write note"),
	);

	if (calledRead && calledWrite) {
		ctx.pass(
			"mixed read/write — both tools called",
			`Tool cards: ${toolNames.join(", ")}`,
			shot,
		);
	} else if (calledRead || calledWrite) {
		ctx.pass(
			"mixed read/write — at least one tool called",
			`Tool cards: ${toolNames.join(", ")}`,
			shot,
		);
	} else {
		ctx.fail(
			"mixed read/write — tools called",
			`No read_note or write_note cards found. Tool names: [${toolNames.join(", ")}]`,
			shot,
		);
	}

	// Verify the summary note was actually created
	if (fs.existsSync(summaryPath)) {
		const content = fs.readFileSync(summaryPath, "utf8");
		if (content.toLowerCase().includes("alpha")) {
			ctx.pass(
				"mixed read/write — summary file created with Alpha content",
				`File created (${content.length} chars), references Alpha`,
			);
		} else if (content.length > 10) {
			ctx.pass(
				"mixed read/write — summary file created",
				`File created (${content.length} chars)`,
			);
		} else {
			ctx.fail(
				"mixed read/write — summary file has content",
				`File exists but too short: "${content}"`,
			);
		}
	} else if (calledWrite) {
		ctx.fail(
			"mixed read/write — summary file on disk",
			"write_note was called but file not found on disk",
			shot,
		);
	}
}

/**
 * Test 3: Two different read tools in parallel (list_vault + search_vault).
 *
 * Both are mode="read" so they should be batched together and run concurrently.
 */
async function testDifferentReadToolsParallel(ctx: TestContext): Promise<void> {
	console.log("\n── Test 3: Different read tools in parallel ──────────────────");
	const { page } = ctx;
	await ensureCleanState(page);
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"Please do two things at once: use list_vault to list all files in my vault, " +
		"and use search_vault to search for the word 'milestone'. " +
		"Tell me how many notes there are and which ones mention 'milestone'.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("03-diff-reads-timeout");
		ctx.fail("different read tools — response", "No response within timeout", shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const shot = await ctx.screenshot("03-diff-reads");

	const calledList = toolNames.some(
		(n) => n.toLowerCase().includes("list_vault") || n.toLowerCase().includes("list vault"),
	);
	const calledSearch = toolNames.some(
		(n) => n.toLowerCase().includes("search_vault") || n.toLowerCase().includes("search vault"),
	);

	if (calledList && calledSearch) {
		ctx.pass(
			"different read tools — both list_vault and search_vault called",
			`Tool cards: ${toolNames.join(", ")}`,
			shot,
		);
	} else if (calledList || calledSearch) {
		ctx.pass(
			"different read tools — at least one tool called",
			`Tool cards: ${toolNames.join(", ")}`,
			shot,
		);
	} else {
		ctx.fail(
			"different read tools — tools called",
			`No list_vault or search_vault cards. Tool names: [${toolNames.join(", ")}]`,
			shot,
		);
	}

	// Verify the LLM got results from both tools
	const lower = response.toLowerCase();
	if (lower.includes("alpha") || lower.includes("beta") || lower.includes("gamma") || lower.includes("delta")) {
		ctx.pass(
			"different read tools — response references vault notes",
			"Response mentions note names from vault listing",
		);
	} else {
		ctx.fail(
			"different read tools — response references vault notes",
			`Response: "${response.trim().substring(0, 150)}"`,
			shot,
		);
	}
}

/**
 * Test 4: Token tracking after multi-tool turn.
 *
 * Previously, processStream() returned on the first tool_call_end, missing
 * the message_end chunk that carries token counts. Verify that tokens are
 * now correctly captured by checking the internal conversation state.
 */
async function testTokenTracking(ctx: TestContext): Promise<void> {
	console.log("\n── Test 4: Token count capture ───────────────────────────────");
	const { page } = ctx;
	await ensureCleanState(page);
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"Please read both 'Notes/Alpha.md' and 'Notes/Beta.md' using read_note " +
		"and compare their statuses.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("04-tokens-timeout");
		ctx.fail("token tracking — response", "No response within timeout", shot);
		return;
	}

	const shot = await ctx.screenshot("04-tokens");

	// Check internal conversation state for token counts
	const tokenInfo = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;

		const orchestrator = plugin.getOrchestrator?.();
		if (!orchestrator) return null;

		const convManager = orchestrator.getConversationManager?.();
		if (!convManager) return null;

		const messages = convManager.getMessages?.() ?? [];

		// Find assistant messages with token data (snake_case fields)
		const assistantMsgs = messages.filter(
			(m: any) => m.role === "assistant" && (m.input_tokens > 0 || m.output_tokens > 0),
		);

		// Find tool_call messages
		const toolCallMsgs = messages.filter((m: any) => m.role === "tool_call");

		// Find tool_result messages
		const toolResultMsgs = messages.filter((m: any) => m.role === "tool_result");

		return {
			totalMessages: messages.length,
			assistantWithTokens: assistantMsgs.length,
			toolCallCount: toolCallMsgs.length,
			toolResultCount: toolResultMsgs.length,
			// Sample token values from the last assistant message with tokens
			lastTokens: assistantMsgs.length > 0
				? {
						input: assistantMsgs[assistantMsgs.length - 1].input_tokens,
						output: assistantMsgs[assistantMsgs.length - 1].output_tokens,
					}
				: null,
		};
	});

	if (!tokenInfo) {
		ctx.fail("token tracking — access conversation state", "Could not access plugin internals", shot);
		return;
	}

	console.log(`    Message stats: ${JSON.stringify(tokenInfo)}`);

	// Verify token counts are non-zero (the bug was that they were always 0)
	if (tokenInfo.lastTokens && (tokenInfo.lastTokens.input > 0 || tokenInfo.lastTokens.output > 0)) {
		ctx.pass(
			"token tracking — non-zero token counts",
			`Tokens captured: input=${tokenInfo.lastTokens.input}, output=${tokenInfo.lastTokens.output}`,
			shot,
		);
	} else {
		ctx.fail(
			"token tracking — non-zero token counts",
			`Token counts are zero or missing: ${JSON.stringify(tokenInfo.lastTokens)}`,
			shot,
		);
	}

	// Verify tool_call and tool_result message counts match
	if (tokenInfo.toolCallCount > 0 && tokenInfo.toolCallCount === tokenInfo.toolResultCount) {
		ctx.pass(
			"token tracking — matched tool_call/tool_result counts",
			`${tokenInfo.toolCallCount} tool_call(s) matched by ${tokenInfo.toolResultCount} tool_result(s)`,
		);
	} else if (tokenInfo.toolCallCount > 0) {
		ctx.fail(
			"token tracking — matched tool_call/tool_result counts",
			`Mismatch: ${tokenInfo.toolCallCount} tool_call(s) vs ${tokenInfo.toolResultCount} tool_result(s)`,
			shot,
		);
	}
}

/**
 * Test 5: Conversation continuity after multi-tool turn.
 *
 * After a multi-tool turn, send a follow-up message that requires the LLM
 * to reference the prior tool results. This validates that the coalesced
 * messages are correctly sent back to the API on the next turn.
 */
async function testConversationContinuity(ctx: TestContext): Promise<void> {
	console.log("\n── Test 5: Conversation continuity after multi-tool turn ─────");
	const { page } = ctx;
	await ensureCleanState(page);
	await newConversation(page);
	await setMode(page, "Plan");

	// First turn: trigger multiple tool calls
	const prompt1 =
		"Please use read_note to read 'Notes/Alpha.md' and 'Notes/Delta.md'. " +
		"Tell me what each note is about.";

	const responded1 = await sendMessage(page, prompt1);
	if (!responded1) {
		const shot = await ctx.screenshot("05-continuity-turn1-timeout");
		ctx.fail("continuity — first turn response", "No response within timeout", shot);
		return;
	}

	const firstResponse = await getLastAssistantMessage(page);
	const shot1 = await ctx.screenshot("05-continuity-turn1");

	// Verify first turn got results
	const lower1 = firstResponse.toLowerCase();
	if (!(lower1.includes("alpha") || lower1.includes("delta"))) {
		ctx.fail(
			"continuity — first turn has note content",
			`First response doesn't reference notes: "${firstResponse.trim().substring(0, 120)}"`,
			shot1,
		);
		return;
	}

	ctx.pass(
		"continuity — first turn references notes",
		"First response mentions Alpha and/or Delta content",
		shot1,
	);

	// Second turn: follow-up that requires prior context
	const prompt2 =
		"Based on the two notes you just read, which note mentions the other as a dependency?";

	const responded2 = await sendMessage(page, prompt2);
	if (!responded2) {
		const shot = await ctx.screenshot("05-continuity-turn2-timeout");
		ctx.fail("continuity — second turn response", "No response within timeout", shot);
		return;
	}

	const secondResponse = await getLastAssistantMessage(page);
	const shot2 = await ctx.screenshot("05-continuity-turn2");
	const lower2 = secondResponse.toLowerCase();

	// Delta's content says "the Alpha and Beta milestones must complete first"
	if (lower2.includes("delta") || lower2.includes("depend") || lower2.includes("alpha")) {
		ctx.pass(
			"continuity — follow-up references prior tool results",
			"Second response correctly references content from prior multi-tool turn",
			shot2,
		);
	} else {
		ctx.fail(
			"continuity — follow-up references prior tool results",
			`Second response: "${secondResponse.trim().substring(0, 150)}"`,
			shot2,
		);
	}
}

/**
 * Test 6: Internal message coalescing structure.
 *
 * After a multi-tool turn, inspect the internal conversation state to verify
 * that toChatMessages() produces correctly coalesced messages:
 * - One assistant ChatMessage with multiple tool_use blocks
 * - One user ChatMessage with multiple tool_result blocks
 */
async function testMessageCoalescing(ctx: TestContext): Promise<void> {
	console.log("\n── Test 6: Message coalescing verification ───────────────────");
	const { page } = ctx;
	await ensureCleanState(page);
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"Please use read_note to read both 'Notes/Alpha.md' and 'Notes/Beta.md' " +
		"and tell me the title of each.";

	const responded = await sendMessage(page, prompt);
	if (!responded) {
		const shot = await ctx.screenshot("06-coalescing-timeout");
		ctx.fail("coalescing — response", "No response within timeout", shot);
		return;
	}

	const shot = await ctx.screenshot("06-coalescing");

	// Inspect internal message structure via page.evaluate
	const messageStructure = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;

		const orchestrator = plugin.getOrchestrator?.();
		if (!orchestrator) return null;

		const convManager = orchestrator.getConversationManager?.();
		if (!convManager) return null;

		const messages = convManager.getMessages?.() ?? [];

		// Count message roles
		const roleCounts: Record<string, number> = {};
		for (const m of messages) {
			roleCounts[m.role] = (roleCounts[m.role] || 0) + 1;
		}

		// Find consecutive tool_call runs (these should exist in internal format)
		let maxConsecutiveToolCalls = 0;
		let currentRun = 0;
		for (const m of messages) {
			if (m.role === "tool_call") {
				currentRun++;
				maxConsecutiveToolCalls = Math.max(maxConsecutiveToolCalls, currentRun);
			} else {
				currentRun = 0;
			}
		}

		// Check that every tool_call has a matching tool_result
		const toolCallIds = messages
			.filter((m: any) => m.role === "tool_call" && m.tool_call)
			.map((m: any) => m.tool_call.id);
		const toolResultIds = messages
			.filter((m: any) => m.role === "tool_result" && m.tool_result)
			.map((m: any) => m.tool_result.tool_call_id);

		const unmatchedCalls = toolCallIds.filter(
			(id: string) => !toolResultIds.includes(id),
		);

		return {
			roleCounts,
			maxConsecutiveToolCalls,
			toolCallIds,
			toolResultIds,
			unmatchedCalls,
			messageRoles: messages.map((m: any) => m.role),
		};
	});

	if (!messageStructure) {
		ctx.fail("coalescing — access message state", "Could not access plugin internals", shot);
		return;
	}

	console.log(`    Role counts: ${JSON.stringify(messageStructure.roleCounts)}`);
	console.log(`    Max consecutive tool_calls: ${messageStructure.maxConsecutiveToolCalls}`);
	console.log(`    Message roles: ${messageStructure.messageRoles.join(", ")}`);

	// Verify we have tool_call messages
	if ((messageStructure.roleCounts["tool_call"] ?? 0) >= 2) {
		ctx.pass(
			"coalescing — multiple tool_call messages",
			`Found ${messageStructure.roleCounts["tool_call"]} tool_call messages`,
		);
	} else if ((messageStructure.roleCounts["tool_call"] ?? 0) === 1) {
		ctx.fail(
			"coalescing — multiple tool_call messages",
			"Only 1 tool_call message found; LLM may not have emitted parallel calls",
			shot,
		);
	} else {
		ctx.fail(
			"coalescing — tool_call messages present",
			"No tool_call messages found in conversation",
			shot,
		);
		return;
	}

	// Verify consecutive tool_call ordering (all tool_calls before tool_results)
	if (messageStructure.maxConsecutiveToolCalls >= 2) {
		ctx.pass(
			"coalescing — consecutive tool_call grouping",
			`Max consecutive tool_calls: ${messageStructure.maxConsecutiveToolCalls} (grouped ordering confirmed)`,
		);
	} else {
		ctx.fail(
			"coalescing — consecutive tool_call grouping",
			`Max consecutive tool_calls: ${messageStructure.maxConsecutiveToolCalls}; expected >= 2 for grouped ordering`,
			shot,
		);
	}

	// Verify all tool_calls have matching tool_results (no orphans)
	if (messageStructure.unmatchedCalls.length === 0) {
		ctx.pass(
			"coalescing — no orphaned tool_calls",
			`All ${messageStructure.toolCallIds.length} tool_call(s) have matching tool_result(s)`,
		);
	} else {
		ctx.fail(
			"coalescing — no orphaned tool_calls",
			`${messageStructure.unmatchedCalls.length} tool_call(s) without matching result: ${messageStructure.unmatchedCalls.join(", ")}`,
			shot,
		);
	}
}

/**
 * Test 7: No unexpected errors in logs during parallel execution.
 *
 * Reviews the structured log output for any errors that occurred during
 * the parallel tool execution tests.
 */
async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\n── Test 7: No unexpected errors in logs ──────────────────────");

	const errors = ctx.collector.getLogsByLevel("error");

	// Filter out known/expected errors (e.g., network connectivity issues)
	const unexpectedErrors = errors.filter((e) => {
		const msg = e.message.toLowerCase();
		// Ignore transient network errors from fetch_webpage/web_search if any
		if (msg.includes("econnrefused") || msg.includes("fetch failed")) return false;
		// Ignore timeout errors from slow model responses
		if (msg.includes("timeout") || msg.includes("timed out")) return false;
		return true;
	});

	const shot = await ctx.screenshot("07-error-check");

	if (unexpectedErrors.length === 0) {
		ctx.pass(
			"no unexpected errors",
			`${errors.length} total errors, all expected/filtered`,
			shot,
		);
	} else {
		const summary = unexpectedErrors
			.slice(-5)
			.map((e) => `[${e.source}] ${e.message.substring(0, 80)}`)
			.join("; ");
		ctx.fail(
			"no unexpected errors",
			`${unexpectedErrors.length} unexpected error(s): ${summary}`,
			shot,
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	// Wait for plugin initialization
	await page.waitForTimeout(5_000);

	// Verify chat panel is ready
	console.log("Verifying chat panel...");
	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chatContainer) {
		const shot = await ctx.screenshot("00-no-chat-panel");
		ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
		throw new Error("Chat panel not visible — cannot run tests");
	}
	const shot = await ctx.screenshot("00-chat-ready");
	ctx.pass("Chat panel ready", "Plugin loaded and chat container found", shot);

	// Run test scenarios
	await testParallelReads(ctx);
	await testDifferentReadToolsParallel(ctx);
	await testMixedReadWrite(ctx);
	await testTokenTracking(ctx);
	await testConversationContinuity(ctx);
	await testMessageCoalescing(ctx);
	await testNoUnexpectedErrors(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "plan",
	auto_approve: {
		read_note: true,
		search_vault: true,
		list_vault: true,
		read_frontmatter: true,
		write_note: true,
		replace_in_note: true,
	},
});

runTest(
	{
		name: "parallel-tool-execution-test",
		settings,
		setupVault: (vaultPath) => setupTestVault(vaultPath),
		cleanupFiles: [
			"Notes/Alpha.md",
			"Notes/Beta.md",
			"Notes/Gamma.md",
			"Notes/Delta.md",
			"E2E-Parallel-Summary.md",
		],
	},
	tests,
);
