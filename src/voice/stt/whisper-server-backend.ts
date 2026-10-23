/**
 * whisper.cpp `whisper-server` backend.
 *
 * Spawns a long-lived local server (so the model loads once, not per
 * utterance), waits for it to accept connections, and transcribes utterances
 * through `POST /inference` with a multipart WAV body via `requestUrl`
 * (loopback, no CORS). Unexpected exits restart the server with backoff; a
 * crash loop surfaces as an `error` status the controller turns into a spoken
 * message and a Notice.
 */

import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { requestUrl as obsidianRequestUrl } from "obsidian";
import { resolveExecutable, resolveLoginShellPath } from "../../shell/login-shell-path";
import { parseShellArgs } from "../../utils/shell-args";
import { logger } from "../../utils/logger";
import { encodeMultipart, type MultipartPart } from "./multipart";
import type { SttBackend, SttStatus, TranscribeHints, VoiceConfigProblem } from "./types";

const log = logger("WhisperServer");

export interface WhisperServerConfig {
	/** Bare binary name (login-shell PATH) or absolute path. */
	serverPath: string;
	/** Absolute path to the ggml model file. */
	modelPath: string;
	port: number;
	language: string;
	/** Launch-time vocabulary prompt (wake word + user jargon); may be empty. */
	initialPrompt: string;
	/** Extra shell-style arguments appended to the launch command. */
	extraArgs: string;
}

/** Injectable dependencies (tests replace the process and HTTP layers). */
export interface WhisperServerDeps {
	spawnFn?: typeof nodeSpawn;
	request?: typeof obsidianRequestUrl;
	fileExists?: (path: string) => boolean;
	resolveExe?: (nameOrPath: string) => string | null;
	loginPath?: () => string;
	sleep?: (ms: number) => Promise<void>;
	isMacOS?: boolean;
	/** Total time allowed for the server to start accepting connections. Default 60 000. */
	readyTimeoutMs?: number;
	/** Delay between readiness probes. Default 250. */
	probeIntervalMs?: number;
}

/** Backoff schedule for restarting a server that exited unexpectedly. */
export const WHISPER_RESTART_DELAYS_MS = [1_000, 4_000, 10_000];

/** Extra ports tried when the configured one cannot be bound. */
const PORT_RETRIES = 2;

const SIGKILL_GRACE_MS = 3_000;

/**
 * Transcripts whisper is known to produce for silence or noise. Case- and
 * whitespace-insensitive; matched against the whole trimmed transcript.
 */
const HALLUCINATIONS = new Set([
	"",
	".",
	"[blank_audio]",
	"[silence]",
	"(silence)",
	"[music]",
	"(music)",
	"[inaudible]",
	"you",
	"you.",
	"bye.",
	"thank you.",
	"thank you",
	"thanks for watching!",
	"thanks for watching.",
	"subtitles by the amara.org community",
]);

/** True when `text` is a known whisper silence/noise hallucination. */
export function isWhisperHallucination(text: string): boolean {
	const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
	return HALLUCINATIONS.has(normalized);
}

/** Build the whisper-server launch arguments for a config (exported for tests). */
export function buildWhisperServerArgs(config: WhisperServerConfig, port: number): string[] {
	const args = [
		"-m", config.modelPath,
		"--host", "127.0.0.1",
		"--port", String(port),
		"-l", config.language.trim() || "en",
	];
	const prompt = config.initialPrompt.trim();
	if (prompt) args.push("--prompt", prompt);
	args.push(...parseShellArgs(config.extraArgs));
	return args;
}

export class WhisperServerBackend implements SttBackend {
	private _status: SttStatus = "stopped";
	private child: ChildProcess | null = null;
	private port: number;
	private starting: Promise<void> | null = null;
	private restartAttempts = 0;
	private restartTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;
	private readonly listeners = new Set<(status: SttStatus, detail?: string) => void>();

	private readonly spawnFn: typeof nodeSpawn;
	private readonly request: typeof obsidianRequestUrl;
	private readonly fileExists: (path: string) => boolean;
	private readonly resolveExe: (nameOrPath: string) => string | null;
	private readonly loginPath: () => string;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly isMacOS: boolean;
	private readonly readyTimeoutMs: number;
	private readonly probeIntervalMs: number;

