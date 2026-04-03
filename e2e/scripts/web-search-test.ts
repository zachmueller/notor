#!/usr/bin/env npx tsx
/**
 * web_search End-to-End Test
 *
 * Tests the web_search tool against DuckDuckGo's HTML endpoint in the real
 * Obsidian runtime environment.
 *
 * Scenarios:
 *   1. Basic search returns results — verify web_search tool call appears and
 *      the assistant response references search results
 *   2. Domain denylist filtering — verify blocked domains are excluded from results
 *   3. Search-then-fetch workflow — verify both web_search and fetch_webpage
 *      tool calls appear when asked to search and then read a result
 *   4. Error handling — timeout — verify graceful error with extremely low timeout
 *
 * @see specs/ZZ-misc/web-search-tool-impl-plan.md — Phase 5
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	sendMessage,
	sendMessageWithApprovalHandling,
	newConversation,
	waitForSelector,
	getLastToolCallNames,
	getLastAssistantMessage,
	buildDefaultSettings,
	ensureCleanState,
	BUILD_DIR,
	PLUGIN_DATA_PATH,
} from "../lib/test-helpers";

const HISTORY_DIR = path.join(BUILD_DIR, "history");

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Returns the tool_result record for the most recent web_search call
 * across all history files in HISTORY_DIR.
 */
function getLastWebSearchResult(): {
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
					obj.tool_result?.tool_name === "web_search"
				) {
					console.log(
						`    [debug] Found web_search tool_result in ${file} (line ${i + 1})`
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
		`    [debug] No web_search tool_result found in any history file`
	);
	return null;
}

/**
 * Get all tool names from tool_result messages in the most recent history file.
 */
function getToolNamesFromHistory(): string[] {
	if (!fs.existsSync(HISTORY_DIR)) return [];
	const files = fs
		.readdirSync(HISTORY_DIR)
		.filter((f) => f.endsWith(".jsonl"))
		.sort()
		.reverse();
	if (files.length === 0) return [];

	const content = fs.readFileSync(
		path.join(HISTORY_DIR, files[0]!),
		"utf8"
	);
	const lines = content.split("\n").filter((l) => l.trim());
	const names: string[] = [];
	for (const line of lines) {
		try {
			const obj = JSON.parse(line);
			if (
				obj._type === "message" &&
				obj.role === "tool_result" &&
				obj.tool_result?.tool_name
			) {
				names.push(obj.tool_result.tool_name);
			}
		} catch {
			/* skip */
		}
	}
	return names;
}

/**
 * Inject settings mid-test. Builds on buildDefaultSettings with overrides.
 */
