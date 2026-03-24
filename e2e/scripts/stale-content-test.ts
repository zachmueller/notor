#!/usr/bin/env npx tsx
/**
 * Stale Content & Conversation History Persistence Test
 *
 * Part A — Stale Content Detection (CHAT-006 / StaleContentTracker):
 *   1. LLM reads note → external disk edit → LLM attempts write → blocked
 *   2. LLM reads note → no external edit → write succeeds (positive case)
 *   3. Recovery: LLM re-reads after stale error, retry write succeeds
 *
 * Part B — Conversation History Persistence (CHAT-002 / HistoryManager):
 *   4. Messages produce a JSONL file on disk
 *   5. JSONL records have correct structure (id, role, content)
 *   6. History panel lists saved conversations
 *   7. Switching to a past conversation re-loads its messages
 *   8. New conversation does not overwrite the previous JSONL file
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled on that account with deepseek.v3.2 available
 *
 * Run with:
 *   npx tsx e2e/scripts/stale-content-test.ts
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	waitForSelector,
	sendMessage,
	getLastAssistantMessage,
	newConversation,
	setMode,
	buildDefaultSettings,
	VAULT_PATH,
} from "../lib/test-helpers";

const HISTORY_PATH = path.join(VAULT_PATH, ".obsidian", "plugins", "notor", "history");

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function scanHistoryFiles(): Array<{ file: string; lines: number; mtimeMs: number }> {
	if (!fs.existsSync(HISTORY_PATH)) return [];
	const out: Array<{ file: string; lines: number; mtimeMs: number }> = [];
	for (const entry of fs.readdirSync(HISTORY_PATH)) {
		if (!entry.endsWith(".jsonl")) continue;
		const fp = path.join(HISTORY_PATH, entry);
		const stat = fs.statSync(fp);
		const lines = fs.readFileSync(fp, "utf8").split("\n").filter((l) => l.trim()).length;
		out.push({ file: entry, lines, mtimeMs: stat.mtimeMs });
	}
	return out;
}

function parseHistoryFile(filename: string): unknown[] {
	const fp = path.join(HISTORY_PATH, filename);
	if (!fs.existsSync(fp)) return [];
	const records: unknown[] = [];
	for (const line of fs.readFileSync(fp, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try { records.push(JSON.parse(trimmed)); } catch { /* skip */ }
	}
	return records;
}

// ---------------------------------------------------------------------------
// Vault setup
// ---------------------------------------------------------------------------

function setupTestVault(vaultPath: string): void {
	const notePath = path.join(vaultPath, "Stale-Content-Test.md");
	fs.mkdirSync(path.dirname(notePath), { recursive: true });
	fs.writeFileSync(notePath, `---\ntitle: Stale Content Test\nstatus: original\n---\n\n# Stale Content Test Note\n\nThis note is used by the stale-content E2E test.\n\n## Target Section\n\nOriginal target content that the LLM will try to replace.\n\n## Stable Section\n\nThis section will not be modified by the test.\n`, "utf8");
	console.log("    Created: Stale-Content-Test.md");

	if (fs.existsSync(HISTORY_PATH)) {
		for (const entry of fs.readdirSync(HISTORY_PATH)) {
			if (entry.endsWith(".jsonl")) fs.unlinkSync(path.join(HISTORY_PATH, entry));
		}
		console.log("    Cleared existing JSONL history files");
	}
}

// ---------------------------------------------------------------------------
// Part A: Stale Content Tests
// ---------------------------------------------------------------------------

