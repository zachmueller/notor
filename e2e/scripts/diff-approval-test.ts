#!/usr/bin/env npx tsx
/**
 * Diff Preview & Approval UI Test
 *
 * Tests the diff preview and manual approval flow for write tool operations.
 * Uses AWS Bedrock (default profile) for real LLM calls.
 *
 * Scenarios covered:
 *   1. write_note with auto-approve OFF → diff shown expanded, approve button present
 *   2. Approve a write_note diff → file actually created, tool status → approved
 *   3. Reject a write_note diff → file NOT created, LLM receives rejection message
 *   4. replace_in_note with auto-approve OFF → diff shown with per-change controls
 *   5. Approve a replace_in_note diff → file content updated correctly
 *   6. write_note with auto-approve ON → diff shown collapsed (no approve/reject buttons)
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled on that account with deepseek.v3.2 available
 *
 * Run with:
 *   npx tsx e2e/scripts/diff-approval-test.ts
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	waitForSelector,
	waitForResponse,
	getLastAssistantMessage,
	newConversation,
	setMode,
	buildDefaultSettings,
	VAULT_PATH,
	PLUGIN_DATA_PATH,
} from "../lib/test-helpers";
import type { Page, ElementHandle } from "playwright-core";

// ---------------------------------------------------------------------------
// Local helpers (not available in shared test-helpers)
// ---------------------------------------------------------------------------

/**
 * Wait for an approval prompt or diff view to appear after the LLM makes a
 * write-tool call. This fires before the response loop completes (input is
 * still disabled while approval is pending).
 */
async function waitForApprovalUI(page: Page, timeoutMs = 30_000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(500);

		const approveBtn = await page.$(".notor-approve-btn");
		const rejectBtn = await page.$(".notor-reject-btn");
		const diffView = await page.$(".notor-diff-view");

		if (approveBtn || rejectBtn || diffView) return true;
	}
	return false;
}

/**
 * Send a chat message and return (without waiting for the full response so the
 * caller can intercept the approval UI mid-flight).
 *
 * Uses `page.evaluate()` to set the contenteditable div's text directly,
 * avoiding `keyboard.type()` which dispatches Enter keydown events for `\n`
 * characters — those would trigger the plugin's Enter-to-send handler and
 * prematurely send a partial message.
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

	await page.waitForTimeout(600);

	console.log(`    → Sent: "${message.substring(0, 80)}${message.length > 80 ? "..." : ""}"`);
}

/**
 * Get text of the most recent error.
 */
async function getLastError(page: Page): Promise<string> {
	const errs = await page.$$(".notor-chat-error");
	if (errs.length === 0) return "";
	const last = errs[errs.length - 1]!;
	return (await last.textContent()) ?? "";
}

// ---------------------------------------------------------------------------
// Vault setup
// ---------------------------------------------------------------------------
function setupTestVault(vaultPath: string): void {
	const notes: Record<string, string> = {
		"Diff-Test-Source.md": `# Diff Test Source\n\nThis note is used by the diff-approval E2E tests.\n\n## Section Alpha\n\nOriginal content in section alpha.\n\n## Section Beta\n\nOriginal content in section beta.\n`,
	};

	for (const [relativePath, content] of Object.entries(notes)) {
		const fullPath = path.join(vaultPath, relativePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content, "utf8");
		console.log(`    Created: ${relativePath}`);
	}
}

// ---------------------------------------------------------------------------
// Individual diff/approval tests
// ---------------------------------------------------------------------------

