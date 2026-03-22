/**
 * System prompt assembly.
 *
 * Builds the system prompt from the built-in default, user customization
 * file, and vault-level rules. Tool definitions are generated from the
 * tool registry.
 *
 * @see specs/01-mvp/spec.md — FR-6 (system prompt configuration)
 * @see design/research/system-prompt-design.md — prompt structure, sections
 * @see design/architecture.md — system prompt assembly
 */

import type { MetadataCache, Vault } from "obsidian";
import { parseYaml } from "obsidian";
import type { ConversationMode, Persona, VaultRule } from "../types";
import type { ToolDefinition } from "../providers/provider";
import type { ParsedToolConfig } from "../tool-config/types";
import { extractToolConfigs } from "../tool-config/parser";
import { estimateTokenCount } from "../utils/tokens";
import { DEFAULT_SYSTEM_PROMPT } from "./default-system-prompt";
import { resolveIncludeNotes } from "../include-note/resolver";
import { logger } from "../utils/logger";

const log = logger("SystemPromptBuilder");

/** Hard ceiling for total system prompt tokens. */
const MAX_SYSTEM_PROMPT_TOKENS = 8000;

/**
 * Result of the extraction phase (phase 1 of the two-phase builder).
 *
 * Contains tool configs extracted from persona and rule sources.
 * Stripped content is cached internally on the builder instance.
 *
 * @see specs/04b-tool-toggle/tasks.md — SYS-001
 */
export interface ExtractedToolConfigResult {
	personaToolConfigs: ParsedToolConfig[];
	ruleToolConfigs: ParsedToolConfig[];
}

/**
 * Builds and assembles the complete system prompt for LLM calls.
 */
export class SystemPromptBuilder {
	/**
	 * Cached stripped persona content from `extractSourceToolConfigs()`.
	 * Used by `assemble()` so tool config blocks are not sent to the LLM.
	 */
	private cachedStrippedPersonaContent: string | null = null;

	/**
	 * Cached stripped per-rule contents from `extractSourceToolConfigs()`.
	 * Keyed in the same order as the matched rules array. Joined with
	 * separators in `assemble()`.
	 */
	private cachedStrippedRuleContents: string[] | null = null;

	constructor(
		private readonly vault: Vault,
		private notorDir: string,
		private readonly metadataCache?: MetadataCache
	) {}

	/**
	 * Update the notor directory path (after settings change).
	 */
	setNotorDir(notorDir: string): void {
		this.notorDir = notorDir;
	}

	/**
	 * Phase 1: Extract tool configs from persona and rule sources.
	 *
	 * Resolves `<include_note>` tags, then extracts `<notor_tool_config>` blocks
	 * from persona content and each matched rule. Stripped content is cached
	 * internally for use in the subsequent `assemble()` call.
	 *
	 * Must be called before `assemble()` on each iteration of the response loop.
	 *
	 * @param matchedRules - Rules matched by VaultRuleManager for the current context.
	 * @param persona      - Active persona, or null/undefined for no persona.
	 * @returns Extracted tool configs from persona and rule sources.
	 *
	 * @see specs/04b-tool-toggle/tasks.md — SYS-001, SYS-002
	 */
	async extractSourceToolConfigs(
		matchedRules?: VaultRule[],
		persona?: Persona | null
	): Promise<ExtractedToolConfigResult> {
		const personaToolConfigs: ParsedToolConfig[] = [];
		const ruleToolConfigs: ParsedToolConfig[] = [];

		// --- Persona extraction ---
		if (persona && persona.prompt_content.trim()) {
			// Resolve <include_note> tags first
			const resolvedPersonaContent = await this.resolveIncludeNotesIfAvailable(
				persona.prompt_content,
				persona.system_prompt_path,
				"system_prompt"
			);

			// Extract <notor_tool_config> blocks
			const personaResult = extractToolConfigs(
				resolvedPersonaContent,
				"persona",
				persona.system_prompt_path,
				undefined, // knownToolNames — validated downstream by the merger
				parseYaml,
			);

			personaToolConfigs.push(...personaResult.configs);
			this.cachedStrippedPersonaContent = personaResult.strippedContent;

			// Log validation errors (callers surface as Notices)
			for (const error of personaResult.errors) {
				log.warn("Tool config validation error in persona", {
					sourceFile: error.sourceFile,
					detail: error.detail,
				});
			}
		} else {
			this.cachedStrippedPersonaContent = persona?.prompt_content ?? null;
		}

		// --- Per-rule extraction ---
		const strippedRuleContents: string[] = [];

		if (matchedRules && matchedRules.length > 0) {
			for (const rule of matchedRules) {
				const trimmed = rule.content.trim();
				if (trimmed.length === 0) {
					strippedRuleContents.push("");
					continue;
				}

				try {
					// Resolve <include_note> tags per-rule
					const resolvedRuleContent = await this.resolveIncludeNotesIfAvailable(
						trimmed,
						rule.file_path,
						"vault_rule"
					);

					// Extract <notor_tool_config> blocks
					const ruleResult = extractToolConfigs(
						resolvedRuleContent,
						"rule",
						rule.file_path,
						undefined,
						parseYaml,
					);

					ruleToolConfigs.push(...ruleResult.configs);
					strippedRuleContents.push(ruleResult.strippedContent);

					for (const error of ruleResult.errors) {
						log.warn("Tool config validation error in rule", {
							sourceFile: error.sourceFile,
							detail: error.detail,
						});
					}
				} catch (e) {
					// On resolution failure, use the original content so the rule
					// still applies. Log the error for debugging.
					log.warn("Failed to resolve <include_note> tags in rule", {
						filePath: rule.file_path,
						error: String(e),
					});
					strippedRuleContents.push(trimmed);
				}
			}
		}

		this.cachedStrippedRuleContents = strippedRuleContents;

		log.debug("Tool configs extracted from sources", {
			personaConfigs: personaToolConfigs.length,
			ruleConfigs: ruleToolConfigs.length,
		});

		return { personaToolConfigs, ruleToolConfigs };
	}

