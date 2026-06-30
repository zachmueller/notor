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
import type { ToolPolicyContext } from "./tool-policy";
import type { ApprovalCallback, InteractionCallback } from "./dispatcher";
import type { InteractionRequest, InteractionResponse } from "../ui/interaction-ui";
import type { NotorSettings } from "../settings";

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
	workflowAssembly?: WorkflowAssemblyResult | null;
	approvalCallback: ApprovalCallback;
	interactionCallback?: InteractionCallback;
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
	readonly providerId: string;
	readonly modelId: string;
	readonly useExtendedContext: boolean;
	readonly thinkingLevel: string | null;
	readonly workflowAssembly: WorkflowAssemblyResult | null;

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

	private _status: SessionStatus = "running";
	onStatusChange?: (session: ConversationSession) => void;

	constructor(opts: ConversationSessionOptions) {
		this.conversationId = opts.conversationId;
		this.conversationManager = opts.conversationManager;
		this.abortController = opts.abortController;
		this.title = opts.title;
		this.startedAt = Date.now();
		this.pinnedPersona = opts.pinnedPersona;
		this.providerId = opts.providerId;
		this.modelId = opts.modelId;
		this.useExtendedContext = opts.useExtendedContext;
		this.thinkingLevel = opts.thinkingLevel;
		this.workflowAssembly = opts.workflowAssembly ?? null;
		this.approvalCallback = opts.approvalCallback;
		this.interactionCallback = opts.interactionCallback;
		this.effectiveConfig = opts.initialConfig;
		this.parsedConfigs = opts.initialParsedConfigs;
	}

	get status(): SessionStatus {
		return this._status;
	}

	setStatus(status: SessionStatus): void {
		this._status = status;
		this.onStatusChange?.(this);
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
	}

	/**
	 * Build a ToolPolicyContext from this session's resolved state.
	 *
	 * Mode is read dynamically (not pinned) because users expect toggling
	 * plan→act to take immediate effect mid-stream. Persona/provider are
	 * pinned because changing them mid-stream would produce incoherent
	 * instructions or break conversation format.
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
			displayManager.loadConversation(finalConv, finalMessages, { silent: true });
		}
	}
}
