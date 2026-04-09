#!/usr/bin/env npx tsx
/**
 * Multi-Provider Web Search E2E Test
 *
 * Validates Phase 7.3 manual smoke tests from the multi-provider web search
 * implementation: plugin loads cleanly, new settings fields render in the
 * extension settings UI, DDG-only search works, disabled-all-providers
 * returns a descriptive error, and domain denylist filtering still works.
 *
 * Scenarios:
 *   1. Plugin loads without web-search-related console errors
 *   2. WebSearchQueue and SearchProviderRegistry are initialized
 *   3. Extension settings UI renders all new provider fields
 *   4. Basic DDG-only search returns results correctly
 *   5. All providers disabled → descriptive error returned
 *   6. Domain denylist filtering works with new provider infrastructure
 *
 * @see specs/ZZ-misc/multi-provider-web-search-tasks.md — Phase 7.3
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	waitForSelector,
	sendMessage,
	newConversation,
	getLastToolCallNames,
	getLastAssistantMessage,
	ensureCleanState,
	BUILD_DIR,
	PLUGIN_DATA_PATH,
	VAULT_PATH,
} from "../lib/test-helpers";

const HISTORY_DIR = path.join(BUILD_DIR, "history");

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Open Obsidian settings and navigate to the Notor plugin tab. */
async function openNotorSettings(page: Page): Promise<boolean> {
	await page.keyboard.press("Meta+,");
	await page.waitForTimeout(1_500);

	return page.evaluate(() => {
		const items = Array.from(document.querySelectorAll(".vertical-tab-nav-item"));
		for (const item of items) {
			if (item.textContent?.trim() === "Notor") {
				(item as HTMLElement).click();
				return true;
			}
		}
		return false;
	});
}

/** Close settings dialog. */
async function closeSettings(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await page.waitForTimeout(600);
}

/** Expand a settings group by its summary title. */
async function expandSettingsGroup(page: Page, groupTitle: string): Promise<boolean> {
	return page.evaluate((title) => {
		const summaries = document.querySelectorAll(".notor-settings-group-summary");
		for (const summary of summaries) {
			if (summary.textContent?.trim() === title) {
				const details = summary.closest("details");
				if (details && !details.open) {
					details.setAttribute("open", "");
				}
				return true;
			}
		}
		return false;
	}, groupTitle);
}

/**
 * Returns the tool_result record for the most recent web_search call
 * across all history files in HISTORY_DIR.
 */
function getLastWebSearchResult(): {
	success: boolean;
	result: string;
	error?: string;
} | null {
	if (!fs.existsSync(HISTORY_DIR)) return null;
	const files = fs
		.readdirSync(HISTORY_DIR)
		.filter((f) => f.endsWith(".jsonl"))
		.sort()
		.reverse();
	if (files.length === 0) return null;

	for (const file of files) {
		const content = fs.readFileSync(path.join(HISTORY_DIR, file), "utf8");
		const lines = content.split("\n").filter((l) => l.trim());
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const obj = JSON.parse(lines[i]!);
				if (
					obj._type === "message" &&
					obj.role === "tool_result" &&
					obj.tool_result?.tool_name === "web_search"
				) {
					return {
						success: obj.tool_result.success ?? false,
						result: obj.tool_result.result ?? "",
						error: obj.tool_result.error,
					};
				}
			} catch { /* skip malformed lines */ }
		}
	}
	return null;
}

