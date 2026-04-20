#!/usr/bin/env npx tsx
/**
 * Template Variable Resolution E2E Test (TEST-TVR-1)
 *
 * Validates that {notor_dir} and {vault_name} template variables are resolved
 * in scaffold content before it reaches downstream consumers (tool-config
 * parser, path enforcer, system-prompt assembly).
 *
 * Scenarios:
 *   1. Registry resolves {notor_dir} to the configured notor_dir setting
 *   2. Registry resolves {vault_name} to the vault name
 *   3. Sub-agent profile: {notor_dir} in allowed_paths resolves to concrete path
 *   4. Persona: {notor_dir} in prompt_content resolves to concrete path
 *   5. Settings change: updating notor_dir propagates to next resolve() call
 *
 * @see specs/ZZ-misc/template-variable-resolution-design.md — §2, §4
 * @see specs/ZZ-misc/template-variable-resolution-implementation-tasks.md — Phase 4.3
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, waitForSelector, VAULT_PATH } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Vault setup
// ---------------------------------------------------------------------------

function setupVault(vaultPath: string): void {
	// Sub-agent profile with {notor_dir} in allowed_paths
	const subAgentsDir = path.join(vaultPath, "notor", "sub-agents", "tvr-test-agent");
	fs.mkdirSync(subAgentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(subAgentsDir, "system-prompt.md"),
		`---
notor-description: Template variable resolution test sub-agent.
---

You are a test sub-agent for verifying template variable resolution.

<notor_tool_config version="1.0">
read_note:
  enabled: true
  allowed_paths:
    - "{notor_dir}/memory"
    - "{notor_dir}/notes"
write_note:
  enabled: false
</notor_tool_config>
`,
	);

	// Persona with {notor_dir} and {vault_name} in prompt content
	const personaDir = path.join(vaultPath, "notor", "personas", "tvr-test-persona");
	fs.mkdirSync(personaDir, { recursive: true });
	fs.writeFileSync(
		path.join(personaDir, "system-prompt.md"),
		`---
notor-persona-prompt-mode: append
---

You are a test persona. Your notes are stored in {notor_dir}/notes.
This vault is named {vault_name}.
Unknown variables like {unknown_var} should pass through unchanged.
`,
	);

	console.log("  Template variable resolution test fixtures created.");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testRegistryResolvesNotorDir(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Registry resolves {notor_dir}");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			const registry = plugin.getTemplateRegistry();
			const resolved = registry.resolve("{notor_dir}/memory");
			const settings = plugin.settings;
			const expected = settings.notor_dir.replace(/\/$/, "") + "/memory";
			return { resolved, expected, match: resolved === expected };
		} catch (e) {
			return { error: String(e) };
		}
	});

	const shot = await ctx.screenshot("01-notor-dir-resolution");
	if ("error" in result) {
		ctx.fail("Registry resolves {notor_dir}", `Error: ${result.error}`, shot);
	} else if (result.match) {
		ctx.pass(
			"Registry resolves {notor_dir}",
			`"{notor_dir}/memory" → "${result.resolved}" (matches expected "${result.expected}")`,
			shot,
		);
	} else {
		ctx.fail(
			"Registry resolves {notor_dir}",
			`Got "${result.resolved}", expected "${result.expected}"`,
			shot,
		);
	}
}

async function testRegistryResolvesVaultName(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Registry resolves {vault_name}");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			const registry = plugin.getTemplateRegistry();
			const resolved = registry.resolve("{vault_name}");
			const vaultName = (window as any).app?.vault?.getName?.() ?? "";
			return { resolved, vaultName, match: resolved === vaultName && resolved !== "" };
		} catch (e) {
			return { error: String(e) };
		}
	});

	const shot = await ctx.screenshot("02-vault-name-resolution");
	if ("error" in result) {
		ctx.fail("Registry resolves {vault_name}", `Error: ${result.error}`, shot);
	} else if (result.match) {
		ctx.pass(
			"Registry resolves {vault_name}",
			`"{vault_name}" → "${result.resolved}" (vault name: "${result.vaultName}")`,
			shot,
		);
	} else {
		ctx.fail(
			"Registry resolves {vault_name}",
			`Got "${result.resolved}", vault name is "${result.vaultName}"`,
			shot,
		);
	}
}

async function testSubAgentAllowedPathsResolved(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Sub-agent allowed_paths resolves {notor_dir}");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			const mgr = plugin.getSubAgentManager();
			const profiles = await mgr.discoverProfiles();
			const testProfile = profiles.find((p: any) => p.name === "tvr-test-agent");
			if (!testProfile) return { error: "tvr-test-agent profile not found" };

			const notorDir = plugin.settings.notor_dir.replace(/\/$/, "");
			const toolConfigs = testProfile.tool_configs as any[];
			const readNoteConfig = toolConfigs
				.flatMap((tc: any) => Object.entries(tc.tools ?? {}))
				.find(([name]: [string, unknown]) => name === "read_note");

			if (!readNoteConfig) return { error: "read_note config not found in profile" };
			const allowedPaths: string[] = (readNoteConfig[1] as any)?.allowed_paths ?? [];

			const expectedPaths = [`${notorDir}/memory`, `${notorDir}/notes`];
			const hasUnresolved = allowedPaths.some((p: string) => p.includes("{notor_dir}"));
			const allResolved = expectedPaths.every((ep) => allowedPaths.includes(ep));

			return { allowedPaths, expectedPaths, hasUnresolved, allResolved };
		} catch (e) {
			return { error: String(e) };
		}
	});

	const shot = await ctx.screenshot("03-subagent-allowed-paths");
	if ("error" in result) {
		ctx.fail("Sub-agent allowed_paths resolves {notor_dir}", `Error: ${result.error}`, shot);
	} else if (result.hasUnresolved) {
		ctx.fail(
			"Sub-agent allowed_paths resolves {notor_dir}",
			`Unresolved {notor_dir} found in allowed_paths: ${JSON.stringify(result.allowedPaths)}`,
			shot,
		);
	} else if (result.allResolved) {
		ctx.pass(
			"Sub-agent allowed_paths resolves {notor_dir}",
			`allowed_paths contains concrete paths: ${JSON.stringify(result.allowedPaths)}`,
			shot,
		);
	} else {
		ctx.fail(
			"Sub-agent allowed_paths resolves {notor_dir}",
			`Expected ${JSON.stringify(result.expectedPaths)}, got ${JSON.stringify(result.allowedPaths)}`,
			shot,
		);
	}
}

async function testPersonaPromptResolved(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Persona prompt_content resolves {notor_dir} and {vault_name}");
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			const mgr = plugin.getPersonaManager();
			const persona = await mgr.getPersonaByName("tvr-test-persona");
			if (!persona) return { error: "tvr-test-persona not found" };

			const notorDir = plugin.settings.notor_dir.replace(/\/$/, "");
			const vaultName = (window as any).app?.vault?.getName?.() ?? "";
			const content: string = persona.prompt_content;

			const hasUnresolvedNotorDir = content.includes("{notor_dir}");
			const hasUnresolvedVaultName = content.includes("{vault_name}");
			const hasResolvedNotorDir = content.includes(notorDir + "/notes");
			const hasResolvedVaultName = content.includes(vaultName);
			const unknownPassthrough = content.includes("{unknown_var}");

			return {
				content,
				notorDir,
				vaultName,
				hasUnresolvedNotorDir,
				hasUnresolvedVaultName,
				hasResolvedNotorDir,
				hasResolvedVaultName,
				unknownPassthrough,
			};
		} catch (e) {
			return { error: String(e) };
		}
	});

	const shot = await ctx.screenshot("04-persona-prompt-resolved");
	if ("error" in result) {
		ctx.fail("Persona prompt_content resolved", `Error: ${result.error}`, shot);
		return;
	}

	const issues: string[] = [];
	if (result.hasUnresolvedNotorDir) issues.push("{notor_dir} not resolved");
	if (result.hasUnresolvedVaultName) issues.push("{vault_name} not resolved");
	if (!result.hasResolvedNotorDir) issues.push(`"${result.notorDir}/notes" not found in content`);
	if (!result.hasResolvedVaultName) issues.push(`vault name "${result.vaultName}" not found in content`);
	if (!result.unknownPassthrough) issues.push("{unknown_var} was removed (should pass through)");

	if (issues.length === 0) {
		ctx.pass(
			"Persona prompt_content resolved",
			`{notor_dir} → "${result.notorDir}", {vault_name} → "${result.vaultName}", {unknown_var} preserved`,
			shot,
		);
	} else {
		ctx.fail(
			"Persona prompt_content resolved",
			`Issues: ${issues.join("; ")}. Content: "${result.content.substring(0, 200)}"`,
			shot,
		);
	}
}

async function testSettingsChangePropagation(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Settings change propagates to registry resolver");
	const { page } = ctx;

	const result = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		if (!plugin) return { error: "Plugin not found" };
		try {
			const registry = plugin.getTemplateRegistry();
			const originalDir = plugin.settings.notor_dir;

			// Resolve with current settings
			const before = registry.resolve("{notor_dir}");

			// Temporarily update notor_dir in the live settings object
			plugin.settings.notor_dir = "custom-test-dir/";
			const after = registry.resolve("{notor_dir}");

			// Restore original
			plugin.settings.notor_dir = originalDir;
			const restored = registry.resolve("{notor_dir}");

			return { before, after, restored, originalDir };
		} catch (e) {
			return { error: String(e) };
		}
	});

	const shot = await ctx.screenshot("05-settings-propagation");
	if ("error" in result) {
		ctx.fail("Settings change propagates", `Error: ${result.error}`, shot);
		return;
	}

	const originalStripped = result.originalDir.replace(/\/$/, "");
	const beforeOk = result.before === originalStripped;
	const afterOk = result.after === "custom-test-dir";
	const restoredOk = result.restored === originalStripped;

	if (beforeOk && afterOk && restoredOk) {
		ctx.pass(
			"Settings change propagates",
			`before="${result.before}", after settings change="${result.after}", restored="${result.restored}"`,
			shot,
		);
	} else {
		const issues: string[] = [];
		if (!beforeOk) issues.push(`before="${result.before}", expected "${originalStripped}"`);
		if (!afterOk) issues.push(`after change="${result.after}", expected "custom-test-dir"`);
		if (!restoredOk) issues.push(`restored="${result.restored}", expected "${originalStripped}"`);
		ctx.fail("Settings change propagates", issues.join("; "), shot);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init

	const chat = await waitForSelector(page, ".notor-chat-container", 15_000);
	if (!chat) {
		ctx.fail("Plugin loaded", ".notor-chat-container not found", await ctx.screenshot("00-load-failed"));
		return;
	}

	await testRegistryResolvesNotorDir(ctx);
	await testRegistryResolvesVaultName(ctx);
	await testSubAgentAllowedPathsResolved(ctx);
	await testPersonaPromptResolved(ctx);
	await testSettingsChangePropagation(ctx);
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	notor_dir: "notor/",
});

runTest(
	{
		name: "template-var-resolution",
		settings,
		setupVault,
		cleanupFiles: [
			"notor/sub-agents/tvr-test-agent",
			"notor/personas/tvr-test-persona",
		],
	},
	tests,
);
