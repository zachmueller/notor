#!/usr/bin/env npx tsx
/**
 * Path Scoping Table E2E Test Script
 *
 * Validates the path-first path-scoping settings table:
 *  1. Section renders with the add-rule row when no rules exist
 *  2. Adding a relative path shows "vault + filesystem"
 *  3. Read/Write dropdowns offer the six states
 *  4. Setting Write = Auto-approve persists across the redisplay
 *  5. Adding a ~ path shows "filesystem"
 *  6. Choosing "Allow only" surfaces the restrict-mode hint
 *
 * LLM Required: No
 *
 * Obsidian 1.13 notes:
 *  - The settings modal renders into `app.setting.tabContentContainer`, which is
 *    NOT reachable from `document.querySelector`. Every DOM query below is scoped
 *    to that element via the SCOPE snippet.
 *  - `Meta+,` is not delivered reliably over CDP; drive `app.setting` directly.
 *  - Do not declare nested functions inside `page.evaluate` — tsx compiles them
 *    with an esbuild `__name` helper that does not exist in the page.
 */

import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector, writeCleanWorkspace } from "../lib/test-helpers";

/** Resolve the settings content root (Obsidian 1.13 renders outside `document`). */
const SCOPE = `(() => {
	const s = window.app && window.app.setting;
	return (s && (s.tabContentContainer || s.containerEl)) || document.body;
})()`;

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

async function openNotorSettings(page: Page): Promise<boolean> {
	const opened = await page.evaluate(() => {
		const setting = (window as unknown as { app?: { setting?: Record<string, unknown> } }).app
			?.setting as { open?: () => void; openTabById?: (id: string) => void } | undefined;
		if (!setting?.open || !setting.openTabById) return false;
		setting.open();
		setting.openTabById("notor");
		return true;
	});
	await page.waitForTimeout(2_000);
	return opened;
}

/** Force a `<details>` settings group open by its summary text. */
async function expandSettingsGroup(page: Page, groupTitle: string): Promise<boolean> {
	return page.evaluate(
		`((title) => {
			const scope = ${SCOPE};
			const groups = scope.querySelectorAll("details.notor-settings-group");
			for (const d of groups) {
				const summary = d.querySelector("summary");
				if (summary && summary.textContent.trim() === title) {
					if (!d.open) d.setAttribute("open", "");
					return true;
				}
			}
			return false;
		})(${JSON.stringify(groupTitle)})`,
	) as Promise<boolean>;
}

/** Scroll the Path scoping heading into view so screenshots show the table. */
async function scrollToSection(page: Page): Promise<void> {
	await page.evaluate(`(() => {
		const scope = ${SCOPE};
		const heading = scope.querySelector('[data-notor-subsection="Path scoping"]');
		if (heading) heading.scrollIntoView({ block: "start" });
	})()`);
	await page.waitForTimeout(400);
}

/** Type a path into the "Add path rule" row and click Add. */
async function addRule(page: Page, rulePath: string): Promise<boolean> {
	return page.evaluate(
		`((value) => {
			const scope = ${SCOPE};
			const items = scope.querySelectorAll(".setting-item");
			for (const item of items) {
				const name = item.querySelector(".setting-item-name");
				if (!name || name.textContent.trim() !== "Add path rule") continue;
				const input = item.querySelector("input[type='text']");
				const button = item.querySelector("button");
				if (!input || !button) return false;
				input.value = value;
				input.dispatchEvent(new Event("input"));
				button.click();
				return true;
			}
			return false;
		})(${JSON.stringify(rulePath)})`,
	) as Promise<boolean>;
}

interface RuleRow {
	path: string;
	desc: string;
	states: string[];
	options: string[];
}

/** Read back every rendered rule row. */
async function readRows(page: Page): Promise<RuleRow[]> {
	return page.evaluate(`(() => {
		const scope = ${SCOPE};
		const rows = [];
		for (const item of scope.querySelectorAll(".setting-item")) {
			const selects = item.querySelectorAll("select.notor-path-rule-select");
			if (selects.length !== 2) continue;
			const name = item.querySelector(".setting-item-name");
			const desc = item.querySelector(".setting-item-description");
			const states = [];
			for (const s of selects) states.push(s.value);
			const options = [];
			for (const o of selects[0].options) options.push(o.text);
			rows.push({
				path: name ? name.textContent.trim() : "",
				desc: desc ? desc.textContent.trim() : "",
				states: states,
				options: options,
			});
		}
		return rows;
	})()`) as Promise<RuleRow[]>;
}

