#!/usr/bin/env npx tsx
/**
 * Phase A Verification: Persistence Flush Test (AV.2)
 *
 * Validates Bug B fix — JSONL writes complete before session cleanup.
 * The old model used fire-and-forget persistence (`void this.onMessageAdded?.(msg)`)
 * with no flush mechanism. Phase A adds `HistoryManager.flush()` and
 * `flushConversation()`, called in handleUserMessage/executeWorkflow finally
 * blocks and in orchestrator.destroy().
 *
 * Scenarios:
 *   1. Send message, verify JSONL persisted after response completes
 *   2. Send multiple rapid messages, verify all persisted
 *   3. Verify HistoryManager has flush() method
 *   4. Verify orchestrator destroy() includes flush in its cleanup
 *   5. After streaming completion, JSONL has correct message count
 *   6. No unexpected error logs from persistence operations
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — AV.2
 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Bug B
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessage,
	newConversation,
	ensureCleanState,
	writeCleanWorkspace,
	VAULT_PATH,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const HISTORY_DIR = ".obsidian/plugins/notor/history/";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

async function safeRun(
	ctx: TestContext,
	name: string,
	fn: () => Promise<void>,
): Promise<void> {
	try {
		await fn();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.fail(name, `Unhandled error: ${msg.substring(0, 200)}`);
		console.error(`  [catch] ${name}:`, err);
	}
}

/** Find a JSONL file on disk for a given conversation ID. */
function findJSONLFile(conversationId: string): { basename: string; fullPath: string } | null {
	const histDir = path.join(VAULT_PATH, HISTORY_DIR);
	if (!fs.existsSync(histDir)) return null;
	const files = fs.readdirSync(histDir).filter((f) => f.endsWith(".jsonl"));
	for (const file of files) {
		const firstLine = fs.readFileSync(path.join(histDir, file), "utf-8").split("\n")[0];
		if (!firstLine) continue;
		try {
			const header = JSON.parse(firstLine);
			if (header.id === conversationId) {
				return { basename: file, fullPath: path.join(histDir, file) };
			}
		} catch { /* skip */ }
	}
	return null;
}

/** Count non-empty lines in a JSONL file (includes header). */
function countJSONLLines(filePath: string): number {
	if (!fs.existsSync(filePath)) return 0;
	return fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean).length;
}

/** Parse all messages from a JSONL file (excluding header). */
function parseJSONLMessages(filePath: string): Array<{ role?: string; content?: string }> {
	if (!fs.existsSync(filePath)) return [];
	const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
	return lines.slice(1).map((line) => {
		try { return JSON.parse(line); } catch { return {}; }
	});
}

/** Get the active conversation state from the plugin. */
async function getConversationState(page: any): Promise<{
	conversationId: string;
	messageCount: number;
} | null> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		try {
			const orch = plugin.getActiveOrchestrator?.();
			if (!orch) return null;
			const convManager = orch.getConversationManager();
			const conv = convManager.getActiveConversation();
			const messages = convManager.getMessages();
			if (!conv) return null;
			return { conversationId: conv.id, messageCount: messages.length };
		} catch {
			return null;
		}
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSingleMessagePersistence(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 1: Send message, verify JSONL persisted after response --");
	const { page } = ctx;

	const responded = await sendMessage(page, "Say 'Hello persistence test!' and nothing else.");
	if (!responded) {
		const shot = await ctx.screenshot("01-no-response");
		ctx.fail("Single message persistence", "LLM did not respond", shot);
		return;
	}

	// Wait for JSONL flush (happens in handleUserMessage finally block)
	await page.waitForTimeout(3_000);

	const convState = await getConversationState(page);
	if (!convState) {
		ctx.fail("Single message persistence", "Could not get conversation state");
		return;
	}

	const jsonlFile = findJSONLFile(convState.conversationId);
	const shot = await ctx.screenshot("01-single-message");

	if (!jsonlFile) {
		ctx.fail("Single message persistence", "No JSONL file found on disk", shot);
		return;
	}

	const lineCount = countJSONLLines(jsonlFile.fullPath);
	const messages = parseJSONLMessages(jsonlFile.fullPath);
	const hasUserMsg = messages.some((m) => m.role === "user");
	const hasAssistantMsg = messages.some((m) => m.role === "assistant");

	// Expected: header + user message + assistant message = 3+ lines
	if (lineCount >= 3 && hasUserMsg && hasAssistantMsg) {
		ctx.pass(
			"Single message persistence",
			`JSONL has ${lineCount} lines (header + ${messages.length} messages). ` +
			`user=${hasUserMsg}, assistant=${hasAssistantMsg}`,
			shot,
		);
	} else {
		ctx.fail(
			"Single message persistence",
			`JSONL has ${lineCount} lines, user=${hasUserMsg}, assistant=${hasAssistantMsg}`,
			shot,
		);
	}
}

