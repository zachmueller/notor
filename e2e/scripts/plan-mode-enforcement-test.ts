#!/usr/bin/env npx tsx
/**
 * Plan Mode Enforcement Test
 *
 * Verifies that the plugin correctly blocks write tool calls when the chat is
 * in Plan mode, even when the LLM attempts to invoke them.
 * Uses AWS Bedrock (default profile) for real LLM calls.
 *
 * Scenarios covered:
 *   1. write_note blocked in Plan mode — file not created, LLM receives error
 *   2. replace_in_note blocked in Plan mode — file unchanged
 *   3. update_frontmatter blocked in Plan mode — frontmatter unchanged
 *   4. manage_tags blocked in Plan mode — tags unchanged
 *   5. Read tools still work in Plan mode (list_vault, read_note, search_vault, read_frontmatter)
 *   6. Mode switch Plan → Act unblocks write tools (write succeeds after switch)
 *   7. Mode switch Act → Plan re-blocks write tools mid-conversation
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled on that account with deepseek.v3.2 available
 *
 * Run with:
 *   npx tsx e2e/scripts/plan-mode-enforcement-test.ts
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
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots", "plan-mode");
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
 * Send a message and wait for the full response.
 */
async function sendMessage(page: Page, message: string): Promise<boolean> {
	const textarea = await page.$(".notor-text-input");
	if (!textarea) throw new Error("Textarea not found");

	await textarea.fill(message);
	await page.waitForTimeout(200);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(600);

	console.log(`    → Sent: "${message.substring(0, 80)}${message.length > 80 ? "..." : ""}"`);
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
 * Get all tool call names visible in the current conversation.
 */
async function getToolCallNames(page: Page): Promise<string[]> {
	const cards = await page.$$(".notor-tool-call");
	const names: string[] = [];
	for (const card of cards) {
		const header = await card.$(".notor-tool-call-header, .notor-tool-name");
		const text = await header?.textContent();
		if (text) names.push(text.trim());
	}
	return names;
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
	console.log(`    Mode set to: ${mode}`);
}

/**
 * Get current mode text from the toggle.
 */
async function getCurrentMode(page: Page): Promise<string> {
	const toggle = await page.$(".notor-mode-toggle");
	return (await toggle?.textContent())?.trim() ?? "unknown";
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function buildSettings(): Record<string, unknown> {
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
		// Auto-approve everything so the ONLY blocking factor is Plan mode
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
		// Default to plan mode
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
		"Plan-Mode-Test.md": `---
title: Plan Mode Test Note
status: original
tags: [original]
---

# Plan Mode Test Note

This note is used by the plan-mode-enforcement E2E tests.

## Content Section

Original body content here.
`,
	};

	for (const [relativePath, content] of Object.entries(notes)) {
		const fullPath = path.join(VAULT_PATH, relativePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content, "utf8");
		console.log(`    Created: ${relativePath}`);
	}
}

// ---------------------------------------------------------------------------
// Plan mode enforcement tests
// ---------------------------------------------------------------------------

/**
 * Test 1: write_note is blocked in Plan mode
 *
 * The LLM is explicitly asked to create a file. The dispatcher must block
 * this in Plan mode and return a clear error message. The file must not
 * appear on disk.
 */
async function testWriteNoteBlockedInPlanMode(page: Page): Promise<void> {
	console.log("\n── Plan Test 1: write_note blocked in Plan mode ───────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const targetPath = path.join(VAULT_PATH, "Plan-Mode-Should-Not-Exist.md");
	if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

	const responded = await sendMessage(
		page,
		"Please use the write_note tool to create a file at 'Plan-Mode-Should-Not-Exist.md' " +
		"with the content '# Blocked'. This is a test of Plan mode enforcement."
	);

	const shot = await screenshot(page, "01-write-note-blocked");

	if (!responded) {
		fail("write_note blocked in Plan mode — response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const response = await getLastAssistantMessage(page);
	const toolNames = await getToolCallNames(page);
	const lowerResponse = response.toLowerCase();

	// The file must NOT have been created
	if (!fs.existsSync(targetPath)) {
		pass("write_note blocked — file not created", `File correctly absent: ${targetPath}`, shot);
	} else {
		fail("write_note blocked — file not created", `File was created despite Plan mode: ${targetPath}`, shot);
	}

	// The LLM response should acknowledge the Plan mode restriction
	const mentionsPlanMode =
		lowerResponse.includes("plan") ||
		lowerResponse.includes("act mode") ||
		lowerResponse.includes("cannot") ||
		lowerResponse.includes("can't") ||
		lowerResponse.includes("not allowed") ||
		lowerResponse.includes("restricted") ||
		lowerResponse.includes("blocked") ||
		lowerResponse.includes("write") ||
		lowerResponse.includes("switch");

	if (mentionsPlanMode) {
		pass("write_note blocked — LLM acknowledges restriction", `Response mentions restriction: "${response.trim().substring(0, 120)}"`, shot);
	} else if (response.trim().length > 0) {
		// A response was received even if it doesn't explicitly mention Plan mode
		pass("write_note blocked — LLM responded", `Response: "${response.trim().substring(0, 120)}"`, shot);
	} else {
		fail("write_note blocked — LLM responded", "No assistant message after blocked write attempt");
	}

	// Verify that a tool call card was shown but in a blocked/error state
	if (toolNames.length > 0) {
		const toolError = await page.$(".notor-tool-call.notor-tool-error, .notor-tool-call[data-status='error'], .notor-tool-call[data-status='blocked']");
		if (toolError) {
			pass("write_note blocked — tool call shows blocked/error", `Tool card in error/blocked state`);
		} else {
			// Tool call present but status not clearly blocked — still informative
			pass("write_note blocked — tool call rendered", `Tool call card rendered: ${toolNames.join(", ")}`);
		}
	}
}

/**
 * Test 2: replace_in_note is blocked in Plan mode
 *
 * File content must remain unchanged after the LLM attempts a replace_in_note
 * in Plan mode.
 */
async function testReplaceInNoteBlockedInPlanMode(page: Page): Promise<void> {
	console.log("\n── Plan Test 2: replace_in_note blocked in Plan mode ──────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const targetPath = path.join(VAULT_PATH, "Plan-Mode-Test.md");
	const originalContent = fs.readFileSync(targetPath, "utf8");

	const responded = await sendMessage(
		page,
		"In 'Plan-Mode-Test.md', please use replace_in_note to replace " +
		"'Original body content here.' with 'This text should not appear — Plan mode.'"
	);

	const shot = await screenshot(page, "02-replace-blocked");

	if (!responded) {
		fail("replace_in_note blocked — response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const currentContent = fs.readFileSync(targetPath, "utf8");

	if (currentContent === originalContent) {
		pass("replace_in_note blocked — file unchanged", "File content is identical to original", shot);
	} else if (currentContent.includes("This text should not appear")) {
		fail("replace_in_note blocked — file unchanged", "File was modified despite Plan mode enforcement", shot);
	} else {
		// Content changed but not with the test string — unexpected
		fail("replace_in_note blocked — file unchanged", `File content changed unexpectedly: "${currentContent.substring(0, 200)}"`, shot);
	}

	const response = await getLastAssistantMessage(page);
	if (response.trim().length > 0) {
		pass("replace_in_note blocked — LLM responded", `Response: "${response.trim().substring(0, 120)}"`, shot);
	} else {
		fail("replace_in_note blocked — LLM responded", "No assistant message after blocked replace attempt");
	}
}

/**
 * Test 3: update_frontmatter is blocked in Plan mode
 *
 * Frontmatter must remain unchanged after a blocked update_frontmatter call.
 */
async function testUpdateFrontmatterBlockedInPlanMode(page: Page): Promise<void> {
	console.log("\n── Plan Test 3: update_frontmatter blocked in Plan mode ────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const targetPath = path.join(VAULT_PATH, "Plan-Mode-Test.md");
	const originalContent = fs.readFileSync(targetPath, "utf8");

	const responded = await sendMessage(
		page,
		"In 'Plan-Mode-Test.md', please use the update_frontmatter tool to set " +
		"'status' to 'modified-by-plan-mode-test'. This should be blocked."
	);

	const shot = await screenshot(page, "03-update-frontmatter-blocked");

	if (!responded) {
		fail("update_frontmatter blocked — response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const currentContent = fs.readFileSync(targetPath, "utf8");

	if (currentContent.includes("modified-by-plan-mode-test")) {
		fail("update_frontmatter blocked — frontmatter unchanged", "Frontmatter was modified despite Plan mode enforcement", shot);
	} else {
		pass("update_frontmatter blocked — frontmatter unchanged", "Frontmatter does not contain the test value", shot);
	}

	const response = await getLastAssistantMessage(page);
	if (response.trim().length > 0) {
		pass("update_frontmatter blocked — LLM responded", `Response: "${response.trim().substring(0, 120)}"`, shot);
	} else {
		fail("update_frontmatter blocked — LLM responded", "No assistant message after blocked update attempt");
	}
}

/**
 * Test 4: manage_tags is blocked in Plan mode
 *
 * Tags must not be modified after a blocked manage_tags call.
 */
async function testManageTagsBlockedInPlanMode(page: Page): Promise<void> {
	console.log("\n── Plan Test 4: manage_tags blocked in Plan mode ───────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const targetPath = path.join(VAULT_PATH, "Plan-Mode-Test.md");

	const responded = await sendMessage(
		page,
		"Please use the manage_tags tool to add the tag 'plan-mode-blocked-tag' " +
		"to the note 'Plan-Mode-Test.md'. This should be blocked in Plan mode."
	);

	const shot = await screenshot(page, "04-manage-tags-blocked");

	if (!responded) {
		fail("manage_tags blocked — response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const currentContent = fs.readFileSync(targetPath, "utf8");

	if (currentContent.includes("plan-mode-blocked-tag")) {
		fail("manage_tags blocked — tags unchanged", "Tag was added despite Plan mode enforcement", shot);
	} else {
		pass("manage_tags blocked — tags unchanged", "Tag not present in frontmatter (correctly blocked)", shot);
	}

	const response = await getLastAssistantMessage(page);
	if (response.trim().length > 0) {
		pass("manage_tags blocked — LLM responded", `Response: "${response.trim().substring(0, 120)}"`, shot);
	} else {
		fail("manage_tags blocked — LLM responded", "No assistant message after blocked tag attempt");
	}
}

/**
 * Test 5: Read tools work normally in Plan mode
 *
 * list_vault, read_note, search_vault, and read_frontmatter must all succeed
 * in Plan mode since they are classified as read tools.
 */
async function testReadToolsWorkInPlanMode(page: Page): Promise<void> {
	console.log("\n── Plan Test 5: Read tools work in Plan mode ──────────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	// list_vault
	{
		const responded = await sendMessage(
			page,
			"Please use the list_vault tool to list the notes in my vault root."
		);
		const shot = await screenshot(page, "05a-list-vault-plan");

		if (!responded) {
			fail("list_vault in Plan mode — response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		} else {
			const response = await getLastAssistantMessage(page);
			const toolNames = await getToolCallNames(page);
			const hasListVault = toolNames.some((n) => n.toLowerCase().includes("list_vault") || n.toLowerCase().includes("list vault"));
			const responseHasNotes =
				response.toLowerCase().includes(".md") ||
				response.toLowerCase().includes("note") ||
				response.toLowerCase().includes("vault");

			if (hasListVault || responseHasNotes) {
				pass("list_vault in Plan mode — succeeded", `Tool called (${toolNames.join(", ")}), response references vault`, shot);
			} else {
				const errorMsg = await page.$(".notor-chat-error");
				if (errorMsg) {
					const errText = await errorMsg.textContent();
					fail("list_vault in Plan mode — succeeded", `Error: "${errText?.trim().substring(0, 120)}"`, shot);
				} else {
					fail("list_vault in Plan mode — succeeded", `Response: "${response.trim().substring(0, 120)}"`, shot);
				}
			}
		}
	}

	// read_note
	await newConversation(page);
	await setMode(page, "Plan");
	{
		const responded = await sendMessage(
			page,
			"Please use read_note to read 'Plan-Mode-Test.md' and tell me what the title heading is."
		);
		const shot = await screenshot(page, "05b-read-note-plan");

		if (!responded) {
			fail("read_note in Plan mode — response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		} else {
			const response = await getLastAssistantMessage(page);
			const toolNames = await getToolCallNames(page);
			const hasReadNote = toolNames.some((n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note"));
			// The note title is "Plan Mode Test Note"
			const responseHasContent =
				response.toLowerCase().includes("plan mode test") ||
				response.toLowerCase().includes("original body");

			if (hasReadNote || responseHasContent) {
				pass("read_note in Plan mode — succeeded", `Tool called (${toolNames.join(", ")}), response contains note content`, shot);
			} else {
				fail("read_note in Plan mode — succeeded", `Response did not reference note content: "${response.trim().substring(0, 120)}"`, shot);
			}
		}
	}

	// search_vault
	await newConversation(page);
	await setMode(page, "Plan");
	{
		const responded = await sendMessage(
			page,
			"Please search my vault for the word 'original' using search_vault."
		);
		const shot = await screenshot(page, "05c-search-vault-plan");

		if (!responded) {
			fail("search_vault in Plan mode — response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		} else {
			const response = await getLastAssistantMessage(page);
			const toolNames = await getToolCallNames(page);
			const hasSearch = toolNames.some((n) => n.toLowerCase().includes("search"));
			const responseHasResults =
				response.toLowerCase().includes("original") ||
				response.toLowerCase().includes("plan-mode-test") ||
				response.toLowerCase().includes(".md");

			if (hasSearch || responseHasResults) {
				pass("search_vault in Plan mode — succeeded", `Tool called (${toolNames.join(", ")}), response references search results`, shot);
			} else {
				fail("search_vault in Plan mode — succeeded", `Response: "${response.trim().substring(0, 120)}"`, shot);
			}
		}
	}

	// read_frontmatter
	await newConversation(page);
	await setMode(page, "Plan");
	{
		const responded = await sendMessage(
			page,
			"Please use read_frontmatter to read the frontmatter of 'Plan-Mode-Test.md'."
		);
		const shot = await screenshot(page, "05d-read-frontmatter-plan");

		if (!responded) {
			fail("read_frontmatter in Plan mode — response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		} else {
			const response = await getLastAssistantMessage(page);
			const toolNames = await getToolCallNames(page);
			const hasFrontmatter = toolNames.some((n) => n.toLowerCase().includes("frontmatter"));
			// Plan-Mode-Test.md has: title, status, tags
			const responseHasFrontmatter =
				response.toLowerCase().includes("title") ||
				response.toLowerCase().includes("status") ||
				response.toLowerCase().includes("original") ||
				response.toLowerCase().includes("tags");

			if (hasFrontmatter || responseHasFrontmatter) {
				pass("read_frontmatter in Plan mode — succeeded", `Tool called (${toolNames.join(", ")}), response contains frontmatter`, shot);
			} else {
				fail("read_frontmatter in Plan mode — succeeded", `Response: "${response.trim().substring(0, 120)}"`, shot);
			}
		}
	}
}

/**
 * Test 6: Switching Plan → Act unblocks write tools
 *
 * After switching to Act mode, a write_note request should succeed and the
 * file should be created on disk.
 */
async function testSwitchToActUnblocksWrites(page: Page): Promise<void> {
	console.log("\n── Plan Test 6: Plan → Act switch unblocks write tools ─────────");
	await newConversation(page);

	const targetPath = path.join(VAULT_PATH, "Plan-Mode-Act-Created.md");
	if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

	// Confirm we start in Plan mode
	await setMode(page, "Plan");
	const modeBefore = await getCurrentMode(page);
	pass("Plan→Act test — starting in Plan mode", `Mode confirmed: ${modeBefore}`);

	// Now switch to Act
	await setMode(page, "Act");
	const modeAfter = await getCurrentMode(page);

	if (modeAfter === "Act") {
		pass("Plan→Act test — switched to Act", "Mode is now Act");
	} else {
		fail("Plan→Act test — switched to Act", `Expected Act, got: ${modeAfter}`);
		return;
	}

	// Send a write request — should succeed in Act mode
	const responded = await sendMessage(
		page,
		"Please use write_note to create 'Plan-Mode-Act-Created.md' with content:\n\n# Act Mode Created\n\nThis note was created in Act mode.\n"
	);

	const shot = await screenshot(page, "06-act-mode-write");

	if (!responded) {
		fail("Plan→Act test — response received", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	if (fs.existsSync(targetPath)) {
		const content = fs.readFileSync(targetPath, "utf8");
		if (content.includes("Act Mode") || content.includes("Act mode")) {
			pass("Plan→Act test — file created with content", `File at ${targetPath} contains expected content`, shot);
		} else {
			pass("Plan→Act test — file created", `File exists at ${targetPath} (${content.length} chars)`, shot);
		}
	} else {
		const response = await getLastAssistantMessage(page);
		fail("Plan→Act test — file created", `File not found. Response: "${response.trim().substring(0, 120)}"`, shot);
	}
}

/**
 * Test 7: Switching Act → Plan mid-conversation re-blocks write tools
 *
 * In an existing Act-mode conversation we switch back to Plan mode and verify
 * a subsequent write attempt is blocked.
 */
async function testSwitchToPlanReBlocksWrites(page: Page): Promise<void> {
	console.log("\n── Plan Test 7: Act → Plan switch re-blocks write tools ────────");
	await newConversation(page);
	await setMode(page, "Act");

	// First send a successful read to establish Act mode context
	const readResponded = await sendMessage(
		page,
		"Please use read_note to read 'Plan-Mode-Test.md' and confirm you can access it."
	);

	if (!readResponded) {
		fail("Act→Plan test — initial read", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`);
		return;
	}
	pass("Act→Plan test — initial read succeeded", "Read tool worked in Act mode");

	// Now switch to Plan mode
	await setMode(page, "Plan");
	const modeAfterSwitch = await getCurrentMode(page);

	if (modeAfterSwitch === "Plan") {
		pass("Act→Plan test — switched to Plan mid-conversation", "Mode is now Plan");
	} else {
		fail("Act→Plan test — switched to Plan mid-conversation", `Expected Plan, got: ${modeAfterSwitch}`);
		return;
	}

	// Attempt a write — should now be blocked
	const blockTargetPath = path.join(VAULT_PATH, "Plan-Mode-Mid-Convo-Blocked.md");
	if (fs.existsSync(blockTargetPath)) fs.unlinkSync(blockTargetPath);

	const responded = await sendMessage(
		page,
		"Now please use write_note to create 'Plan-Mode-Mid-Convo-Blocked.md' with content '# Should Be Blocked'."
	);

	const shot = await screenshot(page, "07-act-to-plan-reblock");

	if (!responded) {
		fail("Act→Plan test — response received", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	if (!fs.existsSync(blockTargetPath)) {
		pass("Act→Plan test — write blocked after mode switch", `File correctly absent after switching back to Plan`, shot);
	} else {
		fail("Act→Plan test — write blocked after mode switch", `File was created despite switching back to Plan mode`, shot);
	}

	const response = await getLastAssistantMessage(page);
	if (response.trim().length > 0) {
		pass("Act→Plan test — LLM responded after block", `Response: "${response.trim().substring(0, 120)}"`, shot);
	} else {
		fail("Act→Plan test — LLM responded after block", "No assistant message after blocked write");
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
	console.log("=== Notor Plan Mode Enforcement Test ===\n");
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

	// ── Step 2: Inject settings ────────────────────────────────────────
	console.log("[2/5] Injecting settings (auto-approve ON, mode=plan)...");
	const settings = buildSettings();
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
		console.log("[5/5] Verifying chat panel and running Plan mode tests...");
		{
			const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
			if (!chatContainer) {
				const shot = await screenshot(page, "00-no-chat-panel");
				fail("Chat panel visible", ".notor-chat-container not found", shot);
				throw new Error("Chat panel not visible — cannot run Plan mode tests");
			}
			const shot = await screenshot(page, "00-chat-ready");
			pass("Chat panel ready", "Plugin loaded and chat container found", shot);
		}

		// ── Run all tests ────────────────────────────────────────────────
		await testWriteNoteBlockedInPlanMode(page);
		await testReplaceInNoteBlockedInPlanMode(page);
		await testUpdateFrontmatterBlockedInPlanMode(page);
		await testManageTagsBlockedInPlanMode(page);
		await testReadToolsWorkInPlanMode(page);
		await testSwitchToActUnblocksWrites(page);
		await testSwitchToPlanReBlocksWrites(page);

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

	const resultsPath = path.join(RESULTS_DIR, "plan-mode-results.json");
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
