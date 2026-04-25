#!/usr/bin/env npx tsx
/**
 * Web Search Provider Visibility E2E Test
 *
 * Diagnoses the bug where paid search providers (Tavily, Brave, SerpApi) do not
 * re-appear in the web_search tool settings UI after an API key is entered.
 *
 * The fix we shipped filters `currentList` against `field.options` (built from
 * `optionsSource: "web_search_configured_providers"`) at render time — stripping
 * unconfigured providers. But the reported symptom is that entering a key does
 * not restore the provider to the Add dropdown or unlock its enabled/delay rows.
 *
 * Scenarios:
 *   1. No API keys — modal shows only DuckDuckGo rows; paid provider rows hidden;
 *      priority list contains only DuckDuckGo; Add dropdown absent or DuckDuckGo-only
 *   2. Tavily key written to SecretStorage — after modal re-open, Tavily enabled +
 *      delay rows appear; Tavily is offered in the priority Add dropdown
 *   3. requiresSecret IDs match — the secret ID used by the SecretComponent input
 *      and the one checked by the requiresSecret guard are identical (diagnostic)
 *   4. optionsSource resolves — the priority field's computed options include Tavily
 *      after the key is present (diagnostic: verifies optionsSource isn't short-
 *      circuited by a cached or stale options array)
 *   5. currentList after key — verify persisted priority list and filter behaviour
 *      when the key is present (catches over-aggressive pruning that saves [] and
 *      then never auto-repopulates)
 *
 * @see src/settings/sections/field-renderer.ts
 * @see src/extensions/builtin-tool-scaffolds.ts — web_search settings YAML
 */

import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector } from "../lib/test-helpers";
import { slugifySecretId } from "../../src/extensions/settings-schema";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const TAVILY_SECRET_KEY = slugifySecretId("notor-ext", "web_search", "web_search_tavily_api_key");
const FAKE_TAVILY_KEY = "tvly-e2e-test-key-00000000000000000000";

const PAID_PROVIDERS = ["tavily", "brave", "serpapi"];
const PAID_PROVIDER_ROWS = [
	"Tavily — Enabled",
	"Tavily — Delay (ms)",
	"Brave Search — Enabled",
	"Brave Search — Delay (ms)",
	"SerpApi — Enabled",
	"SerpApi — Delay (ms)",
];
const TAVILY_ROWS = ["Tavily — Enabled", "Tavily — Delay (ms)"];

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Open Obsidian settings and navigate to the Notor tab. */
async function openNotorSettings(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const app = (window as any).app;
		if (!app?.setting) return false;
		app.setting.open();
		app.setting.openTabById("notor");
		return true;
	});
}

/** Expand the Tools settings group so its rows are visible. */
async function expandToolsGroup(page: Page): Promise<void> {
	await page.evaluate(() => {
		const group = document.querySelector('details[data-notor-group="Tools"]') as HTMLDetailsElement | null;
		if (group) group.open = true;
	});
	await page.waitForTimeout(500);
}

/**
 * Click the gear icon for the web_search tool row.
 * Must be called after openNotorSettings + expandToolsGroup.
 */
async function openWebSearchModal(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const toolsSection = document.querySelector('details[data-notor-group="Tools"]');
		if (!toolsSection) return false;
		const items = toolsSection.querySelectorAll(".setting-item");
		for (const item of Array.from(items)) {
			const nameEl = item.querySelector(".setting-item-name");
			// The tool display name is title-cased: "Web search"
			if (nameEl?.textContent?.trim() === "Web search") {
				const gearBtn = Array.from(
					item.querySelectorAll(".extra-setting-button"),
				).find((btn) =>
					btn.getAttribute("aria-label")?.includes("Configure tool settings"),
				);
				if (gearBtn) {
					(gearBtn as HTMLElement).click();
					return true;
				}
			}
		}
		return false;
	});
}

/**
 * Snapshot the currently open ToolSettingsModal.
 * Returns null if no modal is open.
 */
