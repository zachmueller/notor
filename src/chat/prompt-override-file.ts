/**
 * A built-in prompt with a user override stored as a vault note.
 *
 * Generalizes the core-system-prompt customization pattern: a "Customize"
 * button exports the default text to `{notor_dir}/prompts/<name>.md`; when
 * that note exists and is non-blank, its body (frontmatter stripped) replaces
 * the default. Used by the voice-mode shaping prompts.
 */

import type { Vault } from "obsidian";
import { logger } from "../utils/logger";

const log = logger("PromptOverrideFile");

export interface PromptOverrideFileOptions {
	/** Vault-relative path of the override note. */
	path: string;
	/** Built-in prompt used when no override exists. */
	defaultText: string;
	/** One-line frontmatter description written into the exported note. */
	description: string;
	/** Optional guidance written as an HTML comment above the exported default. */
	notes?: string;
}

export interface PromptOverrideReadResult {
	text: string;
	source: "file" | "default";
}

/** Strip a leading YAML frontmatter block, if present. */
export function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return content;
	const afterFence = content.indexOf("\n", end + 1);
	return afterFence === -1 ? "" : content.slice(afterFence + 1);
}

export class PromptOverrideFile {
	constructor(
		private readonly vault: Vault,
		private readonly opts: PromptOverrideFileOptions,
	) {}

	getPath(): string {
		return this.opts.path;
	}

	get defaultText(): string {
		return this.opts.defaultText;
	}

	async exists(): Promise<boolean> {
		try {
			return await this.vault.adapter.exists(this.opts.path);
		} catch {
			return false;
		}
	}

	/** The override text when the note exists and is non-blank; otherwise the default. */
	async read(): Promise<PromptOverrideReadResult> {
		try {
			if (await this.vault.adapter.exists(this.opts.path)) {
				const content = await this.vault.adapter.read(this.opts.path);
				const stripped = stripFrontmatter(content).trim();
				if (stripped) return { text: stripped, source: "file" };
			}
		} catch (e) {
			log.warn("Failed to read prompt override, using default", {
				path: this.opts.path,
				error: String(e),
			});
		}
		return { text: this.opts.defaultText, source: "default" };
	}

	/** Write the default prompt to the override note (creating its folder) and return the path. */
	async writeDefault(): Promise<string> {
		const path = this.opts.path;
		const dir = path.substring(0, path.lastIndexOf("/"));
		if (dir && !(await this.vault.adapter.exists(dir))) {
			await this.vault.adapter.mkdir(dir);
		}

		const notes = this.opts.notes ? `<!--\n${this.opts.notes.trim()}\n-->\n\n` : "";
		const content = `---\ndescription: ${this.opts.description}\n---\n\n${notes}${this.opts.defaultText.trim()}\n`;
		await this.vault.adapter.write(path, content);
		log.info("Wrote default prompt override file", { path });
		return path;
	}
}
