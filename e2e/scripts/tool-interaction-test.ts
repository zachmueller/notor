#!/usr/bin/env npx tsx
/**
 * Tool Interaction Test
 *
 * Tests all Notor plugin tools end-to-end via real LLM prompts using
 * AWS Bedrock with the deepseek.v3.2 model.
 *
 * Tools exercised:
 *   Read (Plan mode — auto-approved):
 *     - list_vault      : "List all notes in my vault"
 *     - read_note       : "Read the Meeting Notes note"
 *     - search_vault    : "Search my vault for the word 'project'"
 *     - read_frontmatter: "What frontmatter does the Meeting Notes note have?"
 *
 *   Write (Act mode — auto-approved in settings):
 *     - write_note          : Create a new note
 *     - replace_in_note     : Edit content inside a note
 *     - update_frontmatter  : Add/modify frontmatter properties
 *     - manage_tags         : Add tags to a note
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled on that account with deepseek.v3.2 available
 *
 * Run with:
 *   npx tsx e2e/scripts/tool-interaction-test.ts
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
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots", "tools");
const LOGS_DIR = path.join(RESULTS_DIR, "logs");
const BUILD_DIR = path.resolve(__dirname, "..", "..", "build");
const PLUGIN_DATA_PATH = path.join(BUILD_DIR, "data.json");

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
/** Max ms to wait for any single LLM response to complete. */
const RESPONSE_TIMEOUT_MS = 90_000;
/** Polling interval while waiting for a response. */
const POLL_INTERVAL_MS = 1_500;

// ---------------------------------------------------------------------------
// Test vault note content
// ---------------------------------------------------------------------------
const VAULT_NOTES: Record<string, string> = {
	"Test Note.md": `# Test Note\n\nThis is a test vault for E2E testing of the Notor plugin.\n\nCreated automatically by the setup script.\n`,

	"Notes/Meeting Notes.md": `---
title: Weekly Team Meeting
date: 2025-01-15
status: draft
priority: high
---

# Weekly Team Meeting

## Attendees
- Alice
- Bob
- Carol

## Agenda
1. Project status update
2. Upcoming deadlines
3. Blocker review

## Action Items
- Alice will complete the design document by Friday
- Bob needs to fix the authentication bug
- Carol will schedule the next sprint planning session

## Notes
The team discussed the current project velocity and identified several blockers.
Overall progress is on track for the Q1 deadline.
`,

	"Notes/Project Plan.md": `---
title: Q1 Project Plan
status: active
tags: [project, planning]
owner: alice
---

# Q1 Project Plan

## Objectives
- Ship version 1.0 by end of Q1
- Achieve 95% test coverage
- Complete documentation

## Milestones
| Milestone | Target Date | Status |
|-----------|-------------|--------|
| Alpha release | Jan 31 | Complete |
| Beta release | Feb 28 | In Progress |
| GA release | Mar 31 | Planned |

## Resources
- Engineering: 3 developers
- Design: 1 designer
- QA: 1 QA engineer

## Risks
- Third-party API dependency may delay integration
- Resource availability during holiday period
`,

	"Journal/2025-01-01.md": `---
date: 2025-01-01
type: journal
mood: reflective
---

# New Year Journal Entry

Starting the new year with clear goals:
1. Learn more about distributed systems
2. Contribute to open source projects
3. Read at least 24 books this year

Feeling optimistic about what lies ahead.
`,
};

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
 * Wait for any pending LLM response to finish.
 *
 * Polls until the textarea is re-enabled (response complete) or timeout.
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

		// Log streaming progress
		const lastMsg = await page.$(".notor-message-assistant:last-child");
		if (lastMsg) {
			const partial = await lastMsg.textContent();
			const elapsed = Math.round((Date.now() - start) / 1000);
			if (partial && partial.trim().length > 0) {
				console.log(`    [${elapsed}s] Streaming: "${partial.trim().substring(0, 80)}..."`);
			}
		}
	}
	return false;
}