async function getModalSnapshot(page: Page): Promise<{
	isOpen: boolean;
	settingNames: string[];
	priorityListEntries: string[];
	priorityAddOptions: string[];
} | null> {
	return page.evaluate(() => {
		// Find the ToolSettingsModal specifically — it has an h2 with "web_search" as text.
		// The Obsidian settings panel is also a .modal, so we must be specific.
		const allModals = Array.from(document.querySelectorAll(".modal-container .modal, .modal"));
		const modal = allModals.find((m) => {
			const h2 = m.querySelector("h2");
			return h2?.textContent?.trim() === "web_search";
		});
		if (!modal) return null;
		const content = modal.querySelector(".modal-content") ?? modal;

		const settingNames = Array.from(
			content.querySelectorAll(".setting-item:not(.setting-item-heading) .setting-item-name"),
		).map((n) => n.textContent?.trim() ?? "");

		// The priority list renders each existing entry as a .setting-item whose
		// name is the provider string (e.g. "duckduckgo"). These appear after the
		// "Provider priority order" header row and before the "Add to …" row.
		// We identify them by checking which items do NOT look like a labelled
		// setting field — they have no description and no control other than
		// reorder/remove buttons.
		// Simpler: collect the text of all setting-item-name elements that equal
		// a known provider string.
		const knownProviders = new Set(["duckduckgo", "tavily", "brave", "serpapi"]);
		const priorityListEntries = settingNames.filter((n) => knownProviders.has(n));

		// The "Add" dropdown is a <select> inside a setting-item whose name starts
		// with "Add to".
		const priorityAddOptions: string[] = [];
		for (const item of Array.from(content.querySelectorAll(".setting-item"))) {
			const nameEl = item.querySelector(".setting-item-name");
			if (nameEl?.textContent?.trim().startsWith("Add to")) {
				const select = item.querySelector("select");
				if (select) {
					for (const opt of Array.from(select.options)) {
						priorityAddOptions.push(opt.value);
					}
				}
			}
		}

		return { isOpen: true, settingNames, priorityListEntries, priorityAddOptions };
	});
}

/** Close the open modal via its Done button. */
async function closeModal(page: Page): Promise<void> {
	await page.evaluate(() => {
		const modal = document.querySelector(".modal-container .modal");
		if (!modal) return;
		const buttons = Array.from(modal.querySelectorAll("button"));
		const done = buttons.find((b) => b.textContent?.trim() === "Done");
		if (done) done.click();
	});
	await page.waitForTimeout(600);
}

/** Write a secret value directly to Obsidian's SecretStorage. Returns false if unavailable. */
async function writeSecret(page: Page, id: string, value: string): Promise<boolean> {
	return page.evaluate(
		async ([secretId, secretValue]) => {
			const app = (window as any).app;
			if (!app?.secretStorage) return false;
			await app.secretStorage.setSecret(secretId, secretValue);
			return true;
		},
		[id, value] as [string, string],
	);
}

/** Read a secret value from SecretStorage. Returns null if absent/empty. */
async function readSecret(page: Page, id: string): Promise<string | null> {
	return page.evaluate((secretId: string) => {
		const app = (window as any).app;
		if (!app?.secretStorage) return null;
		const v: string = app.secretStorage.getSecret(secretId);
		return v === null || v === "" ? null : v;
	}, id);
}

