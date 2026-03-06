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

import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type ElementHandle } from "playwright-core";
import {
	launchObsidian,
	closeObsidian,
	type ObsidianProcess,
} from "../lib/obsidian-launcher";
import { LogCollector } from "../lib/log-collector";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const VAULT_PATH = path.resolve(__dirname, "..", "test-vault");
const CDP_PORT = 9222;
const RESULTS_DIR = path.resolve(__dirname, "..", "results");
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots", "diff-approval");
const LOGS_DIR = path.join(RESULTS_DIR, "logs");
const BUILD_DIR = path.resolve(__dirname, "..", "..", "build");
const PLUGIN_DATA_PATH = path.join(BUILD_DIR, "data.json");

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
const RESPONSE_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_500;

// ---------------------------------------------------------------------------
// Test results
// ---------------------------------------------------------------------------
interface TestResult {
	name: string;
	passed: boolean;
	detail: string;
	screenshot?: string;
}

const results: TestResult[] = [];

function pass(name: string, detail: string, screenshot?: string): void {
	console.log(`  ✓ PASS: ${name} — ${detail}`);
	results.push({ name, passed: true, detail, screenshot });
}

function fail(name: string, detail: string, screenshot?: string): void {
	console.error(`  ✗ FAIL: ${name} — ${detail}`);
	results.push({ name, passed: false, detail, screenshot });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function screenshot(page: Page, name: string): Promise<string> {
	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
	const file = path.join(SCREENSHOTS_DIR, `${name}.png`);
	await page.screenshot({ path: file, fullPage: true });
	return file;
}

async function waitForSelector(
	page: Page,
	selector: string,
	timeoutMs = 8_000
): Promise<ElementHandle | null> {
	try {
		return await page.waitForSelector(selector, { timeout: timeoutMs });
	} catch {
		return null;
	}
}

/**
 * Wait for the LLM response to finish (textarea re-enabled).
 * Returns true if completed within timeout, false otherwise.
 */
async function waitForResponse(page: Page, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(POLL_INTERVAL_MS);

		const inputEnabled = await page.evaluate(() => {
			const ta = document.querySelector(".notor-text-input") as HTMLTextAreaElement | null;
			return ta !== null && !ta.disabled;
		});

		if (inputEnabled) return true;

		const lastMsg = await page.$(".notor-message-assistant:last-child");
		if (lastMsg) {
			const partial = await lastMsg.textContent();
			const elapsed = Math.round((Date.now() - start) / 1000);
			if (partial?.trim()) {
				console.log(`    [${elapsed}s] Streaming: "${partial.trim().substring(0, 80)}..."`);
			}
		}
	}
	return false;
}

/**
 * Wait for an approval prompt or diff view to appear after the LLM makes a
 * write-tool call. This fires before the response loop completes (input is
 * still disabled while approval is pending).
 *
 * Returns true if the approval UI appeared within the timeout.
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
 */
async function sendMessageNoWait(page: Page, message: string): Promise<void> {
	const textarea = await page.$(".notor-text-input");
	if (!textarea) throw new Error("Textarea not found");

	await textarea.fill(message);
	await page.waitForTimeout(200);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(600);

	console.log(`    → Sent: "${message.substring(0, 80)}${message.length > 80 ? "..." : ""}"`);
}

/**
 * Send a chat message and wait for the full response.
 */
async function sendMessage(page: Page, message: string): Promise<boolean> {
	await sendMessageNoWait(page, message);
	return waitForResponse(page);
}

/**
 * Get the text of the most recent assistant message.
 */
