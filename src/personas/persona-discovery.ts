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
import { logger } from "../utils/logger";

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
 * @returns Array of discovered and parsed Persona objects
 */
export async function discoverPersonas(
	vault: Vault,
	metadataCache: MetadataCache,
	notorDir: string
): Promise<Persona[]> {
	const personasRootPath = getPersonasRootPath(notorDir);
	const personasRoot = vault.getAbstractFileByPath(personasRootPath);

	if (!personasRoot) {
		log.debug("Personas directory does not exist", { path: personasRootPath });
		return [];
	}

	// Verify it's a folder
	if (!isFolder(personasRoot)) {
		log.warn("Personas path exists but is not a directory", { path: personasRootPath });
		return [];
	}

	const personas: Persona[] = [];
	const folder = personasRoot as TFolder;

	for (const child of folder.children) {
		if (!isFolder(child)) continue;

		const subdir = child as TFolder;
		const persona = await loadPersonaFromDirectory(vault, metadataCache, subdir);
		if (persona) {
			personas.push(persona);
		}
	}

	log.info("Persona discovery complete", {
		personasDir: personasRootPath,
		found: personas.length,
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
	subdir: TFolder
): Promise<Persona | null> {
	const promptPath = `${subdir.path}/${SYSTEM_PROMPT_FILENAME}`;
	const promptFile = vault.getAbstractFileByPath(promptPath);

	if (!promptFile || !isFile(promptFile)) {
		// Silently ignore — subdirectory without system-prompt.md
		return null;
	}

	const tFile = promptFile as TFile;

	try {
		return await parsePersona(vault, metadataCache, subdir, tFile);
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
	promptFile: TFile
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

	// Extract body content (after frontmatter)
	const promptContent = stripFrontmatter(rawContent);

	return {
		name,
		directory_path: directoryPath,
		system_prompt_path: promptFile.path,
		prompt_content: promptContent,
		prompt_mode: promptMode,
		preferred_provider: preferredProvider,
		preferred_model: preferredModel,
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
	if (raw === undefined || raw === null || raw === "") return "append";

	const value = String(raw).trim().toLowerCase();
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
function getPersonasRootPath(notorDir: string): string {
	return `${notorDir.replace(/\/$/, "")}/personas`;
}