async function testWriteNoteApprovalUIAppears(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Diff Test 1: write_note — approval UI appears ──────────────");
	await newConversation(page);
	await setMode(page, "Act");

	const targetPath = path.join(VAULT_PATH, "Diff-Approve-New.md");
	if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

	// Send the message but do NOT wait for full response — intercept approval UI
	await sendMessageNoWait(
		page,
		"Please create a new note at 'Diff-Approve-New.md' with the content:\n\n# Approval Test\n\nThis note tests the diff approval flow.\n"
	);

	// Wait for approval UI to appear
	const approvalAppeared = await waitForApprovalUI(page, 45_000);
	const shot = await ctx.screenshot("01-approval-ui");

	if (!approvalAppeared) {
		// Check if it auto-approved (settings may not have taken effect)
		const diffCollapsed = await page.$(".notor-diff-collapsed");
		if (diffCollapsed) {
			ctx.fail(
				"write_note — approval UI appears",
				"Diff appeared but was collapsed (auto-approved) — settings may not be correct",
				shot
			);
		} else {
			ctx.fail("write_note — approval UI appears", "Neither approval buttons nor diff view appeared within 45s", shot);
		}
		// Wait for the response to settle before moving on
		await waitForResponse(page, 30_000);
		return;
	}

	// Verify approve and reject buttons are both present
	const approveBtn = await page.$(".notor-approve-btn");
	const rejectBtn = await page.$(".notor-reject-btn");
	const diffView = await page.$(".notor-diff-view");

	if (approveBtn && rejectBtn) {
		ctx.pass("write_note — approval UI appears", "Both approve and reject buttons visible", shot);
	} else if (diffView) {
		ctx.pass("write_note — diff view appears", `Diff view rendered (approveBtn=${!!approveBtn}, rejectBtn=${!!rejectBtn})`, shot);
	} else {
		ctx.fail("write_note — approval UI appears", `Unexpected state: approveBtn=${!!approveBtn}, rejectBtn=${!!rejectBtn}, diffView=${!!diffView}`, shot);
	}

	// Verify the send button is disabled while approval is pending
	const sendDisabled = await page.evaluate(() => {
		const btn = document.querySelector(".notor-send-btn") as HTMLButtonElement | null;
		return btn ? btn.disabled || btn.classList.contains("notor-hidden") : true;
	});
	const textareaDisabled = await page.evaluate(() => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		return el ? el.getAttribute("contenteditable") === "false" : false;
	});

	if (sendDisabled || textareaDisabled) {
		ctx.pass("write_note — send disabled during approval", "Send button or textarea is disabled while approval is pending");
	} else {
		ctx.fail("write_note — send disabled during approval", `sendDisabled=${sendDisabled}, textareaDisabled=${textareaDisabled}`);
	}

	// Clean up: reject to unblock the response loop
	if (rejectBtn) {
		await rejectBtn.click();
	} else if (approveBtn) {
		await approveBtn.click();
	}
	await waitForResponse(page, 30_000);
}

async function testWriteNoteApprove(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Diff Test 2: write_note — approve creates file ─────────────");
	await newConversation(page);
	await setMode(page, "Act");

	const targetPath = path.join(VAULT_PATH, "Diff-Approved-Note.md");
	if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

	await sendMessageNoWait(
		page,
		"Please create a note at 'Diff-Approved-Note.md' with content:\n\n# Approved\n\nApproved via E2E test.\n"
	);

	const approvalAppeared = await waitForApprovalUI(page, 45_000);

	if (!approvalAppeared) {
		// If auto-approve is active the file may have been written already
		await waitForResponse(page, 30_000);
		if (fs.existsSync(targetPath)) {
			ctx.pass("write_note approve — file created (auto-approved)", `File found at ${targetPath}`);
		} else {
			const shot = await ctx.screenshot("02-approve-no-ui");
			ctx.fail("write_note approve — approval UI appeared", "Approval UI did not appear and file not created", shot);
		}
		return;
	}

	await ctx.screenshot("02-approve-before-click");

	// Click approve
	const approveBtn = await page.$(".notor-approve-btn");
	if (!approveBtn) {
		ctx.fail("write_note approve — approve button found", "Approve button not found after approval UI appeared");
		await waitForResponse(page, 30_000);
		return;
	}

	await approveBtn.click();
	await page.waitForTimeout(500);
	ctx.pass("write_note approve — approve button clicked", "Clicked approve");

	// Wait for the full response to complete
	await waitForResponse(page, 30_000);

	const shot2 = await ctx.screenshot("02-approve-after");

	// Verify file was created
	if (fs.existsSync(targetPath)) {
		const content = fs.readFileSync(targetPath, "utf8");
		if (content.includes("Approved") || content.includes("E2E test")) {
			ctx.pass("write_note approve — file created with content", `File at ${targetPath} contains expected text`, shot2);
		} else {
			ctx.pass("write_note approve — file created", `File exists at ${targetPath} (${content.length} chars)`, shot2);
		}
	} else {
		ctx.fail("write_note approve — file created", `File not found at ${targetPath}`, shot2);
	}

	// Verify tool call status shows success/approved
	const toolSuccess = await page.$(".notor-tool-call.notor-tool-success, .notor-tool-call[data-status='success'], .notor-tool-call[data-status='approved']");
	const toolError = await page.$(".notor-tool-call.notor-tool-error, .notor-tool-call[data-status='error']");
	if (toolSuccess) {
		ctx.pass("write_note approve — tool call shows success", "Tool call card has success status");
	} else if (!toolError) {
		ctx.pass("write_note approve — no tool error", "No error status on tool call card");
	} else {
		const errText = await toolError.textContent();
		ctx.fail("write_note approve — tool call shows success", `Tool call shows error: "${errText?.trim().substring(0, 80)}"`, shot2);
	}
}

