# Contract: Vault Event Hooks

**Created:** 2026-08-03
**Plan:** [specs/03-workflows-personas/plan.md](../plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](../spec.md) — FR-47, FR-48, FR-48a, FR-48b, FR-49, FR-50, FR-50a, FR-51

This contract defines the vault event hook configuration schema, event listener behavior, environment variables, debounce semantics, concurrency management, and the "run a workflow" action type.

---

## Vault Event Hook Configuration Schema

### VaultEventHook

Each vault event hook has the following structure:

```typescript
interface VaultEventHook {
  /** Unique identifier (UUID v4). */
  id: string;
  /** Vault event this hook fires on. */
  event: VaultEventHookType;
  /** Action to perform when the hook fires. */
  action_type: "execute_command" | "run_workflow";
  /** Shell command (required for execute_command). */
  command: string | null;
  /** Vault-relative workflow path under {notor_dir}/workflows/ (required for run_workflow). */
  workflow_path: string | null;
  /** Human-readable label (optional). */
  label: string;
  /** Whether this hook is active. */
  enabled: boolean;
  /** Cron expression (required for on_schedule event). */
  schedule: string | null;
}

type VaultEventHookType =
  | "on_note_open"
  | "on_note_create"
  | "on_save"
  | "on_manual_save"
  | "on_tag_change"
  | "on_schedule";

interface VaultEventHookConfig {
  on_note_open: VaultEventHook[];
  on_note_create: VaultEventHook[];
  on_save: VaultEventHook[];
  on_manual_save: VaultEventHook[];
  on_tag_change: VaultEventHook[];
  on_schedule: VaultEventHook[];
}
```

### Settings UI

Vault event hooks are configured in **Settings → Notor** under a "Vault event hooks" section, following the same grouped, collapsible UI pattern as the Phase 3 LLM interaction hooks:

- One collapsible subsection per event type
- Each subsection lists configured hooks with enable/disable toggle, reorder, and delete controls
- "Add hook" form with action type selector (shell command or run workflow), command/path input, and optional label
- For `on_schedule` hooks: additional cron expression input with validation feedback

---

## Event Listener Registration

### Lazy Per-Hook-Type Activation (FR-50a)

Obsidian event listeners are only registered for event types that have at least one configured hook (in settings) or at least one discovered workflow with a matching `notor-trigger` value.

**Registration logic:**

```typescript
function evaluateListeners() {
  for (const eventType of ALL_VAULT_EVENT_TYPES) {
    const hasSettingsHooks = settings.vault_event_hooks[eventType].some(h => h.enabled);
    const hasWorkflowTriggers = discoveredWorkflows.some(w => w.trigger === mapEventToTrigger(eventType));
    const shouldBeActive = hasSettingsHooks || hasWorkflowTriggers;

    if (shouldBeActive && !activeListeners.has(eventType)) {
      registerListener(eventType);
    } else if (!shouldBeActive && activeListeners.has(eventType)) {
      unregisterListener(eventType);
    }
  }
}
```

**Re-evaluation triggers:**
- Plugin settings saved (hook configuration changes)
- Workflow discovery completes (new/removed workflows may change trigger requirements)
- Plugin reload

**Cleanup:** All listeners use Obsidian's `this.registerEvent()` or `this.register()` helpers to ensure proper cleanup on plugin unload.

### Listener-to-Obsidian Event Mapping

| Hook Event Type | Obsidian Event | API |
|---|---|---|
| `on_note_open` | `file-open` | `app.workspace.on('file-open', callback)` |
| `on_note_create` | `create` | `app.vault.on('create', callback)` |
| `on_save` | `modify` | `app.vault.on('modify', callback)` |
| `on_manual_save` | `modify` + command interception | `app.vault.on('modify', callback)` + `editor:save-file` flag |
| `on_tag_change` | `changed` | `app.metadataCache.on('changed', callback)` |
| `on_schedule` | Cron timer | In-process cron library |

---

## Event Handler Specifications

### `on-note-open` (FR-47)

**Trigger:** A note is opened (activated) in the Obsidian editor.

