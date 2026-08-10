#!/usr/bin/env npx tsx
/**
 * Tool-Search Highlighting E2E Test
 *
 * Validates the tool-name search/filter UI in the Tools settings section:
 * typing a query highlights matching name substrings (`.notor-tool-search-highlight`),
 * hides non-matching rows (`.notor-hidden`), surfaces a "No tools match" message
 * for a no-match query, and the clear button resets the filter.
 *
 * Pure UI test (no live model) driven by opening the Notor settings tab,
 * expanding the Tools group, and dispatching input events on the search box.
 *
 * Scenarios:
 *   1. Typing a query highlights matching tool-name substrings and keeps matches visible
 *   2. Non-matching tool rows get `.notor-hidden`
 *   3. A no-match query reveals `.notor-tool-search-no-match` + the clear button
 *   4. Clicking the clear button resets input, highlights, no-match, and visibility
 *   5. No ToolsSection errors logged
 *
 * @see src/settings/sections/tools.ts — renderNameHighlights / applyFilter
 */

import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	expandSettingsGroup,
	openPluginSettings,
	waitForSelector,
	writeCleanWorkspace,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local helpers (test-specific only)
// ---------------------------------------------------------------------------

/** Set the search input value and dispatch the `input` event the handler listens for. */
async function typeSearch(page: Page, query: string): Promise<void> {
	await page.evaluate((q) => {
		const inp = document.querySelector<HTMLInputElement>(".notor-tools-section .notor-tool-search-input");
		if (inp) {
			inp.value = q;
			inp.dispatchEvent(new Event("input", { bubbles: true }));
		}
	}, query);
	await page.waitForTimeout(300);
}

