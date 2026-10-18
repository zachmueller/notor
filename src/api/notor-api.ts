/**
 * The external API facade mounted at `plugin.api` (reachable from Templater
 * and other plugins as `app.plugins.plugins.notor.api`).
 *
 * It only validates, gates, and delegates: circuits run through
 * `launchCircuit`, workflows through the chat orchestrators, and tools through
 * the shared dispatcher, so external calls get the same Plan/Act mode, policy,
 * and approval handling as everything else.
 */

import type { NotorApiHost } from "./host";
import { runCircuit } from "./run-circuit";
import { runTool } from "./run-tool";
import { runWorkflow } from "./run-workflow";
import { RunTracker } from "./run-tracker";
import { NotorApiError, type NotorApi } from "./types";

export interface NotorApiHandle {
	api: NotorApi;
	/** Called on plugin unload: cancels live API runs and rejects further calls. */
	dispose(): void;
}

/**
 * @param ready - Resolves once tools are registered and the initial
 *   workflow/circuit scans finish. Every method awaits it, so a script that
 *   runs during startup doesn't race plugin loading.
 */
export function createNotorApi(host: NotorApiHost, ready: Promise<void>): NotorApiHandle {
	const tracker = new RunTracker();
	let disposed = false;

	const enter = async (): Promise<void> => {
		await ready;
		if (disposed) throw new NotorApiError("unloaded", "Notor has been unloaded.");
		if (!host.settings.external_api_enabled) {
			throw new NotorApiError(
				"api_disabled",
				"The Notor API is turned off in Settings → Notor → Automation → External API.",
			);
		}
	};

	const api: NotorApi = {
		version: 1,
		ready,

		async listCircuits() {
			await enter();
			if (!host.settings.circuits_enabled) return [];
			return host.getDiscoveredCircuits().map((c) => ({
				name: c.name,
				...(c.description ? { description: c.description } : {}),
				path: c.flowDir,
				invocable: c.invocable,
			}));
		},

		async listWorkflows() {
			await enter();
			return host.getDiscoveredWorkflows().map((w) => ({
				name: w.display_name,
				path: w.file_path,
				aliases: [...w.aliases],
			}));
		},

		async runCircuit(nameOrPath, opts) {
			await enter();
			return runCircuit(host, tracker, String(nameOrPath), opts);
		},

		async runWorkflow(nameOrPath, opts) {
			await enter();
			return runWorkflow(host, tracker, String(nameOrPath), opts);
		},

		async runTool(name, params, opts) {
			await enter();
			return runTool(host, String(name), params, opts);
		},

		getRun(runId) {
			return tracker.get(runId);
		},

		cancelRun(runId) {
			return tracker.cancel(runId);
		},
	};
	Object.freeze(api);

	return {
		api,
		dispose() {
			disposed = true;
			tracker.cancelAll();
		},
	};
}
