/**
 * MCP servers settings section — INT-001, INT-002, INT-003.
 *
 * Renders the "MCP servers" section in Settings → Notor. Covers:
 * - Server list with status indicators and enable/disable toggles (INT-001)
 * - "Add server" form with transport-specific fields (INT-001)
 * - Expandable per-server detail view with editable config (INT-002)
 * - Per-tool classification and auto-approve controls (INT-002)
 * - Sensitive env var / header credential management (INT-003)
 *
 * @see specs/04-mcp/tasks.md — INT-001, INT-002, INT-003
 * @see specs/04-mcp/spec.md — FR-54, FR-57, FR-60, FR-61
 */

import { Notice, Platform, setIcon, Setting, ToggleComponent } from "obsidian";
import { ConfirmModal } from "../../ui/confirm-modal";
import type { SettingsContext } from "./context";
import type { McpServerConfig, McpEnvVar, McpHeader } from "../../mcp/mcp-types";
import {
	MCP_SERVER_NAME_REGEX,
	MCP_SERVER_NAME_MAX_LENGTH,
	mcpEnvSecretKey,
	mcpHeaderSecretKey,
} from "../../mcp/mcp-types";
import { parseShellArgs, serializeShellArgs } from "../../utils/shell-args";
import type { McpHub } from "../../mcp/mcp-hub";
import type { McpConnectionStatus } from "../../mcp/mcp-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Auto-slugify a server name: trim, lowercase, replace non-[a-z0-9] with hyphens,
 * collapse multiple hyphens, strip leading/trailing hyphens.
 */
function slugify(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.substring(0, MCP_SERVER_NAME_MAX_LENGTH);
}

/** Validate a server name against the slug regex and length limit. */
function validateServerName(name: string): string | null {
	if (!name) return "Server name is required.";
	if (name.length > MCP_SERVER_NAME_MAX_LENGTH) return `Name must be ≤ ${MCP_SERVER_NAME_MAX_LENGTH} characters.`;
	if (!MCP_SERVER_NAME_REGEX.test(name)) return "Name must be lowercase alphanumeric and hyphens only (e.g. my-server).";
	return null;
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

/** Get a human-readable label for a transport type. */
function transportLabel(type: McpServerConfig["type"]): string {
	switch (type) {
		case "stdio": return "stdio";
		case "sse": return "SSE";
		case "streamableHttp": return "HTTP";
	}
}

/**
 * Resolve the SecretStorage accessor from the plugin's Obsidian app instance.
 * Uses the same approach as main.ts `pluginSecretStorage`.
 */
function makeSecretStorage(ctx: SettingsContext) {
	return {
		get: async (key: string): Promise<string | undefined> => {
			try {
				const app = ctx.app as unknown as { loadLocalStorage?: (k: string) => string | null };
				const val = app.loadLocalStorage?.(`notor-secret-${key}`);
				return val ?? undefined;
			} catch { return undefined; }
		},
		set: async (key: string, value: string): Promise<void> => {
			try {
				const app = ctx.app as unknown as { saveLocalStorage?: (k: string, v: string) => void };
				app.saveLocalStorage?.(`notor-secret-${key}`, value);
			} catch { /* silent */ }
		},
		delete: async (key: string): Promise<void> => {
			try {
				const app = ctx.app as unknown as { saveLocalStorage?: (k: string, v: string | null) => void };
				app.saveLocalStorage?.(`notor-secret-${key}`, null as unknown as string);
			} catch { /* silent */ }
		},
	};
}

/** Get the McpHub instance from the plugin (cast through unknown). */
function getMcpHub(ctx: SettingsContext): McpHub | undefined {
	return (ctx.plugin as unknown as { _mcpHub?: McpHub })._mcpHub;
}

// ---------------------------------------------------------------------------
// Main section renderer
// ---------------------------------------------------------------------------

/**
 * Render the "MCP servers" section in Settings → Notor.
 *
 * @param containerEl - Element to render into
 * @param ctx - Shared settings context
 */
export function renderMcpServersSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("MCP servers");
	containerEl.createEl("p", {
		text:
			"Connect custom MCP (Model Context Protocol) servers to extend the AI's tool set " +
			"with your own tools. Discovered tools appear alongside built-in tools.",
		cls: "setting-item-description",
	});

	const mcpHub = getMcpHub(ctx);
	const servers = ctx.settings.mcp_servers ?? {};

	// Render existing server entries
	const serverListEl = containerEl.createDiv({ cls: "notor-mcp-server-list" });
	renderServerList(serverListEl, ctx, mcpHub, () => {
		serverListEl.empty();
		renderServerList(serverListEl, ctx, mcpHub, arguments.callee as () => void);
		addServerFormEl.empty();
		renderAddServerForm(addServerFormEl, ctx, mcpHub, () => {
			serverListEl.empty();
			renderServerList(serverListEl, ctx, mcpHub, refresh);
		});
	});

	// Keep a stable refresh reference
	function refresh() {
		serverListEl.empty();
		renderServerList(serverListEl, ctx, mcpHub, refresh);
		addServerFormEl.empty();
		renderAddServerForm(addServerFormEl, ctx, mcpHub, refresh);
	}

	// Re-render list with stable refresh
	serverListEl.empty();
	renderServerList(serverListEl, ctx, mcpHub, refresh);

	// Subscribe to live status changes so icons update as connections resolve.
	if (mcpHub) {
		ctx.addCleanup?.(mcpHub.onStatusChange(refresh));
	}

	// "Add server" form section
	const addServerFormEl = containerEl.createDiv({ cls: "notor-mcp-add-server" });
	renderAddServerForm(addServerFormEl, ctx, mcpHub, refresh);

	// Empty state
	if (Object.keys(servers).length === 0) {
		serverListEl.createEl("p", {
			text: "No MCP servers configured yet. Add one below.",
			cls: "notor-mcp-empty",
		});
	}
}