/** Set one row's read or write dropdown by visible label. */
async function setRowState(
	page: Page,
	rowPath: string,
	access: "read" | "write",
	label: string,
): Promise<boolean> {
	const index = access === "read" ? 0 : 1;
	return page.evaluate(
		`((rowPath, index, label) => {
			const scope = ${SCOPE};
			for (const item of scope.querySelectorAll(".setting-item")) {
				const name = item.querySelector(".setting-item-name");
				if (!name || name.textContent.trim() !== rowPath) continue;
				const selects = item.querySelectorAll("select.notor-path-rule-select");
				if (selects.length !== 2) continue;
				const select = selects[index];
				for (const option of select.options) {
					if (option.text === label) {
						select.value = option.value;
						select.dispatchEvent(new Event("change"));
						return true;
					}
				}
				return false;
			}
			return false;
		})(${JSON.stringify(rowPath)}, ${index}, ${JSON.stringify(label)})`,
	) as Promise<boolean>;
}

/** Collect the muted restrict-mode hint lines. */
async function readRestrictHints(page: Page): Promise<string[]> {
	return page.evaluate(`(() => {
		const scope = ${SCOPE};
		const hints = [];
		for (const p of scope.querySelectorAll("p.setting-item-description")) {
			const text = p.textContent.trim();
			if (text.indexOf("restricted to:") !== -1) hints.push(text);
		}
		return hints;
	})()`) as Promise<string[]>;
}

/**
 * Screenshot the window that actually shows the settings.
 *
 * Obsidian 1.13 renders settings into a separate `about:blank` popout window that
 * has NO `window.app` of its own — the vault page owns the app object while the
 * popout owns the DOM. So detect the settings window by its DOM alone, and note
 * that `ctx.screenshot()` would only ever capture the chat view.
 */
async function findSettingsPage(ctx: TestContext): Promise<Page | null> {
	for (const context of ctx.browser.contexts()) {
		for (const candidate of context.pages()) {
			const isSettings = await candidate
				.evaluate(
					`!!document.querySelector('[data-notor-subsection="Path scoping"]')`,
				)
				.catch(() => false);
			if (isSettings) return candidate;
		}
	}
	return null;
}

async function screenshotSettings(ctx: TestContext, name: string): Promise<string> {
	const settingsPage = await findSettingsPage(ctx);
	if (!settingsPage) return ctx.screenshot(name);
	const file = `${ctx.screenshotsDir}/${name}.png`;
	await settingsPage.screenshot({ path: file }).catch(() => undefined);
	return file;
}

