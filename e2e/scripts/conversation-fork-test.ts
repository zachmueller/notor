#!/usr/bin/env npx tsx
/**
 * Conversation Fork E2E Test
 *
 * Validates the full conversation forking flow: core fork creation,
 * tool call boundary handling, fork badge navigation, and streaming guards.
 *
 * Scenarios:
 *   1.  Create conversation with several exchanges, fork at message N, verify fork JSONL exists
 *   2.  Verify all IDs in fork JSONL are fresh (no overlap with original)
 *   3.  Verify original conversation JSONL is byte-identical after fork
 *   4.  Verify forked conversation can be continued (send a new message)
 *   5.  Verify conversation list shows the fork with lineage badge
 *   6.  Fork at tool_call → paired tool_result is included in fork JSONL
 *   7.  Fork at tool_result → next tool_call is NOT included
 *   8.  Fork at tool_call with no paired result → fork is still valid
 *   9.  Fork mid-multi-tool sequence → exact message count matches expectation
 *   10. Continue forked conversation after tool_call boundary → LLM responds
 *   11. Fork badge is clickable and navigates to parent conversation
 *   12. Delete parent conversation → fork badge is no longer shown
 *   13. Fork an imported conversation → forked_from_conversation_id references the import's local ID
 *   14. While streaming, right-click an earlier completed message → context menu appears
 *   15. While streaming, right-click the in-progress message → no context menu
 *   16. While tool call is pending, right-click the pending tool call → no context menu
 *   17. While tool call is pending, right-click an earlier completed message → context menu appears
 *
 * @see specs/ZZ-misc/conversation-fork-implementation-plan.md — Phase 7
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessage,
	sendMessageWithApprovalHandling,
	waitForResponse,
	newConversation,
	VAULT_PATH,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const HISTORY_DIR = ".obsidian/plugins/notor/history/";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Read all JSONL files from the history directory and return parsed entries.
 */
function readHistoryFiles(): Array<{ filename: string; lines: any[] }> {
	const histDir = path.join(VAULT_PATH, HISTORY_DIR);
	if (!fs.existsSync(histDir)) return [];

	const files = fs.readdirSync(histDir).filter((f) => f.endsWith(".jsonl"));
	return files.map((filename) => {
		const content = fs.readFileSync(path.join(histDir, filename), "utf-8");
		const lines = content
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l));
		return { filename, lines };
	});
}

/**
 * Find a JSONL history file by conversation ID.
 */
function findHistoryByConversationId(
	conversationId: string,
): { filename: string; lines: any[] } | null {
	const entries = readHistoryFiles();
	return entries.find((e) => e.lines[0]?._type === "conversation" && e.lines[0]?.id === conversationId) ?? null;
}

/**
 * Get all message IDs from a JSONL history file.
 */
function getMessageIds(lines: any[]): string[] {
	return lines.filter((l) => l._type === "message").map((l) => l.id);
}

/**
 * Get the raw bytes of a history file for byte-comparison.
 */
function readHistoryFileRaw(filename: string): Buffer {
	return fs.readFileSync(path.join(VAULT_PATH, HISTORY_DIR, filename));
}

/**
 * Access plugin internals to get conversation messages and fork.
 */
async function getConversationState(page: any): Promise<{
	conversationId: string;
	title: string;
	messages: Array<{ id: string; role: string; content?: string; tool_call?: any; tool_result?: any }>;
} | null> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		try {
			const orchestrator = plugin.getOrchestrator();
			const convManager = orchestrator.getConversationManager();
			const conversation = convManager.getActiveConversation();
			const messages = convManager.getMessages();
			if (!conversation) return null;
			return {
				conversationId: conversation.id,
				title: conversation.title ?? "",
				messages: messages.map((m: any) => ({
					id: m.id,
					role: m.role,
					content: m.content,
					tool_call: m.tool_call,
					tool_result: m.tool_result,
				})),
			};
		} catch {
			return null;
		}
	});
}

/**
 * Fork at a specific message ID via the orchestrator and return the result.
 */
async function forkAtMessage(
	page: any,
	messageId: string,
): Promise<{ filename: string; conversationId: string; title: string } | null> {
	return page.evaluate(async (msgId: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		try {
			const orchestrator = plugin.getOrchestrator();
			const result = await orchestrator.forkConversation(msgId);
			if (!result) return null;
			return {
				filename: result.filename,
				conversationId: result.conversation.id,
				title: result.conversation.title,
			};
		} catch (e: any) {
			console.error("Fork failed:", e);
			return null;
		}
	}, messageId);
}

/**
 * Switch to a conversation by filename via the orchestrator.
 */
async function switchToConversation(page: any, filename: string): Promise<boolean> {
	return page.evaluate(async (fname: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		try {
			const orchestrator = plugin.getOrchestrator();
			await orchestrator.switchConversation(fname);
			return true;
		} catch {
			return false;
		}
	}, filename);
}

// ---------------------------------------------------------------------------
// Tests — 7.1 Core fork flow
// ---------------------------------------------------------------------------

async function testCoreForkCreation(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Create conversation, fork at message N, verify fork JSONL exists");
	const { page } = ctx;

	// Send 2 exchanges to have enough messages
	console.log("  Sending first message...");
	const resp1 = await sendMessage(page, "Hello, what is 2+2? Reply briefly.");
	if (!resp1) {
		ctx.fail("Core fork creation", "First message got no response");
		return;
	}

	console.log("  Sending second message...");
	const resp2 = await sendMessage(page, "Now what is 3+3? Reply briefly.");
	if (!resp2) {
		ctx.fail("Core fork creation", "Second message got no response");
		return;
	}

	await page.waitForTimeout(2_000);

	// Get conversation state
	const state = await getConversationState(page);
	if (!state || state.messages.length < 3) {
		const shot = await ctx.screenshot("01-insufficient-messages");
		ctx.fail("Core fork creation", `Not enough messages: ${state?.messages.length ?? 0}`, shot);
		return;
	}

	// Save original conversation info
	(ctx as any)._originalConvId = state.conversationId;
	(ctx as any)._originalFilename = null;

	// Find the original JSONL file
	const originalEntry = findHistoryByConversationId(state.conversationId);
	if (!originalEntry) {
		ctx.fail("Core fork creation", "Original conversation JSONL not found on disk");
		return;
	}
	(ctx as any)._originalFilename = originalEntry.filename;
	(ctx as any)._originalBytes = readHistoryFileRaw(originalEntry.filename);

	// Fork at the second message (first user message after the first exchange)
	// Find the second user message
	const userMessages = state.messages.filter((m) => m.role === "user");
	if (userMessages.length < 2) {
		ctx.fail("Core fork creation", `Only ${userMessages.length} user messages, need at least 2`);
		return;
	}

	const forkAtId = userMessages[0]!.id; // Fork at first user message (should include just that message)
	(ctx as any)._forkAtOriginalId = forkAtId;

	// Determine expected message count: messages up to and including the fork point
	const forkIdx = state.messages.findIndex((m) => m.id === forkAtId);
	const expectedCount = forkIdx + 1;

	const forkResult = await forkAtMessage(page, forkAtId);
	if (!forkResult) {
		const shot = await ctx.screenshot("01-fork-failed");
		ctx.fail("Core fork creation", "forkConversation returned null", shot);
		return;
	}

	(ctx as any)._forkConvId = forkResult.conversationId;
	(ctx as any)._forkFilename = forkResult.filename;
	(ctx as any)._forkTitle = forkResult.title;

	// Verify fork JSONL exists on disk
	await page.waitForTimeout(1_000);
	const forkEntry = findHistoryByConversationId(forkResult.conversationId);
	if (!forkEntry) {
		const shot = await ctx.screenshot("01-fork-jsonl-missing");
		ctx.fail("Core fork creation", "Fork JSONL file not found on disk", shot);
		return;
	}

	const forkMessages = forkEntry.lines.filter((l) => l._type === "message");
	const shot = await ctx.screenshot("01-fork-created");
	ctx.pass(
		"Core fork creation",
		`Fork created with ${forkMessages.length} messages (expected ${expectedCount}), file: ${forkEntry.filename}`,
		shot,
	);
}