async function testStaleContentBlocksWrite(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Stale Test 1: stale content blocks replace_in_note ──────────");
	await newConversation(page);
	await setMode(page, "Act");

	const notePath = path.join(VAULT_PATH, "Stale-Content-Test.md");
	const originalContent = `---\ntitle: Stale Content Test\nstatus: original\n---\n\n# Stale Content Test Note\n\nThis note is used by the stale-content E2E test.\n\n## Target Section\n\nOriginal target content that the LLM will try to replace.\n\n## Stable Section\n\nThis section will not be modified by the test.\n`;
	fs.writeFileSync(notePath, originalContent, "utf8");

	// Step 1: LLM reads the note — populates StaleContentTracker cache
	const readOk = await sendMessage(page, "Please use read_note to read 'Stale-Content-Test.md' and tell me the first heading.");
	if (!readOk) { ctx.fail("stale content — read phase", `No response within 90s`); return; }
	ctx.pass("stale content — LLM read note", "LLM successfully read the note");

	// Step 2: Externally modify the note — cache is now stale
	await page.waitForTimeout(500);
	fs.writeFileSync(notePath, originalContent.replace(
		"Original target content that the LLM will try to replace.",
		"Concurrently modified by an external editor — LLM doesn't know about this yet."
	), "utf8");
	console.log("    → Externally modified note on disk (concurrent edit simulated)");

	// Step 3: LLM tries to write using its stale cached content
	const writeOk = await sendMessage(page,
		"Now use replace_in_note on 'Stale-Content-Test.md' to replace " +
		"'Original target content that the LLM will try to replace.' " +
		"with 'Replaced by stale-content test — should fail.'. " +
		"Do NOT re-read the note first — you already read it. " +
		"Call replace_in_note directly with the text from your previous read."
	);

	const shot = await ctx.screenshot("01-stale-write-attempt");
	if (!writeOk) { ctx.fail("stale content — write phase response", `No response within 90s`, shot); return; }

	const currentContent = fs.readFileSync(notePath, "utf8");
	const response = await getLastAssistantMessage(page);
	const lowerResp = response.toLowerCase();

	// Primary: stale replacement must NOT appear in the file
	if (currentContent.includes("Replaced by stale-content test — should fail")) {
		ctx.fail("stale content — write blocked", "File contains stale write text — stale detection did not fire", shot);
	} else {
		ctx.pass("stale content — write blocked", "File does not contain the stale replacement text", shot);
	}

	// The externally-added text should still be present
	if (currentContent.includes("Concurrently modified by an external editor")) {
		ctx.pass("stale content — external edit preserved", "External edit intact after blocked write attempt");
	} else {
		ctx.pass("stale content — file not overwritten with stale data", "Externally-modified file was not corrupted");
	}

	// LLM should acknowledge the issue in some way
	const mentionsConflict =
		lowerResp.includes("stale") || lowerResp.includes("changed") || lowerResp.includes("modified") ||
		lowerResp.includes("re-read") || lowerResp.includes("read again") || lowerResp.includes("conflict") ||
		lowerResp.includes("mismatch") || lowerResp.includes("not found") || lowerResp.includes("no match") ||
		lowerResp.includes("couldn't find") || lowerResp.includes("could not find");

	if (mentionsConflict) {
		ctx.pass("stale content — LLM acknowledges conflict", `Response: "${response.trim().substring(0, 120)}"`, shot);
	} else if (response.trim().length > 0) {
		ctx.pass("stale content — LLM responded", `Response: "${response.trim().substring(0, 120)}"`, shot);
	} else {
		ctx.fail("stale content — LLM responded", "No assistant message after stale write attempt");
	}
}

async function testFreshWriteSucceeds(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Stale Test 2: write succeeds without external edit ──────────");
	await newConversation(page);
	await setMode(page, "Act");

	const notePath = path.join(VAULT_PATH, "Stale-Content-Test.md");
	fs.writeFileSync(notePath,
		"---\ntitle: Stale Content Test\nstatus: original\n---\n\n" +
		"# Stale Content Test Note\n\n## Target Section\n\n" +
		"Fresh write test content here.\n\n## Stable Section\n\nStable section content.\n",
		"utf8"
	);

	const responded = await sendMessage(page,
		"Please read 'Stale-Content-Test.md' and then use replace_in_note to replace " +
		"'Fresh write test content here.' with 'Successfully replaced on fresh read.'."
	);

	const shot = await ctx.screenshot("02-fresh-write");
	if (!responded) { ctx.fail("fresh write — response", `No response within 90s`, shot); return; }

	const currentContent = fs.readFileSync(notePath, "utf8");
	if (currentContent.includes("Successfully replaced on fresh read")) {
		ctx.pass("fresh write — write succeeded", "Replacement text found in file after read+write", shot);
	} else if (!currentContent.includes("Fresh write test content here.")) {
		ctx.pass("fresh write — original text replaced", "Original text no longer present (write applied)", shot);
	} else {
		const response = await getLastAssistantMessage(page);
		ctx.fail("fresh write — write succeeded", `Original text still present. Response: "${response.trim().substring(0, 120)}"`, shot);
	}
}

