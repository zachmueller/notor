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
import { logger } from "../utils/logger";
import {
	parseClaudeModelId,
	pickNearestClaudeEntry,
	type ClaudeCandidate,
	type ClaudeFamily,
} from "./model-family";
import {
	getApiContextWindow,
	getContextOverride,
	getLearnedContextWindow,
	isBetaRejected,
	reportFallbackContextWindow,
} from "./model-limits";

const log = logger("ModelMetadata");

/** Default context window for unknown models. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Extended context configuration for models that support
 * the 1M context window beta header on Bedrock.
 */
export interface ExtendedContext {
	context_window: number;
	beta_flag: string;
	input_price_per_1k?: number;
	output_price_per_1k?: number;
	/**
	 * The extended window is the model's default: the beta flag is sent on
	 * every request and the picker shows no separate 1M variant. If Bedrock
	 * rejects the beta, the model falls back to the entry's base window.
	 */
	default?: boolean;
}

/**
 * Metadata entry for a known model.
 * Only includes fields not available from provider list APIs.
 */
export interface ModelMetadataEntry {
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
	// 5.5-series / Fable 5.1 — 1M is the default (and maximum) window on the
	// Anthropic API, no beta header. Pricing: Anthropic list rates.
	"claude-opus-5-5": {
		context_window: 1_000_000,
		input_price_per_1k: 0.004,
		output_price_per_1k: 0.020,
		display_name: "Claude Opus 5.5",
	},
	"claude-sonnet-5-5": {
		context_window: 1_000_000,
		input_price_per_1k: 0.002,
		output_price_per_1k: 0.010,
		display_name: "Claude Sonnet 5.5",
	},
	"claude-fable-5-1": {
		context_window: 1_000_000,
		input_price_per_1k: 0.010,
		output_price_per_1k: 0.050,
		display_name: "Claude Fable 5.1",
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

	// -----------------------------------------------------------------------
	// Claude 5.5-series / Fable 5.1 — 1M by default.
	//
	// As of 2026-10, us-east-1 lists only `us.` and `global.` profiles (the
	// model cards also name eu./au./jp. geos — not added until seen live).
	// Live converse probes: all three accept the `context-1m-2025-08-07` beta
	// and reject thinking.type=enabled ("use adaptive"), so they classify
	// "effort" via the getThinkingMode() default. The AWS model cards list a
	// 1M context window, so `extended_context.default` sends the beta on every
	// request (no separate 1M picker variant); if Bedrock ever rejects it the
	// model falls back to the 200K base. No long-context premium, so the 1M
	// window uses base pricing. Bedrock rates aren't published on the pricing
	// page yet — Anthropic list rates below.
	// -----------------------------------------------------------------------

	// Claude Opus 5.5
	"us.anthropic.claude-opus-5-5": {
		context_window: 200_000,
		input_price_per_1k: 0.004, // verify (Anthropic list rate; geo profiles may add ~10%)
		output_price_per_1k: 0.020, // verify
		display_name: "Claude Opus 5.5",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			default: true,
		},
	},
	"global.anthropic.claude-opus-5-5": {
		context_window: 200_000,
		input_price_per_1k: 0.004, // verify (Anthropic list rate; geo profiles may add ~10%)
		output_price_per_1k: 0.020, // verify
		display_name: "Claude Opus 5.5",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			default: true,
		},
	},

	// Claude Sonnet 5.5
	"us.anthropic.claude-sonnet-5-5": {
		context_window: 200_000,
		input_price_per_1k: 0.002, // verify (Anthropic list rate; geo profiles may add ~10%)
		output_price_per_1k: 0.010, // verify
		display_name: "Claude Sonnet 5.5",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			default: true,
		},
	},
	"global.anthropic.claude-sonnet-5-5": {
		context_window: 200_000,
		input_price_per_1k: 0.002, // verify (Anthropic list rate; geo profiles may add ~10%)
		output_price_per_1k: 0.010, // verify
		display_name: "Claude Sonnet 5.5",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			default: true,
		},
	},

	// Claude Fable 5.1 — the account's data-retention mode must be aws_review (model card)
	"us.anthropic.claude-fable-5-1": {
		context_window: 200_000,
		input_price_per_1k: 0.010, // verify (Anthropic list rate; geo profiles may add ~10%)
		output_price_per_1k: 0.050, // verify
		display_name: "Claude Fable 5.1",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			default: true,
		},
	},
	"global.anthropic.claude-fable-5-1": {
		context_window: 200_000,
		input_price_per_1k: 0.010, // verify (Anthropic list rate; geo profiles may add ~10%)
		output_price_per_1k: 0.050, // verify
		display_name: "Claude Fable 5.1",
		extended_context: {
			context_window: 1_000_000,
			beta_flag: "context-1m-2025-08-07",
			default: true,
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

	// -----------------------------------------------------------------------
	// AWS Bedrock — OpenAI inference profiles
	// -----------------------------------------------------------------------
	// Context windows and Standard-tier rates from the AWS model cards
	// (2026-10). Prices are the short-context rate (≤272K input); requests
	// above 272K input are billed at roughly 2x for the whole request.
	// Geo (us.) profiles carry a 10% premium over global.
	// GPT-5.4 / GPT-5.5: the model cards list bedrock-mantle only (no
	// bedrock-runtime Converse), but the profiles are ACTIVE so they still list.
	// Their us./global. rates are not published — In-Region rate (us.) and the
	// OpenAI base rate (global.) used here.
	"us.openai.gpt-5.4": {
		context_window: 1_050_000,
		input_price_per_1k: 0.00275, // verify pricing
		output_price_per_1k: 0.0165, // verify pricing
	},
	"global.openai.gpt-5.4": {
		context_window: 1_050_000,
		input_price_per_1k: 0.0025, // verify pricing
		output_price_per_1k: 0.015, // verify pricing
	},
	"us.openai.gpt-5.5": {
		context_window: 1_050_000,
		input_price_per_1k: 0.0055, // verify pricing
		output_price_per_1k: 0.033, // verify pricing
	},
	"global.openai.gpt-5.5": {
		context_window: 1_050_000,
		input_price_per_1k: 0.005, // verify pricing
		output_price_per_1k: 0.030, // verify pricing
	},
	"us.openai.gpt-5.6-sol": {
		context_window: 1_050_000,
		input_price_per_1k: 0.0044, // verify pricing
		output_price_per_1k: 0.022, // verify pricing
	},
	"global.openai.gpt-5.6-sol": {
		context_window: 1_050_000,
		input_price_per_1k: 0.004, // verify pricing
		output_price_per_1k: 0.020, // verify pricing
	},
	"us.openai.gpt-5.6-terra": {
		context_window: 1_050_000,
		input_price_per_1k: 0.0022, // verify pricing
		output_price_per_1k: 0.0132, // verify pricing
	},
	"global.openai.gpt-5.6-terra": {
		context_window: 1_050_000,
		input_price_per_1k: 0.002, // verify pricing
		output_price_per_1k: 0.012, // verify pricing
	},
	"us.openai.gpt-5.6-luna": {
		context_window: 1_050_000,
		input_price_per_1k: 0.00022, // verify pricing
		output_price_per_1k: 0.00132, // verify pricing
	},
	"global.openai.gpt-5.6-luna": {
		context_window: 1_050_000,
		input_price_per_1k: 0.0002, // verify pricing
		output_price_per_1k: 0.0012, // verify pricing
	},
	"us.openai.gpt-6-astra": {
		context_window: 1_050_000,
		input_price_per_1k: 0.011, // verify pricing
		output_price_per_1k: 0.055, // verify pricing
	},
	"global.openai.gpt-6-astra": {
		context_window: 1_050_000,
		input_price_per_1k: 0.010, // verify pricing
		output_price_per_1k: 0.050, // verify pricing
	},
	"us.openai.gpt-6-sol": {
		context_window: 1_050_000,
		input_price_per_1k: 0.0022, // verify pricing
		output_price_per_1k: 0.011, // verify pricing
	},
	"global.openai.gpt-6-sol": {
		context_window: 1_050_000,
		input_price_per_1k: 0.002, // verify pricing
		output_price_per_1k: 0.010, // verify pricing
	},
	"us.openai.gpt-6-luna": {
		context_window: 1_050_000,
		input_price_per_1k: 0.00011, // verify pricing
		output_price_per_1k: 0.00055, // verify pricing
	},
	"global.openai.gpt-6-luna": {
		context_window: 1_050_000,
		input_price_per_1k: 0.0001, // verify pricing
		output_price_per_1k: 0.0005, // verify pricing
	},
	"us.openai.gpt-6.1-sol": {
		context_window: 1_000_000,
		input_price_per_1k: 0.0022, // verify pricing
		output_price_per_1k: 0.011, // verify pricing
	},
	"global.openai.gpt-6.1-sol": {
		context_window: 1_000_000,
		input_price_per_1k: 0.002, // verify pricing
		output_price_per_1k: 0.010, // verify pricing
	},

	// -----------------------------------------------------------------------
	// AWS Bedrock — xAI inference profiles
	// -----------------------------------------------------------------------
	// Grok 4.6 / 4.7 — 500K context; rates from the AWS model cards (2026-10).
	"us.xai.grok-4.6": {
		context_window: 500_000,
		input_price_per_1k: 0.0022, // verify pricing
		output_price_per_1k: 0.0066, // verify pricing
	},
	"global.xai.grok-4.6": {
		context_window: 500_000,
		input_price_per_1k: 0.002, // verify pricing
		output_price_per_1k: 0.006, // verify pricing
	},
	"us.xai.grok-4.7": {
		context_window: 500_000,
		input_price_per_1k: 0.0022, // verify pricing
		output_price_per_1k: 0.0066, // verify pricing
	},
	"global.xai.grok-4.7": {
		context_window: 500_000,
		input_price_per_1k: 0.002, // verify pricing
		output_price_per_1k: 0.006, // verify pricing
	},

	// -----------------------------------------------------------------------
	// AWS Bedrock — Moonshot AI inference profiles
	// -----------------------------------------------------------------------
	// Kimi K3 — 1M context; rates from the AWS model card (2026-10). The card
	// notes Converse fails when prior-turn reasoning blocks are replayed.
	"us.moonshotai.kimi-k3": {
		context_window: 1_000_000,
		input_price_per_1k: 0.0033, // verify pricing
		output_price_per_1k: 0.0165, // verify pricing
	},
	"global.moonshotai.kimi-k3": {
		context_window: 1_000_000,
		input_price_per_1k: 0.003, // verify pricing
		output_price_per_1k: 0.015, // verify pricing
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

// ---------------------------------------------------------------------------
// Claude family inference (models not yet in the static table)
// ---------------------------------------------------------------------------

/**
 * Claude families whose newly released versions are assumed to ship with a
 * 1M context window (every Sonnet/Opus/Fable since 4.6 does). Haiku is
 * excluded — new Haiku versions inherit their nearest sibling's window.
 */
const DEFAULT_1M_FAMILIES: ReadonlySet<ClaudeFamily> = new Set(["sonnet", "opus", "fable", "mythos"]);

/** Context window assumed for a new Sonnet+ model. */
const ASSUMED_NEW_MODEL_CONTEXT_WINDOW = 1_000_000;

/** Beta flag sent for a new Bedrock Sonnet+ model when its sibling has none. */
const DEFAULT_EXTENDED_BETA_FLAG = "context-1m-2025-08-07";

/** Base window for a sibling-less new model once Bedrock rejects its 1M beta. */
const CLAUDE_BASE_CONTEXT_WINDOW = 200_000;

/** Metadata inferred for a Claude model missing from the static table. Never carries pricing. */
interface InferredEntry {
	/** Sibling table entry this was derived from, or null when none exists. */
	from: string | null;
	/** Base context window (for a new Bedrock Sonnet+ model: the fallback if its beta is rejected). */
	context_window: number;
	/** Extended context, inherited from the sibling or assumed by default for a new Sonnet+ model. */
	extended_context?: ExtendedContext;
}

let claudeCandidates: Array<ClaudeCandidate<ModelMetadataEntry>> | null = null;
const inferenceMemo = new Map<string, InferredEntry | null>();

function getClaudeCandidates(): Array<ClaudeCandidate<ModelMetadataEntry>> {
	if (!claudeCandidates) {
		claudeCandidates = [];
		for (const [id, value] of Object.entries(MODEL_METADATA)) {
			const parsed = parseClaudeModelId(id);
			if (parsed) claudeCandidates.push({ id, parsed, value });
		}
	}
	return claudeCandidates;
}

/** Infer metadata for an unknown Claude model ID (memoized). */
function inferClaude(modelId: string): InferredEntry | null {
	const cached = inferenceMemo.get(modelId);
	if (cached !== undefined) return cached;

	let inferred: InferredEntry | null = null;
	const parsed = parseClaudeModelId(modelId);
	if (parsed) {
		const sibling = pickNearestClaudeEntry(parsed, getClaudeCandidates());
		const siblingExt = sibling?.value.extended_context;
		if (DEFAULT_1M_FAMILIES.has(parsed.family) && (!sibling || sibling.newerThanAll)) {
			// New Sonnet+ model: assume 1M. Direct-API IDs get it as the base
			// window; Bedrock IDs send the 1M beta by default.
			inferred = parsed.shape === "bedrock"
				? {
					from: sibling?.id ?? null,
					context_window: sibling?.value.context_window ?? CLAUDE_BASE_CONTEXT_WINDOW,
					extended_context: {
						context_window: ASSUMED_NEW_MODEL_CONTEXT_WINDOW,
						beta_flag: siblingExt?.beta_flag ?? DEFAULT_EXTENDED_BETA_FLAG,
						default: true,
					},
				}
				: { from: sibling?.id ?? null, context_window: ASSUMED_NEW_MODEL_CONTEXT_WINDOW };
		} else if (sibling) {
			inferred = {
				from: sibling.id,
				context_window: sibling.value.context_window,
				extended_context: siblingExt
					? { context_window: siblingExt.context_window, beta_flag: siblingExt.beta_flag, default: siblingExt.default }
					: undefined,
			};
		}
	}

	inferenceMemo.set(modelId, inferred);
	if (inferred) {
		log.info("Inferred context window for unknown model", {
			modelId,
			from: inferred.from,
			contextWindow: inferred.context_window,
			extendedByDefault: inferred.extended_context?.default === true,
		});
	}
	return inferred;
}

/** The static or inferred entry for a model, if any. */
function lookupEntry(modelId: string): { entry: InferredEntry | ModelMetadataEntry; inferredFrom?: string | null } | null {
	const entry = MODEL_METADATA[modelId];
	if (entry) return { entry };
	const inferred = inferClaude(modelId);
	return inferred ? { entry: inferred, inferredFrom: inferred.from } : null;
}

/** Whether a default-on extended context is active (its beta not rejected). */
function defaultExtendedActive(modelId: string, ext: ExtendedContext | undefined): boolean {
	return ext?.default === true && !isBetaRejected(modelId);
}

/** Context window for a static or inferred entry in the given mode. */
function entryContextWindow(
	modelId: string,
	entry: { context_window: number; extended_context?: ExtendedContext },
	useExtendedContext?: boolean
): number {
	const ext = entry.extended_context;
	if (!ext) return entry.context_window;
	if (ext.default) return defaultExtendedActive(modelId, ext) ? ext.context_window : entry.context_window;
	return useExtendedContext ? ext.context_window : entry.context_window;
}

// ---------------------------------------------------------------------------
// Context window resolution
// ---------------------------------------------------------------------------

/** Where a resolved context window came from. */
export type ContextWindowSource = "override" | "learned" | "api" | "static" | "inferred" | "default";

/** A resolved context window plus how it was derived. */
export interface ContextWindowInfo {
	/** The effective window. */
	tokens: number;
	source: ContextWindowSource;
	/** The window before overrides and learned limits. */
	base: number;
	baseSource: "api" | "static" | "inferred" | "default";
	learned?: number;
	override?: number;
	/** Sibling table entry used when `baseSource` is "inferred" (null if none). */
	inferredFrom?: string | null;
}

function resolveBaseContextWindow(
	modelId: string,
	useExtendedContext?: boolean
): Pick<ContextWindowInfo, "base" | "baseSource" | "inferredFrom"> {
	const api = getApiContextWindow(modelId);
	if (api !== undefined) {
		// The Anthropic API reports one window per model — no beta variant.
		return { base: api, baseSource: "api" };
	}
	const found = lookupEntry(modelId);
	if (found) {
		return {
			base: entryContextWindow(modelId, found.entry, useExtendedContext),
			baseSource: found.inferredFrom !== undefined ? "inferred" : "static",
			...(found.inferredFrom !== undefined ? { inferredFrom: found.inferredFrom } : {}),
		};
	}
	return { base: DEFAULT_CONTEXT_WINDOW, baseSource: "default" };
}

/**
 * Resolve a model's context window and report where it came from.
 *
 * Precedence: user override → (API limit → static table → Claude family
 * inference → 128K default), then clamped down by any limit learned from an
 * overflow error. Unlike {@link getContextWindow}, never warns.
 */
export function describeContextWindow(modelId: string, useExtendedContext?: boolean): ContextWindowInfo {
	const id = modelId.trim();
	const base = resolveBaseContextWindow(id, useExtendedContext);
	const override = getContextOverride(id, useExtendedContext);
	const learned = getLearnedContextWindow(id, useExtendedContext);
	const detail = { ...base, learned, override };

	if (override !== undefined) return { ...detail, tokens: override, source: "override" };
	if (learned !== undefined && learned < base.base) return { ...detail, tokens: learned, source: "learned" };
	return { ...detail, tokens: base.base, source: base.baseSource };
}

/**
 * Get the context window size for a model.
 *
 * Resolution order: user override, then the provider's model-list API, the
 * static table, Claude family inference, and finally DEFAULT_CONTEXT_WINDOW
 * (128,000) — clamped down by any limit learned from an overflow error.
 * Using the 128K default reports a one-time warning for the model.
 *
 * @param modelId - The model identifier
 * @param useExtendedContext - Whether to use the extended (1M) context window
 * @returns Context window size in tokens
 */
export function getContextWindow(modelId: string, useExtendedContext?: boolean): number {
	const info = describeContextWindow(modelId, useExtendedContext);
	if (info.source === "default") {
		reportFallbackContextWindow(modelId);
	}
	return info.tokens;
}

/**
 * Enrich a ModelInfo object with metadata from the static table.
 *
 * Fills in context_window and pricing if available from the static
 * table. Fields already present on the input are not overwritten.
 * For Claude models missing from the table, fills only the inferred
 * context_window — pricing is never inferred.
 *
 * @param model - A ModelInfo object (e.g., from a provider's listModels)
 * @returns The same object with enriched fields
 */
export function enrichModelInfo(model: ModelInfo): ModelInfo {
	const entry = MODEL_METADATA[model.id];
	if (!entry) {
		if (model.context_window != null) return model;
		const inferred = inferClaude(model.id);
		return inferred
			? { ...model, context_window: entryContextWindow(model.id, inferred) }
			: model;
	}
	return {
		...model,
		display_name:
			model.display_name !== model.id
				? model.display_name
				: (entry.display_name ?? model.display_name),
		context_window: model.context_window ?? entryContextWindow(model.id, entry),
		input_price_per_1k:
			model.input_price_per_1k ?? entry.input_price_per_1k,
		output_price_per_1k:
			model.output_price_per_1k ?? entry.output_price_per_1k,
	};
}

/**
 * Get the extended context configuration for a model's selectable 1M variant.
 *
 * A static entry is authoritative (even one without extended context).
 * Models with an API-reported window have no beta variant. Otherwise an
 * inferred Claude model inherits its sibling's extended context (without
 * pricing). Returns undefined when the 1M window is already the default.
 *
 * @param modelId - The model identifier
 * @returns ExtendedContext config, or undefined if there is no separate 1M variant
 */
export function getModelExtendedContext(modelId: string): ExtendedContext | undefined {
	if (!MODEL_METADATA[modelId] && getApiContextWindow(modelId) !== undefined) return undefined;
	const ext = lookupEntry(modelId)?.entry.extended_context;
	return ext && !ext.default ? ext : undefined;
}

/**
 * The 1M beta flag to send with a Bedrock request, if any.
 *
 * Sent when the user selected the extended variant of a model that has one,
 * or on every request for a model whose 1M window is the default (unless
 * Bedrock has rejected its beta).
 */
export function getExtendedContextBeta(modelId: string, useExtendedContext?: boolean): string | undefined {
	if (!MODEL_METADATA[modelId] && getApiContextWindow(modelId) !== undefined) return undefined;
	const ext = lookupEntry(modelId)?.entry.extended_context;
	if (!ext) return undefined;
	if (ext.default) return defaultExtendedActive(modelId, ext) ? ext.beta_flag : undefined;
	return useExtendedContext ? ext.beta_flag : undefined;
}

/**
 * Whether a model sends the 1M beta by default — its 1M window is the
 * default (static entry or a new inferred Sonnet+ Bedrock model) and Bedrock
 * hasn't rejected the beta yet.
 */
export function sendsExtendedBetaByDefault(modelId: string): boolean {
	if (!MODEL_METADATA[modelId] && getApiContextWindow(modelId) !== undefined) return false;
	return defaultExtendedActive(modelId, lookupEntry(modelId)?.entry.extended_context);
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