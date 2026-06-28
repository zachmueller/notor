/**
 * Reusable counting semaphore for run-tree concurrency control.
 *
 * Generalized out of `src/sub-agents/semaphore.ts` (ARCH-006) into the run-loop
 * layer so orchestration child-run concurrency uses the same primitive WITHOUT
 * a sub-agent dependency. `src/sub-agents/semaphore.ts` now re-exports this.
 *
 * This is the **run-tree-expansion** concurrency axis — "how deep/wide a single
 * run tree spawns children". It is distinct from:
 * - `WorkflowConcurrencyManager` (background flow/workflow triggering), and
 * - `executeToolBatches`'s internal cap (intra-turn tool dispatch,
 *   `DEFAULT_CONCURRENCY_CAP = 5`).
 *
 * Do not conflate the three axes. The semaphore is purely an admission gate; it
 * does NOT decrement the aggregate budget (that is the two-layer model's job in
 * `budget.ts`). Concurrency = how *wide*; budget = how *much*.
 *
 * Sub-agents continue to bound concurrent runs at `SUB_AGENT_CONCURRENCY_CAP`
 * (3) using this shared primitive.
 *
 * @see specs/ZZ-misc/orchestration/contracts/run-loop.md — Three Concurrency Axes
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
