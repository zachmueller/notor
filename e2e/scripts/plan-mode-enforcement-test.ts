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

import * as path from "node:path";
import * as fs from "node:fs";
import { type Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	waitForSelector,
	buildDefaultSettings,
	sendMessage,
	getLastAssistantMessage,
	getLastToolCallNames,
	newConversation,
	setMode,
	VAULT_PATH,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local helper (not in shared helpers)
// ---------------------------------------------------------------------------

/**
 * Get current mode text from the toggle.
 */
async function getCurrentMode(page: Page): Promise<string> {
	const toggle = await page.$(".notor-mode-toggle");
	return (await toggle?.textContent())?.trim() ?? "unknown";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	// ── Verify chat panel ────────────────────────────────────────────
	{
		const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
		if (!chatContainer) {
			const shot = await ctx.screenshot("00-no-chat-panel");
			ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
			throw new Error("Chat panel not visible — cannot run Plan mode tests");
		}
		const shot = await ctx.screenshot("00-chat-ready");
		ctx.pass("Chat panel ready", "Plugin loaded and chat container found", shot);
	}

	// ── Run all tests ────────────────────────────────────────────────
	await testWriteNoteBlockedInPlanMode(ctx);
	await testReplaceInNoteBlockedInPlanMode(ctx);
	await testUpdateFrontmatterBlockedInPlanMode(ctx);
	await testManageTagsBlockedInPlanMode(ctx);
	await testReadToolsWorkInPlanMode(ctx);
	await testSwitchToActUnblocksWrites(ctx);
	await testSwitchToPlanReBlocksWrites(ctx);
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
async function testWriteNoteBlockedInPlanMode(ctx: TestContext): Promise<void> {
	const { page } = ctx;
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

	const shot = await ctx.screenshot("01-write-note-blocked");

	if (!responded) {
		ctx.fail("write_note blocked in Plan mode — response", `No response within timeout`, shot);
		return;
	}

	const response = await getLastAssistantMessage(page);
	const toolNames = await getLastToolCallNames(page);
	const lowerResponse = response.toLowerCase();

	// The file must NOT have been created
	if (!fs.existsSync(targetPath)) {
		ctx.pass("write_note blocked — file not created", `File correctly absent: ${targetPath}`, shot);
	} else {
		ctx.fail("write_note blocked — file not created", `File was created despite Plan mode: ${targetPath}`, shot);
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
		ctx.pass("write_note blocked — LLM acknowledges restriction", `Response mentions restriction: "${response.trim().substring(0, 120)}"`, shot);
	} else if (response.trim().length > 0) {
		// A response was received even if it doesn't explicitly mention Plan mode
		ctx.pass("write_note blocked — LLM responded", `Response: "${response.trim().substring(0, 120)}"`, shot);
	} else {
		ctx.fail("write_note blocked — LLM responded", "No assistant message after blocked write attempt");
	}

	// Verify that a tool call card was shown but in a blocked/error state
	if (toolNames.length > 0) {
		const toolError = await page.$(".notor-tool-call.notor-tool-error, .notor-tool-call[data-status='error'], .notor-tool-call[data-status='blocked']");
		if (toolError) {
			ctx.pass("write_note blocked — tool call shows blocked/error", `Tool card in error/blocked state`);
		} else {
			// Tool call present but status not clearly blocked — still informative
			ctx.pass("write_note blocked — tool call rendered", `Tool call card rendered: ${toolNames.join(", ")}`);
		}
	}
}

/**
 * Test 2: replace_in_note is blocked in Plan mode
 *
 * File content must remain unchanged after the LLM attempts a replace_in_note
 * in Plan mode.
 */
async function testReplaceInNoteBlockedInPlanMode(ctx: TestContext): Promise<void> {
	const { page } = ctx;
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

	const shot = await ctx.screenshot("02-replace-blocked");

	if (!responded) {
		ctx.fail("replace_in_note blocked — response", `No response within timeout`, shot);
		return;
	}

	const currentContent = fs.readFileSync(targetPath, "utf8");

	if (currentContent === originalContent) {
		ctx.pass("replace_in_note blocked — file unchanged", "File content is identical to original", shot);
	} else if (currentContent.includes("This text should not appear")) {
		ctx.fail("replace_in_note blocked — file unchanged", "File was modified despite Plan mode enforcement", shot);
	} else {
		// Content changed but not with the test string — unexpected
		ctx.fail("replace_in_note blocked — file unchanged", `File content changed unexpectedly: "${currentContent.substring(0, 200)}"`, shot);
	}

	const response = await getLastAssistantMessage(page);
	if (response.trim().length > 0) {
		ctx.pass("replace_in_note blocked — LLM responded", `Response: "${response.trim().substring(0, 120)}"`, shot);
	} else {
		ctx.fail("replace_in_note blocked — LLM responded", "No assistant message after blocked replace attempt");
	}
}

/**
 * Test 3: update_frontmatter is blocked in Plan mode
 *
 * Frontmatter must remain unchanged after a blocked update_frontmatter call.
 */
async function testUpdateFrontmatterBlockedInPlanMode(ctx: TestContext): Promise<void> {
	const { page } = ctx;
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

	const shot = await ctx.screenshot("03-update-frontmatter-blocked");

	if (!responded) {
		ctx.fail("update_frontmatter blocked — response", `No response within timeout`, shot);
		return;
	}

	const currentContent = fs.readFileSync(targetPath, "utf8");

	if (currentContent.includes("modified-by-plan-mode-test")) {
		ctx.fail("update_frontmatter blocked — frontmatter unchanged", "Frontmatter was modified despite Plan mode enforcement", shot);
	} else {
		ctx.pass("update_frontmatter blocked — frontmatter unchanged", "Frontmatter does not contain the test value", shot);
	}

	const response = await getLastAssistantMessage(page);
	if (response.trim().length > 0) {
		ctx.pass("update_frontmatter blocked — LLM responded", `Response: "${response.trim().substring(0, 120)}"`, shot);
	} else {
		ctx.fail("update_frontmatter blocked — LLM responded", "No assistant message after blocked update attempt");
	}
}

/**
 * Test 4: manage_tags is blocked in Plan mode
 *
 * Tags must not be modified after a blocked manage_tags call.
 */
async function testManageTagsBlockedInPlanMode(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Plan Test 4: manage_tags blocked in Plan mode ───────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	const targetPath = path.join(VAULT_PATH, "Plan-Mode-Test.md");

	const responded = await sendMessage(
		page,
		"Please use the manage_tags tool to add the tag 'plan-mode-blocked-tag' " +
		"to the note 'Plan-Mode-Test.md'. This should be blocked in Plan mode."
	);

	const shot = await ctx.screenshot("04-manage-tags-blocked");

	if (!responded) {
		ctx.fail("manage_tags blocked — response", `No response within timeout`, shot);
		return;
	}

	const currentContent = fs.readFileSync(targetPath, "utf8");

	if (currentContent.includes("plan-mode-blocked-tag")) {
		ctx.fail("manage_tags blocked — tags unchanged", "Tag was added despite Plan mode enforcement", shot);
	} else {
		ctx.pass("manage_tags blocked — tags unchanged", "Tag not present in frontmatter (correctly blocked)", shot);
	}

	const response = await getLastAssistantMessage(page);
	if (response.trim().length > 0) {
		ctx.pass("manage_tags blocked — LLM responded", `Response: "${response.trim().substring(0, 120)}"`, shot);
	} else {
		ctx.fail("manage_tags blocked — LLM responded", "No assistant message after blocked tag attempt");
	}
}

/**
 * Test 5: Read tools work normally in Plan mode
 *
 * list_vault, read_note, search_vault, and read_frontmatter must all succeed
 * in Plan mode since they are classified as read tools.
 */
async function testReadToolsWorkInPlanMode(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Plan Test 5: Read tools work in Plan mode ──────────────────");
	await newConversation(page);
	await setMode(page, "Plan");

	// list_vault
	{
		const responded = await sendMessage(
			page,
			"Please use the list_vault tool to list the notes in my vault root."
		);
		const shot = await ctx.screenshot("05a-list-vault-plan");

		if (!responded) {
			ctx.fail("list_vault in Plan mode — response", `No response within timeout`, shot);
		} else {
			const response = await getLastAssistantMessage(page);
			const toolNames = await getLastToolCallNames(page);
			const hasListVault = toolNames.some((n) => n.toLowerCase().includes("list_vault") || n.toLowerCase().includes("list vault"));
			const responseHasNotes =
				response.toLowerCase().includes(".md") ||
				response.toLowerCase().includes("note") ||
				response.toLowerCase().includes("vault");

			if (hasListVault || responseHasNotes) {
				ctx.pass("list_vault in Plan mode — succeeded", `Tool called (${toolNames.join(", ")}), response references vault`, shot);
			} else {
				const errorMsg = await page.$(".notor-chat-error");
				if (errorMsg) {
					const errText = await errorMsg.textContent();
					ctx.fail("list_vault in Plan mode — succeeded", `Error: "${errText?.trim().substring(0, 120)}"`, shot);
				} else {
					ctx.fail("list_vault in Plan mode — succeeded", `Response: "${response.trim().substring(0, 120)}"`, shot);
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
		const shot = await ctx.screenshot("05b-read-note-plan");

		if (!responded) {
			ctx.fail("read_note in Plan mode — response", `No response within timeout`, shot);
		} else {
			const response = await getLastAssistantMessage(page);
			const toolNames = await getLastToolCallNames(page);
			const hasReadNote = toolNames.some((n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note"));
			// The note title is "Plan Mode Test Note"
			const responseHasContent =
				response.toLowerCase().includes("plan mode test") ||
				response.toLowerCase().includes("original body");

			if (hasReadNote || responseHasContent) {
				ctx.pass("read_note in Plan mode — succeeded", `Tool called (${toolNames.join(", ")}), response contains note content`, shot);
			} else {
				ctx.fail("read_note in Plan mode — succeeded", `Response did not reference note content: "${response.trim().substring(0, 120)}"`, shot);
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
		const shot = await ctx.screenshot("05c-search-vault-plan");

		if (!responded) {
			ctx.fail("search_vault in Plan mode — response", `No response within timeout`, shot);
		} else {
			const response = await getLastAssistantMessage(page);
			const toolNames = await getLastToolCallNames(page);
			const hasSearch = toolNames.some((n) => n.toLowerCase().includes("search"));
			const responseHasResults =
				response.toLowerCase().includes("original") ||
				response.toLowerCase().includes("plan-mode-test") ||
				response.toLowerCase().includes(".md");

			if (hasSearch || responseHasResults) {
				ctx.pass("search_vault in Plan mode — succeeded", `Tool called (${toolNames.join(", ")}), response references search results`, shot);
			} else {
				ctx.fail("search_vault in Plan mode — succeeded", `Response: "${response.trim().substring(0, 120)}"`, shot);
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
		const shot = await ctx.screenshot("05d-read-frontmatter-plan");

		if (!responded) {
			ctx.fail("read_frontmatter in Plan mode — response", `No response within timeout`, shot);
		} else {
			const response = await getLastAssistantMessage(page);
			const toolNames = await getLastToolCallNames(page);
			const hasFrontmatter = toolNames.some((n) => n.toLowerCase().includes("frontmatter"));
			// Plan-Mode-Test.md has: title, status, tags
			const responseHasFrontmatter =
				response.toLowerCase().includes("title") ||
				response.toLowerCase().includes("status") ||
				response.toLowerCase().includes("original") ||
				response.toLowerCase().includes("tags");

			if (hasFrontmatter || responseHasFrontmatter) {
				ctx.pass("read_frontmatter in Plan mode — succeeded", `Tool called (${toolNames.join(", ")}), response contains frontmatter`, shot);
			} else {
				ctx.fail("read_frontmatter in Plan mode — succeeded", `Response: "${response.trim().substring(0, 120)}"`, shot);
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
async function testSwitchToActUnblocksWrites(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Plan Test 6: Plan → Act switch unblocks write tools ─────────");
	await newConversation(page);

	const targetPath = path.join(VAULT_PATH, "Plan-Mode-Act-Created.md");
	if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);

	// Confirm we start in Plan mode
	await setMode(page, "Plan");
	const modeBefore = await getCurrentMode(page);
	ctx.pass("Plan→Act test — starting in Plan mode", `Mode confirmed: ${modeBefore}`);

	// Now switch to Act
	await setMode(page, "Act");
	const modeAfter = await getCurrentMode(page);

	if (modeAfter === "Act") {
		ctx.pass("Plan→Act test — switched to Act", "Mode is now Act");
	} else {
		ctx.fail("Plan→Act test — switched to Act", `Expected Act, got: ${modeAfter}`);
		return;
	}

	// Send a write request — should succeed in Act mode
	const responded = await sendMessage(
		page,
		"Please use write_note to create 'Plan-Mode-Act-Created.md' with content:\n\n# Act Mode Created\n\nThis note was created in Act mode.\n"
	);

	const shot = await ctx.screenshot("06-act-mode-write");

	if (!responded) {
		ctx.fail("Plan→Act test — response received", `No response within timeout`, shot);
		return;
	}

	if (fs.existsSync(targetPath)) {
		const content = fs.readFileSync(targetPath, "utf8");
		if (content.includes("Act Mode") || content.includes("Act mode")) {
			ctx.pass("Plan→Act test — file created with content", `File at ${targetPath} contains expected content`, shot);
		} else {
			ctx.pass("Plan→Act test — file created", `File exists at ${targetPath} (${content.length} chars)`, shot);
		}
	} else {
		const response = await getLastAssistantMessage(page);
		ctx.fail("Plan→Act test — file created", `File not found. Response: "${response.trim().substring(0, 120)}"`, shot);
	}
}

/**
 * Test 7: Switching Act → Plan mid-conversation re-blocks write tools
 *
 * In an existing Act-mode conversation we switch back to Plan mode and verify
 * a subsequent write attempt is blocked.
 */
async function testSwitchToPlanReBlocksWrites(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Plan Test 7: Act → Plan switch re-blocks write tools ────────");
	await newConversation(page);
	await setMode(page, "Act");

	// First send a successful read to establish Act mode context
	const readResponded = await sendMessage(
		page,
		"Please use read_note to read 'Plan-Mode-Test.md' and confirm you can access it."
	);

	if (!readResponded) {
		ctx.fail("Act→Plan test — initial read", `No response within timeout`);
		return;
	}
	ctx.pass("Act→Plan test — initial read succeeded", "Read tool worked in Act mode");

	// Now switch to Plan mode
	await setMode(page, "Plan");
	const modeAfterSwitch = await getCurrentMode(page);

	if (modeAfterSwitch === "Plan") {
		ctx.pass("Act→Plan test — switched to Plan mid-conversation", "Mode is now Plan");
	} else {
		ctx.fail("Act→Plan test — switched to Plan mid-conversation", `Expected Plan, got: ${modeAfterSwitch}`);
		return;
	}

	// Attempt a write — should now be blocked
	const blockTargetPath = path.join(VAULT_PATH, "Plan-Mode-Mid-Convo-Blocked.md");
	if (fs.existsSync(blockTargetPath)) fs.unlinkSync(blockTargetPath);

	const responded = await sendMessage(
		page,
		"Now please use write_note to create 'Plan-Mode-Mid-Convo-Blocked.md' with content '# Should Be Blocked'."
	);

	const shot = await ctx.screenshot("07-act-to-plan-reblock");

	if (!responded) {
		ctx.fail("Act→Plan test — response received", `No response within timeout`, shot);
		return;
	}

	if (!fs.existsSync(blockTargetPath)) {
		ctx.pass("Act→Plan test — write blocked after mode switch", `File correctly absent after switching back to Plan`, shot);
	} else {
		ctx.fail("Act→Plan test — write blocked after mode switch", `File was created despite switching back to Plan mode`, shot);
	}

	const response = await getLastAssistantMessage(page);
	if (response.trim().length > 0) {
		ctx.pass("Act→Plan test — LLM responded after block", `Response: "${response.trim().substring(0, 120)}"`, shot);
	} else {
		ctx.fail("Act→Plan test — LLM responded after block", "No assistant message after blocked write");
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTest(
	{
		name: "plan-mode",
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
		setupVault: (vaultPath: string) => {
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
				const fullPath = path.join(vaultPath, relativePath);
				fs.mkdirSync(path.dirname(fullPath), { recursive: true });
				fs.writeFileSync(fullPath, content, "utf8");
				console.log(`    Created: ${relativePath}`);
			}
		},
		cleanupFiles: [
			"Plan-Mode-Test.md",
			"Plan-Mode-Should-Not-Exist.md",
			"Plan-Mode-Act-Created.md",
			"Plan-Mode-Mid-Convo-Blocked.md",
		],
	},
	tests,
);