/** Find a tool row by its display name and report its visibility within the Tools section. */
async function rowState(page: Page, displayName: string): Promise<{ found: boolean; hidden: boolean }> {
	return page.evaluate((name) => {
		const rows = Array.from(document.querySelectorAll(".notor-tools-section .setting-item"));
		const row = rows.find((r) => r.querySelector(".setting-item-name")?.textContent?.trim() === name);
		return { found: !!row, hidden: row?.classList.contains("notor-hidden") ?? false };
	}, displayName);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSearch(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	const opened = await openPluginSettings(page);
	if (!opened) {
		ctx.fail("Open Notor settings", "app.setting API unavailable or 'notor' tab not registered");
		return;
	}

	const expanded = await expandSettingsGroup(page, "Tools");
	if (!expanded) {
		ctx.fail("Expand Tools group", "Could not find the 'Tools' settings group");
		return;
	}

	const input = await waitForSelector(page, ".notor-tools-section .notor-tool-search-input", 6_000);
	if (!input) {
		const shot = await ctx.screenshot("00-no-search-input");
		ctx.fail("Tool search input present", "No .notor-tool-search-input in the Tools section", shot);
		return;
	}
	ctx.pass("Tool search input present", "Found .notor-tool-search-input in the Tools section");

	// --- Scenario 1: highlight matching names ---
	console.log("\nTest 1: query highlights matching tool names");
	await typeSearch(page, "Read");
	const highlightShot = await ctx.screenshot("01-highlights");

	const highlights = await page.evaluate(() =>
		Array.from(document.querySelectorAll(".notor-tools-section .notor-tool-search-highlight")).map((e) => e.textContent ?? ""),
	);
	const allHighlightsMatch = highlights.length > 0 && highlights.every((h) => /read/i.test(h));
	if (allHighlightsMatch) {
		ctx.pass("Matching names highlighted", `${highlights.length} highlight span(s), all matching "read": ${JSON.stringify(highlights.slice(0, 6))}`, highlightShot);
	} else {
		ctx.fail("Matching names highlighted", `highlights=${JSON.stringify(highlights)}`, highlightShot);
	}

	const readNote = await rowState(page, "Read note");
	if (readNote.found && !readNote.hidden) {
		ctx.pass("Matching row stays visible", '"Read note" row visible under query "Read"');
	} else {
		ctx.fail("Matching row stays visible", `found=${readNote.found}, hidden=${readNote.hidden}`);
	}

	// --- Scenario 2: non-matching row hidden ---
	console.log("\nTest 2: non-matching rows hidden");
	const manageTags = await rowState(page, "Manage tags");
	if (manageTags.found && manageTags.hidden) {
		ctx.pass("Non-matching row hidden", '"Manage tags" row hidden under query "Read"');
	} else if (!manageTags.found) {
		ctx.fail("Non-matching row hidden", '"Manage tags" row not found in the Tools section');
	} else {
		ctx.fail("Non-matching row hidden", '"Manage tags" row was visible under query "Read"');
	}

	// --- Scenario 3: no-match query ---
	console.log("\nTest 3: no-match query reveals the no-match message + clear button");
	await typeSearch(page, "zzzznotatoolzzzz");
	const noMatchShot = await ctx.screenshot("03-no-match");
	const noMatchState = await page.evaluate(() => {
		const noMatch = document.querySelector(".notor-tools-section .notor-tool-search-no-match");
		const clearBtn = document.querySelector(".notor-tools-section .notor-tool-search-clear");
		const visibleToolRows = Array.from(document.querySelectorAll(".notor-tools-section .setting-item"))
			.filter((r) => r.querySelector(".setting-item-name") && !r.classList.contains("notor-hidden")).length;
		return {
			noMatchVisible: !!noMatch && !noMatch.classList.contains("notor-hidden"),
			clearVisible: !!clearBtn && !clearBtn.classList.contains("notor-hidden"),
			visibleToolRows,
		};
	});

	if (noMatchState.noMatchVisible) {
		ctx.pass("No-match message shown", '".notor-tool-search-no-match" visible for a non-matching query', noMatchShot);
	} else {
		ctx.fail("No-match message shown", "No-match message stayed hidden for a non-matching query", noMatchShot);
	}
	if (noMatchState.clearVisible) {
		ctx.pass("Clear button shown when filtering", "Clear button visible while a query is active");
	} else {
		ctx.fail("Clear button shown when filtering", "Clear button stayed hidden while a query was active");
	}

	// --- Scenario 4: clear resets everything ---
	console.log("\nTest 4: clear button resets the filter");
	await page.evaluate(() => {
		(document.querySelector<HTMLElement>(".notor-tools-section .notor-tool-search-clear"))?.click();
	});
	await page.waitForTimeout(300);
	const clearShot = await ctx.screenshot("04-cleared");
	const cleared = await page.evaluate(() => {
		const inp = document.querySelector<HTMLInputElement>(".notor-tools-section .notor-tool-search-input");
		const noMatch = document.querySelector(".notor-tools-section .notor-tool-search-no-match");
		return {
			inputEmpty: (inp?.value ?? "x") === "",
			noHighlights: document.querySelectorAll(".notor-tools-section .notor-tool-search-highlight").length === 0,
			noMatchHidden: !!noMatch && noMatch.classList.contains("notor-hidden"),
		};
	});
	const readNoteAfter = await rowState(page, "Read note");
	const manageTagsAfter = await rowState(page, "Manage tags");

	if (cleared.inputEmpty && cleared.noHighlights && cleared.noMatchHidden && !readNoteAfter.hidden && !manageTagsAfter.hidden) {
		ctx.pass("Clear resets the filter", "Input empty, highlights gone, no-match hidden, all rows visible", clearShot);
	} else {
		ctx.fail(
			"Clear resets the filter",
			`inputEmpty=${cleared.inputEmpty}, noHighlights=${cleared.noHighlights}, noMatchHidden=${cleared.noMatchHidden}, readNoteHidden=${readNoteAfter.hidden}, manageTagsHidden=${manageTagsAfter.hidden}`,
			clearShot,
		);
	}

	await page.keyboard.press("Escape");
	await page.waitForTimeout(400);
}

async function testNoErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: no errors logged for the tools search section");
	const errors = ctx.collector.getLogsByLevel("error");
	const relevant = errors.filter(
		(e) => e.source === "ToolsSection" || e.message?.toLowerCase().includes("tool search"),
	);
	if (relevant.length === 0) {
		ctx.pass("No tool-search errors", "Zero relevant error-level logs");
	} else {
		ctx.fail("No tool-search errors", `${relevant.length}: ${relevant.map((e) => e.message).join("; ")}`);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // plugin init

	await page.evaluate(() => {
		if (typeof (window as any).__name === "undefined") {
			(window as any).__name = (fn: unknown, _name: string) => fn;
		}
	});

	await testSearch(ctx);
	await testNoErrors(ctx);
}

runTest(
	{
		name: "tool-search-test",
		settings: buildDefaultSettings(),
		// Pin a clean workspace so the chat panel (deferred view in Obsidian 1.12)
		// mounts regardless of leftover workspace state from prior runs.
		setupVault: (vaultPath) => writeCleanWorkspace(vaultPath),
	},
	tests,
);
