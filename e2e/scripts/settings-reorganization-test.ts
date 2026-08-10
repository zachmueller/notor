#!/usr/bin/env npx tsx
/**
 * Settings Reorganization E2E Test
 *
 * Validates the Phase 8 settings reorganization: new section layout,
 * tool row icons (open-file + gear), ToolSettingsModal, shared settings
 * in Tools section, user automations in Automation section, file
 * attachments in Conversation section, and removal of old sections.
 *
 * Scenarios:
 *   1.  Section layout — correct groups exist, old ones removed
 *   2.  Conversation section — includes file attachments
 *   3.  Tools section — includes shared settings and reload extensions
 *   4.  Automation section — includes user automations
 *   5.  Built-in tool rows — have open-file icon
 *   6.  Built-in tool rows — gear icon on configurable tools
 *   7.  Gear icon absent on non-configurable tools (placeholder present)
 *   8.  ToolSettingsModal opens for execute_command with shell config
 *   9.  ToolSettingsModal — shared settings note and Done button
 *   10. ToolSettingsModal — close via Done button refreshes settings
 *   11. User tool rows — have open-file and conditional gear icons
 *   12. MCP tool rows — no open-file or gear icons
 *   13. Copy tool config YAML button present
 *   14. Persisted collapsed state migration — no errors from removed keys
 *   15. No unexpected error-level logs
 *
 * @see specs/ZZ-misc/settings-reorganization-design.md
 * @see specs/ZZ-misc/settings-reorganization-tasks.md — Phase 9
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	closeSettings,
	openPluginSettings,
	waitForSelector,
	VAULT_PATH,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

/**
 * Expected settings groups in order.
 *
 * "Provider setup" was later split into "Providers" + "Models" — see the
 * persisted-state rename in `src/settings/settings-tab.ts`.
 */
const EXPECTED_GROUPS = [
	"General",
	"Providers",
	"Models",
	"Conversation",
	"Personas",
	"Sub-agents",
	"Rules and workflows",
	"Tools",
	"MCP servers",
	"Automation",
	"Storage",
	"Reference",
];

/** Groups that should NOT exist after reorganization. */
const REMOVED_GROUPS = ["Tool configuration", "Extensions", "Provider setup"];

// ---------------------------------------------------------------------------
// Fixture content — user tool + automation + shared settings
// ---------------------------------------------------------------------------

const USER_TOOL_WITH_SETTINGS_MD = `---
notor-type: tool
notor-tool-name: e2e_settings_test_tool
notor-description: "A test tool with settings for settings reorganization e2e"
notor-mode: read
---

# Settings Test Tool

\`\`\`yaml
params:
  query:
    type: string
    description: "Input query"
settings:
  max_items:
    name: "Max items"
    type: number
    description: "Maximum items to return"
    default: 5
\`\`\`

\`\`\`js
return "Settings test: " + params.query;
\`\`\`
`;

const USER_TOOL_NO_SETTINGS_MD = `---
notor-type: tool
notor-tool-name: e2e_plain_tool
notor-description: "A test tool without settings"
notor-mode: read
---

# Plain Tool

\`\`\`yaml
params:
  input:
    type: string
    description: "Some input"
\`\`\`

\`\`\`js
return "Plain: " + params.input;
\`\`\`
`;

const TEST_AUTOMATION_MD = `---
notor-type: automation
notor-trigger: after_completion
notor-display-name: "E2E Reorg Automation"
notor-automation-order: 1
---

# Reorg Test Automation

\`\`\`js
const log = utils.logger("e2e-reorg-automation");
log.info("E2E reorg automation fired");
\`\`\`
`;

const SHARED_SETTINGS_MD = `---
notor-type: settings
---

# Shared Extension Settings

\`\`\`yaml
settings:
  domain_denylist:
    name: "Domain denylist"
    type: string[]
    description: "Domains to block"
    default: []
  read_file_allowed_paths:
    name: "Allowed paths"
    type: string[]
    description: "Paths allowed for read_file"
    default: []
\`\`\`
`;

// ---------------------------------------------------------------------------
// Vault setup
// ---------------------------------------------------------------------------