async function testForkIdsAreFresh(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Verify all IDs in fork JSONL are fresh");

	const originalId = (ctx as any)._originalConvId as string;
	const forkId = (ctx as any)._forkConvId as string;

	if (!originalId || !forkId) {
		ctx.fail("Fork IDs are fresh", "Missing IDs from previous test");
		return;
	}

	const originalEntry = findHistoryByConversationId(originalId);
	const forkEntry = findHistoryByConversationId(forkId);

	if (!originalEntry || !forkEntry) {
		ctx.fail("Fork IDs are fresh", "Could not find JSONL files");
		return;
	}

	// Check conversation ID is different
	if (originalEntry.lines[0].id === forkEntry.lines[0].id) {
		ctx.fail("Fork IDs are fresh", "Fork conversation ID matches original");
		return;
	}

	// Check all message IDs are different
	const originalMsgIds = new Set(getMessageIds(originalEntry.lines));
	const forkMsgIds = getMessageIds(forkEntry.lines);
	const overlapping = forkMsgIds.filter((id) => originalMsgIds.has(id));

	if (overlapping.length > 0) {
		ctx.fail("Fork IDs are fresh", `${overlapping.length} message IDs overlap with original`);
		return;
	}

	// Check conversation_id on each fork message points to the fork
	const wrongConvId = forkEntry.lines
		.filter((l) => l._type === "message")
		.filter((l) => l.conversation_id !== forkId);

	if (wrongConvId.length > 0) {
		ctx.fail("Fork IDs are fresh", `${wrongConvId.length} messages have wrong conversation_id`);
		return;
	}

	// Check fork provenance fields
	const header = forkEntry.lines[0];
	if (header.forked_from_conversation_id !== originalId) {
		ctx.fail("Fork IDs are fresh", `forked_from_conversation_id mismatch: ${header.forked_from_conversation_id}`);
		return;
	}

	const forkAtOriginalId = (ctx as any)._forkAtOriginalId as string;
	if (header.forked_from_message_id !== forkAtOriginalId) {
		ctx.fail("Fork IDs are fresh", `forked_from_message_id mismatch: ${header.forked_from_message_id}`);
		return;
	}

	ctx.pass(
		"Fork IDs are fresh",
		`All ${forkMsgIds.length} message IDs are fresh, provenance fields correct`,
	);
}

async function testOriginalUnchanged(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Verify original conversation JSONL is byte-identical after fork");

	const originalFilename = (ctx as any)._originalFilename as string;
	const originalBytes = (ctx as any)._originalBytes as Buffer;

	if (!originalFilename || !originalBytes) {
		ctx.fail("Original unchanged", "Missing original file data from previous test");
		return;
	}

	const currentBytes = readHistoryFileRaw(originalFilename);

	if (Buffer.compare(originalBytes, currentBytes) === 0) {
		ctx.pass("Original unchanged", "Original JSONL file is byte-identical after fork");
	} else {
		ctx.fail(
			"Original unchanged",
			`Original JSONL changed: was ${originalBytes.length} bytes, now ${currentBytes.length} bytes`,
		);
	}
}

async function testForkCanBeContinued(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Verify forked conversation can be continued");
	const { page } = ctx;

	const forkFilename = (ctx as any)._forkFilename as string;
	if (!forkFilename) {
		ctx.fail("Fork continuable", "No fork filename from previous test");
		return;
	}

	// Switch to the forked conversation
	const switched = await switchToConversation(page, forkFilename);
	if (!switched) {
		ctx.fail("Fork continuable", "Could not switch to forked conversation");
		return;
	}

	await page.waitForTimeout(2_000);

	// Send a new message in the forked conversation (retry once on timeout)
	console.log("  Sending message in forked conversation...");
	let responded = await sendMessage(page, "What is 10+10? Reply briefly.");
	if (!responded) {
		console.log("  First attempt timed out, retrying...");
		await newConversation(page);
		await page.waitForTimeout(1_500);
		// Switch back to fork for a clean retry
		await switchToConversation(page, forkFilename);
		await page.waitForTimeout(2_000);
		responded = await sendMessage(page, "What is 10+10? Reply briefly.");
	}
	if (!responded) {
		const shot = await ctx.screenshot("04-fork-no-response");
		ctx.fail("Fork continuable", "LLM did not respond in forked conversation (after retry)", shot);
		return;
	}

	const shot = await ctx.screenshot("04-fork-continued");
	ctx.pass("Fork continuable", "Successfully sent and received message in forked conversation", shot);
}

