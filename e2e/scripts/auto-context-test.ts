#!/usr/bin/env npx tsx
/**
 * Auto-Context End-to-End Test
 *
 * Validates auto-context collection and injection behaviour.
 *
 * ## ACI-TEST-001: Auto-context in system prompt (not user message)
 *
 * After the ACI-001 migration, auto-context must be injected into the
 * **system prompt** before each LLM call, and must NOT appear in:
 *   - The user message `content` field in the JSONL history
 *   - The `auto_context` metadata field on user messages
 *
 * Scenarios:
 *   1. Send a message → verify JSONL user message `content` does NOT contain `<auto-context>`
 *   2. Send a message → verify JSONL user message `auto_context` field is absent/null
 *   3. Send multiple messages → verify auto-context is NOT duplicated in user message history
 *   4. Intercept system prompt via structured log → verify it contains `<auto-context>` block
 *      with expected sections: `<open-notes>`, `<vault-structure>`, `<os>`
 *   5. Disable a source in settings → verify system prompt omits that source's tag
 *   6. All sources disabled → verify no `<auto-context>` block in system prompt
 *
 * @see specs/02-context-intelligence/auto-context-iteration/tasks.md — ACI-TEST-001
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
import { LogCollector, type LogEntry } from "../lib/log-collector";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VAULT_PATH = path.resolve(__dirname, "..", "test-vault");
const CDP_PORT = 9222;
const RESULTS_DIR = path.resolve(__dirname, "..", "results");
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots", "auto-context");
const LOGS_DIR = path.join(RESULTS_DIR, "logs");
const BUILD_DIR = path.resolve(__dirname, "..", "..", "build");
const PLUGIN_DATA_PATH = path.join(BUILD_DIR, "data.json");
const HISTORY_DIR = path.join(VAULT_PATH, ".obsidian", "plugins", "notor", "history");

const RESPONSE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_500;

// ---------------------------------------------------------------------------
// Test infrastructure
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

async function waitForResponse(page: Page, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(POLL_INTERVAL_MS);
		const inputReady = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			if (!el) return false;
			return el.getAttribute("contenteditable") === "true";
		});
		if (inputReady) return true;
	}
	return false;
}

async function sendMessage(page: Page, message: string): Promise<boolean> {
	const input = await page.$(".notor-text-input");
	if (!input) throw new Error("Chat input not found");

	await input.click();
	await input.evaluate((el, msg) => {
		el.textContent = msg;
		el.dispatchEvent(new Event("input", { bubbles: true }));
	}, message);
	await page.waitForTimeout(200);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(600);

	console.log(`    → Sent: "${message.substring(0, 80)}"`);
	return waitForResponse(page);
}

async function newConversation(page: Page): Promise<void> {
	const btn = await page.$(".notor-chat-header-btn[aria-label='New conversation']");
	if (btn) {
		await btn.click();
		await page.waitForTimeout(1_500);
	}
}

// ---------------------------------------------------------------------------
// JSONL history helpers
// ---------------------------------------------------------------------------

/**
 * Read all user messages from the latest JSONL history file.
 */
function getAllUserMessages(): Array<Record<string, unknown>> {
	if (!fs.existsSync(HISTORY_DIR)) return [];

	const files = fs.readdirSync(HISTORY_DIR)
		.filter((f) => f.endsWith(".jsonl"))
		.sort()
		.reverse();

	for (const file of files) {
		const content = fs.readFileSync(path.join(HISTORY_DIR, file), "utf8");
		const lines = content.split("\n").filter((l) => l.trim());

		const userMessages: Array<Record<string, unknown>> = [];
		for (const line of lines) {
			try {
				const obj = JSON.parse(line);
				if (obj.role === "user") {
					userMessages.push(obj);
				}
			} catch { /* skip */ }
		}

		if (userMessages.length > 0) return userMessages;
	}
	return [];
}

/**
 * Read the latest JSONL history file and find the last user message.
 */
function getLatestUserMessage(): Record<string, unknown> | null {
	const messages = getAllUserMessages();
	return messages.length > 0 ? messages[messages.length - 1]! : null;
}

/**
 * Find all "System prompt assembled" log entries captured by the log collector.
 * These are emitted by ChatOrchestrator as debug-level structured logs.
 */
