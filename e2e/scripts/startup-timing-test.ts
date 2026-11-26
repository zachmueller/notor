#!/usr/bin/env npx tsx
/**
 * Startup timing harness — repeatable cold-launch measurements of Notor's
 * startup cost on a synthetic heavy vault.
 *
 * For each workspace variant, launches a fresh Obsidian process N times on a
 * freshly copied fixture vault and collects, over CDP:
 *   - Obsidian's own start-up breakdown (`dev:startup format=json`), including the
 *     per-plugin `communityPlugins.notor` time (read + eval main.js + awaited onload)
 *   - every `notor:*` performance mark/measure (src/utils/startup-timing.ts)
 *   - for the `collapsed` layout: the cost of the deferred restore when the user
 *     first opens each sidebar (chat restore, run-tree scan)
 * and reports medians.
 *
 * Variants:
 *   collapsed  both sidebars collapsed; the notor leaves restore as deferred views
 *   visible    sidebars expanded; the chat, inspector and run-tree restore at launch
 *
 * The fixture (e2e/lib/startup-fixture.ts) mirrors a heavy real install's shape
 * using generated content only. Disk caches are warm after the first run (no
 * cache purge), so the numbers favour steady-state launches over a cold boot.
 *
 * Usage:
 *   npm run e2e:startup -- [--runs 5] [--variants collapsed,visible] [--scale 1]
 *                          [--mcp 10] [--log-level debug] [--label baseline]
 *                          [--skip-build] [--reuse-fixture]
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { launchObsidian, closeObsidian, type ObsidianProcess } from "../lib/obsidian-launcher";
import { BUILD_DIR, E2E_DIR, PROJECT_ROOT, RESULTS_DIR } from "../lib/test-helpers";
import {
	buildWorkspace,
	generateStartupFixture,
	type StartupFixtureInfo,
	type WorkspaceVariant,
} from "../lib/startup-fixture";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUNS = Number(arg("runs", "5"));
const VARIANTS = arg("variants", "collapsed,visible").split(",") as WorkspaceVariant[];
const SCALE = Number(arg("scale", "1"));
const MCP = Number(arg("mcp", "10"));
const LOG_LEVEL = arg("log-level", "debug") as "debug" | "info" | "warn" | "error";
const LABEL = arg("label", "run");
const CDP_PORT = Number(arg("cdp-port", "9231"));

const TMP = fs.realpathSync(os.tmpdir());
const TEMPLATE_DIR = path.join(TMP, "notor-startup-fixture");
const VAULT_DIR = path.join(TMP, "notor-startup-vault");
const USER_DATA_DIR = path.join(TMP, "notor-startup-user-data");
const ECHO_SERVER = path.join(E2E_DIR, "fixtures", "echo-mcp-server.mjs");

const SETTLE_TIMEOUT_MS = 120_000;
const MCP_TIMEOUT_MS = 30_000;
const RESTORE_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Page helpers (evaluate bodies are strings: no nested fn declarations, see
// the e2e __name trap note)
// ---------------------------------------------------------------------------

async function findAppPage(browser: Browser, timeout = 60_000): Promise<Page> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		for (const ctx of browser.contexts()) {
			for (const p of ctx.pages()) {
				try {
					if (await p.evaluate("!!(window.app && window.app.workspace)")) return p;
				} catch { /* not ready */ }
			}
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error("Obsidian app page not found");
}

async function pollUntil(page: Page, expr: string, timeout: number, interval = 250): Promise<boolean> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			if (await page.evaluate(expr)) return true;
		} catch { /* navigation / reload */ }
		await new Promise((r) => setTimeout(r, interval));
	}
	return false;
}

interface RawEntry { name: string; kind: "mark" | "measure"; startTime: number; duration: number; detail?: unknown }

const COLLECT_ENTRIES = `(() => {
	const out = [];
	for (const kind of ["mark", "measure"]) {
		for (const e of performance.getEntriesByType(kind)) {
			if (e.name.indexOf("notor:") !== 0) continue;
			out.push({ name: e.name.slice(6), kind, startTime: e.startTime, duration: e.duration, detail: e.detail ?? undefined });
		}
	}
	return out;
})()`;

// ---------------------------------------------------------------------------
// One launch
// ---------------------------------------------------------------------------

