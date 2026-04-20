/**
 * Sub-agent profile discovery — scans `{notor_dir}/sub-agents/` for
 * subdirectories containing a `system-prompt.md` file, parses
 * frontmatter properties, extracts tool config blocks, and returns
 * fully populated SubAgentProfile objects.
 *
 * Discovery is stateless — each call re-scans the directory.
 * Mirrors the persona discovery pattern in `src/personas/persona-discovery.ts`.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 2.4 (Sub-Agent Profiles)
 */

import type { MetadataCache, TFile, TFolder, Vault } from "obsidian";
import { TAbstractFile } from "obsidian";
import type { SubAgentProfile } from "./types";
import { BUILTIN_SUBAGENT_PROFILES } from "./builtin-profiles";
import { extractToolConfigs } from "../tool-config/parser";
import { logger } from "../utils/logger";
import type { TemplateVariableRegistry } from "../template-vars";

const log = logger("SubAgentDiscovery");

/** Name of the required system prompt file inside each sub-agent directory. */
const SYSTEM_PROMPT_FILENAME = "system-prompt.md";

/**
 * Scan `{notorDir}/sub-agents/` for valid profile directories and return
 * fully populated `SubAgentProfile` objects.
 *
 * A valid profile directory is a subdirectory that contains a
 * `system-prompt.md` file. Subdirectories without the file are silently
 * ignored. If the sub-agents root directory does not exist, only built-in
 * profiles are returned.
 *
 * Built-in profiles that also have a vault file are loaded from the vault
 * file (user customizations preserved). Built-in profiles without a vault
 * file are loaded from the code constants.
 *
 * @param vault - Obsidian Vault instance
 * @param metadataCache - Obsidian MetadataCache for frontmatter access
 * @param notorDir - Vault-relative path to the Notor directory (e.g. `"notor/"`)
 * @param knownToolNames - Registered tool names for tool config validation (optional)
 * @param parseYAML - YAML parser function (pass `parseYaml` from obsidian)
 * @param templateRegistry - Optional registry for template variable resolution
 * @returns Array of discovered and parsed SubAgentProfile objects
 */
export async function discoverSubAgentProfiles(
	vault: Vault,
	metadataCache: MetadataCache,
	notorDir: string,
	knownToolNames?: string[],
	parseYAML?: (yaml: string) => unknown,
	templateRegistry?: TemplateVariableRegistry,
): Promise<SubAgentProfile[]> {
	const rootPath = getSubAgentsRootPath(notorDir);
	const root = vault.getAbstractFileByPath(rootPath);

	const profiles: SubAgentProfile[] = [];
	const discoveredNames = new Set<string>();

	// Scan vault directory if it exists
	if (root && isFolder(root)) {
		for (const child of root.children) {
			if (!isFolder(child)) continue;

			const profile = await loadProfileFromDirectory(
				vault, metadataCache, child, knownToolNames, parseYAML, templateRegistry,
			);
			if (profile) {
				profiles.push(profile);
				discoveredNames.add(profile.name);
			}
		}
	} else if (root && !isFolder(root)) {
		log.warn("Sub-agents path exists but is not a directory", { path: rootPath });
	}

	// Add built-in profiles that don't have vault files
	for (const [name, builtin] of BUILTIN_SUBAGENT_PROFILES) {
		if (discoveredNames.has(name)) continue;

		const profile = buildProfileFromBuiltin(name, builtin.systemPromptContent, rootPath, knownToolNames, parseYAML, templateRegistry);
		profiles.push(profile);
	}

	log.info("Sub-agent profile discovery complete", {
		subAgentsDir: rootPath,
		found: profiles.length,
		fromVault: discoveredNames.size,
		fromBuiltin: profiles.length - discoveredNames.size,
	});

	return profiles;
}

// ---------------------------------------------------------------------------
// Internal: load from vault directory
// ---------------------------------------------------------------------------

