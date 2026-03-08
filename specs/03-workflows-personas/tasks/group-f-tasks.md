# Task Breakdown: Group F — Vault Event Hooks

**Created:** 2026-08-03
**Implementation Plan:** [specs/03-workflows-personas/plan.md](../plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](../spec.md)
**Contract:** [specs/03-workflows-personas/contracts/vault-event-hooks.md](../contracts/vault-event-hooks.md)
**Status:** Planning

## Task Summary

**Total Tasks:** 24
**Phases:** 7 (Types → Settings & Config → Event Listeners → Cron & Tag Detection → Hook Dispatch & Execution → Background Workflow Execution → Wiring & Validation)
**FRs Covered:** FR-47, FR-48, FR-48a, FR-48b, FR-49, FR-50, FR-50a, FR-51
**Estimated Complexity:** High
**Parallel Execution Opportunities:** 5 task groups

## Dependency Graph

```
F-001 (Vault event hook types & settings)
  │
  ├──▶ F-002 (VaultEventHookConfig CRUD helpers)
  │       │
  │       └──▶ F-003 (Vault event hooks settings UI)
  │               │
  │               └──▶ F-004 ("Run a workflow" action type — settings UI)
  │
  ├──▶ F-005 [P] (Debounce engine)
  │
  ├──▶ F-006 [P] (Execution chain tracker — loop prevention)
  │
  ├──▶ F-007 [P] (Lazy listener manager)
  │       │
  │       ├──▶ F-008 (on-note-open listener)
  │       │
  │       ├──▶ F-009 [P] (on-note-create listener)
  │       │
  │       ├──▶ F-010 [P] (on-save listener)
  │       │       │
  │       │       └──▶ F-011 (Manual save detector — command interception)
  │       │               │
  │       │               └──▶ F-012 (on-manual-save listener)
  │       │
  │       └──▶ F-013 [P] (on-schedule listener — croner integration)
  │
  ├──▶ F-014 [P] (Tag shadow cache)
  │       │
  │       └──▶ F-015 (Tag change suppression manager)
  │               │
  │               └──▶ F-016 (on-tag-change listener)
  │
  └──▶ F-017 [P] (Vault event hook environment variables)

F-005 + F-006 + F-008..F-013 + F-016 + F-017
  │
  └──▶ F-018 (Vault event hook dispatcher)
          │
          └──▶ F-019 ("Run a workflow" hook action executor)
                  │
                  └──▶ F-020 (Concurrency manager — WorkflowConcurrencyManager)
                          │
                          └──▶ F-021 (Background workflow execution pipeline)
                                  │
                                  └──▶ F-022 (Extend Phase 3 hooks with "run workflow" action)

F-022 ──▶ F-023 (main.ts wiring — connect all vault event hook components)
              │
              └──▶ F-024 (End-to-end validation & cleanup)
```

---

## Phase 0: Types & Settings Model

### F-001: Define vault event hook types and extend settings interface

**Description:** Add all vault event hook types, the `VaultEventHookConfig` settings structure, the `WorkflowExecution` state entity, and new settings fields required for Group F. This is the foundational type work that all subsequent Group F tasks depend on.

**Files:**
- `src/types.ts` — Add `VaultEventHook`, `VaultEventHookType`, `VaultEventHookConfig`, `WorkflowExecution`, `WorkflowExecutionStatus`, `ExecutionChain` interfaces
- `src/settings.ts` — Extend `NotorSettings` with `vault_event_hooks`, `vault_event_debounce_seconds`, `workflow_concurrency_limit`, `workflow_activity_indicator_count`; extend `Hook` interface with `action_type` and `workflow_path`; add to `DEFAULT_SETTINGS`

**Dependencies:** None (Group C and Group E types assumed available)

**Acceptance Criteria:**
- [ ] `VaultEventHookType` type defined: `"on_note_open" | "on_note_create" | "on_save" | "on_manual_save" | "on_tag_change" | "on_schedule"`
- [ ] `VaultEventHook` interface defined per data-model.md: `id` (string), `event` (VaultEventHookType), `action_type` (`"execute_command" | "run_workflow"`), `command` (string | null), `workflow_path` (string | null), `label` (string), `enabled` (boolean), `schedule` (string | null)
- [ ] `VaultEventHookConfig` interface defined: one `VaultEventHook[]` array per event type
- [ ] `WorkflowExecutionStatus` type defined: `"queued" | "running" | "waiting_approval" | "completed" | "errored" | "stopped"`
- [ ] `WorkflowExecution` interface defined per data-model.md: `id`, `workflow_path`, `workflow_name`, `conversation_id`, `trigger_event`, `trigger_source`, `status`, `started_at`, `completed_at`, `error_message`
- [ ] `ExecutionChain` interface defined: `sourceHooks` (Set<string>), `modifiedNotePaths` (Set<string>)
- [ ] `NotorSettings.vault_event_hooks` added with type `VaultEventHookConfig`, defaulting to empty arrays per event type
- [ ] `NotorSettings.vault_event_debounce_seconds` added as `number`, default `5`
- [ ] `NotorSettings.workflow_concurrency_limit` added as `number`, default `3`
- [ ] `NotorSettings.workflow_activity_indicator_count` added as `number`, default `5`
- [ ] Existing `Hook` interface in `src/settings.ts` extended with optional `action_type: "execute_command" | "run_workflow"` (default `"execute_command"`) and optional `workflow_path: string | null`
- [ ] All types exported from `src/types.ts`
- [ ] `DEFAULT_SETTINGS` updated with all new fields
- [ ] TypeScript compiles cleanly with `npm run build`

### F-002: VaultEventHookConfig CRUD helpers

**Description:** Implement CRUD operations for vault event hooks, mirroring the pattern established in `src/hooks/hook-config.ts` for LLM lifecycle hooks. Supports add, remove, reorder, toggle, and query operations grouped by vault event type.

**Files:**
- `src/hooks/vault-event-hook-config.ts` — New file

**Dependencies:** F-001

**Acceptance Criteria:**
- [ ] `addVaultEventHook(config, event, actionType, commandOrPath, label?, schedule?): VaultEventHook` — creates a new hook with UUID, appends to `config[event]`
- [ ] `removeVaultEventHook(config, hookId): boolean` — removes hook by ID across all event types
- [ ] `reorderVaultEventHooks(config, event, hookId, newIndex): boolean` — moves a hook within an event type's list
- [ ] `toggleVaultEventHook(config, hookId): boolean | null` — toggles enabled state
- [ ] `getEnabledVaultEventHooks(config, event): VaultEventHook[]` — returns ordered enabled hooks for an event type
- [ ] Validates `action_type`: `"execute_command"` requires non-empty `command`; `"run_workflow"` requires non-empty `workflow_path`
- [ ] For `on_schedule` event, validates that `schedule` is non-empty
- [ ] Functions are pure (mutate config in place, like Phase 3 `hook-config.ts` pattern)

