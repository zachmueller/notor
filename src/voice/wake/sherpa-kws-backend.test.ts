import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

vi.mock("../../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { KWS_WRAPPER_PY } from "./kws-wrapper-script";
import {
	KwsStartError,
	SherpaKwsBackend,
	buildKwsArgs,
	floatToInt16LE,
	type SherpaKwsConfig,
} from "./sherpa-kws-backend";
import type { WakeHit, WakeStatus } from "./types";

class FakeStdin extends EventEmitter {
	writable = true;
	writableLength = 0;
	written: Buffer[] = [];
	write = vi.fn((chunk: Buffer) => {
		this.written.push(chunk);
		return true;
	});
	end = vi.fn(() => {
		this.writable = false;
	});
}

class FakeChild extends EventEmitter {
	stdin = new FakeStdin();
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
		if (this.exitCode !== null) return;
		this.exitCode = code ?? (signal ? 143 : 0);
		this.emit("exit", code, signal);
	}
	say(message: Record<string, unknown>): void {
		this.stdout.emit("data", `${JSON.stringify(message)}\n`);
	}
}

const MODEL_FILES = [
	"tokens.txt",
	"bpe.model",
	"encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
	"decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
	"joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
];

const config: SherpaKwsConfig = {
	pythonPath: "python3",
	modelDir: "/models/kws",
	spellings: ["Hey Notor", "Hey Nota"],
	threshold: 0.15,
	score: 2,
	numThreads: 1,
};

function makeHarness(
	overrides: Partial<SherpaKwsConfig> = {},
	deps: { resolveExe?: string | null; dirExists?: boolean; files?: string[] } = {},
) {
	const children: FakeChild[] = [];
	const spawnFn = vi.fn(() => {
		const child = new FakeChild();
		children.push(child);
		return child as unknown as ChildProcess;
	});
	const backend = new SherpaKwsBackend({ ...config, ...overrides }, {
		spawnFn: spawnFn as never,
		fileExists: () => deps.dirExists ?? true,
		listDir: () => deps.files ?? MODEL_FILES,
		resolveExe: () => (deps.resolveExe === undefined ? "/usr/bin/python3" : deps.resolveExe),
		loginPath: () => "/opt/homebrew/bin:/usr/bin",
		readyTimeoutMs: 5_000,
	});
	return { backend, children, spawnFn };
}

