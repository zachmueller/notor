/**
 * Per-conversation session state for an active response loop.
 *
 * Each `ConversationSession` isolates all mutable state that was previously
 * shared on the orchestrator/dispatcher: conversation manager, effective tool
 * config, persona, provider, model, abort controller, and approval callback.
 *
 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1c
 */

import type { ConversationManager } from "./conversation";
import type { Persona, WorkflowAssemblyResult } from "../types";
import type { EffectiveToolConfig, ParsedToolConfig } from "../tool-config/types";
import type { ApprovalOverride, ToolPolicyContext } from "./tool-policy";
import type { ApprovalCallback, InteractionCallback } from "./dispatcher";
import type { InteractionRequest, InteractionResponse } from "../ui/interaction-ui";
import type { NotorSettings } from "../settings";
import { getPlanReviewController } from "../plans/plan-review-controller";
import { readSelection, type ModelSelection } from "./model-selection";

export type SessionStatus =
	| "running"
	| "waiting_approval"
	| "completed"
	| "errored"
	| "cancelled";

export interface PendingApproval {
	resolve: (decision: "approved" | "rejected") => void;
	toolCallId: string;
	messageId: string;
	toolName: string;
	parameters: Record<string, unknown>;
}

export interface PendingInteraction {
	/** Resolve the original interaction promise with the user's answers. */
	resolve: (response: InteractionResponse) => void;
	/** Reject the interaction promise so the tool loop unwinds (on abort/teardown). */
	reject: (reason: Error) => void;
	/** The originating request — needed to re-render the prompt after view teardown. */
	request: InteractionRequest;
	messageId: string;
}

export interface ConversationSessionOptions {
	conversationId: string;
	conversationManager: ConversationManager;
	abortController: AbortController;
	title: string;
	pinnedPersona: Persona | null;
	providerId: string;
	modelId: string;
	useExtendedContext: boolean;
	thinkingLevel: string | null;
	presetName?: string | null;
	workflowAssembly?: WorkflowAssemblyResult | null;
	approvalCallback: ApprovalCallback;
	interactionCallback?: InteractionCallback;
	/** Per-run approval override from a programmatic caller (the external API). */
	approvalOverride?: ApprovalOverride;
	initialConfig: EffectiveToolConfig;
	initialParsedConfigs: ParsedToolConfig[];
}

export class ConversationSession {
	readonly conversationId: string;
	readonly conversationManager: ConversationManager;
	readonly abortController: AbortController;
	readonly title: string;
	readonly startedAt: number;

	/** Per-session resolved state (updated after resolveEffectiveConfig each iteration). */
	effectiveConfig: EffectiveToolConfig;
	parsedConfigs: ParsedToolConfig[];

	/** Snapshotted at session creation — immutable for the session's lifetime. */
	readonly pinnedPersona: Persona | null;
	readonly workflowAssembly: WorkflowAssemblyResult | null;

	/**
	 * Provider/model selection. NOT pinned: a Quick Settings change on the
	 * panel pushes a new selection here via `setSelection()`, and the response
	 * loop reads it once at the top of every iteration — so a mid-turn switch
	 * applies from the next LLM call (next tool round). Sessions nobody pushes
	 * to (background workflows) stay effectively pinned.
	 */
	private _selection: ModelSelection;

	/** Per-session routing — bound to the correct panel's view. */
	readonly approvalCallback: ApprovalCallback;

	/** Per-session interaction routing (follow-up questions) — bound to the panel's view. */
	readonly interactionCallback?: InteractionCallback;

	/** The response loop promise — used by destroy() to await cleanup. */
	responsePromise?: Promise<void>;

	/** Pending approval resolvers — keyed by messageId. Survives view teardown. */
	readonly pendingApprovals = new Map<string, PendingApproval>();

	/** Pending interaction rejecters — keyed by messageId. Used to unwind on teardown. */
	readonly pendingInteractions = new Map<string, PendingInteraction>();

	/**
	 * "Approve & auto-accept edits": when true, built-in vault write tools are
	 * auto-approved for the rest of this session's response loop. Never
	 * persisted; reset by the orchestrator when the loop ends.
	 */
	autoAcceptWrites = false;

	/** Pinned for the session's response loop; see {@link ApprovalOverride}. */
	readonly approvalOverride?: ApprovalOverride;

	private _status: SessionStatus = "running";
	onStatusChange?: (session: ConversationSession) => void;
	/** Additional status listeners (the single slot above is chained by the lifecycle manager). */
	private readonly statusListeners = new Set<(session: ConversationSession) => void>();

