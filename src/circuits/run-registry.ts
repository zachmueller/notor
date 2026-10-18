/**
 * `CircuitRunRegistry` (F1 Fix 1) — the in-memory owner of live
 * orchestration runs, giving a running flow a lifecycle handle it never had.
 *
 * A launched flow registers a handle (its abort controller + a `lastProgressAt`
 * heartbeat) here for the duration of `runner.start()` / `runner.resume()` and
 * unregisters in a `finally`. That handle is what the Stop button, the per-flow
 * single-instance guard, and the plugin-unload teardown all consume:
 *  - {@link abort} — the Stop UI cancels one run;
 *  - {@link isFlowRunning} — the single-instance guard refuses a colliding launch;
 *  - {@link abortAll} — `onunload` aborts every live run before teardown;
 *  - {@link touch} — the runner's `onProgress` refreshes the heartbeat.
 *
 * It also holds each live session's {@link CircuitRunPolicy} so `run_flow`
 * children and chaining successors inherit the root's mode and approval channel.
 *
 * Deliberately in-memory only (no persistence): after a crash the recovery
 * liveness guard (Fix 2) is the protection, not this registry. This module is
 * **pure** — no Obsidian imports — so it is trivially unit-testable.
 *
 * @see specs/ZZ-misc/arch-review-july-2026/F1-orchestration-run-lifecycle.md — Fix 1
 */

import type { CircuitRunPolicy } from "./run-policy";

/** A live orchestration run's lifecycle handle. */
export interface CircuitRunHandle {
	sessionId: string;
	flowName: string;
	controller: AbortController;
	/** Refreshed by the runner's onProgress; used by recovery liveness (Fix 2). */
	lastProgressAt: number;
}

/** In-memory registry of live orchestration runs, keyed by session id. */
export class CircuitRunRegistry {
	private runs = new Map<string, CircuitRunHandle>();
	private policies = new Map<string, CircuitRunPolicy>();

	/** Register a live run's handle (called after the controller is created). */
	register(handle: CircuitRunHandle): void {
		this.runs.set(handle.sessionId, handle);
	}

	/** Remove a run's handle (called in the `finally` around the run await). */
	unregister(sessionId: string): void {
		this.runs.delete(sessionId);
	}

	/** The handle for a session, or `undefined` when it is not live. */
	get(sessionId: string): CircuitRunHandle | undefined {
		return this.runs.get(sessionId);
	}

	/** A snapshot of every live run's handle (e.g. for a Stop picker). */
	listActive(): CircuitRunHandle[] {
		return [...this.runs.values()];
	}

	/** Whether any live run is executing the named flow (single-instance guard). */
	isFlowRunning(flowName: string): boolean {
		for (const handle of this.runs.values()) {
			if (handle.flowName === flowName) return true;
		}
		return false;
	}

	/**
	 * Abort one live run by session id. Returns `true` when a matching live run
	 * was found and its controller aborted, `false` otherwise (already finished /
	 * never registered).
	 */
	abort(sessionId: string): boolean {
		const handle = this.runs.get(sessionId);
		if (!handle) return false;
		handle.controller.abort();
		return true;
	}

	/**
	 * Abort every live run (called from `onunload`). Returns the aborted
	 * controllers so the caller can await their finalize writes with a bounded
	 * timeout. Does NOT unregister — each run's own `finally` unregisters as it
	 * settles.
	 */
	abortAll(): AbortController[] {
		const controllers: AbortController[] = [];
		for (const handle of this.runs.values()) {
			handle.controller.abort();
			controllers.push(handle.controller);
		}
		return controllers;
	}

	/** Refresh a run's heartbeat (the runner's `onProgress` seam). */
	touch(sessionId: string): void {
		const handle = this.runs.get(sessionId);
		if (handle) handle.lastProgressAt = Date.now();
	}

	/**
	 * Record a session's run policy for its lifetime. Unlike {@link register},
	 * this covers child and chaining runs too, which inherit it by parent id.
	 */
	setPolicy(sessionId: string, policy: CircuitRunPolicy): void {
		this.policies.set(sessionId, policy);
	}

	/** The run policy of a live session, or `undefined`. */
	getPolicy(sessionId: string): CircuitRunPolicy | undefined {
		return this.policies.get(sessionId);
	}

	/** Drop a session's run policy once it (and any chained successor) settles. */
	clearPolicy(sessionId: string): void {
		this.policies.delete(sessionId);
	}
}
