import { scaffold } from "./_scaffold-helper";

/**
 * `invoke_workflow` — the step→workflow invocation tool (INT-031 / FR-151).
 *
 * A conversation step calls this to delegate a well-bounded sub-task to a named
 * single-turn **workflow** (a reusable prompt template), awaiting the workflow's
 * final assistant text **into the step's context** so the step can reason over it
 * before emitting its own event. Distinct from `run_flow` (Phase 7): there is no
 * child flow session, no terminal event, no structured return — just a workflow's
 * single-turn output folded back inline.
 *
 * The tool reaches the seam through the `utils.invokeWorkflow` bridge, which
 * resolves the workflow by name (`discoverWorkflows`) and drives the existing
 * background-workflow loop (`src/chat/workflow-executor.ts`) to completion (one
 * tool call per iteration), then reports `{ text, costUsd, iterations }`.
 *
 * **Budget accounting (FR-151 / Issue-13h).** The invoked workflow runs
 * **uncapped** during the call (the background loop has no per-run cap and no
 * `RunContext`), so the aggregate overshoot is **unbounded** (a whole workflow
 * run) — unlike `run_flow`'s bounded soft ceiling. This tool captures the
 * workflow's reported spend onto the per-step `orchestrationContext.workflowInvocations`
 * accumulator; `StepTurnExecutor` folds it into the shared aggregate-budget cell
 * **after** the turn (`decrementAggregate`), so the ceiling is accurate going
 * forward but is not enforced during the call. Treat a step→workflow call as a
 * deliberate, potentially expensive delegation.
 *
 * Gated `featureGroup: "orchestration"`, so the `ExtensionManager` only
 * compiles/registers it when `orchestration_enabled`. Mode `write` (Act only),
 * mirroring `emit_event`. Absent an `orchestrationContext` (reached outside a step
 * turn) or an `invokeWorkflow` bridge (no live orchestrator), it returns an error.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-5-interactive-workflow.md — INT-031
 * @see specs/ZZ-misc/orchestration/contracts/tools.md — run_flow vs step→workflow
 */
export const INVOKE_WORKFLOW = scaffold(
	"invoke_workflow",
	"Invoke a named single-turn workflow to direct a sub-task, awaiting its result into your context. Use for a well-bounded delegation (a reusable prompt template); the workflow runs uncapped, so treat it as a deliberate, potentially expensive call.",
	"write",
	`params:
  workflow:
    type: string
    description: "Name of the workflow to invoke (its display name, e.g. 'summarize' or 'daily/review')."
  task:
    type: string
    description: "The task / direction folded into the workflow's prompt as supplementary text."
required: [workflow, task]`,
	`if (!params.workflow || typeof params.workflow !== "string") {
  return { __toolError: true, error: "Missing required parameter: workflow" };
}
if (typeof params.task !== "string") {
  return { __toolError: true, error: "Missing required parameter: task" };
}

const workflowName = (params.workflow).trim();
const task = params.task;

// Only valid from within an orchestration step turn (the carriage threads the
// spend accumulator the executor reconciles after the turn).
const ctx = utils.orchestrationContext;
if (!ctx) {
  return {
    __toolError: true,
    error: "invoke_workflow can only be called from within an orchestration step turn.",
  };
}

// The bridge is null when no live chat orchestrator is available (e.g. a
// hook-launched flow with no chat panel) — error cleanly (documented v1 limit).
if (!utils.invokeWorkflow) {
  return {
    __toolError: true,
    error: "invoke_workflow requires an active chat panel in v1; no orchestrator is available.",
  };
}

let result;
try {
  result = await utils.invokeWorkflow(workflowName, task);
} catch (e) {
  return {
    __toolError: true,
    error: "Workflow '" + workflowName + "' failed: " + (e && e.message ? e.message : String(e)),
  };
}

// Post-hoc budget reconciliation hook (FR-151): record the workflow's reported
// spend so StepTurnExecutor folds it into the shared aggregate cell after the
// turn. The background loop has no RunContext, so this is the only accounting.
if (Array.isArray(ctx.workflowInvocations)) {
  ctx.workflowInvocations.push({
    costUsd: typeof result.costUsd === "number" ? result.costUsd : 0,
    iterations: typeof result.iterations === "number" ? result.iterations : 0,
  });
}

// Return the workflow's final assistant text into the step's context.
return "Workflow '" + workflowName + "' returned:\\n\\n" + (result.text || "(no output)");`,
	"orchestration",
);