// ---------------------------------------------------------------------------
// Server list renderer (INT-001)
// ---------------------------------------------------------------------------

function renderServerList(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	mcpHub: McpHub | undefined,
	refresh: () => void
): void {
	const servers = ctx.settings.mcp_servers ?? {};
	const serverNames = Object.keys(servers);

	if (serverNames.length === 0) return;

	for (const serverName of serverNames) {
		const config = servers[serverName];
		if (!config) continue;

		const conn = mcpHub?.getConnection(serverName);
		const status = conn?.status;

		// Collapsible server entry
		const details = containerEl.createEl("details", { cls: "notor-mcp-server-entry" });
		const summary = details.createEl("summary", { cls: "notor-mcp-server-summary" });

		// Status dot + name + transport badge
		const summaryLeft = summary.createDiv({ cls: "notor-mcp-server-summary-left" });
		const dotSpan = summaryLeft.createSpan({ cls: `notor-mcp-status-dot notor-mcp-dot-${status ?? "disconnected"}` });
		setStatusIcon(dotSpan, status);
		summaryLeft.createSpan({ cls: "notor-mcp-server-name", text: serverName });
		summaryLeft.createSpan({ cls: "notor-mcp-transport-badge", text: transportLabel(config.type) });

		if (status === "error" && conn?.error) {
			summaryLeft.createSpan({ cls: "notor-mcp-server-error-hint", text: conn.error });
		}

		// Enable/disable toggle (right side of summary)
		const summaryRight = summary.createDiv({ cls: "notor-mcp-server-summary-right" });
		const toggle = new ToggleComponent(summaryRight)
			.setValue(!config.disabled)
			.onChange(async (value) => {
				config.disabled = !value;
				await ctx.saveSettings();
				if (value) {
					mcpHub?.connectServer(serverName).catch(() => {});
				} else {
					mcpHub?.disconnectServer(serverName).catch(() => {});
				}
				refresh();
			});
		// Prevent the <details> element from collapsing when clicking the toggle
		toggle.toggleEl.addEventListener("click", (e) => e.stopPropagation());

		// Detail body
		const body = details.createDiv({ cls: "notor-mcp-server-body" });
		renderServerDetail(body, serverName, config, ctx, mcpHub, refresh);
	}
}

// ---------------------------------------------------------------------------
// Server detail view (INT-002)
// ---------------------------------------------------------------------------