## Phase 1: Settings UI

### F-003: Vault event hooks settings UI

**Description:** Add a "Vault event hooks" section to **Settings → Notor** with collapsible subsections per event type, following the same grouped UI pattern as the Phase 3 LLM interaction hooks section in `renderHooksSection()`. Each subsection lists configured hooks with enable/disable toggle, reorder, and delete controls. Initially supports only `"execute_command"` action type; F-004 extends with `"run_workflow"`.

**Files:**
- `src/settings.ts` — Add `renderVaultEventHooksSection()` method; call it from `display()`

**Dependencies:** F-002

**Acceptance Criteria:**
- [ ] A "Vault event hooks" section rendered in Settings below the existing "Hooks" section
- [ ] One collapsible `<details>` subsection per event type with descriptive titles: "On note open", "On note create", "On save", "On manual save" (with help text: "Desktop only — fires on Cmd+S / Ctrl+S; does not fire on mobile"), "On tag change", "On schedule"
- [ ] Each subsection lists configured hooks for that event type with: label/command display, enabled toggle, reorder (↑↓) buttons, remove button — matching Phase 3 hook UI pattern
- [ ] "Add hook" form per event type with: action type dropdown (`"execute_command"` initially), command text input, optional label text input, "Add" button
- [ ] For `on_schedule` hooks: additional "Cron expression" text input with live validation feedback via `CronPattern` constructor (from `croner`). Invalid expressions show error text below the input; valid expressions show next run time preview
- [ ] Settings changes call `await this.plugin.saveSettings()` and trigger listener re-evaluation (F-007)
- [ ] Debounce cooldown setting: a single numeric input for `vault_event_debounce_seconds` at the top of the section (shared across all debounced event types)
- [ ] Concurrency limit setting: numeric input for `workflow_concurrency_limit`
- [ ] Help text for `on-manual-save` noting it is desktop-only per R-2 findings

### F-004: "Run a workflow" action type in settings UI

**Description:** Extend the vault event hooks settings UI (F-003) and the Phase 3 LLM lifecycle hooks settings UI to support the "run a workflow" action type. When the user selects "Run a workflow", the command input is replaced with a workflow path input (vault-relative path under `{notor_dir}/workflows/`).

**Files:**
- `src/settings.ts` — Extend both `renderHooksSection()` and `renderVaultEventHooksSection()` with action type selector and conditional inputs

**Dependencies:** F-003, Group C (workflow discovery for path suggestions)

**Acceptance Criteria:**
- [ ] In both vault event hook and LLM lifecycle hook "Add hook" forms: action type dropdown with "Execute shell command" and "Run a workflow" options
- [ ] When "Execute shell command" is selected: command text input shown (existing behavior)
- [ ] When "Run a workflow" is selected: workflow path text input shown with placeholder `"daily/review.md"` (vault-relative path under `{notor_dir}/workflows/`). Optionally, a suggest dropdown listing discovered workflow paths.
- [ ] Existing hooks display their action type: shell icon for commands, workflow icon for "run workflow"
- [ ] Backward compatibility: existing Phase 3 hooks without `action_type` are treated as `"execute_command"` — no migration needed
- [ ] Invalid workflow paths (non-existent file) show a warning indicator in the hook list (non-blocking — does not prevent saving)

---

## Phase 2: Core Infrastructure

### F-005 [P]: Debounce engine

**Description:** Implement a per-event-type, per-note-path cooldown tracker that prevents the same hook from firing repeatedly for rapid successive events on the same note. Used by `on-note-open`, `on-save`, and `on-manual-save` listeners. Not used by `on-note-create`, `on-tag-change`, or `on-schedule` per the contract.

**Files:**
- `src/hooks/vault-event-debounce.ts` — New file

**Dependencies:** F-001 (types only)

**Acceptance Criteria:**
- [ ] `VaultEventDebounce` class exported with constructor accepting `cooldownMs: number`
- [ ] `shouldDebounce(eventType: string, notePath: string): boolean` — returns `true` if the same event+path was recorded within `cooldownMs`; otherwise records timestamp and returns `false`
- [ ] Uses nested `Map<string, Map<string, number>>` (event type → note path → timestamp)
- [ ] `startCleanup(registerInterval: (callback: () => void, ms: number) => number): void` — registers a periodic cleanup interval (every 60s) that prunes entries older than 2× cooldownMs
- [ ] `destroy(): void` — clears all internal state
- [ ] Cooldown can be updated at runtime (reads `cooldownMs` dynamically from settings if a getter is passed)

### F-006 [P]: Execution chain tracker — infinite loop prevention

**Description:** Implement the execution chain tracking mechanism that prevents infinite hook-to-workflow loops. Each workflow execution carries a `Set<string>` of source hook event types. When a tool call within the workflow would trigger a hook whose event type is already in the chain, the re-trigger is skipped with a notice.

**Files:**
- `src/hooks/execution-chain.ts` — New file

**Dependencies:** F-001 (types only)

**Acceptance Criteria:**
- [ ] `ExecutionChainTracker` class exported
- [ ] `createChain(sourceHookEvent: string): ExecutionChain` — creates a new chain with the initial source hook event
- [ ] `shouldSkipHook(chain: ExecutionChain | null, hookEvent: string): boolean` — returns `true` if `hookEvent` is already in `chain.sourceHooks`; returns `false` if chain is null (no chain context = not hook-triggered)
- [ ] `extendChain(chain: ExecutionChain, hookEvent: string): ExecutionChain` — returns a new chain with the additional hook event added to `sourceHooks`
- [ ] `suppressNotePath(chain: ExecutionChain, notePath: string): void` — adds a path to `modifiedNotePaths` for create-loop prevention
- [ ] `isNotePathSuppressed(chain: ExecutionChain | null, notePath: string): boolean` — checks if a note path is in the chain's suppressed set
- [ ] When a loop is detected, the caller surfaces `new Notice("Hook cycle detected; skipping '{hookEvent}' to prevent infinite loop.")`

### F-007 [P]: Lazy listener manager

**Description:** Implement the lazy per-hook-type listener activation/deactivation system (FR-50a). Obsidian event listeners are only registered for event types that have at least one configured hook or workflow trigger. The manager re-evaluates on settings save and workflow discovery completion, dynamically registering/unregistering listeners.

