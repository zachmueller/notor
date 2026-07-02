#!/usr/bin/env npx tsx
/**
 * Legacy Tool-Policy Tripwire E2E Test (F2 Phase D gate)
 *
 * The final readiness gate before deleting the dispatcher's legacy inline
 * tool-policy branch. Phases A–C of the tool-policy reconciliation (spec F2)
 * routed all five dispatch contexts through the pure `evaluateToolPolicy` path
 * and armed a tripwire: the legacy `else` branch's first line logs
 * `log.error("LEGACY POLICY PATH HIT …", { toolName, mode })` (source
 * "ToolDispatcher"). Any hit means a caller reached `dispatch()` without a
 * `policyCtx` — i.e. the legacy branch is still reachable and must not be
 * deleted.
 *
 * The orchestration-run-flow test (TEST-008) covers the orchestration
 * conversation-step, code-step, and child-spawn contexts. This script covers
 * the two remaining LIVE dispatch contexts:
 *   1. Foreground chat — a plain read tool call (list_vault / read_note).
 *   2. Sub-agent — a use_subagent run (its own ToolDispatcher instance).
 *
 * Each context must actually DISPATCH a tool for the check to be meaningful, so
 * both scenarios drive a message that provokes an auto-approved tool call, then
 * assert zero `LEGACY POLICY PATH HIT` errors in the collected structured logs.
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a usable profile
 *   - Bedrock access with the configured model available (real LLM turns)
 *
 * Run with:
 *   npx tsx e2e/scripts/legacy-policy-tripwire-test.ts
 *
 * @see specs/ZZ-misc/arch-review-july-2026/tasks/04-tool-policy-reconciliation.md — Phase D
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	waitForSelector,
	buildDefaultSettings,
	sendMessage,
	getLastToolCallNames,
	newConversation,
	setMode,
	ensureCleanState,
	writeCleanWorkspace,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Vault setup — a couple of notes so read/search tools have something to hit
// ---------------------------------------------------------------------------

function setupVault(vaultPath: string): void {
	writeCleanWorkspace(vaultPath);
	const notes: Record<string, string> = {
		"Notes/alpha.md": `---
title: Alpha
tags: [demo]
---

# Alpha

The alpha note mentions pineapples and orchestration.
`,
		"Notes/beta.md": `---
title: Beta
tags: [demo]
---

# Beta

The beta note mentions pineapples too.
`,
	};
	for (const [rel, content] of Object.entries(notes)) {
		const full = path.join(vaultPath, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf8");
	}
	// Built-in sub-agent profiles are discovered from code constants, but the
	// directory must exist for the sub-agent subsystem to initialize cleanly.
	fs.mkdirSync(path.join(vaultPath, "notor", "sub-agents"), { recursive: true });
}

// ---------------------------------------------------------------------------
// Shared assertion
// ---------------------------------------------------------------------------

/** Assert no legacy-branch tripwire has fired at any point in the run so far. */
function assertNoTripwire(ctx: TestContext, contextLabel: string): void {
	const hits = ctx.collector
		.getLogsByLevel("error")
		.filter((e) => e.message.includes("LEGACY POLICY PATH HIT"));
	if (hits.length === 0) {
		ctx.pass(
			`no legacy policy path hit (${contextLabel})`,
			`zero LEGACY POLICY PATH HIT errors after the ${contextLabel} dispatch`,
		);
	} else {
		ctx.fail(
			`no legacy policy path hit (${contextLabel})`,
			`${hits.length} tripwire hit(s): ${hits.map((h) => JSON.stringify(h.data)).join("; ")}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testForegroundChatToolCall(ctx: TestContext): Promise<void> {
	console.log("\n── Test 1: Foreground chat tool call → pure policy path ─────");
	const { page } = ctx;
	await newConversation(page);
	await setMode(page, "Act");

	// All tools here are auto-approved, so the plain keyboard-Enter sender is
	// sufficient (and avoids the send-button click-visibility flakiness).
	const responded = await sendMessage(
		page,
		"List the notes in my vault, then read Notes/alpha.md and tell me what it mentions. " +
		"Use the list_vault and read_note tools.",
	);
	const shot = await ctx.screenshot("01-foreground-tool-call");

	if (!responded) {
		ctx.fail("foreground tool call — response", "No response within timeout", shot);
		return;
	}
	const toolNames = await getLastToolCallNames(page);
	if (toolNames.length === 0) {
		// No tool dispatched ⇒ the gate observation for this context is vacuous.
		ctx.fail(
			"foreground tool call dispatched",
			"LLM responded without dispatching any tool — the foreground dispatch context was not exercised",
			shot,
		);
		return;
	}
	ctx.pass("foreground tool call dispatched", `tools: [${toolNames.join(", ")}]`, shot);
	assertNoTripwire(ctx, "foreground chat");
}

async function testSubAgentToolCall(ctx: TestContext): Promise<void> {
	console.log("\n── Test 2: Sub-agent run → pure policy path ─────────────────");
	const { page } = ctx;
	await ensureCleanState(page);
	// A fresh conversation is preferred but not required — the tripwire assertion
	// sweeps ALL collected logs, so exercising the sub-agent dispatch context in
	// the existing conversation is equally valid. Tolerate a flaky new-convo click
	// (button can be transiently non-interactable right after a prior response)
	// rather than aborting the whole run before the sub-agent context is exercised.
	try {
		await newConversation(page);
	} catch (e) {
		console.log(`    (newConversation skipped: ${String(e).split("\n")[0]}) — reusing current conversation`);
	}
	await setMode(page, "Act");

	const responded = await sendMessage(
		page,
		"You MUST use the use_subagent tool with profile='search-vault' to search my vault " +
		"for notes about pineapples. Do not use list_vault or search_vault directly — " +
		"delegate the search to the sub-agent, then summarize what it returns.",
	);
	const shot = await ctx.screenshot("02-subagent-tool-call");

	if (!responded) {
		ctx.fail("sub-agent tool call — response", "No response within timeout", shot);
		return;
	}
	// Confirm the sub-agent subsystem actually ran (its dispatcher is the context
	// under test); accept either a use_subagent card or SubAgentRunner logs.
	const toolNames = await getLastToolCallNames(page);
	const subAgentRan = ctx.collector
		.getStructuredLogs()
		.some((e) => e.source === "SubAgentRunner" || e.source === "UseSubagentTool");
	if (!subAgentRan && !toolNames.some((n) => n.toLowerCase().includes("subagent"))) {
		ctx.fail(
			"sub-agent dispatched",
			`no SubAgentRunner/UseSubagentTool activity — sub-agent dispatch context not exercised (tools: [${toolNames.join(", ")}])`,
			shot,
		);
		return;
	}
	ctx.pass("sub-agent dispatched", "use_subagent ran on its own dispatcher instance", shot);
	assertNoTripwire(ctx, "sub-agent");
}

function testFinalTripwireSweep(ctx: TestContext): void {
	console.log("\n── Test 3: Final tripwire sweep across the whole run ────────");
	assertNoTripwire(ctx, "full run");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);
	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chat) {
		const shot = await ctx.screenshot("00-no-chat-panel");
		ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
		throw new Error("Chat panel not visible — cannot run tripwire tests");
	}
	ctx.pass("Chat panel ready", "Plugin loaded and chat container found");

	// Each scenario is isolated so a UI-flakiness throw in one doesn't abort the
	// final sweep — the load-bearing assertion is the whole-run tripwire check,
	// which reads every log collected across whatever dispatches did happen.
	for (const scenario of [testForegroundChatToolCall, testSubAgentToolCall]) {
		try {
			await scenario(ctx);
		} catch (e) {
			ctx.fail(scenario.name, `threw before asserting: ${String(e).split("\n")[0]}`);
		}
	}
	testFinalTripwireSweep(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

runTest(
	{
		name: "legacy-policy-tripwire",
		settings: buildDefaultSettings({
			mode: "act",
			auto_approve: {
				list_vault: true,
				read_note: true,
				search_vault: true,
				read_frontmatter: true,
				use_subagent: true,
			},
			sub_agent_visibility: {},
			sub_agent_auto_approve_reads: true,
			sub_agent_concurrency_cap: 3,
		}),
		setupVault,
		cleanupFiles: ["Notes/", "notor/sub-agents/"],
	},
	tests,
);