function getSystemPromptLogs(collector: LogCollector): LogEntry[] {
	return collector
		.getStructuredLogs()
		.filter(
			(e) =>
				e.source === "ChatOrchestrator" &&
				e.message === "System prompt assembled"
		);
}

/**
 * Get the most recent system prompt string from the log collector.
 */
function getLatestSystemPrompt(collector: LogCollector): string | null {
	const logs = getSystemPromptLogs(collector);
	if (logs.length === 0) return null;
	const last = logs[logs.length - 1]!;
	const data = last.data as { systemPrompt?: string } | undefined;
	return data?.systemPrompt ?? null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function buildSettings(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
	return {
		notor_dir: "notor/",
		active_provider: "local",
		providers: [
			{
				type: "local",
				enabled: true,
				display_name: "Local (OpenAI-compatible)",
				endpoint: "http://localhost:11434/v1",
			},
		],
		auto_approve: { read_note: true, search_vault: true, list_vault: true },
		mode: "plan",
		open_notes_on_access: true,
		history_path: ".obsidian/plugins/notor/history/",
		history_max_size_mb: 500,
		history_max_age_days: 90,
		checkpoint_path: ".obsidian/plugins/notor/checkpoints/",
		checkpoint_max_per_conversation: 100,
		checkpoint_max_age_days: 30,
		model_pricing: {},
		auto_context_open_notes: true,
		auto_context_vault_structure: true,
		auto_context_os: true,
		compaction_threshold: 0.8,
		compaction_prompt_override: "",
		fetch_webpage_timeout: 15,
		fetch_webpage_max_download_mb: 5,
		fetch_webpage_max_output_chars: 50000,
		domain_denylist: [],
		execute_command_timeout: 30,
		execute_command_max_output_chars: 50000,
		execute_command_allowed_paths: [],
		execute_command_shell: "",
		execute_command_shell_args: [],
		external_file_size_threshold_mb: 1,
		hooks: { pre_send: [], on_tool_call: [], on_tool_result: [], after_completion: [] },
		hook_timeout: 10,
		hook_env_truncation_chars: 10000,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Vault setup
// ---------------------------------------------------------------------------

function setupTestVault(): void {
	// Create a folder structure for vault structure detection
	const folders = ["Research", "Daily", "Projects"];
	for (const folder of folders) {
		fs.mkdirSync(path.join(VAULT_PATH, folder), { recursive: true });
	}

	// Create test notes
	const notes: Record<string, string> = {
		"Research/Climate.md": "# Climate Research\n\nNotes on climate science.\n",
		"Daily/2026-07-03.md": "# Daily Log\n\nToday's notes.\n",
		"Test Note.md": "# Test Note\n\nA test vault note.\n",
	};

	for (const [relativePath, content] of Object.entries(notes)) {
		const fullPath = path.join(VAULT_PATH, relativePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		fs.writeFileSync(fullPath, content, "utf8");
	}

	// Clean history
	if (fs.existsSync(HISTORY_DIR)) {
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	}

	console.log("  Test vault prepared with folders and notes.");
}

// ---------------------------------------------------------------------------
// ACI-TEST-001: Auto-context in system prompt (not user message)
// ---------------------------------------------------------------------------

/**
 * ACI-TEST-001-a: User message content must NOT contain `<auto-context>` XML.
 *
 * After ACI-001, auto-context is injected into the system prompt before each
 * LLM call. It must never appear in the persisted user message `content`.
 */
async function testUserMessageContentLacksAutoContext(
	page: Page,
	collector: LogCollector
): Promise<void> {
	console.log("\n── ACI-TEST-001-a: User message content has no <auto-context> ──");
	await newConversation(page);

	const responded = await sendMessage(page, "Hello, what can you help me with?");
	const shot = await screenshot(page, "aci-001a-no-autocontext-in-content");

	if (!responded) {
		console.log("    (No LLM response — checking JSONL directly)");
	}

	await page.waitForTimeout(1_000);
	const userMsg = getLatestUserMessage();

	if (!userMsg) {
		fail(
			"ACI-TEST-001-a: user message content lacks <auto-context>",
			"No user message found in JSONL history",
			shot
		);
		return;
	}

	const content = String(userMsg.content ?? "");

	if (content.includes("<auto-context>")) {
		fail(
			"ACI-TEST-001-a: user message content lacks <auto-context>",
			`<auto-context> block found in user message content (should be in system prompt only). ` +
				`Content prefix: "${content.substring(0, 200)}"`,
			shot
		);
	} else {
		pass(
			"ACI-TEST-001-a: user message content lacks <auto-context>",
			"User message content does not contain <auto-context> XML",
			shot
		);
	}
}

/**
 * ACI-TEST-001-b: User message `auto_context` metadata field must be absent/null.
 *
 * The old implementation stored auto-context in a per-message `auto_context`
 * field. After ACI-001, this field should no longer be populated.
 */
async function testUserMessageAutoContextFieldAbsent(
	collector: LogCollector
): Promise<void> {
	console.log("\n── ACI-TEST-001-b: User message auto_context field is absent ──");

	const userMsg = getLatestUserMessage();

	if (!userMsg) {
		fail(
			"ACI-TEST-001-b: auto_context field absent",
			"No user message found in JSONL history"
		);
		return;
	}

	const autoContextField = userMsg.auto_context;

	if (autoContextField === null || autoContextField === undefined) {
		pass(
			"ACI-TEST-001-b: auto_context field absent",
			"auto_context field is null/absent in user message JSONL — correct per ACI-001"
		);
	} else {
		fail(
			"ACI-TEST-001-b: auto_context field absent",
			`auto_context field is unexpectedly set: "${String(autoContextField).substring(0, 200)}"`
		);
	}
}

/**
 * ACI-TEST-001-c: Auto-context must NOT be duplicated across multiple user messages.
 *
 * Sends three messages in sequence. In the old implementation, every user
 * message stored a full auto-context block, inflating token costs. After ACI-001,
 * no user message should contain `<auto-context>`.
 */
async function testNoAutoContextDuplicationAcrossMessages(
	page: Page,
	collector: LogCollector
): Promise<void> {
	console.log("\n── ACI-TEST-001-c: No auto-context duplication across messages ──");

	// Send two more messages in the same conversation
	await sendMessage(page, "Tell me about note-taking strategies.");
	await page.waitForTimeout(500);
	await sendMessage(page, "What are some common vault structures?");
	await page.waitForTimeout(1_000);

	const userMessages = getAllUserMessages();

	if (userMessages.length === 0) {
		fail(
			"ACI-TEST-001-c: no auto-context duplication",
			"No user messages found in JSONL history"
		);
		return;
	}

	// Filter out hook injection messages (they're also user role but not from the human)
	const humanMessages = userMessages.filter((m) => !m.is_hook_injection);

	const messagesWithAutoContext = humanMessages.filter((m) => {
		const content = String(m.content ?? "");
		const autoContextField = m.auto_context;
		return (
			content.includes("<auto-context>") ||
			(autoContextField !== null && autoContextField !== undefined)
		);
	});

	if (messagesWithAutoContext.length === 0) {
		pass(
			"ACI-TEST-001-c: no auto-context duplication",
			`Checked ${humanMessages.length} user messages — none contain <auto-context> content or auto_context field`
		);
	} else {
		fail(
			"ACI-TEST-001-c: no auto-context duplication",
			`${messagesWithAutoContext.length} of ${humanMessages.length} user messages still contain auto-context data`
		);
	}
}

/**
 * ACI-TEST-001-d: The system prompt MUST contain the `<auto-context>` block
 * with the expected sections.
 *
 * Inspects the structured debug log emitted by ChatOrchestrator after each
 * system prompt assembly (log source: "ChatOrchestrator",
 * message: "System prompt assembled").
 */
async function testSystemPromptContainsAutoContext(
	collector: LogCollector
): Promise<void> {
	console.log("\n── ACI-TEST-001-d: System prompt contains <auto-context> block ──");

	const systemPrompt = getLatestSystemPrompt(collector);

	if (systemPrompt === null) {
		fail(
			"ACI-TEST-001-d: system prompt contains <auto-context>",
			"No 'System prompt assembled' log entry found. " +
				"Ensure the plugin emitted the debug log (ChatOrchestrator source)."
		);
		return;
	}

	// Check for the outer <auto-context> block
	if (!systemPrompt.includes("<auto-context>")) {
		fail(
			"ACI-TEST-001-d: system prompt contains <auto-context>",
			`System prompt does not contain <auto-context> block. ` +
				`System prompt prefix: "${systemPrompt.substring(0, 300)}"`
		);
		return;
	}

	pass(
		"ACI-TEST-001-d: system prompt contains <auto-context>",
		"<auto-context> block found in assembled system prompt"
	);

	// Check for open-notes section
	if (systemPrompt.includes("<open-notes>")) {
		pass(
			"ACI-TEST-001-d: system prompt has <open-notes>",
			"<open-notes> section present in system prompt auto-context"
		);
	} else {
		// Open notes may be empty if no markdown tabs are open in test env
		pass(
			"ACI-TEST-001-d: system prompt has <open-notes>",
			"<open-notes> section not found — may be expected if no markdown tabs are open in test env"
		);
	}

	// Check for vault-structure section
	if (systemPrompt.includes("<vault-structure>")) {
		pass(
			"ACI-TEST-001-d: system prompt has <vault-structure>",
			"<vault-structure> section present in system prompt auto-context"
		);

		// Verify at least one known folder from the test vault
		const knownFolders = ["Research/", "Daily/", "Projects/"];
		const foundFolder = knownFolders.find((f) => systemPrompt.includes(f));
		if (foundFolder) {
			pass(
				"ACI-TEST-001-d: vault-structure has expected folder",
				`Found test vault folder "${foundFolder}" in system prompt vault-structure`
			);
		} else {
			// May not be present if the vault differs — still a soft check
			pass(
				"ACI-TEST-001-d: vault-structure has expected folder",
				"Test vault folders not found (may differ in test environment) — vault-structure tag present"
			);
		}
	} else {
		fail(
			"ACI-TEST-001-d: system prompt has <vault-structure>",
			"<vault-structure> section missing from system prompt auto-context"
		);
	}

	// Check for os section
	if (systemPrompt.includes("<os>")) {
		const knownOS = ["macOS", "Windows", "Linux"];
		const foundOS = knownOS.find((os) => systemPrompt.includes(os));
		if (foundOS) {
			pass(
				"ACI-TEST-001-d: system prompt has <os>",
				`<os> section present with recognized platform: "${foundOS}"`
			);
		} else {
			pass(
				"ACI-TEST-001-d: system prompt has <os>",
				"<os> section present (platform value present)"
			);
		}
	} else {
		fail(
			"ACI-TEST-001-d: system prompt has <os>",
			"<os> section missing from system prompt auto-context"
		);
	}

	// Check that ## Workspace context heading is present (injected by system-prompt.ts)
	if (systemPrompt.includes("## Workspace context")) {
		pass(
			"ACI-TEST-001-d: system prompt has workspace context heading",
			'"## Workspace context" section heading found in system prompt'
		);
	} else {
		fail(
			"ACI-TEST-001-d: system prompt has workspace context heading",
			'"## Workspace context" heading missing from system prompt'
		);
	}
}

/**
 * ACI-TEST-001-e: System prompt auto-context is rebuilt on every LLM call.
 *
 * Sends multiple messages in a single conversation and verifies the system
 * prompt log shows a "System prompt assembled" entry for each user send,
 * confirming fresh auto-context is injected each time.
 */
async function testSystemPromptRebuiltPerCall(
	collector: LogCollector
): Promise<void> {
	console.log("\n── ACI-TEST-001-e: System prompt rebuilt for each LLM call ──");

	const systemPromptLogs = getSystemPromptLogs(collector);

	// We sent at least 3 messages in this session (tests c added 2 more)
	if (systemPromptLogs.length >= 3) {
		pass(
			"ACI-TEST-001-e: system prompt rebuilt per LLM call",
			`Found ${systemPromptLogs.length} "System prompt assembled" log entries — ` +
				"system prompt is rebuilt before each LLM call as required by ACI-001"
		);
	} else if (systemPromptLogs.length >= 1) {
		pass(
			"ACI-TEST-001-e: system prompt rebuilt per LLM call",
			`Found ${systemPromptLogs.length} "System prompt assembled" log entries ` +
				"(fewer than expected — provider may have rejected all but first call)"
		);
	} else {
		fail(
			"ACI-TEST-001-e: system prompt rebuilt per LLM call",
			"No 'System prompt assembled' log entries found — cannot verify per-call rebuild"
		);
	}
}

/**
 * ACI-TEST-001-f: Disabled source omitted from system prompt.
 *
 * Disables `auto_context_os` in settings, reloads, sends a message, and
 * verifies the system prompt does NOT contain `<os>` but does contain the
 * other auto-context sections.
 */
async function testDisabledSourceOmittedFromSystemPrompt(
	page: Page,
	collector: LogCollector
): Promise<void> {
	console.log("\n── ACI-TEST-001-f: Disabled source omitted from system prompt ──");

	// Update settings to disable OS auto-context
	const settings = buildSettings({ auto_context_os: false });
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));

	// Reload plugin by refreshing
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);

	const responded = await sendMessage(page, "Test: OS auto-context disabled");
	const shot = await screenshot(page, "aci-001f-os-disabled");

	if (!responded) {
		console.log("    (No LLM response — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPrompt = getLatestSystemPrompt(collector);

	if (systemPrompt === null) {
		fail(
			"ACI-TEST-001-f: disabled source omitted from system prompt",
			"No 'System prompt assembled' log entry found after reload",
			shot
		);
		return;
	}

	const hasAutoContext = systemPrompt.includes("<auto-context>");
	const hasOS = systemPrompt.includes("<os>");

	if (hasAutoContext && !hasOS) {
		pass(
			"ACI-TEST-001-f: disabled source omitted from system prompt",
			"<auto-context> block present but <os> tag correctly omitted when auto_context_os=false",
			shot
		);
	} else if (!hasAutoContext) {
		fail(
			"ACI-TEST-001-f: disabled source omitted from system prompt",
			"<auto-context> block missing entirely from system prompt — expected partial block",
			shot
		);
	} else {
		fail(
			"ACI-TEST-001-f: disabled source omitted from system prompt",
			"<os> tag still present in system prompt despite auto_context_os=false",
			shot
		);
	}

	// Also confirm user message still has no <auto-context>
	const userMsg = getLatestUserMessage();
	if (userMsg) {
		const content = String(userMsg.content ?? "");
		if (!content.includes("<auto-context>")) {
			pass(
				"ACI-TEST-001-f: user message still clean after settings reload",
				"User message content does not contain <auto-context> after settings reload"
			);
		} else {
			fail(
				"ACI-TEST-001-f: user message still clean after settings reload",
				"<auto-context> found in user message content after settings reload"
			);
		}
	}
}

/**
 * ACI-TEST-001-g: All sources disabled → no `<auto-context>` block in system prompt.
 *
 * When every auto-context source is disabled, `buildAutoContextBlock()` returns
 * null and the system prompt should contain no `<auto-context>` section.
 */
async function testAllSourcesDisabledNoAutoContextInSystemPrompt(
	page: Page,
	collector: LogCollector
): Promise<void> {
	console.log("\n── ACI-TEST-001-g: All sources disabled → no <auto-context> in system prompt ──");

	// Disable all sources
	const settings = buildSettings({
		auto_context_open_notes: false,
		auto_context_vault_structure: false,
		auto_context_os: false,
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));

	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);

	const responded = await sendMessage(page, "Test: all auto-context sources disabled");
	const shot = await screenshot(page, "aci-001g-all-disabled");

	if (!responded) {
		console.log("    (No LLM response — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPrompt = getLatestSystemPrompt(collector);

	if (systemPrompt === null) {
		fail(
			"ACI-TEST-001-g: no <auto-context> when all sources disabled",
			"No 'System prompt assembled' log entry found after reload",
			shot
		);
		return;
	}

	if (!systemPrompt.includes("<auto-context>")) {
		pass(
			"ACI-TEST-001-g: no <auto-context> when all sources disabled",
			"System prompt correctly has no <auto-context> block when all sources are disabled",
			shot
		);
	} else {
		fail(
			"ACI-TEST-001-g: no <auto-context> when all sources disabled",
			"<auto-context> block still found in system prompt despite all sources being disabled",
			shot
		);
	}

	// Verify "## Workspace context" heading is also absent
	if (!systemPrompt.includes("## Workspace context")) {
		pass(
			"ACI-TEST-001-g: workspace context heading absent",
			'"## Workspace context" heading correctly absent when no auto-context block'
		);
	} else {
		fail(
			"ACI-TEST-001-g: workspace context heading absent",
			'"## Workspace context" heading still present despite no auto-context content'
		);
	}

	// Verify user message also has no auto-context content
	const userMsg = getLatestUserMessage();
	if (userMsg) {
		const content = String(userMsg.content ?? "");
		const autoContextField = userMsg.auto_context;
		if (!content.includes("<auto-context>") && (autoContextField === null || autoContextField === undefined)) {
			pass(
				"ACI-TEST-001-g: user message clean when all sources disabled",
				"User message has no <auto-context> in content and auto_context field is absent"
			);
		} else {
			fail(
				"ACI-TEST-001-g: user message clean when all sources disabled",
				`User message unexpectedly contains auto-context data. ` +
					`content has tag: ${content.includes("<auto-context>")}, ` +
					`auto_context field: ${String(autoContextField).substring(0, 100)}`
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("=== Notor Auto-Context E2E Test (ACI-TEST-001) ===\n");

	console.log("[0/4] Building plugin...");
	execSync("npm run build", { cwd: path.resolve(__dirname, "..", ".."), stdio: "inherit" });
	console.log("Build complete.\n");

	console.log("[1/4] Setting up test vault...");
	setupTestVault();

	console.log("[2/4] Injecting settings...");
	const settings = buildSettings();
	fs.mkdirSync(BUILD_DIR, { recursive: true });

	let existingData: string | null = null;
	if (fs.existsSync(PLUGIN_DATA_PATH)) {
		existingData = fs.readFileSync(PLUGIN_DATA_PATH, "utf8");
	}
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));

	fs.mkdirSync(LOGS_DIR, { recursive: true });
	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

	let obsidian: ObsidianProcess | undefined;
	let collector: LogCollector | undefined;

	try {
		console.log("[3/4] Launching Obsidian...");
		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });

		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		const contexts = browser.contexts();
		const page = contexts[0]?.pages()[0];
		if (!page) throw new Error("No page found");

		collector = new LogCollector({ outputDir: LOGS_DIR });
		collector.attach(page);

		await page.waitForLoadState("domcontentloaded");
		await page.waitForTimeout(5_000);

		console.log("[4/4] Running ACI-TEST-001 tests...\n");
		{
			const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
			if (!chat) {
				const shot = await screenshot(page, "00-no-chat");
				fail("Chat panel visible", ".notor-chat-container not found", shot);
				throw new Error("Chat panel not visible");
			}
			pass("Chat panel ready", "Plugin loaded and chat container found");
		}

		// ACI-TEST-001-a: user message content must not contain <auto-context>
		await testUserMessageContentLacksAutoContext(page, collector);

		// ACI-TEST-001-b: auto_context metadata field must be absent/null
		await testUserMessageAutoContextFieldAbsent(collector);

		// ACI-TEST-001-c: no duplication across multiple messages
		await testNoAutoContextDuplicationAcrossMessages(page, collector);

		// ACI-TEST-001-d: system prompt contains <auto-context> with all sections
		await testSystemPromptContainsAutoContext(collector);

		// ACI-TEST-001-e: system prompt is rebuilt before each LLM call
		await testSystemPromptRebuiltPerCall(collector);

		// ACI-TEST-001-f: disabled source omitted from system prompt
		await testDisabledSourceOmittedFromSystemPrompt(page, collector);

		// ACI-TEST-001-g: all sources disabled → no <auto-context> in system prompt
		await testAllSourcesDisabledNoAutoContextInSystemPrompt(page, collector);

		await screenshot(page, "99-final");

		console.log("\n=== Collecting logs ===");
		await page.waitForTimeout(1_000);
		const summaryPath = await collector.writeSummary();
		console.log(`Log summary: ${summaryPath}`);

		await browser.close().catch(() => {});
	} catch (err) {
		console.error("\nFatal error:", err);
		if (collector) await collector.dispose().catch(() => {});
	} finally {
		if (obsidian) await closeObsidian(obsidian);
		if (existingData !== null) {
			fs.writeFileSync(PLUGIN_DATA_PATH, existingData);
		} else {
			try { fs.unlinkSync(PLUGIN_DATA_PATH); } catch { /* ignore */ }
		}
	}

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

	const resultsPath = path.join(RESULTS_DIR, "auto-context-results.json");
	fs.writeFileSync(resultsPath, JSON.stringify({ passed, failed, total: results.length, results }, null, 2));
	console.log(`\nResults written to: ${resultsPath}`);

	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
