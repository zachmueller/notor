#!/usr/bin/env npx tsx
/**
 * Cancel Tool Call E2E Test
 *
 * Validates that the chat panel remains functional after a user cancels
 * (stops) a response mid-tool-call. The specific failure mode:
 *
 *   1. LLM responds with a tool_use block
 *   2. User clicks Stop before the tool_result is recorded
 *   3. Conversation history now has an orphaned tool_call (no matching tool_result)
 *   4. Next message send fails with Bedrock validation error:
 *      "tool_use ids were found without tool_result blocks immediately after"
 *
 * Scenarios:
 *   1. Cancel during auto-approved tool execution, then send follow-up
 *   2. Cancel during tool approval dialog, then send follow-up
 *   3. New conversation after cancel recovers normally
 *
 * Prerequisites:
 *   - ~/.aws/credentials with a [default] profile
 *   - Bedrock access with deepseek.v3.2
 *
 * Run with:
 *   npx tsx e2e/scripts/cancel-tool-call-test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	newConversation,
	setMode,
	sendMessage,
	getLastAssistantMessage,
	RESPONSE_TIMEOUT_MS,
	POLL_INTERVAL_MS,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Send a message without waiting for the response to complete.
 * Uses page.evaluate to set contenteditable text (avoids keyboard.type
 * which dispatches Enter keydown for \n chars).
 */
async function sendMessageNoWait(page: Page, message: string): Promise<void> {
	const found = await page.evaluate((msg) => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		if (!el) return false;
		el.focus();
		el.textContent = msg;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	}, message);
	if (!found) throw new Error("Chat input not found");

	await page.waitForTimeout(300);

	const sendBtn = await page.$(".notor-send-btn");
	if (sendBtn) await sendBtn.click();
	else await page.keyboard.press("Enter");

	await page.waitForTimeout(400);
	console.log(`    → Sent (no wait): "${message.substring(0, 80)}${message.length > 80 ? "..." : ""}"`);
}

/** Wait until the stop button becomes visible (LLM response in flight). */
async function waitForStopButton(page: Page, timeoutMs = 30_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(300);
		const stopVisible = await page.evaluate(() => {
			const btn = document.querySelector(".notor-stop-btn");
			return btn && !btn.classList.contains("notor-hidden");
		});
		if (stopVisible) return true;
	}
	return false;
}

/** Wait until the contenteditable input is re-enabled. */
async function waitForInputEnabled(page: Page, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(POLL_INTERVAL_MS);
		const enabled = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el !== null && el.getAttribute("contenteditable") === "true";
		});
		if (enabled) return true;
	}
	return false;
}

/** Wait for a tool call card to appear in the chat. */
async function waitForToolCallCard(page: Page, timeoutMs = 30_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(500);
		const found = await page.evaluate(() => {
			return document.querySelectorAll(".notor-tool-call").length > 0;
		});
		if (found) return true;
	}
	return false;
}

/** Wait for an approval button to appear in the chat. */
async function waitForApprovalButton(page: Page, timeoutMs = 30_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(500);
		const found = await page.evaluate(() => {
			return document.querySelector(".notor-approve-btn") !== null;
		});
		if (found) return true;
	}
	return false;
}

/** Click the stop button if visible. Returns true if clicked. */
async function clickStopButton(page: Page): Promise<boolean> {
	const btn = await page.$(".notor-stop-btn");
	if (!btn) return false;
	const visible = await page.evaluate((el) => {
		return !el.classList.contains("notor-hidden");
	}, btn);
	if (!visible) return false;
	await btn.click();
	console.log("    → Clicked stop button");
	return true;
}

/**
 * Check the latest error or assistant message for the orphaned tool_result error.
 * Returns the error text if found, empty string otherwise.
 */
