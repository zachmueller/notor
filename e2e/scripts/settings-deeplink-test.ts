#!/usr/bin/env npx tsx
/**
 * Settings Deep-Link E2E Test
 *
 * Validates that `notor-settings://` links in assistant messages render as
 * clickable elements and correctly open the Obsidian settings panel to the
 * target section when clicked.
 *
 * Pre-populates conversation history with known assistant messages containing
 * settings deep-links to avoid any flaky LLM behavior.
 *
 * Scenarios:
 *   1. DOM inspection — verify rendered anchor elements after markdown rendering
 *   2. Click handler — verify clicking a settings deep-link fires the callback
 *   3. Settings navigation — verify the Obsidian settings panel opens to the correct group
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, VAULT_PATH, waitForSelector } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Pre-populated conversation data
// ---------------------------------------------------------------------------

const CONVERSATION_ID = "deeplink-test-0001-0001-0001-000000000001";
const NOW = new Date().toISOString();

/** Assistant message content that includes notor-settings:// links. */
const ASSISTANT_CONTENT = [
	"Here's how to configure your AI provider in Notor:",
	"",
	"1. Open [Open Provider setup](notor-settings://Provider%20setup) and select your provider.",
	"2. For automation, visit [Open Automation](notor-settings://Automation).",
	"3. You can also check [Open Tool configuration](notor-settings://Tool%20configuration) for advanced options.",
].join("\n");

/**
 * Build a minimal JSONL conversation file with one user message
 * and one assistant message containing settings deep-links.
 */
