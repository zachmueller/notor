/**
 * Command-line text-to-speech backend (macOS `say` by default).
 *
 * One child process per utterance, text written to stdin, SIGTERM on stop so
 * barge-in cuts playback immediately. `-v <voice>` / `-r <wpm>` are added only
 * when configured, so other stdin-reading synthesizers are not handed flags
 * they may not understand.
 */

import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { resolveExecutable, resolveLoginShellPath } from "../../shell/login-shell-path";
import { logger } from "../../utils/logger";
import type { SpeakResult, TtsBackend } from "./types";

const log = logger("CommandTts");

export interface CommandTtsConfig {
	/** Bare command name (login-shell PATH) or absolute path. */
	command: string;
	/** Voice name; "" = default. */
	voice: string;
	/** Words per minute; 0 = default. */
	rate: number;
}

export interface CommandTtsDeps {
	spawnFn?: typeof nodeSpawn;
	resolveExe?: (nameOrPath: string) => string | null;
	loginPath?: () => string;
}

const SIGKILL_GRACE_MS = 1_000;

/** Build the argument list for a config (exported for tests). */
export function buildTtsArgs(config: CommandTtsConfig): string[] {
	const args: string[] = [];
	if (config.voice.trim()) args.push("-v", config.voice.trim());
	if (config.rate > 0) args.push("-r", String(Math.round(config.rate)));
	return args;
}

interface Utterance {
	child: ChildProcess;
	interrupted: boolean;
}

export class CommandTts implements TtsBackend {
	private current: Utterance | null = null;
	private readonly spawnFn: typeof nodeSpawn;
	private readonly resolveExe: (nameOrPath: string) => string | null;
	private readonly loginPath: () => string;

	constructor(private readonly config: CommandTtsConfig, deps: CommandTtsDeps = {}) {
		this.spawnFn = deps.spawnFn ?? nodeSpawn;
		this.resolveExe = deps.resolveExe ?? ((p) => resolveExecutable(p));
		this.loginPath = deps.loginPath ?? resolveLoginShellPath;
	}

	get isSpeaking(): boolean {
		return this.current !== null;
	}

	speak(text: string): Promise<SpeakResult> {
		const trimmed = text.trim();
		if (!trimmed) return Promise.resolve({ interrupted: false });
		if (this.current) this.stop();

		const exe = this.resolveExe(this.config.command) ?? this.config.command.trim();
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v !== undefined) env[k] = v;
		}
		const loginPath = this.loginPath();
		if (loginPath) env.PATH = loginPath;

		return new Promise<SpeakResult>((resolve) => {
			let child: ChildProcess;
			try {
				child = this.spawnFn(exe, buildTtsArgs(this.config), { env, stdio: ["pipe", "ignore", "pipe"] });
			} catch (e) {
				log.error("TTS command failed to start", { command: exe, error: String(e) });
				resolve({ interrupted: false });
				return;
			}
			const utterance: Utterance = { child, interrupted: false };
			this.current = utterance;

			let settled = false;
			let stderr = "";
			const finish = () => {
				if (settled) return;
				settled = true;
				if (this.current === utterance) this.current = null;
				resolve({ interrupted: utterance.interrupted });
			};

			child.stderr?.on("data", (chunk: Buffer | string) => {
				stderr = (stderr + String(chunk)).slice(-2000);
			});
			child.once("error", (e) => {
				log.error("TTS command error", { command: exe, error: String(e) });
				finish();
			});
			child.once("close", (code) => {
				if (code && !utterance.interrupted) {
					log.warn("TTS command exited with an error", { command: exe, code, stderr: stderr.trim().slice(-300) });
				}
				finish();
			});

			child.stdin?.on("error", () => {
				// The process may exit before consuming stdin (e.g. killed by stop()).
			});
			child.stdin?.end(`${trimmed}\n`);
		});
	}

	stop(): void {
		const utterance = this.current;
		if (!utterance) return;
		utterance.interrupted = true;
		this.current = null;
		const { child } = utterance;
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

	dispose(): void {
		this.stop();
	}
}