/**
 * Load a single sub-agent profile from a subdirectory.
 *
 * Returns null if the directory does not contain a `system-prompt.md`
 * file or if parsing fails.
 */
async function loadProfileFromDirectory(
	vault: Vault,
	metadataCache: MetadataCache,
	subdir: TFolder,
	knownToolNames?: string[],
	parseYAML?: (yaml: string) => unknown,
	templateRegistry?: TemplateVariableRegistry,
): Promise<SubAgentProfile | null> {
	const promptPath = `${subdir.path}/${SYSTEM_PROMPT_FILENAME}`;
	const promptFile = vault.getAbstractFileByPath(promptPath);

	if (!promptFile || !isFile(promptFile)) {
		return null;
	}

	try {
		return await parseProfile(vault, metadataCache, subdir, promptFile, knownToolNames, parseYAML, templateRegistry);
	} catch (e) {
		log.warn("Failed to parse sub-agent profile, skipping", {
			directory: subdir.path,
			error: String(e),
		});
		return null;
	}
}

/**
 * Parse a sub-agent profile from its directory and system-prompt.md file.
 */
async function parseProfile(
	vault: Vault,
	metadataCache: MetadataCache,
	subdir: TFolder,
	promptFile: TFile,
	knownToolNames?: string[],
	parseYAML?: (yaml: string) => unknown,
	templateRegistry?: TemplateVariableRegistry,
): Promise<SubAgentProfile | null> {
	const name = subdir.name;
	const directoryPath = subdir.path.endsWith("/") ? subdir.path : `${subdir.path}/`;

	const rawContent = await vault.cachedRead(promptFile);

	// Get frontmatter from metadata cache
	const fileCache = metadataCache.getFileCache(promptFile);
	let frontmatter = fileCache?.frontmatter;

	// If the metadata cache hasn't indexed the file yet (common during early
	// plugin load), attempt manual YAML parsing before assuming malformed.
	if (!frontmatter && rawContent.trimStart().startsWith("---") && parseYAML) {
		const afterOpener = rawContent.indexOf("\n", rawContent.indexOf("---"));
		if (afterOpener !== -1) {
			const closerIdx = rawContent.indexOf("\n---", afterOpener);
			if (closerIdx !== -1) {
				const yamlBody = rawContent.substring(afterOpener + 1, closerIdx);
				try {
					const parsed = parseYAML(yamlBody);
					if (parsed && typeof parsed === "object") {
						frontmatter = parsed as Record<string, unknown>;
					} else {
						// Empty or non-object frontmatter (e.g., `---\n---`)
						// Treat as no frontmatter — not malformed, just empty
						frontmatter = undefined;
					}
				} catch {
					log.warn(
						"Sub-agent profile has malformed YAML frontmatter, excluding from discovery",
						{ name, path: promptFile.path },
					);
					return null;
				}
			}
		}
	}

	// Parse frontmatter properties
	const description = parseStringOrNull(frontmatter?.["notor-description"]);
	const preferredProvider = parseStringOrNull(frontmatter?.["notor-preferred-provider"]);
	const preferredModel = parseStringOrNull(frontmatter?.["notor-preferred-model"]);

	// Strip frontmatter from content, then resolve template variables
	const strippedBody = stripFrontmatter(rawContent);
	const contentAfterFrontmatter = templateRegistry ? templateRegistry.resolve(strippedBody) : strippedBody;

	// Extract and strip tool config blocks
	const { strippedContent, configs, errors } = extractToolConfigs(
		contentAfterFrontmatter,
		"subagent",
		promptFile.path,
		knownToolNames,
		parseYAML,
	);

	// Log validation errors as warnings
	for (const error of errors) {
		log.warn("Tool config validation error in sub-agent profile", {
			name,
			sourceFile: error.sourceFile,
			detail: error.detail,
		});
	}

	const isBuiltin = BUILTIN_SUBAGENT_PROFILES.has(name);

	return {
		name,
		directory_path: directoryPath,
		system_prompt_path: promptFile.path,
		prompt_content: strippedContent.trim(),
		description,
		preferred_provider: preferredProvider,
		preferred_model: preferredModel,
		tool_configs: configs,
		is_builtin: isBuiltin,
	};
}