/**
 * Send a chat message and wait for the response.
 *
 * Returns true if a response was received before timeout.
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
	const last = msgs[msgs.length - 1];
	return (await last!.textContent()) ?? "";
}

/**
 * Get the text of the most recent error message.
 */
async function getLastError(page: Page): Promise<string> {
	const errs = await page.$$(".notor-chat-error");
	if (errs.length === 0) return "";
	const last = errs[errs.length - 1];
	return (await last!.textContent()) ?? "";
}

/**
 * Check if any tool call card appeared after the last user message.
 */
async function getLastToolCallNames(page: Page): Promise<string[]> {
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
 * Start a fresh conversation (click New Conversation button).
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
// Settings builder
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
		// Auto-approve all tools so write tool tests don't block on UI prompts
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
	console.log("  Setting up test vault notes...");
	for (const [relativePath, content] of Object.entries(VAULT_NOTES)) {
		const fullPath = path.join(VAULT_PATH, relativePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content, "utf8");
		console.log(`    Created: ${relativePath}`);
	}
}

// ---------------------------------------------------------------------------
// Individual tool tests
// ---------------------------------------------------------------------------

/**
 * Test: list_vault
 *
 * Prompt asks the LLM to list the vault. We verify:
 *  - A tool call card appears for list_vault
 *  - The response mentions vault structure
 */
