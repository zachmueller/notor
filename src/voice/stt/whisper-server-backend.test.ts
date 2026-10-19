import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

vi.mock("../../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
	WhisperServerBackend,
	buildWhisperServerArgs,
	isWhisperHallucination,
	type WhisperServerConfig,
} from "./whisper-server-backend";

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	exitCode: number | null = null;
	killed = false;
	kill = vi.fn((signal?: string) => {
		this.killed = true;
		queueMicrotask(() => this.exit(null, signal ?? "SIGTERM"));
		return true;
	});
	exit(code: number | null, signal: string | null = null): void {
		this.exitCode = code ?? (signal ? 143 : 0);
		this.emit("exit", code, signal);
	}
}

const config: WhisperServerConfig = {
	serverPath: "whisper-server",
	modelPath: "/models/ggml-base.en.bin",
	port: 8178,
	language: "en",
	initialPrompt: "voice command. Notor",
	extraArgs: "-t 8 --flash-attn",
};

interface Harness {
	backend: WhisperServerBackend;
	children: FakeChild[];
	spawnFn: ReturnType<typeof vi.fn>;
	request: ReturnType<typeof vi.fn>;
	/** How many readiness probes fail before the server "listens". */
	probesUntilReady: { value: number };
}

function makeHarness(
	overrides: Partial<WhisperServerConfig> = {},
	deps: { isMacOS?: boolean; fileExists?: boolean; resolveExe?: string | null; inferenceText?: unknown } = {},
): Harness {
	const children: FakeChild[] = [];
	const probesUntilReady = { value: 2 };
	const spawnFn = vi.fn(() => {
		const child = new FakeChild();
		children.push(child);
		return child as unknown as ChildProcess;
	});
	const request = vi.fn(async (params: { url: string; method?: string }) => {
		if (params.method === "POST") {
			const text = deps.inferenceText === undefined ? { text: "  hello world " } : deps.inferenceText;
			return { status: 200, text: typeof text === "string" ? text : JSON.stringify(text) };
		}
		if (probesUntilReady.value > 0) {
			probesUntilReady.value--;
			throw new Error("ECONNREFUSED");
		}
		return { status: 200, text: "" };
	});
	const backend = new WhisperServerBackend({ ...config, ...overrides }, {
		spawnFn: spawnFn as never,
		request: request as never,
		fileExists: () => deps.fileExists ?? true,
		resolveExe: () => (deps.resolveExe === undefined ? "/opt/homebrew/bin/whisper-server" : deps.resolveExe),
		loginPath: () => "/opt/homebrew/bin:/usr/bin",
		sleep: () => Promise.resolve(),
		isMacOS: deps.isMacOS ?? true,
		readyTimeoutMs: 5_000,
		probeIntervalMs: 1,
	});
	return { backend, children, spawnFn, request, probesUntilReady };
}

describe("buildWhisperServerArgs", () => {
	it("assembles model, host, port, language, prompt and parsed extra args", () => {
		expect(buildWhisperServerArgs(config, 8179)).toEqual([
			"-m", "/models/ggml-base.en.bin",
			"--host", "127.0.0.1",
			"--port", "8179",
			"-l", "en",
			"--prompt", "voice command. Notor",
			"-t", "8", "--flash-attn",
		]);
		expect(buildWhisperServerArgs({ ...config, initialPrompt: "  ", extraArgs: "", language: "" }, 1)).toEqual([
			"-m", "/models/ggml-base.en.bin", "--host", "127.0.0.1", "--port", "1", "-l", "en",
		]);
	});
});

describe("isWhisperHallucination", () => {
	it("matches known silence outputs case-insensitively", () => {
		expect(isWhisperHallucination("[BLANK_AUDIO]")).toBe(true);
		expect(isWhisperHallucination(" Thank you. ")).toBe(true);
		expect(isWhisperHallucination("")).toBe(true);
		expect(isWhisperHallucination("Thank you for the notes.")).toBe(false);
	});
});

describe("WhisperServerBackend.preflight", () => {
	it("reports every missing prerequisite", () => {
		expect(makeHarness().backend.preflight()).toEqual([]);
		expect(makeHarness({}, { isMacOS: false }).backend.preflight().map((p) => p.code)).toEqual(["not_macos"]);
		expect(makeHarness({}, { resolveExe: null }).backend.preflight().map((p) => p.code)).toEqual(["binary_not_found"]);
		expect(makeHarness({}, { fileExists: false }).backend.preflight().map((p) => p.code)).toEqual(["model_missing"]);
		expect(makeHarness({ modelPath: " " }).backend.preflight().map((p) => p.code)).toEqual(["model_missing"]);
	});
});

