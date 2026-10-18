#!/usr/bin/env npx tsx
/**
 * Guided Setup Wizard E2E Test
 *
 * Validates the first-run "Get started with Notor" banner at the top of the
 * settings tab and the guided setup modal it opens, against a real (local,
 * in-test) OpenAI-compatible server that serves a model list.
 *
 * Scenarios:
 *   1. Fresh-install settings (empty local endpoint, no presets) show the banner.
 *   2. Wizard flow: Providers → Local → endpoint → Model step lists the mock
 *      model → pick it for the default preset → Done checklist all ✓ → Finish
 *      closes the modal and the banner disappears.
 *   3. Reopening settings keeps the banner hidden, and the endpoint/preset persisted.
 *   4. Clearing the endpoint and preset brings the banner back (no one-time flag).
 *   5. "Configure MCP servers →" closes the wizard and opens the MCP servers group.
 *
 * @see ai/notor/ideas/Initial setup flow for new users.md
 * @see src/settings/setup-detection.ts, src/ui/setup-wizard/
 */

import * as http from "node:http";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	closeSettings,
	openPluginSettings,
	SETTINGS_CONTENT_SELECTOR,
	waitForSelector,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

/** Fixed port so the endpoint typed into the wizard is known up front. */
const MOCK_PORT = 18_735;
const MOCK_ENDPOINT = `http://127.0.0.1:${MOCK_PORT}/v1`;
const MOCK_MODEL = "mock-setup-model";

const BANNER_SELECTOR = `${SETTINGS_CONTENT_SELECTOR} .notor-setup-banner`;
const WIZARD_SELECTOR = ".modal.notor-setup-wizard";
const WIZARD_BODY_SELECTOR = `${WIZARD_SELECTOR} .notor-setup-wizard-body`;
/** Obsidian 1.12 renders a hidden `.is-measuring` twin beside each dropdown. */
const WIZARD_SELECT_SELECTOR = `${WIZARD_BODY_SELECTOR} select.dropdown:not(.is-measuring)`;
const WIZARD_NEXT_SELECTOR = `${WIZARD_SELECTOR} .notor-setup-wizard-footer button.mod-cta`;

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const UNCONFIGURED_PRESETS = ["tiny", "small", "medium", "large"].map((name) => ({
	name, provider_id: null, model_id: null, use_extended_context: false, thinking_level: null,
}));

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible server (model listing only)
// ---------------------------------------------------------------------------

function startMockServer(): http.Server {
	const srv = http.createServer((req, res) => {
		if (req.method === "OPTIONS") {
			res.writeHead(204, CORS_HEADERS);
			res.end();
			return;
		}
		if (req.url?.endsWith("/models")) {
			res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: MOCK_MODEL, object: "model" }] }));
			return;
		}
		res.writeHead(404, CORS_HEADERS);
		res.end();
	});
	srv.listen(MOCK_PORT, "127.0.0.1");
	return srv;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

async function isBannerVisible(page: Page): Promise<boolean> {
	return (await page.$(BANNER_SELECTOR)) !== null;
}

async function getWizardProgress(page: Page): Promise<string> {
	return page.evaluate((sel: string) => {
		return document.querySelector(sel)?.textContent?.trim() ?? "";
	}, `${WIZARD_SELECTOR} .notor-setup-wizard-progress`);
}

/** Click Next (or Finish) `times` times. */
async function clickNext(page: Page, times = 1): Promise<void> {
	for (let i = 0; i < times; i++) {
		await page.click(WIZARD_NEXT_SELECTOR);
		await page.waitForTimeout(400);
	}
}

