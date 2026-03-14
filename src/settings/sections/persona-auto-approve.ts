/**
 * Persona auto-approve settings section renderer (B-004, B-005).
 *
 * Handles its own async state: `cachedPersonas` is managed as a parameter
 * to `renderPersonaAutoApproveSection()`, and `triggerPersonaRescan()`
 * re-renders the section container when discovery completes.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Setting } from "obsidian";
import type { AutoApproveState, Persona } from "../../types";
import { discoverPersonas } from "../../personas/persona-discovery";
import {
	getStaleToolNames,
	setPersonaToolOverride,
} from "../../personas/auto-approve-resolver";
import { TOOL_DISPLAY_NAMES } from "../constants";
import { logger } from "../../utils/logger";
import type { SettingsContext } from "./context";
import type { McpHub } from "../../mcp/mcp-hub";

/** Get the McpHub instance from the plugin (cast through unknown). */
function getMcpHub(ctx: SettingsContext): McpHub | undefined {
	return (ctx.plugin as unknown as { _mcpHub?: McpHub })._mcpHub;
}

const log = logger("SettingsTab");

/**
 * Render the "Persona auto-approve" section in **Settings → Notor**.
 *
 * Lists all discovered personas with collapsible sub-sections. Each
 * persona sub-section shows every registered tool with a three-state
 * dropdown ("Global default", "Auto-approve", "Require approval").
 *
 * Also detects stale tool names (B-005) — tools stored in overrides
 * that no longer exist in the registry — and renders them with a
 * warning indicator and remove button.
 *
 * @param containerEl - Element to render into
 * @param personas - Discovered personas from the most recent scan
 * @param ctx - Shared settings context
 * @param onRerender - Callback to re-render just this section (for stale removal)
 */