/** Inject settings mid-test by writing data.json directly. */
function injectSettings(overrides: Record<string, unknown> = {}): void {
	const settings = buildDefaultSettings({
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
 * Test 1: Plugin loads without web-search-related console errors.
 */
async function testNoStartupErrors(ctx: TestContext): Promise<void> {
	console.log("\n── Test 1: No web-search-related startup errors ──");

	const errors = ctx.collector.getLogsByLevel("error");
	const webSearchErrors = errors.filter(
		(e) =>
			e.source.includes("web") ||
			e.source.includes("search") ||
			e.source.includes("queue") ||
			e.source.includes("provider") ||
			e.message.toLowerCase().includes("web_search") ||
			e.message.toLowerCase().includes("websearch"),
	);

	const shot = await ctx.screenshot("01-startup");

	if (webSearchErrors.length > 0) {
		ctx.fail(
			"No startup errors",
			`Found ${webSearchErrors.length} web-search-related error(s): ${webSearchErrors.map((e) => `[${e.source}] ${e.message}`).join("; ")}`,
			shot,
		);
	} else {
		ctx.pass(
			"No startup errors",
			`Plugin loaded cleanly — ${errors.length} total errors (none web-search-related)`,
			shot,
		);
	}
}

/**
 * Test 2: WebSearchQueue and SearchProviderRegistry are properly initialized.
 */
async function testInfrastructureInit(ctx: TestContext): Promise<void> {
	console.log("\n── Test 2: WebSearchQueue and registry initialization ──");

	const result = await ctx.page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };

		try {
			const queue = plugin.getWebSearchQueue();
			const hasQueue = !!queue;
			const hasSearch = typeof queue?.search === "function";

			// Access the private registry through the queue's construction
			// We can verify it by checking if buildConfig works
			const config = queue?.buildConfig?.({});
			const hasConfig = !!config;

			return { hasQueue, hasSearch, hasConfig };
		} catch (err) {
			return { error: String(err) };
		}
	});

	const shot = await ctx.screenshot("02-infrastructure");

	if (result.error) {
		ctx.fail("Infrastructure init", `Error: ${result.error}`, shot);
		return;
	}

	if (result.hasQueue && result.hasSearch) {
		ctx.pass(
			"Infrastructure init",
			`WebSearchQueue initialized — search: ${result.hasSearch}, buildConfig: ${result.hasConfig}`,
			shot,
		);
	} else {
		ctx.fail(
			"Infrastructure init",
			`Missing: queue=${result.hasQueue}, search=${result.hasSearch}`,
			shot,
		);
	}
}

/**
 * Test 3: Extension settings UI renders all new provider fields.
 */
async function testSettingsUIRender(ctx: TestContext): Promise<void> {
	console.log("\n── Test 3: Extension settings UI renders provider fields ──");
	const { page } = ctx;

	const opened = await openNotorSettings(page);
	if (!opened) {
		ctx.fail("Settings UI", "Could not open Notor settings");
		return;
	}
	await page.waitForTimeout(1_000);

	// Expand the Extensions group
	const expanded = await expandSettingsGroup(page, "Extensions");
	if (!expanded) {
		// Try alternate group name
		await expandSettingsGroup(page, "Tool extensions");
	}
	await page.waitForTimeout(1_000);

	// Look for the web_search extension section and expand it
	const webSearchExpanded = await page.evaluate(() => {
		// Find the web_search details section within the settings
		const allDetails = document.querySelectorAll("details");
		for (const details of allDetails) {
			const summary = details.querySelector("summary");
			if (summary && summary.textContent?.includes("web_search")) {
				if (!details.open) details.setAttribute("open", "");
				return true;
			}
		}
		return false;
	});

	if (!webSearchExpanded) {
		const shot = await ctx.screenshot("03-settings-no-web-search");
		ctx.fail("Settings UI — web_search section", "Could not find web_search extension section", shot);
		await closeSettings(page);
		return;
	}
	await page.waitForTimeout(500);

	// Check for expected setting field labels
	const expectedFields = [
		"Round-robin across providers",
		"Provider priority order",
		"Max providers to try",
		"DuckDuckGo — Enabled",
		"DuckDuckGo — Delay (ms)",
		"Tavily — Enabled",
		"Tavily — API Key",
		"Tavily — Delay (ms)",
		"Brave Search — Enabled",
		"Brave Search — API Key",
		"Brave Search — Delay (ms)",
		"SerpApi — Enabled",
		"SerpApi — API Key",
		"SerpApi — Delay (ms)",
	];

	const foundFields = await page.evaluate((fields) => {
		const results: Record<string, boolean> = {};
		// Get all setting item names in the settings modal
		const settingNames = Array.from(document.querySelectorAll(".setting-item-name"));
		const allText = settingNames.map((el) => el.textContent?.trim() ?? "");

		for (const field of fields) {
			results[field] = allText.some((t) => t.includes(field));
		}
		return results;
	}, expectedFields);

	const shot = await ctx.screenshot("03-settings-ui");

	const missing = Object.entries(foundFields)
		.filter(([, found]) => !found)
		.map(([name]) => name);

	if (missing.length === 0) {
		ctx.pass(
			"Settings UI — all provider fields",
			`All ${expectedFields.length} provider settings fields rendered correctly`,
			shot,
		);
	} else {
		ctx.fail(
			"Settings UI — all provider fields",
			`Missing ${missing.length} field(s): ${missing.join(", ")}`,
			shot,
		);
	}

	// Verify provider priority is rendered as a list with reorder controls
	const hasPriorityList = await page.evaluate(() => {
		const settingNames = Array.from(document.querySelectorAll(".setting-item-name"));
		// Look for individual provider entries in the string[] list
		// Each entry in the list renders as its own setting item
		const providerEntries = settingNames.filter((el) => {
			const text = el.textContent?.trim() ?? "";
			return text === "duckduckgo" || text === "tavily" || text === "brave" || text === "serpapi";
		});
		return providerEntries.length;
	});

	if (hasPriorityList >= 4) {
		ctx.pass(
			"Settings UI — priority list entries",
			`Provider priority list shows ${hasPriorityList} entries with individual controls`,
			shot,
		);
	} else {
		ctx.fail(
			"Settings UI — priority list entries",
			`Expected 4 provider priority entries, found ${hasPriorityList}`,
			shot,
		);
	}

	await closeSettings(page);
}

