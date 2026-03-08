/**
 * Vault event hook engine — environment variable builder and shell command
 * executor for vault event hook actions.
 *
 * Extends the existing hook-engine.ts pattern for LLM lifecycle hooks with
 * vault-event-specific variables (NOTOR_NOTE_PATH, NOTOR_TAGS_ADDED,
 * NOTOR_TAGS_REMOVED). Does NOT include Phase 3 LLM-specific variables
 * (NOTOR_CONVERSATION_ID, NOTOR_TOOL_NAME, etc.) per the contract.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-017
 * @see specs/03-workflows-personas/contracts/vault-event-hooks.md — §Environment variables
 */

import { Notice, Platform } from "obsidian";
import type { VaultEventHook } from "../types";
import type { NotorSettings } from "../settings";
import type { HookExecutionResult } from "./hook-engine";
import { executeShellCommand } from "../shell/shell-executor";
import { logger } from "../utils/logger";

const log = logger("VaultEventHookEngine");

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Event context metadata passed to vault event hook execution.
 *
 * Used to populate NOTOR_* environment variables for shell command hooks
 * and to provide trigger context for workflow hooks.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-017
 */
export interface VaultEventHookContext {
	/** The vault event type that triggered the hook (e.g. `"on_note_open"`). */
	hookEvent: string;
	/** UTC timestamp of the event (ISO 8601). */
	timestamp: string;
	/** Vault-relative path of the note that caused the event (null for scheduled). */
	notePath: string | null;
	/** Tags added to the note (on_tag_change only; null otherwise). */
	tagsAdded: string[] | null;
	/** Tags removed from the note (on_tag_change only; null otherwise). */
	tagsRemoved: string[] | null;
}

// ---------------------------------------------------------------------------
// Environment variable building
// ---------------------------------------------------------------------------

/**
 * Build the NOTOR_* environment variables for a vault event hook execution.
 *
 * Variables included:
 * - `NOTOR_HOOK_EVENT`    — event name (e.g. `"on_note_open"`)
 * - `NOTOR_TIMESTAMP`     — UTC ISO 8601 timestamp
 * - `NOTOR_NOTE_PATH`     — vault-relative note path (when `notePath` is non-null)
 * - `NOTOR_TAGS_ADDED`    — comma-separated added tags (on_tag_change only)
 * - `NOTOR_TAGS_REMOVED`  — comma-separated removed tags (on_tag_change only)
 *
 * Deliberately excludes Phase 3 LLM-specific variables per contract:
 * no NOTOR_CONVERSATION_ID, NOTOR_TOOL_NAME, NOTOR_TOOL_PARAMS, etc.
 *
 * @param context - Vault event hook context metadata.
 * @returns Record of environment variable name → value.
 *
 * @see specs/03-workflows-personas/contracts/vault-event-hooks.md — §Environment variables
 */
export function buildVaultEventHookEnv(
	context: VaultEventHookContext
): Record<string, string> {
	const env: Record<string, string> = {
		NOTOR_HOOK_EVENT: context.hookEvent,
		NOTOR_TIMESTAMP: context.timestamp,
	};

	if (context.notePath !== null) {
		env.NOTOR_NOTE_PATH = context.notePath;
	}

	if (context.tagsAdded !== null) {
		env.NOTOR_TAGS_ADDED = context.tagsAdded.join(",");
	}

	if (context.tagsRemoved !== null) {
		env.NOTOR_TAGS_REMOVED = context.tagsRemoved.join(",");
	}

	return env;
}

// ---------------------------------------------------------------------------
// Shell command executor
// ---------------------------------------------------------------------------

/**
 * Execute a vault event hook's shell command action.
 *
 * Uses the shared `executeShellCommand()` infrastructure with vault event
 * environment variables injected. Subject to the global hook timeout setting.
 *
 * Desktop-only: returns an error result on mobile without attempting execution.
 *
 * @param hook          - The vault event hook to execute (must have action_type "execute_command").
 * @param context       - Vault event context for environment variable injection.
 * @param settings      - Plugin settings (shell config, timeout, output limits).
 * @param vaultRootPath - Vault root path used as cwd for hook commands.
 * @returns Execution result with success status, stdout, and error info.
 */
export async function executeVaultEventHook(
	hook: VaultEventHook,
	context: VaultEventHookContext,
	settings: NotorSettings,
	vaultRootPath: string
): Promise<HookExecutionResult> {
	// Desktop-only guard
	if (!Platform.isDesktopApp) {
		return {
			hook: hook as unknown as import("./hook-engine").HookExecutionResult["hook"],
			success: false,
			stdout: "",
			error: "Vault event hooks (shell commands) are only available on desktop",
			timedOut: false,
		};
	}

	const command = hook.command ?? "";
	if (!command.trim()) {
		return {
			hook: hook as unknown as import("./hook-engine").HookExecutionResult["hook"],
			success: false,
			stdout: "",
			error: "Hook has no command configured",
			timedOut: false,
		};
	}

	const env = buildVaultEventHookEnv(context);
	const hookLabel = hook.label || command.substring(0, 60);

	log.info("Executing vault event hook", {
		id: hook.id,
		event: hook.event,
		hookEvent: context.hookEvent,
		label: hookLabel,
		command: command.substring(0, 200),
		notePath: context.notePath,
	});

	try {
		const result = await executeShellCommand(command, settings, {
			cwd: vaultRootPath,
			env,
			timeoutSeconds: settings.hook_timeout,
			maxOutputChars: settings.execute_command_max_output_chars,
		});

		if (result.timedOut) {
			const msg = `Vault event hook "${hookLabel}" timed out after ${settings.hook_timeout}s`;
			log.warn(msg, { hookId: hook.id });
			new Notice(msg);
			return {
				hook: hook as unknown as import("./hook-engine").HookExecutionResult["hook"],
				success: false,
				stdout: result.stdout,
				error: msg,
				timedOut: true,
			};
		}

		if (result.exitCode !== 0) {
			const msg = `Vault event hook "${hookLabel}" exited with code ${result.exitCode}`;
			log.warn(msg, { hookId: hook.id, exitCode: result.exitCode });
			new Notice(msg);
			return {
				hook: hook as unknown as import("./hook-engine").HookExecutionResult["hook"],
				success: false,
				stdout: result.stdout,
				error: `${msg}: ${result.stdout.substring(0, 200)}`,
				timedOut: false,
			};
		}

		log.info("Vault event hook executed successfully", {
			id: hook.id,
			outputLength: result.stdout.length,
		});

		return {
			hook: hook as unknown as import("./hook-engine").HookExecutionResult["hook"],
			success: true,
			stdout: result.stdout.trim(),
			timedOut: false,
		};
	} catch (e) {
		const errorMsg = e instanceof Error ? e.message : String(e);
		const msg = `Vault event hook "${hookLabel}" failed: ${errorMsg}`;
		log.error(msg, { hookId: hook.id, error: errorMsg });
		new Notice(msg);

		return {
			hook: hook as unknown as import("./hook-engine").HookExecutionResult["hook"],
			success: false,
			stdout: "",
			error: msg,
			timedOut: false,
		};
	}
}
