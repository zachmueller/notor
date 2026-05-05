#!/usr/bin/env npx tsx
/**
 * Multi-Provider Instance E2E Test
 *
 * Validates the multi-instance provider architecture: multiple instances of the
 * same provider type can coexist, each with independent configuration. Also
 * validates the migration path (existing providers get id = type).
 *
 * Scenarios:
 *   1. Migration — existing providers have id matching their type after load
 *   2. Add provider — a new provider instance can be added via settings
 *   3. Provider picker — multiple instances appear with display names in the chat picker
 *   4. Provider isolation — switching between instances uses the correct config
 *   5. Delete provider — removing an instance cleans up and falls back gracefully
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testMigrationAssignsIds(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Migration assigns id = type to existing providers");
	const { page } = ctx;

	const providerIds = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		return plugin.settings.providers.map((p: any) => ({
			id: p.id,
			type: p.type,
			display_name: p.display_name,
		}));
	});

	const shot = await ctx.screenshot("01-migration-ids");

	if (!providerIds || providerIds.length === 0) {
		ctx.fail("Migration — providers loaded", "No providers found in settings", shot);
		return;
	}

	// Every provider should have id = type (migrated defaults)
	const allHaveIds = providerIds.every((p: any) => p.id && p.id === p.type);
	if (allHaveIds) {
		ctx.pass("Migration — providers have id = type", JSON.stringify(providerIds), shot);
	} else {
		ctx.fail("Migration — providers have id = type", `Some providers missing id: ${JSON.stringify(providerIds)}`, shot);
	}
}

async function testRegistryKeyedById(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: ProviderRegistry is keyed by instance ID");
	const { page } = ctx;

	const registryState = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		const registry = plugin.getProviderRegistry();
		return {
			activeId: registry.getActiveId(),
			activeType: registry.getActiveType(),
			configuredIds: registry.getConfiguredIds(),
			configuredTypes: registry.getConfiguredTypes(),
		};
	});

	const shot = await ctx.screenshot("02-registry-state");

	if (!registryState) {
		ctx.fail("Registry — accessible", "Could not access provider registry", shot);
		return;
	}

	if (registryState.activeId === "bedrock") {
		ctx.pass("Registry — activeId is 'bedrock'", `activeId=${registryState.activeId}`, shot);
	} else {
		ctx.fail("Registry — activeId is 'bedrock'", `Got activeId=${registryState.activeId}`, shot);
	}

	if (registryState.activeType === "bedrock") {
		ctx.pass("Registry — activeType resolves to 'bedrock'", `activeType=${registryState.activeType}`, shot);
	} else {
		ctx.fail("Registry — activeType resolves to 'bedrock'", `Got activeType=${registryState.activeType}`, shot);
	}

	if (registryState.configuredIds.includes("local") && registryState.configuredIds.includes("bedrock")) {
		ctx.pass("Registry — configuredIds includes both providers", JSON.stringify(registryState.configuredIds), shot);
	} else {
		ctx.fail("Registry — configuredIds includes both providers", JSON.stringify(registryState.configuredIds), shot);
	}
}

async function testAddProviderInstance(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Add a new provider instance programmatically");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		// Add a second local provider
		const newProvider = {
			id: "local-studio",
			type: "local",
			enabled: true,
			display_name: "Mac Studio",
			endpoint: "http://192.168.1.100:11434/v1",
		};
		plugin.settings.providers.push(newProvider);

		// Update registry
		const registry = plugin.getProviderRegistry();
		registry.updateConfig(newProvider);

		return {
			providerCount: plugin.settings.providers.length,
			configuredIds: registry.getConfiguredIds(),
			newConfig: registry.getConfig("local-studio"),
		};
	});

	const shot = await ctx.screenshot("03-add-provider");

	if ("error" in result) {
		ctx.fail("Add provider — plugin access", (result as any).error, shot);
		return;
	}

	if (result.providerCount === 3) {
		ctx.pass("Add provider — settings has 3 providers", `count=${result.providerCount}`, shot);
	} else {
		ctx.fail("Add provider — settings has 3 providers", `count=${result.providerCount}`, shot);
	}

	if (result.configuredIds.includes("local-studio")) {
		ctx.pass("Add provider — registry has new ID", JSON.stringify(result.configuredIds), shot);
	} else {
		ctx.fail("Add provider — registry has new ID", JSON.stringify(result.configuredIds), shot);
	}

	if (result.newConfig?.endpoint === "http://192.168.1.100:11434/v1") {
		ctx.pass("Add provider — config has correct endpoint", result.newConfig.endpoint, shot);
	} else {
		ctx.fail("Add provider — config has correct endpoint", JSON.stringify(result.newConfig), shot);
	}
}

async function testProviderPickerShowsInstances(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Chat provider picker shows multiple instances");
	const { page } = ctx;

	// Open the settings popover in the chat header
	const gearBtn = await page.$(".notor-chat-header-btn[aria-label='Chat settings']");
	if (!gearBtn) {
		const shot = await ctx.screenshot("04-no-gear-btn");
		ctx.fail("Provider picker — gear button found", "Chat settings button not found", shot);
		return;
	}
	await gearBtn.click();
	await page.waitForTimeout(500);

	// The first select is the preset picker. Select "Custom…" to reveal provider select.
	const customSelected = await page.evaluate(() => {
		const popover = document.querySelector(".notor-settings-popover");
		if (!popover) return false;
		const presetSelect = popover.querySelector("select.notor-settings-select") as HTMLSelectElement;
		if (!presetSelect) return false;
		presetSelect.value = "__custom";
		presetSelect.dispatchEvent(new Event("change", { bubbles: true }));
		return true;
	});

	if (!customSelected) {
		const shot = await ctx.screenshot("04-no-preset-select");
		ctx.fail("Provider picker — preset select found", "Could not find or interact with preset select", shot);
		return;
	}

	await page.waitForTimeout(500);

	// Now the provider select should be visible (second <select> in the popover)
	const providerOptions = await page.evaluate(() => {
		const popover = document.querySelector(".notor-settings-popover");
		if (!popover) return null;
		const selects = popover.querySelectorAll("select.notor-settings-select");
		// The provider select is the second one (after the preset select)
		const providerSelect = selects[1] as HTMLSelectElement | undefined;
		if (!providerSelect) return null;
		const options: { value: string; text: string }[] = [];
		providerSelect.querySelectorAll("option").forEach((opt: HTMLOptionElement) => {
			options.push({ value: opt.value, text: opt.textContent ?? "" });
		});
		return options;
	});

	const shot = await ctx.screenshot("04-provider-picker");

	if (!providerOptions) {
		ctx.fail("Provider picker — provider select found after Custom", "Could not find provider select in popover", shot);
		return;
	}

	// Should have at least 3 options (local, bedrock, local-studio)
	if (providerOptions.length >= 3) {
		ctx.pass("Provider picker — shows multiple instances", JSON.stringify(providerOptions), shot);
	} else {
		ctx.fail("Provider picker — shows multiple instances", `Only ${providerOptions.length} options: ${JSON.stringify(providerOptions)}`, shot);
	}

	// Check that "Mac Studio" appears as a display name
	const hasStudio = providerOptions.some(o => o.text.includes("Mac Studio"));
	if (hasStudio) {
		ctx.pass("Provider picker — shows custom display name", "'Mac Studio' found in options", shot);
	} else {
		ctx.fail("Provider picker — shows custom display name", `'Mac Studio' not in options: ${JSON.stringify(providerOptions)}`, shot);
	}

	// Check that values are instance IDs, not types
	const hasLocalStudioId = providerOptions.some(o => o.value === "local-studio");
	if (hasLocalStudioId) {
		ctx.pass("Provider picker — uses instance IDs as values", "Found value='local-studio'", shot);
	} else {
		ctx.fail("Provider picker — uses instance IDs as values", `No 'local-studio' value: ${JSON.stringify(providerOptions)}`, shot);
	}

	// Close popover
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
}

async function testSwitchProviderInstance(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Switching to a different instance updates registry");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const registry = plugin.getProviderRegistry();

		// Switch to the new local-studio instance
		registry.switchProvider("local-studio");

		return {
			activeId: registry.getActiveId(),
			activeType: registry.getActiveType(),
			config: registry.getConfig("local-studio"),
		};
	});

	const shot = await ctx.screenshot("05-switch-instance");

	if ("error" in result) {
		ctx.fail("Switch instance — plugin access", (result as any).error, shot);
		return;
	}

	if (result.activeId === "local-studio") {
		ctx.pass("Switch instance — activeId updated", `activeId=${result.activeId}`, shot);
	} else {
		ctx.fail("Switch instance — activeId updated", `Got activeId=${result.activeId}`, shot);
	}

	if (result.activeType === "local") {
		ctx.pass("Switch instance — activeType resolved to 'local'", `activeType=${result.activeType}`, shot);
	} else {
		ctx.fail("Switch instance — activeType resolved to 'local'", `Got activeType=${result.activeType}`, shot);
	}
}

async function testResolveTypeToId(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: resolveTypeToId backward compat for conversation headers");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return null;
		const registry = plugin.getProviderRegistry();
		return {
			localResolved: registry.resolveTypeToId("local"),
			bedrockResolved: registry.resolveTypeToId("bedrock"),
			unknownResolved: registry.resolveTypeToId("nonexistent"),
		};
	});

	const shot = await ctx.screenshot("06-resolve-type-to-id");

	if (!result) {
		ctx.fail("resolveTypeToId — accessible", "Could not access registry", shot);
		return;
	}

	if (result.localResolved === "local") {
		ctx.pass("resolveTypeToId — 'local' resolves to 'local'", `resolved=${result.localResolved}`, shot);
	} else {
		ctx.fail("resolveTypeToId — 'local' resolves to 'local'", `Got ${result.localResolved}`, shot);
	}

	if (result.bedrockResolved === "bedrock") {
		ctx.pass("resolveTypeToId — 'bedrock' resolves to 'bedrock'", `resolved=${result.bedrockResolved}`, shot);
	} else {
		ctx.fail("resolveTypeToId — 'bedrock' resolves to 'bedrock'", `Got ${result.bedrockResolved}`, shot);
	}

	if (result.unknownResolved === null) {
		ctx.pass("resolveTypeToId — unknown type returns null", `resolved=${result.unknownResolved}`, shot);
	} else {
		ctx.fail("resolveTypeToId — unknown type returns null", `Got ${result.unknownResolved}`, shot);
	}
}

async function testRemoveProviderInstance(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: Remove a provider instance");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const registry = plugin.getProviderRegistry();

		// Switch back to bedrock first (so we're not deleting the active one)
		registry.switchProvider("bedrock");

		// Remove local-studio from settings
		const idx = plugin.settings.providers.findIndex((p: any) => p.id === "local-studio");
		if (idx >= 0) {
			plugin.settings.providers.splice(idx, 1);
		}
		registry.removeProvider("local-studio");

		return {
			providerCount: plugin.settings.providers.length,
			configuredIds: registry.getConfiguredIds(),
			removedConfig: registry.getConfig("local-studio"),
			activeId: registry.getActiveId(),
		};
	});

	const shot = await ctx.screenshot("07-remove-provider");

	if ("error" in result) {
		ctx.fail("Remove provider — plugin access", (result as any).error, shot);
		return;
	}

	if (result.providerCount === 2) {
		ctx.pass("Remove provider — settings back to 2 providers", `count=${result.providerCount}`, shot);
	} else {
		ctx.fail("Remove provider — settings back to 2 providers", `count=${result.providerCount}`, shot);
	}

	if (!result.configuredIds.includes("local-studio")) {
		ctx.pass("Remove provider — registry no longer has 'local-studio'", JSON.stringify(result.configuredIds), shot);
	} else {
		ctx.fail("Remove provider — registry no longer has 'local-studio'", JSON.stringify(result.configuredIds), shot);
	}

	if (result.removedConfig === undefined) {
		ctx.pass("Remove provider — getConfig returns undefined", "Config correctly removed", shot);
	} else {
		ctx.fail("Remove provider — getConfig returns undefined", JSON.stringify(result.removedConfig), shot);
	}

	if (result.activeId === "bedrock") {
		ctx.pass("Remove provider — active provider unchanged", `activeId=${result.activeId}`, shot);
	} else {
		ctx.fail("Remove provider — active provider unchanged", `Got activeId=${result.activeId}`, shot);
	}
}

async function testGetConfigsForType(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: getConfigsForType returns all instances of a type");
	const { page } = ctx;

	// Add back a second local for this test
	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "plugin not found" };

		const registry = plugin.getProviderRegistry();

		// Add two more local instances
		const extra1 = { id: "local-a", type: "local", enabled: true, display_name: "Server A", endpoint: "http://a:11434/v1" };
		const extra2 = { id: "local-b", type: "local", enabled: true, display_name: "Server B", endpoint: "http://b:11434/v1" };
		plugin.settings.providers.push(extra1, extra2);
		registry.updateConfig(extra1);
		registry.updateConfig(extra2);

		const localConfigs = registry.getConfigsForType("local");
		const bedrockConfigs = registry.getConfigsForType("bedrock");

		// Cleanup
		plugin.settings.providers = plugin.settings.providers.filter((p: any) => p.id !== "local-a" && p.id !== "local-b");
		registry.removeProvider("local-a");
		registry.removeProvider("local-b");

		return {
			localCount: localConfigs.length,
			localIds: localConfigs.map((c: any) => c.id),
			bedrockCount: bedrockConfigs.length,
		};
	});

	const shot = await ctx.screenshot("08-configs-for-type");

	if ("error" in result) {
		ctx.fail("getConfigsForType — plugin access", (result as any).error, shot);
		return;
	}

	if (result.localCount === 3) {
		ctx.pass("getConfigsForType — 3 local instances found", `ids=${JSON.stringify(result.localIds)}`, shot);
	} else {
		ctx.fail("getConfigsForType — 3 local instances found", `Got ${result.localCount}: ${JSON.stringify(result.localIds)}`, shot);
	}

	if (result.bedrockCount === 1) {
		ctx.pass("getConfigsForType — 1 bedrock instance", `count=${result.bedrockCount}`, shot);
	} else {
		ctx.fail("getConfigsForType — 1 bedrock instance", `Got ${result.bedrockCount}`, shot);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init

	// Verify plugin loaded
	const loaded = await page.evaluate(() => {
		return !!(window as any).app?.plugins?.plugins?.["notor"];
	});
	if (!loaded) {
		ctx.fail("Plugin loaded", "Notor plugin not found after 5s wait");
		return;
	}

	await waitForSelector(page, ".notor-chat-container", 15_000);

	await testMigrationAssignsIds(ctx);
	await testRegistryKeyedById(ctx);
	await testAddProviderInstance(ctx);
	await testProviderPickerShowsInstances(ctx);
	await testSwitchProviderInstance(ctx);
	await testResolveTypeToId(ctx);
	await testRemoveProviderInstance(ctx);
	await testGetConfigsForType(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings();

runTest({ name: "multi-provider-instance", settings }, tests);
