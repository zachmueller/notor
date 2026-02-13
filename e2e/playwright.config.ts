/**
 * Playwright configuration for Obsidian E2E testing.
 *
 * This is NOT a typical browser-based Playwright config. Instead, we use
 * Playwright's CDP (Chrome DevTools Protocol) connection to attach to a
 * running Obsidian instance (which is an Electron app backed by Chromium).
 *
 * The test harness connects to Obsidian via --remote-debugging-port,
 * captures console output, takes screenshots, and interacts with the UI.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	timeout: 60_000,
	retries: 0,
	workers: 1, // Serial — only one Obsidian instance at a time
	reporter: [["list"], ["json", { outputFile: "e2e/results/test-results.json" }]],
	use: {
		// No default browserName — we connect via CDP in the test fixtures
		trace: "retain-on-failure",
		screenshot: "on",
		video: "retain-on-failure",
	},
	outputDir: "e2e/results/artifacts",
});