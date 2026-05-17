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

import { createHash } from "crypto";
import { getFrontMatterInfo } from "obsidian";
import type { StaleContentEntry } from "../types";
import { logger } from "../utils/logger";

/**
 * Compute MD5 hash of body content (everything after frontmatter).
 * If no frontmatter exists, the entire content is the body.
 */
function computeBodyHash(content: string): string {
	const fmInfo = getFrontMatterInfo(content);
	const body = fmInfo.exists ? content.slice(fmInfo.contentStart) : content;
	return createHash("md5").update(body).digest("hex");
}

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
	 * Uses a two-tier comparison:
	 * 1. Fast path: exact full-content equality
	 * 2. Fallback: body-hash comparison (ignores frontmatter-only changes)
	 *
	 * @param notePath - Vault-relative path of the note
	 * @param currentContent - The note's current content (read fresh from vault)
	 * @returns Stale check result
	 */
	check(notePath: string, currentContent: string): StaleCheckResult {
		const entry = this.entries.get(notePath);

		if (!entry) {
			return { isStale: false, error: null };
		}

		// Fast path: exact full-content match
		if (currentContent === entry.last_read_content) {
			return { isStale: false, error: null };
		}

		// Fallback: compare body hashes (frontmatter-only changes are not stale)
		if (!entry.body_hash) {
			entry.body_hash = computeBodyHash(entry.last_read_content);
		}
		const currentBodyHash = computeBodyHash(currentContent);

		if (currentBodyHash === entry.body_hash) {
			// Frontmatter-only change — update stored content so future checks hit fast path
			entry.last_read_content = currentContent;
			log.debug("Frontmatter-only change detected, not stale", { notePath });
			return { isStale: false, error: null };
		}

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

	/**
	 * Update tracked content after a frontmatter-only write.
	 *
	 * Preserves the existing body hash (body hasn't changed) while
	 * updating stored full-content so subsequent fast-path checks pass.
	 */
	updateAfterFrontmatterWrite(notePath: string, newFullContent: string): void {
		const entry = this.entries.get(notePath);
		if (!entry) return;

		entry.last_read_content = newFullContent;
		entry.last_read_timestamp = new Date().toISOString();
		// body_hash intentionally preserved — body unchanged
		log.debug("Updated tracking after frontmatter write", { notePath });
	}

	/**
	 * Serialize current state for JSONL persistence.
	 * Computes body hash for any entry that doesn't already have one.
	 */
	serialize(): Array<{ note_path: string; body_hash: string; timestamp: string }> {
		const result: Array<{ note_path: string; body_hash: string; timestamp: string }> = [];
		for (const [, entry] of this.entries) {
			const hash = entry.body_hash ?? computeBodyHash(entry.last_read_content);
			result.push({
				note_path: entry.note_path,
				body_hash: hash,
				timestamp: entry.last_read_timestamp,
			});
		}
		return result;
	}

	/**
	 * Restore stale tracking state from persisted JSONL data.
	 *
	 * Restored entries use an empty sentinel for last_read_content,
	 * forcing the body-hash comparison path until the note is re-read.
	 */
	restore(entries: Array<{ note_path: string; body_hash: string; timestamp: string }>): void {
		for (const entry of entries) {
			this.entries.set(entry.note_path, {
				note_path: entry.note_path,
				last_read_content: "",
				last_read_timestamp: entry.timestamp,
				body_hash: entry.body_hash,
			});
		}
		log.debug("Restored stale state", { entryCount: entries.length });
	}
}