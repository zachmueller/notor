/**
 * Sliding-window rate limiter for extension block emission (Phase 12).
 *
 * Per-conversation emission timestamps stored in a module-level Map.
 * Extracted from runtime-context.ts to allow unit testing.
 */

/** Per-conversation emission timestamps for sliding-window rate limiting. */
const emitTimestamps: Map<string, number[]> = new Map();

/**
 * Check whether emission is allowed for the given conversation under the
 * configured rate limit. Prunes expired entries from the sliding window.
 * Returns true when the emit should proceed, false when over limit.
 */
export function checkRateLimit(conversationId: string, maxEmits: number, windowMs: number): boolean {
	const now = Date.now();
	const cutoff = now - windowMs;
	const timestamps = (emitTimestamps.get(conversationId) ?? []).filter(t => t > cutoff);
	if (timestamps.length >= maxEmits) {
		emitTimestamps.set(conversationId, timestamps);
		return false;
	}
	timestamps.push(now);
	emitTimestamps.set(conversationId, timestamps);
	return true;
}

/** Reset all rate limit state (for testing only). */
export function _resetRateLimiter(): void {
	emitTimestamps.clear();
}
