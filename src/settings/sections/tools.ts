/**
 * Unified tools settings section.
 *
 * Renders both built-in tool and MCP tool controls in a single
 * "Tools" settings group. Each tool row shows an Enabled toggle
 * and an Auto-approve toggle. MCP tools also include a classification
 * dropdown and server-hint badge.
 *
 * Replaces the old separate "Built-in tools / Auto-approve" section
 * and the per-server tool controls that lived inside "MCP servers".
 */

import { Notice, Platform, Setting, TextComponent, normalizePath, setIcon, prepareSimpleSearch } from "obsidian";
import type { SearchMatchPart } from "obsidian";
import { TOOL_DISPLAY_NAMES, TOOLS_DEFAULT_DISABLED, defaultAutoApproveFor } from "../constants";
import type { SettingsContext } from "./context";
import type { McpServerConfig } from "../../mcp/mcp-types";
import type { McpHub } from "../../mcp/mcp-hub";
import type { McpConnectionStatus } from "../../mcp/mcp-types";
import type { UserToolDefinition } from "../../extensions/types";
import { ToolSettingsModal } from "../../ui/tool-settings-modal";
import type { CreationField } from "./shared";
import { promptForCreation, ensureDirectory } from "./shared";
import { markSubsection, applyDescriptionTruncation, createToolSubgroup } from "../helpers";
import { logger } from "../../utils/logger";

const log = logger("ToolsSection");

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

interface ToolFilterEntry {
	settingEl: HTMLElement;
	nameEl: HTMLElement;
	name: string;
	searchTexts: string[];
}

interface SectionGroup {
	elements: HTMLElement[];
	entries: ToolFilterEntry[];
}

interface ToolSubgroupOpts {
	persisted: Record<string, boolean>;
	onToggle: (key: string, open: boolean) => void;
	subgroupRefs: Array<{ details: HTMLDetailsElement; persistKey: string }>;
}

/** Persistent search query — survives ctx.redisplay() re-renders. */
let persistedToolSearchQuery = "";

