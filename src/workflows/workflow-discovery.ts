/**
 * Workflow discovery service — recursively scans `{notor_dir}/workflows/`
 * for Markdown notes with `notor-workflow: true` in their frontmatter,
 * parses workflow-specific frontmatter properties, validates required
 * fields, and returns fully populated Workflow objects.
 *
 * Discovery is stateless — each call re-scans the directory.
 * Callers (main plugin, command palette, settings) trigger discovery
 * when they need a fresh list.
 *
 * Tasks covered:
 * - C-002: Recursive directory scanning
 * - C-003: Frontmatter parser (trigger, schedule, persona)
 * - C-004: Workflow validation logic
 * - C-005: Cron expression validation
 * - C-006: WorkflowScopedHook frontmatter parser
 *
 * @see specs/03-workflows-personas/data-model.md — Workflow entity
 * @see specs/03-workflows-personas/spec.md — FR-41 (workflow discovery)
 */

import type { MetadataCache, TFile, TFolder, Vault } from "obsidian";
import { TAbstractFile } from "obsidian";
import type {
	LLMHookEvent,
	Workflow,
	WorkflowHookConfig,
	WorkflowScopedHook,
	WorkflowTrigger,
} from "../types";
import { VALID_WORKFLOW_TRIGGERS } from "../types";
import { logger } from "../utils/logger";

const log = logger("WorkflowDiscovery");

// ---------------------------------------------------------------------------
// Valid LLM hook event names (snake_case canonical form)
// ---------------------------------------------------------------------------

const VALID_HOOK_EVENTS: readonly LLMHookEvent[] = [
	"pre_send",
	"on_tool_call",
	"on_tool_result",
	"after_completion",
] as const;

/**
 * Map of kebab-case → snake_case for hook event names.
 * Frontmatter YAML commonly uses kebab-case; we normalize to snake_case.
 */
