/**
 * `withTimeout` — race a promise-returning invocation against a wall-clock
 * timeout, always clearing the timer so a fast completion never leaks a pending
 * `setTimeout`.
 *
 * Lifted from `CodeStepExecutor.runWithTimeout` so tools, automations, and code
 * steps share one implementation. On timeout it rejects with a typed
 * {@link ExtensionTimeoutError} carrying the honest caveat: the guard is a
 * `setTimeout`, so it can only preempt at an `await` boundary — an unbounded
 * synchronous loop never yields and is not interruptible.
 */

/** Thrown when {@link withTimeout} fires its timeout guard (at an `await` boundary). */
export class ExtensionTimeoutError extends Error {
	constructor(ms: number) {
		super(
			`Execution exceeded its ${Math.round(ms / 1000)}s timeout. (Note: the guard fires only ` +
				`at an await boundary — an unbounded synchronous loop is not interruptible; insert ` +
				`await yield points.)`,
		);
		this.name = "ExtensionTimeoutError";
	}
}

/**
 * Run `invoke()` under a `ms`-millisecond timeout.
 *
 * Resolves with the invocation's value on success (transparent — the value is
 * passed through unchanged). Rejects with {@link ExtensionTimeoutError} if the
 * timeout fires first, or with the invocation's own error if it rejects first.
 * The timer is always cleared once the race settles.
 */
export function withTimeout<T>(invoke: () => Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ExtensionTimeoutError(ms)), ms);
	});
	// `Promise.resolve().then(invoke)` ensures a synchronous throw inside `invoke`
	// surfaces as a rejected promise rather than escaping the race.
	return Promise.race([Promise.resolve().then(invoke), timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	}) as Promise<T>;
}
