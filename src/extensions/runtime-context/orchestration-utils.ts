import type { BuilderContext, ExtensionUtils } from "./types";
import { normalizePath } from "obsidian";
import { TaskRegistry, type TaskFs, type TaskNote, type TaskStatus } from "../../orchestration/task-registry";
import { discoverWorkflows } from "../../workflows/workflow-discovery";
import { logger } from "../../utils/logger";

const log = logger("OrchestrationUtils");

/**
 * Build the `utils.orchestrationTasks` + `utils.invokeWorkflow` bridges.
 *
 * **`orchestrationTasks` (INT-002).** The four task-tool scaffolds
 * (`orchestration_task_ensure` / `_start` / `_close` / `_list`) are compiled
 * strings and cannot `import` the {@link TaskRegistry} directly, so — exactly as
 * `capture_memory` reaches the memory subsystem through `utils.memory` — they
 * reach the registry through this bridge. Each method takes the active session's
 * `tasksPath` (read by the scaffold off `utils.orchestrationContext`) so the
 * registry resolves nothing globally: a step in session A can only touch session
 * A's `tasks/` directory.
 *
 * **`invokeWorkflow` (INT-031 / FR-151).** The `invoke_workflow` scaffold reaches
 * the step→workflow seam through this bridge: it resolves a workflow by name via
 * `discoverWorkflows` and drives the live orchestrator's `runWorkflowHeadless`
 * (the existing background-workflow loop), returning the workflow's final text +
 * total spend. The bridge is `null` when no live chat orchestrator is available
 * (e.g. a hook-launched flow with no chat panel) — the tool then errors cleanly,
 * the documented v1 limitation.
 *
 * Both bridges are always present (cheap); the *tools* are feature-gated, so they
 * are never reachable unless `orchestration_enabled` and a step turn supplies an
 * `orchestrationContext`.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-002
 * @see specs/ZZ-misc/orchestration/tasks/phase-5-interactive-workflow.md — INT-031
 */
export function buildOrchestrationUtils(
	ctx: BuilderContext,
): Pick<ExtensionUtils, "orchestrationTasks" | "invokeWorkflow"> {
	const { plugin } = ctx;
	const adapter = plugin.app.vault.adapter;

	const fs: TaskFs = {
		exists: (path) => adapter.exists(normalizePath(path)),
		read: (path) => adapter.read(normalizePath(path)),
		write: async (path, data) => {
			const norm = normalizePath(path);
			const dir = norm.slice(0, norm.lastIndexOf("/"));
			if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
			await adapter.write(norm, data);
		},
		mkdir: async (path) => {
			const norm = normalizePath(path);
			if (!(await adapter.exists(norm))) await adapter.mkdir(norm);
		},
		list: async (dir) => {
			const norm = normalizePath(dir);
			if (!(await adapter.exists(norm))) return [];
			const listing = await adapter.list(norm);
			return listing.files;
		},
	};

	const registry = new TaskRegistry(fs);

	return {
		orchestrationTasks: {
			ensure: (tasksDir: string, key: string, description: string) =>
				registry.ensure(tasksDir, key, description),
			start: (tasksDir: string, key: string) => registry.start(tasksDir, key),
			close: (tasksDir: string, key: string) => registry.close(tasksDir, key),
			list: (tasksDir: string, filter?: { status?: TaskStatus }): Promise<TaskNote[]> =>
				registry.list(tasksDir, filter),
		},
		invokeWorkflow: async (workflowName: string, task: string) => {
			// Step→workflow runs the workflow headlessly through the live
			// orchestrator's background loop (INT-031, "wrap" the existing loop).
			// Absent a live panel (e.g. hook-launched flow, no chat view), there is
			// no orchestrator to drive it — surface a clear error to the step.
			const orchestrator = plugin.getActiveOrchestrator();
			if (!orchestrator) {
				throw new Error(
					"invoke_workflow requires an active chat panel in v1; no orchestrator is available.",
				);
			}
			const workflows = discoverWorkflows(
				plugin.app.vault,
				plugin.app.metadataCache,
				plugin.settings.notor_dir,
			);
			const workflow = workflows.find(
				(w) => w.display_name === workflowName || w.file_name === workflowName,
			);
			if (!workflow) {
				throw new Error(
					`Workflow '${workflowName}' not found under ${plugin.settings.notor_dir.replace(/\/$/, "")}/workflows/.`,
				);
			}
			log.info("Step→workflow invocation", { workflow: workflow.display_name });
			return orchestrator.runWorkflowHeadless(workflow, task);
		},
	};
}