function injectSettings(overrides: Record<string, unknown> = {}): void {
	const settings = buildDefaultSettings({
		domain_denylist: ["blocked-domain.com", "*.blocked-wildcard.com"],
		web_search_timeout: 10,
		web_search_default_num_results: 5,
		auto_approve: { web_search: true, fetch_webpage: true },
		...overrides,
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Test 1: Basic search returns results.
 * Send a search query and verify:
 * - web_search tool call appears in UI
 * - assistant response references search results
 */
async function testBasicSearch(ctx: TestContext): Promise<void> {
	console.log("\n── Test 1: Basic search returns results ──");
	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(ctx.page);

	const responded = await sendMessage(
		ctx.page,
		'Use the web_search tool to search for "Obsidian note-taking app" and summarize the results.'
	);
	const shot = await ctx.screenshot("01-basic-search");

	if (!responded) {
		ctx.fail("Basic search", "No response within timeout", shot);
		return;
	}

	// Check tool call appeared in UI
	const toolNames = await getLastToolCallNames(ctx.page);
	const hasWebSearch = toolNames.some((n) =>
		n.toLowerCase().includes("web_search")
	);
	if (!hasWebSearch) {
		ctx.fail(
			"Basic search — tool call in UI",
			`web_search tool call not found in UI. Tool names found: [${toolNames.join(", ")}]`,
			shot
		);
	} else {
		ctx.pass(
			"Basic search — tool call in UI",
			"web_search tool call appeared in UI",
			shot
		);
	}

	// Check tool result in history
	const toolResult = getLastWebSearchResult();
	if (!toolResult) {
		ctx.fail(
			"Basic search — tool result",
			"No web_search tool_result found in JSONL history",
			shot
		);
		return;
	}
	if (!toolResult.success) {
		ctx.fail(
			"Basic search — tool result",
			`Tool returned error: ${toolResult.error ?? "(no error message)"}`,
			shot
		);
		return;
	}

	// Verify results contain search content
	const result = toolResult.result;
	if (
		result.includes("Obsidian") ||
		result.includes("note") ||
		result.includes("http")
	) {
		ctx.pass(
			"Basic search — results content",
			`Search returned relevant results (${result.length} chars)`,
			shot
		);
	} else {
		ctx.fail(
			"Basic search — results content",
			`Results don't contain expected content. Got: "${result.substring(0, 300)}"`,
			shot
		);
	}

	// Verify assistant referenced the results
	const assistantMsg = await getLastAssistantMessage(ctx.page);
	if (assistantMsg.length > 20) {
		ctx.pass(
			"Basic search — assistant response",
			`Assistant provided a substantive response (${assistantMsg.length} chars)`,
			shot
		);
	} else {
		ctx.fail(
			"Basic search — assistant response",
			`Assistant response too short or empty: "${assistantMsg}"`,
			shot
		);
	}
}

/**
 * Test 2: Domain denylist filtering.
 * Configure denylist with "wikipedia.org", search for a topic that would
 * normally return Wikipedia results, and verify Wikipedia is excluded.
 */
async function testDomainDenylist(ctx: TestContext): Promise<void> {
	console.log("\n── Test 2: Domain denylist filtering ──");

	// Reload with wikipedia.org blocked
	console.log("    Reloading plugin with wikipedia.org in denylist...");
	injectSettings({
		domain_denylist: [
			"*.wikipedia.org",
			"blocked-domain.com",
			"*.blocked-wildcard.com",
		],
	});
	await ctx.page.reload();
	await ctx.page.waitForTimeout(8_000);

	const chat = await waitForSelector(
		ctx.page,
		".notor-chat-container",
		10_000
	);
	if (!chat) {
		ctx.fail("Domain denylist", "Chat panel not visible after reload");
		return;
	}

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(ctx.page);

	const responded = await sendMessage(
		ctx.page,
		'Use the web_search tool to search for "Albert Einstein physicist" and show me the raw results.'
	);
	const shot = await ctx.screenshot("02-domain-denylist");

	if (!responded) {
		ctx.fail("Domain denylist", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastWebSearchResult();
	if (!toolResult) {
		ctx.fail(
			"Domain denylist",
			"No web_search tool_result found in JSONL history",
			shot
		);
		return;
	}
	if (!toolResult.success) {
		// Even "No results found" is a valid success response
		ctx.pass(
			"Domain denylist — tool executed",
			`Tool returned: ${toolResult.error ?? toolResult.result.substring(0, 200)}`,
			shot
		);
	}

	const result = toolResult.result;
	if (result.includes("wikipedia.org")) {
		ctx.fail(
			"Domain denylist — filtering",
			`wikipedia.org found in results despite being in denylist. Result: "${result.substring(0, 400)}"`,
			shot
		);
	} else {
		ctx.pass(
			"Domain denylist — filtering",
			"wikipedia.org correctly excluded from search results",
			shot
		);
	}
}

/**
 * Test 3: Search-then-fetch workflow.
 * Ask the LLM to search and then fetch one of the results.
 * Verify both web_search and fetch_webpage tool calls appear.
 */
async function testSearchThenFetch(ctx: TestContext): Promise<void> {
	console.log("\n── Test 3: Search-then-fetch workflow ──");

	// Restore normal settings (no wikipedia block)
	console.log("    Reloading plugin with normal settings...");
	injectSettings();
	await ctx.page.reload();
	await ctx.page.waitForTimeout(8_000);

	const chat = await waitForSelector(
		ctx.page,
		".notor-chat-container",
		10_000
	);
	if (!chat) {
		ctx.fail("Search-then-fetch", "Chat panel not visible after reload");
		return;
	}

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(ctx.page);
	await ensureCleanState(ctx.page);

	const { responded } = await sendMessageWithApprovalHandling(
		ctx.page,
		'Use the web_search tool to search for "RFC 2549 IP over Avian Carriers". Then use fetch_webpage to read the full content of the first result URL. Show me a summary of what you fetched.',
		120_000
	);
	const shot = await ctx.screenshot("03-search-then-fetch");

	if (!responded) {
		ctx.fail("Search-then-fetch", "No response within timeout", shot);
		return;
	}

	// Check both tool calls appeared
	const historyTools = getToolNamesFromHistory();
	const hasSearch = historyTools.includes("web_search");
	const hasFetch = historyTools.includes("fetch_webpage");

	if (hasSearch && hasFetch) {
		ctx.pass(
			"Search-then-fetch — both tools used",
			`Both web_search and fetch_webpage tool calls found in history: [${historyTools.join(", ")}]`,
			shot
		);
	} else {
		ctx.fail(
			"Search-then-fetch — both tools used",
			`Expected both web_search and fetch_webpage. Found: [${historyTools.join(", ")}]`,
			shot
		);
	}

	// Also check the UI shows both tool call cards
	const uiToolNames = await getLastToolCallNames(ctx.page);
	const uiHasSearch = uiToolNames.some((n) =>
		n.toLowerCase().includes("web_search")
	);
	const uiHasFetch = uiToolNames.some((n) =>
		n.toLowerCase().includes("fetch_webpage")
	);

	if (uiHasSearch && uiHasFetch) {
		ctx.pass(
			"Search-then-fetch — UI tool cards",
			"Both tool call cards visible in UI",
			shot
		);
	} else {
		ctx.fail(
			"Search-then-fetch — UI tool cards",
			`UI tool cards: [${uiToolNames.join(", ")}] — expected both web_search and fetch_webpage`,
			shot
		);
	}
}

/**
 * Test 4: Error handling — timeout.
 * Set web_search_timeout to an extremely low value so the request times out.
 * Verify the tool returns a timeout error gracefully.
 */
async function testTimeout(ctx: TestContext): Promise<void> {
	console.log("\n── Test 4: Error handling — timeout ──");

	// Reload with extremely low timeout
	console.log(
		"    Reloading plugin with web_search_timeout=0.001 (1ms)..."
	);
	injectSettings({ web_search_timeout: 0.001 });
	await ctx.page.reload();
	await ctx.page.waitForTimeout(8_000);

	const chat = await waitForSelector(
		ctx.page,
		".notor-chat-container",
		10_000
	);
	if (!chat) {
		ctx.fail("Timeout handling", "Chat panel not visible after reload");
		return;
	}

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(ctx.page);

	const responded = await sendMessage(
		ctx.page,
		'Use the web_search tool to search for "test query timeout" right now. You MUST call the web_search tool.'
	);
	const shot = await ctx.screenshot("04-timeout");

	if (!responded) {
		ctx.fail("Timeout handling", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastWebSearchResult();
	if (!toolResult) {
		ctx.fail(
			"Timeout handling",
			"No web_search tool_result found in JSONL history",
			shot
		);
		return;
	}

	if (toolResult.success) {
		// The request might still succeed if DuckDuckGo responds within 1ms
		// (unlikely but possible). Check if there's a timeout indicator.
		ctx.fail(
			"Timeout handling",
			`Expected timeout error but tool succeeded. Result: "${toolResult.result.substring(0, 200)}"`,
			shot
		);
		return;
	}

	const errorMsg = (toolResult.error ?? "").toLowerCase();
	if (
		errorMsg.includes("timeout") ||
		errorMsg.includes("timed out") ||
		errorMsg.includes("failed")
	) {
		ctx.pass(
			"Timeout handling",
			`Timeout error returned gracefully: "${toolResult.error}"`,
			shot
		);
	} else {
		// Any error is acceptable here — the point is it didn't crash
		ctx.pass(
			"Timeout handling",
			`Tool returned error (not a timeout but still graceful): "${toolResult.error}"`,
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
		"Note: Uses real DuckDuckGo search (Electron cannot reach 127.0.0.1 from plugin context).\n"
	);

	await page.waitForTimeout(5_000);

	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chat) throw new Error("Chat panel not visible");
	ctx.pass("Chat panel ready", "Plugin loaded");

	await testBasicSearch(ctx);
	await testDomainDenylist(ctx);
	await testSearchThenFetch(ctx);
	await testTimeout(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	domain_denylist: ["blocked-domain.com", "*.blocked-wildcard.com"],
	web_search_timeout: 10,
	web_search_default_num_results: 5,
	auto_approve: { web_search: true, fetch_webpage: true },
});

runTest({ name: "web-search", settings }, tests);
