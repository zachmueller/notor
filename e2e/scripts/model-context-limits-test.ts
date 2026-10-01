#!/usr/bin/env npx tsx
/**
 * Model Context Limits Settings E2E Test
 *
 * Validates the "Model context limits" section in Settings → Notor → Reference
 * and, through its override descriptions, that the bundled plugin resolves an
 * unknown new Claude model (a hypothetical Opus 6) by family inference.
 *
 * Scenarios:
 *   1. Section renders — deep-linkable heading, "Add override" row, and the
 *      "Detected limits" empty state
 *   2. Add override — a row appears whose description reports the inferred
 *      1,000,000-token base window, the override persists to data.json, and the
 *      pane is not rebuilt
 *   3. Remove override — the row and the persisted entry are deleted in place
 *   4. No unexpected plugin errors
 */

import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	expandSettingsGroup,
	openPluginSettings,
	PLUGIN_DATA_PATH,
	scrollToSettingsSubsection,
	SETTINGS_CONTENT_SELECTOR,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const SUBSECTION = "Model context limits";
/** Not in the static table — resolved by Claude family inference. */
const MODEL_ID = "us.anthropic.claude-opus-6";
const OVERRIDE_INPUT = "500k";
const OVERRIDE_TOKENS = 500_000;
/** Stamped on the heading; disappears if the pane is rebuilt. */
const PANE_MARKER = "data-e2e-pane-marker";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Names and descriptions of every setting row in the active settings tab. */
async function readRows(ctx: TestContext): Promise<Array<{ name: string; desc: string }>> {
	return ctx.page.evaluate((scopeSelector: string) => {
		const scope = document.querySelector(scopeSelector) ?? document.body;
		return Array.from(scope.querySelectorAll(".setting-item")).map((row) => ({
			name: row.querySelector(".setting-item-name")?.textContent?.trim() ?? "",
			desc: row.querySelector(".setting-item-description")?.textContent?.trim() ?? "",
		}));
	}, SETTINGS_CONTENT_SELECTOR);
}

/** Whether the heading stamped before an action is still the same DOM node. */
async function paneMarkerPresent(ctx: TestContext): Promise<boolean> {
	return ctx.page.evaluate(
		({ scopeSelector, marker }: { scopeSelector: string; marker: string }) => {
			const scope = document.querySelector(scopeSelector) ?? document.body;
			return scope.querySelector(`[${marker}]`) !== null;
		},
		{ scopeSelector: SETTINGS_CONTENT_SELECTOR, marker: PANE_MARKER },
	);
}