	/**
	 * Assemble the complete system prompt.
	 *
	 * When a persona is active, its system prompt is incorporated based on
	 * the persona's `prompt_mode`:
	 * - `"append"` (default): global system prompt first, then persona prompt
	 *   appended as a labeled section.
	 * - `"replace"`: global system prompt is excluded entirely; only the
	 *   persona prompt is used as the base. Vault-level rules still apply.
	 *
	 * Backward-compatible: when `persona` is null/undefined, existing
	 * behavior is unchanged.
	 *
	 * @param mode - Current Plan/Act mode
	 * @param toolDefinitions - Tool definitions from the tool registry (filtered when effective config is active)
	 * @param vaultRuleContent - Pre-evaluated vault rule content to inject (legacy path — used when `extractSourceToolConfigs()` was not called)
	 * @param autoContextBlock - Dynamic `<auto-context>` XML block (rebuilt before each LLM call)
	 * @param persona - Active persona, or null/undefined for no persona
	 * @returns Complete system prompt string
	 *
	 * @see specs/03-workflows-personas/spec.md — FR-38
	 * @see specs/03-workflows-personas/tasks/group-a-tasks.md — A-006
	 * @see specs/04b-tool-toggle/tasks.md — SYS-001 (two-phase builder)
	 */
	async assemble(
		mode: ConversationMode,
		toolDefinitions: ToolDefinition[],
		vaultRuleContent?: string,
		autoContextBlock?: string,
		persona?: Persona | null
	): Promise<string> {
		const parts: string[] = [];

		// Determine persona content to use:
		// - If extractSourceToolConfigs() was called, use cached stripped content
		//   (tool config blocks already removed)
		// - Otherwise, resolve <include_note> tags directly (legacy path)
		const useCache = this.cachedStrippedPersonaContent !== null
			|| this.cachedStrippedRuleContents !== null;

		// 1. Base system prompt — depends on persona prompt_mode
		if (persona && persona.prompt_mode === "replace") {
			// Replace mode: persona prompt replaces the global system prompt
			// entirely. Use persona prompt as the base (may be empty).
			if (persona.prompt_content.trim()) {
				let personaContent: string;
				if (useCache && this.cachedStrippedPersonaContent !== null) {
					personaContent = this.cachedStrippedPersonaContent;
				} else {
					// D-010: Resolve <include_note> tags in persona prompt (replace mode).
					personaContent = await this.resolveIncludeNotesIfAvailable(
						persona.prompt_content,
						persona.system_prompt_path,
						"system_prompt"
					);
				}
				if (personaContent.trim()) {
					parts.push(personaContent);
				}
			}
			log.debug("Using persona prompt in replace mode", {
				persona: persona.name,
				hasContent: !!persona.prompt_content.trim(),
			});
		} else {
			// No persona, or append mode: start with global system prompt
			const basePrompt = await this.getBasePrompt();
			parts.push(basePrompt);

			// Append persona prompt as a labeled section (if persona active
			// and has non-empty content)
			if (persona && persona.prompt_content.trim()) {
				let personaContent: string;
				if (useCache && this.cachedStrippedPersonaContent !== null) {
					personaContent = this.cachedStrippedPersonaContent;
				} else {
					// D-010: Resolve <include_note> tags in persona prompt (append mode).
					personaContent = await this.resolveIncludeNotesIfAvailable(
						persona.prompt_content,
						persona.system_prompt_path,
						"system_prompt"
					);
				}
				if (personaContent.trim()) {
					parts.push(this.buildPersonaSection({
						...persona,
						prompt_content: personaContent,
					}));
				}
			}
		}

		// 2. Tool definitions section
		if (toolDefinitions.length > 0) {
			const toolSection = this.buildToolDefinitionsSection(toolDefinitions);
			parts.push(toolSection);
		}

		// 3. Mode-aware instructions
		parts.push(this.buildModeSection(mode));

		// 4. Vault-level rules (always applied regardless of persona prompt_mode)
		// Use cached stripped rule contents if available (two-phase path),
		// otherwise fall back to the legacy vaultRuleContent parameter.
		if (useCache && this.cachedStrippedRuleContents !== null) {
			const ruleContent = this.cachedStrippedRuleContents
				.filter((c) => c.trim().length > 0)
				.join("\n\n---\n\n");
			if (ruleContent.trim()) {
				parts.push(this.buildRulesSection(ruleContent));
			}
		} else if (vaultRuleContent && vaultRuleContent.trim()) {
			parts.push(this.buildRulesSection(vaultRuleContent));
		}

		// 5. Workspace context (auto-context — rebuilt before each LLM call)
		if (autoContextBlock && autoContextBlock.trim()) {
			parts.push(this.buildAutoContextSection(autoContextBlock));
		}

		let assembled = parts.join("\n\n");

		// Enforce hard ceiling (persona content included in the limit)
		const tokenCount = estimateTokenCount(assembled);
		if (tokenCount > MAX_SYSTEM_PROMPT_TOKENS) {
			log.warn("System prompt exceeds token ceiling, truncating", {
				tokens: tokenCount,
				ceiling: MAX_SYSTEM_PROMPT_TOKENS,
			});
			// Truncate from the end (rules section is the most variable)
			assembled = this.truncateToTokenLimit(assembled, MAX_SYSTEM_PROMPT_TOKENS);
		}

		// Clear cached state so the next iteration must call extractSourceToolConfigs()
		// before assemble() to get fresh data.
		this.cachedStrippedPersonaContent = null;
		this.cachedStrippedRuleContents = null;

		return assembled;
	}

