/**
 * Unified automations settings section renderer.
 *
 * Displays all automations and workflows in a single grouped view,
 * organized by trigger type. Each row has an Enabled toggle, an
 * open-file icon, and (for extension automations with settings) a
 * gear icon.
 *
 * Built-in scaffolds are marked with a subtle badge. Scheduled items
 * show a status dot and next-run time.
 */

import { Notice, Setting, normalizePath } from "obsidian";
import type { SettingsContext } from "./context";
import { markSubsection } from "../helpers";
import { BUILTIN_AUTOMATION_SCAFFOLDS } from "../../extensions/builtin-automation-scaffolds";
import type { BuiltinAutomationScaffold } from "../../extensions/builtin-automation-scaffolds";
import { AutomationSettingsModal } from "../../ui/automation-settings-modal";
import type { UserAutomationDefinition } from "../../extensions/types";
import type { Workflow } from "../../types";
import { discoverWorkflows } from "../../workflows/workflow-discovery";
import type { VaultEventScheduler } from "../../hooks/vault-event-scheduler";
import { logger } from "../../utils/logger";

const log = logger("UserAutomationsSection");

// ---------------------------------------------------------------------------
// Trigger group ordering and display names
// ---------------------------------------------------------------------------

type TriggerGroup = {
	key: string;
	label: string;
};

const TRIGGER_GROUP_ORDER: TriggerGroup[] = [
	{ key: "on-schedule", label: "Scheduled" },
	{ key: "on-note-open", label: "On note open" },
	{ key: "on-note-create", label: "On note create" },
	{ key: "on-save", label: "On save" },
	{ key: "on-manual-save", label: "On manual save" },
	{ key: "on-tag-change", label: "On tag change" },
	{ key: "manual", label: "Manual" },
	{ key: "pre_send", label: "Pre-send" },
	{ key: "on_tool_call", label: "On tool call" },
	{ key: "on_tool_result", label: "On tool result" },
	{ key: "after_completion", label: "After completion" },
	{ key: "on_conversation_start", label: "On conversation start" },
];

/**
 * Normalize trigger values to a canonical group key.
 * Workflows use hyphenated names (on-schedule), automations use underscored (on_schedule).
 */
function normalizeTriggerKey(trigger: string): string {
	const mapping: Record<string, string> = {
		"on_schedule": "on-schedule",
		"on_note_open": "on-note-open",
		"on_note_create": "on-note-create",
		"on_save": "on-save",
		"on_manual_save": "on-manual-save",
		"on_tag_change": "on-tag-change",
	};
	return mapping[trigger] ?? trigger;
}

// ---------------------------------------------------------------------------
// Unified item type
// ---------------------------------------------------------------------------

type AutomationItem = {
	kind: "workflow";
	workflow: Workflow;
	name: string;
	triggerKey: string;
	isBuiltin: false;
} | {
	kind: "automation";
	automation: UserAutomationDefinition;
	name: string;
	triggerKey: string;
	isBuiltin: boolean;
	scaffold?: BuiltinAutomationScaffold;
};

// ---------------------------------------------------------------------------
// Column headers
// ---------------------------------------------------------------------------

function renderColumnHeaders(containerEl: HTMLElement): void {
	const headerEl = containerEl.createDiv({ cls: "notor-automation-column-headers" });
	headerEl.createSpan({ cls: "notor-tool-column-spacer" });
	headerEl.createSpan({ cls: "notor-tool-column-label", text: "Enabled" });
	headerEl.createSpan({ cls: "notor-tool-column-icon-spacer" });
}

// ---------------------------------------------------------------------------
// Item collection
// ---------------------------------------------------------------------------

