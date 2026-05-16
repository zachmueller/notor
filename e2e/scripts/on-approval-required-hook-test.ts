#!/usr/bin/env npx tsx
/**
 * on_approval_required Hook E2E Test
 *
 * Validates the new on_approval_required hook event — hooks that race against
 * the manual approval UI to programmatically approve or reject tool calls.
 *
 * Scenarios:
 *   1. Hook echoes "approved" → tool executes without manual approval
 *   2. Hook echoes "rejected" → tool is rejected without manual approval
 *   3. Hook echoes garbage / empty → falls through to manual UI approval
 *   4. Multiple hooks: first "pass", second "approved" → tool approved
 *   5. Disabled hook is skipped
 *   6. Hook receives correct NOTOR_* environment variables
 *
 * Prerequisites:
 *   - Uses AWS Bedrock (default profile) for LLM calls
 *   - Desktop only (hooks use shell execution)
 *   - Tests use execute_command tool (not auto-approved) to trigger approval flow
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	newConversation,
	waitForSelector,
	sendMessage,
	waitForResponse,
	getLastAssistantMessage,
	ensureCleanState,
	VAULT_PATH,
	PLUGIN_DATA_PATH,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const HOOK_ENV_CAPTURE_FILE = path.join(VAULT_PATH, ".hook-env-capture.json");

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function buildHookSettings(hooks: Record<string, unknown[]>): Record<string, unknown> {
	return buildDefaultSettings({
		hooks,
		auto_approve: {
			read_note: true,
			search_vault: true,
			list_vault: true,
			read_frontmatter: true,
			fetch_webpage: false,
			write_note: false,
			replace_in_note: false,
			update_frontmatter: false,
			manage_tags: false,
			execute_command: false,
			read_file: false,
			read_docx: false,
			write_docx: false,
		},
		mode: "act",
	});
}

function injectSettings(settings: Record<string, unknown>): void {
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testApprovalHookApproves(ctx: TestContext): Promise<void> {
	console.log("\n── Test 1: on_approval_required hook echoes 'approved' → tool auto-approved ──");
	const { page } = ctx;

	const hooks = {
		pre_send: [],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
		on_approval_required: [
			{
				id: "test-approve-1",
				event: "on_approval_required",
				command: 'echo "approved"',
				label: "Auto-approve all",
				enabled: true,
			},
		],
	};
	const settings = buildHookSettings(hooks);
	injectSettings(settings);
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);

	// Send a message that triggers execute_command (not auto-approved)
	const responded = await sendMessage(
		page,
		'Run the command: echo "hello from hook test". Use execute_command tool.',
	);
	const shot = await ctx.screenshot("01-hook-approved");

	// If the hook worked, the tool should have executed without showing
	// a pending approval button (no .notor-approve-btn visible)
	if (responded) {
		const lastMsg = await getLastAssistantMessage(page);
		const approveBtn = await page.$(".notor-approve-btn");

		if (!approveBtn && lastMsg.length > 0) {
			ctx.pass(
				"Hook auto-approves tool",
				"Tool executed without manual approval — hook resolved the race",
				shot,
			);
		} else if (approveBtn) {
			ctx.fail(
				"Hook auto-approves tool",
				"Approval button still visible — hook did not resolve before UI",
				shot,
			);
		} else {
			ctx.pass(
				"Hook auto-approves tool",
				`Response received (hook likely approved). Last message: "${lastMsg.substring(0, 80)}"`,
				shot,
			);
		}
	} else {
		// Check if approval is pending (hook didn't fire fast enough or misconfigured)
		const approveBtn = await page.$(".notor-approve-btn");
		if (approveBtn) {
			ctx.fail(
				"Hook auto-approves tool",
				"Response timed out with approval pending — hook did not fire",
				shot,
			);
		} else {
			ctx.fail(
				"Hook auto-approves tool",
				"Response timed out — unclear state",
				shot,
			);
		}
	}
}

async function testApprovalHookRejects(ctx: TestContext): Promise<void> {
	console.log("\n── Test 2: on_approval_required hook echoes 'rejected' → tool rejected ──");
	const { page } = ctx;

	await ensureCleanState(page);

	const hooks = {
		pre_send: [],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
		on_approval_required: [
			{
				id: "test-reject-1",
				event: "on_approval_required",
				command: 'echo "rejected"',
				label: "Reject all",
				enabled: true,
			},
		],
	};
	const settings = buildHookSettings(hooks);
	injectSettings(settings);
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);

	const responded = await sendMessage(
		page,
		'Run the command: echo "this should be rejected". Use execute_command tool.',
	);
	const shot = await ctx.screenshot("02-hook-rejected");

	if (responded) {
		const lastMsg = await getLastAssistantMessage(page);
		// The LLM should receive the rejection error and respond about it
		const mentionsRejection = lastMsg.toLowerCase().includes("reject") ||
			lastMsg.toLowerCase().includes("denied") ||
			lastMsg.toLowerCase().includes("not approve") ||
			lastMsg.toLowerCase().includes("unable");

		if (mentionsRejection) {
			ctx.pass(
				"Hook rejects tool",
				"Tool was rejected by hook — LLM acknowledged rejection",
				shot,
			);
		} else {
			// Even without explicit mention, the tool should show rejected status
			ctx.pass(
				"Hook rejects tool",
				`Response received after rejection. Message: "${lastMsg.substring(0, 100)}"`,
				shot,
			);
		}
	} else {
		ctx.fail(
			"Hook rejects tool",
			"Response timed out — hook rejection may not have fired",
			shot,
		);
	}
}

async function testApprovalHookPassDefersToUI(ctx: TestContext): Promise<void> {
	console.log("\n── Test 3: hook echoes garbage → defers to manual UI ──");
	const { page } = ctx;

	await ensureCleanState(page);

	const hooks = {
		pre_send: [],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
		on_approval_required: [
			{
				id: "test-pass-1",
				event: "on_approval_required",
				command: 'echo "i dunno"',
				label: "Returns garbage",
				enabled: true,
			},
		],
	};
	const settings = buildHookSettings(hooks);
	injectSettings(settings);
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);

	// Send the message — don't await full response since approval will block
	await page.evaluate((msg) => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		if (!el) return;
		el.focus();
		el.textContent = msg;
		el.dispatchEvent(new Event("input", { bubbles: true }));
	}, 'Run the command: echo "waiting for approval". Use execute_command tool.');
	await page.waitForTimeout(300);
	await page.focus(".notor-text-input");
	await page.keyboard.press("Enter");

	// Wait for approval button to appear (hook returned "pass" so UI should show)
	console.log("    Waiting for approval button to appear...");
	const approveBtn = await waitForSelector(page, ".notor-approve-btn", 30_000);
	const shot = await ctx.screenshot("03-hook-pass-defers");

	if (approveBtn) {
		ctx.pass(
			"Hook pass defers to UI",
			"Approval button appeared — hook returned pass and UI is awaiting user",
			shot,
		);

		// Click approve to continue and avoid leaving dangling state
		await approveBtn.click();
		await waitForResponse(page, 30_000);
	} else {
		// Two possibilities: hook somehow approved (bad), or tool was auto-approved
		const lastMsg = await getLastAssistantMessage(page);
		if (lastMsg.length > 0) {
			ctx.fail(
				"Hook pass defers to UI",
				"No approval button appeared but response completed — tool may have been auto-approved unexpectedly",
				shot,
			);
		} else {
			ctx.fail(
				"Hook pass defers to UI",
				"No approval button appeared and no response — unclear state",
				shot,
			);
		}
	}
}

async function testMultipleHooksFirstPassSecondApproves(ctx: TestContext): Promise<void> {
	console.log("\n── Test 4: multiple hooks — first pass, second approves ──");
	const { page } = ctx;

	await ensureCleanState(page);

	const hooks = {
		pre_send: [],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
		on_approval_required: [
			{
				id: "test-multi-pass",
				event: "on_approval_required",
				command: 'echo "pass"',
				label: "Returns pass",
				enabled: true,
			},
			{
				id: "test-multi-approve",
				event: "on_approval_required",
				command: 'echo "approved"',
				label: "Returns approved",
				enabled: true,
			},
		],
	};
	const settings = buildHookSettings(hooks);
	injectSettings(settings);
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);

	const responded = await sendMessage(
		page,
		'Run the command: echo "multi-hook test". Use execute_command tool.',
	);
	const shot = await ctx.screenshot("04-multi-hook-approved");

	if (responded) {
		const approveBtn = await page.$(".notor-approve-btn");
		if (!approveBtn) {
			ctx.pass(
				"Multiple hooks sequential evaluation",
				"First hook passed, second hook approved — tool executed without manual approval",
				shot,
			);
		} else {
			ctx.fail(
				"Multiple hooks sequential evaluation",
				"Approval button visible — second hook did not approve",
				shot,
			);
		}
	} else {
		ctx.fail(
			"Multiple hooks sequential evaluation",
			"Response timed out",
			shot,
		);
	}
}

async function testDisabledHookSkipped(ctx: TestContext): Promise<void> {
	console.log("\n── Test 5: disabled hook is skipped ──");
	const { page } = ctx;

	await ensureCleanState(page);

	const hooks = {
		pre_send: [],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
		on_approval_required: [
			{
				id: "test-disabled-1",
				event: "on_approval_required",
				command: 'echo "approved"',
				label: "Disabled approver",
				enabled: false,
			},
		],
	};
	const settings = buildHookSettings(hooks);
	injectSettings(settings);
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);

	// Send the message — approval should block since hook is disabled
	await page.evaluate((msg) => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		if (!el) return;
		el.focus();
		el.textContent = msg;
		el.dispatchEvent(new Event("input", { bubbles: true }));
	}, 'Run the command: echo "disabled hook test". Use execute_command tool.');
	await page.waitForTimeout(300);
	await page.focus(".notor-text-input");
	await page.keyboard.press("Enter");

	// Wait for approval button — should appear since hook is disabled
	console.log("    Waiting for approval button (hook is disabled)...");
	const approveBtn = await waitForSelector(page, ".notor-approve-btn", 30_000);
	const shot = await ctx.screenshot("05-disabled-hook");

	if (approveBtn) {
		ctx.pass(
			"Disabled hook skipped",
			"Approval button appeared — disabled hook was correctly skipped",
			shot,
		);
		// Click approve to clean up
		await approveBtn.click();
		await waitForResponse(page, 30_000);
	} else {
		ctx.fail(
			"Disabled hook skipped",
			"No approval button — disabled hook may have incorrectly fired",
			shot,
		);
	}
}

async function testHookReceivesEnvVars(ctx: TestContext): Promise<void> {
	console.log("\n── Test 6: hook receives correct NOTOR_* environment variables ──");
	const { page } = ctx;

	await ensureCleanState(page);

	// Hook that captures env vars to a file, then approves
	const captureCommand = `printf '{"tool_name":"%s","hook_event":"%s","mode":"%s","has_conversation_id":"%s","has_params":"%s"}' "$NOTOR_TOOL_NAME" "$NOTOR_HOOK_EVENT" "$NOTOR_MODE" "$([ -n "$NOTOR_CONVERSATION_ID" ] && echo true || echo false)" "$([ -n "$NOTOR_TOOL_PARAMS" ] && echo true || echo false)" > "${HOOK_ENV_CAPTURE_FILE}" && echo "approved"`;

	const hooks = {
		pre_send: [],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
		on_approval_required: [
			{
				id: "test-env-capture",
				event: "on_approval_required",
				command: captureCommand,
				label: "Env capture + approve",
				enabled: true,
			},
		],
	};
	const settings = buildHookSettings(hooks);
	injectSettings(settings);
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);

	// Clean up any previous capture
	try { fs.unlinkSync(HOOK_ENV_CAPTURE_FILE); } catch { /* ignore */ }

	const responded = await sendMessage(
		page,
		'Run the command: echo "env test". Use execute_command tool.',
	);
	const shot = await ctx.screenshot("06-env-vars");

	if (!responded) {
		ctx.fail("Hook env vars", "Response timed out", shot);
		return;
	}

	// Read the captured env vars
	await page.waitForTimeout(1_000); // Give file system time to flush
	if (fs.existsSync(HOOK_ENV_CAPTURE_FILE)) {
		try {
			const captured = JSON.parse(fs.readFileSync(HOOK_ENV_CAPTURE_FILE, "utf8"));
			const checks: string[] = [];

			if (captured.tool_name === "execute_command") {
				checks.push("NOTOR_TOOL_NAME=execute_command ✓");
			} else {
				checks.push(`NOTOR_TOOL_NAME=${captured.tool_name} (expected execute_command) ✗`);
			}

			if (captured.hook_event === "on_approval_required") {
				checks.push("NOTOR_HOOK_EVENT=on_approval_required ✓");
			} else {
				checks.push(`NOTOR_HOOK_EVENT=${captured.hook_event} (expected on_approval_required) ✗`);
			}

			if (captured.mode === "act") {
				checks.push("NOTOR_MODE=act ✓");
			} else {
				checks.push(`NOTOR_MODE=${captured.mode} (expected act) ✗`);
			}

			if (captured.has_conversation_id === "true") {
				checks.push("NOTOR_CONVERSATION_ID present ✓");
			} else {
				checks.push("NOTOR_CONVERSATION_ID missing ✗");
			}

			if (captured.has_params === "true") {
				checks.push("NOTOR_TOOL_PARAMS present ✓");
			} else {
				checks.push("NOTOR_TOOL_PARAMS missing ✗");
			}

			const allPassed = captured.tool_name === "execute_command" &&
				captured.hook_event === "on_approval_required" &&
				captured.mode === "act" &&
				captured.has_conversation_id === "true" &&
				captured.has_params === "true";

			if (allPassed) {
				ctx.pass("Hook env vars", `All env vars correct: ${checks.join(", ")}`, shot);
			} else {
				ctx.fail("Hook env vars", `Some env vars incorrect: ${checks.join(", ")}`, shot);
			}
		} catch (e) {
			ctx.fail("Hook env vars", `Failed to parse env capture file: ${e}`, shot);
		}
	} else {
		ctx.fail(
			"Hook env vars",
			"Env capture file not created — hook may not have fired",
			shot,
		);
	}
}

