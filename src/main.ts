/**
 * Notor plugin entry point — lifecycle only.
 *
 * Keeps main.ts minimal per AGENTS.md conventions. All feature logic
 * is delegated to separate modules.
 *
 * INT-001: Full lifecycle wiring — registers chat view, commands, settings
 * tab, and initializes all managers with clean unload support.
 */

import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { MarkdownView } from "obsidian";
import { DEFAULT_SETTINGS, NotorSettings, NotorSettingTab } from "./settings";
import { logger } from "./utils/logger";
import { notifyMarkdownLeafActivated } from "./context/auto-context";

// Workflows
import { discoverWorkflows } from "./workflows/workflow-discovery";
import { showWorkflowPicker } from "./workflows/workflow-executor";
import type { Workflow } from "./types";

// Providers
import { ProviderRegistry } from "./providers/index";
import { LocalProvider } from "./providers/local-provider";
import { AnthropicProvider } from "./providers/anthropic-provider";
import { OpenAIProvider } from "./providers/openai-provider";
import type { LLMProviderType } from "./types";

// Tools
import { ToolRegistry } from "./tools/index";
import { ReadNoteTool } from "./tools/read-note";
import { WriteNoteTool } from "./tools/write-note";
import { ReplaceInNoteTool } from "./tools/replace-in-note";
import { SearchVaultTool } from "./tools/search-vault";
import { ListVaultTool } from "./tools/list-vault";
import { ReadFrontmatterTool } from "./tools/read-frontmatter";
import { UpdateFrontmatterTool } from "./tools/update-frontmatter";
import { ManageTagsTool } from "./tools/manage-tags";
import { FetchWebpageTool } from "./tools/fetch-webpage";
import { ExecuteCommandTool } from "./tools/execute-command";
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

// UI
import { NotorChatView, CHAT_VIEW_TYPE } from "./ui/chat-view";

const log = logger("Main");

export default class NotorPlugin extends Plugin {
	settings: NotorSettings;

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
	private _noteOpener?: NoteOpener;
	private _staleTracker?: StaleContentTracker;
	private _personaManager?: PersonaManager;

	/** Cached workflow discovery results (C-008). In-memory only — always re-discovered from vault. */
	private _discoveredWorkflows: Workflow[] = [];

	// -----------------------------------------------------------------------
	// Plugin lifecycle
	// -----------------------------------------------------------------------

