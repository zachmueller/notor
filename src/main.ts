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
import { MarkdownView } from "obsidian";
import { createDefaultSettings, NotorSettingTab } from "./settings";
import type { NotorSettings } from "./settings";
import { logger, setLogLevel } from "./utils/logger";
import { notifyMarkdownLeafActivated, getLastActiveMarkdownPath } from "./context/auto-context";

// Workflows
import { discoverWorkflows } from "./workflows/workflow-discovery";
import {
	showWorkflowPicker,
	showActiveNoteWorkflowPicker,
	buildActiveNoteContent,
	resolveActiveNotePrompt,
} from "./workflows/workflow-executor";
import type { Workflow } from "./types";

// Group G: Workflow hook override manager
import { WorkflowHookOverrideManager } from "./hooks/workflow-hook-override";

// Group H: Workflow activity tracker
import { WorkflowActivityTracker } from "./workflows/workflow-activity-tracker";

// Export / Import
import { ExportModal, type ExportFormat } from "./export/export-modal";
import { ConfirmModal } from "./ui/confirm-modal";
import { exportToMarkdown } from "./export/markdown-exporter";
import { exportToHtml, type SubAgentConversationMap } from "./export/html-exporter";
import { USE_SUBAGENT_TOOL_NAME } from "./sub-agents/constants";
import { extractJsonlFromHtml, reassignIds } from "./export/html-importer";

// Group F: Vault event hooks
import { TagShadowCache } from "./hooks/tag-change-detector";
import { TagChangeSuppressionManager } from "./hooks/tag-change-detector";
import { VaultEventDebounce } from "./hooks/vault-event-debounce";
import { ExecutionChainTracker } from "./hooks/execution-chain";
import { ManualSaveDetector } from "./hooks/manual-save-detector";
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
import { parseOptionValue, buildOptionValue } from "./providers/model-grouping";
import type { LLMProviderType } from "./types";

// Tools
import { ToolRegistry } from "./tools/index";
import { NoteOpener } from "./tools/note-opener";

// Chat
import { ToolDispatcher } from "./chat/dispatcher";
import { HistoryManager } from "./chat/history";
import { SystemPromptBuilder } from "./chat/system-prompt";
import { ChatOrchestrator } from "./chat/orchestrator";
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

// Extensions
import { ExtensionManager } from "./extensions/manager";
import type { AutomationTrigger } from "./extensions/types";
import { isExtensionFile, isExtensionPath } from "./extensions/watcher";

// MCP
import { McpHub } from "./mcp/mcp-hub";
import { McpRegisteredTool } from "./mcp/mcp-tool-adapter";

// Queue
import { TaskLaneQueue } from "./queue/task-lane-queue";

// Web Search
import { SearchProviderRegistry } from "./web-search/provider-registry";
import { WebSearchQueue } from "./web-search/queue";
import { DuckDuckGoProvider } from "./web-search/providers/duckduckgo";
import { TavilyProvider } from "./web-search/providers/tavily";
import { BraveSearchProvider } from "./web-search/providers/brave";
import { SerpApiProvider } from "./web-search/providers/serpapi";