/** Render `text` into `el`, wrapping the [start,end] match ranges in highlight spans. */
function renderNameHighlights(el: HTMLElement, text: string, matches: SearchMatchPart[]): void {
	el.empty();
	const sorted = [...matches].filter((m) => m[0] < m[1]).sort((a, b) => a[0] - b[0]);
	let cursor = 0;
	for (const [start, end] of sorted) {
		if (start < cursor) continue; // skip overlaps
		if (start > cursor) el.appendText(text.slice(cursor, start));
		el.createSpan({ cls: "notor-tool-search-highlight", text: text.slice(start, end) });
		cursor = end;
	}
	if (cursor < text.length) el.appendText(text.slice(cursor));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the McpHub instance from the plugin (cast through unknown). */
function getMcpHub(ctx: SettingsContext): McpHub | undefined {
	return (ctx.plugin as unknown as { _mcpHub?: McpHub })._mcpHub;
}

/**
 * Generate a `<notor_tool_config>` YAML snippet listing all built-in and
 * MCP tools with their current enabled and auto-approve settings.
 */
export function generateToolConfigSnippet(
	autoApprove: Record<string, boolean>,
	toolEnabled: Record<string, boolean>,
	mcpServers: Record<string, McpServerConfig>,
	mcpHub: McpHub | undefined,
	userTools?: Array<{ name: string; mode: "read" | "write" }>,
): string {
	const lines: string[] = [];

	// Built-in tools
	for (const [toolId] of Object.entries(TOOL_DISPLAY_NAMES)) {
		const currentAutoApprove = autoApprove[toolId] ?? defaultAutoApproveFor(toolId);
		const currentEnabled = toolEnabled[toolId] ?? !TOOLS_DEFAULT_DISABLED.has(toolId);
		lines.push(`${toolId}:`);
		lines.push(`  enabled: ${currentEnabled}`);
		lines.push(`  auto_approve: ${currentAutoApprove}`);
	}

	// User tools
	if (userTools) {
		for (const tool of userTools) {
			const defaultAutoApprove = tool.mode === "read";
			const currentAutoApprove = autoApprove[tool.name] ?? defaultAutoApprove;
			const currentEnabled = toolEnabled[tool.name] ?? true;
			lines.push(`${tool.name}:`);
			lines.push(`  enabled: ${currentEnabled}`);
			lines.push(`  auto_approve: ${currentAutoApprove}`);
		}
	}

	// MCP tools (namespaced as server__tool in the YAML)
	for (const [serverName, config] of Object.entries(mcpServers)) {
		if (config.disabled) continue;
		const conn = mcpHub?.getConnection(serverName);
		const tools = conn?.tools ?? [];
		for (const tool of tools) {
			const namespacedName = `${serverName}__${tool.name}`;
			const currentEnabled = toolEnabled[namespacedName] ?? true;
			const currentAutoApprove = (config.autoApprove ?? []).includes(tool.name);
			lines.push(`${namespacedName}:`);
			lines.push(`  enabled: ${currentEnabled}`);
			lines.push(`  auto_approve: ${currentAutoApprove}`);
		}
	}

	return `<notor_tool_config version="1.0">\n${lines.join("\n")}\n</notor_tool_config>`;
}

/** Get user-defined tools (excluding built-in scaffolds/overrides). */
function getUserTools(ctx: SettingsContext): UserToolDefinition[] {
	const manager = ctx.plugin.getExtensionManager();
	const builtinNames = new Set(manager.getBuiltinToolNames());
	return manager.getTools().filter((t) => !builtinNames.has(t.name));
}

/** Set a Lucide status icon on an element based on connection status. */
function setStatusIcon(el: HTMLElement, status: McpConnectionStatus | undefined): void {
	switch (status) {
		case "connected":    setIcon(el, "circle-check"); break;
		case "connecting":   setIcon(el, "loader"); break;
		case "error":        setIcon(el, "circle-alert"); break;
		case "disconnected":
		default:             setIcon(el, "circle-minus"); break;
	}
}

// ---------------------------------------------------------------------------
// Main section renderer
// ---------------------------------------------------------------------------

/** Render the unified "Tools" settings section. */
export function renderToolsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	containerEl.addClass("notor-tools-section");
	new Setting(containerEl).setHeading().setName("Tools");
	containerEl.createEl("p", {
		text:
			"Control which tools the AI can use and which run without asking for approval. " +
			"Disabling a tool removes it from the AI's context entirely. " +
			"These global defaults can be overridden per-context with <notor_tool_config> blocks " +
			"in persona, workflow, or rule notes.",
		cls: "setting-item-description",
	});

	// --- Search / filter input ---
	const groups: SectionGroup[] = [];

	const searchWrapper = containerEl.createDiv({ cls: "notor-tool-search-wrapper" });
	const searchInput = searchWrapper.createEl("input", {
		type: "search",
		cls: "notor-tool-search-input",
		placeholder: "Filter tools\u2026",
	});
	const clearBtn = searchWrapper.createDiv({ cls: "notor-tool-search-clear notor-hidden" });
	setIcon(clearBtn, "x");

	const noMatchEl = containerEl.createDiv({
		cls: "notor-tool-search-no-match notor-hidden",
		text: "No tools match your filter.",
	});

	// --- Approval timeout ---
	new Setting(containerEl)
		.setName("Tool approval timeout (seconds)")
		.setDesc(
			"How long to wait for manual tool approval before auto-skipping. " +
			"Set to 0 for no timeout (wait indefinitely). When a tool call times out, " +
			"the AI receives an error and can proceed without user input."
		)
		.addText((text) =>
			text
				.setPlaceholder("0")
				.setValue(ctx.settings.approval_timeout ? String(ctx.settings.approval_timeout) : "")
				.onChange(async (value) => {
					ctx.settings.approval_timeout = Math.max(0, parseInt(value) || 0);
					await ctx.saveSettings();
				})
		);

	// --- Output spillover ---
	let thresholdText: TextComponent | null = null;
	let thresholdSetting: Setting | null = null;

	new Setting(containerEl)
		.setName("Output spillover")
		.setDesc(
			"When enabled, tool output exceeding the threshold is truncated and " +
			"written to a temporary file the AI can retrieve via read_file. " +
			"Requires restart to take effect." +
			(Platform.isDesktopApp ? "" : " (Desktop only.)")
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.output_spillover_enabled)
				.onChange(async (value) => {
					ctx.settings.output_spillover_enabled = value;
					await ctx.saveSettings();
					if (thresholdText) {
						thresholdText.setDisabled(!value);
					}
					if (thresholdSetting) {
						thresholdSetting.settingEl.toggleClass("notor-tool-row-disabled", !value);
					}
					new Notice("Output spillover change requires a restart to take effect.");
				})
		);

	thresholdSetting = new Setting(containerEl)
		.setName("Output spillover threshold (characters)")
		.setDesc(
			"Tool output exceeding this character count will be spilled to a temp file. " +
			"Changes take effect immediately for new tool calls."
		)
		.addText((text) => {
			thresholdText = text;
			text
				.setPlaceholder("50000")
				.setValue(ctx.settings.output_spillover_threshold ? String(ctx.settings.output_spillover_threshold) : "")
				.onChange(async (value) => {
					ctx.settings.output_spillover_threshold = Math.max(1, parseInt(value) || 50000);
					await ctx.saveSettings();
				});
			if (!ctx.settings.output_spillover_enabled) {
				text.setDisabled(true);
			}
		});

	if (!ctx.settings.output_spillover_enabled) {
		thresholdSetting.settingEl.addClass("notor-tool-row-disabled");
	}

	// Sub-group collapsible plumbing
	const subgroupOpts: ToolSubgroupOpts = {
		persisted: ctx.settings.settings_collapsed_sections,
		onToggle: (key, open) => {
			ctx.settings.settings_collapsed_sections[key] = open;
			void ctx.saveSettings();
		},
		subgroupRefs: [],
	};

	// --- Built-in tools ---
	renderBuiltinTools(containerEl, ctx, groups, subgroupOpts);

	// --- User tools ---
	renderUserTools(containerEl, ctx, groups, subgroupOpts);

	// --- MCP tools ---
	renderMcpTools(containerEl, ctx, groups, subgroupOpts);

	// --- Copy tool config YAML ---
	new Setting(containerEl)
		.setName("Copy tool config YAML")
		.setDesc(
			"Generate a <notor_tool_config> snippet listing all built-in and MCP tools with their " +
			"current enabled and auto-approve settings, and copy it to your clipboard. Paste into a " +
			"persona, workflow, or rule note to override tool behaviour per context."
		)
		.addButton((btn) =>
			btn
				.setButtonText("Copy to clipboard")
				.onClick(async () => {
					const userToolsList = getUserTools(ctx).map(
						(t) => ({ name: t.name, mode: t.mode }),
					);
					const snippet = generateToolConfigSnippet(
						ctx.settings.auto_approve,
						ctx.settings.tool_enabled,
						ctx.settings.mcp_servers ?? {},
						getMcpHub(ctx),
						userToolsList,
					);
					await navigator.clipboard.writeText(snippet);
					new Notice("Tool config YAML copied to clipboard.");
				})
		);

	// --- Wire filter handler ---
	const applyFilter = (query: string) => {
		persistedToolSearchQuery = query;
		if (!query) {
			// Show everything
			for (const group of groups) {
				for (const el of group.elements) el.removeClass("notor-hidden");
				for (const entry of group.entries) {
					entry.settingEl.removeClass("notor-hidden");
					entry.nameEl.setText(entry.name);
				}
			}
			// Restore persisted collapse state
			for (const { details, persistKey } of subgroupOpts.subgroupRefs) {
				const shouldBeOpen = persistKey in subgroupOpts.persisted
					? subgroupOpts.persisted[persistKey]
					: true;
				if (shouldBeOpen) details.setAttribute("open", "");
				else details.removeAttribute("open");
			}
			clearBtn.addClass("notor-hidden");
			noMatchEl.addClass("notor-hidden");
			return;
		}

		// Force all sub-groups open while filtering
		for (const { details } of subgroupOpts.subgroupRefs) {
			details.setAttribute("open", "");
		}

		clearBtn.removeClass("notor-hidden");
		const search = prepareSimpleSearch(query);
		let totalVisible = 0;

		for (const group of groups) {
			let groupVisible = 0;
			for (const entry of group.entries) {
				const nameResult = search(entry.name);
				const matched = nameResult !== null || entry.searchTexts.some((t) => search(t) !== null);
				// Always rebuild the name so stale highlights from prior keystrokes are cleared.
				if (nameResult) renderNameHighlights(entry.nameEl, entry.name, nameResult.matches);
				else entry.nameEl.setText(entry.name);
				if (matched) {
					entry.settingEl.removeClass("notor-hidden");
					groupVisible++;
				} else {
					entry.settingEl.addClass("notor-hidden");
				}
			}
			for (const el of group.elements) {
				if (groupVisible > 0) {
					el.removeClass("notor-hidden");
				} else {
					el.addClass("notor-hidden");
				}
			}
			totalVisible += groupVisible;
		}

		if (totalVisible === 0) {
			noMatchEl.removeClass("notor-hidden");
		} else {
			noMatchEl.addClass("notor-hidden");
		}
	};

	searchInput.addEventListener("input", () => {
		applyFilter(searchInput.value.trim());
	});

	clearBtn.addEventListener("click", () => {
		searchInput.value = "";
		applyFilter("");
		searchInput.focus();
	});

	// Restore persisted search query after redisplay
	if (persistedToolSearchQuery) {
		searchInput.value = persistedToolSearchQuery;
		applyFilter(persistedToolSearchQuery);
	}
}

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