**Files:**
- `src/hooks/vault-event-listener-manager.ts` — New file

**Dependencies:** F-001 (types only)

**Acceptance Criteria:**
- [ ] `VaultEventListenerManager` class exported
- [ ] Constructor accepts `plugin: Plugin`, `settings: NotorSettings`, `getDiscoveredWorkflows: () => Workflow[]`
- [ ] `evaluateListeners(): void` — for each `VaultEventHookType`, determines if at least one enabled settings hook OR one discovered workflow with matching `notor-trigger` exists; registers/unregisters listeners accordingly
- [ ] `registerListener(eventType)` / `unregisterListener(eventType)` manage individual Obsidian event subscriptions via `plugin.registerEvent()` — each listener stored in a `Map<VaultEventHookType, EventRef>`
- [ ] Mapping from hook event types to Obsidian events per contract: `on_note_open` → `workspace.on('file-open')`, `on_note_create` → `vault.on('create')`, `on_save`/`on_manual_save` → `vault.on('modify')` (shared listener), `on_tag_change` → `metadataCache.on('changed')`, `on_schedule` → cron timer management
- [ ] When `on_save` OR `on_manual_save` have hooks, a single `vault.on('modify')` listener is registered (the modify handler dispatches to the correct hook type internally)
- [ ] `setEventHandler(eventType, handler)` — allows individual listener implementations (F-008..F-016) to register their handler callbacks
- [ ] `destroy(): void` — unregisters all active listeners; called on plugin unload
- [ ] Re-evaluation is triggered by: settings save, workflow discovery completion, plugin reload

### F-017 [P]: Vault event hook environment variables

**Description:** Implement the environment variable builder for vault event hook shell command actions. Extends the existing `buildHookEnv()` pattern from `src/hooks/hook-engine.ts` with vault-event-specific variables (`NOTOR_NOTE_PATH`, `NOTOR_TAGS_ADDED`, `NOTOR_TAGS_REMOVED`).

**Files:**
- `src/hooks/vault-event-hook-engine.ts` — New file

**Dependencies:** F-001 (types only)

**Acceptance Criteria:**
- [ ] `VaultEventHookContext` interface defined: `hookEvent` (string), `timestamp` (string — ISO 8601), `notePath` (string | null), `tagsAdded` (string[] | null), `tagsRemoved` (string[] | null)
- [ ] `buildVaultEventHookEnv(context: VaultEventHookContext): Record<string, string>` function exported
- [ ] Sets `NOTOR_HOOK_EVENT` to event name (e.g., `on_note_open`)
- [ ] Sets `NOTOR_TIMESTAMP` to UTC ISO 8601 timestamp
- [ ] Sets `NOTOR_NOTE_PATH` when `notePath` is non-null (note-related events)
- [ ] Sets `NOTOR_TAGS_ADDED` (comma-separated) and `NOTOR_TAGS_REMOVED` (comma-separated) when present (`on_tag_change` only)
- [ ] Does NOT include Phase 3 LLM-specific variables (`NOTOR_CONVERSATION_ID`, `NOTOR_TOOL_NAME`, etc.) per contract
- [ ] `executeVaultEventHook(hook: VaultEventHook, context: VaultEventHookContext, settings: NotorSettings, vaultRootPath: string): Promise<HookExecutionResult>` — executes a shell command hook using the shared `executeShellCommand()` infrastructure, with vault event env vars injected

## Phase 3: Event Listeners

### F-008: on-note-open listener

**Description:** Implement the `file-open` event handler for `on-note-open` hooks (FR-47). When a Markdown note is opened (activated) in the editor, collect matching hooks and dispatch them. Applies debounce per note path.

**Files:**
- `src/hooks/vault-event-handlers.ts` — New file; add `handleNoteOpen()` function

**Dependencies:** F-005 (debounce), F-007 (listener manager)

**Acceptance Criteria:**
- [ ] `handleNoteOpen(file: TFile | null, deps: VaultEventHandlerDeps): void` function exported
- [ ] Skips if `file` is null or not a Markdown file (`.md` extension)
- [ ] Calls `debounce.shouldDebounce("on_note_open", file.path)` — skips if debounced
- [ ] Collects matching hooks: settings-configured `on_note_open` hooks (in order) + discovered workflows with `notor-trigger: on-note-open` (alphabetical by path)
- [ ] Dispatches hooks via the vault event hook dispatcher (F-018) — non-blocking (fire-and-forget)
- [ ] Passes `notePath: file.path` as context for env vars and trigger context
- [ ] Registered via listener manager's `setEventHandler("on_note_open", handleNoteOpen)`

### F-009 [P]: on-note-create listener

**Description:** Implement the `create` event handler for `on-note-create` hooks (FR-48a). When a new Markdown file is created, dispatch hooks. Includes loop prevention — notes created by hook-initiated workflows don't re-trigger.

**Files:**
- `src/hooks/vault-event-handlers.ts` — Add `handleNoteCreate()` function

**Dependencies:** F-006 (execution chain), F-007 (listener manager)

