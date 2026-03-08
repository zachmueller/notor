/**
 * Vault event handler functions for Phase 3 event listeners.
 *
 * Contains handler implementations for the following vault event types:
 * - F-008: `handleNoteOpen()` — on_note_open (file-open)
 * - F-009: `handleNoteCreate()` — on_note_create (vault create)
 * - F-010: `handleModify()` — shared on_save / on_manual_save (vault modify)
 * - F-012: `handleManualSave()` — on_manual_save (called from handleModify)
 * - F-016: `handleMetadataChanged()` — on_tag_change (metadataCache changed)
 *
 * All handlers are fire-and-forget — they return void and surface failures
 * via Notice rather than propagating errors to the Obsidian event system.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-008..F-012, F-016
 * @see specs/03-workflows-personas/contracts/vault-event-hooks.md
 */

import type { CachedMetadata, TAbstractFile, TFile } from "obsidian";
import { parseFrontMatterTags } from "obsidian";
import type { VaultEventDebounce } from "./vault-event-debounce";
import type { ExecutionChainTracker } from "./execution-chain";
import type { ManualSaveDetector } from "./manual-save-detector";
import type { TagShadowCache, TagChangeSuppressionManager } from "./tag-change-detector";
import type { VaultEventHook, VaultEventHookConfig, Workflow } from "../types";
import type { NotorSettings } from "../settings";
import { logger } from "../utils/logger";

const log = logger("VaultEventHandlers");

// ---------------------------------------------------------------------------
// Dependencies interface
// ---------------------------------------------------------------------------

/**
 * All dependencies needed by vault event handler functions.
 *
 * Assembled in `main.ts` (F-023) and passed to all handler registrations
 * via the listener manager's `setEventHandler()`.
 */
export interface VaultEventHandlerDeps {
	/** Debounce engine for on_note_open, on_save, on_manual_save. */
	debounce: VaultEventDebounce;
	/** Execution chain tracker for loop prevention. */
	chainTracker: ExecutionChainTracker;
	/** Manual save detector for on_manual_save. */
	manualSaveDetector: ManualSaveDetector;
	/** Tag shadow cache for on_tag_change diff computation. */
	tagShadowCache: TagShadowCache;
	/** Tag change suppression manager for on_tag_change. */
	tagSuppression: TagChangeSuppressionManager;
	/**
	 * Dispatch function for executing collected hooks.
	 * Injected lazily to avoid circular dependency with vault-event-dispatcher.
	 */
	dispatch: (
		hooks: Array<VaultEventHook | Workflow>,
		context: import("./vault-event-hook-engine").VaultEventHookContext,
		chain: import("../types").ExecutionChain | null,
	) => void;
	/** Accessor for current plugin settings (always returns the live object). */
	getSettings: () => NotorSettings;
	/** Accessor for currently discovered workflows. */
	getDiscoveredWorkflows: () => Workflow[];
}

// ---------------------------------------------------------------------------
// F-008: on-note-open listener
// ---------------------------------------------------------------------------

/**
 * Handle the `file-open` workspace event for `on_note_open` hooks (FR-47).
 *
 * When a Markdown note is opened (activated) in the editor, collect matching
 * hooks and dispatch them. Applies debounce per note path.
 *
 * Registered via:
 * ```ts
 * listenerManager.setEventHandler("on_note_open", {
 *   type: "on_note_open",
 *   handler: (file) => handleNoteOpen(file, deps),
 * });
 * ```
 *
 * @param file - The opened file (may be null when the active leaf has no file).
 * @param deps - Vault event handler dependencies.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-008
 */
export function handleNoteOpen(
	file: TFile | null,
	deps: VaultEventHandlerDeps
): void {
	// Skip null (no file) or non-Markdown files
	if (!file || !file.path.endsWith(".md")) {
		return;
	}

	const eventType = "on_note_open" as const;

	// Debounce: skip if the same note was opened within the cooldown window
	if (deps.debounce.shouldDebounce(eventType, file.path)) {
		return;
	}

	log.debug("on_note_open fired", { path: file.path });

	const settings = deps.getSettings();
	const workflows = deps.getDiscoveredWorkflows();

	// Collect enabled settings hooks + workflow triggers (alphabetical by path)
	const hooks = collectHooksAndWorkflows(
		settings.vault_event_hooks,
		workflows,
		eventType,
		"on-note-open"
	);

	if (hooks.length === 0) return;

	const context: import("./vault-event-hook-engine").VaultEventHookContext = {
		hookEvent: eventType,
		timestamp: new Date().toISOString(),
		notePath: file.path,
		tagsAdded: null,
		tagsRemoved: null,
	};

	// Fire-and-forget — do not await
	deps.dispatch(hooks, context, null);
}