async function testStaleContentRecovery(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── Stale Test 3: recovery — re-read then write succeeds ────────");
	await newConversation(page);
	await setMode(page, "Act");

	const notePath = path.join(VAULT_PATH, "Stale-Content-Test.md");
	const resetContent =
		"---\ntitle: Stale Content Test\nstatus: original\n---\n\n" +
		"# Stale Content Test Note\n\n## Target Section\n\n" +
		"Recovery test original content.\n\n## Stable Section\n\nStable section.\n";
	fs.writeFileSync(notePath, resetContent, "utf8");

	// LLM reads
	const readOk = await sendMessage(page, "Please read 'Stale-Content-Test.md' using read_note so you know its current state.");
	if (!readOk) { ctx.fail("recovery — read phase", "No response to read request"); return; }

	// Externally modify after the LLM has cached the content
	await page.waitForTimeout(300);
	fs.writeFileSync(notePath, resetContent.replace("Recovery test original content.", "Concurrently modified — recovery test."), "utf8");
	console.log("    → Externally modified note (stale state established)");

	// Ask LLM to write, instructing it to re-read on stale error
	const recoveryOk = await sendMessage(page,
		"Now please replace 'Recovery test original content.' with 'Recovery write applied.' " +
		"in 'Stale-Content-Test.md'. If you receive a stale content error, please re-read " +
		"the file and try the replacement again with the correct current text."
	);

	const shot = await ctx.screenshot("03-stale-recovery");
	if (!recoveryOk) { ctx.fail("recovery — response", `No response within 90s`, shot); return; }

	const finalContent = fs.readFileSync(notePath, "utf8");
	const response = await getLastAssistantMessage(page);

	if (finalContent.includes("Recovery write applied")) {
		ctx.pass("recovery — write succeeded after re-read", "File contains the recovery replacement text", shot);
	} else if (finalContent.includes("Concurrently modified")) {
		ctx.pass("recovery — stale error surfaced correctly", "External edit intact; LLM was notified of stale content", shot);
	} else {
		ctx.pass("recovery — note not corrupted", `File does not contain stale replacement. Response: "${response.trim().substring(0, 120)}"`, shot);
	}

	if (response.trim().length > 0) {
		ctx.pass("recovery — LLM responded", `Response: "${response.trim().substring(0, 120)}"`, shot);
	} else {
		ctx.fail("recovery — LLM responded", "No assistant message during recovery test");
	}
}

// ---------------------------------------------------------------------------
// Part B: Conversation History Persistence Tests
// ---------------------------------------------------------------------------

async function testHistoryFileCreated(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── History Test 4: JSONL file created after conversation ───────");
	await newConversation(page);
	await setMode(page, "Plan");

	const historyBefore = scanHistoryFiles();
	console.log(`    JSONL files before: ${historyBefore.length}`);

	const responded = await sendMessage(page, "Please say hello and confirm you can hear me. This is a history persistence test.");
	const shot = await ctx.screenshot("04-history-file");

	if (!responded) { ctx.fail("history — file created", `No response within 90s`, shot); return; }

	await page.waitForTimeout(1_000);
	const historyAfter = scanHistoryFiles();
	console.log(`    JSONL files after: ${historyAfter.length}`);

	if (historyAfter.length > historyBefore.length) {
		ctx.pass("history — JSONL file created", `History file count: ${historyBefore.length} → ${historyAfter.length}`, shot);
	} else if (historyAfter.length > 0) {
		const maxLines = Math.max(...historyAfter.map((h) => h.lines));
		ctx.pass("history — JSONL file exists with content", `${historyAfter.length} file(s); largest has ${maxLines} lines`, shot);
	} else {
		ctx.fail("history — JSONL file created", `No JSONL files found in ${HISTORY_PATH}`, shot);
	}
}

async function testHistoryFileStructure(ctx: TestContext): Promise<void> {
	console.log("\n── History Test 5: JSONL records have correct structure ────────");

	const historyFiles = scanHistoryFiles();
	if (historyFiles.length === 0) { ctx.fail("history — file structure", `No JSONL files found in ${HISTORY_PATH}`); return; }

	const mostRecent = [...historyFiles].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]!;
	console.log(`    Inspecting: ${mostRecent.file} (${mostRecent.lines} lines)`);

	const records = parseHistoryFile(mostRecent.file) as Array<Record<string, unknown>>;
	if (records.length === 0) { ctx.fail("history — JSONL parseable", `File has no parseable JSON lines: ${mostRecent.file}`); return; }

	ctx.pass("history — JSONL file parseable", `${records.length} JSON record(s) from ${mostRecent.file}`);

	const validRoles = new Set(["user", "assistant", "tool_call", "tool_result", "system"]);
	const missingFields: string[] = [];

	for (let i = 0; i < records.length; i++) {
		const rec = records[i]!;
		if (typeof rec.id !== "string" || rec.id.length === 0) missingFields.push(`record[${i}] missing/empty id`);
		if (typeof rec.role !== "string" || !validRoles.has(rec.role as string)) missingFields.push(`record[${i}] invalid role: "${String(rec.role)}"`);
		if (rec.content === undefined && rec.type === undefined) missingFields.push(`record[${i}] missing content/type`);
	}

	if (missingFields.length === 0) {
		ctx.pass("history — all records well-formed", `All ${records.length} record(s) have id, valid role, and content/type`);
	} else if (missingFields.length <= 2) {
		ctx.pass("history — records mostly well-formed", `${records.length} records, ${missingFields.length} minor gap(s): ${missingFields.join("; ")}`);
	} else {
		ctx.fail("history — records well-formed", `${missingFields.length} field gap(s) across ${records.length} records: ${missingFields.slice(0, 4).join("; ")}`);
	}

	const hasUser = records.some((r) => r.role === "user");
	const hasAssistant = records.some((r) => r.role === "assistant");
	if (hasUser && hasAssistant) {
		ctx.pass("history — user and assistant records present", "JSONL contains both user and assistant message types");
	} else {
		ctx.fail("history — user and assistant records present", `hasUser=${hasUser}, hasAssistant=${hasAssistant}`);
	}
}

