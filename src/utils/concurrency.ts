/**
 * Map over `items` with at most `limit` calls of `fn` in flight at once.
 *
 * Results keep input order regardless of completion order. A rejection from any
 * call rejects the whole map (after in-flight calls settle their own promise
 * chains). Callers that want per-item error handling should catch inside `fn`.
 *
 * Used where many small independent vault reads would otherwise run strictly one
 * after another (each `adapter.read` is an async round-trip).
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]!, i);
		}
	};
	await Promise.all(Array.from({ length: width }, () => worker()));
	return results;
}
