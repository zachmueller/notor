/**
 * Workflow frontmatter hook parser — extracts and validates the
 * `notor-hooks` YAML mapping from a workflow note's frontmatter.
 *
 * The parser is called during workflow discovery (Group C) and produces
 * a validated `WorkflowHookConfig` (or `null` if no valid hooks are found).
 * Invalid hook definitions are logged as warnings and skipped; valid hooks
 * in the same event array still apply.
 *
 * Handles the frontmatter YAML key format: `notor-hooks` uses kebab-case
 * event names in YAML (`pre-send`, `on-tool-call`, `on-tool-result`,
 * `after-completion`) which are normalised to underscore-separated
 * `LLMHookEvent` values (`pre_send`, `on_tool_call`, `on_tool_result`,
 * `after_completion`).
 *
 * Only LLM lifecycle hooks are supported here — vault event hook names
 * (e.g. `on-note-open`) are rejected with a warning per FR-52.
 *
 * Task covered:
 * - G-001: WorkflowScopedHook types and frontmatter parser
 *
 * @see specs/03-workflows-personas/data-model.md — WorkflowScopedHook, WorkflowHookConfig
 * @see specs/03-workflows-personas/spec.md — FR-52
 */

import type {
	LLMHookEvent,
	WorkflowHookConfig,
	WorkflowScopedHook,
} from "../types";
import { logger } from "../utils/logger";

const log = logger("WorkflowHookParser");

// ---------------------------------------------------------------------------
// Recognised LLM lifecycle event names
// ---------------------------------------------------------------------------

/**
 * Map of kebab-case and snake_case YAML keys → canonical `LLMHookEvent`.
 *
 * Only LLM lifecycle hook events are accepted here; vault-event names such
 * as `on-note-open` are intentionally absent so they produce a warning.
 */
