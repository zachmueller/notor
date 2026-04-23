/**
 * Persona file watcher helpers.
 *
 * Provides path-matching utilities for detecting changes to persona
 * files under `notor/personas/`.
 */

import { normalizePath, TFile, type TAbstractFile } from "obsidian";

/**
 * Returns true if the given file is a Markdown note inside the personas
 * subdirectory of the configured notor directory.
 */
export function isPersonaFile(file: TAbstractFile, notorDir: string): boolean {
	if (!(file instanceof TFile) || !file.path.endsWith(".md")) return false;
	const personasDir = normalizePath(`${notorDir}/personas`);
	return file.path.startsWith(personasDir + "/");
}

/**
 * Returns true if a vault-relative path points to a persona file.
 * Used to check the old path in rename events.
 */
export function isPersonaPath(filePath: string, notorDir: string): boolean {
	const personasDir = normalizePath(`${notorDir}/personas`);
	return filePath.endsWith(".md") && filePath.startsWith(personasDir + "/");
}
