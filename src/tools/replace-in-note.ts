/**
 * `replace_in_note` tool — atomic SEARCH/REPLACE editing via vault.process.
 *
 * Write tool available in Act mode only. Uses vault.process for atomic
 * read-modify-write. All search blocks must match before any change is applied.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — replace_in_note schema
 * @see specs/01-mvp/spec.md — FR-9
 * @see design/research/obsidian-vault-api-frontmatter.md — vault.process atomic operations
 */

import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { Tool, ToolResult } from "./tool";
import type { StaleContentTracker } from "../chat/stale-tracker";
import type { NoteOpener } from "./note-opener";
import type { CheckpointManager } from "../checkpoints/checkpoint";
import { logger } from "../utils/logger";

const log = logger("ReplaceInNoteTool");

/** A single SEARCH/REPLACE block. */
interface ChangeBlock {
	search: string;
	replace: string;
}

/**
 * Implements the `replace_in_note` tool.
 *
 * Makes targeted edits using SEARCH/REPLACE blocks. The operation is atomic:
 * if any search block fails to match, vault.process throws and no changes
 * are written to disk.
 *
 * Multiple blocks are applied in sequence (order matters). Each block
 * replaces only the first occurrence of the search text. An empty replace
 * string deletes the matched text.
 */
export class ReplaceInNoteTool implements Tool {
	readonly name = "replace_in_note";
	readonly mode = "write" as const;

	readonly description =
		"Make targeted edits within a note using SEARCH/REPLACE blocks for surgical editing " +
		"without rewriting the entire note. Each search string must match exactly " +
		"(character-for-character including whitespace). The operation is atomic: if any " +
		"search block fails to match, no changes are applied. Requires user approval unless " +
		"auto-approved.";

	readonly input_schema = {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Path to the note relative to vault root",
			},
			changes: {
				type: "array",
				description:
					"Array of search/replace blocks to apply in sequence. Each block " +
					"replaces only the first occurrence of the search text.",
				items: {
					type: "object",
					properties: {
						search: {
							type: "string",
							description:
								"Exact text to find in the note (character-for-character " +
								"match including whitespace)",
						},
						replace: {
							type: "string",
							description:
								"Text to replace the matched search text with. " +
								"Use empty string to delete the matched text.",
						},
					},
					required: ["search", "replace"],
				},
				minItems: 1,
			},
		},
		required: ["path", "changes"],
	};

	constructor(
		private readonly app: App,
		private readonly staleTracker: StaleContentTracker,
		private readonly noteOpener?: NoteOpener,
		private readonly checkpointManager?: CheckpointManager
	) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const path = params["path"] as string;
		const changes = params["changes"] as ChangeBlock[] | undefined;

		if (!path || typeof path !== "string") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: path",
			};
		}

		if (!Array.isArray(changes) || changes.length === 0) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing or empty required parameter: changes",
			};
		}

		// Validate change blocks
		for (let i = 0; i < changes.length; i++) {
			const block = changes[i];
			if (typeof block?.search !== "string" || typeof block?.replace !== "string") {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `Change block ${i + 1} is missing required 'search' or 'replace' property`,
				};
			}
			if (block.search === "") {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `Change block ${i + 1} has an empty search string. Search text must be non-empty.`,
				};
			}
		}

		log.debug("Replacing in note", { path, changeCount: changes.length });

		// Resolve file
		const file = this.app.vault.getFileByPath(path);

		if (!file) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Note not found: ${path}`,
			};
		}

		if (!(file instanceof TFile)) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Path is not a file: ${path}`,
			};
		}

		// Stale content check: read current content first
		let currentContent: string;
		try {
			currentContent = await this.app.vault.read(file);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Failed to read note for stale check: ${message}`,
			};
		}

		const staleResult = this.staleTracker.check(path, currentContent);
		if (staleResult.isStale) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error:
					"Note content has changed since last read. " +
					"Re-read the note with read_note before retrying.",
			};
		}

		// Checkpoint: snapshot existing content before applying changes
		await this.checkpointManager?.createCheckpoint(path, this.name, "");

		// Apply changes atomically via vault.process
		// If any search block doesn't match, the callback throws and
		// vault.process ensures NO changes are written.
		let failedBlockIndex = -1;
		let failedSearchText = "";

		try {
			await this.app.vault.process(file, (data) => {
				let modified = data;

				for (let i = 0; i < changes.length; i++) {
					const block = changes[i];
					if (!block) continue;

					const idx = modified.indexOf(block.search);

					if (idx === -1) {
						// Record which block failed before throwing
						failedBlockIndex = i + 1;
						failedSearchText = block.search;
						throw new Error(`Search block ${i + 1} did not match`);
					}

					// Replace only the first occurrence
					modified =
						modified.slice(0, idx) +
						block.replace +
						modified.slice(idx + block.search.length);
				}

				return modified;
			});
		} catch (e) {
			// Check if this was a no-match error (which we initiated)
			if (failedBlockIndex !== -1) {
				const preview =
					failedSearchText.length > 80
						? failedSearchText.slice(0, 80) + "..."
						: failedSearchText;
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error:
						`Search block ${failedBlockIndex} did not match any text in ${path}. ` +
						`No changes were applied. The search text was: "${preview}"`,
				};
			}

			const message = e instanceof Error ? e.message : String(e);
			log.error("Failed to apply replacements", { path, error: message });
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Failed to apply replacements: ${message}`,
			};
		}

		// Update stale tracker with the new content
		// We need to re-read since vault.process returns the written content
		try {
			const newContent = await this.app.vault.read(file);
			this.staleTracker.updateAfterWrite(path, newContent);
		} catch {
			// Non-fatal: stale tracker may cause a re-read next time
			this.staleTracker.invalidate(path);
		}

		log.info("Applied replacements", { path, count: changes.length });

		// Open in editor
		await this.noteOpener?.openNote(path);

		return {
			tool_name: this.name,
			success: true,
			result: `Applied ${changes.length} replacement${changes.length > 1 ? "s" : ""} to ${path}`,
		};
	}
}