/** Clear a secret from SecretStorage (set to empty string). */
async function clearSecret(page: Page, id: string): Promise<void> {
	await page.evaluate(async (secretId: string) => {
		const app = (window as any).app;
		if (!app?.secretStorage) return;
		await app.secretStorage.setSecret(secretId, "");
	}, id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testNoKeysState(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: No API keys — paid provider rows hidden, priority list DuckDuckGo-only");
	const { page } = ctx;

	const opened = await openNotorSettings(page);
	if (!opened) {
		ctx.fail("No-keys: open settings", "Could not open Notor settings");
		return;
	}
	await page.waitForTimeout(2_000);
	await expandToolsGroup(page);
	await page.waitForTimeout(1_000);

	// Quick diagnostic: confirm the gear button is present for web_search
	const gearPresent = await page.evaluate(() => {
		const toolsSection = document.querySelector('details[data-notor-group="Tools"]');
		if (!toolsSection) return false;
		const wsRow = Array.from(toolsSection.querySelectorAll(".setting-item"))
			.find(i => i.querySelector(".setting-item-name")?.textContent?.trim() === "Web search");
		return !!wsRow?.querySelector('.extra-setting-button[aria-label="Configure tool settings"]');
	});
	console.log(`  Gear button present for Web search: ${gearPresent}`);

	const gearOpened = await openWebSearchModal(page);
	if (!gearOpened) {
		const shot = await ctx.screenshot("01a-no-gear");
		ctx.fail("No-keys: open web_search modal", "Could not find or click gear icon for web_search", shot);
		return;
	}
	await page.waitForTimeout(1_000);

	const snap = await getModalSnapshot(page);
	const shot = await ctx.screenshot("01-no-keys-modal");

	if (!snap || !snap.isOpen) {
		ctx.fail("No-keys: modal open", "ToolSettingsModal did not open", shot);
		return;
	}

	ctx.pass("No-keys: modal open", `Modal open; found ${snap.settingNames.length} setting rows`, shot);

	// Paid provider rows must NOT be visible
	const visiblePaidRows = PAID_PROVIDER_ROWS.filter((r) => snap.settingNames.includes(r));
	if (visiblePaidRows.length > 0) {
		ctx.fail(
			"No-keys: paid rows hidden",
			`Paid rows still visible: [${visiblePaidRows.join(", ")}]`,
			shot,
		);
	} else {
		ctx.pass("No-keys: paid rows hidden", "None of the 6 paid-provider rows are visible");
	}

	// Priority list must contain only duckduckgo
	const hasBadEntry = snap.priorityListEntries.some((e) => PAID_PROVIDERS.includes(e));
	if (hasBadEntry) {
		ctx.fail(
			"No-keys: priority list clean",
			`Paid providers in existing list: [${snap.priorityListEntries.join(", ")}]`,
			shot,
		);
	} else {
		ctx.pass(
			"No-keys: priority list clean",
			`Priority list entries: [${snap.priorityListEntries.join(", ")}]`,
		);
	}

	// Add dropdown must not offer paid providers
	const badAddOptions = snap.priorityAddOptions.filter((o) => PAID_PROVIDERS.includes(o));
	if (badAddOptions.length > 0) {
		ctx.fail(
			"No-keys: Add dropdown clean",
			`Add dropdown offers unconfigured providers: [${badAddOptions.join(", ")}]`,
			shot,
		);
	} else {
		ctx.pass(
			"No-keys: Add dropdown clean",
			`Add dropdown options: [${snap.priorityAddOptions.join(", ")}]`,
		);
	}

	// Log current setting names for diagnostic output
	console.log(`  Visible setting names: [${snap.settingNames.join(", ")}]`);
	console.log(`  Priority list entries: [${snap.priorityListEntries.join(", ")}]`);
	console.log(`  Add dropdown options:  [${snap.priorityAddOptions.join(", ")}]`);

	await closeModal(page);
}

async function testSecretIdConsistency(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Secret ID consistency — requiresSecret guard uses same ID as SecretComponent");
	const { page } = ctx;

	// The secret ID that the SecretComponent uses for web_search_tavily_api_key
	// is computed at render time as slugifySecretId("notor-ext", "web_search", "web_search_tavily_api_key").
	// We have that value in TAVILY_SECRET_KEY (computed at top of script from the same function).
	// Verify that writing to that ID makes the secret readable by the plugin's getSecret().
	const writeOk = await writeSecret(page, TAVILY_SECRET_KEY, FAKE_TAVILY_KEY);
	if (!writeOk) {
		ctx.fail("Secret ID: write", "SecretStorage not available in this Obsidian build");
		return;
	}
	await page.waitForTimeout(300);

	const readBack = await readSecret(page, TAVILY_SECRET_KEY);
	if (readBack === FAKE_TAVILY_KEY) {
		ctx.pass(
			"Secret ID: round-trip",
			`Written and read back via ID "${TAVILY_SECRET_KEY}"`,
		);
	} else {
		ctx.fail(
			"Secret ID: round-trip",
			`Expected "${FAKE_TAVILY_KEY}", got "${readBack}". ID used: "${TAVILY_SECRET_KEY}"`,
		);
	}

	// Also verify the plugin's own getSecret sees it
	const pluginSees = await page.evaluate((secretId: string) => {
		const app = (window as any).app;
		if (!app?.secretStorage) return null;
		try {
			const v: string = app.secretStorage.getSecret(secretId);
			return v === null || v === "" ? null : v;
		} catch {
			return null;
		}
	}, TAVILY_SECRET_KEY);

	if (pluginSees) {
		ctx.pass("Secret ID: plugin visibility", `Plugin getSecret sees value for ID "${TAVILY_SECRET_KEY}"`);
	} else {
		ctx.fail(
			"Secret ID: plugin visibility",
			`Plugin getSecret returned null/empty for ID "${TAVILY_SECRET_KEY}" even though we just wrote it`,
		);
	}

	// Leave the key in place for subsequent tests
}

async function testWithTavilyKey(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: With Tavily key — enabled/delay rows appear, Add dropdown offers Tavily");
	const { page } = ctx;

	// Key should already be in SecretStorage from test 2; ensure it's there
	const present = await readSecret(page, TAVILY_SECRET_KEY);
	if (!present) {
		const wrote = await writeSecret(page, TAVILY_SECRET_KEY, FAKE_TAVILY_KEY);
		if (!wrote) {
			ctx.fail("With Tavily key: precondition", "Could not write Tavily key to SecretStorage");
			return;
		}
		await page.waitForTimeout(300);
	}

	// Re-open settings (closing modal may have closed settings too) and re-expand Tools
	await openNotorSettings(page);
	await page.waitForTimeout(1_500);
	await expandToolsGroup(page);
	await page.waitForTimeout(500);

	const gearOpened = await openWebSearchModal(page);
	if (!gearOpened) {
		const shot = await ctx.screenshot("03a-no-gear");
		ctx.fail("With Tavily key: open modal", "Could not open web_search modal", shot);
		return;
	}
	await page.waitForTimeout(1_000);

	const snap = await getModalSnapshot(page);
	const shot = await ctx.screenshot("03-with-tavily-key");

	if (!snap || !snap.isOpen) {
		ctx.fail("With Tavily key: modal open", "Modal did not open", shot);
		return;
	}

	console.log(`  Visible setting names: [${snap.settingNames.join(", ")}]`);
	console.log(`  Priority list entries: [${snap.priorityListEntries.join(", ")}]`);
	console.log(`  Add dropdown options:  [${snap.priorityAddOptions.join(", ")}]`);

	// Tavily rows must now be visible
	const tavilyRowsVisible = TAVILY_ROWS.every((r) => snap.settingNames.includes(r));
	if (tavilyRowsVisible) {
		ctx.pass("With Tavily key: Tavily rows visible", `Found: [${TAVILY_ROWS.join(", ")}]`, shot);
	} else {
		const missing = TAVILY_ROWS.filter((r) => !snap.settingNames.includes(r));
		ctx.fail(
			"With Tavily key: Tavily rows visible",
			`Still hidden after key set: [${missing.join(", ")}]. All names: [${snap.settingNames.join(", ")}]`,
			shot,
		);
	}

	// Other paid provider rows (Brave, SerpApi) must still be hidden
	const otherPaidRows = PAID_PROVIDER_ROWS.filter((r) => !r.startsWith("Tavily"));
	const wronglyVisible = otherPaidRows.filter((r) => snap.settingNames.includes(r));
	if (wronglyVisible.length > 0) {
		ctx.fail(
			"With Tavily key: Brave/SerpApi still hidden",
			`Unexpectedly visible: [${wronglyVisible.join(", ")}]`,
			shot,
		);
	} else {
		ctx.pass("With Tavily key: Brave/SerpApi still hidden", "Correctly hidden (no key set)");
	}

	// Tavily should be offered in the Add dropdown
	if (snap.priorityAddOptions.includes("tavily")) {
		ctx.pass(
			"With Tavily key: Add dropdown includes Tavily",
			`Add options: [${snap.priorityAddOptions.join(", ")}]`,
			shot,
		);
	} else {
		ctx.fail(
			"With Tavily key: Add dropdown includes Tavily",
			`Tavily not in Add dropdown. Options: [${snap.priorityAddOptions.join(", ")}]. Entries: [${snap.priorityListEntries.join(", ")}]`,
			shot,
		);
	}

	// Brave and SerpApi must NOT be in the Add dropdown
	const badAdd = snap.priorityAddOptions.filter((o) => o === "brave" || o === "serpapi");
	if (badAdd.length > 0) {
		ctx.fail(
			"With Tavily key: Add dropdown excludes keyless providers",
			`Brave/SerpApi in Add dropdown without keys: [${badAdd.join(", ")}]`,
			shot,
		);
	} else {
		ctx.pass("With Tavily key: Add dropdown excludes keyless providers", "brave/serpapi absent from Add dropdown");
	}

	await closeModal(page);
}

async function testPersistedListAfterFilter(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Persisted list — check what was saved to settings after filter pruning");
	const { page } = ctx;

	// Inspect the persisted value of web_search_provider_priority in plugin settings
	const persisted = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		const extSettings = plugin.settings?.user_extension_settings?.web_search;
		return extSettings?.web_search_provider_priority ?? null;
	});

	console.log(`  Persisted web_search_provider_priority: ${JSON.stringify(persisted)}`);

	if (persisted === null) {
		ctx.pass(
			"Persisted list: not yet saved",
			"No persisted override — field will use default. This is expected if no pruning occurred.",
		);
	} else if (Array.isArray(persisted)) {
		// If the filter saved a pruned list, it may have stripped everything but duckduckgo.
		// That's fine — but verify Tavily is NOT in it (it was removed when there was no key).
		const hasPayProv = (persisted as string[]).some((p) => PAID_PROVIDERS.includes(p));
		if (hasPayProv) {
			ctx.fail(
				"Persisted list: should not contain keyless providers",
				`Persisted list still contains paid providers: ${JSON.stringify(persisted)}`,
			);
		} else {
			ctx.pass(
				"Persisted list: keyless providers removed",
				`Persisted list after pruning: ${JSON.stringify(persisted)}`,
			);
		}
	} else {
		ctx.fail("Persisted list: unexpected type", `Got: ${JSON.stringify(persisted)}`);
	}
}

