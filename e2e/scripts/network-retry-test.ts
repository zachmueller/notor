#!/usr/bin/env npx tsx
/**
 * Network Retry E2E Test
 *
 * Validates automatic retry of transient provider failures in the main chat
 * against a real (local, in-test) OpenAI-compatible SSE server that can drop
 * the connection mid-stream — the in-flight Wi-Fi failure mode.
 *
 * Scenarios:
 *   1. A mid-stream drop is retried automatically: the partial text is dimmed
 *      (.notor-message-interrupted), a retry status line appears, and the
 *      retried response replaces the partial — no error block.
 *   2. When retries run out, the error shows a Retry button; once the server
 *      is healthy, selecting Retry re-runs the turn without retyping.
 *   3. Offline awareness: going offline during a retry backoff shows
 *      "Waiting for network…" without sending; coming back online resumes.
 *
 * @see ai/notor/ideas/Resilient provider streaming on unstable network connections.md
 * @see src/providers/stream-retry.ts, src/chat/orchestrator.ts (streamWithRetry)
 */

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "playwright-core";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	ensureCleanState,
	getLastAssistantMessage,
	newConversation,
	waitForResponse,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

/** Fixed port so the endpoint can live in the initial settings. */
const MOCK_PORT = 18_734;
const MOCK_MODEL = "mock-model";
const PARTIAL_TEXT = "Partial answer that gets cut";
const RECOVERED_TEXT = "Recovered answer after retry.";

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible server
// ---------------------------------------------------------------------------

/**
 * - `drop-once`: the next completion streams PARTIAL_TEXT then drops the
 *   socket; later completions are healthy.
 * - `always-drop`: every completion drops mid-stream.
 * - `healthy`: every completion streams RECOVERED_TEXT.
 */
type ServerMode = "drop-once" | "always-drop" | "healthy";

const server = {
	mode: "healthy" as ServerMode,
	completions: 0,
	/** Delay before the first chunk of a healthy response (keeps the interrupted block observable). */
	healthyFirstChunkDelayMs: 1_500,
};

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function startMockServer(): http.Server {
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
			const drop = server.mode === "always-drop" || server.mode === "drop-once";
			if (server.mode === "drop-once") server.mode = "healthy";

			res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			if (drop) {
				res.write(sseChunk({ choices: [{ index: 0, delta: { content: PARTIAL_TEXT } }] }));
				// Abruptly kill the connection mid-stream (no [DONE], no clean end).
				setTimeout(() => res.socket?.destroy(), 400);
				return;
			}
			setTimeout(() => {
				res.write(sseChunk({ choices: [{ index: 0, delta: { content: RECOVERED_TEXT } }] }));
				res.write(sseChunk({
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: { prompt_tokens: 12, completion_tokens: 6 },
				}));
				res.write("data: [DONE]\n\n");
				res.end();
			}, server.healthyFirstChunkDelayMs);
		});
	});
	srv.listen(MOCK_PORT, "127.0.0.1");
	return srv;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Submit a message without waiting for the response (to observe interim UI). */
async function submitMessage(page: Page, message: string): Promise<void> {
	await page.evaluate((msg: string) => {
		const el = document.querySelector(".notor-text-input") as HTMLElement | null;
		if (!el) throw new Error("Chat input not found");
		el.focus();
		el.textContent = msg;
		el.dispatchEvent(new Event("input", { bubbles: true }));
	}, message);
	await page.waitForTimeout(300);
	await page.focus(".notor-text-input");
	await page.keyboard.press("Enter");
}

/** Poll (fast) until `selector` exists; returns its text, or null on timeout. */
async function pollForSelector(page: Page, selector: string, timeoutMs: number): Promise<string | null> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const text = await page.evaluate((sel: string) => {
			const el = document.querySelector(sel);
			return el ? (el.textContent ?? "") : null;
		}, selector);
		if (text !== null) return text;
		await page.waitForTimeout(100);
	}
	return null;
}

