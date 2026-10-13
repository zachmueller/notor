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
// Obsidian settings helpers
// ---------------------------------------------------------------------------

/**
 * CSS scope for the active settings tab's content.
 *
 * Prefer this over a bare `.setting-item` query: Obsidian's left-sidebar search
 * pane renders three `.setting-item` rows of its own ("Collapse results",
 * "Show more context", "Explain search terms") that would otherwise pollute
 * counts and name lookups.
 *
 * Usable both as a Playwright selector (`page.click(...)`) and inside
 * `page.evaluate` (`document.querySelector(SETTINGS_CONTENT_SELECTOR)`).
 */
export const SETTINGS_CONTENT_SELECTOR = ".modal.mod-settings .vertical-tab-content";

/**
 * Force Obsidian to render the settings modal inside the main vault window.
 *
 * Obsidian 1.12 moved settings into a separate OS window by default. When the
 * `settingsPopoutWindow` vault config flag is on, `app.setting.open()` mounts
 * the modal into a detached `about:blank` popout that has NO `window.app` of
 * its own — the vault page owns the app object while the popout owns the DOM.
 * Consequences for e2e tests:
 *   - `document.querySelector(".setting-item")` on the vault page finds nothing
 *   - `ctx.screenshot()` only ever captures the chat view
 *   - `page.click()` against settings selectors times out
 *
 * Writing the flag to `false` before launch restores the pre-1.12 layout: the
 * modal renders into the vault page's own document, so plain `document` queries,
 * Playwright clicks, and `ctx.screenshot()` all work again.
 *
 * `runTest()` calls this for every test, so test scripts normally need not.
 * Obsidian preserves the flag when it rewrites `app.json`.
 */
export function disableSettingsPopout(vaultPath: string): void {
	const appJsonPath = path.join(vaultPath, ".obsidian", "app.json");
	let config: Record<string, unknown> = {};
	if (fs.existsSync(appJsonPath)) {
		try {
			config = JSON.parse(fs.readFileSync(appJsonPath, "utf8")) as Record<string, unknown>;
		} catch {
			config = {};
		}
	}
	if (config.settingsPopoutWindow === false) return;
	config.settingsPopoutWindow = false;
	fs.mkdirSync(path.dirname(appJsonPath), { recursive: true });
	fs.writeFileSync(appJsonPath, JSON.stringify(config, null, 2));
}

/**
 * Open Obsidian's settings modal on a plugin's tab.
 *
 * Drives `app.setting` directly instead of pressing `Meta+,` then clicking a
 * `.vertical-tab-nav-item` by label — the hotkey depends on which element has
 * focus and the nav label is user-facing text, so both are needlessly brittle.
 *
 * Returns false if the `app.setting` API is unavailable or the tab id is not
 * registered, which lets callers `ctx.fail()` with a clear reason.
 */
export async function openPluginSettings(page: Page, tabId = "notor"): Promise<boolean> {
	const opened = await page.evaluate((id: string) => {
		const setting = (window as any).app?.setting;
		if (!setting?.open || !setting.openTabById) return false;
		// Belt-and-braces: if the harness-level app.json flag was overwritten by a
		// custom setupVault, force inline rendering at runtime too.
		try {
			if ((window as any).app?.vault?.setConfig) {
				(window as any).app.vault.setConfig("settingsPopoutWindow", false);
			}
		} catch { /* older builds lack setConfig */ }
		setting.open();
		setting.openTabById(id);
		return setting.activeTab != null;
	}, tabId);

	if (!opened) return false;
	// The tab body renders synchronously, but plugin sections that await disk
	// reads (personas, workflows) settle a beat later.
	await waitForSelector(page, SETTINGS_CONTENT_SELECTOR, 8_000);
	await page.waitForTimeout(1_200);
	return true;
}

/** Close the settings modal via the `app.setting` API. */
export async function closeSettings(page: Page): Promise<void> {
	await page.evaluate(() => {
		(window as any).app?.setting?.close?.();
	});
	await page.waitForTimeout(600);
}

/**
 * Force one of Notor's settings groups open. Returns false if no group carries
 * that title.
 *
 * Matches on the `data-notor-group` attribute that `createSettingsGroup()`
 * stamps, falling back to the summary's visible text. Sets the `open` attribute
 * rather than clicking the summary — a click *toggles*, so it would collapse a
 * group that is already expanded.
 */