function collectAllItems(ctx: SettingsContext): AutomationItem[] {
	const items: AutomationItem[] = [];

	// 1. Discovered workflows (all triggers)
	const workflows = discoverWorkflows(
		ctx.app.vault,
		ctx.app.metadataCache,
		ctx.settings.notor_dir
	);
	for (const workflow of workflows) {
		items.push({
			kind: "workflow",
			workflow,
			name: workflow.display_name,
			triggerKey: normalizeTriggerKey(workflow.trigger),
			isBuiltin: false,
		});
	}

	// 2. Extension automations (built-in scaffolds + user-defined)
	const manager = ctx.plugin.getExtensionManager();
	const automations = manager.getAutomations();
	const builtinNames = manager.getBuiltinAutomationNames();

	// Track which scaffolds have vault-file overrides
	const overriddenScaffolds = new Set<string>();

	for (const automation of automations) {
		if (automation.isScaffold) continue;
		const filename = automation.filePath.split("/").pop()?.replace(/\.md$/, "") ?? "";
		const isBuiltinOverride = builtinNames.has(filename);
		if (isBuiltinOverride) overriddenScaffolds.add(filename);

		const scaffold = isBuiltinOverride
			? BUILTIN_AUTOMATION_SCAFFOLDS.get(filename)
			: undefined;

		items.push({
			kind: "automation",
			automation,
			name: scaffold?.displayName ?? automation.displayName ?? filename,
			triggerKey: normalizeTriggerKey(automation.trigger),
			isBuiltin: isBuiltinOverride,
			scaffold,
		});
	}

	// 3. Built-in scaffolds without vault overrides (show as built-in entries)
	for (const [name, scaffold] of BUILTIN_AUTOMATION_SCAFFOLDS) {
		if (overriddenScaffolds.has(name)) continue;

		// Create a synthetic entry for the scaffold
		items.push({
			kind: "automation",
			automation: {
				filePath: normalizePath(`${ctx.settings.notor_dir}/automations/${name}.md`),
				displayName: scaffold.displayName,
				trigger: scaffold.trigger,
				schedule: scaffold.schedule ?? null,
				toolFilter: null,
				order: 0,
				settingsSchema: scaffold.settingsSchema ?? null,
				rawCode: "",
				compiledFn: null,
				isScaffold: true,
			},
			name: scaffold.displayName,
			triggerKey: normalizeTriggerKey(scaffold.trigger),
			isBuiltin: true,
			scaffold,
		});
	}

	return items;
}

// ---------------------------------------------------------------------------
// Row renderers
// ---------------------------------------------------------------------------

