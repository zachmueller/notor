/**
 * SubAgentRunner — a thin adapter over the generalized {@link RunLoop} engine.
 *
 * Historically this class owned the sub-agent turn loop directly. The loop was
 * lifted into `src/run-loop/run-loop.ts` (ARCH-002); `SubAgentRunner` is now an
 * adapter that:
 * - constructs `RunLoopOptions` seeding **`maxDepth = 0`**, a **fresh** both-
 *   `Infinity` aggregate `budget` cell, a fresh write-only `subtreeConsumed`,
 *   `orchestrationContext: undefined`, **no** `settings` (so per-turn cost stays
 *   `0`), and **no** persistence hooks (only `onProgress`);
 * - maps the engine's {@link RunResult} → {@link SubAgentResult} (a strict
 *   subset — `structured` is dropped; the `stopReason` union narrows to the
 *   reachable sub-agent reasons, dropping only `cost_cap`/`depth_cap`, which are
 *   unreachable with an `Infinity` cell and `maxDepth = 0`).
 *
 * With the aggregate cell at `Infinity` and `maxDepth = 0`, the two-layer
 * decision rule reduces to exactly today's single `iterationCount < iterationCap`
 * check — so sub-agent caps, wind-down, and abort cascading are byte-identical to
 * HEAD (the RunLoop Regression Gate, TEST-001).
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 9.1
 * @see specs/ZZ-misc/orchestration/contracts/run-loop.md — Behavior-preservation gate
 */

import type { LLMProvider, ChatMessage, ToolDefinition } from "../providers/provider";
import type { ConversationMode } from "../types";
import type { ToolDispatcher } from "./dispatcher";
import type { ToolPolicyContext } from "./tool-policy";
import { RunLoop } from "../run-loop/run-loop";
import { newRootBudget, deriveChildContext } from "../run-loop/budget";
import type { RunContext } from "../run-loop/types";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result returned by a sub-agent execution.
 *
 * A strict subset of {@link RunResult}: it omits `structured` (always null for
 * sub-agents) and narrows `stopReason` to the reachable sub-agent reasons.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 9.1
 */
/** Why the sub-agent stopped. */
export type SubAgentStopReason =
	| "completed"
	| "iteration_cap"
	| "token_limit"
	| "context_window"
	| "error"
	| "cancelled";

export interface SubAgentResult {
	/** Final text response from the sub-agent. */
	text: string;
	/** Full conversation messages (for history persistence). */
	messages: ChatMessage[];
	/** Cumulative token usage across all iterations. */
	tokenUsage: { input: number; output: number };
	/** Number of LLM turns executed. */
	iterationCount: number;
	/** Why the sub-agent stopped. */
	stopReason: SubAgentStopReason;
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface SubAgentRunnerOptions {
	/** Resolved LLM provider instance. */
	provider: LLMProvider;
	/** Model ID for this sub-agent. */
	model: string;
	/** Full system prompt (preamble + profile body). */
	systemPrompt: string;
	/** Tool definitions available to this sub-agent (already filtered). */
	toolDefinitions: ToolDefinition[];
	/** Dispatcher with pre-clamped effective config. */
	dispatcher: ToolDispatcher;
	/** Parent's abort signal — triggers cancellation of this sub-agent. */
	parentAbortSignal: AbortSignal;
	/** Maximum LLM turns (default: SUB_AGENT_ITERATION_CAP). */
	iterationCap?: number;
	/** Maximum total tokens (input + output). 0 = no limit. */
	tokenLimit?: number;
	/** Inherited from parent conversation (Section 9.6). */
	mode: ConversationMode;
	/** Inherited thinking level from parent session (null = off). */
	thinkingLevel?: string | null;
	/** Optional progress callback (Section 9.5). */
	onProgress?: (status: string) => void;
	/**
	 * Parent run's {@link RunContext}, when this sub-agent is spawned from inside
	 * another run tree (a flow dispatching `use_subagent` at `maxDepth ≥ 1`). When
	 * supplied, the child inherits the parent's SHARED aggregate budget cell by
	 * reference and `depth + 1` (so its turns draw down the same tree-wide
	 * ceiling). When omitted (today's foreground-chat sub-agent), the runner seeds
	 * a fresh `maxDepth = 0` / both-`Infinity` context — behavior unchanged.
	 */
	parentRunContext?: RunContext;
	/**
	 * Per-run tool-policy context (F2). Built by the sub-agent assembly site from
	 * the intersected effective config + the tool's settings reference, and
	 * threaded into every tool dispatch so command patterns / path allowlists /
	 * plan-mode / denylist gate sub-agent tool calls (they previously ran the
	 * dispatcher's legacy inline branch). Required since F2 Phase D removed that
	 * branch — the sub-agent assembly always builds one.
	 */
	policyCtx: ToolPolicyContext;
}

// ---------------------------------------------------------------------------
// SubAgentRunner
// ---------------------------------------------------------------------------

export class SubAgentRunner {
	private readonly options: SubAgentRunnerOptions;