**Acceptance Criteria:**
- [ ] `handleNoteCreate(file: TAbstractFile, deps: VaultEventHandlerDeps): void` function exported
- [ ] Skips if file is not a `TFile` or not `.md`
- [ ] Checks execution chain: if `isNotePathSuppressed(activeChain, file.path)` → skip (note created by hook workflow)
- [ ] No debounce applied (`on-note-create` fires once per file per contract)
- [ ] Collects matching hooks + workflow triggers for `on_note_create`
- [ ] Dispatches hooks non-blocking with `notePath: file.path`
- [ ] Fires after the file has been created in the vault (Obsidian's `create` event guarantees this)

### F-010 [P]: on-save listener

**Description:** Implement the `modify` event handler for `on-save` hooks (FR-48). When a note is saved (manual or auto-save), dispatch hooks. Applies debounce per note path. This handler is shared with `on-manual-save` (F-012) — a single `vault.on('modify')` listener dispatches to both.

**Files:**
- `src/hooks/vault-event-handlers.ts` — Add `handleModify()` function

**Dependencies:** F-005 (debounce), F-007 (listener manager)

**Acceptance Criteria:**
- [ ] `handleModify(file: TAbstractFile, deps: VaultEventHandlerDeps): void` function exported
- [ ] Skips if file is not a `TFile` or not `.md`
- [ ] For `on_save` hooks: calls `debounce.shouldDebounce("on_save", file.path)` — skips if debounced
- [ ] Collects enabled `on_save` hooks + workflow triggers and dispatches non-blocking
- [ ] Also calls `handleManualSave()` (F-012) if the manual save detector indicates this was a manual save
- [ ] Passes `notePath: file.path` as context
- [ ] Fires after the save operation is complete (file written to disk)

### F-011: Manual save detector — command interception

**Description:** Implement the `editor:save-file` command interception mechanism to distinguish manual saves from auto-saves (FR-48b). Monkey-patches `app.commands.executeCommandById` to set a short-lived flag when the save command is executed. Based on R-2 research findings.

**Files:**
- `src/hooks/manual-save-detector.ts` — New file

**Dependencies:** F-010

**Acceptance Criteria:**
- [ ] `ManualSaveDetector` class exported
- [ ] `install(app: App): () => void` — patches `app.commands.executeCommandById` to intercept `"editor:save-file"`. When intercepted, records `{ notePath: activeFilePath, timestamp: Date.now() }` in an internal `Map<string, number>`. Returns an uninstall function that restores the original method.
- [ ] Defensive check: `typeof (app as any).commands?.executeCommandById === "function"` — if unavailable, logs warning and returns a no-op uninstall function (graceful degradation per R-2)
- [ ] `isManualSave(notePath: string): boolean` — checks if the note path has a recent manual-save flag within 500 ms window. Consumes (deletes) the flag on match (one-shot per R-2). Returns `false` if no flag or flag expired.
- [ ] `startCleanup(registerInterval): void` — registers periodic cleanup (every 60s) to prune unconsumed flags older than 1000 ms (2× the 500 ms window)
- [ ] `destroy(): void` — calls uninstall function, clears all flags
- [ ] Active file path read via `app.workspace.getActiveViewOfType(MarkdownView)?.file?.path`
- [ ] Desktop-only: `Platform.isDesktopApp` guard. On mobile, `install()` is a no-op and `isManualSave()` always returns `false`.

### F-012: on-manual-save listener

**Description:** Implement the manual save handler that fires `on-manual-save` hooks only when a save was initiated by the user (FR-48b). Called from the shared `handleModify()` function (F-010) when the manual save detector confirms a manual save.

**Files:**
- `src/hooks/vault-event-handlers.ts` — Add `handleManualSave()` function

**Dependencies:** F-011 (manual save detector)

**Acceptance Criteria:**
- [ ] `handleManualSave(file: TFile, deps: VaultEventHandlerDeps): void` function exported
- [ ] Called by `handleModify()` only when `manualSaveDetector.isManualSave(file.path)` returns `true`
- [ ] Applies debounce: `debounce.shouldDebounce("on_manual_save", file.path)` — skips if debounced
- [ ] Collects enabled `on_manual_save` hooks + workflow triggers and dispatches non-blocking
- [ ] Passes `notePath: file.path` as context
- [ ] Fires after the save operation is complete (same timing as `on-save`)

### F-013 [P]: on-schedule listener — croner integration

**Description:** Implement the cron-based scheduler for `on-schedule` hooks (FR-50) using `croner` v10.x. Manages cron jobs dynamically — creating, pausing, resuming, and stopping jobs based on hook configuration. Per R-1 research findings.

**Files:**
- `src/hooks/vault-event-scheduler.ts` — New file

**Dependencies:** F-007 (listener manager)

**Acceptance Criteria:**
- [ ] `VaultEventScheduler` class exported
- [ ] `npm install croner` added as a dependency (run during implementation)
- [ ] `syncJobs(hooks: VaultEventHook[]): void` — takes the current list of enabled `on_schedule` hooks, creates new `Cron` jobs for newly added hooks, stops jobs for removed hooks, leaves unchanged hooks running
- [ ] Each cron job created with `new Cron(schedule, { paused: false }, handler)` per R-1 API findings
- [ ] Job handler calls the vault event hook dispatcher (F-018) with event type `on_schedule` and no note path context
- [ ] `validateCronExpression(expr: string): { valid: boolean; error?: string }` — wraps `new CronPattern(expr)` in try/catch per R-1 findings; exported for settings UI validation (F-003)
- [ ] `getNextRun(expr: string): Date | null` — creates a temporary `Cron` and calls `nextRun()` for preview in settings UI
- [ ] `destroy(): void` — calls `.stop()` on all active jobs; clears internal job map
- [ ] Jobs are stored in `Map<string, Cron>` keyed by hook ID for individual management
- [ ] If Obsidian is not running at scheduled time, execution is skipped (no catch-up — inherent behavior of in-process cron)
- [ ] Default timezone: local system time (no `timezone` option per R-1 recommendation)

## Phase 4: Tag Change Detection

### F-014 [P]: Tag shadow cache

**Description:** Implement the shadow cache (`Map<string, Set<string>>`) that maintains per-note normalized tag state for diff computation. Eagerly initialized at plugin load via `workspace.onLayoutReady()`. Maintained by `vault.on('delete')` and `vault.on('rename')` lifecycle handlers. Based on R-3 research findings.

**Files:**
- `src/hooks/tag-change-detector.ts` — New file

**Dependencies:** F-001 (types only)

**Acceptance Criteria:**
- [ ] `TagShadowCache` class exported
- [ ] `initialize(app: App): void` — iterates all Markdown files via `vault.getMarkdownFiles()`, reads tags from `metadataCache.getFileCache(file)?.frontmatter` via `parseFrontMatterTags()`, normalizes (strip `#`, trim, lowercase), stores in `Map<string, Set<string>>`
- [ ] Initialization is synchronous in-memory reads only (no disk I/O — reads from Obsidian's metadata cache). Target: <50 ms for 10,000 notes per R-3 findings
- [ ] `getTags(notePath: string): Set<string>` — returns the shadow cache entry for a note (empty Set if not present)
- [ ] `updateTags(notePath: string, newTags: Set<string>): void` — replaces the cache entry
- [ ] `removePath(notePath: string): void` — called on file delete
- [ ] `renamePath(oldPath: string, newPath: string): void` — called on file rename (moves entry)
- [ ] `computeDiff(notePath: string, newTags: Set<string>): { added: string[]; removed: string[] }` — compares shadow cache entry against new tags using Set-based diff. Returns empty diff if no change. Tags reported in original case (from new tags), compared in lowercase.
- [ ] Tag normalization: strip leading `#` (from `parseFrontMatterTags`), trim whitespace, lowercase for comparison. Original case preserved for reporting per R-3.
- [ ] Uses `parseFrontMatterTags()` (NOT `getAllTags()`) to extract frontmatter-only tags per R-3 rationale
- [ ] Registers `vault.on('delete')` and `vault.on('rename')` handlers for cache maintenance

### F-015: Tag change suppression manager

**Description:** Implement the `TagChangeSuppressionManager` — a two-phase consume-on-event mechanism that prevents `on-tag-change` hooks from re-firing when Notor's own tools (`manage_tags`, `update_frontmatter`) modify tags within a hook-initiated workflow. Per R-3 research.

**Files:**
- `src/hooks/tag-change-detector.ts` — Add `TagChangeSuppressionManager` class

**Dependencies:** F-014

**Acceptance Criteria:**
- [ ] `TagChangeSuppressionManager` class exported
- [ ] `suppress(notePath: string): void` — records the note path with a `Date.now()` timestamp in an internal `Map<string, number>`
- [ ] `checkAndConsume(notePath: string): boolean` — checks if the path has an active suppression within 2000 ms window. If yes, deletes the entry and returns `true` (suppressed). Otherwise returns `false`.
- [ ] `startCleanup(registerInterval): void` — registers periodic cleanup (every 30s) that prunes entries older than 2 seconds
- [ ] `destroy(): void` — clears all state
- [ ] Integration point: when `manage_tags` or `update_frontmatter` is called within a hook-initiated workflow, the tool dispatcher calls `suppress(notePath)` before the tool executes
- [ ] The shadow cache is still updated on suppressed events (to keep it accurate) — only hook dispatch is skipped

### F-016: on-tag-change listener

**Description:** Implement the `metadataCache.on('changed')` event handler for `on-tag-change` hooks (FR-49). Extracts new frontmatter tags, diffs against the shadow cache, updates the cache, checks suppression, and dispatches hooks with tag diff context.

**Files:**
- `src/hooks/vault-event-handlers.ts` — Add `handleMetadataChanged()` function

**Dependencies:** F-014, F-015

**Acceptance Criteria:**
- [ ] `handleMetadataChanged(file: TFile, data: string, cache: CachedMetadata, deps: VaultEventHandlerDeps): void` function exported
- [ ] Extracts new tags via `parseFrontMatterTags(cache.frontmatter)` — frontmatter only per R-3
- [ ] Normalizes new tags (strip `#`, trim, lowercase for comparison)
- [ ] Calls `shadowCache.computeDiff(file.path, normalizedNewTags)` to get `added` / `removed` arrays
- [ ] Updates shadow cache with new tags regardless of suppression (step 4d per R-3: keep cache accurate)
- [ ] If diff is empty (no tag change) → return early (non-tag metadata change)
- [ ] If `suppression.checkAndConsume(file.path)` returns `true` → return early (suppress hook dispatch)
- [ ] Collects enabled `on_tag_change` hooks + workflow triggers
- [ ] Dispatches hooks non-blocking with context: `notePath: file.path`, `tagsAdded: added`, `tagsRemoved: removed`
- [ ] No debounce applied (tag changes are discrete; shadow cache diff handles deduplication per R-3)

## Phase 5: Hook Dispatch & Background Execution

### F-018: Vault event hook dispatcher

**Description:** Implement the central dispatcher that receives collected hooks and event context from individual listeners and executes them sequentially. For `execute_command` actions, uses the vault event hook engine (F-017). For `run_workflow` actions, delegates to the workflow action executor (F-019). Integrates with the execution chain tracker (F-006) for loop prevention.

**Files:**
- `src/hooks/vault-event-dispatcher.ts` — New file

**Dependencies:** F-005, F-006, F-017, all listener tasks (F-008..F-016)

**Acceptance Criteria:**
- [ ] `dispatchVaultEventHooks(hooks: Array<VaultEventHook | Workflow>, context: VaultEventHookContext, chain: ExecutionChain | null, deps: DispatcherDeps): void` function exported
- [ ] Executes hooks sequentially in the provided order (settings hooks first, then workflow triggers alphabetically per contract)
- [ ] For each hook, checks execution chain: `if shouldSkipHook(chain, context.hookEvent)` → skip with loop notice
- [ ] For `execute_command` action: calls `executeVaultEventHook()` from F-017. Subject to global hook timeout. Non-blocking: failures surface a notice but do not prevent subsequent hooks.
- [ ] For `run_workflow` action: calls the workflow action executor (F-019). NOT subject to hook timeout — workflow runs its full lifecycle.
- [ ] For workflow triggers (discovered workflows with matching `notor-trigger`): treated same as `run_workflow` action — assembles and executes the workflow
- [ ] Single-instance guard per contract: if a workflow is already running, skip with `new Notice("Workflow '{name}' already running; skipped.")`
- [ ] Fire-and-forget: the entire dispatch is non-blocking — listeners do not await completion
- [ ] Passes `Platform.isDesktopApp` guard for shell command actions

### F-019: "Run a workflow" hook action executor

**Description:** Implement the executor for the "run a workflow" hook action (FR-51). Resolves the workflow by path, assembles the prompt with trigger context, and delegates to the background workflow execution pipeline (F-021). Used by both vault event hooks and Phase 3 LLM lifecycle hooks.

**Files:**
- `src/hooks/vault-event-dispatcher.ts` — Add `executeRunWorkflowAction()` function

**Dependencies:** F-018, Group E (`assembleWorkflowPrompt` from E-006)

**Acceptance Criteria:**
- [ ] `executeRunWorkflowAction(workflowPath: string, context: VaultEventHookContext, chain: ExecutionChain | null, deps: DispatcherDeps): Promise<void>` function exported
- [ ] Resolves workflow by vault-relative path via workflow discovery results or `vault.getAbstractFileByPath()`
- [ ] If workflow not found or invalid (missing `notor-workflow: true`) → `new Notice("Workflow '{path}' not found.")` and return
- [ ] Builds `TriggerContext` from event context: `event`, `note_path`, `tags_added`, `tags_removed`
- [ ] Creates `WorkflowExecutionRequest` with the resolved workflow, null supplementary text, and the trigger context
- [ ] Calls `assembleWorkflowPrompt()` (from Group E) to build the user message with `<trigger_context>` + `<workflow_instructions>` blocks
- [ ] If assembly returns null (empty workflow) → notice and return
- [ ] Delegates to `WorkflowConcurrencyManager.submit()` (F-020) for background execution
- [ ] Applies persona switching if workflow has `notor-workflow-persona` (via Group E's `switchWorkflowPersona()`)
- [ ] Extends execution chain with current hook event before passing to the workflow execution

### F-020: Workflow concurrency manager

**Description:** Implement the global concurrency limiter for background (event-triggered) workflow executions. Manages a bounded pool of active executions with FIFO queue for overflow. Tracks `WorkflowExecution` state for the activity indicator (Group H).

**Files:**
- `src/workflows/workflow-concurrency.ts` — New file

**Dependencies:** F-019

**Acceptance Criteria:**
- [ ] `WorkflowConcurrencyManager` class exported
- [ ] Constructor accepts `limit: number` (from `settings.workflow_concurrency_limit`, default 3)
- [ ] `submit(execution: WorkflowExecution, runFn: () => Promise<void>): void` — if active count < limit, starts immediately (status → `running`); otherwise queues (status → `queued`). FIFO queue for overflow.
- [ ] `onComplete(executionId: string, status: WorkflowExecutionStatus, error?: string): void` — marks execution complete, updates `completed_at` and `error_message`; starts next queued execution if any
- [ ] Single-instance guard: `isWorkflowRunning(workflowPath: string): boolean` — checks if the same workflow is already active or queued. Returns `true` → caller skips with notice.
- [ ] `getActiveExecutions(): WorkflowExecution[]` — returns currently running/waiting executions (for activity indicator)
- [ ] `getRecentExecutions(n: number): WorkflowExecution[]` — returns the N most recent completed + active executions sorted by recency (for activity indicator dropdown)
- [ ] `updateStatus(executionId: string, status: WorkflowExecutionStatus): void` — updates status (e.g., `running` → `waiting_approval`)
- [ ] State is in-memory only — lost on plugin reload (acceptable per plan.md)
- [ ] Manually triggered workflows are NOT submitted through this manager — they run in the foreground per FR-45
- [ ] `destroy(): void` — clears all state

### F-021: Background workflow execution pipeline

**Description:** Implement the full background workflow execution flow: create a background conversation, send the assembled prompt, and run the LLM response loop without taking over the main chat panel. Event-triggered workflows execute silently; completion/failure surfaces a non-blocking notice. The conversation is accessible via the activity indicator (Group H).

**Files:**
- `src/chat/orchestrator.ts` — Add `executeBackgroundWorkflow()` method

**Dependencies:** F-020, Group E (`executeWorkflow` pipeline from E-013)

**Acceptance Criteria:**
- [ ] `ChatOrchestrator.executeBackgroundWorkflow(request: WorkflowExecutionRequest, execution: WorkflowExecution, chain: ExecutionChain): Promise<void>` method added
- [ ] Creates a new background conversation via `ConversationManager.createConversation()` with `is_background: true`, workflow metadata, and the active persona name
- [ ] Does NOT reveal the chat panel or switch the user's active conversation — runs silently in background
- [ ] Sends the assembled prompt as the first user message with `is_workflow_message: true`
- [ ] Dispatches to the LLM via a dedicated `responseLoop()` that runs independently of the main chat panel's response loop
- [ ] When a tool call requires approval: updates `WorkflowExecution.status` to `"waiting_approval"` via concurrency manager. The activity indicator (Group H) shows "Waiting for approval" status. User clicks into the conversation to approve/reject.
- [ ] On completion: updates status to `"completed"`, surfaces `new Notice("Workflow '{name}' completed.")`
- [ ] On error: updates status to `"errored"` with `error_message`, surfaces `new Notice("Workflow '{name}' failed: {error}")`
- [ ] On user stop: updates status to `"stopped"`
- [ ] Persona revert is scoped to the background conversation — does not affect main chat panel persona
- [ ] Execution chain is passed to the background response loop for loop prevention during tool calls
- [ ] The `_suppressNoteCreateHooks` and tag change suppression are wired for tool calls within the background workflow

### F-022: Extend Phase 3 LLM lifecycle hooks with "run workflow" action

**Description:** Extend the Phase 3 hook dispatching system (`src/hooks/hook-events.ts` and `src/hooks/hook-engine.ts`) to handle the new `"run_workflow"` action type alongside the existing `"execute_command"`. When a lifecycle hook has `action_type: "run_workflow"`, the hook engine delegates to the workflow action executor instead of spawning a shell command.

**Files:**
- `src/hooks/hook-events.ts` — Extend all four dispatch functions to check `hook.action_type`
- `src/hooks/hook-engine.ts` — Add `action_type` routing logic

**Dependencies:** F-019, F-021

**Acceptance Criteria:**
- [ ] In `dispatchPreSend()`, `dispatchOnToolCall()`, `dispatchOnToolResult()`, `dispatchAfterCompletion()`: for each hook, check `hook.action_type ?? "execute_command"`
- [ ] If `"execute_command"`: existing behavior (call `executeHook()`) — unchanged
- [ ] If `"run_workflow"`: call `executeRunWorkflowAction()` with the hook's `workflow_path` and appropriate context. For lifecycle hooks, trigger context includes `conversationId` and `hookEvent` but no note path.
- [ ] `pre_send` hooks with `"run_workflow"` action: the workflow runs fire-and-forget (stdout capture is not applicable to workflow actions). No stdout is returned.
- [ ] `"run_workflow"` actions are NOT subject to the global hook timeout (per FR-51) — timeout applies only to shell commands
- [ ] Backward-compatible: hooks without `action_type` field default to `"execute_command"`
- [ ] Hooks with `action_type: "run_workflow"` and missing/invalid `workflow_path` are skipped with a notice

## Phase 6: Wiring & Validation

### F-023: main.ts wiring — connect all vault event hook components

**Description:** Wire all Group F components into the plugin lifecycle in `src/main.ts`. Initialize the tag shadow cache, manual save detector, debounce engine, execution chain tracker, scheduler, listener manager, and dispatcher during `onload()`. Tear down everything during `onunload()`. Connect settings save events to listener re-evaluation.

**Files:**
- `src/main.ts` — Add initialization and teardown for all Group F components

**Dependencies:** F-001 through F-022

**Acceptance Criteria:**
- [ ] In `onload()`, initialize in order: (1) `TagShadowCache` with deferred `initialize()` via `workspace.onLayoutReady()`, (2) `VaultEventDebounce` with cooldown from settings, (3) `ExecutionChainTracker`, (4) `ManualSaveDetector` with `install()`, (5) `TagChangeSuppressionManager`, (6) `VaultEventScheduler`, (7) `VaultEventListenerManager` with handler registrations for all event types, (8) call `evaluateListeners()` after layout ready
- [ ] All periodic cleanups registered via `this.registerInterval()` for proper Obsidian lifecycle management
- [ ] `VaultEventHandlerDeps` dependency object assembled and passed to all handler registrations — includes references to debounce, execution chain tracker, manual save detector, tag shadow cache, tag suppression manager, dispatcher, settings getter
- [ ] On settings save: call `listenerManager.evaluateListeners()` and `scheduler.syncJobs(enabledScheduleHooks)`
- [ ] On workflow discovery completion: call `listenerManager.evaluateListeners()`
- [ ] In `onunload()`: call `destroy()` on all Group F components — listener manager, scheduler, manual save detector, debounce engine, tag shadow cache, tag suppression manager
- [ ] `ManualSaveDetector.install()` uninstall function stored and called on unload
- [ ] No heavy synchronous work in `onload()` — shadow cache init deferred to `onLayoutReady()`
- [ ] TypeScript compiles cleanly with `npm run build`
- [ ] Plugin loads and unloads without errors in Obsidian console

### F-024: Playwright E2E validation & cleanup

**Description:** Validate the complete vault event hook system end-to-end across all six event types via a Playwright E2E test script (`e2e/scripts/vault-event-hooks-test.ts`). The test launches Obsidian via CDP, configures vault event hooks via the Settings UI, triggers vault events programmatically (opening notes, creating files, saving, tag changes), and verifies correct dispatch, shell command execution, workflow triggering, concurrency management, loop prevention, and proper cleanup via structured logs and DOM assertions. Extend the existing `e2e/scripts/hook-execution-test.ts` with vault event hook scenarios where appropriate.

**Files:**
- `e2e/scripts/vault-event-hooks-test.ts` — New Playwright E2E test script
- `e2e/scripts/hook-execution-test.ts` — Extend with vault event hook test scenarios (if applicable)
- All Group F files — integration testing and bug fixes

**Dependencies:** F-023

**Acceptance Criteria:**
- [ ] **E2E test script created:** `e2e/scripts/vault-event-hooks-test.ts` follows the established pattern (build → launch Obsidian → connect Playwright via CDP → `LogCollector` → DOM assertions → structured log verification → screenshots → results JSON)
- [ ] **on-note-open (E2E):** Test opens a note via `app.workspace` command → structured logs confirm `on_note_open` hook dispatched with correct `NOTOR_NOTE_PATH`; rapid re-opens within debounce window → structured logs confirm second dispatch skipped
- [ ] **on-note-create (E2E):** Test creates a new note via vault API → structured logs confirm `on_note_create` hook dispatched; notes created by hook-initiated workflows → structured logs confirm loop prevention (re-trigger skipped with chain notice)
- [ ] **on-save (E2E):** Test modifies and saves a note → structured logs confirm `on_save` hook dispatched with debounce; rapid saves → second dispatch debounced
- [ ] **on-manual-save (E2E):** Test triggers Cmd+S keyboard shortcut via Playwright → structured logs confirm `on_manual_save` hook dispatched; auto-save → structured logs confirm `on_manual_save` NOT dispatched (only `on_save`); desktop-only guard verified via `Platform.isDesktopApp` log
- [ ] **on-tag-change (E2E):** Test modifies frontmatter tags on a note → structured logs confirm `on_tag_change` hook dispatched with correct `NOTOR_TAGS_ADDED` / `NOTOR_TAGS_REMOVED` data fields; tag changes from Notor tools within hook workflows → structured logs confirm suppression (dispatch skipped)
- [ ] **on-schedule (E2E):** Test configures a cron hook with a short interval (e.g., `* * * * *`) → waits for one trigger cycle → structured logs confirm `on_schedule` hook dispatched; settings UI renders cron validation feedback and next-run preview *(Note: may require extended wait time or fast cron expression)*
- [ ] **"Run a workflow" action (E2E):** Test configures a vault event hook with `action_type: "run_workflow"` → triggers the event → structured logs confirm workflow execution pipeline invoked; background conversation created; completion notice surfaced
- [ ] **Concurrency (E2E):** Test triggers >3 simultaneous workflow executions → structured logs confirm queuing behavior (FIFO); single-instance guard → structured logs confirm duplicate workflow skipped with notice
- [ ] **Loop prevention (E2E):** Test configures an `on-save` hook that triggers a workflow which writes a note → structured logs confirm the save from the workflow does NOT re-trigger the `on-save` hook (execution chain blocks re-entry)
- [ ] **Settings UI (E2E):** DOM assertions verify all six event type subsections render; add/remove/toggle/reorder operations work via DOM interactions; cron expression input shows validation feedback; action type dropdown switches between "Execute shell command" and "Run a workflow"
- [ ] **Lazy listeners (E2E):** Test disables all hooks for an event type → structured logs confirm listener unregistered; re-enables → structured logs confirm listener registered
- [ ] **Plugin unload (E2E):** Test disables/enables plugin → no error-level structured logs; structured logs confirm all listeners, intervals, cron jobs cleaned up on disable
- [ ] **Backward compatibility (E2E):** Existing Phase 3 hooks without `action_type` → structured logs confirm continued execution as `"execute_command"`

---

## Cross-Reference: Files Created & Modified

| File | Status | Tasks |
|------|--------|-------|
| `src/types.ts` | Modified | F-001 |
| `src/settings.ts` | Modified | F-001, F-003, F-004 |
| `src/hooks/vault-event-hook-config.ts` | **New** | F-002 |
| `src/hooks/vault-event-debounce.ts` | **New** | F-005 |
| `src/hooks/execution-chain.ts` | **New** | F-006 |
| `src/hooks/vault-event-listener-manager.ts` | **New** | F-007 |
| `src/hooks/vault-event-handlers.ts` | **New** | F-008, F-009, F-010, F-012, F-016 |
| `src/hooks/manual-save-detector.ts` | **New** | F-011 |
| `src/hooks/vault-event-scheduler.ts` | **New** | F-013 |
| `src/hooks/tag-change-detector.ts` | **New** | F-014, F-015 |
| `src/hooks/vault-event-hook-engine.ts` | **New** | F-017 |
| `src/hooks/vault-event-dispatcher.ts` | **New** | F-018, F-019 |
| `src/hooks/hook-events.ts` | Modified | F-022 |
| `src/hooks/hook-engine.ts` | Modified | F-022 |
| `src/workflows/workflow-concurrency.ts` | **New** | F-020 |
| `src/chat/orchestrator.ts` | Modified | F-021 |
| `src/main.ts` | Modified | F-023 |
| `e2e/scripts/vault-event-hooks-test.ts` | **New** | F-024 |

## Parallel Execution Opportunities

The following task groups can be implemented in parallel within their phase:

| Group | Tasks | Rationale |
|-------|-------|-----------|
| **Phase 2 infra** | F-005, F-006, F-007, F-017 | All depend only on F-001 types; no interdependencies |
| **Phase 3 listeners** | F-008, F-009, F-010, F-013 | Independent event handlers; all depend on F-007 but not on each other |
| **Phase 4 tag** | F-014 can start in parallel with Phase 3 listeners | Tag shadow cache depends only on F-001 types |
| **Settings UI** | F-003 can start once F-002 is done; F-004 can start once F-003 is done | Sequential within phase but overlaps with Phase 2 |
| **Phase 5 dispatch** | F-018 → F-019 → F-020 → F-021 → F-022 | Strictly sequential chain |

**Recommended implementation order for maximum parallelism:**

```
Sprint 1:  F-001
Sprint 2:  F-002 | F-005 | F-006 | F-007 | F-014 | F-017
Sprint 3:  F-003 | F-008 | F-009 | F-010 | F-013 | F-015
Sprint 4:  F-004 | F-011 | F-016
Sprint 5:  F-012 | F-018
Sprint 6:  F-019
Sprint 7:  F-020 → F-021
Sprint 8:  F-022
Sprint 9:  F-023 → F-024
```

## Design Decisions

| Decision | Rationale | Reference |
|----------|-----------|-----------|
| **Lazy listener activation** (FR-50a) | Avoid registering Obsidian event listeners when no hooks are configured for that event type. Reduces overhead for users who only use a subset of hook types. | Contract §Listener-to-event mapping |
| **Shared `vault.on('modify')` listener** for on-save + on-manual-save | Obsidian has no separate "manual save" event. A single modify listener handles both, with the manual save detector distinguishing the two. Avoids duplicate listener registration. | R-2 research |
| **Monkey-patch `executeCommandById`** for manual save detection | Only reliable cross-platform approach found in R-2 research. Hotkey monitoring doesn't cover menu/command palette saves. Defensive guard ensures graceful degradation if API changes. | R-2 research §Approach A |
| **`parseFrontMatterTags()` over `getAllTags()`** for tag change detection | `getAllTags()` includes inline tags which would create false-positive diffs when body text changes. Frontmatter tags are the canonical tag source and are what users typically manage via Notor tools. | R-3 research §Tag extraction |
| **Shadow cache for tag diff** | `metadataCache.on('changed')` does not provide before/after tag state. A shadow cache is the only way to compute diffs without re-reading the file. In-memory cost is minimal (~2 bytes per tag per note). | R-3 research §Shadow cache |
| **Tag change suppression** (2-phase consume-on-event) | When Notor's own tools modify tags within a workflow, the resulting `metadataCache.on('changed')` event must not re-trigger `on-tag-change` hooks. A time-windowed suppression flag is the simplest approach that handles async metadata cache updates. | R-3 research §Suppression |
| **`croner` v10.x** for cron scheduling | Lightweight (pure JS, no native deps), supports standard 5-field cron, ESM-compatible, actively maintained. `node-cron` lacks ESM support; `cron` package is heavier. | R-1 research |
| **In-memory execution state** (no persistence) | Background workflow execution state is transient — lost on plugin reload. Acceptable because: (a) workflows are short-lived, (b) persistence adds complexity with minimal benefit, (c) users can re-trigger manually if needed. | Plan §F-13 |
| **Single-instance guard per workflow** | Prevents accidental duplicate execution of the same workflow (e.g., rapid saves triggering the same on-save workflow). A simple Map check is sufficient. | Contract §Concurrency |
| **Execution chain for loop prevention** | Instead of complex graph analysis, a simple Set of source hook event types carried through the execution chain is sufficient to detect direct cycles (hook A → workflow → triggers hook A). Transitive cycles are handled by the same mechanism. | Contract §Loop prevention |
| **Fire-and-forget dispatch** | Vault event listeners do not await hook completion. This prevents slow hooks from blocking the Obsidian UI thread. Failures surface via `Notice` but do not cascade. | Contract §Execution semantics |
| **Concurrency limit of 3** (default) | Balances resource usage with responsiveness. Three concurrent background workflows is sufficient for typical usage (e.g., on-save + on-tag-change + scheduled). Configurable via settings. | Plan §F-13 |

## Readiness Checklist

### Prerequisites (from other groups)

- [ ] **Group C complete:** Workflow discovery, `notor-trigger` frontmatter parsing, `assembleWorkflowPrompt()` available
- [ ] **Group E complete:** Workflow execution pipeline (`executeWorkflow`), persona switching (`switchWorkflowPersona`), conversation creation with workflow metadata
- [ ] **Phase 3 hooks operational:** `hook-config.ts`, `hook-engine.ts`, `hook-events.ts` working with `execute_command` action type
- [ ] **`croner` installed:** `npm install croner` run and `package.json` updated

### Integration Points

| Integration | Source (Group F) | Target | Notes |
|-------------|-----------------|--------|-------|
| Workflow assembly | F-019 | Group E `assembleWorkflowPrompt()` | Trigger context injected into assembled prompt |
| Background execution | F-021 | `ChatOrchestrator` | New `executeBackgroundWorkflow()` method on existing orchestrator |
| Phase 3 hook extension | F-022 | `hook-events.ts` dispatch functions | Adds `action_type` routing to four existing dispatch functions |
| Workflow discovery | F-007, F-008..F-016 | Group C discovery results | Listener manager queries discovered workflows for trigger matching |
| Tag suppression | F-015 | `manage_tags` and `update_frontmatter` tools | Tools call `suppress(notePath)` before modifying tags |
| Concurrency tracking | F-020 | Group H activity indicator | Activity indicator reads from `WorkflowConcurrencyManager` |
| Settings save | F-023 | `src/settings.ts` | Settings save triggers `evaluateListeners()` and `scheduler.syncJobs()` |

### Definition of Done

- [ ] All 24 tasks (F-001 through F-024) completed and acceptance criteria met
- [ ] All six vault event types (`on-note-open`, `on-note-create`, `on-save`, `on-manual-save`, `on-tag-change`, `on-schedule`) fire hooks correctly
- [ ] Both action types (`execute_command`, `run_workflow`) work for vault event hooks and Phase 3 lifecycle hooks
- [ ] Lazy listener activation verified: listeners register/unregister dynamically based on configuration
- [ ] Debounce, loop prevention, tag change suppression, and single-instance guard all verified
- [ ] Background workflow execution runs without blocking the main chat panel
- [ ] Concurrency limit enforced with FIFO queuing
- [ ] Settings UI fully functional for all six event types with cron validation
- [ ] Plugin loads/unloads cleanly with no leaked listeners, intervals, or monkey-patches
- [ ] `npm run build` compiles without errors
