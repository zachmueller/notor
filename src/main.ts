/**
 * Notor plugin entry point — lifecycle only.
 *
 * Keeps main.ts minimal per AGENTS.md conventions. All feature logic
 * is delegated to separate modules.
 *
 * INT-001: Full lifecycle wiring — registers chat view, commands, settings
 * tab, and initializes all managers with clean unload support.
 */

import { Notice, Platform, Plugin, WorkspaceLeaf, TFile, TAbstractFile, normalizePath, parseYaml } from "obsidian";
import { createDefaultSettings, NotorSettingTab } from "./settings";
import type { NotorSettings } from "./settings";
import { logger, setLogLevel } from "./utils/logger";
import { notifyFileLeafActivated } from "./context/auto-context";

// Workflows
import { discoverWorkflows } from "./workflows/workflow-discovery";
import { autoInjectUnidentifiedWorkflows, injectWorkflowFrontmatter } from "./workflows/workflow-frontmatter";
import type { Workflow } from "./types";

// Group G: Workflow hook override manager
import { WorkflowHookOverrideManager } from "./hooks/workflow-hook-override";

// Group H: Workflow activity tracker
import { WorkflowActivityTracker, type FlowRunEntry } from "./workflows/workflow-activity-tracker";

// Export / Import
import { ExportModal, type ExportFormat } from "./export/export-modal";
import { exportToMarkdown } from "./export/markdown-exporter";
import { exportToHtml, type SubAgentConversationMap } from "./export/html-exporter";
import { USE_SUBAGENT_TOOL_NAME } from "./sub-agents/constants";

// Group F: Vault event hooks
import { TagShadowCache } from "./hooks/tag-change-detector";
import { TagChangeSuppressionManager } from "./hooks/tag-change-detector";
import { VaultEventDebounce } from "./hooks/vault-event-debounce";
import { ExecutionChainTracker } from "./hooks/execution-chain";
import { ManualSaveDetector } from "./hooks/manual-save-detector";
import { HookDelayManager } from "./hooks/hook-delay-manager";
import { VaultEventScheduler } from "./hooks/vault-event-scheduler";
import { VaultEventListenerManager } from "./hooks/vault-event-listener-manager";
import { WorkflowConcurrencyManager } from "./workflows/workflow-concurrency";
import {
	handleNoteOpen,
	handleNoteCreate,
	handleModify,
	handleMetadataChanged,
} from "./hooks/vault-event-handlers";
import type { VaultEventHandlerDeps } from "./hooks/vault-event-handlers";
import { dispatchVaultEventHooks } from "./hooks/vault-event-dispatcher";
import type { DispatcherDeps } from "./hooks/vault-event-dispatcher";

// Providers
import { ProviderRegistry } from "./providers/index";
import { LocalProvider } from "./providers/local-provider";
import { AnthropicProvider } from "./providers/anthropic-provider";
import { OpenAIProvider } from "./providers/openai-provider";
import { resolvePreset } from "./presets/preset-resolver";

// Tools
import { ToolRegistry } from "./tools/index";
import { NoteOpener } from "./tools/note-opener";

// Chat
import { ToolDispatcher } from "./chat/dispatcher";
import { HistoryManager } from "./chat/history";
import { SystemPromptBuilder } from "./chat/system-prompt";
import { ChatOrchestrator, type SessionGuard } from "./chat/orchestrator";
import type { ConversationSession } from "./chat/conversation-session";
import { StaleContentTracker } from "./chat/stale-tracker";

// Checkpoints
import { CheckpointStorage } from "./checkpoints/storage";
import { CheckpointManager } from "./checkpoints/checkpoint";

// Rules
import { VaultRuleManager } from "./rules/vault-rules";

// Personas
import { PersonaManager } from "./personas/persona-manager";

// Sub-agents
import { SubAgentManager } from "./sub-agents/manager";
import { UseSubagentTool } from "./tools/use-subagent";
import { UpdateTasksTool } from "./tools/update-tasks";
import { RunFlowTool, RUN_FLOW_TOOL_NAME } from "./tools/run-flow";
import { FlowCompositionManager } from "./orchestration/flow-composition-manager";
import { makeChildFlowSpawner } from "./orchestration/launch";
import type { OrchestrationFlow } from "./orchestration/types";

// Extensions
import { ExtensionManager } from "./extensions/manager";
import type { AutomationTrigger } from "./extensions/types";
import { isExtensionFile, isExtensionPath } from "./extensions/watcher";
import { isPersonaFile, isPersonaPath } from "./personas/watcher";

// Settings migrations
import { runAllMigrations } from "./settings/migrations";

// Commands
import { registerCommands } from "./commands";

// View wiring
import { wireView as wireViewFn } from "./ui/wire-view";

// MCP
import { McpHub } from "./mcp/mcp-hub";
import { SleepWakeDetector } from "./utils/sleep-wake-detector";
import type { McpServerConfig } from "./mcp/mcp-types";
import { McpRegisteredTool } from "./mcp/mcp-tool-adapter";
import { showMcpMissingAnnotationsNotice } from "./tool-config/notices";

// Queue
import { TaskLaneQueue } from "./queue/task-lane-queue";

// Web Search
import { SearchProviderRegistry } from "./web-search/provider-registry";
import { WebSearchQueue } from "./web-search/queue";
import { DuckDuckGoProvider } from "./web-search/providers/duckduckgo";
import { TavilyProvider } from "./web-search/providers/tavily";
import { BraveSearchProvider } from "./web-search/providers/brave";
import { SerpApiProvider } from "./web-search/providers/serpapi";
import { KagiSearchProvider } from "./web-search/providers/kagi";

// Chat blocks
import { ChatBlockRegistry } from "./ui/chat-blocks/registry";
import { setChatBlockRegistry } from "./chat/message-pipeline";

// Memory approval
import { PendingMemoryManager } from "./memory/pending-memory-manager";

// Template variables
import { TemplateVariableRegistry, registerBuiltinVars } from "./template-vars";

// UI
import { NotorChatView, CHAT_VIEW_TYPE } from "./ui/chat-view";
import { OrchestrationRunTreeView, ORCHESTRATION_RUN_TREE_VIEW_TYPE } from "./ui/run-tree-view";
import { EffectiveConfigInspectorView, INSPECTOR_VIEW_TYPE } from "./ui/effective-config-inspector";
import { resolveNote } from "./utils/resolve-note";

const log = logger("Main");

export default class NotorPlugin extends Plugin {
	settings: NotorSettings;

	/**
	 * Vault root absolute path (Electron-specific).
	 *
	 * Consolidates the `basePath` adapter cast that previously appeared
	 * at multiple call sites. Returns empty string when unavailable
	 * (e.g. mobile/web where `basePath` doesn't exist).
	 *
	 * @see specs/05-user-tools/tasks.md — EXT-017
	 */
	get vaultRootPath(): string {
		return (this.app.vault.adapter as { basePath?: string }).basePath ?? "";
	}

	// Lazily initialized components (heavy init deferred until first use)
	private _providerRegistry?: ProviderRegistry;
	private _toolRegistry?: ToolRegistry;
	private _toolDispatcher?: ToolDispatcher;
	private _historyManager?: HistoryManager;
	private _checkpointStorage?: CheckpointStorage;
	private _checkpointManager?: CheckpointManager;
	private _sharedCheckpointManager?: CheckpointManager;
	private _systemPromptBuilder?: SystemPromptBuilder;
	private _vaultRuleManager?: VaultRuleManager;
	private _templateRegistry?: TemplateVariableRegistry;
	/**
	 * Unified orchestrator registry — maps leaf ID to its orchestrator.
	 *
	 * All panels are equal. The factory in `registerView` creates an
	 * orchestrator for each panel and stores it here.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 4.1
	 */
	private _orchestrators = new Map<string, ChatOrchestrator>();

	/**
	 * Cross-orchestrator active conversation session set.
	 *
	 * Used by `_sessionGuard` to prevent two orchestrators from
	 * processing the same conversation concurrently.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 4.3
	 */
	private _activeConversationSessions = new Set<string>();

	/**
	 * Global set of `updateActivityIndicator` callbacks — one per open chat panel.
	 *
	 * When any orchestrator's session set changes, every panel's indicator is
	 * refreshed so all panels see the full global session pool.
	 */
	private _activityIndicatorCallbacks = new Set<() => void>();

	/**
	 * Session guard implementation backed by `_activeConversationSessions`.
	 *
	 * Passed to each orchestrator at construction time.
	 */
	private _sessionGuard: SessionGuard = {
		isActive: (id: string) => this._activeConversationSessions.has(id),
		register: (id: string) => { this._activeConversationSessions.add(id); },
		unregister: (id: string) => { this._activeConversationSessions.delete(id); },
	};

	/**
	 * Leaf ID of the last focused chat panel.
	 *
	 * Populated by the `active-leaf-change` listener (A1.3). Used by
	 * `getActiveOrchestrator()` as a fallback when no chat panel is
	 * currently focused (e.g. user is in a markdown editor).
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 4.9
	 */
	private _lastFocusedChatLeafId?: string;

	/** Conversation-scoped webview leaf cache (maps conversation UUID → WorkspaceLeaf). */
	private _webviewLeafCache = new Map<string, WorkspaceLeaf>();

	/** Guard to prevent multiple wireView() calls from re-registering the persona name change callback. */
	private _noteOpener?: NoteOpener;
	private _staleTracker?: StaleContentTracker;
	private _personaManager?: PersonaManager;
	private _subAgentManager?: SubAgentManager;
	private _pendingMemoryManager?: PendingMemoryManager;
	private _extensionManager?: ExtensionManager;
	private _chatBlockRegistry?: ChatBlockRegistry;
	private _tempOutputSpiller?: import("./shell/temp-output-spiller").TempOutputSpiller;
	private _settingTab?: NotorSettingTab;

	/**
	 * Active detached sub-agent registry.
	 *
	 * Tracks `AbortController`s for sub-agents spawned from extension code
	 * via `utils.runSubAgent({ detached: true })`. On plugin unload, all
	 * registered controllers are aborted so background sub-agents stop cleanly.
	 */
	private _detachedSubAgents = new Set<AbortController>();

	/** Register a detached sub-agent controller so it is cleaned up on unload. */
	registerDetachedSubAgent(controller: AbortController): void {
		this._detachedSubAgents.add(controller);
	}

	/** Unregister a detached sub-agent controller (called in the finally block after completion). */
	unregisterDetachedSubAgent(controller: AbortController): void {
		this._detachedSubAgents.delete(controller);
	}

	// -----------------------------------------------------------------------
	// Phase 4.1: MCP (ARCH-005)
	// -----------------------------------------------------------------------

	/**
	 * MCP connection hub — manages all MCP server connections.
	 *
	 * Initialized on plugin load (async, non-blocking). Cleanup registered
	 * via this.register() so all connections are closed on unload.
	 *
	 * @see specs/04-mcp/tasks.md — ARCH-005
	 */
	private _mcpHub?: McpHub;

	/**
	 * Per-lane FIFO serialization queue — rate-limits async operations
	 * by lane key. Used by web search, MCP dispatch, and user extensions.
	 *
	 * @see specs/ZZ-misc/task-lane-queue-design.md
	 */
	private _taskLaneQueue?: TaskLaneQueue;

	/**
	 * Web search provider registry — maps provider type strings to singleton
	 * provider instances (DuckDuckGo, Tavily, Brave, SerpApi).
	 *
	 * @see specs/ZZ-misc/multi-provider-web-search-design.md — Section 6
	 */
	private _searchProviderRegistry?: SearchProviderRegistry;

	/**
	 * Web search queue — orchestrates provider selection, round-robin,
	 * and fallback on top of the shared TaskLaneQueue.
	 *
	 * @see specs/ZZ-misc/multi-provider-web-search-design.md — Section 5.2
	 */
	private _webSearchQueue?: WebSearchQueue;

	/** Cached workflow discovery results (C-008). In-memory only — always re-discovered from vault. */
	private _discoveredWorkflows: Workflow[] = [];

	/**
	 * Cached orchestration-flow discovery results. In-memory only — re-discovered
	 * from vault via `rescanFlows()`. Read synchronously by the `VaultEventScheduler`
	 * (which is sync) to register `notor-schedule` cron jobs. Empty when
	 * `orchestration_enabled` is off.
	 */
	private _discoveredFlows: OrchestrationFlow[] = [];

	/** Debounce timer for vault-triggered workflow rescans. */
	private _workflowRescanTimer: ReturnType<typeof setTimeout> | null = null;

	/** Debounce timer for vault-triggered orchestration-flow rescans. */
	private _flowRescanTimer: ReturnType<typeof setTimeout> | null = null;

	/** Debounce timer for extension file change auto-reload (EXT-024). */
	private _extensionChangeTimer: ReturnType<typeof setTimeout> | null = null;

	/** Reference to the most recent extension error Notice (for cleanup on unload). */
	private _extensionStaleNotice: Notice | null = null;

	/** Debounce timer for persona file change auto-reload. */
	private _personaChangeTimer: ReturnType<typeof setTimeout> | null = null;

	/** Reference to the most recent persona error Notice (for cleanup on unload). */
	private _personaStaleNotice: Notice | null = null;

	// -----------------------------------------------------------------------
	// Group F: Vault event hook components (F-023)
	// -----------------------------------------------------------------------

	/** Tag shadow cache for on_tag_change diff computation (F-014). */
	private _tagShadowCache?: TagShadowCache;

	/** Tag change suppression manager to prevent re-trigger from Notor tools (F-015). */
	private _tagSuppression?: TagChangeSuppressionManager;

	/** Per-event-type, per-note-path debounce engine (F-005). */
	private _vaultEventDebounce?: VaultEventDebounce;

