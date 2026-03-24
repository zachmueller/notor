#!/usr/bin/env npx tsx
/**
 * E2E test for the `move_note` tool.
 *
 * Tests rename, move, rename+move, alias insertion, and directory auto-creation
 * by prompting the LLM and verifying both tool invocation and filesystem results.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	sendMessageWithApprovalHandling,
	getLastAssistantMessage,
	getLastToolCallNames,
	newConversation,
	setMode,
	buildDefaultSettings,
	VAULT_PATH,
} from "../lib/test-helpers";
import type { Page } from "playwright-core";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

async function getLastError(page: Page): Promise<string> {
	const errs = await page.$$(".notor-chat-error");
	if (errs.length === 0) return "";
	const last = errs[errs.length - 1];
	return (await last!.textContent()) ?? "";
}

// ---------------------------------------------------------------------------
// Vault setup
// ---------------------------------------------------------------------------

const VAULT_NOTES: Record<string, string> = {
	"MoveTest/Original Note.md": [
		"---",
		"tags:",
		"  - test",
		"---",
		"",
		"# Original Note",
		"",
		"This note will be renamed by the move_note e2e test.",
	].join("\n"),
	"MoveTest/Note To Move.md": [
		"# Note To Move",
		"",
		"This note will be moved to a different folder.",
	].join("\n"),
	"MoveTest/Rename And Move.md": [
		"# Rename And Move",
		"",
		"This note will be renamed and moved simultaneously.",
	].join("\n"),
	"MoveTest/Alias Test Note.md": [
		"---",
		"tags:",
		"  - alias-test",
		"---",
		"",
		"# Alias Test Note",
		"",
		"This note will be renamed with add_alias=true.",
	].join("\n"),
};

function setupTestVault(vaultPath: string): void {
	console.log("  Setting up move_note test fixtures...");
	for (const [relativePath, content] of Object.entries(VAULT_NOTES)) {
		const fullPath = path.join(vaultPath, relativePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content, "utf8");
		console.log(`    Created: ${relativePath}`);
	}
}

// ---------------------------------------------------------------------------
// Individual tests
// ---------------------------------------------------------------------------

/**
 * Test 1: Basic rename — same folder, different name.
 */
