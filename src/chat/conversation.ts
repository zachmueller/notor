/**
 * Conversation manager — core conversation state management.
 *
 * Creates, loads, and manages in-memory conversation state.
 * Handles message addition, token/cost tracking, mode management,
 * and auto-generation of conversation titles.
 *
 * @see specs/01-mvp/data-model.md — Conversation, Message entities
 * @see specs/01-mvp/spec.md — FR-4, FR-14, FR-19
 */

import type { Conversation, ConversationMode, Message, MessageRole, TaskItem, ToolCall, ToolResult } from "../types";
import { logger } from "../utils/logger";
import type { ContentBlock } from "../media/types";
import { getTextContent } from "../media/types";
import { estimateConversationTokens } from "../context/compaction";

const log = logger("ConversationManager");

/** Generate a UUID v4 string. */
function generateId(): string {
	return crypto.randomUUID();
}

/** Maximum length for auto-generated titles. */
const MAX_TITLE_LENGTH = 80;

/**
 * Manages in-memory conversation state for the active conversation
 * and provides operations for creating, switching, and querying
 * conversations.
 */
export class ConversationManager {
	/** The currently active conversation, or null if none. */
	private activeConversation: Conversation | null = null;

	/** Messages for the active conversation, ordered chronologically. */
	private messages: Message[] = [];

	/** Callback invoked when a message is added (for persistence, UI updates). */
	private onMessageAdded?: (message: Message) => void | Promise<void>;

	/** Callback invoked when a message is updated in-memory (for UI re-render, no JSONL write). */
	private onMessageUpdated?: (message: Message) => void | Promise<void>;

	/** Callback invoked when the conversation metadata changes. */
	private onConversationChanged?: (conversation: Conversation) => void | Promise<void>;

	/** Callback invoked specifically when the conversation title is set programmatically. */
	private onTitleChanged?: (conversationId: string, title: string) => void;

	constructor(
		private defaultMode: ConversationMode = "plan"
	) {}

	// -----------------------------------------------------------------------
	// Event handlers
	// -----------------------------------------------------------------------

	/** Register a callback for when a message is added. */
	setOnMessageAdded(callback: (message: Message) => void | Promise<void>): void {
		this.onMessageAdded = callback;
	}

	/** Register a callback for when a message is updated in-memory (no JSONL write). */
	setOnMessageUpdated(callback: (message: Message) => void | Promise<void>): void {
		this.onMessageUpdated = callback;
	}

	/** Register a callback for when conversation metadata changes. */
	setOnConversationChanged(callback: (conversation: Conversation) => void | Promise<void>): void {
		this.onConversationChanged = callback;
	}

	/** Register a callback for when the conversation title is changed programmatically. */
	setOnTitleChanged(callback: (conversationId: string, title: string) => void): void {
		this.onTitleChanged = callback;
	}

	// -----------------------------------------------------------------------
	// Conversation lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Create a new conversation.
	 *
	 * @param providerId - The active provider type
	 * @param modelId - The active model ID
	 * @param mode - Optional mode override (defaults to plugin setting)
	 * @param workflowMetadata - Optional workflow metadata for workflow conversations (E-013)
	 */
	createConversation(
		providerId: string,
		modelId: string,
		mode?: ConversationMode,
		workflowMetadata?: {
			workflow_path?: string | null;
			workflow_name?: string | null;
			workflow_tool_configs?: import("../tool-config/types").ParsedToolConfig[] | null;
			persona_name?: string | null;
			is_background?: boolean;
			title?: string;
			use_extended_context?: boolean;
			preset_name?: string | null;
		}
	): Conversation {
		const now = new Date().toISOString();
		const conversation: Conversation = {
			id: generateId(),
			created_at: now,
			updated_at: now,
			provider_id: providerId,
			model_id: modelId,
			total_input_tokens: 0,
			total_output_tokens: 0,
			estimated_cost: null,
			mode: mode ?? this.defaultMode,
			// Preset name tracking
			...(workflowMetadata?.preset_name !== undefined && {
				preset_name: workflowMetadata.preset_name,
			}),
			// Workflow metadata (E-013) — undefined fields are omitted from JSONL
			...(workflowMetadata?.workflow_path !== undefined && {
				workflow_path: workflowMetadata.workflow_path,
			}),
			...(workflowMetadata?.workflow_name !== undefined && {
				workflow_name: workflowMetadata.workflow_name,
			}),
			...(workflowMetadata?.workflow_tool_configs !== undefined && {
				workflow_tool_configs: workflowMetadata.workflow_tool_configs,
			}),
			...(workflowMetadata?.persona_name !== undefined && {
				persona_name: workflowMetadata.persona_name,
			}),
			...(workflowMetadata?.is_background !== undefined && {
				is_background: workflowMetadata.is_background,
			}),
			...(workflowMetadata?.title !== undefined && {
				title: workflowMetadata.title,
			}),
			...(workflowMetadata?.use_extended_context && {
				use_extended_context: workflowMetadata.use_extended_context,
			}),
		};

		this.activeConversation = conversation;
		this.messages = [];

		log.info("Created new conversation", {
			id: conversation.id,
			provider: providerId,
			model: modelId,
			mode: conversation.mode,
		});

		void this.onConversationChanged?.(conversation);
		return conversation;
	}