	constructor(options: SubAgentRunnerOptions) {
		this.options = options;
	}

	/**
	 * Run the sub-agent conversation loop by delegating to {@link RunLoop}.
	 *
	 * @param taskPrompt - The task/question for the sub-agent to complete.
	 * @returns Sub-agent result with text, messages, and token usage.
	 */
	async run(taskPrompt: string): Promise<SubAgentResult> {
		// Seed the sub-agent RunContext.
		//
		// - No parent context (today's foreground-chat sub-agent): seed a fresh
		//   maxDepth = 0 / both-Infinity cell so the per-run cap is the only
		//   effective limit — byte-identical to HEAD.
		// - With a parent context (a flow spawning use_subagent at maxDepth ≥ 1):
		//   inherit the parent's SHARED budget cell by reference and depth + 1, so
		//   the child's turns draw down the same tree-wide ceiling.
		//
		// The abort signal is the parent's — RunLoop links its own controller to it
		// and cleans up the listener in its finally block (one add + one remove).
		const runContext: RunContext = this.options.parentRunContext
			? { ...deriveChildContext(this.options.parentRunContext), abort: this.options.parentAbortSignal }
			: {
				depth: 0,
				maxDepth: 0,
				budget: newRootBudget(Infinity, Infinity),
				subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: 0 },
				abort: this.options.parentAbortSignal,
			};

		const runLoop = new RunLoop({
			provider: this.options.provider,
			model: this.options.model,
			systemPrompt: this.options.systemPrompt,
			toolDefinitions: this.options.toolDefinitions,
			dispatcher: this.options.dispatcher,
			mode: this.options.mode,
			iterationCap: this.options.iterationCap,
			tokenLimit: this.options.tokenLimit,
			thinkingLevel: this.options.thinkingLevel,
			runContext,
			// No settings → per-turn cost stays 0 (the Infinity cell never blocks
			// anyway); no orchestrationContext and no hooks → today's behavior.
			orchestrationContext: undefined,
			policyCtx: this.options.policyCtx,
			onProgress: this.options.onProgress,
		});

		const result = await runLoop.run(taskPrompt);

		// Map RunResult → SubAgentResult (strict subset). `structured` is dropped.
		// `SubAgentStopReason` now includes `error`/`cancelled` (both reachable: a
		// provider/parser stream error and a parent/mid-stream abort respectively).
		// The narrowing cast remains sound because the ONLY `RunStopReason` members
		// `SubAgentStopReason` omits — `cost_cap`/`depth_cap` — stay unreachable here
		// (fresh both-`Infinity` cell + `maxDepth = 0`).
		return {
			text: result.text,
			messages: result.messages,
			tokenUsage: result.tokenUsage,
			iterationCount: result.iterationCount,
			stopReason: result.stopReason as SubAgentStopReason,
		};
	}
}
