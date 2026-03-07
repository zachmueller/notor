/**
 * Shell executor — spawns shell commands using `child_process.spawn`
 * with platform-specific shell resolution, timeout enforcement, and
 * output buffering.
 *
 * Shared infrastructure used by both `execute_command` tool and the
 * hook execution engine.
 *
 * @see specs/02-context-intelligence/research.md § R-3
 * @see specs/02-context-intelligence/tasks.md — FOUND-003
 */

import { spawn, type ChildProcess } from "child_process";
import { Platform } from "obsidian";
import type { NotorSettings } from "../settings";
import { resolveShell } from "./shell-resolver";
import { OutputBuffer } from "./output-buffer";
import { logger } from "../utils/logger";

const log = logger("ShellExecutor");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for a single shell execution. */
export interface ShellExecuteOptions {
	/** Working directory for the command. */
	cwd?: string;
	/** Additional environment variables merged with `process.env`. */
	env?: Record<string, string>;
	/** Timeout in seconds. Process is killed on expiry. */
	timeoutSeconds?: number;
	/** Maximum output characters to capture (default: 50,000). */
	maxOutputChars?: number;
}

/** Result of a shell execution. */
export interface ShellExecuteResult {
	/** Combined stdout + stderr output. */
	stdout: string;
	/** Process exit code (null if killed by signal). */
	exitCode: number;
	/** Whether the process was killed due to timeout. */
	timedOut: boolean;
	/** Whether the output was truncated due to size cap. */
	truncated: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Grace period in ms after SIGTERM before sending SIGKILL. */
const SIGKILL_GRACE_MS = 3_000;

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Execute a shell command with timeout and output buffering.
 *
 * Desktop-only: throws if `Platform.isDesktopApp` is false.
 *
 * @param command  - Shell command string to execute.
 * @param settings - Plugin settings (for shell resolution).
 * @param options  - Execution options (cwd, env, timeout, output cap).
 * @returns Promise resolving to the execution result.
 * @throws Error if not on desktop, shell not found, or spawn fails.
 */
export async function executeShellCommand(
	command: string,
	settings: NotorSettings,
	options: ShellExecuteOptions = {}
): Promise<ShellExecuteResult> {
	// Desktop-only guard
	if (!Platform.isDesktopApp) {
		throw new Error("Shell execution is only available on desktop");
	}

	const { executable, args } = resolveShell(command, settings);
	const timeoutMs = (options.timeoutSeconds ?? settings.execute_command_timeout) * 1000;
	const maxChars = options.maxOutputChars ?? settings.execute_command_max_output_chars;

	log.info("Executing shell command", {
		command: command.substring(0, 200),
		shell: executable,
		cwd: options.cwd ?? "(default)",
		timeout: `${timeoutMs}ms`,
	});

	return new Promise<ShellExecuteResult>((resolve, reject) => {
		let child: ChildProcess;

		try {
			child = spawn(executable, args, {
				cwd: options.cwd,
				env: options.env
					? { ...process.env, ...options.env }
					: process.env,
				stdio: ["pipe", "pipe", "pipe"],
				shell: false, // We spawn the shell directly
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.error("Failed to spawn shell process", { error: message });
			reject(new Error(`Failed to spawn shell process: ${message}`));
			return;
		}

		const buffer = new OutputBuffer(maxChars);
		let timedOut = false;
		let killTimer: ReturnType<typeof setTimeout> | null = null;
		let graceTimer: ReturnType<typeof setTimeout> | null = null;

		// Capture stdout and stderr into combined buffer
		child.stdout?.on("data", (data: Buffer) => buffer.append(data));
		child.stderr?.on("data", (data: Buffer) => buffer.append(data));

		// Timeout enforcement
		if (timeoutMs > 0) {
			killTimer = setTimeout(() => {
				timedOut = true;
				log.warn("Shell command timed out, sending SIGTERM", {
					command: command.substring(0, 100),
				});

				// Send SIGTERM; on Windows child.kill() terminates
				child.kill("SIGTERM");

				// Grace period: SIGKILL after 3 seconds if still alive
				graceTimer = setTimeout(() => {
					if (!child.killed) {
						log.warn("Shell process did not terminate, sending SIGKILL");
						child.kill("SIGKILL");
					}
				}, SIGKILL_GRACE_MS);
			}, timeoutMs);
		}

		// Handle spawn errors (e.g., ENOENT for missing shell)
		child.on("error", (err) => {
			clearTimers();
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				reject(new Error(`Shell not found: ${executable}`));
			} else {
				reject(new Error(`Shell execution failed: ${err.message}`));
			}
		});

		// Handle process exit
		child.on("close", (exitCode: number | null) => {
			clearTimers();

			const result: ShellExecuteResult = {
				stdout: buffer.toString(),
				exitCode: exitCode ?? (timedOut ? 124 : 1),
				timedOut,
				truncated: buffer.truncated,
			};

			log.info("Shell command completed", {
				exitCode: result.exitCode,
				timedOut: result.timedOut,
				truncated: result.truncated,
				outputLength: result.stdout.length,
			});

			resolve(result);
		});

		function clearTimers(): void {
			if (killTimer) clearTimeout(killTimer);
			if (graceTimer) clearTimeout(graceTimer);
		}
	});
}