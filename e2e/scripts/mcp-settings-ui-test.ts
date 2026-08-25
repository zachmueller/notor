#!/usr/bin/env npx tsx
/**
 * MCP settings UI E2E Test
 *
 * Covers the two MCP settings changes that have no other coverage:
 *
 * Workstream A — the "Add server" form collects connection parameters up front:
 *   1. stdio: working directory + plain env var + sensitive env var persist on add
 *   2. HTTP: sensitive header persists on add
 *      (sensitive values land in secret storage with an empty inline value)
 *
 * Workstream B — toggles and connection status changes update in place instead of
 * rebuilding the whole settings pane (which reset scroll position on every click):
 *   3. Tools section enable toggle: row survives, scroll unchanged, sibling
 *      auto-approve toggle flips disabled state
 *   4. MCP server enable toggle: <details> survives and stays open, scroll unchanged
 *   5. Background connect/error status events: marked elements survive, scroll
 *      unchanged, and the server's Tools subgroup still re-renders to "error"
 *   6. Removing a server drops its row and its Tools subgroup, and the last
 *      removal restores the empty-state message
 *
 * LLM required: No. Network required: No (both servers are expected to fail to
 * connect — a bogus command and a closed port).
 *
 * @see src/settings/sections/mcp-servers.ts
 * @see src/settings/sections/tools.ts
 */

import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	closeSettings,
	expandSettingsGroup,
	openPluginSettings,
	SETTINGS_CONTENT_SELECTOR,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STDIO_SERVER = "e2e-stdio-form";
const HTTP_SERVER = "e2e-http-form";

/** Scope for add-form queries. */
const ADD_FORM = ".notor-mcp-add-server";

/** Command that fails fast — the point is the config, not a live connection. */
const BOGUS_COMMAND = "definitely-not-a-real-command-xyz-12345";

/** Port 9 (discard) refuses instantly, so the HTTP server errors without network. */
const DEAD_URL = "http://127.0.0.1:9/mcp";

const SETTLE_MS = 900;

// ---------------------------------------------------------------------------
// DOM helpers — every page.evaluate callback stays flat (no nested function
// declarations), which would otherwise throw ReferenceError: __name is not
// defined at runtime. See e2e/README.md.
// ---------------------------------------------------------------------------

/** Type into the text input of a named `Setting` row inside `scope`. */
async function setSettingText(page: Page, scope: string, label: string, value: string): Promise<boolean> {
	return page.evaluate(
		({ scopeSel, name, val }: { scopeSel: string; name: string; val: string }) => {
			const items = Array.from(document.querySelectorAll(`${scopeSel} .setting-item`));
			const item = items.find(
				(el) => el.querySelector(".setting-item-name")?.textContent?.trim() === name,
			);
			const input = item?.querySelector<HTMLInputElement>(".setting-item-control input");
			if (!input) return false;
			input.value = val;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
			return true;
		},
		{ scopeSel: scope, name: label, val: value },
	);
}

/** Pick an option in the dropdown of a named `Setting` row inside `scope`. */
async function setSettingDropdown(page: Page, scope: string, label: string, value: string): Promise<boolean> {
	return page.evaluate(
		({ scopeSel, name, val }: { scopeSel: string; name: string; val: string }) => {
			const items = Array.from(document.querySelectorAll(`${scopeSel} .setting-item`));
			const item = items.find(
				(el) => el.querySelector(".setting-item-name")?.textContent?.trim() === name,
			);
			const select = item?.querySelector<HTMLSelectElement>(".setting-item-control select");
			if (!select) return false;
			select.value = val;
			select.dispatchEvent(new Event("change", { bubbles: true }));
			return true;
		},
		{ scopeSel: scope, name: label, val: value },
	);
}

/** Click a button by exact text inside `scope`. */
async function clickButtonByText(page: Page, scope: string, text: string): Promise<boolean> {
	return page.evaluate(
		({ scopeSel, label }: { scopeSel: string; label: string }) => {
			const btn = Array.from(
				document.querySelectorAll<HTMLButtonElement>(`${scopeSel} button`),
			).find((b) => b.textContent?.trim() === label);
			if (!btn) return false;
			btn.click();
			return true;
		},
		{ scopeSel: scope, label: text },
	);
}