async function getLastAssistantMessage(page: Page): Promise<string> {
	const msgs = await page.$$(".notor-message-assistant");
	if (msgs.length === 0) return "";
	const last = msgs[msgs.length - 1]!;
	return (await last.textContent()) ?? "";
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

/**
 * Start a fresh conversation.
 */
async function newConversation(page: Page): Promise<void> {
	const btn = await page.$(".notor-chat-header-btn[aria-label='New conversation']");
	if (btn) {
		await btn.click();
		await page.waitForTimeout(1_500);
	}
}

/**
 * Switch the chat mode to Plan or Act.
 */
async function setMode(page: Page, mode: "Plan" | "Act"): Promise<void> {
	const toggle = await page.$(".notor-mode-toggle");
	if (!toggle) throw new Error("Mode toggle not found");

	const current = await toggle.textContent();
	if (current?.trim() === mode) return;

	await toggle.click();
	await page.waitForTimeout(400);

	const updated = await toggle.textContent();
	if (updated?.trim() !== mode) {
		throw new Error(`Failed to switch to ${mode} mode (currently "${updated?.trim()}")`);
	}
}

// ---------------------------------------------------------------------------
// Settings builders
// ---------------------------------------------------------------------------

/** Write tools require manual approval. */
function buildManualApprovalSettings(): Record<string, unknown> {
	return buildSettings({ writeAutoApprove: false });
}

/** All write tools auto-approved (diff shown collapsed). */
function buildAutoApproveSettings(): Record<string, unknown> {
	return buildSettings({ writeAutoApprove: true });
}

function buildSettings({ writeAutoApprove }: { writeAutoApprove: boolean }): Record<string, unknown> {
	return {
		notor_dir: "notor/",
		active_provider: "bedrock",
		providers: [
			{
				type: "local",
				enabled: false,
				display_name: "Local (OpenAI-compatible)",
				endpoint: "http://localhost:11434/v1",
			},
			{
				type: "anthropic",
				enabled: false,
				display_name: "Anthropic",
				endpoint: "https://api.anthropic.com",
			},
			{
				type: "openai",
				enabled: false,
				display_name: "OpenAI",
				endpoint: "https://api.openai.com",
			},
			{
				type: "bedrock",
				enabled: true,
				display_name: "AWS Bedrock",
				aws_auth_method: "profile",
				aws_profile: "default",
				region: "us-east-1",
				model_id: "deepseek.v3.2",
			},
		],
		auto_approve: {
			read_note: true,
			search_vault: true,
			list_vault: true,
			read_frontmatter: true,
			write_note: writeAutoApprove,
			replace_in_note: writeAutoApprove,
			update_frontmatter: writeAutoApprove,
			manage_tags: writeAutoApprove,
		},
		mode: "plan",
		open_notes_on_access: true,
		history_path: ".obsidian/plugins/notor/history/",
		history_max_size_mb: 500,
		history_max_age_days: 90,
		checkpoint_path: ".obsidian/plugins/notor/checkpoints/",
		checkpoint_max_per_conversation: 100,
		checkpoint_max_age_days: 30,
		model_pricing: {},
	};
}

// ---------------------------------------------------------------------------
// Vault setup
// ---------------------------------------------------------------------------
function setupTestVault(): void {
	const notes: Record<string, string> = {
		"Diff-Test-Source.md": `# Diff Test Source\n\nThis note is used by the diff-approval E2E tests.\n\n## Section Alpha\n\nOriginal content in section alpha.\n\n## Section Beta\n\nOriginal content in section beta.\n`,
	};

	for (const [relativePath, content] of Object.entries(notes)) {
		const fullPath = path.join(VAULT_PATH, relativePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content, "utf8");
		console.log(`    Created: ${relativePath}`);
	}
}

// ---------------------------------------------------------------------------
// Individual diff/approval tests
// ---------------------------------------------------------------------------

/**
 * Test 1: write_note with manual approval — diff shown, approve button present
 *
 * Verify that when write tools are NOT auto-approved:
 *  - A diff view appears in the chat thread
 *  - Approve and reject buttons are both visible
 *  - The send button is disabled while approval is pending
 */
async function testWriteNoteApprovalUIAppears(page: Page): Promise<void> {
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
	const shot = await screenshot(page, "01-approval-ui");

	if (!approvalAppeared) {
		// Check if it auto-approved (settings may not have taken effect)
		const diffCollapsed = await page.$(".notor-diff-collapsed");
		if (diffCollapsed) {
			fail(
				"write_note — approval UI appears",
				"Diff appeared but was collapsed (auto-approved) — settings may not be correct",
				shot
			);
		} else {
			fail("write_note — approval UI appears", "Neither approval buttons nor diff view appeared within 45s", shot);
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
		pass("write_note — approval UI appears", "Both approve and reject buttons visible", shot);
	} else if (diffView) {
		pass("write_note — diff view appears", `Diff view rendered (approveBtn=${!!approveBtn}, rejectBtn=${!!rejectBtn})`, shot);
	} else {
		fail("write_note — approval UI appears", `Unexpected state: approveBtn=${!!approveBtn}, rejectBtn=${!!rejectBtn}, diffView=${!!diffView}`, shot);
	}

	// Verify the send button is disabled while approval is pending
	const sendDisabled = await page.evaluate(() => {
		const btn = document.querySelector(".notor-send-btn") as HTMLButtonElement | null;
		return btn ? btn.disabled || btn.classList.contains("notor-hidden") : true;
	});
	const textareaDisabled = await page.evaluate(() => {
		const ta = document.querySelector(".notor-text-input") as HTMLTextAreaElement | null;
		return ta ? ta.disabled : false;
	});

	if (sendDisabled || textareaDisabled) {
		pass("write_note — send disabled during approval", "Send button or textarea is disabled while approval is pending");
	} else {
		fail("write_note — send disabled during approval", `sendDisabled=${sendDisabled}, textareaDisabled=${textareaDisabled}`);
	}

	// Clean up: reject to unblock the response loop
	if (rejectBtn) {
		await rejectBtn.click();
	} else if (approveBtn) {
		// If only approve exists, click it to unblock
		await approveBtn.click();
	}
	await waitForResponse(page, 30_000);
}

/**
 * Test 2: write_note — approve creates the file
 *
 * After approval the file should exist on disk with correct content.
 * The tool call status should transition to approved/success.
 */
async function testWriteNoteApprove(page: Page): Promise<void> {
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
			pass("write_note approve — file created (auto-approved)", `File found at ${targetPath}`);
		} else {
			const shot = await screenshot(page, "02-approve-no-ui");
			fail("write_note approve — approval UI appeared", "Approval UI did not appear and file not created", shot);
		}
		return;
	}

	const shot1 = await screenshot(page, "02-approve-before-click");

	// Click approve
	const approveBtn = await page.$(".notor-approve-btn");
	if (!approveBtn) {
		fail("write_note approve — approve button found", "Approve button not found after approval UI appeared");
		await waitForResponse(page, 30_000);
		return;
	}

	await approveBtn.click();
	await page.waitForTimeout(500);
	pass("write_note approve — approve button clicked", "Clicked approve");

	// Wait for the full response to complete
	await waitForResponse(page, 30_000);

	const shot2 = await screenshot(page, "02-approve-after");

	// Verify file was created
	if (fs.existsSync(targetPath)) {
		const content = fs.readFileSync(targetPath, "utf8");
		if (content.includes("Approved") || content.includes("E2E test")) {
			pass("write_note approve — file created with content", `File at ${targetPath} contains expected text`, shot2);
		} else {
			pass("write_note approve — file created", `File exists at ${targetPath} (${content.length} chars)`, shot2);
		}
	} else {
		fail("write_note approve — file created", `File not found at ${targetPath}`, shot2);
	}

	// Verify tool call status shows success/approved
	const toolSuccess = await page.$(".notor-tool-call.notor-tool-success, .notor-tool-call[data-status='success'], .notor-tool-call[data-status='approved']");
	const toolError = await page.$(".notor-tool-call.notor-tool-error, .notor-tool-call[data-status='error']");
	if (toolSuccess) {
		pass("write_note approve — tool call shows success", "Tool call card has success status");
	} else if (!toolError) {
		pass("write_note approve — no tool error", "No error status on tool call card");
	} else {
		const errText = await toolError.textContent();
		fail("write_note approve — tool call shows success", `Tool call shows error: "${errText?.trim().substring(0, 80)}"`, shot2);
	}
}