	/**
	 * Load an existing conversation and its messages into memory.
	 *
	 * Used when switching to a past conversation loaded from history.
	 *
	 * @param opts.silent - When true, skip the `onConversationChanged` callback.
	 *   Used during sync-back from an active session to prevent mid-stream
	 *   token count writes to the JSONL header — the session's own
	 *   ConversationManager is the authoritative header writer.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 2, Step 2b
	 */
	loadConversation(conversation: Conversation, messages: Message[], opts?: { silent?: boolean }): void {
		this.activeConversation = { ...conversation };
		this.messages = [...messages];

		log.info("Loaded conversation", {
			id: conversation.id,
			messageCount: messages.length,
		});

		if (!opts?.silent) {
			void this.onConversationChanged?.(this.activeConversation);
		}
	}

	/**
	 * Prepare a forked conversation by slicing messages up to (and including)
	 * the given fork-point message. Does NOT persist or switch — the caller
	 * is responsible for that.
	 *
	 * If the fork-point message is a `tool_call`, the immediately following
	 * `tool_result` whose `tool_call_id` matches is auto-included so the
	 * forked conversation is never left with an unpaired tool call.
	 *
	 * @returns Fork data, or `null` if the fork-point message was not found.
	 */
	prepareFork(
		forkAtMessageId: string,
		currentProviderId: string,
		currentModelId: string,
		currentMode: ConversationMode,
	): { conversation: Conversation; messages: Message[] } | null {
		if (!this.activeConversation) return null;

		// --- Locate fork-point index ---
		const forkIdx = this.messages.findIndex((m) => m.id === forkAtMessageId);
		if (forkIdx === -1) return null;

		// --- Slice messages up to fork point (inclusive) ---
		let endIdx = forkIdx;

		// Auto-pair: if fork-point is a tool_call, include the paired tool_result
		const forkMsg = this.messages[forkIdx]!;
		if (forkMsg.role === "tool_call" && forkMsg.tool_call) {
			const expectedId = forkMsg.tool_call.id ?? forkMsg.id;
			const next = this.messages[forkIdx + 1];
			if (next?.role === "tool_result" && next.tool_result?.tool_call_id === expectedId) {
				endIdx = forkIdx + 1;
			}
		}

		const slicedMessages = this.messages.slice(0, endIdx + 1);

		// --- Build new conversation object ---
		const now = new Date().toISOString();
		const newId = generateId();
		const parent = this.activeConversation;

		// Title: strip existing "Fork of " prefix to prevent accumulation
		const baseTitle = parent.title
			? parent.title.replace(/^Fork of /, "")
			: parent.id.substring(0, 8);
		const title = `Fork of ${baseTitle}`;

		// Re-sum token/cost from sliced messages only
		let totalInput = 0;
		let totalOutput = 0;
		let estimatedCost: number | null = null;
		for (const m of slicedMessages) {
			if (m.input_tokens) totalInput += m.input_tokens;
			if (m.output_tokens) totalOutput += m.output_tokens;
			// Include sub-agent token usage (not stored on input_tokens/output_tokens)
			const subTokens = m.tool_result?.sub_agent_metadata?.token_usage;
			if (subTokens) {
				totalInput += subTokens.input;
				totalOutput += subTokens.output;
			}
			if (m.cost_estimate != null) {
				estimatedCost = (estimatedCost ?? 0) + m.cost_estimate;
			}
		}

		const conversation: Conversation = {
			id: newId,
			created_at: now,
			updated_at: now,
			title,
			provider_id: currentProviderId,
			model_id: currentModelId,
			total_input_tokens: totalInput,
			total_output_tokens: totalOutput,
			estimated_cost: estimatedCost,
			mode: currentMode,
			// Workflow metadata from parent
			...(parent.workflow_path !== undefined && { workflow_path: parent.workflow_path }),
			...(parent.workflow_name !== undefined && { workflow_name: parent.workflow_name }),
			...(parent.workflow_tool_configs !== undefined && { workflow_tool_configs: parent.workflow_tool_configs }),
			...(parent.workflow_deactivated !== undefined && { workflow_deactivated: parent.workflow_deactivated }),
			...(parent.persona_name !== undefined && { persona_name: parent.persona_name }),
			is_background: false,
			...(parent.use_extended_context && { use_extended_context: parent.use_extended_context }),
			// Fork provenance
			forked_from_conversation_id: parent.id,
			forked_from_message_id: forkAtMessageId,
		};

		// --- Assign fresh IDs to messages ---
		const newMessages: Message[] = slicedMessages.map((m) => ({
			...m,
			id: generateId(),
			conversation_id: newId,
		}));

		log.info("Prepared fork", {
			parentId: parent.id,
			forkAtMessageId,
			newId,
			messageCount: newMessages.length,
		});

		return { conversation, messages: newMessages };
	}

