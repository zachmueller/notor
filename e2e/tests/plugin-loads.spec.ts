/**
 * Basic smoke test: verify the plugin loads in Obsidian and emits structured logs.
 *
 * This test:
 *  1. Launches Obsidian with the plugin symlinked into a test vault
 *  2. Waits for plugin initialization
 *  3. Checks that structured log entries were captured
 *  4. Verifies no error-level logs during startup
 *  5. Takes a screenshot for visual verification
 *
 * Run with: npx playwright test --config=e2e/playwright.config.ts
 */

import { test, expect } from "../lib/obsidian-fixture";

test.describe("Plugin smoke tests", () => {
	test("plugin loads without errors", async ({ obsidianPage, logCollector }) => {
		// Wait a bit for the plugin to fully initialize
		await obsidianPage.waitForTimeout(5000);

		// Take a screenshot for visual inspection
		await obsidianPage.screenshot({
			path: "e2e/results/screenshots/plugin-loaded.png",
			fullPage: true,
		});

		// Check we got structured logs from the plugin
		const allLogs = logCollector.getStructuredLogs();
		console.log(`Captured ${allLogs.length} structured log entries`);

		// There should be at least the "Plugin loading" entry
		const loadingLogs = allLogs.filter(
			(entry) => entry.source === "Main" && entry.message.includes("Plugin loading")
		);
		expect(loadingLogs.length).toBeGreaterThanOrEqual(1);

		// Verify no errors during startup
		const errors = logCollector.getLogsByLevel("error");
		if (errors.length > 0) {
			console.error("Plugin errors during startup:", JSON.stringify(errors, null, 2));
		}
		expect(errors.length).toBe(0);

		// Log the summary for Cline to review
		const summaryPath = await logCollector.writeSummary();
		console.log(`Log summary written to: ${summaryPath}`);
	});

	test("plugin settings load correctly", async ({ obsidianPage, logCollector }) => {
		await obsidianPage.waitForTimeout(5000);

		const settingsLogs = logCollector.getStructuredLogs().filter(
			(entry) => entry.message.includes("Settings loaded")
		);

		expect(settingsLogs.length).toBeGreaterThanOrEqual(1);

		// Verify settings data was captured
		const settingsEntry = settingsLogs[0];
		expect(settingsEntry.data).toBeDefined();
		console.log("Settings:", JSON.stringify(settingsEntry.data, null, 2));
	});
});