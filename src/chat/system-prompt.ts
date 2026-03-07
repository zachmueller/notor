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

import type { Vault } from "obsidian";
import type { ConversationMode } from "../types";
import type { ToolDefinition } from "../providers/provider";
import { estimateTokenCount } from "../utils/tokens";
import { DEFAULT_SYSTEM_PROMPT } from "./default-system-prompt";
import { logger } from "../utils/logger";

const log = logger("SystemPromptBuilder");

/** Hard ceiling for total system prompt tokens. */
const MAX_SYSTEM_PROMPT_TOKENS = 8000;

/**
 * Builds and assembles the complete system prompt for LLM calls.
 */
export class SystemPromptBuilder {
	constructor(
		private readonly vault: Vault,
		private notorDir: string
	) {}

	/**
	 * Update the notor directory path (after settings change).
	 */
	setNotorDir(notorDir: string): void {
		this.notorDir = notorDir;
	}

	/**
	 * Assemble the complete system prompt.
	 *
	 * @param mode - Current Plan/Act mode
	 * @param toolDefinitions - Tool definitions from the tool registry
	 * @param vaultRuleContent - Pre-evaluated vault rule content to inject
	 * @param autoContextBlock - Dynamic `<auto-context>` XML block (rebuilt before each LLM call)
	 * @returns Complete system prompt string
	 */
	async assemble(
		mode: ConversationMode,
		toolDefinitions: ToolDefinition[],
		vaultRuleContent?: string,
		autoContextBlock?: string
	): Promise<string> {
		const parts: string[] = [];

		// 1. Base system prompt (built-in or custom)
		const basePrompt = await this.getBasePrompt();
		parts.push(basePrompt);

		// 2. Tool definitions section
		if (toolDefinitions.length > 0) {
			const toolSection = this.buildToolDefinitionsSection(toolDefinitions);
			parts.push(toolSection);
		}

		// 3. Mode-aware instructions
		parts.push(this.buildModeSection(mode));

		// 4. Vault-level rules (if any)
		if (vaultRuleContent && vaultRuleContent.trim()) {
			parts.push(this.buildRulesSection(vaultRuleContent));
		}

		// 5. Workspace context (auto-context — rebuilt before each LLM call)
		if (autoContextBlock && autoContextBlock.trim()) {
			parts.push(this.buildAutoContextSection(autoContextBlock));
		}

		let assembled = parts.join("\n\n");

		// Enforce hard ceiling
		const tokenCount = estimateTokenCount(assembled);
		if (tokenCount > MAX_SYSTEM_PROMPT_TOKENS) {
			log.warn("System prompt exceeds token ceiling, truncating", {
				tokens: tokenCount,
				ceiling: MAX_SYSTEM_PROMPT_TOKENS,
			});
			// Truncate from the end (rules section is the most variable)
			assembled = this.truncateToTokenLimit(assembled, MAX_SYSTEM_PROMPT_TOKENS);
		}

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
					return stripped.trim();
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