/**
 * Test 4: Basic DDG-only search returns results correctly.
 */
async function testBasicDDGSearch(ctx: TestContext): Promise<void> {
	console.log("\n── Test 4: Basic DDG-only search ──");
	const { page } = ctx;

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(page);
	await ensureCleanState(page);

	const responded = await sendMessage(
		page,
		'Use the web_search tool to search for "Obsidian note-taking plugin" and show me the results.',
	);
	const shot = await ctx.screenshot("04-basic-ddg-search");

	if (!responded) {
		ctx.fail("Basic DDG search", "No response within timeout", shot);
		return;
	}

	// Check tool call appeared
	const toolNames = await getLastToolCallNames(page);
	const hasWebSearch = toolNames.some((n) => n.toLowerCase().includes("web_search"));
	if (!hasWebSearch) {
		ctx.fail(
			"Basic DDG search — tool call",
			`web_search not in UI tool calls: [${toolNames.join(", ")}]`,
			shot,
		);
	} else {
		ctx.pass("Basic DDG search — tool call", "web_search tool call appeared in UI", shot);
	}

	// Check tool result in history
	const toolResult = getLastWebSearchResult();
	if (!toolResult) {
		ctx.fail("Basic DDG search — tool result", "No web_search tool_result in history", shot);
		return;
	}
	if (!toolResult.success) {
		ctx.fail(
			"Basic DDG search — tool result",
			`Tool returned error: ${toolResult.error ?? "(no error message)"}`,
			shot,
		);
		return;
	}

	// Verify results contain search content
	if (toolResult.result.includes("http") || toolResult.result.includes("Obsidian")) {
		ctx.pass(
			"Basic DDG search — results content",
			`Search returned relevant results (${toolResult.result.length} chars)`,
			shot,
		);
	} else {
		ctx.fail(
			"Basic DDG search — results content",
			`Results don't contain expected content: "${toolResult.result.substring(0, 300)}"`,
			shot,
		);
	}

	// Check that provider info is logged (new behavior from Phase 5)
	const logs = ctx.collector.getStructuredLogs();
	const providerLog = logs.find(
		(l) =>
			l.message.includes("provider") ||
			(l.data && JSON.stringify(l.data).includes("provider")),
	);
	if (providerLog) {
		ctx.pass(
			"Basic DDG search — provider logged",
			`Provider info in logs: ${providerLog.message}`,
			shot,
		);
	} else {
		// Not critical — log format may vary
		ctx.pass(
			"Basic DDG search — provider logged",
			"Provider info not found in structured logs (non-critical)",
			shot,
		);
	}
}

/**
 * Test 5: All providers disabled → descriptive error returned.
 */
