/**
 * JSONL-based conversation history persistence.
 *
 * Writes messages as they occur (append-only) and loads full
 * conversations from disk. Manages conversation listing, ordering,
 * and retention policy enforcement.
 *
 * ## JSONL Schema
 *
 * Each JSONL file has the following line types:
 *
 * **Line 1 — Conversation header:**
 * ```json
 * { "_type": "conversation", "id": "...", "created_at": "...", ... }
 * ```
 *
 * **Subsequent lines — Message records:**
 * ```json
 * { "_type": "message", "id": "...", "role": "user|assistant|system|tool_call|tool_result", "content": "...", ... }
 * ```
 *
 * ### Phase 3 field extensions (backward-compatible — all optional)
 *
 * User messages may include:
 * - `auto_context` (string | null): The raw `<auto-context>` XML block injected
 *   into the message, or null if auto-context was disabled/empty.
 * - `attachments` (array | null): Metadata-only records of attached notes/files.
 *   Each entry: `{ id, type, path, section, display_name, content_length, status }`.
 *   Full attachment content is NOT stored — only metadata for auditability.
 * - `hook_injections` (string[] | null): Captured stdout from `pre_send` hooks
 *   that was injected into the assembled message.
 *
 * System messages may contain a serialized `CompactionRecord`:
 * - When `role === "system"` and `content` is valid JSON with a `type` field
 *   equal to `"compaction"`, the line represents a compaction event.
 * - CompactionRecord fields: `{ id, type, conversation_id, timestamp, trigger,
 *   token_count_at_compaction, summary_token_count, messages_before, messages_after }`.
 *
 * ### Backward compatibility
 *
 * All Phase 3 fields are defined as optional (`?`) on the Message interface.
 * Older JSONL files written before Phase 3 will parse correctly — missing
 * fields default to `undefined` which is treated identically to `null` by
 * all consuming code. No migration is required.
 *
 * @see specs/01-mvp/data-model.md — JSONL Message Schema (Phase 1)
 * @see specs/02-context-intelligence/data-model.md — Phase 3 extensions
 * @see specs/01-mvp/spec.md — FR-19
 */

import type { Vault } from "obsidian";
import type { Conversation, Message } from "../types";
import type { CompactionRecord } from "../context/compaction";
import { logger } from "../utils/logger";

const log = logger("HistoryManager");

/** Metadata about a persisted conversation for listing purposes. */
export interface ConversationListEntry {
	id: string;
	title?: string;
	updated_at: string;
	created_at: string;
	preview?: string;
	provider_id: string;
	model_id: string;
	filename: string;
}

/**
 * Manages JSONL-based conversation persistence.
 *
 * Each conversation is stored as a single JSONL file where each line
 * is a JSON-serialized Message object. The first line is a metadata
 * header containing the Conversation object itself.
 *
 * File naming: `{timestamp}_{id}.jsonl`
 */
export class HistoryManager {
	/**
	 * Per-file write queue. All mutations to a given JSONL file are
	 * serialized through a promise chain stored here, keyed by the
	 * vault-relative file path. This prevents read-modify-write races
	 * between concurrent appendMessage / updateConversationHeader calls.
	 */
	private readonly writeQueues = new Map<string, Promise<void>>();

	constructor(
		private readonly vault: Vault,
		private historyPath: string,
		private maxSizeMb: number,
		private maxAgeDays: number
	) {}

	// -----------------------------------------------------------------------
	// Configuration
	// -----------------------------------------------------------------------

	/** Update history settings (e.g., after settings change). */
	updateSettings(historyPath: string, maxSizeMb: number, maxAgeDays: number): void {
		this.historyPath = historyPath;
		this.maxSizeMb = maxSizeMb;
		this.maxAgeDays = maxAgeDays;
	}

	// -----------------------------------------------------------------------
	// Write operations
	// -----------------------------------------------------------------------

	// -----------------------------------------------------------------------
	// Write queue helpers
	// -----------------------------------------------------------------------

