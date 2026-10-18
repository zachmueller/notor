/**
 * Per-run tool policy for a circuit: the Plan/Act mode its step turns run in
 * and the channel that approves tool calls policy leaves for a human.
 *
 * A root run resolves its policy once at launch. `run_flow` children and
 * `notor-on-complete-flow` successors inherit the parent's policy through the
 * {@link CircuitRunRegistry} (keyed by the parent session id), so a whole run
 * tree shares one mode and one approval channel.
 */

import type { ApprovalCallback, ApprovalHookDispatcher } from "../chat/dispatcher";
import type { ApprovalOverride } from "../chat/tool-policy";
import type { ConversationMode } from "../types";
import type { CircuitHost } from "./host";

/** The approval channel a host supplies for runs with no chat panel. */
export interface RunApprovalChannel {
	callback: ApprovalCallback;
	/** The `on_approval_required` hook seam, raced against the callback. */
	hook?: ApprovalHookDispatcher;
}

export interface CircuitRunPolicy {
	mode: ConversationMode;
	/**
	 * Approves step tool calls that aren't auto-approved. Undefined only for
	 * hosts with no approval channel (narrow test hosts), where the dispatcher
	 * falls back to auto-approving.
	 */
	approvalCallback?: ApprovalCallback;
	approvalHook?: ApprovalHookDispatcher;
	/** Set by programmatic launches (the external API); folded into every step's policy context. */
	approvalOverride?: ApprovalOverride;
}

/**
 * Resolve the policy for a launch or resume: an explicit policy wins, then the
 * parent session's (children and chaining successors), then a fresh default
 * from the host. An explicit `mode` overrides the inherited one.
 */
export function resolveRunPolicy(
	host: CircuitHost,
	flowName: string,
	opts: { policy?: CircuitRunPolicy; parentSessionId?: string | null; mode?: ConversationMode },
): CircuitRunPolicy {
	if (opts.policy) return opts.policy;

	const inherited = opts.parentSessionId
		? host.getCircuitRunRegistry().getPolicy(opts.parentSessionId)
		: undefined;
	if (inherited) return opts.mode ? { ...inherited, mode: opts.mode } : inherited;

	const channel = host.getRunApproval?.(`Circuit '${flowName}'`);
	return {
		mode: opts.mode ?? host.settings.mode,
		approvalCallback: channel?.callback,
		approvalHook: channel?.hook,
	};
}
