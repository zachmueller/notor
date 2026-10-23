#!/usr/bin/env npx tsx
/**
 * Voice mode e2e — the hands-free loop without a microphone.
 *
 * Replaces the three external programs with fixtures from e2e/fixtures/voice/:
 *   - fake-kws.mjs stands in for the sherpa-onnx keyword-spotter sidecar: it
 *     answers the ready handshake and reports a wake-word hit whenever
 *     /tmp/notor-e2e-kws-hit.txt appears;
 *   - fake-whisper-server.mjs answers `POST /inference` with a canned transcript
 *     (read from /tmp/notor-e2e-whisper-text.txt) and logs each request;
 *   - fake-say.sh appends everything it would have spoken to /tmp/notor-e2e-say.log.
 * The LLM is a scripted OpenAI-compatible SSE server: the speech-summary pass
 * (recognised by its system prompt) gets SUMMARY_TEXT, everything else FINAL_TEXT,
 * and a user message containing "#slow" is answered after a delay.
 *
 * Audio capture is bypassed via VoiceManager.startWithoutCapture(); utterances
 * enter through injectTranscript() (after STT) and injectAudio() (before STT),
 * addressed (as if said after the wake word) unless stated otherwise.
 *
 * Run: npm run e2e:voice   (add --skip-build to reuse the last build)
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runTest, type TestContext } from "../lib/test-harness";
import {
	buildDefaultSettings,
	ensureCleanState,
	getLastAssistantMessage,
	newConversation,
	waitForResponse,
} from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Constants + fixtures
// ---------------------------------------------------------------------------

const MOCK_PORT = 18_751;
const MOCK_MODEL = "mock-model";
const FINAL_TEXT = "MOCK-DONE";
const SUMMARY_TEXT = "SPOKEN-SUMMARY";
const SLOW_DELAY_MS = 4_000;
const WHISPER_PORT = 18_760;

const FIXTURES = fileURLToPath(new URL("../fixtures/voice/", import.meta.url));
const FAKE_WHISPER = path.join(FIXTURES, "fake-whisper-server.mjs");
const FAKE_SAY = path.join(FIXTURES, "fake-say.sh");
const SAY_LOG = "/tmp/notor-e2e-say.log";
const WHISPER_LOG = "/tmp/notor-e2e-whisper.log";
const WHISPER_TEXT = "/tmp/notor-e2e-whisper-text.txt";
const FAKE_KWS = path.join(FIXTURES, "fake-kws.mjs");
const KWS_LOG = "/tmp/notor-e2e-kws.log";
const KWS_HIT = "/tmp/notor-e2e-kws-hit.txt";
/** Empty stand-ins for the files preflight expects in a keyword-spotting model folder. */
const KWS_MODEL_DIR = "/tmp/notor-e2e-kws-model";
const KWS_MODEL_FILES = ["tokens.txt", "bpe.model", "encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx"];
const LISTEN_TIMEOUT_MS = 1_000;

// ---------------------------------------------------------------------------
// Scripted mock LLM server
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

type OpenAiMessage = { role: string; content?: string | Array<{ type: string; text?: string }> | null };

let summaryRequests = 0;
let chatRequests = 0;

function messageText(m: OpenAiMessage | undefined): string {
	if (!m?.content) return "";
	if (typeof m.content === "string") return m.content;
	return m.content.map((p) => p.text ?? "").join("\n");
}