function setupTestVault(vaultPath: string): void {
	console.log("  Setting up settings reorganization test fixtures...");
	const toolsDir = path.join(vaultPath, "notor", "tools");
	const automationsDir = path.join(vaultPath, "notor", "automations");
	if (fs.existsSync(toolsDir)) fs.rmSync(toolsDir, { recursive: true, force: true });
	if (fs.existsSync(automationsDir)) fs.rmSync(automationsDir, { recursive: true, force: true });
	fs.mkdirSync(toolsDir, { recursive: true });
	fs.mkdirSync(automationsDir, { recursive: true });

	fs.writeFileSync(path.join(toolsDir, "settings-test-tool.md"), USER_TOOL_WITH_SETTINGS_MD);
	fs.writeFileSync(path.join(toolsDir, "plain-tool.md"), USER_TOOL_NO_SETTINGS_MD);
	fs.writeFileSync(path.join(automationsDir, "reorg-automation.md"), TEST_AUTOMATION_MD);
	fs.writeFileSync(path.join(vaultPath, "notor", "settings.md"), SHARED_SETTINGS_MD);

	console.log("    - notor/tools/settings-test-tool.md (tool with settings)");
	console.log("    - notor/tools/plain-tool.md (tool without settings)");
	console.log("    - notor/automations/reorg-automation.md");
	console.log("    - notor/settings.md (shared settings)");
}

// ---------------------------------------------------------------------------
// Settings panel helpers
// ---------------------------------------------------------------------------

/**
 * Open Obsidian settings and navigate to the Notor plugin tab.
 * Returns true if the settings panel was opened successfully.
 */
async function openNotorSettings(page: Page): Promise<boolean> {
	const tabId = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return (plugin?._settingTab?.id as string | undefined) ?? "notor";
	});
	return openPluginSettings(page, tabId);
}

/**
 * Get all settings group titles from the Notor settings tab.
 */
async function getSettingsGroupTitles(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const groups = document.querySelectorAll("details[data-notor-group]");
		return Array.from(groups).map((g) => g.getAttribute("data-notor-group") ?? "");
	});
}

/**
 * Expand a specific settings group by title.
 */
async function expandGroup(page: Page, title: string): Promise<boolean> {
	return page.evaluate((t) => {
		const group = document.querySelector(`details[data-notor-group="${CSS.escape(t)}"]`) as HTMLDetailsElement | null;
		if (!group) return false;
		group.open = true;
		return true;
	}, title);
}

/**
 * Get all heading texts within a settings group.
 */
async function getGroupHeadings(page: Page, groupTitle: string): Promise<string[]> {
	return page.evaluate((t) => {
		const group = document.querySelector(`details[data-notor-group="${CSS.escape(t)}"]`);
		if (!group) return [];
		const body = group.querySelector(".notor-settings-group-body");
		if (!body) return [];
		// Obsidian Setting headings render as .setting-item.setting-item-heading .setting-item-name
		const headings = body.querySelectorAll(".setting-item-heading .setting-item-name");
		return Array.from(headings).map((h) => h.textContent?.trim() ?? "");
	}, groupTitle);
}

/**
 * Get the names of all setting items within a group (non-heading).
 */
async function getGroupSettingNames(page: Page, groupTitle: string): Promise<string[]> {
	return page.evaluate((t) => {
		const group = document.querySelector(`details[data-notor-group="${CSS.escape(t)}"]`);
		if (!group) return [];
		const body = group.querySelector(".notor-settings-group-body");
		if (!body) return [];
		const items = body.querySelectorAll(".setting-item:not(.setting-item-heading) .setting-item-name");
		return Array.from(items).map((n) => n.textContent?.trim() ?? "");
	}, groupTitle);
}

/**
 * Count tool rows with specific extra button icons in the Tools section.
 */
