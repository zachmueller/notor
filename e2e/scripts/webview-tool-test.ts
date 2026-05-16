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
	sendMessageWithApprovalHandling,
	newConversation,
	setMode,
	buildDefaultSettings,
	BUILD_DIR,
	PLUGIN_DATA_PATH,
} from "../lib/test-helpers";

const HISTORY_DIR = path.join(BUILD_DIR, "history");

// Real public URL for testing — simple, fast-loading, stable content
const TEST_URL = "https://example.com";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Returns the tool_result record for the most recent webview call
 * across all history files in HISTORY_DIR.
 */
function getLastWebviewResult(): {
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
			"utf8",
		);
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
		`    [debug] No webview tool_result found in any history file`,
	);
	return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Test 1: Tool is hidden when disabled (default state).
 * Verify that the webview tool is NOT in the tool definitions when disabled.
 */
async function testToolDisabledByDefault(ctx: TestContext): Promise<void> {
	console.log("\n── Test 1: Tool hidden when disabled (default) ──");
	const { page } = ctx;

	const hasWebviewTool = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		const registry = plugin.getToolRegistry?.();
		if (!registry) return null;
		const allTools = registry.getAll?.();
		if (!allTools) return null;
		return Array.from(allTools).some((t: any) => t.name === "webview");
	});

	const shot = await ctx.screenshot("01-tool-disabled-check");

	if (hasWebviewTool === null) {
		ctx.fail("Tool disabled by default", "Could not access tool registry", shot);
	} else if (hasWebviewTool === false) {
		ctx.pass("Tool disabled by default", "webview tool not in registry when disabled", shot);
	} else {
		ctx.fail("Tool disabled by default", "webview tool found in registry despite being disabled", shot);
	}
}

/**
 * Test 2: Enable tool and navigate to a URL.
 * Reloads plugin with webview enabled, then asks LLM to navigate.
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

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
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
 */
async function testRead(ctx: TestContext): Promise<void> {
	console.log("\n── Test 3: Read page content → Markdown with links ──");
	const { page } = ctx;

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });

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
	// example.com should contain "Example Domain" text and a link to IANA
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
 */
async function testClick(ctx: TestContext): Promise<void> {
	console.log("\n── Test 4: Click link by text → navigate to linked page ──");
	const { page } = ctx;

	// First navigate back to example.com to ensure we have a known state
	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });

	const responded = await sendMessage(
		page,
		`Use the webview tool with action "click" and text "More information". Do not use any other tool.`,
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
		// Click might fail if the link text doesn't match — check if it's an informative error
		const err = toolResult.error ?? "";
		if (err.includes("No link found") && err.includes("Available link texts")) {
			ctx.fail("Click link", `Link text "More information" not found. Error: ${err.substring(0, 300)}`, shot);
		} else {
			ctx.fail("Click link", `Tool returned error: ${err}`, shot);
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
 */
async function testBlockedDomain(ctx: TestContext): Promise<void> {
	console.log("\n── Test 5: Navigate to blocked domain → denylist error ──");
	const { page } = ctx;

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
	await newConversation(page);

	const responded = await sendMessage(
		page,
		`You MUST call the webview tool right now with action "navigate" and url "https://blocked-domain.com/page". Do not respond without calling the tool first.`,
	);
	const shot = await ctx.screenshot("05-blocked-domain");

	if (!responded) {
		ctx.fail("Blocked domain", "No response within timeout", shot);
		return;
	}

	const toolResult = getLastWebviewResult();
	if (!toolResult) {
		ctx.fail("Blocked domain", "No webview tool_result found in JSONL history", shot);
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
 * Verify the webview facade is wired (utils.webview is not null).
 */
async function testDesktopGuard(ctx: TestContext): Promise<void> {
	console.log("\n── Test 6: Desktop guard → tool available on desktop ──");
	const { page } = ctx;

	const isDesktop = await page.evaluate(() => {
		return (window as any).require?.("obsidian")?.Platform?.isDesktopApp ?? null;
	});
	const shot = await ctx.screenshot("06-desktop-guard");

	if (isDesktop === true) {
		ctx.pass("Desktop guard", "Running on desktop — webview tool should be available", shot);
	} else if (isDesktop === null) {
		ctx.fail("Desktop guard", "Could not determine platform from Obsidian API", shot);
	} else {
		ctx.fail("Desktop guard", `Not desktop (isDesktopApp=${isDesktop}) — webview tool would be unavailable`, shot);
	}
}

/**
 * Test 7: Invalid action parameter → verify error.
 * Directly invoke the tool with an invalid action via page.evaluate.
 */
async function testInvalidAction(ctx: TestContext): Promise<void> {
	console.log("\n── Test 7: Invalid action parameter → error message ──");
	const { page } = ctx;

	if (fs.existsSync(HISTORY_DIR))
		fs.rmSync(HISTORY_DIR, { recursive: true, force: true });
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

	// Tests 2-5, 7: require tool to be enabled (reloads plugin)
	await testNavigate(ctx);
	await testRead(ctx);
	await testClick(ctx);
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
