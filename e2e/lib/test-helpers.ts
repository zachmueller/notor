/**
 * Shared E2E test helpers — extracted from duplicated code across 37 test scripts.
 *
 * Provides constants, page interaction utilities, and settings builders
 * so individual test scripts can focus on test logic only.
 */

import * as fs from "node:fs";
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
 * Polls until the send button is visible (stop button hidden), which indicates
 * setRespondingState(false) has been called.
 */
export async function waitForResponse(
	page: Page,
	timeoutMs = RESPONSE_TIMEOUT_MS,
	pollMs = POLL_INTERVAL_MS,
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(pollMs);

		const responseComplete = await page.evaluate(() => {
			const sendBtn = document.querySelector(".notor-send-btn");
			const stopBtn = document.querySelector(".notor-stop-btn");
			const sendVisible = sendBtn && !sendBtn.classList.contains("notor-hidden");
			const stopHidden = !stopBtn || stopBtn.classList.contains("notor-hidden");
			return sendVisible && stopHidden;
		});

		if (responseComplete) return true;

		const lastMsg = await page.$(".notor-message-assistant:last-child .notor-message-content");
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

	// Use keyboard Enter to send — more reliable than clicking the send button
	// which may not be visible depending on UI state
	await page.focus(".notor-text-input");
	await page.keyboard.press("Enter");
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

	// Use visible send button if available, otherwise fall back to Enter key.
	// page.$() matches hidden elements, so check visibility via :not(.notor-hidden).
	const sendBtn = await page.$(".notor-send-btn:not(.notor-hidden)");
	if (sendBtn) await sendBtn.click();
	else {
		await page.focus(".notor-text-input");
		await page.keyboard.press("Enter");
	}

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

		const responseComplete = await page.evaluate(() => {
			const sendBtn = document.querySelector(".notor-send-btn");
			const stopBtn = document.querySelector(".notor-stop-btn");
			const sendVisible = sendBtn && !sendBtn.classList.contains("notor-hidden");
			const stopHidden = !stopBtn || stopBtn.classList.contains("notor-hidden");
			return sendVisible && stopHidden;
		});
		if (responseComplete) {
			return { responded: true, approved };
		}
	}
	return { responded: false, approved };
}

/**
 * Get the text of the most recent assistant message.
 * Targets the inner .notor-message-content to exclude fork button and token annotation.
 */