function renderBuiltinTools(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	groups: SectionGroup[],
	opts: ToolSubgroupOpts,
): void {
	const manager = ctx.plugin.getExtensionManager();
	const toolDefs = new Map(manager.getTools().map((t) => [t.name, t]));

	const readTools = Object.entries(TOOL_DISPLAY_NAMES).filter(
		([id, meta]) => !meta.isWrite && toolDefs.has(id)
	);
	const writeTools = Object.entries(TOOL_DISPLAY_NAMES).filter(
		([id, meta]) => meta.isWrite && toolDefs.has(id)
	);

	// Read-only tools
	const readPersistKey = "Tools/Read-only tools";
	const { body: readBody, details: readDetails } = createToolSubgroup(
		containerEl, "Read-only tools", readPersistKey, opts.persisted, opts.onToggle,
	);
	opts.subgroupRefs.push({ details: readDetails, persistKey: readPersistKey });
	renderColumnHeaders(readBody, true);
	const readGroup: SectionGroup = { elements: [readDetails], entries: [] };
	for (const [toolId, meta] of readTools) {
		const setting = renderBuiltinToolRow(readBody, toolId, meta, ctx, defaultAutoApproveFor(toolId));
		addBuiltinToolIcons(setting, toolId, toolDefs, ctx);
		readGroup.entries.push({ settingEl: setting.settingEl, nameEl: setting.nameEl, name: meta.name, searchTexts: [meta.name, meta.desc, toolId] });
	}
	groups.push(readGroup);

	// Write tools
	const writePersistKey = "Tools/Write tools";
	const { body: writeBody, details: writeDetails } = createToolSubgroup(
		containerEl, "Write tools", writePersistKey, opts.persisted, opts.onToggle,
	);
	opts.subgroupRefs.push({ details: writeDetails, persistKey: writePersistKey });
	renderColumnHeaders(writeBody, true);
	const writeGroup: SectionGroup = { elements: [writeDetails], entries: [] };
	for (const [toolId, meta] of writeTools) {
		const setting = renderBuiltinToolRow(writeBody, toolId, meta, ctx, defaultAutoApproveFor(toolId));
		addBuiltinToolIcons(setting, toolId, toolDefs, ctx);
		writeGroup.entries.push({ settingEl: setting.settingEl, nameEl: setting.nameEl, name: meta.name, searchTexts: [meta.name, meta.desc, toolId] });
	}
	groups.push(writeGroup);
}