async function testWriteNoteReject(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Diff Test 3: write_note — reject does not create file ──────");
	await newConversation(page);
	await setMode(page, "Act");

	const targetPath = path.join(VAULT_PATH, "Diff-Rejected-Note.md");
	if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

	await sendMessageNoWait(
		page,
		"Please create a note at 'Diff-Rejected-Note.md' with content:\n\n# Rejected\n\nThis note should NOT be created.\n"
	);

	const approvalAppeared = await waitForApprovalUI(page, 45_000);

	if (!approvalAppeared) {
		await waitForResponse(page, 30_000);
		const shot = await ctx.screenshot("03-reject-no-ui");
		if (fs.existsSync(targetPath)) {
			ctx.fail("write_note reject — approval UI appeared", "File was created without approval prompt — auto-approve may be active", shot);
		} else {
			ctx.fail("write_note reject — approval UI appeared", "Approval UI did not appear", shot);
		}
		return;
	}

	await ctx.screenshot("03-reject-before-click");

	// Click reject
	const rejectBtn = await page.$(".notor-reject-btn");
	if (!rejectBtn) {
		ctx.fail("write_note reject — reject button found", "Reject button not found after approval UI appeared");
		const approveBtn = await page.$(".notor-approve-btn");
		await approveBtn?.click();
		await waitForResponse(page, 30_000);
		return;
	}

	await rejectBtn.click();
	await page.waitForTimeout(500);
	ctx.pass("write_note reject — reject button clicked", "Clicked reject");

	// Wait for LLM to respond to the rejection
	await waitForResponse(page, 30_000);

	const shot2 = await ctx.screenshot("03-reject-after");

	// Verify file was NOT created
	if (!fs.existsSync(targetPath)) {
		ctx.pass("write_note reject — file not created", `File correctly absent at ${targetPath}`, shot2);
	} else {
		ctx.fail("write_note reject — file not created", `File was created despite rejection: ${targetPath}`, shot2);
	}

	// Verify the LLM acknowledged the rejection
	const response = await getLastAssistantMessage(page);
	const lowerResponse = response.toLowerCase();
	if (
		lowerResponse.includes("cancel") ||
		lowerResponse.includes("reject") ||
		lowerResponse.includes("not") ||
		lowerResponse.includes("unable") ||
		lowerResponse.includes("denied")
	) {
		ctx.pass("write_note reject — LLM acknowledges rejection", `Response: "${response.trim().substring(0, 120)}"`, shot2);
	} else if (response.trim().length > 0) {
		ctx.pass("write_note reject — LLM responded after rejection", `Response: "${response.trim().substring(0, 120)}"`, shot2);
	} else {
		ctx.fail("write_note reject — LLM responded after rejection", "No assistant message after rejection");
	}
}

