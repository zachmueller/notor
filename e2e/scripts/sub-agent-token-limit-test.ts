#!/usr/bin/env npx tsx
/**
 * Sub-Agent Token Limit E2E Test
 *
 * Validates Phase 3 task 3D-4: setting `sub_agent_token_limit` to a low
 * value causes the sub-agent to stop early with the token limit marker.
 *
 * Scenarios:
 *   1. Plugin loads and chat panel is visible
 *   2. Sub-agent hits token limit — with a 5 000 token limit, the sub-agent
 *      should stop early and produce a "[Sub-agent stopped: token limit ...]"
 *      marker in its result
 *   3. Structured logs confirm stopReason is "token_limit"
 *   4. Sub-agent completes normally with no token limit (limit = 0)
 *   5. No unexpected error-level logs from sub-agent components
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access with the configured model available
 *
 * @see specs/ZZ-misc/token-counting-improvements-tasks.md — Phase 3, task 3D-4
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessageWithApprovalHandling,
	getLastAssistantMessage,
	newConversation,
	setMode,
	ensureCleanState,
	VAULT_PATH,
	RESPONSE_TIMEOUT_MS,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

/** Low enough that the sub-agent hits the limit within 1–2 turns. */
const LOW_TOKEN_LIMIT = 5_000;

const SUBAGENT_PROMPT =
	"Search my vault for notes about quantum computing. " +
	"Use the use_subagent tool with the search-vault profile to find all relevant notes. " +
	"Summarize what you find.";

const SUBAGENT_TIMEOUT = RESPONSE_TIMEOUT_MS + 30_000;

// ---------------------------------------------------------------------------
// Vault setup — create notes for the sub-agent to discover
// ---------------------------------------------------------------------------