function renderColumnHeaders(containerEl: HTMLElement, includeIconSpacers = false): HTMLElement {
	const headerEl = containerEl.createDiv({ cls: "notor-tool-column-headers" });
	headerEl.createSpan({ cls: "notor-tool-column-spacer" });
	headerEl.createSpan({ cls: "notor-tool-column-label", text: "Enabled" });
	headerEl.createSpan({ cls: "notor-tool-column-divider" });
	headerEl.createSpan({ cls: "notor-tool-column-label", text: "Auto-approve" });
	if (includeIconSpacers) {
		headerEl.createSpan({ cls: "notor-tool-column-icon-spacer" });
	}
	return headerEl;
}

function renderBuiltinToolRow(
	containerEl: HTMLElement,
	toolId: string,
	meta: { name: string; desc: string; isWrite: boolean },
	ctx: SettingsContext,
	defaultAutoApprove: boolean,
): Setting {
	const isEnabled = ctx.settings.tool_enabled[toolId] ?? !TOOLS_DEFAULT_DISABLED.has(toolId);
	const isAutoApproved = ctx.settings.auto_approve[toolId] ?? defaultAutoApprove;

	const setting = new Setting(containerEl)
		.setName(meta.name)
		.setDesc(meta.desc);
	applyDescriptionTruncation(setting, meta.desc);

	// Enabled toggle
	setting.addToggle((toggle) =>
		toggle
			.setValue(isEnabled)
			.setTooltip("Enabled")
			.onChange(async (value) => {
				ctx.settings.tool_enabled[toolId] = value;
				await ctx.saveSettings();
				ctx.redisplay();
			})
	);

	// Auto-approve toggle
	setting.addToggle((toggle) => {
		toggle
			.setValue(isAutoApproved)
			.setTooltip("Auto-approve")
			.onChange(async (value) => {
				ctx.settings.auto_approve[toolId] = value;
				await ctx.saveSettings();
			});
		if (!isEnabled) {
			toggle.setDisabled(true);
		}
	});

	if (!isEnabled) {
		setting.settingEl.addClass("notor-tool-row-disabled");
	}

	return setting;
}

