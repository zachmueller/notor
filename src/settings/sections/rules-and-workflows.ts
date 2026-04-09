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
import type { CreationField } from "./shared";
import { promptForCreation, ensureDirectory } from "./shared";
import { markSubsection } from "../helpers";
import { logger } from "../../utils/logger";

const log = logger("RulesAndWorkflowsSection");

// ---------------------------------------------------------------------------
// Rule skeleton builder
// ---------------------------------------------------------------------------

const RULE_TRIGGER_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: "always-include", label: "Always include" },
	{ value: "directory", label: "Directory (path-based)" },
	{ value: "tag", label: "Tag (tag-based)" },
];

function buildRuleSkeleton(trigger: string, triggerValue: string): string {
	const lines: string[] = ["---"];
	if (trigger === "always-include") {
		lines.push("notor-always-include: true");
		lines.push("# notor-directory-include: path/to/directory");
		lines.push("# notor-tag-include: my-tag");
	} else if (trigger === "directory") {
		lines.push("# notor-always-include: true");
		lines.push(`notor-directory-include: ${triggerValue || "path/to/directory"}`);
		lines.push("# notor-tag-include: my-tag");
	} else if (trigger === "tag") {
		lines.push("# notor-always-include: true");
		lines.push("# notor-directory-include: path/to/directory");
		lines.push(`notor-tag-include: ${triggerValue || "my-tag"}`);
	}
	lines.push("---");
	lines.push("");
	lines.push("<!-- Your rule instructions here. The AI will follow these when the trigger conditions are met. -->");
	lines.push("");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Workflow skeleton builder
// ---------------------------------------------------------------------------

const WORKFLOW_TRIGGER_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: "manual", label: "Manual" },
	{ value: "on-note-open", label: "On note open" },
	{ value: "on-note-create", label: "On note create" },
	{ value: "on-save", label: "On save (auto or manual)" },
	{ value: "on-manual-save", label: "On manual save (Cmd/Ctrl+S)" },
	{ value: "on-tag-change", label: "On tag change" },
	{ value: "scheduled", label: "Scheduled (cron)" },
];

function buildWorkflowSkeleton(trigger: string, schedule: string): string {
	const lines: string[] = ["---"];
	lines.push("notor-workflow: true");
	lines.push(`notor-trigger: ${trigger}`);
	if (trigger === "scheduled") {
		lines.push(`notor-schedule: "${schedule || "0 9 * * *"}"`);
	} else {
		lines.push('# notor-schedule: "0 9 * * *"');
	}
	lines.push("# notor-workflow-persona: researcher");
	lines.push("---");
	lines.push("");
	lines.push("<!-- Workflow instructions here. This is the prompt sent to the AI when the workflow runs. -->");
	lines.push("");
	return lines.join("\n");
}

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

	const rulesHeading = new Setting(section).setHeading().setName("Rules");
	markSubsection(rulesHeading, "Rules");
	section.createEl("p", {
		text:
			"Rules inject instructions into the system prompt based on trigger conditions " +
			"(always, directory, or tag). Each rule is a Markdown file in the notor rules folder.",
		cls: "setting-item-description",
	});

	// "Create new rule" button
	const ruleFields: CreationField[] = [
		{ type: "text", key: "name", placeholder: "Rule name (e.g. coding-style)" },
		{ type: "select", key: "trigger", options: RULE_TRIGGER_OPTIONS },
		{ type: "text", key: "directory_value", placeholder: "path/to/directory", showWhen: { key: "trigger", value: "directory" } },
		{ type: "text", key: "tag_value", placeholder: "tag-name", showWhen: { key: "trigger", value: "tag" } },
	];

	new Setting(section)
		.setName("Create new rule")
		.setDesc(
			"Creates a skeleton rule file with your chosen trigger type."
		)
		.addButton((btn) =>
			btn.setButtonText("Create").onClick(async () => {
				const result = await promptForCreation(section, ruleFields);
				if (!result) return;

				const rulesDir = normalizePath(
					`${ctx.settings.notor_dir}/rules`
				);
				const filePath = normalizePath(`${rulesDir}/${result["name"]}.md`);

				if (ctx.app.vault.getAbstractFileByPath(filePath)) {
					new Notice(`Rule "${result["name"]}" already exists.`);
					return;
				}

				const trigger = result["trigger"] || "always-include";
				const triggerValue = trigger === "directory"
					? result["directory_value"] || ""
					: trigger === "tag"
						? result["tag_value"] || ""
						: "";

				try {
					await ensureDirectory(ctx, rulesDir);
					await ctx.app.vault.create(
						filePath,
						buildRuleSkeleton(trigger, triggerValue)
					);
					new Notice(`Rule "${result["name"]}" created.`);
					ctx.redisplay();
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Failed to create rule", { name: result["name"], error: msg });
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

	const workflowsHeading = new Setting(section).setHeading().setName("Workflows");
	markSubsection(workflowsHeading, "Workflows");
	section.createEl("p", {
		text:
			"Workflows are AI-driven automations triggered by events or manual commands. " +
			"Each workflow is a Markdown file in the notor workflows folder.",
		cls: "setting-item-description",
	});

	// "Create new workflow" button
	const workflowFields: CreationField[] = [
		{ type: "text", key: "name", placeholder: "Workflow name (e.g. daily-review)" },
		{ type: "select", key: "trigger", options: WORKFLOW_TRIGGER_OPTIONS },
		{ type: "text", key: "schedule", placeholder: "Cron expression (e.g. 0 9 * * *)", showWhen: { key: "trigger", value: "scheduled" } },
	];

	new Setting(section)
		.setName("Create new workflow")
		.setDesc(
			"Creates a skeleton workflow file with your chosen trigger."
		)
		.addButton((btn) =>
			btn.setButtonText("Create").onClick(async () => {
				const result = await promptForCreation(section, workflowFields);
				if (!result) return;

				const workflowsDir = normalizePath(
					`${ctx.settings.notor_dir}/workflows`
				);
				const filePath = normalizePath(`${workflowsDir}/${result["name"]}.md`);

				if (ctx.app.vault.getAbstractFileByPath(filePath)) {
					new Notice(`Workflow "${result["name"]}" already exists.`);
					return;
				}

				const trigger = result["trigger"] || "manual";
				const schedule = result["schedule"] || "";

				try {
					await ensureDirectory(ctx, workflowsDir);
					await ctx.app.vault.create(
						filePath,
						buildWorkflowSkeleton(trigger, schedule)
					);
					new Notice(`Workflow "${result["name"]}" created.`);
					ctx.redisplay();
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Failed to create workflow", {
						name: result["name"],
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
