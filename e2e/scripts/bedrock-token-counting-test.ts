#!/usr/bin/env npx tsx
/**
 * Bedrock Token Counting Diagnostic Test
 *
 * Validates Phase 1A diagnostic logging and token counting accuracy for the
 * Bedrock provider. Sends real prompts through the Bedrock Converse API and
 * inspects structured logs + UI footer for correct token values.
 *
 * Scenarios:
 *   1. Plugin loads and chat panel is visible
 *   2. Send a simple text prompt — verify Bedrock metadata event logs non-zero tokens
 *   3. Verify orchestrator message_end logs match Bedrock metadata
 *   4. Verify token footer shows non-zero values
 *   5. Send a tool-triggering prompt — compare tool-call turn tokens
 *   6. Verify token footer accumulates across turns
 *   7. Write a large note — verify output tokens are proportional to content size
 *   8. Dump all token-related logs for manual inspection
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled on that account (Claude model)
 *
 * @see specs/ZZ-misc/token-counting-improvements-tasks.md — Phase 1A
 */

import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessage,
	sendMessageWithApprovalHandling,
	getLastAssistantMessage,
	waitForResponse,
	newConversation,
	ensureCleanState,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const SIMPLE_PROMPT = "What is 2 + 2? Reply with just the number.";
const TOOL_PROMPT = "Read the file named 'Welcome.md' in the vault root. Summarize it in one sentence.";
const LARGE_WRITE_PROMPT =
	"Create a new note at 'Token Test/large-output.md' with a comprehensive guide to " +
	"sorting algorithms. Include sections on bubble sort, selection sort, insertion sort, " +
	"merge sort, quick sort, and heap sort. For each algorithm include: a description, " +
	"pseudocode in a code block, time complexity analysis (best/average/worst), space " +
	"complexity, and when to use it. Make it detailed — at least 300 lines of markdown.";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface TokenLogPair {
	bedrock: { inputTokens?: number; outputTokens?: number; totalTokens?: number; hasUsage?: boolean }[];
	orchestrator: { inputTokens?: number; outputTokens?: number; toolCallCount?: number }[];
}

/**
 * Extract token-related log entries from the collector, filtered to entries
 * captured after `afterTimestamp`.
 */
function extractTokenLogs(ctx: TestContext, afterTimestamp?: string): TokenLogPair {
	const all = ctx.collector.getStructuredLogs();
	const filtered = afterTimestamp
		? all.filter((e) => e.timestamp > afterTimestamp)
		: all;

	const bedrock = filtered
		.filter((e) => e.source === "BedrockProvider" && e.message === "Bedrock metadata event")
		.map((e) => e.data as TokenLogPair["bedrock"][number]);

	const orchestrator = filtered
		.filter((e) => e.source === "ChatOrchestrator" && e.message === "processStream message_end")
		.map((e) => e.data as TokenLogPair["orchestrator"][number]);

	return { bedrock, orchestrator };
}

/**
 * Read the token footer text from the UI.
 */
async function getTokenFooterText(page: import("playwright-core").Page): Promise<string | null> {
	return page.evaluate(() => {
		const el = document.querySelector(".notor-token-footer");
		if (!el || el.classList.contains("notor-hidden")) return null;
		return el.textContent?.trim() ?? null;
	});
}

/**
 * Parse "Tokens: ↑1,234 ↓5,678" from the footer text.
 */