/** Add open-file and gear icons to a built-in tool row. */
function addBuiltinToolIcons(
	setting: Setting,
	toolId: string,
	toolDefs: Map<string, UserToolDefinition>,
	ctx: SettingsContext,
): void {
	const manager = ctx.plugin.getExtensionManager();
	const vaultFilePath = normalizePath(
		`${ctx.settings.notor_dir}/tools/${toolId}.md`,
	);
	const vaultFileExists =
		ctx.app.vault.getAbstractFileByPath(vaultFilePath) !== null;

	// Open-file icon (all built-in tools)
	setting.addExtraButton((btn) =>
		btn
			.setIcon("square-arrow-out-up-right")
			.setTooltip("Open tool definition")
			.onClick(async () => {
				if (vaultFileExists) {
					await ctx.app.workspace.openLinkText(vaultFilePath, "", true);
				} else {
					try {
						const path = await manager.ensureBuiltinToolVaultFile(toolId);
						await ctx.app.workspace.openLinkText(path, "", true);
						new Notice(
							`Created ${path} — reload extensions to activate.`,
						);
						ctx.redisplay();
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						new Notice(`Failed to create tool file: ${msg}`);
					}
				}
			}),
	);

	// Gear icon (conditional: has settings, vault override, or execute_command)
	const toolDef = toolDefs.get(toolId);
	const hasSettings = (toolDef?.settingsSchema?.length ?? 0) > 0;
	const isExecuteCommand = toolId === "execute_command";

	if (hasSettings || vaultFileExists || isExecuteCommand) {
		setting.addExtraButton((btn) =>
			btn
				.setIcon("settings")
				.setTooltip("Configure tool settings")
				.onClick(() => {
					new ToolSettingsModal(ctx, toolId, ctx.scrollToGroup).open();
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
// User tool skeleton
// ---------------------------------------------------------------------------

const TOOL_MODE_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: "read", label: "Read-only" },
	{ value: "write", label: "Write" },
];

function buildToolSkeleton(name: string, description: string, mode: string): string {
	const lines: string[] = [
		"---",
		"notor-type: tool",
		`notor-tool-name: ${name}`,
		`notor-description: "${description}"`,
		`notor-mode: ${mode}`,
		"---",
		"",
		`# ${name}`,
		"",
		"<!-- Describe what this tool does. This prose is ignored by the runtime. -->",
		"",
		"```yaml",
		"params:",
		"  example_param:",
		"    type: string",
		'    description: "Replace with your parameters"',
		"```",
		"",
		"```ts",
		"// Implement your tool logic here.",
		`return { success: true, result: "Hello from ${name}!" };`,
		"```",
		"",
	];
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// User tools
// ---------------------------------------------------------------------------

function renderUserTools(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	groups: SectionGroup[],
	opts: ToolSubgroupOpts,
): void {
	const userTools = getUserTools(ctx);

	containerEl.createEl("hr", { cls: "notor-tool-divider" });
	const userToolsHeading = new Setting(containerEl).setHeading().setName("User tools");
	markSubsection(userToolsHeading, "User tools");
	// Built via a const (not an inline literal) so the sentence-case rule
	// doesn't try to capitalize the "notor/" path segment to the Notor brand.
	const userToolsDescText = "Tools defined in your vault's notor/tools/ directory.";
	const userToolsDesc = containerEl.createEl("p", {
		text: userToolsDescText,
		cls: "setting-item-description",
	});

	// "Create new tool" button
	const toolFields: CreationField[] = [
		{ type: "text", key: "name", placeholder: "Tool name (e.g. search_notes)" },
		{ type: "text", key: "description", placeholder: "Short description for the AI" },
		{ type: "select", key: "mode", options: TOOL_MODE_OPTIONS },
	];

	new Setting(containerEl)
		.setName("Create new tool")
		.setDesc(
			"Creates a skeleton tool file you can customize with parameters and code."
		)
		.addButton((btn) =>
			btn.setButtonText("Create").onClick(async () => {
				const result = await promptForCreation(containerEl, toolFields);
				if (!result) return;

				const toolsDir = normalizePath(
					`${ctx.settings.notor_dir}/tools`
				);
				const filePath = normalizePath(`${toolsDir}/${result["name"]}.md`);

				if (ctx.app.vault.getAbstractFileByPath(filePath)) {
					new Notice(`Tool "${result["name"]}" already exists.`);
					return;
				}

				const name = result["name"] || "";
				const description = result["description"] || "";
				const mode = result["mode"] || "read";

				try {
					await ensureDirectory(ctx, toolsDir);
					await ctx.app.vault.create(
						filePath,
						buildToolSkeleton(name, description, mode)
					);
					new Notice(`Tool "${name}" created — reload extensions to activate.`);
					await ctx.app.workspace.openLinkText(filePath, "", true);
					ctx.redisplay();
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Failed to create tool", { name, error: msg });
					new Notice(`Failed to create tool: ${msg}`);
				}
			})
		);

	if (userTools.length === 0) {
		const emptyMsg = containerEl.createEl("p", {
			text: "No user tools yet.",
			cls: "setting-item-description",
		});
		groups.push({ elements: [userToolsHeading.settingEl, userToolsDesc, emptyMsg], entries: [] });
		return;
	}

	const userParentElements = [userToolsHeading.settingEl, userToolsDesc];

	const readTools = userTools.filter((t) => t.mode === "read");
	const writeTools = userTools.filter((t) => t.mode === "write");

	if (readTools.length > 0) {
		const readPersistKey = "Tools/User: Read-only";
		const { body: readBody, details: readDetails } = createToolSubgroup(
			containerEl, "Read-only", readPersistKey, opts.persisted, opts.onToggle,
		);
		opts.subgroupRefs.push({ details: readDetails, persistKey: readPersistKey });
		renderColumnHeaders(readBody, true);
		const group: SectionGroup = { elements: [...userParentElements, readDetails], entries: [] };
		for (const tool of readTools) {
			const setting = renderUserToolRow(readBody, tool, ctx, true);
			addUserToolIcons(setting, tool, ctx);
			group.entries.push({ settingEl: setting.settingEl, nameEl: setting.nameEl, name: tool.name, searchTexts: [tool.name, tool.description] });
		}
		groups.push(group);
	}

	if (writeTools.length > 0) {
		const writePersistKey = "Tools/User: Write";
		const { body: writeBody, details: writeDetails } = createToolSubgroup(
			containerEl, "Write", writePersistKey, opts.persisted, opts.onToggle,
		);
		opts.subgroupRefs.push({ details: writeDetails, persistKey: writePersistKey });
		renderColumnHeaders(writeBody, true);
		const parentEls = readTools.length > 0 ? [] : userParentElements;
		const group: SectionGroup = { elements: [...parentEls, writeDetails], entries: [] };
		for (const tool of writeTools) {
			const setting = renderUserToolRow(writeBody, tool, ctx, false);
			addUserToolIcons(setting, tool, ctx);
			group.entries.push({ settingEl: setting.settingEl, nameEl: setting.nameEl, name: tool.name, searchTexts: [tool.name, tool.description] });
		}
		groups.push(group);
	}
}

function renderUserToolRow(
	containerEl: HTMLElement,
	tool: UserToolDefinition,
	ctx: SettingsContext,
	defaultAutoApprove: boolean,
): Setting {
	const isEnabled = ctx.settings.tool_enabled[tool.name] ?? true;
	const isAutoApproved = ctx.settings.auto_approve[tool.name] ?? defaultAutoApprove;

	const setting = new Setting(containerEl)
		.setName(tool.name)
		.setDesc(tool.description);
	applyDescriptionTruncation(setting, tool.description);

	// Enabled toggle
	setting.addToggle((toggle) =>
		toggle
			.setValue(isEnabled)
			.setTooltip("Enabled")
			.onChange(async (value) => {
				ctx.settings.tool_enabled[tool.name] = value;
				await ctx.saveSettings();
				ctx.redisplay();
			})
	);

	// Auto-approve toggle
	setting.addToggle((toggle) => {
		toggle
			.setValue(isAutoApproved)
			.setTooltip("Auto-approve")
			.onChange(async (value) => {
				ctx.settings.auto_approve[tool.name] = value;
				await ctx.saveSettings();
			});
		if (!isEnabled) {
			toggle.setDisabled(true);
		}
	});

	if (!isEnabled) {
		setting.settingEl.addClass("notor-tool-row-disabled");
	}

	return setting;
}

/** Add open-file and gear icons to a user tool row. */
function addUserToolIcons(
	setting: Setting,
	tool: UserToolDefinition,
	ctx: SettingsContext,
): void {
	// Open-file icon (all user tools)
	setting.addExtraButton((btn) =>
		btn
			.setIcon("square-arrow-out-up-right")
			.setTooltip("Open tool definition")
			.onClick(async () => {
				await ctx.app.workspace.openLinkText(tool.filePath, "", true);
			}),
	);

	// Gear icon (only if tool has settings schema)
	if (tool.settingsSchema && tool.settingsSchema.length > 0) {
		setting.addExtraButton((btn) =>
			btn
				.setIcon("settings")
				.setTooltip("Configure tool settings")
				.onClick(() => {
					new ToolSettingsModal(ctx, tool.name, ctx.scrollToGroup).open();
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
// MCP tools
// ---------------------------------------------------------------------------

function renderMcpTools(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	groups: SectionGroup[],
	opts: ToolSubgroupOpts,
): void {
	const mcpHub = getMcpHub(ctx);
	const servers = ctx.settings.mcp_servers ?? {};
	const serverNames = Object.keys(servers);

	if (serverNames.length === 0) return;

	containerEl.createEl("hr", { cls: "notor-tool-divider" });
	const mcpHeading = new Setting(containerEl).setHeading().setName("MCP tools");
	markSubsection(mcpHeading, "MCP tools");
	const mcpDesc = containerEl.createEl("p", {
		text: "Tools discovered from connected MCP servers. Server-reported classification hints are shown but your override takes precedence.",
		cls: "setting-item-description",
	});

	const mcpParentElements = [mcpHeading.settingEl, mcpDesc];

	for (const serverName of serverNames) {
		const config = servers[serverName];
		if (!config) continue;
		renderMcpServerTools(containerEl, serverName, config, ctx, mcpHub, groups, mcpParentElements, opts);
	}

	// Subscribe to live status changes so tool lists update as servers connect.
	if (mcpHub) {
		ctx.addCleanup?.(mcpHub.onStatusChange(() => ctx.redisplay()));
	}
}

function renderMcpServerTools(
	containerEl: HTMLElement,
	serverName: string,
	config: McpServerConfig,
	ctx: SettingsContext,
	mcpHub: McpHub | undefined,
	groups: SectionGroup[],
	mcpParentElements: HTMLElement[],
	opts: ToolSubgroupOpts,
): void {
	const conn = mcpHub?.getConnection(serverName);
	const status = conn?.status;

	const persistKey = `Tools/MCP:${serverName}`;
	const { body, details } = createToolSubgroup(
		containerEl, serverName, persistKey, opts.persisted, opts.onToggle,
		(summaryEl) => {
			const dotSpan = summaryEl.createSpan({
				cls: `notor-mcp-status-dot notor-mcp-dot-${status ?? "disconnected"}`,
			});
			setStatusIcon(dotSpan, status);
			summaryEl.createSpan({ text: serverName, cls: "notor-tool-mcp-server-name" });
		},
	);
	opts.subgroupRefs.push({ details, persistKey });
	details.setAttribute("data-notor-subsection", `mcp-server:${serverName}`);

	if (config.disabled) {
		body.createEl("p", {
			text: "Server is disabled. Enable it in the MCP servers section.",
			cls: "setting-item-description notor-tool-mcp-note",
		});
		groups.push({ elements: [...mcpParentElements, details], entries: [] });
		return;
	}

	if (status !== "connected") {
		body.createEl("p", {
			text: status === "connecting"
				? "Connecting to server\u2026"
				: "Server is not connected.",
			cls: "setting-item-description notor-tool-mcp-note",
		});
		groups.push({ elements: [...mcpParentElements, details], entries: [] });
		return;
	}

	const tools = conn?.tools ?? [];
	if (tools.length === 0) {
		body.createEl("p", {
			text: "No tools discovered for this server.",
			cls: "setting-item-description notor-tool-mcp-note",
		});
		groups.push({ elements: [...mcpParentElements, details], entries: [] });
		return;
	}

	renderColumnHeaders(body);
	const group: SectionGroup = { elements: [...mcpParentElements, details], entries: [] };
	for (const tool of tools) {
		const setting = renderMcpToolRow(body, serverName, tool, config, ctx);
		group.entries.push({ settingEl: setting.settingEl, nameEl: setting.nameEl, name: tool.name, searchTexts: [tool.name, tool.description, serverName] });
	}
	groups.push(group);
}

function renderMcpToolRow(
	containerEl: HTMLElement,
	serverName: string,
	tool: { name: string; description: string; annotations?: { readOnlyHint?: boolean } },
	config: McpServerConfig,
	ctx: SettingsContext,
): Setting {
	const rawName = tool.name;
	const namespacedName = `${serverName}__${rawName}`;

	const defaultMode = tool.annotations?.readOnlyHint === true ? "read" : "write";
	const currentMode = config.toolClassifications?.[rawName] ?? defaultMode;
	const isEnabled = ctx.settings.tool_enabled[namespacedName] ?? true;
	const isAutoApproved = (config.autoApprove ?? []).includes(rawName);

	const desc = tool.description
		? `${tool.description}${tool.annotations?.readOnlyHint !== undefined ? ` (server: ${tool.annotations.readOnlyHint ? "read" : "write"})` : ""}`
		: tool.annotations?.readOnlyHint !== undefined
			? `Server hint: ${tool.annotations.readOnlyHint ? "read" : "write"}`
			: "";

	const setting = new Setting(containerEl)
		.setName(rawName)
		.setDesc(desc);
	applyDescriptionTruncation(setting, desc);

	// Classification dropdown
	setting.addDropdown((dropdown) => {
		dropdown
			.addOption("read", "Read-only")
			.addOption("write", "Write")
			.setValue(currentMode)
			.onChange(async (value) => {
				const val = value as "read" | "write";
				if (!config.toolClassifications) config.toolClassifications = {};
				if (val === defaultMode) {
					delete config.toolClassifications[rawName];
				} else {
					config.toolClassifications[rawName] = val;
				}
				await ctx.saveSettings();
			});
		if (!isEnabled) {
			dropdown.setDisabled(true);
		}
	});

	// Enabled toggle
	setting.addToggle((toggle) =>
		toggle
			.setValue(isEnabled)
			.setTooltip("Enabled")
			.onChange(async (value) => {
				ctx.settings.tool_enabled[namespacedName] = value;
				await ctx.saveSettings();
				ctx.redisplay();
			})
	);

	// Auto-approve toggle
	setting.addToggle((toggle) => {
		toggle
			.setValue(isAutoApproved)
			.setTooltip("Auto-approve")
			.onChange(async (value) => {
				if (!config.autoApprove) config.autoApprove = [];
				if (value) {
					if (!config.autoApprove.includes(rawName)) config.autoApprove.push(rawName);
				} else {
					config.autoApprove = config.autoApprove.filter((n) => n !== rawName);
				}
				await ctx.saveSettings();
			});
		if (!isEnabled) {
			toggle.setDisabled(true);
		}
	});

	if (!isEnabled) {
		setting.settingEl.addClass("notor-tool-row-disabled");
	}

	return setting;
}