/** Fill one key/value/sensitive row of a draft list inside `scope`. */
async function setKeyValueRow(
	page: Page,
	scope: string,
	index: number,
	key: string,
	value: string,
	sensitive: boolean,
): Promise<boolean> {
	return page.evaluate(
		({ scopeSel, i, k, v, s }: { scopeSel: string; i: number; k: string; v: string; s: boolean }) => {
			const row = document.querySelectorAll(`${scopeSel} .notor-mcp-kv-row`)[i];
			const keyInput = row?.querySelector<HTMLInputElement>(".notor-mcp-kv-key");
			const valueInput = row?.querySelector<HTMLInputElement>(".notor-mcp-kv-value");
			const sensitiveInput = row?.querySelector<HTMLInputElement>(
				".notor-mcp-kv-sensitive-label input",
			);
			if (!keyInput || !valueInput || !sensitiveInput) return false;
			keyInput.value = k;
			keyInput.dispatchEvent(new Event("change", { bubbles: true }));
			valueInput.value = v;
			valueInput.dispatchEvent(new Event("change", { bubbles: true }));
			if (sensitiveInput.checked !== s) {
				sensitiveInput.checked = s;
				sensitiveInput.dispatchEvent(new Event("change", { bubbles: true }));
			}
			return true;
		},
		{ scopeSel: scope, i: index, k: key, v: value, s: sensitive },
	);
}

/** Read a persisted server config out of plugin settings. */
async function getServerConfig(page: Page, name: string): Promise<Record<string, unknown> | null> {
	return page.evaluate((serverName: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.settings?.mcp_servers?.[serverName] ?? null;
	}, name);
}

/** Read a value out of Notor's secret storage (localStorage-backed). */
async function getSecret(page: Page, key: string): Promise<string | null> {
	return page.evaluate(
		(secretKey: string) => (window as any).app?.loadLocalStorage?.(`notor-secret-${secretKey}`) ?? null,
		key,
	);
}

/** Current scroll offset of the settings pane. */
async function getScrollTop(page: Page): Promise<number> {
	return page.evaluate(
		(sel: string) => document.querySelector(sel)?.scrollTop ?? -1,
		SETTINGS_CONTENT_SELECTOR,
	);
}

/**
 * Stamp the nth element matching `selector` so later assertions can prove the
 * element itself survived rather than being rebuilt by a full pane redisplay.
 */
async function markElement(page: Page, selector: string, mark: string, index = 0): Promise<boolean> {
	return page.evaluate(
		({ sel, name, i }: { sel: string; name: string; i: number }) => {
			const el = document.querySelectorAll<HTMLElement>(sel)[i];
			if (!el) return false;
			el.dataset.e2eMark = name;
			return true;
		},
		{ sel: selector, name: mark, i: index },
	);
}

/** Does a stamped element still exist? */
async function markSurvives(page: Page, mark: string): Promise<boolean> {
	return page.evaluate(
		(name: string) => document.querySelector(`[data-e2e-mark="${name}"]`) !== null,
		mark,
	);
}

