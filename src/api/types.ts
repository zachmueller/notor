/**
 * Public types for `app.plugins.plugins.notor.api` (v1).
 *
 * This is a stability contract for other plugins and user scripts (Templater,
 * QuickAdd, …): only plain data crosses it, never internal objects. Breaking
 * changes bump {@link NotorApi.version}.
 */

/** Where a run is shown. */
export type NotorDisplay = "headless" | "main" | "new-panel";

/**
 * How a run's tool calls are approved. Blocks (disabled tools, Plan-mode
 * writes, blocked paths, the domain denylist) always apply.
 * - `inherit`: your configured auto-approve rules; anything else prompts.
 * - `auto`: approve every allowed call. Requires **Allow scripts to
 *   auto-approve**; never-auto-approve paths and blocked commands still prompt.
 * - `prompt`: ask for every call.
 */
export type NotorApproval = "inherit" | "auto" | "prompt";

/** Optional result details (`notes` reads the run's conversations afterwards). */
export type NotorResultDetail = "conversation" | "text" | "cost" | "notes";

export interface NotorRunOptions {
	/**
	 * Text processed like the chat input: `[[Note]]`, `[[Note#Section]]`, and
	 * `[[Note|alias]]` links to Markdown notes attach those notes' contents.
	 */
	prompt?: string;
	/** Default `"headless"`. `"main"` and `"new-panel"` show the run in a chat panel. */
	display?: NotorDisplay;
	/** Default `true`: resolve when the run finishes. `false` resolves at once with `status: "running"`. */
	wait?: boolean;
	/** Default: the workflow's own mode, else your Plan/Act setting. */
	mode?: "plan" | "act";
	/** Default `"inherit"`. */
	approval?: NotorApproval;
	/** Circuits only. Default `true`; `false` cancels the run when it asks you a question. */
	interactive?: boolean;
	/** Circuits only: start even if this circuit is already running. */
	allowConcurrent?: boolean;
	/** Default `["conversation", "text", "cost"]`. */
	include?: NotorResultDetail[];
	/** Aborting cancels the run. */
	signal?: AbortSignal;
}

export type NotorRunStatus = "running" | "completed" | "failed" | "cancelled";

/** Snapshot of a run. */
export interface NotorRunInfo {
	runId: string;
	kind: "circuit" | "workflow";
	/** The circuit or workflow name. */
	name: string;
	status: NotorRunStatus;
	/** Circuits: the session id (the run-tree root). */
	sessionId?: string;
	/** Workflows: the run's conversation. Circuits: the latest step conversation. */
	conversationId?: string;
	/** The final assistant text (circuits: the terminal payload). */
	text?: string;
	/** Circuits: a terminal code step's typed return value, if any. */
	structured?: unknown;
	costUsd?: number;
	/** Vault paths read during the run (requires `include: ["notes"]`). */
	notesRead?: string[];
	/** Vault paths written during the run (requires `include: ["notes"]`). */
	notesEdited?: string[];
	error?: string;
	errorCode?: NotorApiErrorCode;
}

export interface NotorRunResult extends NotorRunInfo {
	/** Resolves with the final result; present even when `wait: false`. */
	done: Promise<NotorRunInfo>;
}

export interface NotorToolResult {
	/** The canonical tool name (legacy aliases are resolved). */
	toolName: string;
	success: boolean;
	result: unknown;
	error?: string;
	durationMs?: number;
}

export interface NotorToolOptions {
	mode?: "plan" | "act";
	approval?: NotorApproval;
	signal?: AbortSignal;
}

export interface NotorCircuitInfo {
	name: string;
	description?: string;
	/** Vault path of the circuit's directory. */
	path: string;
	/** Whether other circuits may call it with `run_circuit`. */
	invocable: boolean;
}

export interface NotorWorkflowInfo {
	/** Display name, e.g. `daily/review`. */
	name: string;
	/** Vault path of the workflow note. */
	path: string;
	aliases: string[];
}

export interface NotorApi {
	readonly version: 1;
	/** Resolves once Notor has finished loading its tools. Every method awaits it. */
	readonly ready: Promise<void>;
	listCircuits(): Promise<NotorCircuitInfo[]>;
	listWorkflows(): Promise<NotorWorkflowInfo[]>;
	/** Run a circuit by name or directory path. */
	runCircuit(nameOrPath: string, opts?: NotorRunOptions): Promise<NotorRunResult>;
	/** Run a workflow by name, alias, file name, or vault path. */
	runWorkflow(nameOrPath: string, opts?: NotorRunOptions): Promise<NotorRunResult>;
	/** Call one tool directly, through the same policy and approval checks as chat. */
	runTool(name: string, params: Record<string, unknown>, opts?: NotorToolOptions): Promise<NotorToolResult>;
	/** A recent run by id (the last 50 finished runs are kept). */
	getRun(runId: string): NotorRunInfo | undefined;
	/** Cancel a running run. Returns false when it isn't running. */
	cancelRun(runId: string): boolean;
}

export type NotorApiErrorCode =
	| "api_disabled"
	| "unloaded"
	| "circuits_disabled"
	| "not_found"
	| "ambiguous"
	| "auto_approve_not_allowed"
	| "invalid_option"
	| "unsupported_tool"
	| "panel_unavailable"
	| "panel_busy"
	| "already_running"
	| "run_failed";

/** Thrown for caller mistakes; failures during a run are reported in the result instead. */
export class NotorApiError extends Error {
	constructor(readonly code: NotorApiErrorCode, message: string) {
		super(message);
		this.name = "NotorApiError";
	}
}
