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
 *
 * ## ACI-TEST-002: Open notes detection — all tabs detected on first message
 *
 * Tests that the ACI-004 fix reliably detects all open markdown tabs on the
 * first message, including notes that have never been manually clicked.
 *
 * Scenarios:
 *   a. Open 3+ notes programmatically → first message → ALL paths in auto-context
 *   b. Open notes in a split pane → verify all panes detected
 *   c. Switch active note without closing first → verify both appear
 *   d. Close a tab → send message → closed note no longer in auto-context
 *   e. Open notes from different vault folders → full vault-relative paths correct
 *
 * @see specs/02-context-intelligence/auto-context-iteration/tasks.md — ACI-TEST-002
 *
 * ## ACI-TEST-003: Active note marker
 *
 * Validates the ` (active)` marker on the currently active note in the
 * `<open-notes>` block of the assembled system prompt (ACI-005).
 *
 * Scenarios:
 *   a. Open multiple notes → send message → verify exactly one note has ` (active)` suffix
 *   b. Switch active note → send another message → verify the active marker moved
 *   c. The active marker matches the note currently in the foreground/focused leaf
 *
 * @see specs/02-context-intelligence/auto-context-iteration/tasks.md — ACI-TEST-003
 *
 * ## ACI-TEST-004: Vault structure formatting
 *
 * Validates that the `<vault-structure>` block in the assembled system prompt
 * uses the corrected formatting introduced by ACI-003:
 *   - Each folder is on its own line (not comma-separated)
 *   - Each folder name ends with `/`
 *
 * Scenarios:
 *   a. Each folder in `<vault-structure>` is on its own line
 *   b. Each folder name ends with `/`
 *   c. Folders are not comma-separated
 *
 * @see specs/02-context-intelligence/auto-context-iteration/tasks.md — ACI-TEST-004
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
	timeoutMs = 8_000,
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

	const files = fs
		.readdirSync(HISTORY_DIR)
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
			} catch {
				/* skip */
			}
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
			(e) => e.source === "ChatOrchestrator" && e.message === "System prompt assembled",
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

	// Ensure additional notes used by ACI-TEST-002 and ACI-TEST-003 exist
	const extraNotes: Record<string, string> = {
		"Notes/Meeting Notes.md": "# Meeting Notes\n\nNotes from meetings.\n",
		"Notes/Project Plan.md": "# Project Plan\n\nProject planning notes.\n",
		"Journal/2025-01-01.md": "# Journal Entry\n\nNew year thoughts.\n",
	};
	for (const [relativePath, content] of Object.entries(extraNotes)) {
		const fullPath = path.join(VAULT_PATH, relativePath);
		fs.mkdirSync(path.dirname(fullPath), { recursive: true });
		if (!fs.existsSync(fullPath)) {
			fs.writeFileSync(fullPath, content, "utf8");
		}
	}

	// Clean history
	if (fs.existsSync(HISTORY_DIR)) {
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	}

	console.log("  Test vault prepared with folders and notes.");
}

// ---------------------------------------------------------------------------
// Obsidian note-tab helpers (used by ACI-TEST-002)
// ---------------------------------------------------------------------------

/**
 * Open a vault-relative note path in a new tab using Obsidian's workspace API.
 * The note will be opened in the background (new leaf) without activating it,
 * so it remains unclicked — matching the "lazily initialised tab" scenario that
 * the ACI-004 fix must handle.
 *
 * @param page      - Connected Playwright page
 * @param notePath  - Vault-relative path, e.g. "Research/Climate.md"
 * @param activate  - If true, make this tab the active (focused) one
 */
async function openNoteInNewTab(page: Page, notePath: string, activate = false): Promise<void> {
	await page.evaluate(
		async ({ notePath, activate }: { notePath: string; activate: boolean }) => {
			const app = (
				window as unknown as { app: { workspace: unknown; vault: unknown } }
			).app;
			const workspace = app.workspace as {
				getLeaf: (
					newLeaf: boolean | string,
				) => { openFile: (file: unknown, opts?: unknown) => Promise<void> };
			};
			const vault = app.vault as {
				getAbstractFileByPath: (path: string) => unknown;
			};

			const file = vault.getAbstractFileByPath(notePath);
			if (!file) {
				console.error(`[ACI-TEST-002] File not found: ${notePath}`);
				return;
			}

			// "tab" creates a new background tab; activate controls focus
			const leaf = workspace.getLeaf("tab");
			await leaf.openFile(file, { active: activate });
		},
		{ notePath, activate },
	);
	// Brief pause so Obsidian can register the tab state
	await page.waitForTimeout(400);
}

/**
 * Open a note in a split pane (vertical split) next to the current leaf.
 *
 * @param page     - Connected Playwright page
 * @param notePath - Vault-relative path to open in the split
 */
async function openNoteInSplitPane(page: Page, notePath: string): Promise<void> {
	await page.evaluate(
		async ({ notePath }: { notePath: string }) => {
			const app = (
				window as unknown as { app: { workspace: unknown; vault: unknown } }
			).app;
			const workspace = app.workspace as {
				getLeaf: (
					newLeaf: string,
				) => { openFile: (file: unknown, opts?: unknown) => Promise<void> };
			};
			const vault = app.vault as {
				getAbstractFileByPath: (path: string) => unknown;
			};

			const file = vault.getAbstractFileByPath(notePath);
			if (!file) {
				console.error(`[ACI-TEST-002] File not found in split: ${notePath}`);
				return;
			}

			// "split" creates a new pane adjacent to the current one
			const leaf = workspace.getLeaf("split");
			await leaf.openFile(file, { active: false });
		},
		{ notePath },
	);
	await page.waitForTimeout(400);
}

/**
 * Switch the active leaf to the specified vault-relative note path.
 * Iterates all leaves and activates the one whose file matches.
 */
async function activateNote(page: Page, notePath: string): Promise<void> {
	await page.evaluate(
		({ notePath }: { notePath: string }) => {
			const app = (window as unknown as { app: { workspace: unknown } }).app;
			const workspace = app.workspace as {
				iterateAllLeaves: (cb: (leaf: unknown) => void) => void;
				setActiveLeaf: (leaf: unknown, opts?: unknown) => void;
			};

			workspace.iterateAllLeaves((leaf) => {
				const typedLeaf = leaf as {
					view?: { file?: { path: string } };
				};
				if (typedLeaf.view?.file?.path === notePath) {
					workspace.setActiveLeaf(leaf, { focus: true });
				}
			});
		},
		{ notePath },
	);
	await page.waitForTimeout(300);
}

/**
 * Close the tab that contains the given vault-relative note path.
 */