// ---------------------------------------------------------------------------
// Internal: build from built-in constant
// ---------------------------------------------------------------------------

/**
 * Build a SubAgentProfile from a built-in constant (no vault file exists).
 *
 * The profile gets synthetic paths pointing to where the vault file would
 * be created if the user clicks "Open" in settings.
 */
function buildProfileFromBuiltin(
	name: string,
	systemPromptContent: string,
	rootPath: string,
	knownToolNames?: string[],
	parseYAML?: (yaml: string) => unknown,
	templateRegistry?: TemplateVariableRegistry,
): SubAgentProfile {
	const directoryPath = `${rootPath}/${name}/`;
	const systemPromptPath = `${rootPath}/${name}/${SYSTEM_PROMPT_FILENAME}`;

	const strippedBody = stripFrontmatter(systemPromptContent);
	const contentAfterFrontmatter = templateRegistry ? templateRegistry.resolve(strippedBody) : strippedBody;

	const { strippedContent, configs } = extractToolConfigs(
		contentAfterFrontmatter,
		"subagent",
		systemPromptPath,
		knownToolNames,
		parseYAML,
	);

	// Extract description from the raw content's frontmatter
	const description = extractFrontmatterField(systemPromptContent, "notor-description");

	return {
		name,
		directory_path: directoryPath,
		system_prompt_path: systemPromptPath,
		prompt_content: strippedContent.trim(),
		description,
		preferred_provider: extractFrontmatterField(systemPromptContent, "notor-preferred-provider"),
		preferred_model: extractFrontmatterField(systemPromptContent, "notor-preferred-model"),
		tool_configs: configs,
		is_builtin: true,
	};
}

/**
 * Extract a string field value from YAML frontmatter in raw content.
 *
 * This is a simple regex-based extraction for use with built-in constants
 * where the metadata cache is not available. Only handles simple scalar
 * string values (not arrays or objects).
 */
function extractFrontmatterField(content: string, fieldName: string): string | null {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith("---")) return null;

	const afterOpener = trimmed.indexOf("\n", 3);
	if (afterOpener === -1) return null;

	const closerIdx = trimmed.indexOf("\n---", afterOpener);
	if (closerIdx === -1) return null;

	const frontmatterBody = trimmed.substring(afterOpener + 1, closerIdx);

	// Match `fieldName: value` or `fieldName: "value"`
	const regex = new RegExp(`^${fieldName}:\\s*(.+)$`, "m");
	const match = regex.exec(frontmatterBody);
	if (!match) return null;

	let value = match[1]!.trim();
	// Strip surrounding quotes if present
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		value = value.slice(1, -1);
	}

	return value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a frontmatter value as a string or null.
 * Returns null for undefined, null, or empty string values.
 */
function parseStringOrNull(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
	const str = String(value).trim();
	return str.length > 0 ? str : null;
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/** Strip YAML frontmatter from Markdown content, returning only the body. */
function stripFrontmatter(content: string): string {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith("---")) {
		return content.trim();
	}

	const afterOpener = trimmed.indexOf("\n", 3);
	if (afterOpener === -1) {
		return content.trim();
	}

	const closerIdx = trimmed.indexOf("\n---", afterOpener);
	if (closerIdx === -1) {
		return content.trim();
	}

	const bodyStart = closerIdx + 4; // length of "\n---"
	return trimmed.substring(bodyStart).trim();
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isFolder(file: TAbstractFile): file is TFolder {
	return "children" in file;
}

function isFile(file: TAbstractFile): file is TFile {
	return "stat" in file && !("children" in file);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Get the vault-relative path to the sub-agents root directory.
 */
export function getSubAgentsRootPath(notorDir: string): string {
	return `${notorDir.replace(/\/$/, "")}/sub-agents`;
}
