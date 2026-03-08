/**
 * Lazy listener manager for vault event hooks.
 *
 * Implements the lazy per-hook-type listener activation/deactivation system
 * (FR-50a). Obsidian event listeners are only registered for event types that
 * have at least one configured hook or discovered workflow trigger. The manager
 * re-evaluates on settings save and workflow discovery completion, dynamically
 * registering/unregistering listeners.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-007
 * @see specs/03-workflows-personas/contracts/vault-event-hooks.md — §Listener-to-event mapping
 */

import type { EventRef, Plugin, TAbstractFile, TFile } from "obsidian";
import type { CachedMetadata } from "obsidian";
import type { NotorSettings } from "../settings";
import type { VaultEventHookType, Workflow } from "../types";
import { logger } from "../utils/logger";

const log = logger("VaultEventListenerManager");

// ---------------------------------------------------------------------------
// Handler callback types
// ---------------------------------------------------------------------------

/** Handler for `on_note_open` — receives the opened file (may be null). */
export type NoteOpenHandler = (file: TFile | null) => void;

/** Handler for `on_note_create` — receives the created abstract file. */
export type NoteCreateHandler = (file: TAbstractFile) => void;

/**
 * Handler for `on_save` / `on_manual_save` — receives the modified abstract
 * file. A single `vault.on('modify')` listener feeds both event types.
 */
export type ModifyHandler = (file: TAbstractFile) => void;

/** Handler for `on_tag_change` — receives the changed file, raw data, and parsed metadata. */
export type TagChangeHandler = (
	file: TFile,
	data: string,
	cache: CachedMetadata
) => void;

/**
 * Discriminated union of all handler types, keyed by vault event type.
 * `on_schedule` has no Obsidian event — it is managed by `VaultEventScheduler`.
 */
export type VaultEventHandler =
	| { type: "on_note_open"; handler: NoteOpenHandler }
	| { type: "on_note_create"; handler: NoteCreateHandler }
	| { type: "on_save"; handler: ModifyHandler }
	| { type: "on_manual_save"; handler: ModifyHandler }
	| { type: "on_tag_change"; handler: TagChangeHandler }
	| { type: "on_schedule"; handler: null }; // managed by scheduler

// ---------------------------------------------------------------------------
// VaultEventListenerManager
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of Obsidian event subscriptions for vault event hooks.
 *
 * Listeners are registered lazily — only when at least one enabled settings
 * hook OR at least one discovered workflow with a matching `notor-trigger`
 * exists for a given event type.
 *
 * `on_save` and `on_manual_save` share a single `vault.on('modify')` listener.
 * The modify handler internally dispatches to the correct per-event handlers.
 *
 * `on_schedule` is not managed here — cron timers are handled by
 * `VaultEventScheduler` which operates independently.
 */
export class VaultEventListenerManager {
	private readonly plugin: Plugin;
	private readonly getSettings: () => NotorSettings;
	private readonly getDiscoveredWorkflows: () => Workflow[];

	/**
	 * Currently registered Obsidian EventRef values, keyed by a logical
	 * listener name. We use a string key rather than VaultEventHookType
	 * because `on_save` and `on_manual_save` share one Obsidian listener
	 * registered under `"modify"`.
	 */
	private readonly activeListeners = new Map<string, EventRef>();

	/**
	 * Registered handler callbacks, keyed by VaultEventHookType.
	 * Populated by callers (individual listener implementations F-008..F-016)
	 * via `setEventHandler()`.
	 */
	private readonly handlers = new Map<VaultEventHookType, VaultEventHandler>();

	constructor(
		plugin: Plugin,
		getSettings: () => NotorSettings,
		getDiscoveredWorkflows: () => Workflow[]
	) {
		this.plugin = plugin;
		this.getSettings = getSettings;
		this.getDiscoveredWorkflows = getDiscoveredWorkflows;
	}

	// ---------------------------------------------------------------------------
	// Handler registration
	// ---------------------------------------------------------------------------

	/**
	 * Register the callback for a specific vault event type.
	 *
	 * Called by individual listener implementations (F-008..F-016) during
	 * plugin initialisation, before `evaluateListeners()` is called.
	 *
	 * @param eventType - The vault event type.
	 * @param handler   - The typed handler callback.
	 */
	setEventHandler(eventType: VaultEventHookType, handler: VaultEventHandler): void {
		this.handlers.set(eventType, handler);
		log.debug("Handler registered", { eventType });
	}