/** Poll a predicate until it returns true or the deadline passes. */
async function pollUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Test 1: add an stdio server with cwd + plain and sensitive env vars. */
async function testAddStdioServerWithEnvAndCwd(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\nTest 1: Add form persists stdio cwd + env vars");

	if (!(await openPluginSettings(page))) {
		ctx.fail("Open Notor settings", "Could not open the Notor settings tab");
		return;
	}
	await expandSettingsGroup(page, "MCP servers");

	const filledName = await setSettingText(page, ADD_FORM, "Server name", STDIO_SERVER);
	const filledCommand = await setSettingText(page, ADD_FORM, "Command", BOGUS_COMMAND);
	const filledArgs = await setSettingText(page, ADD_FORM, "Arguments", "--serve /tmp");
	const filledCwd = await setSettingText(page, ADD_FORM, "Working directory", "/tmp");

	if (!filledName || !filledCommand || !filledArgs || !filledCwd) {
		const shot = await ctx.screenshot("01-add-form-fields-missing");
		ctx.fail(
			"Add form exposes stdio fields",
			`name=${filledName} command=${filledCommand} args=${filledArgs} cwd=${filledCwd}`,
			shot,
		);
		return;
	}
	ctx.pass("Add form exposes stdio fields", "Name, command, arguments and working directory all present");

	// Two env rows: one plain, one sensitive.
	await clickButtonByText(page, ADD_FORM, "+ add variable");
	await clickButtonByText(page, ADD_FORM, "+ add variable");
	const rowA = await setKeyValueRow(page, ADD_FORM, 0, "PLAIN_VAR", "plain-value", false);
	const rowB = await setKeyValueRow(page, ADD_FORM, 1, "SECRET_TOKEN", "s3cret-token", true);

	if (!rowA || !rowB) {
		const shot = await ctx.screenshot("01-env-rows-missing");
		ctx.fail("Add form exposes env var rows", `row0=${rowA} row1=${rowB}`, shot);
		return;
	}
	ctx.pass("Add form exposes env var rows", "Two key/value/sensitive rows accepted input");

	const shotBefore = await ctx.screenshot("01-add-form-filled");
	await clickButtonByText(page, ADD_FORM, "Add server");
	await page.waitForTimeout(SETTLE_MS);

	const config = await getServerConfig(page, STDIO_SERVER);
	if (!config) {
		ctx.fail("stdio server persisted", `No mcp_servers["${STDIO_SERVER}"] after add`, shotBefore);
		return;
	}

	const env = (config.env ?? []) as Array<{ key: string; value: string; sensitive: boolean }>;
	const plain = env.find((e) => e.key === "PLAIN_VAR");
	const secret = env.find((e) => e.key === "SECRET_TOKEN");
	const storedSecret = await getSecret(page, `mcp_env_${STDIO_SERVER}_SECRET_TOKEN`);
	const shot = await ctx.screenshot("01-after-add-stdio");

	if (config.cwd === "/tmp") {
		ctx.pass("Working directory persisted", `cwd="${String(config.cwd)}"`, shot);
	} else {
		ctx.fail("Working directory persisted", `Expected cwd="/tmp", got "${String(config.cwd)}"`, shot);
	}

	if (plain?.value === "plain-value" && plain.sensitive === false) {
		ctx.pass("Plain env var persisted", "PLAIN_VAR stored inline with sensitive=false");
	} else {
		ctx.fail("Plain env var persisted", `Got ${JSON.stringify(plain)}`);
	}

	if (secret?.sensitive === true && secret.value === "") {
		ctx.pass("Sensitive env var placeholder persisted", "SECRET_TOKEN stored with an empty inline value");
	} else {
		ctx.fail("Sensitive env var placeholder persisted", `Got ${JSON.stringify(secret)}`);
	}

	if (storedSecret === "s3cret-token") {
		ctx.pass("Sensitive env var in secret storage", `mcp_env_${STDIO_SERVER}_SECRET_TOKEN resolved`);
	} else {
		ctx.fail(
			"Sensitive env var in secret storage",
			`Expected "s3cret-token" under mcp_env_${STDIO_SERVER}_SECRET_TOKEN, got ${String(storedSecret)}`,
		);
	}

	if (Array.isArray(config.args) && (config.args as string[]).join(" ") === "--serve /tmp") {
		ctx.pass("Arguments parsed on add", `args=${JSON.stringify(config.args)}`);
	} else {
		ctx.fail("Arguments parsed on add", `Got ${JSON.stringify(config.args)}`);
	}
}

