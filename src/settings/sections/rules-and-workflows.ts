/**
 * Rules and workflows settings section renderer.
 *
 * Provides "Create new rule" and "Create new workflow" buttons along
 * with listings of existing rules and workflows, each with an "Open"
 * action. Follows the same pattern as the Personas section.
 */

import { Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type { SettingsContext } from "./context";
import { discoverWorkflows } from "../../workflows/workflow-discovery";
import { promptForName, ensureDirectory } from "./shared";
import { logger } from "../../utils/logger";

const log = logger("RulesAndWorkflowsSection");

const RULE_SKELETON_CONTENT = `---
notor-always-include: true
# notor-directory-include: path/to/directory
# notor-tag-include: my-tag
---

<!-- Your rule instructions here. The AI will follow these when the trigger conditions are met. -->
`;

const WORKFLOW_SKELETON_CONTENT = `---
notor-workflow: true
notor-trigger: manual
# notor-trigger options: manual, on-note-open, on-note-create, on-save, on-manual-save, on-tag-change, scheduled
# notor-schedule: "0 9 * * *"
# notor-workflow-persona: researcher
---

<!-- Workflow instructions here. This is the prompt sent to the AI when the workflow runs. -->
`;

/** Render the "Rules and workflows" settings section. */
export function renderRulesAndWorkflowsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	// ── Rules subsection ────────────────────────────────────────────────
	renderRulesSubsection(containerEl, ctx);

	// ── Workflows subsection ────────────────────────────────────────────
	renderWorkflowsSubsection(containerEl, ctx);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function renderRulesSubsection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	// Wrap in a scoped div so the inline name prompt appears within this subsection
	const section = containerEl.createDiv({ cls: "notor-rules-subsection" });

	new Setting(section).setHeading().setName("Rules");
	section.createEl("p", {
		text:
			"Rules inject instructions into the system prompt based on trigger conditions " +
			"(always, directory, or tag). Each rule is a Markdown file in the notor rules folder.",
		cls: "setting-item-description",
	});

	// "Create new rule" button
	new Setting(section)
		.setName("Create new rule")
		.setDesc(
			"Creates a skeleton rule file with always-include enabled."
		)
		.addButton((btn) =>
			btn.setButtonText("Create").onClick(async () => {
				const name = await promptForName(
					section,
					"Rule name (e.g. coding-style)"
				);
				if (!name) return;

				const rulesDir = normalizePath(
					`${ctx.settings.notor_dir}/rules`
				);
				const filePath = normalizePath(`${rulesDir}/${name}.md`);

				if (ctx.app.vault.getAbstractFileByPath(filePath)) {
					new Notice(`Rule "${name}" already exists.`);
					return;
				}

				try {
					await ensureDirectory(ctx, rulesDir);
					await ctx.app.vault.create(filePath, RULE_SKELETON_CONTENT);
					new Notice(`Rule "${name}" created.`);
					ctx.redisplay();
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Failed to create rule", { name, error: msg });
					new Notice(`Failed to create rule: ${msg}`);
				}
			})
		);

	// List existing rules
	const listContainer = section.createDiv({ cls: "notor-rules-list" });

	const rulesDir = normalizePath(`${ctx.settings.notor_dir}/rules`);
	const rulesDirFile = ctx.app.vault.getAbstractFileByPath(rulesDir);

	if (!rulesDirFile || !(rulesDirFile instanceof TFolder)) {
		listContainer.createEl("p", {
			text: "No rules found.",
			cls: "setting-item-description",
		});
		return;
	}

	const mdFiles = rulesDirFile.children
		.filter((f): f is TFile => f instanceof TFile && f.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name));

	if (mdFiles.length === 0) {
		listContainer.createEl("p", {
			text: "No rules found.",
			cls: "setting-item-description",
		});
		return;
	}

	for (const file of mdFiles) {
		const displayName = file.name.replace(/\.md$/, "");
		new Setting(listContainer)
			.setName(displayName)
			.addButton((btn) =>
				btn.setButtonText("Open").onClick(() => {
					void ctx.app.workspace.openLinkText(file.path, "");
				})
			);
	}
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

function renderWorkflowsSubsection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	// Wrap in a scoped div so the inline name prompt appears within this subsection
	const section = containerEl.createDiv({ cls: "notor-workflows-subsection" });

	new Setting(section).setHeading().setName("Workflows");
	section.createEl("p", {
		text:
			"Workflows are AI-driven automations triggered by events or manual commands. " +
			"Each workflow is a Markdown file in the notor workflows folder.",
		cls: "setting-item-description",
	});

	// "Create new workflow" button
	new Setting(section)
		.setName("Create new workflow")
		.setDesc(
			"Creates a skeleton workflow file with manual trigger."
		)
		.addButton((btn) =>
			btn.setButtonText("Create").onClick(async () => {
				const name = await promptForName(
					section,
					"Workflow name (e.g. daily-review)"
				);
				if (!name) return;

				const workflowsDir = normalizePath(
					`${ctx.settings.notor_dir}/workflows`
				);
				const filePath = normalizePath(`${workflowsDir}/${name}.md`);

				if (ctx.app.vault.getAbstractFileByPath(filePath)) {
					new Notice(`Workflow "${name}" already exists.`);
					return;
				}

				try {
					await ensureDirectory(ctx, workflowsDir);
					await ctx.app.vault.create(
						filePath,
						WORKFLOW_SKELETON_CONTENT
					);
					new Notice(`Workflow "${name}" created.`);
					ctx.redisplay();
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Failed to create workflow", {
						name,
						error: msg,
					});
					new Notice(`Failed to create workflow: ${msg}`);
				}
			})
		);

	// List existing workflows
	const listContainer = section.createDiv({
		cls: "notor-workflows-list",
	});

	const workflows = discoverWorkflows(
		ctx.app.vault,
		ctx.app.metadataCache,
		ctx.settings.notor_dir
	);

	if (workflows.length === 0) {
		listContainer.createEl("p", {
			text: "No workflows found.",
			cls: "setting-item-description",
		});
		return;
	}

	for (const workflow of workflows) {
		new Setting(listContainer)
			.setName(workflow.display_name)
			.setDesc(`Trigger: ${workflow.trigger}`)
			.addButton((btn) =>
				btn.setButtonText("Open").onClick(() => {
					void ctx.app.workspace.openLinkText(
						workflow.file_path,
						""
					);
				})
			);
	}
}
