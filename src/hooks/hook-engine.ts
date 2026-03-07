/**
 * Hook execution engine — spawns shell commands for lifecycle hooks
 * with metadata injected as environment variables.
 *
 * Uses the shared `ShellExecutor` infrastructure for shell spawning.
 * Handles environment variable building, truncation, timeout, and
 * stdout capture for `pre_send` hooks.
 *
 * @see specs/02-context-intelligence/data-model.md — Hook entity
 * @see specs/02-context-intelligence/tasks.md — HOOK-002
 */

import { Notice, Platform } from "obsidian";
import type { Hook, NotorSettings } from "../settings";
import { executeShellCommand } from "../shell/shell-executor";
import { logger } from "../utils/logger";

const log = logger("HookEngine");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context metadata passed to hook execution for environment variable building. */
export interface HookContext {
	/** Current conversation UUID. */
	conversationId: string;
	/** The hook event name. */
	hookEvent: string;
	/** Active workflow name (empty string if none; populated in Phase 4). */
	workflowName?: string;
	/** UTC timestamp of the event (ISO 8601). */
	timestamp: string;
	/** Tool name (for on_tool_call and on_tool_result events). */
	toolName?: string;
	/** Serialized tool parameters JSON (for on_tool_call and on_tool_result). */
	toolParams?: string;
	/** Tool result output (for on_tool_result). */
	toolResult?: string;
	/** Tool status: "success" or "error" (for on_tool_result). */
	toolStatus?: string;
}

/** Result of executing a single hook. */
export interface HookExecutionResult {
	/** The hook that was executed. */
	hook: Hook;
	/** Whether the hook completed successfully. */
	success: boolean;
	/** Captured stdout (only meaningful for pre_send hooks). */
	stdout: string;
	/** Error message if execution failed. */
	error?: string;
	/** Whether the hook timed out. */
	timedOut: boolean;
}

// ---------------------------------------------------------------------------
// Environment variable building
// ---------------------------------------------------------------------------

/**
 * Truncate a string to the configured cap, appending a marker if truncated.
 */
function truncateEnvValue(value: string, cap: number): string {
	if (value.length <= cap) return value;
	const marker = `\n[truncated at ${cap.toLocaleString()} chars; full length: ${value.length.toLocaleString()} chars]`;
	return value.substring(0, cap) + marker;
}

/**
 * Build the NOTOR_* environment variables for a hook execution.
 *
 * @param context - Hook context metadata.
 * @param truncationCap - Max character length for env var values.
 * @returns Record of environment variable name → value.
 */
export function buildHookEnv(
	context: HookContext,
	truncationCap: number
): Record<string, string> {
	const env: Record<string, string> = {
		NOTOR_CONVERSATION_ID: context.conversationId,
		NOTOR_HOOK_EVENT: context.hookEvent,
		NOTOR_WORKFLOW_NAME: context.workflowName ?? "",
		NOTOR_TIMESTAMP: context.timestamp,
	};

	if (context.toolName !== undefined) {
		env.NOTOR_TOOL_NAME = context.toolName;
	}

	if (context.toolParams !== undefined) {
		env.NOTOR_TOOL_PARAMS = truncateEnvValue(context.toolParams, truncationCap);
	}

	if (context.toolResult !== undefined) {
		env.NOTOR_TOOL_RESULT = truncateEnvValue(context.toolResult, truncationCap);
	}

	if (context.toolStatus !== undefined) {
		env.NOTOR_TOOL_STATUS = context.toolStatus;
	}

	return env;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Execute a single hook shell command.
 *
 * @param hook - The hook to execute.
 * @param context - Hook context metadata for environment variables.
 * @param settings - Plugin settings (shell config, timeout, truncation).
 * @param vaultRootPath - Vault root path used as cwd for hook commands.
 * @returns Execution result with stdout, success status, and error info.
 */
export async function executeHook(
	hook: Hook,
	context: HookContext,
	settings: NotorSettings,
	vaultRootPath: string
): Promise<HookExecutionResult> {
	// Desktop-only guard
	if (!Platform.isDesktopApp) {
		return {
			hook,
			success: false,
			stdout: "",
			error: "Hooks are only available on desktop",
			timedOut: false,
		};
	}

	const env = buildHookEnv(context, settings.hook_env_truncation_chars);
	const hookLabel = hook.label || hook.command.substring(0, 60);

	log.info("Executing hook", {
		id: hook.id,
		event: hook.event,
		label: hookLabel,
		command: hook.command.substring(0, 200),
	});

	try {
		const result = await executeShellCommand(hook.command, settings, {
			cwd: vaultRootPath,
			env,
			timeoutSeconds: settings.hook_timeout,
			maxOutputChars: settings.execute_command_max_output_chars,
		});

		if (result.timedOut) {
			const msg = `Hook "${hookLabel}" timed out after ${settings.hook_timeout}s`;
			log.warn(msg, { hookId: hook.id });
			new Notice(msg);
			return {
				hook,
				success: false,
				stdout: result.stdout,
				error: msg,
				timedOut: true,
			};
		}

		if (result.exitCode !== 0) {
			const msg = `Hook "${hookLabel}" exited with code ${result.exitCode}`;
			log.warn(msg, { hookId: hook.id, exitCode: result.exitCode });
			new Notice(msg);
			return {
				hook,
				success: false,
				stdout: result.stdout,
				error: `${msg}: ${result.stdout.substring(0, 200)}`,
				timedOut: false,
			};
		}

		log.info("Hook executed successfully", {
			id: hook.id,
			outputLength: result.stdout.length,
		});

		return {
			hook,
			success: true,
			stdout: result.stdout.trim(),
			timedOut: false,
		};
	} catch (e) {
		const errorMsg = e instanceof Error ? e.message : String(e);
		const msg = `Hook "${hookLabel}" failed: ${errorMsg}`;
		log.error(msg, { hookId: hook.id, error: errorMsg });
		new Notice(msg);

		return {
			hook,
			success: false,
			stdout: "",
			error: msg,
			timedOut: false,
		};
	}
}