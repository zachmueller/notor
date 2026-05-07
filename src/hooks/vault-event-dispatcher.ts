/**
 * Vault event hook dispatcher — central coordinator for vault event hook execution.
 *
 * Implements two functions:
 *
 * - `dispatchVaultEventHooks()` (F-018): Receives collected hooks + event context
 *   from individual listeners (F-008..F-016) and executes them sequentially.
 *   Routes `execute_command` actions to the vault event hook engine (F-017) and
 *   `run_workflow` actions to `executeRunWorkflowAction()` (F-019).
 *
 * - `executeRunWorkflowAction()` (F-019): Resolves a workflow by vault-relative
 *   path, assembles the prompt with trigger context, and delegates to the
 *   WorkflowConcurrencyManager (F-020) for background execution.
 *
 * The dispatch is fire-and-forget: listeners never await the dispatcher.
 * Failures surface via Notice but do not prevent subsequent hooks from running.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-018, F-019
 * @see specs/03-workflows-personas/contracts/vault-event-hooks.md — §Execution semantics
 */

import { Notice, Platform, TFile } from "obsidian";
import type { App, Vault, MetadataCache } from "obsidian";
import type { ConversationMode, VaultEventHook, Workflow, ExecutionChain, TriggerContext, WorkflowExecution } from "../types";
import type { AutomationTrigger, UserAutomationDefinition } from "../extensions/types";
import type { NotorSettings } from "../settings";
import type { WorkflowConcurrencyManager } from "../workflows/workflow-concurrency";
import type { ChatOrchestrator } from "../chat/orchestrator";
import type { PersonaManager } from "../personas/persona-manager";
import { ExecutionChainTracker } from "./execution-chain";
import { executeVaultEventHook } from "./vault-event-hook-engine";
import type { VaultEventHookContext } from "./vault-event-hook-engine";
import { vaultEventTypeToWorkflowTrigger } from "./vault-event-listener-manager";
import { assembleWorkflowPrompt, switchWorkflowPersona } from "../workflows/workflow-executor";
import { injectWorkflowFrontmatter } from "../workflows/workflow-frontmatter";
import { logger } from "../utils/logger";
import type { TemplateVariableRegistry } from "../template-vars";
import type { HookDelayManager } from "./hook-delay-manager";

const log = logger("VaultEventDispatcher");

// ---------------------------------------------------------------------------
// Dependencies interfaces
// ---------------------------------------------------------------------------

/**
 * Dependencies required by the dispatcher and workflow action executor.
 *
 * Assembled in `main.ts` (F-023) and passed through the dispatch chain.
 */
export interface DispatcherDeps {
	/** The Obsidian App instance. */
	app: App;
	/** Vault instance for file resolution. */
	vault: Vault;
	/** Metadata cache for workflow file resolution. */
	metadataCache: MetadataCache;
	/** Plugin settings getter (returns the live settings object). */
	getSettings: () => NotorSettings;
	/** Vault root path for shell command execution. */
	vaultRootPath: string;
	/** Concurrency manager for background workflow executions. */
	concurrencyManager: WorkflowConcurrencyManager;
	/** Chat orchestrator for background workflow execution pipeline (null if no active panel). */
	orchestrator: ChatOrchestrator | null;
	/** Persona manager for workflow persona switching. */
	personaManager?: PersonaManager;
	/** Execution chain tracker instance. */
	chainTracker: ExecutionChainTracker;
	/** EXT-014: Accessor for user-defined automations matching a vault event trigger. */
	getExtensionAutomations?: (trigger: AutomationTrigger) => UserAutomationDefinition[];
	/** EXT-014: Executor for user-defined automations (encapsulates runtime context building). */
	executeExtensionAutomation?: (automation: UserAutomationDefinition, context: Record<string, unknown>) => Promise<unknown>;
	/** Template variable registry for resolving {notor_dir} etc. in workflow bodies. */
	templateRegistry?: TemplateVariableRegistry;
	/** Per-hook debounce delay manager (Phase 5). */
	hookDelayManager?: HookDelayManager;
	/** Factory to create a headless orchestrator for background workflow execution. */
	createHeadlessOrchestrator?: () => ChatOrchestrator;
}