	/**
	 * Get the base system prompt — custom file or built-in default.
	 *
	 * Resolution order:
	 * 1. If `{notor_dir}/prompts/core-system-prompt.md` exists, use its body
	 * 2. Otherwise, use the built-in DEFAULT_SYSTEM_PROMPT
	 */
	async getBasePrompt(): Promise<string> {
		const customPath = this.getCustomPromptPath();

		try {
			const exists = await this.vault.adapter.exists(customPath);
			if (exists) {
				const content = await this.vault.adapter.read(customPath);
				const stripped = this.stripFrontmatter(content);
				if (stripped.trim()) {
					log.debug("Using custom system prompt", { path: customPath });
					// D-010: Resolve <include_note> tags in the custom system prompt.
					// Uses only inlineContent (attached mode ignored in system_prompt context).
					const resolved = await this.resolveIncludeNotesIfAvailable(
						stripped.trim(),
						customPath,
						"system_prompt"
					);
					return resolved;
				}
			}
		} catch (e) {
			log.warn("Failed to read custom system prompt, using default", {
				path: customPath,
				error: String(e),
			});
		}

		return DEFAULT_SYSTEM_PROMPT;
	}

	/**
	 * Write the default system prompt to the customization file.
	 *
	 * Creates the file at `{notor_dir}/prompts/core-system-prompt.md`
	 * for user editing.
	 */
	async writeDefaultPromptFile(): Promise<string> {
		const filePath = this.getCustomPromptPath();
		const dir = filePath.substring(0, filePath.lastIndexOf("/"));

		// Ensure directory exists
		const dirExists = await this.vault.adapter.exists(dir);
		if (!dirExists) {
			await this.vault.adapter.mkdir(dir);
		}

		const content = `---
description: Custom system prompt for Notor AI assistant
---

${DEFAULT_SYSTEM_PROMPT}
`;

		await this.vault.adapter.write(filePath, content);
		log.info("Wrote default system prompt file", { path: filePath });

		return filePath;
	}

	/**
	 * Get the vault-relative path for the custom system prompt file.
	 */
	getCustomPromptPath(): string {
		const dir = this.notorDir.replace(/\/$/, "");
		return `${dir}/prompts/core-system-prompt.md`;
	}

	// -----------------------------------------------------------------------
	// Section builders
	// -----------------------------------------------------------------------

