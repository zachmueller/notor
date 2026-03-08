# Task Breakdown: Group C — Workflow Definition & Discovery

**Created:** 2026-08-03
**Implementation Plan:** [specs/03-workflows-personas/plan.md](../plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](../spec.md)
**Status:** Planning

## Task Summary

**Total Tasks:** 8
**Phases:** 4 (Types → Discovery & Parsing → Validation & Test Fixtures → Wiring & Validation)
**FRs Covered:** FR-41
**Estimated Complexity:** Medium
**Parallel Execution Opportunities:** 2 task groups

## Dependency Graph

```
C-001 (Workflow types & settings)
  │
  ├──▶ C-002 (Discovery service — directory scanning)
  │       │
  │       └──▶ C-003 (Frontmatter parser)
  │               │
  │               └──▶ C-004 (Workflow validation logic)
  │                       │
  │                       └──▶ C-005 (Cron expression validation)
  │
  └──▶ C-006 [P] (WorkflowScopedHook frontmatter parser)

C-004 + C-005 + C-006 ──▶ C-007 (Test vault fixtures & manual validation)
                                │
                                └──▶ C-008 (main.ts wiring & integration)
```

---

## Phase 0: Types & Interfaces

### C-001: Define Workflow types, WorkflowTrigger enum, and WorkflowScopedHook types

**Description:** Add the `Workflow` in-memory entity interface, `WorkflowTrigger` type, `WorkflowHookConfig` interface, `WorkflowScopedHook` interface, and the `LLMHookEvent` type to the codebase. These are the foundational types that all subsequent Group C tasks (and later Groups E, F, G) depend on.

**Files:**
- `src/types.ts` — Add `Workflow`, `WorkflowTrigger`, `WorkflowHookConfig`, `WorkflowScopedHook`, and `LLMHookEvent` types

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `WorkflowTrigger` type defined: `"manual" | "on-note-open" | "on-note-create" | "on-save" | "on-manual-save" | "on-tag-change" | "scheduled"`
- [ ] `LLMHookEvent` type defined: `"pre_send" | "on_tool_call" | "on_tool_result" | "after_completion"`
- [ ] `WorkflowScopedHook` interface defined per data-model.md: `event`, `action_type` (`"execute_command" | "run_workflow"`), `command` (string | null), `workflow_path` (string | null)
- [ ] `WorkflowHookConfig` interface defined: optional arrays of `WorkflowScopedHook` keyed by `pre_send`, `on_tool_call`, `on_tool_result`, `after_completion`
- [ ] `Workflow` interface defined per data-model.md: `file_path`, `file_name`, `display_name`, `trigger`, `schedule` (string | null), `persona_name` (string | null), `hooks` (WorkflowHookConfig | null), `body_content`
- [ ] `VALID_WORKFLOW_TRIGGERS` constant array exported for validation
- [ ] All types exported from `src/types.ts`
- [ ] TypeScript compiles cleanly with `npm run build`

---

## Phase 1: Discovery & Parsing

### C-002: Workflow discovery service — recursive directory scanning

**Description:** Implement the workflow discovery service that recursively scans `{notor_dir}/workflows/` for Markdown notes with `notor-workflow: true` in their frontmatter. This task handles directory traversal and file identification only — frontmatter parsing is in C-003.

**Files:**
- `src/workflows/workflow-discovery.ts` — New file

**Dependencies:** C-001

**Acceptance Criteria:**
- [ ] `WorkflowDiscoveryService` class (or exported functions) created in new `src/workflows/` directory
- [ ] `discoverWorkflows(vault: Vault, metadataCache: MetadataCache, notorDir: string): Promise<Workflow[]>` is the primary entry point
- [ ] Scans `{notor_dir}/workflows/` recursively for all Markdown files (`.md` extension)
- [ ] Uses `vault.getAbstractFileByPath()` to locate the workflows root directory
- [ ] Recursively traverses subdirectories (e.g., `{notor_dir}/workflows/daily/review.md` is discovered)
- [ ] For each Markdown file, checks frontmatter via `metadataCache.getFileCache(file)?.frontmatter` for `notor-workflow: true`
- [ ] Only notes with `notor-workflow: true` (boolean `true`, not string `"true"`) are included
- [ ] Notes without `notor-workflow: true` are silently ignored
- [ ] If `{notor_dir}/workflows/` does not exist, returns an empty array without error
- [ ] Handles errors gracefully (logs warning per-file, does not throw on overall scan failure)
- [ ] Returns an array of `Workflow` objects (partially populated — `body_content` is not read during discovery to keep scans fast; frontmatter-only reads for discovery)