	// ---------------------------------------------------------------------------
	// Listener evaluation
	// ---------------------------------------------------------------------------

	/**
	 * Evaluate which Obsidian listeners should be active based on the current
	 * settings and discovered workflows.
	 *
	 * For each vault event type (excluding `on_schedule`), determines if at
	 * least one enabled settings hook OR one discovered workflow with a matching
	 * `notor-trigger` exists. Registers listeners that are needed but inactive;
	 * unregisters listeners that are active but no longer needed.
	 *
	 * Should be called:
	 * - After plugin layout is ready (initial evaluation)
	 * - After settings are saved
	 * - After workflow discovery completes
	 */
	evaluateListeners(): void {
		const settings = this.getSettings();
		const workflows = this.getDiscoveredWorkflows();

		log.debug("Evaluating vault event listeners");

		// Determine required Obsidian listener subscriptions.
		// on_save and on_manual_save share a single modify listener.
		const needsNoteOpen = this.hasActiveHooks(settings, workflows, "on_note_open");
		const needsNoteCreate = this.hasActiveHooks(settings, workflows, "on_note_create");
		const needsModify =
			this.hasActiveHooks(settings, workflows, "on_save") ||
			this.hasActiveHooks(settings, workflows, "on_manual_save");
		const needsTagChange = this.hasActiveHooks(settings, workflows, "on_tag_change");

		// Apply registrations / unregistrations
		this.applyListener("file-open", needsNoteOpen, () => this.registerNoteOpenListener());
		this.applyListener("create", needsNoteCreate, () => this.registerNoteCreateListener());
		this.applyListener("modify", needsModify, () => this.registerModifyListener());
		this.applyListener("metadata-changed", needsTagChange, () => this.registerTagChangeListener());
	}

	// ---------------------------------------------------------------------------
	// Cleanup
	// ---------------------------------------------------------------------------

	/**
	 * Unregister all active Obsidian event subscriptions.
	 *
	 * Called on plugin unload. The Obsidian `Plugin.registerEvent()` helper
	 * also cleans up on unload, but explicit teardown here ensures deterministic
	 * behaviour during plugin disable/enable cycles.
	 */
	destroy(): void {
		for (const [key, ref] of this.activeListeners) {
			this.unregisterRef(key, ref);
		}
		this.activeListeners.clear();
		log.debug("VaultEventListenerManager destroyed");
	}

	// ---------------------------------------------------------------------------
	// Private: registration helpers
	// ---------------------------------------------------------------------------

	/**
	 * Register or unregister a specific Obsidian listener as needed.
	 *
	 * @param key     - Logical listener key (Obsidian event name string).
	 * @param needed  - Whether the listener should be active.
	 * @param register - Factory function that registers the listener and returns
	 *   an EventRef. Only called when `needed` is true and not already active.
	 */
	private applyListener(
		key: string,
		needed: boolean,
		register: () => EventRef | null
	): void {
		const isActive = this.activeListeners.has(key);

		if (needed && !isActive) {
			const ref = register();
			if (ref) {
				this.activeListeners.set(key, ref);
				log.info("Vault event listener registered", { key });
			}
		} else if (!needed && isActive) {
			const ref = this.activeListeners.get(key)!;
			this.unregisterRef(key, ref);
			this.activeListeners.delete(key);
			log.info("Vault event listener unregistered", { key });
		}
	}

	/** Unregister a single EventRef from the appropriate Obsidian event source. */
	private unregisterRef(key: string, ref: EventRef): void {
		try {
			if (key === "file-open") {
				this.plugin.app.workspace.offref(ref);
			} else {
				// create, modify → vault; metadata-changed → metadataCache
				if (key === "metadata-changed") {
					this.plugin.app.metadataCache.offref(ref);
				} else {
					this.plugin.app.vault.offref(ref);
				}
			}
		} catch (e) {
			log.warn("Failed to unregister event ref", { key, error: String(e) });
		}
	}

	private registerNoteOpenListener(): EventRef | null {
		const handlerEntry = this.handlers.get("on_note_open");
		if (!handlerEntry || handlerEntry.type !== "on_note_open") {
			log.warn("No handler registered for on_note_open");
			return null;
		}
		const { handler } = handlerEntry;

		const ref = this.plugin.app.workspace.on(
			"file-open",
			(file: TFile | null) => {
				handler(file);
			}
		);
		this.plugin.registerEvent(ref);
		return ref;
	}

