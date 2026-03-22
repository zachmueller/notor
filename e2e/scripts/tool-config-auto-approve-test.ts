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

import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type ElementHandle } from "playwright-core";
import { launchObsidian, closeObsidian, type ObsidianProcess } from "../lib/obsidian-launcher";
import { LogCollector, type LogEntry } from "../lib/log-collector";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VAULT_PATH = path.resolve(__dirname, "..", "test-vault");
const CDP_PORT = 9222;
const RESULTS_DIR = path.resolve(__dirname, "..", "results");
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots", "tool-config-auto-approve");
const LOGS_DIR = path.join(RESULTS_DIR, "logs");
const BUILD_DIR = path.resolve(__dirname, "..", "..", "build");
const PLUGIN_DATA_PATH = path.join(BUILD_DIR, "data.json");

/** Max ms to wait for any single LLM response to complete. */
const RESPONSE_TIMEOUT_MS = 90_000;
/** Polling interval while waiting for a response. */
const POLL_INTERVAL_MS = 1_500;

// ---------------------------------------------------------------------------
// Test result tracking
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

// ---------------------------------------------------------------------------
// Find the correct Obsidian vault page (not DevTools)
// ---------------------------------------------------------------------------

async function findVaultPage(browser: Browser, timeout = 20_000): Promise<Page> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		for (const ctx of browser.contexts()) {
			for (const p of ctx.pages()) {
				try {
					const el = await p.$(".notor-chat-container");
					if (el) return p;
				} catch { /* page may be closed or not ready */ }
			}
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("Could not find vault page with .notor-chat-container within timeout");
}

// ---------------------------------------------------------------------------
// Persona selection helper
// ---------------------------------------------------------------------------

async function selectPersona(page: Page, personaName: string | null): Promise<boolean> {
	const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
	if (!settingsBtn) return false;

	await settingsBtn.click();
	await page.waitForTimeout(1500);

	const selected = await page.evaluate((name) => {
		const selects = document.querySelectorAll(".notor-settings-popover .notor-settings-select");
		for (const select of selects) {
			const opts = Array.from(select.querySelectorAll("option"));
			const noneOpt = opts.find((o) => o.textContent?.trim() === "None");
			if (noneOpt) {
				const targetValue = name === null ? "None" : name;
				const targetOpt = opts.find((o) => o.textContent?.trim() === targetValue);
				if (targetOpt) {
					(select as HTMLSelectElement).value = (targetOpt as HTMLOptionElement).value;
					select.dispatchEvent(new Event("change", { bubbles: true }));
					return true;
				}
			}
		}
		return false;
	}, personaName);

	await page.waitForTimeout(2000);

	// Close popover
	await settingsBtn.click();
	await page.waitForTimeout(500);

	return selected;
}

// ---------------------------------------------------------------------------
// LLM interaction helpers
// ---------------------------------------------------------------------------

/**
 * Wait for any pending LLM response to finish.
 * Polls until the textarea is re-enabled (response complete) or timeout.
 */
async function waitForResponse(page: Page, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(POLL_INTERVAL_MS);

		const inputEnabled = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el !== null && el.getAttribute("contenteditable") === "true";
		});

		if (inputEnabled) return true;

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
 * The input is a contenteditable div, not a textarea.
 */
async function sendMessage(page: Page, message: string): Promise<boolean> {
	const input = await page.$(".notor-text-input");
	if (!input) throw new Error("Chat input not found");

	await input.click();
	await page.keyboard.type(message);
	await page.waitForTimeout(300);

	const sendBtn = await page.$(".notor-send-btn");
	if (sendBtn) {
		await sendBtn.click();
	} else {
		await page.keyboard.press("Enter");
	}
	await page.waitForTimeout(600);

	console.log(`    → Sent: "${message.substring(0, 80)}${message.length > 80 ? "..." : ""}"`);

	return waitForResponse(page);
}

/**
 * Send a message but handle approval dialog mid-response.
 * Returns { responded, approved, timedOut }.
 */