**Handler:**
```
1. Receive file-open event with TFile
2. IF file is not a Markdown note → skip
3. Check debounce: IF same note path opened within cooldown → skip
4. Record debounce timestamp for this note path
5. Collect matching hooks (settings hooks + workflow triggers)
6. Execute hooks sequentially in configuration order
```

**Context available:**
- `note_path`: vault-relative path of the opened note

### `on-note-create` (FR-48a)

**Trigger:** A new Markdown file is created in the vault.

**Handler:**
```
1. Receive create event with TAbstractFile
2. IF file is not a TFile or not .md → skip
3. IF creation is from a hook-initiated workflow (loop prevention flag set) → skip
4. Collect matching hooks
5. Execute hooks sequentially
```

**Context available:**
- `note_path`: vault-relative path of the newly created note

**Loop prevention:** A `_suppressNoteCreateHooks` flag is set before any `write_note` tool call within a hook-initiated workflow. The flag is cleared after the tool call completes. While set, `on-note-create` hooks are suppressed for notes created by that tool call.

### `on-save` (FR-48)

**Trigger:** A note is saved (manual or auto-save).

**Handler:**
```
1. Receive modify event with TAbstractFile
2. IF file is not a TFile or not .md → skip
3. Check debounce: IF same note path saved within cooldown → skip
4. Record debounce timestamp for this note path
5. Collect matching hooks
6. Execute hooks sequentially
```

**Context available:**
- `note_path`: vault-relative path of the saved note

### `on-manual-save` (FR-48b)

**Trigger:** A note is saved manually by the user (Cmd+S / Ctrl+S / command palette "Save current file"). Auto-saves do NOT trigger this hook.

**Detection mechanism:**
```
1. Intercept editor:save-file command:
   - Record { notePath: activeFilePath, timestamp: Date.now() } in a Map
2. In modify event handler:
   - Check if file path has a recent manual-save flag (within 500ms window)
   - IF yes → this is a manual save; fire on-manual-save hooks
   - Clean up expired flags
```

**Handler:**
```
1. Receive modify event with TAbstractFile
2. IF file is not flagged as manual save → skip
3. Clear the manual-save flag for this file
4. Check debounce: IF same note path manually saved within cooldown → skip
5. Record debounce timestamp
6. Collect matching hooks
7. Execute hooks sequentially
```

**Platform notes:**
- **Desktop (macOS, Windows, Linux):** All save shortcuts (Cmd+S / Ctrl+S) and command palette "Save current file" route through `editor:save-file`. Vim mode `:w` also routes through this command. Detection works identically on all desktop platforms.
- **Mobile (iOS, Android):** No save shortcut exists. All saving is via auto-save (periodic timer or on-app-background). `on-manual-save` effectively never fires on mobile. This should be documented in the settings UI help text.
- **Defensive availability check:** At registration time, check `typeof (app as any).commands?.executeCommandById === "function"`. If unavailable, log a warning and degrade gracefully — `on-manual-save` hooks simply never fire, with no crash or error.
- **Cleanup interval:** Register a periodic cleanup interval (every 60 seconds) via `this.registerInterval()` to prune unconsumed manual-save flags older than 2× the window (1000 ms).

**Context available:**
- `note_path`: vault-relative path of the manually saved note

### `on-tag-change` (FR-49)

**Trigger:** Tags are added to or removed from a note's frontmatter.

**Detection mechanism:**
```
1. Maintain shadow cache: Map<string, Set<string>> of note path → last-known normalized tags
2. Initialize shadow cache eagerly at plugin load via workspace.onLayoutReady()
   - Iterate all Markdown files via vault.getMarkdownFiles()
   - Read tags from metadataCache.getFileCache(file)?.frontmatter via parseFrontMatterTags()
   - Normalize: strip leading #, trim whitespace, lowercase for comparison
   - Store in shadow cache (< 50 ms for 10,000 notes, no disk I/O)
3. Register lifecycle handlers:
   - vault.on('delete', ...) → remove entry from shadow cache
   - vault.on('rename', ...) → move entry from old path to new path
4. On metadataCache 'changed' event:
   a. Extract new tags via parseFrontMatterTags(cache.frontmatter) — frontmatter tags only, NOT getAllTags()
   b. Normalize new tags (strip #, trim, lowercase)
   c. Compare with shadow cache entry via Set-based diff
   d. Update shadow cache with new tags (even if suppressed, to keep cache accurate)
   e. IF diff is empty (no tag change) → skip (non-tag metadata change)
   f. IF suppression.checkAndConsume(file.path) returns true → skip hook dispatch (loop prevention)
   g. Fire on-tag-change hooks with diff context
```

