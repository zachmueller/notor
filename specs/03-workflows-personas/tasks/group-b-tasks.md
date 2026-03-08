# Task Breakdown: Group B — Per-Persona Auto-Approve Overrides

**Created:** 2026-08-03
**Implementation Plan:** [specs/03-workflows-personas/plan.md](../plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](../spec.md)
**Status:** In Progress

## Task Summary

**Total Tasks:** 8
**Phases:** 4 (Types → Resolution Logic → Settings UI → Wiring & Validation)
**FRs Covered:** FR-40
**Estimated Complexity:** Medium
**Parallel Execution Opportunities:** 2 task groups

## Dependency Graph

```
Group A (persona discovery + manager) ← external prerequisite
  │
  └──▶ B-001 (Types & settings defaults)
          │
          ├──▶ B-002 (Auto-approve resolution service)
          │       │
          │       └──▶ B-003 (Extend dispatcher)
          │
          ├──▶ B-004 [P] (Settings sub-page — persona list & tool selectors)
          │       │
          │       └──▶ B-005 (Stale tool name detection & warning)
          │
          └──▶ B-006 [P] (Storage helpers — read/write persona overrides)
          
B-003 + B-005 + B-006 ──▶ B-007 (main.ts wiring & integration)
                                │
                                └──▶ B-008 (Manual validation & cleanup)
```

---

## Phase 0: Types & Settings Defaults

### B-001: Define auto-approve override types and extend settings interface

**Description:** Add the `AutoApproveState` type, the `PersonaAutoApproveConfig` interface, and extend `NotorSettings` with the `persona_auto_approve` field. This is the foundational type work for all Group B tasks.

**Files:**
- `src/types.ts` — Add `AutoApproveState` type and `PersonaAutoApproveConfig` interface
- `src/settings.ts` — Extend `NotorSettings` with `persona_auto_approve` field; add to `DEFAULT_SETTINGS`

**Dependencies:** Group A complete (A-001 types must exist)

**Acceptance Criteria:**
- [x] `AutoApproveState` type defined: `"global" | "approve" | "deny"`
- [x] `PersonaAutoApproveConfig` interface defined per data-model.md: `persona_name: string`, `overrides: Record<string, AutoApproveState>`
- [x] `NotorSettings.persona_auto_approve` added as `Record<string, Record<string, string>>` — outer key is persona name, inner key is tool name, value is `AutoApproveState`
- [x] `DEFAULT_SETTINGS` updated with `persona_auto_approve: {}`
- [x] All new types exported from `src/types.ts`
- [x] TypeScript compiles cleanly with `npm run build`

---

## Phase 1: Resolution Logic

### B-002: Auto-approve resolution service

**Description:** Create a service that resolves the effective auto-approve decision for a given tool, considering the active persona's overrides (if any) before falling back to global auto-approve settings. This is a pure logic module with no UI or Obsidian dependencies.

**Files:**
- `src/personas/auto-approve-resolver.ts` — New file

**Dependencies:** B-001

**Acceptance Criteria:**
- [x] `resolveAutoApprove(toolName: string, personaName: string | null, personaOverrides: Record<string, Record<string, string>>, globalAutoApprove: Record<string, boolean>): boolean` function exported
- [x] When `personaName` is null (no active persona) → return `globalAutoApprove[toolName] ?? false`
- [x] When persona is active and tool has override `"approve"` → return `true`
- [x] When persona is active and tool has override `"deny"` → return `false`
- [x] When persona is active and tool has override `"global"` or no entry → fall back to `globalAutoApprove[toolName] ?? false`
- [x] Resolution does NOT consider Plan/Act mode (that check remains in the dispatcher, upstream of auto-approve)
- [x] Function is pure (no side effects, no Obsidian API calls) for easy unit testing
- [x] Edge case: persona name exists in overrides but has an empty overrides map → falls back to global for all tools

### B-003: Extend ToolDispatcher for persona-aware auto-approve

**Description:** Modify the `ToolDispatcher` to accept an active persona name and use the auto-approve resolution service instead of the simple boolean lookup. The dispatcher's `dispatch()` method must consider persona overrides when determining whether a tool call requires user approval.

**Files:**
- `src/chat/dispatcher.ts` — Extend auto-approve check to use persona resolution