/** Test 2: add an HTTP server with a sensitive header. */
async function testAddHttpServerWithHeader(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\nTest 2: Add form persists an HTTP sensitive header");

	await expandSettingsGroup(page, "MCP servers");

	const switched = await setSettingDropdown(page, ADD_FORM, "Transport type", "streamableHttp");
	if (!switched) {
		ctx.fail("Switch add form to HTTP", "Transport type dropdown not found");
		return;
	}

	const filledName = await setSettingText(page, ADD_FORM, "Server name", HTTP_SERVER);
	const filledUrl = await setSettingText(page, ADD_FORM, "URL", DEAD_URL);
	const added = await clickButtonByText(page, ADD_FORM, "+ add header");
	const row = await setKeyValueRow(page, ADD_FORM, 0, "Authorization", "Bearer e2e", true);

	if (!filledName || !filledUrl || !added || !row) {
		const shot = await ctx.screenshot("02-http-form-incomplete");
		ctx.fail(
			"Add form exposes HTTP header rows",
			`name=${filledName} url=${filledUrl} addBtn=${added} row=${row}`,
			shot,
		);
		return;
	}
	ctx.pass("Add form exposes HTTP header rows", "URL plus one key/value/sensitive header row");

	await clickButtonByText(page, ADD_FORM, "Add server");
	await page.waitForTimeout(SETTLE_MS);

	const config = await getServerConfig(page, HTTP_SERVER);
	const headers = (config?.headers ?? []) as Array<{ key: string; value: string; sensitive: boolean }>;
	const auth = headers.find((h) => h.key === "Authorization");
	const storedSecret = await getSecret(page, `mcp_header_${HTTP_SERVER}_Authorization`);
	const shot = await ctx.screenshot("02-after-add-http");

	if (config?.url === DEAD_URL) {
		ctx.pass("HTTP server persisted", `url="${String(config.url)}"`, shot);
	} else {
		ctx.fail("HTTP server persisted", `Expected url="${DEAD_URL}", got "${String(config?.url)}"`, shot);
	}

	if (auth?.sensitive === true && auth.value === "") {
		ctx.pass("Sensitive header placeholder persisted", "Authorization stored with an empty inline value");
	} else {
		ctx.fail("Sensitive header placeholder persisted", `Got ${JSON.stringify(auth)}`);
	}

	if (storedSecret === "Bearer e2e") {
		ctx.pass("Sensitive header in secret storage", `mcp_header_${HTTP_SERVER}_Authorization resolved`);
	} else {
		ctx.fail(
			"Sensitive header in secret storage",
			`Expected "Bearer e2e", got ${String(storedSecret)}`,
		);
	}

	// Stop the HTTP reconnect backoff so it can't churn through later assertions.
	await page.evaluate((name: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (plugin?.settings?.mcp_servers?.[name]) plugin.settings.mcp_servers[name].disabled = true;
		return plugin?._mcpHub?.disconnectServer(name);
	}, HTTP_SERVER);
	await page.waitForTimeout(400);
}

