import { scaffold } from "./_scaffold-helper";

/**
 * `circuit_task_list` (formerly `orchestration_task_list`) (INT-002) — list the session's tasks.
 *
 * Returns the current session's tasks, optionally filtered by status. The only
 * **read**-mode task tool. Resolves the session `tasks/` directory off the
 * per-step `orchestrationContext` and dispatches through
 * `utils.orchestrationTasks`. Gated `featureGroup: "circuits"` (legacy group id `orchestration` still accepted).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-002
 * @see specs/ZZ-misc/orchestration/contracts/tools.md — Task tools
 */
export const CIRCUIT_TASK_LIST = scaffold(
	"circuit_task_list",
	"List the current session's circuit tasks, optionally filtered by status. (Formerly orchestration_task_list.)",
	"read",
	`params:
  filter:
    type: object
    optional: true
    properties:
      status:
        type: string
        enum: [open, running, closed]
    description: "Optional status filter."`,
	`const ctx = utils.orchestrationContext;
if (!ctx) {
  return { __toolError: true, error: "circuit_task_list can only be called from within a circuit step turn." };
}

const filter = params.filter && typeof params.filter === "object" ? params.filter : undefined;
const status = filter && typeof filter.status === "string" ? filter.status : undefined;

const tasks = await utils.orchestrationTasks.list(ctx.tasksPath, status ? { status } : undefined);
return {
  count: tasks.length,
  tasks: tasks.map((t) => ({
    key: t.key,
    status: t.status,
    description: t.description,
    created: t.created,
    started: t.started,
    completed: t.completed,
  })),
};`,
	"circuits",
);