**Tag normalization rules:**

| Rule | Example | Rationale |
|---|---|---|
| Strip leading `#` | `#research` → `research` | `parseFrontMatterTags` adds `#`; frontmatter stores without it; `manage_tags` strips it |
| Trim whitespace | `" research "` → `research` | Defensive normalization |
| Lowercase for comparison | `Research` → `research` (in shadow cache) | Obsidian treats tags as case-insensitive; case-only changes should not trigger false add/remove events |

Tags are reported in their **original case** (from the current frontmatter) in the `tags_added` / `tags_removed` arrays passed to hooks.

**Why `parseFrontMatterTags` and NOT `getAllTags`:** FR-49 specifies that `on-tag-change` fires when "the `tags` frontmatter property of a note changes." `getAllTags(cache)` includes both frontmatter tags AND inline body tags (`#tag` in note body text). Using `getAllTags` would cause false positives when body text changes add/remove inline `#tag` references without any frontmatter changes. `parseFrontMatterTags` extracts frontmatter tags only, matching the spec requirement.

**Why eager initialization (not lazy):** Lazy initialization on first `changed` event would have no previous state for the first tag change on any note, causing a false "all tags added" detection for every note. Eager initialization (< 50 ms for 10,000 notes from in-memory metadata cache) ensures correct diff behavior from the very first event.

**Context available:**
- `note_path`: vault-relative path of the affected note
- `tags_added`: array of newly added tags (original case)
- `tags_removed`: array of removed tags (original case)

**Loop prevention: `TagChangeSuppressionManager`**

A two-phase consume-on-event mechanism tracks note paths being modified by hook-initiated workflows:

```typescript
class TagChangeSuppressionManager {
  private suppressed: Map<string, number> = new Map();
  // Key: note path being modified by hook workflow
  // Value: Date.now() timestamp when suppression was set

  /** Called before tool execution within a hook workflow. */
  suppress(path: string): void { this.suppressed.set(path, Date.now()); }

  /** Called in metadataCache 'changed' handler. Consumes (deletes) the entry on match. */
  checkAndConsume(path: string): boolean {
    const ts = this.suppressed.get(path);
    if (ts && Date.now() - ts < 2000) {
      this.suppressed.delete(path);
      return true; // suppressed
    }
    return false;
  }

  /** Periodic cleanup (every 30s) prunes entries older than 2 seconds. */
  startCleanup(registerInterval: (id: number) => void): void { /* ... */ }
}
```

**Why two-phase (not immediate cleanup after tool execution):** The `metadataCache.on('changed')` event fires **asynchronously**, typically 50–200 ms after the file write. If suppression were cleared immediately after tool execution (synchronously), the `changed` event wouldn't have fired yet and would miss the suppression. The two-phase approach ensures the flag persists until the corresponding cache event consumes it.

**Note:** The shadow cache is still updated on suppressed events (step 4d) to keep it accurate. Only hook dispatch is skipped.

### `on-schedule` (FR-50)

**Trigger:** Cron expression schedule fires.

**Handler:**
```
1. Cron timer fires for a specific hook
2. Collect the scheduled hook
3. Execute the hook
```

**Context available:**
- No note path (scheduled events are not tied to a specific note)

**Scheduler rules:**
- Cron jobs are started/stopped dynamically based on configuration (lazy activation).
- If Obsidian is not running at the scheduled time, the execution is skipped — no catch-up.
- Invalid cron expressions are caught at configuration time; the hook is saved but marked inactive with a validation error in the settings UI.

