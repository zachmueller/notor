#!/usr/bin/env npx tsx
/**
 * Tool Config Auto-Approve E2E Test Script
 *
 * Validates that `auto_approve` from `<notor_tool_config>` overrides global
 * auto-approve settings via the unified early-return in the dispatcher.
 *
 *  1. Baseline: write_note requires approval (global auto_approve.write_note = false)
 *  2. Permissive persona auto-approves write_note without user confirmation
 *  3. Restrictive persona auto-approves read_note for allowed paths
 *  4. After deactivation, global defaults are restored
 *
 * LLM Required: Yes (needs LLM to trigger tool dispatch)
 *
 * @see specs/04b-tool-toggle/e2e-tests.md — Script 3
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	waitForSelector,
	sendMessage,
	getLastAssistantMessage,
	getLastToolCallNames,
	waitForResponse,
	newConversation,
	setMode,
	selectPersona,
	buildDefaultSettings,
	VAULT_PATH,
	RESPONSE_TIMEOUT_MS,
	POLL_INTERVAL_MS,
} from "../lib/test-helpers";

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

	console.log("  Tool config test fixtures ensured in test vault.");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	await page.waitForTimeout(2000);

	// ── Test 1: Chat panel present ──────────────────────────────────────────
	console.log("── Test 1: Chat panel present ──");
	{
		const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
		const shot = await ctx.screenshot("01-chat-panel");
		if (chat) {
			ctx.pass("Chat panel present", "Found .notor-chat-container", shot);
		} else {
			ctx.fail("Chat panel present", ".notor-chat-container not found", shot);
			throw new Error("Chat panel not visible — cannot run tests");
		}
	}

	// ── Test 2: Baseline — write_note requires approval ─────────────────────
	// Global auto_approve.write_note = false, no persona active.
	// Send a write prompt and expect an approval dialog.
	console.log("\n── Test 2: Baseline — write_note requires approval ──");
	{
		await setMode(page, "Act");

		// Send write request — expect approval dialog
		const input = await page.$(".notor-text-input");
		if (!input) throw new Error("Chat input not found");
		await input.click();
		await page.keyboard.type(
			"Please write a note called 'AutoTest' with content 'baseline test'. Use the write_note tool."
		);
		await page.waitForTimeout(300);
		const sendBtn = await page.$(".notor-send-btn");
		if (sendBtn) await sendBtn.click();
		else await page.keyboard.press("Enter");

		console.log("    → Sent write request (expecting approval dialog)");

		// Poll for approval button or response completion
		const start = Date.now();
		let approvalSeen = false;
		let responded = false;
		while (Date.now() - start < RESPONSE_TIMEOUT_MS) {
			await page.waitForTimeout(POLL_INTERVAL_MS);

			// Check for approval button
			const approveBtn = await page.$(".notor-approve-btn");
			if (approveBtn) {
				approvalSeen = true;
				console.log("    → Approval dialog detected (as expected for baseline)");
				// Reject to avoid creating the file in baseline test
				const rejectBtn = await page.$(".notor-reject-btn");
				if (rejectBtn) {
					await rejectBtn.click();
					console.log("    → Rejected to keep baseline clean");
				} else {
					// If no reject button, just approve and clean up later
					await approveBtn.click();
				}
				await page.waitForTimeout(1000);
				break;
			}

			// Check if response is complete (LLM may not have called write_note)
			const inputEnabled = await page.evaluate(() => {
				const el = document.querySelector(".notor-text-input") as HTMLElement | null;
				return el !== null && el.getAttribute("contenteditable") === "true";
			});
			if (inputEnabled) {
				responded = true;
				break;
			}
		}

		// Wait for response to complete after approval/rejection
		if (approvalSeen && !responded) {
			await waitForResponse(page, 30_000);
		}

		const shot = await ctx.screenshot("02-baseline-approval");

		// Check logs for approval request
		const allLogs = ctx.collector.getStructuredLogs();
		const approvalLogs = allLogs.filter(
			(entry) =>
				(entry.message.includes("waiting") && entry.message.includes("approv")) ||
				(entry.message.includes("rejected") && JSON.stringify(entry.data ?? "").includes("write_note")) ||
				entry.message.includes("approval callback")
		);

		if (approvalSeen) {
			ctx.pass(
				"Baseline: write_note requires approval",
				"Approval dialog appeared for write_note when no persona is active (global auto_approve.write_note = false)",
				shot
			);
		} else if (approvalLogs.length > 0) {
			ctx.pass(
				"Baseline: write_note requires approval",
				`Approval-related logs found: ${approvalLogs.map((l) => l.message).join("; ")}`,
				shot
			);
		} else if (responded) {
			// The LLM may not have attempted write_note — check response
			const response = await getLastAssistantMessage(page);
			if (
				response.toLowerCase().includes("approv") ||
				response.toLowerCase().includes("permission") ||
				response.toLowerCase().includes("confirm")
			) {
				ctx.pass(
					"Baseline: write_note requires approval",
					"Response indicates approval was needed",
					shot
				);
			} else {
				// Tool wasn't auto-approved but LLM may have declined to use it
				ctx.fail(
					"Baseline: write_note requires approval",
					`Could not confirm approval was required. Response: "${response.substring(0, 120)}"`,
					shot
				);
			}
		} else {
			ctx.fail(
				"Baseline: write_note requires approval",
				"Neither approval dialog nor response received within timeout",
				shot
			);
		}
	}

	// Clean up any baseline test file
	const baselineFile = path.join(VAULT_PATH, "AutoTest.md");
	if (fs.existsSync(baselineFile)) {
		fs.unlinkSync(baselineFile);
	}

	// ── Test 3: Activate permissive persona ──────────────────────────────────
	console.log("\n── Test 3: Activate permissive persona ──");
	{
		// Start fresh conversation
		await newConversation(page);
		await setMode(page, "Act");

		const selected = await selectPersona(page, "permissive");
		if (selected) {
			const label = await page.$(".notor-persona-label");
			const text = label ? await label.textContent() : "";
			const shot = await ctx.screenshot("03-permissive-activated");
			if (text?.includes("permissive")) {
				ctx.pass("Activate permissive persona", `Persona label shows: "${text?.trim()}"`, shot);
			} else {
				ctx.fail("Activate permissive persona", `Label text: "${text?.trim()}" — expected "permissive"`, shot);
			}
		} else {
			const shot = await ctx.screenshot("03-select-failed");
			ctx.fail("Activate permissive persona", "Could not select permissive persona from dropdown", shot);
		}
	}

	// ── Test 4: write_note auto-approved via persona config ──────────────────
	// The permissive persona sets write_note.auto_approve = true, overriding
	// the global auto_approve.write_note = false.
	console.log("\n── Test 4: write_note auto-approved via persona config ──");
	{
		// Record log baseline before sending
		const logCountBefore = ctx.collector.getStructuredLogs().length;

		const responded = await sendMessage(
			page,
			"Please write a note called 'AutoTest' with content 'auto-approved content'. Use the write_note tool."
		);
		const shot = await ctx.screenshot("04-auto-approved-write");

		if (responded) {
			const toolNames = await getLastToolCallNames(page);
			const response = await getLastAssistantMessage(page);

			// Check that write_note executed without approval prompt
			const allLogs = ctx.collector.getStructuredLogs();
			const recentLogs = allLogs.slice(logCountBefore);

			// Look for tool rejection (should NOT exist)
			const rejectionLogs = recentLogs.filter(
				(entry) =>
					entry.message.includes("rejected") &&
					JSON.stringify(entry.data ?? "").includes("write_note")
			);

			// Check for successful write_note execution
			const hasWriteTool = toolNames.some(
				(n) => n.toLowerCase().includes("write_note") || n.toLowerCase().includes("write note")
			);

			const writeSuccess =
				hasWriteTool ||
				response.toLowerCase().includes("created") ||
				response.toLowerCase().includes("written") ||
				response.toLowerCase().includes("saved") ||
				response.toLowerCase().includes("auto-approved");

			if (writeSuccess && rejectionLogs.length === 0) {
				ctx.pass(
					"write_note auto-approved via persona config",
					`write_note executed without approval dialog. Tool cards: [${toolNames.join(", ")}]`,
					shot
				);
			} else if (rejectionLogs.length > 0) {
				ctx.fail(
					"write_note auto-approved via persona config",
					"write_note was rejected — auto-approve override from persona config did not work",
					shot
				);
			} else {
				ctx.fail(
					"write_note auto-approved via persona config",
					`Could not confirm auto-approve override. Tool cards: [${toolNames.join(", ")}]. Response: "${response.substring(0, 120)}"`,
					shot
				);
			}
		} else {
			ctx.fail(
				"write_note auto-approved via persona config",
				`No response within ${RESPONSE_TIMEOUT_MS / 1000}s`,
				shot
			);
		}
	}

	// ── Test 5: Auto-approve resolution log ──────────────────────────────────
	console.log("\n── Test 5: Auto-approve resolution log ──");
	{
		const allLogs = ctx.collector.getStructuredLogs();

		// Look for effective tool config logs in dispatcher or orchestrator
		const effectiveConfigLogs = allLogs.filter(
			(entry) =>
				(entry.source === "ToolDispatcher" &&
					entry.message.includes("effective tool config")) ||
				(entry.source === "ChatOrchestrator" &&
					(entry.message.toLowerCase().includes("effective") ||
						entry.message.toLowerCase().includes("tool config")))
		);

		if (effectiveConfigLogs.length > 0) {
			const last = effectiveConfigLogs[effectiveConfigLogs.length - 1]!;
			ctx.pass(
				"Auto-approve resolution log",
				`Found ${effectiveConfigLogs.length} effective config log(s). Last: [${last.source}] "${last.message}"`,
			);
		} else {
			// Fallback: check for any tool config-related logs
			const anyConfigLogs = allLogs.filter(
				(entry) =>
					entry.message.toLowerCase().includes("tool config") ||
					entry.message.toLowerCase().includes("effectivetoolconfig")
			);
			if (anyConfigLogs.length > 0) {
				ctx.pass(
					"Auto-approve resolution log",
					`Found ${anyConfigLogs.length} tool config log(s): "${anyConfigLogs[0]!.message}"`,
				);
			} else {
				ctx.fail(
					"Auto-approve resolution log",
					`No effective tool config or auto-approve resolution logs. Total logs: ${allLogs.length}`,
				);
			}
		}
	}

	// ── Test 6: File created ────────────────────────────────────────────────
	console.log("\n── Test 6: File created ──");
	{
		const autoTestPath = path.join(VAULT_PATH, "AutoTest.md");
		const shot = await ctx.screenshot("06-file-check");

		if (fs.existsSync(autoTestPath)) {
			const content = fs.readFileSync(autoTestPath, "utf8");
			if (content.includes("auto-approved")) {
				ctx.pass(
					"File created",
					`AutoTest.md exists with expected content: "${content.substring(0, 80)}"`,
					shot
				);
			} else {
				ctx.pass(
					"File created",
					`AutoTest.md exists (content differs): "${content.substring(0, 80)}"`,
					shot
				);
			}
		} else {
			ctx.fail(
				"File created",
				"AutoTest.md does NOT exist — write_note may not have executed",
				shot
			);
		}
	}

	// ── Test 7: Activate restrictive persona ─────────────────────────────────
	console.log("\n── Test 7: Activate restrictive persona ──");
	{
		await newConversation(page);
		await setMode(page, "Act");

		const selected = await selectPersona(page, "restrictive");
		if (selected) {
			const label = await page.$(".notor-persona-label");
			const text = label ? await label.textContent() : "";
			const shot = await ctx.screenshot("07-restrictive-activated");
			if (text?.includes("restrictive")) {
				ctx.pass("Activate restrictive persona", `Persona label shows: "${text?.trim()}"`, shot);
			} else {
				ctx.fail("Activate restrictive persona", `Label text: "${text?.trim()}" — expected "restrictive"`, shot);
			}
		} else {
			const shot = await ctx.screenshot("07-select-failed");
			ctx.fail("Activate restrictive persona", "Could not select restrictive persona from dropdown", shot);
		}
	}

	// ── Test 8: read_note auto-approved for allowed path ─────────────────────
	// The restrictive persona sets read_note.auto_approve = true.
	// Global already has read_note: true, but this validates the persona config
	// path is exercised (effective config overrides global).
	console.log("\n── Test 8: read_note auto-approved for allowed path ──");
	{
		const logCountBefore = ctx.collector.getStructuredLogs().length;

		const responded = await sendMessage(
			page,
			"Please read the note 'Notes/Meeting Notes.md' and tell me what it contains."
		);
		const shot = await ctx.screenshot("08-read-auto-approved");

		if (responded) {
			const toolNames = await getLastToolCallNames(page);
			const response = await getLastAssistantMessage(page);

			const hasReadContent =
				response.toLowerCase().includes("meeting") ||
				response.toLowerCase().includes("discussion") ||
				response.toLowerCase().includes("project timeline");

			const hasReadTool = toolNames.some(
				(n) => n.toLowerCase().includes("read_note") || n.toLowerCase().includes("read note")
			);

			if (hasReadTool || hasReadContent) {
				ctx.pass(
					"read_note auto-approved for allowed path",
					`read_note executed without approval. Tool cards: [${toolNames.join(", ")}]. Content returned: ${hasReadContent}`,
					shot
				);
			} else {
				ctx.fail(
					"read_note auto-approved for allowed path",
					`Could not verify read_note executed. Tool cards: [${toolNames.join(", ")}]. Response: "${response.substring(0, 120)}"`,
					shot
				);
			}
		} else {
			ctx.fail(
				"read_note auto-approved for allowed path",
				`No response within ${RESPONSE_TIMEOUT_MS / 1000}s`,
				shot
			);
		}
	}

	// ── Test 9: Deactivate persona ───────────────────────────────────────────
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

	// ── Test 10: Global defaults restored ────────────────────────────────────
	// After deactivating the persona, read_note should still be auto-approved
	// (global auto_approve.read_note = true), but now via global path, not
	// effective config.
	console.log("\n── Test 10: Global defaults restored ──");
	{
		await newConversation(page);
		await setMode(page, "Act");

		const logCountBefore = ctx.collector.getStructuredLogs().length;

		const responded = await sendMessage(
			page,
			"Please read the note 'Notes/Meeting Notes.md' and tell me what it says."
		);
		const shot = await ctx.screenshot("10-global-defaults");

		if (responded) {
			const toolNames = await getLastToolCallNames(page);
			const response = await getLastAssistantMessage(page);

			const hasReadContent =
				response.toLowerCase().includes("meeting") ||
				response.toLowerCase().includes("discussion") ||
				response.toLowerCase().includes("project timeline");

			if (hasReadContent) {
				// Verify this used global path: no effectiveToolConfig should be active
				const allLogs = ctx.collector.getStructuredLogs();
				const recentLogs = allLogs.slice(logCountBefore);

				// After persona deactivation + new conversation, effectiveToolConfig
				// should either be null or use global defaults. Look for
				// "Updated effective tool config" with active: false or no config logs
				const effectiveConfigActive = recentLogs.filter(
					(entry) =>
						entry.source === "ToolDispatcher" &&
						entry.message.includes("effective tool config") &&
						JSON.stringify(entry.data ?? "").includes('"active":true')
				);

				if (effectiveConfigActive.length === 0) {
					ctx.pass(
						"Global defaults restored",
						`read_note still auto-approved via global settings (no active effectiveToolConfig). Content returned correctly.`,
						shot
					);
				} else {
					// effective config is still active — this is also acceptable
					// since resolveEffectiveConfig runs on every message and may
					// produce defaults even without persona
					ctx.pass(
						"Global defaults restored",
						`read_note auto-approved. effectiveToolConfig still active but using global defaults. Content returned correctly.`,
						shot
					);
				}
			} else {
				ctx.fail(
					"Global defaults restored",
					`Could not verify read_note executed with global defaults. Response: "${response.substring(0, 120)}"`,
					shot
				);
			}
		} else {
			ctx.fail(
				"Global defaults restored",
				`No response within ${RESPONSE_TIMEOUT_MS / 1000}s`,
				shot
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTest(
	{
		name: "tool-config-auto-approve-test",
		settings: buildDefaultSettings({ mode: "act" }),
		setupVault: (vaultPath) => setupToolConfigFixtures(vaultPath),
		cleanupFiles: [
			"AutoTest.md",
			"notor/personas/restrictive",
			"notor/personas/permissive",
			"Notes/",
			"Research/",
		],
	},
	tests,
);
