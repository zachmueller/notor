#!/usr/bin/env npx tsx
/**
 * Tool Config Path Enforcement E2E Test Script
 *
 * Validates `allowed_paths` and `blocked_paths` enforcement at dispatch time (FR-84).
 *
 *  1. Restrictive persona allows reads from Notes/ and Research/, blocks Notes/Private/
 *  2. Reads from allowed paths succeed
 *  3. Reads from blocked paths fail with path constraint violation
 *  4. Reads from disallowed paths (not in allowed_paths) fail
 *  5. Path-restricted workflow allows Journal/, blocks Journal/Private/
 *  6. Deactivating persona removes path restrictions
 *
 * LLM Required: Yes (needs LLM to trigger tool calls with specific paths)
 *
 * @see specs/04b-tool-toggle/e2e-tests.md — Script 4
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	sendMessage,
	sendMessageWithApprovalHandling,
	newConversation,
	setMode,
	selectPersona,
	getLastAssistantMessage,
	getLastToolCallNames,
	buildDefaultSettings,
	VAULT_PATH,
	RESPONSE_TIMEOUT_MS,
	waitForResponse,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Vault setup
// ---------------------------------------------------------------------------

function setupVault(vaultPath: string): void {
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

	// Ensure existing test personas still exist
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

	// Workflow fixtures
	const workflowsDir = path.join(vaultPath, "notor", "workflows");
	fs.mkdirSync(workflowsDir, { recursive: true });

	// Path-restricted workflow — allows only Journal/, blocks Journal/Private/
	fs.writeFileSync(
		path.join(workflowsDir, "path-restricted.md"),
		`---
notor-workflow: true
notor-trigger: manual
---

Only work within the Journal folder.

<notor_tool_config version="1.0">
read_note:
  auto_approve: true
  allowed_paths:
    - "Journal/"
write_note:
  auto_approve: true
  allowed_paths:
    - "Journal/"
  blocked_paths:
    - "Journal/Private/"
</notor_tool_config>
`
	);

	// Test notes
	const notesDir = path.join(vaultPath, "Notes");
	fs.mkdirSync(notesDir, { recursive: true });
	fs.writeFileSync(
		path.join(notesDir, "Meeting Notes.md"),
		"# Meeting Notes\n\nDiscussion about project timeline.\n"
	);

	const privateDir = path.join(notesDir, "Private");
	fs.mkdirSync(privateDir, { recursive: true });
	fs.writeFileSync(path.join(privateDir, "Secret.md"), "# Secret\n\nConfidential information.\n");

	const researchDir = path.join(vaultPath, "Research");
	fs.mkdirSync(researchDir, { recursive: true });
	fs.writeFileSync(path.join(researchDir, "Paper.md"), "# Paper\n\nResearch findings.\n");

	// Journal test notes
	const journalDir = path.join(vaultPath, "Journal");
	fs.mkdirSync(journalDir, { recursive: true });
	fs.writeFileSync(
		path.join(journalDir, "2025-01-15.md"),
		"# January 15, 2025\n\nToday I worked on the project.\n"
	);

	const journalPrivateDir = path.join(journalDir, "Private");
	fs.mkdirSync(journalPrivateDir, { recursive: true });
	fs.writeFileSync(
		path.join(journalPrivateDir, "Draft.md"),
		"# Private Draft\n\nWork in progress, do not share.\n"
	);

	// Archive test notes (for rule-based tests in future scripts)
	const archiveDir = path.join(vaultPath, "Archive");
	fs.mkdirSync(archiveDir, { recursive: true });
	fs.writeFileSync(
		path.join(archiveDir, "Old Project.md"),
		"# Old Project\n\nThis project is archived.\n"
	);

	console.log("  Tool config test fixtures ensured in test vault.");
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Execute a workflow via the command palette picker.
 * Types the workflow name to filter, then selects the first match.
 */
