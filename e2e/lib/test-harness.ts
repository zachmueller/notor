/**
 * E2E Test Harness — eliminates boilerplate from individual test scripts.
 *
 * Provides `runTest(config, testFn)` which orchestrates the full lifecycle:
 *   build → vault reset → data.json backup/inject → launch Obsidian →
 *   CDP connect → find vault page → attach log collector → run tests →
 *   collect logs → cleanup → results summary → exit
 *
 * Each test script calls `runTest()` with its config and a test function
 * that receives a `TestContext` with `page`, `pass()`, `fail()`, etc.
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { chromium, type Page, type Browser } from "playwright-core";
import { launchObsidian, closeObsidian, type ObsidianProcess } from "./obsidian-launcher";
import { LogCollector } from "./log-collector";
import { resetVault, type VaultResetOptions } from "./vault-reset";
import {
	PROJECT_ROOT,
	BUILD_DIR,
	VAULT_PATH,
	PLUGIN_DATA_PATH,
	RESULTS_DIR,
	LOGS_DIR,
	CDP_PORT,
	findVaultPage,
} from "./test-helpers";

// ---------------------------------------------------------------------------
// Data.json backup — crash-safe (on disk, not in-memory)
// ---------------------------------------------------------------------------

const BACKUP_PATH = path.join(BUILD_DIR, "data.json.e2e-backup");

function recoverStaleBackup(): void {
	if (fs.existsSync(BACKUP_PATH)) {
		console.log("  Found stale data.json backup from a previous crash — restoring...");
		fs.copyFileSync(BACKUP_PATH, PLUGIN_DATA_PATH);
		fs.unlinkSync(BACKUP_PATH);
		console.log("  Restored data.json from crash backup");
	}
}

function backupDataJson(): void {
	if (fs.existsSync(PLUGIN_DATA_PATH)) {
		fs.copyFileSync(PLUGIN_DATA_PATH, BACKUP_PATH);
	}
}

function restoreDataJson(): void {
	if (fs.existsSync(BACKUP_PATH)) {
		fs.copyFileSync(BACKUP_PATH, PLUGIN_DATA_PATH);
		fs.unlinkSync(BACKUP_PATH);
	} else {
		try { fs.unlinkSync(PLUGIN_DATA_PATH); } catch { /* ignore */ }
	}
}

// ---------------------------------------------------------------------------
// Test result tracking
// ---------------------------------------------------------------------------

export interface TestResult {
	name: string;
	passed: boolean;
	detail: string;
	screenshot?: string;
}

// ---------------------------------------------------------------------------
// TestContext — passed to every test function
// ---------------------------------------------------------------------------

export class TestContext {
	readonly page: Page;
	readonly browser: Browser;
	readonly obsidian: ObsidianProcess;
	readonly collector: LogCollector;
	readonly results: TestResult[];
	readonly vaultPath: string;
	readonly screenshotsDir: string;

	constructor(opts: {
		page: Page;
		browser: Browser;
		obsidian: ObsidianProcess;
		collector: LogCollector;
		results: TestResult[];
		vaultPath: string;
		screenshotsDir: string;
	}) {
		this.page = opts.page;
		this.browser = opts.browser;
		this.obsidian = opts.obsidian;
		this.collector = opts.collector;
		this.results = opts.results;
		this.vaultPath = opts.vaultPath;
		this.screenshotsDir = opts.screenshotsDir;
	}

	pass(name: string, detail: string, screenshot?: string): void {
		console.log(`  ✓ PASS: ${name} — ${detail}`);
		this.results.push({ name, passed: true, detail, screenshot });
	}

	fail(name: string, detail: string, screenshot?: string): void {
		console.error(`  ✗ FAIL: ${name} — ${detail}`);
		this.results.push({ name, passed: false, detail, screenshot });
	}

	async screenshot(name: string): Promise<string> {
		fs.mkdirSync(this.screenshotsDir, { recursive: true });
		const file = path.join(this.screenshotsDir, `${name}.png`);
		await this.page.screenshot({ path: file, fullPage: true });
		return file;
	}
}

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

export interface TestConfig {
	/** Test name — used for result file and screenshot directory. */
	name: string;

	/**
	 * Plugin settings to inject into data.json.
	 * If null/undefined, no settings injection is performed.
	 */
	settings?: Record<string, unknown> | null;

	/** Skip the build step (also settable via `--skip-build` CLI flag). */
	skipBuild?: boolean;

	/**
	 * Optional callback to set up vault fixtures before Obsidian launches.
	 * Called after vault reset and data.json injection.
	 */
	setupVault?: (vaultPath: string) => void;

	/** Vault-relative paths to delete during teardown. */
	cleanupFiles?: string[];

	/** Options for the vault reset step. */
	vaultResetOptions?: VaultResetOptions;

	/** CDP port override (default: 9222). */
	cdpPort?: number;

	/** Obsidian launch timeout in ms (default: 30000). */
	launchTimeout?: number;
}

// ---------------------------------------------------------------------------
// Results output
// ---------------------------------------------------------------------------