**Dependencies:** B-002

**Acceptance Criteria:**
- [x] `ToolDispatcher` gains a `setPersonaAutoApprove(overrides: Record<string, Record<string, string>>): void` method to receive the full persona auto-approve config from settings
- [x] `ToolDispatcher` gains a `setActivePersonaName(name: string | null): void` method to track the currently active persona
- [x] `dispatch()` method's auto-approve check (currently `const isAutoApproved = this.autoApprove[toolName] ?? false`) replaced with a call to `resolveAutoApprove()` passing the active persona name, persona overrides, and global auto-approve settings
- [x] Backward-compatible: when no persona is active (`null`), behavior is identical to current global-only auto-approve logic
- [x] Plan/Act mode check remains upstream and unaffected — write tools in Plan mode are still blocked regardless of persona overrides
- [x] `setAutoApprove()` continues to work for global settings (no breaking changes to existing callers)
- [x] Changes take effect on the next `dispatch()` call — no plugin reload required

### B-006 [P]: Storage helpers — read and write persona overrides

**Description:** Implement helper functions for reading, writing, and cleaning up persona auto-approve override entries in the plugin settings data. These helpers are used by both the Settings UI and the runtime resolution path.

**Files:**
- `src/personas/auto-approve-resolver.ts` — Add storage helper functions to the existing file

**Dependencies:** B-001

**Acceptance Criteria:**
- [x] `getPersonaOverrides(settings: NotorSettings, personaName: string): Record<string, AutoApproveState>` returns the overrides map for a persona (empty record if not found)
- [x] `setPersonaToolOverride(settings: NotorSettings, personaName: string, toolName: string, state: AutoApproveState): void` sets a single tool override for a persona; creates the persona entry if it doesn't exist
- [x] `removePersonaOverrides(settings: NotorSettings, personaName: string): void` removes all overrides for a persona (cleanup when persona is deleted)
- [x] `getStaleToolNames(personaOverrides: Record<string, string>, registeredToolNames: string[]): string[]` returns tool names in overrides that are not in the registered tool list
- [x] All helpers operate on the `NotorSettings` object directly (caller is responsible for `saveData()`)
- [x] Functions are pure/deterministic where possible

---

## Phase 2: Settings UI

### B-004: Persona auto-approve settings sub-page

**Description:** Add a "Persona auto-approve" section to **Settings → Notor** that lists all discovered personas and displays a three-state selector per tool for each persona. The section uses the persona discovery service (from Group A) to list personas and the tool registry to list all available tools.

**Files:**
- `src/settings.ts` — Add `renderPersonaAutoApproveSection()` method and call it from `display()`

**Dependencies:** B-001, Group A (A-002 persona discovery service)

