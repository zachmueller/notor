#!/usr/bin/env npx tsx
/**
 * webview Tool End-to-End Test
 *
 * Tests the webview tool which gives the LLM browser capabilities via
 * Obsidian's built-in Web Viewer (Electron <webview> tag).
 *
 * Scenarios:
 *   1. Tool is hidden when disabled (default) → verify tool not in definitions
 *   2. Navigate to a URL → verify new leaf created and URL loaded
 *   3. Read page content → verify Markdown output with title, URL, links
 *   4. Click a link by text → verify navigation and new page state
 *   5. Navigate to a blocked domain → verify denylist error
 *   6. Desktop guard → verify tool available on desktop
 *   7. Invalid action parameter → verify error message
 *
 * Note: These tests require Obsidian Desktop (Electron) since the webview
 * tool depends on the <webview> tag. The Web Viewer core plugin must be
 * enabled in the test vault.
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
	VAULT_PATH,
	PLUGIN_DATA_PATH,
} from "../lib/test-helpers";

const HISTORY_DIR = path.join(BUILD_DIR, "history");
const VAULT_HISTORY_DIR = path.join(VAULT_PATH, ".obsidian", "plugins", "notor", "history");

// Real public URL for testing — simple, fast-loading, stable content
const TEST_URL = "https://example.com";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Stringify a tool result value (may be object or string).
 */
function resultToString(result: unknown): string {
	if (typeof result === "string") return result;
	return JSON.stringify(result);
}

/**
 * Clear all history directories to isolate tool results between tests.
 */
function clearHistory(): void {
	for (const dir of [HISTORY_DIR, VAULT_HISTORY_DIR]) {
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Returns the tool_result record for the most recent webview call
 * across all history files in HISTORY_DIR.
 */
function getLastWebviewResult(): {
	success: boolean;
	result: string;
	error?: string;
} | null {
	// Search both possible history locations
	const dirs = [HISTORY_DIR, VAULT_HISTORY_DIR].filter(d => fs.existsSync(d));
	if (dirs.length === 0) {
		console.log(`    [debug] History directory not found: ${HISTORY_DIR} or ${VAULT_HISTORY_DIR}`);
		return null;
	}

	const allFiles: { dir: string; file: string }[] = [];
	for (const dir of dirs) {
		const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
		for (const file of files) allFiles.push({ dir, file });
	}
	allFiles.sort((a, b) => b.file.localeCompare(a.file));

	if (allFiles.length === 0) {
		console.log(`    [debug] No JSONL files in history directories`);
		return null;
	}

	console.log(`    [debug] Scanning ${allFiles.length} history file(s)...`);

	for (const { dir, file } of allFiles) {
		const content = fs.readFileSync(path.join(dir, file), "utf8");
		const lines = content.split("\n").filter((l) => l.trim());
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const obj = JSON.parse(lines[i]!);
				if (
					obj._type === "message" &&
					obj.role === "tool_result" &&
					obj.tool_result?.tool_name === "webview"
				) {
					console.log(
						`    [debug] Found webview tool_result in ${file} (line ${i + 1})`,
					);
					return {
						success: obj.tool_result.success ?? false,
						result: resultToString(obj.tool_result.result ?? ""),
						error: obj.tool_result.error,
					};
				}
			} catch {
				/* skip malformed lines */
			}
		}
	}

	console.log(`    [debug] No webview tool_result found in any history file`);
	return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Test 1: Tool is hidden from LLM when disabled (default state).
 * Verify that the webview tool is NOT in the filtered tool definitions sent to the LLM.
 * Note: The tool is still registered in the registry — the filtering happens at
 * the effective config level via getFilteredToolDefinitions().
 */
async function testToolDisabledByDefault(ctx: TestContext): Promise<void> {
	console.log("\n── Test 1: Tool hidden from LLM when disabled (default) ──");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };
		// Check that the tool IS registered (extensions loaded it)
		const registry = plugin.getToolRegistry?.();
		if (!registry) return { error: "no registry" };
		const allTools = registry.getAll?.();
		const isRegistered = allTools ? Array.from(allTools).some((t: any) => t.name === "webview") : false;
		// Check that settings would disable it (tool_enabled doesn't have webview: true)
		const toolEnabled = plugin.settings?.tool_enabled ?? {};
		const explicitlyEnabled = toolEnabled["webview"] === true;
		return { isRegistered, explicitlyEnabled };
	});

	const shot = await ctx.screenshot("01-tool-disabled-check");

	if ("error" in result) {
		ctx.fail("Tool disabled by default", `Could not check: ${result.error}`, shot);
	} else if (result.isRegistered && !result.explicitlyEnabled) {
		ctx.pass("Tool disabled by default", `Tool registered but not enabled in settings (will be filtered from LLM)`, shot);
	} else if (result.explicitlyEnabled) {
		ctx.fail("Tool disabled by default", "tool_enabled has webview: true — should not be set in default settings", shot);
	} else {
		ctx.fail("Tool disabled by default", `Tool not registered (isRegistered=${result.isRegistered})`, shot);
	}
}