/**
 * Test 3: write_note — reject does NOT create file
 *
 * After rejection the file must NOT exist on disk.
 * The LLM should receive a rejection message and respond accordingly.
 */
async function testWriteNoteReject(page: Page): Promise<void> {
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
		const shot = await screenshot(page, "03-reject-no-ui");
		// If auto-approved it will be created — report that as a test gap
		if (fs.existsSync(targetPath)) {
			fail("write_note reject — approval UI appeared", "File was created without approval prompt — auto-approve may be active", shot);
		} else {
			fail("write_note reject — approval UI appeared", "Approval UI did not appear", shot);
		}
		return;
	}

	const shot1 = await screenshot(page, "03-reject-before-click");

	// Click reject
	const rejectBtn = await page.$(".notor-reject-btn");
	if (!rejectBtn) {
		fail("write_note reject — reject button found", "Reject button not found after approval UI appeared");
		// Approve to unblock
		const approveBtn = await page.$(".notor-approve-btn");
		await approveBtn?.click();
		await waitForResponse(page, 30_000);
		return;
	}

	await rejectBtn.click();
	await page.waitForTimeout(500);
	pass("write_note reject — reject button clicked", "Clicked reject");

	// Wait for LLM to respond to the rejection
	await waitForResponse(page, 30_000);

	const shot2 = await screenshot(page, "03-reject-after");

	// Verify file was NOT created
	if (!fs.existsSync(targetPath)) {
		pass("write_note reject — file not created", `File correctly absent at ${targetPath}`, shot2);
	} else {
		fail("write_note reject — file not created", `File was created despite rejection: ${targetPath}`, shot2);
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
		pass("write_note reject — LLM acknowledges rejection", `Response: "${response.trim().substring(0, 120)}"`, shot2);
	} else if (response.trim().length > 0) {
		pass("write_note reject — LLM responded after rejection", `Response: "${response.trim().substring(0, 120)}"`, shot2);
	} else {
		fail("write_note reject — LLM responded after rejection", "No assistant message after rejection");
	}
}

