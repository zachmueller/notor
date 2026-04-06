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

import { Notice, Setting, setIcon } from "obsidian";
import { TOOL_DISPLAY_NAMES } from "../constants";
import type { SettingsContext } from "./context";
import type { McpServerConfig } from "../../mcp/mcp-types";
import type { McpHub } from "../../mcp/mcp-hub";
import type { McpConnectionStatus } from "../../mcp/mcp-types";
import type { UserToolDefinition } from "../../extensions/types";

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
	for (const [toolId, meta] of Object.entries(TOOL_DISPLAY_NAMES)) {
		const defaultAutoApprove = !meta.isWrite;
		const currentAutoApprove = autoApprove[toolId] ?? defaultAutoApprove;
		const currentEnabled = toolEnabled[toolId] ?? true;
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

	// --- Built-in tools ---
	renderBuiltinTools(containerEl, ctx);

	// --- User tools ---
	renderUserTools(containerEl, ctx);

	// --- MCP tools ---
	renderMcpTools(containerEl, ctx);

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
}

// ---------------------------------------------------------------------------
// Built-in tools
// ---------------------------------------------------------------------------

function renderBuiltinTools(containerEl: HTMLElement, ctx: SettingsContext): void {
	const readTools = Object.entries(TOOL_DISPLAY_NAMES).filter(
		([, meta]) => !meta.isWrite
	);
	const writeTools = Object.entries(TOOL_DISPLAY_NAMES).filter(
		([, meta]) => meta.isWrite
	);

	// Read-only tools
	new Setting(containerEl).setHeading().setName("Read-only tools");
	renderColumnHeaders(containerEl);
	for (const [toolId, meta] of readTools) {
		renderBuiltinToolRow(containerEl, toolId, meta, ctx, true);
	}

	// Write tools
	new Setting(containerEl).setHeading().setName("Write tools");
	renderColumnHeaders(containerEl);
	for (const [toolId, meta] of writeTools) {
		renderBuiltinToolRow(containerEl, toolId, meta, ctx, false);
	}
}

function renderColumnHeaders(containerEl: HTMLElement): void {
	const headerEl = containerEl.createDiv({ cls: "notor-tool-column-headers" });
	headerEl.createSpan({ cls: "notor-tool-column-spacer" });
	headerEl.createSpan({ cls: "notor-tool-column-label", text: "Enabled" });
	headerEl.createSpan({ cls: "notor-tool-column-divider" });
	headerEl.createSpan({ cls: "notor-tool-column-label", text: "Auto-approve" });
}

function renderBuiltinToolRow(
	containerEl: HTMLElement,
	toolId: string,
	meta: { name: string; desc: string; isWrite: boolean },
	ctx: SettingsContext,
	defaultAutoApprove: boolean,
): void {
	const isEnabled = ctx.settings.tool_enabled[toolId] ?? true;
	const isAutoApproved = ctx.settings.auto_approve[toolId] ?? defaultAutoApprove;

	const setting = new Setting(containerEl)
		.setName(meta.name)
		.setDesc(meta.desc);

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
}

// ---------------------------------------------------------------------------
// User tools
// ---------------------------------------------------------------------------

function renderUserTools(containerEl: HTMLElement, ctx: SettingsContext): void {
	const userTools = getUserTools(ctx);
	if (userTools.length === 0) return;

	containerEl.createEl("hr", { cls: "notor-tool-divider" });
	new Setting(containerEl).setHeading().setName("User tools");
	containerEl.createEl("p", {
		text: "Tools defined in your vault's notor/tools/ directory.",
		cls: "setting-item-description",
	});

	const readTools = userTools.filter((t) => t.mode === "read");
	const writeTools = userTools.filter((t) => t.mode === "write");

	if (readTools.length > 0) {
		new Setting(containerEl).setHeading().setName("Read-only");
		renderColumnHeaders(containerEl);
		for (const tool of readTools) {
			renderUserToolRow(containerEl, tool, ctx, true);
		}
	}

	if (writeTools.length > 0) {
		new Setting(containerEl).setHeading().setName("Write");
		renderColumnHeaders(containerEl);
		for (const tool of writeTools) {
			renderUserToolRow(containerEl, tool, ctx, false);
		}
	}
}

function renderUserToolRow(
	containerEl: HTMLElement,
	tool: UserToolDefinition,
	ctx: SettingsContext,
	defaultAutoApprove: boolean,
): void {
	const isEnabled = ctx.settings.tool_enabled[tool.name] ?? true;
	const isAutoApproved = ctx.settings.auto_approve[tool.name] ?? defaultAutoApprove;

	const setting = new Setting(containerEl)
		.setName(tool.name)
		.setDesc(tool.description);

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
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

function renderMcpTools(containerEl: HTMLElement, ctx: SettingsContext): void {
	const mcpHub = getMcpHub(ctx);
	const servers = ctx.settings.mcp_servers ?? {};
	const serverNames = Object.keys(servers);

	if (serverNames.length === 0) return;

	containerEl.createEl("hr", { cls: "notor-tool-divider" });
	new Setting(containerEl).setHeading().setName("MCP tools");
	containerEl.createEl("p", {
		text: "Tools discovered from connected MCP servers. Server-reported classification hints are shown but your override takes precedence.",
		cls: "setting-item-description",
	});

	for (const serverName of serverNames) {
		const config = servers[serverName];
		if (!config) continue;
		renderMcpServerTools(containerEl, serverName, config, ctx, mcpHub);
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
): void {
	const conn = mcpHub?.getConnection(serverName);
	const status = conn?.status;

	// Server sub-heading with status dot
	const headerEl = containerEl.createDiv({ cls: "notor-tool-mcp-server-header" });
	const dotSpan = headerEl.createSpan({
		cls: `notor-mcp-status-dot notor-mcp-dot-${status ?? "disconnected"}`,
	});
	setStatusIcon(dotSpan, status);
	headerEl.createSpan({ text: serverName, cls: "notor-tool-mcp-server-name" });

	if (config.disabled) {
		containerEl.createEl("p", {
			text: "Server is disabled. Enable it in the MCP servers section.",
			cls: "setting-item-description notor-tool-mcp-note",
		});
		return;
	}

	if (status !== "connected") {
		containerEl.createEl("p", {
			text: status === "connecting"
				? "Connecting to server…"
				: "Server is not connected.",
			cls: "setting-item-description notor-tool-mcp-note",
		});
		return;
	}

	const tools = conn?.tools ?? [];
	if (tools.length === 0) {
		containerEl.createEl("p", {
			text: "No tools discovered for this server.",
			cls: "setting-item-description notor-tool-mcp-note",
		});
		return;
	}

	renderColumnHeaders(containerEl);
	for (const tool of tools) {
		renderMcpToolRow(containerEl, serverName, tool, config, ctx);
	}
}

function renderMcpToolRow(
	containerEl: HTMLElement,
	serverName: string,
	tool: { name: string; description: string; annotations?: { readOnlyHint?: boolean } },
	config: McpServerConfig,
	ctx: SettingsContext,
): void {
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
}
