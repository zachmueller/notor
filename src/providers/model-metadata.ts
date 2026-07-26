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
 * Extended context configuration for models that support
 * the 1M context window beta header on Bedrock.
 */
interface ExtendedContext {
	context_window: number;
	beta_flag: string;
	input_price_per_1k?: number;
	output_price_per_1k?: number;
}

/**
 * Metadata entry for a known model.
 * Only includes fields not available from provider list APIs.
 */
interface ModelMetadataEntry {
	context_window: number;
	input_price_per_1k: number | null;
	output_price_per_1k: number | null;
	display_name?: string;
	extended_context?: ExtendedContext;
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
	"claude-opus-5": {
		context_window: 200_000,
		input_price_per_1k: 0.015, // verify pricing
		output_price_per_1k: 0.075, // verify pricing
		display_name: "Claude Opus 5",
	},
	"claude-sonnet-5": {
		context_window: 200_000,
		input_price_per_1k: 0.003, // verify pricing
		output_price_per_1k: 0.015, // verify pricing
		display_name: "Claude Sonnet 5",
	},
	"claude-fable-5": {
		context_window: 200_000,
		input_price_per_1k: 0.010, // verify pricing
		output_price_per_1k: 0.050, // verify pricing
		display_name: "Claude Fable 5",
	},
	"claude-opus-4-8": {
		context_window: 200_000,
		input_price_per_1k: 0.015, // verify pricing
		output_price_per_1k: 0.075, // verify pricing
		display_name: "Claude Opus 4.8",
	},
	"claude-opus-4-7": {
		context_window: 200_000,
		input_price_per_1k: 0.015, // verify pricing
		output_price_per_1k: 0.075, // verify pricing
		display_name: "Claude Opus 4.7",
	},
	"claude-opus-4-5": {
		context_window: 200_000,
		input_price_per_1k: 0.015, // verify pricing
		output_price_per_1k: 0.075, // verify pricing
		display_name: "Claude Opus 4.5",
	},
	"claude-opus-4-1": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		display_name: "Claude Opus 4.1",
	},
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
	"claude-3-sonnet-20240229": {
		context_window: 200_000,
		input_price_per_1k: 0.003, // verify pricing
		output_price_per_1k: 0.015, // verify pricing
		display_name: "Claude 3 Sonnet",
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

	// Claude Opus 4.8 — 1M context beta supported (pricing copied from 4.6, verify)
	"us.anthropic.claude-opus-4-8": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.030,
			output_price_per_1k: 0.150,
		},
	},
	"eu.anthropic.claude-opus-4-8": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.030,
			output_price_per_1k: 0.150,
		},
	},
	"apac.anthropic.claude-opus-4-8": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.030,
			output_price_per_1k: 0.150,
		},
	},
	"global.anthropic.claude-opus-4-8": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.030,
			output_price_per_1k: 0.150,
		},
	},

	// Claude Opus 4.7 — 1M context beta supported; classifies "effort" (rejects
	// legacy thinking.type=enabled — live converse probe). us./global. only.
	"us.anthropic.claude-opus-4-7": {
		context_window: 200_000,
		input_price_per_1k: 0.015, // verify pricing
		output_price_per_1k: 0.075, // verify pricing
		display_name: "Claude Opus 4.7",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.030, // verify
			output_price_per_1k: 0.150, // verify
		},
	},
	"global.anthropic.claude-opus-4-7": {
		context_window: 200_000,
		input_price_per_1k: 0.015, // verify pricing
		output_price_per_1k: 0.075, // verify pricing
		display_name: "Claude Opus 4.7",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.030, // verify
			output_price_per_1k: 0.150, // verify
		},
	},

	// Claude Opus 4.5 — 1M context beta supported; classifies "enabled" (visible
	// reasoning transcript confirmed by live converse probe). us./global. only.
	"us.anthropic.claude-opus-4-5-20251101-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.015, // verify pricing
		output_price_per_1k: 0.075, // verify pricing
		display_name: "Claude Opus 4.5",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.030, // verify
			output_price_per_1k: 0.150, // verify
		},
	},
	"global.anthropic.claude-opus-4-5-20251101-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.015, // verify pricing
		output_price_per_1k: 0.075, // verify pricing
		display_name: "Claude Opus 4.5",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.030, // verify
			output_price_per_1k: 0.150, // verify
		},
	},

	// -----------------------------------------------------------------------
	// Claude 5-series (Opus 5 / Sonnet 5 / Fable 5) — 1M context beta supported.
	//
	// As of 2026-07, Bedrock ships only the `us.` and `global.` inference
	// profiles for these models (no `eu.`/`apac.` variants yet, unlike Opus 4.8)
	// — the omission of those two geo prefixes is intentional, not an oversight.
	// The `context-1m-2025-08-07` beta header is accepted by all three (live
	// converse probe), and each rejects legacy thinking.type=enabled in favor of
	// adaptive/effort — so they classify "effort" via the getThinkingMode()
	// default and need no LEGACY_ENABLED_THINKING_PATTERNS entry.
	// -----------------------------------------------------------------------

	// Claude Opus 5 — pricing copied from Opus 4.8 (verify)
	"us.anthropic.claude-opus-5": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		display_name: "Claude Opus 5",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.030,
			output_price_per_1k: 0.150,
		},
	},
	"global.anthropic.claude-opus-5": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		display_name: "Claude Opus 5",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.030,
			output_price_per_1k: 0.150,
		},
	},

	// Claude Sonnet 5 — pricing copied from Sonnet 4.6 (verify)
	"us.anthropic.claude-sonnet-5": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "Claude Sonnet 5",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.006,
			output_price_per_1k: 0.030,
		},
	},
	"global.anthropic.claude-sonnet-5": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		display_name: "Claude Sonnet 5",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.006,
			output_price_per_1k: 0.030,
		},
	},

	// Claude Fable 5 — base pricing per Anthropic first-party rates (verify pricing);
	// extended-tier premium unconfirmed, set equal to base for now (verify).
	"us.anthropic.claude-fable-5": {
		context_window: 200_000,
		input_price_per_1k: 0.010, // verify pricing
		output_price_per_1k: 0.050, // verify pricing
		display_name: "Claude Fable 5",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.010, // verify
			output_price_per_1k: 0.050, // verify
		},
	},
	"global.anthropic.claude-fable-5": {
		context_window: 200_000,
		input_price_per_1k: 0.010, // verify pricing
		output_price_per_1k: 0.050, // verify pricing
		display_name: "Claude Fable 5",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.010, // verify
			output_price_per_1k: 0.050, // verify
		},
	},

	// Claude Opus 4.6 — 1M context beta supported
	"us.anthropic.claude-opus-4-6-v1": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.030,
			output_price_per_1k: 0.150,
		},
	},
	"global.anthropic.claude-opus-4-6-v1": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.030,
			output_price_per_1k: 0.150,
		},
	},

	// Claude Sonnet 4.6 — 1M context beta supported
	"us.anthropic.claude-sonnet-4-6": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.006,
			output_price_per_1k: 0.030,
		},
	},
	"eu.anthropic.claude-sonnet-4-6": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.006,
			output_price_per_1k: 0.030,
		},
	},
	"apac.anthropic.claude-sonnet-4-6": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.006,
			output_price_per_1k: 0.030,
		},
	},
	"global.anthropic.claude-sonnet-4-6": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.006,
			output_price_per_1k: 0.030,
		},
	},

	// Claude Sonnet 4.5
	"us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
	},
	"eu.anthropic.claude-sonnet-4-5-20250929-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
	},
	"apac.anthropic.claude-sonnet-4-5-20250929-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
	},
	"global.anthropic.claude-sonnet-4-5-20250929-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
	},

	// Claude Haiku 4.5
	"us.anthropic.claude-haiku-4-5-20251001-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
	},
	"eu.anthropic.claude-haiku-4-5-20251001-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
	},
	"apac.anthropic.claude-haiku-4-5-20251001-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
	},
	"global.anthropic.claude-haiku-4-5-20251001-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
	},

	// Claude Sonnet 4 — 1M context beta supported
	"us.anthropic.claude-sonnet-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.006,
			output_price_per_1k: 0.030,
		},
	},
	"eu.anthropic.claude-sonnet-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.006,
			output_price_per_1k: 0.030,
		},
	},
	"apac.anthropic.claude-sonnet-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.006,
			output_price_per_1k: 0.030,
		},
	},
	"global.anthropic.claude-sonnet-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			input_price_per_1k: 0.006,
			output_price_per_1k: 0.030,
		},
	},

	// Claude Opus 4.1 — LEGACY foundation model but profile still ACTIVE; classifies
	// "enabled" (visible reasoning transcript confirmed by live converse probe).
	// No extended_context: 4.1 predates the 1M era (matches the dated Opus 4.0 entry).
	// us. only.
	"us.anthropic.claude-opus-4-1-20250805-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.015, // verify pricing
		output_price_per_1k: 0.075, // verify pricing
		display_name: "Claude Opus 4.1",
	},

	// Claude Opus 4
	"us.anthropic.claude-opus-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
	},
	"eu.anthropic.claude-opus-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
	},
	"global.anthropic.claude-opus-4-20250514-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.015,
		output_price_per_1k: 0.075,
	},

	// Claude 3.7 Sonnet
	"us.anthropic.claude-3-7-sonnet-20250219-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
	},
	"eu.anthropic.claude-3-7-sonnet-20250219-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
	},
	"apac.anthropic.claude-3-7-sonnet-20250219-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
	},

	// Claude 3.5 Sonnet v2
	"us.anthropic.claude-3-5-sonnet-20241022-v2:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
	},
	"eu.anthropic.claude-3-5-sonnet-20241022-v2:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
	},
	"apac.anthropic.claude-3-5-sonnet-20241022-v2:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003,
		output_price_per_1k: 0.015,
	},

	// Claude 3.5 Haiku
	"us.anthropic.claude-3-5-haiku-20241022-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
	},
	"eu.anthropic.claude-3-5-haiku-20241022-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
	},
	"apac.anthropic.claude-3-5-haiku-20241022-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.004,
	},

	// Claude 3 (LEGACY foundation models, profiles still ACTIVE in us-east-1).
	// No thinking support (supportsThinking() false). us. only.
	"us.anthropic.claude-3-haiku-20240307-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.00025,
		output_price_per_1k: 0.00125,
		display_name: "Claude 3 Haiku",
	},
	"us.anthropic.claude-3-sonnet-20240229-v1:0": {
		context_window: 200_000,
		input_price_per_1k: 0.003, // verify pricing
		output_price_per_1k: 0.015, // verify pricing
		display_name: "Claude 3 Sonnet",
	},

	// -----------------------------------------------------------------------
	// AWS Bedrock — Amazon Nova inference profiles
	// -----------------------------------------------------------------------

	// Nova Premier
	"us.amazon.nova-premier-v1:0": {
		context_window: 1_000_000,
		input_price_per_1k: 0.0025,
		output_price_per_1k: 0.0125,
	},

	// Nova Pro
	"us.amazon.nova-pro-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.0032,
	},
	"eu.amazon.nova-pro-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.0032,
	},
	"apac.amazon.nova-pro-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.0008,
		output_price_per_1k: 0.0032,
	},

	// Nova Lite
	"us.amazon.nova-lite-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.00006,
		output_price_per_1k: 0.00024,
	},
	"eu.amazon.nova-lite-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.00006,
		output_price_per_1k: 0.00024,
	},
	"apac.amazon.nova-lite-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.00006,
		output_price_per_1k: 0.00024,
	},

	// Nova Micro
	"us.amazon.nova-micro-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.000035,
		output_price_per_1k: 0.00014,
	},
	"eu.amazon.nova-micro-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.000035,
		output_price_per_1k: 0.00014,
	},
	"apac.amazon.nova-micro-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.000035,
		output_price_per_1k: 0.00014,
	},

	// Nova 2 Lite (us. + global. as of July 2026)
	"us.amazon.nova-2-lite-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.00006,
		output_price_per_1k: 0.00024,
	},
	"global.amazon.nova-2-lite-v1:0": {
		context_window: 300_000,
		input_price_per_1k: 0.00006,
		output_price_per_1k: 0.00024,
	},

	// -----------------------------------------------------------------------
	// AWS Bedrock — Meta Llama inference profiles
	// -----------------------------------------------------------------------
	"us.meta.llama4-maverick-17b-instruct-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.00024,
		output_price_per_1k: 0.00024,
	},
	"us.meta.llama4-scout-17b-instruct-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.00017,
		output_price_per_1k: 0.00017,
	},

	// Llama 3.x — profiles ACTIVE in us-east-1 (Llama 3.2 foundation models are
	// LEGACY/EOL but their inference profiles remain ACTIVE, so they still list).
	// 128K context; pricing per AWS Bedrock rates (verify). us. only.
	"us.meta.llama3-3-70b-instruct-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.00072, // verify pricing
		output_price_per_1k: 0.00072, // verify pricing
	},
	"us.meta.llama3-2-90b-instruct-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.00072, // verify pricing
		output_price_per_1k: 0.00072, // verify pricing
	},
	"us.meta.llama3-2-11b-instruct-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.00016, // verify pricing
		output_price_per_1k: 0.00016, // verify pricing
	},
	"us.meta.llama3-2-3b-instruct-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.00015, // verify pricing
		output_price_per_1k: 0.00015, // verify pricing
	},
	"us.meta.llama3-2-1b-instruct-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.0001, // verify pricing
		output_price_per_1k: 0.0001, // verify pricing
	},
	"us.meta.llama3-1-70b-instruct-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.00072, // verify pricing
		output_price_per_1k: 0.00072, // verify pricing
	},
	"us.meta.llama3-1-8b-instruct-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.00022, // verify pricing
		output_price_per_1k: 0.00022, // verify pricing
	},

	// -----------------------------------------------------------------------
	// AWS Bedrock — Mistral inference profiles
	// -----------------------------------------------------------------------
	// Pixtral Large (vision-capable). 128K context; pricing per Bedrock rates (verify).
	"us.mistral.pixtral-large-2502-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.002, // verify pricing
		output_price_per_1k: 0.006, // verify pricing
	},

	// -----------------------------------------------------------------------
	// AWS Bedrock — Writer inference profiles
	// -----------------------------------------------------------------------
	// Palmyra X4 (128K) and X5 (1M advertised). Pricing per Bedrock rates (verify).
	"us.writer.palmyra-x4-v1:0": {
		context_window: 128_000,
		input_price_per_1k: 0.0025, // verify pricing
		output_price_per_1k: 0.01, // verify pricing
	},
	"us.writer.palmyra-x5-v1:0": {
		context_window: 1_000_000, // verify (Writer advertises 1M context)
		input_price_per_1k: 0.0006, // verify pricing
		output_price_per_1k: 0.006, // verify pricing
	},

	// -----------------------------------------------------------------------
	// AWS Bedrock — DeepSeek inference profiles
	// -----------------------------------------------------------------------
	"us.deepseek.r1-v1:0": {
		context_window: 64_000,
		input_price_per_1k: 0.00135,
		output_price_per_1k: 0.0054,
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
 * When `useExtendedContext` is true and the model supports the 1M beta,
 * returns the extended context window instead.
 *
 * @param modelId - The model identifier
 * @param useExtendedContext - Whether to use the extended (1M) context window
 * @returns Context window size in tokens
 */
export function getContextWindow(modelId: string, useExtendedContext?: boolean): number {
	const entry = MODEL_METADATA[modelId];
	if (useExtendedContext && entry?.extended_context?.context_window) {
		return entry.extended_context.context_window;
	}
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
 * Get the extended context configuration for a model, if available.
 *
 * @param modelId - The model identifier
 * @returns ExtendedContext config, or undefined if not supported
 */
export function getModelExtendedContext(modelId: string): ExtendedContext | undefined {
	return MODEL_METADATA[modelId]?.extended_context;
}

/**
 * Get all known model IDs from the static metadata table.
 */
export function getKnownModelIds(): string[] {
	return Object.keys(MODEL_METADATA);
}

// ---------------------------------------------------------------------------
// Thinking / reasoning support detection
// ---------------------------------------------------------------------------

const THINKING_PATTERNS = [
	// Anthropic direct API — Claude 3.5 Sonnet, 3.7 Sonnet, Sonnet/Opus 4+ and 5-series
	/^claude-(opus|sonnet)-4/,
	/^claude-(opus|sonnet)-5/,
	/^claude-fable-5/,
	/^claude-3-7-sonnet/,
	/^claude-3-5-sonnet/,
	// Bedrock Anthropic inference profiles
	/^(us|eu|apac|global)\.anthropic\.claude-(opus|sonnet)-4/,
	/^(us|eu|apac|global)\.anthropic\.claude-(opus|sonnet)-5/,
	/^(us|eu|apac|global)\.anthropic\.claude-fable-5/,
	/^(us|eu|apac|global)\.anthropic\.claude-3-7-sonnet/,
	/^(us|eu|apac|global)\.anthropic\.claude-3-5-sonnet/,
	// OpenAI o-series reasoning models
	/^o[134]/,
];

// Closed, final set: models that use the legacy `enabled`+budget_tokens thinking
// protocol, which streams a VISIBLE reasoning transcript. This list never grows —
// every model using the old protocol already exists. All newer models (Opus 4.8+)
// use the adaptive/effort protocol and are covered by the default in
// getThinkingMode(), so they need no entry here.
const LEGACY_ENABLED_THINKING_PATTERNS = [
	// Claude 3.5 / 3.7 Sonnet (direct API + Bedrock inference profiles)
	/^claude-3-5-sonnet/,
	/^claude-3-7-sonnet/,
	/^(us|eu|apac|global)\.anthropic\.claude-3-5-sonnet/,
	/^(us|eu|apac|global)\.anthropic\.claude-3-7-sonnet/,
	// Sonnet/Opus 4.0 (dated id), Opus 4.1, Sonnet 4.5, Sonnet/Opus 4.6 — NOT 4.7/4.8.
	// Opus 4.1 (dated id claude-opus-4-1-20250805) predates the adaptive era and
	// still serves a VISIBLE reasoning transcript on Bedrock — verified by live
	// converse probe (accepts thinking.type=enabled, returns reasoningContent text),
	// unlike 4.7/4.8 which reject it. Without this entry it falls through to the
	// "effort" default and silently loses its transcript.
	/^claude-(opus|sonnet)-4-(5|6)/,
	/^claude-opus-4-1/,
	/^claude-(opus|sonnet)-4-20250514/,
	/^(us|eu|apac|global)\.anthropic\.claude-(opus|sonnet)-4-(5|6)/,
	/^(us|eu|apac|global)\.anthropic\.claude-opus-4-1/,
	/^(us|eu|apac|global)\.anthropic\.claude-(opus|sonnet)-4-20250514/,
];

export type ThinkingMode = "enabled" | "effort";

/**
 * A model's thinking capability, resolved through a single chokepoint so the
 * UI-visibility decision and the wire-payload decision can never diverge.
 *
 * - `mode: "enabled"` — legacy `budget_tokens` protocol with a VISIBLE streamed
 *   transcript (closed `LEGACY_ENABLED_THINKING_PATTERNS` set).
 * - `mode: "effort"` — adaptive thinking + `output_config.effort` (Opus 4.8+).
 * - `mode: "none"` — thinking not supported / model unknown. Send NO thinking or
 *   `output_config` fields and hide the thinking control. This is the SAFE
 *   default for any model not in `THINKING_PATTERNS` (e.g. Claude Fable 5 until
 *   its dialect is confirmed) — unknown models must never emit a thinking
 *   payload a model might reject.
 */
export interface ThinkingCapability {
	supported: boolean;
	mode: "enabled" | "effort" | "none";
}

/**
 * Normalize a model id before any thinking-capability regex test. The single
 * chokepoint so a model classifies identically no matter which code path
 * (header id, active id, preset id) supplied it. Trims surrounding whitespace;
 * `THINKING_PATTERNS`/`LEGACY_ENABLED_THINKING_PATTERNS` already cover both bare
 * and `(us|eu|apac|global).anthropic.*` inference-profile forms.
 */
function normalizeModelId(modelId: string): string {
	return modelId.trim();
}

/**
 * Single source of truth for "can this model think, and how." Both the settings
 * UI gate (`buildThinkingLevelSection`, preset controls) and the wire-payload
 * builder (`resolveAnthropicThinking`) route through this so visibility and the
 * request shape are always the same decision over the same normalized id.
 */
export function getThinkingCapability(modelId: string): ThinkingCapability {
	const id = normalizeModelId(modelId);
	if (!THINKING_PATTERNS.some((pattern) => pattern.test(id))) {
		return { supported: false, mode: "none" };
	}
	return {
		supported: true,
		mode: LEGACY_ENABLED_THINKING_PATTERNS.some((pattern) => pattern.test(id))
			? "enabled"
			: "effort",
	};
}

export function supportsThinking(modelId: string): boolean {
	return getThinkingCapability(modelId).supported;
}

/**
 * The thinking protocol a (thinking-capable) model uses on the wire. Only
 * meaningful for models where `supportsThinking()` is already true; retained for
 * back-compat callers, but new code should prefer `getThinkingCapability()`.
 */
export function getThinkingMode(modelId: string): ThinkingMode {
	const mode = getThinkingCapability(modelId).mode;
	// Preserve the historical "effort" default for the (gated) unknown case.
	return mode === "none" ? "effort" : mode;
}