// ---------------------------------------------------------------------------
// F-018: Vault event hook dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch collected vault event hooks sequentially.
 *
 * This is the central dispatcher called by all vault event listeners
 * (F-008..F-016) with the hooks they have collected for their event type.
 * Execution is fire-and-forget — the caller does not await completion.
 *
 * Execution order:
 * 1. Settings-configured hooks (in their configured order)
 * 2. Discovered workflows with matching `notor-trigger` (alphabetical by path)
 *
 * For each hook:
 * - Checks execution chain for loop prevention (skips if cycle detected)
 * - For `execute_command` actions: calls `executeVaultEventHook()` (F-017)
 *   subject to global hook timeout; failures surface Notice but continue
 * - For `run_workflow` actions and raw Workflow triggers: calls
 *   `executeRunWorkflowAction()` (F-019) — NOT subject to hook timeout
 *
 * @param hooks   - Ordered list of settings hooks and/or workflow triggers.
 * @param context - Vault event context (event type, timestamp, note path, tag diff).
 * @param chain   - Execution chain for loop prevention, or null outside hook context.
 * @param deps    - Dispatcher dependencies.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-018
 * @see specs/03-workflows-personas/contracts/vault-event-hooks.md — §Execution semantics
 */
export function dispatchVaultEventHooks(
	hooks: Array<VaultEventHook | Workflow>,
	context: VaultEventHookContext,
	chain: ExecutionChain | null,
	deps: DispatcherDeps
): void {
	// EXT-014: Also check for extension automations before early return
	const hasAutomations = deps.getExtensionAutomations && deps.executeExtensionAutomation;
	if (hooks.length === 0 && !hasAutomations) return;

	log.info("Dispatching vault event hooks", {
		count: hooks.length,
		event: context.hookEvent,
		notePath: context.notePath,
	});

	// Fire-and-forget: execute sequentially but don't block the caller
	void (async () => {
		for (const hook of hooks) {
			try {
				await _executeOneHook(hook, context, chain, deps);
			} catch (e) {
				// Unexpected errors are caught here so subsequent hooks still run
				const msg = e instanceof Error ? e.message : String(e);
				log.error("Unexpected error executing vault event hook", {
					error: msg,
					hookEvent: context.hookEvent,
				});
				new Notice(`Vault event hook error: ${msg}`);
			}
		}

		// EXT-014: Execute matching extension automations after hooks/workflows
		if (deps.getExtensionAutomations && deps.executeExtensionAutomation) {
			try {
				const automations = deps.getExtensionAutomations(context.hookEvent as AutomationTrigger);
				if (automations.length > 0) {
					log.info("Dispatching extension automations for vault event", {
						count: automations.length,
						event: context.hookEvent,
					});

					// Build vault event context for automations
					const automationCtx: Record<string, unknown> = {
						hookEvent: context.hookEvent,
						timestamp: context.timestamp,
					};

					// Add event-specific context fields
					if (context.notePath !== null) {
						automationCtx.notePath = context.notePath;
					}
					if (context.tagsAdded !== null) {
						automationCtx.tagsAdded = context.tagsAdded;
					}
					if (context.tagsRemoved !== null) {
						automationCtx.tagsRemoved = context.tagsRemoved;
					}

					// Execute within the same chain context for loop prevention
					for (const automation of automations) {
						// Check execution chain for loop prevention
						if (chain !== null && deps.chainTracker.shouldSkipHook(chain, context.hookEvent)) {
							break;
						}

						try {
							await deps.executeExtensionAutomation(automation, automationCtx);
						} catch (e) {
							const displayName = automation.displayName ?? automation.filePath;
							const message = e instanceof Error ? e.message : String(e);
							new Notice(`Automation error in ${displayName}: ${message}`);
							log.error("User automation execution failed", {
								automation: displayName,
								trigger: context.hookEvent,
								error: String(e),
								stack: e instanceof Error ? e.stack : undefined,
							});
						}
					}
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				log.error("Unexpected error dispatching extension automations", {
					error: msg,
					hookEvent: context.hookEvent,
				});
			}
		}

		log.info("Vault event hook dispatch complete", {
			count: hooks.length,
			event: context.hookEvent,
		});
	})();
}

/**
 * Execute a single hook or workflow trigger with loop detection.
 */
async function _executeOneHook(
	hook: VaultEventHook | Workflow,
	context: VaultEventHookContext,
	chain: ExecutionChain | null,
	deps: DispatcherDeps
): Promise<void> {
	const chainTracker = deps.chainTracker;

	// Check execution chain for loop prevention
	if (chainTracker.shouldSkipHook(chain, context.hookEvent)) {
		// Notice already surfaced inside shouldSkipHook
		return;
	}

	// Determine if this is a raw Workflow trigger or a VaultEventHook
	const isWorkflowTrigger = _isWorkflow(hook);

	if (isWorkflowTrigger) {
		// Raw workflow trigger — treat as run_workflow action
		const workflow = hook;

		// Single-instance guard (skipped if delay > 0; re-checked at execution time)
		const effectiveDelay = (context.hookEvent === "on_schedule")
			? 0
			: (workflow.hook_delay ?? 0);
		if (effectiveDelay === 0 && deps.concurrencyManager.isWorkflowRunning(workflow.file_path)) {
			const name = workflow.display_name;
			log.warn("Workflow already running; skipping", { name });
			new Notice(`Workflow '${name}' already running; skipped.`);
			return;
		}

		await executeRunWorkflowAction(
			workflow.file_path,
			context,
			chain,
			deps,
			null,               // hookDelayMs — inherit from workflow.hook_delay
			workflow.file_path, // hookId — use file path as debounce key
		);
		return;
	}

	// Settings-configured VaultEventHook
	const vaultHook = hook;
	const actionType = vaultHook.action_type ?? "execute_command";

	if (actionType === "execute_command") {
		// Shell command action — subject to hook timeout, desktop-only
		if (!Platform.isDesktopApp) {
			log.debug("Skipping execute_command vault hook on mobile", {
				hookId: vaultHook.id,
			});
			return;
		}

		const settings = deps.getSettings();
		const result = await executeVaultEventHook(
			vaultHook,
			context,
			settings,
			deps.vaultRootPath
		);

		if (!result.success && !result.timedOut) {
			// Error is already noticed inside executeVaultEventHook; continue
			log.warn("Vault event hook command failed; continuing", {
				hookId: vaultHook.id,
				error: result.error,
			});
		}
	} else if (actionType === "run_workflow") {
		// Workflow action — NOT subject to hook timeout
		const workflowPath = vaultHook.workflow_path;
		if (!workflowPath?.trim()) {
			log.warn("run_workflow hook has no workflow_path; skipping", {
				hookId: vaultHook.id,
			});
			new Notice(`Vault event hook '${vaultHook.label || vaultHook.id}' has no workflow path configured.`);
			return;
		}

		// Single-instance guard (skipped if delay > 0; re-checked at execution time)
		const hookDelay = vaultHook.delay_ms;
		const skipConcurrencyCheck = hookDelay != null && hookDelay > 0;
		if (!skipConcurrencyCheck && deps.concurrencyManager.isWorkflowRunning(workflowPath)) {
			log.warn("Workflow already running; skipping", { workflowPath });
			new Notice(`Workflow '${workflowPath}' already running; skipped.`);
			return;
		}

		await executeRunWorkflowAction(
			workflowPath, context, chain, deps,
			vaultHook.delay_ms, // hookDelayMs — null=inherit, 0=immediate, >0=override
			vaultHook.id,       // hookId — use hook ID as debounce key
		);
	}
}

/**
 * Type guard: distinguish a `Workflow` from a `VaultEventHook` by checking
 * for the `file_path` property (unique to `Workflow`).
 */
function _isWorkflow(hook: VaultEventHook | Workflow): hook is Workflow {
	return "file_path" in hook && "trigger" in hook;
}

// ---------------------------------------------------------------------------
// F-019: "Run a workflow" hook action executor
// ---------------------------------------------------------------------------

/**
 * Execute a "run a workflow" hook action.
 *
 * Resolves the workflow by its vault-relative path, assembles the prompt with
 * trigger context, and submits the execution to `WorkflowConcurrencyManager`
 * (F-020) for background processing.
 *
 * Used by both vault event hooks (via `dispatchVaultEventHooks`) and Phase 3
 * LLM lifecycle hooks (via F-022 routing in `hook-events.ts`).
 *
 * Error conditions that abort execution:
 * - Workflow file not found in vault
 * - File exists but is not a valid workflow (`notor-workflow: true` required)
 * - Prompt assembly fails or returns null (empty guard)
 *
 * On success, delegates to `WorkflowConcurrencyManager.submit()` which starts
 * the background execution pipeline asynchronously.
 *
 * @param workflowPath - Vault-relative path to the workflow note.
 * @param context      - Vault event context (may represent an LLM lifecycle event).
 * @param chain        - Execution chain for loop prevention (extended before submission).
 * @param deps         - Dispatcher dependencies.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-019
 */
export async function executeRunWorkflowAction(
	workflowPath: string,
	context: VaultEventHookContext,
	chain: ExecutionChain | null,
	deps: DispatcherDeps,
	hookDelayMs?: number | null,
	hookId?: string,
): Promise<void> {
	log.info("Executing run_workflow action", {
		workflowPath,
		hookEvent: context.hookEvent,
	});

	// Resolve the workflow TFile
	const abstractFile = deps.vault.getAbstractFileByPath(workflowPath);
	if (!(abstractFile instanceof TFile)) {
		log.warn("Workflow file not found", { workflowPath });
		new Notice(`Workflow '${workflowPath}' not found.`);
		return;
	}

	// Discover the workflow from cached discovery results or build a minimal Workflow object
	// by reading its frontmatter via metadataCache.
	const workflowFile = abstractFile;
	const cache = deps.metadataCache.getFileCache(workflowFile);
	let fm = cache?.frontmatter;

	// Validate it's a Notor workflow note — attempt auto-repair if missing
	const isValidWorkflow = fm?.["notor-workflow"] === true || fm?.["notor-type"] === "workflow";
	if (!isValidWorkflow) {
		log.warn("Workflow missing identification, attempting auto-repair", { workflowPath });
		const trigger = vaultEventTypeToWorkflowTrigger(context.hookEvent as import("../types").VaultEventHookType)
			?? (context.hookEvent === "on_schedule" ? "scheduled" : "manual");
		const result = await injectWorkflowFrontmatter(deps.app, workflowFile, trigger);
		if (!result.injected) {
			log.warn("Auto-repair failed", { workflowPath });
			new Notice(`'${workflowPath}' is not a valid workflow and auto-repair failed.`);
			return;
		}
		new Notice(`Auto-repaired workflow headers in '${workflowFile.name}'.`);
		const newCache = deps.metadataCache.getFileCache(workflowFile);
		fm = newCache?.frontmatter;
		if (!fm) {
			new Notice(`'${workflowPath}' metadata unavailable after repair.`);
			return;
		}
	}

	// Build a minimal Workflow object from frontmatter
	if (!fm) {
		new Notice(`'${workflowPath}' has no frontmatter.`);
		return;
	}
	const workflow: import("../types").Workflow = {
		file_path: workflowFile.path,
		file_name: workflowFile.name,
		display_name: (fm["notor-display-name"] as string | undefined)
			?? workflowFile.basename,
		aliases: [],
		trigger: (fm["notor-trigger"] as import("../types").WorkflowTrigger | undefined)
			?? "manual",
		schedule: (fm["notor-schedule"] as string | null | undefined) ?? null,
		persona_name: (fm["notor-workflow-persona"] as string | null | undefined) ?? null,
		mode: (fm["notor-conversation-mode"] === "plan" || fm["notor-conversation-mode"] === "act")
			? fm["notor-conversation-mode"] as ConversationMode
			: null,
		model_preset: (fm["notor-model-preset"] as string | null | undefined)?.trim() ?? null,
		hook_delay: (() => {
			const raw = fm["notor-hook-delay"];
			return (typeof raw === "number" && raw >= 0) ? raw : null;
		})(),
		hooks: null, // Per-workflow hooks not needed here — handled by the execution pipeline
		active_note_prompt: (fm["notor-active-note-prompt"] as string | null | undefined) ?? null,
		body_content: "",
	};

	// Phase 5: Compute effective delay — on_schedule events always skip delay
	const effectiveDelay = (context.hookEvent === "on_schedule")
		? 0
		: (hookDelayMs ?? workflow.hook_delay ?? 0);

	if (effectiveDelay > 0 && deps.hookDelayManager) {
		deps.hookDelayManager.schedule(
			hookId ?? workflow.file_path,
			context.notePath ?? "",
			effectiveDelay,
			async () => {
				// Re-check concurrency at execution time (not schedule time)
				if (deps.concurrencyManager.isWorkflowRunning(workflow.file_path)) {
					log.warn("Workflow already running after delay; skipping", {
						workflowName: workflow.display_name,
					});
					return;
				}
				await _executeWorkflowSubmission(workflow, workflowFile, context, chain, deps);
			},
		);
		return;
	}

	// effectiveDelay === 0 → immediate execution
	await _executeWorkflowSubmission(workflow, workflowFile, context, chain, deps);
}

/**
 * Inner execution logic: assembles prompt, switches persona, and submits
 * the background workflow execution to the concurrency manager.
 */
async function _executeWorkflowSubmission(
	workflow: import("../types").Workflow,
	workflowFile: TFile,
	context: VaultEventHookContext,
	chain: ExecutionChain | null,
	deps: DispatcherDeps,
): Promise<void> {
	const workflowPath = workflow.file_path;

	// Build trigger context for prompt assembly
	const triggerContext: TriggerContext = {
		event: context.hookEvent,
		note_path: context.notePath,
		tags_added: context.tagsAdded,
		tags_removed: context.tagsRemoved,
	};

	// Assemble the workflow prompt
	let assemblyResult;
	try {
		assemblyResult = await assembleWorkflowPrompt(
			{
				workflow,
				supplementaryText: null,
				triggerContext,
			},
			deps.vault,
			deps.metadataCache,
			deps.templateRegistry,
		);
	} catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		log.error("Workflow prompt assembly failed", {
			workflowPath,
			error: errMsg,
		});
		new Notice(`Workflow '${workflow.display_name}' assembly failed: ${errMsg}`);
		return;
	}

	// Empty guard: assembleWorkflowPrompt returns null and surfaces Notice itself
	if (assemblyResult === null) {
		log.warn("Workflow assembly returned null (empty guard)", { workflowPath });
		return;
	}

	// Apply persona switching if the workflow specifies one
	let personaSwitchResult: { switched: boolean; previousPersona: string | null } = {
		switched: false,
		previousPersona: null,
	};

	if (workflow.persona_name && deps.personaManager) {
		try {
			personaSwitchResult = await switchWorkflowPersona(
				workflow.persona_name,
				deps.personaManager
			);
		} catch (e) {
			log.error("Persona switch failed before background workflow execution", {
				personaName: workflow.persona_name,
				error: String(e),
			});
			// Non-fatal — continue with current persona
		}
	}

	// Extend the execution chain with the current hook event to prevent re-entry
	const extendedChain = chain !== null
		? deps.chainTracker.extendChain(chain, context.hookEvent)
		: deps.chainTracker.createChain(context.hookEvent);

	// Create a WorkflowExecution record
	const executionId = crypto.randomUUID();
	const execution: WorkflowExecution = {
		id: executionId,
		workflow_path: workflow.file_path,
		workflow_name: workflow.display_name,
		conversation_id: "", // Will be populated by executeBackgroundWorkflow
		trigger_event: context.hookEvent,
		trigger_source: context.notePath,
		status: "queued",
		started_at: new Date().toISOString(),
		completed_at: null,
		error_message: null,
	};

	log.info("Submitting background workflow execution", {
		executionId,
		workflowName: workflow.display_name,
	});

	// Resolve orchestrator: prefer active panel, fall back to headless factory
	let orchestrator = deps.orchestrator;
	let isHeadless = false;
	if (!orchestrator) {
		if (!deps.createHeadlessOrchestrator) {
			log.warn("Skipping background workflow — no orchestrator available", {
				workflowName: workflow.display_name,
			});
			new Notice(`Workflow '${workflow.display_name}' skipped: unable to create execution context.`);
			return;
		}
		orchestrator = deps.createHeadlessOrchestrator();
		isHeadless = true;
		log.info("Created headless orchestrator for background workflow", {
			workflowName: workflow.display_name,
		});
	}

	// Submit to the concurrency manager — run function is the background pipeline
	deps.concurrencyManager.submit(execution, async () => {
		try {
			await orchestrator.executeBackgroundWorkflow(
				{
					workflow,
					supplementaryText: null,
					triggerContext,
				},
				execution,
				extendedChain,
				deps.concurrencyManager,
				personaSwitchResult
			);
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			log.error("Background workflow execution failed", {
				executionId,
				workflowName: workflow.display_name,
				error: errMsg,
			});
			// onComplete will be called by executeBackgroundWorkflow's finally block;
			// if it throws before that, notify the concurrency manager here.
			deps.concurrencyManager.onComplete(executionId, "errored", errMsg);
			new Notice(`Workflow '${workflow.display_name}' failed: ${errMsg}`);
		} finally {
			if (isHeadless) {
				await orchestrator.destroy();
			}
		}
	});
}