### C-003: Workflow frontmatter parser

**Description:** Parse workflow-specific frontmatter properties (`notor-trigger`, `notor-schedule`, `notor-workflow-persona`) from each discovered workflow note and populate the corresponding `Workflow` fields. The `notor-hooks` property is handled separately in C-006 since it has a more complex structure.

**Files:**
- `src/workflows/workflow-discovery.ts` — Extend with frontmatter parsing logic

**Dependencies:** C-002

**Acceptance Criteria:**
- [ ] Parses `notor-trigger` from frontmatter: must be one of the valid `WorkflowTrigger` values
- [ ] Missing `notor-trigger` → logs a warning ("Workflow '{file_path}' is missing required 'notor-trigger' property") and excludes the workflow from the returned list
- [ ] Unrecognized `notor-trigger` value → logs a warning ("Workflow '{file_path}' has unrecognized trigger '{value}'") and excludes the workflow from the returned list
- [ ] Parses `notor-schedule`: string or null (required when trigger is `"scheduled"`; validated in C-005)
- [ ] Parses `notor-workflow-persona`: string or null (empty/omitted → null)
- [ ] `file_name` derived from the note's filename (e.g., `review.md`)
- [ ] `display_name` derived from filename without extension for top-level workflows (e.g., `review`) or subdirectory-qualified for nested workflows (e.g., `daily/review`)
- [ ] `body_content` is set to an empty string during discovery (full body is read lazily at execution time by the workflow executor in Group E)
- [ ] Malformed YAML frontmatter causes that workflow to be excluded with a warning logged; other workflows unaffected

### C-004: Workflow validation logic

**Description:** Implement validation rules that ensure discovered workflows have all required properties and valid configurations. Centralize validation so it can be called both during discovery and when validating individual workflows at execution time.

**Files:**
- `src/workflows/workflow-discovery.ts` — Add `validateWorkflow()` function

**Dependencies:** C-003

**Acceptance Criteria:**
- [ ] `validateWorkflow(frontmatter: Record<string, unknown>, filePath: string): { valid: boolean; errors: string[] }` function exported
- [ ] Validates `notor-workflow` is `true` (boolean)
- [ ] Validates `notor-trigger` is present and is a recognized `WorkflowTrigger` value (uses `VALID_WORKFLOW_TRIGGERS` constant from C-001)
- [ ] Validates that `notor-schedule` is present when `notor-trigger` is `"scheduled"` (cron expression syntax validation is in C-005)
- [ ] Validates that `notor-workflow-persona` is either a string or omitted (not a number, boolean, etc.)
- [ ] Returns a structured result with `valid: boolean` and an array of human-readable error strings
- [ ] Discovery function (`discoverWorkflows`) calls `validateWorkflow()` and excludes invalid workflows, logging each error string as a warning via `console.warn()`
- [ ] Valid workflows with non-fatal issues (e.g., `scheduled` trigger with invalid cron expression) are included in the list but flagged — they can be triggered manually but not scheduled

### C-005: Cron expression validation for scheduled workflows

**Description:** Add cron expression validation for workflows with `notor-trigger: "scheduled"`. This validates the `notor-schedule` value at discovery time so invalid expressions are caught early. Uses a lightweight validation approach that will be replaced with `croner`'s `CronPattern` validation when the cron library is installed in Group F.

**Files:**
- `src/workflows/workflow-discovery.ts` — Add cron validation step to the discovery pipeline

**Dependencies:** C-004

