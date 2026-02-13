/**
 * Playwright Test Fixture for Obsidian
 *
 * Extends Playwright's base test with custom fixtures that:
 *  1. Launch Obsidian with CDP remote debugging
 *  2. Connect Playwright to the running Obsidian instance
 *  3. Attach the log collector to capture plugin output
 *  4. Provide the connected Page to tests
 *  5. Clean up (write summary, close browser, shut down Obsidian) after tests
 *
 * Usage in tests:
 *   import { test, expect } from "../lib/obsidian-fixture";
 *   test("plugin loads", async ({ obsidianPage, logCollector }) => {
 *     // obsidianPage is a Playwright Page connected to Obsidian
 *     // logCollector has all captured plugin logs
 *   });
 */

import { test as base, chromium, type Page, type Browser } from "@playwright/test";
import { launchObsidian, closeObsidian, type ObsidianProcess } from "./obsidian-launcher";
import { LogCollector } from "./log-collector";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Default test vault path — can be overridden with E2E_VAULT_PATH env var */
function getVaultPath(): string {
	if (process.env.E2E_VAULT_PATH) {
		return process.env.E2E_VAULT_PATH;
	}
	// Default: use a test vault in the project
	return path.resolve(__dirname, "..", "test-vault");
}

/** Ensure the test vault exists with minimal structure */
function ensureTestVault(vaultPath: string): void {
	const obsidianDir = path.join(vaultPath, ".obsidian");
	if (!fs.existsSync(obsidianDir)) {
		fs.mkdirSync(obsidianDir, { recursive: true });
		// Write minimal config so Obsidian recognizes this as a vault
		fs.writeFileSync(
			path.join(obsidianDir, "app.json"),
			JSON.stringify({ alwaysUpdateLinks: true }, null, 2)
		);
		fs.writeFileSync(
			path.join(obsidianDir, "appearance.json"),
			JSON.stringify({}, null, 2)
		);
	}

	// Ensure the plugin is symlinked into the vault
	const pluginId = "notor"; // Must match manifest.json id
	const pluginDir = path.join(obsidianDir, "plugins", pluginId);
	const buildDir = path.resolve(__dirname, "..", "..", "build");

	if (!fs.existsSync(path.join(obsidianDir, "plugins"))) {
		fs.mkdirSync(path.join(obsidianDir, "plugins"), { recursive: true });
	}

	// Create symlink if it doesn't exist — points to build/ (not repo root)
	if (!fs.existsSync(pluginDir)) {
		fs.symlinkSync(buildDir, pluginDir, "junction");
		console.log(`[fixture] Symlinked plugin: ${buildDir} → ${pluginDir}`);
	}

	// Ensure community plugins are enabled and our plugin is active
	const communityPluginsPath = path.join(obsidianDir, "community-plugins.json");
	let enabledPlugins: string[] = [];
	if (fs.existsSync(communityPluginsPath)) {
		try {
			enabledPlugins = JSON.parse(fs.readFileSync(communityPluginsPath, "utf8"));
		} catch {
			enabledPlugins = [];
		}
	}
	if (!enabledPlugins.includes(pluginId)) {
		enabledPlugins.push(pluginId);
		fs.writeFileSync(communityPluginsPath, JSON.stringify(enabledPlugins));
	}
}

// Custom fixture types
type ObsidianFixtures = {
	obsidianPage: Page;
	logCollector: LogCollector;
};

export const test = base.extend<ObsidianFixtures>({
	obsidianPage: async ({}, use) => {
		const vaultPath = getVaultPath();
		ensureTestVault(vaultPath);

		const cdpPort = parseInt(process.env.CDP_PORT ?? "9222", 10);
		let obsidian: ObsidianProcess | undefined;
		let browser: Browser | undefined;

		try {
			// Launch Obsidian
			obsidian = await launchObsidian({
				vaultPath,
				cdpPort,
				timeout: 30_000,
			});

			// Connect Playwright via CDP
			browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);

			// Get the first page (Obsidian's main window)
			const contexts = browser.contexts();
			const pages = contexts[0]?.pages() ?? [];
			const page = pages[0] ?? (await contexts[0]?.newPage());

			if (!page) {
				throw new Error("Could not get a page from Obsidian's browser context");
			}

			// Wait for Obsidian to be reasonably loaded
			await page.waitForLoadState("domcontentloaded");

			// Give Obsidian a moment to initialize plugins
			await page.waitForTimeout(3000);

			await use(page);
		} finally {
			if (browser) {
				await browser.close().catch(() => {});
			}
			if (obsidian) {
				await closeObsidian(obsidian);
			}
		}
	},

	logCollector: async ({ obsidianPage }, use) => {
		const outputDir = path.resolve(__dirname, "..", "results", "logs");
		const collector = new LogCollector({ outputDir });
		collector.attach(obsidianPage);

		await use(collector);

		// After the test, write summary and clean up
		await collector.dispose();
	},
});

export { expect } from "@playwright/test";