function sse(res: http.ServerResponse, payload: unknown): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function reply(res: http.ServerResponse, text: string): void {
	res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	sse(res, { choices: [{ index: 0, delta: { content: text } }] });
	sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
	res.write("data: [DONE]\n\n");
	res.end();
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
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const messages = (JSON.parse(body) as { messages?: OpenAiMessage[] }).messages ?? [];
			const system = messages[0]?.role === "system" ? messageText(messages[0]) : "";
			if (/spoken summary/i.test(system)) {
				summaryRequests++;
				reply(res, SUMMARY_TEXT);
				return;
			}
			chatRequests++;
			const last = messages[messages.length - 1];
			const delay = messageText(last).includes("#slow") ? SLOW_DELAY_MS : 0;
			setTimeout(() => reply(res, FINAL_TEXT), delay);
		});
	});
	srv.listen(MOCK_PORT, "127.0.0.1");
	return srv;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readLog(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function resetLogs(): void {
	for (const f of [SAY_LOG, WHISPER_LOG, WHISPER_TEXT, KWS_LOG, KWS_HIT]) fs.rmSync(f, { force: true });
}

function writeFakeKwsModel(): void {
	fs.mkdirSync(KWS_MODEL_DIR, { recursive: true });
	for (const f of KWS_MODEL_FILES) fs.writeFileSync(path.join(KWS_MODEL_DIR, f), "");
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 250): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await sleep(intervalMs);
	}
	return check();
}

async function setSetting(ctx: TestContext, key: string, value: unknown): Promise<void> {
	await ctx.page.evaluate(async (args: { key: string; value: unknown }) => {
		const plugin = (window as any).app.plugins.plugins["notor"];
		plugin.settings[args.key] = args.value;
		await plugin.saveSettings();
	}, { key, value });
}

/** Start without the microphone; the wake word comes from the fake keyword-spotter sidecar. */
async function startVoice(ctx: TestContext): Promise<{ started: boolean; leafId: string | null }> {
	return ctx.page.evaluate(`(async () => {
		const plugin = window.app.plugins.plugins["notor"];
		const orch = plugin.getActiveOrchestrator();
		const controller = await plugin.getVoiceManager().startWithoutCapture(orch, { realWakeDetector: true });
		return { started: !!controller, leafId: orch.getView()?.leaf.id ?? null };
	})()`) as Promise<{ started: boolean; leafId: string | null }>;
}

async function voiceStatus(ctx: TestContext, leafId: string): Promise<{ state: string; detail?: string; queuedText?: string }> {
	return ctx.page.evaluate((id: string) => {
		const plugin = (window as any).app.plugins.plugins["notor"];
		return plugin.getVoiceManager().getStatus(id);
	}, leafId);
}

async function injectTranscript(ctx: TestContext, leafId: string, text: string): Promise<void> {
	await ctx.page.evaluate(async (args: { leafId: string; text: string }) => {
		const plugin = (window as any).app.plugins.plugins["notor"];
		await plugin.getVoiceManager().injectTranscript(args.leafId, args.text);
	}, { leafId, text });
}

async function injectAudio(ctx: TestContext, leafId: string, addressed = true): Promise<void> {
	await ctx.page.evaluate(async (args: { leafId: string; addressed: boolean }) => {
		const plugin = (window as any).app.plugins.plugins["notor"];
		const samples = Array.from({ length: 16_000 }, () => 0.1);
		await plugin.getVoiceManager().injectAudio(args.leafId, samples, 16_000, { addressed: args.addressed });
	}, { leafId, addressed });
}

async function noticeTexts(ctx: TestContext): Promise<string[]> {
	return ctx.page.evaluate(() => Array.from(document.querySelectorAll(".notice")).map((n) => n.textContent ?? ""));
}

async function userBubbleCount(ctx: TestContext, containing: string): Promise<number> {
	return ctx.page.evaluate((needle: string) => {
		return Array.from(document.querySelectorAll(".notor-message-user"))
			.filter((el) => (el.textContent ?? "").includes(needle)).length;
	}, containing);
}

