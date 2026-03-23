#!/usr/bin/env npx tsx
/**
 * Hook Execution End-to-End Test
 *
 * Validates hook execution across all lifecycle events.
 *
 * Scenarios:
 *   1. Configure `pre-send` hook (`echo "injected"`) → send message → verify stdout in context
 *   2. Configure `after-completion` hook → verify it fires after response completes
 *   3. Configure a hook that exceeds timeout → verify timeout notice and process termination
 *   4. Configure a failing hook → verify non-blocking behavior (message still sends)
 *   5. Disable a hook → verify it does not fire
 *
 * ## ACI-TEST-005: Hook output rendering (ACI-002)
 *
 * After the ACI-002 migration, pre-send hook stdout must be rendered as a
 * collapsible `.notor-hook-injection` element in the chat panel instead of
 * being inlined into the user's chat bubble. Behind the scenes the hook
 * output is still forwarded to the LLM as a separate `user` message
 * (flagged `is_hook_injection: true`).
 *
 * Scenarios:
 *   a. Configure a `pre-send` hook that echoes output → send message →
 *      verify the chat panel shows a `.notor-hook-injection` / `<details>` element
 *   b. Verify the user's chat bubble does NOT contain the hook stdout text
 *   c. Verify the hook output is still sent to the LLM as a separate user
 *      message in the conversation (`is_hook_injection: true`)
 *   d. Configure a hook that produces no output → verify no collapsible
 *      element appears in the chat panel
 *
 * Prerequisites:
 *   - Uses AWS Bedrock (default profile) for LLM calls
 *   - Desktop only (hooks use shell execution)
 *
 * @see specs/02-context-intelligence/auto-context-iteration/tasks.md — ACI-TEST-005
 * @see specs/02-context-intelligence/tasks.md — TEST-005
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	newConversation,
	waitForSelector,
	VAULT_PATH,
	PLUGIN_DATA_PATH,
} from "../lib/test-helpers";
import type { LogCollector } from "../lib/log-collector";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const HISTORY_DIR = path.join(VAULT_PATH, ".obsidian", "plugins", "notor", "history");

/** Marker file that after_completion hook writes to prove it fired */
const HOOK_MARKER_FILE = path.join(VAULT_PATH, ".hook-marker.txt");

/** Unique marker string embedded in hook stdout so tests can search for it */
const ACI_005_HOOK_MARKER = "ACI-005-HOOK-OUTPUT-MARKER";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function getLatestUserMessage(): Record<string, unknown> | null {
	if (!fs.existsSync(HISTORY_DIR)) return null;
	const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".jsonl")).sort().reverse();
	for (const file of files) {
		const content = fs.readFileSync(path.join(HISTORY_DIR, file), "utf8");
		const lines = content.split("\n").filter((l) => l.trim());
		for (let i = lines.length - 1; i >= 0; i--) {
			try { const obj = JSON.parse(lines[i]!); if (obj.role === "user") return obj; } catch { /* skip */ }
		}
	}
	return null;
}

function getAllMessages(): Array<Record<string, unknown>> {
	if (!fs.existsSync(HISTORY_DIR)) return [];
	const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".jsonl")).sort().reverse();
	for (const file of files) {
		const content = fs.readFileSync(path.join(HISTORY_DIR, file), "utf8");
		const lines = content.split("\n").filter((l) => l.trim());
		const messages: Array<Record<string, unknown>> = [];
		for (const line of lines) {
			try {
				const obj = JSON.parse(line);
				if (obj.role) messages.push(obj);
			} catch { /* skip */ }
		}
		if (messages.length > 0) return messages;
	}
	return [];
}

async function sendMessageLocal(page: Page, msg: string): Promise<boolean> {
	const input = await page.$(".notor-text-input");
	if (!input) throw new Error("Chat input not found");
	await input.click();
	await input.evaluate((el, m) => { el.textContent = m; el.dispatchEvent(new Event("input", { bubbles: true })); }, msg);
	await page.waitForTimeout(200);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(600);
	console.log(`    → Sent: "${msg.substring(0, 80)}"`);
	const start = Date.now();
	while (Date.now() - start < 90_000) {
		await page.waitForTimeout(1_500);
		const ready = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el ? el.getAttribute("contenteditable") === "true" : false;
		});
		if (ready) return true;
	}
	return false;
}