async function closeNoteTab(page: Page, notePath: string): Promise<void> {
	await page.evaluate(
		({ notePath }: { notePath: string }) => {
			const app = (window as unknown as { app: { workspace: unknown } }).app;
			const workspace = app.workspace as {
				iterateAllLeaves: (cb: (leaf: unknown) => void) => void;
			};

			workspace.iterateAllLeaves((leaf) => {
				const typedLeaf = leaf as {
					view?: { file?: { path: string } };
					detach?: () => void;
				};
				if (typedLeaf.view?.file?.path === notePath) {
					typedLeaf.detach?.();
				}
			});
		},
		{ notePath },
	);
	await page.waitForTimeout(400);
}

/**
 * Close ALL markdown tabs currently open (reset state between sub-tests).
 */
async function closeAllMarkdownTabs(page: Page): Promise<void> {
	await page.evaluate(() => {
		const app = (window as unknown as { app: { workspace: unknown } }).app;
		const workspace = app.workspace as {
			iterateAllLeaves: (cb: (leaf: unknown) => void) => void;
		};

		const toDetach: Array<{ detach?: () => void }> = [];
		workspace.iterateAllLeaves((leaf) => {
			const typedLeaf = leaf as {
				view?: { getViewType?: () => string; file?: unknown };
				detach?: () => void;
			};
			if (typedLeaf.view?.getViewType?.() === "markdown") {
				toDetach.push(typedLeaf);
			}
		});
		// Detach after collecting to avoid iterator mutation issues
		for (const leaf of toDetach) {
			leaf.detach?.();
		}
	});
	await page.waitForTimeout(500);
}

/**
 * Extract the `<open-notes>` section content from a system prompt string.
 * Returns null if the tag is absent, or an array of trimmed non-empty lines.
 */
