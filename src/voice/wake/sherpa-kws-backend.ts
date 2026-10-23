/**
 * sherpa-onnx keyword-spotter backend.
 *
 * Runs the embedded Python wrapper (`kws-wrapper-script.ts`) as a long-lived
 * sidecar, streams microphone frames to its stdin as 16-bit PCM, and turns its
 * JSON-line hits into `WakeHit`s. Unexpected exits restart the sidecar with
 * backoff; a crash loop surfaces as an `error` status the controller turns
 * into a Notice. Hit positions are reported on the plugin's own sample
 * counter, so they stay aligned across restarts.
 */

import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { existsSync, readdirSync } from "fs";
import { resolveExecutable, resolveLoginShellPath } from "../../shell/login-shell-path";
import { logger } from "../../utils/logger";
import type { VoiceConfigProblem, VoiceProblemCode } from "../stt/types";
import { KWS_WRAPPER_PY } from "./kws-wrapper-script";
import type { WakeHit, WakeStatus, WakeWordDetector } from "./types";

const log = logger("WakeWord");

export interface SherpaKwsConfig {
	/** Python interpreter — bare name (login-shell PATH) or absolute path. */
	pythonPath: string;
	/** Model directory with tokens.txt, bpe.model and encoder/decoder/joiner .onnx files. */
	modelDir: string;
	/** Wake word first, then alternative spellings. */
	spellings: string[];
	threshold: number;
	score: number;
	numThreads: number;
}

/** Injectable dependencies (tests replace the process and file-system layers). */
export interface SherpaKwsDeps {
	spawnFn?: typeof nodeSpawn;
	fileExists?: (path: string) => boolean;
	listDir?: (path: string) => string[];
	resolveExe?: (nameOrPath: string) => string | null;
	loginPath?: () => string;
	/** Time allowed for the wrapper to load the model and report ready. Default 30 000. */
	readyTimeoutMs?: number;
}

/** Backoff schedule for restarting a sidecar that exited unexpectedly. */
export const KWS_RESTART_DELAYS_MS = [1_000, 4_000, 10_000];

/** Unwritten PCM beyond this (~30 s at 16 kHz) is dropped rather than buffered. */
const MAX_PENDING_BYTES = 1_000_000;

const SIGKILL_GRACE_MS = 3_000;

/** A startup failure with the problem to show the user. */
export class KwsStartError extends Error {
	constructor(public readonly problem: VoiceConfigProblem) {
		super(problem.message);
		this.name = "KwsStartError";
	}
}

/** Build the sidecar arguments (exported for tests). */
export function buildKwsArgs(config: SherpaKwsConfig, sampleRate: number): string[] {
	const [keyword = "", ...variants] = config.spellings;
	const args = ["-u", "-c", KWS_WRAPPER_PY, "--model-dir", config.modelDir, "--keyword", keyword];
	for (const variant of variants) args.push("--variant", variant);
	args.push(
		"--threshold", String(config.threshold),
		"--score", String(config.score),
		"--num-threads", String(config.numThreads),
		"--sample-rate", String(Math.round(sampleRate)),
	);
	return args;
}

/** Float32 [-1, 1] → 16-bit little-endian PCM. */
export function floatToInt16LE(frame: Float32Array): Buffer {
	const out = Buffer.alloc(frame.length * 2);
	for (let i = 0; i < frame.length; i++) {
		const s = Math.max(-1, Math.min(1, frame[i]!));
		out.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
	}
	return out;
}

interface WrapperMessage {
	type?: string;
	code?: string;
	message?: string;
	keyword?: string;
	endSample?: number;
	version?: string;
	tokens?: string[];
}

export class SherpaKwsBackend implements WakeWordDetector {
	private _status: WakeStatus = "stopped";
	private child: ChildProcess | null = null;
	private sampleRate = 16_000;
	private starting: Promise<void> | null = null;
	private restartAttempts = 0;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;
	/** Every sample handed to `push`, written or not. */
	private pushedSamples = 0;
	/** `pushedSamples` when the current sidecar became ready (its sample 0). */
	private sampleOffset = 0;
	/** Samples dropped (backpressure) since the current sidecar started. */
	private droppedSamples = 0;
	private readonly hitListeners = new Set<(hit: WakeHit) => void>();
	private readonly statusListeners = new Set<(status: WakeStatus, detail?: string) => void>();

	private readonly spawnFn: typeof nodeSpawn;
	private readonly fileExists: (path: string) => boolean;
	private readonly listDir: (path: string) => string[];
	private readonly resolveExe: (nameOrPath: string) => string | null;
	private readonly loginPath: () => string;
	private readonly readyTimeoutMs: number;

	constructor(private readonly config: SherpaKwsConfig, deps: SherpaKwsDeps = {}) {
		this.spawnFn = deps.spawnFn ?? nodeSpawn;
		this.fileExists = deps.fileExists ?? existsSync;
		this.listDir = deps.listDir ?? ((p) => readdirSync(p));
		this.resolveExe = deps.resolveExe ?? ((p) => resolveExecutable(p));
		this.loginPath = deps.loginPath ?? resolveLoginShellPath;
		this.readyTimeoutMs = deps.readyTimeoutMs ?? 30_000;
	}

