/**
 * Shell resolver — determines the correct shell executable and arguments
 * per platform.
 *
 * Uses `process.env.SHELL` with login shell (`-l`) on macOS/Linux to
 * inherit the user's full PATH (Homebrew, nvm, pyenv, etc.). Falls back
 * to PowerShell on Windows.
 *
 * @see specs/02-context-intelligence/research.md § R-3
 */

import type { NotorSettings } from "../settings";

/** Resolved shell executable and arguments for spawning. */
export interface ResolvedShell {
	/** Absolute path or name of the shell executable. */
	executable: string;
	/** Arguments to pass before the command string. */
	args: string[];
}

/**
 * Resolve the shell executable and launch arguments for the current platform.
 *
 * Resolution order:
 * 1. User-configured shell from settings (if non-empty)
 * 2. `process.env.SHELL` on macOS/Linux (with `-l -c` for login shell)
 * 3. `powershell.exe` on Windows (with `-NoProfile -Command`)
 * 4. `cmd.exe` as last resort on Windows (with `/c`)
 *
 * @param command  - The shell command string to execute.
 * @param settings - Plugin settings for user-configured overrides.
 * @returns Resolved shell executable and full argument array.
 */
export function resolveShell(command: string, settings: NotorSettings): ResolvedShell {
	// 1. User-configured override
	if (settings.execute_command_shell) {
		const userArgs = settings.execute_command_shell_args.length > 0
			? [...settings.execute_command_shell_args, command]
			: ["-c", command];
		return {
			executable: settings.execute_command_shell,
			args: userArgs,
		};
	}

	const platform = process.platform;

	// 2. macOS / Linux — login shell via $SHELL
	if (platform === "darwin" || platform === "linux") {
		const shell = process.env.SHELL || "/bin/sh";
		return {
			executable: shell,
			args: ["-l", "-c", command],
		};
	}

	// 3. Windows — PowerShell (preferred) or cmd.exe (fallback)
	if (platform === "win32") {
		// PowerShell is available on all modern Windows systems
		return {
			executable: "powershell.exe",
			args: ["-NoProfile", "-Command", command],
		};
	}

	// 4. Unknown platform fallback
	return {
		executable: "/bin/sh",
		args: ["-c", command],
	};
}