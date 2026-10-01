/**
 * Model context limits settings section.
 *
 * Lets the user override a model's context window and review the limits
 * Notor detected on its own (Anthropic models API, overflow errors, rejected
 * 1M betas). Lists re-render in place — never `ctx.redisplay()` — so the
 * pane keeps its scroll position and half-typed input.
 */

import { Notice, Setting, type TextComponent } from "obsidian";
import type { SettingsContext } from "./context";
import { markSubsection } from "../helpers";
import { describeContextWindow, type ContextWindowInfo } from "../../providers/model-metadata";
import { EXTENDED_CONTEXT_SUFFIX } from "../../providers/model-id";
import { forgetModelLimit, listModelLimits, onModelLimitsChanged } from "../../providers/model-limits";

/** Deep-link target for `scrollSettingsToGroup("Reference", …)`. */
export const MODEL_CONTEXT_LIMITS_SUBSECTION = "Model context limits";

/** Smallest override accepted (the registry ignores anything below). */
const MIN_OVERRIDE_TOKENS = 1_000;

/** Render the "Model context limits" settings section. */
export function renderModelContextLimitsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	const heading = new Setting(containerEl).setHeading().setName("Model context limits");
	markSubsection(heading, MODEL_CONTEXT_LIMITS_SUBSECTION);
	containerEl.createEl("p", {
		text:
			"Notor uses each model's context window to decide when to compact a conversation. " +
			"Windows come from built-in data, the Anthropic models API, a related model, " +
			"or limits learned from errors. An override wins over all of them.",
		cls: "setting-item-description",
	});

	// --- Overrides -----------------------------------------------------------

	const overridesEl = containerEl.createDiv();
	const renderOverrides = () => {
		overridesEl.empty();
		const overrides = ctx.settings.model_context_overrides;
		for (const key of Object.keys(overrides).sort((a, b) => a.localeCompare(b))) {
			const tokens = overrides[key];
			if (tokens === undefined) continue;
			const extended = key.endsWith(EXTENDED_CONTEXT_SUFFIX);
			const modelId = extended ? key.slice(0, -EXTENDED_CONTEXT_SUFFIX.length) : key;
			const info = describeContextWindow(modelId, extended);
			new Setting(overridesEl)
				.setName(extended ? `${modelId} (1M variant)` : modelId)
				.setDesc(`${formatTokens(tokens)} tokens · otherwise ${describeWithoutOverride(info)}`)
				.addButton((btn) =>
					btn
						.setButtonText("Remove")
						.setWarning()
						.onClick(async () => {
							delete ctx.settings.model_context_overrides[key];
							await ctx.saveSettings();
							renderOverrides();
						})
				);
		}
	};
	renderOverrides();

	let newModelId = "";
	let newTokens = "";
	let modelInput: TextComponent | undefined;
	let tokensInput: TextComponent | undefined;
	const addSetting = new Setting(containerEl)
		.setName("Add override")
		.setDesc(
			"Model ID and context window in tokens (e.g. 200000, 200k or 1m). " +
				`Append ${EXTENDED_CONTEXT_SUFFIX} to the model ID to apply only to its 1M variant.`
		);
	addSetting.addText((text) => {
		text.setPlaceholder("Model ID").onChange((v) => {
			newModelId = v.trim();
		});
		text.inputEl.addClass("notor-input-w-160");
		modelInput = text;
	});
	addSetting.addText((text) => {
		text.setPlaceholder("Tokens").onChange((v) => {
			newTokens = v.trim();
		});
		text.inputEl.addClass("notor-input-w-80");
		tokensInput = text;
	});
	addSetting.addButton((btn) =>
		btn.setButtonText("Add").onClick(async () => {
			if (!newModelId) {
				new Notice("Model ID is required.");
				return;
			}
			const tokens = parseTokenCount(newTokens);
			if (tokens === null || tokens < MIN_OVERRIDE_TOKENS) {
				new Notice("Enter a context window of at least 1,000 tokens (e.g. 200000, 200k or 1m).");
				return;
			}
			ctx.settings.model_context_overrides[newModelId] = tokens;
			await ctx.saveSettings();
			newModelId = "";
			newTokens = "";
			modelInput?.setValue("");
			tokensInput?.setValue("");
			renderOverrides();
		})
	);

	// --- Detected limits -----------------------------------------------------

	new Setting(containerEl)
		.setName("Detected limits")
		.setDesc(
			"Limits Notor found on its own. Learned limits only ever lower a window; " +
				"forget one if the model's limit has since increased."
		);
	const detectedEl = containerEl.createDiv();
	// A direct child of the group body so it picks up the description indent.
	const emptyEl = containerEl.createEl("p", { text: "No detected limits yet.", cls: "setting-item-description" });
	const renderDetected = () => {
		detectedEl.empty();
		const { api, learned, betaRejected } = listModelLimits();
		const isEmpty = api.length === 0 && learned.length === 0 && betaRejected.length === 0;
		emptyEl.toggle(isEmpty);
		if (isEmpty) return;

		for (const entry of learned) {
			const how = entry.source === "estimate"
				? "estimated after an overflow error"
				: "learned from an overflow error";
			new Setting(detectedEl)
				.setName(entry.extended ? `${entry.modelId} (1M variant)` : entry.modelId)
				.setDesc(`${formatTokens(entry.context_window)} tokens · ${how}`)
				.addButton((btn) =>
					btn.setButtonText("Forget").onClick(() => forgetModelLimit("learned", entry.key))
				);
		}

		for (const entry of betaRejected) {
			new Setting(detectedEl)
				.setName(entry.modelId)
				.setDesc("Bedrock rejected the extended context beta, so Notor no longer sends it")
				.addButton((btn) =>
					btn.setButtonText("Forget").onClick(() => forgetModelLimit("beta_rejected", entry.modelId))
				);
		}

		if (api.length > 0) {
			// Re-reported on every model list refresh, so summarized rather than listed.
			new Setting(detectedEl)
				.setName("Anthropic models API")
				.setDesc(`Context windows for ${api.length} ${api.length === 1 ? "model" : "models"}, refreshed when the model list loads`)
				.addButton((btn) =>
					btn.setButtonText("Clear").onClick(() => {
						for (const entry of api) forgetModelLimit("api", entry.modelId);
					})
				);
		}
	};
	renderDetected();
	const off = onModelLimitsChanged(() => {
		renderDetected();
		renderOverrides();
	});
	ctx.addCleanup?.(off);
}

/**
 * Parse a token count such as `200000`, `200,000`, `200k`, `1m` or `1.5m`.
 *
 * @returns the count, or null when unparseable
 */
export function parseTokenCount(input: string): number | null {
	const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(input.trim().toLowerCase().replace(/[,_\s]/g, ""));
	if (!match) return null;
	const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
	const value = Math.round(Number(match[1]) * multiplier);
	return Number.isFinite(value) && value > 0 ? value : null;
}

function formatTokens(tokens: number): string {
	return tokens.toLocaleString("en-US");
}

/** What the window would be without the override, e.g. "1,000,000 from the Anthropic models API". */
function describeWithoutOverride(info: ContextWindowInfo): string {
	if (info.learned !== undefined && info.learned < info.base) {
		return `${formatTokens(info.learned)} (learned from an overflow error)`;
	}
	const source =
		info.baseSource === "api" ? "from the Anthropic models API"
			: info.baseSource === "static" ? "from built-in data"
				: info.baseSource === "inferred"
					? (info.inferredFrom ? `inferred from ${info.inferredFrom}` : "assumed for a new model")
					: "the default for unknown models";
	return `${formatTokens(info.base)} ${source}`;
}