/** Open the wizard from the banner; returns false if the modal didn't appear. */
async function openWizard(page: Page): Promise<boolean> {
	await page.click(`${BANNER_SELECTOR} button.mod-cta`);
	return (await waitForSelector(page, WIZARD_SELECTOR, 5_000)) !== null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testBannerOnFreshInstall(ctx: TestContext): Promise<boolean> {
	console.log("\nTest 1: Banner shows on fresh-install settings");
	const { page } = ctx;

	if (!(await openPluginSettings(page))) {
		ctx.fail("Open settings", "app.setting API unavailable");
		return false;
	}
	// Outlast the Keychain re-check timers (100/500/1500 ms) so a pass means
	// the banner really stays.
	await page.waitForTimeout(1_800);
	const shot = await ctx.screenshot("01-banner");

	if (!(await isBannerVisible(page))) {
		ctx.fail("Banner visible on fresh install", `No ${BANNER_SELECTOR} (${shot})`);
		return false;
	}
	const isFirst = await page.evaluate((scopeSel: string) => {
		const scope = document.querySelector(scopeSel);
		return scope?.firstElementChild?.classList.contains("notor-setup-banner-slot") ?? false;
	}, SETTINGS_CONTENT_SELECTOR);
	ctx.pass("Banner visible on fresh install", `Rendered above General: ${isFirst} (${shot})`);
	return true;
}

async function testWizardFlow(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Wizard configures a provider and the default preset");
	const { page } = ctx;

	if (!(await openWizard(page))) {
		ctx.fail("Wizard opens from banner", "Modal .notor-setup-wizard did not appear");
		return;
	}
	ctx.pass("Wizard opens from banner", await getWizardProgress(page));

	// --- Providers step: pick Local and enter the endpoint ---
	await clickNext(page);
	const providersProgress = await getWizardProgress(page);
	if (!providersProgress.includes("Providers")) {
		ctx.fail("Providers step", `Unexpected progress: "${providersProgress}"`);
		return;
	}
	await page.locator(WIZARD_SELECT_SELECTOR).first().selectOption("local");
	const endpointInput = `${WIZARD_BODY_SELECTOR} .notor-setup-wizard-provider input[type="text"]`;
	if (!(await waitForSelector(page, endpointInput, 5_000))) {
		ctx.fail("Local provider form renders", `No endpoint input (${await ctx.screenshot("02-providers-fail")})`);
		return;
	}
	await page.fill(endpointInput, MOCK_ENDPOINT);
	await page.press(endpointInput, "Tab"); // commit → change event
	await page.waitForTimeout(800);
	ctx.pass("Local provider form renders", `Endpoint set (${await ctx.screenshot("02-providers")})`);

	const warningVisible = await page.evaluate((sel: string) => {
		const el = document.querySelector(`${sel} .notor-setup-wizard-provider-warning`) as HTMLElement | null;
		return !!el && el.offsetParent !== null;
	}, WIZARD_BODY_SELECTOR);
	if (warningVisible) {
		ctx.fail("Not-configured warning clears", "Warning still visible after entering an endpoint");
	} else {
		ctx.pass("Not-configured warning clears", "Warning hidden once the endpoint is committed");
	}

	// --- Model step: pick the mock model for the default preset ---
	await clickNext(page);
	const modelProgress = await getWizardProgress(page);
	if (!modelProgress.includes("Model")) {
		ctx.fail("Model step", `Unexpected progress: "${modelProgress}"`);
		return;
	}
	const providerOptions = await page.evaluate((sel: string) => {
		const select = document.querySelector(sel) as HTMLSelectElement | null;
		return Array.from(select?.options ?? []).map((o) => o.value).filter((v) => v);
	}, WIZARD_SELECT_SELECTOR);
	if (providerOptions.length !== 1 || providerOptions[0] !== "local") {
		ctx.fail("Model step lists only configured providers", `Options: ${JSON.stringify(providerOptions)}`);
	} else {
		ctx.pass("Model step lists only configured providers", "Only the configured local provider is offered");
	}

	await page.locator(WIZARD_SELECT_SELECTOR).first().selectOption("local");
	const modelOption = `${WIZARD_SELECT_SELECTOR} option[value="${MOCK_MODEL}"]`;
	// <option> elements inside a closed <select> never count as visible.
	const optionAttached = await page
		.waitForSelector(modelOption, { state: "attached", timeout: 10_000 })
		.then(() => true, () => false);
	if (!optionAttached) {
		ctx.fail("Model list loads from provider", `No ${MOCK_MODEL} option (${await ctx.screenshot("03-model-fail")})`);
		return;
	}
	await page.locator(WIZARD_SELECT_SELECTOR).nth(1).selectOption(MOCK_MODEL);
	await page.waitForTimeout(600);
	const readyText = await page.evaluate((sel: string) => {
		return document.querySelector(`${sel} .notor-setup-wizard-check.is-done`)?.textContent ?? "";
	}, WIZARD_BODY_SELECTOR);
	const modelShot = await ctx.screenshot("03-model");
	if (!readyText.includes("ready")) {
		ctx.fail("Default preset configured", `No ready confirmation (${modelShot})`);
		return;
	}
	ctx.pass("Default preset configured", `${readyText.trim()} (${modelShot})`);

	// --- Safety, Workspace, MCP → Done ---
	await clickNext(page, 4);
	const doneProgress = await getWizardProgress(page);
	const checklist = await page.evaluate((sel: string) => {
		return {
			done: document.querySelectorAll(`${sel} .notor-setup-wizard-check.is-done`).length,
			missing: document.querySelectorAll(`${sel} .notor-setup-wizard-check.is-missing`).length,
		};
	}, WIZARD_BODY_SELECTOR);
	const doneShot = await ctx.screenshot("04-done");
	if (!doneProgress.includes("Done") || checklist.done !== 3 || checklist.missing !== 0) {
		ctx.fail("Done checklist all complete", `"${doneProgress}" ${JSON.stringify(checklist)} (${doneShot})`);
	} else {
		ctx.pass("Done checklist all complete", `3 ✓ items (${doneShot})`);
	}

	// --- Finish → modal closes, banner gone ---
	await clickNext(page);
	await page.waitForTimeout(800);
	const wizardOpen = (await page.$(WIZARD_SELECTOR)) !== null;
	const bannerVisible = await isBannerVisible(page);
	const finishShot = await ctx.screenshot("05-after-finish");
	if (wizardOpen || bannerVisible) {
		ctx.fail("Finish closes wizard and clears banner", `wizardOpen=${wizardOpen} bannerVisible=${bannerVisible} (${finishShot})`);
	} else {
		ctx.pass("Finish closes wizard and clears banner", finishShot);
	}
}

async function testPersistedAfterReopen(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Setup persists across reopening settings");
	const { page } = ctx;

	await closeSettings(page);
	await openPluginSettings(page);
	await page.waitForTimeout(1_800);

	const state = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const local = plugin?.settings?.providers?.find((p: any) => p.id === "local");
		const preset = plugin?.settings?.model_presets?.find((p: any) => p.name === plugin.settings.default_preset);
		return { endpoint: local?.endpoint ?? null, enabled: local?.enabled ?? null, presetProvider: preset?.provider_id ?? null, presetModel: preset?.model_id ?? null };
	});

	if (state.endpoint !== MOCK_ENDPOINT || state.presetProvider !== "local" || state.presetModel !== MOCK_MODEL) {
		ctx.fail("Wizard changes persisted", JSON.stringify(state));
	} else {
		ctx.pass("Wizard changes persisted", JSON.stringify(state));
	}

	if (await isBannerVisible(page)) {
		ctx.fail("Banner stays hidden after reopen", await ctx.screenshot("06-reopen-fail"));
	} else {
		ctx.pass("Banner stays hidden after reopen", "No banner once a provider is configured");
	}
}

