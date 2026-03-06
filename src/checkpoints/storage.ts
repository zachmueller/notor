/**
 * Checkpoint storage — persists and retrieves checkpoint JSON files.
 *
 * Checkpoints are stored as JSON files organized by conversation:
 * `{checkpoint_path}/{conversation_id}/{checkpoint_id}.json`
 *
 * Implements retention policy enforcement (max per conversation + max age).
 * Pruning runs lazily on checkpoint creation.
 *
 * @see specs/01-mvp/spec.md — FR-17 (checkpoints and rollback)
 * @see specs/01-mvp/data-model.md — Checkpoint entity, retention policy
 */

import type { Vault } from "obsidian";
import type { Checkpoint } from "../types";
import { logger } from "../utils/logger";

const log = logger("CheckpointStorage");

/**
 * Persists checkpoint data as JSON files in the plugin directory.
 *
 * Default path: `.obsidian/plugins/notor/checkpoints/`
 * File layout:  `{basePath}/{conversation_id}/{checkpoint_id}.json`
 */
export class CheckpointStorage {
	constructor(
		private readonly vault: Vault,
		private basePath: string,
		private maxPerConversation: number,
		private maxAgeDays: number
	) {}

	// -----------------------------------------------------------------------
	// Configuration
	// -----------------------------------------------------------------------

	/** Update storage path (after settings change). */
	setBasePath(basePath: string): void {
		this.basePath = basePath;
	}

	/** Update retention limits (after settings change). */
	setRetentionLimits(maxPerConversation: number, maxAgeDays: number): void {
		this.maxPerConversation = maxPerConversation;
		this.maxAgeDays = maxAgeDays;
	}

	// -----------------------------------------------------------------------
	// Save
	// -----------------------------------------------------------------------

	/**
	 * Persist a checkpoint to disk.
	 *
	 * After saving, lazily prunes checkpoints for the conversation to
	 * enforce retention policy.
	 */
	async save(checkpoint: Checkpoint): Promise<void> {
		const dir = this.conversationDir(checkpoint.conversation_id);
		await this.ensureDir(dir);

		const filePath = `${dir}/${checkpoint.id}.json`;
		await this.vault.adapter.write(filePath, JSON.stringify(checkpoint, null, 2));

		log.debug("Saved checkpoint", {
			id: checkpoint.id,
			conversationId: checkpoint.conversation_id,
			path: filePath,
		});

		// Lazily enforce retention policy
		await this.pruneConversation(checkpoint.conversation_id);
	}

	// -----------------------------------------------------------------------
	// Load / list
	// -----------------------------------------------------------------------

	/**
	 * Load a single checkpoint by ID.
	 *
	 * @returns The checkpoint, or null if not found.
	 */
	async load(conversationId: string, checkpointId: string): Promise<Checkpoint | null> {
		const filePath = `${this.conversationDir(conversationId)}/${checkpointId}.json`;

		try {
			const exists = await this.vault.adapter.exists(filePath);
			if (!exists) return null;

			const raw = await this.vault.adapter.read(filePath);
			return JSON.parse(raw) as Checkpoint;
		} catch (e) {
			log.error("Failed to load checkpoint", { conversationId, checkpointId, error: String(e) });
			return null;
		}
	}

	/**
	 * List all checkpoints for a conversation, ordered newest first.
	 */
	async listForConversation(conversationId: string): Promise<Checkpoint[]> {
		const dir = this.conversationDir(conversationId);

		try {
			const exists = await this.vault.adapter.exists(dir);
			if (!exists) return [];

			const listing = await this.vault.adapter.list(dir);
			const checkpoints: Checkpoint[] = [];

			for (const filePath of listing.files) {
				if (!filePath.endsWith(".json")) continue;
				try {
					const raw = await this.vault.adapter.read(filePath);
					checkpoints.push(JSON.parse(raw) as Checkpoint);
				} catch (e) {
					log.warn("Skipping malformed checkpoint file", { filePath, error: String(e) });
				}
			}

			// Sort newest first
			checkpoints.sort((a, b) =>
				new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
			);

			return checkpoints;
		} catch (e) {
			log.error("Failed to list checkpoints", { conversationId, error: String(e) });
			return [];
		}
	}