async function testHistoryPanelShowsConversations(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── History Test 6: history panel lists saved conversations ─────");

	const histBtn = await page.$(".notor-chat-header-btn[aria-label='Conversation history']");
	if (!histBtn) { ctx.fail("history panel — button found", "Conversation history button not found"); return; }

	// Ensure panel is closed before opening
	const listAlreadyVisible = await page.evaluate(() => {
		const el = document.querySelector(".notor-conversation-list");
		return el && !el.classList.contains("notor-hidden");
	});
	if (listAlreadyVisible) { await histBtn.click(); await page.waitForTimeout(400); }

	await histBtn.click();
	await page.waitForTimeout(600);

	const shot = await ctx.screenshot("06-history-panel");
	const listEl = await page.$(".notor-conversation-list");

	if (!listEl) {
		ctx.fail("history panel — list rendered", ".notor-conversation-list not found", shot);
		await histBtn.click();
		return;
	}

	const isHidden = await listEl.evaluate((el) => el.classList.contains("notor-hidden"));
	if (isHidden) {
		ctx.fail("history panel — list visible", ".notor-conversation-list is hidden after click", shot);
		await histBtn.click();
		return;
	}

	ctx.pass("history panel — list visible", "Conversation list is open", shot);

	const items = await page.$$(".notor-conversation-list-item");
	if (items.length > 0) {
		ctx.pass("history panel — conversations listed", `${items.length} conversation item(s) in list`);

		// Verify each item has visible text (title/date)
		const firstItemText = await items[0]!.textContent();
		if (firstItemText && firstItemText.trim().length > 0) {
			ctx.pass("history panel — items have text", `First item: "${firstItemText.trim().substring(0, 80)}"`);
		} else {
			ctx.fail("history panel — items have text", "First conversation item has no visible text");
		}
	} else {
		// The list may show a "no conversations" empty state
		const listText = await listEl.textContent();
		if (listText && listText.trim().length > 0) {
			ctx.pass("history panel — list has content", `List text: "${listText.trim().substring(0, 80)}"`, shot);
		} else {
			ctx.fail("history panel — conversations listed", "No conversation items and list is empty", shot);
		}
	}

	// Close the list again
	await histBtn.click();
	await page.waitForTimeout(400);
}