---

## Hook Execution Semantics

### Execution Order

When multiple hooks match the same event:
1. **Settings-configured hooks** execute first, in their configured order.
2. **Workflow-trigger matches** execute after settings hooks, in alphabetical order by workflow file path.

### Action Types

#### `execute_command`

- Shell command executed via the same `child_process.spawn` infrastructure as Phase 3 hooks and the `execute_command` tool.
- Subject to global hook timeout (default: 10 seconds).
- `cwd` set to vault root.
- Non-blocking: failures surface a notice but do not prevent subsequent hooks.
- Environment variables injected (see below).

#### `run_workflow`

- Specified workflow is executed following the standard workflow execution pipeline (see [workflow-assembly.md](workflow-assembly.md)).
- **NOT subject to hook timeout** — workflow completes when the LLM conversation finishes, fails, or is stopped.
- Workflow executes in the background (event-triggered) or foreground (manual) depending on the triggering context.
- If the specified workflow does not exist or is invalid → non-blocking notice; hook fails but subsequent hooks continue.
- Vault event context (note path, changed tags) is available to the workflow via the `<trigger_context>` block.
- Persona switching from the workflow's `notor-workflow-persona` applies normally.

---

## Environment Variables

### Variables for Shell Command Actions

All vault event hook shell commands receive context as environment variables:

| Variable | Type | Present For | Description |
|---|---|---|---|
| `NOTOR_HOOK_EVENT` | string | All events | Event name: `on_note_open`, `on_note_create`, `on_save`, `on_manual_save`, `on_tag_change`, `on_schedule` |
| `NOTOR_TIMESTAMP` | string (ISO 8601) | All events | UTC timestamp of the event |
| `NOTOR_NOTE_PATH` | string | Note-related events | Vault-relative path of the affected note |
| `NOTOR_TAGS_ADDED` | string | `on_tag_change` | Comma-separated list of added tags (empty string if none) |
| `NOTOR_TAGS_REMOVED` | string | `on_tag_change` | Comma-separated list of removed tags (empty string if none) |

**Note:** The Phase 3 variables (`NOTOR_CONVERSATION_ID`, `NOTOR_WORKFLOW_NAME`, `NOTOR_TOOL_NAME`, etc.) are NOT present for vault event hooks — those are specific to LLM lifecycle hooks.

### Shell Command Construction

Same as Phase 3:

| Platform | Shell | Invocation |
|---|---|---|
| macOS | `$SHELL` | `spawn($SHELL, ["-l", "-c", hookCommand])` |
| Linux | `$SHELL` | `spawn($SHELL, ["-l", "-c", hookCommand])` |
| Windows | PowerShell | `spawn("powershell.exe", ["-Command", hookCommand])` |

Custom shell configuration from settings overrides these defaults.

---

## Debounce Mechanism

### Purpose

Prevents the same hook from firing repeatedly for rapid successive events on the same note (e.g., auto-save triggering multiple `on-save` events in quick succession, or rapid tab switching triggering multiple `on-note-open` events).

### Implementation

```typescript
/** Per-event-type, per-note-path cooldown tracker. */
const debounceMap: Map<string, Map<string, number>> = new Map();

function shouldDebounce(eventType: string, notePath: string, cooldownMs: number): boolean {
  const eventMap = debounceMap.get(eventType) ?? new Map();
  const lastFired = eventMap.get(notePath) ?? 0;
  const now = Date.now();

  if (now - lastFired < cooldownMs) {
    return true; // debounce — skip this invocation
  }

  eventMap.set(notePath, now);
  debounceMap.set(eventType, eventMap);
  return false;
}
```

### Configuration

- Default cooldown: 5 seconds (`vault_event_debounce_seconds` setting)
- Applies to: `on_note_open`, `on_save`, `on_manual_save`
- Does NOT apply to: `on_note_create` (fires once per file), `on_tag_change` (fires once per distinct tag diff), `on_schedule` (cron-controlled)

### Cleanup