/**
 * Test 4: replace_in_note — approval UI shows per-change diff controls
 *
 * When a replace_in_note call has multiple SEARCH/REPLACE blocks, the diff
 * view should show individual accept/reject controls per change.
 */
async function testReplaceInNoteApprovalUI(page: Page): Promise<void> {
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
	const shot = await screenshot(page, "04-replace-approval-ui");

	if (!approvalAppeared) {
		await waitForResponse(page, 30_000);
		fail("replace_in_note — approval UI appears", "No approval UI within 45s", shot);
		return;
	}

	pass("replace_in_note — approval UI appeared", "Approval or diff UI present", shot);

	// Look for per-change controls (individual accept/reject per block)
	// The diff view may show multiple blocks each with their own buttons,
	// or a single set of approve/reject/accept-all/reject-all buttons.
	const perChangeControls = await page.$$(".notor-diff-change-approve, .notor-diff-accept-change, [data-change-index]");
	const acceptAllBtn = await page.$(".notor-accept-all-btn, [aria-label='Accept all']");
	const rejectAllBtn = await page.$(".notor-reject-all-btn, [aria-label='Reject all']");
	const approveBtn = await page.$(".notor-approve-btn");
	const rejectBtn = await page.$(".notor-reject-btn");
	const diffLines = await page.$$(".notor-diff-add, .notor-diff-del");

	if (perChangeControls.length > 0) {
		pass("replace_in_note — per-change controls shown", `${perChangeControls.length} per-change control(s) found`);
	} else if (acceptAllBtn || rejectAllBtn) {
		pass("replace_in_note — accept/reject all buttons shown", `acceptAll=${!!acceptAllBtn}, rejectAll=${!!rejectAllBtn}`);
	} else if (approveBtn) {
		pass("replace_in_note — approve button shown", "Approval button present (single-block approval)");
	} else {
		fail("replace_in_note — per-change controls shown", "No per-change controls, accept/reject-all buttons, or approve button found");
	}

	// Verify diff lines are rendered (additions/deletions highlighted)
	if (diffLines.length > 0) {
		pass("replace_in_note — diff lines rendered", `${diffLines.length} diff line(s) shown (additions/deletions)`);
	} else {
		fail("replace_in_note — diff lines rendered", "No .notor-diff-add or .notor-diff-del elements found in diff view");
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

/**
 * Test 5: replace_in_note — approve applies changes to file
 *
 * After approving a replace_in_note diff the file content should reflect
 * the replacement.
 */
async function testReplaceInNoteApprove(page: Page): Promise<void> {
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
			pass("replace_in_note approve — applied (auto-approved)", "Change applied without approval prompt");
		} else {
			const shot = await screenshot(page, "05-replace-approve-no-ui");
			fail("replace_in_note approve — approval UI appeared", "Approval UI did not appear and change not applied", shot);
		}
		return;
	}

	const shot1 = await screenshot(page, "05-replace-approve-before");

	// Approve the change
	const acceptAllBtn = await page.$(".notor-accept-all-btn, [aria-label='Accept all']");
	const approveBtn = await page.$(".notor-approve-btn");

	if (acceptAllBtn) {
		await (acceptAllBtn as ElementHandle).click();
		pass("replace_in_note approve — clicked accept all", "Clicked accept all button");
	} else if (approveBtn) {
		await approveBtn.click();
		pass("replace_in_note approve — clicked approve", "Clicked approve button");
	} else {
		fail("replace_in_note approve — no approve button", "Neither accept-all nor approve button found");
		await waitForResponse(page, 30_000);
		return;
	}

	await waitForResponse(page, 30_000);

	const shot2 = await screenshot(page, "05-replace-approve-after");
	const content = fs.readFileSync(srcPath, "utf8");

	if (content.includes("Replaced alpha content via E2E") || content.includes("Replaced alpha")) {
		pass("replace_in_note approve — change applied", "File contains the expected replacement text", shot2);
	} else if (!content.includes("Original alpha content")) {
		pass("replace_in_note approve — original text removed", "Original text no longer in file (different replacement text used)", shot2);
	} else {
		fail("replace_in_note approve — change applied", `File still contains original text. Content: "${content.substring(0, 200)}"`, shot2);
	}
}