// ---------------------------------------------------------------------------
// F-009: on-note-create listener
// ---------------------------------------------------------------------------

/**
 * Handle the `vault.on('create')` event for `on_note_create` hooks (FR-48a).
 *
 * When a new Markdown file is created, dispatch hooks. Includes loop
 * prevention — notes created by hook-initiated workflows don't re-trigger.
 *
 * No debounce is applied; `on-note-create` fires once per file per contract.
 *
 * @param file - The created abstract file.
 * @param deps - Vault event handler dependencies.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-009
 */
export function handleNoteCreate(
	file: TAbstractFile,
	deps: VaultEventHandlerDeps
): void {
	// Must be a TFile with a .md extension
	if (!isTFile(file) || !file.path.endsWith(".md")) {
		return;
	}

	const eventType = "on_note_create" as const;

	// Loop prevention: skip notes created by a hook-initiated workflow
	// The active chain is carried through the background execution pipeline.
	// At the handler level we don't have a chain reference — the dispatcher
	// receives null for the chain and checks there. However, we can check
	// via the execution chain tracker if the path is suppressed.
	// (F-023 wires active chain access; for now we log and dispatch.)
	log.debug("on_note_create fired", { path: file.path });

	const settings = deps.getSettings();
	const workflows = deps.getDiscoveredWorkflows();

	const hooks = collectHooksAndWorkflows(
		settings.vault_event_hooks,
		workflows,
		eventType,
		"on-note-create"
	);

	if (hooks.length === 0) return;

	const context: import("./vault-event-hook-engine").VaultEventHookContext = {
		hookEvent: eventType,
		timestamp: new Date().toISOString(),
		notePath: file.path,
		tagsAdded: null,
		tagsRemoved: null,
	};

	deps.dispatch(hooks, context, null);
}

// ---------------------------------------------------------------------------
// F-010: on-save listener (shared modify handler)
// ---------------------------------------------------------------------------

/**
 * Handle the `vault.on('modify')` event — the shared handler for both
 * `on_save` and `on_manual_save` hooks (FR-48).
 *
 * A single Obsidian `modify` event feeds both hook types. This function
 * dispatches `on_save` hooks (with debounce) and then calls
 * `handleManualSave()` if the manual save detector indicates a manual save.
 *
 * @param file - The modified abstract file.
 * @param deps - Vault event handler dependencies.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-010
 */
export function handleModify(
	file: TAbstractFile,
	deps: VaultEventHandlerDeps
): void {
	// Must be a TFile with a .md extension
	if (!isTFile(file) || !file.path.endsWith(".md")) {
		return;
	}

	const onSaveEventType = "on_save" as const;

	// --- on_save path ---
	const onSaveDebounced = deps.debounce.shouldDebounce(onSaveEventType, file.path);

	if (!onSaveDebounced) {
		log.debug("on_save fired", { path: file.path });

		const settings = deps.getSettings();
		const workflows = deps.getDiscoveredWorkflows();

		const onSaveHooks = collectHooksAndWorkflows(
			settings.vault_event_hooks,
			workflows,
			onSaveEventType,
			"on-save"
		);

		if (onSaveHooks.length > 0) {
			const context: import("./vault-event-hook-engine").VaultEventHookContext = {
				hookEvent: onSaveEventType,
				timestamp: new Date().toISOString(),
				notePath: file.path,
				tagsAdded: null,
				tagsRemoved: null,
			};
			deps.dispatch(onSaveHooks, context, null);
		}
	}

	// --- on_manual_save path (always check, independent of on_save debounce) ---
	handleManualSave(file, deps);
}

// ---------------------------------------------------------------------------
// F-011 helper: manual save integration
// ---------------------------------------------------------------------------

/**
 * Handle the `on_manual_save` hook dispatch.
 *
 * Called from `handleModify()` when the manual save detector confirms that
 * the save was initiated by the user (Cmd+S / Ctrl+S).
 *
 * Applies its own debounce for `on_manual_save` events independently of
 * the `on_save` debounce.
 *
 * @param file - The saved file (already validated as TFile .md by caller).
 * @param deps - Vault event handler dependencies.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-012
 */
