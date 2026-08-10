/**
 * "Path scoping" sub-section of the Tools settings group.
 *
 * One row per path prefix, with independent Read and Write dropdowns — the same
 * shape as the tool rows above, so the whole policy fits on one screen instead of
 * being spread across sixteen list editors. The rule model and the settings→config
 * bridge live in `../path-scoping`.
 */

import { Notice, Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { applyTruncationToElement, markSubsection } from "../helpers";
import {
	PATH_GROUP_PHRASES,
	PATH_GROUPS,
	PATH_RULE_STATES,
	detectRuleNamespace,
	restrictSummary,
	type PathRuleState,
	type PathScopeRule,
} from "../path-scoping";

/** Human-readable summary of which namespaces a path governs. */
function namespaceLabel(path: string): string {
	return detectRuleNamespace(path) === "filesystem" ? "filesystem" : "vault + filesystem";
}

/**
 * Render the "Path scoping" sub-section: heading, help text, the rule table, and
 * the add-rule row.
 */
export function renderPathScopingSection(containerEl: HTMLElement, ctx: SettingsContext): void {
	const heading = new Setting(containerEl).setHeading().setName("Path scoping");
	markSubsection(heading, "Path scoping");

	const intro = containerEl.createEl("p", { cls: "setting-item-description" });
	applyTruncationToElement(
		intro,
		"Per-path rules for what the AI may read and write. Relative paths apply to vault notes and to file tools resolving against the vault; absolute or ~ paths apply to the filesystem only. " +
			"Blocked and Allow only are hard boundaries — out-of-bounds calls fail, and a persona or workflow can narrow them further but never widen them. " +
			"Auto-approve and Always ask only decide whether a call waits for your approval, so use Blocked if you mean to forbid access. " +
			"Setting any path to Allow only restricts that whole direction to the listed paths. " +
			PATH_GROUPS.map(({ name, description }) => `${name}: ${description}`).join(" "),
	);

	const rules = ctx.settings.path_scope_rules;

	if (rules.length > 0) {
		renderColumnHeaders(containerEl);
		rules.forEach((rule, index) => renderRuleRow(containerEl, rule, index, ctx));
		renderRestrictHints(containerEl, rules);
	}

	renderAddRow(containerEl, ctx);
}

/** Column labels above the rule rows, aligned with each row's two dropdowns. */
function renderColumnHeaders(containerEl: HTMLElement): void {
	const headerEl = containerEl.createDiv({
		cls: "notor-tool-column-headers notor-path-rule-column-headers",
	});
	headerEl.createSpan({ cls: "notor-tool-column-spacer" });
	headerEl.createSpan({ cls: "notor-path-rule-column-label", text: "Read" });
	headerEl.createSpan({ cls: "notor-path-rule-column-label", text: "Write" });
	headerEl.createSpan({ cls: "notor-path-rule-remove-spacer" });
}

/** One rule: the path, its detected namespaces, read/write dropdowns, remove. */
function renderRuleRow(
	containerEl: HTMLElement,
	rule: PathScopeRule,
	index: number,
	ctx: SettingsContext,
): void {
	const setting = new Setting(containerEl)
		.setName(rule.path)
		.setDesc(namespaceLabel(rule.path));

	for (const access of ["read", "write"] as const) {
		setting.addDropdown((dd) => {
			for (const { state, label } of PATH_RULE_STATES) {
				dd.addOption(state, label);
			}
			dd.setValue(rule[access]);
			dd.selectEl.addClass("notor-path-rule-select");
			dd.selectEl.setAttribute(
				"aria-label",
				access === "read" ? "Read behavior" : "Write behavior",
			);
			dd.onChange(async (value) => {
				rule[access] = value as PathRuleState;
				await ctx.saveSettings();
				// Redisplay so the restrict-mode hints below reflect the new state.
				ctx.redisplay();
			});
		});
	}

	setting.addExtraButton((btn) =>
		btn
			.setIcon("x")
			.setTooltip("Remove rule")
			.onClick(async () => {
				ctx.settings.path_scope_rules.splice(index, 1);
				await ctx.saveSettings();
				ctx.redisplay();
			}),
	);
}

/**
 * Warn when a direction has been narrowed to a fixed set of paths.
 *
 * A single "Allow only" row blocks everything else in that direction, which is
 * easy to set without realizing — so name the consequence explicitly.
 */
function renderRestrictHints(containerEl: HTMLElement, rules: readonly PathScopeRule[]): void {
	const summary = restrictSummary(rules);
	for (const { group } of PATH_GROUPS) {
		const allowed = summary[group];
		if (!allowed) continue;
		const unique = [...new Set(allowed)];
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: `${PATH_GROUP_PHRASES[group]} restricted to: ${unique.join(", ")} — everything else is blocked.`,
		});
	}
}

/** The add-rule row: path input with live namespace feedback, plus Add. */
function renderAddRow(containerEl: HTMLElement, ctx: SettingsContext): void {
	let newPath = "";

	const addSetting = new Setting(containerEl)
		.setName("Add path rule")
		.setDesc("A folder or file prefix. Relative paths apply to the vault; ~ or absolute paths to the filesystem.");

	addSetting.addText((text) => {
		text.setPlaceholder("Path prefix, e.g. ai/ or ~/Downloads").onChange((value) => {
			newPath = value.trim();
			addSetting.setDesc(
				newPath === ""
					? "A folder or file prefix. Relative paths apply to the vault; ~ or absolute paths to the filesystem."
					: `Applies to: ${namespaceLabel(newPath)}.`,
			);
		});
		text.inputEl.addClass("notor-input-w-160");
	});

	addSetting.addButton((btn) =>
		btn.setButtonText("Add").onClick(async () => {
			if (newPath === "") {
				new Notice("Enter a path prefix.");
				return;
			}
			if (ctx.settings.path_scope_rules.some((rule) => rule.path === newPath)) {
				new Notice("A rule for this path already exists.");
				return;
			}
			ctx.settings.path_scope_rules.push({
				path: newPath,
				read: "default",
				write: "default",
			});
			await ctx.saveSettings();
			ctx.redisplay();
		}),
	);
}
