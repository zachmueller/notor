/**
 * Vault-level rule manager — scans, parses, and evaluates instruction files.
 *
 * Rule files live under `{notor_dir}/rules/` as regular Markdown notes.
 * Each file uses frontmatter trigger properties to control injection:
 *   - `notor-always-include: true`
 *   - `notor-directory-include: <path>`
 *   - `notor-tag-include: <tag>`
 *
 * Multiple triggers on the same file use OR logic.
 * Rules are re-evaluated after each tool call that accesses a note.
 *
 * @see specs/01-mvp/spec.md — FR-23 (vault-level instruction files)
 * @see specs/01-mvp/data-model.md — VaultRule entity
 * @see design/architecture.md — vault-level rule trigger evaluation
 * @see design/ux.md — vault-level instruction files
 */

import type { App, TFile } from "obsidian";
import { TAbstractFile } from "obsidian";
import type { VaultRule } from "../types";
import { resolveIncludeNotes } from "../include-note/resolver";
import { logger } from "../utils/logger";

const log = logger("VaultRuleManager");

/**
 * Manages vault-level instruction files under `{notor_dir}/rules/`.
 *
 * Responsibilities:
 * 1. Scan and cache rule files from the rules directory
 * 2. Re-scan when rule files change
 * 3. Track notes accessed by tools in the current conversation
 * 4. Evaluate which rules apply given the accessed notes
 * 5. Return the combined rule content for system prompt injection
 */
export class VaultRuleManager {
	/** Cached in-memory representation of all parsed rule files. */
	private rules: VaultRule[] = [];

	/** Vault-relative paths of notes accessed by tools in the current conversation. */
	private accessedNotes = new Set<string>();

	/** Whether the rule cache is stale and needs a reload. */
	private dirty = true;

	/** Cleanup handler for the vault event listener. */
	private eventCleanup?: () => void;

	constructor(
		private readonly app: App,
		private notorDir: string
	) {}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Start watching the rules directory for changes.
	 *
	 * Should be called from plugin onload. Registers vault events
	 * so rule files are reloaded when created, modified, or deleted.
	 */
	start(): void {
		const rulesDir = this.getRulesDir();

		const onCreate = (file: TAbstractFile) => {
			if (file.path.startsWith(rulesDir)) {
				log.debug("Rule file created/modified — marking cache dirty", { path: file.path });
				this.dirty = true;
			}
		};

		const onModify = (file: TAbstractFile) => {
			if (file.path.startsWith(rulesDir)) {
				this.dirty = true;
			}
		};

		const onDelete = (file: TAbstractFile) => {
			if (file.path.startsWith(rulesDir)) {
				log.debug("Rule file deleted — marking cache dirty", { path: file.path });
				this.dirty = true;
			}
		};

		this.app.vault.on("create", onCreate);
		this.app.vault.on("modify", onModify);
		this.app.vault.on("delete", onDelete);

		this.eventCleanup = () => {
			this.app.vault.off("create", onCreate);
			this.app.vault.off("modify", onModify);
			this.app.vault.off("delete", onDelete);
		};

		log.info("VaultRuleManager started", { rulesDir });
	}

	/**
	 * Stop watching for changes and release resources.
	 *
	 * Should be called from plugin onunload.
	 */
	stop(): void {
		this.eventCleanup?.();
		this.eventCleanup = undefined;
		log.info("VaultRuleManager stopped");
	}

	// -----------------------------------------------------------------------
	// Configuration
	// -----------------------------------------------------------------------

	/** Update the notor directory (after settings change). */
	setNotorDir(notorDir: string): void {
		if (notorDir !== this.notorDir) {
			this.notorDir = notorDir;
			this.dirty = true;
			log.debug("Notor dir updated — marking cache dirty", { notorDir });
		}
	}

	// -----------------------------------------------------------------------
	// Conversation scoping
	// -----------------------------------------------------------------------

	/**
	 * Clear the accessed notes set for a new conversation.
	 *
	 * Call this when starting a new conversation or switching conversations.
	 */
	clearAccessedNotes(): void {
		this.accessedNotes.clear();
		log.debug("Cleared accessed notes");
	}

	/**
	 * Record that a note was accessed by a tool.
	 *
	 * Called after read_note, write_note, replace_in_note,
	 * update_frontmatter, and manage_tags.
	 * Triggers rule re-evaluation on the next call to getActiveRuleContent.
	 *
	 * @param notePath - Vault-relative path of the accessed note
	 */
	recordNoteAccess(notePath: string): void {
		this.accessedNotes.add(notePath);
		log.debug("Recorded note access", { notePath, total: this.accessedNotes.size });
	}