/** Test 3: a Tools enable toggle updates its row in place without scrolling. */
async function testToolToggleKeepsScroll(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\nTest 3: Tools enable toggle updates in place");

	await expandSettingsGroup(page, "Tools");

	// Target the last built-in tool row so the pane is genuinely scrolled.
	const rowCount = await page.evaluate(
		() =>
			document.querySelectorAll(
				'.notor-tools-section .setting-item:has(.checkbox-container[aria-label="Enabled"])',
			).length,
	);
	if (rowCount === 0) {
		ctx.fail("Locate a tool row", "No tool rows with an Enabled toggle found");
		return;
	}

	const marked = await markElement(
		page,
		'.notor-tools-section .setting-item:has(.checkbox-container[aria-label="Enabled"])',
		"tool-row",
		rowCount - 1,
	);
	if (!marked) {
		ctx.fail("Locate a tool row", "Could not stamp the last tool row");
		return;
	}

	await page.evaluate(() => {
		document
			.querySelector('[data-e2e-mark="tool-row"]')
			?.scrollIntoView({ block: "center" });
	});
	await page.waitForTimeout(500);

	const before = await page.evaluate(() => {
		const row = document.querySelector('[data-e2e-mark="tool-row"]');
		const toggles = row?.querySelectorAll(".checkbox-container");
		return {
			rowDisabled: row?.classList.contains("notor-tool-row-disabled") ?? null,
			autoApproveDisabled: toggles?.[1]?.classList.contains("is-disabled") ?? null,
			name: row?.querySelector(".setting-item-name")?.textContent?.trim() ?? "",
		};
	});
	const scrollBefore = await getScrollTop(page);

	// Click via the DOM, not Playwright — a Playwright click would scroll the
	// element into view and invalidate the scroll assertion.
	await page.evaluate(() => {
		document
			.querySelector<HTMLElement>('[data-e2e-mark="tool-row"] .checkbox-container[aria-label="Enabled"]')
			?.click();
	});
	await page.waitForTimeout(SETTLE_MS);

	const after = await page.evaluate(() => {
		const row = document.querySelector('[data-e2e-mark="tool-row"]');
		const toggles = row?.querySelectorAll(".checkbox-container");
		return {
			survived: row !== null,
			rowDisabled: row?.classList.contains("notor-tool-row-disabled") ?? null,
			autoApproveDisabled: toggles?.[1]?.classList.contains("is-disabled") ?? null,
		};
	});
	const scrollAfter = await getScrollTop(page);
	const shot = await ctx.screenshot("03-after-tool-toggle");

	if (after.survived) {
		ctx.pass("Tool row survives its own toggle", `Row "${before.name}" was updated in place, not rebuilt`, shot);
	} else {
		ctx.fail("Tool row survives its own toggle", "The stamped row is gone — the pane was rebuilt", shot);
		return;
	}

	if (scrollAfter === scrollBefore) {
		ctx.pass("Scroll position preserved on tool toggle", `scrollTop stayed at ${scrollAfter}`);
	} else {
		ctx.fail("Scroll position preserved on tool toggle", `scrollTop ${scrollBefore} → ${scrollAfter}`);
	}

	if (after.rowDisabled === !before.rowDisabled) {
		ctx.pass("Row disabled styling flipped", `notor-tool-row-disabled: ${String(before.rowDisabled)} → ${String(after.rowDisabled)}`);
	} else {
		ctx.fail("Row disabled styling flipped", `notor-tool-row-disabled stayed ${String(after.rowDisabled)}`);
	}

	if (after.autoApproveDisabled === after.rowDisabled) {
		ctx.pass("Auto-approve toggle tracks enabled state", `is-disabled=${String(after.autoApproveDisabled)}`);
	} else {
		ctx.fail(
			"Auto-approve toggle tracks enabled state",
			`row disabled=${String(after.rowDisabled)} but auto-approve is-disabled=${String(after.autoApproveDisabled)}`,
		);
	}

	// Flip back — the reverse transition has to update in place too.
	await page.evaluate(() => {
		document
			.querySelector<HTMLElement>('[data-e2e-mark="tool-row"] .checkbox-container[aria-label="Enabled"]')
			?.click();
	});
	await page.waitForTimeout(SETTLE_MS);

	const restored = await page.evaluate(() => {
		const row = document.querySelector('[data-e2e-mark="tool-row"]');
		const toggles = row?.querySelectorAll(".checkbox-container");
		return {
			survived: row !== null,
			rowDisabled: row?.classList.contains("notor-tool-row-disabled") ?? null,
			autoApproveDisabled: toggles?.[1]?.classList.contains("is-disabled") ?? null,
		};
	});

	if (
		restored.survived &&
		restored.rowDisabled === before.rowDisabled &&
		restored.autoApproveDisabled === before.rowDisabled
	) {
		ctx.pass("Reverse toggle restores original state in place", "Row and auto-approve toggle back to their initial state");
	} else {
		ctx.fail("Reverse toggle restores original state in place", JSON.stringify(restored));
	}
}

