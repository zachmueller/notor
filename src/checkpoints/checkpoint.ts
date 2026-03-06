/**
 * Checkpoint manager — automatic snapshots before write operations.
 *
 * Captures note content before any write tool executes so users can
 * preview, compare, and restore prior states. Scoped per conversation.
 *
 * @see specs/01-mvp/spec.md — FR-17 (checkpoints and rollback)
 * @see specs/01-mvp/data-model.md — Checkpoint entity
 * @see design/architecture.md — Checkpoints (Phase 2)
 */

import type { App } from "obsidian";
import type { Checkpoint } from "../types";
import type { CheckpointStorage } from "./storage";
import { logger } from "../utils/logger";

const log = logger("CheckpointManager");

/**
 * Manages automatic checkpoint creation before write operations.
 *
 * Scoped to the active conversation — `setConversationId` must be
 * called when the active conversation changes.
 */
export class CheckpointManager {
	/** The active conversation ID (checkpoints are scoped per conversation). */
	private conversationId: string | null = null;

	constructor(
		private readonly app: App,
		private readonly storage: CheckpointStorage
	) {}

	// -----------------------------------------------------------------------
	// Conversation scoping
	// -----------------------------------------------------------------------

	/**
	 * Set the active conversation ID.
	 *
	 * Must be called whenever the active conversation changes.
	 */
	setConversationId(conversationId: string): void {
		this.conversationId = conversationId;
		log.debug("Conversation scope set", { conversationId });
	}

	/**
	 * Clear the active conversation scope.
	 */
	clearConversationId(): void {
		this.conversationId = null;
	}

	// -----------------------------------------------------------------------
	// Checkpoint creation
	// -----------------------------------------------------------------------

	/**
	 * Snapshot a note's current content before a write operation.
	 *
	 * Should be called before `write_note`, `replace_in_note`,
	 * `update_frontmatter`, and `manage_tags`.
	 *
	 * @param notePath - Vault-relative path of the note to snapshot
	 * @param toolName - The write tool triggering this checkpoint
	 * @param messageId - The tool_call message ID that triggered this
	 * @returns The created checkpoint, or null if the note doesn't exist
	 *          or no conversation is active
	 */
	async createCheckpoint(
		notePath: string,
		toolName: string,
		messageId: string
	): Promise<Checkpoint | null> {
		if (!this.conversationId) {
			log.warn("No active conversation — skipping checkpoint", { notePath, toolName });
			return null;
		}

		// Read the current note content from vault
		const file = this.app.vault.getFileByPath(notePath);
		if (!file) {
			// Note doesn't exist yet (e.g., write_note creating a new file)
			log.debug("Note does not exist — skipping checkpoint", { notePath });
			return null;
		}

		let content: string;
		try {
			content = await this.app.vault.read(file);
		} catch (e) {
			log.warn("Failed to read note for checkpoint", { notePath, error: String(e) });
			return null;
		}

		const checkpoint: Checkpoint = {
			id: crypto.randomUUID(),
			conversation_id: this.conversationId,
			note_path: notePath,
			content,
			timestamp: new Date().toISOString(),
			description: this.buildDescription(toolName, notePath),
			tool_name: toolName,
			message_id: messageId,
		};

		try {
			await this.storage.save(checkpoint);
			log.info("Checkpoint created", {
				id: checkpoint.id,
				notePath,
				toolName,
				conversationId: this.conversationId,
			});
		} catch (e) {
			// Checkpoint failure should not block the write operation
			log.error("Failed to persist checkpoint", { notePath, error: String(e) });
			return null;
		}

		return checkpoint;
	}

	// -----------------------------------------------------------------------
	// Checkpoint retrieval
	// -----------------------------------------------------------------------

	/**
	 * List all checkpoints for the active conversation, newest first.
	 */
	async listCheckpoints(): Promise<Checkpoint[]> {
		if (!this.conversationId) return [];
		return this.storage.listForConversation(this.conversationId);
	}

	/**
	 * Load a single checkpoint by ID.
	 */
	async getCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
		if (!this.conversationId) return null;
		return this.storage.load(this.conversationId, checkpointId);
	}

	// -----------------------------------------------------------------------
	// Restore
	// -----------------------------------------------------------------------

	/**
	 * Restore a note to a checkpoint state.
	 *
	 * Creates a new checkpoint of the current state before restoring,
	 * so the restore itself is reversible.
	 *
	 * @param checkpointId - The checkpoint to restore
	 * @returns true if restore succeeded, false otherwise
	 */
	async restore(checkpointId: string): Promise<boolean> {
		if (!this.conversationId) {
			log.warn("No active conversation — cannot restore checkpoint");
			return false;
		}

		const checkpoint = await this.storage.load(this.conversationId, checkpointId);
		if (!checkpoint) {
			log.error("Checkpoint not found for restore", { checkpointId });
			return false;
		}

		const file = this.app.vault.getFileByPath(checkpoint.note_path);
		if (!file) {
			log.error("Note not found for restore", { notePath: checkpoint.note_path });
			return false;
		}

		// Snapshot current state before restoring (so restore is reversible)
		await this.createCheckpoint(
			checkpoint.note_path,
			"restore",
			checkpointId
		);

		try {
			await this.app.vault.modify(file, checkpoint.content);
			log.info("Restored checkpoint", {
				checkpointId,
				notePath: checkpoint.note_path,
			});
			return true;
		} catch (e) {
			log.error("Failed to restore checkpoint", { checkpointId, error: String(e) });
			return false;
		}
	}

	// -----------------------------------------------------------------------
	// Current content for diff
	// -----------------------------------------------------------------------

	/**
	 * Read the current content of a note (for diff comparison).
	 */
	async getCurrentContent(notePath: string): Promise<string | null> {
		const file = this.app.vault.getFileByPath(notePath);
		if (!file) return null;
		try {
			return await this.app.vault.read(file);
		} catch {
			return null;
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Build a human-readable description for a checkpoint.
	 */
	private buildDescription(toolName: string, notePath: string): string {
		const toolLabels: Record<string, string> = {
			write_note: "Before write_note",
			replace_in_note: "Before replace_in_note",
			update_frontmatter: "Before update_frontmatter",
			manage_tags: "Before manage_tags",
			restore: "Before restore",
		};
		const label = toolLabels[toolName] ?? `Before ${toolName}`;
		return `${label} on ${notePath}`;
	}
}