function renderServerDetail(
	containerEl: HTMLElement,
	serverName: string,
	config: McpServerConfig,
	ctx: SettingsContext,
	mcpHub: McpHub | undefined,
	refresh: () => void
): void {
	const conn = mcpHub?.getConnection(serverName);

	// Error state notice
	if (conn?.status === "error" && conn.error) {
		const errEl = containerEl.createDiv({ cls: "notor-mcp-error-banner" });
		errEl.createSpan({ text: "⚠ Error: " });
		errEl.createSpan({ text: conn.error });
		errEl.createEl("p", {
			text: "Check your configuration and toggle the server off then back on to reconnect.",
			cls: "notor-mcp-error-hint",
		});
	}

	// Timeout setting
	new Setting(containerEl)
		.setName("Request timeout (seconds)")
		.setDesc("Timeout for tool calls to this server. Default: 60.")
		.addText((text) =>
			text
				.setPlaceholder("60")
				.setValue(String(config.timeout ?? 60))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						config.timeout = parsed;
						await ctx.saveSettings();
					}
				})
		);

	// Transport-specific fields
	if (config.type === "stdio") {
		renderStdioFields(containerEl, serverName, config, ctx);
	} else {
		renderHttpFields(containerEl, serverName, config, ctx);
	}

	// Refresh tools button + tools list (only when connected)
	if (conn?.status === "connected") {
		renderToolsSubsection(containerEl, serverName, config, ctx, mcpHub, refresh);
	}

	// Remove server button
	containerEl.createEl("hr", { cls: "notor-mcp-divider" });
	new Setting(containerEl)
		.setName("Remove server")
		.setDesc("Delete this server configuration. This cannot be undone.")
		.addButton((btn) =>
			btn
				.setButtonText("Remove")
				.setWarning()
				.onClick(() => {
					new ConfirmModal(
						ctx.app,
						"Remove server",
						`Remove MCP server "${serverName}"? This cannot be undone.`,
						async () => {
							// Disconnect first
							await mcpHub?.disconnectServer(serverName).catch(() => {});

							// Clean up secrets for env vars and headers
							const secrets = makeSecretStorage(ctx);
							for (const envVar of config.env ?? []) {
								if (envVar.sensitive) {
									await secrets.delete(mcpEnvSecretKey(serverName, envVar.key));
								}
							}
							for (const header of config.headers ?? []) {
								if (header.sensitive) {
									await secrets.delete(mcpHeaderSecretKey(serverName, header.key));
								}
							}

							delete ctx.settings.mcp_servers[serverName];
							await ctx.saveSettings();
							refresh();
						},
						"Remove",
						true
					).open();
				})
		);
}

// ---------------------------------------------------------------------------
// stdio transport fields (INT-001, INT-003)
// ---------------------------------------------------------------------------