async function testBannerResurfaces(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Banner returns when configuration is cleared");
	const { page } = ctx;

	await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		const local = plugin.settings.providers.find((p: any) => p.id === "local");
		local.endpoint = "";
		for (const preset of plugin.settings.model_presets) {
			preset.provider_id = null;
			preset.model_id = null;
		}
		await plugin.saveSettings();
		plugin._settingTab?.display();
	});
	await page.waitForTimeout(1_800);

	const shot = await ctx.screenshot("07-resurfaced");
	if (await isBannerVisible(page)) {
		ctx.pass("Banner resurfaces after clearing setup", shot);
	} else {
		ctx.fail("Banner resurfaces after clearing setup", `No banner (${shot})`);
	}
}

async function testOpenInSettingsLink(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Wizard link opens the MCP servers group");
	const { page } = ctx;

	if (!(await isBannerVisible(page)) || !(await openWizard(page))) {
		ctx.fail("Open wizard for link test", "Banner or wizard unavailable");
		return;
	}
	// Collapse the group first so the assertion proves the link opened it.
	await page.evaluate((scopeSel: string) => {
		const details = document.querySelector(`${scopeSel} details[data-notor-group="MCP servers"]`) as HTMLDetailsElement | null;
		if (details) details.open = false;
	}, SETTINGS_CONTENT_SELECTOR);

	await clickNext(page, 5);
	const progress = await getWizardProgress(page);
	if (!progress.includes("MCP servers")) {
		ctx.fail("Reach MCP step", `Unexpected progress: "${progress}"`);
		return;
	}
	await page.click(`${WIZARD_BODY_SELECTOR} button:has-text("Configure MCP servers")`);
	await page.waitForTimeout(1_500);

	const result = await page.evaluate((scopeSel: string) => {
		const details = document.querySelector(`${scopeSel} details[data-notor-group="MCP servers"]`) as HTMLDetailsElement | null;
		const rect = details?.getBoundingClientRect();
		return {
			wizardOpen: document.querySelector(".modal.notor-setup-wizard") !== null,
			groupOpen: details?.open ?? false,
			inView: !!rect && rect.top < window.innerHeight && rect.bottom > 0,
		};
	}, SETTINGS_CONTENT_SELECTOR);
	const shot = await ctx.screenshot("08-mcp-link");

	if (result.wizardOpen || !result.groupOpen || !result.inView) {
		ctx.fail("MCP link closes wizard and opens group", `${JSON.stringify(result)} (${shot})`);
	} else {
		ctx.pass("MCP link closes wizard and opens group", shot);
	}
}

