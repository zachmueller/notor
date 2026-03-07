#!/usr/bin/env npx tsx
/**
 * fetch_webpage End-to-End Test
 *
 * Tests the fetch_webpage tool against real URLs and controlled settings.
 *
 * Scenarios:
 *   1. Fetch a real HTML page (Wikipedia) → verify Markdown conversion returned
 *   2. Fetch a plain text URL → verify returned as-is
 *   3. Fetch a JSON URL → verify returned as-is
 *   4. Fetch a blocked domain → verify denylist error returned
 *   5. Fetch a page with a very low output cap → verify truncation notice
 *   6. Fetch a URL with a very low download size cap → verify error
 *
 * Note: Obsidian's Electron renderer cannot reach 127.0.0.1 (loopback is
 * blocked by Electron's security model). Tests 1–3 use real public URLs.
 * Tests 5–6 use tight settings overrides to trigger caps reliably and
 * require an Obsidian restart to reload updated settings.
 *
 * @see specs/02-context-intelligence/tasks.md — TEST-003
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
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots", "fetch-webpage");
const LOGS_DIR = path.join(RESULTS_DIR, "logs");
const BUILD_DIR = path.resolve(__dirname, "..", "..", "build");
const PLUGIN_DATA_PATH = path.join(BUILD_DIR, "data.json");
const HISTORY_DIR = path.join(BUILD_DIR, "history");

const RESPONSE_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1_500;

// Real public URLs used by the tests
const WIKIPEDIA_URL =
	"https://en.wikipedia.org/wiki/A_Mathematical_Theory_of_Communication";
const PLAIN_TEXT_URL = "https://www.rfc-editor.org/rfc/rfc2549.txt";
const JSON_URL = "https://jsonplaceholder.typicode.com/todos/1";

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

function pass(name: string, detail: string, screenshotPath?: string): void {
	console.log(`  ✓ PASS: ${name} — ${detail}`);
	results.push({ name, passed: true, detail, screenshot: screenshotPath });
}

function fail(name: string, detail: string, screenshotPath?: string): void {
	console.error(`  ✗ FAIL: ${name} — ${detail}`);
	results.push({ name, passed: false, detail, screenshot: screenshotPath });
}

async function takeScreenshot(page: Page, name: string): Promise<string> {
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

async function waitForResponse(
	page: Page,
	timeoutMs = RESPONSE_TIMEOUT_MS
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await page.waitForTimeout(POLL_INTERVAL_MS);
		const inputReady = await page.evaluate(() => {
			const el = document.querySelector(
				".notor-text-input"
			) as HTMLElement | null;
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
	const btn = await page.$(
		".notor-chat-header-btn[aria-label='New conversation']"
	);
	if (btn) {
		await btn.click();
		await page.waitForTimeout(1_500);
	}
}

// ---------------------------------------------------------------------------
// JSONL history reading
// ---------------------------------------------------------------------------

/**
 * Returns the tool_result record for the most recent fetch_webpage call
 * across all history files in HISTORY_DIR.
 *
 * Plugin JSONL schema:
 *   { _type: "message", role: "tool_result",
 *     tool_result: { tool_name, success, result, error, ... } }
 */
function getLastFetchWebpageResult(): {
	success: boolean;
	result: string;
	error?: string;
} | null {
	if (!fs.existsSync(HISTORY_DIR)) {
		console.log(`    [debug] History directory not found: ${HISTORY_DIR}`);
		return null;
	}
	const files = fs
		.readdirSync(HISTORY_DIR)
		.filter((f) => f.endsWith(".jsonl"))
		.sort()
		.reverse();

	if (files.length === 0) {
		console.log(`    [debug] No JSONL files in history directory`);
		return null;
	}

	console.log(`    [debug] Scanning ${files.length} history file(s)...`);

	for (const file of files) {
		const content = fs.readFileSync(
			path.join(HISTORY_DIR, file),
			"utf8"
		);
		const lines = content.split("\n").filter((l) => l.trim());
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const obj = JSON.parse(lines[i]!);
				if (
					obj._type === "message" &&
					obj.role === "tool_result" &&
					obj.tool_result?.tool_name === "fetch_webpage"
				) {
					console.log(
						`    [debug] Found fetch_webpage tool_result in ${file} (line ${i + 1})`
					);
					return {
						success: obj.tool_result.success ?? false,
						result: obj.tool_result.result ?? "",
						error: obj.tool_result.error,
					};
				}
			} catch {
				/* skip malformed lines */
			}
		}
	}

	console.log(
		`    [debug] No fetch_webpage tool_result found in any history file`
	);
	return null;
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