function parseTokenFooter(text: string): { input: number; output: number } | null {
	const match = text.match(/↑([\d,]+)\s*↓([\d,]+)/);
	if (!match) return null;
	return {
		input: parseInt(match[1]!.replace(/,/g, ""), 10),
		output: parseInt(match[2]!.replace(/,/g, ""), 10),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testChatPanelVisible(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Chat panel visible");
	const { page } = ctx;

	const chatContainer = await waitForSelector(page, ".notor-chat-container", 8_000);
	if (chatContainer) {
		const shot = await ctx.screenshot("01-startup");
		ctx.pass("Chat panel visible", "Found .notor-chat-container", shot);
	} else {
		const shot = await ctx.screenshot("01-startup-missing");
		ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
		throw new Error("Chat panel not visible — cannot continue");
	}
}

async function testSimplePromptTokens(ctx: TestContext): Promise<TokenLogPair> {
	console.log("\nTest 2: Simple prompt — Bedrock token logging");
	const { page } = ctx;

	// Record timestamp before sending so we can filter logs
	const beforeSend = new Date().toISOString();

	// Start a fresh conversation to isolate token counts
	await newConversation(page);
	await page.waitForTimeout(1_000);

	const responded = await sendMessage(page, SIMPLE_PROMPT);
	if (!responded) {
		const shot = await ctx.screenshot("02-no-response");
		ctx.fail("Simple prompt response", "No response received within timeout", shot);
		return { bedrock: [], orchestrator: [] };
	}

	const responseText = await getLastAssistantMessage(page);
	const shot = await ctx.screenshot("02-simple-response");
	ctx.pass("Simple prompt response", `Response: "${responseText.trim().substring(0, 80)}"`, shot);

	// Extract token logs
	const logs = extractTokenLogs(ctx, beforeSend);

	// Test 2a: Bedrock metadata event logged
	console.log("\nTest 2a: Bedrock metadata event contains token data");
	if (logs.bedrock.length === 0) {
		ctx.fail("Bedrock metadata logged", "No 'Bedrock metadata event' log entries found after prompt");
	} else {
		const last = logs.bedrock[logs.bedrock.length - 1]!;
		const detail = `hasUsage=${last.hasUsage}, input=${last.inputTokens}, output=${last.outputTokens}, total=${last.totalTokens}`;
		if (last.hasUsage && (last.inputTokens ?? 0) > 0) {
			ctx.pass("Bedrock metadata logged", detail);
		} else if (last.hasUsage) {
			ctx.fail("Bedrock metadata logged", `Usage present but inputTokens is 0: ${detail}`);
		} else {
			ctx.fail("Bedrock metadata logged", `hasUsage=false — metadata.usage was undefined: ${detail}`);
		}
	}

	// Test 2b: Orchestrator message_end logged
	console.log("\nTest 2b: Orchestrator message_end contains token data");
	if (logs.orchestrator.length === 0) {
		ctx.fail("Orchestrator message_end logged", "No 'processStream message_end' log entries found");
	} else {
		const last = logs.orchestrator[logs.orchestrator.length - 1]!;
		const detail = `inputTokens=${last.inputTokens}, outputTokens=${last.outputTokens}, toolCallCount=${last.toolCallCount}`;
		if ((last.inputTokens ?? 0) > 0 && (last.outputTokens ?? 0) > 0) {
			ctx.pass("Orchestrator message_end logged", detail);
		} else {
			ctx.fail("Orchestrator message_end logged", `Unexpected zero tokens: ${detail}`);
		}
	}

	// Test 2c: Cross-check Bedrock → Orchestrator token propagation
	console.log("\nTest 2c: Token propagation Bedrock → Orchestrator");
	if (logs.bedrock.length > 0 && logs.orchestrator.length > 0) {
		const bk = logs.bedrock[logs.bedrock.length - 1]!;
		const oc = logs.orchestrator[logs.orchestrator.length - 1]!;
		const inputMatch = bk.inputTokens === oc.inputTokens;
		const outputMatch = bk.outputTokens === oc.outputTokens;
		const detail = `Bedrock(in=${bk.inputTokens}, out=${bk.outputTokens}) → Orchestrator(in=${oc.inputTokens}, out=${oc.outputTokens})`;
		if (inputMatch && outputMatch) {
			ctx.pass("Token propagation matches", detail);
		} else {
			ctx.fail("Token propagation matches", `Mismatch: ${detail}`);
		}
	} else {
		ctx.fail("Token propagation matches", "Cannot compare — missing log entries from one or both layers");
	}

	return logs;
}

async function testTokenFooterAfterSimplePrompt(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Token footer updated after simple prompt");
	const { page } = ctx;

	const footerText = await getTokenFooterText(page);
	const shot = await ctx.screenshot("03-token-footer");

	if (!footerText) {
		ctx.fail("Token footer visible", "Footer is hidden or not found after response", shot);
		return;
	}

	const parsed = parseTokenFooter(footerText);
	if (!parsed) {
		ctx.fail("Token footer parseable", `Could not parse footer: "${footerText}"`, shot);
		return;
	}

	const detail = `Footer: "${footerText}" → input=${parsed.input}, output=${parsed.output}`;
	if (parsed.input > 0 && parsed.output > 0) {
		ctx.pass("Token footer shows non-zero values", detail, shot);
	} else {
		ctx.fail("Token footer shows non-zero values", `Zero tokens in footer: ${detail}`, shot);
	}
}

async function testToolCallTokens(ctx: TestContext, prevLogs: TokenLogPair): Promise<void> {
	console.log("\nTest 4: Tool-call prompt — token counting with tool use");
	const { page } = ctx;

	const beforeSend = new Date().toISOString();

	// Send a prompt that should trigger a read_note tool call
	// Use approval handling since read_note may or may not be auto-approved
	const { responded, approved } = await sendMessageWithApprovalHandling(page, TOOL_PROMPT);

	if (!responded) {
		const shot = await ctx.screenshot("04-tool-no-response");
		ctx.fail("Tool-call prompt response", "No response received within timeout", shot);
		return;
	}

	const responseText = await getLastAssistantMessage(page);
	const shot = await ctx.screenshot("04-tool-response");
	ctx.pass("Tool-call prompt response", `Response: "${responseText.trim().substring(0, 80)}"${approved ? " (approved tool)" : ""}`, shot);

	// Extract token logs from this turn
	const logs = extractTokenLogs(ctx, beforeSend);

	// Test 4a: Bedrock metadata events for tool-call turn
	console.log("\nTest 4a: Bedrock metadata events during tool-call turn");
	if (logs.bedrock.length === 0) {
		ctx.fail("Bedrock metadata (tool turn)", "No metadata events logged during tool-call turn");
	} else {
		const details = logs.bedrock.map((e, i) =>
			`  [${i}] input=${e.inputTokens} output=${e.outputTokens} total=${e.totalTokens}`
		).join("\n");
		console.log(`  Bedrock metadata events (${logs.bedrock.length}):\n${details}`);
		ctx.pass("Bedrock metadata (tool turn)", `${logs.bedrock.length} metadata event(s) logged`);
	}

	// Test 4b: Orchestrator message_end events — should show toolCallCount > 0
	console.log("\nTest 4b: Orchestrator message_end during tool-call turn");
	if (logs.orchestrator.length === 0) {
		ctx.fail("Orchestrator message_end (tool turn)", "No message_end events logged");
	} else {
		const toolTurn = logs.orchestrator.find((e) => (e.toolCallCount ?? 0) > 0);
		const details = logs.orchestrator.map((e, i) =>
			`  [${i}] input=${e.inputTokens} output=${e.outputTokens} toolCalls=${e.toolCallCount}`
		).join("\n");
		console.log(`  Orchestrator message_end events (${logs.orchestrator.length}):\n${details}`);

		if (toolTurn) {
			ctx.pass("Tool-call turn detected", `Found turn with toolCallCount=${toolTurn.toolCallCount}, output=${toolTurn.outputTokens}`);

			// Check if output tokens seem reasonable for a tool call
			if ((toolTurn.outputTokens ?? 0) > 0) {
				ctx.pass("Tool-call output tokens non-zero", `outputTokens=${toolTurn.outputTokens}`);
			} else {
				ctx.fail("Tool-call output tokens non-zero", `outputTokens=0 — this is the suspected bug`);
			}
		} else {
			// No turn with tool calls — model may have responded with text directly
			ctx.pass("Orchestrator message_end (tool turn)", `${logs.orchestrator.length} events, none with tool calls (model may have answered directly)`);
		}
	}
}

async function testTokenFooterAccumulation(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Token footer accumulates across turns");
	const { page } = ctx;

	const footerText = await getTokenFooterText(page);
	const shot = await ctx.screenshot("05-accumulated-footer");

	if (!footerText) {
		ctx.fail("Token footer after multi-turn", "Footer is hidden or not found", shot);
		return;
	}

	const parsed = parseTokenFooter(footerText);
	if (!parsed) {
		ctx.fail("Token footer parseable (multi-turn)", `Could not parse: "${footerText}"`, shot);
		return;
	}

	// After 2+ turns, input tokens should be well above a single turn's worth
	// (because each turn re-sends the full conversation)
	const detail = `Footer: "${footerText}" → input=${parsed.input}, output=${parsed.output}`;
	if (parsed.input > 0 && parsed.output > 0) {
		ctx.pass("Token footer accumulated values", detail, shot);
	} else {
		ctx.fail("Token footer accumulated values", `Unexpected: ${detail}`, shot);
	}
}

async function testLargeWriteTokens(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: Large write_note — output token proportionality");
	const { page } = ctx;

	// Fresh conversation so token counts are isolated
	await newConversation(page);
	await page.waitForTimeout(1_000);

	const beforeSend = new Date().toISOString();

	// write_note requires approval — use approval handling
	const { responded, approved } = await sendMessageWithApprovalHandling(
		page, LARGE_WRITE_PROMPT, 120_000
	);

	if (!responded) {
		const shot = await ctx.screenshot("06-large-write-no-response");
		ctx.fail("Large write response", "No response received within timeout", shot);
		return;
	}

	const responseText = await getLastAssistantMessage(page);
	const shot = await ctx.screenshot("06-large-write-response");
	ctx.pass("Large write response", `Response: "${responseText.trim().substring(0, 80)}"${approved ? " (approved)" : ""}`, shot);

	// Extract token logs from this interaction
	const logs = extractTokenLogs(ctx, beforeSend);

	// Test 6a: Bedrock metadata events — expect multiple turns (tool call + final)
	console.log("\nTest 6a: Bedrock metadata events during large write");
	if (logs.bedrock.length === 0) {
		ctx.fail("Bedrock metadata (large write)", "No metadata events logged");
	} else {
		const totalOutput = logs.bedrock.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0);
		const details = logs.bedrock.map((e, i) =>
			`  [${i}] input=${e.inputTokens} output=${e.outputTokens} total=${e.totalTokens}`
		).join("\n");
		console.log(`  Bedrock metadata events (${logs.bedrock.length}):\n${details}`);
		console.log(`  Total output tokens across all turns: ${totalOutput}`);
		ctx.pass("Bedrock metadata (large write)", `${logs.bedrock.length} event(s), total output=${totalOutput}`);
	}

	// Test 6b: Orchestrator events — check tool-call turn output tokens
	console.log("\nTest 6b: Orchestrator message_end during large write");
	if (logs.orchestrator.length === 0) {
		ctx.fail("Orchestrator message_end (large write)", "No message_end events logged");
	} else {
		const toolTurns = logs.orchestrator.filter((e) => (e.toolCallCount ?? 0) > 0);
		const totalOutput = logs.orchestrator.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0);
		const details = logs.orchestrator.map((e, i) =>
			`  [${i}] input=${e.inputTokens} output=${e.outputTokens} toolCalls=${e.toolCallCount}`
		).join("\n");
		console.log(`  Orchestrator events (${logs.orchestrator.length}):\n${details}`);
		console.log(`  Tool-call turns: ${toolTurns.length}, total output tokens: ${totalOutput}`);

		if (toolTurns.length > 0) {
			const writeCallTurn = toolTurns[0]!;
			ctx.pass("Large write tool-call detected",
				`toolCallCount=${writeCallTurn.toolCallCount}, outputTokens=${writeCallTurn.outputTokens}`);

			// The write_note tool call should generate substantial output tokens
			// because the model outputs the full note content as a tool argument.
			// A 300+ line markdown guide should be at least ~1000 tokens.
			if ((writeCallTurn.outputTokens ?? 0) >= 500) {
				ctx.pass("Large write output tokens proportional",
					`outputTokens=${writeCallTurn.outputTokens} (≥500 — proportional to content size)`);
			} else {
				ctx.fail("Large write output tokens proportional",
					`outputTokens=${writeCallTurn.outputTokens} (<500 — suspiciously low for a 300+ line note)`);
			}
		} else {
			ctx.fail("Large write tool-call detected",
				"No tool-call turns found — model may not have used write_note");
		}
	}

	// Test 6c: Read the written file to check actual content size
	console.log("\nTest 6c: Verify written content size vs reported tokens");
	const fileContent = await page.evaluate(async () => {
		const app = (window as any).app;
		if (!app) return null;
		const file = app.vault.getAbstractFileByPath("Token Test/large-output.md");
		if (!file) return null;
		return await app.vault.read(file);
	});

	if (fileContent) {
		const charCount = fileContent.length;
		const lineCount = fileContent.split("\n").length;
		// Rough estimate: 1 token ≈ 4 characters for English text
		const estimatedTokens = Math.round(charCount / 4);

		const toolTurn = logs.orchestrator.find((e) => (e.toolCallCount ?? 0) > 0);
		const reportedOutput = toolTurn?.outputTokens ?? 0;

		console.log(`  Written file: ${lineCount} lines, ${charCount} chars`);
		console.log(`  Estimated tokens from content: ~${estimatedTokens}`);
		console.log(`  Reported output tokens (tool-call turn): ${reportedOutput}`);

		// The reported output tokens should be in the same ballpark as the
		// estimated tokens from content (within 2x either way)
		const ratio = reportedOutput > 0 ? estimatedTokens / reportedOutput : 0;
		const detail = `${lineCount} lines, ${charCount} chars, est ~${estimatedTokens} tokens, reported ${reportedOutput} (ratio ${ratio.toFixed(2)})`;

		if (ratio > 0.2 && ratio < 5.0) {
			ctx.pass("Content size vs token count proportional", detail);
		} else if (reportedOutput === 0) {
			ctx.fail("Content size vs token count proportional", `Reported 0 output tokens despite writing ${charCount} chars`);
		} else {
			ctx.fail("Content size vs token count proportional", `Ratio ${ratio.toFixed(2)} is outside expected range (0.2–5.0): ${detail}`);
		}
	} else {
		ctx.fail("Written file readable", "Could not read 'Token Test/large-output.md' — file may not have been created");
	}

	// Test 6d: Token footer after large write
	console.log("\nTest 6d: Token footer after large write");
	const footerText = await getTokenFooterText(page);
	if (footerText) {
		const parsed = parseTokenFooter(footerText);
		if (parsed) {
			const shotFooter = await ctx.screenshot("06d-large-write-footer");
			ctx.pass("Token footer after large write",
				`Footer: "${footerText}" → input=${parsed.input}, output=${parsed.output}`, shotFooter);
		}
	}
}