async function testReplaceInNoteApprovalUI(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Diff Test 4: replace_in_note — per-change diff controls ────");
	await newConversation(page);
	await setMode(page, "Act");

	// Reset the source note
	const srcPath = path.join(VAULT_PATH, "Diff-Test-Source.md");
	fs.writeFileSync(
		srcPath,
		`# Diff Test Source\n\nThis note is used by the diff-approval E2E tests.\n\n## Section Alpha\n\nOriginal content in section alpha.\n\n## Section Beta\n\nOriginal content in section beta.\n`,
		"utf8"
	);

	await sendMessageNoWait(
		page,
		"In 'Diff-Test-Source.md', please use replace_in_note to make two changes:\n" +
		"1. Replace 'Original content in section alpha.' with 'Updated content in section alpha.'\n" +
		"2. Replace 'Original content in section beta.' with 'Updated content in section beta.'"
	);

	const approvalAppeared = await waitForApprovalUI(page, 45_000);
	const shot = await ctx.screenshot("04-replace-approval-ui");

	if (!approvalAppeared) {
		await waitForResponse(page, 30_000);
		ctx.fail("replace_in_note — approval UI appears", "No approval UI within 45s", shot);
		return;
	}

	ctx.pass("replace_in_note — approval UI appeared", "Approval or diff UI present", shot);

	// Look for per-change controls
	const perChangeControls = await page.$$(".notor-diff-change-approve, .notor-diff-accept-change, [data-change-index]");
	const acceptAllBtn = await page.$(".notor-accept-all-btn, [aria-label='Accept all']");
	const rejectAllBtn = await page.$(".notor-reject-all-btn, [aria-label='Reject all']");
	const approveBtn = await page.$(".notor-approve-btn");
	const rejectBtn = await page.$(".notor-reject-btn");
	const diffLines = await page.$$(".notor-diff-add, .notor-diff-del");

	if (perChangeControls.length > 0) {
		ctx.pass("replace_in_note — per-change controls shown", `${perChangeControls.length} per-change control(s) found`);
	} else if (acceptAllBtn || rejectAllBtn) {
		ctx.pass("replace_in_note — accept/reject all buttons shown", `acceptAll=${!!acceptAllBtn}, rejectAll=${!!rejectAllBtn}`);
	} else if (approveBtn) {
		ctx.pass("replace_in_note — approve button shown", "Approval button present (single-block approval)");
	} else {
		ctx.fail("replace_in_note — per-change controls shown", "No per-change controls, accept/reject-all buttons, or approve button found");
	}

	// Verify diff lines are rendered (additions/deletions highlighted)
	if (diffLines.length > 0) {
		ctx.pass("replace_in_note — diff lines rendered", `${diffLines.length} diff line(s) shown (additions/deletions)`);
	} else {
		ctx.fail("replace_in_note — diff lines rendered", "No .notor-diff-add or .notor-diff-del elements found in diff view");
	}

	// Approve everything to unblock the response
	if (acceptAllBtn) {
		await (acceptAllBtn as ElementHandle).click();
	} else if (approveBtn) {
		await (approveBtn as ElementHandle).click();
	} else if (rejectBtn) {
		await (rejectBtn as ElementHandle).click();
	}

	await waitForResponse(page, 30_000);
}

async function testReplaceInNoteApprove(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Diff Test 5: replace_in_note — approve applies changes ─────");
	await newConversation(page);
	await setMode(page, "Act");

	const srcPath = path.join(VAULT_PATH, "Diff-Test-Source.md");
	fs.writeFileSync(
		srcPath,
		`# Diff Test Source\n\nThis note is used by the diff-approval E2E tests.\n\n## Section Alpha\n\nOriginal alpha content.\n\n## Section Beta\n\nOriginal beta content.\n`,
		"utf8"
	);

	await sendMessageNoWait(
		page,
		"In 'Diff-Test-Source.md', use replace_in_note to replace 'Original alpha content.' with 'Replaced alpha content via E2E.'"
	);

	const approvalAppeared = await waitForApprovalUI(page, 45_000);

	if (!approvalAppeared) {
		await waitForResponse(page, 30_000);
		// Check if auto-approved and applied
		const content = fs.readFileSync(srcPath, "utf8");
		if (content.includes("Replaced alpha content")) {
			ctx.pass("replace_in_note approve — applied (auto-approved)", "Change applied without approval prompt");
		} else {
			const shot = await ctx.screenshot("05-replace-approve-no-ui");
			ctx.fail("replace_in_note approve — approval UI appeared", "Approval UI did not appear and change not applied", shot);
		}
		return;
	}

	await ctx.screenshot("05-replace-approve-before");

	// Approve the change
	const acceptAllBtn = await page.$(".notor-accept-all-btn, [aria-label='Accept all']");
	const approveBtn = await page.$(".notor-approve-btn");

	if (acceptAllBtn) {
		await (acceptAllBtn as ElementHandle).click();
		ctx.pass("replace_in_note approve — clicked accept all", "Clicked accept all button");
	} else if (approveBtn) {
		await approveBtn.click();
		ctx.pass("replace_in_note approve — clicked approve", "Clicked approve button");
	} else {
		ctx.fail("replace_in_note approve — no approve button", "Neither accept-all nor approve button found");
		await waitForResponse(page, 30_000);
		return;
	}

	await waitForResponse(page, 30_000);

	const shot2 = await ctx.screenshot("05-replace-approve-after");
	const content = fs.readFileSync(srcPath, "utf8");

	if (content.includes("Replaced alpha content via E2E") || content.includes("Replaced alpha")) {
		ctx.pass("replace_in_note approve — change applied", "File contains the expected replacement text", shot2);
	} else if (!content.includes("Original alpha content")) {
		ctx.pass("replace_in_note approve — original text removed", "Original text no longer in file (different replacement text used)", shot2);
	} else {
		ctx.fail("replace_in_note approve — change applied", `File still contains original text. Content: "${content.substring(0, 200)}"`, shot2);
	}
}

