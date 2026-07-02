/**
 * `run_flow` tool (INT-042 / INT-043 / FR-172 / FR-173) — invoke another
 * orchestration flow as a tool and return its result.
 *
 * It is a **single** tool whose `flow` parameter is a dynamic `enum` of discovered
 * invocable flow names (plus a single loose `payload` string) — **not** one tool
 * per flow, so flow names are enum *values* and cross-flow naming collisions are
 * sidestepped entirely. The dynamic `get description()` / `get input_schema()`
 * mirror `UseSubagentTool` (`src/tools/use-subagent.ts`): the cached invocable-flow
 * list is rebuilt at registration and at the start of each `execute()` (hot-reload).
 *
 * It is **gated** to `orchestration_enabled` by its registration (main.ts registers
 * it only when the feature group is on; the settings toggle re-gates it), and it is
 * **orchestration-context-only** (Issue-4): reached without an `orchestrationContext`
 * (a foreground-chat turn, a non-orchestration automation) it returns
 * `success: false` and spawns nothing — so a parentless, unrecoverable child flow
 * can never exist.
 *
 * The actual child-flow execution (child session, child `RunLoop`, the
 * `child.spawned`/`child.result` ledger) lives behind the injected
 * {@link SpawnChildFlow} callback (wired in `launch.ts`), so this tool stays free
 * of the plugin/launch stack.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — INT-042 / INT-043
 * @see specs/ZZ-misc/orchestration/contracts/tools.md — run_flow
 */

import type { Tool, JSONSchema, ToolExecuteOptions, ToolResult } from "./tool";
import type { FlowCompositionManager } from "../orchestration/flow-composition-manager";
import type { SpawnChildFlow } from "../orchestration/child-flow";
import { canSpawnChild } from "../run-loop/budget";
import { logger } from "../utils/logger";

const log = logger("RunFlowTool");

export const RUN_FLOW_TOOL_NAME = "run_flow";

/** A discovered invocable flow's name + its self-describing input contract. */
interface InvocableFlowSummary {
	name: string;
	inputs: string | null;
}

export class RunFlowTool implements Tool {
	readonly name = RUN_FLOW_TOOL_NAME;
	readonly mode = "write" as const;

	private cachedInvocable: InvocableFlowSummary[] = [];

	constructor(
		private readonly compositionManager: FlowCompositionManager,
		private readonly spawnChildFlow: SpawnChildFlow,
	) {}

	// -- Dynamic description & schema (mirrors UseSubagentTool) ----------------

	get description(): string {
		const base =
			"Run another orchestration flow to its terminal event and return its result " +
			"(prefer its structured return, else its closing text). Available flows:\n";
		if (this.cachedInvocable.length === 0) {
			return base + "(no invocable flows available)";
		}
		const lines = this.cachedInvocable.map(
			(f) => `- ${f.name}: ${f.inputs ?? "(no input contract declared)"}`,
		);
		return base + lines.join("\n");
	}

	get input_schema(): JSONSchema {
		return {
			type: "object",
			properties: {
				flow: {
					type: "string",
					description:
						"Which invocable flow to run. Each flow's notor-flow-inputs is surfaced in the description.",
					enum: this.cachedInvocable.map((f) => f.name),
				},
				payload: {
					type: "string",
					description: "Loose, natural-language input conforming to the callee's notor-flow-inputs.",
				},
			},
			required: ["flow", "payload"],
		};
	}

	/**
	 * Refresh the cached invocable-flow list from the {@link FlowCompositionManager}
	 * (a stateless re-scan). Called at registration and at the start of each
	 * `execute()` (hot-reload), exactly like `UseSubagentTool.refreshVisibleProfiles`.
	 */
	async refreshInvocableFlows(): Promise<void> {
		try {
			const flows = await this.compositionManager.listInvocableFlows();
			this.cachedInvocable = flows.map((f) => ({ name: f.name, inputs: f.flowInputs }));
		} catch (e) {
			log.warn("Failed to refresh invocable flows", { error: String(e) });
		}
	}

	// -- Execute ---------------------------------------------------------------