// UI
import { NotorChatView, CHAT_VIEW_TYPE } from "./ui/chat-view";
import { EffectiveConfigInspectorView, INSPECTOR_VIEW_TYPE } from "./ui/effective-config-inspector";

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
	private _systemPromptBuilder?: SystemPromptBuilder;
	private _vaultRuleManager?: VaultRuleManager;
	private _orchestrator?: ChatOrchestrator;

	/**
	 * Orchestrators for secondary chat panels.
	 *
	 * Each secondary panel gets its own `ChatOrchestrator` sharing
	 * infrastructure singletons. Tracked for cleanup in `onunload()`.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	private _secondaryOrchestrators: ChatOrchestrator[] = [];

	/** Guard to prevent multiple wireView() calls from re-registering the persona name change callback. */
	private _personaNameChangeWired = false;
	private _noteOpener?: NoteOpener;
	private _staleTracker?: StaleContentTracker;
	private _personaManager?: PersonaManager;
	private _subAgentManager?: SubAgentManager;
	private _extensionManager?: ExtensionManager;
	private _settingTab?: NotorSettingTab;

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

	/** Debounce timer for vault-triggered workflow rescans. */
	private _workflowRescanTimer: ReturnType<typeof setTimeout> | null = null;

	/** Debounce timer for extension file change Notice (EXT-024). */
	private _extensionChangeTimer: ReturnType<typeof setTimeout> | null = null;

	/** Reference to the "stale extensions" Notice for duplicate suppression (EXT-024). */
	private _extensionStaleNotice: Notice | null = null;

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

		// 3. Register the chat panel view type.
		// Both primary and secondary panels use the same view type.
		// Secondary panels get their own orchestrator sharing infrastructure singletons.
		// @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
		this.registerView(CHAT_VIEW_TYPE, (leaf) => {
			const view = new NotorChatView(leaf, this);

			// Check if this is a secondary panel (set by setState during workspace
			// restore or by setIsSecondary before wireView for command-created panels).
			// At this point during initial registerView, the leaf state may not be
			// set yet — secondary detection happens in two places:
			// 1. Command-created: the command calls wireViewAsSecondary() explicitly
			// 2. Workspace restore: setState() triggers re-wiring via a deferred callback
			//
			// Default wiring uses the primary orchestrator singleton.
			this.wireView(view);
			return view;
		});

		// 3b. Register the tool config inspector view type (UI-003 / FR-88)
		this.registerView(INSPECTOR_VIEW_TYPE, (leaf) => {
			const inspectorView = new EffectiveConfigInspectorView(leaf);
			inspectorView.setOrchestrator(this.getOrchestrator());
			return inspectorView;
		});

		// 4. Register commands
		this.addCommand({
			id: "open-chat-panel",
			name: "Open chat panel",
			callback: () => this.openChatPanel(),
		});

		this.addCommand({
			id: "new-conversation",
			name: "New conversation",
			callback: () => this.newConversation(),
		});

		// Phase 3 (COMP-004): Manual compaction command
		this.addCommand({
			id: "compact-context",
			name: "Compact context",
			callback: () => {
				this.getOrchestrator().manualCompaction().catch((e) => {
					log.error("Manual compaction failed", { error: String(e) });
					new Notice(`Compaction failed: ${e instanceof Error ? e.message : String(e)}`);
				});
			},
		});

		// UI-003: Open the tool config inspector (FR-88)
		this.addCommand({
			id: "open-tool-config-inspector",
			name: "Open tool config inspector",
			callback: () => this.openInspector(),
		});

		// E-009: "Notor: Run workflow" command palette entry.
		// Rescans workflows on each invocation so newly created/deleted
		// workflows are reflected without a plugin reload (FR-41).
		this.addCommand({
			id: "run-workflow",
			name: "Run workflow",
			callback: () => {
				try {
					showWorkflowPicker(
						this.app,
						() => this.rescanWorkflows(),
						(workflow) => {
							// Open the chat panel if not already open, then execute the workflow.
							this.openChatPanel().then(() => {
								log.info("Workflow selected from command palette", {
									display_name: workflow.display_name,
									file_path: workflow.file_path,
								});
								// E-013: Execute the workflow via the orchestrator.
								return this.getOrchestrator().executeWorkflow(workflow);
							}).catch((e) => {
								log.error("Failed to execute workflow from command palette", {
									error: String(e),
								});
								new Notice(`Workflow execution failed: ${e instanceof Error ? e.message : String(e)}`);
							});
						},
						this.settings.notor_dir
					);
				} catch (e) {
					log.error("Run workflow command failed", { error: String(e) });
					new Notice(`Failed to open workflow picker: ${e instanceof Error ? e.message : String(e)}`);
				}
			},
		});

		// Launch active-note-scoped workflow against the currently focused note.
		// Opens a filtered picker showing only workflows with `notor-active-note-prompt`.
		this.addCommand({
			id: "launch-active-note-workflow",
			name: "Launch active note workflow",
			callback: () => {
				try {
					// Resolve active note path (two-stage: active view + cache fallback)
					const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
					let activeFilePath = activeView?.file?.path ?? null;
					if (!activeFilePath) {
						activeFilePath = getLastActiveMarkdownPath();
					}
					if (!activeFilePath) {
						new Notice("No active note found.");
						return;
					}

					const capturedPath = activeFilePath;

					showActiveNoteWorkflowPicker(
						this.app,
						() => this.rescanWorkflows(),
						(workflow) => {
							(async () => {
								const activeNoteContent = await buildActiveNoteContent(
									capturedPath,
									this.app.vault,
								);
								const resolvedPrompt = resolveActiveNotePrompt(
									workflow.active_note_prompt!,
									activeNoteContent,
								);

								await this.openChatPanel();
								log.info("Active note workflow selected", {
									display_name: workflow.display_name,
									active_note: capturedPath,
								});
								await this.getOrchestrator().executeWorkflow(workflow, resolvedPrompt);
							})().catch((e) => {
								log.error("Failed to execute active note workflow", {
									error: String(e),
								});
								new Notice(
									`Active note workflow failed: ${e instanceof Error ? e.message : String(e)}`
								);
							});
						},
						this.settings.notor_dir
					);
				} catch (e) {
					log.error("Launch active note workflow command failed", { error: String(e) });
					new Notice(
						`Failed to open active note workflow picker: ${e instanceof Error ? e.message : String(e)}`
					);
				}
			},
		});

		// Export active conversation
		this.addCommand({
			id: "export-conversation",
			name: "Export conversation",
			callback: () => {
				try {
					const orchestrator = this.getOrchestrator();
					const convManager = orchestrator.getConversationManager();
					const conversation = convManager.getActiveConversation();
					const messages = convManager.getMessages();
					if (!conversation) {
						new Notice("No active conversation to export");
						return;
					}
					this.showExportModal(conversation, messages);
				} catch (e) {
					log.error("Export conversation command failed", { error: String(e) });
					new Notice(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
				}
			},
		});

		// Import conversation from exported HTML file
		this.addCommand({
			id: "import-conversation",
			name: "Import conversation from HTML",
			callback: () => {
				const input = document.createElement("input");
				input.type = "file";
				input.accept = ".html";
				input.style.display = "none";
				document.body.appendChild(input);

				input.addEventListener("change", () => {
					const file = input.files?.[0];
					if (!file) {
						input.remove();
						return;
					}

					const reader = new FileReader();
					reader.onload = async () => {
						try {
							const htmlContent = reader.result as string;
							const extracted = extractJsonlFromHtml(htmlContent);
							if (!extracted) {
								new Notice("This HTML file does not contain embedded conversation data");
								return;
							}
							const { conversation, messages } = reassignIds(
								extracted.conversation,
								extracted.messages
							);
							const filename = await this.getHistoryManager().importConversation(conversation, messages);
							await this.getOrchestrator().switchConversation(filename);
							new Notice(`Imported conversation: ${conversation.title ?? "Untitled"}`);
						} catch (e) {
							log.error("Import conversation command failed", { error: String(e) });
							new Notice(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
						} finally {
							input.remove();
						}
					};
					reader.onerror = () => {
						log.error("Failed to read imported file", { error: String(reader.error) });
						new Notice("Failed to read selected file");
						input.remove();
					};
					reader.readAsText(file);
				});

				input.click();
			},
		});

		// Phase 4, Step 4d: Open a secondary chat panel in a new tab.
		// Each secondary panel gets its own orchestrator for independent
		// provider/model state and concurrent streaming.
		// Obsidian calls the factory (registerView), creates the view, then
		// calls setState() which detects isSecondary and re-wires with its
		// own orchestrator.
		this.addCommand({
			id: "open-secondary-chat",
			name: "Open new chat panel",
			callback: () => {
				const leaf = this.app.workspace.getLeaf("tab");
				leaf.setViewState({
					type: CHAT_VIEW_TYPE,
					active: true,
					state: { isSecondary: true },
				}).catch((e) => {
					log.error("Failed to open secondary chat panel", { error: String(e) });
				});
			},
		});

		// EXT-016: Reload user extensions from vault files.
		this.addCommand({
			id: "reload-extensions",
			name: "Reload user extensions",
			callback: () => {
				this.getExtensionManager().reload(false).then((result) => {
					const summary =
						`Extensions reloaded: ${result.toolCount} tool${result.toolCount !== 1 ? "s" : ""}, ` +
						`${result.automationCount} automation${result.automationCount !== 1 ? "s" : ""}` +
						(result.errors.length > 0 ? ` (${result.errors.length} error${result.errors.length !== 1 ? "s" : ""})` : "");
					new Notice(summary);
				}).catch((e) => {
					log.error("Extension reload failed", { error: String(e) });
					new Notice(`Extension reload failed: ${e instanceof Error ? e.message : String(e)}`);
				});
			},
		});

		// 5. Register active-leaf-change listener so the auto-context module
		// can track the last-focused markdown note even when the chat panel
		// (or another non-markdown view) has focus at send time (ACI-005).
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				const view = leaf?.view;
				if (view instanceof MarkdownView && view.file?.path) {
					notifyMarkdownLeafActivated(view.file.path);
				}
				// Intentionally NOT clearing the cache on non-markdown leaf
				// changes — that lets us recover the last active note when the
				// user switches to the chat panel (or any other non-markdown view).
			})
		);

		// 6. Start vault rule manager (watches rules directory for changes)
		// This is lightweight — just sets up file watchers
		this.getVaultRuleManager().start();

		// 7. Initialize Group F: vault event hook components (F-023).
		// Heavy init (tag shadow cache) is deferred to onLayoutReady.
		this._initVaultEventHooks();

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
				this.rescanWorkflows();
				this.registerWorkflowVaultWatcher();
			} catch (e) {
				log.warn("Initial workflow discovery failed", { error: String(e) });
			}

			// EXT-017: Discover and compile user extensions (tools + automations).
			// Scaffold defaults for all 20 built-in tools are injected here;
			// vault-authored overrides win by last-write-wins.
			// isInitialLoad=true skips dispatcher registration during reload().
			// However, if the dispatcher was already created (e.g., by workspace
			// restore triggering wireView() → getOrchestrator() → getToolDispatcher()
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
			}).catch((e) => {
				log.warn("Initial extension discovery failed", { error: String(e) });
			});
		});

		log.info("Plugin loaded");
	}

	onunload() {
		log.info("Plugin unloading");

		// Step 1h: Abort all active sessions first so their response loops can
		// flush JSONL writes before infrastructure singletons are torn down.
		// Fire-and-forget since onunload() is synchronous — the 2s timeout
		// in destroy() prevents hanging.
		this._orchestrator?.destroy().catch((e) => {
			log.error("Orchestrator destroy failed", { error: String(e) });
		});

		// Phase 4: Destroy secondary orchestrators
		for (const orch of this._secondaryOrchestrators) {
			orch.destroy().catch((e) => {
				log.error("Secondary orchestrator destroy failed", { error: String(e) });
			});
		}
		this._secondaryOrchestrators = [];

		// Clear the last-active markdown path cache on unload
		notifyMarkdownLeafActivated(null);

		// Stop vault rule manager file watchers
		this._vaultRuleManager?.stop();

		// Clear cached workflow discovery results (C-008)
		this._discoveredWorkflows = [];

		// Group F: Tear down vault event hook components in reverse order (F-023)
		this._vaultEventListenerManager?.destroy();
		this._vaultEventScheduler?.destroy();
		this._manualSaveDetector?.destroy();
		this._tagSuppression?.destroy();
		this._vaultEventDebounce?.destroy();
		// this._executionChainTracker — stateless, nothing to destroy
		this._tagShadowCache?.destroy();
		this._workflowConcurrencyManager?.destroy();

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

		// All DOM elements, intervals, and event listeners registered via
		// this.register* / this.registerEvent / this.registerDomEvent are
		// automatically cleaned up by Obsidian when the plugin unloads.

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

		if (this.settings) {
			// Mutate the existing object so all components that captured a reference
			// (e.g. ReadFileTool, ExecuteCommandTool) see the updated values.
			Object.assign(this.settings, loaded);
		} else {
			this.settings = loaded;
		}

		// One-time migration of old tool settings into the extension settings system.
		await this.migrateToolSettingsToExtensions();
	}

	/**
	 * One-time migration of old NotorSettings tool fields into the extension
	 * settings system (per-extension + shared). See spec D-2.
	 *
	 * Detection: per-tool-group check — migrate only if the extension settings
	 * key is absent (undefined) AND the old field exists in loaded data.
	 *
	 * Atomicity: two-phase write.
	 *   Phase 1: copy values into extension settings + saveSettings()
	 *   Phase 2: delete old fields from settings object + saveSettings()
	 * If the plugin crashes between phases, next boot sees old fields still
	 * present but extension settings already populated — detection skips
	 * already-migrated groups.
	 */
	private async migrateToolSettingsToExtensions(): Promise<void> {
		let migrated = false;

		// --- Per-extension settings groups ---

		// fetch_webpage
		if (
			this.settings.user_extension_settings["fetch_webpage"] === undefined &&
			this.settings.fetch_webpage_timeout !== undefined
		) {
			this.settings.user_extension_settings["fetch_webpage"] = {
				fetch_webpage_timeout: this.settings.fetch_webpage_timeout,
				fetch_webpage_max_download_mb: this.settings.fetch_webpage_max_download_mb,
				fetch_webpage_max_output_chars: this.settings.fetch_webpage_max_output_chars,
			};
			migrated = true;
		}

		// web_search (fields removed from NotorSettings — cast through raw data)
		const rawWs = this.settings as unknown as Record<string, unknown>;
		if (
			this.settings.user_extension_settings["web_search"] === undefined &&
			rawWs.web_search_timeout !== undefined
		) {
			this.settings.user_extension_settings["web_search"] = {
				web_search_timeout: rawWs.web_search_timeout as number,
				web_search_default_num_results: rawWs.web_search_default_num_results as number,
			};
			migrated = true;
		}

		// execute_command
		if (
			this.settings.user_extension_settings["execute_command"] === undefined &&
			this.settings.execute_command_timeout !== undefined
		) {
			this.settings.user_extension_settings["execute_command"] = {
				execute_command_allowed_paths: this.settings.execute_command_allowed_paths,
				execute_command_timeout: this.settings.execute_command_timeout,
				execute_command_max_output_chars: this.settings.execute_command_max_output_chars,
			};
			migrated = true;
		}

		// read_file
		if (
			this.settings.user_extension_settings["read_file"] === undefined &&
			this.settings.image_max_dimension !== undefined
		) {
			this.settings.user_extension_settings["read_file"] = {
				image_max_dimension: this.settings.image_max_dimension,
				image_compression_quality: this.settings.image_compression_quality,
				pdf_prefer_native: this.settings.pdf_prefer_native,
				pdf_text_max_chars: this.settings.pdf_text_max_chars,
				pdf_native_max_size_mb: this.settings.pdf_native_max_size_mb,
			};
			migrated = true;
		}

		// write_docx
		if (
			this.settings.user_extension_settings["write_docx"] === undefined &&
			this.settings.write_docx_default_output_dir !== undefined
		) {
			this.settings.user_extension_settings["write_docx"] = {
				write_docx_default_output_dir: this.settings.write_docx_default_output_dir,
				write_docx_default_template_path: this.settings.write_docx_default_template_path,
			};
			migrated = true;
		}

		// --- Shared settings ---

		// domain_denylist
		if (
			this.settings.user_shared_settings["domain_denylist"] === undefined &&
			this.settings.domain_denylist !== undefined
		) {
			this.settings.user_shared_settings["domain_denylist"] = this.settings.domain_denylist;
			migrated = true;
		}

		// read_file_allowed_paths
		if (
			this.settings.user_shared_settings["read_file_allowed_paths"] === undefined &&
			this.settings.read_file_allowed_paths !== undefined
		) {
			this.settings.user_shared_settings["read_file_allowed_paths"] = this.settings.read_file_allowed_paths;
			migrated = true;
		}

		if (!migrated) return;

		// Phase 1: persist the copied extension settings
		await this.saveSettings();

		// Phase 2: strip old fields from persisted data only.
		// The in-memory settings object retains the old fields so that non-tool
		// code (shell-executor, hooks, orchestrator, attachment-picker) which
		// still references them continues working during this session. On next
		// boot, loadSettings() merges defaults (which still provide these fields)
		// with the cleaned data.json. Phase 7 will remove these legacy references.
		const oldFields = [
			"fetch_webpage_timeout",
			"fetch_webpage_max_download_mb",
			"fetch_webpage_max_output_chars",
			"domain_denylist",
			"web_search_timeout",
			"web_search_default_num_results",
			"execute_command_timeout",
			"execute_command_max_output_chars",
			"execute_command_allowed_paths",
			"image_max_dimension",
			"image_compression_quality",
			"pdf_native_max_size_mb",
			"pdf_text_max_chars",
			"pdf_prefer_native",
			"read_file_allowed_paths",
			"write_docx_default_output_dir",
			"write_docx_default_template_path",
		];

		const rawData = (await this.loadData()) as Record<string, unknown> | null;
		if (rawData) {
			for (const field of oldFields) {
				delete rawData[field];
			}
			await this.saveData(rawData);
		}

		new Notice("Tool settings have been migrated to Extensions in Settings.", 5000);
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

		// Step 7: Vault event scheduler (cron jobs for on_schedule hooks)
		const vaultEventScheduler = new VaultEventScheduler();
		this._vaultEventScheduler = vaultEventScheduler;

		// Step 8: Build the dispatcher deps object (assembled here for access
		// by handler closures). Orchestrator is accessed lazily via getter so
		// it isn't initialized until first use (lazy init pattern).
		const getDispatcherDeps = (): DispatcherDeps => {
			return {
				app: this.app,
				vault: this.app.vault,
				metadataCache: this.app.metadataCache,
				getSettings: () => this.settings,
				vaultRootPath: this.vaultRootPath,
				concurrencyManager: workflowConcurrencyManager,
				orchestrator: this.getOrchestrator(),
				personaManager: this._personaManager,
				chainTracker: executionChainTracker,
				// EXT-017: Wire extension automation accessor + executor for vault event hooks.
				// Uses lazy accessor so it returns [] until extensions are discovered.
				getExtensionAutomations: (trigger) => this.getExtensionManager().getAutomationsForTrigger(trigger),
				executeExtensionAutomation: (automation, context) => this.getExtensionManager().executeAutomation(automation, context),
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
			if (!toolRegistry || !toolDispatcher) return;

			if (status === "connected") {
				// Server connected + tools discovered → register MCP tools
				const connection = mcpHub.getConnection(serverName);
				if (!connection) return;

				// Mode accessor: reads current mode from the orchestrator's
				// conversation manager at call time
				const getModeCallback = (): "plan" | "act" => {
					try {
						const convManager = this._orchestrator?.getConversationManager();
						return convManager?.getActiveConversation()?.mode ?? this.settings.mode;
					} catch {
						return this.settings.mode;
					}
				};

				for (const discoveredTool of connection.tools) {
					const registeredTool = new McpRegisteredTool(
						serverName,
						discoveredTool,
						connection.config,
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

		log.info("McpHub initialized (connections launching in background)");
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
				this.settings.active_provider as LLMProviderType
			);
		}

		if (this._orchestrator) {
			this._orchestrator.updateSettings(this.settings);
		}

		if (this._noteOpener) {
			this._noteOpener.setEnabled(this.settings.open_notes_on_access);
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
				this.settings.active_provider as LLMProviderType
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
			registry.updateConfig(
				this.settings.providers.find((p) => p.type === "bedrock") ?? {
					type: "bedrock",
					enabled: false,
					display_name: "AWS Bedrock",
				}
			);
			log.debug("Bedrock provider registered");
		} catch (e) {
			log.warn("Failed to register Bedrock provider", { error: String(e) });
		}
	}

	/** Stale content tracker for write tool safety. */
	getStaleTracker(): StaleContentTracker {
		if (!this._staleTracker) {
			this._staleTracker = new StaleContentTracker();
		}
		return this._staleTracker;
	}

	/** Note opener utility. */
	getNoteOpener(): NoteOpener {
		if (!this._noteOpener) {
			this._noteOpener = new NoteOpener(
				this.app,
				this.settings.open_notes_on_access
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

	/** Checkpoint manager. */
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
				() => this.getOrchestrator()?.getEffectiveToolConfig() ?? null,
				this.getHistoryManager(),
				() => this.getOrchestrator()?.getConversationManager()?.getActiveConversation() ?? null,
			);
			if (this.vaultRootPath) {
				useSubagentTool.setVaultRootPath(this.vaultRootPath);
			}
			this._toolRegistry.register(useSubagentTool);
			// Fire-and-forget initial profile cache population
			useSubagentTool.refreshVisibleProfiles().catch((e) =>
				log.warn("Failed to load initial sub-agent profiles", { error: String(e) })
			);

			log.debug("Tool registry initialized", {
				tools: this._toolRegistry.getNames(),
			});
		}
		return this._toolRegistry;
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

			this._toolDispatcher.setActivePersonaName(
				this.settings.active_persona || null
			);

			// Set vault root path for working directory validation
			if (this.vaultRootPath) {
				this._toolDispatcher.setVaultRootPath(this.vaultRootPath);
			}
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
				this.app.metadataCache
			);
		}
		return this._systemPromptBuilder;
	}

	/** Vault rule manager. */
	getVaultRuleManager(): VaultRuleManager {
		if (!this._vaultRuleManager) {
			this._vaultRuleManager = new VaultRuleManager(
				this.app,
				this.settings.notor_dir
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
				async () => this.saveData(this.settings)
			);
		}
		return this._personaManager;
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

	/** Chat orchestrator — the main send/receive loop coordinator. */
	getOrchestrator(): ChatOrchestrator {
		if (!this._orchestrator) {
			const dispatcher = this.getToolDispatcher();
			const historyManager = this.getHistoryManager();
			const systemPromptBuilder = this.getSystemPromptBuilder();
			const providerRegistry = this.getProviderRegistry();
			const vaultRuleManager = this.getVaultRuleManager();

			this._orchestrator = new ChatOrchestrator(
				this.app,
				providerRegistry,
				systemPromptBuilder,
				dispatcher,
				historyManager,
				this.settings,
				undefined, // view wired later via wireView()
				vaultRuleManager
			);

			// Wire persona manager to orchestrator (A-013)
			this._orchestrator.setPersonaManager(this.getPersonaManager());

			// G-005/G-006/G-007: Wire workflow hook override manager to orchestrator
			this._orchestrator.setWorkflowHookOverrideManager(
				this.getWorkflowHookOverrideManager()
			);

			// EXT-017: Wire extension automation accessors to orchestrator.
			// Uses lazy accessor closures so the extension manager is only
			// created when the orchestrator is first used (not at import time).
			const mgr = this.getExtensionManager();
			this._orchestrator.setExtensionAccessors({
				lifecycle: {
					getForTrigger: (t) => mgr.getAutomationsForTrigger(t),
					execute: (a, c) => mgr.executeAutomation(a, c),
				},
				toolEvent: {
					getForToolEvent: (t, n) => mgr.getAutomationsForToolEvent(t, n),
					execute: (a, c) => mgr.executeAutomation(a, c),
				},
			});
		}
		return this._orchestrator;
	}

	/**
	 * Create a secondary orchestrator sharing infrastructure singletons.
	 *
	 * Each secondary panel gets its own `ChatOrchestrator` with its own
	 * `ConversationManager`, `activeSessions` map, and per-orchestrator
	 * provider/model fields. Expensive singletons (ProviderRegistry,
	 * HistoryManager, etc.) are shared.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	createSecondaryOrchestrator(): ChatOrchestrator {
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
			undefined, // view wired later via wireView()
			vaultRuleManager
		);

		// Wire same shared managers as primary
		orchestrator.setPersonaManager(this.getPersonaManager());
		orchestrator.setWorkflowHookOverrideManager(
			this.getWorkflowHookOverrideManager()
		);

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

		orchestrator.setGetToolDefinitions((config) => {
			const toolRegistry = this.getToolRegistry();
			if (config) {
				return toolRegistry.getFilteredToolDefinitions(config) as import("./providers/provider").ToolDefinition[];
			}
			return toolRegistry.getToolDefinitions() as import("./providers/provider").ToolDefinition[];
		});

		this._secondaryOrchestrators.push(orchestrator);
		log.info("Secondary orchestrator created", { total: this._secondaryOrchestrators.length });
		return orchestrator;
	}

	/**
	 * Wire a chat view as a secondary panel with its own orchestrator.
	 *
	 * Called from the "open-secondary-chat" command and from view setState()
	 * when restoring a secondary panel from workspace state.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	wireViewAsSecondary(view: NotorChatView): void {
		view.setIsSecondary(true);
		const orchestrator = this.createSecondaryOrchestrator();
		this.wireView(view, orchestrator);
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
	 * Returns true if `file` is a Markdown note inside the workflows
	 * subdirectory of the configured notor directory.
	 */
	private isWorkflowFile(file: TAbstractFile): boolean {
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
				if (this.isWorkflowFile(f)) this.scheduleWorkflowRescan();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (this.isWorkflowFile(f)) this.scheduleWorkflowRescan();
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				if (this.isWorkflowFile(f) || this.isWorkflowPath(oldPath)) {
					this.scheduleWorkflowRescan();
				}
			})
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (f) => {
				if (this.isWorkflowFile(f)) this.scheduleWorkflowRescan();
			})
		);
	}

	// -----------------------------------------------------------------------
	// Extension file watcher (EXT-024)
	// -----------------------------------------------------------------------

	/**
	 * Debounced handler for extension file changes.
	 *
	 * Shows a persistent Notice prompting the user to reload extensions.
	 * Uses 1000ms debounce (longer than the 300ms workflow watcher) since
	 * this only shows a Notice rather than auto-reloading.
	 *
	 * @see specs/05-user-tools/tasks.md — EXT-024
	 */
	private scheduleExtensionChangeNotice(): void {
		if (this._extensionChangeTimer !== null) {
			clearTimeout(this._extensionChangeTimer);
		}
		this._extensionChangeTimer = setTimeout(() => {
			this._extensionChangeTimer = null;

			// Suppress duplicate Notice — if one is already showing, skip
			if (this._extensionStaleNotice) return;

			const NOTICE_DURATION_MS = 10_000;
			const notice = new Notice(
				"Extension files changed." + (Platform.isDesktop ? "\n(right-click to reload)" : ""),
				NOTICE_DURATION_MS,
			);

			// Clear stale reference when the notice auto-dismisses
			setTimeout(() => {
				if (this._extensionStaleNotice === notice) {
					this._extensionStaleNotice = null;
				}
			}, NOTICE_DURATION_MS);

			// Left-click: clear reference (Obsidian's default dismisses the Notice)
			notice.noticeEl.addEventListener("click", () => {
				this._extensionStaleNotice = null;
			});

			// Right-click: trigger reload (desktop only)
			if (Platform.isDesktop) {
				notice.noticeEl.oncontextmenu = (e) => {
					e.preventDefault();
					notice.hide();
					this._extensionStaleNotice = null;
					this.getExtensionManager().reload(false).then((result) => {
						const summary =
							`Extensions reloaded: ${result.toolCount} tool${result.toolCount !== 1 ? "s" : ""}, ` +
							`${result.automationCount} automation${result.automationCount !== 1 ? "s" : ""}` +
							(result.errors.length > 0 ? ` (${result.errors.length} error${result.errors.length !== 1 ? "s" : ""})` : "");
						new Notice(summary);

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
					}).catch((err) => {
						log.error("Extension reload from Notice failed", { error: String(err) });
						new Notice(`Extension reload failed: ${err instanceof Error ? err.message : String(err)}`);
					});
				};
			}

			this._extensionStaleNotice = notice;
		}, 1000);
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
					this.scheduleExtensionChangeNotice();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (isExtensionFile(f, this.settings.notor_dir)) {
					this.scheduleExtensionChangeNotice();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				if (
					isExtensionFile(f, this.settings.notor_dir) ||
					isExtensionPath(oldPath, this.settings.notor_dir)
				) {
					this.scheduleExtensionChangeNotice();
				}
			})
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (f) => {
				if (isExtensionFile(f, this.settings.notor_dir)) {
					this.scheduleExtensionChangeNotice();
				}
			})
		);
	}

	// -----------------------------------------------------------------------
	// View wiring
	// -----------------------------------------------------------------------

	/**
	 * Wire a newly created chat view to the orchestrator.
	 *
	 * Called when the view is registered and every time the view is opened
	 * (Obsidian may recreate views on workspace restore). Each panel gets
	 * its own orchestrator instance (sharing infrastructure singletons).
	 *
	 * @param view - The chat view to wire
	 * @param orchestrator - The orchestrator for this panel. Primary panels
	 *   use the shared singleton; secondary panels get their own instance.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	private wireView(view: NotorChatView, orchestrator?: ChatOrchestrator): void {
		if (!orchestrator) {
			orchestrator = this.getOrchestrator();
		}
		const toolRegistry = this.getToolRegistry();
		const historyManager = this.getHistoryManager();
		const checkpointManager = this.getCheckpointManager();
		const providerRegistry = this.getProviderRegistry();
		const toolDispatcher = this.getToolDispatcher();

		// Wire orchestrator ↔ view
		orchestrator.setView(view);

		// H-006: Wire workflow activity tracker to the chat view so the
		// indicator is created in onOpen() and destroyed in onClose().
		if (this._workflowActivityTracker) {
			view.setWorkflowActivityTracker(this._workflowActivityTracker);
		}

		// Phase 3: Wire active session accessor so the activity indicator
		// includes detached foreground conversations in badge count + dropdown.
		view.setGetActiveSessions(() => orchestrator.getActiveSessions());
		orchestrator.onSessionsChanged(() => view.updateActivityIndicator());

		// H-005: Wire conversation-by-ID switching for the activity dropdown.
		// When a user clicks a workflow entry in the dropdown, it calls
		// switchToConversation(conversationId) on the view, which delegates
		// to this callback to find and load the conversation from history.
		view.setOnSwitchToConversationById(async (conversationId: string) => {
			const result = await orchestrator.switchToConversationById(conversationId);
			if (result) {
				view.setActiveConversationId(conversationId);
			}
			return result;
		});

		// Wire persona manager to view (A-013: picker + label)
		const personaManager = this.getPersonaManager();
		view.setPersonaManager(personaManager);

		// B-007: Wire persona name changes to the dispatcher so auto-approve
		// resolution tracks the active persona in real time.
		// Phase 4: This is a global callback (shared PersonaManager singleton).
		// Only set once — guard against multiple wireView calls overwriting it.
		// The dispatcher propagation is global; the header update iterates
		// all orchestrators' displayed conversations.
		if (!this._personaNameChangeWired) {
			this._personaNameChangeWired = true;
			personaManager.setOnPersonaNameChanged((name) => {
				toolDispatcher.setActivePersonaName(name);

				// Step 1f-addendum (Trigger 2): Update conversation header for
				// all orchestrators that have a displayed conversation.
				const allOrchestrators = [this._orchestrator, ...this._secondaryOrchestrators].filter(Boolean);
				for (const orch of allOrchestrators) {
					const conv = orch!.getDisplayedConversation();
					if (conv) {
						conv.persona_name = name;
						historyManager.updateConversationHeader(conv).catch((e) => {
							log.error("Failed to update conversation header on persona change", { error: String(e) });
						});
					}
				}
			});
		}

		// Restore active persona from settings on view wire (deferred, non-blocking).
		// This ensures the persona label and provider/model state are restored
		// when the chat panel opens after plugin load. Only needs to run once.
		if (!view.getIsSecondary()) {
			personaManager.restoreFromSettings().catch((e) => {
				log.warn("Failed to restore active persona from settings", { error: String(e) });
			});
		}

		// E-015 / MAIN-001: Wire tool definitions callback. When an
		// EffectiveToolConfig is provided, returns filtered tool definitions
		// (disabled tools excluded). When omitted, returns all tools.
		orchestrator.setGetToolDefinitions((config) => {
			if (config) {
				return toolRegistry.getFilteredToolDefinitions(config) as import("./providers/provider").ToolDefinition[];
			}
			return toolRegistry.getToolDefinitions() as import("./providers/provider").ToolDefinition[];
		});

		// E-012 / E-015: Wire the workflow send callback from the chat view
		// to the orchestrator's executeWorkflow() method. When the user sends
		// a message with a workflow chip attached, this path is taken instead
		// of the normal handleUserMessage path.
		view.setOnSendWorkflow(async (workflow, supplementaryText) => {
			await orchestrator.executeWorkflow(workflow, supplementaryText);
		});

		// E-015: Provide the workflow discovery callback to the slash-command suggest
		// so it can list workflows in the autocomplete popup.
		view.setGetWorkflows(() => this.getDiscoveredWorkflows());

		// Send message (with optional attachments from the chat view)
		// MAIN-001: Tool definitions are now computed per-iteration inside
		// responseLoop() via resolveEffectiveConfig() — no longer passed externally.
		view.setOnSendMessage(async (content: string, attachments?) => {
			await orchestrator.handleUserMessage(content, attachments);
		});

		// Stop response — resolve displayed conversation's active session and abort it
		view.setOnStopResponse(() => {
			const displayedConvId = orchestrator.getConversationManager().getActiveConversation()?.id;
			if (displayedConvId) {
				const session = orchestrator.getActiveSession(displayedConvId);
				if (session) {
					session.abortController.abort();
					return;
				}
			}
			// Fallback: no active session — the view's legacy AbortController is a no-op
		});

		// New conversation
		view.setOnNewConversation(() => {
			const staleTracker = this.getStaleTracker();
			staleTracker.clear?.();
			const vaultRuleManager = this.getVaultRuleManager();
			vaultRuleManager.clearAccessedNotes();

			// Reload settings from disk so any external changes to data.json
			// (e.g. E2E tests injecting auto-approve configs) are picked up
			// before the new conversation starts.
			this.loadSettings().then(() => {
				// Propagate refreshed auto-approve settings to the dispatcher
				toolDispatcher.setAutoApprove(this.settings.auto_approve);
				toolDispatcher.setActivePersonaName(
					this.settings.active_persona || null
				);
				if (this._orchestrator) {
					this._orchestrator.updateSettings(this.settings);
				}
				// Phase 4.1: Keep McpHub settings reference in sync after reload
				// so servers configured after the last reload can still be found.
				if (this._mcpHub) {
					this._mcpHub.updateSettings(this.settings);
				}

				return orchestrator.newConversation();
			}).then(() => {
				const convManager = orchestrator.getConversationManager();
				const conv = convManager.getActiveConversation();
				if (conv) {
					checkpointManager.setConversationId(conv.id);
					view.setActiveConversationId(conv.id);
				}
			}).catch((e) => {
				log.error("Failed to create new conversation", { error: String(e) });
				new Notice(`Failed to create conversation: ${e instanceof Error ? e.message : String(e)}`);
			});
		});

		// Open conversation list — refresh from disk
		view.setOnOpenConversationList(() => {
			return historyManager.listConversations();
		});

		// Search conversations by query
		view.setOnSearchConversations((query: string) => {
			return historyManager.searchConversations(query);
		});

		// Switch conversation
		view.setOnSwitchConversation((filename: string) => {
			orchestrator.switchConversation(filename).then(() => {
				const convManager = orchestrator.getConversationManager();
				const conv = convManager.getActiveConversation();
				if (conv) {
					checkpointManager.setConversationId(conv.id);
					view.setActiveConversationId(conv.id);
				}
				// Clear stale tracker and vault rule accessed notes when switching
				this.getStaleTracker().clear?.();
				this.getVaultRuleManager().clearAccessedNotes();
			}).catch((e) => {
				log.error("Failed to switch conversation", { error: String(e) });
			});
		});

		// Fork conversation at a specific message
		view.setOnForkConversation(async (messageId: string) => {
			const result = await orchestrator.forkConversation(messageId);
			if (!result) return;

			await orchestrator.switchConversation(result.filename);

			checkpointManager.setConversationId(result.conversation.id);
			view.setActiveConversationId(result.conversation.id);
			this.getStaleTracker().clear?.();
			this.getVaultRuleManager().clearAccessedNotes();

			new Notice(`Forked: ${result.conversation.title}`);
		});

		// Export conversation from history list
		view.setOnExportConversation((filename: string) => {
			historyManager.loadConversation(filename).then(({ conversation, messages }) => {
				this.showExportModal(conversation, messages);
			}).catch((e) => {
				log.error("Failed to load conversation for export", { error: String(e) });
				new Notice(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
			});
		});

		// Toggle favorite
		view.setOnToggleFavorite(async (filename: string) => {
			await historyManager.toggleFavorite(filename);
			const entries = await historyManager.listConversations();
			view.renderConversationList(
				view.isFavFilterActive() ? entries.filter((e) => e.is_favorite) : entries
			);
		});

		// Open conversation in a new secondary tab
		view.setOnOpenInNewTab((filename: string) => {
			const leaf = this.app.workspace.getLeaf("tab");
			leaf.setViewState({
				type: CHAT_VIEW_TYPE,
				active: true,
				state: { isSecondary: true, conversationFilename: filename },
			}).catch((e) => {
				log.error("Failed to open conversation in new tab", { error: String(e) });
			});
		});

		// Delete conversation with confirmation
		view.setOnDeleteConversation((filename: string) => {
			// Step 2c: Block deletion of conversations with active sessions.
			// Check if any active session's conversation ID is in the filename.
			const activeSessions = orchestrator.getActiveSessions();
			const streamingSession = activeSessions.find(s => filename.includes(s.conversationId));
			if (streamingSession) {
				new Notice("Cannot delete — conversation is still streaming. Stop it first.");
				return;
			}
			new ConfirmModal(
				this.app,
				"Delete conversation",
				"This conversation will be permanently deleted. This action cannot be undone.",
				async () => {
					const convManager = orchestrator.getConversationManager();
					const activeConv = convManager.getActiveConversation();
					await historyManager.deleteConversationFile(filename);
					// Refresh the conversation list
					const entries = await historyManager.listConversations();
					view.renderConversationList(entries);
					// If the deleted conversation was the active one, switch to another
					const nextEntry = entries[0];
					if (activeConv && nextEntry && filename.includes(activeConv.id)) {
						await orchestrator.switchConversation(nextEntry.filename);
						const conv = convManager.getActiveConversation();
						if (conv) {
							checkpointManager.setConversationId(conv.id);
							view.setActiveConversationId(conv.id);
						}
					} else if (entries.length === 0) {
						await orchestrator.newConversation();
						const conv = convManager.getActiveConversation();
						if (conv) {
							checkpointManager.setConversationId(conv.id);
							view.setActiveConversationId(conv.id);
						}
					}
				},
				"Delete",
				true
			).open();
		});

		// Import conversation from exported HTML
		view.setOnImportConversation(async (htmlContent: string) => {
			const extracted = extractJsonlFromHtml(htmlContent);
			if (!extracted) {
				new Notice("This HTML file does not contain embedded conversation data");
				return;
			}
			const { conversation, messages } = reassignIds(
				extracted.conversation,
				extracted.messages
			);
			try {
				const filename = await historyManager.importConversation(conversation, messages);
				await orchestrator.switchConversation(filename);
				new Notice(`Imported conversation: ${conversation.title ?? "Untitled"}`);
			} catch (e) {
				log.error("Failed to import conversation", { error: String(e) });
				new Notice(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		});

		// Mode toggle — propagate to active session so buildPolicyContext reads the new mode
		view.setOnModeToggle((mode) => {
			const convManager = orchestrator.getConversationManager();
			convManager.setMode(mode);

			// Propagate to active session's ConversationManager
			const displayedConvId = convManager.getActiveConversation()?.id;
			if (displayedConvId) {
				const session = orchestrator.getActiveSession(displayedConvId);
				session?.conversationManager.setMode(mode);
			}
		});

		// Settings open (open Obsidian settings tab)
		view.setOnSettingsOpen(() => {
			// Open plugin settings
			(this.app as import("obsidian").App & {
				setting?: { open: () => void; openTabById: (id: string) => void };
			}).setting?.openTabById("notor");
		});

		// Settings deep-link: open settings panel, switch to Notor tab, scroll to group/subsection
		view.setOnOpenSettingsGroup((groupTitle: string, subsection?: string) => {
			const appSetting = (this.app as import("obsidian").App & {
				setting?: { open: () => void; openTabById: (id: string) => void };
			}).setting;
			appSetting?.open();
			appSetting?.openTabById("notor");
			// Defer scrollToGroup so the settings DOM renders first
			setTimeout(() => {
				this._settingTab?.scrollToGroup(groupTitle, subsection);
			}, 100);
		});

		// Provider change — updates per-orchestrator state (Phase 4, Step 4b).
		// Also persists to global settings for the "default provider" behavior.
		view.setOnProviderChange((providerId) => {
			// Update per-orchestrator provider (Phase 4, Step 4b)
			orchestrator!.setActiveProvider(providerId);

			// Also update global state for backward compat and defaults
			providerRegistry.switchProvider(providerId);
			this.settings.active_provider = providerId;
			this.saveSettings().catch((e) => {
				log.error("Failed to save provider change", { error: String(e) });
			});

			// Step 1f-addendum (Trigger 2): Update conversation header so the
			// next session pins from the user's explicit choice.
			const conv = orchestrator!.getDisplayedConversation();
			if (conv) {
				conv.provider_id = providerId;
				historyManager.updateConversationHeader(conv).catch((e) => {
					log.error("Failed to update conversation header on provider change", { error: String(e) });
				});
			}
		});

		// Model change — parses ::1m suffix to set use_extended_context.
		// Updates per-orchestrator model state (Phase 4, Step 4b).
		view.setOnModelChange((selectedValue) => {
			const { modelId, isExtendedContext } = parseOptionValue(selectedValue);

			// Update per-orchestrator model (Phase 4, Step 4b)
			orchestrator!.setActiveModel(modelId, isExtendedContext);

			const activeType = providerRegistry.getActiveType();
			const config = providerRegistry.getConfig(activeType);
			if (config) {
				const updated = { ...config, model_id: modelId, use_extended_context: isExtendedContext };
				providerRegistry.updateConfig(updated);
				// Update settings
				const idx = this.settings.providers.findIndex(
					(p) => p.type === activeType
				);
				if (idx >= 0) {
					this.settings.providers[idx] = updated;
					this.saveSettings().catch((e) => {
						log.error("Failed to save model change", { error: String(e) });
					});
				}
			}

			// Step 1f-addendum (Trigger 2): Update conversation header so the
			// next session pins from the user's explicit choice.
			const conv = orchestrator.getDisplayedConversation();
			if (conv) {
				conv.model_id = modelId;
				conv.use_extended_context = isExtendedContext;
				historyManager.updateConversationHeader(conv).catch((e) => {
					log.error("Failed to update conversation header on model change", { error: String(e) });
				});
			}
		});

		// Refresh models
		view.setOnRefreshModels(async () => {
			return providerRegistry.refreshModels();
		});

		// Available providers
		view.setGetAvailableProviders(() => {
			const providerLabels: Record<string, string> = {
				local: "Local (OpenAI-compatible)",
				anthropic: "Anthropic",
				openai: "OpenAI",
				bedrock: "AWS Bedrock",
			};
			return providerRegistry.getConfiguredTypes().map((type) => ({
				type,
				displayName: providerLabels[type] ?? type,
			}));
		});

		// Available models
		view.setGetAvailableModels(() => {
			const activeType = providerRegistry.getActiveType();
			// Return cached models synchronously (stale-while-revalidate).
			// The cache is populated when refreshModels() is called (e.g. via
			// the refresh button in the settings popover). If no cache exists yet,
			// fall back to the single configured model_id so the UI always shows
			// something useful.
			try {
				const cached = providerRegistry.getCachedModels(activeType);
				if (cached.length > 0) {
					return cached;
				}
				// Trigger a background fetch so the next popover open will have data
				providerRegistry.getModels(activeType).catch(() => {});
				// Fall back to configured model_id
				const config = providerRegistry.getConfig(activeType);
				if (config?.model_id) {
					return [{ id: config.model_id, display_name: config.model_id }];
				}
				return [];
			} catch {
				return [];
			}
		});

		// Current provider — reads from per-orchestrator state (Phase 4, Step 4b)
		view.setGetCurrentProvider(() => {
			return orchestrator!.getActiveProviderType();
		});

		// Current model — reads from per-orchestrator state (Phase 4, Step 4b)
		// Reconstructs ::1m composite value for picker selection.
		view.setGetCurrentModel(() => {
			const activeType = orchestrator!.getActiveProviderType();
			const config = providerRegistry.getConfig(activeType);
			const modelId = config?.model_id ?? "";
			return buildOptionValue(modelId, config?.use_extended_context ?? false);
		});

		// Checkpoint callbacks
		view.setOnListCheckpoints(async () => {
			return checkpointManager.listCheckpoints();
		});

		view.setOnRestoreCheckpoint(async (checkpointId) => {
			return checkpointManager.restore(checkpointId);
		});

		view.setOnGetCurrentContent(async (notePath) => {
			return checkpointManager.getCurrentContent(notePath);
		});

		// Wire approval callback for this panel's orchestrator (Phase 4, Step 4e).
		// Each orchestrator gets its own approval callback bound to the correct
		// panel's view. Replaces the former ToolDispatcher.setApprovalCallback().
		orchestrator.setApprovalCallback(async (toolCall, abortSignal?, messageId?) => {
			// Look up the specific tool call element by message ID, falling back to
			// the last rendered element for backward compatibility (e.g. sub-agent dispatchers).
			const toolCallEl = messageId
				? view.getToolCallEl(messageId) ?? view.getLastToolCallEl()
				: view.getLastToolCallEl();
			if (!toolCallEl) {
				// Fallback: auto-approve if no UI element available
				log.warn("No tool call element for approval prompt, auto-approving");
				return "approved";
			}

			// For write_note and replace_in_note, render a full diff preview.
			// For all other tools, use the plain approve/reject prompt.
			const approvalPromise = view.renderDiffApprovalPrompt(
				toolCallEl,
				toolCall.tool_name,
				toolCall.parameters ?? {}
			);

			// If no abort signal, just await the approval normally
			if (!abortSignal) return approvalPromise;

			// Race the approval against the abort signal so that clicking Stop
			// unblocks the pending approval promise instead of hanging forever.
			return Promise.race([
				approvalPromise,
				new Promise<"rejected">((resolve) => {
					if (abortSignal.aborted) { resolve("rejected"); return; }
					abortSignal.addEventListener("abort", () => resolve("rejected"), { once: true });
				}),
			]);
		});

		// Load conversation history and render it.
		// Skip for secondary panels — they get their conversation from setState().
		if (view.getIsSecondary()) return;
		historyManager.listConversations().then((entries) => {
			view.renderConversationList(entries);

			// Auto-start a new conversation if none exist, or restore last
			if (entries.length === 0) {
				orchestrator.newConversation().then(() => {
					const conv = orchestrator.getConversationManager().getActiveConversation();
					if (conv) {
						checkpointManager.setConversationId(conv.id);
						view.setActiveConversationId(conv.id);
					}
				}).catch((e) => {
					log.error("Failed to start initial conversation", { error: String(e) });
				});
			} else {
				// Restore most recent conversation
				const mostRecent = entries[0];
				if (mostRecent) {
					orchestrator.switchConversation(mostRecent.filename).then(() => {
						const conv = orchestrator.getConversationManager().getActiveConversation();
						if (conv) {
							checkpointManager.setConversationId(conv.id);
							view.setActiveConversationId(conv.id);
						}
					}).catch(() => {
						// Fallback to new conversation on load error
						orchestrator.newConversation().then(() => {
							const conv = orchestrator.getConversationManager().getActiveConversation();
							if (conv) {
								checkpointManager.setConversationId(conv.id);
								view.setActiveConversationId(conv.id);
							}
						}).catch(() => {});
					});
				}
			}
		}).catch((e) => {
			log.error("Failed to load conversation history", { error: String(e) });
			// Start fresh on error
			orchestrator.newConversation().catch(() => {});
		});
	}

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------

	/**
	 * Open (or reveal) the tool config inspector view (UI-003 / FR-88).
	 *
	 * Opens alongside the chat panel. If already open, reveals the existing leaf.
	 */
	private async openInspector(): Promise<void> {
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

	/**
	 * Get the primary chat panel leaf (the first non-secondary leaf).
	 *
	 * With multi-panel support, multiple leaves of CHAT_VIEW_TYPE may exist.
	 * This helper returns the primary panel for operations that should target
	 * the main panel (e.g., command palette "New conversation").
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	private getPrimaryChatLeaf(): WorkspaceLeaf | undefined {
		const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		// Primary is the first leaf that is NOT secondary
		return leaves.find((l) => {
			const view = l.view as NotorChatView | undefined;
			return view && !view.getIsSecondary();
		}) ?? leaves[0];
	}

	/** Open (or reveal) the primary Notor chat panel. */
	private async openChatPanel(): Promise<void> {
		const { workspace } = this.app;

		// Check if the primary panel is already open
		const existing = this.getPrimaryChatLeaf();
		if (existing) {
			void workspace.revealLeaf(existing);
			return;
		}

		// Open in the right sidebar
		const leaf = workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
			void workspace.revealLeaf(leaf);
		}
	}

	/** Start a new conversation (command palette action). */
	private newConversation(): void {
		const primaryLeaf = this.getPrimaryChatLeaf();
		if (primaryLeaf) {
			// Trigger via the view's new conversation callback
			const view = primaryLeaf.view as NotorChatView | undefined;
			if (view) {
				// Delegate to the orchestrator
				this.getOrchestrator()
					.newConversation()
					.then(() => {
						const conv = this.getOrchestrator().getConversationManager().getActiveConversation();
						if (conv) {
							view.setActiveConversationId(conv.id);
						}
						// Refresh conversation list
						this.getHistoryManager()
							.listConversations()
							.then((entries) => {
								view.renderConversationList(entries);
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
				return;
			}
		}

		// Panel not open — open it first, then it will auto-start a conversation
		this.openChatPanel().catch((e) => {
			log.error("Failed to open chat panel", { error: String(e) });
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
			if (
				msg.role === "tool_result" &&
				msg.tool_result?.tool_name === USE_SUBAGENT_TOOL_NAME &&
				msg.tool_result.sub_agent_metadata?.jsonl_filename
			) {
				const filename = msg.tool_result.sub_agent_metadata.jsonl_filename;
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

	private showExportModal(conversation: import("./types").Conversation, messages: import("./types").Message[]): void {
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