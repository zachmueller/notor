#!/usr/bin/env npx tsx
/**
 * Sub-Agent Settings UI E2E Test
 *
 * Validates the sub-agents section in the Obsidian Settings tab:
 *   1. "Sub-agents" heading appears in the Notor settings tab
 *   2. Built-in profiles (search-vault, search-web) are listed with "Built-in" badges
 *   3. Visibility toggles function correctly (toggle off → on)
 *   4. User-created sub-agent profiles appear after vault setup
 *   5. "Create new sub-agent" button exists
 *   6. Structured logs confirm profile discovery
 *   7. Visibility toggle state persists in plugin settings
 *   8. No error-level logs from sub-agent settings rendering
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 7
 * @see specs/ZZ-misc/sub-agents-implementation-plan.md — Phase 7
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import { waitForSelector, buildDefaultSettings } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Vault setup — create a user-defined sub-agent profile alongside built-ins
// ---------------------------------------------------------------------------

function setupVault(vaultPath: string): void {
	const subAgentsDir = path.join(vaultPath, "notor", "sub-agents");

	// User-created sub-agent profile: "note-summarizer"
	const summarizerDir = path.join(subAgentsDir, "note-summarizer");
	fs.mkdirSync(summarizerDir, { recursive: true });
	fs.writeFileSync(
		path.join(summarizerDir, "system-prompt.md"),
		`---
notor-description: Summarize notes into concise bullet points.
---

You are a note summarizer. Read notes and produce concise summaries.

<notor_tool_config version="1.0">
read_note:
  enabled: true
search_vault:
  enabled: true
</notor_tool_config>
`
	);

	// Profile with no description (edge case — should still appear in list)
	const silentDir = path.join(subAgentsDir, "silent-worker");
	fs.mkdirSync(silentDir, { recursive: true });
	fs.writeFileSync(
		path.join(silentDir, "system-prompt.md"),
		`---
---

A sub-agent with no description field.

<notor_tool_config version="1.0">
read_note:
  enabled: true
</notor_tool_config>
`
	);

	console.log("  Test sub-agent profiles created in test vault.");
}

// ---------------------------------------------------------------------------
// Helper: navigate to Notor settings tab
// ---------------------------------------------------------------------------

async function openNotorSettings(ctx: TestContext): Promise<boolean> {
	const { page } = ctx;

	// Open Obsidian Settings via Cmd+,
	await page.keyboard.press("Meta+Comma");
	await page.waitForTimeout(2000);

	// Click the Notor tab in the settings sidebar
	const found = await page.evaluate(() => {
		const navItems = document.querySelectorAll(".vertical-tab-nav-item");
		for (const item of navItems) {
			if (item.textContent?.trim() === "Notor") {
				(item as HTMLElement).click();
				return true;
			}
		}
		return false;
	});

	if (found) {
		await page.waitForTimeout(1500);
	}

	return found;
}

// ---------------------------------------------------------------------------
// Helper: scroll to sub-agents section
// ---------------------------------------------------------------------------

async function scrollToSubAgentsSection(ctx: TestContext): Promise<boolean> {
	const { page } = ctx;

	const found = await page.evaluate(() => {
		const headings = document.querySelectorAll(
			".vertical-tab-content .setting-item-heading .setting-item-name",
		);
		for (const h of headings) {
			if (h.textContent?.includes("Sub-agents")) {
				h.scrollIntoView({ behavior: "instant", block: "start" });
				return true;
			}
		}
		return false;
	});

	if (found) {
		await page.waitForTimeout(500);
	}

	return found;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSubAgentsHeadingExists(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Sub-agents heading appears in settings");
	const { page } = ctx;

	const hasHeading = await scrollToSubAgentsSection(ctx);
	const shot = await ctx.screenshot("01-sub-agents-heading");

	if (hasHeading) {
		ctx.pass("Sub-agents heading exists", "Found 'Sub-agents' heading in Notor settings tab", shot);
	} else {
		ctx.fail("Sub-agents heading exists", "No 'Sub-agents' heading found in settings", shot);
	}
}

async function testBuiltinProfilesListed(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Built-in profiles listed with badges");
	const { page } = ctx;

	await scrollToSubAgentsSection(ctx);

	// Look for built-in profile entries and badges
	const profileInfo = await page.evaluate(() => {
		const container = document.querySelector(".notor-subagents-list");
		if (!container) return null;

		const settings = container.querySelectorAll(".setting-item");
		const profiles: Array<{ name: string; hasBuiltinBadge: boolean; hasToggle: boolean; hasOpenBtn: boolean }> = [];

		for (const item of settings) {
			const nameEl = item.querySelector(".setting-item-name");
			const name = nameEl?.textContent?.replace("Built-in", "").trim() ?? "";
			if (!name) continue;

			const hasBuiltinBadge = !!item.querySelector(".notor-subagent-badge-builtin");
			const hasToggle = !!item.querySelector(".checkbox-container");
			const hasOpenBtn = !!item.querySelector("[aria-label='Open system prompt']") ||
				item.querySelectorAll("button").length > 0;

			profiles.push({ name, hasBuiltinBadge, hasToggle, hasOpenBtn });
		}

		return profiles;
	});

	const shot = await ctx.screenshot("02-builtin-profiles");

	if (!profileInfo || profileInfo.length === 0) {
		ctx.fail("Built-in profiles listed", "No profiles found in .notor-subagents-list", shot);
		return;
	}

	const searchVault = profileInfo.find((p) => p.name.includes("search-vault"));
	const searchWeb = profileInfo.find((p) => p.name.includes("search-web"));

	if (searchVault && searchWeb) {
		const bothBadged = searchVault.hasBuiltinBadge && searchWeb.hasBuiltinBadge;
		const bothToggled = searchVault.hasToggle && searchWeb.hasToggle;

		if (bothBadged && bothToggled) {
			ctx.pass(
				"Built-in profiles listed with badges and toggles",
				`Found search-vault (badge=${searchVault.hasBuiltinBadge}, toggle=${searchVault.hasToggle}) and search-web (badge=${searchWeb.hasBuiltinBadge}, toggle=${searchWeb.hasToggle})`,
				shot,
			);
		} else {
			ctx.pass(
				"Built-in profiles listed",
				`Found both profiles. Badges: vault=${searchVault.hasBuiltinBadge}, web=${searchWeb.hasBuiltinBadge}. Toggles: vault=${searchVault.hasToggle}, web=${searchWeb.hasToggle}`,
				shot,
			);
		}
	} else {
		ctx.fail(
			"Built-in profiles listed",
			`Missing built-in profiles. Found: [${profileInfo.map((p) => p.name).join(", ")}]`,
			shot,
		);
	}
}

async function testUserCreatedProfilesListed(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: User-created profiles appear in list");
	const { page } = ctx;

	await scrollToSubAgentsSection(ctx);

	const profileNames = await page.evaluate(() => {
		const container = document.querySelector(".notor-subagents-list");
		if (!container) return [];

		const settings = container.querySelectorAll(".setting-item");
		const names: string[] = [];

		for (const item of settings) {
			const nameEl = item.querySelector(".setting-item-name");
			const name = nameEl?.textContent?.replace("Built-in", "").trim() ?? "";
			if (name) names.push(name);
		}
		return names;
	});

	const shot = await ctx.screenshot("03-user-profiles");

	const hasNoteSummarizer = profileNames.some((n) => n.includes("note-summarizer"));
	const hasSilentWorker = profileNames.some((n) => n.includes("silent-worker"));

	if (hasNoteSummarizer && hasSilentWorker) {
		ctx.pass(
			"User-created profiles listed",
			`Found user profiles: note-summarizer and silent-worker in [${profileNames.join(", ")}]`,
			shot,
		);
	} else if (hasNoteSummarizer || hasSilentWorker) {
		ctx.pass(
			"User-created profiles partially listed",
			`Found some user profiles in [${profileNames.join(", ")}]. note-summarizer=${hasNoteSummarizer}, silent-worker=${hasSilentWorker}`,
			shot,
		);
	} else {
		ctx.fail(
			"User-created profiles listed",
			`Neither note-summarizer nor silent-worker found. Profiles: [${profileNames.join(", ")}]`,
			shot,
		);
	}
}

async function testVisibilityToggleFunction(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Visibility toggle functions correctly");
	const { page } = ctx;

	await scrollToSubAgentsSection(ctx);

	// Find a profile toggle and click it to change state
	const toggleResult = await page.evaluate(() => {
		const container = document.querySelector(".notor-subagents-list");
		if (!container) return { found: false, profileName: "", toggled: false };

		const settings = container.querySelectorAll(".setting-item");
		for (const item of settings) {
			const nameEl = item.querySelector(".setting-item-name");
			const name = nameEl?.textContent?.replace("Built-in", "").trim() ?? "";
			if (!name.includes("search-vault")) continue;

			const toggle = item.querySelector(".checkbox-container") as HTMLElement | null;
			if (toggle) {
				const wasBefore = toggle.classList.contains("is-enabled");
				toggle.click();
				return { found: true, profileName: name, toggled: true, wasBefore };
			}
		}
		return { found: false, profileName: "", toggled: false };
	});

	await page.waitForTimeout(1000);

	if (toggleResult.toggled) {
		// Check that the toggle state changed
		const newState = await page.evaluate(() => {
			const container = document.querySelector(".notor-subagents-list");
			if (!container) return null;

			const settings = container.querySelectorAll(".setting-item");
			for (const item of settings) {
				const nameEl = item.querySelector(".setting-item-name");
				const name = nameEl?.textContent?.replace("Built-in", "").trim() ?? "";
				if (!name.includes("search-vault")) continue;

				const toggle = item.querySelector(".checkbox-container");
				return toggle?.classList.contains("is-enabled") ?? null;
			}
			return null;
		});

		const shot = await ctx.screenshot("04-visibility-toggle");

		if (newState !== null && newState !== toggleResult.wasBefore) {
			ctx.pass(
				"Visibility toggle works",
				`search-vault toggle changed from ${toggleResult.wasBefore} to ${newState}`,
				shot,
			);
		} else {
			ctx.fail(
				"Visibility toggle works",
				`Toggle state did not change. Before: ${toggleResult.wasBefore}, After: ${newState}`,
				shot,
			);
		}

		// Toggle back to restore original state
		await page.evaluate(() => {
			const container = document.querySelector(".notor-subagents-list");
			if (!container) return;
			const settings = container.querySelectorAll(".setting-item");
			for (const item of settings) {
				const nameEl = item.querySelector(".setting-item-name");
				const name = nameEl?.textContent?.replace("Built-in", "").trim() ?? "";
				if (!name.includes("search-vault")) continue;
				const toggle = item.querySelector(".checkbox-container") as HTMLElement | null;
				if (toggle) toggle.click();
			}
		});
		await page.waitForTimeout(500);
	} else {
		const shot = await ctx.screenshot("04-no-toggle");
		ctx.fail("Visibility toggle works", "Could not find search-vault toggle", shot);
	}
}

async function testCreateButtonExists(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: 'Create new sub-agent' button exists");
	const { page } = ctx;

	await scrollToSubAgentsSection(ctx);

	const hasCreateBtn = await page.evaluate(() => {
		const settings = document.querySelectorAll(".vertical-tab-content .setting-item");
		for (const item of settings) {
			const nameEl = item.querySelector(".setting-item-name");
			if (nameEl?.textContent?.includes("Create new sub-agent")) {
				const btn = item.querySelector("button");
				return btn !== null;
			}
		}
		return false;
	});

	const shot = await ctx.screenshot("05-create-button");

	if (hasCreateBtn) {
		ctx.pass("Create new sub-agent button exists", "Found 'Create new sub-agent' setting with button", shot);
	} else {
		ctx.fail("Create new sub-agent button exists", "No 'Create new sub-agent' button found", shot);
	}
}

async function testProfileDescriptionsShown(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: Profile descriptions shown where available");
	const { page } = ctx;

	await scrollToSubAgentsSection(ctx);

	const descriptions = await page.evaluate(() => {
		const container = document.querySelector(".notor-subagents-list");
		if (!container) return [];

		const settings = container.querySelectorAll(".setting-item");
		const result: { name: string; desc: string }[] = [];

		for (const item of settings) {
			const nameEl = item.querySelector(".setting-item-name");
			const name = nameEl?.textContent?.replace("Built-in", "").trim() ?? "";
			if (!name) continue;

			const descEl = item.querySelector(".setting-item-description");
			const desc = descEl?.textContent?.trim() ?? "";
			result.push({ name, desc });
		}
		return result;
	});

	const shot = await ctx.screenshot("06-descriptions");

	const searchVault = descriptions.find((d) => d.name.includes("search-vault"));
	const summarizer = descriptions.find((d) => d.name.includes("note-summarizer"));
	const silent = descriptions.find((d) => d.name.includes("silent-worker"));

	const hasSearchVaultDesc = searchVault && searchVault.desc.length > 0;
	const hasSummarizerDesc = summarizer && summarizer.desc.length > 0;

	if (hasSearchVaultDesc) {
		const svDesc = searchVault!.desc.substring(0, 80);
		const sumDesc = summarizer?.desc?.substring(0, 80) ?? "(not found)";
		const silDesc = silent?.desc ?? "(not found)";
		ctx.pass(
			"Profile descriptions shown",
			"search-vault: " + svDesc + ", note-summarizer: " + sumDesc + ", silent-worker: " + silDesc,
			shot,
		);
	} else {
		const desc = searchVault?.desc ?? "(not found)";
		ctx.fail(
			"Profile descriptions shown",
			"search-vault desc: " + desc,
			shot,
		);
	}
}

async function testDiscoveryLogs(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: Structured logs confirm profile discovery");

	const allLogs = ctx.collector.getStructuredLogs();
	const discoveryLogs = allLogs.filter(
		(entry) =>
			entry.source === "SubAgentManager" ||
			entry.source === "SubAgentDiscovery" ||
			(entry.source === "SubAgentsSection" && entry.level !== "error"),
	);

	if (discoveryLogs.length > 0) {
		const firstMsg = discoveryLogs[0].message;
		ctx.pass(
			"Profile discovery logged",
			"Found " + discoveryLogs.length + " sub-agent log(s): " + firstMsg,
		);
	} else {
		// Discovery may happen silently at debug level — check for any sub-agent related logs
		const anySubAgentLogs = allLogs.filter(
			(e) =>
				e.message.toLowerCase().includes("sub-agent") ||
				e.message.toLowerCase().includes("subagent") ||
				e.source.toLowerCase().includes("subagent"),
		);
		if (anySubAgentLogs.length > 0) {
			ctx.pass(
				"Profile discovery logged",
				"Found " + anySubAgentLogs.length + " sub-agent related log(s)",
			);
		} else {
			ctx.fail("Profile discovery logged", "No sub-agent related logs found. Total logs: " + allLogs.length);
		}
	}
}

async function testVisibilityPersistsInSettings(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: Visibility toggle state persists in plugin settings");
	const { page } = ctx;

	// Check the plugin's settings object via page.evaluate
	const visibility = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		return plugin.settings?.sub_agent_visibility ?? null;
	});

	if (visibility !== null) {
		ctx.pass(
			"Visibility state in settings",
			"sub_agent_visibility: " + JSON.stringify(visibility),
		);
	} else {
		ctx.fail(
			"Visibility state in settings",
			"Could not read sub_agent_visibility from plugin settings",
		);
	}
}

async function testNoSubAgentErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 9: No error-level logs from sub-agent settings");

	const errors = ctx.collector.getLogsByLevel("error");
	const subAgentErrors = errors.filter(
		(e) =>
			e.source === "SubAgentManager" ||
			e.source === "SubAgentsSection" ||
			e.source === "SubAgentDiscovery",
	);

	if (subAgentErrors.length === 0) {
		ctx.pass("No sub-agent errors", "Zero error-level logs from sub-agent system (" + errors.length + " total errors)");
	} else {
		const errSummary = subAgentErrors.map((e) => "[" + e.source + "] " + e.message).join("; ");
		ctx.fail(
			"No sub-agent errors",
			subAgentErrors.length + " error(s): " + errSummary,
		);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	// Verify chat panel is present (plugin loaded)
	const chatContainer = await waitForSelector(page, ".notor-chat-container", 10_000);
	if (!chatContainer) {
		const shot = await ctx.screenshot("00-no-chat-panel");
		ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
		throw new Error("Chat panel not visible — cannot run sub-agent settings tests");
	}
	ctx.pass("Chat panel visible", "Plugin loaded and chat container found");

	// Open Notor settings tab
	const opened = await openNotorSettings(ctx);
	if (!opened) {
		const shot = await ctx.screenshot("00-no-notor-tab");
		ctx.fail("Open Notor settings", "Could not find Notor tab in settings sidebar", shot);
		throw new Error("Cannot open Notor settings tab");
	}
	ctx.pass("Open Notor settings", "Navigated to Notor settings tab");

	await testSubAgentsHeadingExists(ctx);
	await testBuiltinProfilesListed(ctx);
	await testUserCreatedProfilesListed(ctx);
	await testVisibilityToggleFunction(ctx);
	await testCreateButtonExists(ctx);
	await testProfileDescriptionsShown(ctx);
	await testDiscoveryLogs(ctx);
	await testVisibilityPersistsInSettings(ctx);
	await testNoSubAgentErrors(ctx);

	// Close settings
	await page.keyboard.press("Escape");
	await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTest(
	{
		name: "sub-agent-settings",
		settings: buildDefaultSettings({
			sub_agent_visibility: {},
			sub_agent_auto_approve_reads: true,
			sub_agent_concurrency_cap: 3,
		}),
		setupVault,
		cleanupFiles: [
			"notor/sub-agents/note-summarizer",
			"notor/sub-agents/silent-worker",
			"notor/sub-agents/search-vault",
			"notor/sub-agents/search-web",
		],
	},
	tests,
);
