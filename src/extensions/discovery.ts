/**
 * Extension file discovery.
 *
 * Scans `notor/tools/`, `notor/automations/`, and `notor/settings.md`
 * for user-defined extension files and parses them into typed definitions.
 *
 * Follows patterns from `src/sub-agents/discovery.ts` (async, vault API)
 * and `src/workflows/workflow-discovery.ts` (normalize notorDir, collect .md files).
 */

import type { MetadataCache, TFile, TFolder, Vault } from "obsidian";
import { TAbstractFile } from "obsidian";
import type {
	ExtensionError,
	SharedSettingsDefinition,
	UserAutomationDefinition,
	UserBlockDefinition,
	UserToolDefinition,
} from "./types";
import { parseExtensionFile, type ParseResult } from "./parser";
import { logger } from "../utils/logger";

const log = logger("ExtensionDiscovery");

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
// Public API
// ---------------------------------------------------------------------------

/** Result of extension discovery across all directories. */
export interface DiscoveryResult {
	tools: UserToolDefinition[];
	automations: UserAutomationDefinition[];
	blocks: UserBlockDefinition[];
	sharedSettings: SharedSettingsDefinition | null;
	errors: ExtensionError[];
}

/**
 * Scan `notor/tools/`, `notor/automations/`, and `notor/settings.md` for
 * extension files, parse them, and return typed definitions.
 *
 * Missing directories are handled gracefully (empty results, no error).
 * Malformed files are logged, added to errors, and skipped.
 *
 * @param vault - Obsidian Vault instance
 * @param metadataCache - Obsidian MetadataCache for frontmatter access
 * @param notorDir - Vault-relative path to the Notor directory (e.g. `"notor/"`)
 * @param parseYAML - YAML parser function (Obsidian's `parseYaml`)
 */
