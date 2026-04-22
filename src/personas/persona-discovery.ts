/**
 * Persona discovery service — scans `{notor_dir}/personas/` for
 * subdirectories containing a `system-prompt.md` file, parses
 * frontmatter properties, and returns fully populated Persona objects.
 *
 * Discovery is stateless — each call re-scans the directory.
 * Callers (PersonaManager, settings tab, persona picker) trigger
 * discovery when they need a fresh list.
 *
 * @see specs/03-workflows-personas/data-model.md — Persona entity
 * @see specs/03-workflows-personas/spec.md — FR-37 (persona directory structure)
 * @see specs/03-workflows-personas/spec.md — FR-38 (persona frontmatter)
 */

import type { MetadataCache, TFile, TFolder, Vault } from "obsidian";
import { TAbstractFile } from "obsidian";
import type { Persona, PersonaPromptMode } from "../types";
import { BUILTIN_PERSONA_PROFILES } from "./builtin-personas";
import { logger } from "../utils/logger";
import type { TemplateVariableRegistry } from "../template-vars";

const log = logger("PersonaDiscovery");

/** Name of the required system prompt file inside each persona directory. */
const SYSTEM_PROMPT_FILENAME = "system-prompt.md";

/**
 * Scan `{notorDir}/personas/` for valid persona directories and return
 * fully populated `Persona` objects.
 *
 * A valid persona directory is a subdirectory that contains a
 * `system-prompt.md` file. Subdirectories without the file are silently
 * ignored. If the personas root directory does not exist, an empty array
 * is returned without error.
 *
 * @param vault - Obsidian Vault instance
 * @param metadataCache - Obsidian MetadataCache for frontmatter access
 * @param notorDir - Vault-relative path to the Notor directory (e.g. `"notor/"`)
 * @param templateRegistry - Optional registry for template variable resolution
 * @returns Array of discovered and parsed Persona objects
 */
export async function discoverPersonas(
	vault: Vault,
	metadataCache: MetadataCache,
	notorDir: string,
	templateRegistry?: TemplateVariableRegistry,
): Promise<Persona[]> {
	const personasRootPath = getPersonasRootPath(notorDir);
	const personasRoot = vault.getAbstractFileByPath(personasRootPath);

	const personas: Persona[] = [];

	if (!personasRoot) {
		log.debug("Personas directory does not exist", { path: personasRootPath });
	} else if (!isFolder(personasRoot)) {
		log.warn("Personas path exists but is not a directory", { path: personasRootPath });
	} else {
		for (const child of personasRoot.children) {
			if (!isFolder(child)) continue;

			const persona = await loadPersonaFromDirectory(vault, metadataCache, child, templateRegistry);
			if (persona) {
				personas.push(persona);
			}
		}
	}

	// Add built-in personas that don't have vault files
	const discoveredNames = new Set(personas.map((p) => p.name));
	for (const [name, builtin] of BUILTIN_PERSONA_PROFILES) {
		if (discoveredNames.has(name)) continue;

		const persona = buildPersonaFromBuiltin(name, builtin.systemPromptContent, personasRootPath, templateRegistry);
		personas.push(persona);
	}

	log.info("Persona discovery complete", {
		personasDir: personasRootPath,
		found: personas.length,
		fromVault: discoveredNames.size,
		fromBuiltin: personas.length - discoveredNames.size,
	});

	return personas;
}

/**
 * Load a single persona from a subdirectory under the personas root.
 *
 * Returns null if the directory does not contain a `system-prompt.md`
 * file or if parsing fails.
 */
async function loadPersonaFromDirectory(
	vault: Vault,
	metadataCache: MetadataCache,
	subdir: TFolder,
	templateRegistry?: TemplateVariableRegistry,
): Promise<Persona | null> {
	const promptPath = `${subdir.path}/${SYSTEM_PROMPT_FILENAME}`;
	const promptFile = vault.getAbstractFileByPath(promptPath);

	if (!promptFile || !isFile(promptFile)) {
		// Silently ignore — subdirectory without system-prompt.md
		return null;
	}

	const tFile = promptFile;

	try {
		return await parsePersona(vault, metadataCache, subdir, tFile, templateRegistry);
	} catch (e) {
		log.warn("Failed to parse persona, skipping", {
			directory: subdir.path,
			error: String(e),
		});
		return null;
	}
}

/**
 * Parse a persona from its directory and system-prompt.md file.
 *
 * Reads frontmatter via `metadataCache.getFileCache()?.frontmatter`
 * for structured properties, and reads the file body for prompt content.
 *
 * @returns Fully populated Persona object, or null if frontmatter is
 *          malformed (logged as warning).
 */
