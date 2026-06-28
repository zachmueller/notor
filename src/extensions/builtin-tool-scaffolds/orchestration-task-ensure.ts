import { scaffold } from "./_scaffold-helper";

/**
 * `orchestration_task_ensure` (INT-002) — idempotently create a task note.
 *
 * Resolves the active session's `tasks/` directory from the per-step
 * `orchestrationContext` (threaded onto `utils`) and dispatches through the
 * shared `TaskRegistry` (`utils.orchestrationTasks`). **Idempotent:** creates
 * `{key}.md` with status `open` if absent; a second call with the same key is a
 * no-op (no duplicate, no status reset) — the property that makes session
 * recovery replay safe (FR-122 → FR-125).
 *
 * Gated `featureGroup: "orchestration"` (registered only when
 * `orchestration_enabled`). Mode `write` (Act only).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-002
 * @see specs/ZZ-misc/orchestration/contracts/tools.md — Task tools
 */
export const ORCHESTRATION_TASK_ENSURE = scaffold(
	"orchestration_task_ensure",
	"Idempotently create an orchestration task (status open) in the current session's task registry.",
	"write",
	`params:
  key:
    type: string
    description: "Unique, stable task key (e.g. step-01-impl). Same key is idempotent."
  description:
    type: string
    description: "Human-readable task description."
required: [key, description]`,
	`if (!params.key || typeof params.key !== "string") {
  return { __toolError: true, error: "Missing required parameter: key" };
}
if (typeof params.description !== "string") {
  return { __toolError: true, error: "Missing required parameter: description" };
}

const ctx = utils.orchestrationContext;
if (!ctx) {
  return { __toolError: true, error: "orchestration_task_ensure can only be called from within an orchestration step turn." };
}

const result = await utils.orchestrationTasks.ensure(ctx.tasksPath, params.key, params.description);
return result.created
  ? "Created task '" + result.note.key + "' (status: open)."
  : "Task '" + result.note.key + "' already exists (status: " + result.note.status + "); no change.";`,
	"orchestration",
);