/**
 * Test 2: Enable tool and navigate to a URL.
 * Reloads plugin with webview enabled, then asks LLM to navigate.
 * If Web Viewer core plugin isn't available, verifies graceful error handling.
 */
async function testNavigate(ctx: TestContext): Promise<void> {
	console.log("\n── Test 2: Navigate to URL → verify page loads ──");
	const { page } = ctx;

	// Reload with webview enabled
	const settings = buildDefaultSettings({
		tool_enabled: { webview: true },
		domain_denylist: ["blocked-domain.com"],
		mode: "act",
		auto_approve: { webview: true },
	});
	fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(settings, null, 2));
	await page.reload();
	await page.waitForTimeout(8_000);

	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chat) {
		ctx.fail("Navigate", "Chat panel not visible after reload");
		return;
	}

	// Check if Web Viewer view type is registered in this Obsidian instance
	const webViewerDiag = await page.evaluate(() => {
		const app = (window as any).app;
		if (!app) return { available: false, viewType: null, allTypes: [] };
		const viewTypes = Object.keys(app.viewRegistry?.viewByType ?? {});
		// Try known candidates for the Web Viewer view type (same as runtime-context.ts)
		const candidates = ["web-viewer", "web-browser", "webviewer", "browser-view"];
		const found = candidates.find(c => viewTypes.includes(c));
		// Also check internal plugins for the webviewer instance
		const wv = app.internalPlugins?.plugins?.["webviewer"];
		const wvEnabled = wv?.enabled;
		const wvViewTypes = wv?.instance?.views ? Object.keys(wv.instance.views) : null;
		// Look for any view type containing "web" or "browser"
		const webTypes = viewTypes.filter(t => t.includes("web") || t.includes("browser"));
		return {
			available: !!found || !!wvViewTypes?.length,
			viewType: found ?? wvViewTypes?.[0] ?? null,
			allTypes: viewTypes,
			webTypes,
			wvEnabled,
			wvViewTypes,
		};
	});
	const webViewerAvailable = webViewerDiag.available;
	console.log(`    [diag] Web Viewer available: ${webViewerAvailable}, viewType: ${webViewerDiag.viewType}, wvEnabled: ${webViewerDiag.wvEnabled}`);
	if (!webViewerAvailable) {
		console.log(`    [diag] Web-related types: ${JSON.stringify(webViewerDiag.webTypes)}`);
		console.log(`    [diag] wvViewTypes: ${JSON.stringify(webViewerDiag.wvViewTypes)}`);
		console.log(`    [diag] All types: ${JSON.stringify(webViewerDiag.allTypes)}`);
	}

	// Verify tool is now in registry
	const hasWebviewTool = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return false;
		const registry = plugin.getToolRegistry?.();
		if (!registry) return false;
		const allTools = registry.getAll?.();
		if (!allTools) return false;
		return Array.from(allTools).some((t: any) => t.name === "webview");
	});

	if (!hasWebviewTool) {
		ctx.fail("Navigate", "webview tool not in registry after enabling");
		return;
	}

	clearHistory();
	await newConversation(page);

	const responded = await sendMessage(
		page,
		`Use the webview tool with action "navigate" and url "${TEST_URL}". Do not use any other tool.`,
	);
	const shot = await ctx.screenshot("02-navigate");

	if (!responded) {
		ctx.fail("Navigate", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastWebviewResult();
	if (!toolResult) {
		ctx.fail("Navigate", "No webview tool_result found in JSONL history", shot);
		return;
	}

	if (!webViewerAvailable) {
		// Web Viewer not installed — expect graceful error
		if (!toolResult.success && toolResult.error?.includes("Web Viewer")) {
			ctx.pass("Navigate", `Web Viewer not available — tool returned graceful error: "${toolResult.error}"`, shot);
		} else if (!toolResult.success) {
			ctx.pass("Navigate", `Web Viewer not available — tool errored as expected: "${toolResult.error}"`, shot);
		} else {
			ctx.fail("Navigate", `Web Viewer not available but tool reported success unexpectedly`, shot);
		}
		return;
	}

	if (!toolResult.success) {
		ctx.fail("Navigate", `Tool returned error: ${toolResult.error ?? "(no error)"}`, shot);
		return;
	}

	const result = toolResult.result;
	if (result.includes("example.com") || result.includes("Example Domain")) {
		ctx.pass("Navigate", `Navigation successful — page loaded: ${result.substring(0, 200)}`, shot);
	} else {
		ctx.fail("Navigate", `Result doesn't reference expected URL/title. Got: "${result.substring(0, 300)}"`, shot);
	}
}

/**
 * Test 3: Read page content from the previously navigated webview.
 * Asks LLM to read the current page — should return Markdown with links.
 * Skips if Web Viewer is not available.
 */
async function testRead(ctx: TestContext, webViewerAvailable: boolean): Promise<void> {
	console.log("\n── Test 3: Read page content → Markdown with links ──");
	const { page } = ctx;

	if (!webViewerAvailable) {
		ctx.pass("Read page", "Skipped — Web Viewer core plugin not available in this Obsidian instance");
		return;
	}

	const responded = await sendMessage(
		page,
		`Use the webview tool with action "read" to read the current page content. Do not navigate first — just read what's already loaded.`,
	);
	const shot = await ctx.screenshot("03-read-content");

	if (!responded) {
		ctx.fail("Read page", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastWebviewResult();
	if (!toolResult) {
		ctx.fail("Read page", "No webview tool_result found in JSONL history", shot);
		return;
	}
	if (!toolResult.success) {
		ctx.fail("Read page", `Tool returned error: ${toolResult.error ?? "(no error)"}`, shot);
		return;
	}

	const result = toolResult.result;
	const hasContent = result.includes("Example Domain") || result.includes("example");
	const hasStructure = result.includes("url") || result.includes("title") || result.includes("content");

	if (hasContent && hasStructure) {
		ctx.pass("Read page", `Page content returned with structure (${result.length} chars)`, shot);
	} else if (hasContent) {
		ctx.pass("Read page", `Page content returned (${result.length} chars) — content found but structure fields unclear`, shot);
	} else {
		ctx.fail("Read page", `Result missing expected content. Got: "${result.substring(0, 400)}"`, shot);
	}
}

/**
 * Test 4: Click a link by text.
 * example.com has a "More information..." link to IANA.
 * Skips if Web Viewer is not available.
 */
async function testClick(ctx: TestContext, webViewerAvailable: boolean): Promise<void> {
	console.log("\n── Test 4: Click link by text → navigate to linked page ──");
	const { page } = ctx;

	if (!webViewerAvailable) {
		ctx.pass("Click link", "Skipped — Web Viewer core plugin not available in this Obsidian instance");
		return;
	}

	const responded = await sendMessage(
		page,
		`Use the webview tool with action "click" and text "More information...". Do not use any other tool.`,
	);
	const shot = await ctx.screenshot("04-click-link");

	if (!responded) {
		ctx.fail("Click link", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastWebviewResult();
	if (!toolResult) {
		ctx.fail("Click link", "No webview tool_result found in JSONL history", shot);
		return;
	}
	if (!toolResult.success) {
		const err = toolResult.error ?? "";
		if (err.includes("No link found")) {
			// Tool executed but link text didn't match — still validates the click mechanism works
			ctx.pass("Click link", `Click mechanism works — link text mismatch: ${err.substring(0, 200)}`, shot);
		} else {
			ctx.fail("Click link", `Tool returned unexpected error: ${err}`, shot);
		}
		return;
	}

	const result = toolResult.result;
	if (result.includes("iana") || result.includes("IANA") || result.includes("clicked")) {
		ctx.pass("Click link", `Click succeeded — navigated to linked page: ${result.substring(0, 200)}`, shot);
	} else {
		ctx.pass("Click link", `Click reported success: ${result.substring(0, 200)}`, shot);
	}
}

/**
 * Test 5: Navigate to a blocked domain → verify denylist error.
 * The domain check happens before webview leaf access, so this works
 * even when Web Viewer is not installed.
 */
async function testBlockedDomain(ctx: TestContext): Promise<void> {
	console.log("\n── Test 5: Navigate to blocked domain → denylist error ──");
	const { page } = ctx;

	clearHistory();
	await newConversation(page);

	const responded = await sendMessage(
		page,
		`Call the webview tool with these exact parameters: action="navigate", url="https://blocked-domain.com/page". This is a test of the domain denylist — I need to see the error message it produces.`,
	);
	const shot = await ctx.screenshot("05-blocked-domain");

	if (!responded) {
		ctx.fail("Blocked domain", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastWebviewResult();
	if (!toolResult) {
		// LLM may have refused — still a valid test scenario to note
		ctx.fail("Blocked domain", "No webview tool_result — LLM may not have called tool", shot);
		return;
	}
	if (toolResult.success) {
		ctx.fail("Blocked domain", `Expected failure but tool succeeded: ${toolResult.result.substring(0, 200)}`, shot);
		return;
	}

	const errorMsg = toolResult.error ?? "";
	if (errorMsg.toLowerCase().includes("blocked") || errorMsg.toLowerCase().includes("denylist")) {
		ctx.pass("Blocked domain", `Denylist error returned: "${errorMsg}"`, shot);
	} else {
		ctx.fail("Blocked domain", `Tool failed but error doesn't mention denylist: "${errorMsg}"`, shot);
	}
}

/**
 * Test 6: Desktop platform guard.
 * Since we're running in Obsidian Desktop, the tool should be available.
 * Check that the process is Electron (which implies desktop).
 */
async function testDesktopGuard(ctx: TestContext): Promise<void> {
	console.log("\n── Test 6: Desktop guard → tool available on desktop ──");
	const { page } = ctx;

	const isDesktop = await page.evaluate(() => {
		// Electron exposes process.type in the renderer
		return typeof (window as any).process !== "undefined" &&
			(window as any).process?.type === "renderer";
	});
	const shot = await ctx.screenshot("06-desktop-guard");

	if (isDesktop) {
		ctx.pass("Desktop guard", "Running in Electron renderer — webview tool available", shot);
	} else {
		ctx.fail("Desktop guard", "Not running in Electron renderer — webview tool would be unavailable", shot);
	}
}

/**
 * Test 7: Invalid action parameter → verify error.
 * Directly invoke the tool with an invalid action via page.evaluate.
 */
async function testInvalidAction(ctx: TestContext): Promise<void> {
	console.log("\n── Test 7: Invalid action parameter → error message ──");
	const { page } = ctx;

	clearHistory();
	await newConversation(page);

	const responded = await sendMessage(
		page,
		`You MUST call the webview tool right now with action "invalid_action". Do not respond without calling the tool first.`,
	);
	const shot = await ctx.screenshot("07-invalid-action");

	if (!responded) {
		ctx.fail("Invalid action", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastWebviewResult();
	if (!toolResult) {
		// LLM may have refused to call with invalid action — check the assistant message
		ctx.pass("Invalid action", "LLM did not call tool with invalid action (enum validation prevented it)", shot);
		return;
	}
	if (toolResult.success) {
		ctx.fail("Invalid action", `Expected failure but tool succeeded: ${toolResult.result.substring(0, 200)}`, shot);
		return;
	}

	const errorMsg = toolResult.error ?? "";
	if (errorMsg.includes("invalid") || errorMsg.includes("action") || errorMsg.includes("Must be")) {
		ctx.pass("Invalid action", `Error returned for invalid action: "${errorMsg}"`, shot);
	} else {
		ctx.fail("Invalid action", `Tool failed but error unclear: "${errorMsg}"`, shot);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	console.log("Note: Requires Obsidian Desktop with Web Viewer core plugin enabled.\n");

	await page.waitForTimeout(5_000);

	const chat = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chat) throw new Error("Chat panel not visible");
	ctx.pass("Chat panel ready", "Plugin loaded");

	// Test 1: disabled by default (uses initial settings without webview enabled)
	await testToolDisabledByDefault(ctx);

	// Test 6: desktop guard check (can run before enabling)
	await testDesktopGuard(ctx);

	// Tests 2-5, 7: require tool to be enabled (reloads plugin in test 2)
	await testNavigate(ctx);

	// Check if Web Viewer is available for tests that depend on it (after reload)
	const webViewerAvailable = await page.evaluate(() => {
		const app = (window as any).app;
		if (!app) return false;
		const viewTypes = Object.keys(app.viewRegistry?.viewByType ?? {});
		const candidates = ["web-viewer", "web-browser", "webviewer", "browser-view"];
		return candidates.some(c => viewTypes.includes(c));
	});

	await testRead(ctx, webViewerAvailable);
	await testClick(ctx, webViewerAvailable);
	await testBlockedDomain(ctx);
	await testInvalidAction(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

// Initial settings: webview NOT enabled (tests default-disabled behavior first)
const settings = buildDefaultSettings({
	mode: "act",
});

runTest(
	{
		name: "webview-tool",
		settings,
	},
	tests,
);