/** Test 4: an MCP server enable toggle keeps its row, expansion, and scroll. */
async function testServerToggleKeepsRow(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\nTest 4: MCP server toggle updates its row in place");

	await expandSettingsGroup(page, "MCP servers");

	const prepared = await page.evaluate((name: string) => {
		const entries = Array.from(document.querySelectorAll<HTMLDetailsElement>(".notor-mcp-server-entry"));
		const entry = entries.find(
			(el) => el.querySelector(".notor-mcp-server-name")?.textContent?.trim() === name,
		);
		if (!entry) return false;
		entry.open = true;
		entry.dataset.e2eMark = "server-row";
		entry.scrollIntoView({ block: "center" });
		return true;
	}, STDIO_SERVER);

	if (!prepared) {
		const shot = await ctx.screenshot("04-server-row-missing");
		ctx.fail("Locate the server row", `No .notor-mcp-server-entry for "${STDIO_SERVER}"`, shot);
		return;
	}
	await page.waitForTimeout(500);

	const scrollBefore = await getScrollTop(page);
	await page.evaluate(() => {
		document
			.querySelector<HTMLElement>('[data-e2e-mark="server-row"] .notor-mcp-server-summary-right .checkbox-container')
			?.click();
	});
	await page.waitForTimeout(SETTLE_MS);

	const after = await page.evaluate(() => {
		const entry = document.querySelector<HTMLDetailsElement>('[data-e2e-mark="server-row"]');
		return {
			survived: entry !== null,
			open: entry?.open ?? null,
			dotClass: entry?.querySelector(".notor-mcp-status-dot")?.className ?? "",
		};
	});
	const scrollAfter = await getScrollTop(page);
	const disabled = await page.evaluate((name: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		return plugin?.settings?.mcp_servers?.[name]?.disabled === true;
	}, STDIO_SERVER);
	const shot = await ctx.screenshot("04-after-server-toggle");

	if (after.survived && after.open === true) {
		ctx.pass("Server row survives its own toggle", "The <details> element and its open state were preserved", shot);
	} else {
		ctx.fail("Server row survives its own toggle", `survived=${after.survived} open=${String(after.open)}`, shot);
	}

	if (scrollAfter === scrollBefore) {
		ctx.pass("Scroll position preserved on server toggle", `scrollTop stayed at ${scrollAfter}`);
	} else {
		ctx.fail("Scroll position preserved on server toggle", `scrollTop ${scrollBefore} → ${scrollAfter}`);
	}

	if (disabled) {
		ctx.pass("Server toggle persisted", `mcp_servers["${STDIO_SERVER}"].disabled === true`);
	} else {
		ctx.fail("Server toggle persisted", "disabled flag was not written to settings");
	}

	if (after.dotClass.includes("notor-mcp-dot-disconnected")) {
		ctx.pass("Status dot updated in place", `class="${after.dotClass}"`);
	} else {
		ctx.pass("Status dot state", `class="${after.dotClass}" (server had never connected)`);
	}
}