	/**
	 * Enqueue a write operation for a specific file path.
	 *
	 * All callers that write to the same file are serialized through this
	 * queue so that concurrent read-modify-write operations never interleave.
	 */
	private enqueueWrite(filePath: string, operation: () => Promise<void>): Promise<void> {
		const current = this.writeQueues.get(filePath) ?? Promise.resolve();
		const next = current.then(operation, operation); // always advance even on error
		this.writeQueues.set(filePath, next);
		// Prevent unbounded memory growth: remove the entry once the chain settles
		next.finally(() => {
			if (this.writeQueues.get(filePath) === next) {
				this.writeQueues.delete(filePath);
			}
		});
		return next;
	}

	// -----------------------------------------------------------------------
	// Write operations
	// -----------------------------------------------------------------------

	/**
	 * Create a new JSONL file for a conversation.
	 *
	 * Writes the conversation metadata as the first line (header).
	 */
	async createConversationFile(conversation: Conversation): Promise<void> {
		const filename = this.getFilename(conversation);
		const filePath = this.getFilePath(filename);

		await this.ensureDirectory();

		return this.enqueueWrite(filePath, async () => {
			const headerLine = JSON.stringify({
				_type: "conversation",
				...conversation,
			});

			// Use adapter for direct file access (JSONL files are not vault notes)
			await this.vault.adapter.write(filePath, headerLine + "\n");

			log.info("Created conversation file", {
				id: conversation.id,
				path: filePath,
			});
		});
	}

	/**
	 * Append a message to the conversation's JSONL file.
	 *
	 * Messages are appended line-by-line as they occur (not batched).
	 */
	async appendMessage(conversation: Conversation, message: Message): Promise<void> {
		const filename = this.getFilename(conversation);
		const filePath = this.getFilePath(filename);

		const line = JSON.stringify({
			_type: "message",
			...message,
		});

		return this.enqueueWrite(filePath, async () => {
			try {
				const existing = await this.vault.adapter.read(filePath);
				await this.vault.adapter.write(filePath, existing + line + "\n");
			} catch {
				// File doesn't exist yet — create it with header + message
				log.warn("Conversation file not found, creating", { path: filePath });
				const headerLine = JSON.stringify({
					_type: "conversation",
					...conversation,
				});
				await this.vault.adapter.write(filePath, headerLine + "\n" + line + "\n");
			}
		});
	}

	/**
	 * Update the conversation header in the JSONL file.
	 *
	 * Rewrites the first line with updated metadata (e.g., title, token counts).
	 */
	async updateConversationHeader(conversation: Conversation): Promise<void> {
		const filename = this.getFilename(conversation);
		const filePath = this.getFilePath(filename);

		return this.enqueueWrite(filePath, async () => {
			try {
				const content = await this.vault.adapter.read(filePath);
				const lines = content.split("\n");

				// Replace the first line (header)
				lines[0] = JSON.stringify({
					_type: "conversation",
					...conversation,
				});

				await this.vault.adapter.write(filePath, lines.join("\n"));
			} catch (e) {
				log.warn("Failed to update conversation header", {
					id: conversation.id,
					error: String(e),
				});
			}
		});
	}

	// -----------------------------------------------------------------------
	// Read operations
	// -----------------------------------------------------------------------

	/**
	 * Load a conversation and all its messages from a JSONL file.
	 *
	 * Phase 3 fields (`auto_context`, `attachments`, `hook_injections`)
	 * are preserved if present. Older files without these fields parse
	 * correctly — missing optional fields remain `undefined`.
	 */
	async loadConversation(filename: string): Promise<{
		conversation: Conversation;
		messages: Message[];
	}> {
		const path = this.getFilePath(filename);
		const content = await this.vault.adapter.read(path);
		const lines = content.split("\n").filter((l) => l.trim().length > 0);

		const firstLine = lines[0];
		if (!firstLine || lines.length === 0) {
			throw new Error(`Empty conversation file: ${path}`);
		}

		// Parse header (first line)
		const headerObj = JSON.parse(firstLine);
		if (headerObj._type !== "conversation") {
			throw new Error(`Invalid conversation header in: ${path}`);
		}

		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { _type: _headerType, ...conversationData } = headerObj;
		const conversation = conversationData as Conversation;

		// Parse messages (remaining lines)
		const messages: Message[] = [];
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			try {
				const obj = JSON.parse(line);
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				const { _type: _msgType, ...messageData } = obj;
				messages.push(messageData as Message);
			} catch (e) {
				log.warn("Failed to parse message line", {
					file: filename,
					line: i,
					error: String(e),
				});
			}
		}

