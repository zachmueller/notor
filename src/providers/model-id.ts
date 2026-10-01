/**
 * Model ID parsing helpers shared by model metadata and model grouping.
 *
 * Leaf module (no imports) so `model-metadata.ts` and `model-grouping.ts`
 * can both depend on it without importing each other.
 */

/** Known geographic prefixes on Bedrock inference profile IDs. */
export const GEO_PREFIXES: Record<string, string> = {
	"us.": "US",
	"eu.": "EU",
	"apac.": "APAC",
	"global.": "Global",
};

/** Extended context delimiter — cannot appear in a real profile ID. */
export const EXTENDED_CONTEXT_SUFFIX = "::1m";

/**
 * Parse a Bedrock inference profile ID into geographic prefix and base key.
 *
 * Examples:
 * - `"us.anthropic.claude-sonnet-4-6"` → `{ geo: "US", baseKey: "anthropic.claude-sonnet-4-6" }`
 * - `"global.amazon.nova-pro-v1:0"` → `{ geo: "Global", baseKey: "amazon.nova-pro-v1:0" }`
 * - `"claude-sonnet-4-6"` → `{ geo: null, baseKey: "claude-sonnet-4-6" }` (non-Bedrock)
 */
export function parseProfileId(id: string): { geo: string | null; baseKey: string } {
	for (const [prefix, label] of Object.entries(GEO_PREFIXES)) {
		if (id.startsWith(prefix)) {
			return { geo: label, baseKey: id.slice(prefix.length) };
		}
	}
	return { geo: null, baseKey: id };
}

/**
 * Derive a grouping key from a base key by stripping version suffixes.
 *
 * Strips `-v1:0`, `-v1`, `-v2:0`, etc. from the end.
 *
 * Examples:
 * - `"anthropic.claude-sonnet-4-6"` → `"anthropic.claude-sonnet-4-6"` (no suffix)
 * - `"amazon.nova-pro-v1:0"` → `"amazon.nova-pro"`
 * - `"anthropic.claude-sonnet-4-20250514-v1:0"` → `"anthropic.claude-sonnet-4-20250514"`
 */
export function stripVersionSuffix(baseKey: string): string {
	return baseKey.replace(/-v\d+(?::\d+)?$/, "");
}
