/**
 * Recovery liveness predicate (F1 Fix 2) — pure, Obsidian-free.
 *
 * The recovery scan must never start a SECOND runner on a session whose original
 * runner is still live. A crashed/disabled plugin can leave `session.json`
 * `status: "active"` while its runner keeps executing; the one signal that stays
 * fresh is the `session-log.jsonl` mtime (it advances ≥2×/turn via
 * `turn.start`/`turn.complete`). So a fresh mtime means "still live — skip".
 *
 * Kept in its own module (no `obsidian` import) so the fresh/stale/null boundary
 * is unit-testable without a plugin or the launch stack.
 *
 * @see specs/ZZ-misc/arch-review-july-2026/F1-orchestration-run-lifecycle.md — Fix 2
 */

/**
 * Recovery liveness threshold. A recoverable `active` root whose
 * `session-log.jsonl` mtime is fresher than this is treated as **still live**. The
 * threshold is generous on purpose: the dangerous direction is live-seen-as-stale
 * (recreates the double-runner), never the reverse — a false "live" only delays a
 * resume offer to the next reload.
 */
export const LIVE_SESSION_MTIME_MS = 90_000;

/**
 * Whether a session log's mtime indicates a live runner. A `null` mtime (adapter
 * differences / missing file / stat error) ⇒ not live.
 */
export function isSessionLogMtimeLive(mtimeMs: number | null, nowMs: number): boolean {
	if (mtimeMs === null) return false;
	return nowMs - mtimeMs < LIVE_SESSION_MTIME_MS;
}
