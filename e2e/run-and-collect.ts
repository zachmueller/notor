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
	console.debug("=== Notor E2E Debug Runner ===");
	console.debug(`Duration: ${DURATION_S}s | Vault: ${VAULT_PATH} | CDP port: ${CDP_PORT}`);

	// Step 1: Build the plugin (unless skipped)
	if (!SKIP_BUILD) {
		console.debug("\n[1/5] Building plugin...");
		try {
			execSync("npm run build", {
				cwd: path.resolve(__dirname, ".."),
				stdio: "inherit",
			});
			console.debug("Build complete.");
		} catch {
			console.error("Build failed! Fix build errors first.");
			process.exit(1);
		}
	} else {
		console.debug("\n[1/5] Skipping build (--skip-build)");
	}

	// Step 2: Launch Obsidian
	console.debug("\n[2/5] Launching Obsidian...");
	let obsidian: ObsidianProcess | undefined;
	let collector: LogCollector | undefined;

	try {
		obsidian = await launchObsidian({
			vaultPath: VAULT_PATH,
			cdpPort: CDP_PORT,
			timeout: 30_000,
		});

		// Step 3: Connect Playwright
		console.debug("\n[3/5] Connecting Playwright via CDP...");
		const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);

		// Step 4: Attach log collector to ALL pages immediately and watch for new ones.
		// Obsidian may close the initial page and open a new vault window, so we
		// attach the collector to every page we see to avoid missing logs.
		console.debug("\n[4/5] Collecting logs...");
		const outputDir = path.resolve(__dirname, "results", "logs");
		collector = new LogCollector({ outputDir });

		const attachedPages = new Set<string>();
		function attachToPage(p: import("playwright-core").Page) {
			const id = p.url() || String(Date.now());
			if (attachedPages.has(id)) return;
			attachedPages.add(id);
			console.debug(`[4/5] Attaching log collector to page: ${p.url()}`);
			collector!.attach(p);
		}

		// Attach to all existing pages
		for (const ctx of browser.contexts()) {
			for (const p of ctx.pages()) {
				attachToPage(p);
			}
			// Watch for new pages (vault window opening)
			ctx.on("page", (p) => attachToPage(p));
		}

		// Also watch for new contexts
		browser.on("disconnected", () => {
			console.debug("[4/5] Browser disconnected");
		});

		// Wait for Obsidian + plugin to initialize
		console.debug(`Capturing console output for ${DURATION_S} seconds...`);

		// Give a moment for the vault page to appear, then find it for screenshots
		await new Promise((r) => setTimeout(r, 5000));
		let page: import("playwright-core").Page | undefined;
		for (const ctx of browser.contexts()) {
			for (const p of ctx.pages()) {
				attachToPage(p);
				if (p.url().includes("obsidian")) page = p;
			}
		}
		if (!page) {
			const allPages = browser.contexts().flatMap((c) => c.pages());
			page = allPages[allPages.length - 1];
		}

		// Take a screenshot right after load
		const screenshotsDir = path.resolve(__dirname, "results", "screenshots");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(screenshotsDir, { recursive: true });
		if (page) {
			await page.screenshot({
				path: path.join(screenshotsDir, "obsidian-startup.png"),
				fullPage: true,
			}).catch((e) => console.debug(`[screenshot] startup failed: ${e.message}`));
		}

		// Wait for the remaining duration (subtract the 5s already waited)
		const remaining = Math.max(0, DURATION_S - 5);
		await new Promise((r) => setTimeout(r, remaining * 1000));

		// Re-discover the active page for the final screenshot
		for (const ctx of browser.contexts()) {
			for (const p of ctx.pages()) {
				attachToPage(p);
				if (p.url().includes("obsidian")) page = p;
			}
		}

		// Take another screenshot at end
		if (page) {
			await page.screenshot({
				path: path.join(screenshotsDir, "obsidian-after-capture.png"),
				fullPage: true,
			}).catch((e) => console.debug(`[screenshot] after-capture failed: ${e.message}`));
		}

		// Step 5: Write summary and close
		console.debug("\n[5/5] Writing summary and shutting down...");
		const summaryPath = collector.writeSummary();

		const logs = collector.getStructuredLogs();
		const errors = collector.getLogsByLevel("error");

		console.debug(`\n=== Results ===`);
		console.debug(`Total structured log entries: ${logs.length}`);
		console.debug(`Errors: ${errors.length}`);
		console.debug(`Warnings: ${collector.getLogsByLevel("warn").length}`);
		console.debug(`Summary: ${summaryPath}`);

		if (errors.length > 0) {
			console.debug(`\n=== Errors ===`);
			for (const err of errors) {
				console.debug(`  [${err.source}] ${err.message}`);
				if (err.data) console.debug(`    Data: ${JSON.stringify(err.data)}`);
			}
		}

		await collector.dispose();
		await browser.close().catch(() => {});

		console.debug("\nDone. Cline can read the summary at:");
		console.debug(`  ${summaryPath}`);
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