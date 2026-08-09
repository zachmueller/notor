/**
 * Tool dispatcher — sits between LLM response parsing and tool execution.
 *
 * Enforces Plan/Act mode, auto-approve settings, and routes tool calls
 * to the correct tool implementation. Emits events for UI rendering.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — dispatch flow
 * @see specs/01-mvp/spec.md — FR-14 (Plan/Act), FR-15 (auto-approve)
 */

import type { ConversationMode, ToolCall, ToolResult } from "../types";
import type { NotorSettings } from "../settings";
import type { ToolExecuteOptions, ToolSessionContext } from "../tools/tool";
import type { RunContext, OrchestrationToolContext } from "../run-loop/types";
import type { InteractionRequest, InteractionResponse } from "../ui/interaction-ui";
import { McpRegisteredTool } from "../mcp/mcp-tool-adapter";
import { evaluateToolPolicy, type ToolPolicyContext } from "./tool-policy";
import { buildVaultReadFilter } from "../tool-config/path-enforcer";
import type { ParseStreamOpts } from "./stream-utils";
import { logger } from "../utils/logger";

const log = logger("ToolDispatcher");

/** Tool interface for the dispatcher (minimal — not the full tool registry). */
export interface DispatchableTool {
	name: string;
	mode: "read" | "write";
	internal?: boolean;
	execute(params: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolResult>;
}

/**
 * Auto-approved state passed to an {@link ApprovalCallback}.
 *
 * `true` means "auto-approved, no reason to show"; the object form carries a
 * short reason (e.g. `matched ai/`) that the collapsed card renders so a silent
 * auto-approve is explicable. Objects are truthy, so `if (autoApproved)` checks
 * keep working unchanged.
 */
export type AutoApprovedState = boolean | { reason?: string };

/** Extract the reason label from an {@link AutoApprovedState}, if any. */
export function autoApproveReasonOf(state: AutoApprovedState | undefined): string | undefined {
	return typeof state === "object" && state !== null ? state.reason : undefined;
}

/** Callback for requesting user approval of a tool call. */
export type ApprovalCallback = (toolCall: ToolCall, abortSignal?: AbortSignal, messageId?: string, autoApproved?: AutoApprovedState) => Promise<"approved" | "rejected">;

/**
 * Callback for requesting a user interaction (e.g. a follow-up question) from
 * inside a tool call. Unlike {@link ApprovalCallback}, this is NOT raced
 * against a timeout or an approval hook — an interaction always awaits explicit
 * user input (abort-only). Rejection (via abort) unwinds the tool loop.
 */
export type InteractionCallback = (
	request: InteractionRequest,
	abortSignal?: AbortSignal,
	messageId?: string,
) => Promise<InteractionResponse>;

/** Events emitted by the dispatcher for UI updates. */
export interface DispatcherEvents {
	/** A tool call has started (parsed from LLM stream). */
	onToolCallStarted?: (toolCall: ToolCall, messageId: string) => void;
	/** A tool call result has been received. */
	onToolCallResult?: (toolCall: ToolCall, result: ToolResult, messageId: string) => void;
	/** A tool call status has changed (e.g., pending → approved). */
	onToolCallStatusChanged?: (toolCall: ToolCall, messageId: string) => void;
}

/**
 * Central dispatcher for tool calls between the LLM and tool implementations.
 */
export class ToolDispatcher {
	/** Registered tools keyed by name. */
	private tools = new Map<string, DispatchableTool>();

	/** Currently active persona name (null = no persona). */
	private activePersonaName: string | null = null;

	/** Plugin settings (for tool-specific pre-execution checks). */
	private settings?: NotorSettings;

	/** Vault root path for working directory validation. */
	private vaultRootPath?: string;

	/** Optional resolver for vault note paths (used by path enforcement). */
	private resolveVaultPath?: (path: string) => string | null;

	/**
	 * Callback for requesting user approval.
	 *
	 * Used by sub-agent dispatchers (each sub-agent run creates its own
	 * ToolDispatcher with its own approval callback). For the shared
	 * plugin-level dispatcher, approval is passed per-call via sessions —
	 * this field is not set by main.ts.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4e
	 */
	private approvalCallback?: ApprovalCallback;

