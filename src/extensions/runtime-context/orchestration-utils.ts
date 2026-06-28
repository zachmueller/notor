import type { BuilderContext, ExtensionUtils } from "./types";
import { normalizePath } from "obsidian";
import { TaskRegistry, type TaskFs, type TaskNote, type TaskStatus } from "../../orchestration/task-registry";

/**
 * Build the `utils.orchestrationTasks` bridge (INT-002).
 *
 * The four task-tool scaffolds (`orchestration_task_ensure` / `_start` /
 * `_close` / `_list`) are compiled strings and cannot `import` the
 * {@link TaskRegistry} directly, so — exactly as `capture_memory` reaches the
 * memory subsystem through `utils.memory` — they reach the registry through this
 * bridge. Each method takes the active session's `tasksPath` (read by the
 * scaffold off `utils.orchestrationContext`) so the registry resolves nothing
 * globally: a step in session A can only touch session A's `tasks/` directory.
 *
 * The bridge is always present (cheap); the *tools* are feature-gated, so it is
 * never reachable unless `orchestration_enabled` and a step turn supplies an
 * `orchestrationContext`.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-002
 */
export function buildOrchestrationUtils(
	ctx: BuilderContext,
): Pick<ExtensionUtils, "orchestrationTasks"> {
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
	};
}
