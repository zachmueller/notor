/**
 * Shared types for the user-defined extension system.
 *
 * Extensions are vault-authored Markdown files (in `notor/tools/` and
 * `notor/automations/`) containing frontmatter metadata, an optional YAML
 * code fence for param/settings schemas, and a TS/JS code fence with the
 * extension logic.
 */

import type { ToolPathParam } from "../tool-config/types";

// ---------------------------------------------------------------------------
// Extension type discriminator
// ---------------------------------------------------------------------------

/** Discriminator for extension type parsed from frontmatter `notor-type`. */
export type ExtensionType = "tool" | "automation" | "settings" | "block";

// ---------------------------------------------------------------------------
// Param schema
// ---------------------------------------------------------------------------

/** Simplified param schema parsed from the YAML fence `params` block. */
export interface ParamSchema {
	[paramName: string]: {
		type: string;
		description?: string;
		default?: unknown;
		enum?: string[];
		items?: { type: string };
		/**
		 * For `object[]` type: property definitions for each object in the array.
		 * Each key maps to `{ type, description? }`. Converted to JSON Schema
		 * `items.properties` by `paramSchemaToJsonSchema()`.
		 */
		properties?: Record<string, { type: string; description?: string }>;
		/**
		 * For `object[]` type: which properties inside each object are required.
		 * Converted to JSON Schema `items.required` by `paramSchemaToJsonSchema()`.
		 */
		required_items?: string[];
		/** If set, this param is a path and participates in path enforcement. */
		path_namespace?: "vault" | "filesystem";
	};
}

// ---------------------------------------------------------------------------
// Settings field schema
// ---------------------------------------------------------------------------

/** Schema for a single settings field, parsed from the YAML fence `settings` block. */
export interface SettingsFieldSchema {
	/** Setting key (YAML key name). */
	key: string;
	/** Human-readable label for settings UI. */
	name: string;
	/** Value type. */
	type: "string" | "number" | "boolean" | "string[]";
	/** Sub-text for settings UI. */
	description?: string;
	/** Default value (type must match `type` field). */
	default?: string | number | boolean | string[];
	/** If true, stored in SecretStorage. */
	secret?: boolean;
	/** Min value (number type only). */
	min?: number;
	/** Max value (number type only). */
	max?: number;
	/** Constrains valid values — renders as dropdown for `string`, constrains Add input for `string[]`. */
	options?: string[];
	/** Dynamic options source key. When set, `options` is populated at render time (e.g. "model_presets"). */
	optionsSource?: string;
}

// ---------------------------------------------------------------------------
// Compiled extension function
// ---------------------------------------------------------------------------

/** Compiled extension function signature. */
export type CompiledExtensionFn = (...args: unknown[]) => Promise<unknown>;

// ---------------------------------------------------------------------------
// User tool definition
// ---------------------------------------------------------------------------

/** Parsed representation of a user-defined tool from a vault Markdown file. */
export interface UserToolDefinition {
	/** Source vault-relative file path. */
	filePath: string;
	/** Tool name from frontmatter `notor-tool-name`. */
	name: string;
	/** Description from frontmatter `notor-description`. */
	description: string;
	/** Mode from frontmatter `notor-mode`. */
	mode: "read" | "write";
	/** Parsed param schema from YAML fence `params` block. */
	params: ParamSchema;
	/** Path parameter descriptors for path enforcement (from `params[x].path_namespace`). */
	pathParams: ToolPathParam[];
	/** Parsed settings schema from YAML fence `settings` block (optional). */
	settingsSchema: SettingsFieldSchema[] | null;
	/** Raw TypeScript/JavaScript code from code fence. */
	rawCode: string;
	/** Compiled async function (null until compilation succeeds). */
	compiledFn: CompiledExtensionFn | null;
	/** True when this tool was loaded from a built-in scaffold (no vault file). */
	isScaffold?: boolean;
	/** Block kind declarations from the `blocks:` YAML section (optional). */
	blocks?: BlockKindDeclaration[];
}

// ---------------------------------------------------------------------------
// Automation trigger & definition
// ---------------------------------------------------------------------------

/**
 * Automation trigger — union of LLM lifecycle events and vault events.
 *
 * LLM lifecycle: `pre_send`, `on_tool_call`, `on_tool_result`, `after_completion`
 * Vault events: `on_note_open`, `on_note_create`, `on_save`, `on_manual_save`, `on_tag_change`, `on_schedule`
 */
export type AutomationTrigger =
	| "pre_send"
	| "on_tool_call"
	| "on_tool_result"
	| "after_completion"
	| "on_conversation_start"
	| "on_note_open"
	| "on_note_create"
	| "on_save"
	| "on_manual_save"
	| "on_tag_change"
	| "on_schedule";