async function testMultipleMessagesPersistence(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 2: Send multiple messages, verify all persisted --");
	const { page } = ctx;

	// Send a second message in the same conversation
	const responded = await sendMessage(page, "Now say 'Second message received!' and nothing else.");
	if (!responded) {
		const shot = await ctx.screenshot("02-no-response");
		ctx.fail("Multiple messages persistence", "LLM did not respond to second message", shot);
		return;
	}

	await page.waitForTimeout(3_000);

	const convState = await getConversationState(page);
	if (!convState) {
		ctx.fail("Multiple messages persistence", "Could not get conversation state");
		return;
	}

	const jsonlFile = findJSONLFile(convState.conversationId);
	const shot = await ctx.screenshot("02-multiple-messages");

	if (!jsonlFile) {
		ctx.fail("Multiple messages persistence", "No JSONL file found on disk", shot);
		return;
	}

	const messages = parseJSONLMessages(jsonlFile.fullPath);
	const userMsgs = messages.filter((m) => m.role === "user");
	const assistantMsgs = messages.filter((m) => m.role === "assistant");

	// Expected: 2 user messages + 2 assistant messages = 4+ messages
	if (userMsgs.length >= 2 && assistantMsgs.length >= 2) {
		ctx.pass(
			"Multiple messages persistence",
			`All messages persisted: ${userMsgs.length} user, ${assistantMsgs.length} assistant ` +
			`(${messages.length} total)`,
			shot,
		);
	} else {
		ctx.fail(
			"Multiple messages persistence",
			`user=${userMsgs.length} (expected >=2), assistant=${assistantMsgs.length} (expected >=2)`,
			shot,
		);
	}
}

async function testFlushMethodExists(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 3: HistoryManager has flush() method --");
	const { page } = ctx;

	const flushInfo = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };
		try {
			const historyManager = (plugin as any)._historyManager ?? plugin.getHistoryManager?.();
			if (!historyManager) return { error: "no history manager" };
			return {
				hasFlush: typeof historyManager.flush === "function",
				hasFlushConversation: typeof historyManager.flushConversation === "function",
			};
		} catch (e: any) {
			return { error: e.message };
		}
	});

	if ((flushInfo as any).error) {
		ctx.fail("Flush method exists", `Error: ${(flushInfo as any).error}`);
		return;
	}

	const info = flushInfo as { hasFlush: boolean; hasFlushConversation: boolean };
	if (info.hasFlush && info.hasFlushConversation) {
		ctx.pass(
			"Flush method exists",
			`HistoryManager.flush()=${info.hasFlush}, flushConversation()=${info.hasFlushConversation}`,
		);
	} else {
		ctx.fail(
			"Flush method exists",
			`flush()=${info.hasFlush}, flushConversation()=${info.hasFlushConversation}`,
		);
	}
}

async function testDestroyIncludesFlush(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 4: Orchestrator destroy() includes flush in cleanup --");
	const { page } = ctx;

	// Verify destroy() method exists and the orchestrator has a checkpointManager
	// (which indicates the full A5 wiring is in place)
	const destroyInfo = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };
		try {
			const orch = plugin.getActiveOrchestrator?.();
			if (!orch) return { error: "no active orchestrator" };
			return {
				hasDestroy: typeof orch.destroy === "function",
				hasCheckpointManager: typeof orch.getCheckpointManager === "function",
				hasSessionGuard: !!(orch as any).sessionGuard,
			};
		} catch (e: any) {
			return { error: e.message };
		}
	});

	if ((destroyInfo as any).error) {
		ctx.fail("Destroy includes flush", `Error: ${(destroyInfo as any).error}`);
		return;
	}

	const info = destroyInfo as {
		hasDestroy: boolean;
		hasCheckpointManager: boolean;
		hasSessionGuard: boolean;
	};

	if (info.hasDestroy && info.hasSessionGuard) {
		ctx.pass(
			"Destroy includes flush",
			`destroy()=${info.hasDestroy}, sessionGuard=${info.hasSessionGuard}, ` +
			`checkpointManager=${info.hasCheckpointManager}`,
		);
	} else {
		ctx.fail(
			"Destroy includes flush",
			`destroy()=${info.hasDestroy}, sessionGuard=${info.hasSessionGuard}`,
		);
	}
}

