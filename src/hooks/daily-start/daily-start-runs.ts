/**
 * Run tracking for daily-start targets: builds the per-target run observer,
 * keeps each target's `DailyRunRecord` current, and remembers which
 * conversation / circuit session to open for it.
 */

import type { WorkflowExecution } from "../../types";
import type { DispatchRunObserver } from "../vault-event-dispatcher";
import type { TriggerTarget } from "../trigger-sources";
import { isRunCircuitAction } from "../hook-action-type";
import type { DailyRunRecord, DailyRunStatus } from "./daily-start-state";

/** How often live background workflows are polled for status / conversation id. */
const LIVE_POLL_MS = 5_000;

/** Status of a background workflow execution, mapped onto a daily-run status. */
function workflowRunStatus(exec: WorkflowExecution): DailyRunStatus {
	switch (exec.status) {
		case "queued":
		case "running":
			return "running";
		case "waiting_approval":
			return "waiting_approval";
		case "completed":
			return "completed";
		case "errored":
		case "stopped":
			return "failed";
	}
}

/** Same shape as `newSessionId()` in circuits/run-lifecycle (kept local so the circuit engine isn't loaded eagerly). */
function newSessionId(): string {
	return `sess-${crypto.randomUUID().slice(0, 12)}`;
}

/** True when a target launches a circuit (directly or via a `run_circuit` hook). */
export function launchesCircuit(target: TriggerTarget): boolean {
	if (target.kind === "circuit") return true;
	return target.kind === "hook" && isRunCircuitAction(target.hook.action_type);
}

export interface DailyRunTrackerDeps {
	/** The stored record for `key`, if any. */
	getRecord: (key: string) => DailyRunRecord | null;
	/** Apply a patch to the stored record for `key` and return the updated record. */
	patchRecord: (key: string, patch: Partial<DailyRunRecord>) => DailyRunRecord | null;
	/** Called after every record change (drives Notices). */
	onRecordChanged: (record: DailyRunRecord) => void;
}

export class DailyRunTracker {
	/** Live background workflow executions keyed by target key. */
	private readonly live = new Map<string, WorkflowExecution>();
	private pollId: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly deps: DailyRunTrackerDeps) {}

	/** Build the run observer for one target and mark its record running. */
	observe(target: TriggerTarget): DispatchRunObserver {
		const { key } = target;
		const sessionId = launchesCircuit(target) ? newSessionId() : null;
		this.patch(key, { status: "running", sessionId, error: null, startedAt: new Date().toISOString() });

		return {
			onWorkflowSubmitted: (exec, done) => {
				this.live.set(key, exec);
				this.ensurePolling();
				void done.then(() => {
					this.live.delete(key);
					this.patch(key, {
						status: workflowRunStatus(exec),
						conversationId: exec.conversation_id || null,
						error: exec.error_message,
					});
				});
			},
			circuit: sessionId === null ? undefined : {
				origin: "daily_start",
				sessionId,
				observer: {
					onStepTurnSaved: (turn) => {
						// The first saved conversation step is the entry step.
						const rec = this.deps.getRecord(key);
						if (rec && !rec.conversationId) this.patch(key, { conversationId: turn.conversationId });
					},
				},
				onSettled: (status, error) => {
					this.patch(key, { status: status === "completed" ? "completed" : "failed", error: error ?? null });
				},
			},
		};
	}

	/** Live conversation id for a target (a running workflow's record may lag). */
	liveConversationId(key: string): string | null {
		return this.live.get(key)?.conversation_id || null;
	}

	destroy(): void {
		this.stopPolling();
		this.live.clear();
	}

	private patch(key: string, patch: Partial<DailyRunRecord>): void {
		const rec = this.deps.patchRecord(key, patch);
		if (rec) this.deps.onRecordChanged(rec);
	}

	/** Mirror `waiting_approval` / conversation id of live workflows into their records. */
	private poll(): void {
		for (const [key, exec] of this.live) {
			const rec = this.deps.getRecord(key);
			const status = workflowRunStatus(exec);
			const conversationId = exec.conversation_id || null;
			if (rec && (rec.status !== status || rec.conversationId !== conversationId)) {
				this.patch(key, { status, conversationId });
			}
		}
		if (this.live.size === 0) this.stopPolling();
	}

	private ensurePolling(): void {
		if (this.pollId === null) this.pollId = setInterval(() => this.poll(), LIVE_POLL_MS);
	}

	private stopPolling(): void {
		if (this.pollId !== null) clearInterval(this.pollId);
		this.pollId = null;
	}
}