	private registerNoteCreateListener(): EventRef | null {
		const handlerEntry = this.handlers.get("on_note_create");
		if (!handlerEntry || handlerEntry.type !== "on_note_create") {
			log.warn("No handler registered for on_note_create");
			return null;
		}
		const { handler } = handlerEntry;

		const ref = this.plugin.app.vault.on(
			"create",
			(file: TAbstractFile) => {
				handler(file);
			}
		);
		this.plugin.registerEvent(ref);
		return ref;
	}

	private registerModifyListener(): EventRef | null {
		// on_save and on_manual_save share a single modify listener.
		// Both handlers are invoked from within the shared modify callback.
		const onSaveEntry = this.handlers.get("on_save");
		const onManualSaveEntry = this.handlers.get("on_manual_save");

		if (
			(!onSaveEntry || onSaveEntry.type !== "on_save") &&
			(!onManualSaveEntry || onManualSaveEntry.type !== "on_manual_save")
		) {
			log.warn("No handler registered for on_save or on_manual_save");
			return null;
		}

		const ref = this.plugin.app.vault.on(
			"modify",
			(file: TAbstractFile) => {
				// Dispatch to on_save handler
				if (onSaveEntry && onSaveEntry.type === "on_save") {
					onSaveEntry.handler(file);
				}
				// on_manual_save is handled internally by on_save handler
				// (handleModify calls handleManualSave when applicable)
			}
		);
		this.plugin.registerEvent(ref);
		return ref;
	}

	private registerTagChangeListener(): EventRef | null {
		const handlerEntry = this.handlers.get("on_tag_change");
		if (!handlerEntry || handlerEntry.type !== "on_tag_change") {
			log.warn("No handler registered for on_tag_change");
			return null;
		}
		const { handler } = handlerEntry;

		const ref = this.plugin.app.metadataCache.on(
			"changed",
			(file: TFile, data: string, cache: CachedMetadata) => {
				handler(file, data, cache);
			}
		);
		this.plugin.registerEvent(ref);
		return ref;
	}

	// ---------------------------------------------------------------------------
	// Private: active hook detection
	// ---------------------------------------------------------------------------

	/**
	 * Determine whether at least one enabled hook or workflow trigger exists
	 * for the given vault event type.
	 *
	 * Settings hooks: any `enabled: true` entry in `vault_event_hooks[event]`.
	 * Workflow triggers: any discovered workflow whose `trigger` maps to the
	 * event type per the trigger→event mapping table.
	 *
	 * @param settings  - Current plugin settings.
	 * @param workflows - Currently discovered workflows.
	 * @param event     - Vault event type to check.
	 */
	private hasActiveHooks(
		settings: NotorSettings,
		workflows: Workflow[],
		event: VaultEventHookType
	): boolean {
		// Check settings-configured hooks
		const settingsHooks = settings.vault_event_hooks[event];
		if (settingsHooks.some((h) => h.enabled)) {
			return true;
		}

		// Check discovered workflows with a matching notor-trigger
		const triggerValue = vaultEventTypeToWorkflowTrigger(event);
		if (triggerValue && workflows.some((w) => w.trigger === triggerValue)) {
			return true;
		}

		return false;
	}
}

// ---------------------------------------------------------------------------
// Trigger mapping
// ---------------------------------------------------------------------------

/**
 * Map a `VaultEventHookType` to the corresponding `WorkflowTrigger` string
 * used in workflow frontmatter.
 *
 * Returns `null` for `on_schedule` — scheduled workflows use the `"scheduled"`
 * trigger value but are managed by `VaultEventScheduler`, not this manager.
 */
function vaultEventTypeToWorkflowTrigger(
	event: VaultEventHookType
): string | null {
	switch (event) {
		case "on_note_open":
			return "on-note-open";
		case "on_note_create":
			return "on-note-create";
		case "on_save":
			return "on-save";
		case "on_manual_save":
			return "on-manual-save";
		case "on_tag_change":
			return "on-tag-change";
		case "on_schedule":
			// Managed by VaultEventScheduler, not this manager.
			return null;
		default:
			return null;
	}
}