	// -----------------------------------------------------------------------
	// Deletion
	// -----------------------------------------------------------------------

	/**
	 * Delete a single checkpoint file.
	 */
	async delete(conversationId: string, checkpointId: string): Promise<void> {
		const filePath = `${this.conversationDir(conversationId)}/${checkpointId}.json`;
		try {
			const exists = await this.vault.adapter.exists(filePath);
			if (exists) {
				await this.vault.adapter.remove(filePath);
				log.debug("Deleted checkpoint", { conversationId, checkpointId });
			}
		} catch (e) {
			log.warn("Failed to delete checkpoint", { conversationId, checkpointId, error: String(e) });
		}
	}

	/**
	 * Delete all checkpoints for a conversation.
	 */
	async deleteAllForConversation(conversationId: string): Promise<void> {
		const dir = this.conversationDir(conversationId);
		try {
			const exists = await this.vault.adapter.exists(dir);
			if (!exists) return;

			const listing = await this.vault.adapter.list(dir);
			for (const filePath of listing.files) {
				await this.vault.adapter.remove(filePath);
			}
			await this.vault.adapter.rmdir(dir, false);

			log.debug("Deleted all checkpoints for conversation", { conversationId });
		} catch (e) {
			log.warn("Failed to delete checkpoints for conversation", {
				conversationId,
				error: String(e),
			});
		}
	}

	// -----------------------------------------------------------------------
	// Retention / pruning
	// -----------------------------------------------------------------------

	/**
	 * Prune checkpoints for a conversation to enforce retention limits.
	 *
	 * Removes checkpoints that exceed:
	 * - `maxPerConversation`: oldest are removed first
	 * - `maxAgeDays`: checkpoints older than the age limit
	 *
	 * Called lazily on each checkpoint creation.
	 */
	private async pruneConversation(conversationId: string): Promise<void> {
		try {
			const checkpoints = await this.listForConversation(conversationId);
			if (checkpoints.length === 0) return;

			const now = Date.now();
			const maxAgeMs = this.maxAgeDays * 24 * 60 * 60 * 1000;
			const toDelete: string[] = [];

			// Age-based pruning
			for (const cp of checkpoints) {
				const age = now - new Date(cp.timestamp).getTime();
				if (age > maxAgeMs) {
					toDelete.push(cp.id);
				}
			}

			// Count-based pruning (after age pruning, on the remaining set)
			const remaining = checkpoints.filter((cp) => !toDelete.includes(cp.id));
			if (remaining.length > this.maxPerConversation) {
				// remaining is sorted newest first; prune the oldest (end of array)
				const excess = remaining.slice(this.maxPerConversation);
				for (const cp of excess) {
					toDelete.push(cp.id);
				}
			}

			if (toDelete.length > 0) {
				log.info("Pruning checkpoints", {
					conversationId,
					pruneCount: toDelete.length,
					totalBefore: checkpoints.length,
				});
				for (const id of toDelete) {
					await this.delete(conversationId, id);
				}
			}
		} catch (e) {
			log.warn("Retention pruning failed (non-fatal)", {
				conversationId,
				error: String(e),
			});
		}
	}

	// -----------------------------------------------------------------------
	// Path helpers
	// -----------------------------------------------------------------------

	private conversationDir(conversationId: string): string {
		const base = this.basePath.replace(/\/$/, "");
		return `${base}/${conversationId}`;
	}

	private async ensureDir(dir: string): Promise<void> {
		const exists = await this.vault.adapter.exists(dir);
		if (!exists) {
			await this.vault.adapter.mkdir(dir);
		}
	}
}