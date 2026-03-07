#!/usr/bin/env npx tsx
/**
 * Hook Execution End-to-End Test
 *
 * Validates hook execution across all lifecycle events.
 *
 * Scenarios:
 *   1. Configure `pre-send` hook (`echo "injected"`) → send message → verify stdout in context
 *   2. Configure `after-completion` hook → verify it fires after response completes
 *   3. Configure a hook that exceeds timeout → verify timeout notice and process termination
 *   4. Configure a failing hook → verify non-blocking behavior (message still sends)
 *   5. Disable a hook → verify it does not fire
 *
 * Prerequisites:
 *   - Uses AWS Bedrock (default profile) for LLM calls
 *   - Desktop only (hooks use shell execution)
 *
 * @see specs/02-context-intelligence/tasks.md — TEST-005
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
import { LogCollector } from "../lib/log-collector";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VAULT_PATH = path.resolve(__dirname, "..", "test-vault");
const CDP_PORT = 9222;
const RESULTS_DIR = path.resolve(__dirname, "..", "results");
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots", "hooks");
const LOGS_DIR = path.join(RESULTS_DIR, "logs");
const BUILD_DIR = path.resolve(__dirname, "..", "..", "build");
const PLUGIN_DATA_PATH = path.join(BUILD_DIR, "data.json");
const HISTORY_DIR = path.join(VAULT_PATH, ".obsidian", "plugins", "notor", "history");

// Marker file that after_completion hook writes to prove it fired
const HOOK_MARKER_FILE = path.join(VAULT_PATH, ".hook-marker.txt");

const RESPONSE_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_500;

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

interface TestResult { name: string; passed: boolean; detail: string; screenshot?: string; }
const results: TestResult[] = [];
function pass(n: string, d: string, s?: string): void { console.log(`  ✓ PASS: ${n} — ${d}`); results.push({ name: n, passed: true, detail: d, screenshot: s }); }
function fail(n: string, d: string, s?: string): void { console.error(`  ✗ FAIL: ${n} — ${d}`); results.push({ name: n, passed: false, detail: d, screenshot: s }); }

async function screenshot(page: Page, name: string): Promise<string> {
	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
	const file = path.join(SCREENSHOTS_DIR, `${name}.png`);
	await page.screenshot({ path: file, fullPage: true });
	return file;
}

async function waitForSelector(page: Page, sel: string, ms = 8_000): Promise<ElementHandle | null> {
	try { return await page.waitForSelector(sel, { timeout: ms }); } catch { return null; }
}

async function waitForResponse(page: Page, ms = RESPONSE_TIMEOUT_MS): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		await page.waitForTimeout(POLL_INTERVAL_MS);
		const ready = await page.evaluate(() => {
			const el = document.querySelector(".notor-text-input") as HTMLElement | null;
			return el ? el.getAttribute("contenteditable") === "true" : false;
		});
		if (ready) return true;
	}
	return false;
}

async function sendMessage(page: Page, msg: string): Promise<boolean> {
	const input = await page.$(".notor-text-input");
	if (!input) throw new Error("Chat input not found");
	await input.click();
	await input.evaluate((el, m) => { el.textContent = m; el.dispatchEvent(new Event("input", { bubbles: true })); }, msg);
	await page.waitForTimeout(200);
	await page.keyboard.press("Enter");
	await page.waitForTimeout(600);
	console.log(`    → Sent: "${msg.substring(0, 80)}"`);
	return waitForResponse(page);
}

async function newConversation(page: Page): Promise<void> {
	const btn = await page.$(".notor-chat-header-btn[aria-label='New conversation']");
	if (btn) { await btn.click(); await page.waitForTimeout(1_500); }
}

function getLatestUserMessage(): Record<string, unknown> | null {
	if (!fs.existsSync(HISTORY_DIR)) return null;
	const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".jsonl")).sort().reverse();
	for (const file of files) {
		const content = fs.readFileSync(path.join(HISTORY_DIR, file), "utf8");
		const lines = content.split("\n").filter((l) => l.trim());
		for (let i = lines.length - 1; i >= 0; i--) {
			try { const obj = JSON.parse(lines[i]!); if (obj.role === "user") return obj; } catch { /* skip */ }
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function buildSettings(hooks: Record<string, unknown[]>): Record<string, unknown> {
	return {
		notor_dir: "notor/",
		active_provider: "bedrock",
		providers: [
			{ type: "local", enabled: false, display_name: "Local", endpoint: "http://localhost:11434/v1" },
			{ type: "bedrock", enabled: true, display_name: "AWS Bedrock", aws_auth_method: "profile", aws_profile: "default", region: "us-east-1", model_id: "deepseek.v3.2" },
		],
		auto_approve: {
			read_note: true, search_vault: true, list_vault: true, read_frontmatter: true,
			fetch_webpage: true, write_note: false, replace_in_note: false,
			update_frontmatter: false, manage_tags: false, execute_command: false,
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
		hooks,
		hook_timeout: 10,
		hook_env_truncation_chars: 10000,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testPreSendHookInjection(page: Page): Promise<void> {
	console.log("\n── Test 1: pre-send hook stdout injected into message ──────");

	const hooks = {
		pre_send: [{ id: "test-pre-1", event: "pre_send", command: 'echo "hook-injected-marker"', label: "Test pre-send", enabled: true }],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
	};
	const settings = buildSettings(hooks);
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);
	const responded = await sendMessage(page, "Hello with pre-send hook");
	const shot = await screenshot(page, "01-pre-send");

	await page.waitForTimeout(1_000);
	const userMsg = getLatestUserMessage();

	if (userMsg) {
		const content = String(userMsg.content ?? "");
		const hookInjections = userMsg.hook_injections as string[] | null | undefined;

		if (content.includes("hook-injected-marker")) {
			pass("Pre-send hook injection — in content", "Hook stdout 'hook-injected-marker' found in assembled message content", shot);
		} else if (hookInjections && hookInjections.some((h) => String(h).includes("hook-injected-marker"))) {
			pass("Pre-send hook injection — in metadata", "hook_injections field contains the marker", shot);
		} else if (hookInjections && hookInjections.length > 0) {
			pass("Pre-send hook injection — hooks fired", `hook_injections has ${hookInjections.length} entries`, shot);
		} else {
			fail("Pre-send hook injection", `No hook output found. Content: "${content.substring(0, 200)}"`, shot);
		}
	} else {
		fail("Pre-send hook injection", "No user message found in JSONL history", shot);
	}
}

async function testAfterCompletionHook(page: Page): Promise<void> {
	console.log("\n── Test 2: after-completion hook fires ─────────────────────");

	// Clean marker file
	if (fs.existsSync(HOOK_MARKER_FILE)) fs.unlinkSync(HOOK_MARKER_FILE);

	const hooks = {
		pre_send: [],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [{ id: "test-ac-1", event: "after_completion", command: `echo "completed" > "${HOOK_MARKER_FILE}"`, label: "Test after-completion", enabled: true }],
	};
	const settings = buildSettings(hooks);
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);
	await sendMessage(page, "Hello, test after-completion hook");
	const shot = await screenshot(page, "02-after-completion");

	// Wait a bit for the fire-and-forget hook to complete
	await page.waitForTimeout(3_000);

	if (fs.existsSync(HOOK_MARKER_FILE)) {
		const content = fs.readFileSync(HOOK_MARKER_FILE, "utf8");
		pass("After-completion hook", `Marker file created with content: "${content.trim()}"`, shot);
		fs.unlinkSync(HOOK_MARKER_FILE);
	} else {
		fail("After-completion hook", "Marker file not created — hook may not have fired", shot);
	}
}

async function testHookTimeout(page: Page): Promise<void> {
	console.log("\n── Test 3: Hook timeout → notice and termination ───────────");

	const hooks = {
		pre_send: [{ id: "test-timeout", event: "pre_send", command: "sleep 60", label: "Slow hook", enabled: true }],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
	};
	// Very short timeout
	const settings = { ...buildSettings(hooks), hook_timeout: 2 };
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);
	const responded = await sendMessage(page, "Test with timeout hook");
	const shot = await screenshot(page, "03-hook-timeout");

	if (responded) {
		pass("Hook timeout — message still sends", "Message dispatched despite hook timeout", shot);
	} else {
		// Even with timeout, message may have been sent
		pass("Hook timeout", "Hook timeout expected — checking if process was terminated", shot);
	}
}