		return { conversation, messages };
	}

	/**
	 * Append a CompactionRecord to the conversation's JSONL file.
	 *
	 * Compaction records are written as system messages with the serialized
	 * CompactionRecord as the content field. This preserves the append-only
	 * JSONL structure while recording the compaction event at the correct
	 * chronological position in the conversation history.
	 */
	async appendCompactionRecord(
		conversation: Conversation,
		record: CompactionRecord
	): Promise<void> {
		const message: Message = {
			id: record.id,
			conversation_id: conversation.id,
			role: "system",
			content: JSON.stringify(record),
			timestamp: record.timestamp,
		};
		await this.appendMessage(conversation, message);

		log.info("Appended compaction record", {
			conversationId: conversation.id,
			recordId: record.id,
			trigger: record.trigger,
			tokensBefore: record.token_count_at_compaction,
		});
	}

	/**
	 * Check if a parsed message line is a CompactionRecord.
	 *
	 * Returns the deserialized CompactionRecord if so, or null otherwise.
	 */
	static parseCompactionRecord(message: Message): CompactionRecord | null {
		if (message.role !== "system") return null;
		try {
			const parsed = JSON.parse(message.content);
			if (parsed && parsed.type === "compaction") {
				return parsed as CompactionRecord;
			}
		} catch {
			// Not JSON or not a compaction record
		}
		return null;
	}

	/**
	 * List all conversations with metadata, ordered by most recent activity.
	 */
	async listConversations(): Promise<ConversationListEntry[]> {
		await this.ensureDirectory();

		const entries: ConversationListEntry[] = [];
		const files = await this.vault.adapter.list(this.normalizePath(this.historyPath));

		for (const file of files.files) {
			if (!file.endsWith(".jsonl")) continue;

			try {
				const content = await this.vault.adapter.read(file);
				const firstNewline = content.indexOf("\n");
				const headerLine = firstNewline >= 0 ? content.substring(0, firstNewline) : content;

				if (!headerLine.trim()) continue;

				const headerObj = JSON.parse(headerLine) as Record<string, unknown>;
				if (headerObj._type !== "conversation") continue;

				const convId = headerObj.id as string | undefined;
				const convUpdatedAt = headerObj.updated_at as string | undefined;
				const convCreatedAt = headerObj.created_at as string | undefined;
				const convProviderId = headerObj.provider_id as string | undefined;
				const convModelId = headerObj.model_id as string | undefined;

				if (!convId || !convUpdatedAt || !convCreatedAt || !convProviderId || !convModelId) {
					continue;
				}

				// Extract first user message as preview
				let preview: string | undefined;
				const contentLines = content.split("\n");
				for (let i = 1; i < contentLines.length; i++) {
					const msgLine = contentLines[i];
					if (!msgLine || !msgLine.trim()) continue;
					try {
						const msg = JSON.parse(msgLine) as Record<string, unknown>;
						if (msg.role === "user" && typeof msg.content === "string") {
							preview = (msg.content as string).substring(0, 120);
							break;
						}
					} catch {
						// skip malformed lines
					}
				}

				const filename = file.split("/").pop() ?? file;

				entries.push({
					id: convId,
					title: headerObj.title as string | undefined,
					updated_at: convUpdatedAt,
					created_at: convCreatedAt,
					preview,
					provider_id: convProviderId,
					model_id: convModelId,
					filename,
				});
			} catch (e) {
				log.warn("Failed to read conversation header", {
					file,
					error: String(e),
				});
			}
		}

		// Sort by most recent activity (newest first)
		entries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

		return entries;
	}

	// -----------------------------------------------------------------------
	// Retention policy
	// -----------------------------------------------------------------------

	/**
	 * Enforce retention policy: prune by max size and max age.
	 *
	 * Deletes oldest conversations when limits are exceeded.
	 */
	async enforceRetention(): Promise<void> {
		const entries = await this.listConversations();

		if (entries.length === 0) return;

		const now = Date.now();
		const maxAgeMs = this.maxAgeDays * 24 * 60 * 60 * 1000;
		const maxSizeBytes = this.maxSizeMb * 1024 * 1024;

		// Prune by age first (entries are newest-first)
		const toPruneByAge: ConversationListEntry[] = [];
		for (const entry of entries) {
			const age = now - new Date(entry.updated_at).getTime();
			if (age > maxAgeMs) {
				toPruneByAge.push(entry);
			}
		}

		for (const entry of toPruneByAge) {
			await this.deleteConversationFile(entry.filename);
		}

		// Prune by total size (oldest first)
		let totalSize = 0;
		const remaining = entries.filter(
			(e) => !toPruneByAge.some((p) => p.id === e.id)
		);

		const toPruneBySize: ConversationListEntry[] = [];

		// Calculate total size
		for (const entry of remaining) {
			try {
				const path = this.getFilePath(entry.filename);
				const stat = await this.vault.adapter.stat(path);
				if (stat) {
					totalSize += stat.size;
				}
			} catch {
				// skip
			}
		}

		// If over limit, remove oldest until under
		if (totalSize > maxSizeBytes) {
			// Work from oldest to newest
			const oldestFirst = [...remaining].reverse();
			for (const entry of oldestFirst) {
				if (totalSize <= maxSizeBytes) break;

				try {
					const filePath = this.getFilePath(entry.filename);
					const fileStat = await this.vault.adapter.stat(filePath);
					if (fileStat && fileStat.size != null) {
						totalSize -= fileStat.size;
						toPruneBySize.push(entry);
					}
				} catch {
					// skip
				}
			}

			for (const entry of toPruneBySize) {
				await this.deleteConversationFile(entry.filename);
			}
		}

		const totalPruned = toPruneByAge.length + toPruneBySize.length;
		if (totalPruned > 0) {
			log.info("Enforced retention policy", {
				prunedByAge: toPruneByAge.length,
				prunedBySize: toPruneBySize.length,
			});
		}
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	/** Generate the filename for a conversation JSONL file. */
	private getFilename(conversation: Conversation): string {
		// Use created_at timestamp (compact format) + ID
		const ts = conversation.created_at
			.replace(/[-:]/g, "")
			.replace("T", "_")
			.replace(/\.\d+Z$/, "Z")
			.replace("Z", "");
		return `${ts}_${conversation.id}.jsonl`;
	}

	/** Get the full vault-relative path for a history file. */
	private getFilePath(filename: string): string {
		return this.normalizePath(`${this.historyPath}${filename}`);
	}

	/** Normalize a path (remove trailing slashes, handle double slashes). */
	private normalizePath(path: string): string {
		return path.replace(/\/+/g, "/").replace(/\/$/, "");
	}

	/** Ensure the history directory exists. */
	private async ensureDirectory(): Promise<void> {
		const dir = this.normalizePath(this.historyPath);
		const exists = await this.vault.adapter.exists(dir);
		if (!exists) {
			await this.vault.adapter.mkdir(dir);
			log.info("Created history directory", { path: dir });
		}
	}

	/** Delete a conversation file. */
	private async deleteConversationFile(filename: string): Promise<void> {
		const path = this.getFilePath(filename);
		try {
			await this.vault.adapter.remove(path);
			log.info("Deleted conversation file", { path });
		} catch (e) {
			log.warn("Failed to delete conversation file", {
				path,
				error: String(e),
			});
		}
	}
}