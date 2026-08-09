/**
 * Parser for `<notor_tool_config>` XML blocks embedded in source text.
 *
 * Extracts, validates, and strips config blocks from persona system prompts,
 * workflow notes, and vault rule files. Returns structured data — this module
 * has no Obsidian dependency. Callers surface errors as Notices.
 *
 * @see specs/04b-tool-toggle/spec.md — FR-78, FR-81, FR-82
 */

import type {
	ParsedToolConfig,
	ToolConfigEntry,
	ToolConfigSource,
	ToolConfigValidationError,
} from "./types";
import { isMcpTool } from "../mcp/mcp-tool-adapter";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum supported major version of the `<notor_tool_config>` schema. */
const MAX_SUPPORTED_MAJOR = 1;

/**
 * Hardened regex for extracting `<notor_tool_config>` blocks.
 *
 * - `^` + `m` flag: matches only at line boundaries (block-level authoring).
 * - `[^>]*`: captures opening-tag attributes (e.g., `version="1.0"`).
 * - `[\s\S]*?`: non-greedy capture of YAML body.
 *
 * @see specs/04b-tool-toggle/research/RT-2-extraction-parser-benchmark.md
 */
const TAG_REGEX = /^<notor_tool_config([^>]*)>([\s\S]*?)<\/notor_tool_config>/gm;

/** Regex for extracting the `version` attribute value from the opening tag. */
const VERSION_ATTR_REGEX = /version\s*=\s*"([^"]*)"/;

/** Valid per-tool fields in a `<notor_tool_config>` block. */
const VALID_FIELDS = new Set([
	"enabled", "auto_approve", "allowed_paths", "blocked_paths",
	"allowed_command_patterns", "blocked_command_patterns",
	"auto_approve_paths", "never_auto_approve_paths",
]);

/** Regex to detect MCP server wildcard keys like `serverName__*`. */
const MCP_WILDCARD_REGEX = /^(.+)__\*$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExtractToolConfigsResult {
	strippedContent: string;
	configs: ParsedToolConfig[];
	errors: ToolConfigValidationError[];
}

/**
 * Extract and strip all `<notor_tool_config>` blocks from source text.
 *
 * Ordering: `<include_note>` resolution MUST run before calling this.
 *
 * @param text        - Source text (after `<include_note>` resolution).
 * @param source      - The context type of the source file.
 * @param sourceFile  - Vault-relative path of the source file.
 * @param knownToolNames - All registered tool names (built-in + MCP).
 *                         Used to validate top-level keys. If omitted,
 *                         tool-name validation is skipped.
 * @param parseYAML   - YAML parser function (injected to avoid Obsidian
 *                       dependency in the module). Defaults to JSON.parse
 *                       as a fallback; callers should pass `parseYAML`
 *                       from `obsidian`.
 */