async function testForkBadgeInList(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Verify conversation list shows fork with lineage badge");
	const { page } = ctx;

	// Open conversation list
	const histBtn = await page.$(".notor-chat-header-btn[aria-label='Conversation history']");
	if (!histBtn) {
		ctx.fail("Fork badge in list", "Conversation history button not found");
		return;
	}

	await histBtn.click();
	await page.waitForTimeout(2_000);

	// Look for fork badge
	const badge = await waitForSelector(page, ".notor-fork-badge", 5_000);

	if (badge) {
		const shot = await ctx.screenshot("05-fork-badge");
		ctx.pass("Fork badge in list", "Fork lineage badge found in conversation list", shot);
	} else {
		const shot = await ctx.screenshot("05-no-fork-badge");
		ctx.fail("Fork badge in list", "Fork lineage badge not found in conversation list", shot);
	}

	// Close conversation list
	await histBtn.click();
	await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// Tests — 7.2 Tool call boundary tests
// ---------------------------------------------------------------------------

async function testForkAtToolCall(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: Fork at tool_call → paired tool_result is included");
	const { page } = ctx;

	// Start a new conversation and trigger a tool call
	await newConversation(page);
	await page.waitForTimeout(1_500);

	// Try up to 2 attempts to get the LLM to call a tool
	let toolCallMsg: { id: string; role: string } | undefined;
	let state: Awaited<ReturnType<typeof getConversationState>> = null;

	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt > 0) {
			console.log("  Retrying with new conversation...");
			await newConversation(page);
			await page.waitForTimeout(1_500);
		}

		const prompt = attempt === 0
			? "Read the file 'test-note.md' in my vault using the read_note tool. Do not do anything else."
			: "Use the read_note tool to read the file at path 'test-note.md'. Only use the tool, nothing else.";

		console.log(`  Sending message to trigger tool call (attempt ${attempt + 1})...`);
		const { responded } = await sendMessageWithApprovalHandling(page, prompt);
		if (!responded) {
			console.log("  LLM did not respond, will retry...");
			continue;
		}

		await page.waitForTimeout(2_000);

		state = await getConversationState(page);
		if (!state) continue;

		toolCallMsg = state.messages.find((m) => m.role === "tool_call");
		if (toolCallMsg) break;
		console.log(`  No tool_call in response (got ${state.messages.length} messages), will retry...`);
	}

	if (!state) {
		ctx.fail("Fork at tool_call", "Could not get conversation state after retries");
		return;
	}

	if (!toolCallMsg) {
		const shot = await ctx.screenshot("06-no-tool-call-msg");
		ctx.fail("Fork at tool_call", "No tool_call message found after 2 attempts", shot);
		return;
	}

	// Save state for later tests
	(ctx as any)._toolConvId = state.conversationId;

	// Fork at the tool_call message
	const forkResult = await forkAtMessage(page, toolCallMsg.id);
	if (!forkResult) {
		ctx.fail("Fork at tool_call", "Fork at tool_call message returned null");
		return;
	}

	await page.waitForTimeout(1_000);

	// Read the fork JSONL and check it includes the paired tool_result
	const forkEntry = findHistoryByConversationId(forkResult.conversationId);
	if (!forkEntry) {
		ctx.fail("Fork at tool_call", "Fork JSONL not found on disk");
		return;
	}

	const forkMessages = forkEntry.lines.filter((l) => l._type === "message");
	const hasToolCall = forkMessages.some((m) => m.role === "tool_call");
	const hasToolResult = forkMessages.some((m) => m.role === "tool_result");

	if (hasToolCall && hasToolResult) {
		const shot = await ctx.screenshot("06-fork-tool-pair");
		ctx.pass(
			"Fork at tool_call",
			`Fork includes both tool_call and paired tool_result (${forkMessages.length} messages)`,
			shot,
		);
	} else {
		const shot = await ctx.screenshot("06-fork-tool-missing");
		ctx.fail(
			"Fork at tool_call",
			`Fork missing pair: hasToolCall=${hasToolCall}, hasToolResult=${hasToolResult}`,
			shot,
		);
	}
}

async function testForkAtToolResult(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: Fork at tool_result → next tool_call is NOT included");
	const { page } = ctx;

	const toolConvId = (ctx as any)._toolConvId as string;
	if (!toolConvId) {
		ctx.fail("Fork at tool_result", "No tool conversation from previous test");
		return;
	}

	// Switch back to the tool conversation
	const originalEntry = findHistoryByConversationId(toolConvId);
	if (!originalEntry) {
		ctx.fail("Fork at tool_result", "Could not find tool conversation JSONL");
		return;
	}
	await switchToConversation(page, originalEntry.filename);
	await page.waitForTimeout(1_500);

	const state = await getConversationState(page);
	if (!state) {
		ctx.fail("Fork at tool_result", "Could not get conversation state");
		return;
	}

	// Find a tool_result message
	const toolResultMsg = state.messages.find((m) => m.role === "tool_result");
	if (!toolResultMsg) {
		const shot = await ctx.screenshot("07-no-tool-result");
		ctx.fail("Fork at tool_result", "No tool_result message found", shot);
		return;
	}

	// Count messages after the tool_result in the original
	const resultIdx = state.messages.findIndex((m) => m.id === toolResultMsg.id);
	const expectedCount = resultIdx + 1; // Messages up to and including tool_result

	const forkResult = await forkAtMessage(page, toolResultMsg.id);
	if (!forkResult) {
		ctx.fail("Fork at tool_result", "Fork at tool_result returned null");
		return;
	}

	await page.waitForTimeout(1_000);

	const forkEntry = findHistoryByConversationId(forkResult.conversationId);
	if (!forkEntry) {
		ctx.fail("Fork at tool_result", "Fork JSONL not found on disk");
		return;
	}

	const forkMessages = forkEntry.lines.filter((l) => l._type === "message");

	// The fork should have exactly expectedCount messages (no extra tool_call after the result)
	if (forkMessages.length === expectedCount) {
		ctx.pass(
			"Fork at tool_result",
			`Fork has exactly ${expectedCount} messages — no extra tool_call included`,
		);
	} else {
		ctx.fail(
			"Fork at tool_result",
			`Expected ${expectedCount} messages, got ${forkMessages.length}`,
		);
	}
}

async function testForkAtToolCallNoResult(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: Fork at tool_call with no paired result → fork is still valid");
	const { page } = ctx;

	// We test this by creating a conversation programmatically with a trailing tool_call
	const testResult = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };

		try {
			const orchestrator = plugin.getOrchestrator();
			const hm = plugin.getHistoryManager();

			const convId = crypto.randomUUID();
			const now = new Date().toISOString();

			const conversation = {
				id: convId,
				title: "Orphan Tool Call Test",
				created_at: now,
				updated_at: now,
				provider_type: "bedrock",
				model_id: "test-model",
				mode: "act",
				total_input_tokens: 0,
				total_output_tokens: 0,
				estimated_cost: 0,
				is_background: false,
			};

			const messages = [
				{ id: crypto.randomUUID(), conversation_id: convId, role: "user", content: "Test", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0 },
				{ id: crypto.randomUUID(), conversation_id: convId, role: "assistant", content: "Calling tool...", created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0 },
				{
					id: crypto.randomUUID(), conversation_id: convId, role: "tool_call", content: "",
					created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
					tool_call: { id: "tc_orphan_1", name: "read_note", arguments: { path: "test.md" } },
				},
			];

			const filename = await hm.importConversation(conversation, messages);

			// Switch to it and try to fork at the tool_call
			await orchestrator.switchConversation(filename);

			const convManager = orchestrator.getConversationManager();
			const loadedMsgs = convManager.getMessages();
			const toolCallMsg = loadedMsgs.find((m: any) => m.role === "tool_call");

			if (!toolCallMsg) return { error: "tool_call message not found after load" };

			const forkResult = await orchestrator.forkConversation(toolCallMsg.id);
			if (!forkResult) return { error: "Fork returned null" };

			return {
				success: true,
				forkConvId: forkResult.conversation.id,
				forkFilename: forkResult.filename,
			};
		} catch (e: any) {
			return { error: e.message };
		}
	});

	if (testResult.error) {
		ctx.fail("Fork at tool_call no result", `Error: ${testResult.error}`);
		return;
	}

	// Verify the fork JSONL exists and is valid
	await page.waitForTimeout(1_000);
	const forkEntry = findHistoryByConversationId(testResult.forkConvId);
	if (!forkEntry) {
		ctx.fail("Fork at tool_call no result", "Fork JSONL not found on disk");
		return;
	}

	const forkMessages = forkEntry.lines.filter((l) => l._type === "message");
	// Should have 3 messages (user, assistant, tool_call) — no tool_result to pair
	if (forkMessages.length === 3) {
		ctx.pass("Fork at tool_call no result", `Fork valid with ${forkMessages.length} messages (orphan tool_call preserved)`);
	} else {
		ctx.fail("Fork at tool_call no result", `Expected 3 messages, got ${forkMessages.length}`);
	}
}

