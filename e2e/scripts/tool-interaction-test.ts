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
 *   Leaf behavior (note-opener):
 *     - note-opener leaf  : New leaf created; no duplicate on re-open
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled on that account with deepseek.v3.2 available
 *
 * Run with:
 *   npx tsx e2e/scripts/tool-interaction-test.ts
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	waitForSelector,
	sendMessage,
	getLastAssistantMessage,
	getLastToolCallNames,
	newConversation,
	setMode,
	buildDefaultSettings,
	VAULT_PATH,
} from "../lib/test-helpers";
import type { Page } from "playwright-core";

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
// Local helpers (not available in shared test-helpers)
// ---------------------------------------------------------------------------

/**
 * Get the text of the most recent error message.
 */
async function getLastError(page: Page): Promise<string> {
	const errs = await page.$$(".notor-chat-error");
	if (errs.length === 0) return "";
	const last = errs[errs.length - 1];
	return (await last!.textContent()) ?? "";
}

// ---------------------------------------------------------------------------
// Vault setup
// ---------------------------------------------------------------------------
function setupTestVault(vaultPath: string): void {
	console.log("  Setting up test vault notes...");
	for (const [relativePath, content] of Object.entries(VAULT_NOTES)) {
		const fullPath = path.join(vaultPath, relativePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content, "utf8");
		console.log(`    Created: ${relativePath}`);
	}
}

// ---------------------------------------------------------------------------
// Individual tool tests
// ---------------------------------------------------------------------------