type Metrics = Record<string, number>;

interface RunResult {
	variant: WorkspaceVariant;
	run: number;
	metrics: Metrics;
	entries: RawEntry[];
	obsidianStartup: unknown;
	notes: string[];
}

function prepareVault(variant: WorkspaceVariant, info: StartupFixtureInfo): void {
	fs.rmSync(VAULT_DIR, { recursive: true, force: true });
	// Preserve mtimes: Obsidian's metadata cache (IndexedDB, keyed by vault id)
	// is reused only for files whose mtime/size are unchanged, so a plain copy
	// would make every launch re-index the whole vault, unlike a real restart.
	fs.cpSync(TEMPLATE_DIR, VAULT_DIR, { recursive: true, preserveTimestamps: true });
	fs.writeFileSync(
		path.join(VAULT_DIR, ".obsidian", "workspace.json"),
		JSON.stringify(buildWorkspace(variant, info), null, 2),
	);
}

async function withObsidian<T>(fn: (page: Page) => Promise<T>): Promise<T> {
	let obsidian: ObsidianProcess | undefined;
	let browser: Browser | undefined;
	try {
		obsidian = await launchObsidian({ vaultPath: VAULT_DIR, cdpPort: CDP_PORT, userDataDir: USER_DATA_DIR, timeout: 60_000 });
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		const page = await findAppPage(browser);
		return await fn(page);
	} finally {
		if (browser) await browser.close().catch(() => {});
		if (obsidian) await closeObsidian(obsidian).catch(() => {});
		await new Promise((r) => setTimeout(r, 1_500));
	}
}

/** First launch in a fresh user-data dir: turn community plugins on for the fixture vault. */
async function primeCommunityPlugins(info: StartupFixtureInfo): Promise<void> {
	prepareVault("collapsed", info);
	await withObsidian(async (page) => {
		const enabled = await page.evaluate("window.app.plugins.isEnabled()");
		if (enabled) return;
		console.log("[prime] Enabling community plugins for the fixture vault");
		await page.evaluate("window.app.plugins.setEnable(true)");
		await page.waitForTimeout(3_000);
	});
}

function sumMeasures(entries: RawEntry[], name: string): { n: number; ms: number; maxEnd: number } {
	let n = 0, ms = 0, maxEnd = 0;
	for (const e of entries) {
		if (e.kind !== "measure" || e.name !== name) continue;
		n++;
		ms += e.duration;
		maxEnd = Math.max(maxEnd, e.startTime + e.duration);
	}
	return { n, ms, maxEnd };
}