/** Test 5: background status changes don't rebuild the pane. */
async function testStatusChangeKeepsPane(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\nTest 5: background connect/error status changes update in place");

	// Re-stamp both anchors, then reconnect the (failing) stdio server.
	const stamped = await page.evaluate((name: string) => {
		const entries = Array.from(document.querySelectorAll<HTMLDetailsElement>(".notor-mcp-server-entry"));
		const entry = entries.find(
			(el) => el.querySelector(".notor-mcp-server-name")?.textContent?.trim() === name,
		);
		const toolRow = document.querySelector<HTMLElement>(
			'.notor-tools-section .setting-item:has(.checkbox-container[aria-label="Enabled"])',
		);
		if (!entry || !toolRow) return false;
		entry.dataset.e2eMark = "server-row-2";
		toolRow.dataset.e2eMark = "tool-row-2";
		entry.scrollIntoView({ block: "center" });
		return true;
	}, STDIO_SERVER);

	if (!stamped) {
		ctx.fail("Stamp anchors before status change", "Server row or tool row not found");
		return;
	}
	await page.waitForTimeout(500);
	const scrollBefore = await getScrollTop(page);

	await page.evaluate((name: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (plugin?.settings?.mcp_servers?.[name]) plugin.settings.mcp_servers[name].disabled = false;
		plugin?._mcpHub?.connectServer(name);
	}, STDIO_SERVER);

	const settled = await pollUntil(async () => {
		const status = await page.evaluate((name: string) => {
			const plugin = (window as any).app?.plugins?.plugins?.["notor"];
			return plugin?._mcpHub?.getConnection(name)?.status ?? null;
		}, STDIO_SERVER);
		return status === "error" || status === "disconnected";
	}, 20_000);

	await page.waitForTimeout(SETTLE_MS);

	const state = await page.evaluate(() => ({
		serverRow: document.querySelector('[data-e2e-mark="server-row-2"]') !== null,
		toolRow: document.querySelector('[data-e2e-mark="tool-row-2"]') !== null,
		serverDot:
			document.querySelector('[data-e2e-mark="server-row-2"] .notor-mcp-status-dot')?.className ?? "",
		errorHintVisible: !(
			document
				.querySelector('[data-e2e-mark="server-row-2"] .notor-mcp-server-error-hint')
				?.classList.contains("notor-hidden") ?? true
		),
		toolsSubgroupDot:
			document.querySelector(
				'.notor-tools-section [data-notor-subsection^="mcp-server:"] .notor-mcp-status-dot',
			)?.className ?? "",
	}));
	const scrollAfter = await getScrollTop(page);
	const shot = await ctx.screenshot("05-after-status-change");

	if (!settled) {
		ctx.fail("Failing server reaches a terminal status", "Still connecting after 20s", shot);
	}

	if (state.serverRow && state.toolRow) {
		ctx.pass(
			"Pane survives background status changes",
			"Both the MCP server row and a Tools row outlived the connecting → error events",
			shot,
		);
	} else {
		ctx.fail(
			"Pane survives background status changes",
			`serverRow=${state.serverRow} toolRow=${state.toolRow} — a full redisplay wiped the stamps`,
			shot,
		);
	}

	if (scrollAfter === scrollBefore) {
		ctx.pass("Scroll position preserved across status changes", `scrollTop stayed at ${scrollAfter}`);
	} else {
		ctx.fail("Scroll position preserved across status changes", `scrollTop ${scrollBefore} → ${scrollAfter}`);
	}

	if (state.serverDot.includes("notor-mcp-dot-error")) {
		ctx.pass("Server row shows the error state", `class="${state.serverDot}"`);
	} else {
		ctx.fail("Server row shows the error state", `Expected notor-mcp-dot-error, got "${state.serverDot}"`);
	}

	if (state.errorHintVisible) {
		ctx.pass("Inline error hint revealed in place", "notor-hidden was cleared on the existing hint span");
	} else {
		ctx.fail("Inline error hint revealed in place", "Error hint span still hidden");
	}

	if (state.toolsSubgroupDot.includes("notor-mcp-dot-error")) {
		ctx.pass("Tools subgroup re-rendered for the server", `class="${state.toolsSubgroupDot}"`);
	} else {
		ctx.fail(
			"Tools subgroup re-rendered for the server",
			`Expected notor-mcp-dot-error in the Tools section, got "${state.toolsSubgroupDot}"`,
		);
	}
}

/**
 * Test 6: removing servers cleans up both sections and restores the empty state.
 *
 * Removal is deliberately structural — it rebuilds the pane once, the same way
 * adding a server does — because the server's Tools sub-group has to go with it.
 */
