/**
 * Shared E2E test helpers — extracted from duplicated code across 37 test scripts.
 *
 * Provides constants, page interaction utilities, and settings builders
 * so individual test scripts can focus on test logic only.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Browser, ElementHandle } from "playwright-core";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = path.resolve(LIB_DIR, "..");
export const PROJECT_ROOT = path.resolve(E2E_DIR, "..");
export const BUILD_DIR = path.join(PROJECT_ROOT, "build");
export const VAULT_PATH = path.resolve(E2E_DIR, "test-vault");
export const PLUGIN_DATA_PATH = path.join(BUILD_DIR, "data.json");
export const RESULTS_DIR = path.resolve(E2E_DIR, "results");
export const LOGS_DIR = path.join(RESULTS_DIR, "logs");

export const CDP_PORT = 9222;

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

export const RESPONSE_TIMEOUT_MS = 90_000;
export const POLL_INTERVAL_MS = 1_500;

// ---------------------------------------------------------------------------
// Page finders
// ---------------------------------------------------------------------------

/**
 * Find the Obsidian vault page across all CDP contexts.
 *
 * Obsidian spawns multiple renderer processes (title-bar, preload helpers).
 * This polls every 500ms until a page containing `.notor-chat-container`
 * is found, or the timeout expires.
 */
