/**
 * Per-hook execution delay manager with debounce semantics.
 *
 * Each new event for the same hook+note pair resets the timer so only the
 * last event in a burst triggers execution. Combined with the existing
 * WorkflowConcurrencyManager single-instance guard for deduplication.
 *
 * @see specs/ZZ-misc/workflow-hooks-fixes-implementation-tasks.md — Phase 5
 */

export class HookDelayManager {
	/** Map key: `${hookId}::${notePath}` → pending timeout handle */
	private pending = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * Schedule a hook execution with debounce.
	 * If called again for the same key before the delay elapses,
	 * the previous timer is cancelled and a new one starts.
	 */
	schedule(
		hookId: string,
		notePath: string,
		delayMs: number,
		execute: () => void | Promise<void>,
	): void {
		const key = `${hookId}::${notePath}`;

		const existing = this.pending.get(key);
		if (existing !== undefined) {
			clearTimeout(existing);
		}

		const handle = setTimeout(() => {
			this.pending.delete(key);
			void execute();
		}, delayMs);

		this.pending.set(key, handle);
	}

	/** Cancel all pending delays (plugin unload). */
	destroy(): void {
		for (const handle of this.pending.values()) {
			clearTimeout(handle);
		}
		this.pending.clear();
	}

	/** Number of pending delayed executions (for testing/debugging). */
	get size(): number {
		return this.pending.size;
	}
}