async function checkForToolResultError(page: Page): Promise<string> {
	// Check error elements
	const errEl = await page.$(".notor-chat-error");
	if (errEl) {
		const text = (await errEl.textContent()) ?? "";
		if (text.includes("tool_use") && text.includes("tool_result")) {
			return text.trim();
		}
		// Any error after cancel + send is suspicious
		if (text.trim().length > 0) return text.trim();
	}

	// Also check collector for structured errors with the keyword
	return "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Test 1: Cancel during auto-approved tool execution, then send follow-up.
 *
 * Uses Act mode with read_note auto-approved. Asks the LLM to read a note
 * (triggers an auto-approved tool call). Clicks Stop as soon as the tool call
 * card appears, then sends another message and checks for the Bedrock
 * validation error.
 */
async function testCancelAutoApprovedTool(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 1: Cancel during auto-approved tool call ──────────────");

	await newConversation(page);
	await setMode(page, "Act");
	await page.waitForTimeout(1_000);

	// Send a message that will trigger a read_note tool call
	await sendMessageNoWait(
		page,
		"Read the note called 'cancel-test-fixture.md' in my vault and summarize its contents in detail."
	);

	// Wait for a tool call card or stop button to appear
	const toolCardAppeared = await waitForToolCallCard(page, 30_000);
	const stopVisible = await waitForStopButton(page, 1_000); // Quick check

	const shot1 = await ctx.screenshot("01-tool-call-in-progress");

	if (toolCardAppeared || stopVisible) {
		console.log(`    Tool card: ${toolCardAppeared}, Stop visible: ${stopVisible}`);

		// Click stop to abort mid-tool-call
		const stopped = await clickStopButton(page);
		if (!stopped) {
			// Maybe response already completed
			const inputReady = await waitForInputEnabled(page, 10_000);
			if (inputReady) {
				ctx.pass(
					"cancel auto-approved — response completed before stop",
					"LLM finished before stop could be clicked (fast execution)"
				);
				// Still proceed to send follow-up to check for errors
			} else {
				ctx.fail("cancel auto-approved — could not stop", "Stop button not clickable and input not ready", shot1);
				return;
			}
		}
	} else {
		// Check if response completed very quickly
		const inputReady = await waitForInputEnabled(page, 15_000);
		if (inputReady) {
			ctx.pass(
				"cancel auto-approved — response completed before tool card visible",
				"LLM cycle completed before tool call card rendered"
			);
		} else {
			ctx.fail("cancel auto-approved — no tool call or stop button", "Neither tool call card nor stop button appeared", shot1);
			return;
		}
	}

	// Wait for input to be re-enabled after cancel
	const inputReady = await waitForInputEnabled(page, 15_000);
	const shot2 = await ctx.screenshot("02-after-cancel");

	if (!inputReady) {
		ctx.fail("cancel auto-approved — input re-enabled after stop", "Input still disabled after cancel", shot2);
		return;
	}

	console.log("    → Input re-enabled, sending follow-up message...");

	// Now send a follow-up message — this is where the orphaned tool_use error should surface
	await sendMessageNoWait(page, "Thanks. Now just say the word 'recovered' and nothing else.");

	// Wait for response or error
	const followUpComplete = await waitForInputEnabled(page, 60_000);
	const shot3 = await ctx.screenshot("03-follow-up-result");

	// Check for the specific error
	const errorText = await checkForToolResultError(page);
	const lastMsg = await getLastAssistantMessage(page);

	// Also check collector logs for the specific Bedrock error
	const errorLogs = ctx.collector.getLogsByLevel("error");
	const bedrockToolError = errorLogs.find(
		(e) => e.message.includes("tool_use") || e.message.includes("tool_result")
	);

	if (errorText.includes("tool_use") || errorText.includes("tool_result") || bedrockToolError) {
		const detail = errorText || bedrockToolError?.message || "Unknown";
		ctx.fail(
			"cancel auto-approved — follow-up succeeds",
			`Orphaned tool_use error after cancel: "${detail.substring(0, 200)}"`,
			shot3
		);
	} else if (errorText.length > 0) {
		ctx.fail(
			"cancel auto-approved — follow-up succeeds",
			`Error after follow-up (may be related): "${errorText.substring(0, 200)}"`,
			shot3
		);
	} else if (followUpComplete && lastMsg.trim().length > 0) {
		ctx.pass(
			"cancel auto-approved — follow-up succeeds",
			`Follow-up response received: "${lastMsg.trim().substring(0, 80)}"`,
			shot3
		);
	} else {
		ctx.fail(
			"cancel auto-approved — follow-up succeeds",
			`Follow-up did not produce a response (timeout=${!followUpComplete}, lastMsg="${lastMsg.trim().substring(0, 80)}")`,
			shot3
		);
	}
}

/**
 * Test 2: Cancel during tool approval dialog, then send follow-up.
 *
 * Uses Act mode with write_note NOT auto-approved. Asks the LLM to write
 * a note (triggers approval dialog). Clicks Stop instead of Approve, then
 * sends another message.
 */
async function testCancelDuringApproval(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 2: Cancel during tool approval dialog ──────────────────");

	await newConversation(page);
	await setMode(page, "Act");
	await page.waitForTimeout(1_000);

	// Send a message that will trigger a write_note tool (requires approval)
	await sendMessageNoWait(
		page,
		"Create a new note called 'cancel-test-output.md' with the content 'Hello from cancel test'. " +
		"Use the write_note tool to do this."
	);

	// Wait for the approval button OR tool call card
	const approvalAppeared = await waitForApprovalButton(page, 45_000);
	const shot1 = await ctx.screenshot("04-approval-dialog");

	if (!approvalAppeared) {
		// The LLM might have used an auto-approved tool, or finished without tool call
		const inputReady = await waitForInputEnabled(page, 10_000);
		if (inputReady) {
			const lastMsg = await getLastAssistantMessage(page);
			// Check if a tool call card appeared (tool was auto-approved or LLM didn't use write_note)
			const toolCards = await page.$$(".notor-tool-call");
			if (toolCards.length > 0) {
				ctx.pass(
					"cancel during approval — tool auto-approved",
					"Tool executed without approval dialog (may be auto-approved); skipping approval-cancel test"
				);
			} else {
				ctx.pass(
					"cancel during approval — no tool triggered",
					`LLM responded without tool call: "${lastMsg.trim().substring(0, 80)}"`
				);
			}
			return;
		}

		// Check if stop button is available (LLM is streaming but no approval yet)
		const stopped = await clickStopButton(page);
		if (stopped) {
			console.log("    → Stopped before approval dialog appeared");
			await waitForInputEnabled(page, 10_000);
		} else {
			ctx.fail("cancel during approval — approval dialog appeared", "No approval button and no stop button", shot1);
			return;
		}
	} else {
		console.log("    → Approval dialog visible, clicking stop instead of approve...");

		// Click stop instead of approve
		const stopped = await clickStopButton(page);
		if (!stopped) {
			// Stop button might not be visible during approval; try to find it differently
			// or the UI might not show stop during approval state
			ctx.pass(
				"cancel during approval — stop not available during approval",
				"Stop button not accessible during approval dialog; cannot cancel this way"
			);
			// Reject instead to unblock
			const rejectBtn = await page.$(".notor-reject-btn");
			if (rejectBtn) {
				await rejectBtn.click();
				console.log("    → Clicked reject instead");
			}
			await waitForInputEnabled(page, 10_000);
			return;
		}
	}

	// Wait for input to re-enable
	const inputReady = await waitForInputEnabled(page, 15_000);
	const shot2 = await ctx.screenshot("05-after-approval-cancel");

	if (!inputReady) {
		ctx.fail("cancel during approval — input re-enabled", "Input still disabled after cancel during approval", shot2);
		return;
	}

	console.log("    → Input re-enabled, sending follow-up message...");

	// Send follow-up
	await sendMessageNoWait(page, "Never mind the note. Just say 'recovered' and nothing else.");

	const followUpComplete = await waitForInputEnabled(page, 60_000);
	const shot3 = await ctx.screenshot("06-approval-cancel-follow-up");

	const errorText = await checkForToolResultError(page);
	const lastMsg = await getLastAssistantMessage(page);

	const errorLogs = ctx.collector.getLogsByLevel("error");
	const bedrockToolError = errorLogs.find(
		(e) => e.message.includes("tool_use") || e.message.includes("tool_result")
	);

	if (errorText.includes("tool_use") || errorText.includes("tool_result") || bedrockToolError) {
		const detail = errorText || bedrockToolError?.message || "Unknown";
		ctx.fail(
			"cancel during approval — follow-up succeeds",
			`Orphaned tool_use error after approval cancel: "${detail.substring(0, 200)}"`,
			shot3
		);
	} else if (errorText.length > 0) {
		ctx.fail(
			"cancel during approval — follow-up succeeds",
			`Error after follow-up: "${errorText.substring(0, 200)}"`,
			shot3
		);
	} else if (followUpComplete && lastMsg.trim().length > 0) {
		ctx.pass(
			"cancel during approval — follow-up succeeds",
			`Follow-up response received: "${lastMsg.trim().substring(0, 80)}"`,
			shot3
		);
	} else {
		ctx.fail(
			"cancel during approval — follow-up succeeds",
			`Follow-up failed (timeout=${!followUpComplete}, lastMsg="${lastMsg.trim().substring(0, 80)}")`,
			shot3
		);
	}
}

/**
 * Test 3: New conversation after cancel should recover normally.
 *
 * If the follow-up in the same conversation failed (due to orphaned tool_use),
 * starting a new conversation should clear the message history and allow
 * normal interaction.
 */
async function testNewConversationRecovers(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Test 3: New conversation recovers after cancel ──────────────");

	await newConversation(page);
	await setMode(page, "Plan");
	await page.waitForTimeout(1_000);

	const responded = await sendMessage(page, "Say the single word 'fresh' and nothing else.");
	const shot = await ctx.screenshot("07-new-conversation");

	if (!responded) {
		ctx.fail("new conversation — response received", "No response in new conversation", shot);
		return;
	}

	const lastMsg = await getLastAssistantMessage(page);
	const errorText = await checkForToolResultError(page);

	if (errorText.length > 0) {
		ctx.fail(
			"new conversation — no errors",
			`Error persisted into new conversation: "${errorText.substring(0, 200)}"`,
			shot
		);
	} else if (lastMsg.trim().length > 0) {
		ctx.pass(
			"new conversation — clean recovery",
			`New conversation works: "${lastMsg.trim().substring(0, 80)}"`,
			shot
		);
	} else {
		ctx.fail(
			"new conversation — response content",
			"New conversation got empty response",
			shot
		);
	}
}

/**
 * Test 4: Check structured logs for orphaned tool_use errors.
 *
 * Scans all captured logs for Bedrock validation errors related to
 * tool_use/tool_result pairing, providing a definitive signal even if
 * the UI error element was dismissed or not captured.
 */
async function testCheckLogsForOrphanedToolError(ctx: TestContext): Promise<void> {
	console.log("\n── Test 4: Check logs for orphaned tool_use errors ─────────────");

	const allLogs = ctx.collector.getStructuredLogs();
	const errors = ctx.collector.getLogsByLevel("error");

	const orphanErrors = errors.filter((e) => {
		const msg = (e.message ?? "").toLowerCase();
		const data = JSON.stringify(e.data ?? "").toLowerCase();
		return (
			(msg.includes("tool_use") && msg.includes("tool_result")) ||
			(data.includes("tool_use") && data.includes("tool_result")) ||
			msg.includes("tool_use ids were found without") ||
			data.includes("tool_use ids were found without")
		);
	});

	if (orphanErrors.length > 0) {
		const first = orphanErrors[0]!;
		ctx.fail(
			"logs — no orphaned tool_use errors",
			`Found ${orphanErrors.length} orphaned tool_use error(s): "${first.message.substring(0, 200)}"`,
		);
		for (const err of orphanErrors) {
			console.log(`    [${err.source}] ${err.message}`);
			if (err.data) console.log(`      data: ${JSON.stringify(err.data).substring(0, 200)}`);
		}
	} else {
		// Check raw logs too (the error might come through as a warning or info)
		const allWithKeyword = allLogs.filter((e) => {
			const combined = `${e.message} ${JSON.stringify(e.data ?? "")}`.toLowerCase();
			return combined.includes("tool_use ids were found without");
		});

		if (allWithKeyword.length > 0) {
			ctx.fail(
				"logs — no orphaned tool_use errors",
				`Found ${allWithKeyword.length} orphaned tool_use reference(s) at non-error level`
			);
		} else {
			ctx.pass(
				"logs — no orphaned tool_use errors",
				`No orphaned tool_use/tool_result errors in ${errors.length} error log(s)`
			);
		}
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
	const shot = await ctx.screenshot("00-chat-ready");
	ctx.pass("chat panel ready", "Plugin loaded and chat container found", shot);

	// Run scenarios
	await testCancelAutoApprovedTool(ctx);
	await testCancelDuringApproval(ctx);
	await testNewConversationRecovers(ctx);
	await testCheckLogsForOrphanedToolError(ctx);
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
		fetch_webpage: true,
		// write_note intentionally NOT auto-approved for Test 2
		write_note: false,
		replace_in_note: false,
		update_frontmatter: false,
		manage_tags: false,
		execute_command: false,
	},
});

runTest(
	{
		name: "cancel-tool-call",
		settings,
		setupVault: (vaultPath: string) => {
			// Create a fixture note for the read_note tool call
			const fixturePath = path.join(vaultPath, "cancel-test-fixture.md");
			fs.writeFileSync(
				fixturePath,
				[
					"---",
					"title: Cancel Test Fixture",
					"---",
					"",
					"This is a test note used by the cancel-tool-call e2e test.",
					"It contains enough content that the LLM will attempt to read it",
					"using the read_note tool, giving us a window to click Stop.",
					"",
					"## Section One",
					"Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
					"Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
					"",
					"## Section Two",
					"Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
					"Duis aute irure dolor in reprehenderit in voluptate velit esse.",
				].join("\n"),
			);
			console.log("  Created fixture: cancel-test-fixture.md");
		},
		cleanupFiles: [
			"cancel-test-fixture.md",
			"cancel-test-output.md",
		],
	},
	tests,
);