function printAndWriteResults(testName: string, results: TestResult[]): void {
	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;

	console.log("\n=== Test Results ===");
	console.log(`Passed: ${passed}/${results.length}`);
	console.log(`Failed: ${failed}/${results.length}`);

	if (failed > 0) {
		console.log("\nFailed tests:");
		for (const r of results.filter((r) => !r.passed)) {
			console.log(`  ✗ ${r.name}: ${r.detail}`);
		}
	}

	const resultsPath = path.join(RESULTS_DIR, `${testName}-results.json`);
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	fs.writeFileSync(
		resultsPath,
		JSON.stringify({ passed, failed, total: results.length, results }, null, 2),
	);
	console.log(`\nResults written to: ${resultsPath}`);

	if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// runTest — the main entry point
// ---------------------------------------------------------------------------

export async function runTest(
	config: TestConfig,
	testFn: (ctx: TestContext) => Promise<void>,
): Promise<void> {
	const cdpPort = config.cdpPort ?? CDP_PORT;
	const screenshotsDir = path.join(RESULTS_DIR, "screenshots", config.name);
	const skipBuild = config.skipBuild ?? process.argv.includes("--skip-build");

	// Results array lives outside try so it survives to the summary step
	const results: TestResult[] = [];

	console.log(`=== ${config.name} ===\n`);

	// 0. Recover from any previous crash
	recoverStaleBackup();

	// 1. Build
	if (!skipBuild) {
		console.log("[setup] Building plugin...");
		execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });
		console.log("Build complete.\n");
	}

	// 2. Reset vault
	console.log("[setup] Resetting vault...");
	resetVault(VAULT_PATH, config.vaultResetOptions);

	// 3. Backup & inject data.json
	backupDataJson();
	if (config.settings) {
		fs.writeFileSync(PLUGIN_DATA_PATH, JSON.stringify(config.settings, null, 2));
		console.log("[setup] Injected test settings into data.json");
	}

	// 4. Create output directories
	fs.mkdirSync(screenshotsDir, { recursive: true });
	fs.mkdirSync(LOGS_DIR, { recursive: true });

	// 5. Custom vault setup
	if (config.setupVault) {
		config.setupVault(VAULT_PATH);
		console.log("[setup] Custom vault fixtures created");
	}

	let obsidian: ObsidianProcess | undefined;
	let browser: Browser | undefined;
	let collector: LogCollector | undefined;

	// Signal handling for graceful cleanup on Ctrl+C
	const signalCleanup = async () => {
		console.log("\n  Signal received — cleaning up...");
		restoreDataJson();
		if (obsidian) await closeObsidian(obsidian).catch(() => {});
		process.exit(1);
	};
	process.on("SIGINT", signalCleanup);
	process.on("SIGTERM", signalCleanup);

	try {
		// 6. Launch Obsidian
		console.log("[setup] Launching Obsidian...");
		obsidian = await launchObsidian({
			vaultPath: VAULT_PATH,
			cdpPort,
			timeout: config.launchTimeout ?? 30_000,
		});

		// 7. Connect CDP
		console.log("[setup] Connecting via CDP...");
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);

		// 8. Find vault page
		const page = await findVaultPage(browser);
		console.log("[setup] Found vault page");

		// 9. Attach log collector
		collector = new LogCollector({ outputDir: LOGS_DIR });
		collector.attach(page);
		await page.waitForLoadState("domcontentloaded");

		// 10. Run tests
		const ctx = new TestContext({
			page,
			browser,
			obsidian,
			collector,
			results,
			vaultPath: VAULT_PATH,
			screenshotsDir,
		});

		await testFn(ctx);

		// 11. Final screenshot
		await ctx.screenshot("99-final");

		// 12. Collect logs
		console.log("\n=== Collecting final logs ===");
		await page.waitForTimeout(1_000);
		const summaryPath = collector.writeSummary();
		console.log(`Log summary: ${summaryPath}`);

		const errors = collector.getLogsByLevel("error");
		if (errors.length > 0) {
			console.log(`\nPlugin errors captured (${errors.length}):`);
			for (const e of errors.slice(-10)) {
				console.log(`  [${e.source}] ${e.message}`, e.data ?? "");
			}
		}

	} catch (err) {
		console.error("\nFatal error:", err);
	} finally {
		if (collector) await collector.dispose().catch(() => {});
		if (browser) await browser.close().catch(() => {});
		if (obsidian) await closeObsidian(obsidian).catch(() => {});

		restoreDataJson();
		console.log("[teardown] Restored data.json");

		// Delete test-generated files
		if (config.cleanupFiles) {
			for (const f of config.cleanupFiles) {
				const fullPath = path.join(VAULT_PATH, f);
				try {
					if (fs.existsSync(fullPath)) {
						const stat = fs.lstatSync(fullPath);
						if (stat.isDirectory()) {
							fs.rmSync(fullPath, { recursive: true, force: true });
						} else {
							fs.unlinkSync(fullPath);
						}
					}
				} catch { /* best-effort */ }
			}
		}

		process.removeListener("SIGINT", signalCleanup);
		process.removeListener("SIGTERM", signalCleanup);
	}

	printAndWriteResults(config.name, results);
}