async function countToolRowIcons(page: Page): Promise<{
	openFileIcons: number;
	gearIcons: number;
	placeholders: number;
	totalToolRows: number;
}> {
	return page.evaluate(() => {
		const toolsSection = document.querySelector('details[data-notor-group="Tools"]');
		if (!toolsSection) return { openFileIcons: 0, gearIcons: 0, placeholders: 0, totalToolRows: 0 };
		const body = toolsSection.querySelector(".notor-settings-group-body");
		if (!body) return { openFileIcons: 0, gearIcons: 0, placeholders: 0, totalToolRows: 0 };

		// Tool rows are .setting-item elements that have toggle controls (not headings, not buttons-only)
		const allItems = body.querySelectorAll(".notor-tools-section .setting-item");
		let openFileIcons = 0;
		let gearIcons = 0;
		let placeholders = 0;
		let totalToolRows = 0;

		for (const item of Array.from(allItems)) {
			// A tool row has at least one toggle
			const toggles = item.querySelectorAll(".checkbox-container");
			if (toggles.length === 0) continue;
			totalToolRows++;

			// Count extra buttons with specific icons
			const extraBtns = item.querySelectorAll(".extra-setting-button");
			for (const btn of Array.from(extraBtns)) {
				const svg = btn.querySelector("svg");
				if (!svg) continue;
				// Check icon by the lucide class or the use href
				const cls = btn.className;
				if (cls.includes("notor-tool-icon-placeholder")) {
					placeholders++;
				} else {
					// Check tooltip
					const tooltip = btn.getAttribute("aria-label") ?? "";
					if (tooltip.includes("Open tool definition")) openFileIcons++;
					else if (tooltip.includes("Configure tool settings")) gearIcons++;
				}
			}
		}

		return { openFileIcons, gearIcons, placeholders, totalToolRows };
	});
}

/**
 * Click the gear icon for a specific tool by name.
 */
async function clickGearIcon(page: Page, toolDisplayName: string): Promise<boolean> {
	return page.evaluate((name) => {
		const toolsSection = document.querySelector('details[data-notor-group="Tools"]');
		if (!toolsSection) return false;
		const items = toolsSection.querySelectorAll(".setting-item");
		for (const item of Array.from(items)) {
			const nameEl = item.querySelector(".setting-item-name");
			if (nameEl?.textContent?.trim() === name) {
				const gearBtn = Array.from(item.querySelectorAll(".extra-setting-button"))
					.find((btn) => btn.getAttribute("aria-label")?.includes("Configure tool settings"));
				if (gearBtn) {
					(gearBtn as HTMLElement).click();
					return true;
				}
			}
		}
		return false;
	}, toolDisplayName);
}

/**
 * Get information about the currently open modal.
 */
async function getModalInfo(page: Page): Promise<{
	isOpen: boolean;
	title: string;
	headings: string[];
	settingNames: string[];
	hasSharedSettingsNote: boolean;
	hasDoneButton: boolean;
} | null> {
	return page.evaluate(() => {
		// Exclude `.mod-settings`: the settings modal now renders inline in the same
		// `.modal-container`, so a bare `.modal` match would return it, not the
		// tool-settings modal the gear icon opened.
		const modal = document.querySelector(".modal-container .modal:not(.mod-settings)");
		if (!modal) return { isOpen: false, title: "", headings: [], settingNames: [], hasSharedSettingsNote: false, hasDoneButton: false };

		const content = modal.querySelector(".modal-content");
		if (!content) return { isOpen: false, title: "", headings: [], settingNames: [], hasSharedSettingsNote: false, hasDoneButton: false };

		const title = content.querySelector("h2")?.textContent?.trim() ?? "";
		const headings = Array.from(content.querySelectorAll(".setting-item-heading .setting-item-name"))
			.map((h) => h.textContent?.trim() ?? "");
		const settingNames = Array.from(content.querySelectorAll(".setting-item:not(.setting-item-heading) .setting-item-name"))
			.map((n) => n.textContent?.trim() ?? "");
		const allText = content.textContent ?? "";
		const hasSharedSettingsNote = allText.includes("shared settings");
		const hasDoneButton = Array.from(content.querySelectorAll("button"))
			.some((b) => b.textContent?.trim() === "Done");

		return { isOpen: true, title, headings, settingNames, hasSharedSettingsNote, hasDoneButton };
	});
}

/**
 * Close the currently open modal via the Done button.
 */