async function setRetrySettings(page: Page, retries: number): Promise<void> {
	await page.evaluate((n: number) => {
		const plugin = (window as any).app?.plugins?.plugins?.["notor"];
		plugin.settings.network_retry_max_retries = n;
	}, retries);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testMidStreamDropIsRetried(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Mid-stream drop is retried automatically");
	const { page } = ctx;
	await ensureCleanState(page);
	await newConversation(page);
	await setRetrySettings(page, 6);

	server.mode = "drop-once";
	server.completions = 0;
	await submitMessage(page, "Tell me something.");

	const interrupted = await pollForSelector(page, ".notor-message-interrupted", 10_000);
	const shotInterrupted = await ctx.screenshot("01-interrupted");
	if (interrupted !== null && interrupted.includes(PARTIAL_TEXT)) {
		ctx.pass("partial text kept and dimmed", `Interrupted block: "${interrupted.trim().slice(0, 60)}"`, shotInterrupted);
	} else {
		ctx.fail("partial text kept and dimmed", `No .notor-message-interrupted with partial text (got ${JSON.stringify(interrupted)})`, shotInterrupted);
	}

	const status = await pollForSelector(page, ".notor-chat-retry-status", 5_000);
	if (status !== null && /Connection lost — retrying \(1\/6\)|Retrying \(1\)/.test(status)) {
		ctx.pass("retry status line shown", `Status: "${status}"`);
	} else {
		ctx.fail("retry status line shown", `Unexpected status: ${JSON.stringify(status)}`);
	}

	await waitForResponse(page, 30_000, 500);
	const shotDone = await ctx.screenshot("01-recovered");
	const last = await getLastAssistantMessage(page);
	const state = await page.evaluate(() => ({
		interrupted: document.querySelectorAll(".notor-message-interrupted").length,
		status: document.querySelectorAll(".notor-chat-retry-status").length,
		errors: document.querySelectorAll(".notor-chat-error").length,
		assistants: document.querySelectorAll(".notor-message-assistant").length,
	}));

	if (last.includes(RECOVERED_TEXT) && state.interrupted === 0 && state.status === 0 && state.errors === 0) {
		ctx.pass("retried response replaced the partial", `Final: "${last.trim()}", ${state.assistants} assistant block(s)`, shotDone);
	} else {
		ctx.fail("retried response replaced the partial", `Final: "${last.trim()}", state=${JSON.stringify(state)}`, shotDone);
	}

	if (server.completions === 2) {
		ctx.pass("request re-sent exactly once", "2 completion requests");
	} else {
		ctx.fail("request re-sent exactly once", `${server.completions} completion requests`);
	}

	const retryLogs = ctx.collector.getStructuredLogs().filter((e) => e.message === "Provider stream retry");
	if (retryLogs.length >= 1) {
		ctx.pass("retry logged", `${retryLogs.length} "Provider stream retry" log entr${retryLogs.length === 1 ? "y" : "ies"}`);
	} else {
		ctx.fail("retry logged", "No \"Provider stream retry\" structured log");
	}
}

async function testRetryButtonAfterExhaustion(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Retry button after retries run out");
	const { page } = ctx;
	await ensureCleanState(page);
	await newConversation(page);
	await setRetrySettings(page, 1);

	server.mode = "always-drop";
	server.completions = 0;
	await submitMessage(page, "This will keep failing.");
	await waitForResponse(page, 30_000, 500);

	const shotError = await ctx.screenshot("02-error-with-retry");
	const error = await page.evaluate(() => {
		const el = document.querySelector(".notor-chat-error");
		const btn = el?.querySelector(".notor-chat-error-retry") as HTMLElement | null;
		return el
			? { text: el.textContent ?? "", hasButton: !!btn, buttonVisible: !!btn && getComputedStyle(btn).display !== "none" }
			: null;
	});
	if (error && error.hasButton && error.buttonVisible && /Retried 1 time/.test(error.text)) {
		ctx.pass("error shows Retry button", `Error: "${error.text.trim().slice(0, 140)}"`, shotError);
	} else {
		ctx.fail("error shows Retry button", `Error state: ${JSON.stringify(error)}`, shotError);
	}
	if (server.completions === 2) {
		ctx.pass("retry budget respected", "1 attempt + 1 retry");
	} else {
		ctx.fail("retry budget respected", `${server.completions} completion requests (expected 2)`);
	}

	server.mode = "healthy";
	const clicked = await page.evaluate(() => {
		const btn = document.querySelector(".notor-chat-error-retry") as HTMLElement | null;
		btn?.click();
		return !!btn;
	});
	if (!clicked) {
		ctx.fail("Retry re-runs the turn", "No Retry button to click");
		return;
	}
	await page.waitForTimeout(600);
	await waitForResponse(page, 30_000, 500);
	const shotRetried = await ctx.screenshot("02-after-retry");
	const last = await getLastAssistantMessage(page);
	const userCount = await page.evaluate(() => document.querySelectorAll(".notor-message-user").length);
	if (last.includes(RECOVERED_TEXT) && userCount === 1) {
		ctx.pass("Retry re-runs the turn", `Reply: "${last.trim()}", user messages: ${userCount}`, shotRetried);
	} else {
		ctx.fail("Retry re-runs the turn", `Reply: "${last.trim()}", user messages: ${userCount}`, shotRetried);
	}
}

async function testOfflineWait(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Offline wait doesn't spend retries");
	const { page } = ctx;
	await ensureCleanState(page);
	await newConversation(page);
	await setRetrySettings(page, 6);

	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Network.enable");

	server.mode = "drop-once";
	server.completions = 0;
	try {
		await submitMessage(page, "Survive going offline.");
		const status = await pollForSelector(page, ".notor-chat-retry-status", 10_000);
		if (status === null) {
			ctx.fail("offline wait", "Retry status never appeared");
			return;
		}
		await cdp.send("Network.emulateNetworkConditions", {
			offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
		});

		// Well past the 1s backoff: still waiting, no new request.
		await page.waitForTimeout(4_000);
		const offlineStatus = await page.evaluate(() => document.querySelector(".notor-chat-retry-status")?.textContent ?? null);
		const shotOffline = await ctx.screenshot("03-offline");
		if (offlineStatus === "Waiting for network…" && server.completions === 1) {
			ctx.pass("waits offline without sending", `Status "${offlineStatus}", ${server.completions} request`, shotOffline);
		} else {
			ctx.fail("waits offline without sending", `Status ${JSON.stringify(offlineStatus)}, ${server.completions} requests`, shotOffline);
		}
	} finally {
		await cdp.send("Network.emulateNetworkConditions", {
			offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
		});
	}

	await waitForResponse(page, 30_000, 500);
	const last = await getLastAssistantMessage(page);
	const shotBack = await ctx.screenshot("03-back-online");
	if (last.includes(RECOVERED_TEXT) && server.completions === 2) {
		ctx.pass("resumes when back online", `Reply: "${last.trim()}"`, shotBack);
	} else {
		ctx.fail("resumes when back online", `Reply: "${last.trim()}", ${server.completions} requests`, shotBack);
	}
	await cdp.detach();
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // Wait for plugin init
	const srv = startMockServer();
	try {
		await testMidStreamDropIsRetried(ctx);
		await testRetryButtonAfterExhaustion(ctx);
		await testOfflineWait(ctx);
	} finally {
		srv.close();
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
	// Known context window → no "unknown context window" Notice covering the header buttons.
	model_context_overrides: { [MOCK_MODEL]: 128_000 },
	mode: "act",
	network_retry_max_retries: 6,
});

runTest({ name: "network-retry", settings }, tests);
