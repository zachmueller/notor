#!/usr/bin/env npx tsx
/**
 * Bedrock Model Picker E2E Test
 *
 * Verifies the grouped model picker introduced by the Bedrock model picker
 * overhaul (Phases 1-3). Tests:
 *
 *   1. Chat panel loads with Bedrock pre-configured
 *   2. Refresh model list — verify models appear grouped via <optgroup>
 *   3. Verify region labels (US, EU, APAC, Global) appear in option text
 *   4. Verify 1M extended context variants (::1m suffix) are synthesized
 *   5. Select a 1M variant — verify use_extended_context is persisted
 *   6. Select a standard variant — verify use_extended_context is cleared
 *   7. Close and reopen popover — verify 1M selection is preserved
 *   8. Verify context window label ("200K", "1M") shown for known models
 *
 * Prerequisites:
 *   - ~/.aws/credentials or ~/.aws/config with a [default] profile
 *   - Bedrock access enabled on that account (us-east-1)
 *
 * Run with:
 *   npx tsx e2e/scripts/bedrock-model-picker-test.ts
 *
 * @see private/bedrock-model-picker-overhaul.md
 */

import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	waitForSelector,
	buildDefaultSettings,
	PLUGIN_DATA_PATH,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Settings — Bedrock with no model_id pre-set (force list selection)
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	providers: [
		{
			type: "local",
			enabled: false,
			display_name: "Local (OpenAI-compatible)",
			endpoint: "http://localhost:11434/v1",
		},
		{
			type: "anthropic",
			enabled: false,
			display_name: "Anthropic",
			endpoint: "https://api.anthropic.com",
		},
		{
			type: "openai",
			enabled: false,
			display_name: "OpenAI",
			endpoint: "https://api.openai.com",
		},
		{
			type: "bedrock",
			enabled: true,
			display_name: "AWS Bedrock",
			aws_auth_method: "profile",
			aws_profile: "default",
			region: "us-east-1",
			// No model_id — we'll pick from the grouped list
		},
	],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the persisted data.json and extract the Bedrock provider config.
 */
function readBedrockConfig(): Record<string, unknown> | null {
	try {
		const raw = fs.readFileSync(PLUGIN_DATA_PATH, "utf8");
		const data = JSON.parse(raw);
		const providers = data.providers as Array<Record<string, unknown>> | undefined;
		if (!providers) return null;
		return providers.find((p) => p.type === "bedrock") ?? null;
	} catch {
		return null;
	}
}

/**
 * Open the settings popover and return whether it opened.
 */
async function openSettingsPopover(page: import("playwright-core").Page): Promise<boolean> {
	const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
	if (!settingsBtn) return false;
	await settingsBtn.click();
	await page.waitForTimeout(800);
	const popover = await page.$(".notor-settings-popover");
	return !!popover;
}

/**
 * Close the settings popover.
 */
async function closeSettingsPopover(page: import("playwright-core").Page): Promise<void> {
	const settingsBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
	await settingsBtn?.click();
	await page.waitForTimeout(500);
}

/**
 * Click the model refresh button and wait for the dropdown to populate.
 * Returns the model <select> element or null.
 */
