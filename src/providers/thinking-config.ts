import { supportsAdaptiveThinking } from "./model-metadata";

const ANTHROPIC_BUDGET_MAP: Record<string, number> = {
	low: 1024,
	medium: 4096,
	high: 16384,
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

export function resolveAnthropicThinking(
	level: string | null | undefined,
	modelId: string,
): AnthropicThinkingConfig | undefined {
	if (!level || level === "off") return undefined;

	const asInt = parseInt(level, 10);
	if (!isNaN(asInt) && asInt > 0) {
		return { type: "enabled", budget_tokens: asInt };
	}

	if (supportsAdaptiveThinking(modelId)) {
		return { type: "adaptive" };
	}

	const budget = ANTHROPIC_BUDGET_MAP[level];
	if (budget) {
		return { type: "enabled", budget_tokens: budget };
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
