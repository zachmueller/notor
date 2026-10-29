#!/usr/bin/env npx tsx
/**
 * Microphone capture e2e — the real getUserMedia → AudioWorklet path.
 *
 * Obsidian runs with Chromium's fake capture device (a periodic beep), so no
 * microphone or permission prompt is involved. VoiceManager.captureMicrophoneSample()
 * opens a MicrophoneAudioSource on its own and reports the frames it delivered.
 * Guards the worklet module, which is loaded from a blob URL, against Obsidian's
 * content security policy.
 *
 * Run: npm run e2e:microphone   (add --skip-build to reuse the last build)
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings } from "../lib/test-helpers";

/** Must match MIC_FRAME_SAMPLES in src/voice/voice-manager.ts. */
const FRAME_SAMPLES = 2048;
const CAPTURE_MS = 2_500;

interface CaptureResult {
	ok: boolean;
	error?: string;
	sampleRate?: number;
	frameSizes?: number[];
	peak?: number;
}

function capture(ctx: TestContext): Promise<CaptureResult> {
	return ctx.page.evaluate(`(async () => {
		try {
			const r = await window.app.plugins.plugins["notor"].getVoiceManager().captureMicrophoneSample(${CAPTURE_MS});
			return { ok: true, ...r };
		} catch (e) {
			return { ok: false, error: String(e) };
		}
	})()`) as Promise<CaptureResult>;
}

function checkCapture(ctx: TestContext, label: string, r: CaptureResult): void {
	if (!r.ok || !r.sampleRate || !r.frameSizes) {
		ctx.fail(`${label}: capture starts`, r.error ?? "no result");
		return;
	}
	ctx.pass(`${label}: capture starts`, `sampleRate=${r.sampleRate}`);

	const expected = Math.floor(((CAPTURE_MS / 1000) * r.sampleRate) / FRAME_SAMPLES);
	const count = r.frameSizes.length;
	if (count >= Math.max(1, Math.floor(expected / 2))) {
		ctx.pass(`${label}: frames delivered`, `${count} frames (≈${expected} expected)`);
	} else {
		ctx.fail(`${label}: frames delivered`, `${count} frames, expected ≈${expected}`);
	}

	const wrongSize = r.frameSizes.filter((n) => n !== FRAME_SAMPLES);
	if (count > 0 && wrongSize.length === 0) {
		ctx.pass(`${label}: frame size`, `all ${FRAME_SAMPLES} samples`);
	} else {
		ctx.fail(`${label}: frame size`, `unexpected sizes: ${JSON.stringify([...new Set(wrongSize)])}`);
	}

	if ((r.peak ?? 0) > 0.001) {
		ctx.pass(`${label}: signal present`, `peak=${(r.peak ?? 0).toFixed(3)}`);
	} else {
		ctx.fail(`${label}: signal present`, `peak=${r.peak ?? 0} — frames are silent`);
	}
}

async function tests(ctx: TestContext): Promise<void> {
	const cspViolations: string[] = [];
	ctx.page.on("console", (msg) => {
		if (/Content Security Policy|AudioWorklet/i.test(msg.text())) cspViolations.push(msg.text());
	});

	await ctx.page.waitForFunction(`!!window.app?.plugins?.plugins?.["notor"]`, undefined, { timeout: 15_000 });

	console.log("\n=== Test 1: first capture ===");
	checkCapture(ctx, "first", await capture(ctx));

	console.log("\n=== Test 2: second capture after stop (fresh context re-registers the processor) ===");
	checkCapture(ctx, "second", await capture(ctx));

	console.log("\n=== Test 3: no CSP / worklet errors ===");
	if (cspViolations.length === 0) {
		ctx.pass("no CSP or worklet console errors", "clean");
	} else {
		ctx.fail("no CSP or worklet console errors", cspViolations.slice(0, 3).join(" | "));
	}
}

runTest(
	{
		name: "microphone-capture",
		settings: buildDefaultSettings(),
		extraArgs: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
	},
	tests,
);