	async execute(
		params: Record<string, unknown>,
		options?: ToolExecuteOptions,
	): Promise<ToolResult> {
		await this.refreshInvocableFlows();

		const flowName = typeof params["flow"] === "string" ? params["flow"] : "";
		const payload = typeof params["payload"] === "string" ? params["payload"] : "";

		// (0) Orchestration-context-only (Issue-4 / FR-172). No orchestrationContext
		// ⇒ reached outside a flow step (foreground chat / non-orchestration caller)
		// ⇒ refuse: a child stamped origin: "run_flow" with no replayable parent
		// would be a silent, unrecoverable orphan.
		const orchestrationContext = options?.orchestrationContext;
		if (!orchestrationContext) {
			return this.fail("run_flow can only be called from within an orchestration flow.");
		}

		// (1) Resolve the selected flow. Unknown / no-longer-invocable → success:false.
		if (!flowName) {
			return this.fail("Missing required parameter: flow.");
		}
		const flow = await this.compositionManager.resolveFlow(flowName);
		if (!flow) {
			return this.fail(
				`Flow '${flowName}' is not an invocable flow (set notor-flow-invocable: true on its definition.md).`,
			);
		}

		// (2) Spawn gate over the SHARED budget cell + depth (the decision rule is the
		// authority of run-loop.md). A code-step run_flow threads the identical
		// runContext, so there is no code-step bypass of max_depth / the aggregate budget.
		const runContext = options?.runContext;
		if (runContext && !canSpawnChild(runContext)) {
			const reason =
				runContext.depth >= runContext.maxDepth
					? `composition depth cap reached (depth ${runContext.depth} ≥ max ${runContext.maxDepth})`
					: "aggregate budget exhausted (cost or iteration ceiling)";
			return this.fail(`Cannot run flow '${flowName}': ${reason}.`);
		}

		// (3) Spawn the child flow to its terminal event (child session, child
		// RunLoop, child.spawned/child.result ledger — all behind the callback).
		const viaToolCallId = `runflow-${crypto.randomUUID().slice(0, 12)}`;
		// F1 Fix 3: assign a replay-stable ordinal — the Nth run_flow dispatch for
		// this (step, flow) within the step's execution. Read-then-increment the
		// per-step counter on the carriage (v1 runs run_flow serially, so the count
		// is deterministic across a crash/replay). The recovered ledger is matched by
		// (stepName, flowName, ordinal), NOT viaToolCallId (which is re-minted).
		const ordinals = orchestrationContext.childSpawnOrdinals;
		const ordinal = ordinals?.get(flow.name) ?? 0;
		if (ordinals) ordinals.set(flow.name, ordinal + 1);
		let spawned;
		try {
			spawned = await this.spawnChildFlow({
				flowName: flow.name,
				payload,
				parentSessionId: orchestrationContext.sessionId,
				parentScratchpadPath: orchestrationContext.scratchpadPath,
				parentConversationId: orchestrationContext.conversationId,
				stepName: orchestrationContext.stepName,
				turn: orchestrationContext.turn,
				ordinal,
				viaToolCallId,
				cascade: runContext
					? { budget: runContext.budget, depth: runContext.depth, abort: runContext.abort }
					: {
							// No runContext (defensive — orchestration turns always thread one):
							// an unbounded cell + depth 0, so the child still runs.
							budget: { iterationsRemaining: Infinity, costRemainingUsd: Infinity },
							depth: 0,
							abort: options?.abortSignal ?? new AbortController().signal,
						},
			});
		} catch (e) {
			log.error("run_flow child spawn failed", { flow: flow.name, error: String(e) });
			return this.fail(
				`Running flow '${flow.name}' failed: ${e instanceof Error ? e.message : String(e)}`,
			);
		}

		// (4) Write the `child` edge onto the calling turn's carriage so the run-tree
		// can descend (calling step conversation → child flow entry conversation).
		if (spawned.entryConversationId && orchestrationContext.childEdges) {
			orchestrationContext.childEdges.push({
				kind: "child",
				conversation_id: spawned.entryConversationId,
				session_id: spawned.childSessionId,
				via_tool_call_id: viaToolCallId,
			});
		}

		// (5) Fold the child subtree into the calling turn's run-level rollup
		// (attribution only — the child's turns already drew down the shared cell).
		if (orchestrationContext.childRunResults) {
			orchestrationContext.childRunResults.push({
				costUsd: spawned.rollup.costUsd,
				iterations: spawned.rollup.iterations,
				maxDepthReached: spawned.rollup.maxDepthReached,
				tokenUsage: spawned.rollup.tokenUsage,
			});
		}

		// (6) Return — prefer `structured`, fall back to `text`. The shared
		// child_run_metadata block (INT-047) carries the aggregate-subtree rollup.
		const resultText =
			spawned.structured !== null && spawned.structured !== undefined
				? JSON.stringify(spawned.structured)
				: spawned.text;
		return {
			tool_name: RUN_FLOW_TOOL_NAME,
			success: spawned.status !== "error",
			result: resultText || `Flow '${flow.name}' finished (${spawned.status}).`,
			error: spawned.status === "error" ? spawned.text || "Child flow errored." : null,
			child_run_metadata: {
				entry_conversation_id: spawned.entryConversationId ?? undefined,
				session_id: spawned.childSessionId,
				token_usage: spawned.rollup.tokenUsage,
				cost_usd: spawned.rollup.costUsd,
				iteration_count: spawned.rollup.iterations,
				depth: spawned.rollup.maxDepthReached,
				stop_reason: spawned.stopReason,
				name: flow.name,
			},
		};
	}

	private fail(error: string): ToolResult {
		return { tool_name: RUN_FLOW_TOOL_NAME, success: false, result: "", error };
	}
}
