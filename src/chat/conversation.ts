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

import type { Conversation, ConversationMode, Message, MessageRole, ToolCall, ToolResult } from "../types";
import { logger } from "../utils/logger";

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
	private onMessageAdded?: (message: Message) => void;

	/** Callback invoked when the conversation metadata changes. */
	private onConversationChanged?: (conversation: Conversation) => void;

	constructor(
		private defaultMode: ConversationMode = "plan"
	) {}

	// -----------------------------------------------------------------------
	// Event handlers
	// -----------------------------------------------------------------------

	/** Register a callback for when a message is added. */
	setOnMessageAdded(callback: (message: Message) => void): void {
		this.onMessageAdded = callback;
	}

	/** Register a callback for when conversation metadata changes. */
	setOnConversationChanged(callback: (conversation: Conversation) => void): void {
		this.onConversationChanged = callback;
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
	 */
	createConversation(
		providerId: string,
		modelId: string,
		mode?: ConversationMode
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
		};

		this.activeConversation = conversation;
		this.messages = [];

		log.info("Created new conversation", {
			id: conversation.id,
			provider: providerId,
			model: modelId,
			mode: conversation.mode,
		});

		this.onConversationChanged?.(conversation);
		return conversation;
	}

	/**
	 * Load an existing conversation and its messages into memory.
	 *
	 * Used when switching to a past conversation loaded from history.
	 */
	loadConversation(conversation: Conversation, messages: Message[]): void {
		this.activeConversation = { ...conversation };
		this.messages = [...messages];

		log.info("Loaded conversation", {
			id: conversation.id,
			messageCount: messages.length,
		});

		this.onConversationChanged?.(this.activeConversation);
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
		content: string;
		input_tokens?: number | null;
		output_tokens?: number | null;
		cost_estimate?: number | null;
		tool_call?: ToolCall | null;
		tool_result?: ToolResult | null;
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
			tool_call: params.tool_call ?? null,
			tool_result: params.tool_result ?? null,
			truncated: false,
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

		// Auto-generate title from first user message
		if (
			params.role === "user" &&
			!this.activeConversation.title
		) {
			this.activeConversation.title = this.generateTitle(params.content);
		}

		log.debug("Added message", {
			id: message.id,
			role: message.role,
			conversationId: this.activeConversation.id,
		});

		this.onMessageAdded?.(message);
		this.onConversationChanged?.(this.activeConversation);

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
			this.onConversationChanged?.(this.activeConversation);
			log.info("Mode changed", { mode, conversationId: this.activeConversation.id });
		}
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

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	/**
	 * Generate a display title from the first user message.
	 * Truncates to MAX_TITLE_LENGTH and adds ellipsis if needed.
	 */
	private generateTitle(content: string): string {
		// Strip markdown formatting for title
		const cleaned = content
			.replace(/[#*_~`>\[\]()]/g, "")
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