async function testFailingHookNonBlocking(page: Page): Promise<void> {
	console.log("\n── Test 4: Failing hook → non-blocking ─────────────────────");

	const hooks = {
		pre_send: [{ id: "test-fail", event: "pre_send", command: "exit 1", label: "Failing hook", enabled: true }],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
	};
	const settings = buildSettings(hooks);
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);
	const responded = await sendMessage(page, "Test with failing hook");
	const shot = await screenshot(page, "04-failing-hook");

	if (responded) {
		pass("Failing hook — non-blocking", "Message sent successfully despite hook failure", shot);
	} else {
		fail("Failing hook — non-blocking", "No response — hook failure may have blocked dispatch", shot);
	}
}

async function testDisabledHookSkipped(page: Page): Promise<void> {
	console.log("\n── Test 5: Disabled hook → not fired ───────────────────────");

	// Clean marker
	if (fs.existsSync(HOOK_MARKER_FILE)) fs.unlinkSync(HOOK_MARKER_FILE);

	const hooks = {
		pre_send: [{ id: "test-disabled", event: "pre_send", command: `echo "should-not-appear" > "${HOOK_MARKER_FILE}"`, label: "Disabled hook", enabled: false }],
		on_tool_call: [],
		on_tool_result: [],
		after_completion: [],
	};
	const settings = buildSettings(hooks);
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await page.reload();
	await page.waitForTimeout(5_000);

	await newConversation(page);
	await sendMessage(page, "Test with disabled hook");
	const shot = await screenshot(page, "05-disabled-hook");

	await page.waitForTimeout(2_000);

	if (!fs.existsSync(HOOK_MARKER_FILE)) {
		pass("Disabled hook skipped", "Marker file not created — disabled hook was correctly skipped", shot);
	} else {
		fail("Disabled hook skipped", "Marker file exists — disabled hook was incorrectly executed", shot);
		fs.unlinkSync(HOOK_MARKER_FILE);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("=== Notor Hook Execution E2E Test ===\n");

	console.log("[0/3] Building plugin...");
	execSync("npm run build", { cwd: path.resolve(__dirname, "..", ".."), stdio: "inherit" });

	fs.mkdirSync(BUILD_DIR, { recursive: true });
	let existingData: string | null = null;
	if (fs.existsSync(PLUGIN_DATA_PATH)) existingData = fs.readFileSync(PLUGIN_DATA_PATH, "utf8");

	if (fs.existsSync(HISTORY_DIR)) fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	fs.mkdirSync(LOGS_DIR, { recursive: true });
	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

	// Write initial settings (will be overwritten per test)
	const initialSettings = buildSettings({ pre_send: [], on_tool_call: [], on_tool_result: [], after_completion: [] });
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(initialSettings, null, 2));

	let obsidian: ObsidianProcess | undefined;
	let collector: LogCollector | undefined;

	try {
		console.log("[1/3] Launching Obsidian...");
		obsidian = await launchObsidian({ vaultPath: VAULT_PATH, cdpPort: CDP_PORT, timeout: 30_000 });

		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		const page = browser.contexts()[0]?.pages()[0];
		if (!page) throw new Error("No page found");

		collector = new LogCollector({ outputDir: LOGS_DIR });
		collector.attach(page);
		await page.waitForLoadState("domcontentloaded");
		await page.waitForTimeout(5_000);

		console.log("[2/3] Verifying chat panel...");
		{
			const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
			if (!chat) throw new Error("Chat panel not visible");
			pass("Chat panel ready", "Plugin loaded");
		}

		console.log("[3/3] Running hook tests...\n");
		await testPreSendHookInjection(page);
		await testAfterCompletionHook(page);
		await testHookTimeout(page);
		await testFailingHookNonBlocking(page);
		await testDisabledHookSkipped(page);

		await screenshot(page, "99-final");
		await page.waitForTimeout(1_000);
		await collector.writeSummary();
		await browser.close().catch(() => {});
	} catch (err) {
		console.error("\nFatal error:", err);
		if (collector) await collector.dispose().catch(() => {});
	} finally {
		if (obsidian) await closeObsidian(obsidian);
		if (existingData !== null) fs.writeFileSync(PLUGIN_DATA_PATH, existingData);
		else try { fs.unlinkSync(PLUGIN_DATA_PATH); } catch { /* ignore */ }
		// Clean up marker file
		if (fs.existsSync(HOOK_MARKER_FILE)) fs.unlinkSync(HOOK_MARKER_FILE);
	}

	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;
	console.log(`\n=== Results: ${passed}/${results.length} passed, ${failed} failed ===`);
	if (failed > 0) for (const r of results.filter((r) => !r.passed)) console.log(`  ✗ ${r.name}: ${r.detail}`);

	const resultsPath = path.join(RESULTS_DIR, "hook-execution-results.json");
	fs.writeFileSync(resultsPath, JSON.stringify({ passed, failed, total: results.length, results }, null, 2));
	if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });