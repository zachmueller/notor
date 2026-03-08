# Task Breakdown: Group G — Workflow Frontmatter Hooks

**Created:** 2026-08-03
**Implementation Plan:** [specs/03-workflows-personas/plan.md](../plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](../spec.md) — FR-52
**Data Model:** [specs/03-workflows-personas/data-model.md](../data-model.md) — WorkflowScopedHook, WorkflowHookConfig
**Status:** Planning

## Task Summary

**Total Tasks:** 8
**Phases:** 4 (Types & Parsing → Override Manager → Dispatch Integration & Wiring → Validation)
**FRs Covered:** FR-52
**Estimated Complexity:** Medium
**Parallel Execution Opportunities:** 1 task group

## Dependency Graph

```
G-001 (WorkflowScopedHook types & parser)
  │
  ├──▶ G-002 (Workflow discovery integration — store parsed hooks)
  │       │
  │       └──▶ G-003 (WorkflowHookOverrideManager)
  │               │
  │               ├──▶ G-004 (Extend dispatch functions for scoped hooks)
  │               │
  │               └──▶ G-005 [P] (Hook revert on workflow end)
  │
  │    G-004 + G-005
  │       │
  │       └──▶ G-006 (Wire override manager into workflow execution pipeline)
  │               │
  │               └──▶ G-007 (Wire into background workflow execution)
  │                       │
  │                       └──▶ G-008 (End-to-end validation & cleanup)
```

---

## Phase 0: Types & Parsing

### G-001: WorkflowScopedHook types and frontmatter parser

**Description:** Define the `WorkflowScopedHook` and `WorkflowHookConfig` types, and implement a parser that extracts and validates the `notor-hooks` YAML mapping from workflow note frontmatter. The parser produces a validated `WorkflowHookConfig` (or `null` if not present), logging warnings for invalid entries and skipping them while preserving valid ones. This parser is called during workflow discovery (Group C) and the resulting config is stored on the `Workflow` entity.

**Files:**
- `src/types.ts` — Add `WorkflowScopedHook`, `WorkflowHookConfig` interfaces (if not already present from F-001)
- `src/workflows/workflow-hook-parser.ts` — **New file**

**Dependencies:** None (Group F types assumed available; uses existing `HookEvent` type from `src/settings.ts`)

**Acceptance Criteria:**
- [ ] `WorkflowScopedHook` interface defined per data-model.md: `event` (`LLMHookEvent`), `action_type` (`"execute_command" | "run_workflow"`), `command` (string | null), `workflow_path` (string | null)
- [ ] `LLMHookEvent` type defined (or aliased from existing `HookEvent`): `"pre_send" | "on_tool_call" | "on_tool_result" | "after_completion"`
- [ ] `WorkflowHookConfig` interface defined: optional `WorkflowScopedHook[]` array per lifecycle event — `pre_send?`, `on_tool_call?`, `on_tool_result?`, `after_completion?`
- [ ] `parseWorkflowHooks(frontmatter: Record<string, unknown> | undefined, workflowPath: string): WorkflowHookConfig | null` function exported
- [ ] Returns `null` if `notor-hooks` is absent or not an object
- [ ] Iterates over keys of the `notor-hooks` mapping; for each key:
  - Validates that the key is a recognized `LLMHookEvent` — logs warning and skips unrecognized event names (e.g., `on-note-open` is NOT valid here per FR-52: "only LLM lifecycle hooks are supported in this context")
  - Validates that the value is an array — logs warning and skips if not
  - For each array entry, validates: `action` (or `action_type`) field is `"execute_command"` or `"run_workflow"`; `command` is a non-empty string when action is `"execute_command"`; `path` (or `workflow_path`) is a non-empty string when action is `"run_workflow"`
  - Invalid individual hook definitions are logged as warnings (with workflow path for context) and skipped; valid hooks in the same event array still apply
- [ ] Handles the frontmatter YAML key format: `notor-hooks` uses hyphenated event names in YAML (`pre-send`, `on-tool-call`, `on-tool-result`, `after-completion`) which are mapped to underscore-separated `LLMHookEvent` values (`pre_send`, `on_tool_call`, `on_tool_result`, `after_completion`)
- [ ] Returns a `WorkflowHookConfig` with only the events that had at least one valid hook definition; events with zero valid hooks after filtering are omitted (key not present)
- [ ] If all hook definitions are invalid, returns `null` (equivalent to no hooks)
- [ ] All types exported from `src/types.ts`
- [ ] TypeScript compiles cleanly with `npm run build`

**Example frontmatter handled:**
```yaml
notor-hooks:
  pre-send:
    - action: execute_command
      command: "echo 'Starting workflow'"
  after-completion:
    - action: run_workflow
      path: "cleanup/post-review.md"
    - action: execute_command
      command: "echo 'Workflow finished'"
```

### G-002: Workflow discovery integration — store parsed hooks on Workflow entity

**Description:** Integrate the `notor-hooks` parser (G-001) into the workflow discovery pipeline (Group C) so that each discovered workflow's `hooks` field is populated with the parsed `WorkflowHookConfig` (or `null`). This ensures hook overrides are available at execution time without re-reading or re-parsing the frontmatter.

**Files:**
- `src/workflows/workflow-discovery.ts` (or equivalent Group C discovery file) — Call `parseWorkflowHooks()` during discovery and store result on the `Workflow` entity

**Dependencies:** G-001, Group C (workflow discovery service)

**Acceptance Criteria:**
- [ ] During workflow discovery, after parsing standard frontmatter properties (`notor-trigger`, `notor-schedule`, `notor-workflow-persona`), call `parseWorkflowHooks(frontmatter, filePath)` to extract hook overrides
- [ ] Store the result in the `Workflow.hooks` field (`WorkflowHookConfig | null`)
- [ ] If `parseWorkflowHooks` returns `null` (no hooks or all invalid), `Workflow.hooks` is `null`
- [ ] Invalid hooks in `notor-hooks` do NOT prevent the workflow from being discovered — only the invalid hook entries are skipped; the workflow itself remains valid and usable
- [ ] Workflows without any `notor-hooks` frontmatter continue to work exactly as before (no behavioral change)
- [ ] Rescans (plugin load, command palette open) re-parse `notor-hooks` from fresh frontmatter

---

## Phase 1: Override Manager

### G-003: WorkflowHookOverrideManager

**Description:** Implement the runtime hook override manager that tracks when a workflow's scoped hooks should replace global hooks for specific lifecycle events. The manager holds a stack-like state: when a workflow with `notor-hooks` begins execution, its scoped hooks are activated; when the workflow ends, the override is removed and global hooks are restored. Only one workflow's hooks can be active per conversation (workflows don't nest within the same conversation).

**Files:**
- `src/hooks/workflow-hook-override.ts` — **New file**

**Dependencies:** G-001 (types)

**Acceptance Criteria:**
- [ ] `WorkflowHookOverrideManager` class exported
- [ ] `activate(conversationId: string, workflowHooks: WorkflowHookConfig): void` — registers the workflow's hook overrides for the given conversation. If an override was already active for this conversation, replaces it (last-write wins).
- [ ] `deactivate(conversationId: string): void` — removes any workflow hook override for the conversation, restoring global hooks. Safe to call if no override is active (no-op).
- [ ] `getEffectiveHooks(conversationId: string, event: LLMHookEvent, globalHooks: Hook[]): Hook[] | WorkflowScopedHook[]` — returns the hooks to execute for a given lifecycle event:
  - If an active override exists for `conversationId` AND the override includes the requested `event` → return the workflow-scoped hooks for that event
  - Otherwise → return the global hooks (unchanged behavior)
- [ ] `isOverrideActive(conversationId: string): boolean` — returns whether a workflow hook override is currently active for the conversation
- [ ] `getActiveOverride(conversationId: string): WorkflowHookConfig | null` — returns the active override config or `null`
- [ ] The manager is a singleton-like service initialized once in `main.ts` and shared across the orchestrator and hook dispatch functions
- [ ] State is in-memory only — lost on plugin reload (acceptable; workflow execution state is also in-memory)
- [ ] `destroy(): void` — clears all state

**Override semantics (per FR-52 and data-model.md):**
- Workflow-scoped hooks **replace** global hooks for the specified lifecycle events (not merge/append)
- Global hooks for events NOT overridden by the workflow continue to apply unchanged
- Example: if a workflow overrides `after-completion` but not `pre-send`, then during that workflow's execution, `pre-send` uses global hooks and `after-completion` uses the workflow's hooks

---

## Phase 2: Dispatch Integration & Wiring

### G-004: Extend hook dispatch functions to support workflow-scoped hooks

**Description:** Modify the four dispatch functions in `src/hooks/hook-events.ts` (`dispatchPreSend`, `dispatchOnToolCall`, `dispatchOnToolResult`, `dispatchAfterCompletion`) to accept an optional `conversationId` + `WorkflowHookOverrideManager` reference, and use `getEffectiveHooks()` instead of directly calling `getEnabledHooks()` from global settings. When workflow-scoped hooks are active, the dispatch functions execute the scoped hooks using the same execution semantics (pre-send: blocking/sequential with stdout capture; others: fire-and-forget sequential). Workflow-scoped hooks share the same global hook timeout setting.

**Files:**
- `src/hooks/hook-events.ts` — Modify all four dispatch functions

**Dependencies:** G-003

**Acceptance Criteria:**
- [ ] All four dispatch functions accept a new optional parameter: `overrideManager?: WorkflowHookOverrideManager` (or a deps object containing it)
- [ ] All four dispatch functions accept `conversationId` as a required parameter in their context objects (already present in existing context interfaces: `PreSendContext.conversationId`, `ToolHookContext.conversationId`, `CompletionContext.conversationId`)
- [ ] Each dispatch function calls `overrideManager.getEffectiveHooks(conversationId, event, globalHooks)` when an override manager is provided; falls back to `getEnabledHooks(settings.hooks, event)` when no override manager is provided (backward-compatible)
- [ ] When effective hooks are `WorkflowScopedHook[]` (from override):
  - For `execute_command` action: convert to a `Hook`-compatible object and execute via the existing `executeHook()` engine — same timeout, same env vars, same stdout capture behavior
  - For `run_workflow` action: delegate to `executeRunWorkflowAction()` (from F-019) — NOT subject to hook timeout per FR-51
- [ ] `dispatchPreSend` with workflow-scoped hooks: fully awaited sequential execution with stdout collection — same semantics as global hooks. `run_workflow` action for `pre_send` fires sequentially but does not return stdout (stdout capture is not applicable to workflow actions per F-022).
- [ ] `dispatchOnToolCall`, `dispatchOnToolResult`, `dispatchAfterCompletion` with workflow-scoped hooks: fire-and-forget sequential execution — same semantics as global hooks
- [ ] Workflow-scoped hooks use the same `settings.hook_timeout` for `execute_command` actions
- [ ] When no `overrideManager` is provided, all functions behave identically to their current (Phase 3) implementation — zero behavioral change for existing callers
- [ ] TypeScript compiles cleanly with `npm run build`

### G-005 [P]: Hook revert on workflow end

**Description:** Ensure that workflow-scoped hook overrides are cleaned up when a workflow execution ends, regardless of how it ends — success, failure, LLM error, or user stop. The `WorkflowHookOverrideManager.deactivate()` must be called on all workflow exit paths. This task covers both manual (foreground) and background workflow execution exit paths.

**Files:**
- `src/chat/orchestrator.ts` — Add `deactivate()` calls to workflow completion paths
- `src/workflows/workflow-concurrency.ts` — Ensure background workflow cleanup calls `deactivate()`

**Dependencies:** G-003

**Acceptance Criteria:**
- [ ] **Manual workflow execution (foreground):** When a workflow conversation's LLM response loop completes (success), `overrideManager.deactivate(conversationId)` is called
- [ ] **Manual workflow execution (failure):** When the LLM response loop encounters an error, `deactivate()` is called in the error/catch handler
- [ ] **Manual workflow execution (user stop):** When the user stops a workflow mid-execution, `deactivate()` is called in the stop handler
- [ ] **Background workflow execution (success/failure/stop):** `WorkflowConcurrencyManager.onComplete()` (F-020) calls `overrideManager.deactivate(conversationId)` as part of its cleanup
- [ ] **Plugin unload:** `WorkflowHookOverrideManager.destroy()` is called during `onunload()`, clearing all active overrides
- [ ] After `deactivate()`, subsequent hook dispatches for the same conversation use global hooks
- [ ] No dangling override state is possible — every `activate()` path has a corresponding `deactivate()` path
- [ ] Revert occurs regardless of outcome — the pattern is `try { run workflow } finally { deactivate() }`

### G-006: Wire override manager into manual workflow execution pipeline

**Description:** Connect the `WorkflowHookOverrideManager` to the manual (foreground) workflow execution pipeline established in Group E. When a workflow with `notor-hooks` is triggered manually (command palette or slash-command), `activate()` the override before the first LLM API call and pass the override manager reference to all hook dispatch call sites within the conversation's response loop.

**Files:**
- `src/chat/orchestrator.ts` — Wire `WorkflowHookOverrideManager` into `executeWorkflow()` (or equivalent Group E method)
- `src/chat/dispatcher.ts` — Pass override manager to hook dispatch calls within tool dispatch

**Dependencies:** G-004, G-005, Group E (manual workflow execution pipeline)

**Acceptance Criteria:**
- [ ] When `executeWorkflow()` is called for a manual workflow:
  1. Check `workflow.hooks` — if non-null, call `overrideManager.activate(conversationId, workflow.hooks)` before the first message is sent to the LLM
  2. If `workflow.hooks` is null, skip activation (global hooks apply as usual)
- [ ] The `overrideManager` reference is passed through to all hook dispatch call sites within the conversation's response loop:
  - `dispatchPreSend()` — called before each LLM API call in the conversation
  - `dispatchOnToolCall()` — called when the LLM invokes a tool
  - `dispatchOnToolResult()` — called after a tool returns its result
  - `dispatchAfterCompletion()` — called when the LLM response turn completes
- [ ] Each dispatch call includes the conversation ID so the override manager can look up the active override
- [ ] On workflow completion/failure/stop: `deactivate()` is called (covered by G-005, but verify the wiring is correct for manual execution)
- [ ] Workflows without `notor-hooks` frontmatter: zero behavioral change — global hooks fire as before
- [ ] The override is scoped to the conversation — follow-up messages in the same workflow conversation continue to use the workflow-scoped hooks until the conversation is left or a new one is started

### G-007: Wire override manager into background workflow execution

**Description:** Connect the `WorkflowHookOverrideManager` to the background (event-triggered) workflow execution pipeline established in Group F. Background workflows with `notor-hooks` activate their hook overrides just like foreground workflows, scoped to their background conversation.

**Files:**
- `src/chat/orchestrator.ts` — Wire `WorkflowHookOverrideManager` into `executeBackgroundWorkflow()` (F-021)

**Dependencies:** G-006, F-021 (background workflow execution pipeline)

**Acceptance Criteria:**
- [ ] When `executeBackgroundWorkflow()` is called for a workflow with `notor-hooks`:
  1. Call `overrideManager.activate(conversationId, workflow.hooks)` before the first message dispatch
  2. Pass the override manager to all hook dispatch calls within the background response loop
- [ ] Background workflow override is isolated to its own conversation ID — does NOT affect the user's active foreground conversation or other background workflows running concurrently
- [ ] On background workflow completion/failure/stop: `deactivate()` is called via `WorkflowConcurrencyManager.onComplete()` cleanup (verified with G-005)
- [ ] Multiple concurrent background workflows can each have their own independent hook overrides (different conversation IDs, different override configs)
- [ ] If the same workflow is triggered by a vault event hook (e.g., `on-save` → run workflow) and that workflow has `notor-hooks`, the overrides apply to the hook-triggered execution's conversation

---

## Phase 3: Validation

### G-008: Playwright E2E validation & cleanup

**Description:** Validate the complete workflow frontmatter hooks system end-to-end via a Playwright E2E test script (`e2e/scripts/workflow-hooks-test.ts`). The test launches Obsidian via CDP, sets up test workflows with various `notor-hooks` configurations, triggers workflow executions, and verifies parsing, override activation, hook dispatch routing, revert on all exit paths, and interaction with both foreground and background workflows via structured logs and DOM assertions. Fix any integration issues discovered.

**Files:**
- `e2e/scripts/workflow-hooks-test.ts` — New Playwright E2E test script
- All Group G files — integration testing and bug fixes
- Existing Group E and F files — verify no regressions

**Dependencies:** G-007

**Acceptance Criteria:**
- [ ] **E2E test script created:** `e2e/scripts/workflow-hooks-test.ts` follows the established pattern (build → launch Obsidian → connect Playwright via CDP → `LogCollector` → structured log verification → screenshots → results JSON)
- [ ] **Parsing valid `notor-hooks` (E2E):** Structured logs from WorkflowDiscovery confirm `WorkflowHookConfig` correctly populated during discovery for a test workflow with well-formed `notor-hooks` YAML. Both `execute_command` and `run_workflow` action types parsed correctly per log data fields.
- [ ] **Parsing invalid hooks (E2E):** Structured logs confirm warn-level entries for invalid hook entries (missing `command`); valid entries in same config still populated. Workflow remains discoverable per discovery logs.
- [ ] **Parsing unsupported event names (E2E):** Structured logs confirm warn-level entry for vault event names in `notor-hooks` (e.g., `on-note-open`); those entries skipped; valid LLM lifecycle entries still apply.
- [ ] **Override activation — manual workflow (E2E):** Test triggers workflow with `notor-hooks` via command palette → structured logs from HookDispatch confirm scoped `pre-send` hook fired instead of global one. Global hook stdout absent; workflow-scoped hook stdout present in structured log data.
- [ ] **Non-overridden events use global hooks (E2E):** Test triggers workflow that overrides only `after-completion` → structured logs confirm global `pre-send`, `on-tool-call`, `on-tool-result` hooks still fire during execution.
- [ ] **Revert on success (E2E):** After workflow completes → test sends a normal message in a new conversation → structured logs confirm global hooks fire (override cleared).
- [ ] **Revert on failure (E2E):** Test triggers workflow that causes LLM error → structured logs confirm override reverted; subsequent conversation uses global hooks.
- [ ] **Revert on user stop (E2E):** Test stops workflow mid-execution → structured logs confirm override reverted via `deactivate()` call.
- [ ] **Background workflow override isolation (E2E):** Test triggers two concurrent background workflows with different `notor-hooks` → structured logs confirm each conversation fires its own scoped hooks independently (conversation IDs differ in log entries).
- [ ] **Background workflow does not affect foreground (E2E):** Test triggers background workflow with hook override → sends message in foreground → structured logs confirm foreground conversation uses global hooks.
- [ ] **Workflow without `notor-hooks` (E2E):** Test triggers workflow without `notor-hooks` → structured logs confirm global hooks fire throughout — zero WorkflowHookOverride activation logs.
- [ ] **`run_workflow` action in scoped hooks (E2E):** Test triggers workflow with `after-completion` scoped hook using `action: run_workflow` → structured logs confirm triggered workflow executed via standard pipeline on completion.
- [ ] **Timeout behavior (E2E):** Structured logs confirm `execute_command` scoped hooks respect `hook_timeout`; `run_workflow` scoped hooks show no timeout enforcement.
- [ ] **Edge case — empty `notor-hooks` mapping (E2E):** Test workflow with `notor-hooks: {}` → structured logs confirm no override activated; global hooks apply.
- [ ] **Edge case — `notor-hooks` is not a mapping (E2E):** Test workflow with `notor-hooks: "invalid"` → structured logs confirm warn-level entry; no override activated.
- [ ] `npm run build` compiles without errors
- [ ] No error-level structured logs from WorkflowHookOverride or HookDispatch sources during normal test flows
- [ ] No leaked override state after plugin disable/enable cycle (verified via structured logs on re-enable)

---

## Cross-Reference: Files Created & Modified

| File | Status | Tasks |
|------|--------|-------|
| `src/types.ts` | Modified | G-001 |
| `src/workflows/workflow-hook-parser.ts` | **New** | G-001 |
| `src/workflows/workflow-discovery.ts` | Modified | G-002 |
| `src/hooks/workflow-hook-override.ts` | **New** | G-003 |
| `src/hooks/hook-events.ts` | Modified | G-004 |
| `src/chat/orchestrator.ts` | Modified | G-005, G-006, G-007 |
| `src/workflows/workflow-concurrency.ts` | Modified | G-005 |
| `src/chat/dispatcher.ts` | Modified | G-006 |
| `src/main.ts` | Modified | G-005 (destroy on unload) |
| `e2e/scripts/workflow-hooks-test.ts` | **New** | G-008 |

## Parallel Execution Opportunities

The following tasks can be implemented in parallel:

| Group | Tasks | Rationale |
|-------|-------|-----------|
| **Phase 2 wiring** | G-004, G-005 | Both depend on G-003 but not on each other: G-004 modifies dispatch functions, G-005 modifies completion handlers — separate files, no conflict |

**Recommended implementation order:**

```
Sprint 1:  G-001
Sprint 2:  G-002
Sprint 3:  G-003
Sprint 4:  G-004 | G-005
Sprint 5:  G-006
Sprint 6:  G-007
Sprint 7:  G-008
```

## Design Decisions

| Decision | Rationale | Reference |
|----------|-----------|-----------|
| **Replace (not merge) global hooks for overridden events** | FR-52 specifies that workflow-scoped hooks "replace the global hooks for the corresponding lifecycle events." Merging would add complexity and deviate from the spec's intent of giving workflow authors full control over hook behavior for their workflow. | FR-52, data-model.md §WorkflowScopedHook "Override semantics" |
| **Conversation-keyed override tracking** | Using conversation ID as the key naturally isolates overrides between concurrent background workflows and the user's foreground conversation. No global mutable state is needed beyond a `Map<string, WorkflowHookConfig>`. | FR-52 "for the duration of the workflow execution" |
| **Parse hooks at discovery time, not execution time** | Parsing during discovery (not at execution time) means: (1) invalid hooks produce warnings early, (2) no frontmatter re-reading on each execution, (3) the `Workflow` entity carries all needed data. Matches the pattern used for other frontmatter properties (`notor-trigger`, `notor-workflow-persona`). | data-model.md §Workflow "Not persisted as structured data. Workflows are discovered at runtime." |
| **Hyphenated YAML keys → underscore enum mapping** | YAML convention uses hyphens (`pre-send`); TypeScript/code convention uses underscores (`pre_send`). The parser normalizes at parse time so all downstream code uses the existing `HookEvent` type without special casing. | Existing `HookEvent` type: `"pre_send" \| "on_tool_call" \| "on_tool_result" \| "after_completion"` |
| **Override manager as a shared service (not per-conversation)** | A single manager instance tracks overrides for all conversations (keyed by conversation ID). This avoids passing per-conversation state through the entire hook dispatch chain and makes cleanup straightforward (single `destroy()` on unload). | Simplicity; consistent with `WorkflowConcurrencyManager` pattern from F-020 |
| **`try/finally` pattern for deactivation** | Guarantees override cleanup on all exit paths (success, failure, user stop) without relying on callers to remember to clean up. Critical for preventing leaked overrides that would incorrectly apply scoped hooks to subsequent non-workflow conversations. | FR-52 "When the workflow execution ends (or is stopped), the hook configuration reverts to global settings." |
| **Only LLM lifecycle hooks in frontmatter** | FR-52 explicitly states: "Vault event hooks are not configurable via workflow frontmatter — only LLM lifecycle hooks are supported in this context." The parser validates and rejects vault event hook names. | FR-52 acceptance criteria, last bullet |

## Readiness Checklist

### Prerequisites (from other groups)

- [ ] **Group C complete:** Workflow discovery service available, `Workflow` entity defined with `hooks: WorkflowHookConfig | null` field
- [ ] **Group E complete:** Manual workflow execution pipeline (`executeWorkflow`), conversation creation, response loop with hook dispatch calls
- [ ] **Group F complete:** Vault event hooks operational, `executeRunWorkflowAction()` (F-019) available for `run_workflow` scoped hook actions, `WorkflowConcurrencyManager` (F-020) and background execution pipeline (F-021) available, Phase 3 hooks extended with `action_type` routing (F-022)
- [ ] **Phase 3 hooks operational:** `hook-config.ts`, `hook-engine.ts`, `hook-events.ts` working with four lifecycle dispatch functions

### Integration Points

| Integration | Source (Group G) | Target | Notes |
|-------------|-----------------|--------|-------|
| Frontmatter parsing | G-001 `parseWorkflowHooks()` | Group C workflow discovery | Called during discovery to populate `Workflow.hooks` |
| Hook override activation | G-003 `activate()` | `orchestrator.ts` `executeWorkflow()` / `executeBackgroundWorkflow()` | Called before first LLM API call in workflow conversation |
| Hook dispatch override | G-004 modified dispatch functions | `hook-events.ts` all four dispatchers | `getEffectiveHooks()` replaces direct `getEnabledHooks()` when override is active |
| `run_workflow` scoped hooks | G-004 dispatch functions | F-019 `executeRunWorkflowAction()` | Scoped hooks with `action_type: "run_workflow"` delegate to existing executor |
| Override cleanup | G-005 `deactivate()` | `orchestrator.ts` completion paths, `workflow-concurrency.ts` `onComplete()` | Called on all workflow exit paths via `try/finally` |
| Plugin lifecycle | G-005 `destroy()` | `main.ts` `onunload()` | Clears all override state on plugin disable |

### Definition of Done

- [ ] All 8 tasks (G-001 through G-008) completed and acceptance criteria met
- [ ] `notor-hooks` frontmatter YAML parsed correctly for all four LLM lifecycle events
- [ ] Invalid hook definitions are logged as warnings and skipped; valid definitions in the same config still apply
- [ ] Vault event hook names in `notor-hooks` are rejected with a clear warning
- [ ] During workflow execution, workflow-scoped hooks replace global hooks for overridden events
- [ ] Non-overridden events continue to use global hooks during workflow execution
- [ ] Hook configuration reverts to global on workflow completion, failure, and user stop
- [ ] Both `execute_command` and `run_workflow` action types work in workflow-scoped hooks
- [ ] `execute_command` scoped hooks respect global hook timeout; `run_workflow` scoped hooks are exempt
- [ ] Background workflows maintain isolated hook overrides per conversation
- [ ] Workflows without `notor-hooks` have zero behavioral change from pre-Group-G implementation
- [ ] `npm run build` compiles without errors