async function testBasicRename(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n-- Test 1: Basic rename (same folder, different name) -------");

	await newConversation(page);
	await setMode(page, "Act");

	const prompt =
		"Use the move_note tool to rename the note at 'MoveTest/Original Note.md' " +
		"to 'MoveTest/Renamed Note.md'. Do NOT use add_alias.";

	const { responded } = await sendMessageWithApprovalHandling(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("01-rename-timeout");
		ctx.fail("rename — LLM response", "No response within timeout", shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const response = await getLastAssistantMessage(page);
	const errorText = await getLastError(page);
	const shot = await ctx.screenshot("01-rename");

	// Check tool was called
	if (toolNames.some((n) => n.toLowerCase().includes("move_note"))) {
		ctx.pass("rename — tool called", `Tool card found: ${toolNames.join(", ")}`, shot);
	} else if (errorText) {
		ctx.fail("rename — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
		return;
	} else {
		ctx.fail("rename — tool called", `No move_note card. Tools: [${toolNames.join(", ")}]. Response: "${response.substring(0, 100)}"`, shot);
		return;
	}

	// Verify filesystem: old gone, new exists
	const oldPath = path.join(VAULT_PATH, "MoveTest/Original Note.md");
	const newPath = path.join(VAULT_PATH, "MoveTest/Renamed Note.md");

	if (!fs.existsSync(oldPath) && fs.existsSync(newPath)) {
		const content = fs.readFileSync(newPath, "utf8");
		if (content.includes("Original Note")) {
			ctx.pass("rename — filesystem verified", "Old file gone, new file exists with original content");
		} else {
			ctx.fail("rename — filesystem verified", `New file exists but content unexpected: "${content.substring(0, 80)}"`);
		}
	} else if (fs.existsSync(oldPath)) {
		ctx.fail("rename — filesystem verified", "Old file still exists — rename may not have happened");
	} else {
		ctx.fail("rename — filesystem verified", "New file not found at expected path");
	}
}

/**
 * Test 2: Move to different folder (same filename).
 */
async function testBasicMove(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n-- Test 2: Move to different folder -------------------------");

	await newConversation(page);
	await setMode(page, "Act");

	const prompt =
		"Use the move_note tool to move 'MoveTest/Note To Move.md' to 'MoveTest/SubFolder/Note To Move.md'. " +
		"The SubFolder does not exist yet — the tool should create it automatically.";

	const { responded } = await sendMessageWithApprovalHandling(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("02-move-timeout");
		ctx.fail("move — LLM response", "No response within timeout", shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const errorText = await getLastError(page);
	const shot = await ctx.screenshot("02-move");

	if (toolNames.some((n) => n.toLowerCase().includes("move_note"))) {
		ctx.pass("move — tool called", `Tool card found: ${toolNames.join(", ")}`, shot);
	} else if (errorText) {
		ctx.fail("move — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
		return;
	} else {
		ctx.fail("move — tool called", `No move_note card. Tools: [${toolNames.join(", ")}]`, shot);
		return;
	}

	// Verify filesystem: moved to subfolder, old gone
	const oldPath = path.join(VAULT_PATH, "MoveTest/Note To Move.md");
	const newPath = path.join(VAULT_PATH, "MoveTest/SubFolder/Note To Move.md");

	if (!fs.existsSync(oldPath) && fs.existsSync(newPath)) {
		ctx.pass("move — filesystem verified", "File moved to SubFolder, old location removed, directory auto-created");
	} else if (fs.existsSync(oldPath)) {
		ctx.fail("move — filesystem verified", "Old file still exists");
	} else {
		ctx.fail("move — filesystem verified", "New file not found at MoveTest/SubFolder/Note To Move.md");
	}
}

/**
 * Test 3: Rename + move simultaneously.
 */
async function testRenameAndMove(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n-- Test 3: Rename + move simultaneously ----------------------");

	await newConversation(page);
	await setMode(page, "Act");

	const prompt =
		"Use the move_note tool to move 'MoveTest/Rename And Move.md' " +
		"to 'MoveTest/Archive/Archived Note.md'. This is both a rename and a move.";

	const { responded } = await sendMessageWithApprovalHandling(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("03-rename-move-timeout");
		ctx.fail("rename+move — LLM response", "No response within timeout", shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const errorText = await getLastError(page);
	const shot = await ctx.screenshot("03-rename-move");

	if (toolNames.some((n) => n.toLowerCase().includes("move_note"))) {
		ctx.pass("rename+move — tool called", `Tool card found: ${toolNames.join(", ")}`, shot);
	} else if (errorText) {
		ctx.fail("rename+move — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
		return;
	} else {
		ctx.fail("rename+move — tool called", `No move_note card. Tools: [${toolNames.join(", ")}]`, shot);
		return;
	}

	// Verify filesystem
	const oldPath = path.join(VAULT_PATH, "MoveTest/Rename And Move.md");
	const newPath = path.join(VAULT_PATH, "MoveTest/Archive/Archived Note.md");

	if (!fs.existsSync(oldPath) && fs.existsSync(newPath)) {
		const content = fs.readFileSync(newPath, "utf8");
		if (content.includes("Rename And Move")) {
			ctx.pass("rename+move — filesystem verified", "File renamed and moved with original content intact");
		} else {
			ctx.fail("rename+move — filesystem verified", `File exists but unexpected content: "${content.substring(0, 80)}"`);
		}
	} else if (fs.existsSync(oldPath)) {
		ctx.fail("rename+move — filesystem verified", "Old file still exists");
	} else {
		ctx.fail("rename+move — filesystem verified", "New file not found at expected path");
	}
}

/**
 * Test 4: Rename with add_alias — verify old name added to frontmatter aliases.
 */
async function testAddAlias(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n-- Test 4: Rename with add_alias -----------------------------");

	await newConversation(page);
	await setMode(page, "Act");

	const prompt =
		"Use the move_note tool to rename 'MoveTest/Alias Test Note.md' " +
		"to 'MoveTest/Alias Renamed.md'. Set add_alias to true so the old " +
		"name 'Alias Test Note' is preserved in the frontmatter aliases list.";

	const { responded } = await sendMessageWithApprovalHandling(page, prompt);

	if (!responded) {
		const shot = await ctx.screenshot("04-alias-timeout");
		ctx.fail("add_alias — LLM response", "No response within timeout", shot);
		return;
	}

	const toolNames = await getLastToolCallNames(page);
	const errorText = await getLastError(page);
	const shot = await ctx.screenshot("04-alias");

	if (toolNames.some((n) => n.toLowerCase().includes("move_note"))) {
		ctx.pass("add_alias — tool called", `Tool card found: ${toolNames.join(", ")}`, shot);
	} else if (errorText) {
		ctx.fail("add_alias — tool called", `Error: ${errorText.trim().substring(0, 120)}`, shot);
		return;
	} else {
		ctx.fail("add_alias — tool called", `No move_note card. Tools: [${toolNames.join(", ")}]`, shot);
		return;
	}

	// Verify filesystem: renamed and alias added
	const oldPath = path.join(VAULT_PATH, "MoveTest/Alias Test Note.md");
	const newPath = path.join(VAULT_PATH, "MoveTest/Alias Renamed.md");

	if (!fs.existsSync(oldPath) && fs.existsSync(newPath)) {
		const content = fs.readFileSync(newPath, "utf8");
		if (content.includes("Alias Test Note")) {
			ctx.pass("add_alias — alias in frontmatter", "Old name 'Alias Test Note' found in renamed file's frontmatter aliases");
		} else {
			ctx.fail("add_alias — alias in frontmatter", `Alias not found in frontmatter. Content: "${content.substring(0, 200)}"`);
		}
	} else if (fs.existsSync(oldPath)) {
		ctx.fail("add_alias — filesystem verified", "Old file still exists");
	} else {
		ctx.fail("add_alias — filesystem verified", "New file not found at expected path");
	}
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

async function allTests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	await testBasicRename(ctx);
	await testBasicMove(ctx);
	await testRenameAndMove(ctx);
	await testAddAlias(ctx);
}

runTest(
	{
		name: "move-note-test",
		settings: buildDefaultSettings({
			mode: "act",
			auto_approve: {
				read_note: true,
				search_vault: true,
				list_vault: true,
				read_frontmatter: true,
				move_note: true,
			},
		}),
		setupVault: (vaultPath) => setupTestVault(vaultPath),
		cleanupFiles: [
			"MoveTest",
		],
	},
	allTests,
);