**Acceptance Criteria:**
- [ ] `validateCronExpression(expression: string): { valid: boolean; error?: string }` function exported
- [ ] Validates basic cron structure: 5 fields separated by spaces (minute, hour, day-of-month, month, day-of-week), or recognized shorthand aliases (`@daily`, `@weekly`, `@monthly`, `@yearly`, `@annually`, `@hourly`)
- [ ] Returns `{ valid: true }` for structurally valid expressions or `{ valid: false, error: "..." }` with a descriptive error message
- [ ] This is a basic structural check — deep semantic validation (e.g., valid day ranges) will be handled by `croner`'s `CronPattern` constructor when the cron library is integrated in Group F
- [ ] During discovery, workflows with trigger `"scheduled"` and an invalid/missing `notor-schedule` are logged with a warning ("Workflow '{file_path}' has invalid cron expression: {error}") and marked with `schedule: null` — they remain in the discovered list (can be triggered manually) but are excluded from scheduled execution
- [ ] Workflows with trigger `"scheduled"` and a valid `notor-schedule` have their `schedule` field populated

### C-006 [P]: WorkflowScopedHook frontmatter parser

**Description:** Parse the `notor-hooks` frontmatter property from workflow notes. This is the complex YAML mapping that defines per-workflow LLM lifecycle hook overrides. Separated from C-003 because the parsing logic is significantly more complex (nested YAML structures) and can be developed in parallel with C-004/C-005.

**Files:**
- `src/workflows/workflow-discovery.ts` — Add `parseWorkflowHooks()` function

**Dependencies:** C-001 (types only)