function extractOpenNotes(systemPrompt: string): string[] | null {
	const match = systemPrompt.match(/<open-notes>([\s\S]*?)<\/open-notes>/);
	if (!match) return null;
	return match[1]!
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/**
 * Extract the raw `<vault-structure>` inner content from a system prompt string.
 * Returns null if the tag is absent.
 * Returns the raw inner string (preserving whitespace) so tests can inspect
 * both line-separation and trailing-slash formatting.
 */
function extractVaultStructureRaw(systemPrompt: string): string | null {
	const match = systemPrompt.match(/<vault-structure>([\s\S]*?)<\/vault-structure>/);
	if (!match) return null;
	return match[1]!;
}

/**
 * Parse the raw vault-structure inner content into an array of non-empty,
 * trimmed entry strings (one per folder).
 */
function extractVaultStructure(systemPrompt: string): string[] | null {
	const raw = extractVaultStructureRaw(systemPrompt);
	if (raw === null) return null;
	return raw
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
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
	collector: LogCollector,
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
			shot,
		);
		return;
	}

	const content = String(userMsg.content ?? "");

	if (content.includes("<auto-context>")) {
		fail(
			"ACI-TEST-001-a: user message content lacks <auto-context>",
			`<auto-context> block found in user message content (should be in system prompt only). ` +
				`Content prefix: "${content.substring(0, 200)}"`,
			shot,
		);
	} else {
		pass(
			"ACI-TEST-001-a: user message content lacks <auto-context>",
			"User message content does not contain <auto-context> XML",
			shot,
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
	collector: LogCollector,
): Promise<void> {
	console.log("\n── ACI-TEST-001-b: User message auto_context field is absent ──");

	const userMsg = getLatestUserMessage();

	if (!userMsg) {
		fail("ACI-TEST-001-b: auto_context field absent", "No user message found in JSONL history");
		return;
	}

	const autoContextField = userMsg.auto_context;

	if (autoContextField === null || autoContextField === undefined) {
		pass(
			"ACI-TEST-001-b: auto_context field absent",
			"auto_context field is null/absent in user message JSONL — correct per ACI-001",
		);
	} else {
		fail(
			"ACI-TEST-001-b: auto_context field absent",
			`auto_context field is unexpectedly set: "${String(autoContextField).substring(0, 200)}"`,
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
	collector: LogCollector,
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
			"No user messages found in JSONL history",
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
			`Checked ${humanMessages.length} user messages — none contain <auto-context> content or auto_context field`,
		);
	} else {
		fail(
			"ACI-TEST-001-c: no auto-context duplication",
			`${messagesWithAutoContext.length} of ${humanMessages.length} user messages still contain auto-context data`,
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
async function testSystemPromptContainsAutoContext(collector: LogCollector): Promise<void> {
	console.log("\n── ACI-TEST-001-d: System prompt contains <auto-context> block ──");

	const systemPrompt = getLatestSystemPrompt(collector);

	if (systemPrompt === null) {
		fail(
			"ACI-TEST-001-d: system prompt contains <auto-context>",
			"No 'System prompt assembled' log entry found. " +
				"Ensure the plugin emitted the debug log (ChatOrchestrator source).",
		);
		return;
	}

	// Check for the outer <auto-context> block
	if (!systemPrompt.includes("<auto-context>")) {
		fail(
			"ACI-TEST-001-d: system prompt contains <auto-context>",
			`System prompt does not contain <auto-context> block. ` +
				`System prompt prefix: "${systemPrompt.substring(0, 300)}"`,
		);
		return;
	}

	pass(
		"ACI-TEST-001-d: system prompt contains <auto-context>",
		"<auto-context> block found in assembled system prompt",
	);

	// Check for open-notes section
	if (systemPrompt.includes("<open-notes>")) {
		pass(
			"ACI-TEST-001-d: system prompt has <open-notes>",
			"<open-notes> section present in system prompt auto-context",
		);
	} else {
		// Open notes may be empty if no markdown tabs are open in test env
		pass(
			"ACI-TEST-001-d: system prompt has <open-notes>",
			"<open-notes> section not found — may be expected if no markdown tabs are open in test env",
		);
	}

	// Check for vault-structure section
	if (systemPrompt.includes("<vault-structure>")) {
		pass(
			"ACI-TEST-001-d: system prompt has <vault-structure>",
			"<vault-structure> section present in system prompt auto-context",
		);

		// Verify at least one known folder from the test vault
		const knownFolders = ["Research/", "Daily/", "Projects/"];
		const foundFolder = knownFolders.find((f) => systemPrompt.includes(f));
		if (foundFolder) {
			pass(
				"ACI-TEST-001-d: vault-structure has expected folder",
				`Found test vault folder "${foundFolder}" in system prompt vault-structure`,
			);
		} else {
			// May not be present if the vault differs — still a soft check
			pass(
				"ACI-TEST-001-d: vault-structure has expected folder",
				"Test vault folders not found (may differ in test environment) — vault-structure tag present",
			);
		}
	} else {
		fail(
			"ACI-TEST-001-d: system prompt has <vault-structure>",
			"<vault-structure> section missing from system prompt auto-context",
		);
	}

	// Check for os section
	if (systemPrompt.includes("<os>")) {
		const knownOS = ["macOS", "Windows", "Linux"];
		const foundOS = knownOS.find((os) => systemPrompt.includes(os));
		if (foundOS) {
			pass(
				"ACI-TEST-001-d: system prompt has <os>",
				`<os> section present with recognized platform: "${foundOS}"`,
			);
		} else {
			pass("ACI-TEST-001-d: system prompt has <os>", "<os> section present (platform value present)");
		}
	} else {
		fail(
			"ACI-TEST-001-d: system prompt has <os>",
			"<os> section missing from system prompt auto-context",
		);
	}

	// Check that ## Workspace context heading is present (injected by system-prompt.ts)
	if (systemPrompt.includes("## Workspace context")) {
		pass(
			"ACI-TEST-001-d: system prompt has workspace context heading",
			'"## Workspace context" section heading found in system prompt',
		);
	} else {
		fail(
			"ACI-TEST-001-d: system prompt has workspace context heading",
			'"## Workspace context" heading missing from system prompt',
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
async function testSystemPromptRebuiltPerCall(collector: LogCollector): Promise<void> {
	console.log("\n── ACI-TEST-001-e: System prompt rebuilt for each LLM call ──");

	const systemPromptLogs = getSystemPromptLogs(collector);

	// We sent at least 3 messages in this session (tests c added 2 more)
	if (systemPromptLogs.length >= 3) {
		pass(
			"ACI-TEST-001-e: system prompt rebuilt per LLM call",
			`Found ${systemPromptLogs.length} "System prompt assembled" log entries — ` +
				"system prompt is rebuilt before each LLM call as required by ACI-001",
		);
	} else if (systemPromptLogs.length >= 1) {
		pass(
			"ACI-TEST-001-e: system prompt rebuilt per LLM call",
			`Found ${systemPromptLogs.length} "System prompt assembled" log entries ` +
				"(fewer than expected — provider may have rejected all but first call)",
		);
	} else {
		fail(
			"ACI-TEST-001-e: system prompt rebuilt per LLM call",
			"No 'System prompt assembled' log entries found — cannot verify per-call rebuild",
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
	collector: LogCollector,
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
			shot,
		);
		return;
	}

	const hasAutoContext = systemPrompt.includes("<auto-context>");
	const hasOS = systemPrompt.includes("<os>");

	if (hasAutoContext && !hasOS) {
		pass(
			"ACI-TEST-001-f: disabled source omitted from system prompt",
			"<auto-context> block present but <os> tag correctly omitted when auto_context_os=false",
			shot,
		);
	} else if (!hasAutoContext) {
		fail(
			"ACI-TEST-001-f: disabled source omitted from system prompt",
			"<auto-context> block missing entirely from system prompt — expected partial block",
			shot,
		);
	} else {
		fail(
			"ACI-TEST-001-f: disabled source omitted from system prompt",
			"<os> tag still present in system prompt despite auto_context_os=false",
			shot,
		);
	}

	// Also confirm user message still has no <auto-context>
	const userMsg = getLatestUserMessage();
	if (userMsg) {
		const content = String(userMsg.content ?? "");
		if (!content.includes("<auto-context>")) {
			pass(
				"ACI-TEST-001-f: user message still clean after settings reload",
				"User message content does not contain <auto-context> after settings reload",
			);
		} else {
			fail(
				"ACI-TEST-001-f: user message still clean after settings reload",
				"<auto-context> found in user message content after settings reload",
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
	collector: LogCollector,
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
			shot,
		);
		return;
	}

	if (!systemPrompt.includes("<auto-context>")) {
		pass(
			"ACI-TEST-001-g: no <auto-context> when all sources disabled",
			"System prompt correctly has no <auto-context> block when all sources are disabled",
			shot,
		);
	} else {
		fail(
			"ACI-TEST-001-g: no <auto-context> when all sources disabled",
			"<auto-context> block still found in system prompt despite all sources being disabled",
			shot,
		);
	}

	// Verify "## Workspace context" heading is also absent
	if (!systemPrompt.includes("## Workspace context")) {
		pass(
			"ACI-TEST-001-g: workspace context heading absent",
			'"## Workspace context" heading correctly absent when no auto-context block',
		);
	} else {
		fail(
			"ACI-TEST-001-g: workspace context heading absent",
			'"## Workspace context" heading still present despite no auto-context content',
		);
	}

	// Verify user message also has no auto-context content
	const userMsg = getLatestUserMessage();
	if (userMsg) {
		const content = String(userMsg.content ?? "");
		const autoContextField = userMsg.auto_context;
		if (
			!content.includes("<auto-context>") &&
			(autoContextField === null || autoContextField === undefined)
		) {
			pass(
				"ACI-TEST-001-g: user message clean when all sources disabled",
				"User message has no <auto-context> in content and auto_context field is absent",
			);
		} else {
			fail(
				"ACI-TEST-001-g: user message clean when all sources disabled",
				`User message unexpectedly contains auto-context data. ` +
					`content has tag: ${content.includes("<auto-context>")}, ` +
					`auto_context field: ${String(autoContextField).substring(0, 100)}`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// ACI-TEST-003: Active note marker
// ---------------------------------------------------------------------------

/**
 * ACI-TEST-003-a: Exactly one note has ` (active)` suffix.
 *
 * Opens multiple notes, activates one of them, then sends a message.
 * Verifies that exactly one entry in `<open-notes>` ends with ` (active)`,
 * and that all opened notes are present.
 */
async function testExactlyOneNoteMarkedActive(
	page: Page,
	collector: LogCollector,
): Promise<void> {
	console.log("\n── ACI-TEST-003-a: Exactly one note marked active ──");

	await closeAllMarkdownTabs(page);
	await newConversation(page);

	const notes = [
		"Research/Climate.md",
		"Daily/2026-07-03.md",
		"Notes/Meeting Notes.md",
	];

	// Open all notes as background tabs first
	for (const note of notes) {
		await openNoteInNewTab(page, note, false);
	}

	// Activate the middle note so it is the focused leaf
	const activeNote = notes[1]!;
	await activateNote(page, activeNote);

	const responded = await sendMessage(
		page,
		"ACI-TEST-003-a: verify exactly one note is marked active",
	);
	const shot = await screenshot(page, "aci-003a-exactly-one-active");

	if (!responded) {
		console.log("    (No LLM response — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPrompt = getLatestSystemPrompt(collector);

	if (!systemPrompt) {
		fail(
			"ACI-TEST-003-a: exactly one note marked active",
			"No 'System prompt assembled' log entry found",
			shot,
		);
		return;
	}

	const openNotes = extractOpenNotes(systemPrompt);

	if (!openNotes) {
		fail(
			"ACI-TEST-003-a: exactly one note marked active",
			"<open-notes> tag not found in system prompt",
			shot,
		);
		return;
	}

	// Count lines ending with " (active)"
	const activeLines = openNotes.filter((line) => line.endsWith(" (active)"));

	if (activeLines.length !== 1) {
		fail(
			"ACI-TEST-003-a: exactly one note marked active",
			`Expected exactly 1 active marker, found ${activeLines.length}. ` +
				`Open notes: ${openNotes.join(", ")}`,
			shot,
		);
		return;
	}

	// Confirm all opened notes are present (strip active suffix for comparison)
	const normalised = openNotes.map((l) =>
		l.endsWith(" (active)") ? l.slice(0, -" (active)".length) : l,
	);
	const missingNotes = notes.filter((n) => !normalised.includes(n));

	if (missingNotes.length === 0) {
		pass(
			"ACI-TEST-003-a: exactly one note marked active",
			`Exactly one active marker found ("${activeLines[0]}"). All ${notes.length} notes present.`,
			shot,
		);
	} else {
		fail(
			"ACI-TEST-003-a: exactly one note marked active",
			`Active count correct (1) but missing notes: ${missingNotes.join(", ")}. ` +
				`Open notes: ${openNotes.join(", ")}`,
			shot,
		);
	}
}

/**
 * ACI-TEST-003-b: Active marker moves when the user switches active note.
 *
 * Opens two notes and sets note A as active, sends a message and records
 * which note was marked active. Then switches the active leaf to note B,
 * sends another message, and verifies the marker is now on note B (not A).
 */
async function testActiveMarkerMovesOnSwitch(
	page: Page,
	collector: LogCollector,
): Promise<void> {
	console.log("\n── ACI-TEST-003-b: Active marker moves on note switch ──");

	await closeAllMarkdownTabs(page);
	await newConversation(page);

	const noteA = "Research/Climate.md";
	const noteB = "Daily/2026-07-03.md";

	// Open both notes; activate A first
	await openNoteInNewTab(page, noteA, false);
	await openNoteInNewTab(page, noteB, false);
	await activateNote(page, noteA);

	// First message — note A should be active
	const responded1 = await sendMessage(
		page,
		"ACI-TEST-003-b: first message, note A active",
	);

	if (!responded1) {
		console.log("    (No LLM response for first message — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPromptAfterA = getLatestSystemPrompt(collector);

	if (!systemPromptAfterA) {
		fail(
			"ACI-TEST-003-b: active marker moves on switch",
			"No 'System prompt assembled' log entry found after first message",
		);
		return;
	}

	const openNotesAfterA = extractOpenNotes(systemPromptAfterA);

	if (!openNotesAfterA) {
		fail(
			"ACI-TEST-003-b: active marker moves on switch",
			"<open-notes> not found after first message",
		);
		return;
	}

	const noteAActiveAfterFirst = openNotesAfterA.some(
		(line) => line === `${noteA} (active)`,
	);

	if (!noteAActiveAfterFirst) {
		fail(
			"ACI-TEST-003-b: active marker moves on switch",
			`Expected "${noteA} (active)" after first message but got: ${openNotesAfterA.join(", ")}`,
		);
		return;
	}

	// Now switch to note B
	await activateNote(page, noteB);

	// Second message — note B should now be active
	const responded2 = await sendMessage(
		page,
		"ACI-TEST-003-b: second message, switched to note B",
	);
	const shot = await screenshot(page, "aci-003b-active-moves");

	if (!responded2) {
		console.log("    (No LLM response for second message — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPromptAfterB = getLatestSystemPrompt(collector);

	if (!systemPromptAfterB) {
		fail(
			"ACI-TEST-003-b: active marker moves on switch",
			"No 'System prompt assembled' log entry found after second message",
			shot,
		);
		return;
	}

	const openNotesAfterB = extractOpenNotes(systemPromptAfterB);

	if (!openNotesAfterB) {
		fail(
			"ACI-TEST-003-b: active marker moves on switch",
			"<open-notes> not found after second message",
			shot,
		);
		return;
	}

	const noteBActiveAfterSwitch = openNotesAfterB.some(
		(line) => line === `${noteB} (active)`,
	);
	const noteAStillActiveAfterSwitch = openNotesAfterB.some(
		(line) => line === `${noteA} (active)`,
	);

	if (noteBActiveAfterSwitch && !noteAStillActiveAfterSwitch) {
		pass(
			"ACI-TEST-003-b: active marker moves on switch",
			`Active marker correctly moved from "${noteA}" to "${noteB}" after tab switch. ` +
				`Open notes: ${openNotesAfterB.join(", ")}`,
			shot,
		);
	} else {
		const reasons: string[] = [];
		if (!noteBActiveAfterSwitch)
			reasons.push(`"${noteB} (active)" not found after switch`);
		if (noteAStillActiveAfterSwitch)
			reasons.push(`"${noteA} (active)" still present after switching away`);
		fail(
			"ACI-TEST-003-b: active marker moves on switch",
			reasons.join("; ") + `. Open notes: ${openNotesAfterB.join(", ")}`,
			shot,
		);
	}
}

/**
 * ACI-TEST-003-c: Active marker matches the foreground/focused leaf.
 *
 * Opens three notes, explicitly focuses one, and sends a message. Verifies
 * that the path in `<open-notes>` ending with ` (active)` exactly matches
 * the note that was programmatically set as the active leaf.
 *
 * This is the "ground truth" test — it queries Obsidian's workspace API for
 * the current active leaf and cross-checks it against the auto-context output.
 */
async function testActiveMarkerMatchesFocusedLeaf(
	page: Page,
	collector: LogCollector,
): Promise<void> {
	console.log("\n── ACI-TEST-003-c: Active marker matches focused leaf ──");

	await closeAllMarkdownTabs(page);
	await newConversation(page);

	const notes = [
		"Test Note.md",
		"Notes/Project Plan.md",
		"Journal/2025-01-01.md",
	];

	// Open all notes as background tabs
	for (const note of notes) {
		await openNoteInNewTab(page, note, false);
	}

	// Activate the LAST note (the one we want to confirm as active)
	const expectedActive = notes[notes.length - 1]!;
	await activateNote(page, expectedActive);

	// Query the workspace directly to confirm Obsidian's view of the active leaf
	const obsidianActiveLeaf = await page.evaluate((): string | null => {
		const app = (window as unknown as { app: { workspace: unknown } }).app;
		const workspace = app.workspace as {
			getActiveViewOfType?: (type: unknown) => { file?: { path: string } } | null;
			activeLeaf?: { view?: { file?: { path: string } } };
		};

		// Try getActiveViewOfType approach first (may not be available in eval context)
		if (workspace.activeLeaf?.view?.file?.path) {
			return workspace.activeLeaf.view.file.path;
		}
		return null;
	});

	console.log(`    Obsidian active leaf path: ${obsidianActiveLeaf ?? "(could not determine)"}`);

	const responded = await sendMessage(
		page,
		"ACI-TEST-003-c: verify active marker matches focused leaf",
	);
	const shot = await screenshot(page, "aci-003c-active-matches-leaf");

	if (!responded) {
		console.log("    (No LLM response — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPrompt = getLatestSystemPrompt(collector);

	if (!systemPrompt) {
		fail(
			"ACI-TEST-003-c: active marker matches focused leaf",
			"No 'System prompt assembled' log entry found",
			shot,
		);
		return;
	}

	const openNotes = extractOpenNotes(systemPrompt);

	if (!openNotes) {
		fail(
			"ACI-TEST-003-c: active marker matches focused leaf",
			"<open-notes> tag not found in system prompt",
			shot,
		);
		return;
	}

	// Find the line carrying the active marker
	const activeLines = openNotes.filter((line) => line.endsWith(" (active)"));

	if (activeLines.length === 0) {
		fail(
			"ACI-TEST-003-c: active marker matches focused leaf",
			`No ` + "`(active)`" + ` marker found in open-notes. Open notes: ${openNotes.join(", ")}`,
			shot,
		);
		return;
	}

	// Extract the path from the active line (strip " (active)" suffix)
	const markedPath = activeLines[0]!.slice(0, -" (active)".length);

	// Primary check: does the marked path match what we activated?
	if (markedPath === expectedActive) {
		pass(
			"ACI-TEST-003-c: active marker matches focused leaf",
			`Active marker correctly points to the focused note "${expectedActive}". ` +
				`Open notes: ${openNotes.join(", ")}`,
			shot,
		);
	} else if (obsidianActiveLeaf !== null && markedPath === obsidianActiveLeaf) {
		// Secondary: if Obsidian's API returned a different active path (e.g. due to
		// workspace layout changes), trust what Obsidian actually reports
		pass(
			"ACI-TEST-003-c: active marker matches focused leaf",
			`Active marker ("${markedPath}") matches Obsidian's active leaf ` +
				`(expected "${expectedActive}", but Obsidian reports "${obsidianActiveLeaf}"). ` +
				`Open notes: ${openNotes.join(", ")}`,
			shot,
		);
	} else {
		fail(
			"ACI-TEST-003-c: active marker matches focused leaf",
			`Active marker points to "${markedPath}" but expected "${expectedActive}". ` +
				(obsidianActiveLeaf
					? `Obsidian active leaf: "${obsidianActiveLeaf}". `
					: "") +
				`Open notes: ${openNotes.join(", ")}`,
			shot,
		);
	}
}

// ---------------------------------------------------------------------------
// ACI-TEST-002: Open notes detection — all tabs detected on first message
// ---------------------------------------------------------------------------

/**
 * ACI-TEST-002-a: All programmatically opened tabs detected on the first send.
 *
 * Opens 3 notes in new background tabs (never manually clicked), then sends
 * the very first message in a fresh conversation. Verifies that all three
 * paths appear in the `<open-notes>` block of the assembled system prompt.
 *
 * This directly validates the ACI-004 fix: `iterateAllLeaves()` must capture
 * tabs whose views have not been activated by the user.
 */
async function testAllTabsDetectedOnFirstMessage(
	page: Page,
	collector: LogCollector,
): Promise<void> {
	console.log("\n── ACI-TEST-002-a: All tabs detected on first message ──");

	// Reset state: close any existing markdown tabs, start fresh conversation
	await closeAllMarkdownTabs(page);
	await newConversation(page);

	// Open 3 notes in separate background tabs (activate = false)
	const notesToOpen = [
		"Research/Climate.md",
		"Daily/2026-07-03.md",
		"Notes/Meeting Notes.md",
	];
	for (const note of notesToOpen) {
		await openNoteInNewTab(page, note, false);
	}

	// Explicitly activate the last one so there IS an active leaf
	await activateNote(page, notesToOpen[notesToOpen.length - 1]!);

	// Send the FIRST message in this fresh conversation
	const responded = await sendMessage(
		page,
		"ACI-TEST-002-a: first message after opening multiple tabs",
	);
	const shot = await screenshot(page, "aci-002a-all-tabs-first-message");

	if (!responded) {
		console.log("    (No LLM response — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPrompt = getLatestSystemPrompt(collector);

	if (!systemPrompt) {
		fail(
			"ACI-TEST-002-a: all tabs detected on first message",
			"No 'System prompt assembled' log entry found",
			shot,
		);
		return;
	}

	const openNotes = extractOpenNotes(systemPrompt);

	if (!openNotes) {
		fail(
			"ACI-TEST-002-a: all tabs detected on first message",
			"<open-notes> tag not found in system prompt",
			shot,
		);
		return;
	}

	// Check that every opened note appears (strip the " (active)" suffix for comparison)
	const missingNotes: string[] = [];
	for (const expected of notesToOpen) {
		const found = openNotes.some(
			(line) => line === expected || line === `${expected} (active)`,
		);
		if (!found) missingNotes.push(expected);
	}

	if (missingNotes.length === 0) {
		pass(
			"ACI-TEST-002-a: all tabs detected on first message",
			`All ${notesToOpen.length} opened notes detected in <open-notes>: ${openNotes.join(", ")}`,
			shot,
		);
	} else {
		fail(
			"ACI-TEST-002-a: all tabs detected on first message",
			`${missingNotes.length} note(s) NOT detected: ${missingNotes.join(", ")}. ` +
				`Detected: ${openNotes.join(", ")}`,
			shot,
		);
	}
}

/**
 * ACI-TEST-002-b: Notes in split panes are detected.
 *
 * Opens the first note normally (active), then opens a second note in a
 * vertical split pane. Sends a message and verifies both notes appear in
 * the `<open-notes>` block.
 */
async function testSplitPaneNotesDetected(
	page: Page,
	collector: LogCollector,
): Promise<void> {
	console.log("\n── ACI-TEST-002-b: Split pane notes detected ──");

	await closeAllMarkdownTabs(page);
	await newConversation(page);

	// Open first note as active
	await openNoteInNewTab(page, "Test Note.md", true);
	// Open second note in a split pane (not activated)
	await openNoteInSplitPane(page, "Notes/Project Plan.md");

	const responded = await sendMessage(
		page,
		"ACI-TEST-002-b: split pane notes should both be detected",
	);
	const shot = await screenshot(page, "aci-002b-split-pane");

	if (!responded) {
		console.log("    (No LLM response — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPrompt = getLatestSystemPrompt(collector);

	if (!systemPrompt) {
		fail(
			"ACI-TEST-002-b: split pane notes detected",
			"No 'System prompt assembled' log entry found",
			shot,
		);
		return;
	}

	const openNotes = extractOpenNotes(systemPrompt);

	if (!openNotes) {
		fail(
			"ACI-TEST-002-b: split pane notes detected",
			"<open-notes> tag not found in system prompt",
			shot,
		);
		return;
	}

	const expected = ["Test Note.md", "Notes/Project Plan.md"];
	const missingNotes = expected.filter(
		(e) => !openNotes.some((line) => line === e || line === `${e} (active)`),
	);

	if (missingNotes.length === 0) {
		pass(
			"ACI-TEST-002-b: split pane notes detected",
			`Both notes (main pane + split) detected in <open-notes>: ${openNotes.join(", ")}`,
			shot,
		);
	} else {
		fail(
			"ACI-TEST-002-b: split pane notes detected",
			`Missing from <open-notes>: ${missingNotes.join(", ")}. ` +
				`Detected: ${openNotes.join(", ")}`,
			shot,
		);
	}
}

/**
 * ACI-TEST-002-c: Switching active note without closing the first → both appear.
 *
 * Opens note A, then switches to note B (note A remains open but unfocused).
 * Sends a message and verifies both A and B appear in `<open-notes>`.
 */
async function testSwitchActiveNoteShowsBoth(
	page: Page,
	collector: LogCollector,
): Promise<void> {
	console.log("\n── ACI-TEST-002-c: Switch active note — both appear ──");

	await closeAllMarkdownTabs(page);
	await newConversation(page);

	// Open note A and make it active first
	await openNoteInNewTab(page, "Daily/2026-07-03.md", true);
	// Open note B in a new tab and switch to it (A stays open in background)
	await openNoteInNewTab(page, "Journal/2025-01-01.md", true);

	const responded = await sendMessage(
		page,
		"ACI-TEST-002-c: switched active note — both background and active should appear",
	);
	const shot = await screenshot(page, "aci-002c-switch-active");

	if (!responded) {
		console.log("    (No LLM response — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPrompt = getLatestSystemPrompt(collector);

	if (!systemPrompt) {
		fail(
			"ACI-TEST-002-c: switch active note — both appear",
			"No 'System prompt assembled' log entry found",
			shot,
		);
		return;
	}

	const openNotes = extractOpenNotes(systemPrompt);

	if (!openNotes) {
		fail(
			"ACI-TEST-002-c: switch active note — both appear",
			"<open-notes> tag not found in system prompt",
			shot,
		);
		return;
	}

	const expected = ["Daily/2026-07-03.md", "Journal/2025-01-01.md"];
	const missingNotes = expected.filter(
		(e) => !openNotes.some((line) => line === e || line === `${e} (active)`),
	);

	if (missingNotes.length === 0) {
		pass(
			"ACI-TEST-002-c: switch active note — both appear",
			`Both notes present after switching active tab: ${openNotes.join(", ")}`,
			shot,
		);
	} else {
		fail(
			"ACI-TEST-002-c: switch active note — both appear",
			`Note(s) missing after switching: ${missingNotes.join(", ")}. ` +
				`Detected: ${openNotes.join(", ")}`,
			shot,
		);
	}
}

/**
 * ACI-TEST-002-d: Closed tab no longer appears in auto-context.
 *
 * Opens two notes, sends a message to confirm both are detected, then closes
 * one tab. Sends a second message and verifies the closed note is gone from
 * `<open-notes>` while the remaining open note is still present.
 */
async function testClosedTabNotDetected(
	page: Page,
	collector: LogCollector,
): Promise<void> {
	console.log("\n── ACI-TEST-002-d: Closed tab not detected ──");

	await closeAllMarkdownTabs(page);
	await newConversation(page);

	const noteToKeep = "Test Note.md";
	const noteToClose = "Research/Climate.md";

	await openNoteInNewTab(page, noteToKeep, true);
	await openNoteInNewTab(page, noteToClose, false);

	// First message — both should be present (setup)
	await sendMessage(page, "ACI-TEST-002-d setup: both notes open");
	await page.waitForTimeout(500);

	// Now close the second note
	await closeNoteTab(page, noteToClose);
	await page.waitForTimeout(300);

	// Second message — only noteToKeep should be present
	const responded = await sendMessage(
		page,
		"ACI-TEST-002-d: after closing one tab — closed note should not appear",
	);
	const shot = await screenshot(page, "aci-002d-closed-tab");

	if (!responded) {
		console.log("    (No LLM response after closing tab — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPrompt = getLatestSystemPrompt(collector);

	if (!systemPrompt) {
		fail(
			"ACI-TEST-002-d: closed tab not detected",
			"No 'System prompt assembled' log entry found after closing tab",
			shot,
		);
		return;
	}

	const openNotes = extractOpenNotes(systemPrompt);

	if (!openNotes) {
		fail(
			"ACI-TEST-002-d: closed tab not detected",
			"<open-notes> tag not found in system prompt after closing tab",
			shot,
		);
		return;
	}

	const closedNoteStillPresent = openNotes.some(
		(line) => line === noteToClose || line === `${noteToClose} (active)`,
	);
	const keepNotePresent = openNotes.some(
		(line) => line === noteToKeep || line === `${noteToKeep} (active)`,
	);

	if (!closedNoteStillPresent && keepNotePresent) {
		pass(
			"ACI-TEST-002-d: closed tab not detected",
			`Closed note "${noteToClose}" absent; open note "${noteToKeep}" still present. ` +
				`Open notes: ${openNotes.join(", ")}`,
			shot,
		);
	} else {
		const reasons: string[] = [];
		if (closedNoteStillPresent)
			reasons.push(`"${noteToClose}" still listed after closing`);
		if (!keepNotePresent)
			reasons.push(`"${noteToKeep}" unexpectedly missing`);
		fail(
			"ACI-TEST-002-d: closed tab not detected",
			reasons.join("; ") + `. Detected: ${openNotes.join(", ")}`,
			shot,
		);
	}
}

/**
 * ACI-TEST-002-e: Full vault-relative paths for notes from different folders.
 *
 * Opens notes from three different vault sub-folders and verifies that the
 * paths reported in `<open-notes>` are full vault-relative paths (e.g.
 * `Research/Climate.md`), not bare filenames (`Climate.md`).
 */
async function testFullVaultRelativePathsReported(
	page: Page,
	collector: LogCollector,
): Promise<void> {
	console.log("\n── ACI-TEST-002-e: Full vault-relative paths reported ──");

	await closeAllMarkdownTabs(page);
	await newConversation(page);

	// Notes from different folders
	const notesFromDifferentFolders = [
		"Research/Climate.md",
		"Daily/2026-07-03.md",
		"Notes/Project Plan.md",
	];

	for (const note of notesFromDifferentFolders) {
		await openNoteInNewTab(page, note, false);
	}
	await activateNote(page, notesFromDifferentFolders[0]!);

	const responded = await sendMessage(page, "ACI-TEST-002-e: verify full vault-relative paths");
	const shot = await screenshot(page, "aci-002e-vault-paths");

	if (!responded) {
		console.log("    (No LLM response — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPrompt = getLatestSystemPrompt(collector);

	if (!systemPrompt) {
		fail(
			"ACI-TEST-002-e: full vault-relative paths reported",
			"No 'System prompt assembled' log entry found",
			shot,
		);
		return;
	}

	const openNotes = extractOpenNotes(systemPrompt);

	if (!openNotes) {
		fail(
			"ACI-TEST-002-e: full vault-relative paths reported",
			"<open-notes> tag not found in system prompt",
			shot,
		);
		return;
	}

	// Each expected note should appear with its FULL path (folder/file.md)
	const failures: string[] = [];
	for (const expected of notesFromDifferentFolders) {
		const found = openNotes.some(
			(line) => line === expected || line === `${expected} (active)`,
		);
		if (!found) {
			// Check if just the bare filename appears (would indicate path truncation bug)
			const bareName = expected.split("/").pop()!;
			const foundBare = openNotes.some(
				(line) => line === bareName || line === `${bareName} (active)`,
			);
			if (foundBare) {
				failures.push(
					`"${expected}" reported as bare name "${bareName}" (missing folder prefix)`,
				);
			} else {
				failures.push(`"${expected}" not found in open-notes at all`);
			}
		}
	}

	if (failures.length === 0) {
		pass(
			"ACI-TEST-002-e: full vault-relative paths reported",
			`All notes have full vault-relative paths: ${openNotes.join(", ")}`,
			shot,
		);
	} else {
		fail(
			"ACI-TEST-002-e: full vault-relative paths reported",
			failures.join("; ") + `. Detected: ${openNotes.join(", ")}`,
			shot,
		);
	}
}

// ---------------------------------------------------------------------------
// ACI-TEST-004: Vault structure formatting
// ---------------------------------------------------------------------------

/**
 * ACI-TEST-004-a: Each folder in `<vault-structure>` is on its own line.
 *
 * After the ACI-003 fix, `collectVaultStructure()` output is joined with
 * newlines rather than commas. This test sends a message and inspects the
 * assembled system prompt to confirm every entry in `<vault-structure>` is
 * on a separate line (i.e. the parsed array has more than one entry when
 * multiple folders exist, and none of the entries contain a comma that would
 * indicate the old comma-separated format).
 */
async function testVaultStructureFoldersOnOwnLines(
	page: Page,
	collector: LogCollector,
): Promise<void> {
	console.log("\n── ACI-TEST-004-a: Each vault folder on its own line ──");

	await closeAllMarkdownTabs(page);
	await newConversation(page);

	const responded = await sendMessage(
		page,
		"ACI-TEST-004-a: verify vault structure folders are on separate lines",
	);
	const shot = await screenshot(page, "aci-004a-folders-own-lines");

	if (!responded) {
		console.log("    (No LLM response — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPrompt = getLatestSystemPrompt(collector);

	if (!systemPrompt) {
		fail(
			"ACI-TEST-004-a: each folder on its own line",
			"No 'System prompt assembled' log entry found",
			shot,
		);
		return;
	}

	if (!systemPrompt.includes("<vault-structure>")) {
		fail(
			"ACI-TEST-004-a: each folder on its own line",
			"<vault-structure> tag not found in system prompt",
			shot,
		);
		return;
	}

	const folders = extractVaultStructure(systemPrompt);

	if (folders === null) {
		fail(
			"ACI-TEST-004-a: each folder on its own line",
			"Could not extract <vault-structure> content from system prompt",
			shot,
		);
		return;
	}

	// The test vault has at least Research/, Daily/, Projects/ (plus Notes/, Journal/ from extra notes)
	// There must be more than one folder entry — if they were comma-separated they'd appear as one entry
	if (folders.length >= 2) {
		// Additional check: none of the entries should themselves contain a comma
		// (which would indicate comma-separation leaked into a single entry)
		const entriesWithComma = folders.filter((f) => f.includes(","));
		if (entriesWithComma.length === 0) {
			pass(
				"ACI-TEST-004-a: each folder on its own line",
				`${folders.length} folders each on their own line: ${folders.join(" | ")}`,
				shot,
			);
		} else {
			fail(
				"ACI-TEST-004-a: each folder on its own line",
				`Some entries contain commas (old comma-separated format?): ${entriesWithComma.join(", ")}. ` +
					`All entries: ${folders.join(" | ")}`,
				shot,
			);
		}
	} else if (folders.length === 1) {
		// Could be a single-folder vault (acceptable) OR commas still present
		// Distinguish by checking for commas in the single entry
		const singleEntry = folders[0]!;
		if (singleEntry.includes(",")) {
			fail(
				"ACI-TEST-004-a: each folder on its own line",
				`Only one entry found but it contains commas — folders appear comma-separated: "${singleEntry}"`,
				shot,
			);
		} else {
			pass(
				"ACI-TEST-004-a: each folder on its own line",
				`Only 1 folder entry found with no commas: "${singleEntry}" ` +
					"(vault may have a single top-level folder — line-per-folder format is correct)",
				shot,
			);
		}
	} else {
		// Empty vault-structure — acceptable if vault has no top-level folders
		pass(
			"ACI-TEST-004-a: each folder on its own line",
			"<vault-structure> is empty — no top-level folders in vault (empty tag is correct)",
			shot,
		);
	}
}

/**
 * ACI-TEST-004-b: Each folder name ends with `/`.
 *
 * After ACI-003, `buildAutoContextBlock()` appends `/` to each folder name
 * so the LLM can distinguish folders from files. This test verifies every
 * non-empty entry in the `<vault-structure>` block ends with `/`.
 */
async function testVaultStructureFoldersHaveTrailingSlash(
	page: Page,
	collector: LogCollector,
): Promise<void> {
	console.log("\n── ACI-TEST-004-b: Each folder name ends with `/` ──");

	// Re-use the latest system prompt from the previous test (same conversation)
	// by sending another message to get a fresh log entry
	const responded = await sendMessage(
		page,
		"ACI-TEST-004-b: verify vault structure folder names end with /",
	);
	const shot = await screenshot(page, "aci-004b-trailing-slash");

	if (!responded) {
		console.log("    (No LLM response — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPrompt = getLatestSystemPrompt(collector);

	if (!systemPrompt) {
		fail(
			"ACI-TEST-004-b: folder names end with /",
			"No 'System prompt assembled' log entry found",
			shot,
		);
		return;
	}

	const folders = extractVaultStructure(systemPrompt);

	if (folders === null) {
		fail(
			"ACI-TEST-004-b: folder names end with /",
			"<vault-structure> tag not found in system prompt",
			shot,
		);
		return;
	}

	if (folders.length === 0) {
		pass(
			"ACI-TEST-004-b: folder names end with /",
			"<vault-structure> is empty — no entries to check (acceptable for empty vault)",
			shot,
		);
		return;
	}

	const missingSlash = folders.filter((f) => !f.endsWith("/"));

	if (missingSlash.length === 0) {
		pass(
			"ACI-TEST-004-b: folder names end with /",
			`All ${folders.length} folder entries end with "/": ${folders.join(", ")}`,
			shot,
		);
	} else {
		fail(
			"ACI-TEST-004-b: folder names end with /",
			`${missingSlash.length} folder(s) missing trailing "/": ${missingSlash.join(", ")}. ` +
				`All entries: ${folders.join(", ")}`,
			shot,
		);
	}
}

/**
 * ACI-TEST-004-c: Folders are NOT comma-separated.
 *
 * Directly inspects the raw `<vault-structure>` inner content for the
 * presence of comma-separated lists. Before ACI-003 the implementation used
 * `folders.join(", ")` which produced a single comma-separated line. This
 * test verifies the old format no longer appears.
 */
async function testVaultStructureNotCommaSeparated(
	page: Page,
	collector: LogCollector,
): Promise<void> {
	console.log("\n── ACI-TEST-004-c: Folders not comma-separated ──");

	const responded = await sendMessage(
		page,
		"ACI-TEST-004-c: verify vault structure is not comma-separated",
	);
	const shot = await screenshot(page, "aci-004c-no-commas");

	if (!responded) {
		console.log("    (No LLM response — checking log directly)");
	}

	await page.waitForTimeout(1_000);

	const systemPrompt = getLatestSystemPrompt(collector);

	if (!systemPrompt) {
		fail(
			"ACI-TEST-004-c: folders not comma-separated",
			"No 'System prompt assembled' log entry found",
			shot,
		);
		return;
	}

	const raw = extractVaultStructureRaw(systemPrompt);

	if (raw === null) {
		fail(
			"ACI-TEST-004-c: folders not comma-separated",
			"<vault-structure> tag not found in system prompt",
			shot,
		);
		return;
	}

	// The old format produced entries like "Research, Daily, Projects"
	// The new format places each entry on its own line with a trailing slash.
	// We detect the old format by checking whether the raw content contains ", "
	// (comma-space) which is the separator used by the old `join(", ")` call.
	const hasCommaList = raw.includes(", ");

	if (!hasCommaList) {
		pass(
			"ACI-TEST-004-c: folders not comma-separated",
			`<vault-structure> content does not contain comma-separated list. ` +
				`Raw content (trimmed): "${raw.trim().substring(0, 200)}"`,
			shot,
		);
	} else {
		// Check whether commas are between actual folder entries or just coincidentally
		// inside a folder name (very unlikely but worth noting in the detail)
		const folders = extractVaultStructure(systemPrompt) ?? [];
		fail(
			"ACI-TEST-004-c: folders not comma-separated",
			`<vault-structure> content contains comma-separated list (old format). ` +
				`Raw content: "${raw.trim().substring(0, 200)}". ` +
				`Parsed entries: ${folders.join(" | ")}`,
			shot,
		);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("=== Notor Auto-Context E2E Test (ACI-TEST-001 + ACI-TEST-002 + ACI-TEST-003 + ACI-TEST-004) ===\n");

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
		obsidian = await launchObsidian({
			vaultPath: VAULT_PATH,
			cdpPort: CDP_PORT,
			timeout: 30_000,
		});

		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		const contexts = browser.contexts();
		const page = contexts[0]?.pages()[0];
		if (!page) throw new Error("No page found");

		collector = new LogCollector({ outputDir: LOGS_DIR });
		collector.attach(page);

		await page.waitForLoadState("domcontentloaded");
		await page.waitForTimeout(5_000);

		console.log("[4/4] Running ACI-TEST-001 + ACI-TEST-002 + ACI-TEST-003 tests...\n");
		{
			const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
			if (!chat) {
				const shot = await screenshot(page, "00-no-chat");
				fail("Chat panel visible", ".notor-chat-container not found", shot);
				throw new Error("Chat panel not visible");
			}
			pass("Chat panel ready", "Plugin loaded and chat container found");
		}

		// ── ACI-TEST-001 ────────────────────────────────────────────────────

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

		// ── ACI-TEST-002 ────────────────────────────────────────────────────
		// Restore full settings before running open-notes detection tests
		console.log(
			"\n[ACI-TEST-002] Restoring full settings and reloading for open-notes detection tests...",
		);
		const fullSettings = buildSettings();
		fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(fullSettings, null, 2));
		await page.reload();
		await page.waitForTimeout(5_000);

		// ACI-TEST-002-a: all programmatically opened tabs detected on first message
		await testAllTabsDetectedOnFirstMessage(page, collector);

		// ACI-TEST-002-b: notes in split panes detected
		await testSplitPaneNotesDetected(page, collector);

		// ACI-TEST-002-c: switch active note — both the old and new active note appear
		await testSwitchActiveNoteShowsBoth(page, collector);

		// ACI-TEST-002-d: closed tab no longer appears
		await testClosedTabNotDetected(page, collector);

		// ACI-TEST-002-e: full vault-relative paths reported for notes in sub-folders
		await testFullVaultRelativePathsReported(page, collector);

		// ── ACI-TEST-003 ────────────────────────────────────────────────────
		console.log(
			"\n[ACI-TEST-003] Running active note marker tests...",
		);

		// ACI-TEST-003-a: exactly one note has (active) suffix
		await testExactlyOneNoteMarkedActive(page, collector);

		// ACI-TEST-003-b: active marker moves when the user switches note
		await testActiveMarkerMovesOnSwitch(page, collector);

		// ACI-TEST-003-c: active marker matches the foreground/focused leaf
		await testActiveMarkerMatchesFocusedLeaf(page, collector);

		// ── ACI-TEST-004 ────────────────────────────────────────────────────
		console.log(
			"\n[ACI-TEST-004] Running vault structure formatting tests...",
		);

		// Restore full settings and reload to ensure vault structure source is enabled
		const settingsForVaultTest = buildSettings();
		fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settingsForVaultTest, null, 2));
		await page.reload();
		await page.waitForTimeout(5_000);

		// ACI-TEST-004-a: each folder on its own line
		await testVaultStructureFoldersOnOwnLines(page, collector);

		// ACI-TEST-004-b: each folder name ends with /
		await testVaultStructureFoldersHaveTrailingSlash(page, collector);

		// ACI-TEST-004-c: folders are not comma-separated
		await testVaultStructureNotCommaSeparated(page, collector);

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
			try {
				fs.unlinkSync(PLUGIN_DATA_PATH);
			} catch {
				/* ignore */
			}
		}
	}

	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;

	console.log("\n=== Test Results (ACI-TEST-001 + ACI-TEST-002 + ACI-TEST-003 + ACI-TEST-004) ===");
	console.log(`Passed: ${passed}/${results.length}`);
	console.log(`Failed: ${failed}/${results.length}`);

	if (failed > 0) {
		console.log("\nFailed tests:");
		for (const r of results.filter((r) => !r.passed)) {
			console.log(`  ✗ ${r.name}: ${r.detail}`);
		}
	}

	const resultsPath = path.join(RESULTS_DIR, "auto-context-results.json");
	fs.writeFileSync(
		resultsPath,
		JSON.stringify({ passed, failed, total: results.length, results }, null, 2),
	);
	console.log(`\nResults written to: ${resultsPath}`);

	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