export function renderPersonaAutoApproveSection(
	containerEl: HTMLElement,
	personas: Persona[],
	ctx: SettingsContext,
	onRerender: (personas: Persona[]) => void
): void {
	new Setting(containerEl).setHeading().setName("Persona auto-approve");
	containerEl.createEl("p", {
		text:
			"Per-persona overrides for tool auto-approve settings. When a persona " +
			"is active, these overrides take precedence over global defaults.",
		cls: "setting-item-description",
	});

	// No personas discovered
	if (personas.length === 0) {
		const notorDir = ctx.settings.notor_dir.replace(/\/$/, "");
		containerEl.createEl("p", {
			text:
				`No personas found. Create a persona directory under ` +
				`${notorDir}/personas/ to configure per-persona auto-approve settings.`,
			cls: "notor-persona-aa-empty",
		});
		return;
	}

	// Known (registered) tool names from TOOL_DISPLAY_NAMES
	const registeredToolNames = Object.keys(TOOL_DISPLAY_NAMES);
	const readTools = Object.entries(TOOL_DISPLAY_NAMES).filter(
		([, meta]) => !meta.isWrite
	);
	const writeTools = Object.entries(TOOL_DISPLAY_NAMES).filter(
		([, meta]) => meta.isWrite
	);

	// Dropdown option labels
	const stateLabels: Record<string, string> = {
		global: "Global default",
		approve: "Auto-approve",
		deny: "Require approval",
	};

	for (const persona of personas) {
		const personaName = persona.name;

		// Collapsible sub-section per persona using <details>
		const details = containerEl.createEl("details", {
			cls: "notor-persona-aa-details",
		});
		const summary = details.createEl("summary", {
			cls: "notor-persona-aa-summary",
		});
		summary.createEl("strong", { text: personaName });

		// Count how many overrides this persona has
		const overrides = ctx.settings.persona_auto_approve[personaName] ?? {};
		const overrideCount = Object.keys(overrides).length;
		if (overrideCount > 0) {
			summary.createSpan({
				text: ` (${overrideCount} override${overrideCount === 1 ? "" : "s"})`,
				cls: "notor-persona-aa-count",
			});
		}

		const personaBody = details.createDiv({
			cls: "notor-persona-aa-body",
		});

		// Helper to render a tool row with a three-state dropdown
		const renderToolRow = (
			parent: HTMLElement,
			toolId: string,
			toolMeta: { name: string; desc: string }
		): void => {
			const currentState = (overrides[toolId] as AutoApproveState | undefined) ?? "global";

			new Setting(parent)
				.setName(toolMeta.name)
				.setDesc(toolMeta.desc)
				.addDropdown((dropdown) => {
					for (const [value, label] of Object.entries(stateLabels)) {
						dropdown.addOption(value, label);
					}
					dropdown.setValue(currentState);
					dropdown.onChange(async (value) => {
						setPersonaToolOverride(
							ctx.settings,
							personaName,
							toolId,
							value as AutoApproveState
						);
						await ctx.saveSettings();

						// Update the override count badge in the summary
						const updatedOverrides =
							ctx.settings.persona_auto_approve[personaName] ?? {};
						const updatedCount = Object.keys(updatedOverrides).length;
						const countEl = summary.querySelector(".notor-persona-aa-count");
						if (countEl) {
							if (updatedCount > 0) {
								countEl.textContent = ` (${updatedCount} override${updatedCount === 1 ? "" : "s"})`;
							} else {
								countEl.textContent = "";
							}
						} else if (updatedCount > 0) {
							summary.createSpan({
								text: ` (${updatedCount} override${updatedCount === 1 ? "" : "s"})`,
								cls: "notor-persona-aa-count",
							});
						}
					});
				});
		};

		// Read-only tools sub-group
		new Setting(personaBody).setHeading().setName("Read-only tools");
		for (const [toolId, meta] of readTools) {
			renderToolRow(personaBody, toolId, meta);
		}

		// Write tools sub-group
		new Setting(personaBody).setHeading().setName("Write tools");
		for (const [toolId, meta] of writeTools) {
			renderToolRow(personaBody, toolId, meta);
		}

		// -----------------------------------------------------------
		// INT-004: MCP tools grouped by server (FR-60)
		// -----------------------------------------------------------
		const mcpHub = getMcpHub(ctx);
		const allMcpTools = mcpHub?.getAllDiscoveredTools() ?? [];

		if (allMcpTools.length > 0) {
			new Setting(personaBody).setHeading().setName("MCP tools");
			personaBody.createEl("p", {
				text: "Overrides for tools discovered from connected MCP servers.",
				cls: "setting-item-description",
			});

			// Group tools by server name
			const byServer = new Map<string, typeof allMcpTools>();
			for (const entry of allMcpTools) {
				const list = byServer.get(entry.serverName) ?? [];
				list.push(entry);
				byServer.set(entry.serverName, list);
			}

			for (const [serverName, serverTools] of byServer) {
				personaBody.createEl("h5", {
					text: serverName,
					cls: "notor-persona-aa-mcp-server-heading",
				});

				for (const { tool } of serverTools) {
					const namespacedName = `${serverName}__${tool.name}`;
					renderToolRow(personaBody, namespacedName, {
						name: `${serverName}/${tool.name}`,
						desc: tool.description || namespacedName,
					});
					// Add namespacedName to registered names so it isn't flagged stale
					if (!registeredToolNames.includes(namespacedName)) {
						registeredToolNames.push(namespacedName);
					}
				}
			}
		}

		// -----------------------------------------------------------
		// B-005: Stale tool name detection and warning indicator
		// -----------------------------------------------------------
		const staleNames = getStaleToolNames(overrides, registeredToolNames);
		if (staleNames.length > 0) {
			new Setting(personaBody).setHeading().setName("Unknown tools").setClass("notor-persona-aa-stale-heading");
			personaBody.createEl("p", {
				text:
					"These tool names are stored in overrides but no longer exist in the tool registry. " +
					"They have no effect at runtime and can be safely removed.",
				cls: "setting-item-description notor-persona-aa-stale-desc",
			});

			for (const staleName of staleNames) {
				const staleState = overrides[staleName] ?? "global";
				const staleLabel = stateLabels[staleState] ?? staleState;

				new Setting(personaBody)
					.setName(`⚠️ ${staleName}`)
					.setDesc(`Current override: ${staleLabel}`)
					.setClass("notor-persona-aa-stale-row")
					.addButton((btn) =>
						btn
							.setButtonText("Remove")
							.setWarning()
							.onClick(async () => {
								// Delete the stale entry by setting it to "global"
								// (which removes it from storage)
								setPersonaToolOverride(
									ctx.settings,
									personaName,
									staleName,
									"global"
								);
								await ctx.saveSettings();

								// Re-render just the persona auto-approve section
								onRerender(personas);
							})
					);
			}
		}
	}
}

/**
 * Trigger an asynchronous persona rescan.
 *
 * Runs `discoverPersonas()` in the background and calls `onComplete`
 * with the freshly discovered personas when done. Non-blocking.
 *
 * @param ctx - Shared settings context
 * @param onComplete - Callback invoked with the discovered personas
 */
export function triggerPersonaRescan(
	ctx: SettingsContext,
	onComplete: (personas: Persona[]) => void
): void {
	discoverPersonas(
		ctx.app.vault,
		ctx.app.metadataCache,
		ctx.settings.notor_dir
	)
		.then((personas) => {
			log.debug("Persona rescan on settings open complete", {
				count: personas.length,
				names: personas.map((p) => p.name),
			});
			onComplete(personas);
		})
		.catch((e) => {
			log.warn("Persona rescan on settings open failed", {
				error: String(e),
			});
		});
}