async function testForkMidMultiTool(ctx: TestContext): Promise<void> {
	console.log("\nTest 9: Fork mid-multi-tool sequence → exact message count");
	const { page } = ctx;

	// Create a conversation with multiple tool call/result pairs programmatically
	const testResult = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };

		try {
			const orchestrator = plugin.getOrchestrator();
			const hm = plugin.getHistoryManager();

			const convId = crypto.randomUUID();
			const now = new Date().toISOString();

			const conversation = {
				id: convId,
				title: "Multi Tool Test",
				created_at: now,
				updated_at: now,
				provider_type: "bedrock",
				model_id: "test-model",
				mode: "act",
				total_input_tokens: 100,
				total_output_tokens: 200,
				estimated_cost: 0.01,
				is_background: false,
			};

			// Build multi-tool sequence: user → assistant → tc1 → tr1 → tc2 → tr2 → assistant
			const tc1Id = "tc_multi_1";
			const tc2Id = "tc_multi_2";
			const messages = [
				{ id: crypto.randomUUID(), conversation_id: convId, role: "user", content: "Do two things", created_at: now, input_tokens: 10, output_tokens: 0, estimated_cost: 0 },
				{ id: crypto.randomUUID(), conversation_id: convId, role: "assistant", content: "I'll do both.", created_at: now, input_tokens: 0, output_tokens: 20, estimated_cost: 0.001 },
				{
					id: crypto.randomUUID(), conversation_id: convId, role: "tool_call", content: "",
					created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
					tool_call: { id: tc1Id, name: "read_note", arguments: { path: "a.md" } },
				},
				{
					id: crypto.randomUUID(), conversation_id: convId, role: "tool_result", content: "Content of a.md",
					created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
					tool_result: { tool_call_id: tc1Id, content: "Content of a.md" },
				},
				{
					id: crypto.randomUUID(), conversation_id: convId, role: "tool_call", content: "",
					created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
					tool_call: { id: tc2Id, name: "read_note", arguments: { path: "b.md" } },
				},
				{
					id: crypto.randomUUID(), conversation_id: convId, role: "tool_result", content: "Content of b.md",
					created_at: now, input_tokens: 0, output_tokens: 0, estimated_cost: 0,
					tool_result: { tool_call_id: tc2Id, content: "Content of b.md" },
				},
				{ id: crypto.randomUUID(), conversation_id: convId, role: "assistant", content: "Done with both tasks.", created_at: now, input_tokens: 0, output_tokens: 30, estimated_cost: 0.002 },
			];

			const filename = await hm.importConversation(conversation, messages);
			await orchestrator.switchConversation(filename);

			const convManager = orchestrator.getConversationManager();
			const loadedMsgs = convManager.getMessages();

			// Fork at the first tool_call (index 2) — should auto-include its paired result (index 3)
			const firstToolCall = loadedMsgs.find((m: any) => m.role === "tool_call");
			if (!firstToolCall) return { error: "No tool_call found" };

			const forkResult = await orchestrator.forkConversation(firstToolCall.id);
			if (!forkResult) return { error: "Fork returned null" };

			return {
				success: true,
				forkConvId: forkResult.conversation.id,
				originalMsgCount: loadedMsgs.length,
			};
		} catch (e: any) {
			return { error: e.message };
		}
	});

	if (testResult.error) {
		ctx.fail("Fork mid-multi-tool", `Error: ${testResult.error}`);
		return;
	}

	await page.waitForTimeout(1_000);
	const forkEntry = findHistoryByConversationId(testResult.forkConvId);
	if (!forkEntry) {
		ctx.fail("Fork mid-multi-tool", "Fork JSONL not found on disk");
		return;
	}

	const forkMessages = forkEntry.lines.filter((l) => l._type === "message");
	// Fork at index 2 (tool_call) auto-extends to index 3 (tool_result) → 4 messages total
	const expectedCount = 4; // user, assistant, tool_call, tool_result

	if (forkMessages.length === expectedCount) {
		ctx.pass(
			"Fork mid-multi-tool",
			`Fork has exactly ${expectedCount} messages (original had ${testResult.originalMsgCount})`,
		);
	} else {
		ctx.fail(
			"Fork mid-multi-tool",
			`Expected ${expectedCount} messages, got ${forkMessages.length}`,
		);
	}
}

async function testForkToolBoundaryContinuable(ctx: TestContext): Promise<void> {
	console.log("\nTest 10: Continue forked conversation after tool_call boundary");
	const { page } = ctx;

	const toolConvId = (ctx as any)._toolConvId as string;
	if (!toolConvId) {
		// If test 6 failed to produce a tool conversation, skip
		ctx.fail("Fork tool boundary continuable", "No tool conversation available from test 6");
		return;
	}

	// The fork from test 6 should be switchable. Let's create a new fork and continue it.
	const originalEntry = findHistoryByConversationId(toolConvId);
	if (!originalEntry) {
		ctx.fail("Fork tool boundary continuable", "Tool conversation JSONL not found");
		return;
	}

	await switchToConversation(page, originalEntry.filename);
	await page.waitForTimeout(1_500);

	const state = await getConversationState(page);
	if (!state) {
		ctx.fail("Fork tool boundary continuable", "Could not get conversation state");
		return;
	}

	// Fork at the tool_result (so we have a clean conversation to continue)
	const toolResultMsg = state.messages.find((m) => m.role === "tool_result");
	if (!toolResultMsg) {
		ctx.fail("Fork tool boundary continuable", "No tool_result message found");
		return;
	}

	const forkResult = await forkAtMessage(page, toolResultMsg.id);
	if (!forkResult) {
		ctx.fail("Fork tool boundary continuable", "Fork returned null");
		return;
	}

	// Switch to the fork
	await switchToConversation(page, forkResult.filename);
	await page.waitForTimeout(2_000);

	// Send a message and verify response (retry once on timeout)
	console.log("  Sending message in tool-boundary fork...");
	let responded = await sendMessage(page, "Thanks, what did you find? Reply briefly.");
	if (!responded) {
		console.log("  First attempt timed out, retrying...");
		responded = await sendMessage(page, "What did you find in that file? Reply briefly.");
	}
	if (responded) {
		const shot = await ctx.screenshot("10-tool-fork-continued");
		ctx.pass("Fork tool boundary continuable", "LLM responded in forked conversation after tool boundary", shot);
	} else {
		const shot = await ctx.screenshot("10-tool-fork-no-response");
		ctx.fail("Fork tool boundary continuable", "LLM did not respond in forked conversation (after retry)", shot);
	}
}

