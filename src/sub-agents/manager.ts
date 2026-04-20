/**
 * Sub-agent profile manager — coordinates profile discovery, visibility
 * state, and vault file management for built-in profiles.
 *
 * Follows the PersonaManager pattern but is simpler: no "active" state,
 * no provider/model switching (that happens at sub-agent execution time).
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 7
 */

import { normalizePath } from "obsidian";
import type { Vault, MetadataCache } from "obsidian";
import type { SubAgentProfile } from "./types";
import type { NotorSettings } from "../settings/types";
import { discoverSubAgentProfiles, getSubAgentsRootPath } from "./discovery";
import { BUILTIN_SUBAGENT_PROFILES } from "./builtin-profiles";
import { logger } from "../utils/logger";
import type { TemplateVariableRegistry } from "../template-vars";

const log = logger("SubAgentManager");

/** Name of the system prompt file inside each profile directory. */
const SYSTEM_PROMPT_FILENAME = "system-prompt.md";

/**
 * Manages sub-agent profile discovery, visibility state, and vault file
 * operations for built-in profiles.
 */
export class SubAgentManager {
	constructor(
		private readonly vault: Vault,
		private readonly metadataCache: MetadataCache,
		private settings: NotorSettings,
		private readonly saveData: () => Promise<void>,
		private readonly parseYAML?: (yaml: string) => unknown,
		private readonly templateRegistry?: TemplateVariableRegistry,
	) {}

	// -----------------------------------------------------------------------
	// Discovery
	// -----------------------------------------------------------------------

	/**
	 * Discover all sub-agent profiles (built-in + user-created).
	 *
	 * Stateless — re-scans the directory each time. Callers (settings UI,
	 * `use_subagent` tool) invoke this when they need a fresh list.
	 *
	 * @param knownToolNames - Registered tool names for tool config validation
	 */
	async discoverProfiles(knownToolNames?: string[]): Promise<SubAgentProfile[]> {
		return discoverSubAgentProfiles(
			this.vault,
			this.metadataCache,
			this.settings.notor_dir,
			knownToolNames,
			this.parseYAML,
			this.templateRegistry,
		);
	}

	/**
	 * Discover and filter to only visible profiles (per settings toggle).
	 *
	 * Profiles not present in `sub_agent_visibility` default to visible.
	 *
	 * @param knownToolNames - Registered tool names for tool config validation
	 */
	async getVisibleProfiles(knownToolNames?: string[]): Promise<SubAgentProfile[]> {
		const all = await this.discoverProfiles(knownToolNames);
		return all.filter((p) => this.isVisible(p.name));
	}

	/**
	 * Get a single profile by name, or null if not found.
	 *
	 * @param name - Profile name (e.g., `"search-vault"`)
	 * @param knownToolNames - Registered tool names for tool config validation
	 */
	async getProfile(name: string, knownToolNames?: string[]): Promise<SubAgentProfile | null> {
		const all = await this.discoverProfiles(knownToolNames);
		return all.find((p) => p.name === name) ?? null;
	}

	// -----------------------------------------------------------------------
	// Visibility
	// -----------------------------------------------------------------------

	/**
	 * Check if a profile is visible (available to the LLM).
	 *
	 * Profiles not present in `sub_agent_visibility` default to visible.
	 */
	isVisible(name: string): boolean {
		return this.settings.sub_agent_visibility[name] !== false;
	}

	/**
	 * Set the visibility of a profile and persist the change.
	 */
	async setVisibility(name: string, visible: boolean): Promise<void> {
		this.settings.sub_agent_visibility[name] = visible;
		await this.saveData();
		log.info("Sub-agent visibility changed", { name, visible });
	}

	// -----------------------------------------------------------------------
	// Built-in vault file management
	// -----------------------------------------------------------------------

	/**
	 * Ensure a built-in profile has a vault file. Creates the directory
	 * and `system-prompt.md` from the built-in constant if they don't exist.
	 *
	 * Called on first "Open" click in Settings (Section 7.3).
	 *
	 * @param name - Built-in profile name (e.g., `"search-vault"`)
	 * @returns Vault-relative path to the created/existing system-prompt.md
	 * @throws Error if the name is not a built-in profile
	 */
	async ensureBuiltinVaultFile(name: string): Promise<string> {
		const builtin = BUILTIN_SUBAGENT_PROFILES.get(name);
		if (!builtin) {
			throw new Error(`"${name}" is not a built-in sub-agent profile.`);
		}

		const rootPath = getSubAgentsRootPath(this.settings.notor_dir);
		const dirPath = normalizePath(`${rootPath}/${name}`);
		const filePath = normalizePath(`${dirPath}/${SYSTEM_PROMPT_FILENAME}`);

		// If file already exists, return its path
		if (this.vault.getAbstractFileByPath(filePath)) {
			return filePath;
		}

		// Create directory tree
		await this.ensureDirectory(dirPath);

		// Create the file from the built-in constant
		await this.vault.create(filePath, builtin.systemPromptContent);
		log.info("Created vault file for built-in sub-agent profile", { name, path: filePath });

		return filePath;
	}

	/**
	 * Reset a built-in profile's vault file to the default content.
	 *
	 * Overwrites the existing vault file with the built-in constant.
	 * If the vault file doesn't exist, creates it.
	 *
	 * @param name - Built-in profile name
	 * @throws Error if the name is not a built-in profile
	 */
	async resetToDefault(name: string): Promise<void> {
		const builtin = BUILTIN_SUBAGENT_PROFILES.get(name);
		if (!builtin) {
			throw new Error(`"${name}" is not a built-in sub-agent profile.`);
		}

		const rootPath = getSubAgentsRootPath(this.settings.notor_dir);
		const dirPath = normalizePath(`${rootPath}/${name}`);
		const filePath = normalizePath(`${dirPath}/${SYSTEM_PROMPT_FILENAME}`);

		const existing = this.vault.getAbstractFileByPath(filePath);
		if (existing) {
			await this.vault.modify(existing as import("obsidian").TFile, builtin.systemPromptContent);
			log.info("Reset built-in sub-agent profile to default", { name, path: filePath });
		} else {
			await this.ensureDirectory(dirPath);
			await this.vault.create(filePath, builtin.systemPromptContent);
			log.info("Created vault file for built-in sub-agent profile (reset)", { name, path: filePath });
		}
	}

	// -----------------------------------------------------------------------
	// Settings reference update
	// -----------------------------------------------------------------------

	/**
	 * Update the settings reference (called when settings change externally).
	 */
	updateSettings(settings: NotorSettings): void {
		this.settings = settings;
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	/**
	 * Ensure a directory path exists, creating intermediate directories
	 * as needed.
	 */
	private async ensureDirectory(dirPath: string): Promise<void> {
		const parts = dirPath.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const normalized = normalizePath(current);
			if (!this.vault.getAbstractFileByPath(normalized)) {
				await this.vault.createFolder(normalized);
			}
		}
	}
}
