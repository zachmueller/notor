/**
 * Settings popover extracted from chat-view.ts (CHAT-008).
 *
 * Manages the model preset selector, thinking level, and checkpoints UI.
 */

import { Modal, Notice } from "obsidian";
import type { App } from "obsidian";
import type { ModelInfo, ModelPreset, Checkpoint } from "../types";
import { groupModels, formatFullVariantLabel, type ModelGroup } from "../providers/model-grouping";
import { supportsThinking } from "../providers/model-metadata";
import { formatRelativeTime } from "../utils/format-time";
import { logger } from "../utils/logger";

const log = logger("SettingsPopover");

export interface SettingsPopoverDeps {
	headerEl: HTMLElement;
	app: App;
	providers: Array<{ id: string; display_name: string }>;

	getIsSettingsOpen: () => boolean;
	setIsSettingsOpen: (v: boolean) => void;
	getShowConversationList: () => boolean;

	getDisplayedPresetName: () => string | null | undefined;
	setDisplayedPresetName: (v: string | null | undefined) => void;
	getDisplayedProviderId: () => string | null;
	setDisplayedProviderId: (v: string | null) => void;
	getDisplayedModelValue: () => string | null;
	setDisplayedModelValue: (v: string | null) => void;

	onSettingsOpen?: () => void;
	onPresetChange?: (presetName: string | null, providerId?: string, modelId?: string, useExtendedContext?: boolean) => void;
	onProviderChange?: (providerId: string) => void;
	onModelChange?: (modelId: string) => void;
	onRefreshModels?: () => Promise<ModelInfo[]>;
	onThinkingLevelChange?: (level: string | null) => void;
	onListCheckpoints?: () => Promise<Checkpoint[]>;
	onRestoreCheckpoint?: (checkpointId: string) => Promise<boolean>;
	onGetCurrentContent?: (notePath: string) => Promise<string | null>;

	getAvailablePresets?: () => ModelPreset[];
	getCurrentPreset?: () => string | null;
	getAvailableProviders?: () => { id: string; type: string; displayName: string }[];
	getAvailableModels?: () => ModelInfo[];
	getCurrentProvider?: () => string;
	getCurrentModel?: () => string;
	getActiveModelId?: () => string;
	getActiveThinkingLevel?: () => string | null;

	toggleConversationList: () => void;
}

export class SettingsPopover {
	private popoverEl?: HTMLElement;
	private outsideClickHandler?: (e: MouseEvent) => void;
	private escapeHandler?: (e: KeyboardEvent) => void;

	constructor(public deps: SettingsPopoverDeps) {}

	toggle(): void {
		if (this.deps.getIsSettingsOpen()) {
			this.close();
		} else {
			this.open();
		}
	}

