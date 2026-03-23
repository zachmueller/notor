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
 * require a plugin reload to pick up updated settings.
 *
 * @see specs/02-context-intelligence/tasks.md — TEST-003
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	waitForSelector,
	sendMessage,
	newConversation,
	buildDefaultSettings,
	BUILD_DIR,
	PLUGIN_DATA_PATH,
} from "../lib/test-helpers";

const HISTORY_DIR = path.join(BUILD_DIR, "history");

// Real public URLs used by the tests
const WIKIPEDIA_URL =
	"https://en.wikipedia.org/wiki/A_Mathematical_Theory_of_Communication";
const PLAIN_TEXT_URL = "https://www.rfc-editor.org/rfc/rfc2549.txt";
const JSON_URL = "https://jsonplaceholder.typicode.com/todos/1";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Returns the tool_result record for the most recent fetch_webpage call
 * across all history files in HISTORY_DIR.
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

/**
 * Inject settings mid-test (for tests 5 & 6 that need different caps).
 * Builds on buildDefaultSettings with the fetch-webpage-specific overrides.
 */
function injectSettings(overrides: Record<string, unknown> = {}): void {
	const settings = buildDefaultSettings({
		domain_denylist: ["blocked-domain.com", "*.blocked-wildcard.com"],
		fetch_webpage_timeout: 30,
		...overrides,
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Test 1: Fetch a real HTML page (Wikipedia) → verify Markdown conversion.
 */
async function testFetchHTML(ctx: TestContext): Promise<void> {
	console.log(
		"\n── Test 1: Fetch HTML page (Wikipedia) → Markdown conversion ──"
	);
	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(ctx.page);

	const responded = await sendMessage(
		ctx.page,
		`Use the fetch_webpage tool to fetch ${WIKIPEDIA_URL} and return the first paragraph you see.`
	);
	const shot = await ctx.screenshot("01-fetch-html-wikipedia");

	if (!responded) {
		ctx.fail("Fetch HTML (Wikipedia)", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastFetchWebpageResult();
	if (!toolResult) {
		ctx.fail(
			"Fetch HTML (Wikipedia)",
			"No fetch_webpage tool_result found in JSONL history",
			shot
		);
		return;
	}
	if (!toolResult.success) {
		ctx.fail(
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
		ctx.pass(
			"Fetch HTML (Wikipedia)",
			`Markdown content verified — found expected article content (${result.length} chars)`,
			shot
		);
	} else {
		ctx.fail(
			"Fetch HTML (Wikipedia)",
			`Result did not contain expected article content. Got: "${result.substring(0, 300)}"`,
			shot
		);
	}
}

/**
 * Test 2: Fetch a plain text URL → verify content returned as-is.
 */
async function testFetchPlainText(ctx: TestContext): Promise<void> {
	console.log(
		"\n── Test 2: Fetch plain text URL → returned as-is ──────────"
	);
	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(ctx.page);

	const responded = await sendMessage(
		ctx.page,
		`Use the fetch_webpage tool to fetch ${PLAIN_TEXT_URL}`
	);
	const shot = await ctx.screenshot("02-fetch-text");

	if (!responded) {
		ctx.fail("Fetch plain text", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastFetchWebpageResult();
	if (!toolResult) {
		ctx.fail(
			"Fetch plain text",
			"No fetch_webpage tool_result found in JSONL history",
			shot
		);
		return;
	}
	if (!toolResult.success) {
		ctx.fail(
			"Fetch plain text",
			`Tool returned error: ${toolResult.error ?? "(no error message)"}`,
			shot
		);
		return;
	}

	const result = toolResult.result;
	if (result.includes("RFC") || result.includes("Network Working Group")) {
		ctx.pass(
			"Fetch plain text",
			`Plain text content returned as-is (${result.length} chars)`,
			shot
		);
	} else {
		ctx.fail(
			"Fetch plain text",
			`Result missing expected RFC content. Got: "${result.substring(0, 300)}"`,
			shot
		);
	}
}

/**
 * Test 3: Fetch a JSON URL → verify content returned as-is.
 */
async function testFetchJSON(ctx: TestContext): Promise<void> {
	console.log("\n── Test 3: Fetch JSON URL → returned as-is ────────────────");
	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(ctx.page);

	const responded = await sendMessage(
		ctx.page,
		`Use the fetch_webpage tool to fetch ${JSON_URL}`
	);
	const shot = await ctx.screenshot("03-fetch-json");

	if (!responded) {
		ctx.fail("Fetch JSON", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastFetchWebpageResult();
	if (!toolResult) {
		ctx.fail(
			"Fetch JSON",
			"No fetch_webpage tool_result found in JSONL history",
			shot
		);
		return;
	}
	if (!toolResult.success) {
		ctx.fail(
			"Fetch JSON",
			`Tool returned error: ${toolResult.error ?? "(no error message)"}`,
			shot
		);
		return;
	}

	const result = toolResult.result;
	if (
		result.includes('"userId"') ||
		result.includes('"id"') ||
		result.includes('"title"')
	) {
		ctx.pass(
			"Fetch JSON",
			`JSON content returned as-is (${result.length} chars)`,
			shot
		);
	} else {
		ctx.fail(
			"Fetch JSON",
			`Result did not contain expected JSON keys. Got: "${result.substring(0, 300)}"`,
			shot
		);
	}
}

/**
 * Test 4: Fetch a blocked domain → verify denylist error.
 */
async function testFetchBlockedDomain(ctx: TestContext): Promise<void> {
	console.log(
		"\n── Test 4: Fetch blocked domain → denylist error ──────────"
	);
	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(ctx.page);

	const responded = await sendMessage(
		ctx.page,
		"You MUST call the fetch_webpage tool right now with url=\"https://blocked-domain.com/page\". Do not respond without calling the tool first."
	);
	const shot = await ctx.screenshot("04-blocked-domain");

	if (!responded) {
		ctx.fail("Fetch blocked domain", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastFetchWebpageResult();
	if (!toolResult) {
		ctx.fail(
			"Fetch blocked domain",
			"No fetch_webpage tool_result found in JSONL history",
			shot
		);
		return;
	}
	if (toolResult.success) {
		ctx.fail(
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
		ctx.pass(
			"Fetch blocked domain",
			`Denylist error returned as expected: "${errorMsg}"`,
			shot
		);
	} else {
		ctx.fail(
			"Fetch blocked domain",
			`Tool failed but error doesn't mention denylist. Error: "${errorMsg}"`,
			shot
		);
	}
}

/**
 * Test 5: Fetch a page with a very low output cap → verify truncation notice.
 * Reloads plugin with fetch_webpage_max_output_chars=500 so any real page
 * exceeds the cap and triggers the truncation suffix.
 */
async function testFetchLargeOutput(ctx: TestContext): Promise<void> {
	console.log(
		"\n── Test 5: Fetch page with low output cap (500 chars) → truncation ──"
	);
	console.log(
		"    Reloading plugin with fetch_webpage_max_output_chars=500..."
	);

	injectSettings({ fetch_webpage_max_output_chars: 500 });
	await ctx.page.reload();
	await ctx.page.waitForTimeout(8_000);

	const chat = await waitForSelector(ctx.page, ".notor-chat-container", 10_000);
	if (!chat) {
		ctx.fail("Fetch large page (truncation)", "Chat panel not visible after reload");
		return;
	}

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(ctx.page);

	const responded = await sendMessage(
		ctx.page,
		`Use the fetch_webpage tool to fetch ${WIKIPEDIA_URL}`
	);
	const shot = await ctx.screenshot("05-large-output-truncated");

	if (!responded) {
		ctx.fail("Fetch large page (truncation)", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastFetchWebpageResult();
	if (!toolResult) {
		ctx.fail(
			"Fetch large page (truncation)",
			"No fetch_webpage tool_result found in JSONL history",
			shot
		);
		return;
	}
	if (!toolResult.success) {
		ctx.fail(
			"Fetch large page (truncation)",
			`Tool returned error (expected truncated success): ${toolResult.error ?? "(no error message)"}`,
			shot
		);
		return;
	}

	const result = toolResult.result;
	if (result.includes("truncated at") || result.includes("truncated")) {
		ctx.pass(
			"Fetch large page (truncation)",
			`Truncation notice found in result (${result.length} chars, cap was 500)`,
			shot
		);
	} else {
		ctx.fail(
			"Fetch large page (truncation)",
			`Result (${result.length} chars) did not contain truncation notice. Content: "${result.substring(0, 300)}"`,
			shot
		);
	}
}

/**
 * Test 6: Fetch a URL with a tiny download size cap → verify error.
 * Reloads plugin with fetch_webpage_max_download_mb=0.0001 (~100 bytes)
 * so any real page exceeds the cap.
 */
async function testFetchDownloadSizeExceeded(ctx: TestContext): Promise<void> {
	console.log(
		"\n── Test 6: Fetch page with tiny download cap (0.0001 MB) → size error ──"
	);
	console.log(
		"    Reloading plugin with fetch_webpage_max_download_mb=0.0001..."
	);

	injectSettings({ fetch_webpage_max_download_mb: 0.0001 });
	await ctx.page.reload();
	await ctx.page.waitForTimeout(8_000);

	const chat = await waitForSelector(ctx.page, ".notor-chat-container", 10_000);
	if (!chat) {
		ctx.fail("Download size exceeded", "Chat panel not visible after reload");
		return;
	}

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(ctx.page);

	const responded = await sendMessage(
		ctx.page,
		`Use the fetch_webpage tool to fetch ${WIKIPEDIA_URL}`
	);
	const shot = await ctx.screenshot("06-download-exceeded");

	if (!responded) {
		ctx.fail("Download size exceeded", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastFetchWebpageResult();
	if (!toolResult) {
		ctx.fail(
			"Download size exceeded",
			"No fetch_webpage tool_result found in JSONL history",
			shot
		);
		return;
	}
	if (toolResult.success) {
		ctx.fail(
			"Download size exceeded",
			`Expected tool to fail with size error, but it succeeded (${toolResult.result.length} chars)`,
			shot
		);
		return;
	}

	const errorMsg = toolResult.error ?? "";
	if (
		errorMsg.toLowerCase().includes("large") ||
		errorMsg.toLowerCase().includes("size") ||
		errorMsg.toLowerCase().includes("mb")
	) {
		ctx.pass(
			"Download size exceeded",
			`Size error returned as expected: "${errorMsg}"`,
			shot
		);
	} else {
		ctx.fail(
			"Download size exceeded",
			`Tool failed but error doesn't mention size. Error: "${errorMsg}"`,
			shot
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	console.log(
		"Note: Uses real public URLs (Electron cannot reach 127.0.0.1 from plugin context).\n"
	);

	await page.waitForTimeout(5_000);

	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chat) throw new Error("Chat panel not visible");
	ctx.pass("Chat panel ready", "Plugin loaded");

	// Tests 1–4: use the initial session (no reload needed)
	await testFetchHTML(ctx);
	await testFetchPlainText(ctx);
	await testFetchJSON(ctx);
	await testFetchBlockedDomain(ctx);

	// Tests 5–6: each reloads plugin with different settings
	await testFetchLargeOutput(ctx);
	// Restore normal settings then reload for test 6
	injectSettings();
	await testFetchDownloadSizeExceeded(ctx);
}

runTest(
	{
		name: "fetch-webpage",
		settings: buildDefaultSettings({
			domain_denylist: ["blocked-domain.com", "*.blocked-wildcard.com"],
			fetch_webpage_timeout: 30,
		}),
	},
	tests,
);
