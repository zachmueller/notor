/**
 * Model grouping utility for the Bedrock model picker.
 *
 * Groups inference profile IDs by base model, derives human-readable
 * labels from the structured profile ID, and synthesizes virtual 1M
 * variants from `extended_context` metadata.
 *
 * All labels are derived from the raw profile ID — never from
 * `display_name` or AWS's `inferenceProfileName`.
 *
 * @see private/bedrock-model-picker-overhaul.md — Phase 2a
 */

import type { ModelInfo } from "../types";
import { getModelExtendedContext } from "./model-metadata";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ModelGroup {
	/** Human label derived from base key: "Claude Sonnet 4.6", "Nova Pro", etc. */
	label: string;
	/** Grouping key (e.g., "anthropic.claude-sonnet-4-6"). */
	key: string;
	/** Variants sorted by: context window desc, then region alphabetical. */
	variants: ModelVariant[];
}

export interface ModelVariant {
	model: ModelInfo;
	/** Parsed region tag: "US", "EU", "APAC", "Global", or null. */
	region: string | null;
	/** Context window label: "200K", "1M", or null if unknown. */
	contextLabel: string | null;
	/** Whether this variant uses extended (1M) context. */
	isExtendedContext: boolean;
	/**
	 * The value to use in `<option>`. For extended context variants
	 * this is `{model.id}::1m`; otherwise just `model.id`.
	 */
	optionValue: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Known geographic prefixes on Bedrock inference profile IDs. */
const GEO_PREFIXES: Record<string, string> = {
	"us.": "US",
	"eu.": "EU",
	"apac.": "APAC",
	"global.": "Global",
};

/** Extended context delimiter — cannot appear in a real profile ID. */
export const EXTENDED_CONTEXT_SUFFIX = "::1m";

/** Default context window when no metadata is available (128K). */
const DEFAULT_CONTEXT_WINDOW = 128_000;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

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

/**
 * Convert a base key to a human-readable label.
 *
 * Strips the provider prefix (e.g., `anthropic.`, `amazon.`, `meta.`)
 * and humanizes the slug.
 *
 * Examples:
 * - `"anthropic.claude-sonnet-4-6"` → `"Claude Sonnet 4.6"`
 * - `"amazon.nova-pro"` → `"Nova Pro"`
 * - `"meta.llama4-maverick-17b-instruct"` → `"Llama4 Maverick 17B Instruct"`
 * - `"deepseek.r1"` → `"R1"`
 */
export function baseKeyToLabel(baseKey: string): string {
	// Strip provider prefix (first segment before ".")
	const dotIdx = baseKey.indexOf(".");
	const slug = dotIdx >= 0 ? baseKey.slice(dotIdx + 1) : baseKey;

	// Strip date suffixes like -20250514
	const withoutDate = slug.replace(/-\d{8}$/, "");

	// Split on hyphens and capitalize each segment
	const parts = withoutDate.split("-").map((part) => {
		// Numeric parts: keep as-is but join with previous using "."
		// for version numbers like "4-6" → "4.6"
		return part.charAt(0).toUpperCase() + part.slice(1);
	});

	// Join and fix version numbers: "4 6" → "4.6" when both are short digits
	let label = parts.join(" ");

	// Collapse sequences of single-digit words into dot-separated versions
	// e.g., "Claude Sonnet 4 6" → "Claude Sonnet 4.6"
	// e.g., "Claude 3 7 Sonnet" → "Claude 3.7 Sonnet"
	label = label.replace(/\b(\d+)((?:\s\d+)+)\b/g, (_match, first: string, rest: string) => {
		const nums = rest.trim().split(/\s+/);
		return first + nums.map((n: string) => "." + n).join("");
	});

	return label;
}

/**
 * Format a context window token count as a short label.
 *
 * @returns "128K", "200K", "1M", etc., or null if unknown/default.
 */
export function formatContextLabel(tokens: number | null | undefined): string | null {
	if (tokens == null) return null;
	if (tokens === DEFAULT_CONTEXT_WINDOW) return null; // Don't show fallback default
	if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
	return `${tokens}`;
}

/**
 * Group models by base model and synthesize 1M variants.
 *
 * Only groups models that have a geographic prefix (Bedrock inference
 * profiles). Non-Bedrock models (no geo prefix) are placed in
 * single-variant groups.
 *
 * @param models - Array of ModelInfo from a provider's model list
 * @returns Sorted array of ModelGroup objects
 */
export function groupModels(models: ModelInfo[]): ModelGroup[] {
	const groupMap = new Map<string, { label: string; variants: ModelVariant[] }>();

	for (const model of models) {
		const { geo, baseKey } = parseProfileId(model.id);
		const groupKey = stripVersionSuffix(baseKey);
		const label = baseKeyToLabel(groupKey);
		const contextLabel = formatContextLabel(model.context_window);

		if (!groupMap.has(groupKey)) {
			groupMap.set(groupKey, { label, variants: [] });
		}

		const group = groupMap.get(groupKey)!;

		// Add the base variant
		group.variants.push({
			model,
			region: geo,
			contextLabel,
			isExtendedContext: false,
			optionValue: model.id,
		});

		// Synthesize 1M variant if model has extended_context metadata
		const extCtx = getModelExtendedContext(model.id);
		if (extCtx) {
			group.variants.push({
				model: {
					...model,
					context_window: extCtx.context_window,
					input_price_per_1k: extCtx.input_price_per_1k ?? model.input_price_per_1k,
					output_price_per_1k: extCtx.output_price_per_1k ?? model.output_price_per_1k,
				},
				region: geo,
				contextLabel: formatContextLabel(extCtx.context_window),
				isExtendedContext: true,
				optionValue: model.id + EXTENDED_CONTEXT_SUFFIX,
			});
		}
	}

	// Sort groups alphabetically by label
	const groups: ModelGroup[] = Array.from(groupMap.entries())
		.map(([key, { label, variants }]) => ({ key, label, variants }))
		.sort((a, b) => a.label.localeCompare(b.label));

	// Sort variants within each group: highest context first, then region alphabetical
	for (const group of groups) {
		group.variants.sort((a, b) => {
			// Context window descending
			const ctxA = a.model.context_window ?? 0;
			const ctxB = b.model.context_window ?? 0;
			if (ctxB !== ctxA) return ctxB - ctxA;

			// Region alphabetical
			const regA = a.region ?? "";
			const regB = b.region ?? "";
			return regA.localeCompare(regB);
		});
	}

	return groups;
}

/**
 * Parse a selected option value to extract model ID and extended context flag.
 *
 * @param selectedValue - The raw `<option>` value, e.g. `"us.anthropic.claude-sonnet-4-6::1m"`
 * @returns `{ modelId, isExtendedContext }`
 */
export function parseOptionValue(selectedValue: string): {
	modelId: string;
	isExtendedContext: boolean;
} {
	if (selectedValue.endsWith(EXTENDED_CONTEXT_SUFFIX)) {
		return {
			modelId: selectedValue.slice(0, -EXTENDED_CONTEXT_SUFFIX.length),
			isExtendedContext: true,
		};
	}
	return { modelId: selectedValue, isExtendedContext: false };
}

/**
 * Reconstruct the composite option value from config state.
 *
 * @param modelId - The stored model ID
 * @param useExtendedContext - Whether extended context is enabled
 * @returns The composite value for `<option>` matching
 */
export function buildOptionValue(modelId: string, useExtendedContext: boolean): string {
	return useExtendedContext ? modelId + EXTENDED_CONTEXT_SUFFIX : modelId;
}

/**
 * Format the display label for a model variant in the picker.
 *
 * @returns e.g. "US — 200K", "EU — 1M", "Global", etc.
 */
export function formatVariantLabel(variant: ModelVariant): string {
	const parts: string[] = [];
	if (variant.region) parts.push(variant.region);
	if (variant.contextLabel) parts.push(variant.contextLabel);
	if (variant.isExtendedContext) parts.push("(beta)");
	return parts.join(" — ") || variant.model.id;
}