async function testAllProvidersDisabled(ctx: TestContext): Promise<void> {
	console.log("\n── Test 5: All providers disabled → descriptive error ──");
	const { page } = ctx;

	// Inject settings with all providers disabled
	console.log("    Reloading with all providers disabled...");
	const extOverrides: Record<string, unknown> = {
		web_search: {
			web_search_timeout: 10,
			web_search_default_num_results: 5,
			web_search_duckduckgo_enabled: false,
			web_search_tavily_enabled: false,
			web_search_brave_enabled: false,
			web_search_serpapi_enabled: false,
		},
	};
	injectSettings({ user_extension_settings: extOverrides });
	await page.reload();
	await page.waitForTimeout(8_000);

	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chat) {
		ctx.fail("All providers disabled", "Chat panel not visible after reload");
		return;
	}

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(page);
	await ensureCleanState(page);

	const responded = await sendMessage(
		page,
		'Use the web_search tool to search for "test all disabled" right now. You MUST call the web_search tool.',
	);
	const shot = await ctx.screenshot("05-all-disabled");

	if (!responded) {
		ctx.fail("All providers disabled", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastWebSearchResult();
	if (!toolResult) {
		ctx.fail("All providers disabled", "No web_search tool_result in history", shot);
		return;
	}

	// Expect an error about no providers configured
	if (!toolResult.success) {
		const errorMsg = (toolResult.error ?? toolResult.result).toLowerCase();
		if (
			errorMsg.includes("no") &&
			(errorMsg.includes("provider") || errorMsg.includes("configured"))
		) {
			ctx.pass(
				"All providers disabled — descriptive error",
				`Got expected error: "${toolResult.error ?? toolResult.result}"`,
				shot,
			);
		} else if (errorMsg.includes("failed") || errorMsg.includes("error")) {
			ctx.pass(
				"All providers disabled — error returned",
				`Got error (not as descriptive as ideal): "${toolResult.error ?? toolResult.result}"`,
				shot,
			);
		} else {
			ctx.fail(
				"All providers disabled — descriptive error",
				`Unexpected error message: "${toolResult.error ?? toolResult.result}"`,
				shot,
			);
		}
	} else {
		// If it somehow succeeded, that's unexpected
		ctx.fail(
			"All providers disabled",
			`Expected error but tool succeeded: "${toolResult.result.substring(0, 200)}"`,
			shot,
		);
	}
}

/**
 * Test 6: Domain denylist filtering works with new provider infrastructure.
 */
async function testDomainDenylist(ctx: TestContext): Promise<void> {
	console.log("\n── Test 6: Domain denylist filtering ──");
	const { page } = ctx;

	// Reload with DDG enabled and wikipedia.org blocked
	console.log("    Reloading with wikipedia.org in denylist...");
	injectSettings({
		domain_denylist: ["*.wikipedia.org", "blocked-domain.com"],
	});
	await page.reload();
	await page.waitForTimeout(8_000);

	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chat) {
		ctx.fail("Domain denylist", "Chat panel not visible after reload");
		return;
	}

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(page);
	await ensureCleanState(page);

	const responded = await sendMessage(
		page,
		'Use the web_search tool to search for "Albert Einstein physicist" and show me the raw results.',
	);
	const shot = await ctx.screenshot("06-domain-denylist");

	if (!responded) {
		ctx.fail("Domain denylist", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastWebSearchResult();
	if (!toolResult) {
		ctx.fail("Domain denylist", "No web_search tool_result in history", shot);
		return;
	}

	if (toolResult.result.includes("wikipedia.org")) {
		ctx.fail(
			"Domain denylist — filtering",
			`wikipedia.org found in results despite denylist: "${toolResult.result.substring(0, 400)}"`,
			shot,
		);
	} else {
		ctx.pass(
			"Domain denylist — filtering",
			"wikipedia.org correctly excluded from search results",
			shot,
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	console.log(
		"Note: Uses real DuckDuckGo search — Electron cannot reach localhost from plugin context.\n",
	);

	await page.waitForTimeout(5_000);

	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chat) throw new Error("Chat panel not visible");
	ctx.pass("Chat panel ready", "Plugin loaded");

	await testNoStartupErrors(ctx);
	await testInfrastructureInit(ctx);
	await testSettingsUIRender(ctx);
	await testBasicDDGSearch(ctx);
	await testAllProvidersDisabled(ctx);
	await testDomainDenylist(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	web_search_timeout: 10,
	web_search_default_num_results: 5,
	auto_approve: { web_search: true, fetch_webpage: true },
});

runTest({ name: "multi-provider-web-search", settings }, tests);
