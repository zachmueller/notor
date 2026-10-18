#!/usr/bin/env npx tsx
/**
 * Daily Start Trigger E2E Test
 *
 * Validates the `on_daily_start` trigger in the real app against a local
 * OpenAI-compatible mock server that starts out unreachable (the "expired
 * credentials / no network on first boot" case).
 *
 * Scenarios:
 *   1. On a fresh logical day, plugin load fires the shell-command hook once,
 *      and the daily-start workflow's provider pre-flight fails with a
 *      persistent Notice (reason + "Retry now").
 *   2. Once the server is up, "Retry now" launches the workflow; the run's
 *      Notice opens its conversation in the chat panel.
 *   3. A reload on the same logical day fires nothing again.
 *   4. Clearing this device's daily-start state and reloading fires again.
 *   5. "Open most recent daily start run" / "Run daily start now" commands
 *      are available when a daily-start target exists.
 *
 * @see ai/notor/ideas/Proactive agent with daily session detection hook trigger.md
 * @see src/hooks/daily-start/
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, VAULT_PATH } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const MOCK_PORT = 18_735;
const MOCK_MODEL = "mock-model";
const RESPONSE_TEXT = "Good morning from the daily brief.";
const COUNTER_FILE = path.join(VAULT_PATH, ".daily-start-counter.txt");
const WORKFLOW_PATH = "notor/workflows/daily-brief.md";
const STORAGE_KEY = "notor:daily-start";
const NOTICE_SELECTOR = ".notor-daily-start-notice";

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible server (started on demand)
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const server = { completions: 0, instance: null as http.Server | null };

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function startMockServer(): void {
	const srv = http.createServer((req, res) => {
		if (req.method === "OPTIONS") {
			res.writeHead(204, CORS_HEADERS);
			res.end();
			return;
		}
		if (req.url?.endsWith("/models")) {
			res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: MOCK_MODEL, object: "model" }] }));
			return;
		}
		if (!req.url?.endsWith("/chat/completions")) {
			res.writeHead(404, CORS_HEADERS);
			res.end();
			return;
		}
		req.resume();
		req.on("end", () => {
			server.completions++;
			res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			res.write(sseChunk({ choices: [{ index: 0, delta: { content: RESPONSE_TEXT } }] }));
			res.write(sseChunk({
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 12, completion_tokens: 8 },
			}));
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	srv.listen(MOCK_PORT, "127.0.0.1");
	server.instance = srv;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function readCounter(): number {
	if (!fs.existsSync(COUNTER_FILE)) return 0;
	return fs.readFileSync(COUNTER_FILE, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
}

/** Text of every visible daily-start Notice. */
async function dailyNotices(page: Page): Promise<string[]> {
	return page.evaluate((sel: string) =>
		Array.from(document.querySelectorAll(sel)).map((n) => n.textContent?.trim() ?? ""),
	NOTICE_SELECTOR);
}

/** Poll until a daily-start Notice contains `needle`; returns its text or null. */
async function waitForNotice(page: Page, needle: string, timeoutMs: number): Promise<string | null> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const match = (await dailyNotices(page)).find((t) => t.includes(needle));
		if (match) return match;
		await page.waitForTimeout(500);
	}
	return null;
}

/** Click a button inside the daily-start Notice whose text contains `needle`. */
async function clickNoticeButton(page: Page, needle: string, buttonText: string): Promise<boolean> {
	return page.evaluate(({ sel, n, b }: { sel: string; n: string; b: string }) => {
		const notice = Array.from(document.querySelectorAll(sel)).find((el) => el.textContent?.includes(n));
		const button = Array.from(notice?.querySelectorAll("button") ?? []).find((el) => el.textContent?.trim() === b);
		if (!button) return false;
		(button as HTMLButtonElement).click();
		return true;
	}, { sel: NOTICE_SELECTOR, n: needle, b: buttonText });
}