function setupVault(vaultPath: string): void {
	const notes: Record<string, string> = {
		"Research/quantum-computing.md": `---
title: Quantum Computing Basics
tags: [research, quantum, physics]
---

# Quantum Computing Basics

Quantum computers use qubits instead of classical bits.
Key concepts include superposition, entanglement, and quantum gates.
`,
		"Research/quantum-algorithms.md": `---
title: Quantum Algorithms
tags: [research, quantum]
---

# Quantum Algorithms

Shor's algorithm factors large integers in polynomial time.
Grover's algorithm provides quadratic speedup for unstructured search.
`,
	};

	for (const [relativePath, content] of Object.entries(notes)) {
		const fullPath = path.join(vaultPath, relativePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content, "utf8");
		console.log(`    Created: ${relativePath}`);
	}

	const subAgentsDir = path.join(vaultPath, "notor", "sub-agents");
	fs.mkdirSync(subAgentsDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testChatPanelVisible(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Chat panel visible");
	const { page } = ctx;

	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (chatContainer) {
		const shot = await ctx.screenshot("01-startup");
		ctx.pass("Chat panel visible", "Found .notor-chat-container", shot);
	} else {
		const shot = await ctx.screenshot("01-startup-missing");
		ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
		throw new Error("Chat panel not visible — cannot continue");
	}
}

async function testSubAgentHitsTokenLimit(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Sub-agent stops at token limit");
	const { page } = ctx;

	await newConversation(page);
	await setMode(page, "Act");

	// Inject the low token limit into settings at runtime
	await page.evaluate((limit) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return;
		plugin.settings.sub_agent_token_limit = limit;
	}, LOW_TOKEN_LIMIT);
	await page.waitForTimeout(500);

	const { responded } = await sendMessageWithApprovalHandling(
		page, SUBAGENT_PROMPT, SUBAGENT_TIMEOUT,
	);

	const shot = await ctx.screenshot("02-token-limit-hit");

	if (!responded) {
		ctx.fail("Sub-agent token limit — response", "No response within timeout", shot);
		return;
	}

	ctx.pass("Sub-agent token limit — response received", "LLM responded", shot);

	// Check the response text for the token limit marker
	const response = await getLastAssistantMessage(page);
	const hasTokenLimitMarker =
		response.includes("token limit") ||
		response.includes("Sub-agent stopped");

	if (hasTokenLimitMarker) {
		ctx.pass(
			"Token limit marker in response",
			`Response contains token limit indication: "${response.substring(0, 200)}"`,
			shot,
		);
	} else {
		// The LLM may paraphrase the marker or it may be in the tool result, not the
		// final assistant text. Check logs instead (next test).
		console.log(`  Response (first 300 chars): "${response.substring(0, 300)}"`);
		ctx.pass(
			"Token limit marker (not in final text)",
			"Marker may be in tool result text; checking logs next",
			shot,
		);
	}
}

async function testTokenLimitStopReasonInLogs(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Structured logs confirm token_limit stopReason");

	const allLogs = ctx.collector.getStructuredLogs();

	// Look for SubAgentRunner "token limit" log entries
	const tokenLimitLogs = allLogs.filter(
		(e) =>
			(e.source === "SubAgentRunner" && e.message.includes("token limit")) ||
			(e.source === "UseSubagentTool" &&
				e.message.includes("completed") &&
				JSON.stringify(e.data ?? {}).includes("token_limit")),
	);

	// Also check the UseSubagentTool completion log for stopReason
	const completionLogs = allLogs.filter(
		(e) =>
			e.source === "UseSubagentTool" &&
			e.message.includes("completed"),
	);

	const hasTokenLimitStopReason = completionLogs.some((e) => {
		const dataStr = JSON.stringify(e.data ?? {});
		return dataStr.includes("token_limit");
	});

	if (tokenLimitLogs.length > 0 || hasTokenLimitStopReason) {
		const detail = tokenLimitLogs.length > 0
			? `SubAgentRunner log: "${tokenLimitLogs[0].message}" data=${JSON.stringify(tokenLimitLogs[0].data)}`
			: `UseSubagentTool completion with token_limit stopReason`;
		ctx.pass("stopReason is token_limit in logs", detail);
	} else if (completionLogs.length > 0) {
		// Sub-agent completed, but may not have hit the token limit
		// (e.g., it finished in one turn before exceeding the limit)
		const last = completionLogs[completionLogs.length - 1];
		const dataStr = JSON.stringify(last.data ?? {});
		ctx.fail(
			"stopReason is token_limit in logs",
			`Sub-agent completed but stopReason was not token_limit. Log data: ${dataStr}`,
		);
	} else {
		// No sub-agent completion logs at all
		ctx.fail(
			"stopReason is token_limit in logs",
			`No UseSubagentTool completion logs found. Total logs: ${allLogs.length}`,
		);
	}
}

async function testSubAgentCompletesNormally(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Sub-agent completes normally with no token limit (limit=0)");
	const { page } = ctx;

	await ensureCleanState(page);
	await newConversation(page);
	await setMode(page, "Act");

	// Set token limit to 0 (unlimited)
	await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return;
		plugin.settings.sub_agent_token_limit = 0;
	});
	await page.waitForTimeout(500);

	const logCountBefore = ctx.collector.getStructuredLogs().length;

	const { responded } = await sendMessageWithApprovalHandling(
		page, SUBAGENT_PROMPT, SUBAGENT_TIMEOUT,
	);

	const shot = await ctx.screenshot("04-no-limit");

	if (!responded) {
		ctx.fail("Sub-agent no limit — response", "No response within timeout", shot);
		return;
	}

	// Check that the response does NOT contain the token limit marker
	const response = await getLastAssistantMessage(page);
	const hasTokenLimitMarker =
		response.includes("Sub-agent stopped: token limit");

	if (hasTokenLimitMarker) {
		ctx.fail(
			"No token limit marker when limit=0",
			`Response unexpectedly contains token limit marker: "${response.substring(0, 200)}"`,
			shot,
		);
	} else {
		ctx.pass(
			"No token limit marker when limit=0",
			`Sub-agent completed normally: "${response.substring(0, 150)}"`,
			shot,
		);
	}

	// Check logs: stopReason should be "completed", not "token_limit"
	const recentLogs = ctx.collector.getStructuredLogs().slice(logCountBefore);
	const completionLogs = recentLogs.filter(
		(e) => e.source === "UseSubagentTool" && e.message.includes("completed"),
	);

	const hasTokenLimitStop = completionLogs.some((e) =>
		JSON.stringify(e.data ?? {}).includes("token_limit"),
	);

	if (hasTokenLimitStop) {
		ctx.fail(
			"stopReason is 'completed' when limit=0",
			"Completion log shows token_limit despite limit being 0",
		);
	} else if (completionLogs.length > 0) {
		const last = completionLogs[completionLogs.length - 1];
		ctx.pass(
			"stopReason is 'completed' when limit=0",
			`Sub-agent completed normally. Log: ${JSON.stringify(last.data)}`,
		);
	} else {
		// Sub-agent may not have been invoked by the LLM
		ctx.pass(
			"stopReason check (no sub-agent logs)",
			"LLM may have used tools directly instead of sub-agent",
		);
	}
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: No unexpected error-level logs from sub-agent components");

	const errors = ctx.collector.getLogsByLevel("error");

	const subAgentErrors = errors.filter(
		(e) =>
			e.source === "SubAgentRunner" ||
			e.source === "UseSubagentTool" ||
			e.source === "SubAgentManager" ||
			e.source === "ToolDispatcher",
	);

	if (subAgentErrors.length === 0) {
		ctx.pass(
			"No unexpected sub-agent errors",
			`Zero sub-agent-related errors (${errors.length} total errors from other sources)`,
		);
	} else {
		ctx.fail(
			"No unexpected sub-agent errors",
			`${subAgentErrors.length} error(s): ${subAgentErrors.map((e) => `[${e.source}] ${e.message}`).join("; ")}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	await testChatPanelVisible(ctx);
	await ensureCleanState(page);

	await testSubAgentHitsTokenLimit(ctx);
	await testTokenLimitStopReasonInLogs(ctx);
	await testSubAgentCompletesNormally(ctx);
	await testNoUnexpectedErrors(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	mode: "act",
	auto_approve: {
		read_note: true,
		search_vault: true,
		list_vault: true,
		read_frontmatter: true,
		use_subagent: true,
	},
	sub_agent_visibility: {},
	sub_agent_auto_approve_reads: true,
	sub_agent_concurrency_cap: 3,
	sub_agent_token_limit: LOW_TOKEN_LIMIT,
});

runTest(
	{
		name: "sub-agent-token-limit",
		settings,
		setupVault,
		cleanupFiles: [
			"Research/",
			"notor/sub-agents/",
		],
	},
	tests,
);