function renderWorkflowRow(
	containerEl: HTMLElement,
	item: AutomationItem & { kind: "workflow" },
	scheduler: VaultEventScheduler | undefined,
	ctx: SettingsContext,
): void {
	const workflow = item.workflow;
	const isEnabled = ctx.settings.workflow_enabled[workflow.file_path] !== false;

	// Build description
	let desc = `Trigger: ${workflow.trigger}`;
	if (workflow.trigger === "on-schedule" && workflow.schedule) {
		const nextRun = scheduler?.getNextRun(workflow.schedule) ?? null;
		desc = `Schedule: ${workflow.schedule}`;
		if (nextRun) {
			desc += ` · Next: ${nextRun.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
		}
	}

	const setting = new Setting(containerEl)
		.setName(item.name)
		.setDesc(desc);

	// Status dot for scheduled workflows
	if (workflow.trigger === "on-schedule" && workflow.schedule) {
		const jobKey = `workflow:${workflow.file_path}`;
		const isActive = scheduler?.isJobActive(jobKey) ?? false;
		const dot = setting.nameEl.createSpan({
			cls: `notor-schedule-status-dot ${isActive ? "notor-schedule-active" : "notor-schedule-inactive"}`,
		});
		dot.setAttribute("aria-label", isActive ? "Active" : "Inactive");
		setting.nameEl.prepend(dot);
	}

	// Enabled toggle
	setting.addToggle((toggle) =>
		toggle
			.setValue(isEnabled)
			.setTooltip("Enabled")
			.onChange(async (value) => {
				ctx.settings.workflow_enabled[workflow.file_path] = value;
				await ctx.saveSettings();
				ctx.redisplay();
			}),
	);

	if (!isEnabled) {
		setting.settingEl.addClass("notor-tool-row-disabled");
	}

	// Open-file icon
	setting.addExtraButton((btn) =>
		btn
			.setIcon("square-arrow-out-up-right")
			.setTooltip("Open workflow definition")
			.onClick(async () => {
				await ctx.app.workspace.openLinkText(workflow.file_path, "", true);
			}),
	);

	// Invisible gear placeholder for column alignment
	setting.addExtraButton((btn) => {
		btn.extraSettingsEl.addClass("notor-tool-icon-placeholder");
	});
}

function renderAutomationRow(
	containerEl: HTMLElement,
	item: AutomationItem & { kind: "automation" },
	scheduler: VaultEventScheduler | undefined,
	ctx: SettingsContext,
): void {
	const automation = item.automation;
	const filename = automation.filePath.split("/").pop()?.replace(/\.md$/, "") ?? "";
	const extKey = filename;
	const defaultEnabled = filename === "title-generation" ? false : true;
	const isEnabled = ctx.settings.automation_enabled[extKey] ?? defaultEnabled;

	// Build description
	let desc = `Trigger: ${automation.trigger}`;
	if (automation.trigger === "on_schedule" && automation.schedule) {
		const nextRun = scheduler?.getNextRun(automation.schedule) ?? null;
		desc = `Schedule: ${automation.schedule}`;
		if (nextRun) {
			desc += ` · Next: ${nextRun.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
		}
	}

	const setting = new Setting(containerEl)
		.setName(item.name)
		.setDesc(desc);

	// Built-in badge
	if (item.isBuiltin) {
		setting.nameEl.createSpan({
			cls: "notor-automation-builtin-badge",
			text: "built-in",
		});
	}

	// Status dot for scheduled automations
	if (automation.trigger === "on_schedule" && automation.schedule) {
		const jobKey = `ext-auto:${automation.filePath}`;
		const isActive = scheduler?.isJobActive(jobKey) ?? false;
		const dot = setting.nameEl.createSpan({
			cls: `notor-schedule-status-dot ${isActive ? "notor-schedule-active" : "notor-schedule-inactive"}`,
		});
		dot.setAttribute("aria-label", isActive ? "Active" : "Inactive");
		setting.nameEl.prepend(dot);
	}

	// Enabled toggle
	setting.addToggle((toggle) =>
		toggle
			.setValue(isEnabled)
			.setTooltip("Enabled")
			.onChange(async (value) => {
				ctx.settings.automation_enabled[extKey] = value;
				await ctx.saveSettings();
				ctx.redisplay();
			}),
	);

	if (!isEnabled) {
		setting.settingEl.addClass("notor-tool-row-disabled");
	}

	// Open-file icon
	const manager = ctx.plugin.getExtensionManager();
	const vaultFileExists = ctx.app.vault.getAbstractFileByPath(automation.filePath) !== null;

	setting.addExtraButton((btn) =>
		btn
			.setIcon("square-arrow-out-up-right")
			.setTooltip("Open automation definition")
			.onClick(async () => {
				if (vaultFileExists) {
					await ctx.app.workspace.openLinkText(automation.filePath, "", true);
				} else if (item.isBuiltin) {
					try {
						const path = await manager.ensureBuiltinAutomationVaultFile(filename);
						await ctx.app.workspace.openLinkText(path, "", true);
						new Notice(`Created ${path} — reload extensions to activate.`);
						ctx.redisplay();
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						log.error("Failed to open automation file", { error: msg });
						new Notice(`Failed to open automation: ${msg}`);
					}
				}
			}),
	);

	// Gear icon (if has settings schema)
	const hasSettings = (automation.settingsSchema?.length ?? 0) > 0
		|| (item.scaffold?.settingsSchema?.length ?? 0) > 0;

	if (hasSettings || vaultFileExists) {
		setting.addExtraButton((btn) =>
			btn
				.setIcon("settings")
				.setTooltip("Configure automation settings")
				.onClick(() => {
					new AutomationSettingsModal(ctx, extKey, ctx.scrollToGroup).open();
				}),
		);
	} else {
		// Invisible placeholder for column alignment
		setting.addExtraButton((btn) => {
			btn.extraSettingsEl.addClass("notor-tool-icon-placeholder");
		});
	}
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Render the complete automations settings section. */
export function renderUserAutomationsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	new Setting(containerEl).setHeading().setName("Automations");
	containerEl.createEl("p", {
		text:
			"All configured automations and workflows grouped by trigger type. " +
			"Disabling an item prevents it from running when its trigger fires.",
		cls: "setting-item-description",
	});

	const items = collectAllItems(ctx);
	const scheduler = ctx.plugin.getVaultEventScheduler();

	// Group items by trigger
	const groups = new Map<string, AutomationItem[]>();
	for (const item of items) {
		const existing = groups.get(item.triggerKey) ?? [];
		existing.push(item);
		groups.set(item.triggerKey, existing);
	}

	// Render groups in defined order
	for (const group of TRIGGER_GROUP_ORDER) {
		const groupItems = groups.get(group.key);
		if (!groupItems || groupItems.length === 0) continue;

		const heading = new Setting(containerEl).setHeading().setName(group.label);
		markSubsection(heading, group.label);
		renderColumnHeaders(containerEl);

		// Sort: built-in first, then alphabetically by name
		groupItems.sort((a, b) => {
			if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		for (const item of groupItems) {
			if (item.kind === "workflow") {
				renderWorkflowRow(containerEl, item, scheduler, ctx);
			} else {
				renderAutomationRow(containerEl, item, scheduler, ctx);
			}
		}
	}

	// Catch any items with unrecognized trigger groups (shouldn't happen, but just in case)
	const knownKeys = new Set(TRIGGER_GROUP_ORDER.map((g) => g.key));
	for (const [key, groupItems] of groups) {
		if (knownKeys.has(key)) continue;
		if (groupItems.length === 0) continue;

		const heading = new Setting(containerEl).setHeading().setName(key);
		markSubsection(heading, key);
		renderColumnHeaders(containerEl);

		for (const item of groupItems) {
			if (item.kind === "workflow") {
				renderWorkflowRow(containerEl, item, scheduler, ctx);
			} else {
				renderAutomationRow(containerEl, item, scheduler, ctx);
			}
		}
	}
}