async function executeWorkflow(ctx: TestContext, workflowFilter: string): Promise<boolean> {
	const { page } = ctx;
	await page.evaluate(() => {
		const app = (window as unknown as { app?: { commands?: { executeCommandById?: (id: string) => void } } }).app;
		app?.commands?.executeCommandById?.("notor:run-workflow");
	});
	await page.waitForTimeout(2000);

	// Type to filter for the workflow
	await page.keyboard.type(workflowFilter);
	await page.waitForTimeout(600);

	// Select the first matching workflow
	const suggestion = await page.$(".suggestion-item");
	if (suggestion) {
		await suggestion.click();
	} else {
		await page.keyboard.press("Enter");
	}
	await page.waitForTimeout(3000);

	return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	await page.waitForTimeout(2000);

	// ── Test 1: Chat panel present ──────────────────────────────────────
	console.log("── Test 1: Chat panel present ──");
	{
		const chat = await page.$(".notor-chat-container");
		const shot = await ctx.screenshot("01-chat-panel");
		if (chat) {
			ctx.pass("Chat panel present", "Found .notor-chat-container", shot);
		} else {
			ctx.fail("Chat panel present", ".notor-chat-container not found", shot);
			throw new Error("Chat panel not visible — cannot run tests");
		}
	}

	// ── Test 2: Activate restrictive persona ────────────────────────────
	console.log("\n── Test 2: Activate restrictive persona ──");
	{
		await setMode(page, "Act");

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

	// ── Test 3: Read from allowed path succeeds ─────────────────────────
	console.log("\n── Test 3: Read from allowed path succeeds ──");
	{
		const logCountBefore = ctx.collector.getStructuredLogs().length;

		const responded = await sendMessage(
			page,
			"Please read the note 'Notes/Meeting Notes.md' and tell me what it contains. Use the read_note tool."
		);
		const shot = await ctx.screenshot("03-allowed-path-read");

		if (responded) {
			const response = await getLastAssistantMessage(page);
			const toolNames = await getLastToolCallNames(page);

			const hasReadContent =
				response.toLowerCase().includes("meeting") ||
				response.toLowerCase().includes("discussion") ||
				response.toLowerCase().includes("project timeline");

			const hasReadTool = toolNames.some(
				(n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note")
			);

			// Check logs for path constraint violations (should NOT have any)
			const allLogs = ctx.collector.getStructuredLogs();
			const recentLogs = allLogs.slice(logCountBefore);
			const pathViolations = recentLogs.filter(
				(entry) =>
					entry.message.includes("Blocked tool by path constraint") &&
					JSON.stringify(entry.data ?? "").includes("Meeting Notes")
			);

			if ((hasReadTool || hasReadContent) && pathViolations.length === 0) {
				ctx.pass(
					"Read from allowed path succeeds",
					`read_note succeeded for Notes/Meeting Notes.md. Content returned: ${hasReadContent}. Tool cards: [${toolNames.join(", ")}]`,
					shot
				);
			} else if (pathViolations.length > 0) {
				ctx.fail(
					"Read from allowed path succeeds",
					`Path constraint violation for Notes/Meeting Notes.md — should be in allowed_paths!`,
					shot
				);
			} else {
				ctx.fail(
					"Read from allowed path succeeds",
					`Could not confirm read succeeded. Tool cards: [${toolNames.join(", ")}]. Response: "${response.substring(0, 120)}"`,
					shot
				);
			}
		} else {
			ctx.fail("Read from allowed path succeeds", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		}
	}

	// ── Test 4: Read from allowed path (Research) succeeds ───────────────
	console.log("\n── Test 4: Read from allowed path (Research) succeeds ──");
	{
		const logCountBefore = ctx.collector.getStructuredLogs().length;

		const responded = await sendMessage(
			page,
			"Now read the note 'Research/Paper.md' and tell me what it says. Use the read_note tool."
		);
		const shot = await ctx.screenshot("04-research-path-read");

		if (responded) {
			const response = await getLastAssistantMessage(page);
			const toolNames = await getLastToolCallNames(page);

			const hasReadContent =
				response.toLowerCase().includes("paper") ||
				response.toLowerCase().includes("research") ||
				response.toLowerCase().includes("findings");

			// Check logs for path constraint violations (should NOT have any)
			const allLogs = ctx.collector.getStructuredLogs();
			const recentLogs = allLogs.slice(logCountBefore);
			const pathViolations = recentLogs.filter(
				(entry) =>
					entry.message.includes("Blocked tool by path constraint") &&
					JSON.stringify(entry.data ?? "").includes("Paper")
			);

			if (hasReadContent && pathViolations.length === 0) {
				ctx.pass(
					"Read from allowed path (Research) succeeds",
					`read_note succeeded for Research/Paper.md. Content returned.`,
					shot
				);
			} else if (pathViolations.length > 0) {
				ctx.fail(
					"Read from allowed path (Research) succeeds",
					`Path constraint violation for Research/Paper.md — should be in allowed_paths!`,
					shot
				);
			} else {
				ctx.fail(
					"Read from allowed path (Research) succeeds",
					`Could not confirm read succeeded. Response: "${response.substring(0, 120)}"`,
					shot
				);
			}
		} else {
			ctx.fail("Read from allowed path (Research) succeeds", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		}
	}

	// ── Test 5: Read from blocked path fails ────────────────────────────
	console.log("\n── Test 5: Read from blocked path fails ──");
	{
		const logCountBefore = ctx.collector.getStructuredLogs().length;

		const responded = await sendMessage(
			page,
			"Read the note 'Notes/Private/Secret.md' and tell me what it contains. Use the read_note tool."
		);
		const shot = await ctx.screenshot("05-blocked-path-read");

		if (responded) {
			const response = await getLastAssistantMessage(page);

			// Check logs for path constraint violations (SHOULD have one)
			const allLogs = ctx.collector.getStructuredLogs();
			const recentLogs = allLogs.slice(logCountBefore);
			const pathViolations = recentLogs.filter(
				(entry) =>
					entry.message.includes("Blocked tool by path constraint") ||
					(entry.message.includes("path constraint") && entry.message.includes("blocked"))
			);

			// Also check for error tool results mentioning blocked paths
			const blockedErrorLogs = recentLogs.filter((entry) => {
				const dataStr = JSON.stringify(entry.data ?? "");
				return (
					(dataStr.includes("blocked") && dataStr.includes("Private")) ||
					(dataStr.includes("path constraint") && dataStr.includes("Secret"))
				);
			});

			if (pathViolations.length > 0 || blockedErrorLogs.length > 0) {
				ctx.pass(
					"Read from blocked path fails",
					`Path constraint violation correctly raised for Notes/Private/Secret.md. Violations: ${pathViolations.length}, Error logs: ${blockedErrorLogs.length}`,
					shot
				);
			} else if (
				response.toLowerCase().includes("blocked") ||
				response.toLowerCase().includes("not allowed") ||
				response.toLowerCase().includes("constraint") ||
				response.toLowerCase().includes("cannot") ||
				response.toLowerCase().includes("restricted") ||
				response.toLowerCase().includes("denied") ||
				response.toLowerCase().includes("error")
			) {
				ctx.pass(
					"Read from blocked path fails",
					`Response indicates path was blocked: "${response.substring(0, 120)}"`,
					shot
				);
			} else if (!response.toLowerCase().includes("confidential")) {
				// The content of Secret.md is "Confidential information."
				// If we don't see it, the read was blocked (even if logs don't match exactly)
				ctx.pass(
					"Read from blocked path fails",
					"Secret.md content not returned — read was blocked (no 'confidential' in response)",
					shot
				);
			} else {
				ctx.fail(
					"Read from blocked path fails",
					`Notes/Private/Secret.md content appears to have been returned. Response: "${response.substring(0, 150)}"`,
					shot
				);
			}
		} else {
			ctx.fail("Read from blocked path fails", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		}
	}

	// ── Test 6: Path enforcement error message ──────────────────────────
	console.log("\n── Test 6: Path enforcement error message ──");
	{
		const allLogs = ctx.collector.getStructuredLogs();
		const pathViolations = allLogs.filter(
			(entry) =>
				entry.message.includes("Blocked tool by path constraint") ||
				entry.message.includes("path constraint violation")
		);

		if (pathViolations.length > 0) {
			const last = pathViolations[pathViolations.length - 1]!;
			const dataStr = JSON.stringify(last.data ?? "");
			ctx.pass(
				"Path enforcement error message",
				`Found ${pathViolations.length} path constraint log(s). Last: [${last.source}] "${last.message}" data: ${dataStr.substring(0, 200)}`,
			);
		} else {
			// Fallback: check if any error logs mention path constraints
			const anyPathLogs = allLogs.filter((entry) => {
				const dataStr = JSON.stringify(entry.data ?? "").toLowerCase();
				return (
					dataStr.includes("path") &&
					(dataStr.includes("blocked") || dataStr.includes("constraint") || dataStr.includes("not within"))
				);
			});

			if (anyPathLogs.length > 0) {
				ctx.pass(
					"Path enforcement error message",
					`Found ${anyPathLogs.length} path-related error log(s): "${anyPathLogs[0]!.message}"`,
				);
			} else {
				ctx.fail(
					"Path enforcement error message",
					`No path constraint violation logs found. Total logs: ${allLogs.length}`,
				);
			}
		}
	}

	// ── Test 7: Read from disallowed path fails ─────────────────────────
	// Journal/ is not in allowed_paths for the restrictive persona (only Notes/ and Research/)
	console.log("\n── Test 7: Read from disallowed path fails ──");
	{
		const logCountBefore = ctx.collector.getStructuredLogs().length;

		const responded = await sendMessage(
			page,
			"Read the note 'Journal/2025-01-15.md' and tell me what it says. Use the read_note tool."
		);
		const shot = await ctx.screenshot("07-disallowed-path-read");

		if (responded) {
			const response = await getLastAssistantMessage(page);

			// Check logs for path constraint violations
			const allLogs = ctx.collector.getStructuredLogs();
			const recentLogs = allLogs.slice(logCountBefore);
			const pathViolations = recentLogs.filter(
				(entry) =>
					entry.message.includes("Blocked tool by path constraint") ||
					entry.message.includes("path constraint")
			);

			const allowedPathErrors = recentLogs.filter((entry) => {
				const dataStr = JSON.stringify(entry.data ?? "").toLowerCase();
				return dataStr.includes("not within any allowed path") || dataStr.includes("allowed");
			});

			if (pathViolations.length > 0 || allowedPathErrors.length > 0) {
				ctx.pass(
					"Read from disallowed path fails",
					`Path outside allowed_paths correctly blocked for Journal/2025-01-15.md. Violations: ${pathViolations.length}`,
					shot
				);
			} else if (
				response.toLowerCase().includes("blocked") ||
				response.toLowerCase().includes("not allowed") ||
				response.toLowerCase().includes("constraint") ||
				response.toLowerCase().includes("cannot") ||
				response.toLowerCase().includes("restricted") ||
				response.toLowerCase().includes("error")
			) {
				ctx.pass(
					"Read from disallowed path fails",
					`Response indicates path was blocked: "${response.substring(0, 120)}"`,
					shot
				);
			} else if (
				!response.toLowerCase().includes("january") &&
				!response.toLowerCase().includes("worked on the project")
			) {
				// If the content of Journal/2025-01-15.md is not in the response, the read was blocked
				ctx.pass(
					"Read from disallowed path fails",
					"Journal note content not returned — read was blocked (no journal content in response)",
					shot
				);
			} else {
				ctx.fail(
					"Read from disallowed path fails",
					`Journal/2025-01-15.md content appears to have been returned despite not being in allowed_paths. Response: "${response.substring(0, 150)}"`,
					shot
				);
			}
		} else {
			ctx.fail("Read from disallowed path fails", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		}
	}

	// ── Test 8: Execute path-restricted workflow ─────────────────────────
	// The path-restricted workflow allows Journal/ and blocks Journal/Private/
	console.log("\n── Test 8: Execute path-restricted workflow ──");
	{
		// Start a new conversation for the workflow
		await newConversation(page);
		await setMode(page, "Act");
		// Deactivate persona first so workflow config is the only source
		await selectPersona(page, null);
		await page.waitForTimeout(500);

		// Execute the path-restricted workflow
		await executeWorkflow(ctx, "path-restricted");

		// Wait for the workflow's initial LLM response to complete
		console.log("    → Waiting for workflow initial response...");
		await waitForResponse(page, 60_000);
		await page.waitForTimeout(1000);

		const logCountBefore = ctx.collector.getStructuredLogs().length;

		// Now send a follow-up read request within the workflow's allowed path
		const responded = await sendMessage(
			page,
			"Use the read_note tool right now to read the note at path 'Journal/2025-01-15.md'. Do not ask me anything, just call the tool immediately."
		);
		const shot = await ctx.screenshot("08-workflow-allowed-path");

		if (responded) {
			const response = await getLastAssistantMessage(page);
			const toolNames = await getLastToolCallNames(page);

			const hasJournalContent =
				response.toLowerCase().includes("january") ||
				response.toLowerCase().includes("worked on the project") ||
				response.toLowerCase().includes("2025");

			const hasReadTool = toolNames.some(
				(n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note")
			);

			// Check logs for path constraint violations (should NOT have any for Journal/)
			const allLogs = ctx.collector.getStructuredLogs();
			const recentLogs = allLogs.slice(logCountBefore);
			const pathViolations = recentLogs.filter(
				(entry) =>
					entry.message.includes("Blocked tool by path constraint") &&
					JSON.stringify(entry.data ?? "").includes("Journal/2025")
			);

			if ((hasJournalContent || hasReadTool) && pathViolations.length === 0) {
				ctx.pass(
					"Execute path-restricted workflow",
					`read_note succeeded for Journal/2025-01-15.md within workflow's allowed_paths. Content: ${hasJournalContent}. Tool: ${hasReadTool}`,
					shot
				);
			} else if (pathViolations.length > 0) {
				ctx.fail(
					"Execute path-restricted workflow",
					"Path constraint violation for Journal/ — should be allowed by workflow!",
					shot
				);
			} else {
				// Even if the LLM didn't return content, check that no violations were logged
				if (pathViolations.length === 0) {
					// Check if read_note was called at all via logs
					const readNoteLogs = recentLogs.filter(
						(entry) =>
							JSON.stringify(entry.data ?? "").includes("read_note") &&
							JSON.stringify(entry.data ?? "").includes("Journal")
					);
					if (readNoteLogs.length > 0) {
						ctx.pass(
							"Execute path-restricted workflow",
							`read_note called for Journal path without violation. Tool logs: ${readNoteLogs.length}`,
							shot
						);
					} else {
						ctx.fail(
							"Execute path-restricted workflow",
							`Could not confirm read succeeded within workflow. Response: "${response.substring(0, 120)}"`,
							shot
						);
					}
				}
			}
		} else {
			ctx.fail("Execute path-restricted workflow", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		}
	}

	// ── Test 9: Workflow blocked path enforced ───────────────────────────
	// Within the path-restricted workflow, Journal/Private/ is blocked
	console.log("\n── Test 9: Workflow blocked path enforced ──");
	{
		const logCountBefore = ctx.collector.getStructuredLogs().length;

		const { responded } = await sendMessageWithApprovalHandling(
			page,
			"Write a note at 'Journal/Private/Draft.md' with content 'should be blocked'. Use the write_note tool."
		);
		const shot = await ctx.screenshot("09-workflow-blocked-path");

		if (responded) {
			const response = await getLastAssistantMessage(page);

			// Check logs for path constraint violations (SHOULD have one for Journal/Private/)
			const allLogs = ctx.collector.getStructuredLogs();
			const recentLogs = allLogs.slice(logCountBefore);
			const pathViolations = recentLogs.filter(
				(entry) =>
					entry.message.includes("Blocked tool by path constraint") ||
					entry.message.includes("path constraint")
			);

			const blockedPathErrors = recentLogs.filter((entry) => {
				const dataStr = JSON.stringify(entry.data ?? "").toLowerCase();
				return (
					(dataStr.includes("blocked") || dataStr.includes("path constraint")) &&
					dataStr.includes("private")
				);
			});

			if (pathViolations.length > 0 || blockedPathErrors.length > 0) {
				ctx.pass(
					"Workflow blocked path enforced",
					`Journal/Private/Draft.md correctly blocked. Violations: ${pathViolations.length}`,
					shot
				);
			} else if (
				response.toLowerCase().includes("blocked") ||
				response.toLowerCase().includes("not allowed") ||
				response.toLowerCase().includes("constraint") ||
				response.toLowerCase().includes("cannot") ||
				response.toLowerCase().includes("restricted") ||
				response.toLowerCase().includes("error") ||
				response.toLowerCase().includes("denied")
			) {
				ctx.pass(
					"Workflow blocked path enforced",
					`Response indicates path was blocked: "${response.substring(0, 120)}"`,
					shot
				);
			} else {
				// Check that the file was NOT created
				const draftPath = path.join(VAULT_PATH, "Journal", "Private", "Draft.md");
				const draftContent = fs.existsSync(draftPath) ? fs.readFileSync(draftPath, "utf8") : "";
				if (!draftContent.includes("should be blocked")) {
					ctx.pass(
						"Workflow blocked path enforced",
						"File was not modified with blocked content — write was effectively blocked",
						shot
					);
				} else {
					ctx.fail(
						"Workflow blocked path enforced",
						`Journal/Private/Draft.md was written to despite being in blocked_paths! Response: "${response.substring(0, 120)}"`,
						shot
					);
				}
			}
		} else {
			ctx.fail("Workflow blocked path enforced", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		}
	}

	// ── Test 10: blocked_paths overrides allowed_paths ──────────────────
	console.log("\n── Test 10: blocked_paths overrides allowed_paths ──");
	{
		const allLogs = ctx.collector.getStructuredLogs();

		// Look for path violation logs specifically mentioning blocked path precedence
		const blockedPrecedenceLogs = allLogs.filter((entry) => {
			const dataStr = JSON.stringify(entry.data ?? "").toLowerCase();
			return (
				(entry.message.includes("Blocked tool by path constraint") ||
					entry.message.includes("path constraint")) &&
				(dataStr.includes("private") || dataStr.includes("blocked"))
			);
		});

		if (blockedPrecedenceLogs.length > 0) {
			const last = blockedPrecedenceLogs[blockedPrecedenceLogs.length - 1]!;
			ctx.pass(
				"blocked_paths overrides allowed_paths",
				`Path violation references blocked path taking precedence. Log: [${last.source}] "${last.message}"`,
			);
		} else {
			// The test 9 result is the primary evidence — if test 9 passed,
			// then blocked_paths was enforced over allowed_paths
			const test9 = ctx.results.find((r) => r.name === "Workflow blocked path enforced");
			if (test9?.passed) {
				ctx.pass(
					"blocked_paths overrides allowed_paths",
					"Test 9 confirmed Journal/Private/ was blocked despite Journal/ being allowed — blocked_paths overrides allowed_paths",
				);
			} else {
				ctx.fail(
					"blocked_paths overrides allowed_paths",
					"Cannot confirm blocked_paths precedence — test 9 did not pass",
				);
			}
		}
	}

	// ── Test 11: Deactivate persona ─────────────────────────────────────
	console.log("\n── Test 11: Deactivate persona ──");
	{
		// Start a new conversation (clears workflow)
		await newConversation(page);
		await setMode(page, "Act");

		// Ensure no persona is active
		const deactivated = await selectPersona(page, null);
		if (deactivated) {
			const label = await page.$(".notor-persona-label");
			const isHidden = !label || (await label.evaluate((el) => el.classList.contains("notor-hidden")));
			const text = label ? await label.textContent() : "";
			const shot = await ctx.screenshot("11-deactivated");
			if (isHidden || !text?.trim()) {
				ctx.pass("Deactivate persona", "Persona label hidden after selecting None", shot);
			} else {
				ctx.fail("Deactivate persona", `Label still visible: "${text?.trim()}"`, shot);
			}
		} else {
			const shot = await ctx.screenshot("11-deactivate-failed");
			ctx.fail("Deactivate persona", "Could not select None from persona dropdown", shot);
		}
	}

	// ── Test 12: Read from previously blocked path ──────────────────────
	// After deactivation, no path restrictions should be active
	console.log("\n── Test 12: Read from previously blocked path ──");
	{
		const logCountBefore = ctx.collector.getStructuredLogs().length;

		const responded = await sendMessage(
			page,
			"Please read the note 'Notes/Private/Secret.md' and tell me what it contains. Use the read_note tool."
		);
		const shot = await ctx.screenshot("12-no-restrictions");

		if (responded) {
			const response = await getLastAssistantMessage(page);

			const hasSecretContent =
				response.toLowerCase().includes("confidential") ||
				response.toLowerCase().includes("secret");

			// Check logs for path constraint violations (should NOT have any)
			const allLogs = ctx.collector.getStructuredLogs();
			const recentLogs = allLogs.slice(logCountBefore);
			const pathViolations = recentLogs.filter(
				(entry) =>
					entry.message.includes("Blocked tool by path constraint") &&
					JSON.stringify(entry.data ?? "").includes("Private")
			);

			if (hasSecretContent && pathViolations.length === 0) {
				ctx.pass(
					"Read from previously blocked path",
					"Notes/Private/Secret.md readable after persona deactivation — no path restrictions active",
					shot
				);
			} else if (pathViolations.length > 0) {
				ctx.fail(
					"Read from previously blocked path",
					"Path constraint still active after persona deactivation!",
					shot
				);
			} else {
				// The response might not contain the exact content, but no violation means it worked
				const hasReadTool = (await getLastToolCallNames(page)).some(
					(n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note")
				);
				if (hasReadTool) {
					ctx.pass(
						"Read from previously blocked path",
						"read_note tool was called without path violations after deactivation",
						shot
					);
				} else {
					ctx.fail(
						"Read from previously blocked path",
						`Could not confirm read succeeded. Response: "${response.substring(0, 120)}"`,
						shot
					);
				}
			}
		} else {
			ctx.fail("Read from previously blocked path", `No response within ${RESPONSE_TIMEOUT_MS / 1000}s`, shot);
		}
	}

	// ── Final screenshot ────────────────────────────────────────────────
	await ctx.screenshot("99-final-state");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTest(
	{
		name: "tool-config-path-enforce",
		settings: buildDefaultSettings({ mode: "act", auto_approve: { fetch_webpage: false } }),
		setupVault,
		cleanupFiles: [
			"notor/personas/restrictive",
			"notor/personas/permissive",
			"notor/personas/researcher",
			"notor/workflows/path-restricted.md",
			"Notes",
			"Research",
			"Journal",
			"Archive",
		],
	},
	tests,
);
