/**
 * MCP status indicator — chat panel header icon + popover (INT-005).
 *
 * Shows a small icon in the chat header when ≥1 MCP server is configured.
 * Click opens a popover listing all servers with: name, colored status dot,
 * enable/disable toggle, and brief error summary.
 *
 * The indicator shows a warning state when any enabled server is errored
 * or disconnected.
 *
 * @see specs/04-mcp/tasks.md — INT-005
 * @see specs/04-mcp/spec.md — FR-63
 */

import { setIcon, ToggleComponent } from "obsidian";
import type NotorPlugin from "../main";
import type { McpHub } from "../mcp/mcp-hub";
import type { McpConnectionStatus } from "../mcp/mcp-types";

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

/** Get the McpHub from the plugin (private field access via cast). */
function getMcpHub(plugin: NotorPlugin): McpHub | undefined {
	return (plugin as unknown as { _mcpHub?: McpHub })._mcpHub;
}

/**
 * MCP status indicator component for the chat panel header.
 *
 * Lifecycle: construct → render() → destroy().
 */
export class McpStatusIndicator {
	private plugin: NotorPlugin;
	private containerEl: HTMLElement;

	/** The indicator button element. */
	private indicatorEl: HTMLElement | null = null;

	/** The popover overlay element. */
	private popoverEl: HTMLElement | null = null;

	/** Unsubscribe callback for McpHub status changes. */
	private statusUnsubscribe?: () => void;

	/** Handler to close popover on outside click. */
	private outsideClickHandler?: (e: MouseEvent) => void;

	constructor(containerEl: HTMLElement, plugin: NotorPlugin) {
		this.containerEl = containerEl;
		this.plugin = plugin;
	}

	/**
	 * Render the indicator button in the container element.
	 *
	 * Only shows the button when ≥1 MCP server is configured.
	 */
	render(): void {
		this.destroy();

		const mcpHub = getMcpHub(this.plugin);
		const settings = this.plugin.settings;
		const servers = settings.mcp_servers ?? {};

		// Hide when no servers configured
		if (Object.keys(servers).length === 0) return;

		// Create indicator button
		const btn = this.containerEl.createEl("button", {
			cls: "notor-chat-header-btn notor-mcp-status-btn clickable-icon",
			attr: { "aria-label": "MCP servers" },
		});
		setIcon(btn, "server");
		this.indicatorEl = btn;

		// Update appearance based on connection states
		this.updateIndicatorState(mcpHub);

		// Click to toggle popover
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (this.popoverEl) {
				this.closePopover();
			} else {
				this.openPopover(mcpHub);
			}
		});

		// Subscribe to McpHub status changes to update the indicator in real time.
		// Store the unsubscribe callback so destroy() can clean up the listener
		// and prevent accumulation across repeated render/destroy cycles.
		if (mcpHub) {
			const callback = () => {
				this.updateIndicatorState(mcpHub);
				// If popover is open, refresh it too
				if (this.popoverEl) {
					this.closePopover();
					this.openPopover(mcpHub);
				}
			};
			this.statusUnsubscribe = mcpHub.onStatusChange(callback);
		}
	}

	/**
	 * Update the indicator button state: healthy vs. warning.
	 */
	private updateIndicatorState(mcpHub: McpHub | undefined): void {
		if (!this.indicatorEl) return;

		const servers = this.plugin.settings.mcp_servers ?? {};
		const enabledNames = Object.keys(servers).filter((n) => !servers[n]?.disabled);

		let hasWarning = false;
		for (const name of enabledNames) {
			const conn = mcpHub?.getConnection(name);
			const status = conn?.status;
			if (status === "error" || status === "disconnected") {
				hasWarning = true;
				break;
			}
		}

		this.indicatorEl.classList.toggle("notor-mcp-status-warning", hasWarning);
		this.indicatorEl.classList.toggle("notor-mcp-status-healthy", !hasWarning);
	}

	/**
	 * Open the MCP server list popover.
	 */
	private openPopover(mcpHub: McpHub | undefined): void {
		if (!this.indicatorEl) return;

		const popover = this.containerEl.createDiv({ cls: "notor-mcp-popover" });
		this.popoverEl = popover;

		popover.createEl("h4", { text: "MCP servers", cls: "notor-mcp-popover-title" });

		const servers = this.plugin.settings.mcp_servers ?? {};
		const serverNames = Object.keys(servers);

		if (serverNames.length === 0) {
			popover.createEl("p", {
				text: "No MCP servers configured.",
				cls: "notor-mcp-popover-empty",
			});
		} else {
			for (const serverName of serverNames) {
				const config = servers[serverName];
				if (!config) continue;

				const conn = mcpHub?.getConnection(serverName);
				const status = conn?.status;

				const rowEl = popover.createDiv({ cls: "notor-mcp-popover-row" });

				// Status icon
				const dot = rowEl.createSpan({ cls: `notor-mcp-popover-dot notor-mcp-dot-${status ?? "disconnected"}` });
				setStatusIcon(dot, status);

				// Server name
				const nameEl = rowEl.createSpan({ cls: "notor-mcp-popover-server-name" });
				nameEl.textContent = serverName;

				// Error hint
				if (status === "error" && conn?.error) {
					rowEl.createSpan({
						cls: "notor-mcp-popover-error",
						text: conn.error.substring(0, 60) + (conn.error.length > 60 ? "…" : ""),
					});
				}

				// Enable/disable toggle
				new ToggleComponent(rowEl)
					.setValue(!config.disabled)
					.onChange(async (value) => {
						config.disabled = !value;
						await this.plugin.saveSettings();
						if (value) {
							mcpHub?.connectServer(serverName).catch(() => {});
						} else {
							mcpHub?.disconnectServer(serverName).catch(() => {});
						}
					});
			}
		}

		// Close popover when clicking outside
		this.outsideClickHandler = (e: MouseEvent) => {
			if (!popover.contains(e.target as Node) && e.target !== this.indicatorEl) {
				this.closePopover();
			}
		};
		setTimeout(() => {
			document.addEventListener("click", this.outsideClickHandler!);
		}, 0);
	}

	/**
	 * Close the popover and clean up outside-click listener.
	 */
	private closePopover(): void {
		if (this.outsideClickHandler) {
			document.removeEventListener("click", this.outsideClickHandler);
			this.outsideClickHandler = undefined;
		}
		this.popoverEl?.remove();
		this.popoverEl = null;
	}

	/**
	 * Destroy the indicator: remove DOM elements and clean up listeners.
	 *
	 * Calls the McpHub unsubscribe function to prevent callback accumulation
	 * across repeated render/destroy cycles (e.g. chat view open/close).
	 */
	destroy(): void {
		this.statusUnsubscribe?.();
		this.statusUnsubscribe = undefined;
		this.closePopover();
		this.indicatorEl?.remove();
		this.indicatorEl = null;
	}
}