async function clearDeviceState(page: Page): Promise<void> {
	await page.evaluate((key: string) => {
		const app = (window as unknown as { app: { saveLocalStorage: (k: string, v: unknown) => void } }).app;
		app.saveLocalStorage(key, null);
	}, STORAGE_KEY);
}

async function readDeviceState(page: Page): Promise<{ lastFiredDay: string | null } | null> {
	return page.evaluate((key: string) => {
		const app = (window as unknown as { app: { loadLocalStorage: (k: string) => unknown } }).app;
		return app.loadLocalStorage(key) as { lastFiredDay: string | null } | null;
	}, STORAGE_KEY);
}

async function reloadAndSettle(page: Page): Promise<void> {
	await page.reload();
	await page.waitForSelector(".notor-chat-container", { timeout: 30_000 });
	// Discovery (workflows, circuits, extensions) completes before the first check.
	await page.waitForTimeout(8_000);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testFirstLoadFires(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: First load of the day fires the hook and reports the pre-flight failure");
	const { page } = ctx;

	// localStorage outlives the vault reset — start from a fresh device state.
	await clearDeviceState(page);
	if (fs.existsSync(COUNTER_FILE)) fs.unlinkSync(COUNTER_FILE);
	await reloadAndSettle(page);

	const count = readCounter();
	if (count === 1) {
		ctx.pass("Shell hook fires once on load", "Counter file has 1 line");
	} else {
		ctx.fail("Shell hook fires once on load", `Counter file has ${count} line(s), expected 1`);
	}

	const state = await readDeviceState(page);
	if (state?.lastFiredDay) {
		ctx.pass("Fired day persisted per device", `lastFiredDay = ${state.lastFiredDay}`);
	} else {
		ctx.fail("Fired day persisted per device", `State: ${JSON.stringify(state)}`);
	}

	const failure = await waitForNotice(page, "couldn't reach", 30_000);
	const shot = await ctx.screenshot("01-preflight-failure");
	if (failure && failure.includes("Mock local") && failure.includes("no network or provider unreachable") && failure.includes("Retry now")) {
		ctx.pass("Pre-flight failure Notice", failure, shot);
	} else {
		ctx.fail("Pre-flight failure Notice", `Notices: ${JSON.stringify(await dailyNotices(page))}`, shot);
	}
	if (server.completions === 0) {
		ctx.pass("Workflow not launched while provider is down", "No completion requests");
	} else {
		ctx.fail("Workflow not launched while provider is down", `${server.completions} completion request(s)`);
	}
}

async function testRetryNowLaunches(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Retry now launches the workflow once the provider is reachable");
	const { page } = ctx;

	startMockServer();
	await page.waitForTimeout(500);
	if (!(await clickNoticeButton(page, "couldn't reach", "Retry now"))) {
		ctx.fail("Click Retry now", "Retry now button not found");
		return;
	}

	const finished = await waitForNotice(page, "'daily-brief' finished", 60_000);
	const shot = await ctx.screenshot("02-run-finished");
	if (finished && server.completions >= 1) {
		ctx.pass("Workflow runs after retry", `${finished} (${server.completions} completion request(s))`, shot);
	} else {
		ctx.fail("Workflow runs after retry", `Notices: ${JSON.stringify(await dailyNotices(page))}; completions: ${server.completions}`, shot);
		return;
	}

	await clickNoticeButton(page, "'daily-brief' finished", "Open");
	const start = Date.now();
	let opened = false;
	while (Date.now() - start < 15_000 && !opened) {
		opened = await page.evaluate((text: string) =>
			Array.from(document.querySelectorAll(".notor-message-assistant")).some((m) => m.textContent?.includes(text)),
		RESPONSE_TEXT);
		if (!opened) await page.waitForTimeout(500);
	}
	const shot2 = await ctx.screenshot("02b-conversation-open");
	if (opened) {
		ctx.pass("Open shows the run's conversation", "Assistant reply visible in the chat panel", shot2);
	} else {
		ctx.fail("Open shows the run's conversation", "Assistant reply not found in the chat panel", shot2);
	}
}

async function testReloadSameDay(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Reload on the same logical day does not fire again");
	const completionsBefore = server.completions;
	await reloadAndSettle(ctx.page);

	const count = readCounter();
	if (count === 1 && server.completions === completionsBefore) {
		ctx.pass("No re-fire on same-day reload", `Counter ${count}, completions unchanged`);
	} else {
		ctx.fail("No re-fire on same-day reload", `Counter ${count}, completions ${completionsBefore} → ${server.completions}`);
	}
}

async function testResetFiresAgain(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Clearing device state fires again on the next load");
	const { page } = ctx;
	const completionsBefore = server.completions;
	await clearDeviceState(page);
	await reloadAndSettle(page);

	const count = readCounter();
	if (count === 2) {
		ctx.pass("Shell hook fires after reset", "Counter file has 2 lines");
	} else {
		ctx.fail("Shell hook fires after reset", `Counter file has ${count} line(s), expected 2`);
	}

	const finished = await waitForNotice(page, "'daily-brief' finished", 60_000);
	if (finished && server.completions > completionsBefore) {
		ctx.pass("Workflow runs after reset with provider up", finished);
	} else {
		ctx.fail("Workflow runs after reset with provider up", `completions ${completionsBefore} → ${server.completions}`);
	}
}

async function testCommands(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Daily start commands are available");
	const available = await ctx.page.evaluate(() => {
		const app = (window as unknown as {
			app: { commands: { listCommands: () => Array<{ id: string; checkCallback?: (checking: boolean) => boolean }> } };
		}).app;
		return app.commands.listCommands()
			.filter((c) => c.id === "notor:open-latest-daily-start-run" || c.id === "notor:run-daily-start-now")
			.map((c) => ({ id: c.id, ok: c.checkCallback ? c.checkCallback(true) : false }));
	});
	if (available.length === 2 && available.every((c) => c.ok)) {
		ctx.pass("Commands available", available.map((c) => c.id).join(", "));
	} else {
		ctx.fail("Commands available", JSON.stringify(available));
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	try {
		await ctx.page.waitForTimeout(5_000); // Wait for plugin init
		await testFirstLoadFires(ctx);
		await testRetryNowLaunches(ctx);
		await testReloadSameDay(ctx);
		await testResetFiresAgain(ctx);
		await testCommands(ctx);
	} finally {
		server.instance?.close();
		await clearDeviceState(ctx.page).catch(() => undefined);
		if (fs.existsSync(COUNTER_FILE)) fs.unlinkSync(COUNTER_FILE);
	}
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
	active_provider: "local",
	providers: [
		{ id: "local", type: "local", enabled: true, display_name: "Mock local", endpoint: `http://127.0.0.1:${MOCK_PORT}/v1`, model_id: MOCK_MODEL },
	],
	model_presets: [
		{ name: "tiny", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
		{ name: "small", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
		{ name: "medium", provider_id: "local", model_id: MOCK_MODEL, use_extended_context: false, thinking_level: null },
		{ name: "large", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
	],
	default_preset: "medium",
	model_context_overrides: { [MOCK_MODEL]: 128_000 },
	mode: "act",
	vault_event_hooks: {
		on_note_open: [],
		on_note_create: [],
		on_save: [],
		on_manual_save: [],
		on_tag_change: [],
		on_schedule: [],
		on_daily_start: [
			{
				id: "daily-start-counter",
				event: "on_daily_start",
				action_type: "execute_command",
				command: `echo "daily" >> "${COUNTER_FILE}"`,
				workflow_path: null,
				label: "Daily start counter",
				enabled: true,
				schedule: null,
				delay_ms: null,
			},
		],
	},
});

runTest({
	name: "daily-start",
	settings,
	setupVault: (vaultPath) => {
		const file = path.join(vaultPath, WORKFLOW_PATH);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `---
notor-type: workflow
notor-trigger: on-daily-start
notor-conversation-mode: act
---

Say good morning in one sentence. Do not use any tools.
`);
	},
	cleanupFiles: [WORKFLOW_PATH],
}, tests);