export function handleManualSave(
	file: TAbstractFile,
	deps: VaultEventHandlerDeps
): void {
	// Must be a TFile with a .md extension (guard for direct calls)
	if (!isTFile(file) || !file.path.endsWith(".md")) {
		return;
	}

	// Only proceed if this was a manual save
	if (!deps.manualSaveDetector.isManualSave(file.path)) {
		return;
	}

	const eventType = "on_manual_save" as const;

	// Debounce: apply per-note cooldown for manual save events
	if (deps.debounce.shouldDebounce(eventType, file.path)) {
		return;
	}

	log.debug("on_manual_save fired", { path: file.path });

	const settings = deps.getSettings();
	const workflows = deps.getDiscoveredWorkflows();

	const hooks = collectHooksAndWorkflows(
		settings.vault_event_hooks,
		workflows,
		eventType,
		"on-manual-save"
	);

	if (hooks.length === 0) return;

	const context: import("./vault-event-hook-engine").VaultEventHookContext = {
		hookEvent: eventType,
		timestamp: new Date().toISOString(),
		notePath: file.path,
		tagsAdded: null,
		tagsRemoved: null,
	};

	deps.dispatch(hooks, context, null);
}

// ---------------------------------------------------------------------------
// F-016: on-tag-change listener
// ---------------------------------------------------------------------------

/**
 * Handle the `metadataCache.on('changed')` event for `on_tag_change` hooks
 * (FR-49).
 *
 * Extracts current frontmatter tags, diffs against the shadow cache,
 * updates the cache, checks suppression, then dispatches hooks with
 * the tag diff context.
 *
 * @param file  - The changed file.
 * @param _data - Raw file content string (unused — we use the parsed cache).
 * @param cache - Parsed metadata cache for the file.
 * @param deps  - Vault event handler dependencies.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-016
 */
export function handleMetadataChanged(
	file: TFile,
	_data: string,
	cache: CachedMetadata,
	deps: VaultEventHandlerDeps
): void {
	// Extract new tags via parseFrontMatterTags (frontmatter only, per R-3)
	const rawNewTags: string[] = parseFrontMatterTags(cache.frontmatter) ?? [];

	// Normalize: strip leading '#', trim whitespace, lowercase for comparison
	// Store the original-cased values for reporting (using raw from parseFrontMatterTags,
	// which already strips '#' per the Obsidian API).
	const normalizedNewTags = new Set<string>(
		rawNewTags.map((t) => t.replace(/^#/, "").trim().toLowerCase())
	);

	// Compute diff against shadow cache
	const diff = deps.tagShadowCache.computeDiff(file.path, normalizedNewTags);

	// Always update the shadow cache (even if suppressed) to keep it accurate
	deps.tagShadowCache.updateTags(file.path, normalizedNewTags);

	// Early return if no tag changes
	if (diff.added.length === 0 && diff.removed.length === 0) {
		return;
	}

	// Check suppression (tag modified by Notor tools within hook workflow)
	if (deps.tagSuppression.checkAndConsume(file.path)) {
		log.debug("on_tag_change suppressed (Notor tool modification)", {
			path: file.path,
		});
		return;
	}

	log.debug("on_tag_change fired", {
		path: file.path,
		added: diff.added,
		removed: diff.removed,
	});

	const eventType = "on_tag_change" as const;
	const settings = deps.getSettings();
	const workflows = deps.getDiscoveredWorkflows();

	const hooks = collectHooksAndWorkflows(
		settings.vault_event_hooks,
		workflows,
		eventType,
		"on-tag-change"
	);

	if (hooks.length === 0) return;

	const context: import("./vault-event-hook-engine").VaultEventHookContext = {
		hookEvent: eventType,
		timestamp: new Date().toISOString(),
		notePath: file.path,
		tagsAdded: diff.added,
		tagsRemoved: diff.removed,
	};

	deps.dispatch(hooks, context, null);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect enabled settings-configured hooks for the given event type,
 * followed by discovered workflows with the matching `notor-trigger` value,
 * sorted alphabetically by file path.
 *
 * Settings hooks are returned in their configured order. Workflow triggers
 * are appended in alphabetical order by `file_path` per contract.
 *
 * @param config       - Current vault event hook configuration.
 * @param workflows    - All discovered workflows.
 * @param eventType    - Settings-side event type key.
 * @param triggerValue - Frontmatter `notor-trigger` value for workflows.
 * @returns Combined ordered list of hooks and workflow triggers.
 */
function collectHooksAndWorkflows(
	config: VaultEventHookConfig,
	workflows: Workflow[],
	eventType: keyof VaultEventHookConfig,
	triggerValue: string
): Array<VaultEventHook | Workflow> {
	// Settings hooks in order (enabled only)
	const settingsHooks: VaultEventHook[] = config[eventType].filter(
		(h) => h.enabled
	);

	// Workflow triggers alphabetically by file path
	const workflowTriggers: Workflow[] = workflows
		.filter((w) => w.trigger === triggerValue)
		.sort((a, b) => a.file_path.localeCompare(b.file_path));

	return [...settingsHooks, ...workflowTriggers];
}

/**
 * Type guard: check if an `TAbstractFile` is a `TFile`.
 */
function isTFile(file: TAbstractFile): file is TFile {
	return "stat" in file && !("children" in file);
}