**Acceptance Criteria:**
- [x] A "Persona auto-approve" section is rendered in **Settings → Notor**, positioned after the global auto-approve section
- [x] Section header includes a description: "Per-persona overrides for tool auto-approve settings. When a persona is active, these overrides take precedence over global defaults."
- [x] The section discovers all personas by triggering a rescan of `{notor_dir}/personas/` (same discovery logic as FR-37 / Group A) and lists each persona by name
- [x] If no personas are discovered, displays an informational message: "No personas found. Create a persona directory under `{notor_dir}/personas/` to configure per-persona auto-approve settings."
- [x] Each persona is rendered as a collapsible sub-section (using Obsidian's `Setting` + heading pattern or `<details>` element) showing the persona name
- [x] Within each persona sub-section, the full list of tools is displayed (sourced from the tool registry or the `TOOL_DISPLAY_NAMES` constant)
- [x] Each tool row displays the tool's display name, description, and a three-state dropdown selector:
  - **"Global default"** — no override; the global setting applies (this is the default)
  - **"Auto-approve"** — tool is auto-approved when this persona is active
  - **"Require approval"** — tool requires manual approval when this persona is active
- [x] The dropdown reflects the current saved state from `settings.persona_auto_approve[personaName][toolName]`, defaulting to "Global default" when no entry exists
- [x] Changing a dropdown value calls `setPersonaToolOverride()` and `saveData()` immediately
- [x] Tools are grouped into "Read-only tools" and "Write tools" subsections (consistent with the global auto-approve section)
- [x] Newly created or deleted personas are reflected when the settings page is opened or refreshed (via rescan in `display()`)

### B-005: Stale tool name detection and warning indicator

**Description:** When a persona's stored auto-approve configuration references a tool name that no longer exists in the tool registry (e.g., an MCP tool was removed), display a non-blocking warning indicator next to that entry in the Settings UI. Provide an option to remove stale entries.

**Files:**
- `src/settings.ts` — Extend the persona auto-approve sub-page from B-004 with stale tool handling
- `styles.css` — Add styling for the stale tool warning indicator (if needed)

**Dependencies:** B-004, B-006 (for `getStaleToolNames()`)

**Acceptance Criteria:**
- [x] After rendering the known tools for each persona, check for stale tool names using `getStaleToolNames()` comparing stored overrides against the registered tool list
- [x] Stale tool entries are rendered at the bottom of the persona sub-section under a "Unknown tools" subsection with a warning indicator (e.g., ⚠️ icon or warning-colored text)
- [x] Each stale entry displays the tool name, its current override state, and a "Remove" button to delete the stale entry
- [x] Clicking "Remove" calls `setPersonaToolOverride()` to delete the entry and re-renders the section
- [x] Stale entries do not cause errors at runtime — `resolveAutoApprove()` simply ignores overrides for tools that don't exist in the registry (the tool won't be dispatched if it doesn't exist)
- [x] If no stale entries exist for a persona, the "Unknown tools" subsection is not rendered
- [x] Warning styling is consistent with Obsidian's existing warning patterns (e.g., `.mod-warning` or a yellow/amber indicator)

---

## Phase 3: Wiring & Validation

### B-007: Wire persona auto-approve into dispatcher and main plugin

**Description:** Connect the auto-approve resolution service, persona manager, and settings UI so that persona overrides flow through the full system at runtime. Ensure the dispatcher receives updated persona state whenever the active persona changes.

**Files:**
- `src/main.ts` — Pass persona auto-approve config to dispatcher; update on persona switch
- `src/personas/persona-manager.ts` — Emit/callback when persona changes so dispatcher is updated
- `src/chat/orchestrator.ts` — Ensure dispatcher's active persona is updated before each dispatch

**Dependencies:** B-003, B-005, B-006, Group A (A-005 persona manager)

**Acceptance Criteria:**
- [ ] On plugin load, `ToolDispatcher.setPersonaAutoApprove()` is called with the current `settings.persona_auto_approve` config
- [ ] On plugin load, `ToolDispatcher.setActivePersonaName()` is called with the current `settings.active_persona` (or null if empty)
- [ ] When the user switches personas (via the persona picker from Group A), `ToolDispatcher.setActivePersonaName()` is called with the new persona name (or null for "None")
- [ ] When persona auto-approve settings are saved (via the Settings UI from B-004), `ToolDispatcher.setPersonaAutoApprove()` is called with the updated config
- [ ] `PersonaManager.activatePersona()` and `deactivatePersona()` propagate the persona name change to the dispatcher (via a callback, event, or direct reference)
- [ ] Integration does not break existing non-persona auto-approve flows — when no persona is active, behavior is identical to Phase 3
- [ ] Settings changes take effect on the next message dispatch without plugin reload

### B-008: Playwright E2E validation and final cleanup

**Description:** End-to-end Playwright-based validation of the complete per-persona auto-approve system following the "Persona with auto-approve overrides" user scenario from spec.md, plus edge case verification. Create a dedicated E2E test script (`e2e/scripts/auto-approve-test.ts`) that launches Obsidian via CDP, configures persona overrides in the Settings UI, activates personas in the chat panel, triggers tool dispatches, and verifies correct auto-approve resolution via structured logs and DOM assertions. Clean up any remaining issues.

**Files:**
- `e2e/scripts/auto-approve-test.ts` — New Playwright E2E test script
- All files from B-001 through B-007 (review and polish)

**Dependencies:** B-007

**Acceptance Criteria:**
- [ ] **E2E test script created:** `e2e/scripts/auto-approve-test.ts` follows the established pattern (build → launch Obsidian → connect Playwright via CDP → `LogCollector` → DOM assertions → structured log verification → screenshots → results JSON)
- [ ] **Primary flow validated (E2E):** Test opens **Settings → Notor → Persona auto-approve** section → verifies "organizer" persona is listed → sets tool overrides via DOM selects → activates "organizer" persona in chat settings popover → structured logs confirm auto-approve resolution uses persona overrides for `manage_tags` and global fallback for `execute_command`
- [ ] **Global default fallback validated (E2E):** Test sets a tool to "Global default" on persona → toggles global auto-approve on/off → structured logs confirm resolution follows the global value in both states
- [ ] **"Require approval" override validated (E2E):** Test sets a tool to "Require approval" on persona with global auto-approve enabled → structured logs confirm tool requires approval despite global setting
- [ ] **No persona active validated (E2E):** Test deactivates persona → triggers tool dispatch → structured logs confirm only global auto-approve is consulted, persona overrides ignored
- [ ] **Plan mode respected validated (E2E):** Test activates persona with write tool set to "Auto-approve" → switches to Plan mode → structured logs confirm write tool is blocked regardless of persona override
- [ ] **Stale tool warning validated (E2E):** Test injects a fake tool name entry into `persona_auto_approve` via plugin settings manipulation → opens Settings → verifies stale tool warning indicator is visible in the DOM → clicks "Remove" → verifies entry removed from DOM
- [ ] **No personas discovered validated (E2E):** Test removes personas directory before launch → verifies persona auto-approve section shows informational message in the DOM, no error-level structured logs
- [ ] **Settings persistence validated (E2E):** Test sets overrides → reloads plugin (or restarts Obsidian) → verifies overrides still present in Settings UI DOM and effective at runtime via structured logs
- [ ] Build succeeds: `npm run build` produces clean `main.js`
- [ ] No TypeScript errors: `npx tsc --noEmit` passes
- [ ] No persona/auto-approve-related error-level structured logs during test execution (filtered via `LogCollector.getLogsByLevel("error")`)

---

## Cross-Reference: Files Created and Modified

### New Files
| File | Tasks | Description |
|---|---|---|
| `src/personas/auto-approve-resolver.ts` | B-002, B-006 | Auto-approve resolution logic and storage helpers |

### Modified Files
| File | Tasks | Changes |
|---|---|---|
| `src/types.ts` | B-001 | Add `AutoApproveState` type, `PersonaAutoApproveConfig` interface |
| `src/settings.ts` | B-001, B-004, B-005 | Add `persona_auto_approve` setting, persona auto-approve sub-page UI, stale tool warnings |
| `src/chat/dispatcher.ts` | B-003 | Extend auto-approve check for persona-aware resolution |
| `src/main.ts` | B-007 | Wire persona auto-approve config to dispatcher |
| `src/personas/persona-manager.ts` | B-007 | Propagate persona changes to dispatcher |
| `src/chat/orchestrator.ts` | B-007 | Ensure dispatcher has current persona before dispatch |
| `styles.css` | B-005 | Stale tool warning indicator styling (if needed) |

### E2E Test Files
| File | Tasks | Description |
|---|---|---|
| `e2e/scripts/auto-approve-test.ts` | B-008 | Playwright E2E test: persona auto-approve override resolution, settings UI, stale tool warnings |

---

## Parallel Execution Opportunities

The following task groups can be executed in parallel:

1. **After B-001 completes:** B-002 (resolution logic), B-004 (settings UI), and B-006 (storage helpers) can all proceed simultaneously since they have no mutual dependencies
2. **After B-004 completes:** B-005 (stale tool warnings) can proceed in parallel with B-003 (dispatcher extension, which depends on B-002)

## Critical Path

```
B-001 → B-002 → B-003 → B-007 → B-008
```

The longest dependency chain runs through types → resolution service → dispatcher extension → wiring → validation. The Settings UI work (B-004, B-005) and storage helpers (B-006) can be developed in parallel with the resolution logic chain.

## Readiness for Implementation

- [x] All functional requirements (FR-40) mapped to specific tasks
- [x] File paths and integration points identified from existing codebase
- [x] Dependency chain is acyclic and optimized for parallelism
- [x] Acceptance criteria are specific, measurable, and testable
- [x] Edge cases from spec.md addressed (stale tools, no personas, Plan mode enforcement, global fallback)
- [x] Group A integration points identified (persona discovery, persona manager, persona picker)
- [x] Existing dispatcher pattern understood — extension is backward-compatible