	get status(): WakeStatus {
		return this._status;
	}

	onHit(listener: (hit: WakeHit) => void): () => void {
		this.hitListeners.add(listener);
		return () => {
			this.hitListeners.delete(listener);
		};
	}

	onStatus(listener: (status: WakeStatus, detail?: string) => void): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	preflight(): VoiceConfigProblem[] {
		const problems: VoiceConfigProblem[] = [];
		if (!this.resolveExe(this.config.pythonPath)) {
			problems.push({
				code: "kws_python_not_found",
				message:
					`Python was not found for wake-word detection (looked for "${this.config.pythonPath}" on your login-shell PATH). ` +
					"Install Python 3 or set the interpreter path in Settings → Notor → Voice.",
			});
		}
		const dir = this.config.modelDir.trim();
		if (!dir) {
			problems.push({
				code: "kws_model_missing",
				message: "No wake-word model folder is configured. Download a sherpa-onnx keyword-spotting model and set its folder in Settings → Notor → Voice.",
			});
		} else if (!this.fileExists(dir)) {
			problems.push({ code: "kws_model_missing", message: `Wake-word model folder not found: ${dir}` });
		} else {
			const missing = this.missingModelFiles(dir);
			if (missing.length > 0) {
				problems.push({
					code: "kws_model_missing",
					message: `The wake-word model folder is missing ${missing.join(", ")}: ${dir}`,
				});
			}
		}
		if (!this.config.spellings[0]?.trim()) {
			problems.push({ code: "kws_keyword_invalid", message: "No wake word is configured. Set one in Settings → Notor → Voice." });
		}
		return problems;
	}

	async start(sampleRate: number): Promise<void> {
		if (this.disposed) throw new Error("Wake-word detector has been disposed.");
		this.sampleRate = sampleRate;
		if (this._status === "ready" && this.child) return;
		if (this.starting) return this.starting;
		this.starting = this.launch().finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	push(frame: Float32Array): void {
		this.pushedSamples += frame.length;
		const stdin = this.child?.stdin;
		if (this._status !== "ready" || !stdin || !stdin.writable) return;
		if (stdin.writableLength > MAX_PENDING_BYTES) {
			if (this.droppedSamples === 0) log.warn("Wake-word detector is falling behind; dropping audio");
			this.droppedSamples += frame.length;
			return;
		}
		stdin.write(floatToInt16LE(frame));
	}

	/** Stop and restart the sidecar (after system wake or a settings change). */
	async restart(): Promise<void> {
		if (this.disposed) return;
		this.clearRestartTimer();
		this.killChild();
		this.child = null;
		this.restartAttempts = 0;
		this.setStatus("stopped");
		await this.start(this.sampleRate);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.clearRestartTimer();
		this.killChild();
		this.child = null;
		this.setStatus("stopped");
		this.hitListeners.clear();
		this.statusListeners.clear();
	}

	// -----------------------------------------------------------------------

	private missingModelFiles(dir: string): string[] {
		let files: string[];
		try {
			files = this.listDir(dir);
		} catch {
			return ["tokens.txt", "bpe.model", "encoder/decoder/joiner .onnx files"];
		}
		const missing: string[] = [];
		for (const name of ["tokens.txt", "bpe.model"]) {
			if (!files.includes(name)) missing.push(name);
		}
		for (const part of ["encoder", "decoder", "joiner"]) {
			if (!files.some((f) => f.startsWith(part) && f.endsWith(".onnx"))) missing.push(`${part}*.onnx`);
		}
		return missing;
	}

	private setStatus(status: WakeStatus, detail?: string): void {
		this._status = status;
		for (const listener of this.statusListeners) {
			try {
				listener(status, detail);
			} catch (e) {
				log.error("status listener threw", { error: String(e) });
			}
		}
	}

	private launch(): Promise<void> {
		const problems = this.preflight();
		if (problems.length > 0) {
			const message = problems.map((p) => p.message).join(" ");
			this.setStatus("error", message);
			return Promise.reject(new KwsStartError(problems[0]!));
		}
		const exe = this.resolveExe(this.config.pythonPath)!;
		this.setStatus("starting");

		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v !== undefined) env[k] = v;
		}
		const loginPath = this.loginPath();
		if (loginPath) env.PATH = loginPath;