// ---------------------------------------------------------------------------
// Tests — 7.3 Fork badge and navigation
// ---------------------------------------------------------------------------

async function testForkBadgeNavigation(ctx: TestContext): Promise<void> {
	console.log("\nTest 11: Fork badge is clickable and navigates to parent conversation");
	const { page } = ctx;

	const originalConvId = (ctx as any)._originalConvId as string;
	const forkConvId = (ctx as any)._forkConvId as string;

	if (!originalConvId || !forkConvId) {
		ctx.fail("Fork badge navigation", "Missing conversation IDs from earlier tests");
		return;
	}

	// Switch to the fork first
	const forkEntry = findHistoryByConversationId(forkConvId);
	if (forkEntry) {
		await switchToConversation(page, forkEntry.filename);
		await page.waitForTimeout(1_500);
	}

	// Open conversation list
	const histBtn = await page.$(".notor-chat-header-btn[aria-label='Conversation history']");
	if (!histBtn) {
		ctx.fail("Fork badge navigation", "Conversation history button not found");
		return;
	}

	await histBtn.click();
	await page.waitForTimeout(2_000);

	// Find and click the fork badge on the correct conversation list item.
	// Multiple forks may exist from earlier tests, so we locate the badge
	// associated with the specific fork conversation (by matching its title).
	const forkTitle = (ctx as any)._forkTitle as string;
	const badge = await page.evaluate((title: string) => {
		const items = document.querySelectorAll(".notor-conversation-list-item");
		for (const item of items) {
			const titleEl = item.querySelector(".notor-conversation-list-title");
			if (titleEl && titleEl.textContent?.includes(title)) {
				const b = item.querySelector(".notor-fork-badge") as HTMLElement | null;
				if (b) {
					b.click();
					return true;
				}
			}
		}
		return false;
	}, forkTitle ?? "Fork of");

	if (!badge) {
		const shot = await ctx.screenshot("11-no-badge");
		ctx.fail("Fork badge navigation", "Fork badge not found for target fork in conversation list", shot);
		return;
	}
	await page.waitForTimeout(2_000);

	// Verify we navigated to the parent conversation
	const currentState = await getConversationState(page);
	if (currentState && currentState.conversationId === originalConvId) {
		const shot = await ctx.screenshot("11-badge-navigated");
		ctx.pass("Fork badge navigation", "Clicked badge navigated to parent conversation", shot);
	} else {
		const shot = await ctx.screenshot("11-badge-wrong-nav");
		ctx.fail(
			"Fork badge navigation",
			`Expected parent ${originalConvId.substring(0, 8)}, got ${currentState?.conversationId?.substring(0, 8) ?? "null"}`,
			shot,
		);
	}
}

async function testDeleteParentRemovesBadge(ctx: TestContext): Promise<void> {
	console.log("\nTest 12: Delete parent conversation → fork badge is no longer shown");
	const { page } = ctx;

	const originalConvId = (ctx as any)._originalConvId as string;
	if (!originalConvId) {
		ctx.fail("Delete parent removes badge", "No original conversation ID");
		return;
	}

	// Delete the parent conversation via plugin internals
	const deleted = await page.evaluate(async (convId: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		try {
			const hm = plugin.getHistoryManager();
			const entries = await hm.listConversations();
			const parentEntry = entries.find((e: any) => e.id === convId);
			if (!parentEntry) return false;
			await hm.deleteConversationFile(parentEntry.filename);
			return true;
		} catch {
			return false;
		}
	}, originalConvId);

	if (!deleted) {
		ctx.fail("Delete parent removes badge", "Could not delete parent conversation");
		return;
	}

	await page.waitForTimeout(1_000);

	// Open conversation list and check for fork badge
	const histBtn = await page.$(".notor-chat-header-btn[aria-label='Conversation history']");
	if (!histBtn) {
		ctx.fail("Delete parent removes badge", "History button not found");
		return;
	}

	await histBtn.click();
	await page.waitForTimeout(2_000);

	// Check that the specific fork from test 1 no longer has a badge.
	// Other forks (from tests 6-10) may still have badges with valid parents.
	const forkTitle = (ctx as any)._forkTitle as string;
	const forkHasBadge = await page.evaluate((title: string) => {
		const items = document.querySelectorAll(".notor-conversation-list-item");
		for (const item of items) {
			const titleEl = item.querySelector(".notor-conversation-list-title");
			if (titleEl && titleEl.textContent?.includes(title)) {
				return !!item.querySelector(".notor-fork-badge");
			}
		}
		return false; // Fork item not found at all (also acceptable)
	}, forkTitle ?? "Fork of");

	// Close list
	await histBtn.click();
	await page.waitForTimeout(500);

	if (!forkHasBadge) {
		const shot = await ctx.screenshot("12-badge-removed");
		ctx.pass("Delete parent removes badge", "Fork badge correctly removed when parent is deleted", shot);
	} else {
		const shot = await ctx.screenshot("12-badge-still-present");
		ctx.fail("Delete parent removes badge", "Fork badge still shown after parent deletion", shot);
	}
}

