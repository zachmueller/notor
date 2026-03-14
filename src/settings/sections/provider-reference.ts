/**
 * Provider & model identifier reference section renderer (A-012).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/**
 * Render a "Provider & model identifiers" reference section in Settings.
 *
 * Lists each configured provider by its identifier string alongside
 * available models with copyable identifier strings. Helps users
 * configure `notor-preferred-provider` and `notor-preferred-model`
 * in persona frontmatter.
 *
 * @see specs/03-workflows-personas/tasks/group-a-tasks.md — A-012
 */
export function renderProviderModelReferenceSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Provider & model identifiers");
	containerEl.createEl("p", {
		text:
			"Reference list of provider and model identifier strings for use in persona " +
			"frontmatter (notor-preferred-provider and notor-preferred-model). " +
			"Click the copy button to copy an identifier to your clipboard.",
		cls: "setting-item-description",
	});

	const providers = ctx.settings.providers;

	if (providers.length === 0) {
		containerEl.createEl("p", {
			text: "Configure a provider above to see available identifiers.",
			cls: "notor-provider-ref-empty",
		});
		return;
	}

	const refContainer = containerEl.createDiv({ cls: "notor-provider-ref-section" });

	for (const providerConfig of providers) {
		const group = refContainer.createDiv({ cls: "notor-provider-ref-group" });

		// Provider header: display name + identifier with copy button
		const header = group.createDiv({ cls: "notor-provider-ref-header" });
		header.createEl("strong", { text: providerConfig.display_name });
		header.createSpan({
			cls: "notor-provider-ref-id",
			text: `(${providerConfig.type})`,
		});

		const providerCopyBtn = header.createEl("button", {
			cls: "notor-copy-id-btn",
			text: "Copy",
			attr: { "aria-label": `Copy provider identifier: ${providerConfig.type}` },
		});
		providerCopyBtn.addEventListener("click", () => {
			navigator.clipboard.writeText(providerConfig.type).then(() => {
				providerCopyBtn.textContent = "Copied";
				setTimeout(() => {
					providerCopyBtn.textContent = "Copy";
				}, 1500);
			});
		});

		// Models list from cached model data in the provider config
		const cachedModels = providerConfig.model_cache;
		if (cachedModels && cachedModels.length > 0) {
			for (const model of cachedModels) {
				renderModelRefItem(group, model.display_name || model.id, model.id);
			}
		} else if (providerConfig.model_id) {
			// Show the single configured model_id if no cache
			renderModelRefItem(group, providerConfig.model_id, providerConfig.model_id);
		} else {
			group.createDiv({
				cls: "notor-provider-ref-empty",
				text: "No models loaded — open the chat panel to refresh",
			});
		}
	}
}

/** Render a single model reference item with a copy button. */
function renderModelRefItem(
	parent: HTMLElement,
	displayName: string,
	modelId: string
): void {
	const item = parent.createDiv({ cls: "notor-model-ref-item" });
	item.createSpan({
		cls: "notor-model-ref-name",
		text: displayName,
	});
	item.createSpan({
		cls: "notor-model-ref-id",
		text: modelId,
	});

	const modelCopyBtn = item.createEl("button", {
		cls: "notor-copy-id-btn",
		text: "Copy",
		attr: { "aria-label": `Copy model identifier: ${modelId}` },
	});
	modelCopyBtn.addEventListener("click", () => {
		navigator.clipboard.writeText(modelId).then(() => {
			modelCopyBtn.textContent = "Copied";
			setTimeout(() => {
				modelCopyBtn.textContent = "Copy";
			}, 1500);
		});
	});
}