interface SettingsOverrides {
	fetch_webpage_max_output_chars?: number;
	fetch_webpage_max_download_mb?: number;
}

function buildSettings(overrides: SettingsOverrides = {}): Record<string, unknown> {
	return {
		notor_dir: "notor/",
		active_provider: "bedrock",
		providers: [
			{
				type: "local",
				enabled: false,
				display_name: "Local",
				endpoint: "http://localhost:11434/v1",
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
			fetch_webpage: true,
			write_note: false,
			replace_in_note: false,
			update_frontmatter: false,
			manage_tags: false,
			execute_command: false,
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
		fetch_webpage_timeout: 30,
		fetch_webpage_max_download_mb:
			overrides.fetch_webpage_max_download_mb ?? 5,
		fetch_webpage_max_output_chars:
			overrides.fetch_webpage_max_output_chars ?? 50000,
		domain_denylist: ["blocked-domain.com", "*.blocked-wildcard.com"],
		execute_command_timeout: 30,
		execute_command_max_output_chars: 50000,
		execute_command_allowed_paths: [],
		execute_command_shell: "",
		execute_command_shell_args: [],
		external_file_size_threshold_mb: 1,
		hooks: {
			pre_send: [],
			on_tool_call: [],
			on_tool_result: [],
			after_completion: [],
		},
		hook_timeout: 10,
		hook_env_truncation_chars: 10000,
	};
}

function injectSettings(overrides: SettingsOverrides = {}): void {
	fs.mkdirSync(BUILD_DIR, { recursive: true });
	fs.writeFileSync(
		PLUGIN_DATA_PATH,
		JSON.stringify(buildSettings(overrides), null, 2)
	);
}

// ---------------------------------------------------------------------------
// Obsidian restart helper
// ---------------------------------------------------------------------------

interface ObsidianSession {
	obsidian: ObsidianProcess;
	page: Page;
}

/**
 * Close the current Obsidian instance, inject new settings, and launch a
 * fresh instance. Returns the new session's ObsidianProcess and Page.
 */
async function restartObsidian(
	current: ObsidianProcess,
	overrides: SettingsOverrides = {}
): Promise<ObsidianSession> {
	await closeObsidian(current);
	await new Promise((r) => setTimeout(r, 2_000));
	injectSettings(overrides);

	const obsidian = await launchObsidian({
		vaultPath: VAULT_PATH,
		cdpPort: CDP_PORT,
		timeout: 30_000,
	});
	const browser = await chromium.connectOverCDP(
		`http://127.0.0.1:${CDP_PORT}`
	);
	const page = browser.contexts()[0]?.pages()[0];
	if (!page) throw new Error("No page found after Obsidian restart");
	await page.waitForLoadState("domcontentloaded");
	await page.waitForTimeout(5_000);

	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chat) throw new Error("Chat panel not visible after Obsidian restart");

	return { obsidian, page };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Test 1: Fetch a real HTML page (Wikipedia) → verify Markdown conversion.
 *
 * Uses https://en.wikipedia.org/wiki/A_Mathematical_Theory_of_Communication
 * Asserts the JSONL tool_result.result contains known article content.
 */
async function testFetchHTML(page: Page): Promise<void> {
	console.log(
		"\n── Test 1: Fetch HTML page (Wikipedia) → Markdown conversion ──"
	);
	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(page);

	const responded = await sendMessage(
		page,
		`Use the fetch_webpage tool to fetch ${WIKIPEDIA_URL} and return the first paragraph you see.`
	);
	const shot = await takeScreenshot(page, "01-fetch-html-wikipedia");

	if (!responded) {
		fail("Fetch HTML (Wikipedia)", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastFetchWebpageResult();
	if (!toolResult) {
		fail(
			"Fetch HTML (Wikipedia)",
			"No fetch_webpage tool_result found in JSONL history",
			shot
		);
		return;
	}
	if (!toolResult.success) {
		fail(
			"Fetch HTML (Wikipedia)",
			`Tool returned error: ${toolResult.error ?? "(no error message)"}`,
			shot
		);
		return;
	}

	const result = toolResult.result;
	if (
		result.includes("Shannon") ||
		result.includes("Mathematical Theory") ||
		result.includes("communication")
	) {
		pass(
			"Fetch HTML (Wikipedia)",
			`Markdown content verified — found expected article content (${result.length} chars)`,
			shot
		);
	} else {
		fail(
			"Fetch HTML (Wikipedia)",
			`Result did not contain expected article content. Got: "${result.substring(0, 300)}"`,
			shot
		);
	}
}

/**
 * Test 2: Fetch a plain text URL → verify content returned as-is.
 * Uses an RFC .txt file served as text/plain.
 */
async function testFetchPlainText(page: Page): Promise<void> {
	console.log(
		"\n── Test 2: Fetch plain text URL → returned as-is ──────────"
	);
	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(page);

	const responded = await sendMessage(
		page,
		`Use the fetch_webpage tool to fetch ${PLAIN_TEXT_URL}`
	);
	const shot = await takeScreenshot(page, "02-fetch-text");

	if (!responded) {
		fail("Fetch plain text", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastFetchWebpageResult();
	if (!toolResult) {
		fail(
			"Fetch plain text",
			"No fetch_webpage tool_result found in JSONL history",
			shot
		);
		return;
	}
	if (!toolResult.success) {
		fail(
			"Fetch plain text",
			`Tool returned error: ${toolResult.error ?? "(no error message)"}`,
			shot
		);
		return;
	}

	// RFC .txt files contain "RFC" and "Network Working Group" or similar
	const result = toolResult.result;
	if (result.includes("RFC") || result.includes("Network Working Group")) {
		pass(
			"Fetch plain text",
			`Plain text content returned as-is (${result.length} chars)`,
			shot
		);
	} else {
		fail(
			"Fetch plain text",
			`Result missing expected RFC content. Got: "${result.substring(0, 300)}"`,
			shot
		);
	}
}

/**
 * Test 3: Fetch a JSON URL → verify content returned as-is.
 * Uses jsonplaceholder.typicode.com which serves application/json.
 */
async function testFetchJSON(page: Page): Promise<void> {
	console.log("\n── Test 3: Fetch JSON URL → returned as-is ────────────────");
	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(page);

	const responded = await sendMessage(
		page,
		`Use the fetch_webpage tool to fetch ${JSON_URL}`
	);
	const shot = await takeScreenshot(page, "03-fetch-json");

	if (!responded) {
		fail("Fetch JSON", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastFetchWebpageResult();
	if (!toolResult) {
		fail(
			"Fetch JSON",
			"No fetch_webpage tool_result found in JSONL history",
			shot
		);
		return;
	}
	if (!toolResult.success) {
		fail(
			"Fetch JSON",
			`Tool returned error: ${toolResult.error ?? "(no error message)"}`,
			shot
		);
		return;
	}

	// jsonplaceholder returns {"userId":1,"id":1,"title":"...","completed":false}
	const result = toolResult.result;
	if (
		result.includes('"userId"') ||
		result.includes('"id"') ||
		result.includes('"title"')
	) {
		pass(
			"Fetch JSON",
			`JSON content returned as-is (${result.length} chars)`,
			shot
		);
	} else {
		fail(
			"Fetch JSON",
			`Result did not contain expected JSON keys. Got: "${result.substring(0, 300)}"`,
			shot
		);
	}
}

/**
 * Test 4: Fetch a blocked domain → verify denylist error.
 * Uses "blocked-domain.com" which is in domain_denylist.
 * The denylist check runs before any network call — Electron networking irrelevant.
 */
async function testFetchBlockedDomain(page: Page): Promise<void> {
	console.log(
		"\n── Test 4: Fetch blocked domain → denylist error ──────────"
	);
	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(page);

	// Use an explicit, forceful prompt so the LLM always invokes the tool
	// even though it may recognise blocked-domain.com as a test domain.
	const responded = await sendMessage(
		page,
		"You MUST call the fetch_webpage tool right now with url=\"https://blocked-domain.com/page\". Do not respond without calling the tool first."
	);
	const shot = await takeScreenshot(page, "04-blocked-domain");

	if (!responded) {
		fail("Fetch blocked domain", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastFetchWebpageResult();
	if (!toolResult) {
		fail(
			"Fetch blocked domain",
			"No fetch_webpage tool_result found in JSONL history",
			shot
		);
		return;
	}
	if (toolResult.success) {
		fail(
			"Fetch blocked domain",
			`Expected tool to fail with denylist error, but it succeeded. Result: "${toolResult.result.substring(0, 200)}"`,
			shot
		);
		return;
	}

	const errorMsg = toolResult.error ?? "";
	if (
		errorMsg.toLowerCase().includes("blocked") ||
		errorMsg.toLowerCase().includes("denylist") ||
		errorMsg.toLowerCase().includes("deny")
	) {
		pass(
			"Fetch blocked domain",
			`Denylist error returned as expected: "${errorMsg}"`,
			shot
		);
	} else {
		fail(
			"Fetch blocked domain",
			`Tool failed but error doesn't mention denylist. Error: "${errorMsg}"`,
			shot
		);
	}
}

/**
 * Test 5: Fetch a page with a very low output cap → verify truncation notice.
 * Restarts Obsidian with fetch_webpage_max_output_chars=500 so any real page
 * exceeds the cap and triggers the truncation suffix.
 */
async function testFetchLargeOutput(
	currentSession: ObsidianSession
): Promise<ObsidianSession> {
	console.log(
		"\n── Test 5: Fetch page with low output cap (500 chars) → truncation ──"
	);
	console.log(
		"    Restarting Obsidian with fetch_webpage_max_output_chars=500..."
	);

	const session = await restartObsidian(currentSession.obsidian, {
		fetch_webpage_max_output_chars: 500,
	});

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(session.page);

	const responded = await sendMessage(
		session.page,
		`Use the fetch_webpage tool to fetch ${WIKIPEDIA_URL}`
	);
	const shot = await takeScreenshot(session.page, "05-large-output-truncated");

	if (!responded) {
		fail("Fetch large page (truncation)", "No response within timeout", shot);
		return session;
	}

	const toolResult = getLastFetchWebpageResult();
	if (!toolResult) {
		fail(
			"Fetch large page (truncation)",
			"No fetch_webpage tool_result found in JSONL history",
			shot
		);
		return session;
	}
	if (!toolResult.success) {
		fail(
			"Fetch large page (truncation)",
			`Tool returned error (expected truncated success): ${toolResult.error ?? "(no error message)"}`,
			shot
		);
		return session;
	}

	const result = toolResult.result;
	if (result.includes("truncated at") || result.includes("truncated")) {
		pass(
			"Fetch large page (truncation)",
			`Truncation notice found in result (${result.length} chars, cap was 500)`,
			shot
		);
	} else {
		fail(
			"Fetch large page (truncation)",
			`Result (${result.length} chars) did not contain truncation notice. Content: "${result.substring(0, 300)}"`,
			shot
		);
	}

	return session;
}

/**
 * Test 6: Fetch a URL with a tiny download size cap → verify error.
 * Restarts Obsidian with fetch_webpage_max_download_mb=0.0001 (~100 bytes)
 * so any real page exceeds the cap.
 */
async function testFetchDownloadSizeExceeded(
	currentSession: ObsidianSession
): Promise<ObsidianSession> {
	console.log(
		"\n── Test 6: Fetch page with tiny download cap (0.0001 MB) → size error ──"
	);
	console.log(
		"    Restarting Obsidian with fetch_webpage_max_download_mb=0.0001..."
	);

	const session = await restartObsidian(currentSession.obsidian, {
		fetch_webpage_max_download_mb: 0.0001,
	});

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(session.page);

	const responded = await sendMessage(
		session.page,
		`Use the fetch_webpage tool to fetch ${WIKIPEDIA_URL}`
	);
	const shot = await takeScreenshot(session.page, "06-download-exceeded");

	if (!responded) {
		fail("Download size exceeded", "No response within timeout", shot);
		return session;
	}

	const toolResult = getLastFetchWebpageResult();
	if (!toolResult) {
		fail(
			"Download size exceeded",
			"No fetch_webpage tool_result found in JSONL history",
			shot
		);
		return session;
	}
	if (toolResult.success) {
		fail(
			"Download size exceeded",
			`Expected tool to fail with size error, but it succeeded (${toolResult.result.length} chars)`,
			shot
		);
		return session;
	}

	const errorMsg = toolResult.error ?? "";
	if (
		errorMsg.toLowerCase().includes("large") ||
		errorMsg.toLowerCase().includes("size") ||
		errorMsg.toLowerCase().includes("mb")
	) {
		pass(
			"Download size exceeded",
			`Size error returned as expected: "${errorMsg}"`,
			shot
		);
	} else {
		fail(
			"Download size exceeded",
			`Tool failed but error doesn't mention size. Error: "${errorMsg}"`,
			shot
		);
	}

	return session;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("=== Notor fetch_webpage E2E Test ===\n");
	console.log(
		"Note: Uses real public URLs (Electron cannot reach 127.0.0.1 from plugin context).\n"
	);

	console.log("[0/4] Building plugin...");
	execSync("npm run build", {
		cwd: path.resolve(__dirname, "..", ".."),
		stdio: "inherit",
	});

	console.log("[1/4] Injecting initial settings...");
	let existingData: string | null = null;
	if (fs.existsSync(PLUGIN_DATA_PATH))
		existingData = fs.readFileSync(PLUGIN_DATA_PATH, "utf8");
	injectSettings();

	fs.mkdirSync(LOGS_DIR, { recursive: true });
	fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

	let session: ObsidianSession | undefined;
	let collector: LogCollector | undefined;

	try {
		console.log("[2/4] Launching Obsidian...");
		const obsidian = await launchObsidian({
			vaultPath: VAULT_PATH,
			cdpPort: CDP_PORT,
			timeout: 30_000,
		});

		const browser = await chromium.connectOverCDP(
			`http://127.0.0.1:${CDP_PORT}`
		);
		const page = browser.contexts()[0]?.pages()[0];
		if (!page) throw new Error("No page found");

		collector = new LogCollector({ outputDir: LOGS_DIR });
		collector.attach(page);
		await page.waitForLoadState("domcontentloaded");
		await page.waitForTimeout(5_000);

		session = { obsidian, page };

		console.log("[3/4] Verifying chat panel...");
		{
			const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
			if (!chat) throw new Error("Chat panel not visible");
			pass("Chat panel ready", "Plugin loaded");
		}

		console.log("[4/4] Running fetch_webpage tests...\n");

		// Tests 1–4: use the initial session (no restart needed)
		await testFetchHTML(session.page);
		await testFetchPlainText(session.page);
		await testFetchJSON(session.page);
		await testFetchBlockedDomain(session.page);

		// Tests 5–6: each restarts Obsidian with different settings; they return
		// the new session so we can properly shut it down.
		session = await testFetchLargeOutput(session);
		// Restore normal settings then restart for test 6
		injectSettings();
		session = await testFetchDownloadSizeExceeded(session);

		await takeScreenshot(session.page, "99-final");
		await session.page.waitForTimeout(1_000);

		if (collector) await collector.writeSummary();
	} catch (err) {
		console.error("\nFatal error:", err);
		if (collector) await collector.dispose().catch(() => {});
	} finally {
		if (session) await closeObsidian(session.obsidian);
		if (existingData !== null)
			fs.writeFileSync(PLUGIN_DATA_PATH, existingData);
		else
			try {
				fs.unlinkSync(PLUGIN_DATA_PATH);
			} catch {
				/* ignore */
			}
	}

	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;
	console.log(
		`\n=== Results: ${passed}/${results.length} passed, ${failed} failed ===`
	);
	if (failed > 0)
		for (const r of results.filter((r) => !r.passed))
			console.log(`  ✗ ${r.name}: ${r.detail}`);

	const resultsPath = path.join(RESULTS_DIR, "fetch-webpage-results.json");
	fs.writeFileSync(
		resultsPath,
		JSON.stringify({ passed, failed, total: results.length, results }, null, 2)
	);
	if (failed > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});