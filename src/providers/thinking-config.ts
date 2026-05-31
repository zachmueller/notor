import { getThinkingMode } from "./model-metadata";

const ANTHROPIC_BUDGET_MAP: Record<string, number> = {
	low: 1024,
	medium: 4096,
	high: 16384,
};

const EFFORT_MAP: Record<string, "low" | "medium" | "high"> = {
	low: "low",
	medium: "medium",
	high: "high",
};

const OPENAI_LEVEL_MAP: Record<string, "low" | "medium" | "high"> = {
	low: "low",
	medium: "medium",
	high: "high",
};

export type AnthropicThinkingConfig =
	| { type: "enabled"; budget_tokens: number }
	| { type: "adaptive" };

export type OpenAIReasoningEffort = "low" | "medium" | "high";

/**
 * Resolved thinking configuration. `thinking` is the on-the-wire thinking
 * object; `effort` (present only for effort-capable models like Opus 4.8) is a
 * sibling field that callers place in `output_config.effort`.
 */
export interface ResolvedAnthropicThinking {
	thinking: AnthropicThinkingConfig;
	effort?: "low" | "medium" | "high";
}

export function resolveAnthropicThinking(
	level: string | null | undefined,
	modelId: string,
): ResolvedAnthropicThinking | undefined {
	if (!level || level === "off") return undefined;

	// Effort models (Opus 4.8+) use adaptive thinking + output_config.effort and
	// reject thinking.type=enabled. Named levels map directly; a custom integer
	// budget has no effort meaning, so default to medium.
	if (getThinkingMode(modelId) === "effort") {
		return {
			thinking: { type: "adaptive" },
			effort: EFFORT_MAP[level] ?? "medium",
		};
	}

	// "enabled" mode: visible streamed thinking via budget_tokens.
	const asInt = parseInt(level, 10);
	if (!isNaN(asInt) && asInt > 0) {
		return { thinking: { type: "enabled", budget_tokens: asInt } };
	}

	const budget = ANTHROPIC_BUDGET_MAP[level];
	if (budget) {
		return { thinking: { type: "enabled", budget_tokens: budget } };
	}

	return undefined;
}

export function resolveOpenAIReasoning(
	level: string | null | undefined,
): OpenAIReasoningEffort | undefined {
	if (!level || level === "off") return undefined;

	const mapped = OPENAI_LEVEL_MAP[level];
	if (mapped) return mapped;

	// Integer input → map to nearest named level
	const asInt = parseInt(level, 10);
	if (!isNaN(asInt) && asInt > 0) {
		if (asInt <= 2048) return "low";
		if (asInt <= 8192) return "medium";
		return "high";
	}

	return undefined;
}