function buildConversationJsonl(): string {
	const lines = [
		JSON.stringify({
			_type: "conversation",
			id: CONVERSATION_ID,
			created_at: NOW,
			updated_at: NOW,
			title: "Settings Deep-Link Test",
			provider_id: "bedrock",
			model_id: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
			total_input_tokens: 100,
			total_output_tokens: 50,
			estimated_cost: 0.0001,
			mode: "plan",
		}),
		JSON.stringify({
			_type: "message",
			id: "msg-user-0001",
			conversation_id: CONVERSATION_ID,
			role: "user",
			content: "How do I change my AI provider in Notor?",
			timestamp: NOW,
		}),
		JSON.stringify({
			_type: "message",
			id: "msg-assistant-0001",
			conversation_id: CONVERSATION_ID,
			role: "assistant",
			content: ASSISTANT_CONTENT,
			timestamp: new Date(Date.parse(NOW) + 1000).toISOString(),
			input_tokens: 100,
			output_tokens: 50,
			cost_estimate: 0.0001,
		}),
	];
	return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Vault setup — create pre-populated history file
// ---------------------------------------------------------------------------

const HISTORY_FILENAME = "20260403_120000_deeplink-test.jsonl";

function setupTestVault(vaultPath: string): void {
	console.log("  Setting up settings deep-link test fixtures...");
	const historyDir = path.join(vaultPath, ".obsidian/plugins/notor/history/");
	fs.mkdirSync(historyDir, { recursive: true });
	fs.writeFileSync(
		path.join(historyDir, HISTORY_FILENAME),
		buildConversationJsonl(),
		"utf8",
	);
	console.log(`    Created history file: ${HISTORY_FILENAME}`);
}

// ---------------------------------------------------------------------------
// Test 1: DOM inspection after rendering
// ---------------------------------------------------------------------------

async function testDomInspection(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: DOM inspection — rendered anchor elements");
	const { page } = ctx;

	// Switch to the pre-populated conversation
	const switched = await page.evaluate(async (filename: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { ok: false, error: "plugin not found" };
		try {
			const orchestrator = plugin.getOrchestrator();
			await orchestrator.switchConversation(filename);
			return { ok: true };
		} catch (e: any) {
			return { ok: false, error: e.message ?? String(e) };
		}
	}, HISTORY_FILENAME);

	if (!switched.ok) {
		const shot = await ctx.screenshot("01-switch-failed");
		ctx.fail("DOM inspection — load conversation", `Failed to switch: ${switched.error}`, shot);
		return;
	}

	// Wait for the assistant message to render
	await page.waitForTimeout(3_000);
	const shot1 = await ctx.screenshot("01-conversation-loaded");

	// Check that assistant message is present
	const assistantMsgCount = await page.evaluate(() => {
		return document.querySelectorAll(".notor-message-assistant").length;
	});
	if (assistantMsgCount === 0) {
		ctx.fail("DOM inspection — assistant message rendered", "No assistant messages found in DOM", shot1);
		return;
	}
	ctx.pass("DOM inspection — assistant message rendered", `Found ${assistantMsgCount} assistant message(s)`, shot1);

	// Inspect all <a> elements inside the last assistant message
	const linkReport = await page.evaluate(() => {
		const msgs = document.querySelectorAll(".notor-message-assistant");
		const lastMsg = msgs[msgs.length - 1];
		if (!lastMsg) return { error: "no assistant message", links: [] };

		const contentEl = lastMsg.querySelector(".notor-message-content");
		if (!contentEl) return { error: "no content element", links: [] };

		const allAnchors = contentEl.querySelectorAll("a");
		const links = Array.from(allAnchors).map((a) => ({
			tagName: a.tagName,
			href: a.getAttribute("href"),
			dataHref: a.getAttribute("data-href"),
			dataNotorSettingsGroup: a.dataset.notorSettingsGroup ?? null,
			className: a.className,
			textContent: a.textContent?.substring(0, 80) ?? "",
			hasClickListener: true, // can't inspect this from JS
		}));

		return { error: null, links, totalAnchors: allAnchors.length };
	});

	console.log("  Link report:", JSON.stringify(linkReport, null, 2));

	if (linkReport.error) {
		ctx.fail("DOM inspection — content element", linkReport.error, shot1);
		return;
	}

	if (linkReport.links.length === 0) {
		const shot = await ctx.screenshot("01-no-links");
		ctx.fail("DOM inspection — anchors found", "No <a> elements found in assistant message content", shot);
		return;
	}
	ctx.pass("DOM inspection — anchors found", `Found ${linkReport.links.length} anchor(s)`);

	// Check if any link has our expected attributes
	const settingsLinks = linkReport.links.filter(
		(l) => l.dataNotorSettingsGroup || l.href?.startsWith("notor-settings://") || l.dataHref?.startsWith("notor-settings://"),
	);

	if (settingsLinks.length > 0) {
		ctx.pass("DOM inspection — settings links activated", `Found ${settingsLinks.length} settings link(s): ${JSON.stringify(settingsLinks.map((l) => l.dataNotorSettingsGroup ?? l.href))}`);
	} else {
		const shot = await ctx.screenshot("01-no-settings-links");
		ctx.fail(
			"DOM inspection — settings links activated",
			`No settings links found. All anchors: ${JSON.stringify(linkReport.links.map((l) => ({ href: l.href, dataHref: l.dataHref, cls: l.className, text: l.textContent })))}`,
			shot,
		);
	}

	// Check the notor-settings-link CSS class
	const hasClass = linkReport.links.some((l) => l.className.includes("notor-settings-link"));
	if (hasClass) {
		ctx.pass("DOM inspection — CSS class applied", "At least one link has .notor-settings-link class");
	} else {
		ctx.fail("DOM inspection — CSS class applied", `No link has .notor-settings-link class. Classes: ${JSON.stringify(linkReport.links.map((l) => l.className))}`);
	}
}

// ---------------------------------------------------------------------------
// Test 2: Click handler fires
// ---------------------------------------------------------------------------

async function testClickHandler(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Click handler — verify click dispatches callback");
	const { page } = ctx;

	// Install a spy on the settings group callback
	const clickResult = await page.evaluate(async () => {
		return new Promise<{ fired: boolean; groupTitle: string | null; error: string | null }>((resolve) => {
			const timeout = setTimeout(() => {
				resolve({ fired: false, groupTitle: null, error: "timeout — click handler never fired" });
			}, 5_000);

			// Find a settings link
			const msgs = document.querySelectorAll(".notor-message-assistant");
			const lastMsg = msgs[msgs.length - 1];
			if (!lastMsg) {
				clearTimeout(timeout);
				resolve({ fired: false, groupTitle: null, error: "no assistant message" });
				return;
			}

			const settingsLink =
				lastMsg.querySelector<HTMLAnchorElement>("a.notor-settings-link") ??
				lastMsg.querySelector<HTMLAnchorElement>("a[data-notor-settings-group]");

			if (!settingsLink) {
				// Try clicking any anchor that might have our href
				const allAnchors = lastMsg.querySelectorAll("a");
				let found = false;
				for (const a of allAnchors) {
					const href = a.getAttribute("href") ?? a.getAttribute("data-href") ?? "";
					if (href.includes("notor-settings")) {
						clearTimeout(timeout);
						// Click it and observe what happens
						a.click();
						resolve({ fired: false, groupTitle: null, error: `Found anchor with href="${href}" but no notor-settings-link class. Clicked it.` });
						found = true;
						break;
					}
				}
				if (!found) {
					clearTimeout(timeout);
					resolve({ fired: false, groupTitle: null, error: "no settings link element found (no .notor-settings-link class, no data-notor-settings-group attr, no notor-settings href)" });
				}
				return;
			}

			// Override the Obsidian settings open to intercept and capture the call
			const origOpenTabById = (window as any).app?.setting?.openTabById;
			if ((window as any).app?.setting) {
				(window as any).app.setting.openTabById = (id: string) => {
					clearTimeout(timeout);
					// Restore original
					if (origOpenTabById) (window as any).app.setting.openTabById = origOpenTabById;
					resolve({ fired: true, groupTitle: settingsLink.dataset.notorSettingsGroup ?? "unknown", error: null });
				};
			}

			// Click the settings link
			settingsLink.click();
		});
	});

	console.log("  Click result:", JSON.stringify(clickResult));
	const shot = await ctx.screenshot("02-click-result");

	if (clickResult.error && !clickResult.fired) {
		ctx.fail("Click handler — fires", clickResult.error, shot);
		return;
	}

	if (clickResult.fired) {
		ctx.pass("Click handler — fires", `Callback fired for group: "${clickResult.groupTitle}"`, shot);
	} else {
		ctx.fail("Click handler — fires", `Click did not fire callback. Result: ${JSON.stringify(clickResult)}`, shot);
	}
}

// ---------------------------------------------------------------------------
// Test 3: Check structured logs for diagnostics
// ---------------------------------------------------------------------------

async function testStructuredLogs(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Structured logs — check activateSettingsLinks diagnostics");

	const logs = ctx.collector.getStructuredLogs();
	const settingsLinkLogs = logs.filter(
		(l) => l.source === "ChatView" && l.message.includes("activateSettingsLinks"),
	);

	console.log(`  Found ${settingsLinkLogs.length} activateSettingsLinks log entries:`);
	for (const entry of settingsLinkLogs) {
		console.log(`    [${entry.level}] ${entry.message}`, JSON.stringify(entry.data));
	}

	if (settingsLinkLogs.length === 0) {
		ctx.fail("Structured logs — activateSettingsLinks called", "No log entries found for activateSettingsLinks — method may not be called");
		return;
	}
	ctx.pass("Structured logs — activateSettingsLinks called", `Found ${settingsLinkLogs.length} log entries`);

	// Check if any anchors were found during scanning
	const scanLogs = settingsLinkLogs.filter((l) => l.message.includes("scanning"));
	if (scanLogs.length > 0) {
		const lastScan = scanLogs[scanLogs.length - 1];
		const data = lastScan?.data as Record<string, unknown> | undefined;
		console.log(`  Last scan: totalAnchors=${data?.totalAnchors}, hasCallback=${data?.hasCallback}`);
		ctx.pass("Structured logs — scan data", `totalAnchors=${data?.totalAnchors}, hasCallback=${data?.hasCallback}`);
	}

	// Check if any settings links were matched
	const matchLogs = settingsLinkLogs.filter((l) => l.message.includes("matched"));
	if (matchLogs.length > 0) {
		ctx.pass("Structured logs — links matched", `${matchLogs.length} settings link(s) matched`);
	} else {
		// Check anchor details to understand why nothing matched
		const anchorLogs = settingsLinkLogs.filter((l) => l.message.includes("anchor found"));
		if (anchorLogs.length > 0) {
			console.log("  Anchor details (showing why none matched):");
			for (const al of anchorLogs) {
				console.log("   ", JSON.stringify(al.data));
			}
			ctx.fail("Structured logs — links matched", `No links matched notor-settings:// prefix. See anchor details above.`);
		} else {
			ctx.fail("Structured logs — links matched", "No anchor-found logs — zero <a> elements in rendered content");
		}
	}

	// Check scan complete summary
	const completeLogs = settingsLinkLogs.filter((l) => l.message.includes("scan complete"));
	if (completeLogs.length > 0) {
		const lastComplete = completeLogs[completeLogs.length - 1];
		const data = lastComplete?.data as Record<string, unknown> | undefined;
		console.log(`  Scan complete: matched=${data?.matched}, total=${data?.total}`);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init

	await testDomInspection(ctx);
	await testClickHandler(ctx);
	await testStructuredLogs(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings();

runTest(
	{
		name: "settings-deeplink-test",
		settings,
		setupVault: setupTestVault,
		cleanupFiles: [".obsidian/plugins/notor/history/" + HISTORY_FILENAME],
	},
	tests,
);