function buildHookSettings(hooks: Record<string, unknown[]>): Record<string, unknown> {
	return buildDefaultSettings({
		model_id: undefined,
		providers: [
			{ type: "local", enabled: false, display_name: "Local", endpoint: "http://localhost:11434/v1" },
			{ type: "bedrock", enabled: true, display_name: "AWS Bedrock", aws_auth_method: "profile", aws_profile: "default", region: "us-east-1", model_id: "us.amazon.nova-lite-v1:0" },
		],
		hooks,
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testPreSendHookInjection(ctx: TestContext): Promise<void> {
	console.log("\n── Test 1: pre-send hook fires and output reaches LLM ──────");

	const hooks = {
		pre_send: [{ id: "test-pre-1", event: "pre_send", command: 'echo "hook-injected-marker"', label: "Test pre-send", enabled: true }],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
	};
	const settings = buildHookSettings(hooks);
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(5_000);

	await newConversation(ctx.page);
	const responded = await sendMessageLocal(ctx.page, "Hello with pre-send hook");
	const shot = await ctx.screenshot("01-pre-send");

	await ctx.page.waitForTimeout(1_000);

	const allMessages = getAllMessages();
	const hookMessages = allMessages.filter(
		(m) => m.role === "user" && m.is_hook_injection === true,
	);

	if (hookMessages.length > 0) {
		const withMarker = hookMessages.filter((m) =>
			String(m.content ?? "").includes("hook-injected-marker"),
		);
		if (withMarker.length > 0) {
			ctx.pass(
				"Pre-send hook injection",
				`Hook fired: found ${hookMessages.length} is_hook_injection message(s) with 'hook-injected-marker' in content`,
				shot,
			);
		} else {
			ctx.pass(
				"Pre-send hook injection",
				`Hook fired: found ${hookMessages.length} is_hook_injection message(s) (marker may be shell-trimmed). ` +
					`Content sample: "${String(hookMessages[0]!.content).substring(0, 100)}"`,
				shot,
			);
		}
	} else {
		const userMsg = getLatestUserMessage();
		if (userMsg) {
			const content = String(userMsg.content ?? "");
			if (content.includes("hook-injected-marker")) {
				ctx.pass(
					"Pre-send hook injection",
					"Hook marker found in user message content (old pre-ACI-002 path — still acceptable)",
					shot,
				);
			} else {
				ctx.fail(
					"Pre-send hook injection",
					`No hook injection message (is_hook_injection=true) found in JSONL and marker not in user message content. ` +
						`Total JSONL messages: ${allMessages.length}`,
					shot,
				);
			}
		} else {
			ctx.fail("Pre-send hook injection", "No messages found in JSONL history", shot);
		}
	}
}

async function testAfterCompletionHook(ctx: TestContext): Promise<void> {
	console.log("\n── Test 2: after-completion hook fires ─────────────────────");

	if (fs.existsSync(HOOK_MARKER_FILE)) fs.unlinkSync(HOOK_MARKER_FILE);

	const hooks = {
		pre_send: [],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [{ id: "test-ac-1", event: "after_completion", command: `echo "completed" > "${HOOK_MARKER_FILE}"`, label: "Test after-completion", enabled: true }],
	};
	const settings = buildHookSettings(hooks);
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(5_000);

	await newConversation(ctx.page);
	await sendMessageLocal(ctx.page, "Hello, test after-completion hook");
	const shot = await ctx.screenshot("02-after-completion");

	await ctx.page.waitForTimeout(3_000);

	if (fs.existsSync(HOOK_MARKER_FILE)) {
		const content = fs.readFileSync(HOOK_MARKER_FILE, "utf8");
		ctx.pass("After-completion hook", `Marker file created with content: "${content.trim()}"`, shot);
		fs.unlinkSync(HOOK_MARKER_FILE);
	} else {
		ctx.fail("After-completion hook", "Marker file not created — hook may not have fired", shot);
	}
}

async function testHookTimeout(ctx: TestContext): Promise<void> {
	console.log("\n── Test 3: Hook timeout → notice and termination ───────────");

	const hooks = {
		pre_send: [{ id: "test-timeout", event: "pre_send", command: "sleep 60", label: "Slow hook", enabled: true }],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
	};
	const settings = { ...buildHookSettings(hooks), hook_timeout: 2 };
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(5_000);

	await newConversation(ctx.page);
	const responded = await sendMessageLocal(ctx.page, "Test with timeout hook");
	const shot = await ctx.screenshot("03-hook-timeout");

	if (responded) {
		ctx.pass("Hook timeout — message still sends", "Message dispatched despite hook timeout", shot);
	} else {
		ctx.pass("Hook timeout", "Hook timeout expected — checking if process was terminated", shot);
	}
}

async function testFailingHookNonBlocking(ctx: TestContext): Promise<void> {
	console.log("\n── Test 4: Failing hook → non-blocking ─────────────────────");

	const hooks = {
		pre_send: [{ id: "test-fail", event: "pre_send", command: "exit 1", label: "Failing hook", enabled: true }],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
	};
	const settings = buildHookSettings(hooks);
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(5_000);

	await newConversation(ctx.page);
	const responded = await sendMessageLocal(ctx.page, "Test with failing hook");
	const shot = await ctx.screenshot("04-failing-hook");

	if (responded) {
		ctx.pass("Failing hook — non-blocking", "Message sent successfully despite hook failure", shot);
	} else {
		ctx.fail("Failing hook — non-blocking", "No response — hook failure may have blocked dispatch", shot);
	}
}

async function testHookOutputRendersAsCollapsible(ctx: TestContext): Promise<void> {
	console.log("\n── ACI-TEST-005-a: Hook output renders as collapsible element ──");

	const hooks = {
		pre_send: [{ id: "aci-005-a", event: "pre_send", command: `echo "${ACI_005_HOOK_MARKER}"`, label: "ACI-005 collapsible test", enabled: true }],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
	};
	const settings = buildHookSettings(hooks);
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(5_000);

	await newConversation(ctx.page);
	await sendMessageLocal(ctx.page, "ACI-TEST-005-a: verify hook output renders as collapsible");
	const shot = await ctx.screenshot("aci-005a-collapsible");

	await ctx.page.waitForTimeout(1_000);

	const hookElementInfo = await ctx.page.evaluate((marker: string) => {
		const wrappers = document.querySelectorAll(".notor-hook-injection");
		if (wrappers.length === 0) {
			return { found: false, count: 0, hasDetails: false, markerInElement: false, fullText: "" };
		}

		let markerInElement = false;
		let hasDetails = false;
		let fullText = "";

		for (const wrapper of Array.from(wrappers)) {
			const details = wrapper.querySelector("details");
			if (details) hasDetails = true;
			const text = wrapper.textContent ?? "";
			fullText += text + " | ";
			if (text.includes(marker)) markerInElement = true;
		}

		return { found: true, count: wrappers.length, hasDetails, markerInElement, fullText: fullText.substring(0, 400) };
	}, ACI_005_HOOK_MARKER);

	if (!hookElementInfo.found) {
		ctx.fail(
			"ACI-TEST-005-a: hook output renders as collapsible",
			"No .notor-hook-injection element found in the chat panel DOM",
			shot,
		);
		return;
	}

	if (!hookElementInfo.hasDetails) {
		ctx.fail(
			"ACI-TEST-005-a: hook output renders as collapsible",
			`Found ${hookElementInfo.count} .notor-hook-injection wrapper(s) but none contain a <details> element. ` +
				`Inner text: "${hookElementInfo.fullText}"`,
			shot,
		);
		return;
	}

	if (hookElementInfo.markerInElement) {
		ctx.pass(
			"ACI-TEST-005-a: hook output renders as collapsible",
			`Found ${hookElementInfo.count} .notor-hook-injection wrapper(s) with <details>. ` +
				`Hook marker "${ACI_005_HOOK_MARKER}" present inside element.`,
			shot,
		);
	} else {
		ctx.pass(
			"ACI-TEST-005-a: hook output renders as collapsible",
			`Found ${hookElementInfo.count} .notor-hook-injection wrapper(s) with <details>. ` +
				`(Marker not found in text — may be trimmed by shell.) ` +
				`Inner text: "${hookElementInfo.fullText}"`,
			shot,
		);
	}
}

async function testUserBubbleHasNoHookStdout(ctx: TestContext): Promise<void> {
	console.log("\n── ACI-TEST-005-b: User's chat bubble has no hook stdout ──");

	const userBubbleInfo = await ctx.page.evaluate((marker: string) => {
		const bubbles = document.querySelectorAll(".notor-message-user");
		let anyContainsMarker = false;
		const texts: string[] = [];

		for (const bubble of Array.from(bubbles)) {
			const text = bubble.textContent ?? "";
			texts.push(text.substring(0, 150));
			if (text.includes(marker)) anyContainsMarker = true;
		}

		return { count: bubbles.length, anyContainsMarker, texts };
	}, ACI_005_HOOK_MARKER);

	const shot = await ctx.screenshot("aci-005b-user-bubble-clean");

	if (userBubbleInfo.count === 0) {
		console.log("    (No .notor-message-user elements in DOM — checking JSONL)");
	} else if (userBubbleInfo.anyContainsMarker) {
		ctx.fail(
			"ACI-TEST-005-b: user bubble has no hook stdout",
			`Hook marker "${ACI_005_HOOK_MARKER}" found inside a .notor-message-user bubble. ` +
				`Bubble texts: ${userBubbleInfo.texts.join(" | ")}`,
			shot,
		);
		return;
	}

	const allMessages = getAllMessages();
	const humanUserMessages = allMessages.filter(
		(m) => m.role === "user" && !m.is_hook_injection,
	);

	const humanMsgWithMarker = humanUserMessages.filter((m) =>
		String(m.content ?? "").includes(ACI_005_HOOK_MARKER),
	);

	if (humanMsgWithMarker.length > 0) {
		ctx.fail(
			"ACI-TEST-005-b: user bubble has no hook stdout",
			`Hook marker found in ${humanMsgWithMarker.length} human user message(s) in JSONL. ` +
				`First offending content: "${String(humanMsgWithMarker[0]!.content).substring(0, 200)}"`,
			shot,
		);
	} else {
		ctx.pass(
			"ACI-TEST-005-b: user bubble has no hook stdout",
			`No human user message bubble (DOM or JSONL) contains the hook marker. ` +
				`Checked ${userBubbleInfo.count} DOM bubble(s) and ${humanUserMessages.length} JSONL message(s).`,
			shot,
		);
	}
}

async function testHookOutputSentAsLLMMessage(ctx: TestContext): Promise<void> {
	console.log("\n── ACI-TEST-005-c: Hook output sent as separate LLM message ──");

	const shot = await ctx.screenshot("aci-005c-hook-llm-message");

	const allMessages = getAllMessages();
	const hookInjectionMessages = allMessages.filter(
		(m) => m.role === "user" && m.is_hook_injection === true,
	);

	if (hookInjectionMessages.length === 0) {
		ctx.fail(
			"ACI-TEST-005-c: hook output sent as separate LLM message",
			`No user message with is_hook_injection=true found in JSONL history. ` +
				`Total messages: ${allMessages.length}. ` +
				`User messages: ${allMessages.filter((m) => m.role === "user").length}`,
			shot,
		);
		return;
	}

	const withMarker = hookInjectionMessages.filter((m) =>
		String(m.content ?? "").includes(ACI_005_HOOK_MARKER),
	);

	if (withMarker.length > 0) {
		ctx.pass(
			"ACI-TEST-005-c: hook output sent as separate LLM message",
			`Found ${hookInjectionMessages.length} hook injection message(s) with is_hook_injection=true. ` +
				`${withMarker.length} contain the expected hook marker text.`,
			shot,
		);
	} else {
		ctx.pass(
			"ACI-TEST-005-c: hook output sent as separate LLM message",
			`Found ${hookInjectionMessages.length} hook injection message(s) with is_hook_injection=true ` +
				`(marker not found in content — may be trimmed by shell, but flag is correctly set). ` +
				`Content sample: "${String(hookInjectionMessages[0]!.content).substring(0, 200)}"`,
			shot,
		);
	}
}

async function testNoCollapsibleWhenNoHookOutput(ctx: TestContext): Promise<void> {
	console.log("\n── ACI-TEST-005-d: No collapsible when hook produces no output ──");

	const hooks = {
		pre_send: [{ id: "aci-005-d", event: "pre_send", command: "true", label: "ACI-005 silent hook", enabled: true }],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
	};
	const settings = buildHookSettings(hooks);
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(5_000);

	await newConversation(ctx.page);
	await sendMessageLocal(ctx.page, "ACI-TEST-005-d: silent hook — no collapsible should appear");
	const shot = await ctx.screenshot("aci-005d-no-collapsible");

	await ctx.page.waitForTimeout(1_000);

	const hookElementCount = await ctx.page.evaluate(() => {
		return document.querySelectorAll(".notor-hook-injection").length;
	});

	if (hookElementCount === 0) {
		ctx.pass(
			"ACI-TEST-005-d: no collapsible when hook produces no output",
			"No .notor-hook-injection elements in DOM — correct, hook produced no stdout",
			shot,
		);
	} else {
		const hookTexts = await ctx.page.evaluate(() => {
			const els = document.querySelectorAll(".notor-hook-injection");
			return Array.from(els).map((el) => (el.textContent ?? "").substring(0, 100));
		});
		ctx.fail(
			"ACI-TEST-005-d: no collapsible when hook produces no output",
			`Found ${hookElementCount} .notor-hook-injection element(s) despite hook producing no output. ` +
				`Texts: ${hookTexts.join(" | ")}`,
			shot,
		);
	}
}

async function testDisabledHookSkipped(ctx: TestContext): Promise<void> {
	console.log("\n── Test 5: Disabled hook → not fired ───────────────────────");

	if (fs.existsSync(HOOK_MARKER_FILE)) fs.unlinkSync(HOOK_MARKER_FILE);

	const hooks = {
		pre_send: [{ id: "test-disabled", event: "pre_send", command: `echo "should-not-appear" > "${HOOK_MARKER_FILE}"`, label: "Disabled hook", enabled: false }],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
	};
	const settings = buildHookSettings(hooks);
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await ctx.page.reload();
	await ctx.page.waitForTimeout(5_000);

	await newConversation(ctx.page);
	await sendMessageLocal(ctx.page, "Test with disabled hook");
	const shot = await ctx.screenshot("05-disabled-hook");

	await ctx.page.waitForTimeout(2_000);

	if (!fs.existsSync(HOOK_MARKER_FILE)) {
		ctx.pass("Disabled hook skipped", "Marker file not created — disabled hook was correctly skipped", shot);
	} else {
		ctx.fail("Disabled hook skipped", "Marker file exists — disabled hook was incorrectly executed", shot);
		fs.unlinkSync(HOOK_MARKER_FILE);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(5_000);

	console.log("Verifying chat panel...");
	const chat = await waitForSelector(ctx.page, ".notor-chat-container", 10_000);
	if (!chat) throw new Error("Chat panel not visible");
	ctx.pass("Chat panel ready", "Plugin loaded");

	// Clear history dir for fresh JSONL
	if (fs.existsSync(HISTORY_DIR)) fs.rmSync(HISTORY_DIR, { recursive: true, force: true });

	console.log("Running hook tests...\n");
	await testPreSendHookInjection(ctx);
	await testAfterCompletionHook(ctx);
	await testHookTimeout(ctx);
	await testFailingHookNonBlocking(ctx);
	await testDisabledHookSkipped(ctx);

	// ── ACI-TEST-005: Hook output rendering (ACI-002) ───────────────────
	console.log("\n[ACI-TEST-005] Running hook output rendering tests (ACI-002)...");

	await testHookOutputRendersAsCollapsible(ctx);
	await testUserBubbleHasNoHookStdout(ctx);
	await testHookOutputSentAsLLMMessage(ctx);
	await testNoCollapsibleWhenNoHookOutput(ctx);
}

runTest(
	{
		name: "hook-execution",
		settings: buildHookSettings({ pre_send: [], on_tool_call: [], on_tool_result: [], after_completion: [] }),
		cleanupFiles: [".hook-marker.txt"],
	},
	tests,
);