async function parsePersona(
	vault: Vault,
	metadataCache: MetadataCache,
	subdir: TFolder,
	promptFile: TFile,
	templateRegistry?: TemplateVariableRegistry,
): Promise<Persona | null> {
	const name = subdir.name;
	const directoryPath = subdir.path.endsWith("/") ? subdir.path : `${subdir.path}/`;

	// Read raw file content for body extraction
	const rawContent = await vault.cachedRead(promptFile);

	// Get frontmatter from metadata cache
	const fileCache = metadataCache.getFileCache(promptFile);
	const frontmatter = fileCache?.frontmatter;

	// If metadata cache has no entry but we could read the file, the file
	// may have malformed YAML. Check by trying to strip frontmatter manually.
	// If the raw content starts with `---` but the cache has no frontmatter,
	// this likely indicates malformed YAML.
	if (!frontmatter && rawContent.trimStart().startsWith("---")) {
		// Check if the frontmatter block is properly closed
		const afterOpener = rawContent.indexOf("\n", rawContent.indexOf("---"));
		if (afterOpener !== -1) {
			const closerIdx = rawContent.indexOf("\n---", afterOpener);
			if (closerIdx !== -1) {
				// Frontmatter block exists but cache returned nothing — likely malformed YAML
				log.warn(
					"Persona has malformed YAML frontmatter, excluding from discovery",
					{ name, path: promptFile.path }
				);
				return null;
			}
		}
	}

	// Parse frontmatter properties
	const promptMode = parsePromptMode(frontmatter, name);
	const preferredProvider = parseStringOrNull(frontmatter?.["notor-preferred-provider"]);
	const preferredModel = parseStringOrNull(frontmatter?.["notor-preferred-model"]);
	const preferredPreset = parseStringOrNull(frontmatter?.["notor-preferred-preset"]);
	const chipColor = parseStringOrNull(frontmatter?.["notor-persona-chip-color"]);
	const chipEmoji = parseStringOrNull(frontmatter?.["notor-persona-chip-emoji"]);

	// Extract body content (after frontmatter), then resolve template variables
	const strippedContent = stripFrontmatter(rawContent);
	const promptContent = templateRegistry ? templateRegistry.resolve(strippedContent) : strippedContent;

	return {
		name,
		directory_path: directoryPath,
		system_prompt_path: promptFile.path,
		prompt_content: promptContent,
		prompt_mode: promptMode,
		preferred_provider: preferredProvider,
		preferred_model: preferredModel,
		preferred_preset: preferredPreset,
		chip_color: chipColor,
		chip_emoji: chipEmoji,
	};
}

// ---------------------------------------------------------------------------
// Frontmatter parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse `notor-persona-prompt-mode` from frontmatter.
 *
 * Accepts `"append"` or `"replace"`; defaults to `"append"` for
 * missing or unrecognized values. Logs a warning for unrecognized values.
 */
function parsePromptMode(
	frontmatter: Record<string, unknown> | undefined,
	personaName: string
): PersonaPromptMode {
	if (!frontmatter) return "append";

	const raw = frontmatter["notor-persona-prompt-mode"];
	if (typeof raw !== "string" || raw.trim() === "") return "append";

	const value = raw.trim().toLowerCase();
	if (value === "append" || value === "replace") {
		return value;
	}

	log.warn("Unrecognized persona prompt mode, defaulting to 'append'", {
		persona: personaName,
		value: raw,
	});
	return "append";
}

/**
 * Parse a frontmatter value as a string or null.
 *
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

/**
 * Strip YAML frontmatter from Markdown content, returning only the body.
 */
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

	// Skip past the closing `---` and any trailing newline
	const bodyStart = closerIdx + 4; // length of "\n---"
	return trimmed.substring(bodyStart).trim();
}

// ---------------------------------------------------------------------------
// Internal: build from built-in constant
// ---------------------------------------------------------------------------

/**
 * Build a Persona from a built-in constant (no vault file exists).
 *
 * The persona gets synthetic paths pointing to where the vault file would
 * be created if the user clicks "Open" in settings.
 */
function buildPersonaFromBuiltin(
	name: string,
	systemPromptContent: string,
	rootPath: string,
	templateRegistry?: TemplateVariableRegistry,
): Persona {
	const directoryPath = `${rootPath}/${name}/`;
	const systemPromptPath = `${rootPath}/${name}/${SYSTEM_PROMPT_FILENAME}`;

	const strippedBody = stripFrontmatter(systemPromptContent);
	const promptContent = templateRegistry ? templateRegistry.resolve(strippedBody) : strippedBody;

	return {
		name,
		directory_path: directoryPath,
		system_prompt_path: systemPromptPath,
		prompt_content: promptContent,
		prompt_mode: extractPromptMode(systemPromptContent),
		preferred_provider: extractFrontmatterField(systemPromptContent, "notor-preferred-provider"),
		preferred_model: extractFrontmatterField(systemPromptContent, "notor-preferred-model"),
		preferred_preset: extractFrontmatterField(systemPromptContent, "notor-preferred-preset"),
		chip_color: extractFrontmatterField(systemPromptContent, "notor-persona-chip-color"),
		chip_emoji: extractFrontmatterField(systemPromptContent, "notor-persona-chip-emoji"),
	};
}

/**
 * Extract a string field value from YAML frontmatter in raw content.
 *
 * Simple regex-based extraction for use with built-in constants
 * where the metadata cache is not available.
 */
function extractFrontmatterField(content: string, fieldName: string): string | null {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith("---")) return null;

	const afterOpener = trimmed.indexOf("\n", 3);
	if (afterOpener === -1) return null;

	const closerIdx = trimmed.indexOf("\n---", afterOpener);
	if (closerIdx === -1) return null;

	const frontmatterBody = trimmed.substring(afterOpener + 1, closerIdx);

	const regex = new RegExp(`^${fieldName}:\\s*(.+)$`, "m");
	const match = regex.exec(frontmatterBody);
	if (!match) return null;

	let value = match[1]!.trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		value = value.slice(1, -1);
	}

	return value.length > 0 ? value : null;
}

/**
 * Extract prompt mode from built-in constant frontmatter.
 */
function extractPromptMode(content: string): PersonaPromptMode {
	const raw = extractFrontmatterField(content, "notor-persona-prompt-mode");
	if (raw === "append" || raw === "replace") return raw;
	return "append";
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

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Get the vault-relative path to the personas root directory.
 */
export function getPersonasRootPath(notorDir: string): string {
	return `${notorDir.replace(/\/$/, "")}/personas`;
}
