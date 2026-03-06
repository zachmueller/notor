/**
 * Stale content tracker — detects concurrent edits before write operations.
 *
 * Tracks the last-read content for each note path within a conversation.
 * Before any write tool executes, compares the note's current content
 * against what the AI last read, preventing silent overwrites.
 *
 * @see specs/01-mvp/data-model.md — Stale Content Check
 * @see specs/01-mvp/spec.md — NFR-3 (reliability/data safety)
 */

import type { StaleContentEntry } from "../types";
import { logger } from "../utils/logger";

const log = logger("StaleContentTracker");

/**
 * Result of a stale content check.
 */
export interface StaleCheckResult {
	/** Whether the content is stale (has changed since last read). */
	isStale: boolean;
	/** Error message if stale (null if fresh or never read). */
	error: string | null;
}

/**
 * Tracks last-read content per note path within a conversation
 * to detect concurrent edits before write operations.
 *
 * Scoped per conversation — cleared when starting a new conversation.
 */
export class StaleContentTracker {
	/** Last-read content keyed by note path. */
	private entries = new Map<string, StaleContentEntry>();

	/**
	 * Record that a note was read, storing its content for later comparison.
	 *
	 * Called after each `read_note` tool execution.
	 *
	 * @param notePath - Vault-relative path of the note
	 * @param content - Full content as returned by read_note
	 */
	recordRead(notePath: string, content: string): void {
		this.entries.set(notePath, {
			note_path: notePath,
			last_read_content: content,
			last_read_timestamp: new Date().toISOString(),
		});

		log.debug("Recorded read", {
			notePath,
			contentLength: content.length,
		});
	}

	/**
	 * Check if a note's content has changed since the AI last read it.
	 *
	 * Should be called before any write tool executes.
	 *
	 * @param notePath - Vault-relative path of the note
	 * @param currentContent - The note's current content (read fresh from vault)
	 * @returns Stale check result
	 */
	check(notePath: string, currentContent: string): StaleCheckResult {
		const entry = this.entries.get(notePath);

		// If the note was never read in this conversation, no stale check needed
		// (e.g., creating a brand new note)
		if (!entry) {
			return { isStale: false, error: null };
		}

		// Compare current content against last-read content
		if (currentContent !== entry.last_read_content) {
			log.warn("Stale content detected", {
				notePath,
				lastReadAt: entry.last_read_timestamp,
				lastReadLength: entry.last_read_content.length,
				currentLength: currentContent.length,
			});

			return {
				isStale: true,
				error: `Note content has changed since last read. The note "${notePath}" was modified after the AI last read it. Re-read the note with read_note before retrying.`,
			};
		}

		return { isStale: false, error: null };
	}

	/**
	 * Check if a note has been read in this conversation.
	 */
	hasBeenRead(notePath: string): boolean {
		return this.entries.has(notePath);
	}

	/**
	 * Get the last-read entry for a note.
	 */
	getEntry(notePath: string): StaleContentEntry | undefined {
		return this.entries.get(notePath);
	}

	/**
	 * Clear all tracked entries.
	 *
	 * Called when starting a new conversation.
	 */
	clear(): void {
		this.entries.clear();
		log.debug("Cleared stale content tracker");
	}

	/**
	 * Remove tracking for a specific note.
	 *
	 * Called after a successful write to update the tracked content.
	 */
	invalidate(notePath: string): void {
		this.entries.delete(notePath);
		log.debug("Invalidated stale tracking", { notePath });
	}

	/**
	 * Update the tracked content for a note after a successful write.
	 *
	 * This ensures subsequent writes don't falsely detect staleness
	 * from the AI's own modifications.
	 */
	updateAfterWrite(notePath: string, newContent: string): void {
		this.entries.set(notePath, {
			note_path: notePath,
			last_read_content: newContent,
			last_read_timestamp: new Date().toISOString(),
		});
		log.debug("Updated tracking after write", { notePath });
	}
}