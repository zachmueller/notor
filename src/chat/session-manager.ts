/**
 * Session manager — owns active session tracking and lifecycle.
 *
 * Extracted from `ChatOrchestrator` (Phase B2). Manages the
 * `activeSessions` map, session change callbacks, cross-orchestrator
 * session guards, and session teardown during destroy.
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — B2
 */

import type { ConversationSession } from "./conversation-session";
import type { HistoryManager } from "./history";
import type { SessionGuard } from "./orchestrator";
import type { WorkflowHookOverrideManager } from "../hooks/workflow-hook-override";
import { logger } from "../utils/logger";

const log = logger("SessionManager");

export class SessionManager {
	private activeSessions = new Map<string, ConversationSession>();
	private sessionChangeCallbacks = new Set<() => void>();

	constructor(
		private readonly sessionGuard: SessionGuard,
		private readonly historyManager: HistoryManager,
		private readonly getWorkflowHookOverrideManager: () => WorkflowHookOverrideManager | undefined,
	) {}

	// -----------------------------------------------------------------------
	// Session accessors
	// -----------------------------------------------------------------------

	/**
	 * Get the active session for a given conversation ID.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1d
	 */
	getActiveSession(conversationId: string): ConversationSession | undefined {
		return this.activeSessions.get(conversationId);
	}

	/**
	 * Returns all currently active sessions (streaming or waiting for approval).
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 2, Step 2a
	 */
	getActiveSessions(): ConversationSession[] {
		return Array.from(this.activeSessions.values());
	}

	/**
	 * Check whether a conversation has an active session.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 2, Step 2a
	 */
	hasActiveSession(conversationId: string): boolean {
		return this.activeSessions.has(conversationId);
	}

	/**
	 * Register a listener that fires whenever the set of active sessions changes.
	 *
	 * @returns An unregister function that removes the callback.
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 3, Step 3c
	 */
	onSessionsChanged(callback: () => void): () => void {
		this.sessionChangeCallbacks.add(callback);
		return () => {
			this.sessionChangeCallbacks.delete(callback);
		};
	}

	/** Notify all registered listeners that the active session set has changed. */
	notifySessionsChanged(): void {
		for (const cb of this.sessionChangeCallbacks) {
			try {
				cb();
			} catch (e) {
				log.error("sessionChange callback error", { error: String(e) });
			}
		}
	}

	// -----------------------------------------------------------------------
	// Session registration
	// -----------------------------------------------------------------------

	/**
	 * Check both per-orchestrator and cross-orchestrator guards.
	 *
	 * @returns An error message string if blocked, or `null` if OK to proceed.
	 */
	checkSessionGuards(conversationId: string): string | null {
		if (this.activeSessions.has(conversationId)) {
			return "This conversation is already processing a message. Please wait for it to complete.";
		}
		if (this.sessionGuard.isActive(conversationId)) {
			return "This conversation is being processed in another panel.";
		}
		return null;
	}

	/**
	 * Register a session in the active map and cross-orchestrator guard.
	 */
	registerSession(session: ConversationSession): void {
		this.activeSessions.set(session.conversationId, session);
		this.sessionGuard.register(session.conversationId);
		this.notifySessionsChanged();
	}

	/**
	 * Unregister a session from the active map and cross-orchestrator guard.
	 */
	unregisterSession(conversationId: string): void {
		this.sessionGuard.unregister(conversationId);
		this.activeSessions.delete(conversationId);
		this.notifySessionsChanged();
	}

	// -----------------------------------------------------------------------
	// Lifecycle — teardown
	// -----------------------------------------------------------------------

	/**
	 * Abort all active sessions and await their cleanup.
	 *
	 * Called from plugin `onunload()` when the plugin is disabled, hot-reloaded,
	 * or Obsidian closes. Best-effort: awaits response loop completion up to
	 * `timeoutMs` so that JSONL writes can flush, then clears regardless.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1h
	 */
	async destroy(timeoutMs: number = 2000): Promise<void> {
		const sessionPromises: Promise<void>[] = [];

		for (const session of this.activeSessions.values()) {
			if (session.responsePromise) {
				sessionPromises.push(session.responsePromise);
			}
			session.abortController.abort();
		}

		if (sessionPromises.length > 0) {
			await Promise.race([
				Promise.allSettled(sessionPromises),
				new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
			]);
		}

		// Deactivate workflow hook overrides for all active sessions.
		const overrideMgr = this.getWorkflowHookOverrideManager();
		for (const session of this.activeSessions.values()) {
			if (session.workflowAssembly && overrideMgr) {
				overrideMgr.deactivate(session.conversationId);
			}
		}

		// Flush any writes that may have been enqueued in finally blocks.
		try {
			await Promise.race([
				this.historyManager.flush(),
				new Promise<void>((r) => setTimeout(r, Math.max(timeoutMs / 2, 500))),
			]);
		} catch {
			// Best-effort
		}

		// Unregister all active session IDs from the global guard.
		for (const id of this.activeSessions.keys()) {
			this.sessionGuard.unregister(id);
		}

		this.activeSessions.clear();
		this.sessionChangeCallbacks.clear();
		log.info("SessionManager destroyed", { abortedSessions: sessionPromises.length });
	}
}