export async function getLastAssistantMessage(page: Page): Promise<string> {
	const msgs = await page.$$(".notor-message-assistant .notor-message-content");
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

/**
 * Force-abort any in-progress LLM response and wait for the chat input to
 * become editable again. Call this at the start of tests that require a clean
 * input state, especially after tests that may leave a response in flight.
 *
 * Tries the visible stop button first, then falls back to aborting via the
 * plugin's AbortController. Waits up to 20 seconds for the input to re-enable.
 */
export async function ensureCleanState(page: Page): Promise<void> {
	const isResponding = await page.evaluate(() => {
		const stopBtn = document.querySelector(".notor-stop-btn");
		return stopBtn && !stopBtn.classList.contains("notor-hidden");
	});

	if (!isResponding) return;

	console.log("  ⚠ Response in progress — aborting...");

	// Try clicking the stop button
	const stopBtn = await page.$(".notor-stop-btn:not(.notor-hidden)");
	if (stopBtn) {
		await stopBtn.click();
		console.log("  Clicked stop button");
	} else {
		// Fallback: abort via orchestrator's AbortController
		await page.evaluate(() => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			if (!plugin) return;
			try {
				const view = plugin.getChatView?.() ?? plugin.view;
				if (view) {
					const controller = view.getAbortController?.();
					if (controller) controller.abort();
				}
			} catch {}
		});
		console.log("  Aborted via orchestrator fallback");
	}

	// Wait for send button to become visible (response fully complete)
	for (let i = 0; i < 20; i++) {
		await page.waitForTimeout(1_000);
		const ready = await page.evaluate(() => {
			const sendBtn = document.querySelector(".notor-send-btn");
			return sendBtn && !sendBtn.classList.contains("notor-hidden");
		});
		if (ready) {
			console.log(`  Response state cleared after ${i + 1}s`);
			return;
		}
	}
	console.log("  ⚠ Still in responding state after 20s wait");
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
				region: "us-east-1", model_id: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
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
		// Extension settings — prevents settings migration from re-triggering on every reload.
		// Values mirror the old-style fields above.
		user_extension_settings: {
			fetch_webpage: {
				fetch_webpage_timeout: 15,
				fetch_webpage_max_download_mb: 5,
				fetch_webpage_max_output_chars: 50000,
			},
			web_search: {
				web_search_timeout: 30,
				web_search_default_num_results: 10,
			},
			execute_command: {
				execute_command_allowed_paths: [],
				execute_command_timeout: 30,
				execute_command_max_output_chars: 50000,
			},
			read_file: {
				image_max_dimension: 2048,
				image_compression_quality: 0.85,
				pdf_prefer_native: true,
				pdf_text_max_chars: 50000,
				pdf_native_max_size_mb: 10,
			},
			write_docx: {
				write_docx_default_output_dir: "",
				write_docx_default_template_path: "",
			},
		},
		user_shared_settings: {
			domain_denylist: [],
			read_file_allowed_paths: [],
		},
	};

	if (!overrides) return base;

	// Deep-merge auto_approve if provided
	if (overrides.auto_approve && typeof overrides.auto_approve === "object") {
		base.auto_approve = { ...(base.auto_approve as Record<string, unknown>), ...overrides.auto_approve as Record<string, unknown> };
		delete overrides.auto_approve;
	}

	const result = { ...base, ...overrides } as Record<string, unknown>;

	// Sync old-style field overrides into user_extension_settings / user_shared_settings
	// so scaffold tools (which read per-extension settings) see the overridden values.
	const extSettings = { ...(base.user_extension_settings as Record<string, Record<string, unknown>>) };
	const sharedSettings = { ...(base.user_shared_settings as Record<string, unknown>) };

	const extFieldMap: Record<string, string[]> = {
		fetch_webpage: ["fetch_webpage_timeout", "fetch_webpage_max_download_mb", "fetch_webpage_max_output_chars"],
		web_search: ["web_search_timeout", "web_search_default_num_results"],
		execute_command: ["execute_command_allowed_paths", "execute_command_timeout", "execute_command_max_output_chars"],
		read_file: ["image_max_dimension", "image_compression_quality", "pdf_prefer_native", "pdf_text_max_chars", "pdf_native_max_size_mb"],
		write_docx: ["write_docx_default_output_dir", "write_docx_default_template_path"],
	};
	const sharedFields = ["domain_denylist", "read_file_allowed_paths"];

	for (const [tool, fields] of Object.entries(extFieldMap)) {
		for (const field of fields) {
			if (field in overrides) {
				extSettings[tool] = { ...extSettings[tool], [field]: overrides[field] };
			}
		}
	}
	for (const field of sharedFields) {
		if (field in overrides) {
			sharedSettings[field] = overrides[field];
		}
	}

	result.user_extension_settings = extSettings;
	result.user_shared_settings = sharedSettings;
	return result;
}

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

/**
 * Write a clean workspace.json with a single chat panel.
 *
 * Call from a test config's `setupVault` callback to ensure Obsidian starts
 * with exactly one chat panel — prevents stale multi-panel layouts from
 * previous test runs affecting leaf count assertions.
 */
export function writeCleanWorkspace(vaultPath: string): void {
	const workspace = {
		main: {
			id: "e2e-main-split",
			type: "split",
			children: [{
				id: "e2e-main-tabs",
				type: "tabs",
				children: [{
					id: "e2e-chat-leaf",
					type: "leaf",
					state: {
						type: "notor-chat-view",
						state: {},
						icon: "message-square",
						title: "Notor chat",
					},
				}],
			}],
			direction: "vertical",
		},
		active: "e2e-chat-leaf",
		lastOpenFiles: [],
	};
	const wsPath = path.join(vaultPath, ".obsidian", "workspace.json");
	fs.writeFileSync(wsPath, JSON.stringify(workspace, null, 2));
}