	/** Event handlers for UI updates. */
	private events: DispatcherEvents = {};

	/** When true, tools execute with note-opener side effects suppressed. */
	private silentMode = false;

	/**
	 * Tri-state override of the note-opener's enabled state, independent of the
	 * `open_notes_on_access` chat setting. `null` (default) defers to the chat
	 * setting; `true`/`false` force-open/force-suppress. Set by orchestration to
	 * honor its own setting / the per-flow `notor-open-notes-in-editor` override.
	 */
	private openNotesOverride: boolean | null = null;

	/** Temp output spiller for dispatcher-level spillover of large tool results. */
	private spiller?: import("../shell/temp-output-spiller").TempOutputSpiller;

	// -----------------------------------------------------------------------
	// Configuration
	// -----------------------------------------------------------------------

	/** Register a tool for dispatch. */
	registerTool(tool: DispatchableTool): void {
		this.tools.set(tool.name, tool);
		log.debug("Registered tool", { name: tool.name, mode: tool.mode });
	}

	/**
	 * Unregister a tool by name.
	 *
	 * Used to remove MCP tools when servers disconnect or tools are
	 * removed on refresh. Safe to call if the tool is not registered.
	 *
	 * @returns true if the tool was found and removed, false otherwise
	 * @see specs/04-mcp/tasks.md — FEAT-004
	 */
	unregisterTool(name: string): boolean {
		const existed = this.tools.delete(name);
		if (existed) {
			log.debug("Unregistered tool", { name });
		}
		return existed;
	}

	/** Update plugin settings reference. */
	setSettings(settings: NotorSettings): void {
		this.settings = settings;
	}

	/** Set the vault root path for working directory validation. */
	setVaultRootPath(path: string): void {
		this.vaultRootPath = path;
	}

	/** Set the vault path resolver for path constraint enforcement. */
	setResolveVaultPath(fn: (path: string) => string | null): void {
		this.resolveVaultPath = fn;
	}

	/**
	 * Set the approval callback for manual approval.
	 *
	 * Used by sub-agent dispatchers (each sub-agent creates its own
	 * ToolDispatcher per-run). The shared plugin-level dispatcher does
	 * NOT use this — approval is passed per-call via sessions.
	 */
	setApprovalCallback(callback: ApprovalCallback): void {
		this.approvalCallback = callback;
	}

	/** Set event handlers for UI updates. */
	setEvents(events: DispatcherEvents): void {
		this.events = events;
	}

	/** Suppress editor-open side effects on all tools dispatched through this instance. */
	setSilentMode(silent: boolean): void {
		this.silentMode = silent;
	}

	/**
	 * Override the note-opener's enabled state on all tools dispatched through this
	 * instance, independent of the `open_notes_on_access` chat setting. `null`
	 * defers to the chat default; `true`/`false` force-open/force-suppress.
	 */
	setOpenNotesOverride(value: boolean | null): void {
		this.openNotesOverride = value;
	}

	/** Set the temp output spiller for dispatcher-level spillover of large results. */
	setSpiller(spiller: import("../shell/temp-output-spiller").TempOutputSpiller | undefined): void {
		this.spiller = spiller;
	}

	/**
	 * The temp output spiller, if configured (undefined on mobile or when
	 * spillover is disabled). Used by stream consumers to preserve partial
	 * tool-call content on a failed/cut-off write.
	 */
	getSpiller(): import("../shell/temp-output-spiller").TempOutputSpiller | undefined {
		return this.spiller;
	}

	/**
	 * Build the `onPartialToolCall` handler for `parseStreamEvents`, backed by the
	 * configured spiller. Returns `undefined` when no spiller is available (mobile
	 * / spillover disabled) — the parser still logs and emits a diagnostic, just
	 * without persisting a recovery file.
	 */
	makePartialToolCallHandler(): ParseStreamOpts["onPartialToolCall"] {
		const spiller = this.spiller;
		if (!spiller) return undefined;
		return ({ toolName, partialJson }) => spiller.spillRaw(toolName, partialJson);
	}