async function testNoWizardErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: No wizard errors logged");
	const errors = ctx.collector
		.getLogsByLevel("error")
		.filter((e) => ["SetupWizard", "ModelPresetsSection", "Secrets"].includes(e.source));
	if (errors.length > 0) {
		ctx.fail("No wizard errors logged", JSON.stringify(errors.slice(0, 3)));
	} else {
		ctx.pass("No wizard errors logged", "No error-level logs from wizard sources");
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const srv = startMockServer();
	try {
		await ctx.page.waitForTimeout(5_000); // Wait for plugin init
		if (!(await testBannerOnFreshInstall(ctx))) return;
		await testWizardFlow(ctx);
		// An early failure leaves the wizard open over the settings tab.
		if (await ctx.page.$(WIZARD_SELECTOR)) await ctx.page.keyboard.press("Escape");
		await testPersistedAfterReopen(ctx);
		await testBannerResurfaces(ctx);
		await testOpenInSettingsLink(ctx);
		await testNoWizardErrors(ctx);
	} finally {
		await closeSettings(ctx.page);
		srv.close();
	}
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

/** Mirror a fresh install: seeded providers, empty local endpoint, no presets. */
const settings = buildDefaultSettings({
	active_provider: "local",
	providers: [
		{ id: "local", type: "local", enabled: true, display_name: "Local (OpenAI-compatible)", endpoint: "" },
		{ id: "anthropic", type: "anthropic", enabled: false, display_name: "Anthropic", endpoint: "https://api.anthropic.com" },
		{ id: "openai", type: "openai", enabled: false, display_name: "OpenAI", endpoint: "https://api.openai.com" },
		{ id: "bedrock", type: "bedrock", enabled: false, display_name: "AWS Bedrock", aws_auth_method: "profile", aws_profile: "default" },
	],
	model_presets: UNCONFIGURED_PRESETS,
	default_preset: "medium",
	model_context_overrides: { [MOCK_MODEL]: 128_000 },
});

runTest({ name: "setup-wizard", settings }, tests);
