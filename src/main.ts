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
import { createDefaultSettings, DEFAULT_MODEL_PRESETS, NotorSettingTab } from "./settings";
import type { NotorSettings } from "./settings";
import { logger, setLogLevel } from "./utils/logger";
import { notifyFileLeafActivated, getLastActiveFilePath } from "./context/auto-context";

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
import { RenameModal } from "./ui/rename-modal";
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
import { parseOptionValue, buildOptionValue } from "./providers/model-grouping";
import { resolvePreset } from "./presets/preset-resolver";
import type { LLMProviderType } from "./types";

// Tools
import { ToolRegistry } from "./tools/index";
import { NoteOpener } from "./tools/note-opener";

// Chat
import { ToolDispatcher } from "./chat/dispatcher";
import { HistoryManager, conversationFilename } from "./chat/history";
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
import { openPersonaPickerModal } from "./ui/persona-picker-modal";

// Sub-agents
import { SubAgentManager } from "./sub-agents/manager";
import { UseSubagentTool } from "./tools/use-subagent";

// Extensions
import { ExtensionManager } from "./extensions/manager";
import type { AutomationTrigger } from "./extensions/types";
import { isExtensionFile, isExtensionPath } from "./extensions/watcher";
import { isPersonaFile, isPersonaPath } from "./personas/watcher";

// MCP
import { McpHub } from "./mcp/mcp-hub";
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

// Chat blocks
import { ChatBlockRegistry } from "./ui/chat-blocks/registry";
import { setChatBlockRegistry } from "./chat/message-pipeline";

// Memory approval
import { PendingMemoryManager } from "./memory/pending-memory-manager";
import { MemoryApprovalModal } from "./ui/memory-approval-modal";

