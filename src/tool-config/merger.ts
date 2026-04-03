/**
 * Precedence merge engine for tool configurations.
 *
 * Merges multiple `ParsedToolConfig` objects from all active sources
 * into a single `EffectiveToolConfig` using the defined precedence order:
 * workflow (highest) > persona > rule > global defaults.
 *
 * @see specs/04b-tool-toggle/spec.md — FR-80
 */

import type {
	EffectiveToolConfig,
	ParsedToolConfig,
	ResolvedToolConfigEntry,
	ToolConfigEntry,
} from "./types";

// ---------------------------------------------------------------------------
// Precedence Levels
// ---------------------------------------------------------------------------

/** Numeric precedence levels — higher number = higher priority (wins in merge). */
const PRECEDENCE: Record<string, number> = {
	rule: 0,
	persona: 1,
	workflow: 2,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge a list of `ParsedToolConfig` objects into a single `EffectiveToolConfig`.
 *
 * Precedence (highest first): workflow > persona > rule > global defaults.
 * Within the same source type, configs are ordered by `documentPosition`
 * ascending (last wins due to iteration order).
 *
 * Field merge is sparse: a field omitted at a higher-priority level does
 * not override a value set at a lower-priority level.
 *
 * `allowed_paths` and `blocked_paths` use replace semantics: the highest-
 * priority config that sets the field completely replaces lower-level values.
 *
 * @param configs          - All parsed tool config blocks from active sources.
 * @param globalAutoApprove - Per-tool auto-approve defaults from Settings
 *                            (built-in) and MCP server-level `autoApprove[]`
 *                            entries (pre-flattened into namespaced keys).
 * @param allToolNames     - All registered tool names (built-in + MCP in
 *                            `server__tool` format).
 * @param globalEnabled    - Per-tool enabled defaults from Settings.
 *                            Absent keys default to `true`.
 */
export function mergeToolConfigs(
	configs: ParsedToolConfig[],
	globalAutoApprove: Record<string, boolean>,
	allToolNames: string[],
	globalEnabled: Record<string, boolean> = {},
): EffectiveToolConfig {
	// Sort by precedence level ascending, then by documentPosition ascending.
	// This ensures higher-priority sources sort last → last non-undefined wins.
	const sorted = [...configs].sort((a, b) => {
		const pA = PRECEDENCE[a.source] ?? 0;
		const pB = PRECEDENCE[b.source] ?? 0;
		if (pA !== pB) return pA - pB;
		return a.documentPosition - b.documentPosition;
	});

	// Accumulate sparse entries per tool across all configs
	const merged: Record<string, Partial<ResolvedToolConfigEntry>> = {};

	for (const config of sorted) {
		for (const [toolName, entry] of Object.entries(config.tools)) {
			if (!merged[toolName]) {
				merged[toolName] = {};
			}
			applyEntry(merged[toolName], entry);
		}
	}

	// Fill defaults for all registered tools
	const tools: Record<string, ResolvedToolConfigEntry> = {};
	for (const toolName of allToolNames) {
		const partial = merged[toolName] ?? {};
		tools[toolName] = {
			enabled: partial.enabled ?? (globalEnabled[toolName] ?? true),
			auto_approve: partial.auto_approve ?? (globalAutoApprove[toolName] ?? false),
			allowed_paths: partial.allowed_paths ?? [],
			blocked_paths: partial.blocked_paths ?? [],
		};
	}

	return { tools };
}

// ---------------------------------------------------------------------------
// Sub-Agent Intersection Merge
// ---------------------------------------------------------------------------

/**
 * Compute the effective tool config for a sub-agent by intersecting the
 * parent's resolved config with the sub-agent profile's config.
 *
 * Uses AND/intersection semantics — distinct from the precedence-based
 * `mergeToolConfigs()` above:
 * - A tool must be enabled in BOTH parent and sub-agent config to be enabled
 * - Tools not mentioned in the sub-agent config are disabled (default-deny)
 * - `allowed_paths`: intersection (empty = no restriction, so empty ∩ X = X)
 * - `blocked_paths`: union (either block applies)
 * - `auto_approve`: forced `true` for read-mode tools; write tools inherit parent
 *
 * @param parentEffective - The parent conversation's fully resolved config.
 * @param subAgentConfig  - The sub-agent profile's parsed tool config.
 * @param toolModes       - Map of tool name → "read" | "write" for auto-approve logic.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 3.2
 */
export function intersectToolConfig(
	parentEffective: EffectiveToolConfig,
	subAgentConfig: ParsedToolConfig,
	toolModes: Record<string, "read" | "write">,
): EffectiveToolConfig {
	const tools: Record<string, ResolvedToolConfigEntry> = {};

	// Default-deny: only tools explicitly mentioned in the sub-agent config
	// are candidates. Everything else is disabled.
	for (const [toolName, subEntry] of Object.entries(subAgentConfig.tools)) {
		const parentEntry = parentEffective.tools[toolName];

		// If parent doesn't know about this tool, it's disabled
		if (!parentEntry) {
			tools[toolName] = {
				enabled: false,
				auto_approve: false,
				allowed_paths: [],
				blocked_paths: [],
			};
			continue;
		}

		// enabled: AND — must be enabled in both
		const enabled = parentEntry.enabled && (subEntry.enabled ?? true);

		// allowed_paths: intersection (empty = no restriction)
		const allowedPaths = intersectPaths(
			parentEntry.allowed_paths,
			subEntry.allowed_paths ?? [],
		);

		// blocked_paths: union
		const blockedPaths = unionPaths(
			parentEntry.blocked_paths,
			subEntry.blocked_paths ?? [],
		);

		// auto_approve: read tools → true; write tools → parent's value
		const mode = toolModes[toolName];
		const autoApprove = mode === "read" ? true : parentEntry.auto_approve;

		tools[toolName] = {
			enabled,
			auto_approve: autoApprove,
			allowed_paths: allowedPaths,
			blocked_paths: blockedPaths,
		};
	}

	return { tools };
}

/**
 * Intersect two `allowed_paths` arrays.
 *
 * Empty array = "no restriction" (any path allowed).
 * - empty ∩ X = X (the restricted set wins)
 * - X ∩ empty = X
 * - empty ∩ empty = empty (no restrictions)
 * - [a, b] ∩ [b, c] = [b] (only paths in both)
 */
function intersectPaths(a: string[], b: string[]): string[] {
	if (a.length === 0) return b;
	if (b.length === 0) return a;
	const setB = new Set(b);
	return a.filter((p) => setB.has(p));
}

/** Union two `blocked_paths` arrays, deduplicating. */
function unionPaths(a: string[], b: string[]): string[] {
	if (a.length === 0) return b;
	if (b.length === 0) return a;
	return [...new Set([...a, ...b])];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply a sparse `ToolConfigEntry` onto an accumulator.
 * Only non-undefined fields are written (sparse merge).
 * `allowed_paths` / `blocked_paths` use replace semantics.
 */
function applyEntry(
	acc: Partial<ResolvedToolConfigEntry>,
	entry: ToolConfigEntry,
): void {
	if (entry.enabled !== undefined) acc.enabled = entry.enabled;
	if (entry.auto_approve !== undefined) acc.auto_approve = entry.auto_approve;
	if (entry.allowed_paths !== undefined) acc.allowed_paths = entry.allowed_paths;
	if (entry.blocked_paths !== undefined) acc.blocked_paths = entry.blocked_paths;
}