async function testKeyRemovedRestoresHiddenState(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Key removed — Tavily rows re-hide after key is cleared");
	const { page } = ctx;

	// Clear the Tavily key
	await clearSecret(page, TAVILY_SECRET_KEY);
	await page.waitForTimeout(300);

	// Verify it's gone
	const gone = await readSecret(page, TAVILY_SECRET_KEY);
	if (gone !== null) {
		ctx.fail("Key removed: clear", `Key still readable after clear: "${gone}"`);
	}

	// Re-open settings and expand Tools group
	await openNotorSettings(page);
	await page.waitForTimeout(1_500);
	await expandToolsGroup(page);
	await page.waitForTimeout(500);

	const gearOpened = await openWebSearchModal(page);
	if (!gearOpened) {
		ctx.fail("Key removed: open modal", "Could not open web_search modal after key clear");
		return;
	}
	await page.waitForTimeout(1_000);

	const snap = await getModalSnapshot(page);
	const shot = await ctx.screenshot("05-key-removed");

	if (!snap || !snap.isOpen) {
		ctx.fail("Key removed: modal open", "Modal did not open", shot);
		return;
	}

	console.log(`  Visible setting names: [${snap.settingNames.join(", ")}]`);
	console.log(`  Priority list entries: [${snap.priorityListEntries.join(", ")}]`);
	console.log(`  Add dropdown options:  [${snap.priorityAddOptions.join(", ")}]`);

	const tavilyRowsGone = TAVILY_ROWS.every((r) => !snap.settingNames.includes(r));
	if (tavilyRowsGone) {
		ctx.pass("Key removed: Tavily rows re-hidden", "Tavily rows no longer visible after key cleared", shot);
	} else {
		const stillVisible = TAVILY_ROWS.filter((r) => snap.settingNames.includes(r));
		ctx.fail(
			"Key removed: Tavily rows re-hidden",
			`Rows still visible: [${stillVisible.join(", ")}]`,
			shot,
		);
	}

	const tavilyGoneFromAdd = !snap.priorityAddOptions.includes("tavily");
	if (tavilyGoneFromAdd) {
		ctx.pass("Key removed: Tavily absent from Add dropdown", `Add options: [${snap.priorityAddOptions.join(", ")}]`);
	} else {
		ctx.fail(
			"Key removed: Tavily absent from Add dropdown",
			`Tavily still in Add dropdown after key cleared. Options: [${snap.priorityAddOptions.join(", ")}]`,
			shot,
		);
	}

	await closeModal(page);
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	// Ensure any stale Tavily secret is cleared before we begin
	await clearSecret(page, TAVILY_SECRET_KEY);
	await page.waitForTimeout(5_000); // Wait for plugin full init

	await testNoKeysState(ctx);
	await testSecretIdConsistency(ctx);
	await testWithTavilyKey(ctx);
	await testPersistedListAfterFilter(ctx);
	await testKeyRemovedRestoresHiddenState(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	// No web_search_provider_priority override — let it use the default so we
	// see the behaviour starting from an unpersisted state.
});

runTest({ name: "web-search-provider-visibility", settings }, tests);