function readPersistedOverrides(): Record<string, unknown> | undefined {
	const data = JSON.parse(fs.readFileSync(PLUGIN_DATA_PATH, "utf8")) as Record<string, unknown>;
	return data.model_context_overrides as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSectionRenders(ctx: TestContext): Promise<boolean> {
	console.log("\nTest 1: Section renders");
	const { page } = ctx;

	if (!(await openPluginSettings(page))) {
		ctx.fail("Open settings", "app.setting API unavailable");
		return false;
	}
	if (!(await expandSettingsGroup(page, "Reference"))) {
		ctx.fail("Expand Reference group", "No settings group titled Reference");
		return false;
	}
	const found = await scrollToSettingsSubsection(page, SUBSECTION);
	const shot = await ctx.screenshot("01-section");
	if (!found) {
		ctx.fail("Deep-linkable heading", `No [data-notor-subsection="${SUBSECTION}"] element`, shot);
		return false;
	}
	ctx.pass("Deep-linkable heading", `Found subsection "${SUBSECTION}"`, shot);

	const rows = await readRows(ctx);
	const names = rows.map((r) => r.name);
	if (names.includes("Add override") && names.includes("Detected limits")) {
		ctx.pass("Section rows", "Found Add override and Detected limits rows", shot);
	} else {
		ctx.fail("Section rows", `Missing rows; saw: ${JSON.stringify(names.slice(-15))}`, shot);
	}

	const emptyState = await page.evaluate((scopeSelector: string) => {
		const scope = document.querySelector(scopeSelector) ?? document.body;
		return Array.from(scope.querySelectorAll("p.setting-item-description"))
			.some((p) => p.textContent?.trim() === "No detected limits yet.");
	}, SETTINGS_CONTENT_SELECTOR);
	if (emptyState) {
		ctx.pass("Detected limits empty state", "Shows 'No detected limits yet.'", shot);
	} else {
		ctx.fail("Detected limits empty state", "Empty-state text not found", shot);
	}

	await page.evaluate(
		({ scopeSelector, name, marker }: { scopeSelector: string; name: string; marker: string }) => {
			const scope = document.querySelector(scopeSelector) ?? document.body;
			scope.querySelector(`[data-notor-subsection="${CSS.escape(name)}"]`)?.setAttribute(marker, "1");
		},
		{ scopeSelector: SETTINGS_CONTENT_SELECTOR, name: SUBSECTION, marker: PANE_MARKER },
	);
	return true;
}

async function testAddOverride(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Add override");
	const { page } = ctx;

	const addRow = page.locator(`${SETTINGS_CONTENT_SELECTOR} .setting-item`, { hasText: "Add override" });
	await addRow.locator("input").nth(0).fill(MODEL_ID);
	await addRow.locator("input").nth(1).fill(OVERRIDE_INPUT);
	await addRow.getByRole("button", { name: "Add" }).click();
	await page.waitForTimeout(1_500);
	const shot = await ctx.screenshot("02-override-added");

	const row = (await readRows(ctx)).find((r) => r.name === MODEL_ID);
	if (!row) {
		ctx.fail("Override row", `No row named ${MODEL_ID}`, shot);
		return;
	}
	const expectedDesc = `500,000 tokens · otherwise 1,000,000 inferred from us.anthropic.claude-opus-5-5`;
	if (row.desc === expectedDesc) {
		ctx.pass("Override row reports the inferred window", row.desc, shot);
	} else {
		ctx.fail("Override row reports the inferred window", `Expected "${expectedDesc}", got "${row.desc}"`, shot);
	}

	const inMemory = await page.evaluate((id: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.settings?.model_context_overrides?.[id];
	}, MODEL_ID);
	const persisted = readPersistedOverrides()?.[MODEL_ID];
	if (inMemory === OVERRIDE_TOKENS && persisted === OVERRIDE_TOKENS) {
		ctx.pass("Override saved", `settings and data.json hold ${OVERRIDE_TOKENS}`);
	} else {
		ctx.fail("Override saved", `in memory: ${String(inMemory)}, data.json: ${String(persisted)}`);
	}

	if (await paneMarkerPresent(ctx)) {
		ctx.pass("Pane not rebuilt on add", "Heading node survived the add");
	} else {
		ctx.fail("Pane not rebuilt on add", "Heading node was replaced — the pane re-rendered", shot);
	}
}

async function testRemoveOverride(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Remove override");
	const { page } = ctx;

	const row = page.locator(`${SETTINGS_CONTENT_SELECTOR} .setting-item`, {
		has: page.locator(".setting-item-name", { hasText: MODEL_ID }),
	});
	await row.getByRole("button", { name: "Remove" }).click();
	await page.waitForTimeout(1_500);
	const shot = await ctx.screenshot("03-override-removed");

	const stillThere = (await readRows(ctx)).some((r) => r.name === MODEL_ID);
	const persisted = readPersistedOverrides();
	if (!stillThere && persisted !== undefined && !(MODEL_ID in persisted)) {
		ctx.pass("Override removed", "Row gone and data.json entry deleted", shot);
	} else {
		ctx.fail("Override removed", `row present: ${stillThere}, data.json: ${JSON.stringify(persisted)}`, shot);
	}

	if (await paneMarkerPresent(ctx)) {
		ctx.pass("Pane not rebuilt on remove", "Heading node survived the remove");
	} else {
		ctx.fail("Pane not rebuilt on remove", "Heading node was replaced — the pane re-rendered", shot);
	}
}

function testNoErrors(ctx: TestContext): void {
	console.log("\nTest 4: No unexpected plugin errors");
	const errors = ctx.collector.getLogsByLevel("error");
	if (errors.length === 0) {
		ctx.pass("No plugin errors", "0 error-level log entries");
	} else {
		ctx.fail("No plugin errors", JSON.stringify(errors.slice(0, 5)));
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(5_000); // Wait for plugin init
	if (await testSectionRenders(ctx)) {
		await testAddOverride(ctx);
		await testRemoveOverride(ctx);
	}
	testNoErrors(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings();

runTest({ name: "model-context-limits", settings }, tests);