/** Parsed representation of a user-defined automation from a vault Markdown file. */
export interface UserAutomationDefinition {
	/** Source vault-relative file path. */
	filePath: string;
	/** Display name from frontmatter `notor-display-name`. */
	displayName: string | null;
	/** Trigger event from frontmatter `notor-trigger`. */
	trigger: AutomationTrigger;
	/** Cron expression — required when trigger is `on_schedule`. */
	schedule: string | null;
	/** Tool name filter from frontmatter `notor-tools`. */
	toolFilter: string[] | null;
	/** Execution order from frontmatter `notor-automation-order`. Default 0. */
	order: number;
	/** Parsed settings schema from YAML fence `settings` block (optional). */
	settingsSchema: SettingsFieldSchema[] | null;
	/** Raw TypeScript/JavaScript code from code fence. */
	rawCode: string;
	/** Compiled async function (null until compilation succeeds). */
	compiledFn: CompiledExtensionFn | null;
	/**
	 * Whether this is a built-in scaffold automation (analogous to tool scaffolds).
	 * Scaffold automations are injected when no user-defined automation with
	 * the same trigger/name exists.
	 *
	 * @see specs/ZZ-misc/model-presets-design.md — Section 12.1
	 */
	isScaffold?: boolean;
	/** Block kind declarations from the `blocks:` YAML section (optional). */
	blocks?: BlockKindDeclaration[];
	/**
	 * When true, this automation is awaited before the first LLM turn proceeds.
	 * Only meaningful for `on_conversation_start` automations.
	 */
	blocking?: boolean;
	/**
	 * Block kind to emit as a loading placeholder before this automation runs.
	 * Must be a registered block kind. Only used when `blocking === true`.
	 */
	blockingEmitKind?: string;
	/**
	 * Timeout in milliseconds for blocking execution. Defaults to 10000ms.
	 * On timeout, the automation is detached and the turn proceeds without the block.
	 */
	blockingTimeout?: number;
}

// ---------------------------------------------------------------------------
// Shared settings definition
// ---------------------------------------------------------------------------

/** Global shared settings definition parsed from `notor/settings.md`. */
export interface SharedSettingsDefinition {
	/** Source vault-relative file path (`notor/settings.md`). */
	filePath: string;
	/** Parsed settings schema from YAML fence `settings` block. */
	settingsSchema: SettingsFieldSchema[];
}

// ---------------------------------------------------------------------------
// Block kind declarations (attached to tools/automations or standalone)
// ---------------------------------------------------------------------------

/**
 * A block kind declared in the `blocks:` YAML section of a tool or automation scaffold.
 *
 * The code fence of the parent extension must export the named render and
 * (optionally) toLLMText functions.
 */
export interface BlockKindDeclaration {
	/** Globally unique block kind identifier (e.g. `memory_recalled`). */
	kind: string;
	/** Human-readable display name (e.g. "Memories Recalled"). */
	displayName: string;
	/** Emoji or Lucide icon name. */
	icon?: string;
	/** Named export in the code fence that provides the render function. */
	rendererExport: string;
	/** Named export in the code fence that provides the toLLMText function (optional). */
	toLLMTextExport?: string;
	/** Whether to exclude this block from compaction input. Default false. */
	excludeFromCompaction?: boolean;
}

/**
 * Parsed representation of a `notor-type: block` standalone block-kind extension.
 *
 * Discovered from `{notor_dir}/blocks/`. Registers one block kind with
 * `ChatBlockRegistry` independently of any tool or automation.
 */
export interface UserBlockDefinition {
	/** Source vault-relative file path. */
	filePath: string;
	/** Globally unique block kind identifier from frontmatter `notor-block-kind`. */
	kind: string;
	/** Human-readable display name from frontmatter `notor-display-name`. */
	displayName: string;
	/** Emoji or Lucide icon name from frontmatter `notor-icon`. */
	icon?: string;
	/** Whether to exclude blocks of this kind from compaction. From `notor-exclude-from-compaction`. */
	excludeFromCompaction?: boolean;
	/** Named export in the code fence that provides the render function. */
	rendererExport: string;
	/** Named export in the code fence that provides the toLLMText function (optional). */
	toLLMTextExport?: string;
	/** Raw TypeScript/JavaScript code from code fence. */
	rawCode: string;
	/** Compiled async function (null until compilation succeeds). */
	compiledFn: CompiledExtensionFn | null;
	/** True when this block was loaded from a built-in scaffold. */
	isScaffold?: boolean;
}

// ---------------------------------------------------------------------------
// Error & reload result
// ---------------------------------------------------------------------------

/** Error encountered during extension parsing or compilation. */
export interface ExtensionError {
	/** Vault-relative file path of the extension that produced the error. */
	filePath: string;
	/** Human-readable error description. */
	message: string;
}

/** Summary returned by `ExtensionManager.reload()`. */
export interface ExtensionReloadResult {
	/** Number of user tools successfully compiled and registered. */
	toolCount: number;
	/** Number of user automations successfully compiled. */
	automationCount: number;
	/** Number of block kinds compiled and registered with ChatBlockRegistry. */
	blockCount: number;
	/** Names of built-in tools that were overridden by user tools. */
	builtinOverrides: string[];
	/** Errors encountered during discovery, parsing, or compilation. */
	errors: ExtensionError[];
}
