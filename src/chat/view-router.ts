/**
 * View router — owns the chat view reference and message rendering.
 *
 * Extracted from `ChatOrchestrator` (Phase B1). Centralizes the
 * "which view should receive renders" logic via `getViewForSession()`.
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — B1
 */

import type { Message } from "../types";
import { assertUnreachable } from "../utils/assert-unreachable";
import type { ConversationSession } from "./conversation-session";
import type { NotorChatView } from "../ui/chat-view";

export class ViewRouter {
	private view?: NotorChatView;

	constructor(
		private readonly getDisplayedConversationId: () => string | undefined,
	) {}

	/**
	 * Set or update the chat view reference.
	 *
	 * Pass `undefined` to detach the view (e.g. on panel close).
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 7.2
	 */
	setView(view: NotorChatView | undefined): void {
		this.view = view;
	}

	/** Get the current view reference (if any). */
	getView(): NotorChatView | undefined {
		return this.view;
	}

	/**
	 * Returns the view only if it is currently displaying this session's conversation.
	 *
	 * When the user navigates away from a streaming conversation, this returns
	 * `undefined` so all render calls become no-ops while data writes continue.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1d
	 */
	getViewForSession(session: ConversationSession): NotorChatView | undefined {
		const displayConvId = this.getDisplayedConversationId();
		return session.conversationId === displayConvId ? this.view : undefined;
	}

	/**
	 * Render a message in the view based on its role.
	 */
	renderMessage(message: Message): void {
		switch (message.role) {
			case "user":
				this.view?.renderUserMessage(message);
				break;
			case "assistant": {
				const el = this.view?.createAssistantMessagePlaceholder();
				if (el) {
					void this.view?.finalizeAssistantMessage(el, message);
				}
				break;
			}
			case "tool_call":
				this.view?.renderToolCall(message);
				break;
			case "tool_result":
				this.view?.renderToolResult(message);
				break;
			case "system":
				// system messages are not rendered
				break;
			case "extension_block":
				this.view?.renderExtensionBlock(message);
				break;
			default:
				assertUnreachable(message.role);
		}
	}
}