	/** Execution chain tracker for infinite loop prevention (F-006). */
	private _executionChainTracker?: ExecutionChainTracker;

	/** Manual save detector — monkey-patches executeCommandById (F-011). */
	private _manualSaveDetector?: ManualSaveDetector;

	/** Cron-based scheduler for on_schedule hooks (F-013). */
	private _vaultEventScheduler?: VaultEventScheduler;

	/** Lazy listener manager — registers/unregisters Obsidian event listeners (F-007). */
	private _vaultEventListenerManager?: VaultEventListenerManager;

	/** Concurrency manager for background workflow executions (F-020). */
	private _workflowConcurrencyManager?: WorkflowConcurrencyManager;

	/** Shared system sleep/wake detector (MCP reconnect + workflow reconciliation). */
	private _sleepWakeDetector?: SleepWakeDetector;

	/** Per-hook debounce delay manager (Phase 5). */
	private _hookDelayManager?: HookDelayManager;

	// -----------------------------------------------------------------------
	// Group H: Workflow activity tracker (H-006)
	// -----------------------------------------------------------------------

	/**
	 * Workflow activity tracker — UI-oriented view of background execution state.
	 *
	 * Wraps the `WorkflowConcurrencyManager` to provide sorted, filtered,
	 * bounded entry lists and change notification callbacks for the activity
	 * indicator UI. Initialized alongside the concurrency manager in
	 * `_initVaultEventHooks()` and destroyed on plugin unload.
	 *
	 * @see specs/03-workflows-personas/tasks/group-h-tasks.md — H-001, H-006
	 */
	private _workflowActivityTracker?: WorkflowActivityTracker;

	/**
	 * In-memory orchestration flow-run registry feeding the unified activity
	 * indicator's typed `flow-run` entries (POL-004). Session-file-backed: an
	 * entry is upserted when a flow launches (status `active`) and on finalize
	 * (terminal status), and re-seeded from the recovery scan on reload, so a
	 * recovered run still surfaces. Keyed by session id.
	 */
	private _flowRunRegistry: FlowRunEntry[] = [];

	/**
	 * Upsert a flow-run entry in the indicator registry (POL-004), then notify the
	 * tracker so the open dropdown re-renders. Called by the orchestration launcher
	 * on start/finalize and by the recovery scan.
	 */
	upsertFlowRun(entry: FlowRunEntry): void {
		const i = this._flowRunRegistry.findIndex((e) => e.sessionId === entry.sessionId);
		if (i >= 0) this._flowRunRegistry[i] = entry;
		else this._flowRunRegistry.unshift(entry);
		// Bound the registry so a long session doesn't grow it unboundedly.
		if (this._flowRunRegistry.length > 50) this._flowRunRegistry.length = 50;
		this._workflowActivityTracker?.notifyChange();
	}

	// -----------------------------------------------------------------------
	// Group G: Workflow hook override manager (G-003/G-005)
	// -----------------------------------------------------------------------

	/**
	 * Singleton workflow hook override manager.
	 *
	 * Tracks per-conversation workflow-scoped hook overrides (FR-52).
	 * Instantiated once and shared by the orchestrator and hook dispatch
	 * functions. Destroyed on plugin unload via `destroy()`.
	 *
	 * @see specs/03-workflows-personas/tasks/group-g-tasks.md — G-003, G-005
	 */
	private _workflowHookOverrideManager?: WorkflowHookOverrideManager;

	// -----------------------------------------------------------------------
	// Plugin lifecycle
	// -----------------------------------------------------------------------