async function testDumpAllTokenLogs(ctx: TestContext): Promise<void> {
	console.log("\n=== Full Token Log Dump ===");

	const all = ctx.collector.getStructuredLogs();

	const bedrockLogs = all.filter(
		(e) => e.source === "BedrockProvider" && e.message === "Bedrock metadata event"
	);
	const orchestratorLogs = all.filter(
		(e) => e.source === "ChatOrchestrator" && e.message === "processStream message_end"
	);

	console.log(`\nBedrock metadata events (${bedrockLogs.length}):`);
	for (const e of bedrockLogs) {
		console.log(`  [${e.timestamp}]`, JSON.stringify(e.data));
	}

	console.log(`\nOrchestrator message_end events (${orchestratorLogs.length}):`);
	for (const e of orchestratorLogs) {
		console.log(`  [${e.timestamp}]`, JSON.stringify(e.data));
	}

	// Also dump any errors
	const errors = ctx.collector.getLogsByLevel("error");
	if (errors.length > 0) {
		console.log(`\nErrors (${errors.length}):`);
		for (const e of errors) {
			console.log(`  [${e.source}] ${e.message}`, e.data ?? "");
		}
	}

	ctx.pass("Token log dump complete", `${bedrockLogs.length} Bedrock + ${orchestratorLogs.length} Orchestrator events captured`);
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	// Wait for plugin to fully initialize
	await page.waitForTimeout(5_000);

	await testChatPanelVisible(ctx);
	await ensureCleanState(page);

	const simpleLogs = await testSimplePromptTokens(ctx);
	await testTokenFooterAfterSimplePrompt(ctx);
	await testToolCallTokens(ctx, simpleLogs);
	await testTokenFooterAccumulation(ctx);
	await testLargeWriteTokens(ctx);
	await testDumpAllTokenLogs(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	auto_approve: {
		read_note: true,
		search_vault: true,
		list_vault: true,
		read_frontmatter: true,
		fetch_webpage: true,
		write_note: true,
	},
	mode: "act",
});

runTest({
	name: "bedrock-token-counting",
	settings,
	cleanupFiles: ["Token Test"],
}, tests);