async function closeModalViaDone(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		// Exclude `.mod-settings`: the settings modal now renders inline in the same
		// `.modal-container`, so a bare `.modal` match would return it, not the
		// tool-settings modal the gear icon opened.
		const modal = document.querySelector(".modal-container .modal:not(.mod-settings)");
		if (!modal) return false;
		const buttons = modal.querySelectorAll("button");
		for (const btn of Array.from(buttons)) {
			if (btn.textContent?.trim() === "Done") {
				btn.click();
				return true;
			}
		}
		return false;
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSectionLayout(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Section layout — correct groups exist, old ones removed");
	const { page } = ctx;

	const opened = await openNotorSettings(page);
	if (!opened) {
		const shot = await ctx.screenshot("01-settings-open-failed");
		ctx.fail("Section layout — open settings", "Could not open Notor settings tab", shot);
		return;
	}
	await page.waitForTimeout(2_000);

	const groups = await getSettingsGroupTitles(page);
	const shot = await ctx.screenshot("01-section-layout");

	// Check expected groups exist in order
	const allPresent = EXPECTED_GROUPS.every((g) => groups.includes(g));
	const correctOrder = EXPECTED_GROUPS.every((g, i) => {
		const idx = groups.indexOf(g);
		return i === 0 || idx > groups.indexOf(EXPECTED_GROUPS[i - 1]!);
	});

	if (!allPresent) {
		const missing = EXPECTED_GROUPS.filter((g) => !groups.includes(g));
		ctx.fail("Section layout — expected groups", `Missing groups: [${missing.join(", ")}]. Found: [${groups.join(", ")}]`, shot);
	} else if (!correctOrder) {
		ctx.fail("Section layout — group order", `Groups present but in wrong order. Found: [${groups.join(", ")}]`, shot);
	} else {
		ctx.pass("Section layout — expected groups", `All ${EXPECTED_GROUPS.length} groups present in correct order`, shot);
	}

	// Check removed groups do NOT exist
	const removedPresent = REMOVED_GROUPS.filter((g) => groups.includes(g));
	if (removedPresent.length > 0) {
		ctx.fail("Section layout — removed groups", `Old groups still present: [${removedPresent.join(", ")}]`, shot);
	} else {
		ctx.pass("Section layout — removed groups", `"Tool configuration" and "Extensions" correctly removed`);
	}
}

async function testConversationFileAttachments(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Conversation section — includes file attachments");
	const { page } = ctx;

	await expandGroup(page, "Conversation");
	await page.waitForTimeout(500);

	const headings = await getGroupHeadings(page, "Conversation");
	const shot = await ctx.screenshot("02-conversation-file-attachments");

	if (headings.includes("File attachments")) {
		ctx.pass("Conversation — file attachments", `Found "File attachments" heading in Conversation. Headings: [${headings.join(", ")}]`, shot);
	} else {
		ctx.fail("Conversation — file attachments", `"File attachments" heading not found in Conversation. Headings: [${headings.join(", ")}]`, shot);
	}

	// Verify the specific setting exists
	const names = await getGroupSettingNames(page, "Conversation");
	const hasThreshold = names.some((n) => n.includes("External file size threshold"));
	if (hasThreshold) {
		ctx.pass("Conversation — threshold setting", "External file size threshold setting found in Conversation");
	} else {
		ctx.fail("Conversation — threshold setting", `Setting not found. Names: [${names.join(", ")}]`, shot);
	}
}

async function testToolsSharedSettingsAndReload(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Tools section — includes shared settings and reload extensions");
	const { page } = ctx;

	await expandGroup(page, "Tools");
	await page.waitForTimeout(500);

	const headings = await getGroupHeadings(page, "Tools");
	const shot = await ctx.screenshot("03-tools-shared-settings");

	const hasSharedSettings = headings.includes("Shared settings");
	if (hasSharedSettings) {
		ctx.pass("Tools — shared settings heading", `Found "Shared settings" heading in Tools`, shot);
	} else {
		ctx.fail("Tools — shared settings heading", `"Shared settings" heading not found. Headings: [${headings.join(", ")}]`, shot);
	}

	// Check reload extensions button
	const names = await getGroupSettingNames(page, "Tools");
	const hasReload = names.some((n) => n.includes("Reload extensions"));
	if (hasReload) {
		ctx.pass("Tools — reload button", "Reload extensions button found in Tools section");
	} else {
		ctx.fail("Tools — reload button", `"Reload extensions" not found. Setting names: [${names.join(", ")}]`, shot);
	}
}

async function testAutomationUserAutomations(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Automation section — grouped by trigger type with automations listed");
	const { page } = ctx;

	await expandGroup(page, "Automation");
	await page.waitForTimeout(500);

	const headings = await getGroupHeadings(page, "Automation");
	const shot = await ctx.screenshot("04-automation-user-automations");

	// The unified Automation section groups items by trigger type.
	// Our test automation has trigger "after_completion" → "After completion" group.
	const hasAfterCompletion = headings.includes("After completion");
	if (hasAfterCompletion) {
		ctx.pass("Automation — trigger group heading", `Found "After completion" trigger group in Automation section`, shot);
	} else {
		ctx.fail("Automation — trigger group heading", `"After completion" not found. Headings: [${headings.join(", ")}]`, shot);
	}

	// Check that our test automation is listed
	const names = await getGroupSettingNames(page, "Automation");
	const hasReorgAutomation = names.some((n) => n.includes("E2E Reorg Automation"));
	if (hasReorgAutomation) {
		ctx.pass("Automation — test automation listed", "E2E Reorg Automation found in Automation section");
	} else {
		ctx.fail("Automation — test automation listed", `Test automation not found. Names: [${names.join(", ")}]`, shot);
	}
}

async function testBuiltinToolOpenFileIcons(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Built-in tool rows — have open-file icons");
	const { page } = ctx;

	await expandGroup(page, "Tools");
	await page.waitForTimeout(500);

	const iconCounts = await countToolRowIcons(page);
	const shot = await ctx.screenshot("05-tool-row-icons");

	// Every built-in and user tool row should have an open-file icon
	// (MCP tools don't, but we have no MCP servers configured)
	if (iconCounts.openFileIcons > 0) {
		ctx.pass(
			"Built-in tools — open-file icons",
			`Found ${iconCounts.openFileIcons} open-file icons across ${iconCounts.totalToolRows} tool rows`,
			shot,
		);
	} else {
		ctx.fail(
			"Built-in tools — open-file icons",
			`No open-file icons found. Total rows: ${iconCounts.totalToolRows}`,
			shot,
		);
	}
}

async function testBuiltinToolGearIcons(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: Built-in tool rows — gear icon on configurable tools");
	const { page } = ctx;

	const iconCounts = await countToolRowIcons(page);
	const shot = await ctx.screenshot("06-gear-icons");

	// At minimum execute_command should have a gear icon, plus any tools with settingsSchema
	if (iconCounts.gearIcons > 0) {
		ctx.pass(
			"Built-in tools — gear icons",
			`Found ${iconCounts.gearIcons} gear icons (configurable tools) and ${iconCounts.placeholders} placeholders`,
			shot,
		);
	} else {
		ctx.fail(
			"Built-in tools — gear icons",
			`No gear icons found. Total rows: ${iconCounts.totalToolRows}, placeholders: ${iconCounts.placeholders}`,
			shot,
		);
	}
}

async function testGearIconPlaceholders(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: Non-configurable tools — invisible placeholder instead of gear");
	const { page } = ctx;

	const iconCounts = await countToolRowIcons(page);
	const shot = await ctx.screenshot("07-gear-placeholders");

	// There should be some tools without config that have placeholders for alignment
	if (iconCounts.placeholders > 0) {
		ctx.pass(
			"Non-configurable — placeholders",
			`Found ${iconCounts.placeholders} placeholder(s) for column alignment`,
			shot,
		);
	} else if (iconCounts.gearIcons === iconCounts.totalToolRows) {
		// All tools have gear icons — that's valid if all have settings
		ctx.pass(
			"Non-configurable — placeholders",
			"All tool rows have gear icons (no placeholders needed)",
			shot,
		);
	} else {
		ctx.fail(
			"Non-configurable — placeholders",
			`Expected placeholders for non-configurable tools. gear=${iconCounts.gearIcons}, total=${iconCounts.totalToolRows}`,
			shot,
		);
	}
}

async function testModalExecuteCommand(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: ToolSettingsModal opens for execute_command with shell config");
	const { page } = ctx;

	const clicked = await clickGearIcon(page, "Execute command");
	if (!clicked) {
		const shot = await ctx.screenshot("08-gear-click-failed");
		ctx.fail("Modal — execute_command", "Could not find/click gear icon for Execute command", shot);
		return;
	}

	await page.waitForTimeout(1_000);
	const modalInfo = await getModalInfo(page);
	const shot = await ctx.screenshot("08-modal-execute-command");

	if (!modalInfo?.isOpen) {
		ctx.fail("Modal — execute_command opens", "Modal did not open after clicking gear icon", shot);
		return;
	}

	// Check modal title is the tool name
	if (modalInfo.title === "execute_command") {
		ctx.pass("Modal — title", `Modal title is "${modalInfo.title}"`, shot);
	} else {
		ctx.fail("Modal — title", `Expected "execute_command", got "${modalInfo.title}"`, shot);
	}

	// Check shell configuration heading
	const hasShellConfig = modalInfo.headings.includes("Shell configuration");
	if (hasShellConfig) {
		ctx.pass("Modal — shell config heading", `Found "Shell configuration" heading in modal`, shot);
	} else {
		ctx.fail("Modal — shell config heading", `"Shell configuration" not found. Headings: [${modalInfo.headings.join(", ")}]`, shot);
	}

	// Check shell executable and shell arguments settings
	const hasShellExe = modalInfo.settingNames.some((n) => n.includes("Shell executable"));
	const hasShellArgs = modalInfo.settingNames.some((n) => n.includes("Shell arguments"));
	if (hasShellExe && hasShellArgs) {
		ctx.pass("Modal — shell fields", "Shell executable and Shell arguments fields present");
	} else {
		ctx.fail("Modal — shell fields", `exe=${hasShellExe}, args=${hasShellArgs}. Names: [${modalInfo.settingNames.join(", ")}]`, shot);
	}
}

async function testModalSharedNoteAndDone(ctx: TestContext): Promise<void> {
	console.log("\nTest 9: ToolSettingsModal — shared settings note and Done button");
	const { page } = ctx;

	// Modal should still be open from test 8
	const modalInfo = await getModalInfo(page);
	const shot = await ctx.screenshot("09-modal-shared-done");

	if (!modalInfo?.isOpen) {
		ctx.fail("Modal — shared & done", "Modal not open", shot);
		return;
	}

	if (modalInfo.hasSharedSettingsNote) {
		ctx.pass("Modal — shared settings note", "Shared settings note found in modal", shot);
	} else {
		ctx.fail("Modal — shared settings note", "Shared settings note not found in modal", shot);
	}

	if (modalInfo.hasDoneButton) {
		ctx.pass("Modal — Done button", "Done button found in modal", shot);
	} else {
		ctx.fail("Modal — Done button", "Done button not found in modal", shot);
	}
}

async function testModalCloseRefreshes(ctx: TestContext): Promise<void> {
	console.log("\nTest 10: ToolSettingsModal — close via Done refreshes settings");
	const { page } = ctx;

	// Close modal via Done
	const closed = await closeModalViaDone(page);
	if (!closed) {
		const shot = await ctx.screenshot("10-close-failed");
		ctx.fail("Modal — close via Done", "Could not click Done button", shot);
		return;
	}

	await page.waitForTimeout(1_000);

	// Verify modal is closed
	const modalInfo = await getModalInfo(page);
	const shot = await ctx.screenshot("10-modal-closed");

	if (!modalInfo?.isOpen) {
		ctx.pass("Modal — close via Done", "Modal closed successfully after clicking Done", shot);
	} else {
		ctx.fail("Modal — close via Done", "Modal still open after clicking Done", shot);
	}

	// Verify settings tab is still rendered (redisplay happened)
	const groups = await getSettingsGroupTitles(page);
	if (groups.includes("Tools")) {
		ctx.pass("Modal — settings refreshed", "Settings tab re-rendered after modal close (Tools group present)");
	} else {
		ctx.fail("Modal — settings refreshed", `Settings tab may not have re-rendered. Groups: [${groups.join(", ")}]`, shot);
	}
}

async function testUserToolIcons(ctx: TestContext): Promise<void> {
	console.log("\nTest 11: User tool rows — open-file and conditional gear icons");
	const { page } = ctx;

	await expandGroup(page, "Tools");
	await page.waitForTimeout(500);

	// Check for our specific user tools
	const result = await page.evaluate(() => {
		const toolsSection = document.querySelector('details[data-notor-group="Tools"]');
		if (!toolsSection) return null;

		const items = toolsSection.querySelectorAll(".setting-item");
		const report: Record<string, { hasOpenFile: boolean; hasGear: boolean }> = {};

		for (const item of Array.from(items)) {
			const nameEl = item.querySelector(".setting-item-name");
			const name = nameEl?.textContent?.trim() ?? "";

			if (name === "e2e_settings_test_tool" || name === "e2e_plain_tool") {
				const extraBtns = item.querySelectorAll(".extra-setting-button");
				let hasOpenFile = false;
				let hasGear = false;

				for (const btn of Array.from(extraBtns)) {
					const tooltip = btn.getAttribute("aria-label") ?? "";
					if (tooltip.includes("Open tool definition")) hasOpenFile = true;
					if (tooltip.includes("Configure tool settings")) hasGear = true;
				}

				report[name] = { hasOpenFile, hasGear };
			}
		}

		return report;
	});

	const shot = await ctx.screenshot("11-user-tool-icons");

	if (!result) {
		ctx.fail("User tools — icons", "Could not inspect Tools section", shot);
		return;
	}

	const toolWithSettings = result["e2e_settings_test_tool"];
	const toolNoSettings = result["e2e_plain_tool"];

	if (!toolWithSettings) {
		ctx.fail("User tools — tool with settings", "e2e_settings_test_tool not found in Tools section", shot);
	} else {
		const ok = toolWithSettings.hasOpenFile && toolWithSettings.hasGear;
		if (ok) {
			ctx.pass("User tools — tool with settings", "e2e_settings_test_tool has open-file and gear icons", shot);
		} else {
			ctx.fail("User tools — tool with settings", `openFile=${toolWithSettings.hasOpenFile}, gear=${toolWithSettings.hasGear}`, shot);
		}
	}

	if (!toolNoSettings) {
		ctx.fail("User tools — tool no settings", "e2e_plain_tool not found in Tools section", shot);
	} else {
		const ok = toolNoSettings.hasOpenFile && !toolNoSettings.hasGear;
		if (ok) {
			ctx.pass("User tools — tool no settings", "e2e_plain_tool has open-file icon but no gear (correct)", shot);
		} else {
			ctx.fail("User tools — tool no settings", `openFile=${toolNoSettings.hasOpenFile}, gear=${toolNoSettings.hasGear}`, shot);
		}
	}
}

async function testMcpToolsNoIcons(ctx: TestContext): Promise<void> {
	console.log("\nTest 12: MCP tool rows — no open-file or gear icons (no MCP configured)");
	const { page } = ctx;

	// We don't have MCP servers configured, so we verify MCP tools heading doesn't appear
	// or that there are no MCP tool rows with icons
	const headings = await getGroupHeadings(page, "Tools");
	const shot = await ctx.screenshot("12-mcp-tools");

	const hasMcpHeading = headings.includes("MCP tools");
	if (!hasMcpHeading) {
		ctx.pass(
			"MCP tools — no icons",
			"No MCP tools heading (no servers configured) — no icons to verify",
			shot,
		);
	} else {
		// If MCP tools exist, verify they don't have open-file or gear icons
		const mcpResult = await page.evaluate(() => {
			const toolsSection = document.querySelector('details[data-notor-group="Tools"]');
			if (!toolsSection) return { total: 0, withOpenFile: 0, withGear: 0 };

			// MCP tools are in .notor-tool-mcp-server-header sections
			const mcpHeaders = toolsSection.querySelectorAll(".notor-tool-mcp-server-header");
			if (mcpHeaders.length === 0) return { total: 0, withOpenFile: 0, withGear: 0 };

			// Find items after the MCP heading that have dropdowns (MCP tools have classification dropdowns)
			const items = toolsSection.querySelectorAll(".setting-item");
			let total = 0;
			let withOpenFile = 0;
			let withGear = 0;

			for (const item of Array.from(items)) {
				const hasDropdown = item.querySelector("select") !== null;
				if (!hasDropdown) continue;
				total++;

				const extraBtns = item.querySelectorAll(".extra-setting-button");
				for (const btn of Array.from(extraBtns)) {
					const tooltip = btn.getAttribute("aria-label") ?? "";
					if (tooltip.includes("Open tool definition")) withOpenFile++;
					if (tooltip.includes("Configure tool settings")) withGear++;
				}
			}

			return { total, withOpenFile, withGear };
		});

		if (mcpResult.withOpenFile === 0 && mcpResult.withGear === 0) {
			ctx.pass(
				"MCP tools — no icons",
				`${mcpResult.total} MCP tool rows: no open-file or gear icons (correct)`,
				shot,
			);
		} else {
			ctx.fail(
				"MCP tools — no icons",
				`MCP tools have unexpected icons. open-file=${mcpResult.withOpenFile}, gear=${mcpResult.withGear}`,
				shot,
			);
		}
	}
}

async function testCopyToolConfigButton(ctx: TestContext): Promise<void> {
	console.log("\nTest 13: Copy tool config YAML button present");
	const { page } = ctx;

	const names = await getGroupSettingNames(page, "Tools");
	const shot = await ctx.screenshot("13-copy-tool-config");

	const hasCopy = names.some((n) => n.includes("Copy tool config YAML"));
	if (hasCopy) {
		ctx.pass("Copy tool config YAML", "Button found in Tools section", shot);
	} else {
		ctx.fail("Copy tool config YAML", `Not found. Setting names: [${names.join(", ")}]`, shot);
	}
}

async function testPersistedStateMigration(ctx: TestContext): Promise<void> {
	console.log("\nTest 14: Persisted collapsed state — no errors from removed section keys");
	const { page } = ctx;

	// Verify that the plugin settings don't contain the old section keys
	const migrated = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin?.settings?.settings_collapsed_sections) return null;
		const sections = plugin.settings.settings_collapsed_sections;
		return {
			hasToolConfig: "Tool configuration" in sections,
			hasExtensions: "Extensions" in sections,
			hasTools: "Tools" in sections,
			keys: Object.keys(sections),
		};
	});

	const shot = await ctx.screenshot("14-persisted-state");

	if (!migrated) {
		ctx.fail("Persisted state migration", "Could not read settings_collapsed_sections", shot);
		return;
	}

	if (!migrated.hasToolConfig && !migrated.hasExtensions) {
		ctx.pass(
			"Persisted state migration",
			`Old keys removed. Current keys: [${migrated.keys.join(", ")}]`,
			shot,
		);
	} else {
		ctx.fail(
			"Persisted state migration",
			`Old keys still present: Tool configuration=${migrated.hasToolConfig}, Extensions=${migrated.hasExtensions}`,
			shot,
		);
	}
}

