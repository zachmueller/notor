/**
 * Startup timing — thin wrappers over the User Timing API (`performance.mark` /
 * `performance.measure`), namespaced with a `notor:` prefix.
 *
 * Always on and local only: entries live in the renderer's performance timeline
 * and are never sent anywhere. Obsidian's own start-up breakdown
 * (Settings → About, or the `dev:startup format=json` CLI handler) includes every
 * performance mark, and the e2e startup harness (`npm run e2e:startup`) reads
 * them over CDP.
 *
 * Spans use numeric start/end times (not named start/end marks), so overlapping
 * spans with the same name — e.g. two concurrent history listings — measure
 * correctly. A hard cap keeps a long session from growing the timeline without
 * bound: after {@link MAX_ENTRIES} entries recording stops silently.
 */

export const TIMING_PREFIX = "notor:";

/** Upper bound on entries this module records per plugin load. */
export const MAX_ENTRIES = 1000;

let recorded = 0;

interface UserTimingApi {
	now(): number;
	mark(name: string, options?: { startTime?: number; detail?: unknown }): unknown;
	measure(name: string, options: { start: number; end: number; detail?: unknown }): unknown;
	getEntriesByType(type: string): Array<{ name: string; startTime: number; duration: number; detail?: unknown }>;
	clearMarks(name?: string): void;
	clearMeasures(name?: string): void;
}

function api(): UserTimingApi | null {
	const perf = (typeof performance === "undefined" ? undefined : performance) as Partial<UserTimingApi> | undefined;
	if (!perf || typeof perf.now !== "function" || typeof perf.mark !== "function" || typeof perf.measure !== "function") {
		return null;
	}
	return perf as UserTimingApi;
}

function canRecord(): boolean {
	if (recorded >= MAX_ENTRIES) return false;
	recorded++;
	return true;
}

/** Record a point-in-time mark, e.g. `markStartup("layoutReady")`. */
export function markStartup(name: string, detail?: Record<string, unknown>): void {
	const perf = api();
	if (!perf || !canRecord()) return;
	try {
		perf.mark(TIMING_PREFIX + name, detail ? { detail } : undefined);
	} catch {
		// Timing must never break the plugin.
	}
}

/** Ends a span; `detail` is merged into the detail given at start. */
export type EndSpan = (detail?: Record<string, unknown>) => void;

/**
 * Start a span. The returned function records a `notor:<name>` measure from now
 * until it is called. Calling it more than once records only the first call.
 */
export function startSpan(name: string, detail?: Record<string, unknown>): EndSpan {
	const perf = api();
	if (!perf) return () => undefined;
	const start = perf.now();
	let ended = false;
	return (endDetail) => {
		if (ended) return;
		ended = true;
		if (!canRecord()) return;
		try {
			const merged = detail || endDetail ? { ...detail, ...endDetail } : undefined;
			perf.measure(TIMING_PREFIX + name, { start, end: perf.now(), ...(merged ? { detail: merged } : {}) });
		} catch {
			// Timing must never break the plugin.
		}
	};
}

/** Time a synchronous block. The span ends even if `fn` throws. */
export function timeSync<T>(name: string, fn: () => T): T {
	const end = startSpan(name);
	try {
		return fn();
	} finally {
		end();
	}
}

/**
 * Time a promise. The span ends when it settles; a rejection is recorded as
 * `{ error: true }` and re-thrown unchanged.
 */
export function timePromise<T>(name: string, promise: Promise<T>): Promise<T> {
	const end = startSpan(name);
	return promise.then(
		(value) => {
			end();
			return value;
		},
		(error: unknown) => {
			end({ error: true });
			throw error;
		},
	);
}

export interface TimingEntry {
	name: string;
	kind: "mark" | "measure";
	/** Milliseconds since the renderer's time origin. */
	startTime: number;
	duration: number;
	detail?: unknown;
}

/** All `notor:` marks and measures currently in the timeline, sorted by start time. */
export function getStartupTimings(): TimingEntry[] {
	const perf = api();
	if (!perf || typeof perf.getEntriesByType !== "function") return [];
	const out: TimingEntry[] = [];
	for (const kind of ["mark", "measure"] as const) {
		for (const e of perf.getEntriesByType(kind)) {
			if (!e.name.startsWith(TIMING_PREFIX)) continue;
			out.push({
				name: e.name.slice(TIMING_PREFIX.length),
				kind,
				startTime: e.startTime,
				duration: e.duration,
				...(e.detail !== undefined && e.detail !== null ? { detail: e.detail } : {}),
			});
		}
	}
	return out.sort((a, b) => a.startTime - b.startTime);
}

/**
 * Compact summary for a log line: measures as `{ name: [durations…] }` (rounded
 * ms, repeated spans listed in order) and marks as `{ name: startTime }`.
 */
export function summarizeStartupTimings(): { measures: Record<string, number[]>; marks: Record<string, number> } {
	const measures: Record<string, number[]> = {};
	const marks: Record<string, number> = {};
	for (const e of getStartupTimings()) {
		if (e.kind === "measure") {
			(measures[e.name] ??= []).push(Math.round(e.duration));
		} else {
			marks[e.name] = Math.round(e.startTime);
		}
	}
	return { measures, marks };
}

/**
 * Clear this plugin's entries and the record cap. Called at the start of onload
 * so a plugin reload (same renderer) starts from a clean slate.
 */
export function resetStartupTimings(): void {
	recorded = 0;
	const perf = api();
	if (!perf) return;
	try {
		const names = new Set(
			[...(perf.getEntriesByType?.("mark") ?? []), ...(perf.getEntriesByType?.("measure") ?? [])]
				.map((e) => e.name)
				.filter((n) => n.startsWith(TIMING_PREFIX)),
		);
		for (const n of names) {
			perf.clearMarks?.(n);
			perf.clearMeasures?.(n);
		}
	} catch {
		// ignore
	}
}