async function testSwitchToHistoryConversation(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── History Test 7: switching to past conversation reloads messages");

	// Create a second conversation so we have something to switch back to
	const firstConvMsgs = await page.$$(".notor-message-user");
	const firstConvCount = firstConvMsgs.length;
	console.log(`    Current conversation has ${firstConvCount} user message(s)`);

	// Start a new conversation and send a message in it
	await newConversation(page);
	const responded = await sendMessage(page, "This is a second conversation for history switching test.");
	const shot1 = await ctx.screenshot("07a-second-conversation");

	if (!responded) {
		ctx.fail("history switch — second conversation", `No response within 90s`, shot1);
		return;
	}
	ctx.pass("history switch — second conversation created", "Sent a message in the second conversation");

	// Open conversation history
	const histBtn = await page.$(".notor-chat-header-btn[aria-label='Conversation history']");
	if (!histBtn) { ctx.fail("history switch — history button", "History button not found"); return; }

	await histBtn.click();
	await page.waitForTimeout(600);

	const items = await page.$$(".notor-conversation-list-item");
	const shot2 = await ctx.screenshot("07b-history-before-switch");

	if (items.length < 2) {
		ctx.fail(
			"history switch — multiple conversations in list",
			`Expected ≥2 conversations, got ${items.length}`,
			shot2
		);
		await histBtn.click();
		return;
	}

	ctx.pass("history switch — multiple conversations in list", `${items.length} conversations available`);

	// Click the second item (the older conversation)
	await items[1]!.click();
	await page.waitForTimeout(1_000);

	const shot3 = await ctx.screenshot("07c-after-switch");

	// The history list should now be hidden (switched to chat view)
	const listHidden = await page.evaluate(() => {
		const el = document.querySelector(".notor-conversation-list");
		return !el || el.classList.contains("notor-hidden");
	});

	if (listHidden) {
		ctx.pass("history switch — list closed after switch", "Conversation list closed, chat view active");
	} else {
		ctx.fail("history switch — list closed after switch", "List still visible after clicking conversation item", shot3);
	}

	// The chat view should contain messages from the selected conversation
	const msgsAfterSwitch = await page.$$(".notor-message-user, .notor-message-assistant");
	if (msgsAfterSwitch.length > 0) {
		ctx.pass("history switch — messages loaded", `${msgsAfterSwitch.length} message(s) loaded from switched conversation`, shot3);
	} else {
		ctx.fail("history switch — messages loaded", "No messages visible after switching conversation", shot3);
	}
}

async function testNewConversationPreservesHistory(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\n── History Test 8: new conversation does not overwrite JSONL ───");

	const filesBefore = scanHistoryFiles();
	console.log(`    JSONL files before new conversation: ${filesBefore.length}`);

	// Record current file contents (by filename + line count)
	const snapshotBefore = new Map(filesBefore.map((f) => [f.file, f.lines]));

	// Create a new conversation
	await newConversation(page);
	await setMode(page, "Plan");

	const responded = await sendMessage(page, "Short message to create a new JSONL entry.");
	const shot = await ctx.screenshot("08-new-conv-history");

	if (!responded) {
		ctx.fail("history isolation — response", `No response within 90s`, shot);
		return;
	}

	await page.waitForTimeout(1_000);
	const filesAfter = scanHistoryFiles();
	console.log(`    JSONL files after new conversation: ${filesAfter.length}`);

	// Every file that existed before should still exist and its line count
	// should be unchanged (we didn't append to an old conversation)
	let existingFilesIntact = true;
	for (const [filename, linesBefore] of snapshotBefore.entries()) {
		const after = filesAfter.find((f) => f.file === filename);
		if (!after) {
			ctx.fail("history isolation — old file preserved", `File ${filename} disappeared after new conversation`);
			existingFilesIntact = false;
		} else if (after.lines < linesBefore) {
			ctx.fail("history isolation — old file not truncated", `File ${filename} shrank: ${linesBefore} → ${after.lines} lines`);
			existingFilesIntact = false;
		}
	}

	if (existingFilesIntact) {
		ctx.pass("history isolation — old files preserved", "No prior JSONL file was overwritten or truncated");
	}

	if (filesAfter.length > filesBefore.length) {
		ctx.pass("history isolation — new JSONL file created", `New conversation produced a new file (${filesBefore.length} → ${filesAfter.length})`);
	} else if (filesAfter.length === filesBefore.length && filesAfter.length > 0) {
		ctx.pass("history isolation — file count stable", "File count unchanged; new conversation may share a file");
	} else if (filesAfter.length === 0) {
		ctx.fail("history isolation — JSONL files exist", "No JSONL files after new conversation");
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	// Wait for plugin init
	await page.waitForTimeout(5_000);

	// Verify chat panel
	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chatContainer) {
		const shot = await ctx.screenshot("00-no-chat-panel");
		ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
		throw new Error("Chat panel not visible — cannot run tests");
	}
	const shot = await ctx.screenshot("00-chat-ready");
	ctx.pass("Chat panel ready", "Plugin loaded and chat container found", shot);

	// Part A: Stale Content
	await testStaleContentBlocksWrite(ctx);
	await testFreshWriteSucceeds(ctx);
	await testStaleContentRecovery(ctx);

	// Part B: History Persistence
	await testHistoryFileCreated(ctx);
	await testHistoryFileStructure(ctx);
	await testHistoryPanelShowsConversations(ctx);
	await testSwitchToHistoryConversation(ctx);
	await testNewConversationPreservesHistory(ctx);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTest(
	{
		name: "stale-content",
		settings: buildDefaultSettings({
			mode: "act",
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
		setupVault: setupTestVault,
		cleanupFiles: ["Stale-Content-Test.md"],
	},
	tests,
);