	/**
	 * Get the active conversation, or null if none.
	 */
	getActiveConversation(): Conversation | null {
		return this.activeConversation ? { ...this.activeConversation } : null;
	}

	/**
	 * Check if there is an active conversation.
	 */
	hasActiveConversation(): boolean {
		return this.activeConversation !== null;
	}

	/**
	 * Get the estimated current context window usage.
	 *
	 * Unlike header totals (which accumulate for billing), this returns
	 * the tokens currently counting toward the context window limit.
	 */
	getCurrentContextUsage(): { contextTokens: number } {
		if (!this.activeConversation || this.messages.length === 0) {
			return { contextTokens: 0 };
		}
		return { contextTokens: estimateConversationTokens(this.messages) };
	}

	// -----------------------------------------------------------------------
	// Message management
	// -----------------------------------------------------------------------

	/**
	 * Add a message to the active conversation.
	 *
	 * Updates conversation metadata (timestamps, token counts, cost).
	 * Auto-generates title from the first user message.
	 *
	 * @returns The created message
	 * @throws Error if no active conversation
	 */
	addMessage(params: {
		role: MessageRole;
		content: string | ContentBlock[];
		input_tokens?: number | null;
		output_tokens?: number | null;
		cost_estimate?: number | null;
		thinking?: string | null;
		thinking_duration_ms?: number | null;
		tool_call?: ToolCall | null;
		tool_result?: ToolResult | null;
		auto_context?: string | null;
		attachments?: Message["attachments"];
		hook_injections?: string[] | null;
		is_hook_injection?: boolean;
		/** Whether this is the opening workflow message (E-013). */
		is_workflow_message?: boolean;
		/** Extension name that produced this message (extension_block role only). */
		source_extension?: string | null;
		/** When true, block is excluded from compaction summarizer input. */
		exclude_from_compaction?: boolean;
		/**
		 * When true, skip firing onMessageAdded — message is added to the in-memory
		 * array but NOT persisted to JSONL. Used for transient loading placeholders.
		 */
		transient?: boolean;
	}): Message {
		if (!this.activeConversation) {
			throw new Error("No active conversation. Create or load one first.");
		}

		const message: Message = {
			id: generateId(),
			conversation_id: this.activeConversation.id,
			role: params.role,
			content: params.content,
			timestamp: new Date().toISOString(),
			input_tokens: params.input_tokens ?? null,
			output_tokens: params.output_tokens ?? null,
			cost_estimate: params.cost_estimate ?? null,
			thinking: params.thinking ?? null,
			thinking_duration_ms: params.thinking_duration_ms ?? null,
			// Clone tool_call so the persisted message is decoupled from the
			// caller's object. The dispatcher passes the same `parameters` object to
			// both the approval UI and tool.execute, and the approval UI mutates it
			// for partial-accept (see message-renderer.ts renderDiffApprovalPrompt);
			// without this clone that mutation would corrupt the saved parameters
			// used for fork/replay/compaction.
			tool_call: params.tool_call ? (JSON.parse(JSON.stringify(params.tool_call)) as ToolCall) : null,
			tool_result: params.tool_result ?? null,
			truncated: false,
			auto_context: params.auto_context ?? null,
			attachments: params.attachments ?? null,
			hook_injections: params.hook_injections ?? null,
			is_hook_injection: params.is_hook_injection,
			is_workflow_message: params.is_workflow_message,
			source_extension: params.source_extension ?? null,
			exclude_from_compaction: params.exclude_from_compaction ?? false,
		};

		this.messages.push(message);

		// Update conversation metadata
		this.activeConversation.updated_at = message.timestamp;

		// Track tokens
		if (message.input_tokens) {
			this.activeConversation.total_input_tokens += message.input_tokens;
		}
		if (message.output_tokens) {
			this.activeConversation.total_output_tokens += message.output_tokens;
		}

		// Track cost
		if (message.cost_estimate != null) {
			if (this.activeConversation.estimated_cost == null) {
				this.activeConversation.estimated_cost = message.cost_estimate;
			} else {
				this.activeConversation.estimated_cost += message.cost_estimate;
			}
		}

		// Auto-generate title from first user message (skip hook injections)
		if (
			params.role === "user" &&
			!params.is_hook_injection &&
			!this.activeConversation.title
		) {
			const titleText = getTextContent(params.content);
			this.activeConversation.title = this.generateTitle(titleText || "Image conversation");
			this.onTitleChanged?.(this.activeConversation.id, this.activeConversation.title);
		}

		log.debug("Added message", {
			id: message.id,
			role: message.role,
			conversationId: this.activeConversation.id,
		});

		if (!params.transient) {
			void this.onMessageAdded?.(message);
		}
		void this.onConversationChanged?.(this.activeConversation);

		return message;
	}