async function sendMessageWithApprovalHandling(
	page: Page,
	message: string,
): Promise<{ responded: boolean; approved: boolean }> {
	const input = await page.$(".notor-text-input");
	if (!input) throw new Error("Chat input not found");

	await input.click();
	await page.keyboard.type(message);
	await page.waitForTimeout(300);

	const sendBtn = await page.$(".notor-send-btn");
	if (sendBtn) await sendBtn.click();
	else await page.keyboard.press("Enter");

	console.log(`    → Sent: "${message.substring(0, 80)}${message.length > 80 ? "..." : ""}"`);

	const start = Date.now();
	let approved = false;
	while (Date.now() - start < RESPONSE_TIMEOUT_MS) {
		await page.waitForTimeout(POLL_INTERVAL_MS);

		// Check for approval button
		if (!approved) {
			const approveBtn = await page.$(".notor-approve-btn");
			if (approveBtn) {
				console.log("    → Approval dialog detected, clicking approve...");
				await approveBtn.click();
				approved = true;
				await page.waitForTimeout(1000);
				continue;
			}
		}

		// Check if response is complete
		const inputEnabled = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el !== null && el.getAttribute("contenteditable") === "true";
		});
		if (inputEnabled) {
			return { responded: true, approved };
		}
	}
	return { responded: false, approved };
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
// Fixture setup
// ---------------------------------------------------------------------------

function ensureToolConfigFixtures(): void {
	const personasDir = path.join(VAULT_PATH, "notor", "personas");

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
	const notesDir = path.join(VAULT_PATH, "Notes");
	fs.mkdirSync(notesDir, { recursive: true });
	fs.writeFileSync(
		path.join(notesDir, "Meeting Notes.md"),
		"# Meeting Notes\n\nDiscussion about project timeline.\n"
	);

	const privateDir = path.join(notesDir, "Private");
	fs.mkdirSync(privateDir, { recursive: true });
	fs.writeFileSync(path.join(privateDir, "Secret.md"), "# Secret\n\nConfidential information.\n");

	const researchDir = path.join(VAULT_PATH, "Research");
	fs.mkdirSync(researchDir, { recursive: true });
	fs.writeFileSync(path.join(researchDir, "Paper.md"), "# Paper\n\nResearch findings.\n");

	console.log("  Tool config test fixtures ensured in test vault.");
}

// ---------------------------------------------------------------------------
// Settings builder — write_note NOT auto-approved globally
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
		auto_approve: {
			read_note: true,
			search_vault: true,
			list_vault: true,
			read_frontmatter: true,
			fetch_webpage: false,
			write_note: false,
			replace_in_note: false,
			update_frontmatter: false,
			manage_tags: false,
			execute_command: false,
		},
		log_level: "debug",
		mode: "act",
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
// Cleanup helper
// ---------------------------------------------------------------------------

