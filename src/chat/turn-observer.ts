/**
 * Turn observer registry — an in-process, multi-listener seam over the chat
 * orchestrator's turn lifecycle (turn start/finish, tool call start/finish).
 *
 * The session's `onStatusChange` and the conversation manager's message
 * callbacks are single-slot and already occupied; this registry gives
 * features such as voice mode a way to follow a panel's turns without
 * touching those. Observers are notified synchronously, never awaited, and
 * isolated from each other: a throwing observer is logged and skipped.
 */

import type { ConversationSession, SessionStatus } from "./conversation-session";
import type { Message, ToolResult } from "../types";
import { logger } from "../utils/logger";

const log = logger("TurnObserver");

export interface TurnStartInfo {
	/** Id of the user message that started this turn (null if none is found). */
	userMessageId: string | null;
}

export interface TurnFinishInfo {
	/** Terminal session status (`completed` or `errored`). */
	status: SessionStatus;
	/** True when the turn ended because the session was aborted. */
	cancelled: boolean;
	userMessageId: string | null;
}

export interface TurnObserver {
	onTurnStarted?(session: ConversationSession, info: TurnStartInfo): void;
	onToolCallStarted?(
		session: ConversationSession,
		toolName: string,
		parameters: Record<string, unknown>,
		messageId: string,
	): void;
	onToolCallFinished?(
		session: ConversationSession,
		toolName: string,
		parameters: Record<string, unknown>,
		result: ToolResult,
		messageId: string,
	): void;
	/**
	 * Fired after the session is unregistered, so an observer may submit a new
	 * message to the conversation from here without hitting the session guard.
	 */
	onTurnFinished?(session: ConversationSession, info: TurnFinishInfo): void;
}

/** The last real (non-hook-injection) user message id, or null. */
export function findTurnUserMessageId(messages: Message[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "user" && !m.is_hook_injection) return m.id;
	}
	return null;
}

export class TurnObserverRegistry {
	private readonly observers = new Set<TurnObserver>();

	add(observer: TurnObserver): () => void {
		this.observers.add(observer);
		return () => {
			this.observers.delete(observer);
		};
	}

	clear(): void {
		this.observers.clear();
	}

	get size(): number {
		return this.observers.size;
	}

	emitTurnStarted(session: ConversationSession, info: TurnStartInfo): void {
		this.each("onTurnStarted", (o) => o.onTurnStarted?.(session, info));
	}

	emitToolCallStarted(
		session: ConversationSession,
		toolName: string,
		parameters: Record<string, unknown>,
		messageId: string,
	): void {
		this.each("onToolCallStarted", (o) => o.onToolCallStarted?.(session, toolName, parameters, messageId));
	}

	emitToolCallFinished(
		session: ConversationSession,
		toolName: string,
		parameters: Record<string, unknown>,
		result: ToolResult,
		messageId: string,
	): void {
		this.each("onToolCallFinished", (o) =>
			o.onToolCallFinished?.(session, toolName, parameters, result, messageId),
		);
	}

	emitTurnFinished(session: ConversationSession, info: TurnFinishInfo): void {
		this.each("onTurnFinished", (o) => o.onTurnFinished?.(session, info));
	}

	private each(event: string, fn: (observer: TurnObserver) => void): void {
		for (const observer of this.observers) {
			try {
				fn(observer);
			} catch (e) {
				log.error("Turn observer threw", { event, error: String(e) });
			}
		}
	}
}