const HOOK_EVENT_ALIASES: Record<string, LLMHookEvent> = {
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

/**
 * Recognized cron shorthand aliases.
 *
 * @see C-005 acceptance criteria
 */
const CRON_SHORTHANDS = new Set([
	"@daily",
	"@weekly",
	"@monthly",
	"@yearly",
	"@annually",
	"@hourly",
]);

// ---------------------------------------------------------------------------
// Public API: discoverWorkflows
// ---------------------------------------------------------------------------

/**
 * Scan `{notorDir}/workflows/` recursively for valid workflow notes
 * and return fully populated `Workflow` objects.
 *
 * A valid workflow note is a Markdown file whose frontmatter contains
 * `notor-workflow: true` (boolean) and a recognized `notor-trigger` value.
 *
 * Notes without `notor-workflow: true` are silently ignored.
 * Notes with `notor-workflow: true` but missing/invalid `notor-trigger`
 * are excluded with a warning logged.
 *
 * If the workflows root directory does not exist, an empty array is
 * returned without error.
 *
 * @param vault - Obsidian Vault instance
 * @param metadataCache - Obsidian MetadataCache for frontmatter access
 * @param notorDir - Vault-relative path to the Notor directory (e.g. `"notor/"`)
 * @returns Array of discovered and validated Workflow objects
 */
export async function discoverWorkflows(
	vault: Vault,
	metadataCache: MetadataCache,
	notorDir: string
): Promise<Workflow[]> {
	const workflowsRootPath = getWorkflowsRootPath(notorDir);
	const workflowsRoot = vault.getAbstractFileByPath(workflowsRootPath);

	if (!workflowsRoot) {
		log.debug("Workflows directory does not exist", { path: workflowsRootPath });
		return [];
	}

	if (!isFolder(workflowsRoot)) {
		log.warn("Workflows path exists but is not a directory", {
			path: workflowsRootPath,
		});
		return [];
	}

	const workflows: Workflow[] = [];
	const markdownFiles = collectMarkdownFiles(workflowsRoot as TFolder);

	for (const file of markdownFiles) {
		try {
			const workflow = parseWorkflowFile(
				metadataCache,
				file,
				workflowsRootPath
			);
			if (workflow) {
				workflows.push(workflow);
			}
		} catch (e) {
			log.warn("Unexpected error processing workflow file, skipping", {
				path: file.path,
				error: String(e),
			});
		}
	}

	log.info("Workflow discovery complete", {
		workflowsDir: workflowsRootPath,
		found: workflows.length,
	});

	return workflows;
}

// ---------------------------------------------------------------------------
// Public API: validateWorkflow (C-004)
// ---------------------------------------------------------------------------

/**
 * Validate a workflow's frontmatter properties.
 *
 * Returns a structured result indicating whether the workflow is valid
 * and an array of human-readable error strings for any issues found.
 *
 * Can be called both during discovery and at execution time for
 * individual workflow validation.
 *
 * @param frontmatter - Raw frontmatter record from Obsidian's metadata cache
 * @param filePath - Vault-relative file path (for error messages)
 * @returns Validation result with `valid` boolean and error strings
 */
export function validateWorkflow(
	frontmatter: Record<string, unknown>,
	filePath: string
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	// Validate notor-workflow is true (boolean)
	const workflowFlag = frontmatter["notor-workflow"];
	if (workflowFlag !== true) {
		errors.push(
			`Workflow '${filePath}' has 'notor-workflow' set to '${String(workflowFlag)}' (expected boolean true)`
		);
	}

	// Validate notor-trigger is present and recognized
	const triggerValue = frontmatter["notor-trigger"];
	if (triggerValue === undefined || triggerValue === null) {
		errors.push(
			`Workflow '${filePath}' is missing required 'notor-trigger' property`
		);
	} else {
		const triggerStr = String(triggerValue);
		if (!(VALID_WORKFLOW_TRIGGERS as readonly string[]).includes(triggerStr)) {
			errors.push(
				`Workflow '${filePath}' has unrecognized trigger '${triggerStr}'`
			);
		}
	}

	// Validate notor-schedule is present when trigger is "scheduled"
	const triggerStr = triggerValue !== undefined && triggerValue !== null
		? String(triggerValue)
		: "";
	if (triggerStr === "scheduled") {
		const scheduleValue = frontmatter["notor-schedule"];
		if (
			scheduleValue === undefined ||
			scheduleValue === null ||
			String(scheduleValue).trim() === ""
		) {
			errors.push(
				`Workflow '${filePath}' has trigger 'scheduled' but is missing 'notor-schedule'`
			);
		}
	}

	// Validate notor-workflow-persona is a string or omitted
	const personaValue = frontmatter["notor-workflow-persona"];
	if (
		personaValue !== undefined &&
		personaValue !== null &&
		typeof personaValue !== "string"
	) {
		errors.push(
			`Workflow '${filePath}' has invalid 'notor-workflow-persona' (expected string, got ${typeof personaValue})`
		);
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

// ---------------------------------------------------------------------------
// Public API: validateCronExpression (C-005)
// ---------------------------------------------------------------------------

/**
 * Validate basic cron expression structure.
 *
 * Checks for 5-field cron format (minute, hour, day-of-month, month,
 * day-of-week) or recognized shorthand aliases. This is a structural
 * check only — deep semantic validation (e.g., valid day ranges) will
 * be handled by `croner`'s `CronPattern` constructor when the cron
 * library is integrated in Group F.
 *
 * @param expression - Cron expression string to validate
 * @returns Validation result with `valid` boolean and optional error message
 */
export function validateCronExpression(
	expression: string
): { valid: boolean; error?: string } {
	const trimmed = expression.trim();

	if (trimmed.length === 0) {
		return { valid: false, error: "Cron expression is empty" };
	}

	// Check shorthand aliases
	if (trimmed.startsWith("@")) {
		if (CRON_SHORTHANDS.has(trimmed.toLowerCase())) {
			return { valid: true };
		}
		return {
			valid: false,
			error: `Unrecognized cron shorthand '${trimmed}'. Valid shorthands: ${Array.from(CRON_SHORTHANDS).join(", ")}`,
		};
	}

	// Check 5-field format
	const fields = trimmed.split(/\s+/);
	if (fields.length !== 5) {
		return {
			valid: false,
			error: `Expected 5 cron fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
		};
	}

	// Basic field validation: each field should contain only valid cron characters
	const cronFieldPattern = /^[\d*,\-/]+$/;
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i]!;
		if (!cronFieldPattern.test(field)) {
			const fieldNames = ["minute", "hour", "day-of-month", "month", "day-of-week"];
			return {
				valid: false,
				error: `Invalid characters in ${fieldNames[i]} field: '${field}'`,
			};
		}
	}

	return { valid: true };
}

// ---------------------------------------------------------------------------
// Public API: parseWorkflowHooks (C-006)
// ---------------------------------------------------------------------------

/**
 * Parse the `notor-hooks` frontmatter property from a workflow note.
 *
 * Accepts the raw value from Obsidian's YAML parser (which returns it
 * as a JavaScript object or `undefined`). Validates event names and
 * action definitions, logging warnings for invalid entries.
 *
 * Handles both kebab-case (`pre-send`) and snake_case (`pre_send`)
 * event names — normalizes to snake_case for the `LLMHookEvent` type.
 *
 * @param hooksValue - Raw `notor-hooks` value from frontmatter
 * @param filePath - Vault-relative file path (for warning messages)
 * @returns Parsed `WorkflowHookConfig` or `null` if no valid hooks
 */
export function parseWorkflowHooks(
	hooksValue: unknown,
	filePath: string
): WorkflowHookConfig | null {
	// undefined/null → no hook overrides
	if (hooksValue === undefined || hooksValue === null) {
		return null;
	}

	// Must be a plain object (YAML mapping)
	if (typeof hooksValue !== "object" || Array.isArray(hooksValue)) {
		log.warn(
			"Workflow has invalid notor-hooks: expected YAML mapping",
			{ path: filePath, type: typeof hooksValue }
		);
		return null;
	}

	const hooksObj = hooksValue as Record<string, unknown>;
	const config: WorkflowHookConfig = {};
	let hasValidActions = false;

	for (const [rawKey, rawActions] of Object.entries(hooksObj)) {
		// Normalize event name (kebab-case → snake_case)
		const eventName = HOOK_EVENT_ALIASES[rawKey];
		if (!eventName) {
			log.warn("Workflow has unrecognized hook event name, ignoring", {
				path: filePath,
				event: rawKey,
			});
			continue;
		}

		// The value must be an array of action objects
		if (!Array.isArray(rawActions)) {
			log.warn("Workflow hook event value is not an array, ignoring", {
				path: filePath,
				event: rawKey,
			});
			continue;
		}

		const validActions: WorkflowScopedHook[] = [];

		for (let i = 0; i < rawActions.length; i++) {
			const rawAction = rawActions[i];
			if (typeof rawAction !== "object" || rawAction === null || Array.isArray(rawAction)) {
				log.warn("Workflow hook action is not an object, skipping", {
					path: filePath,
					event: rawKey,
					index: i,
				});
				continue;
			}

			const actionObj = rawAction as Record<string, unknown>;
			const parsed = parseHookAction(actionObj, filePath, rawKey, i);
			if (parsed) {
				parsed.event = eventName;
				validActions.push(parsed);
			}
		}

		if (validActions.length > 0) {
			config[eventName] = validActions;
			hasValidActions = true;
		}
	}

	// If all actions are invalid → return null (no overrides)
	return hasValidActions ? config : null;
}

// ---------------------------------------------------------------------------
// Internal: file collection
// ---------------------------------------------------------------------------

/**
 * Recursively collect all Markdown files from a folder tree.
 */
function collectMarkdownFiles(folder: TFolder): TFile[] {
	const files: TFile[] = [];

	for (const child of folder.children) {
		if (isFolder(child)) {
			files.push(...collectMarkdownFiles(child as TFolder));
		} else if (isFile(child) && child.name.endsWith(".md")) {
			files.push(child as TFile);
		}
	}

	return files;
}

// ---------------------------------------------------------------------------
// Internal: workflow file parsing (C-002 + C-003)
// ---------------------------------------------------------------------------

/**
 * Parse a single Markdown file as a potential workflow.
 *
 * Returns a populated `Workflow` object if the file is a valid workflow,
 * or `null` if it should be excluded (not a workflow, or invalid).
 */
function parseWorkflowFile(
	metadataCache: MetadataCache,
	file: TFile,
	workflowsRootPath: string
): Workflow | null {
	// Get frontmatter from metadata cache
	const fileCache = metadataCache.getFileCache(file);
	const frontmatter = fileCache?.frontmatter;

	// No frontmatter → not a workflow (silently ignore)
	if (!frontmatter) {
		return null;
	}

	// Check notor-workflow flag — must be boolean true
	if (frontmatter["notor-workflow"] !== true) {
		return null;
	}

	// Validate the workflow
	const validation = validateWorkflow(frontmatter, file.path);

	// Check for fatal errors (missing/invalid trigger)
	const triggerValue = frontmatter["notor-trigger"];
	const hasTrigger =
		triggerValue !== undefined &&
		triggerValue !== null &&
		(VALID_WORKFLOW_TRIGGERS as readonly string[]).includes(String(triggerValue));

	if (!hasTrigger) {
		// Log all validation errors and exclude
		for (const error of validation.errors) {
			log.warn(error);
		}
		return null;
	}

	const trigger = String(triggerValue) as WorkflowTrigger;

	// Parse optional properties (C-003)
	const personaName = parseStringOrNull(frontmatter["notor-workflow-persona"]);

	// Parse and validate schedule (C-005)
	let schedule: string | null = null;
	if (trigger === "scheduled") {
		const rawSchedule = frontmatter["notor-schedule"];
		if (
			rawSchedule !== undefined &&
			rawSchedule !== null &&
			String(rawSchedule).trim() !== ""
		) {
			const scheduleStr = String(rawSchedule).trim();
			const cronResult = validateCronExpression(scheduleStr);
			if (cronResult.valid) {
				schedule = scheduleStr;
			} else {
				log.warn(
					`Workflow '${file.path}' has invalid cron expression: ${cronResult.error}`
				);
				// schedule remains null — can be triggered manually but not scheduled
			}
		} else {
			log.warn(
				`Workflow '${file.path}' has trigger 'scheduled' but is missing 'notor-schedule'`
			);
		}
	}

	// Parse hooks (C-006)
	const hooks = parseWorkflowHooks(frontmatter["notor-hooks"], file.path);

	// Derive display name (C-003)
	const relativePath = file.path.startsWith(workflowsRootPath + "/")
		? file.path.substring(workflowsRootPath.length + 1)
		: file.name;
	const displayName = relativePath.replace(/\.md$/, "");

	// Log non-fatal validation errors as warnings
	for (const error of validation.errors) {
		// Skip errors we've already handled (trigger-related ones)
		if (
			!error.includes("missing required 'notor-trigger'") &&
			!error.includes("unrecognized trigger")
		) {
			log.warn(error);
		}
	}

	return {
		file_path: file.path,
		file_name: file.name,
		display_name: displayName,
		trigger,
		schedule,
		persona_name: personaName,
		hooks,
		body_content: "", // Deferred — read lazily at execution time (NFR-10)
	};
}

// ---------------------------------------------------------------------------
// Internal: hook action parsing (C-006)
// ---------------------------------------------------------------------------

/**
 * Parse a single hook action object from the `notor-hooks` array.
 *
 * @returns A `WorkflowScopedHook` (with `event` unset — caller fills it),
 *          or `null` if the action is invalid.
 */
function parseHookAction(
	actionObj: Record<string, unknown>,
	filePath: string,
	eventKey: string,
	index: number
): WorkflowScopedHook | null {
	const actionType = actionObj["action"];

	if (actionType !== "execute_command" && actionType !== "run_workflow") {
		log.warn("Workflow hook action has unsupported action type, skipping", {
			path: filePath,
			event: eventKey,
			index,
			action: String(actionType),
		});
		return null;
	}

	if (actionType === "execute_command") {
		const command = actionObj["command"];
		if (typeof command !== "string" || command.trim() === "") {
			log.warn(
				"Workflow hook 'execute_command' action is missing 'command', skipping",
				{ path: filePath, event: eventKey, index }
			);
			return null;
		}
		return {
			event: "pre_send", // placeholder — caller overwrites
			action_type: "execute_command",
			command: command.trim(),
			workflow_path: null,
		};
	}

	// actionType === "run_workflow"
	const workflowPath = actionObj["path"];
	if (typeof workflowPath !== "string" || workflowPath.trim() === "") {
		log.warn(
			"Workflow hook 'run_workflow' action is missing 'path', skipping",
			{ path: filePath, event: eventKey, index }
		);
		return null;
	}
	return {
		event: "pre_send", // placeholder — caller overwrites
		action_type: "run_workflow",
		command: null,
		workflow_path: workflowPath.trim(),
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a frontmatter value as a string or null.
 * Returns null for undefined, null, or empty string values.
 */
function parseStringOrNull(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	const str = String(value).trim();
	return str.length > 0 ? str : null;
}

/**
 * Get the vault-relative path to the workflows root directory.
 */
function getWorkflowsRootPath(notorDir: string): string {
	return `${notorDir.replace(/\/$/, "")}/workflows`;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Check if an abstract file is a folder (TFolder).
 */
function isFolder(file: TAbstractFile): file is TFolder {
	return "children" in file;
}

/**
 * Check if an abstract file is a file (TFile).
 */
function isFile(file: TAbstractFile): file is TFile {
	return "stat" in file && !("children" in file);
}
