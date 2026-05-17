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

import { normalizePath, type Vault } from "obsidian";
import type { Conversation, Message } from "../types";
import type { CompactionRecord } from "../context/compaction";
import { isSubAgentFilename } from "./sub-agent-history";
import { logger } from "../utils/logger";
import type { ContentBlock } from "../media/types";
import { getTextContent } from "../media/types";

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
	/** Parent conversation ID when this entry is a fork. */
	forked_from_conversation_id?: string;
	/** Whether this conversation is marked as a favorite. */
	is_favorite?: boolean;
	/** Preset name active when conversation was created. */
	preset_name?: string;
}

/** Generate the JSONL filename for a conversation from its created_at + id. */
export function conversationFilename(conversation: { created_at: string; id: string }): string {
	const ts = conversation.created_at
		.replace(/[-:]/g, "")
		.replace("T", "_")
		.replace(/\.\d+Z$/, "Z")
		.replace("Z", "");
	return `${ts}_${conversation.id}.jsonl`;
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
		void next.finally(() => {
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
	 * Append a stale state snapshot to the conversation's JSONL file.
	 * Written as a `_type: "stale_state"` line, skipped by loadConversation().
	 */
	async appendStaleState(
		conversation: Conversation,
		entries: Array<{ note_path: string; body_hash: string; timestamp: string }>,
	): Promise<void> {
		if (entries.length === 0) return;

		const filename = this.getFilename(conversation);
		const filePath = this.getFilePath(filename);

		const line = JSON.stringify({
			_type: "stale_state",
			entries,
			written_at: new Date().toISOString(),
		});

		return this.enqueueWrite(filePath, async () => {
			try {
				const existing = await this.vault.adapter.read(filePath);
				await this.vault.adapter.write(filePath, existing + line + "\n");
			} catch {
				log.warn("Failed to append stale state", {
					conversationId: conversation.id,
				});
			}
		});
	}

	/**
	 * Extract the most recent stale_state entries from raw JSONL content.
	 * Returns null if none exists (backward-compatible with older files).
	 */
	static extractStaleState(
		rawContent: string,
	): Array<{ note_path: string; body_hash: string; timestamp: string }> | null {
		const lines = rawContent.split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line?.trim()) continue;
			try {
				const obj = JSON.parse(line);
				if (obj._type === "stale_state") {
					return obj.entries;
				}
			} catch {
				// skip
			}
		}
		return null;
	}

	/**
	 * Append a message to a conversation by ID, without requiring it to be active.
	 *
	 * Resolves the conversation ID to a JSONL filename via listConversations(),
	 * loads the conversation header, then appends the message. Involves a directory
	 * scan — acceptable for non-hot-path use (e.g. detached sub-agent onComplete).
	 *
	 * Returns the created Message, or null if the conversation doesn't exist.
	 */
	async addMessageToConversation(
		conversationId: string,
		params: {
			role: Message["role"];
			content: Message["content"];
			source_extension?: string | null;
			exclude_from_compaction?: boolean;
		}
	): Promise<Message | null> {
		const entries = await this.listConversations();
		const match = entries.find((e) => e.id === conversationId);
		if (!match) return null;

		const { conversation } = await this.loadConversation(match.filename);

		const message: Message = {
			id: crypto.randomUUID(),
			conversation_id: conversationId,
			role: params.role,
			content: params.content,
			timestamp: new Date().toISOString(),
			source_extension: params.source_extension ?? null,
			exclude_from_compaction: params.exclude_from_compaction ?? false,
		};

		await this.appendMessage(conversation, message);
		return message;
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

	/**
	 * Persist an unsent draft text into the conversation's JSONL header.
	 *
	 * Pass null to clear a previously saved draft.
	 */
	async saveDraft(conversation: Conversation, text: string | null): Promise<void> {
		conversation.draft_text = text || null;
		await this.updateConversationHeader(conversation);
	}

	/**
	 * Toggle the `is_favorite` flag on a conversation's JSONL header.
	 *
	 * Returns the new value of `is_favorite` after toggling.
	 */
	async toggleFavorite(filename: string): Promise<boolean> {
		const filePath = normalizePath(`${this.historyPath}/${filename}`);
		let newValue = false;

		await this.enqueueWrite(filePath, async () => {
			try {
				const content = await this.vault.adapter.read(filePath);
				const firstNewline = content.indexOf("\n");
				const headerLine = firstNewline >= 0 ? content.substring(0, firstNewline) : content;
				const rest = firstNewline >= 0 ? content.substring(firstNewline) : "";
				const headerObj = JSON.parse(headerLine) as Record<string, unknown>;
				newValue = !headerObj.is_favorite;
				if (newValue) {
					headerObj.is_favorite = true;
				} else {
					delete headerObj.is_favorite;
				}
				await this.vault.adapter.write(filePath, JSON.stringify(headerObj) + rest);
			} catch (e) {
				log.warn("Failed to toggle favorite", {
					filename,
					error: String(e),
				});
			}
		});

		return newValue;
	}

	/**
	 * Import a full conversation (header + messages) as a single batch write.
	 *
	 * Used when importing a conversation from an exported HTML file.
	 * Returns the generated filename so the caller can immediately switch to it.
	 */
	async importConversation(
		conversation: Conversation,
		messages: Message[]
	): Promise<string> {
		const filename = this.getFilename(conversation);
		const filePath = this.getFilePath(filename);

		await this.ensureDirectory();

		return this.enqueueWrite(filePath, async () => {
			const lines: string[] = [];

			lines.push(JSON.stringify({ _type: "conversation", ...conversation }));

			for (const msg of messages) {
				lines.push(JSON.stringify({ _type: "message", ...msg }));
			}

			await this.vault.adapter.write(filePath, lines.join("\n") + "\n");

			log.info("Imported conversation", {
				id: conversation.id,
				messageCount: messages.length,
				path: filePath,
			});
		}).then(() => filename);
	}

	/**
	 * Write a sub-agent conversation to a JSONL file with a specific filename.
	 *
	 * Sub-agent files use the naming convention:
	 * `{parent_timestamp}_{parent_id}_subagent_{invocation_id}.jsonl`
	 *
	 * The header line uses `_type: "sub_agent_conversation"` so that
	 * `listConversations()` naturally skips them (it checks for
	 * `_type === "conversation"`). The `isSubAgentFilename()` check
	 * provides an additional filter.
	 *
	 * @see specs/ZZ-misc/sub-agents-design.md — Section 5.1
	 */
	async writeSubAgentConversation(
		filename: string,
		metadata: {
			id: string;
			parent_conversation_id: string;
			sub_agent_name: string;
			provider_id: string;
			model_id: string;
			total_input_tokens: number;
			total_output_tokens: number;
			iteration_count: number;
			stop_reason: string;
			created_at: string;
		},
		messages: Message[],
	): Promise<void> {
		const filePath = this.getFilePath(filename);

		await this.ensureDirectory();

		return this.enqueueWrite(filePath, async () => {
			const lines: string[] = [];

			lines.push(JSON.stringify({
				_type: "sub_agent_conversation",
				...metadata,
			}));

			for (const msg of messages) {
				lines.push(JSON.stringify({ _type: "message", ...msg }));
			}

			await this.vault.adapter.write(filePath, lines.join("\n") + "\n");

			log.info("Wrote sub-agent conversation", {
				id: metadata.id,
				parent: metadata.parent_conversation_id,
				subAgent: metadata.sub_agent_name,
				messageCount: messages.length,
				path: filePath,
			});
		});
	}

	/**
	 * Load a sub-agent conversation's messages from a JSONL file.
	 *
	 * Returns just the messages (not the header metadata) for use in
	 * HTML export rendering.
	 *
	 * @see specs/ZZ-misc/sub-agents-design.md — Section 5.3
	 */
	async loadSubAgentMessages(filename: string): Promise<Message[]> {
		const path = this.getFilePath(filename);
		const content = await this.vault.adapter.read(path);
		const lines = content.split("\n").filter((l) => l.trim().length > 0);

		const messages: Message[] = [];
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			try {
				const obj = JSON.parse(line);
				if (obj._type && obj._type !== "message") continue;
				const { _type: _msgType, ...messageData } = obj;
				messages.push(messageData as Message);
			} catch (e) {
				log.warn("Failed to parse sub-agent message line", {
					file: filename,
					line: i,
					error: String(e),
				});
			}
		}

		return messages;
	}

	// -----------------------------------------------------------------------
	// Read operations
	// -----------------------------------------------------------------------

	/**
	 * Read raw JSONL file content for a conversation filename.
	 * Used by external callers that need to inspect non-message line types.
	 */
	async readRawFile(filename: string): Promise<string> {
		const path = this.getFilePath(filename);
		return this.vault.adapter.read(path);
	}

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

		const { _type: _headerType, ...conversationData } = headerObj;
		const conversation = conversationData as Conversation;

		// Parse messages (remaining lines — skip non-message line types like stale_state)
		const messages: Message[] = [];
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			try {
				const obj = JSON.parse(line);
				if (obj._type && obj._type !== "message") continue;
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
		if (typeof message.content !== "string") return null;
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
		const files = await this.vault.adapter.list(normalizePath(this.historyPath));

		for (const file of files.files) {
			if (!file.endsWith(".jsonl")) continue;

			// Skip sub-agent conversation files (Phase 6)
			const fname = file.split("/").pop() ?? file;
			if (isSubAgentFilename(fname)) continue;

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
						if (msg.role === "user") {
							if (typeof msg.content === "string") {
								preview = msg.content.substring(0, 120);
								break;
							} else if (Array.isArray(msg.content)) {
								preview = getTextContent(msg.content as ContentBlock[]).substring(0, 120);
								break;
							}
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
					forked_from_conversation_id: headerObj.forked_from_conversation_id as string | undefined,
					is_favorite: !!headerObj.is_favorite,
					preset_name: headerObj.preset_name as string | undefined,
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

	/**
	 * Search conversations by matching query against title, preview, and
	 * full message content. Returns matching entries ordered by most recent
	 * activity.
	 */
	async searchConversations(query: string): Promise<ConversationListEntry[]> {
		if (!query.trim()) {
			return this.listConversations();
		}

		await this.ensureDirectory();

		const needle = query.toLowerCase();
		const entries: ConversationListEntry[] = [];
		const files = await this.vault.adapter.list(normalizePath(this.historyPath));

		for (const file of files.files) {
			if (!file.endsWith(".jsonl")) continue;

			// Skip sub-agent conversation files (Phase 6)
			const fname = file.split("/").pop() ?? file;
			if (isSubAgentFilename(fname)) continue;

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

				// Check if title matches
				const title = headerObj.title as string | undefined;
				let matched = !!title && title.toLowerCase().includes(needle);

				// Check message content for matches
				let preview: string | undefined;
				const contentLines = content.split("\n");
				for (let i = 1; i < contentLines.length; i++) {
					const msgLine = contentLines[i];
					if (!msgLine || !msgLine.trim()) continue;
					try {
						const msg = JSON.parse(msgLine) as Record<string, unknown>;
						if (msg.role === "user" && !preview) {
							if (typeof msg.content === "string") {
								preview = msg.content.substring(0, 120);
							} else if (Array.isArray(msg.content)) {
								preview = getTextContent(msg.content as ContentBlock[]).substring(0, 120);
							}
						}
						if (!matched) {
							if (typeof msg.content === "string" && msg.content.toLowerCase().includes(needle)) {
								matched = true;
							} else if (Array.isArray(msg.content) && getTextContent(msg.content as ContentBlock[]).toLowerCase().includes(needle)) {
								matched = true;
							}
						}
					} catch {
						// skip malformed lines
					}
					// Once we have both preview and a match, stop scanning
					if (preview && matched) break;
				}

				if (!matched) continue;

				const filename = file.split("/").pop() ?? file;

				entries.push({
					id: convId,
					title,
					updated_at: convUpdatedAt,
					created_at: convCreatedAt,
					preview,
					provider_id: convProviderId,
					model_id: convModelId,
					filename,
					forked_from_conversation_id: headerObj.forked_from_conversation_id as string | undefined,
					is_favorite: !!headerObj.is_favorite,
					preset_name: headerObj.preset_name as string | undefined,
				});
			} catch (e) {
				log.warn("Failed to search conversation", {
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

		// Prune by age first (entries are newest-first).
		// Favorited conversations are always exempt from retention pruning.
		const toPruneByAge: ConversationListEntry[] = [];
		for (const entry of entries) {
			if (entry.is_favorite) continue;
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

		// If over limit, remove oldest until under (skip favorites)
		if (totalSize > maxSizeBytes) {
			// Work from oldest to newest
			const oldestFirst = [...remaining].reverse();
			for (const entry of oldestFirst) {
				if (totalSize <= maxSizeBytes) break;
				if (entry.is_favorite) continue;

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
				favoritesProtected: entries.filter((e) => e.is_favorite).length,
			});
		}
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	/** Generate the filename for a conversation JSONL file. */
	private getFilename(conversation: Conversation): string {
		return conversationFilename(conversation);
	}

	/** Get the full vault-relative path for a history file. */
	private getFilePath(filename: string): string {
		return normalizePath(`${this.historyPath}${filename}`);
	}

	/** Ensure the history directory exists. */
	private async ensureDirectory(): Promise<void> {
		const dir = normalizePath(this.historyPath);
		const exists = await this.vault.adapter.exists(dir);
		if (!exists) {
			await this.vault.adapter.mkdir(dir);
			log.info("Created history directory", { path: dir });
		}
	}

	// -----------------------------------------------------------------------
	// Flush operations
	// -----------------------------------------------------------------------

	/**
	 * Await all pending write queues (best-effort).
	 *
	 * Returns when every in-flight enqueueWrite chain has settled.
	 * Safe to call when no writes are pending (returns immediately).
	 * Use for plugin unload where all writes must drain.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 5.1
	 */
	async flush(): Promise<void> {
		const pending = Array.from(this.writeQueues.values());
		if (pending.length > 0) {
			await Promise.allSettled(pending);
		}
	}

	/**
	 * Await pending writes for a specific conversation's JSONL file (best-effort).
	 *
	 * More precise than flush() — only blocks on writes for the given conversation,
	 * avoiding cross-conversation blocking where a slow write for conversation Y
	 * would delay cleanup of conversation X.
	 *
	 * @param conversation - The conversation whose JSONL writes to drain.
	 *   The conversation object is required (not just the ID) because the
	 *   filename encodes both `created_at` and `id`. The writeQueues Map is
	 *   keyed by file path, so we need the full conversation to resolve the path.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 5.1
	 */
	async flushConversation(conversation: Conversation): Promise<void> {
		const filename = this.getFilename(conversation);
		const filePath = this.getFilePath(filename);
		const pending = this.writeQueues.get(filePath);
		if (pending) {
			await pending;
		}
	}

	/** Delete a conversation file. */
	async deleteConversationFile(filename: string): Promise<void> {
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