	/**
	 * Build the tool definitions section from the tool registry.
	 * This is the single source of truth for tool documentation in the prompt.
	 */
	private buildToolDefinitionsSection(tools: ToolDefinition[]): string {
		const lines: string[] = ["## Available tools", ""];

		for (const tool of tools) {
			lines.push(`### ${tool.name}`);
			lines.push(tool.description);
			lines.push("");

			// Parameter documentation
			const schema = tool.input_schema;
			if (schema.properties && Object.keys(schema.properties).length > 0) {
				lines.push("**Parameters:**");
				const required = new Set(schema.required ?? []);

				for (const [name, prop] of Object.entries(schema.properties)) {
					const propSchema = prop as { type?: string; description?: string; default?: unknown };
					const reqLabel = required.has(name) ? "(required)" : "(optional)";
					const defaultLabel = propSchema.default !== undefined
						? ` Default: \`${JSON.stringify(propSchema.default)}\`.`
						: "";
					lines.push(
						`- \`${name}\` (${propSchema.type ?? "any"}, ${reqLabel}): ${propSchema.description ?? ""}${defaultLabel}`
					);
				}
				lines.push("");
			}
		}

		return lines.join("\n");
	}

	/**
	 * Build mode-aware instructions section.
	 */
	private buildModeSection(mode: ConversationMode): string {
		if (mode === "plan") {
			return `## Current mode: Plan (read-only)

You are in **Plan mode**. You can read notes, search the vault, and list files, but you cannot create or modify notes. Use this mode to research, analyze, and propose changes without risk.

If you need to make changes, inform the user and suggest switching to Act mode.`;
		}

		return `## Current mode: Act (full access)

You are in **Act mode**. You can use all tools, including creating and editing notes. Write operations may require user approval before being applied.

Prefer surgical edits with \`replace_in_note\` over full rewrites with \`write_note\`.`;
	}

	/**
	 * Build the persona system prompt section for append mode.
	 *
	 * Appended after the global system prompt as a clearly labeled section
	 * so the LLM understands which persona is active and its instructions.
	 *
	 * @see specs/03-workflows-personas/spec.md — FR-38 (append mode assembly)
	 */
	private buildPersonaSection(persona: Persona): string {
		return `## Active persona: ${persona.name}

${persona.prompt_content}`;
	}

	/**
	 * Build vault-level rules injection section.
	 */
	private buildRulesSection(ruleContent: string): string {
		return `## Vault instructions

The following instructions are provided by the user's vault configuration and should be followed:

${ruleContent}`;
	}

	/**
	 * Build workspace context section from auto-context XML.
	 *
	 * This section is rebuilt before every LLM API call (including
	 * tool-result round-trips) so it always reflects the latest
	 * workspace state.
	 */
	private buildAutoContextSection(autoContextBlock: string): string {
		return `## Workspace context

${autoContextBlock}`;
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Resolve `<include_note>` tags in text if MetadataCache is available.
	 *
	 * D-010: Backward-compatible — when MetadataCache was not provided to the
	 * constructor (pre-Phase 4 callers), or the text contains no tags, this
	 * returns the original text unmodified. Resolution errors produce inline
	 * error markers visible to the LLM; the rest of the text assembles normally.
	 *
	 * @param text - Text potentially containing `<include_note>` tags
	 * @param sourceFilePath - Vault-relative path of the file containing the tags
	 * @param context - Resolution context (`"system_prompt"` or `"vault_rule"`)
	 * @returns Text with `<include_note>` tags resolved (inlineContent only)
	 *
	 * @see specs/03-workflows-personas/tasks/group-d-tasks.md — D-010
	 */
	private async resolveIncludeNotesIfAvailable(
		text: string,
		sourceFilePath: string,
		context: "system_prompt" | "vault_rule"
	): Promise<string> {
		if (!this.metadataCache) {
			return text;
		}
		try {
			const result = await resolveIncludeNotes(
				text,
				this.vault,
				this.metadataCache,
				sourceFilePath,
				context
			);
			return result.inlineContent;
		} catch (e) {
			log.warn("Failed to resolve <include_note> tags", {
				sourceFilePath,
				context,
				error: String(e),
			});
			return text;
		}
	}

	/**
	 * Strip YAML frontmatter from Markdown content.
	 */
	private stripFrontmatter(content: string): string {
		if (!content.startsWith("---")) {
			return content;
		}

		const endIndex = content.indexOf("---", 3);
		if (endIndex === -1) {
			return content;
		}

		return content.substring(endIndex + 3).trim();
	}

	/**
	 * Truncate text to fit within a token limit.
	 * Cuts at paragraph boundaries where possible.
	 */
	private truncateToTokenLimit(text: string, maxTokens: number): string {
		const targetChars = maxTokens * 4; // rough char estimate
		if (text.length <= targetChars) {
			return text;
		}

		const truncated = text.substring(0, targetChars);
		const lastParagraph = truncated.lastIndexOf("\n\n");
		if (lastParagraph > targetChars * 0.7) {
			return truncated.substring(0, lastParagraph);
		}
		return truncated;
	}
}

/** Export the default prompt for testing / reference. */
export { DEFAULT_SYSTEM_PROMPT as BUILT_IN_SYSTEM_PROMPT };
