/**
 * Effective Config Inspector — standalone leaf view showing the merged
 * tool configuration during a live conversation.
 *
 * Reads `EffectiveToolConfig` and `ParsedToolConfig[]` from the
 * orchestrator's getter methods and renders a per-tool table showing
 * effective values and their source provenance.
 *
 * @see specs/04b-tool-toggle/tasks.md — UI-003
 * @see specs/04b-tool-toggle/spec.md — FR-88
 */

import { ItemView, type WorkspaceLeaf, type EventRef } from "obsidian";
import type { ChatOrchestrator } from "../chat/orchestrator";
import type {
	EffectiveToolConfig,
	ParsedToolConfig,
	ResolvedToolConfigEntry,
	ToolConfigSource,
} from "../tool-config/types";
import { PATH_SCOPE_LISTS, type PathScopeList } from "../settings/path-scoping";

/** View type identifier for Obsidian's view registry. */
export const INSPECTOR_VIEW_TYPE = "notor-tool-config-inspector";

/**
 * Inspector leaf view for the effective tool config.
 *
 * Shows a table per tool with effective `enabled`, `auto_approve`,
 * `allowed_paths`, `blocked_paths`, and the source note that drives
 * each value. Fields at global defaults are shown in muted style.
 */
export class EffectiveConfigInspectorView extends ItemView {
	private orchestrator: ChatOrchestrator | null = null;
	private contentEl_: HTMLElement | null = null;

	/**
	 * Callback to resolve the orchestrator for a given leaf.
	 * Injected by main.ts so the inspector can follow focus changes.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — A4.5
	 */
	private resolveOrchestrator?: (leaf: WorkspaceLeaf) => ChatOrchestrator | null;