	/**
	 * Get all messages for the active conversation.
	 */
	getMessages(): Message[] {
		return [...this.messages];
	}

	/**
	 * Get the ordered message list suitable for sending to the LLM.
	 *
	 * Excludes truncated messages. System messages are always first,
	 * followed by non-truncated user/assistant/tool messages.
	 */
	getMessagesForLLM(): Message[] {
		return this.messages.filter((m) => !m.truncated);
	}

	/**
	 * Get a specific message by ID.
	 */
	getMessageById(id: string): Message | undefined {
		return this.messages.find((m) => m.id === id);
	}

	/**
	 * Update a message in-memory by ID.
	 *
	 * In-memory only — no JSONL persistence. Used for transient state transitions
	 * (e.g. loading → real block). The caller is responsible for persisting the
	 * final state via addMessage() or onMessageAdded if needed.
	 *
	 * Fires onMessageUpdated to trigger UI re-render. Returns the updated message,
	 * or null if not found.
	 */
	updateMessage(messageId: string, patch: Partial<Pick<Message, 'content' | 'exclude_from_compaction'>>): Message | null {
		const message = this.messages.find((m) => m.id === messageId);
		if (!message) return null;

		Object.assign(message, patch);
		void this.onMessageUpdated?.(message);
		return message;
	}

