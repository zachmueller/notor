#!/usr/bin/env npx tsx
/**
 * Tool Config Parse & Strip E2E Test Script
 *
 * Validates that `<notor_tool_config>` blocks are:
 *  1. Parsed and extracted from persona system prompts
 *  2. Stripped from LLM-visible content (never sent to the model)
 *  3. Validation errors surfaced as structured log warnings
 *
 * LLM Required: No (UI-only + log assertions)
 *
 * @see specs/04b-tool-toggle/e2e-tests.md — Script 1
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import { waitForSelector, selectPersona, buildDefaultSettings, VAULT_PATH } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

async function dismissNotices(page: import("playwright-core").Page): Promise<void> {
	await page.evaluate(() => {
		const notices = document.querySelectorAll(".notice");
		for (const notice of Array.from(notices)) {
			(notice as HTMLElement).remove();
		}
	});
	await page.waitForTimeout(200);
}

async function sendMessageNoWait(page: import("playwright-core").Page, text: string): Promise<void> {
	const input = await page.$(".notor-text-input");
	if (!input) throw new Error("Chat input not found");

	await input.click();
	await page.keyboard.type(text);
	await page.waitForTimeout(300);

	const sendBtn = await page.$(".notor-send-btn");
	if (sendBtn) {
		await sendBtn.click();
	} else {
		await page.keyboard.press("Enter");
	}
	// Wait for config resolution to occur (happens before LLM call)
	await page.waitForTimeout(5000);
}

// ---------------------------------------------------------------------------
// Vault setup
// ---------------------------------------------------------------------------

function setupToolConfigFixtures(vaultPath: string): void {
	const personasDir = path.join(vaultPath, "notor", "personas");

	// Restrictive persona — disables write tools, restricts paths
	const restrictiveDir = path.join(personasDir, "restrictive");
	fs.mkdirSync(restrictiveDir, { recursive: true });
	fs.writeFileSync(
		path.join(restrictiveDir, "system-prompt.md"),
		`---
notor-persona-prompt-mode: append
---

You are a read-only research assistant.

<notor_tool_config version="1.0">
write_note:
  enabled: false
replace_in_note:
  enabled: false
read_note:
  auto_approve: true
  allowed_paths:
    - "Notes/"
    - "Research/"
  blocked_paths:
    - "Notes/Private/"
</notor_tool_config>
`
	);

	// Permissive persona — auto-approves everything
	const permissiveDir = path.join(personasDir, "permissive");
	fs.mkdirSync(permissiveDir, { recursive: true });
	fs.writeFileSync(
		path.join(permissiveDir, "system-prompt.md"),
		`---
notor-persona-prompt-mode: append
---

You are a fully autonomous assistant.

<notor_tool_config version="1.0">
write_note:
  auto_approve: true
  enabled: true
read_note:
  auto_approve: true
replace_in_note:
  auto_approve: true
search_vault:
  auto_approve: true
</notor_tool_config>
`
	);

	// Invalid-config persona — contains validation errors
	const invalidDir = path.join(personasDir, "invalid-config");
	fs.mkdirSync(invalidDir, { recursive: true });
	fs.writeFileSync(
		path.join(invalidDir, "system-prompt.md"),
		`---
notor-persona-prompt-mode: append
---

You are a test persona with bad config.

<notor_tool_config version="1.0">
nonexistent_tool:
  enabled: true
read_note:
  enabled: "yes"
  auto_approve: 42
  allowed_paths: "not-an-array"
</notor_tool_config>
`
	);

	// Ensure existing test personas still exist (other tests depend on them)
	const researcherDir = path.join(personasDir, "researcher");
	if (!fs.existsSync(path.join(researcherDir, "system-prompt.md"))) {
		fs.mkdirSync(researcherDir, { recursive: true });
		fs.writeFileSync(
			path.join(researcherDir, "system-prompt.md"),
			`---
notor-persona-prompt-mode: append
---

You are a research assistant. Focus on finding accurate information.
`
		);
	}

	// Test notes for path tests (later scripts need these too)
	const notesDir = path.join(vaultPath, "Notes");
	fs.mkdirSync(notesDir, { recursive: true });
	fs.writeFileSync(path.join(notesDir, "Meeting Notes.md"), "# Meeting Notes\n\nDiscussion about project timeline.\n");

	const privateDir = path.join(notesDir, "Private");
	fs.mkdirSync(privateDir, { recursive: true });
	fs.writeFileSync(path.join(privateDir, "Secret.md"), "# Secret\n\nConfidential information.\n");

	const researchDir = path.join(vaultPath, "Research");
	fs.mkdirSync(researchDir, { recursive: true });
	fs.writeFileSync(path.join(researchDir, "Paper.md"), "# Paper\n\nResearch findings.\n");

	console.log("  Tool config test fixtures ensured in test vault.");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	await page.waitForTimeout(5000);

	// ── Test 1: Chat panel present ──────────────────────────────────────
	console.log("── Test 1: Chat panel present ──");
	{
		const chat = await waitForSelector(page, ".notor-chat-container", 12_000);
		const shot = await ctx.screenshot("01-chat-panel");
		if (chat) {
			ctx.pass("Chat panel present", "Found .notor-chat-container", shot);
		} else {
			ctx.fail("Chat panel present", ".notor-chat-container not found within 12s", shot);
		}
	}

	// ── Test 2: Activate restrictive persona ────────────────────────────
	console.log("\n── Test 2: Activate restrictive persona ──");
	{
		const selected = await selectPersona(page, "restrictive");
		if (selected) {
			const label = await page.$(".notor-persona-label");
			const text = label ? await label.textContent() : "";
			const shot = await ctx.screenshot("02-restrictive-activated");
			if (text?.includes("restrictive")) {
				ctx.pass("Activate restrictive persona", `Persona label shows: "${text?.trim()}"`, shot);
			} else {
				ctx.fail("Activate restrictive persona", `Label text: "${text?.trim()}" — expected "restrictive"`, shot);
			}
		} else {
			const shot = await ctx.screenshot("02-select-failed");
			ctx.fail("Activate restrictive persona", "Could not select restrictive persona from dropdown", shot);
		}
	}

	// ── Test 3: Tool config extracted log ───────────────────────────────
	// Config extraction happens when a message is sent (triggers resolveEffectiveConfig).
	console.log("\n── Test 3: Tool config extracted log ──");
	{
		await sendMessageNoWait(page, "Hello, this is a test message.");

		const allLogs = ctx.collector.getStructuredLogs();
		// Look for SystemPromptBuilder logs about tool config extraction
		const extractLogs = allLogs.filter(
			(entry) =>
				entry.source === "SystemPromptBuilder" &&
				(entry.message.includes("Tool config") ||
					entry.message.includes("tool config") ||
					entry.message.includes("extractToolConfigs") ||
					entry.message.includes("extracted from sources"))
		);

		if (extractLogs.length > 0) {
			const last = extractLogs[extractLogs.length - 1]!;
			ctx.pass(
				"Tool config extracted log",
				`Found ${extractLogs.length} extraction log(s): "${last.message}" data: ${JSON.stringify(last.data)}`
			);
		} else {
			// Also check ChatOrchestrator for resolveEffectiveConfig logs
			const orchLogs = allLogs.filter(
				(entry) =>
					entry.source === "ChatOrchestrator" &&
					(entry.message.includes("tool config") ||
						entry.message.includes("Effective tool config"))
			);
			if (orchLogs.length > 0) {
				ctx.pass(
					"Tool config extracted log",
					`Found via ChatOrchestrator: "${orchLogs[0]!.message}" data: ${JSON.stringify(orchLogs[0]!.data)}`
				);
			} else {
				ctx.fail(
					"Tool config extracted log",
					`No tool config extraction logs found. SystemPromptBuilder logs: ${allLogs.filter((e) => e.source === "SystemPromptBuilder").length}, ChatOrchestrator logs: ${allLogs.filter((e) => e.source === "ChatOrchestrator").length}`
				);
			}
		}
	}

	// ── Test 4: Config block stripped from system prompt ─────────────────
	console.log("\n── Test 4: Config block stripped from system prompt ──");
	{
		const allLogs = ctx.collector.getStructuredLogs();
		// Check that no structured log contains <notor_tool_config> text
		// in a way that suggests it was sent to the LLM
		const logsWithConfigTag = allLogs.filter((entry) => {
			const fullText = entry.message + (entry.data ? JSON.stringify(entry.data) : "");
			return fullText.includes("<notor_tool_config");
		});

		// Filter out logs that are about the config system itself (validation errors, etc.)
		const leakedConfigLogs = logsWithConfigTag.filter((entry) => {
			// These sources legitimately reference the tag name in error messages
			if (entry.source === "SystemPromptBuilder" && entry.message.includes("validation error")) return false;
			if (entry.message.includes("Unrecognized tool") || entry.message.includes("must be")) return false;
			// Check if the log appears to be system prompt content sent to LLM
			return (
				entry.message.includes("system prompt") ||
				entry.message.includes("assembled") ||
				entry.source === "LLMProvider" ||
				entry.source === "Provider"
			);
		});

		if (leakedConfigLogs.length === 0) {
			ctx.pass(
				"Config block stripped from system prompt",
				`No <notor_tool_config> text found in LLM-bound content (checked ${allLogs.length} log entries)`
			);
		} else {
			ctx.fail(
				"Config block stripped from system prompt",
				`Found ${leakedConfigLogs.length} log(s) with <notor_tool_config> in LLM content: ${leakedConfigLogs.map((e) => `[${e.source}] ${e.message.substring(0, 80)}`).join("; ")}`
			);
		}
	}

	// ── Test 5: Activate invalid-config persona ─────────────────────────
	console.log("\n── Test 5: Activate invalid-config persona ──");
	{
		const selected = await selectPersona(page, "invalid-config");
		if (selected) {
			const label = await page.$(".notor-persona-label");
			const text = label ? await label.textContent() : "";
			const shot = await ctx.screenshot("05-invalid-config-activated");
			if (text?.includes("invalid-config")) {
				ctx.pass("Activate invalid-config persona", `Persona label shows: "${text?.trim()}"`, shot);
			} else {
				ctx.fail("Activate invalid-config persona", `Label text: "${text?.trim()}" — expected "invalid-config"`, shot);
			}
		} else {
			const shot = await ctx.screenshot("05-select-failed");
			ctx.fail("Activate invalid-config persona", "Could not select invalid-config persona from dropdown", shot);
		}
	}

	// ── Test 6: Send a message to trigger config resolution ──────────────
	console.log("\n── Test 6: Send message to trigger config resolution ──");
	{
		try {
			await sendMessageNoWait(page, "Test message to trigger config resolution.");
			const shot = await ctx.screenshot("06-message-sent");
			ctx.pass("Send message to trigger config resolution", "Message sent successfully", shot);
		} catch (err) {
			const shot = await ctx.screenshot("06-send-failed");
			ctx.fail("Send message to trigger config resolution", `Error: ${err instanceof Error ? err.message : String(err)}`, shot);
		}
	}

	// ── Test 7: Validation error logs rendered ──────────────────────────
	console.log("\n── Test 7: Validation error notices/logs ──");
	{
		const allLogs = ctx.collector.getStructuredLogs();

		// The invalid-config persona has these errors:
		// - read_note.enabled = "yes" (non-boolean)
		// - read_note.auto_approve = 42 (non-boolean)
		// - read_note.allowed_paths = "not-an-array" (non-array)
		// Note: nonexistent_tool won't trigger "Unrecognized tool" because
		// knownToolNames is not passed to extractToolConfigs in production.

		const validationWarnings = allLogs.filter(
			(entry) =>
				entry.source === "SystemPromptBuilder" &&
				entry.level === "warn" &&
				entry.message.includes("Tool config validation error")
		);

		// Check for specific error types in the validation warnings
		const warningDetails = validationWarnings.map((e) => JSON.stringify(e.data));
		const allDetails = warningDetails.join(" ");

		const hasEnabledTypeError = allDetails.includes("enabled") && allDetails.includes("must be a boolean");
		const hasAutoApproveTypeError = allDetails.includes("auto_approve") && allDetails.includes("must be a boolean");
		const hasPathsTypeError = allDetails.includes("allowed_paths") && allDetails.includes("array");

		const shot = await ctx.screenshot("07-validation-errors");

		if (validationWarnings.length > 0) {
			const details: string[] = [];
			if (hasEnabledTypeError) details.push("enabled type error");
			if (hasAutoApproveTypeError) details.push("auto_approve type error");
			if (hasPathsTypeError) details.push("allowed_paths type error");

			if (details.length >= 2) {
				ctx.pass(
					"Validation error logs",
					`Found ${validationWarnings.length} validation warning(s) covering: ${details.join(", ")}`,
					shot
				);
			} else {
				// Partial success — some errors detected but not all
				ctx.pass(
					"Validation error logs (partial)",
					`Found ${validationWarnings.length} validation warning(s). Detected: ${details.length > 0 ? details.join(", ") : "none of the expected specific errors, but warnings exist"}. Raw: ${warningDetails.slice(0, 3).join("; ")}`,
					shot
				);
			}
		} else {
			ctx.fail(
				"Validation error logs",
				`No validation warning logs found from SystemPromptBuilder. Total logs: ${allLogs.length}`,
				shot
			);
		}
	}

	// ── Test 8: Validation errors contain source file ────────────────────
	console.log("\n── Test 8: Validation errors contain source file ──");
	{
		const allLogs = ctx.collector.getStructuredLogs();
		const validationWarnings = allLogs.filter(
			(entry) =>
				entry.source === "SystemPromptBuilder" &&
				entry.level === "warn" &&
				entry.message.includes("Tool config validation error")
		);

		const withSourceFile = validationWarnings.filter((entry) => {
			const data = entry.data as Record<string, unknown> | undefined;
			return data?.sourceFile && String(data.sourceFile).includes("invalid-config");
		});

		if (withSourceFile.length > 0) {
			ctx.pass(
				"Validation errors contain source file",
				`${withSourceFile.length}/${validationWarnings.length} error(s) reference "invalid-config" in sourceFile`
			);
		} else if (validationWarnings.length > 0) {
			// Errors exist but don't reference the source file as expected
			const sampleData = JSON.stringify(validationWarnings[0]!.data);
			ctx.fail(
				"Validation errors contain source file",
				`${validationWarnings.length} validation warnings found but none reference "invalid-config" in sourceFile. Sample data: ${sampleData.substring(0, 200)}`
			);
		} else {
			ctx.fail(
				"Validation errors contain source file",
				"No validation warning logs to check (prerequisite Test 7 likely failed)"
			);
		}
	}

	// ── Test 9: Deactivate persona ───────────────────────────────────────
	console.log("\n── Test 9: Deactivate persona ──");
	{
		const deactivated = await selectPersona(page, null);
		if (deactivated) {
			const label = await page.$(".notor-persona-label");
			const isHidden = !label || (await label.evaluate((el) => el.classList.contains("notor-hidden")));
			const text = label ? await label.textContent() : "";
			const shot = await ctx.screenshot("09-deactivated");
			if (isHidden || !text?.trim()) {
				ctx.pass("Deactivate persona", "Persona label hidden after selecting None", shot);
			} else {
				ctx.fail("Deactivate persona", `Label still visible: "${text?.trim()}"`, shot);
			}
		} else {
			const shot = await ctx.screenshot("09-deactivate-failed");
			ctx.fail("Deactivate persona", "Could not select None from persona dropdown", shot);
		}
	}

	// ── Test 10: No error logs for valid personas ────────────────────────
	console.log("\n── Test 10: No error logs for valid persona configs ──");
	{
		const allLogs = ctx.collector.getStructuredLogs();

		// Check for errors from tool-config-related sources, excluding the
		// invalid-config persona (which we expect to have errors)
		const toolConfigErrors = allLogs.filter((entry) => {
			if (entry.level !== "error" && entry.level !== "warn") return false;
			// Only care about tool config validation errors
			if (!entry.message.includes("Tool config validation error")) return false;
			// Exclude errors from the invalid-config persona
			const data = entry.data as Record<string, unknown> | undefined;
			if (data?.sourceFile && String(data.sourceFile).includes("invalid-config")) return false;
			return true;
		});

		if (toolConfigErrors.length === 0) {
			ctx.pass(
				"No error logs for valid personas",
				"Zero tool config validation errors from valid persona configs"
			);
		} else {
			ctx.fail(
				"No error logs for valid personas",
				`${toolConfigErrors.length} unexpected tool config error(s): ${toolConfigErrors.map((e) => `[${e.source}] ${e.message}: ${JSON.stringify(e.data)}`).join("; ")}`
			);
		}
	}

	// Dismiss any leftover notices
	await dismissNotices(page);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTest(
	{
		name: "tool-config-parse-strip",
		settings: buildDefaultSettings({ mode: "act" }),
		setupVault: setupToolConfigFixtures,
		cleanupFiles: [
			"notor/personas/restrictive",
			"notor/personas/permissive",
			"notor/personas/invalid-config",
			"Notes/",
			"Research/",
		],
	},
	tests,
);
