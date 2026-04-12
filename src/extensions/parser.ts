/**
 * Markdown parser for user-defined extension files.
 *
 * Extracts frontmatter, YAML code fence (params/settings schemas), and
 * TS/JS code fence from extension Markdown files.
 */

import type {
	AutomationTrigger,
	ExtensionError,
	ParamSchema,
	SettingsFieldSchema,
	SharedSettingsDefinition,
	UserAutomationDefinition,
	UserToolDefinition,
} from "./types";
import { parseSettingsSchema } from "./settings-schema";
import { extractPathParams } from "./param-schema";

// ---------------------------------------------------------------------------
// Valid automation trigger values (for validation)
// ---------------------------------------------------------------------------

const VALID_TRIGGERS = new Set<string>([
	"pre_send",
	"on_tool_call",
	"on_tool_result",
	"after_completion",
	"on_conversation_start",
	"on_note_open",
	"on_note_create",
	"on_save",
	"on_manual_save",
	"on_tag_change",
	"on_schedule",
]);

// ---------------------------------------------------------------------------
// Fence extraction
// ---------------------------------------------------------------------------

/**
 * Extract the content of the first ```yaml fenced code block.
 * Returns the inner content or null if not found.
 */
export function extractYamlFence(content: string): string | null {
	const regex = /^```yaml\s*\n([\s\S]*?)^```\s*$/gm;
	const match = regex.exec(content);
	if (!match) return null;
	const inner = match[1];
	// Treat empty fences as not found
	if (!inner || inner.trim() === "") return null;
	return inner;
}

/**
 * Extract the content and language of the first TS/JS fenced code block.
 * Returns `{ code, lang }` or null if not found.
 */
export function extractCodeFence(content: string): { code: string; lang: string } | null {
	const regex = /^```(ts|typescript|js|javascript)\s*\n([\s\S]*?)^```\s*$/gm;
	const match = regex.exec(content);
	if (!match) return null;
	const lang = match[1] ?? "";
	const code = match[2] ?? "";
	if (code.trim() === "") return null;
	return { code, lang };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export type ParseResult =
	| UserToolDefinition
	| UserAutomationDefinition
	| SharedSettingsDefinition
	| ExtensionError;

/**
 * Parse an extension Markdown file into a typed definition.
 *
 * @param content    - Raw Markdown file content
 * @param frontmatter - Parsed frontmatter (from metadataCache or manual YAML parsing)
 * @param filePath   - Vault-relative file path (for error messages)
 * @param parseYAML  - YAML parser function (Obsidian's `parseYaml`)
 * @returns Parsed definition or an ExtensionError
 */
export function parseExtensionFile(
	content: string,
	frontmatter: Record<string, unknown>,
	filePath: string,
	parseYAML: (yaml: string) => unknown,
): ParseResult {
	// -- Validate notor-type --
	const notorType = frontmatter["notor-type"];
	if (!notorType) {
		return { filePath, message: "Missing required frontmatter field 'notor-type'" };
	}
	if (notorType !== "tool" && notorType !== "automation" && notorType !== "settings") {
		return { filePath, message: `Invalid 'notor-type': '${String(notorType)}'. Must be 'tool', 'automation', or 'settings'` };
	}

	// -- Extract YAML fence --
	const yamlFenceRaw = extractYamlFence(content);
	let yamlFenceData: Record<string, unknown> | null = null;
	if (yamlFenceRaw) {
		try {
			const parsed = parseYAML(yamlFenceRaw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				yamlFenceData = parsed as Record<string, unknown>;
			}
		} catch {
			return { filePath, message: "Failed to parse YAML code fence" };
		}
	}

	// -- Extract code fence --
	const codeFence = extractCodeFence(content);

	// -- Dispatch to type-specific parsing --
	switch (notorType) {
		case "tool":
			return parseToolFile(frontmatter, yamlFenceData, codeFence, filePath);
		case "automation":
			return parseAutomationFile(frontmatter, yamlFenceData, codeFence, filePath);
		case "settings":
			return parseSettingsFile(yamlFenceData, filePath);
	}
}

// ---------------------------------------------------------------------------
// Tool parsing
// ---------------------------------------------------------------------------

function parseToolFile(
	frontmatter: Record<string, unknown>,
	yamlFenceData: Record<string, unknown> | null,
	codeFence: { code: string; lang: string } | null,
	filePath: string,
): UserToolDefinition | ExtensionError {
	// Validate required frontmatter fields
	const name = frontmatter["notor-tool-name"];
	if (!name || typeof name !== "string") {
		return { filePath, message: "Missing or invalid required frontmatter field 'notor-tool-name' (must be a string)" };
	}

	const description = frontmatter["notor-description"];
	if (!description || typeof description !== "string") {
		return { filePath, message: "Missing or invalid required frontmatter field 'notor-description' (must be a string)" };
	}

	const mode = frontmatter["notor-mode"];
	if (mode !== "read" && mode !== "write") {
		return { filePath, message: `Missing or invalid required frontmatter field 'notor-mode': '${String(mode)}'. Must be 'read' or 'write'` };
	}

	// Code fence is required for tools
	if (!codeFence) {
		return { filePath, message: "Missing required code fence (```ts, ```typescript, ```js, or ```javascript)" };
	}

	// Parse params from YAML fence (required)
	const rawParams = yamlFenceData?.params;
	let params: ParamSchema = {};
	if (rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)) {
		params = rawParams as ParamSchema;
	}

	// Extract path params from params with path_namespace
	const pathParams = extractPathParams(name, params);

	// Parse settings from YAML fence (optional)
	let settingsSchema: SettingsFieldSchema[] | null = null;
	const rawSettings = yamlFenceData?.settings;
	if (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)) {
		const result = parseSettingsSchema(rawSettings as Record<string, unknown>);
		if (result.errors.length > 0) {
			return { filePath, message: `Settings schema errors: ${result.errors.join("; ")}` };
		}
		settingsSchema = result.schemas;
	}

	return {
		filePath,
		name,
		description,
		mode,
		params,
		pathParams,
		settingsSchema,
		rawCode: codeFence.code,
		compiledFn: null,
	};
}