	/**
	 * Set the currently active persona name.
	 *
	 * Called on plugin load with `settings.active_persona` (or null if
	 * empty), and whenever the user switches personas via the persona picker.
	 * Changes take effect on the next `dispatch()` call.
	 *
	 * @param name - Active persona name, or null for "no persona"
	 * @see specs/03-workflows-personas/tasks/group-b-tasks.md — B-003
	 */
	setActivePersonaName(name: string | null): void {
		this.activePersonaName = name;
		log.debug("Updated active persona for auto-approve", { persona: name });
	}

	// -----------------------------------------------------------------------
	// Approval racing
	// -----------------------------------------------------------------------

	/**
	 * Race the approval UI callback against an optional hook dispatcher and
	 * optional timeout. Returns the first non-"pass" resolution.
	 */
	private raceApprovalSources(
		toolCall: ToolCall,
		toolName: string,
		parameters: Record<string, unknown>,
		mode: ConversationMode,
		approvalCb: ApprovalCallback,
		abortSignal?: AbortSignal,
		messageId?: string,
		approvalHookDispatcher?: (toolName: string, params: Record<string, unknown>, mode: string) => Promise<"approved" | "rejected" | "pass">,
	): Promise<"approved" | "rejected" | "timed_out"> {
		const racers: Promise<"approved" | "rejected" | "timed_out">[] = [
			approvalCb(toolCall, abortSignal, messageId),
		];

		const approvalTimeout = this.settings?.approval_timeout ?? 0;
		if (approvalTimeout > 0) {
			racers.push(
				new Promise<"timed_out">((resolve) =>
					setTimeout(() => resolve("timed_out"), approvalTimeout * 1000)
				),
			);
		}

		if (approvalHookDispatcher) {
			racers.push(
				approvalHookDispatcher(toolName, parameters, mode)
					.then((decision): Promise<"approved" | "rejected" | "timed_out"> | "approved" | "rejected" => {
						if (decision === "approved") return "approved";
						if (decision === "rejected") return "rejected";
						// "pass" → never resolves, cannot win the race
						return new Promise<never>(() => {});
					})
					.catch((): Promise<never> => {
						// Error → never resolves, cannot win the race
						return new Promise<never>(() => {});
					}),
			);
		}

		return Promise.race(racers);
	}

	// -----------------------------------------------------------------------
	// Dispatch
	// -----------------------------------------------------------------------