export function extractToolConfigs(
	text: string,
	source: ToolConfigSource,
	sourceFile: string,
	knownToolNames?: string[],
	parseYAML?: (yaml: string) => unknown,
): ExtractToolConfigsResult {
	const configs: ParsedToolConfig[] = [];
	const errors: ToolConfigValidationError[] = [];
	const knownSet = knownToolNames ? new Set(knownToolNames) : null;
	const parse = parseYAML ?? JSON.parse;

	// Replace matched blocks with empty string to produce stripped content
	const strippedContent = text.replace(TAG_REGEX, (match, attrs: string, body: string, offset: number) => {
		// 1. Parse version attribute
		const version = parseVersionAttribute(attrs);
		if (version !== null && version > MAX_SUPPORTED_MAJOR) {
			console.warn(
				`[notor] Skipping <notor_tool_config> block in "${sourceFile}": ` +
				`unsupported major version ${version} (max supported: ${MAX_SUPPORTED_MAJOR})`,
			);
			return "";
		}

		// 2. Parse YAML body
		let parsed: unknown;
		try {
			parsed = parse(body);
		} catch (e) {
			errors.push({
				sourceFile,
				detail: `Invalid YAML in <notor_tool_config> block: ${e instanceof Error ? e.message : String(e)}`,
			});
			return "";
		}

		// 3. Type guard: must be a non-null, non-array plain object
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
			errors.push({
				sourceFile,
				detail: `<notor_tool_config> block must contain a YAML mapping (got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}).`,
			});
			return "";
		}

		// 4. Validate and extract per-tool entries
		const tools: Record<string, ToolConfigEntry> = {};
		const serverDefaults: Record<string, ToolConfigEntry> = {};
		for (const [toolName, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
			// Check for MCP server wildcard key (e.g., "serverName__*")
			const wildcardMatch = MCP_WILDCARD_REGEX.exec(toolName);
			const isWildcard = wildcardMatch !== null;
			const wildcardServerName = wildcardMatch?.[1] ?? "";

			// Validate tool name (skip for wildcards — they don't match a specific tool)
			if (!isWildcard && knownSet && !knownSet.has(toolName)) {
				errors.push({
					sourceFile,
					detail: `Unrecognized tool name "${toolName}" in <notor_tool_config>. Skipping this tool entry.`,
				});
				continue;
			}

			// Tool entry must be an object
			if (rawEntry == null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
				errors.push({
					sourceFile,
					detail: `Tool "${toolName}": expected a mapping of fields, got ${rawEntry === null ? "null" : Array.isArray(rawEntry) ? "array" : typeof rawEntry}. Skipping this tool entry.`,
				});
				continue;
			}

			const entry: ToolConfigEntry = {};
			// Wildcards are always MCP-scoped; individual tools check via isMcpTool
			const isMcp = isWildcard || isMcpTool(toolName);

			for (const [field, value] of Object.entries(rawEntry as Record<string, unknown>)) {
				// Unrecognized field
				if (!VALID_FIELDS.has(field)) {
					errors.push({
						sourceFile,
						detail: `Tool "${toolName}": unrecognized field "${field}". Skipping this field.`,
					});
					continue;
				}

				// MCP path field restriction — MCP tools have no registered path params
				if (
					isMcp &&
					(field === "allowed_paths" ||
						field === "blocked_paths" ||
						field === "auto_approve_paths" ||
						field === "never_auto_approve_paths")
				) {
					errors.push({
						sourceFile,
						detail: `Tool "${toolName}": "${field}" is not yet implemented for MCP tools. Skipping this field.`,
					});
					continue;
				}

				// Type validation per field
				if (field === "enabled") {
					if (typeof value !== "boolean") {
						errors.push({
							sourceFile,
							detail: `Tool "${toolName}": "enabled" must be a boolean, got ${typeof value}. Skipping this field.`,
						});
						continue;
					}
					entry.enabled = value;
				} else if (field === "auto_approve") {
					if (typeof value !== "boolean") {
						errors.push({
							sourceFile,
							detail: `Tool "${toolName}": "auto_approve" must be a boolean, got ${typeof value}. Skipping this field.`,
						});
						continue;
					}
					entry.auto_approve = value;
				} else if (field === "allowed_paths") {
					if (!isStringArray(value)) {
						errors.push({
							sourceFile,
							detail: `Tool "${toolName}": "allowed_paths" must be an array of strings. Skipping this field.`,
						});
						continue;
					}
					entry.allowed_paths = value;
				} else if (field === "blocked_paths") {
					if (!isStringArray(value)) {
						errors.push({
							sourceFile,
							detail: `Tool "${toolName}": "blocked_paths" must be an array of strings. Skipping this field.`,
						});
						continue;
					}
					entry.blocked_paths = value;
				} else if (field === "allowed_command_patterns") {
					if (!isStringArray(value)) {
						errors.push({
							sourceFile,
							detail: `Tool "${toolName}": "allowed_command_patterns" must be an array of strings. Skipping this field.`,
						});
						continue;
					}
					entry.allowed_command_patterns = value;
				} else if (field === "blocked_command_patterns") {
					if (!isStringArray(value)) {
						errors.push({
							sourceFile,
							detail: `Tool "${toolName}": "blocked_command_patterns" must be an array of strings. Skipping this field.`,
						});
						continue;
					}
					entry.blocked_command_patterns = value;
				} else if (field === "auto_approve_paths") {
					if (!isStringArray(value)) {
						errors.push({
							sourceFile,
							detail: `Tool "${toolName}": "auto_approve_paths" must be an array of strings. Skipping this field.`,
						});
						continue;
					}
					entry.auto_approve_paths = value;
				} else if (field === "never_auto_approve_paths") {
					if (!isStringArray(value)) {
						errors.push({
							sourceFile,
							detail: `Tool "${toolName}": "never_auto_approve_paths" must be an array of strings. Skipping this field.`,
						});
						continue;
					}
					entry.never_auto_approve_paths = value;
				}
			}

			// Only add if at least one valid field was extracted
			if (Object.keys(entry).length > 0) {
				if (isWildcard) {
					serverDefaults[wildcardServerName] = entry;
				} else {
					tools[toolName] = entry;
				}
			}
		}

		const config: ParsedToolConfig = {
			source,
			sourceFile,
			documentPosition: offset,
			tools,
		};
		if (Object.keys(serverDefaults).length > 0) {
			config.serverDefaults = serverDefaults;
		}
		configs.push(config);

		return "";
	});

	return { strippedContent, configs, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse the major version number from the opening tag attributes.
 * Returns `null` if no version attribute is present.
 */
function parseVersionAttribute(attrs: string): number | null {
	const match = VERSION_ATTR_REGEX.exec(attrs);
	if (!match) return null;

	const versionStr = match[1] ?? "";
	const parts = versionStr.split(".");
	const major = parseInt(parts[0] ?? "", 10);
	return isNaN(major) ? null : major;
}

/** Check if a value is a string array. */
function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}