function renderStdioFields(
	containerEl: HTMLElement,
	serverName: string,
	config: McpServerConfig,
	ctx: SettingsContext
): void {
	new Setting(containerEl)
		.setName("Command")
		.setDesc("The command to spawn (e.g. npx, python, /usr/local/bin/server).")
		.addText((text) =>
			text
				.setPlaceholder("npx")
				.setValue(config.command ?? "")
				.onChange(async (value) => {
					config.command = value.trim();
					await ctx.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Arguments")
		.setDesc(
			"Arguments for the command. Separate with spaces. " +
			"Wrap arguments that contain spaces in double or single quotes " +
			'(e.g. -y server "/path/with spaces").'
		)
		.addText((text) =>
			text
				.setPlaceholder('-y @modelcontextprotocol/server-filesystem "/path/with spaces"')
				.setValue(serializeShellArgs(config.args ?? []))
				.onChange(async (value) => {
					config.args = parseShellArgs(value);
					await ctx.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Working directory")
		.setDesc("Working directory for the process (defaults to vault root).")
		.addText((text) =>
			text
				.setPlaceholder("/path/to/dir")
				.setValue(config.cwd ?? "")
				.onChange(async (value) => {
					config.cwd = value.trim() || undefined;
					await ctx.saveSettings();
				})
		);

	// Environment variables with sensitive toggle (INT-003)
	new Setting(containerEl).setHeading().setName("Environment variables");
	containerEl.createEl("p", {
		text: "Additional environment variables for the spawned process. Mark sensitive values to store them securely.",
		cls: "setting-item-description",
	});

	const envListEl = containerEl.createDiv({ cls: "notor-mcp-kv-list" });
	const secrets = makeSecretStorage(ctx);

	const renderEnvList = () => {
		envListEl.empty();
		(config.env ?? []).forEach((envVar, i) => {
			renderKeyValueRow(
				envListEl, envVar, i,
				async (updated) => {
					const oldKey = config.env![i]!.key;
					const wasSensitive = config.env![i]!.sensitive;
					config.env![i] = updated;
					// If sensitive toggled off, move value out of secrets
					if (wasSensitive && !updated.sensitive) {
						const stored = await secrets.get(mcpEnvSecretKey(serverName, oldKey));
						if (stored) config.env![i]!.value = stored;
						await secrets.delete(mcpEnvSecretKey(serverName, oldKey));
					}
					// If sensitive toggled on, store value in secrets
					if (!wasSensitive && updated.sensitive && updated.value) {
						await secrets.set(mcpEnvSecretKey(serverName, updated.key), updated.value);
						config.env![i]!.value = "";
					}
					// Handle key rename for sensitive entries
					if (wasSensitive && updated.sensitive && oldKey !== updated.key) {
						const stored = await secrets.get(mcpEnvSecretKey(serverName, oldKey));
						if (stored) await secrets.set(mcpEnvSecretKey(serverName, updated.key), stored);
						await secrets.delete(mcpEnvSecretKey(serverName, oldKey));
					}
					await ctx.saveSettings();
				},
				async () => {
					const envVar2 = config.env![i]!;
					if (envVar2.sensitive) await secrets.delete(mcpEnvSecretKey(serverName, envVar2.key));
					config.env!.splice(i, 1);
					await ctx.saveSettings();
					renderEnvList();
				}
			);
		});
	};

	renderEnvList();

	new Setting(containerEl)
		.addButton((btn) =>
			btn.setButtonText("+ Add variable").onClick(() => {
				if (!config.env) config.env = [];
				config.env.push({ key: "", value: "", sensitive: false });
				renderEnvList();
			})
		);
}

// ---------------------------------------------------------------------------
// HTTP transport fields (INT-001, INT-003)
// ---------------------------------------------------------------------------

function renderHttpFields(
	containerEl: HTMLElement,
	serverName: string,
	config: McpServerConfig,
	ctx: SettingsContext
): void {
	new Setting(containerEl)
		.setName("URL")
		.setDesc("The server endpoint URL.")
		.addText((text) =>
			text
				.setPlaceholder("https://my-mcp-server.example.com/mcp")
				.setValue(config.url ?? "")
				.onChange(async (value) => {
					config.url = value.trim();
					await ctx.saveSettings();
				})
		);

	// Headers with sensitive toggle (INT-003)
	new Setting(containerEl).setHeading().setName("Headers");
	containerEl.createEl("p", {
		text: "Custom HTTP headers (e.g. for API key authentication). Mark sensitive values to store them securely.",
		cls: "setting-item-description",
	});

	const headerListEl = containerEl.createDiv({ cls: "notor-mcp-kv-list" });
	const secrets = makeSecretStorage(ctx);

	const renderHeaderList = () => {
		headerListEl.empty();
		(config.headers ?? []).forEach((header, i) => {
			renderKeyValueRow(
				headerListEl, header, i,
				async (updated: McpHeader) => {
					const oldKey = config.headers![i]!.key;
					const wasSensitive = config.headers![i]!.sensitive;
					config.headers![i] = updated;
					if (wasSensitive && !updated.sensitive) {
						const stored = await secrets.get(mcpHeaderSecretKey(serverName, oldKey));
						if (stored) config.headers![i]!.value = stored;
						await secrets.delete(mcpHeaderSecretKey(serverName, oldKey));
					}
					if (!wasSensitive && updated.sensitive && updated.value) {
						await secrets.set(mcpHeaderSecretKey(serverName, updated.key), updated.value);
						config.headers![i]!.value = "";
					}
					if (wasSensitive && updated.sensitive && oldKey !== updated.key) {
						const stored = await secrets.get(mcpHeaderSecretKey(serverName, oldKey));
						if (stored) await secrets.set(mcpHeaderSecretKey(serverName, updated.key), stored);
						await secrets.delete(mcpHeaderSecretKey(serverName, oldKey));
					}
					await ctx.saveSettings();
				},
				async () => {
					const hdr = config.headers![i]!;
					if (hdr.sensitive) await secrets.delete(mcpHeaderSecretKey(serverName, hdr.key));
					config.headers!.splice(i, 1);
					await ctx.saveSettings();
					renderHeaderList();
				}
			);
		});
	};

	renderHeaderList();

	new Setting(containerEl)
		.addButton((btn) =>
			btn.setButtonText("+ Add header").onClick(() => {
				if (!config.headers) config.headers = [];
				config.headers.push({ key: "", value: "", sensitive: false });
				renderHeaderList();
			})
		);
}

// ---------------------------------------------------------------------------
// Key/value row renderer with sensitive toggle (INT-003)
// ---------------------------------------------------------------------------

function renderKeyValueRow(
	containerEl: HTMLElement,
	item: McpEnvVar | McpHeader,
	_index: number,
	onChange: (updated: McpEnvVar | McpHeader) => Promise<void>,
	onRemove: () => Promise<void>
): void {
	const rowEl = containerEl.createDiv({ cls: "notor-mcp-kv-row" });

	const keyInput = rowEl.createEl("input", { type: "text", placeholder: "Key" });
	keyInput.value = item.key;
	keyInput.classList.add("notor-mcp-kv-key");

	const valueInput = rowEl.createEl("input", {
		type: item.sensitive ? "password" : "text",
		placeholder: item.sensitive ? "••••••••" : "Value",
	});
	valueInput.value = item.value;
	valueInput.classList.add("notor-mcp-kv-value");

	const sensitiveLabel = rowEl.createEl("label", { cls: "notor-mcp-kv-sensitive-label" });
	const sensitiveCheck = sensitiveLabel.createEl("input", { type: "checkbox" });
	sensitiveCheck.checked = item.sensitive;
	sensitiveLabel.createSpan({ text: " Sensitive" });

	const removeBtn = rowEl.createEl("button", { text: "✕", cls: "notor-mcp-kv-remove" });

	const emitChange = async () => {
		await onChange({
			key: keyInput.value,
			value: valueInput.value,
			sensitive: sensitiveCheck.checked,
		});
	};

	keyInput.addEventListener("change", emitChange);
	valueInput.addEventListener("change", emitChange);
	sensitiveCheck.addEventListener("change", () => {
		valueInput.type = sensitiveCheck.checked ? "password" : "text";
		valueInput.placeholder = sensitiveCheck.checked ? "••••••••" : "Value";
		emitChange();
	});
	removeBtn.addEventListener("click", async () => {
		await onRemove();
		rowEl.remove();
	});
}

// ---------------------------------------------------------------------------
// Tools subsection (INT-002)
// ---------------------------------------------------------------------------

function renderToolsSubsection(
	containerEl: HTMLElement,
	serverName: string,
	config: McpServerConfig,
	ctx: SettingsContext,
	mcpHub: McpHub | undefined,
	refresh: () => void
): void {
	containerEl.createEl("hr", { cls: "notor-mcp-divider" });

	const toolsHeader = containerEl.createDiv({ cls: "notor-mcp-tools-header" });
	new Setting(toolsHeader).setHeading().setName("Tools");

	// Refresh tools button
	const refreshBtn = toolsHeader.createEl("button", {
		text: "Refresh tools",
		cls: "notor-mcp-refresh-btn",
	});
	refreshBtn.addEventListener("click", async () => {
		refreshBtn.disabled = true;
		refreshBtn.textContent = "Refreshing…";
		try {
			await mcpHub?.refreshTools(serverName);
			new Notice(`Tools refreshed for "${serverName}".`);
			refresh();
		} catch (e) {
			new Notice(`Failed to refresh tools: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			refreshBtn.disabled = false;
			refreshBtn.textContent = "Refresh tools";
		}
	});

	const conn = mcpHub?.getConnection(serverName);
	const tools = conn?.tools ?? [];

	if (tools.length === 0) {
		containerEl.createEl("p", {
			text: "No tools discovered for this server.",
			cls: "notor-mcp-tools-empty",
		});
		return;
	}

	// Classification advisory note
	containerEl.createEl("p", {
		text: "Server-reported hints are not verified. Your override takes precedence.",
		cls: "setting-item-description notor-mcp-classification-note",
	});

	const toolListEl = containerEl.createDiv({ cls: "notor-mcp-tool-list" });

	for (const tool of tools) {
		const rawName = tool.name;
		const defaultMode = tool.annotations?.readOnlyHint === true ? "read" : "write";
		const currentMode = config.toolClassifications?.[rawName] ?? defaultMode;
		const isAutoApproved = (config.autoApprove ?? []).includes(rawName);

		const toolRowEl = toolListEl.createDiv({ cls: "notor-mcp-tool-row" });
		const toolMeta = toolRowEl.createDiv({ cls: "notor-mcp-tool-meta" });
		toolMeta.createSpan({ cls: "notor-mcp-tool-name", text: rawName });
		if (tool.description) {
			toolMeta.createSpan({ cls: "notor-mcp-tool-desc", text: tool.description });
		}

		const toolControls = toolRowEl.createDiv({ cls: "notor-mcp-tool-controls" });

		// Classification dropdown
		const classSelect = toolControls.createEl("select", { cls: "notor-mcp-class-select" });
		const readOpt = classSelect.createEl("option", { value: "read", text: "Read-only" });
		const writeOpt = classSelect.createEl("option", { value: "write", text: "Write" });
		if (currentMode === "read") readOpt.selected = true;
		else writeOpt.selected = true;

		// Show badge if server reported a hint
		if (tool.annotations?.readOnlyHint !== undefined) {
			const hintText = tool.annotations.readOnlyHint ? "server: read" : "server: write";
			toolControls.createSpan({ cls: "notor-mcp-hint-badge", text: hintText });
		}

		classSelect.addEventListener("change", async () => {
			const val = classSelect.value as "read" | "write";
			if (!config.toolClassifications) config.toolClassifications = {};
			if (val === defaultMode) {
				delete config.toolClassifications[rawName];
			} else {
				config.toolClassifications[rawName] = val;
			}
			await ctx.saveSettings();
		});

		// Auto-approve toggle
		const autoApproveLabel = toolControls.createEl("label", { cls: "notor-mcp-aa-label" });
		const autoApproveCheck = autoApproveLabel.createEl("input", { type: "checkbox" });
		autoApproveCheck.checked = isAutoApproved;
		autoApproveLabel.createSpan({ text: " Auto-approve" });

		autoApproveCheck.addEventListener("change", async () => {
			if (!config.autoApprove) config.autoApprove = [];
			if (autoApproveCheck.checked) {
				if (!config.autoApprove.includes(rawName)) config.autoApprove.push(rawName);
			} else {
				config.autoApprove = config.autoApprove.filter((n) => n !== rawName);
			}
			await ctx.saveSettings();
		});
	}
}

// ---------------------------------------------------------------------------
// Add server form (INT-001) — trust warnings, transport selector, name input
// ---------------------------------------------------------------------------

function renderAddServerForm(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	mcpHub: McpHub | undefined,
	refresh: () => void
): void {
	new Setting(containerEl).setHeading().setName("Add server");

	// Trust warning (non-dismissible, always shown) per FR-61
	const trustWarning = containerEl.createDiv({ cls: "notor-mcp-trust-warning" });
	trustWarning.createSpan({ text: "⚠ " });
	trustWarning.createSpan({
		text: "Custom MCP tools run outside Notor's built-in safety guarantees. Only add servers you trust.",
	});

	// State for the form
	let selectedType: McpServerConfig["type"] = "stdio";
	let nameInput = "";
	let stdioCommand = "";
	let stdioArgs = "";
	let stdioWarningEl: HTMLElement | null = null;

	// Transport type selector
	new Setting(containerEl)
		.setName("Transport type")
		.setDesc("How to connect to the MCP server.")
		.addDropdown((dd) => {
			if (Platform.isDesktopApp) {
				dd.addOption("stdio", "stdio — local process");
			}
			dd.addOption("sse", "SSE — remote HTTP (legacy)");
			dd.addOption("streamableHttp", "Streamable HTTP — remote HTTP");
			dd.setValue(Platform.isDesktopApp ? "stdio" : "sse");
			if (!Platform.isDesktopApp) selectedType = "sse";

			dd.onChange((value) => {
				selectedType = value as McpServerConfig["type"];
				if (stdioWarningEl) {
					stdioWarningEl.toggleClass("notor-hidden", selectedType !== "stdio");
				}
				updateTransportFields();
			});
		});

	// Mobile stdio notice
	if (!Platform.isDesktopApp) {
		containerEl.createEl("p", {
			text: "Local process (stdio) servers require the Obsidian desktop app.",
			cls: "setting-item-description notor-mcp-mobile-notice",
		});
	}

	// stdio additional warning
	stdioWarningEl = containerEl.createDiv({ cls: "notor-mcp-stdio-warning" });
	stdioWarningEl.createSpan({ text: "⚠ " });
	stdioWarningEl.createSpan({
		text: "This will spawn a local process on your machine with your user permissions.",
	});
	if (selectedType !== "stdio") stdioWarningEl.addClass("notor-hidden");

	// Server name
	const nameSetting = new Setting(containerEl)
		.setName("Server name")
		.setDesc("Unique identifier — slug format (e.g. my-server). Auto-slugified on input.")
		.addText((text) => {
			text.setPlaceholder("my-server");
			text.onChange((value) => {
				// During typing: only replace invalid characters but preserve trailing hyphens
				// so the user can type "my-server" without the hyphen being stripped mid-input.
				const partial = value
					.toLowerCase()
					.replace(/[^a-z0-9-]+/g, "-")
					.replace(/^-+/, "")
					.replace(/-{2,}/g, "-")
					.substring(0, MCP_SERVER_NAME_MAX_LENGTH);
				if (partial !== value) text.setValue(partial);
				// For validation/submission, use the fully-slugified value (strips trailing hyphens)
				nameInput = slugify(partial);
			});
			// On blur, apply full slugify (strip trailing hyphens, etc.)
			text.inputEl.addEventListener("blur", () => {
				const slugged = slugify(text.getValue());
				if (slugged !== text.getValue()) text.setValue(slugged);
				nameInput = slugged;
			});
		});
	void nameSetting;

	// Transport-specific fields container
	const transportFieldsEl = containerEl.createDiv({ cls: "notor-mcp-add-transport-fields" });
	let httpUrlInput = "";

	const updateTransportFields = () => {
		transportFieldsEl.empty();
		if (selectedType === "stdio") {
			new Setting(transportFieldsEl)
				.setName("Command")
				.setDesc("Command to spawn (e.g. npx).")
				.addText((t) => {
					t.setPlaceholder("npx");
					t.onChange((v) => { stdioCommand = v.trim(); });
				});
			new Setting(transportFieldsEl)
				.setName("Arguments")
				.setDesc(
					"Arguments for the command. Separate with spaces. " +
					"Wrap arguments that contain spaces in double or single quotes " +
					'(e.g. -y server "/path/with spaces").'
				)
				.addText((t) => {
					t.setPlaceholder('-y @modelcontextprotocol/server-filesystem "/path/with spaces"');
					t.onChange((v) => { stdioArgs = v; });
				});
		} else {
			new Setting(transportFieldsEl)
				.setName("URL")
				.setDesc("Server endpoint URL.")
				.addText((t) => {
					t.setPlaceholder("https://my-mcp-server.example.com/mcp");
					t.onChange((v) => { httpUrlInput = v.trim(); });
				});
		}
	};
	updateTransportFields();

	// Validation error element
	const errorEl = containerEl.createEl("p", { cls: "notor-mcp-add-error notor-hidden" });

	// Add button
	new Setting(containerEl)
		.addButton((btn) =>
			btn.setButtonText("Add server").setCta().onClick(async () => {
				errorEl.addClass("notor-hidden");

				// Validate name
				const nameErr = validateServerName(nameInput);
				if (nameErr) {
					errorEl.textContent = nameErr;
					errorEl.removeClass("notor-hidden");
					return;
				}

				// Uniqueness check
				const existing = ctx.settings.mcp_servers ?? {};
				if (existing[nameInput]) {
					errorEl.textContent = `A server named "${nameInput}" already exists.`;
					errorEl.removeClass("notor-hidden");
					return;
				}

				// Validate required transport field
				if (selectedType === "stdio" && !stdioCommand) {
					errorEl.textContent = "Command is required for stdio transport.";
					errorEl.removeClass("notor-hidden");
					return;
				}
				if ((selectedType === "sse" || selectedType === "streamableHttp") && !httpUrlInput) {
					errorEl.textContent = "URL is required for HTTP transport.";
					errorEl.removeClass("notor-hidden");
					return;
				}

				// Build config
				const newConfig: McpServerConfig = {
					name: nameInput,
					type: selectedType,
				};
				if (selectedType === "stdio") {
					newConfig.command = stdioCommand;
					const parsedArgs = parseShellArgs(stdioArgs);
					if (parsedArgs.length > 0) newConfig.args = parsedArgs;
				} else {
					newConfig.url = httpUrlInput;
				}

				if (!ctx.settings.mcp_servers) ctx.settings.mcp_servers = {};
				ctx.settings.mcp_servers[nameInput] = newConfig;
				await ctx.saveSettings();

				// Connect if enabled
				mcpHub?.connectServer(nameInput).catch(() => {});
				new Notice(`MCP server "${nameInput}" added.`);
				refresh();
			})
		);
}
