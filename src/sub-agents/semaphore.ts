/**
 * Reusable counting semaphore for concurrency control.
 *
 * Used by `use_subagent` to cap the number of concurrent sub-agent
 * executions (default: 3, separate from the tool-orchestration cap of 5).
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 9.3
 */

/**
 * A simple counting semaphore with FIFO wait queue.
 *
 * ```ts
 * const sem = new Semaphore(3);
 * await sem.acquire();
 * try {
 *   // … work …
 * } finally {
 *   sem.release();
 * }
 * ```
 */
export class Semaphore {
	private activeCount = 0;
	private waitQueue: Array<() => void> = [];

	constructor(private readonly cap: number) {}

	/**
	 * Acquire a slot. Resolves immediately if a slot is available,
	 * otherwise waits until one is released.
	 */
	async acquire(): Promise<void> {
		if (this.activeCount < this.cap) {
			this.activeCount++;
			return;
		}
		return new Promise<void>((resolve) => {
			this.waitQueue.push(() => {
				this.activeCount++;
				resolve();
			});
		});
	}

	/**
	 * Release a slot. If waiters are queued, the next one (FIFO) is unblocked.
	 */
	release(): void {
		this.activeCount--;
		const next = this.waitQueue.shift();
		if (next) next();
	}

	/** Number of waiters currently blocked in `acquire()`. */
	get pending(): number {
		return this.waitQueue.length;
	}

	/** Number of slots currently held. */
	get active(): number {
		return this.activeCount;
	}
}