	/**
	 * Dispatch a tool call through the approval and execution pipeline.
	 *
	 * Follows the dispatch flow from contracts/tool-schemas.md:
	 * 1. Look up tool by name
	 * 2. Check Plan/Act mode
	 * 3. Check auto-approve
	 * 4. Execute and return result
	 *
	 * @param toolName - Name of the tool to invoke
	 * @param parameters - Tool parameters from the LLM
	 * @param mode - Current Plan/Act mode
	 * @param messageId - ID of the tool_call message (for events)
	 * @returns Tool result to send back to the LLM
	 */
	async dispatch(
		toolName: string,
		parameters: Record<string, unknown>,
		mode: ConversationMode,
		messageId: string,
		// abortSignal + onProgress precede the now-required `policyCtx`, so they are
		// required-but-nullable positional args (TS forbids a required param after
		// an optional one). Every caller already passes all three positionally.
		abortSignal: AbortSignal | undefined,
		onProgress: ((status: string) => void) | undefined,
		policyCtx: ToolPolicyContext,
		perCallApprovalCallback?: ApprovalCallback,
		sessionContext?: ToolSessionContext,
		approvalHookDispatcher?: (toolName: string, params: Record<string, unknown>, mode: string) => Promise<"approved" | "rejected" | "pass">,
		interactionCallback?: InteractionCallback,
		runContext?: RunContext,
		orchestrationContext?: OrchestrationToolContext,
	): Promise<ToolResult> {
		// 1. Look up tool in registry
		const tool = this.tools.get(toolName);
		if (!tool) {
			log.warn("Tool not found", { toolName });
			return {
				tool_name: toolName,
				success: false,
				result: "",
				error: `Tool not found: ${toolName}. Available tools: ${Array.from(this.tools.keys()).join(", ")}`,
			};
		}

		// Create the tool call record
		const toolCall: ToolCall = {
			tool_name: toolName,
			parameters,
			status: "pending",
		};

		// Emit started event
		this.events.onToolCallStarted?.(toolCall, messageId);

		// --- Policy evaluation (pure engine) ---
		// Every dispatch context builds a per-session `policyCtx` and threads it
		// here, so `evaluateToolPolicy()` is the single policy engine — command
		// patterns, path allowlists, plan-mode, denylist, and enabled checks all
		// run through it. (The legacy inline branch was removed in F2 Phase D once
		// the tripwire confirmed no context reached dispatch without a ctx.)
		const decision = evaluateToolPolicy(toolName, parameters, tool, policyCtx);

		if (!decision.allowed) {
			toolCall.status = "error";
			this.events.onToolCallStatusChanged?.(toolCall, messageId);

			const result: ToolResult = {
				tool_name: toolName,
				success: false,
				result: "",
				error: decision.error ?? "Tool call blocked by policy.",
			};

			log.info("Tool blocked by policy", { toolName, error: decision.error });
			this.events.onToolCallResult?.(toolCall, result, messageId);
			return result;
		}

		// Approval resolution (approval ≠ policy — kept in the dispatcher). Prefer
		// the per-call callback (sessions), falling back to the instance callback
		// set via setApprovalCallback — the sub-agent seam.
		const approvalCb = perCallApprovalCallback ?? this.approvalCallback;

		if (!decision.autoApproved) {
			if (!approvalCb) {
				log.warn("No approval callback set, auto-approving", { toolName });
			} else {
				const userDecision = await this.raceApprovalSources(
					toolCall, toolName, parameters, mode,
					approvalCb, abortSignal, messageId, approvalHookDispatcher,
				);

				if (userDecision === "rejected" || userDecision === "timed_out") {
					toolCall.status = "rejected";
					this.events.onToolCallStatusChanged?.(toolCall, messageId);

					const error = userDecision === "timed_out"
						? `Tool call '${toolName}' was not approved within ${this.settings?.approval_timeout ?? 0} seconds and was automatically skipped. The user may be away — proceed without this tool's output.`
						: `Tool call rejected by user. The user chose not to approve this ${toolName} operation.`;

					const result: ToolResult = {
						tool_name: toolName,
						success: false,
						result: "",
						error,
					};

					log.info(userDecision === "timed_out" ? "Tool call timed out waiting for approval" : "Tool call rejected by user", { toolName });
					this.events.onToolCallResult?.(toolCall, result, messageId);
					return result;
				}
			}
		} else if (approvalCb && !tool.internal) {
			// Auto-approved: render the collapsed diff for after-the-fact review.
			// Internal tools (only update_tasks) stay invisible — they fire no render.
			// Fire-and-forget, so the reason must travel at call time.
			void approvalCb(
				toolCall,
				abortSignal,
				messageId,
				decision.autoApproveReason ? { reason: decision.autoApproveReason } : true,
			);
		}

		// Mark as approved
		toolCall.status = "approved";
		this.events.onToolCallStatusChanged?.(toolCall, messageId);

		// 6. Execute tool — race against abort signal so the user is unblocked
		//    immediately when they click Stop. The tool may continue running in
		//    the background but its result is discarded.
		const startTime = Date.now();
		try {
			// Bind messageId + abortSignal so the scaffold's `utils.ask` routes
			// the question to the correct tool-call card and unwinds on abort.
			const boundInteractionCallback = interactionCallback
				? (request: InteractionRequest, signal?: AbortSignal) =>
					interactionCallback(request, signal ?? abortSignal, messageId)
				: undefined;
			// Tools that return *other* notes' paths or content filter their results
			// against the effective vault-read access lists, since the hard gate only
			// inspects a call's own arguments.
			const pathFilter = buildVaultReadFilter(
				policyCtx.effectiveConfig.tools[toolName],
				policyCtx.sessionAllowedPaths,
			);
			const executeOptions: ToolExecuteOptions = { onProgress, mode, abortSignal, sessionContext, silentNoteOpener: this.silentMode || undefined, noteOpenerEnabled: this.openNotesOverride ?? undefined, interactionCallback: boundInteractionCallback, runContext, orchestrationContext, pathFilter };
			const executePromise = tool.execute(parameters, executeOptions);

			let result: ToolResult;
			if (abortSignal) {
				const abortPromise = new Promise<ToolResult>((resolve) => {
					if (abortSignal.aborted) {
						resolve({
							tool_name: toolName, success: false, result: "",
							error: "Tool call cancelled by user.",
						});
						return;
					}
					abortSignal.addEventListener("abort", () => {
						resolve({
							tool_name: toolName, success: false, result: "",
							error: "Tool call cancelled by user.",
						});
					}, { once: true });
				});
				result = await Promise.race([executePromise, abortPromise]);
			} else {
				result = await executePromise;
			}

			const duration = Date.now() - startTime;
			result.duration_ms = duration;

			// Dispatcher-level spillover: catches MCP tools and extension tools
			// whose results exceed the output cap. Built-in tools (execute_command,
			// fetch_webpage) handle spillover internally and return short results.
			if (this.spiller && result.success && typeof result.result === "string") {
				const threshold = (this.settings?.output_spillover_threshold ?? 50_000);
				if (result.result.length > threshold) {
					const truncated = result.result.substring(0, threshold);
					try {
						result = {
							...result,
							result: await this.spiller.spillToFile(toolName, result.result, truncated, threshold),
						};
					} catch (e) {
						log.warn("Dispatcher spillover failed", { toolName, error: String(e) });
					}
				}
			}

			toolCall.status = result.success ? "success" : "error";
			this.events.onToolCallStatusChanged?.(toolCall, messageId);
			this.events.onToolCallResult?.(toolCall, result, messageId);

			log.info("Tool executed", {
				toolName,
				success: result.success,
				durationMs: duration,
			});

			return result;
		} catch (e) {
			const duration = Date.now() - startTime;
			toolCall.status = "error";
			this.events.onToolCallStatusChanged?.(toolCall, messageId);

			const result: ToolResult = {
				tool_name: toolName,
				success: false,
				result: "",
				error: `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`,
				duration_ms: duration,
			};

			log.error("Tool execution failed", {
				toolName,
				error: String(e),
				durationMs: duration,
			});

			this.events.onToolCallResult?.(toolCall, result, messageId);
			return result;
		}
	}

	// -----------------------------------------------------------------------
	// Introspection
	// -----------------------------------------------------------------------

	/**
	 * Check if a tool name is a write tool.
	 */
	isWriteTool(toolName: string): boolean {
		const tool = this.tools.get(toolName);
		return tool?.mode === "write";
	}

	/**
	 * Check if an MCP tool has an explicit user classification of "read".
	 *
	 * Used by tool orchestration to allow concurrency for MCP tools that
	 * the user has explicitly marked as read-only (via toolClassifications
	 * in the MCP server config). Without an explicit override, MCP tools
	 * are conservatively treated as non-concurrent.
	 */
	hasExplicitUserReadClassification(toolName: string): boolean {
		const tool = this.tools.get(toolName);
		if (!(tool instanceof McpRegisteredTool)) return false;
		const config = tool.getServerConfig();
		const rawName = tool.getRawToolName();
		return config.toolClassifications?.[rawName] === "read";
	}

	/**
	 * Get all registered tool names.
	 */
	getRegisteredToolNames(): string[] {
		return Array.from(this.tools.keys());
	}

	/**
	 * Check if a tool is registered.
	 */
	hasTool(toolName: string): boolean {
		return this.tools.has(toolName);
	}

}