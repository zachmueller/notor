/**
 * Runtime model-limits registry.
 *
 * Holds context-window data the static `MODEL_METADATA` table cannot know
 * ahead of time:
 * - user overrides (`settings.model_context_overrides`),
 * - limits reported by a provider's model-list API (Anthropic `/v1/models`
 *   `max_input_tokens`),
 * - limits learned from context-overflow errors (these only ever lower a window),
 * - Bedrock models whose inferred 1M beta header was rejected.
 *
 * `model-metadata.ts` consults this registry when resolving a model's window.
 * This module must never import `model-metadata.ts` (import cycle).
 *
 * API-derived, learned and beta-rejected data persist in data.json through the
 * host's `persist` callback; overrides are read live from settings.
 */

import { logger } from "../utils/logger";
import { EXTENDED_CONTEXT_SUFFIX } from "./model-id";

const log = logger("ModelLimits");

/** Learned limits below this are treated as parse noise and ignored. */
export const MIN_LEARNED_CONTEXT_WINDOW = 4_096;

/** Overrides below this are treated as typos and ignored. */
const MIN_OVERRIDE_CONTEXT_WINDOW = 1_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Limits reported by a provider's model-list API. */
export interface ApiModelLimit {
	context_window: number;
	max_output_tokens?: number;
	updated_at: string;
}

/** How a learned limit was derived. */
export type LearnedLimitSource = "error" | "estimate";

/** A limit learned from a context-overflow error. */
export interface LearnedModelLimit {
	context_window: number;
	/** "error": parsed from the provider's message; "estimate": derived from Notor's token estimate. */
	source: LearnedLimitSource;
	learned_at: string;
}

/** Persisted registry state (stored as `model_limits_cache` in data.json). */
export interface ModelLimitsCache {
	version: 1;
	/** Keyed by model ID. */
	api: Record<string, ApiModelLimit>;
	/** Keyed by model ID, or `{id}::1m` for the extended-context variant. */
	learned: Record<string, LearnedModelLimit>;
	/** Model ID → ISO timestamp the inferred 1M beta header was rejected. */
	beta_rejected: Record<string, string>;
}

/** Kinds of detected data that can be forgotten from the settings UI. */
export type ModelLimitKind = "api" | "learned" | "beta_rejected";