	constructor(private readonly config: WhisperServerConfig, deps: WhisperServerDeps = {}) {
		this.port = config.port;
		this.spawnFn = deps.spawnFn ?? nodeSpawn;
		this.request = deps.request ?? obsidianRequestUrl;
		this.fileExists = deps.fileExists ?? existsSync;
		this.resolveExe = deps.resolveExe ?? ((p) => resolveExecutable(p));
		this.loginPath = deps.loginPath ?? resolveLoginShellPath;
		this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.isMacOS = deps.isMacOS ?? process.platform === "darwin";
		this.readyTimeoutMs = deps.readyTimeoutMs ?? 60_000;
		this.probeIntervalMs = deps.probeIntervalMs ?? 250;
	}

	get status(): SttStatus {
		return this._status;
	}

	/** Port the running server was bound to (may differ from the configured one after retries). */
	get activePort(): number {
		return this.port;
	}

	onStatus(listener: (status: SttStatus, detail?: string) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	preflight(): VoiceConfigProblem[] {
		const problems: VoiceConfigProblem[] = [];
		if (!this.isMacOS) {
			problems.push({ code: "not_macos", message: "Voice mode is only available on macOS." });
		}
		if (!this.resolveExe(this.config.serverPath)) {
			problems.push({
				code: "binary_not_found",
				message:
					`whisper-server was not found (looked for "${this.config.serverPath}" on your login-shell PATH). ` +
					"Install whisper.cpp (for example: brew install whisper-cpp) or set the binary path in Settings → Notor → Voice.",
			});
		}
		const model = this.config.modelPath.trim();
		if (!model) {
			problems.push({
				code: "model_missing",
				message: "No whisper model file is configured. Download a ggml model and set its path in Settings → Notor → Voice.",
			});
		} else if (!this.fileExists(model)) {
			problems.push({ code: "model_missing", message: `Whisper model file not found: ${model}` });
		}
		return problems;
	}

	async start(): Promise<void> {
		if (this.disposed) throw new Error("Speech recognition backend has been disposed.");
		if (this._status === "ready" && this.child) return;
		if (this.starting) return this.starting;
		this.starting = this.launch(0).finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	async transcribe(wav: ArrayBuffer, hints?: TranscribeHints): Promise<string> {
		if (this._status !== "ready") {
			throw new Error("Speech recognition is not ready.");
		}
		const parts: MultipartPart[] = [
			{ name: "file", filename: "utterance.wav", contentType: "audio/wav", data: wav },
			{ name: "response_format", value: "json" },
			{ name: "temperature", value: "0.0" },
		];
		if (hints?.prompt?.trim()) parts.push({ name: "prompt", value: hints.prompt.trim() });
		const { body, contentType } = encodeMultipart(parts);

		const response = await this.request({
			url: `${this.baseUrl()}/inference`,
			method: "POST",
			contentType,
			body,
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`whisper-server returned HTTP ${response.status}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(response.text) as unknown;
		} catch {
			throw new Error("whisper-server returned a non-JSON response");
		}
		const text = typeof (parsed as { text?: unknown }).text === "string"
			? ((parsed as { text: string }).text).trim()
			: "";
		if (isWhisperHallucination(text)) {
			log.debug("Dropped whisper hallucination", { text });
			return "";
		}
		return text;
	}

	/** Stop and restart the server (used after system wake). */
	async restart(): Promise<void> {
		if (this.disposed) return;
		this.killChild();
		this.child = null;
		this.restartAttempts = 0;
		this.setStatus("stopped");
		await this.start();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		this.killChild();
		this.child = null;
		this.setStatus("stopped");
		this.listeners.clear();
	}

	// -----------------------------------------------------------------------

	private baseUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	private setStatus(status: SttStatus, detail?: string): void {
		this._status = status;
		for (const listener of this.listeners) {
			try {
				listener(status, detail);
			} catch (e) {
				log.error("status listener threw", { error: String(e) });
			}
		}
	}

	private async launch(portOffset: number): Promise<void> {
		const problems = this.preflight();
		if (problems.length > 0) {
			const message = problems.map((p) => p.message).join(" ");
			this.setStatus("error", message);
			throw new Error(message);
		}
		const exe = this.resolveExe(this.config.serverPath)!;
		this.port = this.config.port + portOffset;
		this.setStatus("starting");

		const args = buildWhisperServerArgs(this.config, this.port);
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v !== undefined) env[k] = v;
		}
		const loginPath = this.loginPath();
		if (loginPath) env.PATH = loginPath;

		log.info("Spawning whisper-server", { exe, port: this.port, model: this.config.modelPath });
		const child = this.spawnFn(exe, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		this.child = child;

		let stderrTail = "";
		child.stderr?.on("data", (chunk: Buffer | string) => {
			const s = String(chunk);
			stderrTail = (stderrTail + s).slice(-4000);
			log.debug("whisper-server stderr", { line: s.trim().slice(0, 500) });
		});
		child.stdout?.on("data", (chunk: Buffer | string) => {
			log.debug("whisper-server stdout", { line: String(chunk).trim().slice(0, 500) });
		});
		child.once("error", (e) => {
			log.error("whisper-server process error", { error: String(e) });
		});

		let exited = false;
		child.once("exit", () => {
			exited = true;
		});
		child.once("exit", (code, signal) => this.handleExit(child, code, signal, () => stderrTail));

		const outcome = await this.waitUntilReady(() => exited);
		if (outcome === "exited") {
			const bindFailure = /bind|address already in use|listen/i.test(stderrTail);
			if (bindFailure && portOffset < PORT_RETRIES) {
				log.warn("whisper-server could not bind; trying the next port", { port: this.port });
				return this.launch(portOffset + 1);
			}
			const detail = stderrTail.trim().slice(-300);
			const message = `whisper-server exited during startup${detail ? `: ${detail}` : ""}`;
			this.setStatus("error", message);
			throw new Error(message);
		}
		if (outcome === "timeout") {
			this.killChild();
			const message = `whisper-server did not become ready within ${Math.round(this.readyTimeoutMs / 1000)} seconds.`;
			this.setStatus("error", message);
			throw new Error(message);
		}

		this.restartAttempts = 0;
		this.setStatus("ready");
		log.info("whisper-server ready", { port: this.port });
	}

	/** Probe the server until it answers any HTTP request, the process exits, or the budget runs out. */
	private async waitUntilReady(hasExited: () => boolean): Promise<"ready" | "exited" | "timeout"> {
		const deadline = Date.now() + this.readyTimeoutMs;
		while (Date.now() < deadline) {
			if (hasExited() || this.disposed) return "exited";
			try {
				// Any HTTP status means the socket is up; only connection errors reject.
				await this.request({ url: `${this.baseUrl()}/`, method: "GET", throw: false });
				return "ready";
			} catch {
				// not listening yet
			}
			await this.sleep(this.probeIntervalMs);
			if (hasExited()) return "exited";
		}
		return hasExited() ? "exited" : "timeout";
	}

	private handleExit(
		child: ChildProcess,
		code: number | null,
		signal: NodeJS.Signals | null,
		stderrTail: () => string,
	): void {
		if (this.disposed || this.child !== child) return;
		const wasReady = this._status === "ready";
		this.child = null;
		if (!wasReady) return; // startup failures are reported by launch()

		log.warn("whisper-server exited unexpectedly", { code, signal });
		const delay = WHISPER_RESTART_DELAYS_MS[this.restartAttempts];
		if (delay === undefined) {
			const detail = stderrTail().trim().slice(-300);
			this.setStatus(
				"error",
				`whisper-server stopped repeatedly${detail ? ` (${detail})` : ""}. Voice recognition is unavailable.`,
			);
			return;
		}
		this.restartAttempts++;
		this.setStatus("starting", `Restarting speech recognition (attempt ${this.restartAttempts})…`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			if (this.disposed) return;
			this.starting = this.launch(0)
				.catch((e) => {
					log.error("whisper-server restart failed", { error: String(e) });
				})
				.finally(() => {
					this.starting = null;
				});
		}, delay);
	}

	private killChild(): void {
		const child = this.child;
		if (!child) return;
		try {
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