/** Read the persisted rules straight out of the plugin's settings object. */
async function readPersistedRules(page: Page): Promise<unknown> {
	return page.evaluate(`(() => {
		const plugin = window.app && window.app.plugins && window.app.plugins.plugins
			? window.app.plugins.plugins["notor"]
			: null;
		return plugin && plugin.settings ? plugin.settings.path_scope_rules : null;
	})()`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext) {
	const { page } = ctx;
	await waitForSelector(page, ".notor-chat-container", 12_000);

	// ── Test 1: Section renders ─────────────────────────────────────────
	console.log("── Test 1: Path scoping section renders ──");
	{
		const opened = await openNotorSettings(page);
		if (!opened) {
			ctx.fail("Open settings", "app.setting API unavailable", await screenshotSettings(ctx, "01-fail"));
			return;
		}
		await expandSettingsGroup(page, "Tools");
		await page.waitForTimeout(700);
		await scrollToSection(page);

		const present = await page.evaluate(`(() => {
			const scope = ${SCOPE};
			const heading = scope.querySelector('[data-notor-subsection="Path scoping"]');
			let addRow = false;
			for (const n of scope.querySelectorAll(".setting-item-name")) {
				if (n.textContent.trim() === "Add path rule") addRow = true;
			}
			return { heading: heading !== null, addRow: addRow };
		})()`) as { heading: boolean; addRow: boolean };
		const shot = await screenshotSettings(ctx, "01-section-empty");

		if (present.heading && present.addRow) {
			ctx.pass(
				"Path scoping section renders",
				"Heading (deep-link target) and add-rule row present with no rules configured",
				shot,
			);
		} else {
			ctx.fail(
				"Path scoping section renders",
				`heading=${present.heading} addRow=${present.addRow}`,
				shot,
			);
		}
	}

	// ── Test 2: Relative path → vault + filesystem ──────────────────────
	console.log("\n── Test 2: Relative path namespace detection ──");
	{
		const added = await addRule(page, "ai/");
		await page.waitForTimeout(900);
		await scrollToSection(page);
		const rows = await readRows(page);
		const row = rows.find((r) => r.path === "ai/");
		const shot = await screenshotSettings(ctx, "02-relative-rule");

		if (added && row && row.desc === "vault + filesystem") {
			ctx.pass(
				"Relative path namespace detection",
				`Row "ai/" reports "${row.desc}"; both dropdowns default to [${row.states.join(", ")}]`,
				shot,
			);
		} else {
			ctx.fail(
				"Relative path namespace detection",
				`added=${added}; expected desc "vault + filesystem", got ${JSON.stringify(row)} (${rows.length} rows)`,
				shot,
			);
		}
	}

	// ── Test 3: Six dropdown states ─────────────────────────────────────
	console.log("\n── Test 3: Dropdown offers the six states ──");
	{
		const rows = await readRows(page);
		const expected = [
			"Default",
			"Auto-approve",
			"Always ask",
			"Allow only",
			"Allow + auto-approve",
			"Blocked",
		];
		const options = rows[0]?.options ?? [];
		const shot = await screenshotSettings(ctx, "03-dropdown-states");

		if (JSON.stringify(options) === JSON.stringify(expected)) {
			ctx.pass("Dropdown offers the six states", options.join(" / "), shot);
		} else {
			ctx.fail(
				"Dropdown offers the six states",
				`Expected [${expected.join(", ")}], got [${options.join(", ")}]`,
				shot,
			);
		}
	}

	// ── Test 4: Write = Auto-approve persists ───────────────────────────
	console.log("\n── Test 4: Write = Auto-approve persists ──");
	{
		const set = await setRowState(page, "ai/", "write", "Auto-approve");
		await page.waitForTimeout(900);
		await scrollToSection(page);
		const rows = await readRows(page);
		const row = rows.find((r) => r.path === "ai/");
		const persisted = await readPersistedRules(page);
		const shot = await screenshotSettings(ctx, "04-write-auto-approve");

		if (set && row?.states[1] === "auto_approve") {
			ctx.pass(
				"Write = Auto-approve persists",
				`Row survived redisplay with write="${row.states[1]}"; settings hold ${JSON.stringify(persisted)}`,
				shot,
			);
		} else {
			ctx.fail(
				"Write = Auto-approve persists",
				`set=${set}; row=${JSON.stringify(row)}; persisted=${JSON.stringify(persisted)}`,
				shot,
			);
		}
	}

	// ── Test 5: ~ path → filesystem only ────────────────────────────────
	console.log("\n── Test 5: Tilde path namespace detection ──");
	{
		await addRule(page, "~/Downloads/");
		await page.waitForTimeout(900);
		await setRowState(page, "~/Downloads/", "write", "Blocked");
		await page.waitForTimeout(900);
		await scrollToSection(page);
		const rows = await readRows(page);
		const row = rows.find((r) => r.path === "~/Downloads/");
		const shot = await screenshotSettings(ctx, "05-tilde-rule");

		if (row && row.desc === "filesystem" && row.states[1] === "blocked") {
			ctx.pass(
				"Tilde path namespace detection",
				`Row "~/Downloads/" reports "${row.desc}" with write="${row.states[1]}"`,
				shot,
			);
		} else {
			ctx.fail(
				"Tilde path namespace detection",
				`Expected desc "filesystem" + write blocked, got ${JSON.stringify(row)}`,
				shot,
			);
		}
	}

	// ── Test 6: Allow only surfaces the restrict hint ────────────────────
	console.log("\n── Test 6: Allow only surfaces the restrict hint ──");
	{
		await setRowState(page, "ai/", "read", "Allow only");
		await page.waitForTimeout(1_000);
		await scrollToSection(page);
		const hints = await readRestrictHints(page);
		const shot = await screenshotSettings(ctx, "06-restrict-hint");

		const vaultHint = hints.find((h) => h.startsWith("Vault reads restricted to:"));
		const fsHint = hints.find((h) => h.startsWith("Filesystem reads restricted to:"));
		if (vaultHint && fsHint) {
			ctx.pass(
				"Allow only surfaces the restrict hint",
				`Relative rule narrowed both namespaces — "${vaultHint}" / "${fsHint}"`,
				shot,
			);
		} else {
			ctx.fail(
				"Allow only surfaces the restrict hint",
				`Expected vault + filesystem read hints; got ${JSON.stringify(hints)}`,
				shot,
			);
		}
	}

	// ── Test 7: Persisted shape ─────────────────────────────────────────
	console.log("\n── Test 7: Rules persisted under path_scope_rules ──");
	{
		const persisted = (await readPersistedRules(page)) as Array<Record<string, string>> | null;
		const shot = await screenshotSettings(ctx, "07-final-table");
		const ai = persisted?.find((r) => r.path === "ai/");
		const dl = persisted?.find((r) => r.path === "~/Downloads/");

		if (
			persisted?.length === 2 &&
			ai?.read === "allow" &&
			ai?.write === "auto_approve" &&
			dl?.write === "blocked"
		) {
			ctx.pass(
				"Rules persisted under path_scope_rules",
				`settings.path_scope_rules = ${JSON.stringify(persisted)}`,
				shot,
			);
		} else {
			ctx.fail(
				"Rules persisted under path_scope_rules",
				`Unexpected shape: ${JSON.stringify(persisted)}`,
				shot,
			);
		}
	}
}

void runTest(
	{
		name: "path-scoping-table",
		settings: buildDefaultSettings(),
		setupVault: (vaultPath) => writeCleanWorkspace(vaultPath),
	},
	tests,
);