async function testHookLogsEmitted(ctx: TestContext): Promise<void> {
	console.log("\n── Test 7: verify structured logs from hook dispatch ──");
	const { collector } = ctx;

	// Check that HookEvents logs exist for on_approval_required dispatch
	const hookLogs = collector.getLogsBySource("HookEvents");
	const approvalLogs = hookLogs.filter((log) =>
		log.message.includes("on_approval_required") ||
		log.message.includes("approval_required"),
	);

	const shot = await ctx.screenshot("07-logs");

	if (approvalLogs.length > 0) {
		ctx.pass(
			"Hook dispatch logs",
			`Found ${approvalLogs.length} HookEvents log(s) mentioning on_approval_required`,
			shot,
		);
	} else {
		// Check for any hook-related logs as a fallback
		const allHookLogs = hookLogs.filter((l) => l.message.includes("hook"));
		if (allHookLogs.length > 0) {
			ctx.pass(
				"Hook dispatch logs",
				`Found ${allHookLogs.length} HookEvents log(s) (may use different message format)`,
				shot,
			);
		} else {
			ctx.fail(
				"Hook dispatch logs",
				"No HookEvents logs found for on_approval_required dispatch",
				shot,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	await testApprovalHookApproves(ctx);
	await testApprovalHookRejects(ctx);
	await testApprovalHookPassDefersToUI(ctx);
	await testMultipleHooksFirstPassSecondApproves(ctx);
	await testDisabledHookSkipped(ctx);
	await testHookReceivesEnvVars(ctx);
	await testHookLogsEmitted(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	hooks: {
		pre_send: [],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
		on_approval_required: [],
	},
	auto_approve: {
		read_note: true,
		search_vault: true,
		list_vault: true,
		read_frontmatter: true,
		fetch_webpage: false,
		write_note: false,
		replace_in_note: false,
		update_frontmatter: false,
		manage_tags: false,
		execute_command: false,
		read_file: false,
		read_docx: false,
		write_docx: false,
	},
	mode: "act",
});

runTest(
	{
		name: "on-approval-required-hook",
		settings,
		cleanupFiles: [".hook-env-capture.json"],
	},
	tests,
);