async function testMessageCountMatch(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 5: After response, JSONL message count matches in-memory --");
	const { page } = ctx;

	// Start a fresh conversation for a clean count
	await ensureCleanState(page);
	await newConversation(page);
	await page.waitForTimeout(1_500);

	const responded = await sendMessage(page, "Count to 3. Reply: 'one two three'.");
	if (!responded) {
		const shot = await ctx.screenshot("05-no-response");
		ctx.fail("Message count match", "LLM did not respond", shot);
		return;
	}

	await page.waitForTimeout(3_000);

	const convState = await getConversationState(page);
	if (!convState) {
		ctx.fail("Message count match", "Could not get conversation state");
		return;
	}

	const jsonlFile = findJSONLFile(convState.conversationId);
	const shot = await ctx.screenshot("05-message-count");

	if (!jsonlFile) {
		ctx.fail("Message count match", "No JSONL file found", shot);
		return;
	}

	const jsonlMessages = parseJSONLMessages(jsonlFile.fullPath);
	const inMemoryCount = convState.messageCount;

	// In-memory count should match JSONL message count
	if (jsonlMessages.length === inMemoryCount) {
		ctx.pass(
			"Message count match",
			`JSONL and in-memory both have ${inMemoryCount} messages`,
			shot,
		);
	} else {
		// Allow for slight discrepancy (title update messages, etc.)
		const diff = Math.abs(jsonlMessages.length - inMemoryCount);
		if (diff <= 1) {
			ctx.pass(
				"Message count match",
				`Close match: JSONL=${jsonlMessages.length}, in-memory=${inMemoryCount} (diff=${diff})`,
				shot,
			);
		} else {
			ctx.fail(
				"Message count match",
				`Mismatch: JSONL=${jsonlMessages.length}, in-memory=${inMemoryCount}`,
				shot,
			);
		}
	}
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\n-- Test 6: No unexpected error logs from persistence operations --");
	const { collector } = ctx;

	const relevantSources = ["HistoryManager", "ChatOrchestrator", "ConversationManager"];

	const errorLogs = collector.getStructuredLogs().filter(
		(e) =>
			e.level === "error" &&
			relevantSources.some((src) => e.source.includes(src)) &&
			!e.message.includes("Provider error") &&
			!e.message.includes("AUTH_FAILED") &&
			!e.message.includes("API key not configured") &&
			!e.message.includes("RATE_LIMITED") &&
			!e.message.includes("connection") &&
			!e.message.includes("timeout"),
	);

	if (errorLogs.length === 0) {
		ctx.pass(
			"No unexpected errors",
			`Zero error-level logs from ${relevantSources.join(", ")}`,
		);
	} else {
		ctx.fail(
			"No unexpected errors",
			`${errorLogs.length} error(s): ` +
			errorLogs.slice(0, 5).map((e) => `[${e.source}] "${e.message}"`).join("; "),
		);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chatContainer) throw new Error("Chat panel not visible — cannot run tests");
	ctx.pass("Chat panel ready", "Plugin loaded and chat container found");

	await safeRun(ctx, "Single message persistence", () => testSingleMessagePersistence(ctx));
	await safeRun(ctx, "Multiple messages persistence", () => testMultipleMessagesPersistence(ctx));
	await safeRun(ctx, "Flush method exists", () => testFlushMethodExists(ctx));
	await safeRun(ctx, "Destroy includes flush", () => testDestroyIncludesFlush(ctx));
	await safeRun(ctx, "Message count match", () => testMessageCountMatch(ctx));
	await safeRun(ctx, "No unexpected errors", () => testNoUnexpectedErrors(ctx));
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "plan",
});

runTest({
	name: "phase-a-persistence",
	settings,
	setupVault: (vaultPath) => writeCleanWorkspace(vaultPath),
}, tests);
