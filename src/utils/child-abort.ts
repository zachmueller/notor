/**
 * A request-scoped abort controller linked to a longer-lived parent signal.
 *
 * Providers only stop generating when their `abort_signal` fires — leaving a
 * stream's parse early does not close the HTTP request. Giving each request
 * its own child signal lets a caller close it (e.g. a stream stopped at a
 * blocked tool call) without aborting the parent, which reads as a user Stop.
 * A parent abort still cascades.
 */
export interface ChildAbort {
	signal: AbortSignal;
	/** Unlink from the parent and abort — a no-op for a request already done. */
	close: () => void;
}

export function openChildAbort(parent: AbortSignal): ChildAbort {
	const controller = new AbortController();
	const onParentAbort = () => controller.abort();
	if (parent.aborted) controller.abort();
	else parent.addEventListener("abort", onParentAbort, { once: true });
	return {
		signal: controller.signal,
		close: () => {
			parent.removeEventListener("abort", onParentAbort);
			controller.abort();
		},
	};
}