	/**
	 * Promote a transient (loading) message to a real persisted message.
	 *
	 * Overwrites the message's content in-place (preserving array position),
	 * fires onMessageAdded for first-time JSONL persistence, then fires
	 * onMessageUpdated to trigger a UI re-render at the existing DOM position.
	 *
	 * Used by chatBlocks.emit() when replacing a loading placeholder with real data.
	 * Returns the updated message, or null if not found.
	 */
	promoteTransientMessage(
		messageId: string,
		newContent: Message["content"],
		extraPatch?: Partial<Pick<Message, "exclude_from_compaction">>,
	): Message | null {
		const message = this.messages.find((m) => m.id === messageId);
		if (!message) return null;

		message.content = newContent;
		if (extraPatch) Object.assign(message, extraPatch);

		// Clear the loading flag on any custom_block entries
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "custom_block") {
					block.loading = false;
				}
			}
		}

		// First-time persistence (was transient before)
		void this.onMessageAdded?.(message);
		// Re-render at existing DOM position
		void this.onMessageUpdated?.(message);
		return message;
	}

	/**
	 * Replace all messages with a new set (used by compaction).
	 *
	 * This replaces the in-memory message array without triggering
	 * per-message callbacks (the caller handles persistence).
	 *
	 * @param newMessages - The replacement message array.
	 */
	replaceMessages(newMessages: Message[]): void {
		this.messages = [...newMessages];
		log.info("Messages replaced (compaction)", {
			newCount: newMessages.length,
			conversationId: this.activeConversation?.id,
		});
	}

	// -----------------------------------------------------------------------
	// Mode management
	// -----------------------------------------------------------------------

	/**
	 * Get the current conversation mode.
	 */
	getMode(): ConversationMode {
		return this.activeConversation?.mode ?? this.defaultMode;
	}

	/**
	 * Set the conversation mode (plan/act).
	 */
	setMode(mode: ConversationMode): void {
		if (this.activeConversation) {
			this.activeConversation.mode = mode;
			void this.onConversationChanged?.(this.activeConversation);
			log.info("Mode changed", { mode, conversationId: this.activeConversation.id });
		}
	}

	setTasks(tasks: TaskItem[] | null): void {
		if (this.activeConversation) {
			this.activeConversation.tasks = tasks;
			void this.onConversationChanged?.(this.activeConversation);
		}
	}

	/**
	 * Patch the active conversation's workflow metadata in place and persist.
	 *
	 * Used for mid-conversation workflow changes (deactivate via the chip, or
	 * switching to a different workflow). Mutating the in-memory conversation —
	 * not just the persisted header — matters because follow-up turns snapshot
	 * `getActiveConversation()` to re-hydrate workflow tool configs, so the
	 * change must be visible without a reload. Only provided fields are touched.
	 */
	setWorkflowMetadata(patch: {
		workflow_path?: string | null;
		workflow_name?: string | null;
		workflow_tool_configs?: import("../tool-config/types").ParsedToolConfig[] | null;
		workflow_deactivated?: boolean;
	}): void {
		if (!this.activeConversation) return;
		if (patch.workflow_path !== undefined) this.activeConversation.workflow_path = patch.workflow_path;
		if (patch.workflow_name !== undefined) this.activeConversation.workflow_name = patch.workflow_name;
		if (patch.workflow_tool_configs !== undefined) this.activeConversation.workflow_tool_configs = patch.workflow_tool_configs;
		if (patch.workflow_deactivated !== undefined) this.activeConversation.workflow_deactivated = patch.workflow_deactivated;
		void this.onConversationChanged?.(this.activeConversation);
	}

	// -----------------------------------------------------------------------
	// Token and cost tracking
	// -----------------------------------------------------------------------

	/**
	 * Get cumulative token counts for the active conversation.
	 */
	getTokenCounts(): { input: number; output: number } {
		if (!this.activeConversation) {
			return { input: 0, output: 0 };
		}
		return {
			input: this.activeConversation.total_input_tokens,
			output: this.activeConversation.total_output_tokens,
		};
	}

	/**
	 * Get the estimated cost for the active conversation.
	 */
	getEstimatedCost(): number | null {
		return this.activeConversation?.estimated_cost ?? null;
	}

	/**
	 * Accumulate token counts into the active conversation totals
	 * without associating them with a specific message.
	 *
	 * Used for sub-agent token rollup, where the tokens should count
	 * toward the conversation total (for billing display) but must NOT
	 * inflate per-message estimates used by compaction/truncation.
	 */
	addTokens(input: number, output: number): void {
		if (!this.activeConversation) {
			throw new Error("No active conversation. Create or load one first.");
		}
		if (input) {
			this.activeConversation.total_input_tokens += input;
		}
		if (output) {
			this.activeConversation.total_output_tokens += output;
		}
		void this.onConversationChanged?.(this.activeConversation);
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	/**
	 * Set the conversation title programmatically. Fires onConversationChanged.
	 *
	 * @see specs/ZZ-misc/model-presets-design.md — Section 11.3
	 */
	setTitle(title: string): void {
		if (!this.activeConversation) throw new Error("No active conversation");
		log.info("setTitle", { conversationId: this.activeConversation.id, oldTitle: this.activeConversation.title, newTitle: title });
		this.activeConversation.title = title;
		void this.onConversationChanged?.(this.activeConversation);
		this.onTitleChanged?.(this.activeConversation.id, title);
	}

	/**
	 * Set the favorite state programmatically. Fires onConversationChanged.
	 *
	 * @see specs/ZZ-misc/model-presets-design.md — Section 11.3
	 */
	setFavorite(favorite: boolean): void {
		if (!this.activeConversation) throw new Error("No active conversation");
		this.activeConversation.is_favorite = favorite;
		void this.onConversationChanged?.(this.activeConversation);
	}

	/**
	 * Generate a display title from the first user message.
	 * Truncates to MAX_TITLE_LENGTH and adds ellipsis if needed.
	 */
	private generateTitle(content: string): string {
		// Strip markdown formatting for title
		const cleaned = content
			.replace(/[#*_~`>[\]()]/g, "")
			.replace(/\n+/g, " ")
			.trim();

		if (cleaned.length <= MAX_TITLE_LENGTH) {
			return cleaned;
		}

		// Truncate at word boundary
		const truncated = cleaned.substring(0, MAX_TITLE_LENGTH);
		const lastSpace = truncated.lastIndexOf(" ");
		if (lastSpace > MAX_TITLE_LENGTH * 0.6) {
			return truncated.substring(0, lastSpace) + "…";
		}
		return truncated + "…";
	}
}