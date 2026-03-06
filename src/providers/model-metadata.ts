/**
 * Static model metadata table.
 *
 * Maps known model IDs to context window sizes and pricing.
 * Follows Cline's proven pattern since no provider returns this
 * data dynamically.
 *
 * This is a data file — update it when providers release new models
 * or change pricing, without changing any logic.
 *
 * Pricing is per 1K tokens (input/output).
 *
 * Bedrock entries use inference profile IDs (e.g. us.anthropic.*, eu.anthropic.*)
 * rather than bare foundation model IDs (e.g. anthropic.*). These are the correct
 * modelId values for the Converse API and are what ListInferenceProfiles returns.
 *
 * @see design/research/llm-model-list-apis.md — Section 6b (metadata table)
 * @see specs/01-mvp/data-model.md — ModelInfo entity
 */

import type { ModelInfo } from "../types";

/** Default context window for unknown models. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Metadata entry for a known model.
 * Only includes fields not available from provider list APIs.
 */
interface ModelMetadataEntry {
	context_window: number;
	input_price_per_1k: number | null;
	output_price_per_1k: number | null;
	display_name?: string;
}

/**
 * Static metadata table keyed by model ID.
 *
 * Sources:
 * - Anthropic: https://docs.anthropic.com/en/docs/about-claude/models
 * - OpenAI: https://platform.openai.com/docs/models
 * - AWS Bedrock inference profiles: https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html
 *
 * Prices as of July 2026. May be outdated — for informational display only.
 */