**Acceptance Criteria:**
- [ ] `parseWorkflowHooks(hooksValue: unknown, filePath: string): WorkflowHookConfig | null` function exported
- [ ] Accepts the raw `notor-hooks` value from frontmatter (which Obsidian's YAML parser returns as a JavaScript object or `undefined`)
- [ ] If `notor-hooks` is omitted or `undefined` → returns `null` (no hook overrides)
- [ ] If `notor-hooks` is not an object (e.g., string, number, boolean, array) → logs warning ("Workflow '{file_path}' has invalid notor-hooks: expected YAML mapping"), returns `null`
- [ ] For each key in the mapping, validates it is a recognized `LLMHookEvent` (`pre_send`, `on_tool_call`, `on_tool_result`, `after_completion`). Unrecognized keys are logged as warnings and ignored.
- [ ] For each recognized event key, the value must be an array of hook action objects. Each action object must have:
  - `action`: either `"execute_command"` or `"run_workflow"` (mapped to `action_type`)
  - `command`: required when `action` is `"execute_command"`
  - `path`: required when `action` is `"run_workflow"` (mapped to `workflow_path`)
- [ ] Invalid individual hook action definitions (missing required fields, unsupported action type) are logged as warnings and skipped; valid actions in the same array still apply
- [ ] Returns a populated `WorkflowHookConfig` with only the events that have at least one valid action
- [ ] Handles YAML frontmatter using both kebab-case (`pre-send`) and snake_case (`pre_send`) event names — normalizes to snake_case for the `LLMHookEvent` type
- [ ] Edge case: `notor-hooks` with all invalid actions → returns `null` (treated as no overrides)

---

## Phase 2: Test Fixtures & Validation

### C-007: Test vault workflow fixtures and Playwright E2E discovery validation

**Description:** Create test workflow notes in the e2e test vault covering all trigger types, edge cases (missing trigger, invalid YAML, nested subdirectories, scheduled with invalid cron), and validate end-to-end discovery via a Playwright E2E test script that launches Obsidian, verifies structured logs from the workflow discovery service, and confirms correct discovery counts and edge-case handling.

**Files:**
- `e2e/test-vault/notor/workflows/daily/review.md` — Test workflow (manual trigger, persona assignment)
- `e2e/test-vault/notor/workflows/auto-tag.md` — Test workflow (on-save trigger)
- `e2e/test-vault/notor/workflows/scheduled/weekly-review.md` — Test workflow (scheduled trigger with cron)
- `e2e/test-vault/notor/workflows/broken-no-trigger.md` — Test workflow (missing notor-trigger)
- `e2e/test-vault/notor/workflows/not-a-workflow.md` — Regular note without notor-workflow frontmatter
- `e2e/test-vault/notor/workflows/hooks-test.md` — Test workflow with `notor-hooks` frontmatter
- `e2e/scripts/workflow-discovery-test.ts` — New Playwright E2E test script

**Dependencies:** C-004, C-005, C-006

**Acceptance Criteria:**
- [ ] **E2E test script created:** `e2e/scripts/workflow-discovery-test.ts` follows the established pattern (build → launch Obsidian → connect Playwright via CDP → `LogCollector` → structured log verification → screenshots → results JSON)
- [ ] `daily/review.md`: `notor-workflow: true`, `notor-trigger: manual`, `notor-workflow-persona: "organizer"`, body with step-by-step instructions — structured logs confirm discovered with trigger `"manual"`, persona `"organizer"`, display_name `"daily/review"` (E2E)
- [ ] `auto-tag.md`: `notor-workflow: true`, `notor-trigger: on-save`, no persona — structured logs confirm discovered with trigger `"on-save"`, persona `null`, display_name `"auto-tag"` (E2E)
- [ ] `scheduled/weekly-review.md`: `notor-workflow: true`, `notor-trigger: scheduled`, `notor-schedule: "0 9 * * 1"` — structured logs confirm discovered with trigger `"scheduled"`, schedule `"0 9 * * 1"`, display_name `"scheduled/weekly-review"` (E2E)
- [ ] `broken-no-trigger.md`: `notor-workflow: true`, no `notor-trigger` — structured logs confirm warn-level entry mentioning missing trigger; excluded from discovery count (E2E)
- [ ] `not-a-workflow.md`: regular note without `notor-workflow` — no discovery log entries for this file (E2E)
- [ ] `hooks-test.md`: `notor-workflow: true`, `notor-trigger: manual`, `notor-hooks` with `pre-send` and `after-completion` entries — structured logs confirm discovered with hooks parsed (E2E)
- [ ] Discovery structured logs confirm exactly 4 valid workflows discovered, excluding `broken-no-trigger` and ignoring `not-a-workflow` (E2E)
- [ ] Subdirectory organization preserved in `file_path` and `display_name` per structured log data fields (E2E)
- [ ] No error-level structured logs from WorkflowDiscovery source during test execution (E2E)

---

## Phase 3: Wiring & Integration

### C-008: Main plugin wiring — initialize workflow discovery and expose to consumers

**Description:** Wire the workflow discovery service into the main plugin lifecycle. Ensure discovery runs on plugin load and results are accessible to downstream consumers (Group E for command palette, slash-command; Group F for event-triggered workflows). Register a rescan mechanism for the command palette workflow list.

**Files:**
- `src/main.ts` — Initialize workflow discovery, store results, expose accessor
- `src/workflows/workflow-discovery.ts` — Add rescan/refresh capability

**Dependencies:** C-007

**Acceptance Criteria:**
- [ ] `WorkflowDiscoveryService` (or equivalent module) is instantiated in `onload()` with access to `vault`, `metadataCache`, and the configured `notor_dir` from settings
- [ ] Initial workflow discovery runs during `onload()` (deferred/non-blocking — does not delay plugin startup)
- [ ] `NotorPlugin` exposes a `getDiscoveredWorkflows(): Workflow[]` accessor returning the cached discovery results
- [ ] `NotorPlugin` exposes a `rescanWorkflows(): Promise<Workflow[]>` method that triggers a fresh discovery scan and updates the cache — intended to be called when the command palette workflow list is opened (Group E) or when settings change (Group F)
- [ ] Discovery results are stored in-memory on the plugin instance (not in persisted settings — workflows are always discovered fresh from the vault)
- [ ] On plugin unload, no stale references or timers remain from the discovery service
- [ ] Existing plugin functionality is unaffected — no breaking changes to `onload()` or `onunload()`
- [ ] Build succeeds: `npm run build` produces clean `main.js`
- [ ] No TypeScript errors: `npx tsc --noEmit` passes

---

## Cross-Reference: Files Created and Modified

### New Files
| File | Tasks | Description |
|---|---|---|
| `src/workflows/workflow-discovery.ts` | C-002, C-003, C-004, C-005, C-006 | Workflow directory scanning, frontmatter parsing, validation, cron validation, hook parsing |

### Modified Files
| File | Tasks | Changes |
|---|---|---|
| `src/types.ts` | C-001 | Add `Workflow`, `WorkflowTrigger`, `WorkflowHookConfig`, `WorkflowScopedHook`, `LLMHookEvent` types, `VALID_WORKFLOW_TRIGGERS` constant |
| `src/main.ts` | C-008 | Initialize workflow discovery, expose accessor and rescan method |

### Test Vault Files
| File | Tasks | Description |
|---|---|---|
| `e2e/test-vault/notor/workflows/daily/review.md` | C-007 | Test workflow (manual trigger, persona assignment) |
| `e2e/test-vault/notor/workflows/auto-tag.md` | C-007 | Test workflow (on-save trigger) |
| `e2e/test-vault/notor/workflows/scheduled/weekly-review.md` | C-007 | Test workflow (scheduled trigger with cron) |
| `e2e/test-vault/notor/workflows/broken-no-trigger.md` | C-007 | Test workflow (invalid — missing trigger) |
| `e2e/test-vault/notor/workflows/not-a-workflow.md` | C-007 | Regular note (not a workflow) |
| `e2e/test-vault/notor/workflows/hooks-test.md` | C-007 | Test workflow (with notor-hooks frontmatter) |

### E2E Test Files
| File | Tasks | Description |
|---|---|---|
| `e2e/scripts/workflow-discovery-test.ts` | C-007 | Playwright E2E test: workflow discovery, trigger parsing, edge cases, structured log verification |

---

## Parallel Execution Opportunities

The following task groups can be executed in parallel:

1. **After C-001 completes:** C-002 (directory scanning) and C-006 (hook parser) can proceed simultaneously since they have no mutual dependencies — C-002 starts the discovery pipeline while C-006 builds the hook parsing logic independently
2. **After C-004 completes:** C-005 (cron validation) can proceed in parallel with finalizing C-006 (if not already complete)

## Critical Path

```
C-001 → C-002 → C-003 → C-004 → C-005 → C-007 → C-008
```

The longest dependency chain runs through types → directory scanning → frontmatter parsing → validation → cron validation → test fixtures → wiring. The `WorkflowScopedHook` parser (C-006) can be developed in parallel with the main discovery pipeline (C-002 through C-005).

## Integration Points with Other Groups

Group C provides foundational workflow discovery that several downstream groups depend on:

- **Group E (Manual Workflow Execution):** Uses `getDiscoveredWorkflows()` to populate the command palette quick-pick list and slash-command autocomplete. Uses `rescanWorkflows()` to refresh the list when the command palette is opened. Reads `body_content` lazily at execution time (not during discovery).
- **Group F (Vault Event Hooks):** Uses discovered workflows to identify event-triggered workflows (those with `notor-trigger` matching vault event types). Workflow triggers feed into lazy listener activation logic (FR-50a) — listeners are only registered for event types that have at least one configured hook or discovered workflow trigger.
- **Group G (Workflow Frontmatter Hooks):** Uses the `hooks` field (parsed by C-006) to apply per-workflow LLM lifecycle hook overrides at runtime.
- **Group H (Workflow Activity Indicator):** Uses workflow display names for the activity indicator dropdown entries.

## Readiness for Implementation

- [x] All functional requirements (FR-41) mapped to specific tasks
- [x] File paths and integration points identified from existing codebase and quickstart.md
- [x] Dependency chain is acyclic and optimized for parallelism
- [x] Acceptance criteria are specific, measurable, and testable
- [x] Edge cases from spec.md addressed (missing trigger, invalid YAML, subdirectory organization, invalid cron, missing workflows directory)
- [x] Downstream integration points documented for Groups E, F, G, H
- [x] `body_content` is intentionally deferred (empty string during discovery, read lazily at execution time) per NFR-10 performance requirements (frontmatter-only reads during discovery, <500 ms for 200 workflows)