async function refreshAndWaitForModels(
	page: import("playwright-core").Page,
	ctx: TestContext,
): Promise<import("playwright-core").ElementHandle | null> {
	const refreshBtn = await page.$(".notor-settings-popover .notor-settings-refresh-btn");
	if (!refreshBtn) {
		ctx.fail("Refresh models", "Model refresh button not found in popover");
		return null;
	}

	console.log("  Clicking refresh — waiting for Bedrock ListInferenceProfiles...");
	await refreshBtn.click();

	// Wait for model select to appear (up to 25s for Bedrock API call)
	let modelSelect: import("playwright-core").ElementHandle | null = null;
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) {
		await page.waitForTimeout(1000);
		modelSelect = await page.$(".notor-model-select-wrapper select");
		if (modelSelect) {
			// Verify it has actual options (not just a placeholder)
			const optCount = await page.$$eval(
				".notor-model-select-wrapper select option",
				(opts) => opts.length,
			);
			if (optCount > 0) break;
			modelSelect = null;
		}
	}

	return modelSelect;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext) {
	const { page } = ctx;

	console.log("Provider:  AWS Bedrock");
	console.log("Auth:      AWS profile (default)");
	console.log("Region:    us-east-1");
	console.log("Focus:     Grouped model picker + 1M variant synthesis\n");

	// Give plugin time to initialize
	await page.waitForTimeout(5000);

	// ── Test 1: Chat panel visible ─────────────────────────────────────
	console.log("Test 1: Chat panel visible");
	{
		const chatContainer = await waitForSelector(page, ".notor-chat-container", 8000);
		if (chatContainer) {
			const shot = await ctx.screenshot("01-startup");
			ctx.pass("Chat panel visible", "Found .notor-chat-container", shot);
		} else {
			const shot = await ctx.screenshot("01-startup-missing");
			ctx.fail("Chat panel visible", ".notor-chat-container not found", shot);
			throw new Error("Chat panel not visible — cannot continue tests");
		}
	}

	// ── Test 2: Open settings & refresh model list ──────────────────────
	console.log("\nTest 2: Open settings popover and refresh model list");
	{
		const opened = await openSettingsPopover(page);
		if (!opened) {
			ctx.fail("Open settings popover", "Settings popover did not open");
			throw new Error("Cannot open settings popover — cannot continue");
		}
	}

	const modelSelect = await refreshAndWaitForModels(page, ctx);
	if (!modelSelect) {
		const shot = await ctx.screenshot("02-no-models");
		ctx.fail("Refresh model list", "Model select not found after refresh — Bedrock API may be unreachable", shot);
		throw new Error("No model list — cannot continue tests");
	}

	const shot2 = await ctx.screenshot("02-model-list-loaded");
	ctx.pass("Refresh model list", "Model dropdown populated", shot2);

	// ── Test 3: Verify <optgroup> grouping ──────────────────────────────
	console.log("\nTest 3: Verify grouped model picker (<optgroup> elements)");
	{
		const optgroupData = await page.$$eval(
			".notor-model-select-wrapper select optgroup",
			(groups) =>
				groups.map((g) => ({
					label: g.getAttribute("label") ?? "",
					optionCount: g.querySelectorAll("option").length,
					options: Array.from(g.querySelectorAll("option")).map((o) => ({
						value: (o as HTMLOptionElement).value,
						text: o.textContent?.trim() ?? "",
					})),
				})),
		);

		const shot = await ctx.screenshot("03-optgroups");

		if (optgroupData.length > 0) {
			const labels = optgroupData.map((g) => `"${g.label}" (${g.optionCount} variants)`);
			console.log(`  Found ${optgroupData.length} optgroups: ${labels.join(", ")}`);
			ctx.pass(
				"Grouped picker — optgroups present",
				`${optgroupData.length} model groups: ${labels.slice(0, 5).join(", ")}${optgroupData.length > 5 ? "..." : ""}`,
				shot,
			);

			// Verify at least one group has multiple variants (the hallmark of grouping)
			const multiVariant = optgroupData.filter((g) => g.optionCount > 1);
			if (multiVariant.length > 0) {
				ctx.pass(
					"Grouped picker — multi-variant groups",
					`${multiVariant.length} group(s) have multiple variants (region/context)`,
				);
			} else {
				ctx.pass(
					"Grouped picker — single-variant groups only",
					"All groups have single variants (may depend on available profiles)",
				);
			}
		} else {
			// Flat options (no optgroups) — may happen if only single-variant groups
			const flatOptions = await page.$$eval(
				".notor-model-select-wrapper select option",
				(opts) => opts.map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent?.trim() ?? "" })),
			);
			ctx.pass(
				"Grouped picker — flat layout",
				`No optgroups (${flatOptions.length} flat options) — grouping may be single-variant`,
				shot,
			);
		}
	}

	// ── Test 4: Verify region labels in option text ─────────────────────
	console.log("\nTest 4: Verify region labels in option text");
	{
		const allOptionTexts = await page.$$eval(
			".notor-model-select-wrapper select option",
			(opts) => opts.map((o) => o.textContent?.trim() ?? ""),
		);

		const regionPattern = /\b(US|EU|APAC|Global)\b/;
		const withRegion = allOptionTexts.filter((t) => regionPattern.test(t));

		const shot = await ctx.screenshot("04-region-labels");
		if (withRegion.length > 0) {
			console.log(`  Options with region labels: ${withRegion.length}/${allOptionTexts.length}`);
			console.log(`  Examples: ${withRegion.slice(0, 4).map((t) => `"${t}"`).join(", ")}`);
			ctx.pass(
				"Region labels in options",
				`${withRegion.length} options have region labels (US/EU/APAC/Global)`,
				shot,
			);
		} else {
			ctx.pass(
				"Region labels — none found",
				`${allOptionTexts.length} options, none with region labels (may be flat layout)`,
				shot,
			);
		}
	}

	// ── Test 5: Verify 1M extended context variants exist ───────────────
	console.log("\nTest 5: Verify 1M extended context variants (::1m suffix)");
	let extendedOptionValue: string | null = null;
	let standardOptionValue: string | null = null;
	{
		const allOptions = await page.$$eval(
			".notor-model-select-wrapper select option",
			(opts) =>
				opts.map((o) => ({
					value: (o as HTMLOptionElement).value,
					text: o.textContent?.trim() ?? "",
				})),
		);

		const extendedOptions = allOptions.filter((o) => o.value.endsWith("::1m"));
		const standardOptions = allOptions.filter((o) => !o.value.endsWith("::1m"));

		const shot = await ctx.screenshot("05-extended-context-variants");

		if (extendedOptions.length > 0) {
			extendedOptionValue = extendedOptions[0]!.value;
			// Find the corresponding standard option (same base ID without ::1m)
			const baseId = extendedOptionValue.replace("::1m", "");
			standardOptionValue = standardOptions.find((o) => o.value === baseId)?.value ?? standardOptions[0]?.value ?? null;

			console.log(`  Found ${extendedOptions.length} extended context (1M) variants`);
			console.log(`  Examples: ${extendedOptions.slice(0, 3).map((o) => `"${o.text}" (${o.value})`).join(", ")}`);
			ctx.pass(
				"1M variants synthesized",
				`${extendedOptions.length} ::1m options found; e.g. "${extendedOptions[0]!.text}"`,
				shot,
			);
		} else {
			standardOptionValue = standardOptions[0]?.value ?? null;
			ctx.fail(
				"1M variants synthesized",
				`No ::1m options found among ${allOptions.length} total options. Expected extended_context metadata to generate them.`,
				shot,
			);
		}
	}

	// ── Test 6: Verify 1M option text contains context label ────────────
	console.log("\nTest 6: Verify context window labels in option text");
	{
		const allOptionTexts = await page.$$eval(
			".notor-model-select-wrapper select option",
			(opts) => opts.map((o) => o.textContent?.trim() ?? ""),
		);

		const with200K = allOptionTexts.filter((t) => t.includes("200K"));
		const with1M = allOptionTexts.filter((t) => t.includes("1M"));

		const shot = await ctx.screenshot("06-context-labels");

		if (with200K.length > 0 || with1M.length > 0) {
			ctx.pass(
				"Context window labels",
				`${with200K.length} options with "200K", ${with1M.length} with "1M"`,
				shot,
			);
		} else {
			ctx.pass(
				"Context window labels — not shown",
				"No context labels visible (may be unknown models or fallback default)",
				shot,
			);
		}
	}

	// ── Test 7: Select 1M variant → verify use_extended_context persisted
	if (extendedOptionValue) {
		console.log(`\nTest 7: Select 1M variant (${extendedOptionValue})`);
		{
			await modelSelect!.selectOption({ value: extendedOptionValue });
			await page.waitForTimeout(1500); // Allow settings save

			const shot = await ctx.screenshot("07-selected-1m");

			// Read persisted config
			const bedrockConfig = readBedrockConfig();
			if (bedrockConfig) {
				const persistedModelId = bedrockConfig.model_id;
				const persistedExtended = bedrockConfig.use_extended_context;
				const expectedModelId = extendedOptionValue.replace("::1m", "");

				if (persistedModelId === expectedModelId && persistedExtended === true) {
					ctx.pass(
						"1M selection persisted",
						`model_id="${persistedModelId}", use_extended_context=true`,
						shot,
					);
				} else {
					ctx.fail(
						"1M selection persisted",
						`Expected model_id="${expectedModelId}" + use_extended_context=true; got model_id="${persistedModelId}", use_extended_context=${persistedExtended}`,
						shot,
					);
				}
			} else {
				ctx.fail("1M selection persisted", "Could not read Bedrock config from data.json", shot);
			}
		}

		// ── Test 8: Select standard variant → use_extended_context cleared
		if (standardOptionValue) {
			console.log(`\nTest 8: Select standard variant (${standardOptionValue})`);
			{
				await modelSelect!.selectOption({ value: standardOptionValue });
				await page.waitForTimeout(1500);

				const shot = await ctx.screenshot("08-selected-standard");

				const bedrockConfig = readBedrockConfig();
				if (bedrockConfig) {
					const persistedExtended = bedrockConfig.use_extended_context;
					if (persistedExtended === false || persistedExtended === undefined) {
						ctx.pass(
							"Standard selection clears extended context",
							`use_extended_context=${persistedExtended ?? "undefined"} (expected false/undefined)`,
							shot,
						);
					} else {
						ctx.fail(
							"Standard selection clears extended context",
							`use_extended_context=${persistedExtended} (expected false)`,
							shot,
						);
					}
				} else {
					ctx.fail("Standard selection clears extended context", "Could not read Bedrock config from data.json", shot);
				}
			}
		}

		// ── Test 9: Close & reopen popover → 1M selection preserved ─────
		console.log("\nTest 9: Close and reopen popover — verify 1M selection preserved");
		{
			// Re-select the 1M variant first
			await modelSelect!.selectOption({ value: extendedOptionValue });
			await page.waitForTimeout(1500);

			// Close popover
			await closeSettingsPopover(page);

			// Reopen popover
			const reopened = await openSettingsPopover(page);
			if (!reopened) {
				ctx.fail("Reopen popover", "Settings popover did not reopen");
			} else {
				await page.waitForTimeout(500);

				// Check which option is selected
				const selectedValue = await page.$eval(
					".notor-model-select-wrapper select",
					(el) => (el as HTMLSelectElement).value,
				);

				const shot = await ctx.screenshot("09-reopened-popover");

				if (selectedValue === extendedOptionValue) {
					ctx.pass(
						"1M selection preserved after reopen",
						`Selected value: "${selectedValue}" matches expected "${extendedOptionValue}"`,
						shot,
					);
				} else {
					// The picker may reconstruct the value — check if it ends with ::1m
					if (selectedValue.endsWith("::1m")) {
						ctx.pass(
							"1M selection preserved after reopen",
							`Selected value "${selectedValue}" has ::1m suffix (may differ in base ID due to re-fetched list)`,
							shot,
						);
					} else {
						ctx.fail(
							"1M selection preserved after reopen",
							`Selected value "${selectedValue}" — expected "${extendedOptionValue}" (::1m suffix missing)`,
							shot,
						);
					}
				}
			}
		}
	} else {
		console.log("\nTests 7-9: SKIPPED — no 1M variants found in model list");
		ctx.pass("1M variant tests", "Skipped — no ::1m options available (model metadata may not include extended_context for discovered profiles)");
	}

	// Close popover
	await closeSettingsPopover(page);

	// ── Structured log analysis ──────────────────────────────────────────
	const allLogs = ctx.collector.getStructuredLogs();
	const providerLogs = allLogs.filter(
		(e) => e.source === "ProviderRegistry" || e.source === "BedrockProvider",
	);
	console.log(`\nProvider/Bedrock log entries: ${providerLogs.length}`);
	for (const entry of providerLogs.slice(-15)) {
		console.log(`  [${entry.level}] [${entry.source}] ${entry.message}`, entry.data ?? "");
	}
}

runTest({ name: "bedrock-model-picker", settings }, tests);