export async function expandSettingsGroup(page: Page, groupTitle: string): Promise<boolean> {
	const expanded = await page.evaluate(
		({ title, scopeSelector }: { title: string; scopeSelector: string }) => {
			const scope = document.querySelector(scopeSelector) ?? document.body;
			const byAttr = scope.querySelector(`details[data-notor-group="${CSS.escape(title)}"]`);
			const groups = byAttr
				? [byAttr]
				: Array.from(scope.querySelectorAll("details.notor-settings-group")).filter(
						(d) => d.querySelector("summary")?.textContent?.trim() === title,
					);
			const details = groups[0] as HTMLDetailsElement | undefined;
			if (!details) return false;
			if (!details.open) details.setAttribute("open", "");
			return true;
		},
		{ title: groupTitle, scopeSelector: SETTINGS_CONTENT_SELECTOR },
	);
	if (expanded) await page.waitForTimeout(700);
	return expanded;
}

/**
 * Scroll a Notor settings subsection heading into view so screenshots include
 * it. Subsection headings carry `data-notor-subsection="<name>"` (they double as
 * the `notor-settings://` deep-link targets).
 */
export async function scrollToSettingsSubsection(page: Page, subsection: string): Promise<boolean> {
	const found = await page.evaluate(
		({ name, scopeSelector }: { name: string; scopeSelector: string }) => {
			const scope = document.querySelector(scopeSelector) ?? document.body;
			const heading = scope.querySelector(`[data-notor-subsection="${CSS.escape(name)}"]`);
			if (!heading) return false;
			heading.scrollIntoView({ block: "start" });
			return true;
		},
		{ name: subsection, scopeSelector: SETTINGS_CONTENT_SELECTOR },
	);
	if (found) await page.waitForTimeout(400);
	return found;
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
 * Bring the first Notor chat leaf to the front if it's hidden. Notes opened by
 * tools (e.g. write_note) and the plan review tab open as main-area tabs in
 * front of the chat tab, leaving its header and toolbar buttons unclickable.
 */
export async function revealChatView(page: Page): Promise<void> {
	const revealed = await page.evaluate(() => {
		const workspace = (window as any).app?.workspace;
		const leaf = workspace?.getLeavesOfType?.("notor-chat-view")?.[0];
		if (!leaf) return false;
		const container = leaf.view?.containerEl as HTMLElement | undefined;
		if (container && container.offsetParent !== null) return false;
		void workspace.revealLeaf(leaf);
		return true;
	});
	if (revealed) await page.waitForTimeout(500);
}

/**
 * Suffix for prompts whose answer must stream as plain chat text. Without it a
 * "write an essay" prompt can turn into a note (Act mode) or a `submit_plan`
 * review (Plan mode) instead of a long streamed reply.
 */
export const CHAT_ONLY =
	" Answer directly in this chat as plain text — do not create or edit notes, submit a plan, or use any tools.";

/**
 * Wait for the response to finish, a plan review to become pending, or a
 * generic approval gate to appear. In Plan mode the model may call
 * `submit_plan` for a task that changes the vault, which suspends the run
 * (stop button stays visible) until the user decides — so `waitForResponse`
 * alone would time out.
 */
export async function waitForResponseOrPlanReview(
	page: Page,
	timeoutMs = RESPONSE_TIMEOUT_MS,
	pollMs = POLL_INTERVAL_MS,
): Promise<"done" | "plan" | "approval" | "timeout"> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(pollMs);
		const state = await page.evaluate(() => {
			// The review card exists only while the review is pending
			if (document.querySelector(".notor-plan-review-prompt")) return "plan";
			if (document.querySelector(".notor-approve-btn")) return "approval";
			const send = document.querySelector(".notor-send-btn");
			const stop = document.querySelector(".notor-stop-btn");
			const idle = !!send && !send.classList.contains("notor-hidden") && (!stop || stop.classList.contains("notor-hidden"));
			return idle ? "done" : "waiting";
		});
		if (state !== "waiting") return state as "done" | "plan" | "approval";
	}
	return "timeout";
}

/**
 * Reject the pending plan review from its chat card, close the plan tab, and
 * wait for the model's follow-up to finish. Returns false if no review was
 * pending or the response didn't finish.
 */
export async function rejectPendingPlan(page: Page): Promise<boolean> {
	await revealChatView(page);
	const rejected = await page.evaluate(() => {
		const btn = document.querySelector(".notor-plan-review-prompt .notor-plan-review-reject") as HTMLButtonElement | null;
		btn?.click();
		return !!btn;
	});
	if (!rejected) return false;
	await page.evaluate(() => (window as any).app?.workspace?.detachLeavesOfType?.("notor-plan-view"));
	await revealChatView(page);
	return waitForResponse(page);
}