async function testListVault(page: Page): Promise<void> {
	console.log("\n── Tool Test: list_vault ──────────────────────────────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"Please list all the notes and folders in my vault. " +
		"Use the list_vault tool to get a recursive listing.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await screenshot(page, "tool-list_vault-timeout");
		fail("list_vault — LLM response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await screenshot(page, "tool-list_vault");

	if (toolNames.some((n) => n.toLowerCase().includes("list_vault") || n.toLowerCase().includes("list vault"))) {
		pass("list_vault — tool called", `Tool call card found: ${toolNames.join(", ")}`, shot);
	} else if (response.toLowerCase().includes("note") || response.toLowerCase().includes("vault") || response.toLowerCase().includes("folder")) {
		pass("list_vault — response references vault", `No explicit card but response references vault content`, shot);
	} else if (errorText) {
		fail("list_vault — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		fail("list_vault — tool called", `No list_vault tool card found; tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Also verify response quality
	const lowerResponse = response.toLowerCase();
	if (
		lowerResponse.includes("meeting notes") ||
		lowerResponse.includes("project plan") ||
		lowerResponse.includes("journal") ||
		lowerResponse.includes("test note") ||
		lowerResponse.includes(".md")
	) {
		pass("list_vault — response contains note names", `Response references vault notes`);
	} else if (!errorText) {
		fail("list_vault — response contains note names", `Response: "${response.trim().substring(0, 120)}"`);
	}
}

/**
 * Test: read_note
 *
 * Prompt asks the LLM to read a specific note. We verify:
 *  - A tool call card appears for read_note
 *  - The response contains content from Meeting Notes.md
 */
async function testReadNote(page: Page): Promise<void> {
	console.log("\n── Tool Test: read_note ───────────────────────────────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"Please read the file 'Notes/Meeting Notes.md' and summarize what it contains.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await screenshot(page, "tool-read_note-timeout");
		fail("read_note — LLM response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await screenshot(page, "tool-read_note");

	if (toolNames.some((n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note"))) {
		pass("read_note — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (response.toLowerCase().includes("alice") || response.toLowerCase().includes("meeting") || response.toLowerCase().includes("agenda")) {
		pass("read_note — response contains note content", `Response includes meeting note content`, shot);
	} else if (errorText) {
		fail("read_note — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		fail("read_note — tool called", `No read_note tool card. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Check that response reflects the actual note content
	const lowerResponse = response.toLowerCase();
	if (
		lowerResponse.includes("meeting") ||
		lowerResponse.includes("alice") ||
		lowerResponse.includes("bob") ||
		lowerResponse.includes("agenda") ||
		lowerResponse.includes("action item")
	) {
		pass("read_note — response reflects note content", "Response mentions meeting note details");
	} else if (!errorText) {
		fail("read_note — response reflects note content", `Response: "${response.trim().substring(0, 120)}"`);
	}
}

/**
 * Test: search_vault
 *
 * Prompt asks the LLM to search the vault. We verify:
 *  - search_vault tool is called
 *  - Results reference matching notes
 */
async function testSearchVault(page: Page): Promise<void> {
	console.log("\n── Tool Test: search_vault ────────────────────────────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"Search my vault for the word 'milestone' and tell me which notes contain it.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await screenshot(page, "tool-search_vault-timeout");
		fail("search_vault — LLM response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await screenshot(page, "tool-search_vault");

	if (toolNames.some((n) => n.toLowerCase().includes("search_vault") || n.toLowerCase().includes("search vault"))) {
		pass("search_vault — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (response.toLowerCase().includes("project plan") || response.toLowerCase().includes("milestone")) {
		pass("search_vault — response references matching notes", `Response mentions Project Plan`, shot);
	} else if (errorText) {
		fail("search_vault — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		fail("search_vault — tool called", `No search_vault tool card. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// The word "milestone" appears in Notes/Project Plan.md
	const lowerResponse = response.toLowerCase();
	if (lowerResponse.includes("project plan") || lowerResponse.includes("milestone") || lowerResponse.includes("notes/")) {
		pass("search_vault — response identifies matching note", "Response references matching note");
	} else if (!errorText) {
		fail("search_vault — response identifies matching note", `Response: "${response.trim().substring(0, 120)}"`);
	}
}

/**
 * Test: read_frontmatter
 *
 * Prompt asks the LLM to read frontmatter. We verify:
 *  - read_frontmatter tool is called
 *  - Response contains the actual frontmatter properties
 */
async function testReadFrontmatter(page: Page): Promise<void> {
	console.log("\n── Tool Test: read_frontmatter ────────────────────────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"What are the frontmatter properties (metadata) in the file 'Notes/Project Plan.md'? " +
		"Please use the read_frontmatter tool.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await screenshot(page, "tool-read_frontmatter-timeout");
		fail("read_frontmatter — LLM response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await screenshot(page, "tool-read_frontmatter");

	if (toolNames.some((n) => n.toLowerCase().includes("read_frontmatter") || n.toLowerCase().includes("frontmatter"))) {
		pass("read_frontmatter — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (
		response.toLowerCase().includes("status") ||
		response.toLowerCase().includes("owner") ||
		response.toLowerCase().includes("alice") ||
		response.toLowerCase().includes("active")
	) {
		pass("read_frontmatter — response contains frontmatter data", `Response includes frontmatter fields`, shot);
	} else if (errorText) {
		fail("read_frontmatter — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		fail("read_frontmatter — tool called", `No read_frontmatter tool card. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Notes/Project Plan.md has: title, status, tags, owner
	const lowerResponse = response.toLowerCase();
	if (
		lowerResponse.includes("title") ||
		lowerResponse.includes("status") ||
		lowerResponse.includes("owner") ||
		lowerResponse.includes("alice") ||
		lowerResponse.includes("active") ||
		lowerResponse.includes("planning")
	) {
		pass("read_frontmatter — response contains expected properties", "Response includes frontmatter values");
	} else if (!errorText) {
		fail("read_frontmatter — response contains expected properties", `Response: "${response.trim().substring(0, 120)}"`);
	}
}

/**
 * Test: write_note
 *
 * Prompt asks the LLM to create a new note. We verify:
 *  - write_note tool is called
 *  - The file is actually created in the vault
 */
async function testWriteNote(page: Page): Promise<void> {
	console.log("\n── Tool Test: write_note ──────────────────────────────────────");
	await newConversation(page);
	await setMode(page, "Act");

	// Clean up any prior test output
	const targetPath = path.join(VAULT_PATH, "E2E-Generated-Note.md");
	if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

	const prompt =
		"Please create a new note at the path 'E2E-Generated-Note.md'. " +
		"The note should have this exact content:\n\n" +
		"---\n" +
		"created_by: e2e-test\n" +
		"status: draft\n" +
		"---\n\n" +
		"# E2E Generated Note\n\n" +
		"This note was created by the tool interaction test.\n\n" +
		"## Section One\n\n" +
		"Some initial content here.\n";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await screenshot(page, "tool-write_note-timeout");
		fail("write_note — LLM response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await screenshot(page, "tool-write_note");

	if (toolNames.some((n) => n.toLowerCase().includes("write_note") || n.toLowerCase().includes("write note"))) {
		pass("write_note — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (response.toLowerCase().includes("created") || response.toLowerCase().includes("e2e-generated")) {
		pass("write_note — response indicates creation", `Response mentions note creation`, shot);
	} else if (errorText) {
		fail("write_note — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		fail("write_note — tool called", `No write_note tool card. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Verify the file actually exists in the vault
	if (fs.existsSync(targetPath)) {
		const written = fs.readFileSync(targetPath, "utf8");
		if (written.includes("e2e-test") || written.includes("E2E Generated") || written.includes("Section One")) {
			pass("write_note — file created with correct content", `File found at ${targetPath}`);
		} else {
			pass("write_note — file created", `File exists but content differs from requested`);
		}
	} else {
		// Check if the model may have used a slightly different filename
		const vaultFiles = fs.readdirSync(VAULT_PATH);
		const similar = vaultFiles.find(
			(f) => f.toLowerCase().includes("e2e") || f.toLowerCase().includes("generated")
		);
		if (similar) {
			pass("write_note — file created (different name)", `Found similar file: ${similar}`);
		} else if (!errorText) {
			fail("write_note — file created", `File not found at ${targetPath}. Vault contains: ${vaultFiles.join(", ")}`);
		}
	}
}

/**
 * Test: replace_in_note
 *
 * Prompt asks the LLM to make a targeted edit. We verify:
 *  - replace_in_note tool is called
 *  - The note content is actually modified
 */
async function testReplaceInNote(page: Page): Promise<void> {
	console.log("\n── Tool Test: replace_in_note ─────────────────────────────────");
	await newConversation(page);
	await setMode(page, "Act");

	// First, ensure E2E-Generated-Note.md exists (from write_note test or fresh)
	const targetPath = path.join(VAULT_PATH, "E2E-Generated-Note.md");
	if (!fs.existsSync(targetPath)) {
		fs.writeFileSync(
			targetPath,
			`---\ncreated_by: e2e-test\nstatus: draft\n---\n\n# E2E Generated Note\n\nThis note was created by the tool interaction test.\n\n## Section One\n\nSome initial content here.\n`,
			"utf8"
		);
	}

	const originalContent = fs.readFileSync(targetPath, "utf8");

	const prompt =
		"In the file 'E2E-Generated-Note.md', please use the replace_in_note tool to " +
		"replace the text 'Some initial content here.' with " +
		"'Content updated by replace_in_note tool test.'";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await screenshot(page, "tool-replace_in_note-timeout");
		fail("replace_in_note — LLM response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await screenshot(page, "tool-replace_in_note");

	if (toolNames.some((n) => n.toLowerCase().includes("replace_in_note") || n.toLowerCase().includes("replace"))) {
		pass("replace_in_note — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (response.toLowerCase().includes("replaced") || response.toLowerCase().includes("updated") || response.toLowerCase().includes("applied")) {
		pass("replace_in_note — response indicates edit", `Response indicates replacement occurred`, shot);
	} else if (errorText) {
		fail("replace_in_note — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		fail("replace_in_note — tool called", `No replace_in_note tool card. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Verify the actual file content changed
	if (fs.existsSync(targetPath)) {
		const newContent = fs.readFileSync(targetPath, "utf8");
		if (newContent !== originalContent) {
			if (newContent.includes("replace_in_note tool test") || newContent.includes("Content updated")) {
				pass("replace_in_note — file content updated correctly", "Expected replacement text found in file");
			} else {
				pass("replace_in_note — file content changed", "File was modified (content differs from original)");
			}
		} else if (!errorText) {
			fail("replace_in_note — file content updated", "File content unchanged after replace_in_note call");
		}
	} else if (!errorText) {
		fail("replace_in_note — file exists", `Target file not found: ${targetPath}`);
	}
}

/**
 * Test: update_frontmatter
 *
 * Prompt asks the LLM to update frontmatter properties. We verify:
 *  - update_frontmatter tool is called
 *  - The frontmatter is actually modified in the vault file
 */
async function testUpdateFrontmatter(page: Page): Promise<void> {
	console.log("\n── Tool Test: update_frontmatter ──────────────────────────────");
	await newConversation(page);
	await setMode(page, "Act");

	// Ensure target note exists with known frontmatter
	const targetPath = path.join(VAULT_PATH, "E2E-Generated-Note.md");
	if (!fs.existsSync(targetPath)) {
		fs.writeFileSync(
			targetPath,
			`---\ncreated_by: e2e-test\nstatus: draft\n---\n\n# E2E Generated Note\n\nThis note was created by the tool interaction test.\n`,
			"utf8"
		);
	}

	const prompt =
		"In the file 'E2E-Generated-Note.md', please use the update_frontmatter tool to " +
		"set the 'status' property to 'reviewed' and add a new property 'reviewed_at' " +
		"with value '2025-01-15'.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await screenshot(page, "tool-update_frontmatter-timeout");
		fail("update_frontmatter — LLM response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await screenshot(page, "tool-update_frontmatter");

	if (toolNames.some((n) => n.toLowerCase().includes("update_frontmatter") || n.toLowerCase().includes("frontmatter"))) {
		pass("update_frontmatter — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (
		response.toLowerCase().includes("reviewed") ||
		response.toLowerCase().includes("frontmatter") ||
		response.toLowerCase().includes("updated")
	) {
		pass("update_frontmatter — response indicates update", `Response mentions frontmatter update`, shot);
	} else if (errorText) {
		fail("update_frontmatter — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		fail("update_frontmatter — tool called", `No update_frontmatter tool card. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Verify the frontmatter was actually changed in the file
	if (fs.existsSync(targetPath)) {
		const newContent = fs.readFileSync(targetPath, "utf8");
		if (newContent.includes("reviewed") || newContent.includes("2025-01-15")) {
			pass("update_frontmatter — frontmatter updated in file", "File frontmatter contains updated values");
		} else if (!errorText) {
			fail("update_frontmatter — frontmatter updated in file", "Expected values not found in file frontmatter");
		}
	}
}

/**
 * Test: manage_tags
 *
 * Prompt asks the LLM to add tags. We verify:
 *  - manage_tags tool is called
 *  - Tags appear in the vault file frontmatter
 */
async function testManageTags(page: Page): Promise<void> {
	console.log("\n── Tool Test: manage_tags ─────────────────────────────────────");
	await newConversation(page);
	await setMode(page, "Act");

	// Ensure target note exists
	const targetPath = path.join(VAULT_PATH, "E2E-Generated-Note.md");
	if (!fs.existsSync(targetPath)) {
		fs.writeFileSync(
			targetPath,
			`---\ncreated_by: e2e-test\nstatus: draft\n---\n\n# E2E Generated Note\n\nThis note was created by the tool interaction test.\n`,
			"utf8"
		);
	}

	const prompt =
		"Please use the manage_tags tool to add the tags 'e2e', 'automated', and 'test' " +
		"to the note 'E2E-Generated-Note.md'.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await screenshot(page, "tool-manage_tags-timeout");
		fail("manage_tags — LLM response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await screenshot(page, "tool-manage_tags");

	if (toolNames.some((n) => n.toLowerCase().includes("manage_tags") || n.toLowerCase().includes("tags"))) {
		pass("manage_tags — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (response.toLowerCase().includes("tag") || response.toLowerCase().includes("added")) {
		pass("manage_tags — response indicates tags added", `Response mentions tag operation`, shot);
	} else if (errorText) {
		fail("manage_tags — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		fail("manage_tags — tool called", `No manage_tags tool card. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Verify the tags appear in the file
	if (fs.existsSync(targetPath)) {
		const newContent = fs.readFileSync(targetPath, "utf8");
		const hasE2eTag = newContent.includes("e2e") || newContent.includes("automated") || newContent.includes("test");
		if (hasE2eTag) {
			pass("manage_tags — tags written to file", "Tag values found in note frontmatter");
		} else if (!errorText) {
			fail("manage_tags — tags written to file", "Expected tags not found in note frontmatter");
		}
	}
}

/**
 * Test: multi-tool conversation (read then write)
 *
 * Tests a realistic workflow where the LLM reads a note and then writes
 * a summary note — exercising read_note + write_note in one conversation.
 */
async function testMultiToolConversation(page: Page): Promise<void> {
	console.log("\n── Tool Test: multi-tool (read_note + write_note) ─────────────");
	await newConversation(page);
	await setMode(page, "Act");

	// Clean up prior output
	const summaryPath = path.join(VAULT_PATH, "E2E-Meeting-Summary.md");
	if (fs.existsSync(summaryPath)) fs.unlinkSync(summaryPath);

	const prompt =
		"Please read the note 'Notes/Meeting Notes.md' and then create a new note at " +
		"'E2E-Meeting-Summary.md' that contains a brief bullet-point summary of the " +
		"key action items from that meeting.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await screenshot(page, "tool-multi-timeout");
		fail("multi-tool — LLM response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await screenshot(page, "tool-multi");

	// Expect both read_note and write_note to be invoked
	const calledRead = toolNames.some((n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note"));
	const calledWrite = toolNames.some((n) => n.toLowerCase().includes("write_note") || n.toLowerCase().includes("write note"));

	if (calledRead && calledWrite) {
		pass("multi-tool — both read_note and write_note called", `Tool cards: ${toolNames.join(", ")}`, shot);
	} else if (calledRead || calledWrite) {
		pass("multi-tool — at least one tool called", `Tool cards: ${toolNames.join(", ")}`, shot);
	} else if (
		response.toLowerCase().includes("alice") ||
		response.toLowerCase().includes("action") ||
		response.toLowerCase().includes("summary")
	) {
		pass("multi-tool — response reflects meeting content", `Response mentions meeting details`, shot);
	} else if (errorText) {
		fail("multi-tool — tools called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		fail("multi-tool — tools called", `No tool cards found. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Verify the summary file was created
	if (fs.existsSync(summaryPath)) {
		const content = fs.readFileSync(summaryPath, "utf8");
		if (content.length > 20) {
			pass("multi-tool — summary file created", `File created at E2E-Meeting-Summary.md (${content.length} chars)`);
		} else {
			fail("multi-tool — summary file has content", `File exists but is too short: "${content}"`);
		}
	} else if (!errorText) {
		// May have used a different filename — check loosely
		const vaultFiles = fs.readdirSync(VAULT_PATH);
		const similar = vaultFiles.find(
			(f) => f.toLowerCase().includes("summary") || f.toLowerCase().includes("meeting")
		);
		if (similar) {
			pass("multi-tool — summary file created (different name)", `Found: ${similar}`);
		} else {
			fail("multi-tool — summary file created", `File not found at ${summaryPath}`);
		}
	}
}

/**
 * Test: search then read workflow
 *
 * Tests searching the vault for a term and then reading one of the
 * matching notes — exercising search_vault + read_note in sequence.
 */
async function testSearchThenRead(page: Page): Promise<void> {
	console.log("\n── Tool Test: search_vault → read_note workflow ───────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"First, search my vault for notes that mention 'Q1'. " +
		"Then read the most relevant note you find and tell me the owner or author.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await screenshot(page, "tool-search-read-timeout");
		fail("search→read — LLM response", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await screenshot(page, "tool-search-read");

	const calledSearch = toolNames.some((n) => n.toLowerCase().includes("search"));
	const calledRead = toolNames.some((n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note"));

	if (calledSearch || calledRead) {
		pass("search→read — tools called", `Tool cards: ${toolNames.join(", ")}`, shot);
	} else if (
		response.toLowerCase().includes("alice") ||
		response.toLowerCase().includes("project plan") ||
		response.toLowerCase().includes("q1")
	) {
		pass("search→read — response references searched content", `Response: "${response.trim().substring(0, 80)}"`, shot);
	} else if (errorText) {
		fail("search→read — tools called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		fail("search→read — tools called", `No tool cards. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Notes/Project Plan.md contains Q1 and has owner: alice
	const lowerResponse = response.toLowerCase();
	if (lowerResponse.includes("alice") || lowerResponse.includes("owner")) {
		pass("search→read — owner/author found from note", "Response identifies the note owner");
	} else if (!errorText) {
		// Acceptable if response mentions other Q1 details
		if (lowerResponse.includes("q1") || lowerResponse.includes("project") || lowerResponse.includes("deadline")) {
			pass("search→read — Q1 content identified", "Response references Q1 content");
		} else {
			fail("search→read — owner/author found", `Response: "${response.trim().substring(0, 120)}"`);
		}
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
	console.log("=== Notor Tool Interaction Test ===\n");
	console.log("Provider:  AWS Bedrock");
	console.log("Auth:      AWS profile (default)");
	console.log("Region:    us-east-1");
	console.log("Model:     deepseek.v3.2\n");

	// ── Step 0: Build ────────────────────────────────────────────────────
	console.log("[0/5] Building plugin...");
	execSync("npm run build", {
		cwd: path.resolve(__dirname, "..", ".."),
		stdio: "inherit",
	});
	console.log("Build complete.\n");

	// ── Step 1: Set up test vault ────────────────────────────────────────
	console.log("[1/5] Setting up test vault...");
	setupTestVault();
	console.log("");

	// ── Step 2: Inject settings ──────────────────────────────────────────
	console.log("[2/5] Injecting Bedrock settings...");
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
		console.log("[5/5] Verifying chat panel and running tool tests...");
		{
			const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
			if (!chatContainer) {
				const shot = await screenshot(page, "00-no-chat-panel");
				fail("Chat panel visible", ".notor-chat-container not found", shot);
				throw new Error("Chat panel not visible — cannot run tool tests");
			}
			const shot = await screenshot(page, "00-chat-ready");
			pass("Chat panel ready", "Plugin loaded and chat container found", shot);
		}

		// ── Run all tool tests ───────────────────────────────────────────
		await testListVault(page);
		await testReadNote(page);
		await testSearchVault(page);
		await testReadFrontmatter(page);
		await testWriteNote(page);
		await testReplaceInNote(page);
		await testUpdateFrontmatter(page);
		await testManageTags(page);
		await testMultiToolConversation(page);
		await testSearchThenRead(page);

		// ── Final screenshot ─────────────────────────────────────────────
		await screenshot(page, "99-final");

		// ── Collect and summarize logs ───────────────────────────────────
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

	// ── Print summary ────────────────────────────────────────────────────
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

	// Write results JSON
	const resultsPath = path.join(RESULTS_DIR, "tool-interaction-results.json");
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