	/** Event ref for the active-leaf-change listener (A4.5). */
	private leafChangeRef?: EventRef;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return INSPECTOR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Tool config inspector";
	}

	getIcon(): string {
		return "settings";
	}

	/** Inject the orchestrator reference. */
	setOrchestrator(orchestrator: ChatOrchestrator | null): void {
		this.orchestrator = orchestrator;
	}

	/**
	 * Set the resolver used to follow focus changes (A4.5).
	 *
	 * Called by main.ts after view creation. The resolver returns the
	 * orchestrator for a given leaf, or null if the leaf is not a chat panel.
	 */
	setOrchestratorResolver(resolver: (leaf: WorkspaceLeaf) => ChatOrchestrator | null): void {
		this.resolveOrchestrator = resolver;
	}

	onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("notor-config-inspector");

		this.contentEl_ = container.createDiv({
			cls: "notor-config-inspector-content",
		});

		// A4.5: Follow focus changes — update orchestrator when a chat panel gains focus
		this.leafChangeRef = this.app.workspace.on("active-leaf-change", (leaf) => {
			if (!leaf || !this.resolveOrchestrator) return;
			const orch = this.resolveOrchestrator(leaf);
			if (orch) {
				this.orchestrator = orch;
				this.refresh();
			}
			// When a non-chat leaf gains focus, retain last orchestrator
		});

		this.refresh();
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		// A4.5: Unsubscribe from active-leaf-change
		if (this.leafChangeRef) {
			this.app.workspace.offref(this.leafChangeRef);
			this.leafChangeRef = undefined;
		}
		this.contentEl_ = null;
		return Promise.resolve();
	}

	/** Re-render the inspector with the latest effective config. */
	refresh(): void {
		if (!this.contentEl_) return;
		this.contentEl_.empty();

		if (!this.orchestrator) {
			this.contentEl_.createEl("p", {
				text: "Inspector not connected to orchestrator.",
				cls: "notor-config-inspector-empty",
			});
			return;
		}

		const effective = this.orchestrator.getEffectiveToolConfig();
		const parsed = this.orchestrator.getActiveParsedConfigs();

		if (!effective) {
			this.contentEl_.createEl("p", {
				text: "No active conversation — start or resume a conversation to see effective tool config.",
				cls: "notor-config-inspector-empty",
			});
			return;
		}

		this.renderEffectiveConfig(this.contentEl_, effective, parsed);
	}

	// -------------------------------------------------------------------
	// Rendering
	// -------------------------------------------------------------------

	private renderEffectiveConfig(
		container: HTMLElement,
		effective: EffectiveToolConfig,
		parsed: ParsedToolConfig[]
	): void {
		container.createEl("h4", { text: "Effective tool configuration" });

		if (parsed.length > 0) {
			const sourceInfo = container.createEl("p", {
				cls: "notor-config-inspector-sources",
			});
			sourceInfo.createEl("strong", { text: "Sources: " });
			sourceInfo.createEl("span", {
				text: parsed.map((c) => `${c.source}: ${c.sourceFile}`).join(", "),
			});
		}

		const toolNames = Object.keys(effective.tools).sort();

		if (toolNames.length === 0) {
			container.createEl("p", { text: "No tools registered." });
			return;
		}

		const table = container.createEl("table", {
			cls: "notor-config-inspector-table",
		});

		// Header row
		const thead = table.createEl("thead");
		const headerRow = thead.createEl("tr");
		for (const label of [
			"Tool",
			"Enabled",
			"Auto-approve",
			// Access tier — these block calls.
			"Allowed paths",
			"Blocked paths",
			// Approval tier — these only decide whether a prompt is shown.
			"Auto-approve paths",
			"Never auto-approve",
			"Source",
		]) {
			headerRow.createEl("th", { text: label });
		}

		// Body rows
		const tbody = table.createEl("tbody");
		for (const toolName of toolNames) {
			const entry = effective.tools[toolName]!;
			const source = this.findSource(toolName, parsed);
			this.renderToolRow(tbody, toolName, entry, source);
		}
	}

	private renderToolRow(
		tbody: HTMLElement,
		toolName: string,
		entry: ResolvedToolConfigEntry,
		source: { sourceFile: string; sourceType: ToolConfigSource } | null
	): void {
		const row = tbody.createEl("tr");

		// Tool name
		row.createEl("td", { text: toolName });

		// Enabled
		const enabledCell = row.createEl("td", {
			text: entry.enabled ? "Yes" : "No",
		});
		if (!entry.enabled) enabledCell.addClass("notor-config-inspector-disabled");

		// Auto-approve
		row.createEl("td", {
			text: entry.auto_approve ? "Yes" : "No",
		});

		// Path lists: the flat per-context value plus any global group scope the
		// tool inherits, labelled by origin so the two are never confused.
		for (const list of PATH_SCOPE_LISTS) {
			this.renderPathCell(row, entry, list);
		}

		// Source
		const sourceCell = row.createEl("td");
		if (source) {
			const link = sourceCell.createEl("a", {
				text: `${source.sourceType}: ${source.sourceFile}`,
				cls: "notor-config-inspector-source-link",
			});
			link.addEventListener("click", (e) => {
				e.preventDefault();
				void this.app.workspace.openLinkText(source.sourceFile, "");
			});
		} else {
			sourceCell.setText("Global defaults");
			sourceCell.addClass("notor-config-inspector-muted");
		}

		// Mute row when all values are at defaults (enabled=true, auto_approve from global)
		if (!source) {
			row.addClass("notor-config-inspector-default-row");
		}
	}

	/**
	 * Render one path-list cell: the tool's own value, plus any global group
	 * scopes it inherits, tagged with the group they came from.
	 *
	 * Group scopes are shown separately rather than pre-combined because they
	 * apply only to the tool's parameters in that group — a single tool can
	 * inherit different rules for its read and write parameters.
	 */
	private renderPathCell(
		row: HTMLElement,
		entry: ResolvedToolConfigEntry,
		list: PathScopeList,
	): void {
		const cell = row.createEl("td");
		const own = entry[list];
		const inherited = Object.entries(entry.path_scopes)
			.map(([group, lists]) => ({ group, paths: lists?.[list] ?? [] }))
			.filter(({ paths }) => paths.length > 0);

		if (own.length === 0 && inherited.length === 0) {
			cell.setText("(none)");
			cell.addClass("notor-config-inspector-muted");
			return;
		}

		if (own.length > 0) cell.createDiv({ text: own.join(", ") });
		for (const { group, paths } of inherited) {
			cell.createDiv({
				cls: "notor-config-inspector-muted",
				text: `global ${group}: ${paths.join(", ")}`,
			});
		}
	}

	/**
	 * Find the highest-priority parsed config that mentions this tool.
	 *
	 * Walks the parsed configs in reverse (highest-priority last due to
	 * merge ordering) and returns the first match.
	 */
	private findSource(
		toolName: string,
		parsed: ParsedToolConfig[]
	): { sourceFile: string; sourceType: ToolConfigSource } | null {
		// Walk from highest priority to lowest (last entry in array wins)
		for (let i = parsed.length - 1; i >= 0; i--) {
			const config = parsed[i]!;
			if (config.tools[toolName] !== undefined) {
				return {
					sourceFile: config.sourceFile,
					sourceType: config.source,
				};
			}
		}
		return null;
	}
}
