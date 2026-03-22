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
 */
export function mergeToolConfigs(
	configs: ParsedToolConfig[],
	globalAutoApprove: Record<string, boolean>,
	allToolNames: string[],
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
			enabled: partial.enabled ?? true,
			auto_approve: partial.auto_approve ?? (globalAutoApprove[toolName] ?? false),
			allowed_paths: partial.allowed_paths ?? [],
			blocked_paths: partial.blocked_paths ?? [],
		};
	}

	return { tools };
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
