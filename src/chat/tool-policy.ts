/**
 * Tool policy evaluation — pure function for per-dispatch policy checks.
 *
 * Extracted from `ToolDispatcher.dispatch()` to enable per-session policy
 * evaluation without shared mutable state. Each `ConversationSession` builds
 * a `ToolPolicyContext` from its own resolved config, and this function
 * evaluates policy decisions without side effects.
 *
 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1a
 */

import type { ConversationMode } from "../types";
import type { EffectiveToolConfig } from "../tool-config/types";
import type { DispatchableTool } from "./dispatcher";
import { isDomainBlocked } from "../utils/domain-denylist";
import { enforcePathConstraints, evaluatePathApproval } from "../tool-config/path-enforcer";
import { isMcpTool } from "../mcp/mcp-tool-adapter";
import { matchCommandPattern } from "../utils/command-pattern-matcher";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context for evaluating tool policy — all data comes from the session,
 * not from shared mutable state.
 */
export interface ToolPolicyContext {
	effectiveConfig: EffectiveToolConfig;
	mode: ConversationMode;
	domainDenylist?: string[];
	vaultRootPath: string;
	/** Optional resolver for vault note paths (3-step resolution). Returns canonical path or null. */
	resolveVaultPath?: (path: string) => string | null;
	/**
	 * Orchestration scratchpad auto-allow (INT-001 / FR-121): extra allowed roots
	 * for this session, layered on top of the tool's configured `allowed_paths`
	 * without mutating the shared/global config. The orchestration call sites
	 * source these from the active `OrchestrationToolContext` (scratchpad +
	 * optional parent scratchpad). Non-orchestration callers omit it and behave
	 * exactly as today. `blocked_paths` still takes precedence.
	 */
	sessionAllowedPaths?: string[];
}

/**
 * Result of a tool policy evaluation.
 *
 * - `allowed: false` → tool call is blocked, `error` describes why.
 * - `allowed: true, autoApproved: true` → tool call proceeds without user approval.
 * - `allowed: true, autoApproved: false` → tool call requires user approval.
 */
export interface PolicyDecision {
	allowed: boolean;
	autoApproved: boolean;
	error?: string;
	/**
	 * Why the call was auto-approved, when a path rule decided it (e.g.
	 * `matched ai/`). Rendered on the collapsed approval card so a silent
	 * auto-approve is explicable. Absent when auto-approval came from the plain
	 * `auto_approve` setting or a command pattern.
	 */
	autoApproveReason?: string;
}

// ---------------------------------------------------------------------------
// Pure policy evaluation
// ---------------------------------------------------------------------------

/**
 * Human-readable descriptions for write tools blocked in Plan mode.
 *
 * Used by the plan-mode block message in {@link evaluateToolPolicy}. Names are
 * the plugin's real write tools; the fallback covers everything else.
 */
export function getWriteToolDescription(toolName: string): string {
	const descriptions: Record<string, string> = {
		write_note: "create or modify notes",
		replace_in_note: "edit notes",
		update_frontmatter: "modify note frontmatter",
		manage_tags: "modify note tags",
		execute_command: "run shell commands",
		write_file: "write files",
		delete_note: "delete notes",
		move_note: "move notes",
		apply_template: "apply templates",
	};
	return descriptions[toolName] ?? "perform write operations";
}

/**
 * Pure function — evaluates tool policy without reading any shared state.
 *
 * Extracts these checks from dispatcher.ts:
 * - Enabled check (FR-83)
 * - Plan/Act mode check (FR-14)
 * - Domain denylist check (fetch_webpage only)
 * - Auto-approve resolution (DISP-004)
 * - Path enforcement (FR-84)
 *
 * @param toolName   - The tool name (namespaced for MCP tools)
 * @param parameters - The tool call parameters
 * @param tool       - The tool instance from the registry
 * @param ctx        - Policy context built from the session's resolved config
 * @returns A `PolicyDecision` indicating whether the call is allowed and auto-approved
 */