export async function findVaultPage(browser: Browser, timeout = 20_000): Promise<Page> {
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
// Element helpers
// ---------------------------------------------------------------------------

/**
 * Wait for an element matching `selector` with a timeout.
 * Returns null if not found (instead of throwing).
 */
export async function waitForSelector(
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

// ---------------------------------------------------------------------------
// LLM interaction helpers
// ---------------------------------------------------------------------------

/**
 * Wait for any pending LLM response to finish.
 * Polls until the contenteditable input is re-enabled or timeout.
 */
export async function waitForResponse(
	page: Page,
	timeoutMs = RESPONSE_TIMEOUT_MS,
	pollMs = POLL_INTERVAL_MS,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(pollMs);

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
 * The input is a contenteditable div.
 *
 * Uses `page.evaluate()` to set the contenteditable div's text directly,
 * avoiding `keyboard.type()` which dispatches Enter keydown events for `\n`
 * characters — those would trigger the plugin's Enter-to-send handler and
 * prematurely send a partial message.
 */
export async function sendMessage(page: Page, message: string): Promise<boolean> {
	const found = await page.evaluate((msg) => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		if (!el) return false;
		el.focus();
		el.textContent = msg;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	}, message);
	if (!found) throw new Error("Chat input not found");

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
 * Send a message and auto-approve any approval dialog that appears mid-response.
 *
 * Uses `page.evaluate()` to set the contenteditable div's text directly,
 * avoiding `keyboard.type()` which dispatches Enter keydown events for `\n`
 * characters — those would trigger the plugin's Enter-to-send handler and
 * prematurely send a partial message.
 */
export async function sendMessageWithApprovalHandling(
	page: Page,
	message: string,
	timeoutMs = RESPONSE_TIMEOUT_MS,
	pollMs = POLL_INTERVAL_MS,
): Promise<{ responded: boolean; approved: boolean }> {
	const found = await page.evaluate((msg) => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		if (!el) return false;
		el.focus();
		el.textContent = msg;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	}, message);
	if (!found) throw new Error("Chat input not found");

	await page.waitForTimeout(300);

	const sendBtn = await page.$(".notor-send-btn");
	if (sendBtn) await sendBtn.click();
	else await page.keyboard.press("Enter");

	console.log(`    → Sent: "${message.substring(0, 80)}${message.length > 80 ? "..." : ""}"`);

	const start = Date.now();
	let approved = false;
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(pollMs);

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
export async function getLastAssistantMessage(page: Page): Promise<string> {
	const msgs = await page.$$(".notor-message-assistant");
	if (msgs.length === 0) return "";
	const last = msgs[msgs.length - 1];
	return (await last!.textContent()) ?? "";
}

/**
 * Get tool call names from all visible tool-call cards.
 */
export async function getLastToolCallNames(page: Page): Promise<string[]> {
	const cards = await page.$$(".notor-tool-call");
	const names: string[] = [];
	for (const card of cards) {
		const header = await card.$(".notor-tool-call-header, .notor-tool-name");
		const text = await header?.textContent();
		if (text) names.push(text.trim());
	}
	return names;
}

// ---------------------------------------------------------------------------
// UI action helpers
// ---------------------------------------------------------------------------

/**
 * Start a fresh conversation.
 */
export async function newConversation(page: Page): Promise<void> {
	const btn = await page.$(".notor-chat-header-btn[aria-label='New conversation']");
	if (btn) {
		await btn.click();
		await page.waitForTimeout(1_500);
	}
}

/**
 * Switch mode to Plan or Act.
 */
export async function setMode(page: Page, mode: "Plan" | "Act"): Promise<void> {
	const toggle = await page.$(".notor-mode-toggle");
	if (!toggle) throw new Error("Mode toggle not found");

	const current = await toggle.textContent();
	if (current?.trim() === mode) return;

	await toggle.click();
	await page.waitForTimeout(400);

	const updated = await toggle.textContent();
	if (updated?.trim() !== mode) {
		throw new Error(`Failed to switch to ${mode} mode`);
	}
}

/**
 * Select a persona from the settings popover dropdown.
 * Pass `null` to deactivate (select "None").
 */
export async function selectPersona(page: Page, personaName: string | null): Promise<boolean> {
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
// Settings builder
// ---------------------------------------------------------------------------

/**
 * Build the standard plugin settings for e2e tests.
 * Uses AWS Bedrock with the default profile. Pass overrides to customize
 * specific fields (shallow merge at top level, deep merge for auto_approve).
 */
export function buildDefaultSettings(overrides?: Record<string, unknown>): Record<string, unknown> {
	const base: Record<string, unknown> = {
		notor_dir: "notor/",
		active_provider: "bedrock",
		providers: [
			{ type: "local", enabled: false, display_name: "Local", endpoint: "http://localhost:11434/v1" },
			{
				type: "bedrock", enabled: true, display_name: "AWS Bedrock",
				aws_auth_method: "profile", aws_profile: "default",
				region: "us-east-1", model_id: "deepseek.v3.2",
			},
		],
		auto_approve: {
			read_note: true, search_vault: true, list_vault: true, read_frontmatter: true,
			fetch_webpage: true, write_note: false, replace_in_note: false,
			update_frontmatter: false, manage_tags: false, execute_command: false,
			read_file: false, read_docx: false, write_docx: false,
		},
		mode: "plan",
		open_notes_on_access: true,
		history_path: ".obsidian/plugins/notor/history/",
		history_max_size_mb: 500,
		history_max_age_days: 90,
		checkpoint_path: ".obsidian/plugins/notor/checkpoints/",
		checkpoint_max_per_conversation: 100,
		checkpoint_max_age_days: 30,
		model_pricing: {},
		auto_context_open_notes: false,
		auto_context_vault_structure: false,
		auto_context_os: false,
		log_level: "debug",
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
		active_persona: "",
		vault_event_hooks: {
			on_note_open: [], on_note_create: [], on_save: [],
			on_manual_save: [], on_tag_change: [], on_schedule: [],
		},
		vault_event_debounce_seconds: 5,
		workflow_concurrency_limit: 3,
		workflow_activity_indicator_count: 5,
		mcp_servers: {},
		read_file_allowed_paths: [],
		write_docx_default_output_dir: "",
		write_docx_default_template_path: "",
	};

	if (!overrides) return base;

	// Deep-merge auto_approve if provided
	if (overrides.auto_approve && typeof overrides.auto_approve === "object") {
		base.auto_approve = { ...(base.auto_approve as Record<string, unknown>), ...overrides.auto_approve as Record<string, unknown> };
		const { auto_approve: _, ...rest } = overrides;
		return { ...base, ...rest };
	}

	return { ...base, ...overrides };
}