/** Start and answer the ready handshake. */
async function startReady(h: ReturnType<typeof makeHarness>, sampleRate = 16_000) {
	const started = h.backend.start(sampleRate);
	await Promise.resolve();
	h.children[h.children.length - 1]!.say({ type: "ready", version: "2.0.0", tokens: ["▁HE Y ▁NOT OR"] });
	await started;
	return h.children[h.children.length - 1]!;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("buildKwsArgs", () => {
	it("runs the embedded wrapper with the wake word, variants and tuning", () => {
		expect(buildKwsArgs(config, 16_000)).toEqual([
			"-u", "-c", KWS_WRAPPER_PY,
			"--model-dir", "/models/kws",
			"--keyword", "Hey Notor",
			"--variant", "Hey Nota",
			"--threshold", "0.15",
			"--score", "2",
			"--num-threads", "1",
			"--sample-rate", "16000",
		]);
	});

	it("embeds a wrapper that speaks the documented protocol", () => {
		expect(KWS_WRAPPER_PY).toContain("sherpa_onnx.KeywordSpotter(");
		expect(KWS_WRAPPER_PY).toContain('emit(type="hit"');
		expect(KWS_WRAPPER_PY).not.toContain("numpy");
	});
});

describe("floatToInt16LE", () => {
	it("scales, clamps and writes little-endian samples", () => {
		const buf = floatToInt16LE(Float32Array.from([0, 1, -1, 0.5, 2, -2]));
		expect([0, 1, 2, 3, 4, 5].map((i) => buf.readInt16LE(i * 2))).toEqual([0, 32767, -32768, 16384, 32767, -32768]);
	});
});

describe("SherpaKwsBackend.preflight", () => {
	it("is clean when python, the model and a wake word are present", () => {
		expect(makeHarness().backend.preflight()).toEqual([]);
	});

	it("reports a missing interpreter, model folder, model files and wake word", () => {
		expect(makeHarness({}, { resolveExe: null }).backend.preflight().map((p) => p.code)).toEqual(["kws_python_not_found"]);
		expect(makeHarness({ modelDir: "" }).backend.preflight().map((p) => p.code)).toEqual(["kws_model_missing"]);
		expect(makeHarness({}, { dirExists: false }).backend.preflight()[0]!.message).toContain("not found");
		const partial = makeHarness({}, { files: ["tokens.txt", "encoder.onnx"] }).backend.preflight();
		expect(partial[0]!.message).toContain("bpe.model");
		expect(partial[0]!.message).toContain("decoder*.onnx");
		expect(makeHarness({ spellings: [] }).backend.preflight().map((p) => p.code)).toEqual(["kws_keyword_invalid"]);
	});
});

describe("SherpaKwsBackend lifecycle", () => {
	it("spawns python with the login PATH and becomes ready on the handshake", async () => {
		const h = makeHarness();
		const statuses: WakeStatus[] = [];
		h.backend.onStatus((s) => statuses.push(s));
		await startReady(h);
		expect(h.spawnFn).toHaveBeenCalledWith("/usr/bin/python3", expect.arrayContaining(["--keyword", "Hey Notor"]), expect.objectContaining({
			env: expect.objectContaining({ PATH: "/opt/homebrew/bin:/usr/bin" }),
			stdio: ["pipe", "pipe", "pipe"],
		}));
		expect(statuses).toEqual(["starting", "ready"]);
		expect(h.backend.status).toBe("ready");
	});

	it("maps wrapper startup errors to user-facing problems", async () => {
		const h = makeHarness();
		const started = h.backend.start(16_000);
		await Promise.resolve();
		h.children[0]!.say({ type: "error", code: "module_missing", message: "No module named 'sherpa_onnx'" });
		const error = await started.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(KwsStartError);
		expect((error as KwsStartError).problem.code).toBe("kws_module_missing");
		expect((error as KwsStartError).message).toContain("pip install sherpa-onnx sentencepiece");
		expect(h.backend.status).toBe("error");
	});

	it("fails when the sidecar exits before it is ready", async () => {
		const h = makeHarness();
		const started = h.backend.start(16_000);
		await Promise.resolve();
		h.children[0]!.stderr.emit("data", "Traceback: boom");
		h.children[0]!.exit(1);
		await expect(started).rejects.toThrow(/exited during startup: Traceback: boom/);
	});

	it("refuses to start when preflight fails", async () => {
		const h = makeHarness({}, { resolveExe: null });
		await expect(h.backend.start(16_000)).rejects.toBeInstanceOf(KwsStartError);
		expect(h.spawnFn).not.toHaveBeenCalled();
	});
});

describe("SherpaKwsBackend streaming", () => {
	it("writes frames as PCM and reports hits on the caller's sample counter", async () => {
		const h = makeHarness();
		h.backend.push(new Float32Array(1000)); // before start: counted, not written
		const started = h.backend.start(16_000);
		await Promise.resolve();
		h.backend.push(new Float32Array(500)); // starting: counted, not written
		const child = h.children[0]!;
		child.say({ type: "ready" });
		await started;
		const hits: WakeHit[] = [];
		h.backend.onHit((hit) => hits.push(hit));
		h.backend.push(new Float32Array(2048).fill(0.5));
		expect(child.stdin.write).toHaveBeenCalledTimes(1);
		expect(child.stdin.written[0]!.length).toBe(4096);

		child.stdout.emit("data", '{"type":"hit","keyword":"hey_notor",');
		child.stdout.emit("data", '"endSample":2048}\nnot json\n');
		expect(hits).toEqual([{ keyword: "hey_notor", endSample: 3548 }]);
	});

	it("drops audio under backpressure and keeps hit positions aligned", async () => {
		const h = makeHarness();
		const child = await startReady(h);
		const hits: WakeHit[] = [];
		h.backend.onHit((hit) => hits.push(hit));
		child.stdin.writableLength = 2_000_000;
		h.backend.push(new Float32Array(500));
		expect(child.stdin.write).not.toHaveBeenCalled();
		child.stdin.writableLength = 0;
		h.backend.push(new Float32Array(1000));
		child.say({ type: "hit", keyword: "hey_notor", endSample: 1000 });
		expect(hits[0]!.endSample).toBe(1500);
	});

	it("restarts after an unexpected exit and offsets later hits", async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		const first = await startReady(h);
		h.backend.push(new Float32Array(4000));
		const statuses: Array<[WakeStatus, string | undefined]> = [];
		h.backend.onStatus((s, d) => statuses.push([s, d]));
		first.exit(1);
		expect(statuses[0]![0]).toBe("starting");
		h.backend.push(new Float32Array(1000)); // while down: counted, not written
		await vi.advanceTimersByTimeAsync(1_000);
		const second = h.children[1]!;
		second.say({ type: "ready", version: "2.0.0" });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.backend.status).toBe("ready");

		const hits: WakeHit[] = [];
		h.backend.onHit((hit) => hits.push(hit));
		h.backend.push(new Float32Array(800));
		second.say({ type: "hit", keyword: "hey_notor", endSample: 800 });
		expect(hits[0]!.endSample).toBe(5800);
	});

	it("reports an error after repeated crashes", async () => {
		vi.useFakeTimers();
		const h = makeHarness();
		await startReady(h);
		const statuses: WakeStatus[] = [];
		h.backend.onStatus((s) => statuses.push(s));
		for (let attempt = 0; attempt < 3; attempt++) {
			h.children[h.children.length - 1]!.exit(1);
			await vi.advanceTimersByTimeAsync(10_000);
			h.children[h.children.length - 1]!.say({ type: "ready" });
			await vi.advanceTimersByTimeAsync(0);
		}
		h.children[h.children.length - 1]!.exit(1);
		expect(statuses[statuses.length - 1]).toBe("error");
	});

	it("restart() and dispose() stop the sidecar", async () => {
		const h = makeHarness();
		const first = await startReady(h);
		const restarted = h.backend.restart();
		expect(first.stdin.end).toHaveBeenCalled();
		expect(first.kill).toHaveBeenCalledWith("SIGTERM");
		await Promise.resolve();
		h.children[1]!.say({ type: "ready" });
		await restarted;
		expect(h.backend.status).toBe("ready");
		await h.backend.dispose();
		expect(h.children[1]!.kill).toHaveBeenCalled();
		expect(h.backend.status).toBe("stopped");
	});
});