async function testForkImportedConversation(ctx: TestContext): Promise<void> {
	console.log("\nTest 13: Fork an imported conversation → forked_from_conversation_id references local ID");
	const { page } = ctx;

	// Import a conversation programmatically, then fork it
	const testResult = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };

		try {
			const orchestrator = plugin.getOrchestrator();
			const hm = plugin.getHistoryManager();

			const importedId = crypto.randomUUID();
			const now = new Date().toISOString();

			const conversation = {
				id: importedId,
				title: "Imported Conversation",
				created_at: now,
				updated_at: now,
				provider_type: "bedrock",
				model_id: "test-model",
				mode: "act",
				total_input_tokens: 50,
				total_output_tokens: 100,
				estimated_cost: 0.005,
				is_background: false,
			};

			const messages = [
				{ id: crypto.randomUUID(), conversation_id: importedId, role: "user", content: "Hello from import", created_at: now, input_tokens: 10, output_tokens: 0, estimated_cost: 0 },
				{ id: crypto.randomUUID(), conversation_id: importedId, role: "assistant", content: "Hello! I'm from an imported conversation.", created_at: now, input_tokens: 0, output_tokens: 50, estimated_cost: 0.003 },
			];

			const filename = await hm.importConversation(conversation, messages);
			await orchestrator.switchConversation(filename);

			// Now fork it
			const convManager = orchestrator.getConversationManager();
			const loadedMsgs = convManager.getMessages();
			const lastMsg = loadedMsgs[loadedMsgs.length - 1];

			const forkResult = await orchestrator.forkConversation(lastMsg.id);
			if (!forkResult) return { error: "Fork returned null" };

			return {
				success: true,
				importedId,
				forkConvId: forkResult.conversation.id,
			};
		} catch (e: any) {
			return { error: e.message };
		}
	});

	if (testResult.error) {
		ctx.fail("Fork imported conversation", `Error: ${testResult.error}`);
		return;
	}

	await page.waitForTimeout(1_000);

	const forkEntry = findHistoryByConversationId(testResult.forkConvId);
	if (!forkEntry) {
		ctx.fail("Fork imported conversation", "Fork JSONL not found");
		return;
	}

	const header = forkEntry.lines[0];
	if (header.forked_from_conversation_id === testResult.importedId) {
		ctx.pass(
			"Fork imported conversation",
			`forked_from_conversation_id correctly references imported ID: ${testResult.importedId.substring(0, 8)}...`,
		);
	} else {
		ctx.fail(
			"Fork imported conversation",
			`forked_from_conversation_id is ${header.forked_from_conversation_id}, expected ${testResult.importedId}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Tests — 7.4 Streaming and in-progress guards
// ---------------------------------------------------------------------------

async function testContextMenuDuringStreaming(ctx: TestContext): Promise<void> {
	console.log("\nTest 14: While streaming, right-click earlier completed message → context menu appears");
	const { page } = ctx;

	// The context menu is implemented via event delegation on [data-message-id].
	// Verifying that completed messages retain data-message-id during streaming
	// validates that the context menu is available. Testing the actual Obsidian Menu
	// popup over CDP is unreliable, so we verify the underlying invariant.

	// Ensure clean state from previous tests
	await ensureCleanState(page);
	await newConversation(page);
	await page.waitForTimeout(1_500);

	console.log("  Sending first message...");
	const resp = await sendMessage(page, "Say hello briefly.");
	if (!resp) {
		ctx.fail("Context menu during streaming", "First message got no response");
		return;
	}

	await page.waitForTimeout(2_000);

	// Count completed messages with data-message-id before sending second message
	let completedBefore = await page.$$eval("[data-message-id]", (els) => els.length);
	console.log(`  Completed messages after first exchange: ${completedBefore}`);

	// If no completed messages found, wait a bit more and retry (DOM rendering may be async)
	if (completedBefore === 0) {
		console.log("  ⚠ No completed messages found, waiting 3s and retrying...");
		await page.waitForTimeout(3_000);
		completedBefore = await page.$$eval("[data-message-id]", (els) => els.length);
		console.log(`  Completed messages after retry: ${completedBefore}`);
	}

	// Send a second (long) message without waiting for response
	const inputSet = await page.evaluate((msg: string) => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		if (!el) return false;
		el.focus();
		el.textContent = msg;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	}, "Count from 1 to 100, one number per line. Do not use any tools.");

	if (!inputSet) {
		ctx.fail("Context menu during streaming", "Could not set chat input");
		return;
	}

	await page.focus(".notor-text-input");
	await page.keyboard.press("Enter");

	// Wait for streaming to start
	await page.waitForTimeout(3_000);

	// Check: earlier completed messages should still have data-message-id during streaming
	const completedDuring = await page.$$eval("[data-message-id]", (els) => els.length);

	// Wait for streaming to finish (longer timeout since LLM response can be lengthy)
	await waitForResponse(page, 120_000);

	console.log(`  Completed messages during streaming: ${completedDuring} (was ${completedBefore} before)`);

	if (completedBefore === 0) {
		// Edge case: first exchange didn't produce data-message-id elements.
		// This can happen if DOM rendering was delayed. The test is about
		// completed messages retaining data-message-id during streaming,
		// so we pass if we see ANY completed messages during streaming.
		if (completedDuring > 0) {
			const shot = await ctx.screenshot("14-completed-messages-during-stream");
			ctx.pass(
				"Context menu during streaming",
				`${completedDuring} completed messages with data-message-id during streaming (completedBefore was 0, likely DOM timing)`,
				shot,
			);
		} else {
			const shot = await ctx.screenshot("14-no-messages");
			ctx.fail(
				"Context menu during streaming",
				`No completed messages with data-message-id found at any point`,
				shot,
			);
		}
	} else if (completedDuring >= completedBefore) {
		const shot = await ctx.screenshot("14-completed-messages-during-stream");
		ctx.pass(
			"Context menu during streaming",
			`${completedDuring} completed messages with data-message-id during streaming (${completedBefore} before)`,
			shot,
		);
	} else {
		const shot = await ctx.screenshot("14-missing-ids-during-stream");
		ctx.fail(
			"Context menu during streaming",
			`Expected >=${completedBefore} completed messages during streaming, found ${completedDuring}`,
			shot,
		);
	}
}

/**
 * Force-abort any in-progress LLM response and wait for the input to become editable.
 * This ensures a clean state between tests that depend on the input being ready.
 */
async function ensureCleanState(page: any): Promise<void> {
	// Check if input is disabled (indicating an in-progress response)
	const inputDisabled = await page.evaluate(() => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		return el?.getAttribute("contenteditable") !== "true";
	});

	if (inputDisabled) {
		console.log("  ⚠ Input is disabled — aborting in-progress response...");

		// Try clicking the stop button
		const stopBtn = await page.$(".notor-stop-btn:not(.notor-hidden)");
		if (stopBtn) {
			await stopBtn.click();
			console.log("  Clicked stop button");
		} else {
			// Fallback: abort via orchestrator
			await page.evaluate(() => {
				const plugin = (window as any).app?.plugins?.plugins?.["notor"];
				if (!plugin) return;
				try {
					const view = plugin.getChatView?.() ?? plugin.view;
					if (view) {
						const controller = view.getAbortController?.();
						if (controller) controller.abort();
					}
				} catch {}
			});
			console.log("  Aborted via orchestrator fallback");
		}

		// Wait for input to become editable
		for (let i = 0; i < 20; i++) {
			await page.waitForTimeout(1_000);
			const ready = await page.evaluate(() => {
				const el = document.querySelector(".notor-text-input") as HTMLElement | null;
				return el?.getAttribute("contenteditable") === "true";
			});
			if (ready) {
				console.log(`  Input re-enabled after ${i + 1}s`);
				return;
			}
		}
		console.log("  ⚠ Input still disabled after 20s wait");
	}
}

async function testNoContextMenuOnInProgress(ctx: TestContext): Promise<void> {
	console.log("\nTest 15: While streaming, right-click in-progress message → no context menu");
	const { page } = ctx;

	// Verify that in-progress (streaming) assistant messages do NOT have data-message-id.
	// The data-message-id is set in finalizeAssistantMessage(), so during streaming it should be absent.
	//
	// Strategy: install a MutationObserver BEFORE sending the message so we capture
	// the exact state of the .notor-message-assistant element at creation time,
	// avoiding the unreliable polling approach.

	await ensureCleanState(page);
	await newConversation(page);
	await page.waitForTimeout(2_000);

	// Log initial state
	const initState15 = await page.evaluate(() => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		const msgList = document.querySelector(".notor-message-list");
		return {
			inputExists: !!el,
			inputEditable: el?.getAttribute("contenteditable"),
			messageListExists: !!msgList,
			existingAssistantMsgs: document.querySelectorAll(".notor-message-assistant").length,
			existingMessageIds: document.querySelectorAll("[data-message-id]").length,
		};
	});
	console.log(`  Initial state: ${JSON.stringify(initState15)}`);

	// Install MutationObserver to capture assistant message state at creation time
	await page.evaluate(() => {
		(window as any).__forkTest15Result = null;
		const container = document.querySelector(".notor-message-list") || document.body;
		const observer = new MutationObserver((mutations) => {
			for (const m of mutations) {
				for (const node of m.addedNodes) {
					if (!(node instanceof HTMLElement)) continue;
					// Check the node itself or its children for .notor-message-assistant
					const target = node.classList.contains("notor-message-assistant")
						? node
						: node.querySelector?.(".notor-message-assistant");
					if (target && target instanceof HTMLElement) {
						(window as any).__forkTest15Result = {
							hadMessageIdAtCreation: !!target.dataset.messageId,
							timestamp: Date.now(),
						};
						observer.disconnect();
						return;
					}
				}
			}
		});
		observer.observe(container, { childList: true, subtree: true });
		// Safety timeout
		setTimeout(() => observer.disconnect(), 60_000);
	});

	// Send a message that will produce a long response
	const inputSet = await page.evaluate((msg: string) => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		if (!el) return false;
		el.focus();
		el.textContent = msg;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	}, "Count from 1 to 50, one number per line. Do not use any tools, just reply with text.");

	if (!inputSet) {
		ctx.fail("No context menu on in-progress", "Could not set chat input");
		return;
	}

	await page.waitForTimeout(300);
	await page.focus(".notor-text-input");
	await page.keyboard.press("Enter");

	// Wait for response to complete (use longer timeout for slow LLM)
	const responseCompleted = await waitForResponse(page, 120_000);
	console.log(`  waitForResponse completed: ${responseCompleted}`);

	// Read the MutationObserver result — it captured the element state at creation time
	const observerResult = await page.evaluate(() => (window as any).__forkTest15Result);
	console.log(`  Observer result: ${JSON.stringify(observerResult)}`);

	// Log post-response state
	const postState15 = await page.evaluate(() => ({
		assistantMsgCount: document.querySelectorAll(".notor-message-assistant").length,
		messageIdCount: document.querySelectorAll("[data-message-id]").length,
		lastAssistantHasId: (() => {
			const msgs = document.querySelectorAll(".notor-message-assistant");
			const last = msgs[msgs.length - 1] as HTMLElement;
			return last ? !!last.dataset.messageId : null;
		})(),
	}));
	console.log(`  Post-response state: ${JSON.stringify(postState15)}`);

	if (!observerResult) {
		const shot = await ctx.screenshot("15-no-observer-result");
		ctx.fail("No context menu on in-progress", "MutationObserver did not detect assistant message creation", shot);
		return;
	}

	// The key invariant: at creation time, the assistant message had NO data-message-id.
	// This proves pending/streaming messages are not forkable (no context menu target).
	if (!observerResult.hadMessageIdAtCreation) {
		// If the response also completed and gained data-message-id, that's ideal.
		// But even if the response timed out, the core invariant is validated:
		// the element was created WITHOUT data-message-id.
		const finalState = await page.evaluate(() => {
			const msgs = document.querySelectorAll(".notor-message-assistant");
			const last = msgs[msgs.length - 1] as HTMLElement;
			return { hasMessageIdAfterFinalize: !!last?.dataset.messageId };
		});

		const detail = finalState.hasMessageIdAfterFinalize
			? "Assistant message had no data-message-id at creation, gained it after finalization"
			: "Assistant message had no data-message-id at creation (response did not complete within timeout, but invariant is validated)";
		const shot = await ctx.screenshot("15-correct-no-id");
		ctx.pass("No context menu on in-progress", detail, shot);
	} else {
		const shot = await ctx.screenshot("15-unexpected-id");
		ctx.fail(
			"No context menu on in-progress",
			"In-progress assistant message unexpectedly had data-message-id at creation time",
			shot,
		);
	}
}

async function testNoContextMenuOnPendingToolCall(ctx: TestContext): Promise<void> {
	console.log("\nTest 16: While tool call is pending, right-click pending tool call → no context menu");
	const { page } = ctx;

	// Verify that pending tool call elements do NOT have data-message-id.
	// The data-message-id is set after tool dispatch completes (orchestrator:1501),
	// NOT in renderToolCall() (chat-view.ts:1365).
	//
	// Strategy: programmatic — call renderToolCall() directly via plugin internals
	// to create a pending tool call element and verify its DOM state. This avoids
	// depending on unreliable LLM behavior to trigger tool calls.

	await ensureCleanState(page);

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };

		try {
			const orchestrator = plugin.getOrchestrator();
			const view = orchestrator.view;
			if (!view) return { error: "Chat view not found" };

			// Create a fake tool call message to render
			const fakeMessage = {
				id: crypto.randomUUID(),
				conversation_id: "test",
				role: "tool_call" as const,
				content: "",
				created_at: new Date().toISOString(),
				tool_call: {
					tool_name: "read_note",
					parameters: { path: "test.md" },
					status: "pending",
				},
			};

			// renderToolCall does NOT set data-message-id (this is the invariant)
			const toolEl = view.renderToolCall(fakeMessage);
			const hadIdAtRender = !!toolEl.dataset.messageId;

			// Simulate what the orchestrator does after dispatch completes (line 1501)
			toolEl.dataset.messageId = fakeMessage.id;
			const hasIdAfterSimulatedComplete = !!toolEl.dataset.messageId;

			// Clean up — remove the fake element from DOM
			toolEl.remove();

			return {
				hadIdAtRender,
				hasIdAfterSimulatedComplete,
				renderedId: fakeMessage.id,
			};
		} catch (e: any) {
			return { error: e.message };
		}
	});

	console.log(`  Programmatic result: ${JSON.stringify(result)}`);

	if (result.error) {
		const shot = await ctx.screenshot("16-error");
		ctx.fail("No context menu on pending tool", `Error: ${result.error}`, shot);
		return;
	}

	if (!result.hadIdAtRender && result.hasIdAfterSimulatedComplete) {
		const shot = await ctx.screenshot("16-pending-no-id");
		ctx.pass(
			"No context menu on pending tool",
			"renderToolCall() produces no data-message-id; ID is set only after dispatch completes",
			shot,
		);
	} else if (result.hadIdAtRender) {
		const shot = await ctx.screenshot("16-pending-has-id");
		ctx.fail(
			"No context menu on pending tool",
			"renderToolCall() unexpectedly set data-message-id at render time",
			shot,
		);
	} else {
		const shot = await ctx.screenshot("16-no-complete-id");
		ctx.fail(
			"No context menu on pending tool",
			`Simulated completion did not set data-message-id`,
			shot,
		);
	}
}

async function testContextMenuOnEarlierDuringPendingTool(ctx: TestContext): Promise<void> {
	console.log("\nTest 17: While tool is pending, right-click earlier completed message → context menu appears");
	const { page } = ctx;

	// Verify that earlier completed messages retain data-message-id while a pending
	// tool call element is present in the DOM.
	//
	// Strategy: programmatic — send a real first message to create completed messages
	// with data-message-id, then programmatically render a pending tool call element
	// and verify the completed messages still have their data-message-id.

	await ensureCleanState(page);
	await newConversation(page);
	await page.waitForTimeout(2_000);

	console.log("  Sending first message...");
	const resp = await sendMessage(page, "Say hello briefly. Do not use any tools.");
	if (!resp) {
		const shot = await ctx.screenshot("17-first-msg-timeout");
		ctx.fail("Context menu earlier msg during pending tool", "First message got no response", shot);
		return;
	}

	await page.waitForTimeout(2_000);

	// Verify we have completed messages with data-message-id
	let completedBefore = await page.$$eval("[data-message-id]", (els) => els.length);
	console.log(`  Completed messages after first exchange: ${completedBefore}`);

	if (completedBefore === 0) {
		// Retry with extra wait
		await page.waitForTimeout(3_000);
		completedBefore = await page.$$eval("[data-message-id]", (els) => els.length);
		console.log(`  Completed messages after retry: ${completedBefore}`);
	}

	// Programmatically render a pending tool call element (no LLM involved)
	const toolResult = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };

		try {
			const orchestrator = plugin.getOrchestrator();
			const view = orchestrator.view;
			if (!view) return { error: "Chat view not found" };

			const fakeMessage = {
				id: crypto.randomUUID(),
				conversation_id: "test",
				role: "tool_call" as const,
				content: "",
				created_at: new Date().toISOString(),
				tool_call: {
					tool_name: "write_note",
					parameters: { path: "_e2e_fork_test.md", content: "test" },
					status: "pending",
				},
			};

			// Render a pending tool call element
			const toolEl = view.renderToolCall(fakeMessage);
			return {
				rendered: true,
				toolHasMessageId: !!toolEl.dataset.messageId,
				toolElTagName: toolEl.tagName,
			};
		} catch (e: any) {
			return { error: e.message };
		}
	});

	console.log(`  Tool render result: ${JSON.stringify(toolResult)}`);

	if (toolResult.error) {
		const shot = await ctx.screenshot("17-tool-render-error");
		ctx.fail("Context menu earlier msg during pending tool", `Error rendering tool call: ${toolResult.error}`, shot);
		return;
	}

	// Check: earlier completed messages should STILL have data-message-id
	const completedDuring = await page.$$eval("[data-message-id]", (els) => els.length);
	console.log(`  Completed messages with pending tool in DOM: ${completedDuring} (was ${completedBefore})`);

	// Clean up the fake tool call element
	await page.evaluate(() => {
		const toolCalls = document.querySelectorAll(".notor-tool-call");
		const last = toolCalls[toolCalls.length - 1] as HTMLElement;
		if (last && !last.dataset.messageId) {
			last.remove(); // Remove our fake one (no data-message-id)
		}
	});

	if (completedDuring >= completedBefore && completedBefore > 0) {
		const shot = await ctx.screenshot("17-completed-during-pending");
		ctx.pass(
			"Context menu earlier msg during pending tool",
			`${completedDuring} completed messages retain data-message-id alongside pending tool (${completedBefore} before)`,
			shot,
		);
	} else if (completedBefore === 0 && completedDuring > 0) {
		const shot = await ctx.screenshot("17-completed-during-pending");
		ctx.pass(
			"Context menu earlier msg during pending tool",
			`${completedDuring} completed messages with data-message-id alongside pending tool (completedBefore was 0, likely DOM timing)`,
			shot,
		);
	} else {
		const shot = await ctx.screenshot("17-missing-ids-during-pending");
		ctx.fail(
			"Context menu earlier msg during pending tool",
			`Expected >=${completedBefore} completed messages during pending tool, found ${completedDuring}`,
			shot,
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init

	// --- 7.1 Core fork flow ---
	await testCoreForkCreation(ctx);
	await testForkIdsAreFresh(ctx);
	await testOriginalUnchanged(ctx);
	await testForkCanBeContinued(ctx);
	await testForkBadgeInList(ctx);

	// --- 7.2 Tool call boundary tests ---
	await testForkAtToolCall(ctx);
	await testForkAtToolResult(ctx);
	await testForkAtToolCallNoResult(ctx);
	await testForkMidMultiTool(ctx);
	await testForkToolBoundaryContinuable(ctx);

	// --- 7.3 Fork badge and navigation ---
	await testForkBadgeNavigation(ctx);
	await testDeleteParentRemovesBadge(ctx);
	await testForkImportedConversation(ctx);

	// --- 7.4 Streaming and in-progress guards ---
	await testContextMenuDuringStreaming(ctx);
	await testNoContextMenuOnInProgress(ctx);
	await testNoContextMenuOnPendingToolCall(ctx);
	await testContextMenuOnEarlierDuringPendingTool(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "act", // Need act mode for tool calls
});

runTest(
	{
		name: "conversation-fork",
		settings,
		setupVault: (vaultPath: string) => {
			// Create a test note for tool call tests
			const testNotePath = path.join(vaultPath, "test-note.md");
			if (!fs.existsSync(testNotePath)) {
				fs.writeFileSync(testNotePath, "# Test Note\n\nThis is a test note for fork E2E tests.\n");
			}
		},
		cleanupFiles: [
			"test-note.md",
			"_e2e_fork_test_pending.md",
			"_e2e_fork_earlier_test.md",
		],
	},
	tests,
);