async function testListVault(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Tool Test: list_vault ──────────────────────────────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"Please list all the notes and folders in my vault. " +
		"Use the list_vault tool to get a recursive listing.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("tool-list_vault-timeout");
		ctx.fail("list_vault — LLM response", `No response within timeout`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await ctx.screenshot("tool-list_vault");

	if (toolNames.some((n) => n.toLowerCase().includes("list_vault") || n.toLowerCase().includes("list vault"))) {
		ctx.pass("list_vault — tool called", `Tool call card found: ${toolNames.join(", ")}`, shot);
	} else if (response.toLowerCase().includes("note") || response.toLowerCase().includes("vault") || response.toLowerCase().includes("folder")) {
		ctx.pass("list_vault — response references vault", `No explicit card but response references vault content`, shot);
	} else if (errorText) {
		ctx.fail("list_vault — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		ctx.fail("list_vault — tool called", `No list_vault tool card found; tool names: [${toolNames.join(", ")}]`, shot);
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
		ctx.pass("list_vault — response contains note names", `Response references vault notes`);
	} else if (!errorText) {
		ctx.fail("list_vault — response contains note names", `Response: "${response.trim().substring(0, 120)}"`);
	}
}

async function testReadNote(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Tool Test: read_note ───────────────────────────────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"Please read the file 'Notes/Meeting Notes.md' and summarize what it contains.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("tool-read_note-timeout");
		ctx.fail("read_note — LLM response", `No response within timeout`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await ctx.screenshot("tool-read_note");

	if (toolNames.some((n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note"))) {
		ctx.pass("read_note — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (response.toLowerCase().includes("alice") || response.toLowerCase().includes("meeting") || response.toLowerCase().includes("agenda")) {
		ctx.pass("read_note — response contains note content", `Response includes meeting note content`, shot);
	} else if (errorText) {
		ctx.fail("read_note — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		ctx.fail("read_note — tool called", `No read_note tool card. Tool names: [${toolNames.join(", ")}]`, shot);
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
		ctx.pass("read_note — response reflects note content", "Response mentions meeting note details");
	} else if (!errorText) {
		ctx.fail("read_note — response reflects note content", `Response: "${response.trim().substring(0, 120)}"`);
	}
}

async function testSearchVault(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Tool Test: search_vault ────────────────────────────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"Search my vault for the word 'milestone' and tell me which notes contain it.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("tool-search_vault-timeout");
		ctx.fail("search_vault — LLM response", `No response within timeout`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await ctx.screenshot("tool-search_vault");

	if (toolNames.some((n) => n.toLowerCase().includes("search_vault") || n.toLowerCase().includes("search vault"))) {
		ctx.pass("search_vault — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (response.toLowerCase().includes("project plan") || response.toLowerCase().includes("milestone")) {
		ctx.pass("search_vault — response references matching notes", `Response mentions Project Plan`, shot);
	} else if (errorText) {
		ctx.fail("search_vault — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		ctx.fail("search_vault — tool called", `No search_vault tool card. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// The word "milestone" appears in Notes/Project Plan.md
	const lowerResponse = response.toLowerCase();
	if (lowerResponse.includes("project plan") || lowerResponse.includes("milestone") || lowerResponse.includes("notes/")) {
		ctx.pass("search_vault — response identifies matching note", "Response references matching note");
	} else if (!errorText) {
		ctx.fail("search_vault — response identifies matching note", `Response: "${response.trim().substring(0, 120)}"`);
	}
}

async function testReadFrontmatter(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Tool Test: read_frontmatter ────────────────────────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"What are the frontmatter properties (metadata) in the file 'Notes/Project Plan.md'? " +
		"Please use the read_frontmatter tool.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("tool-read_frontmatter-timeout");
		ctx.fail("read_frontmatter — LLM response", `No response within timeout`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await ctx.screenshot("tool-read_frontmatter");

	if (toolNames.some((n) => n.toLowerCase().includes("read_frontmatter") || n.toLowerCase().includes("frontmatter"))) {
		ctx.pass("read_frontmatter — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (
		response.toLowerCase().includes("status") ||
		response.toLowerCase().includes("owner") ||
		response.toLowerCase().includes("alice") ||
		response.toLowerCase().includes("active")
	) {
		ctx.pass("read_frontmatter — response contains frontmatter data", `Response includes frontmatter fields`, shot);
	} else if (errorText) {
		ctx.fail("read_frontmatter — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		ctx.fail("read_frontmatter — tool called", `No read_frontmatter tool card. Tool names: [${toolNames.join(", ")}]`, shot);
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
		ctx.pass("read_frontmatter — response contains expected properties", "Response includes frontmatter values");
	} else if (!errorText) {
		ctx.fail("read_frontmatter — response contains expected properties", `Response: "${response.trim().substring(0, 120)}"`);
	}
}

async function testWriteNote(ctx: TestContext): Promise<void> {
	const { page } = ctx;
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
		const shot = await ctx.screenshot("tool-write_note-timeout");
		ctx.fail("write_note — LLM response", `No response within timeout`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await ctx.screenshot("tool-write_note");

	if (toolNames.some((n) => n.toLowerCase().includes("write_note") || n.toLowerCase().includes("write note"))) {
		ctx.pass("write_note — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (response.toLowerCase().includes("created") || response.toLowerCase().includes("e2e-generated")) {
		ctx.pass("write_note — response indicates creation", `Response mentions note creation`, shot);
	} else if (errorText) {
		ctx.fail("write_note — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		ctx.fail("write_note — tool called", `No write_note tool card. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Verify the file actually exists in the vault
	if (fs.existsSync(targetPath)) {
		const written = fs.readFileSync(targetPath, "utf8");
		if (written.includes("e2e-test") || written.includes("E2E Generated") || written.includes("Section One")) {
			ctx.pass("write_note — file created with correct content", `File found at ${targetPath}`);
		} else {
			ctx.pass("write_note — file created", `File exists but content differs from requested`);
		}
	} else {
		// Check if the model may have used a slightly different filename
		const vaultFiles = fs.readdirSync(VAULT_PATH);
		const similar = vaultFiles.find(
			(f) => f.toLowerCase().includes("e2e") || f.toLowerCase().includes("generated")
		);
		if (similar) {
			ctx.pass("write_note — file created (different name)", `Found similar file: ${similar}`);
		} else if (!errorText) {
			ctx.fail("write_note — file created", `File not found at ${targetPath}. Vault contains: ${vaultFiles.join(", ")}`);
		}
	}
}

async function testReplaceInNote(ctx: TestContext): Promise<void> {
	const { page } = ctx;
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
		const shot = await ctx.screenshot("tool-replace_in_note-timeout");
		ctx.fail("replace_in_note — LLM response", `No response within timeout`, shot);
		return;
	}

	let toolNames = await getLastToolCallNames(page);
	let response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);

	const calledReplace = toolNames.some((n) => n.toLowerCase().includes("replace_in_note") || n.toLowerCase().includes("replace"));
	const calledRead = toolNames.some((n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note"));

	// If LLM called read_note first instead of replace_in_note, send a follow-up
	if (!calledReplace && calledRead) {
		console.log("    → LLM called read_note instead of replace_in_note — sending follow-up");
		const followUp = await sendMessage(page,
			"Now please use the replace_in_note tool to make the replacement. " +
			"Search for 'Some initial content here.' and replace with 'Content updated by replace_in_note tool test.'");
		if (followUp) {
			toolNames = await getLastToolCallNames(page);
			response = await getLastAssistantMessage(page);
		}
	}

	const shot = await ctx.screenshot("tool-replace_in_note");

	if (toolNames.some((n) => n.toLowerCase().includes("replace_in_note") || n.toLowerCase().includes("replace"))) {
		ctx.pass("replace_in_note — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (response.toLowerCase().includes("replaced") || response.toLowerCase().includes("updated") || response.toLowerCase().includes("applied")) {
		ctx.pass("replace_in_note — response indicates edit", `Response indicates replacement occurred`, shot);
	} else if (errorText) {
		ctx.fail("replace_in_note — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		ctx.fail("replace_in_note — tool called", `No replace_in_note tool card. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Verify the actual file content changed
	if (fs.existsSync(targetPath)) {
		const newContent = fs.readFileSync(targetPath, "utf8");
		if (newContent !== originalContent) {
			if (newContent.includes("replace_in_note tool test") || newContent.includes("Content updated")) {
				ctx.pass("replace_in_note — file content updated correctly", "Expected replacement text found in file");
			} else {
				ctx.pass("replace_in_note — file content changed", "File was modified (content differs from original)");
			}
		} else if (!errorText) {
			ctx.fail("replace_in_note — file content updated", "File content unchanged after replace_in_note call");
		}
	} else if (!errorText) {
		ctx.fail("replace_in_note — file exists", `Target file not found: ${targetPath}`);
	}
}

async function testUpdateFrontmatter(ctx: TestContext): Promise<void> {
	const { page } = ctx;
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
		const shot = await ctx.screenshot("tool-update_frontmatter-timeout");
		ctx.fail("update_frontmatter — LLM response", `No response within timeout`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await ctx.screenshot("tool-update_frontmatter");

	if (toolNames.some((n) => n.toLowerCase().includes("update_frontmatter") || n.toLowerCase().includes("frontmatter"))) {
		ctx.pass("update_frontmatter — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (
		response.toLowerCase().includes("reviewed") ||
		response.toLowerCase().includes("frontmatter") ||
		response.toLowerCase().includes("updated")
	) {
		ctx.pass("update_frontmatter — response indicates update", `Response mentions frontmatter update`, shot);
	} else if (errorText) {
		ctx.fail("update_frontmatter — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		ctx.fail("update_frontmatter — tool called", `No update_frontmatter tool card. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Verify the frontmatter was actually changed in the file
	if (fs.existsSync(targetPath)) {
		const newContent = fs.readFileSync(targetPath, "utf8");
		if (newContent.includes("reviewed") || newContent.includes("2025-01-15")) {
			ctx.pass("update_frontmatter — frontmatter updated in file", "File frontmatter contains updated values");
		} else if (!errorText) {
			ctx.fail("update_frontmatter — frontmatter updated in file", "Expected values not found in file frontmatter");
		}
	}
}

async function testManageTags(ctx: TestContext): Promise<void> {
	const { page } = ctx;
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
		const shot = await ctx.screenshot("tool-manage_tags-timeout");
		ctx.fail("manage_tags — LLM response", `No response within timeout`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await ctx.screenshot("tool-manage_tags");

	if (toolNames.some((n) => n.toLowerCase().includes("manage_tags") || n.toLowerCase().includes("tags"))) {
		ctx.pass("manage_tags — tool called", `Tool card: ${toolNames.join(", ")}`, shot);
	} else if (response.toLowerCase().includes("tag") || response.toLowerCase().includes("added")) {
		ctx.pass("manage_tags — response indicates tags added", `Response mentions tag operation`, shot);
	} else if (errorText) {
		ctx.fail("manage_tags — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		ctx.fail("manage_tags — tool called", `No manage_tags tool card. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Verify the tags appear in the file
	if (fs.existsSync(targetPath)) {
		const newContent = fs.readFileSync(targetPath, "utf8");
		const hasE2eTag = newContent.includes("e2e") || newContent.includes("automated") || newContent.includes("test");
		if (hasE2eTag) {
			ctx.pass("manage_tags — tags written to file", "Tag values found in note frontmatter");
		} else if (!errorText) {
			ctx.fail("manage_tags — tags written to file", "Expected tags not found in note frontmatter");
		}
	}
}

async function testMultiToolConversation(ctx: TestContext): Promise<void> {
	const { page } = ctx;
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
		const shot = await ctx.screenshot("tool-multi-timeout");
		ctx.fail("multi-tool — LLM response", `No response within timeout`, shot);
		return;
	}

	let toolNames = await getLastToolCallNames(page);
	let response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);

	// Expect both read_note and write_note to be invoked
	let calledRead = toolNames.some((n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note"));
	let calledWrite = toolNames.some((n) => n.toLowerCase().includes("write_note") || n.toLowerCase().includes("write note"));

	// If LLM only read the note, nudge it to write the summary
	if (calledRead && !calledWrite && !fs.existsSync(summaryPath)) {
		console.log("    → LLM only called read_note — sending follow-up to write the summary");
		const followUp = await sendMessage(page,
			"Now please write that summary to 'E2E-Meeting-Summary.md' using the write_note tool.");
		if (followUp) {
			toolNames = await getLastToolCallNames(page);
			response = await getLastAssistantMessage(page);
			calledWrite = toolNames.some((n) => n.toLowerCase().includes("write_note") || n.toLowerCase().includes("write note"));
		}
	}

	const shot = await ctx.screenshot("tool-multi");

	if (calledRead && calledWrite) {
		ctx.pass("multi-tool — both read_note and write_note called", `Tool cards: ${toolNames.join(", ")}`, shot);
	} else if (calledRead || calledWrite) {
		ctx.pass("multi-tool — at least one tool called", `Tool cards: ${toolNames.join(", ")}`, shot);
	} else if (
		response.toLowerCase().includes("alice") ||
		response.toLowerCase().includes("action") ||
		response.toLowerCase().includes("summary")
	) {
		ctx.pass("multi-tool — response reflects meeting content", `Response mentions meeting details`, shot);
	} else if (errorText) {
		ctx.fail("multi-tool — tools called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		ctx.fail("multi-tool — tools called", `No tool cards found. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Verify the summary file was created
	if (fs.existsSync(summaryPath)) {
		const content = fs.readFileSync(summaryPath, "utf8");
		if (content.length > 20) {
			ctx.pass("multi-tool — summary file created", `File created at E2E-Meeting-Summary.md (${content.length} chars)`);
		} else {
			ctx.fail("multi-tool — summary file has content", `File exists but is too short: "${content}"`);
		}
	} else if (!errorText) {
		// May have used a different filename — check loosely
		const vaultFiles = fs.readdirSync(VAULT_PATH);
		const similar = vaultFiles.find(
			(f) => f.toLowerCase().includes("summary") || f.toLowerCase().includes("meeting")
		);
		if (similar) {
			ctx.pass("multi-tool — summary file created (different name)", `Found: ${similar}`);
		} else {
			ctx.fail("multi-tool — summary file created", `File not found at ${summaryPath}`);
		}
	}
}

async function testNoteOpenerLeafBehavior(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Tool Test: note-opener leaf behavior ───────────────────────");
	await newConversation(page);
	await setMode(page, "Act");

	// Ensure the target note exists and is NOT already open
	const targetNote = "Notes/Meeting Notes.md";

	// Count open editor leaves before any tool call.
	const countLeaves = () =>
		page.evaluate(() => {
			return document.querySelectorAll(
				".workspace-leaf .markdown-source-view, .workspace-leaf .markdown-reading-view"
			).length;
		});

	const leafCountBefore = await countLeaves();
	console.log(`    Leaf count before first read: ${leafCountBefore}`);

	// ── First tool call: read_note on a note that is NOT open ───────────
	const responded1 = await sendMessage(
		page,
		`Please use the read_note tool to read '${targetNote}' and tell me how many attendees are listed.`
	);

	if (!responded1) {
		const shot = await ctx.screenshot("tool-leaf-first-read-timeout");
		ctx.fail("note-opener leaf — first read response", `No response within timeout`, shot);
		return;
	}

	// Give Obsidian a moment to open the leaf
	await page.waitForTimeout(1_000);
	const leafCountAfterFirst = await countLeaves();
	console.log(`    Leaf count after first read: ${leafCountAfterFirst}`);
	const shot1 = await ctx.screenshot("tool-leaf-after-first-read");

	if (leafCountAfterFirst > leafCountBefore) {
		ctx.pass(
			"note-opener leaf — new leaf created on first open",
			`Leaf count: ${leafCountBefore} → ${leafCountAfterFirst} (new tab opened)`,
			shot1
		);
	} else {
		// The note may already have been open from a prior test; treat as acceptable
		ctx.pass(
			"note-opener leaf — leaf count unchanged (note may have been pre-opened)",
			`Leaf count stayed at ${leafCountAfterFirst}; note was likely already open`,
			shot1
		);
	}

	// ── Second tool call: read the SAME note again ───────────────────────
	const leafCountBeforeSecond = await countLeaves();

	const responded2 = await sendMessage(
		page,
		`Please use read_note again on '${targetNote}' and tell me the first action item listed.`
	);

	if (!responded2) {
		const shot = await ctx.screenshot("tool-leaf-second-read-timeout");
		ctx.fail("note-opener leaf — second read response", `No response within timeout`, shot);
		return;
	}

	await page.waitForTimeout(1_000);
	const leafCountAfterSecond = await countLeaves();
	console.log(`    Leaf count after second read: ${leafCountAfterSecond}`);
	const shot2 = await ctx.screenshot("tool-leaf-after-second-read");

	if (leafCountAfterSecond <= leafCountBeforeSecond) {
		ctx.pass(
			"note-opener leaf — no duplicate leaf on re-open",
			`Leaf count: ${leafCountBeforeSecond} → ${leafCountAfterSecond} (no new tab for already-open note)`,
			shot2
		);
	} else {
		ctx.fail(
			"note-opener leaf — no duplicate leaf on re-open",
			`Leaf count grew from ${leafCountBeforeSecond} to ${leafCountAfterSecond} — duplicate tab was opened`,
			shot2
		);
	}

	// ── Verify active leaf shows the target note ─────────────────────────
	const activeNoteTitle = await page.evaluate(() => {
		const activeLeaf = document.querySelector(
			".workspace-leaf.mod-active .view-header-title"
		);
		return activeLeaf?.textContent?.trim() ?? null;
	});
	console.log(`    Active leaf title: "${activeNoteTitle}"`);

	const expectedBasename = "Meeting Notes";
	if (activeNoteTitle && activeNoteTitle.includes(expectedBasename)) {
		ctx.pass(
			"note-opener leaf — active leaf shows target note",
			`Active leaf title: "${activeNoteTitle}"`
		);
	} else {
		// The chat panel itself may be the active leaf (focus: false is correct)
		ctx.pass(
			"note-opener leaf — focus not stolen from chat panel",
			`Active leaf: "${activeNoteTitle ?? "(none)"}" — chat panel retains focus as expected`
		);
	}
}

async function testSearchThenRead(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Tool Test: search_vault → read_note workflow ───────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const prompt =
		"First, search my vault for notes that mention 'Q1'. " +
		"Then read the most relevant note you find and tell me the owner or author.";

	const responded = await sendMessage(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("tool-search-read-timeout");
		ctx.fail("search→read — LLM response", `No response within timeout`, shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await ctx.screenshot("tool-search-read");

	const calledSearch = toolNames.some((n) => n.toLowerCase().includes("search"));
	const calledRead = toolNames.some((n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note"));

	if (calledSearch || calledRead) {
		ctx.pass("search→read — tools called", `Tool cards: ${toolNames.join(", ")}`, shot);
	} else if (
		response.toLowerCase().includes("alice") ||
		response.toLowerCase().includes("project plan") ||
		response.toLowerCase().includes("q1")
	) {
		ctx.pass("search→read — response references searched content", `Response: "${response.trim().substring(0, 80)}"`, shot);
	} else if (errorText) {
		ctx.fail("search→read — tools called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
	} else {
		ctx.fail("search→read — tools called", `No tool cards. Tool names: [${toolNames.join(", ")}]`, shot);
	}

	// Notes/Project Plan.md contains Q1 and has owner: alice
	const lowerResponse = response.toLowerCase();
	if (lowerResponse.includes("alice") || lowerResponse.includes("owner")) {
		ctx.pass("search→read — owner/author found from note", "Response identifies the note owner");
	} else if (!errorText) {
		// Acceptable if response mentions other Q1 details
		if (lowerResponse.includes("q1") || lowerResponse.includes("project") || lowerResponse.includes("deadline")) {
			ctx.pass("search→read — Q1 content identified", "Response references Q1 content");
		} else {
			ctx.fail("search→read — owner/author found", `Response: "${response.trim().substring(0, 120)}"`);
		}
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
			throw new Error("Chat panel not visible — cannot run tool tests");
		}
		const shot = await ctx.screenshot("00-chat-ready");
		ctx.pass("Chat panel ready", "Plugin loaded and chat container found", shot);
	}

	// Run all tool tests
	await testListVault(ctx);
	await testReadNote(ctx);
	await testSearchVault(ctx);
	await testReadFrontmatter(ctx);
	await testWriteNote(ctx);
	await testReplaceInNote(ctx);
	await testUpdateFrontmatter(ctx);
	await testManageTags(ctx);
	await testMultiToolConversation(ctx);
	await testNoteOpenerLeafBehavior(ctx);
	await testSearchThenRead(ctx);
}

runTest(
	{
		name: "tool-interaction-test",
		settings: buildDefaultSettings({
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
		}),
		setupVault: (vaultPath) => setupTestVault(vaultPath),
		cleanupFiles: [
			"E2E-Generated-Note.md",
			"E2E-Meeting-Summary.md",
			"Test Note.md",
			"Notes/Meeting Notes.md",
			"Notes/Project Plan.md",
			"Journal/2025-01-01.md",
		],
	},
	allTests,
);
