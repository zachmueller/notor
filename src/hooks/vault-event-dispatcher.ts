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
import type { VaultEventHook, Workflow, ExecutionChain, TriggerContext, WorkflowExecution } from "../types";
import type { NotorSettings } from "../settings";
import type { WorkflowConcurrencyManager } from "../workflows/workflow-concurrency";
import type { ChatOrchestrator } from "../chat/orchestrator";
import type { PersonaManager } from "../personas/persona-manager";
import { ExecutionChainTracker } from "./execution-chain";
import { executeVaultEventHook } from "./vault-event-hook-engine";
import type { VaultEventHookContext } from "./vault-event-hook-engine";
import { assembleWorkflowPrompt, switchWorkflowPersona } from "../workflows/workflow-executor";
import { logger } from "../utils/logger";

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
	/** Chat orchestrator for background workflow execution pipeline. */
	orchestrator: ChatOrchestrator;
	/** Persona manager for workflow persona switching. */
	personaManager?: PersonaManager;
	/** Execution chain tracker instance. */
	chainTracker: ExecutionChainTracker;
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
	if (hooks.length === 0) return;

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
		const workflow = hook as Workflow;

		// Single-instance guard
		if (deps.concurrencyManager.isWorkflowRunning(workflow.file_path)) {
			const name = workflow.display_name;
			log.warn("Workflow already running; skipping", { name });
			new Notice(`Workflow '${name}' already running; skipped.`);
			return;
		}

		await executeRunWorkflowAction(
			workflow.file_path,
			context,
			chain,
			deps
		);
		return;
	}

	// Settings-configured VaultEventHook
	const vaultHook = hook as VaultEventHook;
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

		// Single-instance guard
		if (deps.concurrencyManager.isWorkflowRunning(workflowPath)) {
			log.warn("Workflow already running; skipping", { workflowPath });
			new Notice(`Workflow '${workflowPath}' already running; skipped.`);
			return;
		}

		await executeRunWorkflowAction(workflowPath, context, chain, deps);
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
	deps: DispatcherDeps
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
	const fm = cache?.frontmatter;

	// Validate it's a Notor workflow note
	if (!fm?.["notor-workflow"]) {
		log.warn("File is not a Notor workflow note (missing notor-workflow: true)", {
			workflowPath,
		});
		new Notice(`'${workflowPath}' is not a valid workflow (missing notor-workflow: true).`);
		return;
	}

	// Build a minimal Workflow object from frontmatter
	const workflow: import("../types").Workflow = {
		file_path: workflowFile.path,
		file_name: workflowFile.name,
		display_name: (fm["notor-display-name"] as string | undefined)
			?? workflowFile.basename,
		trigger: (fm["notor-trigger"] as import("../types").WorkflowTrigger | undefined)
			?? "manual",
		schedule: (fm["notor-schedule"] as string | null | undefined) ?? null,
		persona_name: (fm["notor-workflow-persona"] as string | null | undefined) ?? null,
		hooks: null, // Per-workflow hooks not needed here — handled by the execution pipeline
		body_content: "",
	};

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
			deps.metadataCache
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

	// Submit to the concurrency manager — run function is the background pipeline
	deps.concurrencyManager.submit(execution, async () => {
		try {
			await deps.orchestrator.executeBackgroundWorkflow(
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
		}
	});
}