	open(): void {
		this.close();
		if (this.deps.getShowConversationList()) {
			this.deps.toggleConversationList();
		}
		this.deps.setIsSettingsOpen(true);

		this.popoverEl = this.deps.headerEl.createDiv({ cls: "notor-settings-popover" });

		setTimeout(() => {
			this.outsideClickHandler = (e: MouseEvent) => {
				const target = e.target as Node | null;
				if (
					this.popoverEl &&
					target &&
					!this.popoverEl.contains(target) &&
					!(target as HTMLElement).closest?.("[aria-label='Chat settings']")
				) {
					this.close();
				}
			};
			document.addEventListener("mousedown", this.outsideClickHandler, true);
		}, 0);

		this.escapeHandler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				this.close();
				e.preventDefault();
			}
		};
		document.addEventListener("keydown", this.escapeHandler, true);

		this.buildPresetSelect(this.popoverEl);
		this.buildThinkingLevelSection(this.popoverEl);
		this.buildCheckpointsSection(this.popoverEl);
	}

	close(): void {
		if (this.outsideClickHandler) {
			document.removeEventListener("mousedown", this.outsideClickHandler, true);
			this.outsideClickHandler = undefined;
		}
		if (this.escapeHandler) {
			document.removeEventListener("keydown", this.escapeHandler, true);
			this.escapeHandler = undefined;
		}
		this.deps.setIsSettingsOpen(false);
		this.popoverEl?.remove();
		this.popoverEl = undefined;
	}

	refreshModelSelect(): void {
		if (!this.popoverEl) return;
		const customSection = this.popoverEl.querySelector(".notor-custom-model-section");
		if (customSection) {
			const modelWrapper = customSection.querySelector(".notor-settings-section");
			if (modelWrapper) {
				this.buildModelSelect(modelWrapper as HTMLElement);
			}
		}
	}

	refreshThinkingSection(): void {
		if (!this.popoverEl) return;
		const existing = this.popoverEl.querySelector(".notor-thinking-section");
		if (existing) existing.remove();
		const checkpointsSection = this.popoverEl.querySelector(".notor-checkpoints-section");
		if (checkpointsSection) {
			const tempContainer = createDiv();
			this.buildThinkingLevelSection(tempContainer);
			const newSection = tempContainer.firstElementChild;
			if (newSection) {
				this.popoverEl.insertBefore(newSection, checkpointsSection);
			}
		} else {
			this.buildThinkingLevelSection(this.popoverEl);
		}
	}

	isOpen(): boolean {
		return !!this.popoverEl;
	}

	destroy(): void {
		this.close();
	}

	private buildPresetSelect(container: HTMLElement): void {
		const presetSection = container.createDiv({ cls: "notor-settings-section notor-preset-section" });
		presetSection.createDiv({ cls: "notor-settings-label", text: "Model Preset" });

		const presets = this.deps.getAvailablePresets?.() ?? [];
		const providerLabels: Record<string, string> = {};
		for (const p of this.deps.providers) {
			providerLabels[p.id] = p.display_name;
		}

		const currentPreset = this.deps.getDisplayedPresetName() !== undefined
			? this.deps.getDisplayedPresetName()
			: this.deps.getCurrentPreset?.() ?? null;

		const presetSelect = presetSection.createEl("select", { cls: "notor-settings-select" });

		for (const p of presets) {
			const isConfigured = p.provider_id !== null && p.model_id !== null;
			const detail = isConfigured
				? `${providerLabels[p.provider_id!] ?? p.provider_id} · ${p.model_id}${p.use_extended_context ? " · 1M" : ""}`
				: "(not configured)";
			const opt = presetSelect.createEl("option", {
				text: `${p.name}  —  ${detail}`,
				attr: { value: p.name },
			});
			if (!isConfigured) {
				opt.disabled = true;
			}
			if (p.name === currentPreset) {
				opt.selected = true;
			}
		}

		const separatorOpt = presetSelect.createEl("option", {
			text: "──────────",
			attr: { value: "__separator" },
		});
		separatorOpt.disabled = true;

		const customOpt = presetSelect.createEl("option", {
			text: "Custom…  —  Select specific provider & model",
			attr: { value: "__custom" },
		});
		if (currentPreset === null) {
			customOpt.selected = true;
		}

		const customSection = container.createDiv({ cls: "notor-settings-section notor-custom-model-section" });
		if (currentPreset !== null) {
			customSection.addClass("notor-hidden");
		}

		this.buildCustomModelSection(customSection);

		presetSelect.addEventListener("change", () => {
			const value = presetSelect.value;
			if (value === "__separator") return;

			this.deps.setDisplayedPresetName(undefined);
			this.deps.setDisplayedProviderId(null);
			this.deps.setDisplayedModelValue(null);

			if (value === "__custom") {
				customSection.removeClass("notor-hidden");
				this.deps.onPresetChange?.(null);
			} else {
				customSection.addClass("notor-hidden");
				this.deps.onPresetChange?.(value);
			}
			this.refreshThinkingSection();
		});
	}

	private buildCustomModelSection(container: HTMLElement): void {
		const providerLabel = container.createDiv({ cls: "notor-settings-label", text: "Provider" });
		void providerLabel;

		const providerSelect = container.createEl("select", { cls: "notor-settings-select" });
		const providers = this.deps.getAvailableProviders?.() ?? [];
		const currentProvider = this.deps.getDisplayedProviderId() ?? this.deps.getCurrentProvider?.() ?? "";

		for (const p of providers) {
			const opt = providerSelect.createEl("option", {
				text: p.displayName,
				attr: { value: p.id },
			});
			if (p.id === currentProvider) {
				opt.selected = true;
			}
		}

		providerSelect.addEventListener("change", () => {
			this.deps.setDisplayedProviderId(null);
			this.deps.setDisplayedModelValue(null);
			this.deps.onProviderChange?.(providerSelect.value);
			this.refreshModelSelect();
		});

		const modelWrapper = container.createDiv({ cls: "notor-settings-section" });
		const modelHeader = modelWrapper.createDiv({ cls: "notor-settings-label-row" });
		modelHeader.createDiv({ cls: "notor-settings-label", text: "Model" });

		const refreshBtn = modelHeader.createEl("button", {
			cls: "notor-settings-refresh-btn clickable-icon",
			attr: { "aria-label": "Refresh model list" },
		});
		refreshBtn.textContent = "↻";
		refreshBtn.addEventListener("click", () => {
			void (async () => {
				refreshBtn.disabled = true;
				refreshBtn.textContent = "…";
				try {
					await this.deps.onRefreshModels?.();
					this.refreshModelSelect();
				} catch {
					// Fall through to text input
				} finally {
					refreshBtn.disabled = false;
					refreshBtn.textContent = "↻";
				}
			})();
		});

		this.buildModelSelect(modelWrapper);
	}

	private buildModelSelect(container: HTMLElement): void {
		const existing = container.querySelector(".notor-model-select-wrapper");
		existing?.remove();

		const wrapper = container.createDiv({ cls: "notor-model-select-wrapper" });
		const models = this.deps.getAvailableModels?.() ?? [];
		const currentModel = this.deps.getDisplayedModelValue() ?? this.deps.getCurrentModel?.() ?? "";

		if (models.length > 0) {
			const modelSelect = wrapper.createEl("select", { cls: "notor-settings-select" });
			const groups = groupModels(models);

			if (groups.some((g) => g.variants.length > 1)) {
				this.renderGroupedModelOptions(modelSelect, groups, currentModel);
			} else {
				for (const m of models) {
					const opt = modelSelect.createEl("option", {
						text: m.display_name || m.id,
						attr: { value: m.id },
					});
					if (m.id === currentModel) {
						opt.selected = true;
					}
				}
			}

			modelSelect.addEventListener("change", () => {
				this.deps.setDisplayedModelValue(null);
				this.deps.onModelChange?.(modelSelect.value);
			});
		} else {
			const modelInput = wrapper.createEl("input", {
				cls: "notor-settings-input",
				attr: {
					type: "text",
					placeholder: "Enter model ID...",
					value: currentModel,
				},
			});

			modelInput.addEventListener("change", () => {
				this.deps.setDisplayedModelValue(null);
				this.deps.onModelChange?.(modelInput.value);
			});
		}
	}

	private renderGroupedModelOptions(
		select: HTMLSelectElement,
		groups: ModelGroup[],
		currentModel: string
	): void {
		for (const group of groups) {
			if (group.variants.length === 1) {
				const variant = group.variants[0]!;
				const opt = select.createEl("option", {
					text: group.label,
					attr: { value: variant.optionValue },
				});
				if (variant.optionValue === currentModel) {
					opt.selected = true;
				}
			} else {
				// Flat full-label options (no <optgroup>): a collapsed <select> never
				// renders the optgroup label, so the model name must live on each option.
				for (const variant of group.variants) {
					const opt = select.createEl("option", {
						text: formatFullVariantLabel(group, variant),
						attr: { value: variant.optionValue },
					});
					if (variant.optionValue === currentModel) {
						opt.selected = true;
					}
				}
			}
		}
	}

	private buildThinkingLevelSection(container: HTMLElement): void {
		const modelId = this.deps.getActiveModelId?.();
		if (!modelId || !supportsThinking(modelId)) return;

		const section = container.createDiv({ cls: "notor-settings-section notor-thinking-section" });
		section.createDiv({ cls: "notor-settings-label", text: "Thinking" });

		const select = section.createEl("select", { cls: "notor-settings-select" });
		const options: [string, string][] = [
			["", "Off"],
			["low", "Low"],
			["medium", "Medium"],
			["high", "High"],
		];

		const currentLevel = this.deps.getActiveThinkingLevel?.() ?? null;

		for (const [value, label] of options) {
			const opt = select.createEl("option", { text: label, attr: { value } });
			if (value === "" && (currentLevel === null || !["low", "medium", "high"].includes(currentLevel))) {
				opt.selected = true;
			} else if (value === currentLevel) {
				opt.selected = true;
			}
		}

		select.addEventListener("change", () => {
			const value = select.value;
			this.deps.onThinkingLevelChange?.(value === "" ? null : value);
		});
	}

	private buildCheckpointsSection(container: HTMLElement): void {
		const section = container.createDiv({ cls: "notor-settings-section notor-checkpoints-section" });
		const header = section.createDiv({ cls: "notor-settings-label-row" });
		header.createDiv({ cls: "notor-settings-label", text: "Checkpoints" });

		const refreshBtn = header.createEl("button", {
			cls: "notor-settings-refresh-btn clickable-icon",
			attr: { "aria-label": "Refresh checkpoint list" },
		});
		refreshBtn.textContent = "↻";

		const listEl = section.createDiv({ cls: "notor-checkpoint-list" });
		listEl.textContent = "Loading…";

		const loadCheckpoints = async () => {
			listEl.empty();
			listEl.textContent = "Loading…";
			try {
				const checkpoints = (await this.deps.onListCheckpoints?.()) ?? [];
				listEl.empty();
				if (checkpoints.length === 0) {
					listEl.createDiv({
						cls: "notor-checkpoint-empty",
						text: "No checkpoints yet",
					});
					return;
				}
				for (const cp of checkpoints) {
					this.renderCheckpointItem(listEl, cp);
				}
			} catch {
				listEl.empty();
				listEl.createDiv({ cls: "notor-checkpoint-empty", text: "Failed to load checkpoints" });
			}
		};

		refreshBtn.addEventListener("click", () => void loadCheckpoints());
		void loadCheckpoints();
	}

	private renderCheckpointItem(container: HTMLElement, cp: Checkpoint): void {
		const item = container.createDiv({ cls: "notor-checkpoint-item" });

		const meta = item.createDiv({ cls: "notor-checkpoint-meta" });
		const date = new Date(cp.timestamp);
		meta.createSpan({ cls: "notor-checkpoint-time", text: formatRelativeTime(date) });
		meta.createSpan({ cls: "notor-checkpoint-desc", text: cp.description });

		const actions = item.createDiv({ cls: "notor-checkpoint-actions" });

		const previewBtn = actions.createEl("button", {
			cls: "notor-checkpoint-btn notor-checkpoint-preview-btn",
			text: "Preview",
			attr: { "aria-label": "Preview checkpoint" },
		});
		previewBtn.addEventListener("click", () => {
			this.showCheckpointPreviewModal(cp);
		});

		const compareBtn = actions.createEl("button", {
			cls: "notor-checkpoint-btn",
			text: "Compare",
			attr: { "aria-label": "Compare checkpoint with current note" },
		});
		compareBtn.addEventListener("click", () => {
			void (async () => {
				try {
					const current = await this.deps.onGetCurrentContent?.(cp.note_path);
					if (current == null) {
						new Notice(`Note not found: ${cp.note_path}`);
						return;
					}
					this.showCheckpointDiffModal(cp, current);
				} catch (err) {
					log.error("Failed to compare checkpoint", { err });
					new Notice("Failed to compare checkpoint");
				}
			})();
		});

		const restoreBtn = actions.createEl("button", {
			cls: "notor-checkpoint-btn notor-checkpoint-restore-btn",
			text: "Restore",
			attr: { "aria-label": "Restore note to this checkpoint" },
		});
		restoreBtn.addEventListener("click", () => {
			void (async () => {
				restoreBtn.disabled = true;
				restoreBtn.textContent = "Restoring…";
				try {
					const ok = await this.deps.onRestoreCheckpoint?.(cp.id);
					if (ok) {
						new Notice(`Restored ${cp.note_path} to checkpoint from ${formatRelativeTime(new Date(cp.timestamp))}`);
					} else {
						new Notice(`Failed to restore checkpoint`);
					}
				} catch {
					new Notice(`Failed to restore checkpoint`);
				} finally {
					restoreBtn.disabled = false;
					restoreBtn.textContent = "Restore";
				}
			})();
		});
	}

	private showCheckpointPreviewModal(cp: Checkpoint): void {
		const modal = new CheckpointModal(
			this.deps.app,
			`Checkpoint: ${cp.description}`,
			cp.content,
			null
		);
		modal.open();
	}

	private showCheckpointDiffModal(cp: Checkpoint, current: string): void {
		const modal = new CheckpointModal(
			this.deps.app,
			`Compare: ${cp.description}`,
			cp.content,
			current
		);
		modal.open();
	}
}

