/**
 * Login-shell PATH resolution.
 *
 * Obsidian is a GUI app and does not inherit the user's interactive shell
 * PATH, so tools installed via Homebrew, nvm, pyenv, etc. are not found when
 * spawning child processes. This module runs the user's login shell once to
 * capture the PATH the user sees in a terminal and caches it for the plugin's
 * lifetime. Shared by the MCP stdio transport and the voice-mode backends.
 */

import { execSync } from "child_process";
import { accessSync, constants, existsSync, statSync } from "fs";
import { homedir } from "os";
import { delimiter, isAbsolute, join } from "path";
import { logger } from "../utils/logger";

const log = logger("LoginShellPath");

/** Null means "not yet resolved"; empty string means "resolution failed". */
let cached: string | null = null;

/**
 * Resolve the user's login-shell PATH (cached after the first call).
 *
 * Falls back to `process.env.PATH` on Windows or when the shell cannot be run.
 */
export function resolveLoginShellPath(): string {
	if (cached !== null) return cached;

	if (process.platform === "win32") {
		cached = process.env.PATH ?? "";
		return cached;
	}

	try {
		const shell = process.env.SHELL || "/bin/sh";
		const output = execSync(`${shell} -l -c 'echo $PATH'`, {
			encoding: "utf8",
			timeout: 5000,
			// Suppress shell startup output (e.g. from .bashrc echo statements)
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();

		// Use only the last non-empty line — some login shells print
		// banner text before the PATH value.
		const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
		cached = lines[lines.length - 1] ?? process.env.PATH ?? "";
		log.info("Resolved login shell PATH", { shell, path: cached });
	} catch (e) {
		log.warn("Could not resolve login shell PATH — using process PATH", {
			error: String(e),
		});
		cached = process.env.PATH ?? "";
	}

	return cached;
}

/** Test seam — forget the cached PATH. */
export function _resetLoginShellPathCache(): void {
	cached = null;
}

function isExecutableFile(path: string): boolean {
	try {
		if (!existsSync(path) || !statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/**
 * Resolve an executable to an absolute path.
 *
 * A bare name is searched on `pathEnv` (default: the login-shell PATH); a
 * path containing a separator (or `~`) is checked directly. Returns null when
 * nothing executable is found.
 */
export function resolveExecutable(
	nameOrPath: string,
	pathEnv: string = resolveLoginShellPath(),
): string | null {
	const trimmed = nameOrPath.trim();
	if (!trimmed) return null;

	if (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.startsWith("~")) {
		const direct = expandHome(trimmed);
		return isExecutableFile(direct) ? direct : null;
	}

	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		const full = join(dir, trimmed);
		if (isExecutableFile(full)) return full;
	}
	return null;
}