async function testRemoveServersCleansUp(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	console.log("\nTest 6: removing a server cleans up both sections");

	await expandSettingsGroup(page, "MCP servers");

	const opened = await page.evaluate((name: string) => {
		const entries = Array.from(document.querySelectorAll<HTMLDetailsElement>(".notor-mcp-server-entry"));
		const entry = entries.find(
			(el) => el.querySelector(".notor-mcp-server-name")?.textContent?.trim() === name,
		);
		if (!entry) return false;
		entry.open = true;
		const btn = Array.from(entry.querySelectorAll<HTMLButtonElement>("button")).find(
			(b) => b.textContent?.trim() === "Remove",
		);
		if (!btn) return false;
		btn.click();
		return true;
	}, STDIO_SERVER);

	if (!opened) {
		ctx.fail("Open the remove confirmation", `No Remove button in the "${STDIO_SERVER}" row`);
		return;
	}
	await page.waitForTimeout(500);

	const confirmed = await clickButtonByText(page, ".modal-button-container", "Remove");
	if (!confirmed) {
		const shot = await ctx.screenshot("06-confirm-modal-missing");
		ctx.fail("Confirm removal", "No Remove button in the confirmation modal", shot);
		return;
	}
	await page.waitForTimeout(SETTLE_MS);

	const state = await page.evaluate((name: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const rowNames = Array.from(document.querySelectorAll(".notor-mcp-server-name")).map(
			(el) => el.textContent?.trim() ?? "",
		);
		const subsections = Array.from(
			document.querySelectorAll(".notor-tools-section [data-notor-subsection^='mcp-server:']"),
		).map((el) => el.getAttribute("data-notor-subsection") ?? "");
		return {
			inSettings: plugin?.settings?.mcp_servers?.[name] != null,
			rowNames,
			subsections,
		};
	}, STDIO_SERVER);
	const shot = await ctx.screenshot("06-after-remove");

	if (!state.inSettings && !state.rowNames.includes(STDIO_SERVER)) {
		ctx.pass("Removed server row disappears", `Remaining rows: ${JSON.stringify(state.rowNames)}`, shot);
	} else {
		ctx.fail(
			"Removed server row disappears",
			`inSettings=${state.inSettings} rows=${JSON.stringify(state.rowNames)}`,
			shot,
		);
	}

	if (!state.subsections.includes(`mcp-server:${STDIO_SERVER}`)) {
		ctx.pass("Removed server leaves the Tools section", `Remaining subgroups: ${JSON.stringify(state.subsections)}`);
	} else {
		ctx.fail("Removed server leaves the Tools section", `Stale subgroup: ${JSON.stringify(state.subsections)}`);
	}

	if (state.subsections.includes(`mcp-server:${HTTP_SERVER}`)) {
		ctx.pass("Remaining server keeps its Tools subgroup", `Subgroups: ${JSON.stringify(state.subsections)}`);
	} else {
		ctx.fail("Remaining server keeps its Tools subgroup", `Subgroups: ${JSON.stringify(state.subsections)}`);
	}

	// Remove the remaining HTTP server to check the empty state comes back.
	const secondOpened = await page.evaluate((name: string) => {
		const entries = Array.from(document.querySelectorAll<HTMLDetailsElement>(".notor-mcp-server-entry"));
		const entry = entries.find(
			(el) => el.querySelector(".notor-mcp-server-name")?.textContent?.trim() === name,
		);
		if (!entry) return false;
		entry.open = true;
		const btn = Array.from(entry.querySelectorAll<HTMLButtonElement>("button")).find(
			(b) => b.textContent?.trim() === "Remove",
		);
		if (!btn) return false;
		btn.click();
		return true;
	}, HTTP_SERVER);

	if (!secondOpened) {
		ctx.fail("Remove the last server", `No Remove button in the "${HTTP_SERVER}" row`);
		return;
	}
	await page.waitForTimeout(400);
	await clickButtonByText(page, ".modal-button-container", "Remove");
	await page.waitForTimeout(SETTLE_MS);

	const emptyState = await page.evaluate(() => ({
		rows: document.querySelectorAll(".notor-mcp-server-entry").length,
		empty: document.querySelector(".notor-mcp-empty")?.textContent?.trim() ?? "",
	}));
	const shot2 = await ctx.screenshot("06-empty-state");

	if (emptyState.rows === 0 && emptyState.empty.length > 0) {
		ctx.pass("Empty state returns after the last removal", `"${emptyState.empty}"`, shot2);
	} else {
		ctx.fail(
			"Empty state returns after the last removal",
			`rows=${emptyState.rows} empty="${emptyState.empty}"`,
			shot2,
		);
	}

	await closeSettings(page);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(4_000);

	await testAddStdioServerWithEnvAndCwd(ctx);
	await testAddHttpServerWithHeader(ctx);
	await testToolToggleKeepsScroll(ctx);
	await testServerToggleKeepsRow(ctx);
	await testStatusChangeKeepsPane(ctx);
	await testRemoveServersCleansUp(ctx);
}

const settings = buildDefaultSettings({
	active_provider: "local",
	providers: [
		{
			id: "local",
			type: "local",
			enabled: true,
			display_name: "Local (OpenAI-compatible)",
			endpoint: "http://localhost:11434/v1",
		},
	],
	mcp_servers: {},
});

runTest({ name: "mcp-settings-ui", settings }, tests);