const MODEL_METADATA: Record<string, ModelMetadataEntry> = {
	// -----------------------------------------------------------------------
	// Anthropic models (direct API)
	// -----------------------------------------------------------------------
	"claude-opus-4-6": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		display_name: "Claude Opus 4.6",
	},
	"claude-sonnet-4-6": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "Claude Sonnet 4.6",
	},
	"claude-sonnet-4-5-20250929": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "Claude Sonnet 4.5",
	},
	"claude-haiku-4-5-20251001": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
		display_name: "Claude Haiku 4.5",
	},
	"claude-sonnet-4-20250514": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "Claude Sonnet 4",
	},
	"claude-opus-4-20250514": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		display_name: "Claude Opus 4",
	},
	"claude-3-7-sonnet-20250219": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "Claude 3.7 Sonnet",
	},
	"claude-3-5-sonnet-20241022": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "Claude 3.5 Sonnet v2",
	},
	"claude-3-5-sonnet-20240620": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "Claude 3.5 Sonnet",
	},
	"claude-3-5-haiku-20241022": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
		display_name: "Claude 3.5 Haiku",
	},
	"claude-3-opus-20240229": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		display_name: "Claude 3 Opus",
	},
	"claude-3-haiku-20240307": {
		context_window: 200_000,
		input_price_per_1k: 0.00025,
		output_price_per_1k: 0.00125,
		display_name: "Claude 3 Haiku",
	},

	// -----------------------------------------------------------------------
	// OpenAI models
	// -----------------------------------------------------------------------
	"gpt-4o": {
		context_window: 128_000,
		input_price_per_1k: 0.0025,
		output_price_per_1k: 0.01,
		display_name: "GPT-4o",
	},
	"gpt-4o-2024-11-20": {
		context_window: 128_000,
		input_price_per_1k: 0.0025,
		output_price_per_1k: 0.01,
		display_name: "GPT-4o (Nov 2024)",
	},
	"gpt-4o-2024-08-06": {
		context_window: 128_000,
		input_price_per_1k: 0.0025,
		output_price_per_1k: 0.01,
		display_name: "GPT-4o (Aug 2024)",
	},
	"gpt-4o-mini": {
		context_window: 128_000,
		input_price_per_1k: 0.00015,
		output_price_per_1k: 0.0006,
		display_name: "GPT-4o mini",
	},
	"gpt-4o-mini-2024-07-18": {
		context_window: 128_000,
		input_price_per_1k: 0.00015,
		output_price_per_1k: 0.0006,
		display_name: "GPT-4o mini (July 2024)",
	},
	"o3": {
		context_window: 200_000,
		input_price_per_1k: 0.01,
		output_price_per_1k: 0.04,
		display_name: "o3",
	},
	"o3-mini": {
		context_window: 200_000,
		input_price_per_1k: 0.0011,
		output_price_per_1k: 0.0044,
		display_name: "o3 mini",
	},
	"o4-mini": {
		context_window: 200_000,
		input_price_per_1k: 0.0011,
		output_price_per_1k: 0.0044,
		display_name: "o4 mini",
	},
	"o4-mini-2025-04-16": {
		context_window: 200_000,
		input_price_per_1k: 0.0011,
		output_price_per_1k: 0.0044,
		display_name: "o4 mini (April 2025)",
	},
	"o1": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.06,
		display_name: "o1",
	},
	"o1-mini": {
		context_window: 128_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.012,
		display_name: "o1 mini",
	},
	"gpt-4-turbo": {
		context_window: 128_000,
		input_price_per_1k: 0.01,
		output_price_per_1k: 0.03,
		display_name: "GPT-4 Turbo",
	},
	"gpt-4-turbo-2024-04-09": {
		context_window: 128_000,
		input_price_per_1k: 0.01,
		output_price_per_1k: 0.03,
		display_name: "GPT-4 Turbo (April 2024)",
	},

	// -----------------------------------------------------------------------
	// AWS Bedrock — Anthropic inference profiles
	//
	// Keyed by inferenceProfileId as returned by ListInferenceProfiles and
	// passed directly to the Converse API as modelId.
	// Covers us., eu., apac., and global. geographic prefixes.
	// -----------------------------------------------------------------------

	// Claude Opus 4.6
	"us.anthropic.claude-opus-4-6-v1": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		display_name: "US Claude Opus 4.6 (Bedrock)",
	},
	"global.anthropic.claude-opus-4-6-v1": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		display_name: "Global Claude Opus 4.6 (Bedrock)",
	},

	// Claude Sonnet 4.6
	"us.anthropic.claude-sonnet-4-6": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "US Claude Sonnet 4.6 (Bedrock)",
	},
	"eu.anthropic.claude-sonnet-4-6": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "EU Claude Sonnet 4.6 (Bedrock)",
	},
	"apac.anthropic.claude-sonnet-4-6": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "APAC Claude Sonnet 4.6 (Bedrock)",
	},
	"global.anthropic.claude-sonnet-4-6": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "Global Claude Sonnet 4.6 (Bedrock)",
	},

	// Claude Sonnet 4.5
	"us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "US Claude Sonnet 4.5 (Bedrock)",
	},
	"eu.anthropic.claude-sonnet-4-5-20250929-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "EU Claude Sonnet 4.5 (Bedrock)",
	},
	"apac.anthropic.claude-sonnet-4-5-20250929-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "APAC Claude Sonnet 4.5 (Bedrock)",
	},
	"global.anthropic.claude-sonnet-4-5-20250929-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "Global Claude Sonnet 4.5 (Bedrock)",
	},

	// Claude Haiku 4.5
	"us.anthropic.claude-haiku-4-5-20251001-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
		display_name: "US Claude Haiku 4.5 (Bedrock)",
	},
	"eu.anthropic.claude-haiku-4-5-20251001-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
		display_name: "EU Claude Haiku 4.5 (Bedrock)",
	},
	"apac.anthropic.claude-haiku-4-5-20251001-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
		display_name: "APAC Claude Haiku 4.5 (Bedrock)",
	},
	"global.anthropic.claude-haiku-4-5-20251001-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
		display_name: "Global Claude Haiku 4.5 (Bedrock)",
	},

	// Claude Sonnet 4
	"us.anthropic.claude-sonnet-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "US Claude Sonnet 4 (Bedrock)",
	},
	"eu.anthropic.claude-sonnet-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "EU Claude Sonnet 4 (Bedrock)",
	},
	"apac.anthropic.claude-sonnet-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "APAC Claude Sonnet 4 (Bedrock)",
	},
	"global.anthropic.claude-sonnet-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "Global Claude Sonnet 4 (Bedrock)",
	},

	// Claude Opus 4
	"us.anthropic.claude-opus-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		display_name: "US Claude Opus 4 (Bedrock)",
	},
	"eu.anthropic.claude-opus-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		display_name: "EU Claude Opus 4 (Bedrock)",
	},
	"global.anthropic.claude-opus-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		display_name: "Global Claude Opus 4 (Bedrock)",
	},

	// Claude 3.7 Sonnet
	"us.anthropic.claude-3-7-sonnet-20250219-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "US Claude 3.7 Sonnet (Bedrock)",
	},
	"eu.anthropic.claude-3-7-sonnet-20250219-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "EU Claude 3.7 Sonnet (Bedrock)",
	},
	"apac.anthropic.claude-3-7-sonnet-20250219-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "APAC Claude 3.7 Sonnet (Bedrock)",
	},

	// Claude 3.5 Sonnet v2
	"us.anthropic.claude-3-5-sonnet-20241022-v2:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "US Claude 3.5 Sonnet v2 (Bedrock)",
	},
	"eu.anthropic.claude-3-5-sonnet-20241022-v2:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "EU Claude 3.5 Sonnet v2 (Bedrock)",
	},
	"apac.anthropic.claude-3-5-sonnet-20241022-v2:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "APAC Claude 3.5 Sonnet v2 (Bedrock)",
	},

	// Claude 3.5 Haiku
	"us.anthropic.claude-3-5-haiku-20241022-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
		display_name: "US Claude 3.5 Haiku (Bedrock)",
	},
	"eu.anthropic.claude-3-5-haiku-20241022-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
		display_name: "EU Claude 3.5 Haiku (Bedrock)",
	},
	"apac.anthropic.claude-3-5-haiku-20241022-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
		display_name: "APAC Claude 3.5 Haiku (Bedrock)",
	},

	// -----------------------------------------------------------------------
	// AWS Bedrock — Amazon Nova inference profiles
	// -----------------------------------------------------------------------

	// Nova Premier
	"us.amazon.nova-premier-v1:0": {
		context_window: 1_000_000,
		input_price_per_1k: 0.0025,
		output_price_per_1k: 0.0125,
		display_name: "US Nova Premier (Bedrock)",
	},

	// Nova Pro
	"us.amazon.nova-pro-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.0032,
		display_name: "US Nova Pro (Bedrock)",
	},
	"eu.amazon.nova-pro-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.0032,
		display_name: "EU Nova Pro (Bedrock)",
	},
	"apac.amazon.nova-pro-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.0032,
		display_name: "APAC Nova Pro (Bedrock)",
	},

	// Nova Lite
	"us.amazon.nova-lite-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.00006,
		output_price_per_1k: 0.00024,
		display_name: "US Nova Lite (Bedrock)",
	},
	"eu.amazon.nova-lite-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.00006,
		output_price_per_1k: 0.00024,
		display_name: "EU Nova Lite (Bedrock)",
	},
	"apac.amazon.nova-lite-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.00006,
		output_price_per_1k: 0.00024,
		display_name: "APAC Nova Lite (Bedrock)",
	},

	// Nova Micro
	"us.amazon.nova-micro-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.000035,
		output_price_per_1k: 0.00014,
		display_name: "US Nova Micro (Bedrock)",
	},
	"eu.amazon.nova-micro-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.000035,
		output_price_per_1k: 0.00014,
		display_name: "EU Nova Micro (Bedrock)",
	},
	"apac.amazon.nova-micro-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.000035,
		output_price_per_1k: 0.00014,
		display_name: "APAC Nova Micro (Bedrock)",
	},

	// Nova 2 Lite (global only as of July 2026)
	"global.amazon.nova-2-lite-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.00006,
		output_price_per_1k: 0.00024,
		display_name: "Global Nova 2 Lite (Bedrock)",
	},

	// -----------------------------------------------------------------------
	// AWS Bedrock — Meta Llama 4 inference profiles
	// -----------------------------------------------------------------------
	"us.meta.llama4-maverick-17b-instruct-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.00024,
		output_price_per_1k: 0.00024,
		display_name: "US Llama 4 Maverick 17B (Bedrock)",
	},
	"us.meta.llama4-scout-17b-instruct-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.00017,
		output_price_per_1k: 0.00017,
		display_name: "US Llama 4 Scout 17B (Bedrock)",
	},

	// -----------------------------------------------------------------------
	// AWS Bedrock — DeepSeek inference profiles
	// -----------------------------------------------------------------------
	"us.deepseek.r1-v1:0": {
		context_window: 64_000,
		input_price_per_1k: 0.00135,
		output_price_per_1k: 0.0054,
		display_name: "US DeepSeek R1 (Bedrock)",
	},
};