	constructor(opts: ConversationSessionOptions) {
		this.conversationId = opts.conversationId;
		this.conversationManager = opts.conversationManager;
		this.abortController = opts.abortController;
		this.title = opts.title;
		this.startedAt = Date.now();
		this.pinnedPersona = opts.pinnedPersona;
		this._selection = {
			providerId: opts.providerId,
			modelId: opts.modelId,
			useExtendedContext: opts.useExtendedContext,
			thinkingLevel: opts.thinkingLevel,
			presetName: opts.presetName ?? null,
		};
		this.workflowAssembly = opts.workflowAssembly ?? null;
		this.approvalCallback = opts.approvalCallback;
		this.interactionCallback = opts.interactionCallback;
		this.approvalOverride = opts.approvalOverride;
		this.effectiveConfig = opts.initialConfig;
		this.parsedConfigs = opts.initialParsedConfigs;
	}

	get selection(): ModelSelection {
		return { ...this._selection };
	}
	get providerId(): string {
		return this._selection.providerId;
	}
	get modelId(): string {
		return this._selection.modelId;
	}
	get useExtendedContext(): boolean {
		return this._selection.useExtendedContext;
	}
	get thinkingLevel(): string | null {
		return this._selection.thinkingLevel;
	}

	/**
	 * Replace the selection and mirror it (plus `persona_name`, when given)
	 * onto the session's own conversation header, so every later
	 * `onConversationChanged` header write from this session carries the new
	 * values instead of reverting the JSONL.
	 */
	setSelection(sel: ModelSelection, personaName?: string | null): void {
		this._selection = { ...sel };
		this.conversationManager.setModelSelection(sel, personaName);
	}

	get status(): SessionStatus {
		return this._status;
	}

	setStatus(status: SessionStatus): void {
		this._status = status;
		this.onStatusChange?.(this);
		for (const listener of this.statusListeners) {
			try {
				listener(this);
			} catch {
				// A misbehaving observer must never break the response loop.
			}
		}
	}

	/** Subscribe to status changes without displacing `onStatusChange`. Returns an unsubscribe. */
	addStatusListener(listener: (session: ConversationSession) => void): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	rejectAllPendingApprovals(): void {
		for (const pending of this.pendingApprovals.values()) {
			pending.resolve("rejected");
		}
		this.pendingApprovals.clear();
		for (const pending of this.pendingInteractions.values()) {
			pending.reject(new Error("Interaction cancelled by user."));
		}
		this.pendingInteractions.clear();
		// A re-rendered plan-review prompt (view switch) never settles its
		// original promise, so drop the controller entry explicitly.
		getPlanReviewController()?.clear(this.conversationId);
	}

	/**
	 * Build a ToolPolicyContext from this session's resolved state.
	 *
	 * Mode is read dynamically (not pinned) because users expect toggling
	 * plan→act to take immediate effect mid-stream. Persona is pinned because
	 * changing it mid-stream would produce incoherent instructions. (The model
	 * selection is likewise live — see `selection`.)
	 */
	buildPolicyContext(
		settings: NotorSettings,
		vaultRootPath: string,
		resolveVaultPath?: (path: string) => string | null,
	): ToolPolicyContext {
		return {
			effectiveConfig: this.effectiveConfig,
			mode: this.conversationManager.getActiveConversation()?.mode ?? "act",
			domainDenylist: settings.domain_denylist,
			vaultRootPath,
			resolveVaultPath,
			autoAcceptWrites: this.autoAcceptWrites,
			approvalOverride: this.approvalOverride,
		};
	}
}

/**
 * Sync a finished session's isolated conversation state back into the panel's
 * **display** ConversationManager, so follow-up turns (which snapshot the
 * display manager) see the full turn — assistant + tool messages — not just the
 * user message that started it.
 *
 * Guarded on the active conversation id: if the user navigated the display
 * manager to a different conversation while the session ran, the sync is
 * skipped so we never clobber the now-active conversation. The session's
 * messages are still persisted to JSONL and re-loaded on switch-back.
 *
 * The display header's model selection is kept: the display copy is what
 * Quick Settings write, so the session's copy must never revert it.
 *
 * Loaded `{ silent: true }` so `onConversationChanged` does not re-fire (no
 * mid-teardown header/token writes). This is the single canonical reconcile
 * point shared by the normal-message path and the manual-workflow path.
 */
export function syncSessionToDisplay(
	displayManager: ConversationManager,
	session: ConversationSession,
): void {
	const displayConv = displayManager.getActiveConversation();
	if (displayConv && displayConv.id === session.conversationId) {
		const finalConv = session.conversationManager.getActiveConversation();
		const finalMessages = session.conversationManager.getMessages();
		if (finalConv && finalMessages.length > 0) {
			const displaySelection = readSelection(displayConv);
			displayManager.loadConversation(finalConv, finalMessages, { silent: true });
			displayManager.setModelSelection(displaySelection);
		}
	}
}