export function evaluateToolPolicy(
	toolName: string,
	parameters: Record<string, unknown>,
	tool: DispatchableTool,
	ctx: ToolPolicyContext,
): PolicyDecision {
	if (tool.internal) {
		return { allowed: true, autoApproved: true };
	}

	// 1. Enabled check — block disabled tools (FR-83)
	const toolEntry = ctx.effectiveConfig.tools[toolName];
	if (toolEntry && !toolEntry.enabled) {
		return {
			allowed: false,
			autoApproved: false,
			error: `Tool '${toolName}' is disabled and cannot be used in this context.`,
		};
	}

	// 2. Plan/Act mode check — block write tools in Plan mode
	if (ctx.mode === "plan" && tool.mode === "write") {
		// FEAT-001: MCP tools get a specific error message format per spec FR-59
		const planModeError = isMcpTool(toolName)
			? `Tool '${toolName}' is write-only and blocked in Plan mode. Switch to Act mode to use this tool.`
			: `${toolName} is not available in Plan mode. Switch to Act mode to ${getWriteToolDescription(toolName)}.`;

		return {
			allowed: false,
			autoApproved: false,
			error: planModeError,
		};
	}

	// 3. Domain denylist check (fetch_webpage only)
	if (toolName === "fetch_webpage" && ctx.domainDenylist) {
		const url = parameters["url"] as string;
		if (url) {
			const denyCheck = isDomainBlocked(url, ctx.domainDenylist);
			if (denyCheck.blocked) {
				let hostname: string;
				try {
					hostname = new URL(url).hostname;
				} catch {
					hostname = url;
				}
				return {
					allowed: false,
					autoApproved: false,
					error: `Domain ${hostname} is blocked by your denylist.`,
				};
			}
		}
	}

	// 4. Auto-approve resolution (DISP-004)
	// When effectiveConfig is active, use its merged auto_approve as unified source
	const isAutoApproved = toolEntry?.auto_approve ?? false;

	// 4b. Command pattern override for execute_command
	let finalAutoApproved = isAutoApproved;
	if (toolName === "execute_command" && toolEntry) {
		const command = parameters["command"];
		if (typeof command === "string") {
			if (toolEntry.blocked_command_patterns.length > 0) {
				const deny = matchCommandPattern(command, toolEntry.blocked_command_patterns);
				if (deny.matched) {
					finalAutoApproved = false;
				} else if (!isAutoApproved && toolEntry.allowed_command_patterns.length > 0) {
					const allow = matchCommandPattern(command, toolEntry.allowed_command_patterns);
					if (allow.matched) finalAutoApproved = true;
				}
			} else if (!isAutoApproved && toolEntry.allowed_command_patterns.length > 0) {
				const allow = matchCommandPattern(command, toolEntry.allowed_command_patterns);
				if (allow.matched) finalAutoApproved = true;
			}
		}
	}

	// 4c. Path-based auto-approve override (any tool with registered path params).
	// Soft gate: flips whether the human sees a prompt, never whether the call is
	// allowed — that stays with step 5 below.
	let autoApproveReason: string | undefined;
	if (toolEntry) {
		const match = evaluatePathApproval(
			toolName,
			parameters,
			toolEntry,
			ctx.vaultRootPath,
			ctx.resolveVaultPath,
		);
		if (match.verdict === "never") {
			finalAutoApproved = false;
		} else if (match.verdict === "allow" && !finalAutoApproved) {
			finalAutoApproved = true;
			autoApproveReason = `matched ${match.prefix}`;
		}
	}

	// 5. Path enforcement — check allowed_paths/blocked_paths (FR-84)
	if (toolEntry) {
		const pathError = enforcePathConstraints(
			toolName,
			parameters,
			toolEntry,
			ctx.vaultRootPath,
			ctx.resolveVaultPath,
			ctx.sessionAllowedPaths,
		);
		if (pathError) {
			return {
				allowed: false,
				autoApproved: false,
				error: pathError,
			};
		}
	}

	return {
		allowed: true,
		autoApproved: finalAutoApproved,
		...(finalAutoApproved && autoApproveReason ? { autoApproveReason } : {}),
	};
}