export async function discoverExtensions(
	vault: Vault,
	metadataCache: MetadataCache,
	notorDir: string,
	parseYAML: (yaml: string) => unknown,
): Promise<DiscoveryResult> {
	const baseDir = notorDir.replace(/\/$/, "");
	const tools: UserToolDefinition[] = [];
	const automations: UserAutomationDefinition[] = [];
	const blocks: UserBlockDefinition[] = [];
	const errors: ExtensionError[] = [];
	let sharedSettings: SharedSettingsDefinition | null = null;

	// -- Scan tools directory --
	const toolsDir = `${baseDir}/tools`;
	const toolFiles = collectMarkdownFiles(vault, toolsDir);
	for (const file of toolFiles) {
		const result = await parseOneExtensionFile(vault, metadataCache, file, parseYAML);
		if ("message" in result) {
			log.warn("Extension parse error, skipping file", { file: file.path, error: result.message });
			errors.push(result);
		} else if ("name" in result && "mode" in result) {
			// UserToolDefinition
			tools.push(result as UserToolDefinition);
		} else {
			// Unexpected type from tools/ dir — skip with warning
			log.warn("File in tools/ directory is not a tool extension, skipping", { file: file.path });
			errors.push({ filePath: file.path, message: "File in tools/ directory has notor-type other than 'tool'" });
		}
	}

	// -- Scan automations directory --
	const automationsDir = `${baseDir}/automations`;
	const automationFiles = collectMarkdownFiles(vault, automationsDir);
	for (const file of automationFiles) {
		const result = await parseOneExtensionFile(vault, metadataCache, file, parseYAML);
		if ("message" in result) {
			log.warn("Extension parse error, skipping file", { file: file.path, error: result.message });
			errors.push(result);
		} else if ("trigger" in result) {
			// UserAutomationDefinition
			automations.push(result as UserAutomationDefinition);
		} else {
			log.warn("File in automations/ directory is not an automation extension, skipping", { file: file.path });
			errors.push({ filePath: file.path, message: "File in automations/ directory has notor-type other than 'automation'" });
		}
	}

	// -- Scan blocks directory --
	const blocksDir = `${baseDir}/blocks`;
	const blockFiles = collectMarkdownFiles(vault, blocksDir);
	for (const file of blockFiles) {
		const result = await parseOneExtensionFile(vault, metadataCache, file, parseYAML);
		if ("message" in result) {
			log.warn("Extension parse error, skipping file", { file: file.path, error: result.message });
			errors.push(result);
		} else if ("kind" in result && "rendererExport" in result) {
			// UserBlockDefinition
			blocks.push(result as UserBlockDefinition);
		} else {
			log.warn("File in blocks/ directory is not a block extension, skipping", { file: file.path });
			errors.push({ filePath: file.path, message: "File in blocks/ directory has notor-type other than 'block'" });
		}
	}

	// -- Check for shared settings file --
	const settingsPath = `${baseDir}/settings.md`;
	const settingsFile = vault.getAbstractFileByPath(settingsPath);
	if (settingsFile && isFile(settingsFile)) {
		const result = await parseOneExtensionFile(vault, metadataCache, settingsFile, parseYAML);
		if ("message" in result) {
			log.warn("Shared settings file parse error", { file: settingsFile.path, error: result.message });
			errors.push(result);
		} else if ("settingsSchema" in result && !("name" in result) && !("trigger" in result)) {
			// SharedSettingsDefinition
			sharedSettings = result as SharedSettingsDefinition;
		} else {
			log.warn("settings.md has unexpected notor-type, expected 'settings'", { file: settingsFile.path });
			errors.push({ filePath: settingsFile.path, message: "settings.md has notor-type other than 'settings'" });
		}
	}

	// -- Sort automations by order (ascending), then alphabetically by filename for ties --
	automations.sort((a, b) => {
		if (a.order !== b.order) return a.order - b.order;
		// Extract filename from filePath for alphabetical tiebreaker
		const aName = a.filePath.split("/").pop() ?? a.filePath;
		const bName = b.filePath.split("/").pop() ?? b.filePath;
		return aName.localeCompare(bName);
	});

	log.info("Extension discovery complete", {
		extensionsDir: baseDir,
		tools: tools.length,
		automations: automations.length,
		blocks: blocks.length,
		hasSharedSettings: sharedSettings !== null,
		errors: errors.length,
	});

	return { tools, automations, blocks, sharedSettings, errors };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect all `.md` files from a vault directory (non-recursive — extensions
 * are flat in `tools/` and `automations/`).
 *
 * Returns an empty array if the directory does not exist.
 */
function collectMarkdownFiles(vault: Vault, dirPath: string): TFile[] {
	const dir = vault.getAbstractFileByPath(dirPath);
	if (!dir) return [];
	if (!isFolder(dir)) {
		log.warn("Extension path exists but is not a directory", { path: dirPath });
		return [];
	}

	const files: TFile[] = [];
	for (const child of dir.children) {
		if (isFile(child) && child.name.endsWith(".md")) {
			files.push(child);
		}
	}
	return files;
}

/**
 * Extract frontmatter from raw markdown content via manual YAML parsing.
 *
 * Looks for a `---` opener at the start of the content and a matching `\n---`
 * closer. Returns the parsed object, or `null` if the content has no valid
 * YAML frontmatter block.
 *
 * @throws If the YAML body exists but fails to parse.
 */
export function extractFrontmatter(
	content: string,
	parseYAML: (yaml: string) => unknown,
): Record<string, unknown> | null {
	if (!content.trimStart().startsWith("---")) return null;

	const afterOpener = content.indexOf("\n", content.indexOf("---"));
	if (afterOpener === -1) return null;

	const closerIdx = content.indexOf("\n---", afterOpener);
	if (closerIdx === -1) return null;

	const yamlBody = content.substring(afterOpener + 1, closerIdx);
	const parsed = parseYAML(yamlBody);
	if (parsed && typeof parsed === "object") {
		return parsed as Record<string, unknown>;
	}
	return null;
}

/**
 * Read and parse a single extension file.
 *
 * Gets frontmatter from metadata cache (falls back to manual YAML parsing
 * if the cache hasn't indexed the file yet — common during early plugin load).
 */
async function parseOneExtensionFile(
	vault: Vault,
	metadataCache: MetadataCache,
	file: TFile,
	parseYAML: (yaml: string) => unknown,
): Promise<ParseResult> {
	const content = await vault.cachedRead(file);

	// Get frontmatter from metadata cache
	const fileCache = metadataCache.getFileCache(file);
	let frontmatter = fileCache?.frontmatter as Record<string, unknown> | undefined;

	// If the metadata cache hasn't indexed the file yet, attempt manual YAML parsing
	if (!frontmatter) {
		try {
			frontmatter = extractFrontmatter(content, parseYAML) ?? undefined;
		} catch {
			return { filePath: file.path, message: "Failed to parse YAML frontmatter" };
		}
	}

	if (!frontmatter) {
		return { filePath: file.path, message: "No frontmatter found" };
	}

	return parseExtensionFile(content, frontmatter, file.path, parseYAML);
}