// ---------------------------------------------------------------------------
// Checkpoint preview / diff modal
// ---------------------------------------------------------------------------

class CheckpointModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly checkpointContent: string,
		private readonly currentContent: string | null
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("notor-checkpoint-modal");

		contentEl.createEl("h2", { text: this.title });

		if (this.currentContent === null) {
			this.renderContentBlock(contentEl, "Checkpoint content", this.checkpointContent);
		} else {
			this.renderDiff(contentEl, this.checkpointContent, this.currentContent);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderContentBlock(container: HTMLElement, label: string, content: string): void {
		container.createEl("p", { cls: "notor-checkpoint-modal-label", text: label });
		const pre = container.createEl("pre", { cls: "notor-checkpoint-modal-content" });
		pre.createEl("code", { text: content });
	}

	private renderDiff(
		container: HTMLElement,
		checkpointContent: string,
		currentContent: string
	): void {
		container.createEl("p", {
			cls: "notor-checkpoint-modal-label",
			text: "− checkpoint  /  + current",
		});

		const diffEl = container.createEl("pre", { cls: "notor-checkpoint-modal-diff" });

		const checkpointLines = checkpointContent.split("\n");
		const currentLines = currentContent.split("\n");

		const diff = this.computeDiff(checkpointLines, currentLines);

		for (const entry of diff) {
			const lineEl = diffEl.createEl("div", { cls: `notor-diff-line notor-diff-${entry.type}` });
			const prefix = entry.type === "removed" ? "- " : entry.type === "added" ? "+ " : "  ";
			lineEl.textContent = prefix + entry.text;
		}
	}

	private computeDiff(
		a: string[],
		b: string[]
	): Array<{ type: "unchanged" | "removed" | "added"; text: string }> {
		const m = a.length;
		const n = b.length;
		const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

		for (let i = 1; i <= m; i++) {
			for (let j = 1; j <= n; j++) {
				if (a[i - 1] === b[j - 1]) {
					lcs[i]![j] = lcs[i - 1]![j - 1]! + 1;
				} else {
					lcs[i]![j] = Math.max(lcs[i - 1]![j]!, lcs[i]![j - 1]!);
				}
			}
		}

		let i = m;
		let j = n;
		const entries: Array<{ type: "unchanged" | "removed" | "added"; text: string }> = [];

		while (i > 0 || j > 0) {
			if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
				entries.push({ type: "unchanged", text: a[i - 1]! });
				i--;
				j--;
			} else if (j > 0 && (i === 0 || lcs[i]![j - 1]! >= lcs[i - 1]![j]!)) {
				entries.push({ type: "added", text: b[j - 1]! });
				j--;
			} else {
				entries.push({ type: "removed", text: a[i - 1]! });
				i--;
			}
		}

		entries.reverse();
		return entries;
	}
}
