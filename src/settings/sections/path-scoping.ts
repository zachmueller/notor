/**
 * "Path scoping" sub-section of the Tools settings group.
 *
 * Renders the sixteen global path lists (4 groups × 4 lists) grouped by tier, so
 * the two severity levels stay visually distinct: the Access lists **block**
 * calls, while the Approval lists only decide whether you see a prompt.
 *
 * Definitions and the settings→config bridge live in `../path-scoping`.
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { renderField } from "./field-renderer";
import { createToolSubgroup, markSubsection } from "../helpers";
import {
	PATH_GROUPS,
	PATH_SCOPE_LISTS,
	PATH_SCOPE_TIER,
	pathScopeField,
} from "../path-scoping";

/**
 * Render the "Path scoping" sub-section: heading, help text, and one
 * collapsible sub-group per `namespace × access` group.
 */
export function renderPathScopingSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const heading = new Setting(containerEl).setHeading().setName("Path scoping");
	markSubsection(heading, "Path scoping");

	new Setting(containerEl).setDesc(
		"Restrict which paths the AI may touch, grouped by whether a tool parameter reads or writes. " +
			"Access lists are a hard boundary: out-of-bounds calls are blocked, and a persona or workflow can narrow them further but never widen them. " +
			"Approval lists are convenience only — they decide whether a call waits for your approval, not whether it is allowed, so use Blocked paths if you mean to forbid access. " +
			"Leave a list empty for no restriction.",
	);

	const persisted = ctx.settings.settings_collapsed_sections;
	const onToggle = (key: string, open: boolean) => {
		ctx.settings.settings_collapsed_sections[key] = open;
		void ctx.saveSettings();
	};

	for (const { group, name, description } of PATH_GROUPS) {
		const { body } = createToolSubgroup(
			containerEl,
			name,
			`path-scope-${group}`,
			persisted,
			onToggle,
		);
		new Setting(body).setDesc(description);

		for (const tier of ["access", "approval"] as const) {
			const lists = PATH_SCOPE_LISTS.filter((list) => PATH_SCOPE_TIER[list] === tier);
			if (lists.length === 0) continue;

			new Setting(body)
				.setHeading()
				.setName(tier === "access" ? "Access (blocks calls)" : "Approval (prompts only)");

			for (const list of lists) {
				renderField(body, ctx, pathScopeField(group, list), { kind: "shared" });
			}
		}
	}
}