		log.info("Spawning keyword spotter", { exe, modelDir: this.config.modelDir, spellings: this.config.spellings });
		const child = this.spawnFn(exe, buildKwsArgs(this.config, this.sampleRate), { env, stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;

		let stderrTail = "";
		child.stderr?.on("data", (chunk: Buffer | string) => {
			const s = String(chunk);
			stderrTail = (stderrTail + s).slice(-4000);
			log.debug("keyword spotter stderr", { line: s.trim().slice(0, 500) });
		});
		child.stdin?.on("error", (e) => log.debug("keyword spotter stdin error", { error: String(e) }));
		child.once("error", (e) => log.error("keyword spotter process error", { error: String(e) }));

		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const settle = (error?: KwsStartError) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) {
					this.killChild();
					if (this.child === child) this.child = null;
					this.setStatus("error", error.message);
					reject(error);
				} else {
					// Audio is written from here on; earlier frames were only counted.
					this.sampleOffset = this.pushedSamples;
					this.droppedSamples = 0;
					this.restartAttempts = 0;
					this.setStatus("ready");
					resolve();
				}
			};
			const timer = setTimeout(() => {
				settle(new KwsStartError({
					code: "kws_failed",
					message: `The wake-word detector did not start within ${Math.round(this.readyTimeoutMs / 1000)} seconds.`,
				}));
			}, this.readyTimeoutMs);

			let buffered = "";
			child.stdout?.on("data", (chunk: Buffer | string) => {
				buffered += String(chunk);
				let newline: number;
				while ((newline = buffered.indexOf("\n")) >= 0) {
					const line = buffered.slice(0, newline).trim();
					buffered = buffered.slice(newline + 1);
					if (!line) continue;
					let message: WrapperMessage;
					try {
						message = JSON.parse(line) as WrapperMessage;
					} catch {
						log.debug("keyword spotter stdout (not JSON)", { line: line.slice(0, 300) });
						continue;
					}
					this.handleMessage(message, child, settled ? null : settle);
				}
			});

			child.once("exit", (code, signal) => {
				if (!settled) {
					const detail = stderrTail.trim().slice(-300);
					settle(new KwsStartError({
						code: "kws_failed",
						message: `The wake-word detector exited during startup${detail ? `: ${detail}` : ""}`,
					}));
					return;
				}
				this.handleExit(child, code, signal, stderrTail);
			});
		});
	}

	private handleMessage(message: WrapperMessage, child: ChildProcess, settle: ((error?: KwsStartError) => void) | null): void {
		switch (message.type) {
			case "ready":
				log.info("Keyword spotter ready", { version: message.version, tokens: message.tokens });
				settle?.();
				break;
			case "hit": {
				if (this.child !== child || typeof message.endSample !== "number") return;
				const hit: WakeHit = {
					keyword: message.keyword ?? "",
					endSample: this.sampleOffset + this.droppedSamples + message.endSample,
				};
				log.info("Wake word heard", { keyword: hit.keyword });
				for (const listener of this.hitListeners) {
					try {
						listener(hit);
					} catch (e) {
						log.error("hit listener threw", { error: String(e) });
					}
				}
				break;
			}
			case "warning":
				log.warn("Keyword spotter warning", { message: message.message });
				break;
			case "error": {
				const problem = this.problemFor(message);
				log.error("Keyword spotter error", { code: message.code, message: message.message });
				if (settle) settle(new KwsStartError(problem));
				else this.setStatus("error", problem.message);
				break;
			}
		}
	}

	private problemFor(message: WrapperMessage): VoiceConfigProblem {
		const detail = message.message ?? "";
		const codes: Record<string, VoiceProblemCode> = {
			module_missing: "kws_module_missing",
			model_missing: "kws_model_missing",
			keyword_invalid: "kws_keyword_invalid",
		};
		const code = codes[message.code ?? ""] ?? "kws_failed";
		switch (code) {
			case "kws_module_missing":
				return {
					code,
					message: `The sherpa-onnx Python packages are not installed (${detail}). Run: ${this.config.pythonPath} -m pip install sherpa-onnx sentencepiece`,
				};
			case "kws_keyword_invalid":
				return { code, message: `The wake word cannot be used with this model. ${detail}` };
			default:
				return { code, message: `Wake-word detection failed: ${detail}` };
		}
	}

	private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null, stderrTail: string): void {
		if (this.disposed || this.child !== child) return;
		this.child = null;
		if (this._status !== "ready") return;

		log.warn("Keyword spotter exited unexpectedly", { code, signal });
		const delay = KWS_RESTART_DELAYS_MS[this.restartAttempts];
		if (delay === undefined) {
			const detail = stderrTail.trim().slice(-300);
			this.setStatus("error", `The wake-word detector stopped repeatedly${detail ? ` (${detail})` : ""}.`);
			return;
		}
		this.restartAttempts++;
		this.setStatus("starting", `Restarting wake-word detection (attempt ${this.restartAttempts})…`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			if (this.disposed) return;
			this.starting = this.launch()
				.catch((e) => log.error("Keyword spotter restart failed", { error: String(e) }))
				.finally(() => {
					this.starting = null;
				});
		}, delay);
	}

	private clearRestartTimer(): void {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
	}

	private killChild(): void {
		const child = this.child;
		if (!child) return;
		try {
			child.stdin?.end();
			child.kill("SIGTERM");
		} catch {
			// already gone
		}
		const timer = setTimeout(() => {
			if (child.exitCode === null && !child.killed) {
				try {
					child.kill("SIGKILL");
				} catch {
					// already gone
				}
			}
		}, SIGKILL_GRACE_MS);
		child.once("exit", () => clearTimeout(timer));
	}
}
