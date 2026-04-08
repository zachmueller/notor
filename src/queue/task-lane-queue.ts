/**
 * Generic per-lane FIFO serialization primitive with optional per-task
 * inter-completion delays.
 *
 * Each lane key gets its own serial queue. Cross-lane tasks run concurrently.
 * See specs/ZZ-misc/task-lane-queue-design.md for full design rationale.
 */

interface Waiter {
	/** Called by drain loop to signal "your turn". */
	resolve: () => void;
	/** Called by destroy() to reject the pending caller. */
	reject: (err: Error) => void;
	/** Minimum ms since previous task's completion before this task starts. */
	delayMs: number;
}

interface Lane {
	/** Timestamp (ms) of the last completed task in this lane. */
	lastCompletionTime: number;
	/** FIFO queue of pending tasks awaiting this lane's availability. */
	waitQueue: Waiter[];
	/** Whether a drain loop is currently running for this lane. */
	draining: boolean;
}

export class TaskLaneQueue {
	private lanes = new Map<string, Lane>();
	private destroyed = false;

	/**
	 * Enqueue an async task on the named lane. The task executes when the
	 * lane is available (previous task completed + this task's delay elapsed).
	 *
	 * @param laneKey - Lane identifier (e.g., "duckduckgo", "mcp:obsidian-mcp")
	 * @param fn      - Async function to execute when the lane is ready
	 * @param delayMs - Minimum ms since the previous task's completion before
	 *                  this task starts. Each call controls its own delay.
	 *                  Default: 0 (no delay, but still serialized).
	 * @returns The return value of `fn`.
	 */
	async enqueue<T>(laneKey: string, fn: () => Promise<T>, delayMs = 0): Promise<T> {
		if (this.destroyed) {
			throw new Error("TaskLaneQueue destroyed");
		}

		const lane = this.getOrCreateLane(laneKey);

		// If the lane is idle and enough time has elapsed since the last
		// completion, execute immediately.
		if (!lane.draining && Date.now() - lane.lastCompletionTime >= delayMs) {
			lane.draining = true;
			return this.runThenDrain(lane, fn);
		}

		// Otherwise, wait for the drain loop to signal our turn.
		await new Promise<void>((resolve, reject) => {
			lane.waitQueue.push({ resolve, reject, delayMs });

			// If no drain loop is active, start one. This happens when the
			// lane is idle but the delay hasn't elapsed yet.
			if (!lane.draining) {
				lane.draining = true;
				this.drain(lane);
			}
		});

		// Gate opened — it's our turn. Execute fn, then continue draining.
		return this.runThenDrain(lane, fn);
	}

	/** Number of tasks waiting in a lane's queue. 0 for non-existent lanes. */
	pending(laneKey: string): number {
		return this.lanes.get(laneKey)?.waitQueue.length ?? 0;
	}

	/** Remove a lane. Not exposed to extensions. */
	removeLane(laneKey: string): void {
		this.lanes.delete(laneKey);
	}

	/**
	 * Reject all pending waiters, clear all lanes, mark queue as destroyed.
	 * Called from plugin onunload().
	 */
	destroy(): void {
		this.destroyed = true;
		const err = new Error("TaskLaneQueue destroyed");
		for (const lane of this.lanes.values()) {
			for (const waiter of lane.waitQueue) {
				waiter.reject(err);
			}
			lane.waitQueue.length = 0;
		}
		this.lanes.clear();
	}

	// ── Private helpers ──────────────────────────────────────────────

	private getOrCreateLane(laneKey: string): Lane {
		let lane = this.lanes.get(laneKey);
		if (!lane) {
			lane = { lastCompletionTime: 0, waitQueue: [], draining: false };
			this.lanes.set(laneKey, lane);
		}
		return lane;
	}

	/**
	 * Execute `fn`, update lastCompletionTime, then drain the next waiter.
	 * Propagates fn's error to the caller while still releasing the lane.
	 */
	private async runThenDrain<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} finally {
			lane.lastCompletionTime = Date.now();
			this.drain(lane);
		}
	}

	/**
	 * Resolve the next waiter after its delay has elapsed, or mark the lane
	 * as idle if the queue is empty.
	 */
	private drain(lane: Lane): void {
		if (lane.waitQueue.length === 0) {
			lane.draining = false;
			return;
		}

		const waiter = lane.waitQueue[0]!;
		const elapsed = Date.now() - lane.lastCompletionTime;
		const remaining = waiter.delayMs - elapsed;

		if (remaining > 0) {
			setTimeout(() => {
				lane.waitQueue.shift();
				waiter.resolve();
			}, remaining);
		} else {
			lane.waitQueue.shift();
			waiter.resolve();
		}
	}
}