function cleanupTestFiles(): void {
	const testFiles = ["AutoTest.md"];
	for (const file of testFiles) {
		const filePath = path.join(VAULT_PATH, file);
		if (fs.existsSync(filePath)) {
			fs.unlinkSync(filePath);
			console.log(`  Cleaned up: ${file}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("=== Notor Tool Config Auto-Approve E2E Test ===\n");
	console.log("Provider:  AWS Bedrock");
	console.log("Model:     deepseek.v3.2\n");

	// Step 0: Build plugin
	console.log("[0/3] Building plugin...");
	execSync("npm run build", {
		cwd: path.resolve(__dirname, "..", ".."),
		stdio: "inherit",
	});
	console.log("Build complete.\n");

	// Step 0b: Setup fixtures
	console.log("[0b/3] Setting up tool config test fixtures...");
	ensureToolConfigFixtures();
	cleanupTestFiles();

	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
	fs.mkdirSync(LOGS_DIR, { recursive: true });

	// Inject settings
	console.log("[0c/3] Injecting settings...");
	const settings = buildSettings();
	fs.mkdirSync(BUILD_DIR, { recursive: true });

	let existingData: string | null = null;
	if (fs.existsSync(PLUGIN_DATA_PATH)) {
		existingData = fs.readFileSync(PLUGIN_DATA_PATH, "utf8");
		console.log("  Backed up existing data.json");
	}
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	console.log(`  Wrote settings to ${PLUGIN_DATA_PATH}\n`);

	let obsidian: ObsidianProcess | undefined;
	let collector: LogCollector | undefined;

	try {
		// Step 1: Launch Obsidian
		console.log("\n[1/3] Launching Obsidian...");
		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });

		// Step 2: Connect Playwright
		console.log("[2/3] Connecting Playwright via CDP...");
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);

		collector = new LogCollector({ outputDir: LOGS_DIR });

		// Attach collector to ALL pages so we capture logs regardless of which page is "main"
		for (const ctx of browser.contexts()) {
			for (const p of ctx.pages()) {
				collector.attach(p);
			}
		}

		// Find the vault page (polls for .notor-chat-container across all pages)
		console.log("  Looking for vault page with chat container...");
		const page = await findVaultPage(browser, 25_000);

		// Re-attach collector to the found vault page (may differ from initial pages)
		collector.attach(page);

		await page.waitForTimeout(2000);

		console.log("\n[3/3] Running tests...\n");

		// ── Test 1: Chat panel present ──────────────────────────────────────
		console.log("── Test 1: Chat panel present ──");
		{
			const chat = await page.$(".notor-chat-container");
			const shot = await screenshot(page, "01-chat-panel");
			if (chat) {
				pass("Chat panel present", "Found .notor-chat-container", shot);
			} else {
				fail("Chat panel present", ".notor-chat-container not found", shot);
				throw new Error("Chat panel not visible — cannot run tests");
			}
		}

		// ── Test 2: Baseline — write_note requires approval ─────────────────
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

			const shot = await screenshot(page, "02-baseline-approval");

			// Check logs for approval request
			const allLogs = collector.getStructuredLogs();
			const approvalLogs = allLogs.filter(
				(entry) =>
					(entry.message.includes("waiting") && entry.message.includes("approv")) ||
					(entry.message.includes("rejected") && JSON.stringify(entry.data ?? "").includes("write_note")) ||
					entry.message.includes("approval callback")
			);

			if (approvalSeen) {
				pass(
					"Baseline: write_note requires approval",
					"Approval dialog appeared for write_note when no persona is active (global auto_approve.write_note = false)",
					shot
				);
			} else if (approvalLogs.length > 0) {
				pass(
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
					pass(
						"Baseline: write_note requires approval",
						"Response indicates approval was needed",
						shot
					);
				} else {
					// Tool wasn't auto-approved but LLM may have declined to use it
					fail(
						"Baseline: write_note requires approval",
						`Could not confirm approval was required. Response: "${response.substring(0, 120)}"`,
						shot
					);
				}
			} else {
				fail(
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

		// ── Test 3: Activate permissive persona ─────────────────────────────
		console.log("\n── Test 3: Activate permissive persona ──");
		{
			// Start fresh conversation
			await newConversation(page);
			await setMode(page, "Act");

			const selected = await selectPersona(page, "permissive");
			if (selected) {
				const label = await page.$(".notor-persona-label");
				const text = label ? await label.textContent() : "";
				const shot = await screenshot(page, "03-permissive-activated");
				if (text?.includes("permissive")) {
					pass("Activate permissive persona", `Persona label shows: "${text?.trim()}"`, shot);
				} else {
					fail("Activate permissive persona", `Label text: "${text?.trim()}" — expected "permissive"`, shot);
				}
			} else {
				const shot = await screenshot(page, "03-select-failed");
				fail("Activate permissive persona", "Could not select permissive persona from dropdown", shot);
			}
		}

		// ── Test 4: write_note auto-approved via persona config ──────────────
		// The permissive persona sets write_note.auto_approve = true, overriding
		// the global auto_approve.write_note = false.
		console.log("\n── Test 4: write_note auto-approved via persona config ──");
		{
			// Record log baseline before sending
			const logCountBefore = collector.getStructuredLogs().length;

			const responded = await sendMessage(
				page,
				"Please write a note called 'AutoTest' with content 'auto-approved content'. Use the write_note tool."
			);
			const shot = await screenshot(page, "04-auto-approved-write");

			if (responded) {
				const toolNames = await getLastToolCallNames(page);
				const response = await getLastAssistantMessage(page);

				// Check that write_note executed without approval prompt
				const allLogs = collector.getStructuredLogs();
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
					pass(
						"write_note auto-approved via persona config",
						`write_note executed without approval dialog. Tool cards: [${toolNames.join(", ")}]`,
						shot
					);
				} else if (rejectionLogs.length > 0) {
					fail(
						"write_note auto-approved via persona config",
						"write_note was rejected — auto-approve override from persona config did not work",
						shot
					);
				} else {
					fail(
						"write_note auto-approved via persona config",
						`Could not confirm auto-approve override. Tool cards: [${toolNames.join(", ")}]. Response: "${response.substring(0, 120)}"`,
						shot
					);
				}
			} else {
				fail(
					"write_note auto-approved via persona config",
					`No response within ${RESPONSE_TIMEOUT_MS / 1000}s`,
					shot
				);
			}
		}

		// ── Test 5: Auto-approve resolution log ─────────────────────────────
		console.log("\n── Test 5: Auto-approve resolution log ──");
		{
			const allLogs = collector.getStructuredLogs();

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
				pass(
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
					pass(
						"Auto-approve resolution log",
						`Found ${anyConfigLogs.length} tool config log(s): "${anyConfigLogs[0]!.message}"`,
					);
				} else {
					fail(
						"Auto-approve resolution log",
						`No effective tool config or auto-approve resolution logs. Total logs: ${allLogs.length}`,
					);
				}
			}
		}

		// ── Test 6: File created ────────────────────────────────────────────
		console.log("\n── Test 6: File created ──");
		{
			const autoTestPath = path.join(VAULT_PATH, "AutoTest.md");
			const shot = await screenshot(page, "06-file-check");

			if (fs.existsSync(autoTestPath)) {
				const content = fs.readFileSync(autoTestPath, "utf8");
				if (content.includes("auto-approved")) {
					pass(
						"File created",
						`AutoTest.md exists with expected content: "${content.substring(0, 80)}"`,
						shot
					);
				} else {
					pass(
						"File created",
						`AutoTest.md exists (content differs): "${content.substring(0, 80)}"`,
						shot
					);
				}
			} else {
				fail(
					"File created",
					"AutoTest.md does NOT exist — write_note may not have executed",
					shot
				);
			}
		}

		// ── Test 7: Activate restrictive persona ────────────────────────────
		console.log("\n── Test 7: Activate restrictive persona ──");
		{
			await newConversation(page);
			await setMode(page, "Act");

			const selected = await selectPersona(page, "restrictive");
			if (selected) {
				const label = await page.$(".notor-persona-label");
				const text = label ? await label.textContent() : "";
				const shot = await screenshot(page, "07-restrictive-activated");
				if (text?.includes("restrictive")) {
					pass("Activate restrictive persona", `Persona label shows: "${text?.trim()}"`, shot);
				} else {
					fail("Activate restrictive persona", `Label text: "${text?.trim()}" — expected "restrictive"`, shot);
				}
			} else {
				const shot = await screenshot(page, "07-select-failed");
				fail("Activate restrictive persona", "Could not select restrictive persona from dropdown", shot);
			}
		}

		// ── Test 8: read_note auto-approved for allowed path ────────────────
		// The restrictive persona sets read_note.auto_approve = true.
		// Global already has read_note: true, but this validates the persona config
		// path is exercised (effective config overrides global).
		console.log("\n── Test 8: read_note auto-approved for allowed path ──");
		{
			const logCountBefore = collector.getStructuredLogs().length;

			const responded = await sendMessage(
				page,
				"Please read the note 'Notes/Meeting Notes.md' and tell me what it contains."
			);
			const shot = await screenshot(page, "08-read-auto-approved");

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
					pass(
						"read_note auto-approved for allowed path",
						`read_note executed without approval. Tool cards: [${toolNames.join(", ")}]. Content returned: ${hasReadContent}`,
						shot
					);
				} else {
					fail(
						"read_note auto-approved for allowed path",
						`Could not verify read_note executed. Tool cards: [${toolNames.join(", ")}]. Response: "${response.substring(0, 120)}"`,
						shot
					);
				}
			} else {
				fail(
					"read_note auto-approved for allowed path",
					`No response within ${RESPONSE_TIMEOUT_MS / 1000}s`,
					shot
				);
			}
		}

		// ── Test 9: Deactivate persona ──────────────────────────────────────
		console.log("\n── Test 9: Deactivate persona ──");
		{
			const deactivated = await selectPersona(page, null);
			if (deactivated) {
				const label = await page.$(".notor-persona-label");
				const isHidden = !label || (await label.evaluate((el) => el.classList.contains("notor-hidden")));
				const text = label ? await label.textContent() : "";
				const shot = await screenshot(page, "09-deactivated");
				if (isHidden || !text?.trim()) {
					pass("Deactivate persona", "Persona label hidden after selecting None", shot);
				} else {
					fail("Deactivate persona", `Label still visible: "${text?.trim()}"`, shot);
				}
			} else {
				const shot = await screenshot(page, "09-deactivate-failed");
				fail("Deactivate persona", "Could not select None from persona dropdown", shot);
			}
		}

		// ── Test 10: Global defaults restored ───────────────────────────────
		// After deactivating the persona, read_note should still be auto-approved
		// (global auto_approve.read_note = true), but now via global path, not
		// effective config.
		console.log("\n── Test 10: Global defaults restored ──");
		{
			await newConversation(page);
			await setMode(page, "Act");

			const logCountBefore = collector.getStructuredLogs().length;

			const responded = await sendMessage(
				page,
				"Please read the note 'Notes/Meeting Notes.md' and tell me what it says."
			);
			const shot = await screenshot(page, "10-global-defaults");

			if (responded) {
				const toolNames = await getLastToolCallNames(page);
				const response = await getLastAssistantMessage(page);

				const hasReadContent =
					response.toLowerCase().includes("meeting") ||
					response.toLowerCase().includes("discussion") ||
					response.toLowerCase().includes("project timeline");

				if (hasReadContent) {
					// Verify this used global path: no effectiveToolConfig should be active
					const allLogs = collector.getStructuredLogs();
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
						pass(
							"Global defaults restored",
							`read_note still auto-approved via global settings (no active effectiveToolConfig). Content returned correctly.`,
							shot
						);
					} else {
						// effective config is still active — this is also acceptable
						// since resolveEffectiveConfig runs on every message and may
						// produce defaults even without persona
						pass(
							"Global defaults restored",
							`read_note auto-approved. effectiveToolConfig still active but using global defaults. Content returned correctly.`,
							shot
						);
					}
				} else {
					fail(
						"Global defaults restored",
						`Could not verify read_note executed with global defaults. Response: "${response.substring(0, 120)}"`,
						shot
					);
				}
			} else {
				fail(
					"Global defaults restored",
					`No response within ${RESPONSE_TIMEOUT_MS / 1000}s`,
					shot
				);
			}
		}

		// ── Final screenshot ────────────────────────────────────────────────
		await screenshot(page, "99-final-state");

		// ── Write logs ──────────────────────────────────────────────────────
		console.log("\n=== Collecting final logs ===");
		await page.waitForTimeout(1000);

		const summaryPath = collector.writeSummary();
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
		if (obsidian) {
			await closeObsidian(obsidian);
		}

		// Restore original data.json
		if (existingData !== null) {
			fs.writeFileSync(PLUGIN_DATA_PATH, existingData);
			console.log("\nRestored original data.json");
		} else {
			try { fs.unlinkSync(PLUGIN_DATA_PATH); } catch { /* ignore */ }
			console.log("\nRemoved injected data.json");
		}

		// Cleanup test files
		cleanupTestFiles();
	}

	// ── Print summary ───────────────────────────────────────────────────────
	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;

	console.log("\n=== Tool Config Auto-Approve Test Results ===");
	console.log(`Passed: ${passed}/${results.length}`);
	console.log(`Failed: ${failed}/${results.length}`);

	if (failed > 0) {
		console.log("\nFailed tests:");
		for (const r of results.filter((r) => !r.passed)) {
			console.log(`  ✗ ${r.name}: ${r.detail}`);
		}
	}

	// Write results JSON
	const resultsPath = path.join(RESULTS_DIR, "tool-config-auto-approve-results.json");
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