async function testNoUnexpectedErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 15: No unexpected error-level logs");
	const { collector } = ctx;

	const errors = collector.getLogsByLevel("error").filter((entry) => {
		const text = `${entry.message} ${JSON.stringify(entry.data ?? {})}`;
		// Exclude expected errors
		const isExpected =
			text.includes("page-error") ||
			text.includes("net::ERR") ||
			text.includes("Failed to fetch");
		return !isExpected;
	});

	const shot = await ctx.screenshot("15-no-errors");

	if (errors.length === 0) {
		ctx.pass("No unexpected errors", "Zero unexpected error-level logs", shot);
	} else {
		ctx.fail(
			"No unexpected errors",
			`${errors.length} unexpected error(s): ${errors.map((e) => `[${e.source}] ${e.message}`).join("; ").substring(0, 300)}`,
			shot,
		);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(8_000); // Wait for plugin init + extension discovery

	// Test 1: Section layout
	await testSectionLayout(ctx);

	// Test 2: Conversation includes file attachments
	await testConversationFileAttachments(ctx);

	// Test 3: Tools includes shared settings + reload
	await testToolsSharedSettingsAndReload(ctx);

	// Test 4: Automation includes user automations
	await testAutomationUserAutomations(ctx);

	// Test 5-7: Tool row icons
	await testBuiltinToolOpenFileIcons(ctx);
	await testBuiltinToolGearIcons(ctx);
	await testGearIconPlaceholders(ctx);

	// Test 8-10: ToolSettingsModal
	await testModalExecuteCommand(ctx);
	await testModalSharedNoteAndDone(ctx);
	await testModalCloseRefreshes(ctx);

	// Test 11: User tool icons
	await testUserToolIcons(ctx);

	// Test 12: MCP tools no icons
	await testMcpToolsNoIcons(ctx);

	// Test 13: Copy tool config YAML
	await testCopyToolConfigButton(ctx);

	// Test 14: Persisted state migration
	await testPersistedStateMigration(ctx);

	// Close settings panel
	await closeSettings(page);

	// Test 15: No unexpected errors (last)
	await testNoUnexpectedErrors(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	// Pre-populate removed section keys to test migration
	settings_collapsed_sections: {
		"Tool configuration": false,
		"Extensions": false,
	},
	user_extension_settings: {},
	user_shared_settings: {},
});

runTest(
	{
		name: "settings-reorganization",
		settings,
		setupVault: setupTestVault,
		cleanupFiles: [
			"notor/tools/settings-test-tool.md",
			"notor/tools/plain-tool.md",
			"notor/automations/reorg-automation.md",
			"notor/settings.md",
		],
	},
	tests,
);