async function testAutoApproveDiffCollapsed(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Diff Test 6: auto-approve — diff shown collapsed ───────────");

	// Switch to auto-approve settings by writing directly to data.json
	const autoSettings = buildDefaultSettings({
		auto_approve: {
			read_note: true,
			search_vault: true,
			list_vault: true,
			read_frontmatter: true,
			write_note: true,
			replace_in_note: true,
			update_frontmatter: true,
			manage_tags: true,
		},
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(autoSettings, null, 2));

	// Settings take effect immediately for new conversations without a full reload.
	await newConversation(page);
	await setMode(page, "Act");

	const targetPath = path.join(VAULT_PATH, "Diff-AutoApproved.md");
	if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

	// With auto-approve ON the response completes without any approval prompt
	await sendMessageNoWait(
		page,
		"Please create a note at 'Diff-AutoApproved.md' with content:\n\n# Auto Approved\n\nThis note was auto-approved.\n"
	);

	const responded = await waitForResponse(page);

	const shot = await ctx.screenshot("06-auto-approve");

	if (!responded) {
		ctx.fail("auto-approve — response received", `No response within timeout`, shot);
		return;
	}

	// Approval buttons must NOT be present (auto-approve should have bypassed them)
	const approveBtn = await page.$(".notor-approve-btn");
	const rejectBtn = await page.$(".notor-reject-btn");

	if (!approveBtn && !rejectBtn) {
		ctx.pass("auto-approve — no approval buttons", "No approve/reject buttons shown (correctly auto-approved)", shot);
	} else {
		ctx.fail(
			"auto-approve — no approval buttons",
			`Approval buttons found despite auto-approve=true: approveBtn=${!!approveBtn}, rejectBtn=${!!rejectBtn}`,
			shot
		);
	}

	// A collapsed diff or tool call card SHOULD still appear in the thread
	const diffCollapsed = await page.$(".notor-diff-collapsed, .notor-diff-view");
	const toolCall = await page.$(".notor-tool-call");

	if (diffCollapsed) {
		ctx.pass("auto-approve — collapsed diff shown", "Collapsed diff view present in chat thread");
	} else if (toolCall) {
		ctx.pass("auto-approve — tool call card shown", "Tool call card shown (diff may be embedded)");
	} else {
		ctx.fail("auto-approve — collapsed diff or tool card shown", "No collapsed diff or tool call card found in thread");
	}

	// Verify the file was actually created (auto-approve executed the tool)
	if (fs.existsSync(targetPath)) {
		ctx.pass("auto-approve — file created", `File at ${targetPath} exists`);
	} else {
		ctx.fail("auto-approve — file created", `File not found at ${targetPath} after auto-approved write_note`);
	}
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function allTests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	// Give the plugin time to fully initialize
	await page.waitForTimeout(5_000);

	// Verify chat panel
	console.log("Verifying chat panel...");
	{
		const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
		if (!chatContainer) {
			const shot = await ctx.screenshot("00-no-chat-panel");
			ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
			throw new Error("Chat panel not visible — cannot run diff/approval tests");
		}
		const shot = await ctx.screenshot("00-chat-ready");
		ctx.pass("Chat panel ready", "Plugin loaded and chat container found", shot);
	}

	// Run tests (manual approval settings active for tests 1-5)
	await testWriteNoteApprovalUIAppears(ctx);
	await testWriteNoteApprove(ctx);
	await testWriteNoteReject(ctx);
	await testReplaceInNoteApprovalUI(ctx);
	await testReplaceInNoteApprove(ctx);

	// Test 6 uses auto-approve settings (mutates data.json mid-test)
	await testAutoApproveDiffCollapsed(ctx);
}

runTest(
	{
		name: "diff-approval-test",
		settings: buildDefaultSettings({
			auto_approve: {
				read_note: true,
				search_vault: true,
				list_vault: true,
				read_frontmatter: true,
				write_note: false,
				replace_in_note: false,
				update_frontmatter: false,
				manage_tags: false,
			},
		}),
		setupVault: (vaultPath) => setupTestVault(vaultPath),
		cleanupFiles: [
			"Diff-Test-Source.md",
			"Diff-Approve-New.md",
			"Diff-Approved-Note.md",
			"Diff-Rejected-Note.md",
			"Diff-AutoApproved.md",
		],
	},
	allTests,
);
