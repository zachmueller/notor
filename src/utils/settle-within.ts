/**
 * Resolve once every promise has settled (fulfilled or rejected), or after
 * `capMs`, whichever comes first. Never rejects. Resolves to "settled" or
 * "timeout" so callers can log which happened.
 */
export function settleWithin(promises: readonly Promise<unknown>[], capMs: number): Promise<"settled" | "timeout"> {
	if (promises.length === 0) return Promise.resolve("settled");
	return new Promise((resolve) => {
		const timer = window.setTimeout(() => resolve("timeout"), capMs);
		void Promise.allSettled(promises).then(() => {
			window.clearTimeout(timer);
			resolve("settled");
		});
	});
}