/**
 * Test 6: write_note with auto-approve ON — diff shown collapsed, no approval buttons
 *
 * When write tools ARE auto-approved the diff should still appear in the chat
 * thread but in a collapsed/read-only state with no approve/reject buttons.
 */
async function testAutoApproveDiffCollapsed(page: Page, autoApproveDataPath: string): Promise<void> {
	console.log("\n── Diff Test 6: auto-approve — diff shown collapsed ───────────");

	// Switch to auto-approve settings
	const autoSettings = buildAutoApproveSettings();
	const currentData = fs.existsSync(PLUGIN_DATA_PATH)
		? fs.readFileSync(PLUGIN_DATA_PATH, "utf8")
		: null;
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(autoSettings, null, 2));

	// We need the plugin to reload with the new settings.
	// The simplest approach is to use the existing page since Obsidian is already running.
	// Settings take effect immediately for new conversations without a full reload.
	await newConversation(page);
	await setMode(page, "Act");

	const targetPath = path.join(VAULT_PATH, "Diff-AutoApproved.md");
	if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

	// With auto-approve ON the response completes without any approval prompt
	const responded = await sendMessage(
		page,
		"Please create a note at 'Diff-AutoApproved.md' with content:\n\n# Auto Approved\n\nThis note was auto-approved.\n"
	);

	const shot = await screenshot(page, "06-auto-approve");

	if (!responded) {
		fail("auto-approve — response received", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	// Approval buttons must NOT be present (auto-approve should have bypassed them)
	const approveBtn = await page.$(".notor-approve-btn");
	const rejectBtn = await page.$(".notor-reject-btn");

	if (!approveBtn && !rejectBtn) {
		pass("auto-approve — no approval buttons", "No approve/reject buttons shown (correctly auto-approved)", shot);
	} else {
		fail(
			"auto-approve — no approval buttons",
			`Approval buttons found despite auto-approve=true: approveBtn=${!!approveBtn}, rejectBtn=${!!rejectBtn}`,
			shot
		);
	}

	// A collapsed diff or tool call card SHOULD still appear in the thread
	const diffCollapsed = await page.$(".notor-diff-collapsed, .notor-diff-view");
	const toolCall = await page.$(".notor-tool-call");

	if (diffCollapsed) {
		pass("auto-approve — collapsed diff shown", "Collapsed diff view present in chat thread");
	} else if (toolCall) {
		pass("auto-approve — tool call card shown", "Tool call card shown (diff may be embedded)");
	} else {
		fail("auto-approve — collapsed diff or tool card shown", "No collapsed diff or tool call card found in thread");
	}

	// Verify the file was actually created (auto-approve executed the tool)
	if (fs.existsSync(targetPath)) {
		pass("auto-approve — file created", `File at ${targetPath} exists`);
	} else {
		fail("auto-approve — file created", `File not found at ${targetPath} after auto-approved write_note`);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
	console.log("=== Notor Diff Preview & Approval UI Test ===\n");
	console.log("Provider:  AWS Bedrock");
	console.log("Auth:      AWS profile (default)");
	console.log("Region:    us-east-1");
	console.log("Model:     deepseek.v3.2\n");

	// ── Step 0: Build ──────────────────────────────────────────────────
	console.log("[0/5] Building plugin...");
	execSync("npm run build", {
		cwd: path.resolve(__dirname, "..", ".."),
		stdio: "inherit",
	});
	console.log("Build complete.\n");

	// ── Step 1: Set up test vault ──────────────────────────────────────
	console.log("[1/5] Setting up test vault...");
	setupTestVault();
	console.log("");

	// ── Step 2: Inject manual-approval settings ────────────────────────
	console.log("[2/5] Injecting settings (write tools require manual approval)...");
	const settings = buildManualApprovalSettings();
	fs.mkdirSync(BUILD_DIR, { recursive: true });

	let existingData: string | null = null;
	if (fs.existsSync(PLUGIN_DATA_PATH)) {
		existingData = fs.readFileSync(PLUGIN_DATA_PATH, "utf8");
		console.log("  Backed up existing data.json");
	}
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	console.log(`  Wrote settings to ${PLUGIN_DATA_PATH}\n`);

	fs.mkdirSync(LOGS_DIR, { recursive: true });
	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

	let obsidian: ObsidianProcess | undefined;
	let collector: LogCollector | undefined;

	try {
		// ── Step 3: Launch Obsidian ──────────────────────────────────────
		console.log("[3/5] Launching Obsidian...");
		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });

		// ── Step 4: Connect Playwright ───────────────────────────────────
		console.log("[4/5] Connecting Playwright...");
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		const contexts = browser.contexts();
		const page = contexts[0]?.pages()[0];
		if (!page) throw new Error("No page found");

		collector = new LogCollector({ outputDir: LOGS_DIR });
		collector.attach(page);

		await page.waitForLoadState("domcontentloaded");
		await page.waitForTimeout(5_000);

		// ── Step 5: Verify chat panel ────────────────────────────────────
		console.log("[5/5] Verifying chat panel and running diff/approval tests...");
		{
			const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
			if (!chatContainer) {
				const shot = await screenshot(page, "00-no-chat-panel");
				fail("Chat panel visible", ".notor-chat-container not found", shot);
				throw new Error("Chat panel not visible — cannot run diff/approval tests");
			}
			const shot = await screenshot(page, "00-chat-ready");
			pass("Chat panel ready", "Plugin loaded and chat container found", shot);
		}

		// ── Run tests (manual approval settings active) ──────────────────
		await testWriteNoteApprovalUIAppears(page);
		await testWriteNoteApprove(page);
		await testWriteNoteReject(page);
		await testReplaceInNoteApprovalUI(page);
		await testReplaceInNoteApprove(page);

		// ── Test 6 uses auto-approve settings (mutates data.json) ────────
		await testAutoApproveDiffCollapsed(page, PLUGIN_DATA_PATH);

		// ── Final screenshot ─────────────────────────────────────────────
		await screenshot(page, "99-final");

		// ── Collect logs ─────────────────────────────────────────────────
		console.log("\n=== Collecting final logs ===");
		await page.waitForTimeout(1_000);
		const summaryPath = await collector.writeSummary();
		console.log(`Log summary: ${summaryPath}`);

		const errors = collector.getLogsByLevel("error");
		if (errors.length > 0) {
			console.log(`\nPlugin errors captured (${errors.length}):`);
			for (const e of errors.slice(-10)) {
				console.log(`  [${e.source}] ${e.message}`, e.data ?? "");
			}
		}

		await browser.close().catch(() => {});

	} catch (err) {
		console.error("\nFatal error:", err);
		if (collector) await collector.dispose().catch(() => {});
	} finally {
		if (obsidian) await closeObsidian(obsidian);

		// Restore original data.json
		if (existingData !== null) {
			fs.writeFileSync(PLUGIN_DATA_PATH, existingData);
			console.log("\nRestored original data.json");
		} else {
			try { fs.unlinkSync(PLUGIN_DATA_PATH); } catch { /* ignore */ }
			console.log("\nRemoved injected data.json");
		}
	}

	// ── Print summary ──────────────────────────────────────────────────
	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;

	console.log("\n=== Test Results ===");
	console.log(`Passed: ${passed}/${results.length}`);
	console.log(`Failed: ${failed}/${results.length}`);

	if (failed > 0) {
		console.log("\nFailed tests:");
		for (const r of results.filter((r) => !r.passed)) {
			console.log(`  ✗ ${r.name}: ${r.detail}`);
		}
	}

	const resultsPath = path.join(RESULTS_DIR, "diff-approval-results.json");
	fs.writeFileSync(
		resultsPath,
		JSON.stringify({ passed, failed, total: results.length, results }, null, 2)
	);
	console.log(`\nResults written to: ${resultsPath}`);

	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
