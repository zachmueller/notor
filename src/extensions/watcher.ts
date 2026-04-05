/**
 * Extension file watcher helpers.
 *
 * Provides path matching utilities for detecting changes to extension
 * files in `notor/tools/`, `notor/automations/`, and `notor/settings.md`.
 *
 * @see specs/05-user-tools/tasks.md — EXT-024
 */

import { normalizePath, TFile, type TAbstractFile } from "obsidian";

/**
 * Returns true if the given file is a Markdown note inside the tools
 * subdirectory of the configured notor directory.
 */
export function isExtensionToolFile(file: TAbstractFile, notorDir: string): boolean {
	if (!(file instanceof TFile) || !file.path.endsWith(".md")) return false;
	const toolsDir = normalizePath(`${notorDir}/tools`);
	return file.path.startsWith(toolsDir + "/");
}

/**
 * Returns true if the given file is a Markdown note inside the automations
 * subdirectory of the configured notor directory.
 */
export function isExtensionAutomationFile(file: TAbstractFile, notorDir: string): boolean {
	if (!(file instanceof TFile) || !file.path.endsWith(".md")) return false;
	const automationsDir = normalizePath(`${notorDir}/automations`);
	return file.path.startsWith(automationsDir + "/");
}

/**
 * Returns true if the given file is the shared settings file (`notor/settings.md`).
 */
export function isExtensionSettingsFile(file: TAbstractFile, notorDir: string): boolean {
	if (!(file instanceof TFile)) return false;
	return file.path === normalizePath(`${notorDir}/settings.md`);
}

/**
 * Returns true if the given file is any extension file (tool, automation, or settings).
 */
export function isExtensionFile(file: TAbstractFile, notorDir: string): boolean {
	return (
		isExtensionToolFile(file, notorDir) ||
		isExtensionAutomationFile(file, notorDir) ||
		isExtensionSettingsFile(file, notorDir)
	);
}

/**
 * Returns true if a vault-relative path points to an extension file.
 * Used to check the old path in rename events.
 */
export function isExtensionPath(filePath: string, notorDir: string): boolean {
	const toolsDir = normalizePath(`${notorDir}/tools`);
	const automationsDir = normalizePath(`${notorDir}/automations`);
	const settingsPath = normalizePath(`${notorDir}/settings.md`);
	return (
		(filePath.endsWith(".md") && filePath.startsWith(toolsDir + "/")) ||
		(filePath.endsWith(".md") && filePath.startsWith(automationsDir + "/")) ||
		filePath === settingsPath
	);
}