	/**
	 * Get the set of notes accessed in the current conversation.
	 */
	getAccessedNotes(): Set<string> {
		return new Set(this.accessedNotes);
	}

	// -----------------------------------------------------------------------
	// Rule evaluation
	// -----------------------------------------------------------------------

	/**
	 * Get the combined content of all currently applicable rule files.
	 *
	 * Re-loads rule files from disk if the cache is stale.
	 * Evaluates trigger conditions against accessed notes.
	 *
	 * @returns Combined rule body content to inject into the system prompt,
	 *          or empty string if no rules apply.
	 */
	async getActiveRuleContent(): Promise<string> {
		// Reload rule files if cache is stale
		if (this.dirty) {
			await this.loadRules();
		}

		if (this.rules.length === 0) return "";

		const applicableRules = this.evaluateRules();
		if (applicableRules.length === 0) return "";

		// D-010: Resolve <include_note> tags in each rule's body content.
		// Uses vault_rule context so mode attribute is ignored (always inline).
		// VaultRuleManager already has access to App which provides both
		// vault and metadataCache — no constructor change needed.
		const resolvedContents: string[] = [];
		for (const rule of applicableRules) {
			const trimmed = rule.content.trim();
			if (trimmed.length === 0) continue;

			try {
				const result = await resolveIncludeNotes(
					trimmed,
					this.app.vault,
					this.app.metadataCache,
					rule.file_path,
					"vault_rule"
				);
				resolvedContents.push(result.inlineContent);
			} catch (e) {
				// On resolution failure, use the original content so the rule
				// still applies. Log the error for debugging.
				log.warn("Failed to resolve <include_note> tags in rule", {
					filePath: rule.file_path,
					error: String(e),
				});
				resolvedContents.push(trimmed);
			}
		}

		const content = resolvedContents
			.filter((c) => c.length > 0)
			.join("\n\n---\n\n");

		log.debug("Active rules assembled", {
			totalRules: this.rules.length,
			applicableRules: applicableRules.length,
		});

		return content;
	}

	// -----------------------------------------------------------------------
	// Rule loading
	// -----------------------------------------------------------------------

	/**
	 * Scan `{notor_dir}/rules/` and load all Markdown rule files.
	 *
	 * Parses frontmatter trigger properties and body content.
	 */
	async loadRules(): Promise<void> {
		const rulesDir = this.getRulesDir();
		this.rules = [];

		try {
			const exists = await this.app.vault.adapter.exists(rulesDir);
			if (!exists) {
				log.debug("Rules directory does not exist", { rulesDir });
				this.dirty = false;
				return;
			}

			const listing = await this.app.vault.adapter.list(rulesDir);
			const mdFiles = listing.files.filter((f) => f.endsWith(".md"));

			for (const filePath of mdFiles) {
				const rule = await this.loadRuleFile(filePath);
				if (rule) {
					this.rules.push(rule);
				}
			}

			log.info("Loaded vault rules", {
				rulesDir,
				count: this.rules.length,
			});
		} catch (e) {
			log.error("Failed to load vault rules", { rulesDir, error: String(e) });
		}

		this.dirty = false;
	}

	/**
	 * Load and parse a single rule file.
	 */
	private async loadRuleFile(filePath: string): Promise<VaultRule | null> {
		try {
			const raw = await this.app.vault.adapter.read(filePath);
			const parsed = this.parseFrontmatterAndBody(raw);

			const rule: VaultRule = {
				file_path: filePath,
				content: parsed.body,
				always_include: parsed.frontmatter["notor-always-include"] === true,
				directory_include:
					typeof parsed.frontmatter["notor-directory-include"] === "string"
						? (parsed.frontmatter["notor-directory-include"] as string)
						: null,
				tag_include:
					typeof parsed.frontmatter["notor-tag-include"] === "string"
						? (parsed.frontmatter["notor-tag-include"] as string)
						: null,
			};

			// Skip rule files with no triggers and empty body
			if (!rule.always_include && !rule.directory_include && !rule.tag_include) {
				log.debug("Skipping rule file with no triggers", { filePath });
				return null;
			}

			log.debug("Loaded rule file", {
				filePath,
				alwaysInclude: rule.always_include,
				directoryInclude: rule.directory_include,
				tagInclude: rule.tag_include,
			});

			return rule;
		} catch (e) {
			log.warn("Failed to load rule file", { filePath, error: String(e) });
			return null;
		}
	}

