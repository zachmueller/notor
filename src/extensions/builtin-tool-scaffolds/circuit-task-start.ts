import { scaffold } from "./_scaffold-helper";

/**
 * `circuit_task_start` (formerly `orchestration_task_start`) (INT-002) — move a task to `running`.
 *
 * Sets `notor-task-status: running` and stamps `notor-task-started`. Unknown key
 * → `success: false`. Resolves the session `tasks/` directory off the per-step
 * `orchestrationContext` and dispatches through `utils.orchestrationTasks`.
 * Gated `featureGroup: "circuits"` (legacy group id `orchestration` still accepted); mode `write`.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-002
 * @see specs/ZZ-misc/orchestration/contracts/tools.md — Task tools
 */
export const CIRCUIT_TASK_START = scaffold(
	"circuit_task_start",
	"Mark a circuit task as running (stamps the started timestamp). (Formerly orchestration_task_start.)",
	"write",
	`params:
  key:
    type: string
    description: "Task key to start (must already exist)."
required: [key]`,
	`if (!params.key || typeof params.key !== "string") {
  return { __toolError: true, error: "Missing required parameter: key" };
}

const ctx = utils.orchestrationContext;
if (!ctx) {
  return { __toolError: true, error: "circuit_task_start can only be called from within a circuit step turn." };
}

const result = await utils.orchestrationTasks.start(ctx.tasksPath, params.key);
if (!result.ok) {
  return { __toolError: true, error: result.error || ("Could not start task '" + params.key + "'.") };
}
return "Task '" + params.key + "' is now running.";`,
	"circuits",
);