const HOOK_EVENT_ALIASES: Record<string, LLMHookEvent> = {
	// kebab-case (YAML convention)
	"pre-send": "pre_send",
	"on-tool-call": "on_tool_call",
	"on-tool-result": "on_tool_result",
	"after-completion": "after_completion",
	// snake_case passthrough
	pre_send: "pre_send",
	on_tool_call: "on_tool_call",
	on_tool_result: "on_tool_result",
	after_completion: "after_completion",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse the `notor-hooks` frontmatter property from a workflow note.
 *
 * Accepts the raw frontmatter record from Obsidian's YAML parser.
 * The `notor-hooks` value is expected to be a YAML mapping whose keys
 * are LLM lifecycle event names and whose values are arrays of action
 * objects.
 *
 * Validation rules:
 * - Returns `null` if `notor-hooks` is absent, null, or not an object.
 * - Logs a warning and skips unrecognised event key names (e.g. vault
 *   event names like `on-note-open`).
 * - Logs a warning and skips event entries whose value is not an array.
 * - For each action entry, validates `action` field is `"execute_command"`
 *   or `"run_workflow"`, and that the required payload field is present:
 *   - `command` (non-empty string) for `"execute_command"`.
 *   - `path` (non-empty string) for `"run_workflow"`.
 * - Invalid individual action objects are logged and skipped; valid
 *   actions in the same array still apply.
 * - Events whose entire action array resolves to zero valid entries are
 *   omitted from the returned config.
 * - Returns `null` if no event has at least one valid action.
 *
 * @param frontmatter - Raw frontmatter record (or undefined) from Obsidian.
 * @param workflowPath - Vault-relative file path used in warning messages.
 * @returns Parsed `WorkflowHookConfig` or `null`.
 */
export function parseWorkflowHooks(
	frontmatter: Record<string, unknown> | undefined,
	workflowPath: string
): WorkflowHookConfig | null {
	if (!frontmatter) return null;

	const hooksValue = frontmatter["notor-hooks"];

	// Absent or null → no hook overrides
	if (hooksValue === undefined || hooksValue === null) {
		return null;
	}

	// Must be a plain object (YAML mapping), not an array or scalar
	if (typeof hooksValue !== "object" || Array.isArray(hooksValue)) {
		log.warn("Workflow has invalid notor-hooks: expected a YAML mapping", {
			path: workflowPath,
			type: Array.isArray(hooksValue) ? "array" : typeof hooksValue,
		});
		return null;
	}

	const hooksObj = hooksValue as Record<string, unknown>;
	const config: WorkflowHookConfig = {};
	let hasValidActions = false;

	for (const [rawKey, rawActions] of Object.entries(hooksObj)) {
		// Normalise event name (kebab-case or snake_case → LLMHookEvent)
		const eventName = HOOK_EVENT_ALIASES[rawKey];
		if (!eventName) {
			log.warn(
				"Workflow notor-hooks has unrecognised event name; " +
					"only LLM lifecycle hooks are supported here (not vault event hooks)",
				{ path: workflowPath, event: rawKey }
			);
			continue;
		}

		// The value must be an array of action objects
		if (!Array.isArray(rawActions)) {
			log.warn(
				"Workflow notor-hooks event value is not an array; skipping",
				{ path: workflowPath, event: rawKey }
			);
			continue;
		}

		const validActions: WorkflowScopedHook[] = [];

		const actionsArray: unknown[] = rawActions;
		for (let i = 0; i < actionsArray.length; i++) {
			const rawAction = actionsArray[i];

			if (
				typeof rawAction !== "object" ||
				rawAction === null ||
				Array.isArray(rawAction)
			) {
				log.warn(
					"Workflow notor-hooks action entry is not an object; skipping",
					{ path: workflowPath, event: rawKey, index: i }
				);
				continue;
			}

			const parsed = parseHookAction(
				rawAction as Record<string, unknown>,
				workflowPath,
				rawKey,
				i,
				eventName
			);
			if (parsed) {
				validActions.push(parsed);
			}
		}

		if (validActions.length > 0) {
			config[eventName] = validActions;
			hasValidActions = true;
		}
	}

	// All hook definitions were invalid → equivalent to no hooks
	return hasValidActions ? config : null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a single hook action object from a `notor-hooks` event array.
 *
 * @param actionObj - Raw action object from YAML.
 * @param filePath   - Workflow file path for warning context.
 * @param eventKey   - Raw event key string for warning context.
 * @param index      - Array index for warning context.
 * @param event      - Resolved `LLMHookEvent` to assign to the hook.
 * @returns A populated `WorkflowScopedHook`, or `null` if invalid.
 */
function parseHookAction(
	actionObj: Record<string, unknown>,
	filePath: string,
	eventKey: string,
	index: number,
	event: LLMHookEvent
): WorkflowScopedHook | null {
	// Support both `action` (YAML shorthand) and `action_type` field names
	const actionType = actionObj["action"] ?? actionObj["action_type"];

	if (actionType !== "execute_command" && actionType !== "run_workflow") {
		log.warn(
			"Workflow notor-hooks action has unsupported action type; skipping",
			{
				path: filePath,
				event: eventKey,
				index,
				action: actionType === undefined ? "(missing)" : typeof actionType === "string" ? actionType : JSON.stringify(actionType),
			}
		);
		return null;
	}

	if (actionType === "execute_command") {
		const command = actionObj["command"];
		if (typeof command !== "string" || command.trim() === "") {
			log.warn(
				"Workflow notor-hooks 'execute_command' action is missing a non-empty 'command'; skipping",
				{ path: filePath, event: eventKey, index }
			);
			return null;
		}
		return {
			event,
			action_type: "execute_command",
			command: command.trim(),
			workflow_path: null,
		};
	}

	// actionType === "run_workflow"
	// Support both `path` (YAML shorthand) and `workflow_path` field names
	const workflowPath = actionObj["path"] ?? actionObj["workflow_path"];
	if (typeof workflowPath !== "string" || workflowPath.trim() === "") {
		log.warn(
			"Workflow notor-hooks 'run_workflow' action is missing a non-empty 'path'; skipping",
			{ path: filePath, event: eventKey, index }
		);
		return null;
	}
	return {
		event,
		action_type: "run_workflow",
		command: null,
		workflow_path: workflowPath.trim(),
	};
}