/**
 * Look up metadata for a model by its ID.
 *
 * @param modelId - The model identifier as used in API calls
 * @returns ModelInfo-compatible metadata, or null if the model is unknown
 */
export function getModelMetadata(modelId: string): ModelInfo | null {
	const entry = MODEL_METADATA[modelId];
	if (!entry) {
		return null;
	}
	return {
		id: modelId,
		display_name: entry.display_name ?? modelId,
		context_window: entry.context_window,
		input_price_per_1k: entry.input_price_per_1k,
		output_price_per_1k: entry.output_price_per_1k,
	};
}

/**
 * Get the context window size for a model.
 *
 * Falls back to DEFAULT_CONTEXT_WINDOW (128,000) for unknown models.
 *
 * @param modelId - The model identifier
 * @returns Context window size in tokens
 */
export function getContextWindow(modelId: string): number {
	const entry = MODEL_METADATA[modelId];
	return entry?.context_window ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Enrich a ModelInfo object with metadata from the static table.
 *
 * Fills in context_window and pricing if available from the static
 * table. Fields already present on the input are not overwritten.
 *
 * @param model - A ModelInfo object (e.g., from a provider's listModels)
 * @returns The same object with enriched fields
 */
export function enrichModelInfo(model: ModelInfo): ModelInfo {
	const entry = MODEL_METADATA[model.id];
	if (!entry) {
		return model;
	}
	return {
		...model,
		display_name:
			model.display_name !== model.id
				? model.display_name
				: (entry.display_name ?? model.display_name),
		context_window: model.context_window ?? entry.context_window,
		input_price_per_1k:
			model.input_price_per_1k ?? entry.input_price_per_1k,
		output_price_per_1k:
			model.output_price_per_1k ?? entry.output_price_per_1k,
	};
}

/**
 * Get all known model IDs from the static metadata table.
 */
export function getKnownModelIds(): string[] {
	return Object.keys(MODEL_METADATA);
}