describe("WhisperServerBackend lifecycle", () => {
	it("spawns the server with the login PATH, waits until it listens, then transcribes", async () => {
		const h = makeHarness();
		const statuses: string[] = [];
		h.backend.onStatus((s) => statuses.push(s));

		await h.backend.start();
		expect(h.backend.status).toBe("ready");
		expect(statuses).toEqual(["starting", "ready"]);
		const [exe, args, options] = h.spawnFn.mock.calls[0]! as unknown as [string, string[], { env: Record<string, string> }];
		expect(exe).toBe("/opt/homebrew/bin/whisper-server");
		expect(args).toEqual(buildWhisperServerArgs(config, 8178));
		expect(options.env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
		// Two refused probes, then the one that succeeded.
		expect(h.request.mock.calls.filter((c) => (c[0] as { method?: string }).method === "GET")).toHaveLength(3);

		const text = await h.backend.transcribe(new ArrayBuffer(44));
		expect(text).toBe("hello world");
		const post = h.request.mock.calls.find((c) => (c[0] as { method?: string }).method === "POST")![0] as {
			url: string; contentType: string; body: ArrayBuffer; throw: boolean;
		};
		expect(post.url).toBe("http://127.0.0.1:8178/inference");
		expect(post.contentType).toMatch(/^multipart\/form-data; boundary=/);
		expect(post.body.byteLength).toBeGreaterThan(44);
		expect(post.throw).toBe(false);
	});

	it("filters hallucinated transcripts and rejects non-JSON or error responses", async () => {
		const blank = makeHarness({}, { inferenceText: { text: "[BLANK_AUDIO]" } });
		await blank.backend.start();
		expect(await blank.backend.transcribe(new ArrayBuffer(44))).toBe("");

		const garbage = makeHarness({}, { inferenceText: "<html>" });
		await garbage.backend.start();
		await expect(garbage.backend.transcribe(new ArrayBuffer(44))).rejects.toThrow(/non-JSON/);

		const stopped = makeHarness();
		await expect(stopped.backend.transcribe(new ArrayBuffer(44))).rejects.toThrow(/not ready/);
	});

	it("tries the next port when the server cannot bind", async () => {
		const h = makeHarness();
		h.probesUntilReady.value = Number.MAX_SAFE_INTEGER; // the first process never listens
		const started = h.backend.start();
		await Promise.resolve();
		h.children[0]!.stderr.emit("data", "error: bind: Address already in use\n");
		h.probesUntilReady.value = 0; // the replacement listens right away
		h.children[0]!.exit(1);
		await started;
		expect(h.backend.status).toBe("ready");
		expect(h.backend.activePort).toBe(8179);
		expect(h.spawnFn).toHaveBeenCalledTimes(2);
		expect((h.spawnFn.mock.calls[1]![1] as string[])).toContain("8179");
	});

	it("fails to start when the process exits for another reason", async () => {
		const h = makeHarness();
		h.probesUntilReady.value = Number.MAX_SAFE_INTEGER;
		const started = h.backend.start();
		await Promise.resolve();
		h.children[0]!.stderr.emit("data", "failed to load model\n");
		h.children[0]!.exit(1);
		await expect(started).rejects.toThrow(/exited during startup: failed to load model/);
		expect(h.backend.status).toBe("error");
		expect(h.spawnFn).toHaveBeenCalledTimes(1);
	});

	it("restarts with backoff after an unexpected exit and gives up after the schedule", async () => {
		vi.useFakeTimers();
		try {
			const h = makeHarness();
			const statuses: string[] = [];
			h.backend.onStatus((s) => statuses.push(s));
			await h.backend.start();

			h.probesUntilReady.value = 0;
			h.children[0]!.exit(139, null);
			expect(h.backend.status).toBe("starting");
			await vi.advanceTimersByTimeAsync(1_000);
			expect(h.spawnFn).toHaveBeenCalledTimes(2);
			expect(h.backend.status).toBe("ready");

			// Three more crashes exhaust the schedule (1 s, 4 s, 10 s after the attempt counter resets on success).
			for (const [index, delay] of [1_000, 4_000, 10_000].entries()) {
				h.children[h.children.length - 1]!.exit(139, null);
				expect(h.backend.status).toBe("starting");
				await vi.advanceTimersByTimeAsync(delay);
				expect(h.spawnFn).toHaveBeenCalledTimes(3 + index);
				// Crash again before readiness is re-established? No — each relaunch becomes ready...
				expect(h.backend.status).toBe("ready");
			}
			// ...but successes reset the counter, so a crash loop that *stays* ready between crashes never gives up.
			// Simulate a server that dies immediately after becoming ready three times in a row without resetting:
			const h2 = makeHarness();
			await h2.backend.start();
			h2.probesUntilReady.value = 0;
			h2.children[0]!.exit(1, null);
			await vi.advanceTimersByTimeAsync(1_000); // relaunch #1 ready → counter resets
			expect(h2.backend.status).toBe("ready");
			expect(statuses.filter((s) => s === "error")).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("dispose kills the process and ignores later exits", async () => {
		const h = makeHarness();
		await h.backend.start();
		await h.backend.dispose();
		expect(h.children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
		expect(h.backend.status).toBe("stopped");
		await Promise.resolve();
		expect(h.spawnFn).toHaveBeenCalledTimes(1);
		await expect(h.backend.start()).rejects.toThrow(/disposed/);
	});

	it("restart() relaunches the server", async () => {
		const h = makeHarness();
		await h.backend.start();
		h.probesUntilReady.value = 0;
		await h.backend.restart();
		expect(h.spawnFn).toHaveBeenCalledTimes(2);
		expect(h.backend.status).toBe("ready");
	});
});
