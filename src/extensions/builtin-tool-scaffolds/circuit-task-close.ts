import { scaffold } from "./_scaffold-helper";

/**
 * `circuit_task_close` (formerly `orchestration_task_close`) (INT-002) — move a task to `closed`.
 *
 * Sets `notor-task-status: closed` and stamps `notor-task-completed`. Unknown
 * key → `success: false`. Closing all tasks is what lets a `FLOW_COMPLETE` pass
 * the engine's completion-task enforcement (INT-003). Gated
 * `featureGroup: "circuits"`; mode `write`.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-002
 * @see specs/ZZ-misc/orchestration/contracts/tools.md — Task tools
 */
export const CIRCUIT_TASK_CLOSE = scaffold(
	"circuit_task_close",
	"Mark a circuit task as closed (stamps the completed timestamp). (Formerly orchestration_task_close.)",
	"write",
	`params:
  key:
    type: string
    description: "Task key to close (must already exist)."
required: [key]`,
	`if (!params.key || typeof params.key !== "string") {
  return { __toolError: true, error: "Missing required parameter: key" };
}

const ctx = utils.orchestrationContext;
if (!ctx) {
  return { __toolError: true, error: "circuit_task_close can only be called from within a circuit step turn." };
}

const result = await utils.orchestrationTasks.close(ctx.tasksPath, params.key);
if (!result.ok) {
  return { __toolError: true, error: result.error || ("Could not close task '" + params.key + "'.") };
}
return "Task '" + params.key + "' is now closed.";`,
	"circuits",
);