	async onload() {
		log.info("Plugin loading", { version: this.manifest.version });

		// 1. Load settings (fast — required immediately)
		await this.loadSettings();
		setLogLevel(this.settings.log_level);
		log.debug("Settings loaded", { settings: this.settings });

		// 2. Register the settings tab
		this._settingTab = new NotorSettingTab(this.app, this);
		this.addSettingTab(this._settingTab);

		// 2b. Initialize temp output spiller (desktop only, when enabled).
		if (Platform.isDesktopApp && this.settings.output_spillover_enabled) {
			const { TempOutputSpiller } = await import("./shell/temp-output-spiller");
			this._tempOutputSpiller = new TempOutputSpiller();
			await this._tempOutputSpiller.ensureSpillDir();
			this._tempOutputSpiller.cleanupStale().catch((e) => {
				log.warn("Stale spillover cleanup failed", { error: String(e) });
			});
		}

		// 2c. Instantiate ChatBlockRegistry and wire into the message pipeline.
		// Must happen before any view or orchestrator creation so that
		// toChatMessages() has the registry available for extension_block translation.
		this._chatBlockRegistry = new ChatBlockRegistry();
		setChatBlockRegistry(this._chatBlockRegistry);

		// 3. Register the chat panel view type (A1.8).
		// Every panel gets its own orchestrator via createOrchestrator().
		// Conversation loading is deferred to setState() or a setTimeout(0)
		// fallback — wireView only wires callbacks.
		// @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 4.2
		this.registerView(CHAT_VIEW_TYPE, (leaf) => {
			const view = new NotorChatView(leaf, this);

			// Destroy any stale orchestrator at this leaf ID (Amendment R2-7).
			// The factory is synchronous so the stale destroy() is fire-and-forget.
			// If the stale orchestrator has an active session, sessionGuard.isActive()
			// returns true for that conversation for up to ~2s while the destroy
			// drains, causing a transient "being processed in another panel" notice
			// if the user immediately re-sends. Recoverable by retrying.
			const staleOrch = this._orchestrators.get(leaf.id);
			if (staleOrch) {
				this._orchestrators.delete(leaf.id);
				staleOrch.destroy().catch((e) => {
					log.warn("Stale orchestrator destroy failed", { error: String(e) });
				});
			}

			// Create a fresh orchestrator for this panel
			const orchestrator = this.createOrchestrator();
			this._orchestrators.set(leaf.id, orchestrator);
			this.wireView(view, orchestrator);

			// Schedule setTimeout(0) fallback for conversation loading
			// (Amendment R2-2). setState() fires synchronously after the
			// factory returns and will set isConversationLoaded = true;
			// without this guard, every panel open fires a redundant load.
			view._loadFallbackTimeout = setTimeout(() => {
				if (!view.isConversationLoaded) {
					void this.loadConversation(view, orchestrator);
				}
			}, 0);

			return view;
		});

		// 3a-ii. Register the unified run-tree view (POL-003 / FR-178). A read-only
		// consumer of orchestration_edges + the sub-agent parent_conversation_id
		// scalar; opened from a run_flow/sub-agent card, the activity indicator, or a
		// progress Notice via openRunTreeView().
		this.registerView(
			ORCHESTRATION_RUN_TREE_VIEW_TYPE,
			(leaf) => new OrchestrationRunTreeView(leaf, this),
		);

		// 3b. Register the tool config inspector view type (UI-003 / FR-88)
		// A4.5: Inspector follows focus changes via resolver callback
		this.registerView(INSPECTOR_VIEW_TYPE, (leaf) => {
			const inspectorView = new EffectiveConfigInspectorView(leaf);
			inspectorView.setOrchestrator(this.getActiveOrchestrator());
			inspectorView.setOrchestratorResolver((targetLeaf) => {
				return this._orchestrators.get(targetLeaf.id) ?? null;
			});
			return inspectorView;
		});

		// 4. Register commands
		registerCommands(this);

		// 5. Register active-leaf-change listener so the auto-context module
		// can track the last-focused file even when the chat panel (or another
		// non-file view) has focus at send time (ACI-005).
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				const filePath = (leaf?.view as { file?: { path: string } })?.file?.path;
				if (filePath) {
					notifyFileLeafActivated(filePath);
				}
				// Intentionally NOT clearing the cache on non-file leaf changes —
				// that lets us recover the last active file when the user switches
				// to the chat panel (or any other non-file view).
			})
		);

		// 5b. Track the last focused chat panel leaf for command routing.
		// When a non-chat view gains focus, the last chat leaf ID is retained
		// so getActiveOrchestrator() can route to the correct panel.
		// @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 4.9
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof NotorChatView) {
					this._lastFocusedChatLeafId = leaf.id;
					// Sync ToolDispatcher persona to the focused panel's conversation
					// so auto-approve resolution uses the correct persona context.
					const orch = this._orchestrators.get(leaf.id);
					const conv = orch?.getDisplayedConversation();
					this.getToolDispatcher().setActivePersonaName(conv?.persona_name ?? null);
				}
			})
		);

		// 6. Start vault rule manager (watches rules directory for changes)
		// This is lightweight — just sets up file watchers
		this.getVaultRuleManager().start();

		// 6b. One-time global persona restore from settings (Amendment R5 / A1.7).
		// Ensures the persona label and provider/model state are restored when
		// the plugin loads. Previously called per-wireView for non-secondary
		// panels; now a single global call.
		this.getPersonaManager().restoreFromSettings().catch((e) => {
			log.warn("Failed to restore active persona from settings", { error: String(e) });
		});

		// 6c. Register obsidian://notor protocol handler for deep-links.
		this.registerObsidianProtocolHandler("notor", async (params) => {
			log.info("Protocol handler invoked", { params });
			// Obsidian reserves 'action' for its own routing, so we use 'do' as the verb param.
			const verb = params.do;
			if (verb === "open-conversation") {
				const id = params.id;
				if (!id) {
					new Notice("Missing conversation ID in link");
					return;
				}
				await this.openChatPanel();
				const orchestrator = this.getActiveOrchestrator();
				if (!orchestrator) {
					new Notice("No active chat panel");
					return;
				}
				const found = await orchestrator.switchToConversationById(id);
				if (!found) {
					new Notice("Conversation not found — it may have been deleted");
				}
			} else if (params.id) {
				// Shorthand: obsidian://notor?id=<uuid> — open conversation directly
				await this.openChatPanel();
				const orchestrator = this.getActiveOrchestrator();
				if (!orchestrator) {
					new Notice("No active chat panel");
					return;
				}
				const found = await orchestrator.switchToConversationById(params.id);
				if (!found) {
					new Notice("Conversation not found — it may have been deleted");
				}
			} else {
				log.warn("Unknown protocol params", { params });
			}
		});

		// 6d. Markdown post-processor: intercept obsidian://notor links in vault notes
		// so they work reliably without depending on the OS protocol round-trip.
		this.registerMarkdownPostProcessor((el) => {
			const prefix = "obsidian://notor?";
			const links = el.querySelectorAll<HTMLAnchorElement>("a.external-link");
			for (const link of links) {
				const href = link.getAttribute("href") ?? "";
				if (!href.startsWith(prefix)) continue;

				const params = new URLSearchParams(href.slice(prefix.length));
				const conversationId = params.get("id");
				if (!conversationId) continue;

				link.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					void this.openChatPanel().then(() => {
						const orchestrator = this.getActiveOrchestrator();
						if (!orchestrator) {
							new Notice("No active chat panel");
							return;
						}
						void orchestrator.switchToConversationById(conversationId).then((found) => {
							if (!found) {
								new Notice("Conversation not found — it may have been deleted");
							}
						});
					});
				});

				link.classList.remove("external-link");
				link.classList.add("notor-conversation-link");
				link.removeAttribute("href");
			}
		});

		// 7. Initialize Group F: vault event hook components (F-023).
		// Heavy init (tag shadow cache) is deferred to onLayoutReady.
		this._initVaultEventHooks();

		// 7b. Eagerly create ToolRegistry + ToolDispatcher so they exist
		// before MCP servers fire onStatusChange("connected"). Without
		// this, fast-connecting stdio servers silently drop their tools.
		this.getToolRegistry();
		this.getToolDispatcher();

		// 8. Initialize MCP hub (ARCH-005).
		// Async, non-blocking — plugin load completes without waiting for
		// MCP server connections. Cleanup registered via this.register().
		this._initMcpHub();

		// 9. Kick off initial workflow discovery (C-008).
		// Deferred until layout is ready — vault file index must be fully
		// populated before getAbstractFileByPath() can resolve the
		// workflows directory. This is a standard Obsidian pattern.
		this.app.workspace.onLayoutReady(() => {
			try {
				this.registerWorkflowVaultWatcher();
			} catch (e) {
				log.warn("Workflow vault watcher registration failed", { error: String(e) });
			}

			// Auto-inject frontmatter into unidentified workflow files, then
			// run initial discovery. processFrontMatter atomically updates the
			// metadata cache, so rescanWorkflows() sees injected frontmatter
			// immediately after the promise resolves.
			autoInjectUnidentifiedWorkflows(
				this.app,
				this.app.vault,
				this.app.metadataCache,
				this.settings.notor_dir
			).then((injectedPaths) => {
				if (injectedPaths.length > 0) {
					new Notice(
						`Auto-identified ${injectedPaths.length} workflow${injectedPaths.length > 1 ? "s" : ""} in workflows/`
					);
				}
				try {
					this.rescanWorkflows();
				} catch (e) {
					log.warn("Post-injection workflow rescan failed", { error: String(e) });
				}
			}).catch((e) => {
				log.warn("Auto-inject workflow frontmatter failed", { error: String(e) });
				try {
					this.rescanWorkflows();
				} catch (e2) {
					log.warn("Fallback initial workflow rescan failed", { error: String(e2) });
				}
			});

			// EXT-017: Discover and compile user extensions (tools + automations).
			// Scaffold defaults for all 20 built-in tools are injected here;
			// vault-authored overrides win by last-write-wins.
			// isInitialLoad=true skips dispatcher registration during reload().
			// However, if the dispatcher was already created (e.g., by workspace
			// restore triggering wireView() → createOrchestrator() → getToolDispatcher()
			// before this async reload completes), we must sync it afterwards.
			this.getExtensionManager().reload(true).then(() => {
				// Sync dispatcher if it was already lazily created before reload finished.
				// The dispatcher populates from registry.getAll() at creation time, but
				// if created before reload, it only had use_subagent. Re-register all
				// extension tools now.
				if (this._toolDispatcher) {
					const registry = this.getToolRegistry();
					for (const tool of registry.getAll()) {
						if (!this._toolDispatcher.hasTool(tool.name)) {
							this._toolDispatcher.registerTool(tool);
						}
					}
				}

				// Populate sub-agent profile cache now that all extension tools are registered.
				const useSubagentTool = this.getToolRegistry().get(USE_SUBAGENT_TOOL_NAME);
				if (useSubagentTool && useSubagentTool instanceof UseSubagentTool) {
					useSubagentTool.refreshVisibleProfiles().catch((e) =>
						log.warn("Failed to load initial sub-agent profiles", { error: String(e) })
					);
				}

				// Re-evaluate vault event listeners to pick up automation triggers
				if (this._vaultEventListenerManager) {
					this._vaultEventListenerManager.evaluateListeners();
				}
				// Sync scheduler to pick up on_schedule automations
				if (this._vaultEventScheduler) {
					const enabledScheduleHooks = this.settings.vault_event_hooks.on_schedule.filter(
						(h) => h.enabled
					);
					this._vaultEventScheduler.syncJobs(enabledScheduleHooks);
				}

				// EXT-024: Register file watchers after initial discovery
				this.registerExtensionVaultWatcher();

				// Register persona file watchers for auto-refresh
				this.registerPersonaVaultWatcher();

				// Validate memory presets on load — disable feature if required presets are missing.
				this.validateMemoryPresetsOnLoad();
			}).catch((e) => {
				log.warn("Initial extension discovery failed", { error: String(e) });
			});

			// Enforce chat history retention policy (age + size limits).
			// Fire-and-forget — non-blocking, runs once per startup.
			this.getHistoryManager().enforceRetention().catch((e) => {
				log.warn("History retention enforcement failed", { error: String(e) });
			});

			// INT-005 (FR-125): scan for interrupted orchestration sessions and
			// resume them. Gated on orchestration_enabled; fire-and-forget so it
			// never blocks load. Loud recovery errors surface as Notices.
			if (this.settings.orchestration_enabled) {
				import("./orchestration/launch")
					.then(({ recoverOrchestrations }) => recoverOrchestrations(this))
					.catch((e) => log.warn("Orchestration recovery scan failed", { error: String(e) }));
			}
		});

		log.info("Plugin loaded");
	}

	onunload() {
		log.info("Plugin unloading");

		// Abort all active sessions so their response loops can flush JSONL
		// writes before infrastructure singletons are torn down.
		// Fire-and-forget since onunload() is synchronous — the 2s timeout
		// in destroy() prevents hanging. (A4.8)
		for (const orch of this._orchestrators.values()) {
			orch.destroy().catch((e) => {
				log.error("Orchestrator destroy failed", { error: String(e) });
			});
		}
		this._orchestrators.clear();

		// Clear the last-active file path cache on unload
		notifyFileLeafActivated(null);

		// Stop vault rule manager file watchers
		this._vaultRuleManager?.stop();

		// Clear cached workflow discovery results (C-008)
		this._discoveredWorkflows = [];

		// Group F: Tear down vault event hook components in reverse order (F-023)
		this._vaultEventListenerManager?.destroy();
		this._vaultEventScheduler?.destroy();
		this._manualSaveDetector?.destroy();
		this._hookDelayManager?.destroy();
		this._tagSuppression?.destroy();
		this._vaultEventDebounce?.destroy();
		// this._executionChainTracker — stateless, nothing to destroy
		this._tagShadowCache?.destroy();
		this._workflowConcurrencyManager?.destroy();
		this._sleepWakeDetector?.destroy();

		// Group H: Destroy workflow activity tracker (H-006)
		this._workflowActivityTracker?.destroy();
		log.info("WorkflowActivityTracker destroyed");

		log.info("Group F vault event hook components destroyed");

		// Group G: Clear all workflow hook override state (G-005)
		this._workflowHookOverrideManager?.destroy();
		log.info("WorkflowHookOverrideManager destroyed");

		// Destroy TaskLaneQueue — rejects all pending waiters
		this._taskLaneQueue?.destroy();
		log.info("TaskLaneQueue destroyed");

		// Abort all active detached sub-agents spawned via utils.runSubAgent({ detached: true })
		for (const controller of this._detachedSubAgents) {
			controller.abort();
		}
		this._detachedSubAgents.clear();
		log.info("Detached sub-agents aborted");

		// Clean up spillover temp files
		this._tempOutputSpiller?.cleanup().catch((e) => {
			log.error("TempOutputSpiller cleanup failed", { error: String(e) });
		});

		// EXT-017: Destroy extension manager (unregisters tools + path params)
		this._extensionManager?.destroy();
		log.info("ExtensionManager destroyed");

		// EXT-024: Clear extension watcher timer and stale Notice
		if (this._extensionChangeTimer !== null) {
			clearTimeout(this._extensionChangeTimer);
			this._extensionChangeTimer = null;
		}
		this._extensionStaleNotice?.hide();
		this._extensionStaleNotice = null;

		// Clear persona watcher timer and stale Notice
		if (this._personaChangeTimer !== null) {
			clearTimeout(this._personaChangeTimer);
			this._personaChangeTimer = null;
		}
		this._personaStaleNotice?.hide();
		this._personaStaleNotice = null;

		// All DOM elements, intervals, and event listeners registered via
		// this.register* / this.registerEvent / this.registerDomEvent are
		// automatically cleaned up by Obsidian when the plugin unloads.

		// Best-effort draft persistence: stash any unsent input text so it can
		// be restored when the user returns to the same conversation on next load.
		const activeOrch = this.getActiveOrchestrator();
		if (activeOrch) {
			const currentConv = activeOrch.getConversationManager().getActiveConversation();
			const view = activeOrch.getView();
			const draftText = view?.getInputText()?.trim() ?? "";
			if (currentConv && draftText) {
				void this.loadData().then((rawData) => {
					const data = (rawData ?? {}) as Record<string, unknown>;
					data.pending_draft = { conversationId: currentConv.id, text: draftText };
					return this.saveData(data);
				});
			}
		}

		log.info("Plugin unloaded");
	}

	// -----------------------------------------------------------------------
	// Settings
	// -----------------------------------------------------------------------

	async loadSettings() {
		const defaults = createDefaultSettings(this.app.vault.configDir);
		const loaded = Object.assign({}, defaults, await this.loadData());

		// Deep-merge keyed records so new default entries survive
		// when the saved object replaces defaults via Object.assign.
		loaded.auto_approve = { ...defaults.auto_approve, ...loaded.auto_approve };
		loaded.hooks = { ...defaults.hooks, ...loaded.hooks };

		if (this.settings) {
			// Mutate the existing object so all components that captured a reference
			// (e.g. ReadFileTool, ExecuteCommandTool) see the updated values.
			Object.assign(this.settings, loaded);
		} else {
			this.settings = loaded;
		}

		await runAllMigrations({
			settings: this.settings,
			app: this.app,
			saveSettings: () => this.saveSettings(),
			loadData: () => this.loadData(),
			saveData: (data) => this.saveData(data),
		});
	}


	// -----------------------------------------------------------------------
	// Group F: Vault event hook initialization (F-023)
	// -----------------------------------------------------------------------

	/**
	 * Initialize all Group F vault event hook components and wire them together.
	 *
	 * Initialization order per F-023 acceptance criteria:
	 * 1. TagShadowCache (deferred init via onLayoutReady)
	 * 2. VaultEventDebounce
	 * 3. ExecutionChainTracker
	 * 4. ManualSaveDetector (install)
	 * 5. TagChangeSuppressionManager
	 * 6. WorkflowConcurrencyManager
	 * 7. VaultEventScheduler
	 * 8. VaultEventListenerManager (with handler registrations)
	 * 9. evaluateListeners() (after layout ready)
	 *
	 * All periodic cleanups are registered via this.registerInterval() for
	 * proper Obsidian lifecycle management.
	 *
	 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-023
	 */
	private _initVaultEventHooks(): void {
		// Step 1: Tag shadow cache — init deferred to onLayoutReady
		const tagShadowCache = new TagShadowCache();
		this._tagShadowCache = tagShadowCache;

		// Step 2: Debounce engine
		const debounceMs = (this.settings.vault_event_debounce_seconds ?? 5) * 1000;
		const vaultEventDebounce = new VaultEventDebounce(debounceMs);
		this._vaultEventDebounce = vaultEventDebounce;
		vaultEventDebounce.startCleanup(
			(cb, ms) => this.registerInterval(window.setInterval(cb, ms))
		);

		// Step 3: Execution chain tracker (stateless factory — no cleanup needed)
		const executionChainTracker = new ExecutionChainTracker();
		this._executionChainTracker = executionChainTracker;

		// Step 4: Manual save detector
		const manualSaveDetector = new ManualSaveDetector();
		this._manualSaveDetector = manualSaveDetector;
		manualSaveDetector.install(this.app);
		manualSaveDetector.startCleanup(
			(cb, ms) => this.registerInterval(window.setInterval(cb, ms))
		);

		// Step 5: Tag change suppression manager
		const tagSuppression = new TagChangeSuppressionManager();
		this._tagSuppression = tagSuppression;
		tagSuppression.startCleanup(
			(cb, ms) => this.registerInterval(window.setInterval(cb, ms))
		);

		// Step 6: Workflow concurrency manager
		const workflowConcurrencyManager = new WorkflowConcurrencyManager(
			this.settings.workflow_concurrency_limit ?? 3
		);
		this._workflowConcurrencyManager = workflowConcurrencyManager;

		// Step 6a: Hook delay manager (Phase 5 per-hook debounce)
		const hookDelayManager = new HookDelayManager();
		this._hookDelayManager = hookDelayManager;

		// Step 6b: Workflow activity tracker (H-006)
		// Wraps the concurrency manager to provide UI-focused views and
		// change notifications for the activity indicator. Wired as the
		// concurrency manager's state change listener so that every submit,
		// status update, or completion triggers tracker.notifyChange().
		const workflowActivityTracker = new WorkflowActivityTracker(
			workflowConcurrencyManager,
			this.settings.workflow_activity_indicator_count ?? 5
		);
		this._workflowActivityTracker = workflowActivityTracker;
		workflowConcurrencyManager.setOnStateChange(() => {
			workflowActivityTracker.notifyChange();
		});
		// POL-004: feed orchestration flow runs into the ONE unified indicator as
		// typed `flow-run` entries (session-file-backed via the in-memory registry,
		// re-seeded by the recovery scan). A flow-run entry click opens the run-tree.
		workflowActivityTracker.setFlowRunSource(() => this._flowRunRegistry);

		// Step 6c: Shared sleep/wake detector. One heartbeat timer feeds both
		// MCP reconnection (wired in _initMcpHub) and background-workflow
		// reconciliation. On wake, clear executions whose LLM stream was frozen
		// by the system sleep so the next trigger isn't blocked by the
		// single-instance "already running" guard.
		const sleepWakeDetector = new SleepWakeDetector();
		this._sleepWakeDetector = sleepWakeDetector;
		sleepWakeDetector.start((cb, ms) =>
			this.registerInterval(window.setInterval(cb, ms))
		);
		sleepWakeDetector.onWake((gapMs) => {
			// Short settle delay mirrors the MCP reconnect path — give the
			// event loop a moment to stabilise before sweeping.
			window.setTimeout(() => {
				const { cleared, waitingApproval } =
					workflowConcurrencyManager.reconcileAfterWake(gapMs);
				if (cleared > 0) {
					log.info("Cleared stranded workflow executions after sleep", { cleared });
					new Notice(
						`Cleared ${cleared} stranded workflow execution${cleared === 1 ? "" : "s"} after system sleep.`
					);
				}
				if (waitingApproval > 0) {
					log.info("Background conversations awaiting approval after sleep", {
						waitingApproval,
					});
					new Notice(
						`${waitingApproval} background conversation${waitingApproval === 1 ? " is" : "s are"} waiting for your approval.`
					);
				}
			}, 2_000);
		});

		// Step 7: Vault event scheduler (cron jobs for on_schedule hooks)
		const vaultEventScheduler = new VaultEventScheduler();
		this._vaultEventScheduler = vaultEventScheduler;

		// Step 8: Build the dispatcher deps object (assembled here for access
		// by handler closures). Orchestrator resolved lazily via
		// getActiveOrchestrator() so vault events route to the focused panel.
		const getDispatcherDeps = (): DispatcherDeps => {
			return {
				app: this.app,
				vault: this.app.vault,
				metadataCache: this.app.metadataCache,
				getSettings: () => this.settings,
				vaultRootPath: this.vaultRootPath,
				concurrencyManager: workflowConcurrencyManager,
				orchestrator: this.getActiveOrchestrator(),
				personaManager: this._personaManager,
				chainTracker: executionChainTracker,
				// EXT-017: Wire extension automation accessor + executor for vault event hooks.
				// Uses lazy accessor so it returns [] until extensions are discovered.
				getExtensionAutomations: (trigger) => this.getExtensionManager().getAutomationsForTrigger(trigger),
				executeExtensionAutomation: (automation, context) => this.getExtensionManager().executeAutomation(automation, context),
				templateRegistry: this.getTemplateRegistry(),
				hookDelayManager,
				createHeadlessOrchestrator: () => this.createHeadlessOrchestrator(),
				// FEAT-012: hook-triggered orchestration launch (FR-119b). Present
				// only when orchestration_enabled — otherwise the dispatcher skips
				// the action with a diagnostic Notice.
				launchOrchestration: this.settings.orchestration_enabled
					? async (flowNameOrDir: string, objective: string) => {
							const { FlowDefinitionParser } = await import("./orchestration/flow-parser");
							const { launchOrchestration } = await import("./orchestration/launch");
							const parser = new FlowDefinitionParser(
								this.app.vault,
								this.app.metadataCache,
								this.settings.notor_dir,
							);
							// Resolve by directory if it looks like a path, else by flow name.
							const flows = await parser.discoverFlows();
							const ref = flowNameOrDir.trim();
							const match = flows.find(
								(f) => f.flow.name === ref || f.flow.flowDir === ref || f.flow.flowDir.endsWith(`/${ref}`),
							);
							if (!match) {
								new Notice(`Orchestration flow '${ref}' not found; hook skipped.`);
								return;
							}
							await launchOrchestration(this, match.flow, objective, { origin: "hook" });
						}
					: undefined,
			};
		};

		// Step 9: Build handler deps (assembled for handler functions)
		const handlerDeps: VaultEventHandlerDeps = {
			debounce: vaultEventDebounce,
			chainTracker: executionChainTracker,
			manualSaveDetector,
			tagShadowCache,
			tagSuppression,
			dispatch: (hooks, context, chain) => {
				dispatchVaultEventHooks(hooks, context, chain, getDispatcherDeps());
			},
			getSettings: () => this.settings,
			getDiscoveredWorkflows: () => this._discoveredWorkflows,
		};

		// Step 10: Vault event listener manager
		const listenerManager = new VaultEventListenerManager(
			this,
			() => this.settings,
			() => this._discoveredWorkflows
		);
		this._vaultEventListenerManager = listenerManager;

		// Register handler callbacks for all event types
		listenerManager.setEventHandler("on_note_open", {
			type: "on_note_open",
			handler: (file) => handleNoteOpen(file, handlerDeps),
		});
		listenerManager.setEventHandler("on_note_create", {
			type: "on_note_create",
			handler: (file) => handleNoteCreate(file, handlerDeps),
		});
		listenerManager.setEventHandler("on_save", {
			type: "on_save",
			handler: (file) => handleModify(file, handlerDeps),
		});
		listenerManager.setEventHandler("on_manual_save", {
			type: "on_manual_save",
			// on_manual_save is dispatched from within handleModify (F-010);
			// the shared modify listener calls handleModify which internally
			// calls handleManualSave when the save detector flags it.
			handler: (file) => handleModify(file, handlerDeps),
		});
		listenerManager.setEventHandler("on_tag_change", {
			type: "on_tag_change",
			handler: (file, data, cache) => handleMetadataChanged(file, data, cache, handlerDeps),
		});
		listenerManager.setEventHandler("on_schedule", {
			type: "on_schedule",
			handler: null,
		});

		// Wire the dispatch function and workflow discovery accessor into the scheduler
		vaultEventScheduler.setDispatch(
			(hooks, context, chain) => {
				dispatchVaultEventHooks(hooks, context, chain, getDispatcherDeps());
			},
			() => this._discoveredWorkflows
		);

		// EXT-017: Wire extension automation accessors into listener manager and scheduler.
		// Uses lazy accessors so they return [] until extensions are discovered.
		// After initial reload() completes, evaluateListeners() is called again to
		// register listeners for new automation vault event triggers.
		listenerManager.setExtensionAutomations(
			(trigger: string) => this.getExtensionManager().getAutomationsForTrigger(trigger as AutomationTrigger)
		);
		vaultEventScheduler.setExtensionAutomations(
			(trigger) => this.getExtensionManager().getAutomationsForTrigger(trigger),
			(automation, context) => this.getExtensionManager().executeAutomation(automation, context),
		);
		vaultEventScheduler.setSettingsAccessor(() => this.settings);

		// Wire the orchestration-flow accessor + launcher into the scheduler so
		// flows with a `notor-schedule` get cron jobs. The launcher resolves a
		// fresh definition from disk (the cached flow may be stale) and launches
		// with `origin: "schedule"`. Gated on `orchestration_enabled` — when off,
		// `_discoveredFlows` is already empty so no jobs are registered.
		vaultEventScheduler.setDiscoveredFlows(
			() => this._discoveredFlows,
			async (flow) => {
				if (!this.settings.orchestration_enabled) return;
				const { launchOrchestration } = await import("./orchestration/launch");
				const objective = `Scheduled run of orchestration flow '${flow.name}'.`;
				await launchOrchestration(this, flow, objective, { origin: "schedule" });
			},
		);

		// Register vault.on('delete') and vault.on('rename') for tag shadow cache maintenance (F-014)
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				tagShadowCache.removePath(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				tagShadowCache.renamePath(oldPath, file.path);
			})
		);

		// Deferred initialization: tag shadow cache + listener evaluation after layout ready
		this.app.workspace.onLayoutReady(() => {
			// Initialize the tag shadow cache from Obsidian's metadata cache
			tagShadowCache.initialize(this.app);
			log.info("Tag shadow cache initialized");

			// Evaluate which listeners should be active based on current settings
			// and discovered workflows (called again after rescanWorkflows in step 8)
			listenerManager.evaluateListeners();

			// Sync cron jobs with current on_schedule hooks
			const enabledScheduleHooks = this.settings.vault_event_hooks.on_schedule.filter(
				(h) => h.enabled
			);
			vaultEventScheduler.syncJobs(enabledScheduleHooks);

			// Discover scheduled orchestration flows and register their cron jobs
			// (no-op + empty cache when orchestration_enabled is off). Fire-and-forget.
			void this.rescanFlows().catch((e) =>
				log.warn("Initial orchestration flow scan failed", { error: String(e) }),
			);

			log.info("Vault event hook listeners evaluated and scheduler synced");
		});

		log.info("Group F vault event hook components initialized");
	}

	// -----------------------------------------------------------------------
	// Phase 4.1: MCP hub initialization (ARCH-005)
	// -----------------------------------------------------------------------

	/**
	 * Initialize the MCP connection hub and wire status change listeners
	 * to dynamically register/unregister MCP tools in the ToolRegistry
	 * and ToolDispatcher.
	 *
	 * Non-blocking — McpHub.initialize() fires off connections asynchronously.
	 * Cleanup is registered via this.register() for proper Obsidian lifecycle.
	 *
	 * @see specs/04-mcp/tasks.md — ARCH-005
	 * @see specs/04-mcp/contracts/mcp-connection-lifecycle.md
	 */
	private _initMcpHub(): void {
		const vaultRootPath = this.vaultRootPath;

		const mcpHub = new McpHub(this.manifest.version, vaultRootPath, this.getTaskLaneQueue());
		this._mcpHub = mcpHub;

		// Register cleanup via Obsidian lifecycle — ensures all connections
		// closed on unload even if unexpected shutdown occurs
		this.register(() => {
			mcpHub.dispose().catch((e) => {
				log.error("McpHub dispose failed", { error: String(e) });
			});
		});

		// Wire status change listener to add/remove MCP tools in the
		// ToolRegistry and ToolDispatcher when servers connect/disconnect
		mcpHub.onStatusChange((serverName, status) => {
			const toolRegistry = this._toolRegistry;
			const toolDispatcher = this._toolDispatcher;
			if (!toolRegistry || !toolDispatcher) {
				log.warn("MCP onStatusChange fired but ToolRegistry/Dispatcher not initialized", {
					serverName,
					status,
				});
				return;
			}

			if (status === "connected") {
				// Server connected + tools discovered → register MCP tools
				const connection = mcpHub.getConnection(serverName);
				if (!connection) return;

				// Mode accessor: reads current mode from the orchestrator's
				// conversation manager at call time
				const getModeCallback = (): "plan" | "act" => {
					try {
						const convManager = this.getActiveOrchestrator()?.getConversationManager();
						return convManager?.getActiveConversation()?.mode ?? this.settings.mode;
					} catch {
						return this.settings.mode;
					}
				};

				const getServerConfigFn = (): McpServerConfig =>
					this.settings.mcp_servers?.[serverName] ?? connection.config;

				for (const discoveredTool of connection.tools) {
					const registeredTool = new McpRegisteredTool(
						serverName,
						discoveredTool,
						getServerConfigFn,
						mcpHub,
						getModeCallback
					);
					toolRegistry.register(registeredTool);
					toolDispatcher.registerTool(registeredTool);
				}

				log.info("MCP tools registered", {
					serverName,
					toolCount: connection.tools.length,
					tools: connection.tools.map((t) => `${serverName}__${t.name}`),
				});

				// Warn if tools lack readOnlyHint annotations (once per server, ever).
				// Skip if: (a) notice was already shown, or (b) user has already
				// overridden any tool classification for this server.
				const serverConfig = this.settings.mcp_servers?.[serverName];
				const hasUserOverrides = serverConfig?.toolClassifications
					&& Object.keys(serverConfig.toolClassifications).length > 0;
				if (serverConfig && !serverConfig.annotationsNoticeShown && !hasUserOverrides) {
					const toolsMissingHint = connection.tools.filter(
						(t) => t.annotations?.readOnlyHint === undefined
					);
					if (toolsMissingHint.length > 0) {
						serverConfig.annotationsNoticeShown = true;
						this.saveSettings().catch((e) => {
							log.error("Failed to persist annotationsNoticeShown", { serverName, error: String(e) });
						});
						showMcpMissingAnnotationsNotice(this, serverName, toolsMissingHint.length);
					}
				}
			} else if (status === "disconnected" || status === "error") {
				// Server disconnected → unregister its tools from both
				// ToolRegistry and ToolDispatcher (FEAT-004)
				const toolNames = toolRegistry.getNames().filter(
					(name) => name.startsWith(`${serverName}__`)
				);
				for (const name of toolNames) {
					toolRegistry.unregister(name);
					toolDispatcher.unregisterTool(name);
				}

				if (toolNames.length > 0) {
					log.info("MCP tools unregistered", { serverName, tools: toolNames });
				}
			}
		});

		// Use Obsidian's plugin-level secret storage if available
		const pluginSecretStorage = {
			get: (key: string): Promise<string | undefined> => {
				try {
					// Obsidian stores secrets via the app's internal SecretStorage
					const app = this.app as unknown as {
						vault: { adapter: { basePath?: string } };
						loadLocalStorage?: (key: string) => string | null;
					};
					const val = app.loadLocalStorage?.(`notor-secret-${key}`);
					return Promise.resolve(val ?? undefined);
				} catch {
					return Promise.resolve(undefined);
				}
			},
		};

		// Initialize McpHub — non-blocking, fires off connections asynchronously
		mcpHub.initialize(this.settings, pluginSecretStorage).catch((e) => {
			log.error("McpHub initialization failed", { error: String(e) });
		});

		// Subscribe MCP reconnection to the shared sleep/wake detector created
		// in _initVaultEventHooks (runs before _initMcpHub).
		if (this._sleepWakeDetector) {
			mcpHub.startSleepDetection(this._sleepWakeDetector);
		} else {
			log.warn("SleepWakeDetector unavailable; MCP sleep reconnection disabled");
		}

		// Catch-up: after a microtask yield, register tools for any servers
		// that connected before the onStatusChange listener was fully wired.
		queueMicrotask(() => this._syncMcpToolRegistrations());

		log.info("McpHub initialized (connections launching in background)");
	}

	/**
	 * Synchronize MCP tool registrations with current McpHub state.
	 *
	 * Iterates all connected servers and ensures their discovered tools
	 * are present in ToolRegistry + ToolDispatcher. Idempotent.
	 */
	private _syncMcpToolRegistrations(): void {
		const mcpHub = this._mcpHub;
		const toolRegistry = this._toolRegistry;
		const toolDispatcher = this._toolDispatcher;
		if (!mcpHub || !toolRegistry || !toolDispatcher) return;

		const allTools = mcpHub.getAllDiscoveredTools();
		let registered = 0;

		for (const { serverName, tool: discoveredTool } of allTools) {
			const namespacedName = `${serverName}__${discoveredTool.name}`;
			if (toolRegistry.has(namespacedName)) continue;

			const getServerConfigFn = (): McpServerConfig =>
				this.settings.mcp_servers?.[serverName] ?? mcpHub.getConnection(serverName)!.config;

			const getModeCallback = (): "plan" | "act" => {
				try {
					const convManager = this.getActiveOrchestrator()?.getConversationManager();
					return convManager?.getActiveConversation()?.mode ?? this.settings.mode;
				} catch {
					return this.settings.mode;
				}
			};

			const registeredTool = new McpRegisteredTool(
				serverName,
				discoveredTool,
				getServerConfigFn,
				mcpHub,
				getModeCallback
			);
			toolRegistry.register(registeredTool);
			toolDispatcher.registerTool(registeredTool);
			registered++;
		}

		if (registered > 0) {
			log.info("MCP tool catch-up registration", { registered, total: allTools.length });
		}
	}

	// -----------------------------------------------------------------------
	// Settings
	// -----------------------------------------------------------------------

	async saveSettings() {
		await this.saveData(this.settings);

		// Propagate settings changes to live components (if initialized)
		if (this._providerRegistry) {
			// Rebuild provider configs from updated settings
			for (const config of this.settings.providers) {
				this._providerRegistry.updateConfig(config);
			}
			this._providerRegistry.switchProvider(
				this.settings.active_provider
			);
		}

		// Propagate settings to all active orchestrators (A4.2)
		for (const orch of this._orchestrators.values()) {
			orch.updateSettings(this.settings);
		}

		if (this._noteOpener) {
			this._noteOpener.setEnabled(this.settings.open_notes_on_access);
			this._noteOpener.setFocusEnabled(this.settings.focus_notes_on_access);
		}

		if (this._historyManager) {
			this._historyManager.updateSettings(
				this.settings.history_path,
				this.settings.history_max_size_mb,
				this.settings.history_max_age_days
			);
		}

		if (this._checkpointStorage) {
			this._checkpointStorage.setBasePath(this.settings.checkpoint_path);
			this._checkpointStorage.setRetentionLimits(
				this.settings.checkpoint_max_per_conversation,
				this.settings.checkpoint_max_age_days
			);
		}

		if (this._vaultRuleManager) {
			this._vaultRuleManager.setNotorDir(this.settings.notor_dir);
		}

		if (this._systemPromptBuilder) {
			this._systemPromptBuilder.setNotorDir(this.settings.notor_dir);
		}

		if (this._personaManager) {
			this._personaManager.updateSettings(this.settings);
		}

		// Group F: Propagate debounce cooldown change to live debounce engine
		if (this._vaultEventDebounce) {
			this._vaultEventDebounce.setCooldown(
				(this.settings.vault_event_debounce_seconds ?? 5) * 1000
			);
		}

		// Group F: Update concurrency manager limit
		if (this._workflowConcurrencyManager) {
			this._workflowConcurrencyManager.updateLimit(
				this.settings.workflow_concurrency_limit ?? 3
			);
		}

		// Group H: Update activity indicator entry count (H-007)
		if (this._workflowActivityTracker) {
			this._workflowActivityTracker.updateMaxEntries(
				this.settings.workflow_activity_indicator_count ?? 5
			);
		}

		// Phase 4.1: Keep McpHub's settings reference in sync so it can find
		// newly-added servers without requiring a plugin reload (ARCH-005).
		if (this._mcpHub) {
			this._mcpHub.updateSettings(this.settings);
		}

		// Group F: Re-evaluate listeners and sync scheduler on settings save
		if (this._vaultEventListenerManager) {
			this._vaultEventListenerManager.evaluateListeners();
		}
		if (this._vaultEventScheduler) {
			const enabledScheduleHooks = this.settings.vault_event_hooks.on_schedule.filter(
				(h) => h.enabled
			);
			this._vaultEventScheduler.syncJobs(enabledScheduleHooks);
		}

		// C-008: Re-discover workflows when notor_dir may have changed.
		// Non-blocking — fire and forget so saveSettings() doesn't await
		// the full vault scan.
		try {
			this.rescanWorkflows();
		} catch (e) {
			log.warn("Workflow rescan after settings change failed", { error: String(e) });
		}

		// Propagate log level change immediately
		setLogLevel(this.settings.log_level);
	}

	// -----------------------------------------------------------------------
	// Lazy component accessors (initialized on first use)
	// -----------------------------------------------------------------------

	/** Provider registry with all four provider types registered. */
	getProviderRegistry(): ProviderRegistry {
		if (!this._providerRegistry) {
			this._providerRegistry = new ProviderRegistry(
				this.app,
				this.settings.providers,
				this.settings.active_provider
			);

			// Register HTTP-based providers (always available)
			this._providerRegistry.registerFactory("local", (config, app) => {
				return new LocalProvider(config, app);
			});
			this._providerRegistry.registerFactory("anthropic", (config, app) => {
				return new AnthropicProvider(config, app);
			});
			this._providerRegistry.registerFactory("openai", (config, app) => {
				return new OpenAIProvider(config, app);
			});

			// Bedrock registered lazily via dynamic import to keep startup
			// bundle lean (AWS SDK is large and Node.js-only)
			this._providerRegistry.registerFactory("bedrock", (_config, _app) => {
				// BedrockProvider is constructed synchronously once the module
				// is imported; the actual credential resolution is deferred
				// inside the provider's sendMessage / validateConnection calls.
				// We use a lazy wrapper to defer the import.
				throw new Error(
					"Bedrock provider must be initialized via initBedrockProvider(). " +
					"Call getProviderRegistryAsync() to ensure Bedrock is available."
				);
			});

			// Initialize Bedrock asynchronously (non-blocking)
			this.initBedrockProvider().catch((e) => {
				log.warn("Bedrock provider initialization deferred", { error: String(e) });
			});
		}
		return this._providerRegistry;
	}

	/** Initialize the Bedrock provider by dynamically importing the AWS SDK. */
	private async initBedrockProvider(): Promise<void> {
		try {
			const { BedrockProvider } = await import("./providers/bedrock-provider");
			const registry = this.getProviderRegistry();
			registry.registerFactory("bedrock", (config, app) => {
				return new BedrockProvider(config, app);
			});
			// Clear any cached instance so it re-creates with the real factory
			const bedrockConfig = this.settings.providers.find((p) => p.type === "bedrock");
			if (bedrockConfig) {
				registry.updateConfig(bedrockConfig);
			}
			log.debug("Bedrock provider registered");
		} catch (e) {
			log.warn("Failed to register Bedrock provider", { error: String(e) });
		}
	}

	/** Stale content tracker for write tool safety. */
	getWebviewLeafCache(): Map<string, WorkspaceLeaf> {
		return this._webviewLeafCache;
	}

	getStaleTracker(): StaleContentTracker {
		if (!this._staleTracker) {
			this._staleTracker = new StaleContentTracker();
		}
		return this._staleTracker;
	}

	/** Temp output spiller for writing truncated tool output to disk. Null when disabled or on mobile. */
	getTempOutputSpiller(): import("./shell/temp-output-spiller").TempOutputSpiller | undefined {
		return this._tempOutputSpiller;
	}

	/** Note opener utility. */
	getNoteOpener(): NoteOpener {
		if (!this._noteOpener) {
			this._noteOpener = new NoteOpener(
				this.app,
				this.settings.open_notes_on_access,
				this.settings.focus_notes_on_access
			);
		}
		return this._noteOpener;
	}

	/** Checkpoint storage. */
	getCheckpointStorage(): CheckpointStorage {
		if (!this._checkpointStorage) {
			this._checkpointStorage = new CheckpointStorage(
				this.app.vault,
				this.settings.checkpoint_path,
				this.settings.checkpoint_max_per_conversation,
				this.settings.checkpoint_max_age_days
			);
		}
		return this._checkpointStorage;
	}

	/** Checkpoint manager (legacy plugin-level singleton — retained for backward compat). */
	getCheckpointManager(): CheckpointManager {
		if (!this._checkpointManager) {
			this._checkpointManager = new CheckpointManager(
				this.app,
				this.getCheckpointStorage()
			);
		}
		return this._checkpointManager;
	}

	/**
	 * Shared checkpoint manager for user-defined extensions.
	 *
	 * Extensions set their own conversation ID before use and don't need
	 * per-orchestrator scoping. This lazily-initialized manager is backed
	 * by the same `CheckpointStorage` singleton as the per-orchestrator
	 * managers, keeping behavior backward-compatible.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — A1.6d
	 */
	getSharedCheckpointManager(): CheckpointManager {
		if (!this._sharedCheckpointManager) {
			this._sharedCheckpointManager = new CheckpointManager(
				this.app,
				this.getCheckpointStorage()
			);
		}
		return this._sharedCheckpointManager;
	}

	/**
	 * Tool registry. Built-in tools (except use_subagent) are loaded via
	 * scaffold defaults in ExtensionManager.reload().
	 */
	getToolRegistry(): ToolRegistry {
		if (!this._toolRegistry) {
			this._toolRegistry = new ToolRegistry();

			// Sub-agent tool — the only remaining class-based built-in
			const useSubagentTool = new UseSubagentTool(
				this.getSubAgentManager(),
				this.getProviderRegistry(),
				this._toolRegistry,
				this.settings,
				// Fallback closures for non-session contexts (A4.4f);
				// session-scoped dispatch uses sessionContext instead.
				() => this.getActiveOrchestrator()?.getEffectiveToolConfig() ?? null,
				this.getHistoryManager(),
				() => this.getActiveOrchestrator()?.getConversationManager()?.getActiveConversation() ?? null,
			);
			if (this.vaultRootPath) {
				useSubagentTool.setVaultRootPath(this.vaultRootPath);
			}
			useSubagentTool.setResolveVaultPath((path: string) => {
				const file = resolveNote(path, this.app.vault, this.app.metadataCache);
				return file?.path ?? null;
			});
			this._toolRegistry.register(useSubagentTool);

			// Internal task tracking tool — always-on, hidden from settings
			const updateTasksTool = new UpdateTasksTool();
			this._toolRegistry.register(updateTasksTool);

			// run_flow (INT-042) — a hand-written Tool (it needs the dynamic flow
			// enum, mirroring use_subagent), gated on `orchestration_enabled`. Unlike
			// the orchestration *scaffolds* (auto-gated by the ExtensionManager), this
			// class-based tool is gated by its registration here + the settings toggle
			// (see syncRunFlowToolRegistration). Skipped entirely when the group is off.
			if (this.settings.orchestration_enabled) {
				this.registerRunFlowTool(this._toolRegistry);
			}

			log.debug("Tool registry initialized", {
				tools: this._toolRegistry.getNames(),
			});
		}
		return this._toolRegistry;
	}

	/** Construct + register `run_flow` into the registry (INT-042). */
	private registerRunFlowTool(registry: ToolRegistry): void {
		const composition = new FlowCompositionManager(
			this.app.vault,
			this.app.metadataCache,
			this.settings.notor_dir,
		);
		const runFlowTool = new RunFlowTool(composition, makeChildFlowSpawner(this));
		registry.register(runFlowTool);
		// Prime the invocable-flow cache (hot-reloaded again at each execute()).
		runFlowTool.refreshInvocableFlows().catch((e) =>
			log.warn("Failed to prime run_flow invocable flows", { error: String(e) }),
		);
	}

	/**
	 * Re-gate `run_flow` when `orchestration_enabled` toggles (INT-042). On enable
	 * it registers the tool into both the registry and the live dispatcher; on
	 * disable it unregisters from both, so the tool appears/disappears with the
	 * feature group exactly like the orchestration scaffolds.
	 */
	syncRunFlowToolRegistration(): void {
		const registry = this.getToolRegistry();
		const present = registry.get(RUN_FLOW_TOOL_NAME) !== undefined;
		if (this.settings.orchestration_enabled && !present) {
			this.registerRunFlowTool(registry);
			const tool = registry.get(RUN_FLOW_TOOL_NAME);
			if (tool && this._toolDispatcher && !this._toolDispatcher.hasTool(RUN_FLOW_TOOL_NAME)) {
				this._toolDispatcher.registerTool(tool);
			}
		} else if (!this.settings.orchestration_enabled && present) {
			registry.unregister(RUN_FLOW_TOOL_NAME);
			this._toolDispatcher?.unregisterTool(RUN_FLOW_TOOL_NAME);
		}
	}

	/** Tool dispatcher. */
	getToolDispatcher(): ToolDispatcher {
		if (!this._toolDispatcher) {
			this._toolDispatcher = new ToolDispatcher();

			// Register all tools with the dispatcher
			const registry = this.getToolRegistry();
			for (const tool of registry.getAll()) {
				this._toolDispatcher.registerTool(tool);
			}

			this._toolDispatcher.setAutoApprove(this.settings.auto_approve);
			this._toolDispatcher.setSettings(this.settings);
			this._toolDispatcher.setSpiller(this._tempOutputSpiller);

			this._toolDispatcher.setActivePersonaName(
				this.settings.active_persona || null
			);

			// Set vault root path for working directory validation
			if (this.vaultRootPath) {
				this._toolDispatcher.setVaultRootPath(this.vaultRootPath);
			}

			// Set vault path resolver for path constraint enforcement
			this._toolDispatcher.setResolveVaultPath((path: string) => {
				const file = resolveNote(path, this.app.vault, this.app.metadataCache);
				return file?.path ?? null;
			});
		}
		return this._toolDispatcher;
	}

	/** History manager. */
	getHistoryManager(): HistoryManager {
		if (!this._historyManager) {
			this._historyManager = new HistoryManager(
				this.app.vault,
				this.settings.history_path,
				this.settings.history_max_size_mb,
				this.settings.history_max_age_days
			);
		}
		return this._historyManager;
	}

	/** System prompt builder. */
	getSystemPromptBuilder(): SystemPromptBuilder {
		if (!this._systemPromptBuilder) {
			this._systemPromptBuilder = new SystemPromptBuilder(
				this.app.vault,
				this.settings.notor_dir,
				this.app.metadataCache,
				this.getTemplateRegistry(),
			);
		}
		return this._systemPromptBuilder;
	}

	/** Vault rule manager. */
	getVaultRuleManager(): VaultRuleManager {
		if (!this._vaultRuleManager) {
			this._vaultRuleManager = new VaultRuleManager(
				this.app,
				this.settings.notor_dir,
				this.getTemplateRegistry(),
			);
		}
		return this._vaultRuleManager;
	}

	/**
	 * Persona manager — manages active persona state, discovery,
	 * provider/model switching, and save/restore for workflow revert.
	 *
	 * @see specs/03-workflows-personas/tasks/group-a-tasks.md — A-013
	 */
	getPersonaManager(): PersonaManager {
		if (!this._personaManager) {
			this._personaManager = new PersonaManager(
				this.app.vault,
				this.app.metadataCache,
				this.settings,
				this.getProviderRegistry(),
				async () => this.saveData(this.settings),
				this.getTemplateRegistry(),
			);
		}
		return this._personaManager;
	}

	/** Pending memory manager — returns null when memory is disabled. */
	getPendingMemoryManager(): PendingMemoryManager | null {
		if (!this.settings.memory_enabled) return null;
		if (!this._pendingMemoryManager) {
			const memoryFolder = this.settings.memory_folder ?? "memory";
			const memoryDir = normalizePath(`${this.settings.notor_dir}/${memoryFolder}`);
			const pendingDir = normalizePath(`${this.settings.notor_dir}/pending-memories`);
			this._pendingMemoryManager = new PendingMemoryManager(
				this.app,
				this.app.vault,
				pendingDir,
				memoryDir,
			);
		}
		return this._pendingMemoryManager;
	}

	/** Sub-agent profile manager (Phase 3). */
	getSubAgentManager(): SubAgentManager {
		if (!this._subAgentManager) {
			this._subAgentManager = new SubAgentManager(
				this.app.vault,
				this.app.metadataCache,
				this.settings,
				async () => this.saveData(this.settings),
				parseYaml,
				this.getTemplateRegistry(),
			);
		}
		return this._subAgentManager;
	}

	/** Extension manager — user-defined tools and automations (EXT-016). */
	getExtensionManager(): ExtensionManager {
		if (!this._extensionManager) {
			this._extensionManager = new ExtensionManager(this, parseYaml);
		}
		return this._extensionManager;
	}

	/** Vault event scheduler — provides cron job status for the settings UI. */
	getVaultEventScheduler(): VaultEventScheduler | undefined {
		return this._vaultEventScheduler;
	}

	/** Template variable registry — resolves {notor_dir}, {vault_name} etc. in scaffold content. */
	getTemplateRegistry(): TemplateVariableRegistry {
		if (!this._templateRegistry) {
			this._templateRegistry = new TemplateVariableRegistry();
			registerBuiltinVars(
				this._templateRegistry,
				() => this.settings,
				() => this.app.vault.getName(),
			);
		}
		return this._templateRegistry;
	}

	/** Chat block registry — maps block kinds to render/wire definitions. */
	getChatBlockRegistry(): ChatBlockRegistry {
		if (!this._chatBlockRegistry) {
			// Fallback: registry is normally created in onload(), but if accessed
			// before that (e.g., in tests), create it lazily.
			this._chatBlockRegistry = new ChatBlockRegistry();
			setChatBlockRegistry(this._chatBlockRegistry);
		}
		return this._chatBlockRegistry;
	}

	/** Markdown exporter — exposed for E2E testing. */
	getMarkdownExporter(): typeof import("./export/markdown-exporter").exportToMarkdown {
		return exportToMarkdown;
	}

	/** Per-lane FIFO serialization queue for rate-limiting async operations. */
	getTaskLaneQueue(): TaskLaneQueue {
		if (!this._taskLaneQueue) {
			this._taskLaneQueue = new TaskLaneQueue();
		}
		return this._taskLaneQueue;
	}

	/** Web search provider registry — registers all built-in providers. */
	private getSearchProviderRegistry(): SearchProviderRegistry {
		if (!this._searchProviderRegistry) {
			this._searchProviderRegistry = new SearchProviderRegistry();
			this._searchProviderRegistry.register(new DuckDuckGoProvider());
			this._searchProviderRegistry.register(new TavilyProvider());
			this._searchProviderRegistry.register(new BraveSearchProvider());
			this._searchProviderRegistry.register(new SerpApiProvider());
			this._searchProviderRegistry.register(new KagiSearchProvider());
		}
		return this._searchProviderRegistry;
	}

	/** Web search queue — multi-provider orchestration with fallback and round-robin. */
	getWebSearchQueue(): WebSearchQueue {
		if (!this._webSearchQueue) {
			this._webSearchQueue = new WebSearchQueue(
				() => this.getExtensionManager().getResolvedSettings("web_search").values,
				this.getSearchProviderRegistry(),
				this.getTaskLaneQueue(),
			);
		}
		return this._webSearchQueue;
	}




	/**
	 * Create a new orchestrator with all shared singletons and managers wired.
	 *
	 * Unified factory replacing `getOrchestrator()` (primary singleton) and
	 * `createSecondaryOrchestrator()`. Returns a new `ChatOrchestrator`
	 * every time — caller stores it in `_orchestrators`.
	 *
	 * Setup checklist (Amendment R2-4):
	 *  1. Construct ChatOrchestrator with shared singletons + sessionGuard
	 *  2. Wire PersonaManager
	 *  3. Wire WorkflowHookOverrideManager
	 *  4. Wire extension accessors
	 *  5. Set tool definitions callback (moved from wireView — Amendment R3)
	 *  6. Create per-orchestrator CheckpointManager and wire it (Amendment A1)
	 *
	 * Does NOT call personaManager.restoreFromSettings() — that moves to
	 * onload() as a one-time global restore (Amendment R5 / A1.7).
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 4.2
	 */
	createOrchestrator(): ChatOrchestrator {
		const dispatcher = this.getToolDispatcher();
		const historyManager = this.getHistoryManager();
		const systemPromptBuilder = this.getSystemPromptBuilder();
		const providerRegistry = this.getProviderRegistry();
		const vaultRuleManager = this.getVaultRuleManager();

		const orchestrator = new ChatOrchestrator(
			this.app,
			providerRegistry,
			systemPromptBuilder,
			dispatcher,
			historyManager,
			this.settings,
			this._sessionGuard,
			undefined, // view wired later via wireView()
			vaultRuleManager,
			this.getTemplateRegistry(),
		);

		// Wire shared managers
		orchestrator.setPersonaManager(this.getPersonaManager());
		orchestrator.setWorkflowHookOverrideManager(
			this.getWorkflowHookOverrideManager()
		);
		orchestrator.setChatBlockRegistry(this.getChatBlockRegistry());

		// Wire extension automation accessors
		const mgr = this.getExtensionManager();
		orchestrator.setExtensionAccessors({
			lifecycle: {
				getForTrigger: (t) => mgr.getAutomationsForTrigger(t),
				execute: (a, c) => mgr.executeAutomation(a, c),
			},
			toolEvent: {
				getForToolEvent: (t, n) => mgr.getAutomationsForToolEvent(t, n),
				execute: (a, c) => mgr.executeAutomation(a, c),
			},
		});

		// Set tool definitions callback (Amendment R3 — moved from wireView)
		const toolRegistry = this.getToolRegistry();
		orchestrator.setGetToolDefinitions((config) => {
			if (config) {
				return toolRegistry.getFilteredToolDefinitions(config) as import("./providers/provider").ToolDefinition[];
			}
			return toolRegistry.getToolDefinitions() as import("./providers/provider").ToolDefinition[];
		});

		// Per-orchestrator CheckpointManager (Amendment A1)
		const checkpointManager = new CheckpointManager(
			this.app,
			this.getCheckpointStorage()
		);
		orchestrator.setCheckpointManager(checkpointManager);
		orchestrator.setSharedCheckpointManager(() => this._sharedCheckpointManager);
		orchestrator.setStaleTracker(() => this.getStaleTracker());

		log.info("Orchestrator created via unified factory");
		return orchestrator;
	}

	/**
	 * Create a headless orchestrator for background workflow execution.
	 * Reuses createOrchestrator() which already passes undefined for view —
	 * skipping wireView() gives a fully functional headless orchestrator.
	 */
	createHeadlessOrchestrator(): ChatOrchestrator {
		return this.createOrchestrator();
	}

	/**
	 * Get the orchestrator for the currently active/focused chat panel.
	 *
	 * Three-level fallback:
	 *  1. `workspace.getActiveViewOfType(NotorChatView)` → its leaf.id
	 *  2. `_lastFocusedChatLeafId` → `_orchestrators.get(...)`
	 *  3. First available chat leaf → `_orchestrators.get(...)`
	 *  4. `null` if no panels exist
	 *
	 * The `_lastFocusedChatLeafId` fallback is required — without it,
	 * vault-event workflows and commands route to an arbitrary panel
	 * when the user is focused on a non-chat view.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 4.9
	 */
	getActiveOrchestrator(): ChatOrchestrator | null {
		// Level 1: currently focused chat view
		const activeView = this.app.workspace.getActiveViewOfType(NotorChatView);
		if (activeView) {
			const orch = this._orchestrators.get(activeView.leaf.id);
			if (orch) return orch;
		}

		// Level 2: last focused chat panel
		if (this._lastFocusedChatLeafId) {
			const orch = this._orchestrators.get(this._lastFocusedChatLeafId);
			if (orch) return orch;
		}

		// Level 3: first available chat leaf
		const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		const firstLeaf = leaves[0];
		if (firstLeaf) {
			const orch = this._orchestrators.get(firstLeaf.id);
			if (orch) return orch;
		}

		// Level 4: no panels exist
		return null;
	}

	/**
	 * Get the orchestrator for the last focused chat panel leaf.
	 * Returns null if no chat panel has been focused yet.
	 */
	getLastFocusedOrchestrator(): ChatOrchestrator | null {
		if (!this._lastFocusedChatLeafId) return null;
		return this._orchestrators.get(this._lastFocusedChatLeafId) ?? null;
	}

	/**
	 * Get the orchestrator for a specific chat view.
	 *
	 * @param view - The chat view to look up
	 * @returns The orchestrator for this view, or null if not found
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 4.2
	 */
	getOrchestratorForView(view: NotorChatView): ChatOrchestrator | null {
		return this._orchestrators.get(view.leaf.id) ?? null;
	}

	/** Remove an orchestrator from the registry (called on panel close). */
	removeOrchestrator(leafId: string): void {
		this._orchestrators.delete(leafId);
	}

	/** Get the workflow activity tracker (may be undefined). */
	getWorkflowActivityTracker(): WorkflowActivityTracker | undefined {
		return this._workflowActivityTracker;
	}

	/** Get active sessions from all open chat panels. */
	getAllActiveSessions(): ConversationSession[] {
		return this._getAllActiveSessions();
	}

	/** Register an activity indicator callback. */
	addActivityIndicatorCallback(cb: () => void): void {
		this._activityIndicatorCallbacks.add(cb);
	}

	/** Unregister an activity indicator callback. */
	removeActivityIndicatorCallback(cb: () => void): void {
		this._activityIndicatorCallbacks.delete(cb);
	}

	/** Fire all registered activity indicator callbacks. */
	fireActivityIndicatorCallbacks(): void {
		for (const cb of this._activityIndicatorCallbacks) cb();
	}

	/** Update the MCP hub settings reference. */
	updateMcpHubSettings(): void {
		if (this._mcpHub) {
			this._mcpHub.updateSettings(this.settings);
		}
	}

	/** Scroll settings tab to a specific group/subsection. */
	scrollSettingsToGroup(groupTitle: string, subsection?: string): void {
		this._settingTab?.scrollToGroup(groupTitle, subsection);
	}

	/**
	 * Load a conversation into a panel. Determines which conversation to load
	 * from savedState (workspace restore) or falls back to most-recent.
	 *
	 * Called from setState() (workspace restore) and the setTimeout fallback
	 * (fresh install). This is the ONLY place conversation loading happens.
	 *
	 * Implemented as async — callers (setState, setTimeout fallback) do not
	 * await it. AbortController handles races between concurrent calls.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 4.5
	 */
	async loadConversation(
		view: NotorChatView,
		orchestrator: ChatOrchestrator,
		savedState?: Record<string, unknown> | null,
	): Promise<void> {
		// Abort any in-flight load for this view (Amendment R2).
		view._loadConversationAbort?.abort();
		const controller = new AbortController();
		const { signal } = controller;
		view._loadConversationAbort = controller;
		view.isConversationLoaded = true;

		const historyManager = this.getHistoryManager();
		let entries: import("./chat/history").ConversationListEntry[];
		try {
			entries = await historyManager.listConversations();
		} catch (e) {
			log.error("Failed to load conversation history", { error: String(e) });
			view.isConversationLoaded = false; // allow retry
			return;
		}
		if (signal.aborted) return;

		view.renderConversationList(entries);

		const savedFilename = savedState?.conversationFilename as string | undefined;
		const savedId = savedState?.conversationId as string | undefined;
		const createNew = savedState?.createNew as boolean | undefined;

		try {
			if (savedFilename) {
				// "Open in new tab" passes a filename — load it directly
				await orchestrator.switchConversation(savedFilename, { signal });
				if (signal.aborted) return;
				this.syncViewAfterLoad(view, orchestrator);

				// /btw auto-send: if the fork was created with initial text, send it
				const initialText = savedState?.initialText as string | undefined;
				if (initialText) {
					view.setInputText(initialText);
					view.triggerSend();
				}
			} else if (savedId) {
				// Workspace restore passes a conversation ID — resolve and load
				let switched: boolean;
				try {
					switched = await orchestrator.switchToConversationById(savedId, { signal });
				} catch {
					switched = false;
				}
				if (signal.aborted) return;
				if (!switched) {
					// Conversation may have been deleted — fall back to most recent
					if (entries.length > 0) {
						await orchestrator.switchConversation(entries[0]!.filename, { signal });
						if (signal.aborted) return;
					} else {
						await orchestrator.newConversation({ signal });
						if (signal.aborted) return;
					}
				}
				this.syncViewAfterLoad(view, orchestrator);
			} else if (createNew || entries.length === 0) {
				// Explicit "new panel" command or no existing conversations
				await orchestrator.newConversation({ signal });
				if (signal.aborted) return;
				this.syncViewAfterLoad(view, orchestrator);
			} else {
				// No saved state — load most recent
				await orchestrator.switchConversation(entries[0]!.filename, { signal });
				if (signal.aborted) return;
				this.syncViewAfterLoad(view, orchestrator);
			}
			// Recover any draft saved at quit time
			void this.applyPendingDraft(orchestrator, view);
		} catch (e) {
			if (signal.aborted) return;
			log.error("Failed to load conversation", { error: String(e) });
			view.isConversationLoaded = false; // allow retry
			new Notice("Failed to load conversation — please try reopening the panel.");
		}
	}

	/**
	 * If a `pending_draft` was saved at quit time, write it into the matching
	 * conversation's JSONL header and restore it to the input box.
	 *
	 * The `pending_draft` key is removed from plugin data after recovery so it
	 * doesn't interfere with subsequent loads.
	 */
	private async applyPendingDraft(
		orchestrator: ChatOrchestrator,
		view: NotorChatView,
	): Promise<void> {
		const rawData = (await this.loadData()) as Record<string, unknown> | null;
		if (!rawData?.pending_draft) return;

		const { conversationId, text } = rawData.pending_draft as { conversationId: string; text: string };
		const currentConv = orchestrator.getConversationManager().getActiveConversation();
		if (!currentConv || currentConv.id !== conversationId || !text?.trim()) {
			delete rawData.pending_draft;
			void this.saveData(rawData);
			return;
		}

		await this.getHistoryManager().saveDraft(currentConv, text);
		view.setInputText(text);

		delete rawData.pending_draft;
		void this.saveData(rawData);
	}

	/**
	 * Sync view state after a conversation has been loaded.
	 *
	 * Sets the view's active conversation ID from the orchestrator's
	 * conversation manager. Checkpoint manager is handled internally
	 * by the orchestrator (Amendment A1 / A1.6b).
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 4.5
	 */
	private syncViewAfterLoad(
		view: NotorChatView,
		orchestrator: ChatOrchestrator,
	): void {
		const conv = orchestrator.getConversationManager().getActiveConversation();
		if (conv) {
			view.setActiveConversationId(conv.id);
			view.updateHeaderTitle(conv.id, conv.title ?? null);
			view.updateHeaderFavorite(conv.id, !!conv.is_favorite);

			// Ensure persona label is set after DOM is built. This covers
			// all load paths including new conversations opened in stacked
			// panels where the initial setPersonaManager() fires before onOpen().
			if (conv.persona_name) {
				const pm = this.getPersonaManager();
				pm.getPersonaByName(conv.persona_name).then((p) => {
					view.updatePersonaLabel(p);
				}).catch(() => {
					view.updatePersonaLabel(null);
				});
			} else {
				view.updatePersonaLabel(this.getPersonaManager().getActivePersona() ?? null);
			}

			// Ensure the active-workflow chip is set after the DOM is built,
			// covering the same load paths as the persona label above.
			view.updateWorkflowLabel(conv);
		}
	}

	/**
	 * Workflow hook override manager — singleton, instantiated on first use.
	 *
	 * Shared by the orchestrator (for activate/deactivate) and hook dispatch
	 * functions (for effective hook resolution). Calling `destroy()` clears all
	 * state; called during `onunload()` (G-005).
	 *
	 * @see specs/03-workflows-personas/tasks/group-g-tasks.md — G-003, G-005
	 */
	getWorkflowHookOverrideManager(): WorkflowHookOverrideManager {
		if (!this._workflowHookOverrideManager) {
			this._workflowHookOverrideManager = new WorkflowHookOverrideManager();
			log.debug("WorkflowHookOverrideManager instantiated");
		}
		return this._workflowHookOverrideManager;
	}

	// -----------------------------------------------------------------------
	// Workflow discovery (C-008)
	// -----------------------------------------------------------------------

	/**
	 * Return the cached workflow discovery results.
	 *
	 * Results are populated during `onload()` and refreshed on demand
	 * via `rescanWorkflows()`. Downstream consumers (Group E command
	 * palette, Group F event-triggered workflows, Group H activity
	 * indicator) use this synchronous accessor to read the last
	 * discovered set.
	 *
	 * @returns Array of discovered `Workflow` objects (may be empty if
	 *          discovery hasn't completed yet or no workflows exist)
	 */
	getDiscoveredWorkflows(): Workflow[] {
		return this._discoveredWorkflows;
	}

	/**
	 * Trigger a fresh workflow discovery scan and update the cache.
	 *
	 * Intended to be called when:
	 * - The command palette workflow list is opened (Group E)
	 * - Settings change (e.g., `notor_dir` updated)
	 * - The plugin loads for the first time
	 *
	 * @returns The freshly discovered `Workflow` array
	 */
	rescanWorkflows(): Workflow[] {
		const workflows = discoverWorkflows(
			this.app.vault,
			this.app.metadataCache,
			this.settings.notor_dir
		);
		this._discoveredWorkflows = workflows;
		log.debug("Workflow cache updated", {
			count: workflows.length,
			names: workflows.map((w) => w.display_name),
		});

		// Group F: Re-evaluate listeners after workflow discovery completes
		// so newly discovered workflow triggers activate their listeners (F-007).
		if (this._vaultEventListenerManager) {
			this._vaultEventListenerManager.evaluateListeners();
		}
		if (this._vaultEventScheduler) {
			const enabledScheduleHooks = this.settings.vault_event_hooks.on_schedule.filter(
				(h) => h.enabled
			);
			this._vaultEventScheduler.syncJobs(enabledScheduleHooks);
		}

		return workflows;
	}

	/**
	 * Synchronous accessor for the last discovered orchestration flows.
	 *
	 * Refreshed via `rescanFlows()`. Read by the Automation settings section and
	 * the `VaultEventScheduler` to surface / register `notor-schedule` cron jobs.
	 * Returns `[]` when `orchestration_enabled` is off.
	 */
	getDiscoveredFlows(): OrchestrationFlow[] {
		return this._discoveredFlows;
	}

	/**
	 * Re-discover orchestration flows and refresh the cache, then re-sync the
	 * scheduler so flows with a `notor-schedule` get cron jobs. Mirrors
	 * `rescanWorkflows()` but is async (flow discovery reads the vault).
	 *
	 * No-ops to an empty cache when `orchestration_enabled` is off — a disabled
	 * feature must not register scheduled runs.
	 */
	async rescanFlows(): Promise<OrchestrationFlow[]> {
		if (!this.settings.orchestration_enabled) {
			this._discoveredFlows = [];
			this._vaultEventScheduler?.syncJobs(
				this.settings.vault_event_hooks.on_schedule.filter((h) => h.enabled),
			);
			return [];
		}

		try {
			const { FlowDefinitionParser } = await import("./orchestration/flow-parser");
			const parser = new FlowDefinitionParser(
				this.app.vault,
				this.app.metadataCache,
				this.settings.notor_dir,
			);
			const parsed = await parser.discoverFlows();
			this._discoveredFlows = parsed.map((p) => p.flow);
			log.debug("Flow cache updated", {
				count: this._discoveredFlows.length,
				scheduled: this._discoveredFlows.filter((f) => f.schedule).map((f) => f.name),
			});
		} catch (e) {
			log.warn("Orchestration flow rescan failed", { error: String(e) });
			this._discoveredFlows = [];
		}

		if (this._vaultEventScheduler) {
			this._vaultEventScheduler.syncJobs(
				this.settings.vault_event_hooks.on_schedule.filter((h) => h.enabled),
			);
		}

		return this._discoveredFlows;
	}

	/**
	 * Debounced wrapper around `rescanFlows()` for vault event handlers.
	 * Coalesces rapid bursts (e.g. bulk sync) into a single rescan.
	 */
	private scheduleFlowRescan(): void {
		if (this._flowRescanTimer !== null) {
			clearTimeout(this._flowRescanTimer);
		}
		this._flowRescanTimer = setTimeout(() => {
			this._flowRescanTimer = null;
			void this.rescanFlows().catch((e) =>
				log.warn("Vault-triggered flow rescan failed", { error: String(e) }),
			);
		}, 300);
	}

	/**
	 * Returns true if a vault-relative path points to a Markdown file inside the
	 * orchestrations subdirectory (used to trigger a debounced flow rescan).
	 */
	private isOrchestrationPath(filePath: string): boolean {
		const orchDir = normalizePath(`${this.settings.notor_dir}/orchestrations`);
		return filePath.endsWith(".md") && filePath.startsWith(orchDir + "/");
	}

	/**
	 * Returns true if `file` is a Markdown note inside the workflows
	 * subdirectory of the configured notor directory.
	 */
	private isWorkflowFile(file: TAbstractFile): file is TFile {
		return file instanceof TFile && this.isWorkflowPath(file.path);
	}

	/**
	 * Returns true if a vault-relative path points to a Markdown file inside
	 * the workflows subdirectory. Used to check the old path in rename events.
	 */
	private isWorkflowPath(filePath: string): boolean {
		const workflowDir = normalizePath(`${this.settings.notor_dir}/workflows`);
		return filePath.endsWith(".md") && filePath.startsWith(workflowDir + "/");
	}

	/**
	 * Debounced wrapper around `rescanWorkflows()` for vault event handlers.
	 * Coalesces rapid bursts (e.g. bulk sync) into a single rescan.
	 */
	private scheduleWorkflowRescan(): void {
		if (this._workflowRescanTimer !== null) {
			clearTimeout(this._workflowRescanTimer);
		}
		this._workflowRescanTimer = setTimeout(() => {
			this._workflowRescanTimer = null;
			try {
				this.rescanWorkflows();
			} catch (e) {
				log.warn("Vault-triggered workflow rescan failed", { error: String(e) });
			}
		}, 300);
	}

	/**
	 * Register vault and metadata-cache event listeners that keep the workflow
	 * cache fresh when notes are created, renamed, deleted, or edited.
	 *
	 * All four listeners are automatically torn down on plugin unload via
	 * `registerEvent()`.
	 */
	private registerWorkflowVaultWatcher(): void {
		this.registerEvent(
			this.app.vault.on("create", (f) => {
				if (!this.isWorkflowFile(f)) return;
				this.autoInjectIfNeeded(f);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (this.isWorkflowFile(f)) this.scheduleWorkflowRescan();
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				if (!this.isWorkflowFile(f) && !this.isWorkflowPath(oldPath)) return;

				// File renamed INTO workflows/ — may need injection
				if (this.isWorkflowFile(f) && !this.isWorkflowPath(oldPath)) {
					this.autoInjectIfNeeded(f);
				} else {
					this.scheduleWorkflowRescan();
				}
			})
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (f) => {
				if (this.isWorkflowFile(f)) this.scheduleWorkflowRescan();
			})
		);

		// Orchestration flow definitions: keep the flow cache (and thus scheduled
		// cron jobs) fresh when a definition.md under orchestrations/ changes.
		this.registerEvent(
			this.app.vault.on("create", (f) => {
				if (this.isOrchestrationPath(f.path)) this.scheduleFlowRescan();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (this.isOrchestrationPath(f.path)) this.scheduleFlowRescan();
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				if (this.isOrchestrationPath(f.path) || this.isOrchestrationPath(oldPath)) {
					this.scheduleFlowRescan();
				}
			})
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (f) => {
				if (this.isOrchestrationPath(f.path)) this.scheduleFlowRescan();
			})
		);
	}

	/**
	 * If a workflow file lacks identification frontmatter, inject it.
	 * The injection triggers a metadataCache "changed" event which will
	 * call scheduleWorkflowRescan() naturally.
	 */
	private autoInjectIfNeeded(file: TFile): void {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		const isIdentified = fm?.["notor-workflow"] === true || fm?.["notor-type"] === "workflow";

		if (isIdentified) {
			this.scheduleWorkflowRescan();
			return;
		}

		// Cancel pending rescan — injection will trigger "changed" event
		// which re-schedules the rescan with correct frontmatter in place.
		if (this._workflowRescanTimer !== null) {
			clearTimeout(this._workflowRescanTimer);
			this._workflowRescanTimer = null;
		}

		injectWorkflowFrontmatter(this.app, file, "manual", "plan").then((result) => {
			if (result.injected) {
				log.info("Auto-injected workflow frontmatter", {
					path: file.path,
					fieldsAdded: result.fieldsAdded,
				});
			}
			// "changed" event from processFrontMatter triggers scheduleWorkflowRescan()
		}).catch((e) => {
			log.warn("Failed to auto-inject workflow frontmatter", {
				path: file.path,
				error: String(e),
			});
			this.scheduleWorkflowRescan();
		});
	}

	// -----------------------------------------------------------------------
	// Extension file watcher (EXT-024)
	// -----------------------------------------------------------------------

	/**
	 * Debounced handler for extension file changes.
	 *
	 * Automatically reloads extensions after a 1000ms debounce. On success
	 * with no errors, nothing is shown. On compile/parse errors, shows a
	 * persistent Notice per error with right-click to open the affected note.
	 * The previous working compiled state is preserved for errored extensions
	 * (handled inside ExtensionManager.reload).
	 *
	 * @see specs/05-user-tools/tasks.md — EXT-024
	 */
	private scheduleExtensionAutoReload(): void {
		if (this._extensionChangeTimer !== null) {
			clearTimeout(this._extensionChangeTimer);
		}
		this._extensionChangeTimer = setTimeout(() => {
			this._extensionChangeTimer = null;

			this.getExtensionManager().reload(false).then((result) => {
				// Re-evaluate listeners to pick up any new automation triggers
				if (this._vaultEventListenerManager) {
					this._vaultEventListenerManager.evaluateListeners();
				}
				if (this._vaultEventScheduler) {
					const enabledScheduleHooks = this.settings.vault_event_hooks.on_schedule.filter(
						(h) => h.enabled
					);
					this._vaultEventScheduler.syncJobs(enabledScheduleHooks);
				}

				// Show a persistent error Notice for each failed user extension
				const userErrors = result.errors.filter(e => !e.filePath.startsWith("(built-in"));
				for (const error of userErrors) {
					const filename = error.filePath.split("/").pop() ?? error.filePath;
					const NOTICE_DURATION_MS = 0; // persistent until dismissed
					const notice = new Notice(
						`Extension error in "${filename}": ${error.message}` +
							(Platform.isDesktop ? "\n(right-click to open note)" : ""),
						NOTICE_DURATION_MS,
					);
					this._extensionStaleNotice = notice;
					if (Platform.isDesktop) {
						notice.messageEl.oncontextmenu = (e) => {
							e.preventDefault();
							notice.hide();
							if (this._extensionStaleNotice === notice) this._extensionStaleNotice = null;
							void this.app.workspace.openLinkText(error.filePath, "", true);
						};
					}
					notice.messageEl.addEventListener("click", () => {
						if (this._extensionStaleNotice === notice) this._extensionStaleNotice = null;
					});
				}
			}).catch((err) => {
				log.error("Extension auto-reload failed", { error: String(err) });
				new Notice(`Extension reload failed: ${err instanceof Error ? err.message : String(err)}`);
			});
		}, 1000);
	}

	/**
	 * Validate that required model presets are configured when `memory_enabled`
	 * is true at startup. If any preset is missing, disable the memory feature
	 * and show a long-lived Notice.
	 */
	private validateMemoryPresetsOnLoad(): void {
		if (!this.settings.memory_enabled) return;

		const missing: { preset: string; usedBy: string }[] = [];
		const checks = [
			{ preset: "tiny", usedBy: "memory-search, memory-resolver, memory-capture" },
			{ preset: "large", usedBy: "memory-dream" },
		];
		for (const check of checks) {
			if (!resolvePreset(check.preset, this.settings.model_presets)) {
				missing.push(check);
			}
		}

		if (missing.length > 0) {
			this.settings.memory_enabled = false;
			void this.saveSettings();
			const lines = missing.map((m) => `• Preset "${m.preset}" (used by ${m.usedBy})`);
			new Notice(
				`Memory disabled — required model presets are not configured:\n${lines.join("\n")}\n\nConfigure them in Settings → Models, then re-enable memory.`,
				10000,
			);
		}
	}

	/**
	 * Register vault and metadata-cache event listeners that show a
	 * "reload extensions" Notice when extension files change.
	 *
	 * Follows the same pattern as `registerWorkflowVaultWatcher()`.
	 * All listeners are automatically torn down on plugin unload via
	 * `registerEvent()`.
	 *
	 * @see specs/05-user-tools/tasks.md — EXT-024
	 */
	private registerExtensionVaultWatcher(): void {
		this.registerEvent(
			this.app.vault.on("create", (f) => {
				if (isExtensionFile(f, this.settings.notor_dir)) {
					this.scheduleExtensionAutoReload();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (isExtensionFile(f, this.settings.notor_dir)) {
					this.scheduleExtensionAutoReload();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				if (
					isExtensionFile(f, this.settings.notor_dir) ||
					isExtensionPath(oldPath, this.settings.notor_dir)
				) {
					this.scheduleExtensionAutoReload();
				}
			})
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (f) => {
				if (isExtensionFile(f, this.settings.notor_dir)) {
					this.scheduleExtensionAutoReload();
				}
			})
		);
	}

	/**
	 * Debounced handler for persona file changes.
	 *
	 * Automatically refreshes the active persona after a 1000ms debounce. On
	 * success, a brief Notice is shown. If the persona's file fails to parse,
	 * shows a persistent error Notice with right-click to open the affected note
	 * while keeping the old persona state active.
	 */
	private schedulePersonaAutoReload(): void {
		if (this._personaChangeTimer !== null) {
			clearTimeout(this._personaChangeTimer);
		}
		this._personaChangeTimer = setTimeout(() => {
			this._personaChangeTimer = null;

			this.getPersonaManager().refreshActivePersona().then((result) => {
				switch (result.status) {
					case "refreshed":
						new Notice(`Persona "${result.persona.name}" reloaded.`);
						break;
					case "deactivated":
						new Notice(`Persona "${result.previousName}" was removed; deactivated.`);
						break;
					case "no-active-persona":
						// No active persona — nothing to report
						break;
					case "error": {
						const filename = result.filePath.split("/").pop() ?? result.filePath;
						const notice = new Notice(
							`Persona error in "${filename}": ${result.message}` +
								(Platform.isDesktop ? "\n(right-click to open note)" : ""),
							0,
						);
						this._personaStaleNotice = notice;
						if (Platform.isDesktop) {
							notice.messageEl.oncontextmenu = (e) => {
								e.preventDefault();
								notice.hide();
								if (this._personaStaleNotice === notice) this._personaStaleNotice = null;
								void this.app.workspace.openLinkText(result.filePath, "", true);
							};
						}
						notice.messageEl.addEventListener("click", () => {
							if (this._personaStaleNotice === notice) this._personaStaleNotice = null;
						});
						break;
					}
				}
			}).catch((err) => {
				log.error("Persona auto-reload failed", { error: String(err) });
				new Notice(`Persona refresh failed: ${err instanceof Error ? err.message : String(err)}`);
			});
		}, 1000);
	}

	/**
	 * Register vault and metadata-cache event listeners that show a
	 * "reload persona" Notice when persona files change.
	 *
	 * Follows the same pattern as `registerExtensionVaultWatcher()`.
	 */
	private registerPersonaVaultWatcher(): void {
		this.registerEvent(
			this.app.vault.on("create", (f) => {
				if (isPersonaFile(f, this.settings.notor_dir)) {
					this.schedulePersonaAutoReload();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (isPersonaFile(f, this.settings.notor_dir)) {
					this.schedulePersonaAutoReload();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				if (
					isPersonaFile(f, this.settings.notor_dir) ||
					isPersonaPath(oldPath, this.settings.notor_dir)
				) {
					this.schedulePersonaAutoReload();
				}
			})
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (f) => {
				if (isPersonaFile(f, this.settings.notor_dir)) {
					this.schedulePersonaAutoReload();
				}
			})
		);
	}

	// -----------------------------------------------------------------------
	// View wiring
	// -----------------------------------------------------------------------

	/**
	 * Return the union of active sessions from all open chat panels.
	 *
	 * Used as the global `getActiveSessions` getter so every panel's activity
	 * indicator badge and dropdown reflect sessions across all panels, not just
	 * the one they belong to.
	 */
	private _getAllActiveSessions(): ConversationSession[] {
		const result: ConversationSession[] = [];
		for (const orch of this._orchestrators.values()) {
			result.push(...orch.getActiveSessions());
		}
		return result;
	}

	private wireView(view: NotorChatView, orchestrator: ChatOrchestrator): void {
		wireViewFn(view, orchestrator, this);
	}


	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------

	/**
	 * Open (or reveal) the tool config inspector view (UI-003 / FR-88).
	 *
	 * Opens alongside the chat panel. If already open, reveals the existing leaf.
	 */
	async openInspector(): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(INSPECTOR_VIEW_TYPE);
		if (existing.length > 0) {
			void workspace.revealLeaf(existing[0] as WorkspaceLeaf);
			// Refresh content when re-revealed
			const view = existing[0]?.view as EffectiveConfigInspectorView | undefined;
			view?.refresh();
			return;
		}

		const leaf = workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: INSPECTOR_VIEW_TYPE, active: true });
			void workspace.revealLeaf(leaf);
		}
	}

	/** Open (or reveal) a Notor chat panel. */
	async openChatPanel(): Promise<void> {
		const { workspace } = this.app;

		// Reveal an existing chat panel if one is open
		const leaves = workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		if (leaves.length > 0) {
			void workspace.revealLeaf(leaves[0]!);
			return;
		}

		// Open in the right sidebar
		const leaf = workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
			void workspace.revealLeaf(leaf);
		}
	}

	/**
	 * Open (or reveal) the unified run-tree view, rooted at a run (POL-003 /
	 * FR-178/179). Called from the inline peek card's "Open run tree" affordance,
	 * the activity indicator's flow-run entries, and (future) a progress Notice. An
	 * existing run-tree leaf is re-rooted via `setViewState`; otherwise one is
	 * opened in the right sidebar.
	 */
	async openRunTreeView(root: { sessionId?: string; conversationId?: string }): Promise<void> {
		const { workspace } = this.app;
		const state = { rootSessionId: root.sessionId, rootConversationId: root.conversationId };

		const existing = workspace.getLeavesOfType(ORCHESTRATION_RUN_TREE_VIEW_TYPE);
		if (existing.length > 0) {
			const leaf = existing[0]!;
			await leaf.setViewState({ type: ORCHESTRATION_RUN_TREE_VIEW_TYPE, active: true, state });
			void workspace.revealLeaf(leaf);
			return;
		}

		const leaf = workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: ORCHESTRATION_RUN_TREE_VIEW_TYPE, active: true, state });
			void workspace.revealLeaf(leaf);
		}
	}

	/**
	 * Open a Notor chat panel in a new tab.
	 * If conversationFilename is provided, that conversation is loaded via setState.
	 * Optionally accepts conversationId to load by ID instead of filename.
	 */
	openChatInNewTab(conversationFilename?: string, createNew = false, initialText?: string, conversationId?: string): void {
		const leaf = this.app.workspace.getLeaf("tab");
		const state: Record<string, unknown> = {};
		if (conversationId) {
			state.conversationId = conversationId;
		} else if (conversationFilename) {
			state.conversationFilename = conversationFilename;
		} else if (createNew) {
			state.createNew = true;
		}
		if (initialText) {
			state.initialText = initialText;
		}
		leaf.setViewState({
			type: CHAT_VIEW_TYPE,
			active: true,
			...(Object.keys(state).length > 0 ? { state } : {}),
		}).catch((e) => {
			log.error("Failed to open chat panel in new tab", { error: String(e) });
		});
	}

	/**
	 * Start a new conversation (command palette action).
	 *
	 * Routes to the active/focused orchestrator via `getActiveOrchestrator()`.
	 * View is obtained via `orchestrator.getView()` for consistency with the
	 * `_lastFocusedChatLeafId` fallback (avoids mismatch when focus is on a
	 * non-chat view).
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — A4.1
	 */
	newConversation(): void {
		const orchestrator = this.getActiveOrchestrator();
		if (!orchestrator) {
			// No panel open — open one first, then it will auto-start a conversation
			this.openChatPanel().catch((e) => {
				log.error("Failed to open chat panel", { error: String(e) });
			});
			return;
		}

		const view = orchestrator.getView();
		orchestrator
			.newConversation()
			.then(() => {
				this.syncViewAfterLoad(view!, orchestrator);
				// Refresh conversation list
				this.getHistoryManager()
					.listConversations()
					.then((entries) => {
						view?.renderConversationList(entries);
					})
					.catch(() => {});
			})
			.catch((e) => {
				log.error("Failed to create new conversation from command", {
					error: String(e),
				});
				new Notice(
					`Failed to create conversation: ${e instanceof Error ? e.message : String(e)}`
				);
			});
	}

	// -----------------------------------------------------------------------
	// Export helpers
	// -----------------------------------------------------------------------

	/**
	 * Load sub-agent conversation messages for all `use_subagent` tool results
	 * in the given message list. Returns a map keyed by JSONL filename.
	 *
	 * @see specs/ZZ-misc/sub-agents-design.md — Section 5.3
	 */
	private async loadSubAgentConversations(
		messages: import("./types").Message[],
	): Promise<SubAgentConversationMap> {
		const map: SubAgentConversationMap = new Map();
		const historyManager = this.getHistoryManager();

		for (const msg of messages) {
			const childMeta = msg.tool_result
				? (msg.tool_result.child_run_metadata ?? msg.tool_result.sub_agent_metadata)
				: null;
			if (
				msg.role === "tool_result" &&
				msg.tool_result?.tool_name === USE_SUBAGENT_TOOL_NAME &&
				childMeta?.jsonl_filename
			) {
				const filename = childMeta.jsonl_filename;
				try {
					const subMessages = await historyManager.loadSubAgentMessages(filename);
					map.set(filename, subMessages);
				} catch (e) {
					log.warn("Failed to load sub-agent conversation for export", {
						filename,
						error: String(e),
					});
				}
			}
		}

		return map;
	}

	showExportModal(conversation: import("./types").Conversation, messages: import("./types").Message[]): void {
		new ExportModal(this.app, conversation, async (format: ExportFormat, folderPath: string) => {
			try {
				let content: string;
				if (format === "markdown") {
					content = exportToMarkdown(conversation, messages);
				} else {
					// Phase 6.3: Load sub-agent conversations for HTML export
					const subAgentConversations = await this.loadSubAgentConversations(messages);
					content = exportToHtml(conversation, messages, subAgentConversations);
				}

				const ext = format === "markdown" ? "md" : "html";
				const sanitized = sanitizeFilename(conversation.title);
				const now = new Date();
				const ts = [
					now.getFullYear(),
					String(now.getMonth() + 1).padStart(2, "0"),
					String(now.getDate()).padStart(2, "0"),
					"_",
					String(now.getHours()).padStart(2, "0"),
					String(now.getMinutes()).padStart(2, "0"),
					String(now.getSeconds()).padStart(2, "0"),
				].join("");
				const filename = `${sanitized}_${ts}.${ext}`;
				const fullPath = folderPath ? `${folderPath}/${filename}` : filename;

				// Check for existing file
				const existing = this.app.vault.getAbstractFileByPath(fullPath);
				if (existing) {
					new Notice(`File already exists: ${fullPath}`);
					return;
				}

				await this.app.vault.create(fullPath, content);
				new Notice(`Exported to ${fullPath}`);
				log.info("Conversation exported", { format, path: fullPath });
			} catch (e) {
				log.error("Export failed", { error: String(e) });
				new Notice(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}).open();
	}
}

function sanitizeFilename(title?: string): string {
	return (title || "Untitled-conversation")
		.replace(/[^a-zA-Z0-9\s\-_]/g, "")
		.replace(/\s+/g, "-")
		.substring(0, 60)
		|| "Untitled-conversation";
}