/**
 * In-memory registry of external-API runs: live handles for `getRun` /
 * `cancelRun`, plus the most recent finished runs. Pure (no Obsidian imports).
 */

import type { NotorRunInfo, NotorRunResult } from "./types";

/** Finished runs kept for `getRun` after they settle. */
const MAX_FINISHED = 50;

/** The body of a run: reports progress through `update`, resolves with its final fields. */
export type RunBody = (update: (patch: Partial<NotorRunInfo>) => void) => Promise<Partial<NotorRunInfo>>;

interface LiveRun {
	info: NotorRunInfo;
	cancel: () => void;
}

export class RunTracker {
	private live = new Map<string, LiveRun>();
	private finished = new Map<string, NotorRunInfo>();

	/**
	 * Start tracking a run. The body's rejection becomes `status: "failed"`, so
	 * `done` never rejects. `shape` post-processes the merged final result
	 * (e.g. dropping details the caller didn't ask for).
	 */
	start(
		initial: NotorRunInfo,
		cancel: () => void,
		body: RunBody,
		shape: (info: NotorRunInfo) => NotorRunInfo = (info) => info,
	): NotorRunResult {
		const run: LiveRun = { info: { ...initial, status: "running" }, cancel };
		this.live.set(initial.runId, run);

		const update = (patch: Partial<NotorRunInfo>) => {
			Object.assign(run.info, patch);
		};
		const done = body(update)
			.then((final) => ({ ...run.info, ...final }))
			.catch((e: unknown): NotorRunInfo => ({
				...run.info,
				status: "failed",
				error: e instanceof Error ? e.message : String(e),
				errorCode: "run_failed",
			}))
			.then((merged) => {
				const final = shape(merged);
				this.live.delete(initial.runId);
				this.remember(final);
				return final;
			});

		return { ...run.info, done };
	}

	/** A snapshot of a live or recently finished run. */
	get(runId: string): NotorRunInfo | undefined {
		const info = this.live.get(runId)?.info ?? this.finished.get(runId);
		return info ? { ...info } : undefined;
	}

	/** Cancel a live run. Returns false when it isn't running. */
	cancel(runId: string): boolean {
		const run = this.live.get(runId);
		if (!run) return false;
		run.cancel();
		return true;
	}

	/** Cancel every live run (plugin unload). */
	cancelAll(): void {
		for (const run of this.live.values()) run.cancel();
	}

	private remember(info: NotorRunInfo): void {
		this.finished.set(info.runId, info);
		// Maps iterate in insertion order, so the first keys are the oldest.
		for (const runId of this.finished.keys()) {
			if (this.finished.size <= MAX_FINISHED) break;
			this.finished.delete(runId);
		}
	}
}