/** Wiring supplied by the plugin at load time. */
export interface ModelLimitsHost {
	/** Raw persisted cache from data.json (sanitized on load). */
	cache?: unknown;
	/** Live getter for `settings.model_context_overrides`. */
	getOverrides: () => Record<string, number> | undefined;
	/** Persist the cache (must be a lightweight write, not a full settings save). */
	persist: (cache: ModelLimitsCache) => void;
	/** Called once per model per session when the 128K default is used. */
	onFallbackContextWindow?: (modelId: string) => void;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let host: ModelLimitsHost | null = null;
let cache: ModelLimitsCache = createEmptyModelLimitsCache();
const warnedFallback = new Set<string>();
const listeners = new Set<() => void>();

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Create an empty cache (also the settings default). */
export function createEmptyModelLimitsCache(): ModelLimitsCache {
	return { version: 1, api: {}, learned: {}, beta_rejected: {} };
}

/** Wire the registry to the plugin and load the persisted cache. */
export function initModelLimits(h: ModelLimitsHost): void {
	host = h;
	cache = sanitizeCache(h.cache);
	warnedFallback.clear();
}

/** Drop all state and wiring (plugin unload and tests). */
export function resetModelLimits(): void {
	host = null;
	cache = createEmptyModelLimitsCache();
	warnedFallback.clear();
	listeners.clear();
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** Registry key for a model + context mode: `id` or `id::1m`. */
export function limitKey(modelId: string, useExtendedContext?: boolean): string {
	const id = modelId.trim();
	return useExtendedContext ? id + EXTENDED_CONTEXT_SUFFIX : id;
}

/**
 * User override for a model's context window.
 *
 * In extended mode an `id::1m` override is checked first; a bare `id`
 * override applies to both modes. Invalid values are ignored.
 */
export function getContextOverride(modelId: string, useExtendedContext?: boolean): number | undefined {
	const overrides = host?.getOverrides();
	if (!overrides) return undefined;
	const id = modelId.trim();
	if (useExtendedContext) {
		const ext = validOverride(overrides[id + EXTENDED_CONTEXT_SUFFIX]);
		if (ext !== undefined) return ext;
	}
	return validOverride(overrides[id]);
}

/** Context window reported by a provider's model-list API, if any. */
export function getApiContextWindow(modelId: string): number | undefined {
	return cache.api[modelId.trim()]?.context_window;
}

/** Context window learned from an overflow error for this model + mode, if any. */
export function getLearnedContextWindow(modelId: string, useExtendedContext?: boolean): number | undefined {
	return cache.learned[limitKey(modelId, useExtendedContext)]?.context_window;
}

/** Whether Bedrock rejected the inferred 1M beta header for this model. */
export function isBetaRejected(modelId: string): boolean {
	return cache.beta_rejected[modelId.trim()] !== undefined;
}

/** Snapshot of all detected (non-override) data, for the settings UI. */
export function listModelLimits(): {
	api: Array<{ modelId: string } & ApiModelLimit>;
	learned: Array<{ key: string; modelId: string; extended: boolean } & LearnedModelLimit>;
	betaRejected: Array<{ modelId: string; rejected_at: string }>;
} {
	const byKey = (a: string, b: string) => a.localeCompare(b);
	return {
		api: Object.keys(cache.api).sort(byKey).map((modelId) => ({ modelId, ...cache.api[modelId]! })),
		learned: Object.keys(cache.learned).sort(byKey).map((key) => {
			const extended = key.endsWith(EXTENDED_CONTEXT_SUFFIX);
			const modelId = extended ? key.slice(0, -EXTENDED_CONTEXT_SUFFIX.length) : key;
			return { key, modelId, extended, ...cache.learned[key]! };
		}),
		betaRejected: Object.keys(cache.beta_rejected).sort(byKey).map((modelId) => ({
			modelId,
			rejected_at: cache.beta_rejected[modelId]!,
		})),
	};
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Record limits from a provider's model listing.
 *
 * Persists at most once per call, and only when a value actually changed —
 * listings refresh every few minutes and must not rewrite data.json each time.
 */
export function recordApiModelLimits(
	entries: Array<{ id: string; max_input_tokens?: number | null; max_tokens?: number | null }>
): void {
	let changed = false;
	const now = new Date().toISOString();
	for (const entry of entries) {
		const id = entry.id?.trim();
		const contextWindow = validTokenCount(entry.max_input_tokens);
		if (!id || contextWindow === undefined) continue;
		const maxOutput = validTokenCount(entry.max_tokens);
		const existing = cache.api[id];
		if (existing?.context_window === contextWindow && existing.max_output_tokens === maxOutput) continue;
		cache.api[id] = {
			context_window: contextWindow,
			...(maxOutput !== undefined ? { max_output_tokens: maxOutput } : {}),
			updated_at: now,
		};
		changed = true;
	}
	if (changed) commit();
}

/**
 * Record a context window learned from an overflow error.
 *
 * Only ever lowers the learned value for a key; values below
 * {@link MIN_LEARNED_CONTEXT_WINDOW} are ignored.
 *
 * @returns true when the stored value changed
 */
export function recordLearnedContextWindow(
	modelId: string,
	useExtendedContext: boolean | undefined,
	tokens: number,
	source: LearnedLimitSource
): boolean {
	const id = modelId.trim();
	const value = Math.floor(tokens);
	if (!id || !Number.isFinite(value) || value < MIN_LEARNED_CONTEXT_WINDOW) return false;
	const key = limitKey(id, useExtendedContext);
	const existing = cache.learned[key];
	if (existing && existing.context_window <= value) return false;
	cache.learned[key] = { context_window: value, source, learned_at: new Date().toISOString() };
	log.warn("Learned model context window from overflow error", { modelId: id, key, tokens: value, source });
	commit();
	return true;
}

/**
 * Record that Bedrock rejected the inferred 1M beta header for a model.
 *
 * @returns true when this is new information
 */
export function recordBetaRejected(modelId: string): boolean {
	const id = modelId.trim();
	if (!id || cache.beta_rejected[id] !== undefined) return false;
	cache.beta_rejected[id] = new Date().toISOString();
	log.warn("1M context beta rejected for inferred model; no longer sending it", { modelId: id });
	commit();
	return true;
}

/** Forget one detected entry (settings UI "Forget" button). */
export function forgetModelLimit(kind: ModelLimitKind, key: string): void {
	const bucket = cache[kind];
	if (!(key in bucket)) return;
	delete bucket[key];
	commit();
}

/** Subscribe to registry changes. Returns an unsubscribe function. */
export function onModelLimitsChanged(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/**
 * Report that the 128K default context window was used for a model.
 *
 * Warns once per model ID per session; empty IDs are ignored.
 */
export function reportFallbackContextWindow(modelId: string): void {
	const id = modelId.trim();
	if (!id || warnedFallback.has(id)) return;
	warnedFallback.add(id);
	log.warn("Unknown model context window; assuming the 128K default", { modelId: id });
	try {
		host?.onFallbackContextWindow?.(id);
	} catch (e) {
		log.error("Fallback context window callback failed", { error: String(e) });
	}
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function commit(): void {
	try {
		host?.persist(cache);
	} catch (e) {
		log.error("Failed to persist model limits", { error: String(e) });
	}
	for (const fn of listeners) {
		try {
			fn();
		} catch (e) {
			log.error("Model limits listener failed", { error: String(e) });
		}
	}
}

function validTokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function validOverride(value: unknown): number | undefined {
	const n = validTokenCount(value);
	return n !== undefined && n >= MIN_OVERRIDE_CONTEXT_WINDOW ? n : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rebuild a cache from untrusted persisted data, dropping malformed entries. */
function sanitizeCache(raw: unknown): ModelLimitsCache {
	const result = createEmptyModelLimitsCache();
	if (!isRecord(raw)) return result;

	if (isRecord(raw.api)) {
		for (const [id, v] of Object.entries(raw.api)) {
			if (!isRecord(v)) continue;
			const contextWindow = validTokenCount(v.context_window);
			if (contextWindow === undefined) continue;
			const maxOutput = validTokenCount(v.max_output_tokens);
			result.api[id] = {
				context_window: contextWindow,
				...(maxOutput !== undefined ? { max_output_tokens: maxOutput } : {}),
				updated_at: typeof v.updated_at === "string" ? v.updated_at : "",
			};
		}
	}

	if (isRecord(raw.learned)) {
		for (const [key, v] of Object.entries(raw.learned)) {
			if (!isRecord(v)) continue;
			const contextWindow = validTokenCount(v.context_window);
			if (contextWindow === undefined || contextWindow < MIN_LEARNED_CONTEXT_WINDOW) continue;
			result.learned[key] = {
				context_window: contextWindow,
				source: v.source === "estimate" ? "estimate" : "error",
				learned_at: typeof v.learned_at === "string" ? v.learned_at : "",
			};
		}
	}

	if (isRecord(raw.beta_rejected)) {
		for (const [id, v] of Object.entries(raw.beta_rejected)) {
			if (typeof v === "string") result.beta_rejected[id] = v;
		}
	}

	return result;
}