async function measureOnce(variant: WorkspaceVariant, run: number, info: StartupFixtureInfo): Promise<RunResult> {
	prepareVault(variant, info);
	return withObsidian(async (page) => {
		const notes: string[] = [];

		if (!(await pollUntil(page, `performance.getEntriesByName("notor:settled").length > 0`, SETTLE_TIMEOUT_MS))) {
			notes.push("settled mark not seen within timeout");
		}
		if (MCP > 0 && !(await pollUntil(page, `performance.getEntriesByName("notor:mcp.connect").length >= ${MCP}`, MCP_TIMEOUT_MS))) {
			notes.push("not every MCP server finished connecting within timeout");
		}
		await page.waitForTimeout(1_000);

		const metrics: Metrics = {};

		if (variant === "collapsed") {
			const chat = await page.evaluate<number>(`(async () => {
				const t0 = performance.now();
				window.app.workspace.leftSplit.expand();
				const deadline = Date.now() + ${RESTORE_TIMEOUT_MS};
				while (Date.now() < deadline) {
					const done = performance.getEntriesByName("notor:chat.paint").filter((e) => e.startTime >= t0);
					if (done.length > 0) return done[0].startTime + done[0].duration - t0;
					await new Promise((r) => setTimeout(r, 50));
				}
				return -1;
			})()`);
			if (chat < 0) notes.push("chat restore did not finish after expanding the left sidebar");
			else metrics["restore.chatOnSidebarOpen"] = chat;

			const tree = await page.evaluate<number>(`(async () => {
				const t0 = performance.now();
				window.app.workspace.rightSplit.expand();
				const deadline = Date.now() + ${RESTORE_TIMEOUT_MS};
				while (Date.now() < deadline) {
					const done = performance.getEntriesByName("notor:runTree.scan").filter((e) => e.startTime >= t0);
					if (done.length > 0) return done[0].startTime + done[0].duration - t0;
					await new Promise((r) => setTimeout(r, 50));
				}
				return -1;
			})()`);
			if (tree < 0) notes.push("run-tree scan not seen after expanding the right sidebar");
			else metrics["restore.runTreeOnSidebarOpen"] = tree;
			await page.waitForTimeout(1_000);
		}

		// Correctness guard: what loaded should not change between builds.
		const counts = await page.evaluate<{ tools: number; extensionTools: number; automations: number }>(`(() => {
			const p = window.app.plugins.plugins.notor;
			if (!p) return { tools: -1, extensionTools: -1, automations: -1 };
			return {
				tools: p.getToolRegistry().getNames().length,
				extensionTools: p.getExtensionManager().getTools().length,
				automations: p.getExtensionManager().getAutomations().length,
			};
		})()`);
		metrics["loaded.tools"] = counts.tools;
		metrics["loaded.extensionTools"] = counts.extensionTools;
		metrics["loaded.automations"] = counts.automations;

		const entries = await page.evaluate<RawEntry[]>(COLLECT_ENTRIES);

		let obsidianStartup: unknown = null;
		try {
			const json = await page.evaluate<string | null>(`window.handleCli ? window.handleCli(["dev:startup", "format=json"]) : null`);
			obsidianStartup = json ? JSON.parse(json) : null;
		} catch (e) {
			notes.push(`dev:startup unavailable: ${String(e)}`);
		}
		const durations = (obsidianStartup as { durations?: Record<string, number>; total?: number } | null)?.durations ?? {};
		metrics["obsidian.total"] = (obsidianStartup as { total?: number } | null)?.total ?? NaN;
		metrics["obsidian.communityPlugins"] = durations["communityPlugins"] ?? NaN;
		metrics["obsidian.plugin.notor"] = durations["communityPlugins.notor"] ?? NaN;
		metrics["obsidian.workspace.layout"] = durations["workspace.layout"] ?? NaN;
		metrics["obsidian.vault"] = durations["vault"] ?? NaN;

		const mark = (name: string) => entries.find((e) => e.kind === "mark" && e.name === name)?.startTime ?? NaN;
		metrics["at.layoutReady"] = mark("layoutReady");
		metrics["at.apiReady"] = mark("apiReady");
		metrics["at.settled"] = mark("settled");
		metrics["settledAfterLayoutReady"] = metrics["at.settled"] - metrics["at.layoutReady"];

		const names = [...new Set(entries.filter((e) => e.kind === "measure").map((e) => e.name))];
		for (const name of names) {
			const s = sumMeasures(entries, name);
			metrics[`${name}.ms`] = s.ms;
			metrics[`${name}.n`] = s.n;
		}
		const mcp = sumMeasures(entries, "mcp.connect");
		if (mcp.n > 0) metrics["at.mcpAllConnected"] = mcp.maxEnd;

		console.log(
			`  [${variant} #${run + 1}] notor plugin ${fmt(metrics["obsidian.plugin.notor"])} ms, ` +
			`layoutReady→settled ${fmt(metrics["settledAfterLayoutReady"])} ms` +
			(metrics["restore.chatOnSidebarOpen"] !== undefined ? `, chat on open ${fmt(metrics["restore.chatOnSidebarOpen"])} ms` : "") +
			(notes.length ? `  (${notes.join("; ")})` : ""),
		);
		return { variant, run, metrics, entries, obsidianStartup, notes };
	});
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmt(v: number | undefined): string {
	return v === undefined || Number.isNaN(v) ? "—" : String(Math.round(v));
}

function median(xs: number[]): number {
	const v = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
	if (v.length === 0) return NaN;
	const m = Math.floor(v.length / 2);
	return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function medians(runs: RunResult[]): Metrics {
	const keys = [...new Set(runs.flatMap((r) => Object.keys(r.metrics)))].sort();
	const out: Metrics = {};
	for (const k of keys) out[k] = median(runs.map((r) => r.metrics[k] ?? NaN));
	return out;
}

const HEADLINE = [
	"obsidian.total", "obsidian.communityPlugins", "obsidian.plugin.notor",
	"onload.ms", "onload.settings.ms", "onload.vaultHooks.ms", "onload.toolRegistry.ms", "onload.mcpInit.ms",
	"at.layoutReady", "at.apiReady", "at.settled", "settledAfterLayoutReady", "at.mcpAllConnected",
	"layout.tagCache.ms", "layout.listeners.ms", "layout.persona.ms", "layout.workflows.ms",
	"layout.extensions.ms", "layout.extensions.reload.ms", "layout.circuitsScan.ms", "layout.recoverCircuits.ms",
	"layout.retention.ms",
	"history.list.n", "history.list.ms", "circuits.discover.n", "circuits.discover.ms",
	"runTree.scan.n", "runTree.scan.ms", "mcp.connect.n",
	"chat.factory.ms", "chat.list.ms", "chat.switchById.ms", "chat.load.ms", "chat.paint.ms",
	"restore.chatOnSidebarOpen", "restore.runTreeOnSidebarOpen",
	"loaded.tools", "loaded.extensionTools", "loaded.automations",
];

function printTable(byVariant: Record<string, Metrics>): void {
	const variants = Object.keys(byVariant);
	const w = Math.max(...HEADLINE.map((k) => k.length)) + 2;
	console.log("\nMedians (ms; .n = call count; at.* = ms since renderer time origin)\n");
	console.log("".padEnd(w) + variants.map((v) => v.padStart(12)).join(""));
	for (const k of HEADLINE) {
		if (variants.every((v) => byVariant[v][k] === undefined)) continue;
		console.log(k.padEnd(w) + variants.map((v) => fmt(byVariant[v][k]).padStart(12)).join(""));
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("=== Notor startup timing ===\n");
	if (!flag("skip-build")) {
		console.log("[setup] Building plugin...");
		execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });
	}

	const infoPath = path.join(TEMPLATE_DIR, ".fixture-info.json");
	let info: StartupFixtureInfo;
	if (flag("reuse-fixture") && fs.existsSync(infoPath)) {
		info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as StartupFixtureInfo;
		// Refresh plugin artifacts so a rebuilt main.js is measured.
		for (const f of ["main.js", "manifest.json", "styles.css"]) {
			const src = path.join(BUILD_DIR, f);
			if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEMPLATE_DIR, ".obsidian", "plugins", "notor", f));
		}
		console.log("[setup] Reusing fixture", info.counts);
	} else {
		console.log(`[setup] Generating fixture (scale ${SCALE}) in ${TEMPLATE_DIR} ...`);
		const t = Date.now();
		info = generateStartupFixture(TEMPLATE_DIR, {
			scale: SCALE, mcpServers: MCP, logLevel: LOG_LEVEL, echoServerPath: ECHO_SERVER, buildDir: BUILD_DIR,
		});
		fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));
		console.log(`[setup] Fixture ready in ${Math.round((Date.now() - t) / 1000)} s`, info.counts);
	}

	await primeCommunityPlugins(info);

	const runs: RunResult[] = [];
	for (const variant of VARIANTS) {
		console.log(`\n[${variant}] ${RUNS} launches`);
		for (let i = 0; i < RUNS; i++) {
			try {
				runs.push(await measureOnce(variant, i, info));
			} catch (e) {
				console.error(`  [${variant} #${i + 1}] failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	const byVariant: Record<string, Metrics> = {};
	for (const v of VARIANTS) byVariant[v] = medians(runs.filter((r) => r.variant === v));
	printTable(byVariant);

	const manifest = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "manifest.json"), "utf8")) as { version: string };
	let commit = "";
	try { commit = execSync("git rev-parse --short HEAD", { cwd: PROJECT_ROOT, encoding: "utf8" }).trim(); } catch { /* ignore */ }
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const out = path.join(RESULTS_DIR, `startup-timing-${LABEL}-${stamp}.json`);
	fs.writeFileSync(out, JSON.stringify({
		label: LABEL, commit, pluginVersion: manifest.version,
		options: { runs: RUNS, variants: VARIANTS, scale: SCALE, mcp: MCP, logLevel: LOG_LEVEL },
		fixture: info.counts, medians: byVariant, runs,
	}, null, 2));
	console.log(`\nResults written to: ${out}`);

	const failed = runs.length < RUNS * VARIANTS.length;
	process.exit(failed ? 1 : 0);
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});