// ---------------------------------------------------------------------------
// Automation parsing
// ---------------------------------------------------------------------------

function parseAutomationFile(
	frontmatter: Record<string, unknown>,
	yamlFenceData: Record<string, unknown> | null,
	codeFence: { code: string; lang: string } | null,
	filePath: string,
): UserAutomationDefinition | ExtensionError {
	// Validate required frontmatter: notor-trigger
	const trigger = frontmatter["notor-trigger"];
	if (!trigger || typeof trigger !== "string" || !VALID_TRIGGERS.has(trigger)) {
		return {
			filePath,
			message: `Missing or invalid required frontmatter field 'notor-trigger': '${String(trigger)}'. Must be one of: ${[...VALID_TRIGGERS].join(", ")}`,
		};
	}

	// Code fence is required for automations
	if (!codeFence) {
		return { filePath, message: "Missing required code fence (```ts, ```typescript, ```js, or ```javascript)" };
	}

	// Parse optional fields
	const schedule = typeof frontmatter["notor-schedule"] === "string" ? frontmatter["notor-schedule"] : null;

	// on_schedule trigger requires notor-schedule
	if (trigger === "on_schedule" && !schedule) {
		return { filePath, message: "Trigger 'on_schedule' requires frontmatter field 'notor-schedule' with a cron expression" };
	}

	const rawToolFilter = frontmatter["notor-tools"];
	let toolFilter: string[] | null = null;
	if (Array.isArray(rawToolFilter)) {
		toolFilter = rawToolFilter.filter((t): t is string => typeof t === "string");
	} else if (typeof rawToolFilter === "string") {
		toolFilter = [rawToolFilter];
	}

	const displayName = typeof frontmatter["notor-display-name"] === "string" ? frontmatter["notor-display-name"] : null;

	const rawOrder = frontmatter["notor-automation-order"];
	const order = typeof rawOrder === "number" ? rawOrder : 0;

	// Parse settings from YAML fence (optional)
	let settingsSchema: SettingsFieldSchema[] | null = null;
	const rawSettings = yamlFenceData?.settings;
	if (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)) {
		const result = parseSettingsSchema(rawSettings as Record<string, unknown>);
		if (result.errors.length > 0) {
			return { filePath, message: `Settings schema errors: ${result.errors.join("; ")}` };
		}
		settingsSchema = result.schemas;
	}

	return {
		filePath,
		displayName,
		trigger: trigger as AutomationTrigger,
		schedule,
		toolFilter,
		order,
		settingsSchema,
		rawCode: codeFence.code,
		compiledFn: null,
	};
}

// ---------------------------------------------------------------------------
// Settings parsing
// ---------------------------------------------------------------------------

function parseSettingsFile(
	yamlFenceData: Record<string, unknown> | null,
	filePath: string,
): SharedSettingsDefinition | ExtensionError {
	const rawSettings = yamlFenceData?.settings;
	if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
		return { filePath, message: "Settings file requires a YAML code fence with a 'settings' block" };
	}

	const result = parseSettingsSchema(rawSettings as Record<string, unknown>);
	if (result.errors.length > 0) {
		return { filePath, message: `Settings schema errors: ${result.errors.join("; ")}` };
	}

	if (result.schemas.length === 0) {
		return { filePath, message: "Settings file must declare at least one setting field" };
	}

	return {
		filePath,
		settingsSchema: result.schemas,
	};
}