Expired debounce entries are pruned periodically (e.g., every 60 seconds) to prevent memory growth. Entries older than 2× the cooldown period are removed.

---

## Concurrency Management

### Background Workflow Execution Queue

A global concurrency limiter manages background (event-triggered) workflow executions:

```typescript
interface WorkflowConcurrencyManager {
  /** Maximum simultaneous running workflows. */
  limit: number; // default: 3, from settings
  /** Currently running or waiting-for-approval workflows. */
  active: WorkflowExecution[];
  /** Queued workflows waiting for a slot. */
  queue: WorkflowExecution[];

  /** Submit a workflow for execution. Returns immediately. */
  submit(execution: WorkflowExecution): void;
  /** Called when a workflow completes/fails/stops. Starts next queued. */
  onComplete(executionId: string): void;
}
```

**Rules:**
- Maximum `workflow_concurrency_limit` (default: 3) workflows can be active simultaneously.
- When the limit is reached, additional workflows enter the queue (FIFO).
- When a slot opens (active workflow completes/fails/stops), the next queued workflow starts.
- Manually triggered workflows are NOT counted against this limit.
- Only one instance of a given workflow can execute at a time. Duplicate → skip with notice.

### Single-Instance Guard

Before submitting a workflow execution:
```typescript
const alreadyRunning = manager.active.some(e => e.workflow_path === workflow.file_path)
  || manager.queue.some(e => e.workflow_path === workflow.file_path);
if (alreadyRunning) {
  new Notice(`Workflow '${workflow.display_name}' already running; skipped.`);
  return;
}
```

---

## Infinite Loop Prevention

### Execution Chain Tracking

Each workflow execution carries a `Set<string>` of "source hooks" — the hook events that led to this execution. When a tool call within the workflow would trigger a hook that's already in the chain, the re-trigger is skipped.

```typescript
interface ExecutionChain {
  /** Hook event types already in this execution chain. */
  sourceHooks: Set<string>;
  /** Note paths being modified by this execution (for create/tag loop prevention). */
  modifiedNotePaths: Set<string>;
}
```

**Example:**
1. `on-tag-change` hook fires → runs `auto-categorize.md` workflow
2. Workflow calls `manage_tags` to add tags → would trigger `on-tag-change` again
3. Plugin checks: `on_tag_change` is already in `sourceHooks` → skip re-trigger
4. Notice: "Hook cycle detected; skipping 'on-tag-change' to prevent infinite loop."

### Prevention Mechanisms

| Loop Type | Prevention |
|---|---|
| Hook → workflow → same hook type | Execution chain tracking (`sourceHooks` set) |
| Hook → workflow → `write_note` → `on-note-create` | `_suppressNoteCreateHooks` flag per workflow execution |
| Hook → workflow → `manage_tags` → `on-tag-change` | `_suppressTagChangeHooks` set per workflow execution |

---

## "Run a Workflow" Action — Extended to Phase 3 Hooks

The "run a workflow" action type is available for **all** hook events, including Phase 3 LLM lifecycle hooks:

| Hook Category | Events | Run Workflow Supported |
|---|---|---|
| LLM lifecycle (Phase 3) | `pre_send`, `on_tool_call`, `on_tool_result`, `after_completion` | ✓ Yes (Phase 4 extension) |
| Vault event (Phase 4) | `on_note_open`, `on_note_create`, `on_save`, `on_manual_save`, `on_tag_change`, `on_schedule` | ✓ Yes |

**Phase 3 Hook entity extension:**

The existing `Hook` interface gains two new fields:
```typescript
interface Hook {
  id: string;
  event: HookEvent;
  command: string;           // existing — shell command
  label: string;
  enabled: boolean;
  action_type: "execute_command" | "run_workflow";  // NEW (default: "execute_command")
  workflow_path: string | null;                      // NEW (for run_workflow action)
}
```

The existing `command` field is used for `execute_command` actions. The new `workflow_path` field is used for `run_workflow` actions. Backward compatibility is maintained: existing hook configs without `action_type` default to `"execute_command"`.