	// -----------------------------------------------------------------------
	// Trigger evaluation
	// -----------------------------------------------------------------------

	/**
	 * Evaluate all cached rules against the accessed notes set.
	 *
	 * Uses OR logic: any matching trigger causes inclusion.
	 */
	private evaluateRules(): VaultRule[] {
		const applicable: VaultRule[] = [];

		for (const rule of this.rules) {
			if (this.ruleMatches(rule)) {
				applicable.push(rule);
			}
		}

		return applicable;
	}

	/**
	 * Check if a single rule's triggers match the current context.
	 */
	private ruleMatches(rule: VaultRule): boolean {
		// Always-include: trivially matches
		if (rule.always_include) return true;

		// Directory trigger: match if any accessed note is under the specified directory
		if (rule.directory_include) {
			const dirPrefix = rule.directory_include.replace(/\/$/, "") + "/";
			for (const notePath of this.accessedNotes) {
				if (notePath.startsWith(dirPrefix) || notePath.startsWith(rule.directory_include)) {
					return true;
				}
			}
		}

		// Tag trigger: match if any accessed note has the specified tag
		if (rule.tag_include) {
			for (const notePath of this.accessedNotes) {
				if (this.noteHasTag(notePath, rule.tag_include)) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Check if a note has a specific tag using the metadata cache.
	 */
	private noteHasTag(notePath: string, tag: string): boolean {
		const file = this.app.vault.getFileByPath(notePath);
		if (!file) return false;

		const cache = this.app.metadataCache.getFileCache(file as TFile);
		if (!cache) return false;

		// Check frontmatter tags
		const frontmatterTags: unknown[] = cache.frontmatter?.["tags"] ?? [];
		const tagsArray = Array.isArray(frontmatterTags) ? frontmatterTags : [frontmatterTags];

		// Normalise the search tag (strip leading #)
		const normalisedSearch = tag.replace(/^#/, "").toLowerCase();

		for (const t of tagsArray) {
			if (typeof t === "string") {
				const normalised = t.replace(/^#/, "").toLowerCase();
				if (normalised === normalisedSearch) return true;
			}
		}

		// Also check inline tags via cache.tags array
		const cacheTags = cache.tags ?? [];
		for (const tagCache of cacheTags) {
			const normalised = tagCache.tag.replace(/^#/, "").toLowerCase();
			if (normalised === normalisedSearch) return true;
		}

		return false;
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Get the vault-relative path to the rules directory.
	 */
	private getRulesDir(): string {
		return `${this.notorDir.replace(/\/$/, "")}/rules`;
	}

	/**
	 * Parse raw Markdown content into frontmatter key-value pairs and body.
	 *
	 * Simple YAML frontmatter parser sufficient for the limited set of
	 * trigger properties used in rule files.
	 */
	private parseFrontmatterAndBody(content: string): {
		frontmatter: Record<string, unknown>;
		body: string;
	} {
		if (!content.startsWith("---")) {
			return { frontmatter: {}, body: content };
		}

		const endIndex = content.indexOf("\n---", 3);
		if (endIndex === -1) {
			return { frontmatter: {}, body: content };
		}

		const yamlText = content.slice(3, endIndex).trim();
		const body = content.slice(endIndex + 4).trim();
		const frontmatter = this.parseSimpleYaml(yamlText);

		return { frontmatter, body };
	}

	/**
	 * Parse a minimal YAML string into key-value pairs.
	 *
	 * Supports:
	 *   - `key: value` (string values)
	 *   - `key: true` / `key: false` (boolean values)
	 *   - `key: 123` (numeric values — preserved as strings for our use)
	 *
	 * Sufficient for the trigger properties used in rule files.
	 */
	private parseSimpleYaml(yaml: string): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		const lines = yaml.split("\n");

		for (const line of lines) {
			const colonIdx = line.indexOf(":");
			if (colonIdx === -1) continue;

			const key = line.slice(0, colonIdx).trim();
			const rawValue = line.slice(colonIdx + 1).trim();

			if (!key) continue;

			// Parse value
			if (rawValue === "true") {
				result[key] = true;
			} else if (rawValue === "false") {
				result[key] = false;
			} else if (rawValue === "null" || rawValue === "") {
				result[key] = null;
			} else {
				// Strip surrounding quotes if present
				result[key] = rawValue.replace(/^["']|["']$/g, "");
			}
		}

		return result;
	}
}