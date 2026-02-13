#!/usr/bin/env npx tsx
/**
 * Standalone Debug Runner
 *
 * A single script that Cline can execute to:
 *  1. Build the plugin
 *  2. Launch Obsidian with CDP debugging
 *  3. Connect via Playwright, capture logs for N seconds
 *  4. Write a structured summary to e2e/results/logs/latest-summary.json
 *  5. Shut down Obsidian
 *
 * Cline reads the summary file to understand what happened and iteratively debug.
 *
 * Usage:
 *   npx tsx e2e/run-and-collect.ts                  # Default 15s capture
 *   npx tsx e2e/run-and-collect.ts --duration 30    # Capture for 30s
 *   npx tsx e2e/run-and-collect.ts --skip-build     # Skip the plugin build step
 *   npx tsx e2e/run-and-collect.ts --vault /path     # Use specific vault
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { launchObsidian, closeObsidian, type ObsidianProcess } from "./lib/obsidian-launcher";
import { LogCollector } from "./lib/log-collector";

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
	const idx = args.indexOf(`--${name}`);
	if (idx !== -1 && args[idx + 1]) return args[idx + 1];
	return defaultVal;
}
function hasFlag(name: string): boolean {
	return args.includes(`--${name}`);
}

const DURATION_S = parseInt(getArg("duration", "15"), 10);
const SKIP_BUILD = hasFlag("skip-build");
const VAULT_PATH = getArg("vault", path.resolve(__dirname, "test-vault"));
const CDP_PORT = parseInt(getArg("port", "9222"), 10);

async function main() {
	console.log("=== Notor E2E Debug Runner ===");
	console.log(`Duration: ${DURATION_S}s | Vault: ${VAULT_PATH} | CDP port: ${CDP_PORT}`);

	// Step 1: Build the plugin (unless skipped)
	if (!SKIP_BUILD) {
		console.log("\n[1/5] Building plugin...");
		try {
			execSync("npm run build", {
				cwd: path.resolve(__dirname, ".."),
				stdio: "inherit",
			});
			console.log("Build complete.");
		} catch (err) {
			console.error("Build failed! Fix build errors first.");
			process.exit(1);
		}
	} else {
		console.log("\n[1/5] Skipping build (--skip-build)");
	}

	// Step 2: Launch Obsidian
	console.log("\n[2/5] Launching Obsidian...");
	let obsidian: ObsidianProcess | undefined;
	let collector: LogCollector | undefined;

	try {
		obsidian = await launchObsidian({
			vaultPath: VAULT_PATH,
			cdpPort: CDP_PORT,
			timeout: 30_000,
		});

		// Step 3: Connect Playwright
		console.log("\n[3/5] Connecting Playwright via CDP...");
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		const contexts = browser.contexts();
		const pages = contexts[0]?.pages() ?? [];
		const page = pages[0];

		if (!page) {
			throw new Error("No page found in Obsidian browser context");
		}

		// Step 4: Attach log collector
		console.log("\n[4/5] Collecting logs...");
		const outputDir = path.resolve(__dirname, "results", "logs");
		collector = new LogCollector({ outputDir });
		collector.attach(page);

		// Wait for Obsidian + plugin to initialize
		await page.waitForLoadState("domcontentloaded");
		console.log(`Capturing console output for ${DURATION_S} seconds...`);

		// Take a screenshot right after load
		const screenshotsDir = path.resolve(__dirname, "results", "screenshots");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(screenshotsDir, { recursive: true });
		await page.screenshot({
			path: path.join(screenshotsDir, "obsidian-startup.png"),
			fullPage: true,
		});

		// Wait for the specified duration
		await new Promise((r) => setTimeout(r, DURATION_S * 1000));

		// Take another screenshot at end
		await page.screenshot({
			path: path.join(screenshotsDir, "obsidian-after-capture.png"),
			fullPage: true,
		});

		// Step 5: Write summary and close
		console.log("\n[5/5] Writing summary and shutting down...");
		const summaryPath = await collector.writeSummary();

		const logs = collector.getStructuredLogs();
		const errors = collector.getLogsByLevel("error");

		console.log(`\n=== Results ===`);
		console.log(`Total structured log entries: ${logs.length}`);
		console.log(`Errors: ${errors.length}`);
		console.log(`Warnings: ${collector.getLogsByLevel("warn").length}`);
		console.log(`Summary: ${summaryPath}`);

		if (errors.length > 0) {
			console.log(`\n=== Errors ===`);
			for (const err of errors) {
				console.log(`  [${err.source}] ${err.message}`);
				if (err.data) console.log(`    Data: ${JSON.stringify(err.data)}`);
			}
		}

		await collector.dispose();
		await browser.close().catch(() => {});

		console.log("\nDone. Cline can read the summary at:");
		console.log(`  ${summaryPath}`);
	} catch (err) {
		console.error("Fatal error:", err);
		if (collector) await collector.dispose().catch(() => {});
	} finally {
		if (obsidian) {
			await closeObsidian(obsidian);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});