// Template variables
import { TemplateVariableRegistry, registerBuiltinVars } from "./template-vars";

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

	/** Guard to prevent multiple wireView() calls from re-registering the persona name change callback. */
	private _personaNameChangeWired = false;
	private _noteOpener?: NoteOpener;
	private _staleTracker?: StaleContentTracker;
	private _personaManager?: PersonaManager;
	private _subAgentManager?: SubAgentManager;
	private _pendingMemoryManager?: PendingMemoryManager;
	private _extensionManager?: ExtensionManager;
	private _chatBlockRegistry?: ChatBlockRegistry;
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

	/** Debounce timer for vault-triggered workflow rescans. */
	private _workflowRescanTimer: ReturnType<typeof setTimeout> | null = null;

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

		// 2b. Instantiate ChatBlockRegistry and wire into the message pipeline.
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
					this.loadConversation(view, orchestrator);
				}
			}, 0);

			return view;
		});

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
				const orchestrator = this.getActiveOrchestrator();
				if (!orchestrator) {
					new Notice("No active chat panel");
					return;
				}
				orchestrator.manualCompaction().catch((e) => {
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
								const orchestrator = this.getActiveOrchestrator();
								if (!orchestrator) {
									new Notice("No active chat panel");
									return;
								}
								return orchestrator.executeWorkflow(workflow);
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
					// Resolve active note path (two-stage: active view + cache fallback).
					// Only markdown files are valid targets for note workflows.
					const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
					let activeFilePath = activeView?.file?.path ?? null;
					if (!activeFilePath) {
						const cached = getLastActiveFilePath();
						if (cached?.endsWith(".md")) {
							activeFilePath = cached;
						}
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
								const orchestrator = this.getActiveOrchestrator();
								if (!orchestrator) {
									new Notice("No active chat panel");
									return;
								}
								await orchestrator.executeWorkflow(workflow, resolvedPrompt);
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
					const orchestrator = this.getActiveOrchestrator();
					if (!orchestrator) {
						new Notice("No active chat panel");
						return;
					}
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
							const orchestrator = this.getActiveOrchestrator();
							if (orchestrator) {
								await orchestrator.switchConversation(filename);
							}
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

		// Open an additional chat panel in a new tab.
		// The factory creates a fresh orchestrator automatically — no
		// isSecondary state needed (A4.7).
		this.addCommand({
			id: "open-secondary-chat",
			name: "Open new chat panel",
			callback: () => {
				this.openChatInNewTab(undefined, true);
			},
		});

		// /btw — fork current conversation into a new panel (side conversation)
		this.addCommand({
			id: "btw-side-conversation",
			name: "/btw — Open side conversation in new panel",
			callback: () => {
				const leafId = this._lastFocusedChatLeafId;
				if (!leafId) return;
				const orch = this._orchestrators.get(leafId);
				if (!orch) return;
				const messages = orch.getConversationManager().getMessages();
				const lastId = messages[messages.length - 1]?.id;
				if (!lastId) return;
				orch.forkConversation(lastId).then((result) => {
					if (!result) return;
					this.openChatInNewTab(result.filename);
					new Notice(`Side conversation: ${result.conversation.title}`);
				}).catch((e) => {
					log.error("Failed to create side conversation", { error: String(e) });
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
						`${result.automationCount} automation${result.automationCount !== 1 ? "s" : ""}, ` +
						`${result.blockCount} block kind${result.blockCount !== 1 ? "s" : ""}` +
						(result.errors.length > 0 ? ` (${result.errors.length} error${result.errors.length !== 1 ? "s" : ""})` : "");
					new Notice(summary);
				}).catch((e) => {
					log.error("Extension reload failed", { error: String(e) });
					new Notice(`Extension reload failed: ${e instanceof Error ? e.message : String(e)}`);
				});
			},
		});

		// Switch persona for the active chat panel via fuzzy search modal.
		// Uses checkCallback so the command only appears in the palette
		// when a Notor chat panel is the active view.
		this.addCommand({
			id: "switch-persona",
			name: "Switch persona",
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(NotorChatView);
				if (!activeView) return false;
				if (checking) return true;

				const personaManager = this.getPersonaManager();
				void openPersonaPickerModal(this.app, personaManager, (selected) => {
					if (selected) {
						void personaManager.activatePersona(selected.name).then((ok) => {
							if (ok) {
								activeView.applyPersonaSwitch(selected);
							} else {
								new Notice(`Failed to activate persona '${selected.name}'`);
							}
						});
					} else {
						personaManager.deactivatePersona();
						activeView.applyPersonaSwitch(null);
					}
				});
				return true;
			},
		});

		this.addCommand({
			id: "find-in-messages",
			name: "Find in messages",
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(NotorChatView);
				if (!activeView) return false;
				if (checking) return true;
				activeView.openFindBar();
				return true;
			},
		});

		this.addCommand({
			id: "open-memory-approval",
			name: "Open memory approval panel",
			checkCallback: (checking: boolean) => {
				if (!this.settings.memory_enabled) return false;
				if (this.settings.memory_approval_mode === "auto") return false;
				if (checking) return true;
				const manager = this.getPendingMemoryManager();
				if (!manager) return false;
				new MemoryApprovalModal(this.app, manager).open();
				return true;
			},
		});

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
					this.openChatPanel().then(() => {
						const orchestrator = this.getActiveOrchestrator();
						if (!orchestrator) {
							new Notice("No active chat panel");
							return;
						}
						orchestrator.switchToConversationById(conversationId).then((found) => {
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

		if (this.settings) {
			// Mutate the existing object so all components that captured a reference
			// (e.g. ReadFileTool, ExecuteCommandTool) see the updated values.
			Object.assign(this.settings, loaded);
		} else {
			this.settings = loaded;
		}

		// One-time migration of old tool settings into the extension settings system.
		await this.migrateToolSettingsToExtensions();

		// One-time migration: initialize model presets for existing installs.
		await this.migrateModelPresets();

		// One-time migration: move title_generation_* into generic automation settings.
		await this.migrateAutomationSettings();

		// One-time migration: assign instance IDs to providers for multi-instance support.
		await this.migrateProviderInstances();
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

	/**
	 * One-time migration: initialize model presets for existing installs.
	 *
	 * If `model_presets` is absent (pre-preset install), initializes with
	 * default presets and auto-configures the `medium` preset from the
	 * current active provider + model, so existing users can continue
	 * chatting immediately.
	 *
	 * @see specs/ZZ-misc/model-presets-design.md — Section 13.1
	 */
	private async migrateModelPresets(): Promise<void> {
		if (this.settings.model_presets?.length > 0) return;

		this.settings.model_presets = DEFAULT_MODEL_PRESETS.map((p) => ({ ...p }));
		this.settings.default_preset = "medium";
		// Title generation defaults: disabled, "small" preset — stored in generic systems
		this.settings.automation_enabled["title-generation"] = false;
		if (!this.settings.user_extension_settings["Title Generation"]) {
			this.settings.user_extension_settings["Title Generation"] = {};
		}
		this.settings.user_extension_settings["Title Generation"]["preset"] = "small";

		// Auto-configure the "medium" preset from the current active provider+model
		const activeId = this.settings.active_provider;
		const activeConfig = this.settings.providers.find((p) => p.id === activeId || p.type === activeId);
		if (activeId && activeConfig?.model_id) {
			const medium = this.settings.model_presets.find((p) => p.name === "medium");
			if (medium) {
				medium.provider_id = activeConfig.id;
				medium.model_id = activeConfig.model_id;
				medium.use_extended_context = activeConfig.use_extended_context ?? false;
			}
		}

		await this.saveSettings();
	}

	/**
	 * Migrate legacy `title_generation_enabled` / `title_generation_preset`
	 * into the generic `automation_enabled` / `user_extension_settings` system.
	 */
	private async migrateAutomationSettings(): Promise<void> {
		// Skip if already migrated
		if (this.settings.automation_enabled["title-generation"] !== undefined) return;

		// Only migrate if the legacy fields were ever set (model presets migration sets them)
		const legacyEnabled = (this.settings as unknown as Record<string, unknown>).title_generation_enabled;
		if (legacyEnabled === undefined) return;

		this.settings.automation_enabled["title-generation"] =
			this.settings.title_generation_enabled ?? false;

		// Extension key must match displayName used by executeAutomation()
		const extKey = "Title Generation";
		const legacyPreset = this.settings.title_generation_preset;
		if (legacyPreset) {
			if (!this.settings.user_extension_settings[extKey]) {
				this.settings.user_extension_settings[extKey] = {};
			}
			this.settings.user_extension_settings[extKey]["preset"] = legacyPreset;
		}

		// Remove legacy fields from persisted data
		const raw = this.settings as unknown as Record<string, unknown>;
		delete raw.title_generation_enabled;
		delete raw.title_generation_preset;

		await this.saveSettings();
	}

	/**
	 * Migrate providers to multi-instance format by assigning unique IDs.
	 *
	 * Detection: first provider in array lacks an `id` field.
	 * Action: assign `id = type` for each existing provider (preserves
	 * secret keys and conversation header references). Also migrates
	 * ModelPreset.provider_type → provider_id.
	 */
	private async migrateProviderInstances(): Promise<void> {
		const firstProvider = this.settings.providers[0];
		if (!firstProvider || firstProvider.id) return;

		for (const provider of this.settings.providers) {
			if (!provider.id) {
				provider.id = provider.type;
			}
		}

		// Migrate model presets from provider_type to provider_id
		for (const preset of this.settings.model_presets ?? []) {
			const raw = preset as unknown as Record<string, unknown>;
			if (raw.provider_type && !preset.provider_id) {
				preset.provider_id = raw.provider_type as string;
			}
			delete raw.provider_type;
		}

		await this.saveSettings();
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
			this._toolRegistry.register(useSubagentTool);

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
						notice.noticeEl.oncontextmenu = (e) => {
							e.preventDefault();
							notice.hide();
							if (this._extensionStaleNotice === notice) this._extensionStaleNotice = null;
							void this.app.workspace.openLinkText(error.filePath, "", true);
						};
					}
					notice.noticeEl.addEventListener("click", () => {
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
			this.saveSettings();
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
							notice.noticeEl.oncontextmenu = (e) => {
								e.preventDefault();
								notice.hide();
								if (this._personaStaleNotice === notice) this._personaStaleNotice = null;
								void this.app.workspace.openLinkText(result.filePath, "", true);
							};
						}
						notice.noticeEl.addEventListener("click", () => {
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
	private wireView(view: NotorChatView, orchestrator: ChatOrchestrator): void {
		const historyManager = this.getHistoryManager();
		const providerRegistry = this.getProviderRegistry();
		const toolDispatcher = this.getToolDispatcher();

		// Wire orchestrator ↔ view
		orchestrator.setView(view);

		// A7.3: Wire close cleanup — orderly teardown when the panel closes.
		// Obsidian awaits onClose(), so the async cleanup (JSONL flush,
		// session guard unregister) completes before DOM teardown.
		// @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 7.2
		const leafId = view.leaf.id;

		// Declare before setOnCloseCleanup so the close closure can reference it.
		const updateThisView = () => view.updateActivityIndicator();

		view.setOnCloseCleanup(async () => {
			// 1. Abort any in-flight loadConversation() — must be first.
			//    Without this, a concurrent load can continue after orchestrator
			//    teardown and call syncViewAfterLoad() on a closing view.
			view._loadConversationAbort?.abort();

			// 2. Clear deferred load timeout (prevent post-close spurious load)
			clearTimeout(view._loadFallbackTimeout);

			// 3. Detach view — renders become no-ops via existing this.view?. guards
			orchestrator.setView(undefined);

			// 4. Clean up session-change, persona-changed, and global activity listeners
			view._unregisterSessionsChanged?.();
			view._unregisterPersonaChanged?.();
			view._removeActivityCallback?.();

			// 5. Remove from registry
			this._orchestrators.delete(leafId);

			// 6. Destroy (aborts active sessions, flushes JSONL writes).
			//    Closing a panel does NOT imply consent for unreviewed tool
			//    execution — abort is the safe default.
			await orchestrator.destroy();
		});

		// H-006: Wire workflow activity tracker to the chat view so the
		// indicator is created in onOpen() and destroyed in onClose().
		if (this._workflowActivityTracker) {
			view.setWorkflowActivityTracker(this._workflowActivityTracker);
		}

		// Wire global session accessor so every panel's indicator shows sessions
		// from ALL open chat panels, not just its own orchestrator.
		view.setGetActiveSessions(() => this._getAllActiveSessions());

		// Wire the current conversation ID getter for dropdown entry highlighting.
		view.setGetCurrentConversationId(() => view.getActiveConversationId());

		// Register this panel's indicator updater in the global set so that a
		// session change in any panel triggers every panel's indicator to refresh.
		// Guard against stale closures from a previous wireView call.
		view._removeActivityCallback?.();
		this._activityIndicatorCallbacks.add(updateThisView);
		view._removeActivityCallback = () => this._activityIndicatorCallbacks.delete(updateThisView);

		// A3.5: Clean up previous session-change listener before registering
		// a new one to prevent listener accumulation across wireView calls.
		// The handler fires ALL panels' indicators (not just this one) so that
		// a session starting in Panel A immediately updates Panel B's badge too.
		view._unregisterSessionsChanged?.();
		view._unregisterSessionsChanged = orchestrator.onSessionsChanged(() => {
			for (const cb of this._activityIndicatorCallbacks) cb();
		});

		// H-005: Wire conversation-by-ID switching for the activity dropdown.
		// When a user clicks a workflow entry in the dropdown, it calls
		// switchToConversation(conversationId) on the view, which delegates
		// to this callback to find and load the conversation from history.
		view.setOnSwitchToConversationById(async (conversationId: string) => {
			const result = await orchestrator.switchToConversationById(conversationId);
			if (result) {
				view.setActiveConversationId(conversationId);
				const conv = orchestrator.getConversationManager().getActiveConversation();
				view.updateHeaderTitle(conversationId, conv?.title ?? null);
				view.updateHeaderFavorite(conversationId, !!conv?.is_favorite);
			}
			return result;
		});

		// Wire persona manager to view (A-013: picker + label)
		const personaManager = this.getPersonaManager();
		view.setPersonaManager(personaManager);

		// Wire persona-changed callback so file-watcher refresh updates the chip label.
		view._unregisterPersonaChanged?.();
		view._unregisterPersonaChanged = personaManager.setOnPersonaChanged((persona) => {
			view.updatePersonaLabel(persona);
		});


		view.setOnPersonaChange((persona) => {
			const conv = orchestrator.getDisplayedConversation();
			if (conv) {
				conv.persona_name = persona?.name ?? null;
				historyManager.updateConversationHeader(conv).catch((e) => {
					log.error("Failed to update conversation header on persona change", { error: String(e) });
				});
			}
			// Sync ToolDispatcher to the persona of the panel that just changed
			toolDispatcher.setActivePersonaName(persona?.name ?? null);
		});

		// B-007: Wire persona name changes to the dispatcher so auto-approve
		// resolution tracks the active persona in real time.
		// Phase 4: This is a global callback (shared PersonaManager singleton).
		// Only set once — guard against multiple wireView calls overwriting it.
		// Only propagates to the ToolDispatcher (for workflow persona switches);
		// per-panel conversation headers are updated by the per-panel callback above.
		if (!this._personaNameChangeWired) {
			this._personaNameChangeWired = true;
			personaManager.setOnPersonaNameChanged((name) => {
				toolDispatcher.setActivePersonaName(name);
			});
		}

		// personaManager.restoreFromSettings() moved to onload() (A1.7 / Amendment R5).
		// No longer called per-wireView — single global restore at plugin startup.

		// Tool definitions callback moved to createOrchestrator() (A1.5 / Amendment R3).
		// No longer set here — each orchestrator receives it at construction time.

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
				// A3.6: Use closure-captured orchestrator, not hardcoded _orchestrator
				orchestrator.updateSettings(this.settings);
				// Phase 4.1: Keep McpHub settings reference in sync after reload
				// so servers configured after the last reload can still be found.
				if (this._mcpHub) {
					this._mcpHub.updateSettings(this.settings);
				}

				return orchestrator.newConversation();
			}).then(() => {
				const conv = orchestrator.getConversationManager().getActiveConversation();
				if (conv) {
					view.setActiveConversationId(conv.id);
					view.updateHeaderTitle(conv.id, conv.title ?? null);
					view.updateHeaderFavorite(conv.id, !!conv.is_favorite);
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
				const conv = orchestrator.getConversationManager().getActiveConversation();
				if (conv) {
					view.setActiveConversationId(conv.id);
					view.updateHeaderTitle(conv.id, conv.title ?? null);
					view.updateHeaderFavorite(conv.id, !!conv.is_favorite);
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

			view.setActiveConversationId(result.conversation.id);
			view.updateHeaderTitle(result.conversation.id, result.conversation.title ?? null);
			view.updateHeaderFavorite(result.conversation.id, !!result.conversation.is_favorite);
			this.getStaleTracker().clear?.();
			this.getVaultRuleManager().clearAccessedNotes();

			new Notice(`Forked: ${result.conversation.title}`);
		});

		// /btw — fork conversation to a new panel (side conversation)
		view.setOnForkToNewPanel(async (messageId, initialText) => {
			const messages = orchestrator.getConversationManager().getMessages();
			const forkMessageId = messageId ?? messages[messages.length - 1]?.id;
			if (!forkMessageId) return;

			const result = await orchestrator.forkConversation(forkMessageId);
			if (!result) return;

			this.openChatInNewTab(result.filename, false, initialText);
			new Notice(`Side conversation: ${result.conversation.title}`);
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
			const newValue = await historyManager.toggleFavorite(filename);
			// Sync in-memory state so getActiveConversationMeta returns fresh is_favorite
			const convManager = orchestrator.getConversationManager();
			const activeConv = convManager.getActiveConversation();
			if (activeConv && filename.includes(activeConv.id)) {
				convManager.setFavorite(newValue);
				view.updateHeaderFavorite(activeConv.id, newValue);
			}
			const entries = await historyManager.listConversations();
			view.renderConversationList(
				view.isFavFilterActive() ? entries.filter((e) => e.is_favorite) : entries
			);
		});

		// Rename conversation
		view.setOnRenameConversation((filename: string, currentTitle: string) => {
			new RenameModal(
				this.app,
				currentTitle,
				async (newTitle: string) => {
					const { conversation } = await historyManager.loadConversation(filename);
					conversation.title = newTitle;
					await historyManager.updateConversationHeader(conversation);

					// If this is the active conversation, update in-memory state
					// (setTitle fires onTitleChanged → updateConversationTitleInList)
					const convManager = orchestrator.getConversationManager();
					const activeConv = convManager.getActiveConversation();
					if (activeConv && activeConv.id === conversation.id) {
						convManager.setTitle(newTitle);
					} else {
						view.updateConversationTitleInList(conversation.id, newTitle);
					}
				},
			).open();
		});

		// Direct rename (for inline header title editing — bypasses RenameModal)
		view.setOnDirectRename(async (filename: string, newTitle: string) => {
			const { conversation } = await historyManager.loadConversation(filename);
			conversation.title = newTitle;
			await historyManager.updateConversationHeader(conversation);

			const convManager = orchestrator.getConversationManager();
			const activeConv = convManager.getActiveConversation();
			if (activeConv && activeConv.id === conversation.id) {
				convManager.setTitle(newTitle);
			} else {
				view.updateConversationTitleInList(conversation.id, newTitle);
			}
		});

		// Active conversation metadata (for header context menu and inline edit)
		view.setGetActiveConversationMeta(() => {
			const conv = orchestrator.getConversationManager().getActiveConversation();
			if (!conv) return null;
			return {
				id: conv.id,
				title: conv.title ?? "Untitled",
				filename: conversationFilename(conv),
				is_favorite: !!conv.is_favorite,
			};
		});

		// Open conversation in a new tab — the factory creates a fresh
		// orchestrator automatically; setState loads the conversation.
		view.setOnOpenInNewTab((filename: string) => {
			this.openChatInNewTab(filename);
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
							view.setActiveConversationId(conv.id);
							view.updateHeaderTitle(conv.id, conv.title ?? null);
							view.updateHeaderFavorite(conv.id, !!conv.is_favorite);
						}
					} else if (entries.length === 0) {
						await orchestrator.newConversation();
						const conv = convManager.getActiveConversation();
						if (conv) {
							view.setActiveConversationId(conv.id);
							view.updateHeaderTitle(conv.id, conv.title ?? null);
							view.updateHeaderFavorite(conv.id, !!conv.is_favorite);
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

			const activeId = orchestrator!.getActiveProviderId();
			const config = providerRegistry.getConfig(activeId);
			if (config) {
				const updated = { ...config, model_id: modelId, use_extended_context: isExtendedContext };
				providerRegistry.updateConfig(updated);
				// Update settings
				const idx = this.settings.providers.findIndex(
					(p) => p.id === activeId
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

		// Available providers — returns all configured instances
		view.setGetAvailableProviders(() => {
			return providerRegistry.getConfiguredIds().map((id) => {
				const config = providerRegistry.getConfig(id)!;
				return {
					id: config.id,
					type: config.type,
					displayName: config.display_name,
				};
			});
		});

		// Available models
		view.setGetAvailableModels(() => {
			const activeId = orchestrator!.getActiveProviderId();
			// Return cached models synchronously (stale-while-revalidate).
			// The cache is populated when refreshModels() is called (e.g. via
			// the refresh button in the settings popover). If no cache exists yet,
			// fall back to the single configured model_id so the UI always shows
			// something useful.
			try {
				const cached = providerRegistry.getCachedModels(activeId);
				if (cached.length > 0) {
					return cached;
				}
				// Trigger a background fetch so the next popover open will have data
				providerRegistry.getModels(activeId).catch(() => {});
				// Fall back to configured model_id
				const config = providerRegistry.getConfig(activeId);
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
			return orchestrator!.getActiveProviderId();
		});

		// Current model — reads from per-orchestrator state (Phase 4, Step 4b)
		// Reconstructs ::1m composite value for picker selection.
		view.setGetCurrentModel(() => {
			const modelId = orchestrator!.getActiveModelId();
			const useExtended = orchestrator!.getActiveUseExtendedContext();
			return buildOptionValue(modelId, useExtended);
		});

		// Preset change — resolves preset to concrete provider+model, updates state.
		view.setOnPresetChange((presetName, providerId, modelId, useExtendedContext) => {
			if (presetName !== null) {
				// Resolve preset to concrete values
				const resolved = resolvePreset(presetName, this.settings.model_presets);
				if (!resolved) {
					log.warn("Preset not configured", { presetName });
					return;
				}
				providerId = resolved.providerId;
				modelId = resolved.modelId;
				useExtendedContext = resolved.useExtendedContext;
			}

			if (providerId) {
				orchestrator!.setActiveProvider(providerId);
				providerRegistry.switchProvider(providerId);
				this.settings.active_provider = providerId;
			}
			if (modelId !== undefined) {
				orchestrator!.setActiveModel(modelId, useExtendedContext ?? false);
				const config = providerRegistry.getConfig(orchestrator!.getActiveProviderId());
				if (config) {
					const updated = { ...config, model_id: modelId, use_extended_context: useExtendedContext ?? false };
					providerRegistry.updateConfig(updated);
					const idx = this.settings.providers.findIndex((p) => p.id === config.id);
					if (idx >= 0) {
						this.settings.providers[idx] = updated;
					}
				}
			}

			// Track active preset on orchestrator
			orchestrator!.setActivePresetName(presetName);

			// Persist and update conversation header
			this.saveSettings().catch((e) => {
				log.error("Failed to save preset change", { error: String(e) });
			});
			const conv = orchestrator!.getDisplayedConversation();
			if (conv) {
				conv.preset_name = presetName;
				if (providerId) conv.provider_id = providerId;
				if (modelId) {
					conv.model_id = modelId;
					conv.use_extended_context = useExtendedContext ?? false;
				}
				historyManager.updateConversationHeader(conv).catch((e) => {
					log.error("Failed to update conversation header on preset change", { error: String(e) });
				});
			}
		});

		// Available presets
		view.setGetAvailablePresets(() => {
			return this.settings.model_presets;
		});

		// Current preset — reads from per-orchestrator state
		view.setGetCurrentPreset(() => {
			return orchestrator!.getActivePresetName();
		});

		// Checkpoint callbacks — use per-orchestrator checkpoint manager (A1.6c / A3)
		const checkpointMgr = orchestrator.getCheckpointManager();
		view.setOnListCheckpoints(async () => {
			return checkpointMgr?.listCheckpoints() ?? [];
		});

		view.setOnRestoreCheckpoint(async (checkpointId) => {
			return checkpointMgr?.restore(checkpointId) ?? false;
		});

		view.setOnGetCurrentContent(async (notePath) => {
			return checkpointMgr?.getCurrentContent(notePath) ?? null;
		});

		// Wire approval callback for this panel's orchestrator (Phase 4, Step 4e).
		// Each orchestrator gets its own approval callback bound to the correct
		// panel's view. Replaces the former ToolDispatcher.setApprovalCallback().
		orchestrator.setApprovalCallback(async (toolCall, abortSignal?, messageId?, autoApproved?) => {
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
				toolCall.parameters ?? {},
				autoApproved
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

		// History loading removed — conversation loading is now the sole
		// responsibility of loadConversation(), called from setState() and
		// the setTimeout(0) fallback in the registerView factory.
		// See specs/ZZ-misc/multi-conversation-robustness-redesign.md — Phase A3.1
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

	/** Open (or reveal) a Notor chat panel. */
	private async openChatPanel(): Promise<void> {
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
	private newConversation(): void {
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