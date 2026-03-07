/**
 * `execute_command` tool — executes a shell command on the user's system
 * and returns combined stdout+stderr output.
 *
 * Uses the shared shell executor infrastructure (FOUND-003) for platform-
 * specific shell resolution, timeout enforcement, and output buffering.
 *
 * Write tool available in Act mode only.
 * Auto-approve default: false.
 * Desktop-only: returns error if `Platform.isDesktopApp` is false.
 *
 * @see specs/02-context-intelligence/contracts/tool-schemas.md — execute_command schema
 * @see specs/02-context-intelligence/tasks.md — TOOL-014, TOOL-015
 */

import { Platform } from "obsidian";
import type { App } from "obsidian";
import { normalize, resolve, isAbsolute } from "path";
import type { Tool, ToolResult } from "./tool";
import type { NotorSettings } from "../settings";
import { executeShellCommand } from "../shell/shell-executor";
import { logger } from "../utils/logger";

const log = logger("ExecuteCommandTool");

// ---------------------------------------------------------------------------
// Working directory validation
// ---------------------------------------------------------------------------

/**
 * Resolve and validate a working directory for command execution.
 *
 * Resolution rules:
 * - Empty/undefined → vault root
 * - Relative path → resolve from vault root
 * - Absolute path → use as-is
 *
 * Validation: the resolved path must be within the vault root or one
 * of the user-configured allowed paths. The vault root is always
 * implicitly allowed.
 *
 * @returns `{ valid: true, resolvedPath }` or `{ valid: false, error }`.
 */
export function resolveAndValidateWorkingDir(
	workingDirectory: string | undefined,
	vaultRoot: string,
	allowedPaths: string[]
): { valid: true; resolvedPath: string } | { valid: false; error: string } {
	let resolved: string;

	if (!workingDirectory || workingDirectory.trim() === "") {
		resolved = vaultRoot;
	} else if (isAbsolute(workingDirectory)) {
		resolved = normalize(workingDirectory);
	} else {
		resolved = resolve(vaultRoot, workingDirectory);
	}

	// Normalize for consistent comparison
	resolved = normalize(resolved);
	const normalizedVaultRoot = normalize(vaultRoot);

	// Check if within vault root
	if (isPathWithin(resolved, normalizedVaultRoot)) {
		return { valid: true, resolvedPath: resolved };
	}

	// Check if within any allowed path
	for (const allowed of allowedPaths) {
		const trimmed = allowed.trim();
		if (!trimmed) continue;
		const normalizedAllowed = normalize(trimmed);
		if (isPathWithin(resolved, normalizedAllowed)) {
			return { valid: true, resolvedPath: resolved };
		}
	}

	return {
		valid: false,
		error:
			`Working directory '${workingDirectory}' is outside the allowed paths. ` +
			`Allowed: vault root and configured paths.`,
	};
}

/**
 * Check if `target` is within (or equal to) `base`.
 * Uses normalized path prefix comparison with separator boundary check.
 */
function isPathWithin(target: string, base: string): boolean {
	const normalTarget = normalize(target);
	const normalBase = normalize(base);

	if (normalTarget === normalBase) return true;

	// Ensure base ends with separator for prefix check
	const baseWithSep = normalBase.endsWith("/") || normalBase.endsWith("\\")
		? normalBase
		: normalBase + "/";

	return normalTarget.startsWith(baseWithSep);
}

// ---------------------------------------------------------------------------
// Tool implementation (TOOL-014 + TOOL-015)
// ---------------------------------------------------------------------------

/**
 * Implements the `execute_command` tool.
 *
 * Executes shell commands using the shared shell executor. Validates
 * working directory against allowed paths, enforces timeout, and caps
 * output size.
 */
export class ExecuteCommandTool implements Tool {
	readonly name = "execute_command";
	readonly mode = "write" as const;

	readonly description =
		"Execute a shell command on the user's system and return the combined stdout " +
		"and stderr output. The command runs in the user's default login shell. " +
		"The working directory must be within the vault or a user-configured allow-list " +
		"of paths. Commands have a configurable timeout. Output may be truncated if it " +
		"exceeds the configured size limit. This tool requires user approval unless " +
		"auto-approved.";

	readonly input_schema = {
		type: "object",
		properties: {
			command: {
				type: "string",
				description: "Shell command to execute",
			},
			working_directory: {
				type: "string",
				description:
					"Working directory for the command, relative to vault root or " +
					"as an absolute path. Defaults to vault root. Must be within " +
					"the vault or a user-configured allowed path.",
				default: "",
			},
		},
		required: ["command"],
	};

	constructor(
		private readonly app: App,
		private readonly settings: NotorSettings
	) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const command = params["command"] as string;
		const workingDirectory = (params["working_directory"] as string | undefined) ?? "";

		if (!command || typeof command !== "string") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: command",
			};
		}

		// Desktop-only guard
		if (!Platform.isDesktopApp) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error:
					"execute_command is only available on desktop. " +
					"Shell execution is not supported on mobile.",
			};
		}

		// Resolve vault root path
		const vaultRoot = this.getVaultRootPath();
		if (!vaultRoot) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Could not determine vault root path.",
			};
		}

		// Validate working directory
		const cwdResult = resolveAndValidateWorkingDir(
			workingDirectory,
			vaultRoot,
			this.settings.execute_command_allowed_paths
		);

		if (!cwdResult.valid) {
			log.info("Working directory rejected", {
				workingDirectory,
				error: cwdResult.error,
			});
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: cwdResult.error,
			};
		}

		log.info("Executing command", {
			command: command.substring(0, 200),
			cwd: cwdResult.resolvedPath,
			timeout: `${this.settings.execute_command_timeout}s`,
		});

		// Execute via shared shell executor
		try {
			const result = await executeShellCommand(command, this.settings, {
				cwd: cwdResult.resolvedPath,
				timeoutSeconds: this.settings.execute_command_timeout,
				maxOutputChars: this.settings.execute_command_max_output_chars,
			});

			let output = result.stdout;

			// Append truncation notice if output was capped
			if (result.truncated) {
				output +=
					`\n\nNote: command output was truncated at ` +
					`${this.settings.execute_command_max_output_chars.toLocaleString()} characters.`;
			}

			// Handle timeout
			if (result.timedOut) {
				const partialOutput = output ? `Partial output:\n${output}` : "";
				return {
					tool_name: this.name,
					success: false,
					result: partialOutput,
					error: `Command timed out after ${this.settings.execute_command_timeout} seconds.${partialOutput ? ` ${partialOutput}` : ""}`,
				};
			}

			// Handle non-zero exit codes
			if (result.exitCode !== 0) {
				return {
					tool_name: this.name,
					success: false,
					result: output,
					error: `Command exited with code ${result.exitCode}`,
				};
			}

			return {
				tool_name: this.name,
				success: true,
				result: output,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			log.error("Command execution failed", {
				command: command.substring(0, 200),
				error: message,
			});

			// Provide helpful error for common failure modes
			if (message.includes("Shell not found")) {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `${message}. Check your shell configuration in Settings → Notor.`,
				};
			}

			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Failed to execute command: ${message}`,
			};
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Get the absolute filesystem path of the vault root.
	 *
	 * Uses `app.vault.adapter.basePath` which is available in Electron
	 * desktop environments (the `FileSystemAdapter`).
	 */
	private getVaultRootPath(): string | null {
		const adapter = this.app.vault.adapter as {
			basePath?: string;
		};
		return adapter.basePath ?? null;
	}
}