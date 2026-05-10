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
import type { ApprovalCallback } from "./dispatcher";
import type { NotorSettings } from "../settings";

export type SessionStatus =
	| "running"
	| "waiting_approval"
	| "completed"
	| "errored"
	| "cancelled";

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

	/** The response loop promise — used by destroy() to await cleanup. */
	responsePromise?: Promise<void>;

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

	/**
	 * Build a ToolPolicyContext from this session's resolved state.
	 *
	 * Mode is read dynamically (not pinned) because users expect toggling
	 * plan→act to take immediate effect mid-stream. Persona/provider are
	 * pinned because changing them mid-stream would produce incoherent
	 * instructions or break conversation format.
	 */
	buildPolicyContext(settings: NotorSettings, vaultRootPath: string): ToolPolicyContext {
		return {
			effectiveConfig: this.effectiveConfig,
			mode: this.conversationManager.getActiveConversation()?.mode ?? "act",
			domainDenylist: settings.domain_denylist,
			vaultRootPath,
		};
	}
}