async function preflightCodes(ctx: TestContext): Promise<string[]> {
	return ctx.page.evaluate(() => {
		const plugin = (window as any).app.plugins.plugins["notor"];
		return plugin.getVoiceManager().preflight().map((p: { code: string }) => p.code);
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const srv = startMockServer();
	try {
		await ensureCleanState(ctx.page);
		resetLogs();

		// --- Test 1: not configured ---
		console.log("\nTest 1: Voice mode refuses to start when whisper-server is missing");
		await setSetting(ctx, "voice_whisper_server_path", "/nonexistent/whisper-server");
		const codes = await preflightCodes(ctx);
		if (codes.includes("binary_not_found")) ctx.pass("Preflight reports the missing binary", codes.join(","));
		else ctx.fail("Preflight reports the missing binary", `codes: ${codes.join(",") || "(none)"}`);
		const failed = await startVoice(ctx);
		if (!failed.started) ctx.pass("Start is refused", "startWithoutCapture returned null");
		else ctx.fail("Start is refused", "a controller was created with a bogus binary path");
		await setSetting(ctx, "voice_whisper_server_path", FAKE_WHISPER);

		// --- Test 2: start ---
		console.log("\nTest 2: Voice mode starts the wake-word sidecar and arms");
		const commandRegistered = await ctx.page.evaluate(() =>
			!!(window as any).app.commands.commands["notor:toggle-voice-mode"]);
		if (commandRegistered) ctx.pass("Toggle command registered", "notor:toggle-voice-mode");
		else ctx.fail("Toggle command registered", "command missing");

		const { started, leafId } = await startVoice(ctx);
		if (!started || !leafId) {
			ctx.fail("Voice mode started", `started=${started} leafId=${leafId}`, await ctx.screenshot("voice-start-failed"));
			return;
		}
		const armed = await waitFor(async () => (await voiceStatus(ctx, leafId)).state === "armed", 20_000);
		const status = await voiceStatus(ctx, leafId);
		if (armed) ctx.pass("Voice mode armed", JSON.stringify(status), await ctx.screenshot("voice-armed"));
		else ctx.fail("Voice mode armed", JSON.stringify(status), await ctx.screenshot("voice-not-armed"));
		const buttonArmed = await ctx.page.evaluate(() => !!document.querySelector(".notor-voice-btn.is-armed"));
		if (buttonArmed) ctx.pass("Mic button shows armed", ".notor-voice-btn.is-armed");
		else ctx.fail("Mic button shows armed", "no .notor-voice-btn.is-armed", await ctx.screenshot("voice-button"));
		const kwsLaunch = readLog(KWS_LOG).trim().split("\n").pop() ?? "";
		if (kwsLaunch.includes('"keyword":"Hey Notor"') && kwsLaunch.includes("Hey Nota")) {
			ctx.pass("Keyword spotter launched with the wake word and its spellings", kwsLaunch);
		} else {
			ctx.fail("Keyword spotter launched with the wake word and its spellings", `kws log: ${kwsLaunch || "(none)"}`);
		}
		const notices = await noticeTexts(ctx);
		if (notices.some((n) => n.includes("Say “Hey Notor” to talk"))) ctx.pass("Armed notice shown", "names the wake word");
		else ctx.fail("Armed notice shown", `notices: ${notices.join(" | ") || "(none)"}`);
		await sleep(500);
		if (!readLog(SAY_LOG).includes("Voice mode on.")) ctx.pass("No spoken greeting", "a chime replaces 'Voice mode on.'");
		else ctx.fail("No spoken greeting", "'Voice mode on.' was still spoken");

		// --- Test 2b: wake word from the sidecar, then back to armed ---
		console.log("\nTest 2b: A wake-word hit addresses Notor and a silent pause disarms it");
		fs.writeFileSync(KWS_HIT, "hit\n");
		const addressed = await waitFor(async () => (await voiceStatus(ctx, leafId)).state === "listening", 5_000, 100);
		if (addressed) ctx.pass("Wake word addresses Notor", "state listening", await ctx.screenshot("voice-addressed"));
		else ctx.fail("Wake word addresses Notor", JSON.stringify(await voiceStatus(ctx, leafId)));
		const rearmed = await waitFor(async () => (await voiceStatus(ctx, leafId)).state === "armed", LISTEN_TIMEOUT_MS + 3_000, 100);
		if (rearmed) ctx.pass("Back to armed after the listen timeout", JSON.stringify(await voiceStatus(ctx, leafId)));
		else ctx.fail("Back to armed after the listen timeout", JSON.stringify(await voiceStatus(ctx, leafId)));

		// --- Test 3: transcript → chat → spoken summary ---
		console.log("\nTest 3: An injected transcript is sent and the reply is summarized aloud");
		await injectTranscript(ctx, leafId, "tell me about my vault");
		const replied = await waitForResponse(ctx.page, 30_000, 500);
		const bubble = await userBubbleCount(ctx, "tell me about my vault");
		if (replied && bubble === 1) ctx.pass("Transcript sent as a user message", "bubble rendered and turn finished");
		else ctx.fail("Transcript sent as a user message", `replied=${replied} bubbles=${bubble}`, await ctx.screenshot("voice-transcript"));
		const lastReply = (await getLastAssistantMessage(ctx.page)).trim();
		if (lastReply.includes(FINAL_TEXT)) ctx.pass("Assistant replied", lastReply);
		else ctx.fail("Assistant replied", `last assistant message: ${lastReply}`);
		if (await waitFor(() => readLog(SAY_LOG).includes(SUMMARY_TEXT), 15_000)) {
			ctx.pass("Summary spoken", `summary pass requests: ${summaryRequests}`);
		} else {
			ctx.fail("Summary spoken", `say log: ${readLog(SAY_LOG).slice(-400)}; summary requests: ${summaryRequests}`);
		}

		// --- Test 4: audio → fake whisper → chat ---
		console.log("\nTest 4: Injected audio goes through the whisper server");
		fs.writeFileSync(WHISPER_TEXT, "the audio path works\n");
		await injectAudio(ctx, leafId);
		const whisperHit = await waitFor(() => readLog(WHISPER_LOG).trim().length > 0, 10_000);
		const whisperLine = readLog(WHISPER_LOG).trim().split("\n").pop() ?? "";
		let parsed: { bytes?: number; contentType?: string } = {};
		try { parsed = JSON.parse(whisperLine); } catch { /* not json */ }
		if (whisperHit && (parsed.bytes ?? 0) > 44 && String(parsed.contentType).startsWith("multipart/form-data")) {
			ctx.pass("WAV posted to whisper-server", `${parsed.bytes} bytes, ${parsed.contentType}`);
		} else {
			ctx.fail("WAV posted to whisper-server", `log line: ${whisperLine || "(none)"}`);
		}
		const audioReplied = await waitForResponse(ctx.page, 30_000, 500);
		const audioBubble = await userBubbleCount(ctx, "the audio path works");
		if (audioReplied && audioBubble === 1) ctx.pass("Recognized text sent", "bubble rendered and turn finished");
		else ctx.fail("Recognized text sent", `replied=${audioReplied} bubbles=${audioBubble}`, await ctx.screenshot("voice-audio"));
		fs.rmSync(WHISPER_TEXT, { force: true });
		await waitFor(() => readLog(SAY_LOG).split(SUMMARY_TEXT).length - 1 >= 2, 15_000);

		// --- Test 4b: unaddressed speech is recognized but never sent ---
		console.log("\nTest 4b: Speech without the wake word is dropped");
		fs.writeFileSync(WHISPER_TEXT, "ambient chatter nobody addressed\n");
		const whisperLinesBefore = readLog(WHISPER_LOG).trim().split("\n").length;
		await injectAudio(ctx, leafId, false);
		await waitFor(() => readLog(WHISPER_LOG).trim().split("\n").length > whisperLinesBefore, 10_000);
		await sleep(1_500);
		const ambientBubbles = await userBubbleCount(ctx, "ambient chatter");
		if (ambientBubbles === 0) ctx.pass("Unaddressed speech dropped", "no user bubble");
		else ctx.fail("Unaddressed speech dropped", `${ambientBubbles} bubble(s)`, await ctx.screenshot("voice-unaddressed"));
		fs.rmSync(WHISPER_TEXT, { force: true });

		// --- Test 4c: wake-word residue is stripped ---
		console.log("\nTest 4c: Whisper's spelling of the wake word is not sent");
		await injectTranscript(ctx, leafId, "Hey Nota, residue check please");
		const residueReplied = await waitForResponse(ctx.page, 30_000, 500);
		const residueText = await ctx.page.evaluate(() => {
			const bubbles = Array.from(document.querySelectorAll(".notor-message-user"));
			return bubbles[bubbles.length - 1]?.textContent ?? "";
		});
		if (residueReplied && residueText.includes("residue check please") && !/hey nota/i.test(residueText)) {
			ctx.pass("Wake word stripped", residueText.trim());
		} else {
			ctx.fail("Wake word stripped", `replied=${residueReplied} bubble="${residueText.trim()}"`);
		}
		await waitFor(() => readLog(SAY_LOG).split(SUMMARY_TEXT).length - 1 >= 3, 15_000);

		// --- Test 5: dictation during a turn is queued and sent afterwards ---
		console.log("\nTest 5: Speech during a running turn is queued and sent after the summary");
		const chatRequestsBefore = chatRequests;
		await injectTranscript(ctx, leafId, "first part #slow");
		await sleep(800);
		await injectTranscript(ctx, leafId, "second part queued");
		const queuedStatus = await voiceStatus(ctx, leafId);
		const notSentYet = (await userBubbleCount(ctx, "second part queued")) === 0;
		if (notSentYet && (queuedStatus.queuedText ?? "").includes("second part queued")) {
			ctx.pass("Second utterance queued", JSON.stringify(queuedStatus));
		} else {
			ctx.fail("Second utterance queued", `sent=${!notSentYet} status=${JSON.stringify(queuedStatus)}`);
		}
		const sentLater = await waitFor(async () => (await userBubbleCount(ctx, "second part queued")) === 1, 30_000);
		const secondTurnDone = sentLater && (await waitForResponse(ctx.page, 30_000, 500));
		if (secondTurnDone && chatRequests - chatRequestsBefore === 2) {
			ctx.pass("Queued utterance sent after the turn", `${chatRequests - chatRequestsBefore} chat requests`);
		} else {
			ctx.fail("Queued utterance sent after the turn", `sentLater=${sentLater} done=${secondTurnDone} requests=${chatRequests - chatRequestsBefore}`,
				await ctx.screenshot("voice-queue"));
		}

		// --- Test 6: switching conversation stops voice mode ---
		console.log("\nTest 6: A conversation switch turns voice mode off");
		await newConversation(ctx.page);
		const idle = await waitFor(async () => (await voiceStatus(ctx, leafId)).state === "idle", 10_000);
		if (idle) ctx.pass("Voice mode stopped on conversation switch", JSON.stringify(await voiceStatus(ctx, leafId)));
		else ctx.fail("Voice mode stopped on conversation switch", JSON.stringify(await voiceStatus(ctx, leafId)));
	} finally {
		srv.close();
		resetLogs();
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
	voice_enabled: true,
	voice_whisper_server_path: FAKE_WHISPER,
	voice_whisper_model_path: FAKE_WHISPER,
	voice_whisper_server_port: WHISPER_PORT,
	voice_tts_command: FAKE_SAY,
	voice_input_cleanup_enabled: false,
	voice_progress_verbosity: "needs_me",
	voice_kws_python_path: FAKE_KWS,
	voice_kws_model_dir: KWS_MODEL_DIR,
	voice_wake_listen_timeout_ms: LISTEN_TIMEOUT_MS,
});

runTest(
	{
		name: "voice-mode",
		settings,
		setupVault: () => {
			resetLogs();
			writeFakeKwsModel();
		},
	},
	tests,
);