	async onload() {
		log.info("Plugin loading", { version: this.manifest.version });

		// 1. Load settings (fast — required immediately)
		await this.loadSettings();
		log.debug("Settings loaded", { settings: this.settings });

		// 2. Register the settings tab
		this.addSettingTab(new NotorSettingTab(this.app, this));

		// 3. Register the chat panel view type
		this.registerView(CHAT_VIEW_TYPE, (leaf) => {
			const view = new NotorChatView(leaf, this);
			// Wire the view to the orchestrator once available
			this.wireView(view);
			return view;
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

		// E-009: "Notor: Run workflow" command palette entry.
		// Rescans workflows on each invocation so newly created/deleted
		// workflows are reflected without a plugin reload (FR-41).
		this.addCommand({
			id: "run-workflow",
			name: "Run workflow",
			callback: () => {
				showWorkflowPicker(
					this.app,
					() => this.rescanWorkflows(),
					(workflow) => {
						// Open the chat panel if not already open, then execute the workflow.
						// The panel open is non-blocking — execution begins once the view is ready.
						this.openChatPanel().then(() => {
							log.info("Workflow selected from command palette", {
								display_name: workflow.display_name,
								file_path: workflow.file_path,
							});
							// Workflow execution (E-013) is wired in a future task.
							// For now, log the selection so E2E tests can verify the
							// picker round-trip is functional.
						}).catch((e) => {
							log.error("Failed to open chat panel for workflow", {
								error: String(e),
							});
							new Notice(`Failed to open chat panel: ${e instanceof Error ? e.message : String(e)}`);
						});
					},
					this.settings.notor_dir
				).catch((e) => {
					log.error("Run workflow command failed", { error: String(e) });
					new Notice(`Failed to open workflow picker: ${e instanceof Error ? e.message : String(e)}`);
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
				// chat panel steals focus.
			})
		);

		// 6. Start vault rule manager (watches rules directory for changes)
		// This is lightweight — just sets up file watchers
		this.getVaultRuleManager().start();

		// 7. Kick off initial workflow discovery (C-008).
		// Deferred until layout is ready — vault file index must be fully
		// populated before getAbstractFileByPath() can resolve the
		// workflows directory. This is a standard Obsidian pattern.
		this.app.workspace.onLayoutReady(() => {
			this.rescanWorkflows().catch((e) => {
				log.warn("Initial workflow discovery failed", { error: String(e) });
			});
		});

		log.info("Plugin loaded");
	}

	onunload() {
		log.info("Plugin unloading");

		// Clear the last-active markdown path cache on unload
		notifyMarkdownLeafActivated(null);

		// Stop vault rule manager file watchers
		this._vaultRuleManager?.stop();

		// Clear cached workflow discovery results (C-008)
		this._discoveredWorkflows = [];

		// All DOM elements, intervals, and event listeners registered via
		// this.register* / this.registerEvent / this.registerDomEvent are
		// automatically cleaned up by Obsidian when the plugin unloads.

		log.info("Plugin unloaded");
	}

	// -----------------------------------------------------------------------
	// Settings
	// -----------------------------------------------------------------------

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

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

		// B-007: Propagate persona auto-approve config changes to dispatcher
		// so changes from the Settings UI take effect on the next dispatch()
		// without requiring a plugin reload.
		if (this._toolDispatcher) {
			this._toolDispatcher.setPersonaAutoApprove(this.settings.persona_auto_approve);
		}

		// C-008: Re-discover workflows when notor_dir may have changed.
		// Non-blocking — fire and forget so saveSettings() doesn't await
		// the full vault scan.
		this.rescanWorkflows().catch((e) => {
			log.warn("Workflow rescan after settings change failed", { error: String(e) });
		});
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
			this._providerRegistry.registerFactory("bedrock", (config, app) => {
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

	/** Tool registry with all built-in tools registered. */
	getToolRegistry(): ToolRegistry {
		if (!this._toolRegistry) {
			this._toolRegistry = new ToolRegistry();

			const staleTracker = this.getStaleTracker();
			const noteOpener = this.getNoteOpener();
			const checkpointManager = this.getCheckpointManager();

			// Read-only tools
			this._toolRegistry.register(
				new ReadNoteTool(this.app, staleTracker, noteOpener)
			);
			this._toolRegistry.register(new SearchVaultTool(this.app));
			this._toolRegistry.register(new ListVaultTool(this.app));
			this._toolRegistry.register(new ReadFrontmatterTool(this.app));

			// Write tools
			this._toolRegistry.register(
				new WriteNoteTool(this.app, staleTracker, noteOpener, checkpointManager)
			);
			this._toolRegistry.register(
				new ReplaceInNoteTool(this.app, staleTracker, noteOpener, checkpointManager)
			);
			this._toolRegistry.register(
				new UpdateFrontmatterTool(this.app, checkpointManager)
			);
			this._toolRegistry.register(
				new ManageTagsTool(this.app, checkpointManager)
			);

			// Phase 3: New tools
			this._toolRegistry.register(
				new FetchWebpageTool(this.app, this.settings)
			);
			this._toolRegistry.register(
				new ExecuteCommandTool(this.app, this.settings)
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

			// B-007: Initialize persona auto-approve state on dispatcher
			this._toolDispatcher.setPersonaAutoApprove(this.settings.persona_auto_approve);
			this._toolDispatcher.setActivePersonaName(
				this.settings.active_persona || null
			);

			// Set vault root path for working directory validation
			const adapter = this.app.vault.adapter as { basePath?: string };
			if (adapter.basePath) {
				this._toolDispatcher.setVaultRootPath(adapter.basePath);
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
		}
		return this._orchestrator;
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
	async rescanWorkflows(): Promise<Workflow[]> {
		const workflows = await discoverWorkflows(
			this.app.vault,
			this.app.metadataCache,
			this.settings.notor_dir
		);
		this._discoveredWorkflows = workflows;
		log.debug("Workflow cache updated", {
			count: workflows.length,
			names: workflows.map((w) => w.display_name),
		});
		return workflows;
	}

	// -----------------------------------------------------------------------
	// View wiring
	// -----------------------------------------------------------------------

	/**
	 * Wire a newly created chat view to the orchestrator.
	 *
	 * Called when the view is registered and every time the view is opened
	 * (Obsidian may recreate views on workspace restore).
	 */
	private wireView(view: NotorChatView): void {
		const orchestrator = this.getOrchestrator();
		const toolRegistry = this.getToolRegistry();
		const historyManager = this.getHistoryManager();
		const checkpointManager = this.getCheckpointManager();
		const providerRegistry = this.getProviderRegistry();
		const toolDispatcher = this.getToolDispatcher();

		// Wire orchestrator ↔ view
		orchestrator.setView(view);

		// Wire persona manager to view (A-013: picker + label)
		const personaManager = this.getPersonaManager();
		view.setPersonaManager(personaManager);

		// B-007: Wire persona name changes to the dispatcher so auto-approve
		// resolution tracks the active persona in real time. When the user
		// switches personas via the picker, the PersonaManager fires this
		// callback, which updates the dispatcher's active persona name.
		personaManager.setOnPersonaNameChanged((name) => {
			toolDispatcher.setActivePersonaName(name);
		});

		// Restore active persona from settings on view wire (deferred, non-blocking).
		// This ensures the persona label and provider/model state are restored
		// when the chat panel opens after plugin load.
		personaManager.restoreFromSettings().catch((e) => {
			log.warn("Failed to restore active persona from settings", { error: String(e) });
		});

		// Send message (with optional attachments from the chat view)
		view.setOnSendMessage(async (content: string, attachments?) => {
			// Cast is safe: both ToolDefinition types are structurally identical —
			// the only difference is JSONSchemaProperty.type being string | undefined
			// vs string. Provider implementations handle undefined type gracefully.
			const toolDefinitions = toolRegistry.getToolDefinitions() as import("./providers/provider").ToolDefinition[];
			await orchestrator.handleUserMessage(content, toolDefinitions, attachments);
		});

		// Stop response
		view.setOnStopResponse(() => {
			// AbortController is managed by the view; signal abort via the controller
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
				// B-007: Also propagate persona auto-approve on settings reload
				toolDispatcher.setPersonaAutoApprove(this.settings.persona_auto_approve);
				toolDispatcher.setActivePersonaName(
					this.settings.active_persona || null
				);
				if (this._orchestrator) {
					this._orchestrator.updateSettings(this.settings);
				}

				return orchestrator.newConversation();
			}).then(() => {
				const convManager = orchestrator.getConversationManager();
				const conv = convManager.getActiveConversation();
				if (conv) {
					checkpointManager.setConversationId(conv.id);
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

		// Switch conversation
		view.setOnSwitchConversation((filename: string) => {
			orchestrator.switchConversation(filename).then(() => {
				const convManager = orchestrator.getConversationManager();
				const conv = convManager.getActiveConversation();
				if (conv) {
					checkpointManager.setConversationId(conv.id);
				}
				// Clear stale tracker and vault rule accessed notes when switching
				this.getStaleTracker().clear?.();
				this.getVaultRuleManager().clearAccessedNotes();
			}).catch((e) => {
				log.error("Failed to switch conversation", { error: String(e) });
			});
		});

		// Mode toggle
		view.setOnModeToggle((mode) => {
			const convManager = orchestrator.getConversationManager();
			convManager.setMode(mode);
		});

		// Settings open (open Obsidian settings tab)
		view.setOnSettingsOpen(() => {
			// Open plugin settings
			(this.app as import("obsidian").App & {
				setting?: { open: () => void; openTabById: (id: string) => void };
			}).setting?.openTabById("notor");
		});

		// Provider change
		view.setOnProviderChange((providerId) => {
			providerRegistry.switchProvider(providerId);
			this.settings.active_provider = providerId;
			this.saveSettings().catch((e) => {
				log.error("Failed to save provider change", { error: String(e) });
			});
		});

		// Model change
		view.setOnModelChange((modelId) => {
			const activeType = providerRegistry.getActiveType();
			const config = providerRegistry.getConfig(activeType);
			if (config) {
				const updated = { ...config, model_id: modelId };
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

		// Current provider
		view.setGetCurrentProvider(() => {
			return providerRegistry.getActiveType();
		});

		// Current model
		view.setGetCurrentModel(() => {
			const activeType = providerRegistry.getActiveType();
			const config = providerRegistry.getConfig(activeType);
			return config?.model_id ?? "";
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

		// Wire approval callback for tool dispatcher
		toolDispatcher.setApprovalCallback(async (toolCall) => {
			// Find the most recent tool call element in the view for the approval UI.
			// The view tracks the last rendered tool call element via getLastToolCallEl().
			const toolCallEl = view.getLastToolCallEl();
			if (toolCallEl) {
				// For write_note and replace_in_note, render a full diff preview.
				// For all other tools, use the plain approve/reject prompt.
				return view.renderDiffApprovalPrompt(
					toolCallEl,
					toolCall.tool_name,
					toolCall.parameters ?? {}
				);
			}
			// Fallback: auto-approve if no UI element available
			log.warn("No tool call element for approval prompt, auto-approving");
			return "approved";
		});

		// Load conversation history and render it
		historyManager.listConversations().then((entries) => {
			view.renderConversationList(entries);

			// Auto-start a new conversation if none exist, or restore last
			if (entries.length === 0) {
				orchestrator.newConversation().then(() => {
					const conv = orchestrator.getConversationManager().getActiveConversation();
					if (conv) {
						checkpointManager.setConversationId(conv.id);
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
						}
					}).catch(() => {
						// Fallback to new conversation on load error
						orchestrator.newConversation().then(() => {
							const conv = orchestrator.getConversationManager().getActiveConversation();
							if (conv) {
								checkpointManager.setConversationId(conv.id);
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

	/** Open (or reveal) the Notor chat panel. */
	private async openChatPanel(): Promise<void> {
		const { workspace } = this.app;

		// Check if the view is already open
		const existing = workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		if (existing.length > 0) {
			// Reveal the existing leaf
			workspace.revealLeaf(existing[0] as WorkspaceLeaf);
			return;
		}

		// Open in the right sidebar
		const leaf = workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
			workspace.revealLeaf(leaf);
		}
	}

	/** Start a new conversation (command palette action). */
	private newConversation(): void {
		const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		if (leaves.length > 0) {
			// Trigger via the view's new conversation callback
			const view = leaves[0]?.view as NotorChatView | undefined;
			if (view) {
				// Delegate to the orchestrator
				this.getOrchestrator()
					.newConversation()
					.then(() => {
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
}