/**
 * Send a message in Plan mode. The model may answer directly (e.g. a blocked
 * write) or propose the change with `submit_plan`; a submitted plan is
 * rejected so the vault stays unchanged and the conversation stays in Plan.
 */
export async function sendPlanModeMessage(
	page: Page,
	message: string,
): Promise<{ responded: boolean; planSubmitted: boolean }> {
	await sendMessageNoWait(page, message);
	const outcome = await waitForResponseOrPlanReview(page);
	if (outcome === "plan") {
		console.log("    → Model submitted a plan for review — rejecting it");
		return { responded: await rejectPendingPlan(page), planSubmitted: true };
	}
	return { responded: outcome === "done", planSubmitted: false };
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
	await sendMessageNoWait(page, message);
	return waitForResponse(page);
}

/** Send a chat message without waiting for the response (see {@link sendMessage}). */
export async function sendMessageNoWait(page: Page, message: string): Promise<void> {
	await revealChatView(page);
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
	await revealChatView(page);
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
	await revealChatView(page);
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
	await revealChatView(page);
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
 * Open the persona chip's context menu and return its item titles, leaving the
 * menu open. Switches Obsidian to DOM menus first — native macOS menus never
 * reach the DOM. Returns null when the chip or menu is missing.
 */
export async function openPersonaMenu(page: Page): Promise<string[] | null> {
	await revealChatView(page);
	await page.evaluate(() => (window as any).app?.vault?.setConfig?.("nativeMenus", false));
	const chip = await page.$(".notor-persona-label");
	if (!chip) return null;
	await chip.click();
	// The menu appears after async persona discovery
	if (!(await waitForSelector(page, ".menu .menu-item-title", 5_000))) return null;
	return page.$$eval(".menu .menu-item-title", (els) => els.map((el) => el.textContent?.trim() ?? ""));
}

/** Dismiss an open Obsidian menu. */
export async function closeMenu(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
}

/**
 * Select a persona for the active panel via the persona chip's menu.
 * Pass `null` to deactivate ("None (deactivate)").
 */
export async function selectPersona(page: Page, personaName: string | null): Promise<boolean> {
	const titles = await openPersonaMenu(page);
	if (!titles) return false;

	// Titles are the persona name, prefixed by its chip emoji when set
	const target = personaName ?? "None (deactivate)";
	const index = titles.findIndex((t) => t === target || t.endsWith(` ${target}`));
	if (index < 0) {
		await closeMenu(page);
		return false;
	}

	await page.locator(".menu .menu-item-title").nth(index).click();
	await page.waitForTimeout(1_000);
	return true;
}

/**
 * Read the persona chip. With no persona active it shows "🎭 default" with the
 * `notor-persona-label--default` class (it is never hidden).
 */
export async function getPersonaChip(page: Page): Promise<{ text: string; isDefault: boolean } | null> {
	return page.evaluate(() => {
		const el = document.querySelector(".notor-persona-label");
		if (!el) return null;
		return { text: el.textContent?.trim() ?? "", isDefault: el.classList.contains("notor-persona-label--default") };
	});
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
	await revealChatView(page);

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
			{ id: "local", type: "local", enabled: false, display_name: "Local", endpoint: "http://localhost:11434/v1" },
			{
				id: "bedrock", type: "bedrock", enabled: true, display_name: "AWS Bedrock",
				aws_auth_method: "profile", aws_profile: "default",
				region: "us-east-1", model_id: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
			},
		],
		auto_approve: {
			read_note: true, search_vault: true, list_vault: true, read_frontmatter: true,
			fetch_webpage: true, write_note: false, replace_in_note: false,
			update_frontmatter: false, manage_tags: false, execute_command: false,
			read_file: false, read_docx: false, write_docx: false, ask_user: true,
		},
		// Plan mode (the plugin default) answers questions directly but proposes
		// vault changes via submit_plan — use CHAT_ONLY / Act mode for long
		// streamed replies and sendPlanModeMessage for write requests.
		mode: "plan",
		open_notes_on_access: true,
		history_path: ".obsidian/plugins/notor/history/",
		history_max_size_mb: 500,
		history_max_age_days: 90,
		checkpoint_path: ".obsidian/plugins/notor/checkpoints/",
		checkpoint_max_per_conversation: 100,
		checkpoint_max_age_days: 30,
		model_pricing: {},
		model_context_overrides: {},
		model_limits_cache: { version: 1, api: {}, learned: {}, beta_rejected: {} },
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
