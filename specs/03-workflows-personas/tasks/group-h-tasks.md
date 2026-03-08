# Task Breakdown: Group H — Workflow Activity Indicator

**Created:** 2026-08-03
**Implementation Plan:** [specs/03-workflows-personas/plan.md](../plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](../spec.md) — FR-53
**Data Model:** [specs/03-workflows-personas/data-model.md](../data-model.md) — WorkflowExecution, WorkflowExecutionStatus
**Status:** Planning

## Task Summary

**Total Tasks:** 8
**Phases:** 4 (Types & State Management → Indicator UI → Dropdown & Navigation → Wiring & Validation)
**FRs Covered:** FR-53
**Estimated Complexity:** Medium
**Parallel Execution Opportunities:** 2 task groups

## Dependency Graph

```
H-001 (WorkflowActivityTracker — in-memory execution list)
  │
  ├──▶ H-002 (Activity indicator icon & badge in chat panel header)
  │       │
  │       └──▶ H-003 (Animated/highlighted state for active workflows)
  │
  ├──▶ H-004 [P] (Dropdown/popover list component)
  │       │
  │       └──▶ H-005 (Conversation navigation from dropdown entries)
  │
  H-003 + H-005
  │
  └──▶ H-006 (Wire tracker into workflow execution pipelines)
          │
          └──▶ H-007 (Settings integration — configurable N)
                  │
                  └──▶ H-008 (End-to-end validation & cleanup)
```

---

## Phase 0: Types & State Management

### H-001: WorkflowActivityTracker — in-memory execution list

**Description:** Implement the in-memory tracker that maintains the list of recent and active workflow executions for the activity indicator UI. This tracker wraps the `WorkflowConcurrencyManager` (F-020) execution state with UI-oriented query methods and an event-based notification system so the indicator can reactively update when execution state changes.

The tracker does NOT duplicate execution state — it subscribes to state changes from the `WorkflowConcurrencyManager` and provides UI-focused views (sorted, filtered, bounded by configurable N). It also emits change events so the indicator DOM can update efficiently.

**Files:**
- `src/workflows/workflow-activity-tracker.ts` — **New file**

**Dependencies:** F-020 (`WorkflowConcurrencyManager` — provides `getActiveExecutions()`, `getRecentExecutions()`, `updateStatus()`)

**Acceptance Criteria:**
- [ ] `WorkflowActivityTracker` class exported
- [ ] Constructor accepts `concurrencyManager: WorkflowConcurrencyManager` and `maxEntries: number` (from `settings.workflow_activity_indicator_count`, default 5)
- [ ] `getIndicatorEntries(): WorkflowExecution[]` — returns up to `maxEntries` entries, ordered by recency: currently running/waiting workflows first (sorted by `started_at` descending), then completed/errored/stopped workflows (sorted by `completed_at` descending). Delegates to `concurrencyManager.getActiveExecutions()` and `concurrencyManager.getRecentExecutions(maxEntries)`.
- [ ] `getActiveCount(): number` — returns the count of executions with status `"running"` or `"waiting_approval"`. Used by the numeric badge (H-002).
- [ ] `hasActiveWorkflows(): boolean` — returns `true` if any execution is in `"running"` or `"waiting_approval"` status. Used to toggle the animated indicator state (H-003).
- [ ] `hasWaitingApproval(): boolean` — returns `true` if any execution has status `"waiting_approval"`. Used for prominent approval-needed indicator styling.
- [ ] `onChange(callback: () => void): () => void` — registers a listener that fires whenever execution state changes (new execution submitted, status updated, execution completed). Returns an unregister function.
- [ ] `notifyChange(): void` — called by the concurrency manager (or wiring layer) whenever execution state changes. Fires all registered `onChange` callbacks.
- [ ] `updateMaxEntries(n: number): void` — updates the `maxEntries` limit at runtime (for settings changes without plugin reload)
- [ ] `destroy(): void` — clears all registered callbacks
- [ ] **Filtering rule per FR-53:** Only background (event-triggered) workflow executions appear. Manually triggered workflows that open directly in the chat panel are excluded. This is determined by the `WorkflowExecution.trigger_event` field — manually triggered executions (if any were tracked) would have trigger `"manual"`, but per F-020 design, only background executions are submitted to the concurrency manager, so this filtering is inherent.

---

## Phase 1: Indicator UI

### H-002: Activity indicator icon & badge in chat panel header

**Description:** Add a persistent workflow activity indicator element to the Notor chat panel header area. The indicator is always visible — it serves as both an activity signal and a quick-access point for recent workflow history. It includes a numeric badge that shows the count of active background workflows, hidden when no workflows are running.

**Files:**
- `src/ui/workflow-activity-indicator.ts` — **New file**
- `src/ui/chat-view.ts` — Add indicator to the chat panel header
- `styles.css` — Add indicator and badge styles

**Dependencies:** H-001

**Acceptance Criteria:**
- [ ] `WorkflowActivityIndicator` class exported, extending or composable with the chat view
- [ ] Constructor accepts `containerEl: HTMLElement` (the chat panel header), `tracker: WorkflowActivityTracker`
- [ ] Renders a clickable icon element (e.g., a workflow/activity icon using Obsidian's `setIcon()` API) in the chat panel header area, positioned consistently with existing header elements (gear icon, etc.)
- [ ] The indicator element has the CSS class `notor-workflow-activity-indicator` for styling
- [ ] **Numeric badge:** A `<span>` element with class `notor-workflow-activity-badge` overlaid on the icon. Displays the count of active background workflows (`tracker.getActiveCount()`). Hidden (CSS `display: none` or class toggle) when count is 0 per FR-53.
- [ ] **Always visible:** The indicator icon is rendered regardless of whether workflows are running — it is never hidden. When idle, it is static; when active, it is animated (H-003).
- [ ] Registers an `onChange` callback with the tracker to reactively update the badge count when execution state changes
- [ ] `render(): void` — creates or updates the indicator DOM
- [ ] `updateBadge(): void` — reads `tracker.getActiveCount()` and updates badge text/visibility
- [ ] `destroy(): void` — removes DOM elements and unregisters tracker callback
- [ ] The indicator is unobtrusive — small icon size, consistent with Obsidian's UI density
- [ ] Indicator is added to `chat-view.ts` during `onOpen()` and removed during `onClose()`

**CSS (in `styles.css`):**
- [ ] `.notor-workflow-activity-indicator` — flex/inline-flex container, cursor pointer, relative positioning for badge overlay, appropriate size (~20-24px icon)
- [ ] `.notor-workflow-activity-badge` — absolute positioned, small pill/circle, background color (accent or theme-aware), white text, font-size ~10-11px, hidden when empty via `.notor-workflow-activity-badge.is-hidden` or `[data-count="0"]`

### H-003: Animated/highlighted state for active workflows

**Description:** When workflows are actively running, the indicator shows an animated or highlighted state (e.g., a spinning icon, pulsing badge, or subtle CSS animation) to signal activity. When no workflows are running, the indicator is static/inactive. A distinct visual treatment for "waiting for approval" ensures the user notices when action is needed.

**Files:**
- `src/ui/workflow-activity-indicator.ts` — Add animation state management
- `styles.css` — Add animation keyframes and state classes

**Dependencies:** H-002

**Acceptance Criteria:**
- [ ] `updateAnimationState(): void` method added — reads `tracker.hasActiveWorkflows()` and `tracker.hasWaitingApproval()` and toggles CSS classes accordingly
- [ ] When `hasActiveWorkflows()` is `true` and `hasWaitingApproval()` is `false`: indicator icon has class `is-active` — a subtle animation (e.g., slow spin, pulse, or glow) signals background work is in progress
- [ ] When `hasWaitingApproval()` is `true`: indicator icon has class `is-waiting-approval` — a more prominent animation or color change (e.g., pulsing amber/orange badge, or a distinct attention-drawing style) signals that user action is needed
- [ ] When `hasActiveWorkflows()` is `false`: no animation classes applied — indicator is static/idle
- [ ] Animation state updates are driven by the `onChange` tracker callback (same as badge updates in H-002) — called in `updateBadge()` or a combined `update()` method
- [ ] Animations are CSS-only (no JavaScript timers) for performance and smooth rendering
- [ ] Animations respect `prefers-reduced-motion` media query — reduced or no animation when the user has motion sensitivity preferences enabled

**CSS (in `styles.css`):**
- [ ] `.notor-workflow-activity-indicator.is-active` — subtle animation, e.g., `animation: notor-pulse 2s ease-in-out infinite` or a gentle glow effect
- [ ] `.notor-workflow-activity-indicator.is-waiting-approval` — more prominent visual, e.g., amber/orange-tinted badge pulse, or a distinct border/shadow to draw attention
- [ ] `@keyframes notor-pulse` — a gentle scale/opacity pulse animation
- [ ] `@media (prefers-reduced-motion: reduce)` — disables or simplifies animations

---

## Phase 2: Dropdown & Navigation

### H-004 [P]: Dropdown/popover list component

**Description:** Implement the dropdown/popover that opens when the user clicks the activity indicator icon. The dropdown lists active and recently completed workflow executions with status badges, trigger source descriptions, and timestamps. Uses Obsidian's `Menu` API or a custom popover element positioned relative to the indicator.

**Files:**
- `src/ui/workflow-activity-dropdown.ts` — **New file**
- `styles.css` — Add dropdown styles

**Dependencies:** H-001 (tracker for data), H-002 (indicator element for positioning anchor)

**Acceptance Criteria:**
- [ ] `WorkflowActivityDropdown` class exported
- [ ] Constructor accepts `tracker: WorkflowActivityTracker` and an anchor element reference (the indicator icon) for positioning
- [ ] `open(anchorEl: HTMLElement): void` — creates and displays the dropdown, positioned below or near the anchor element. Uses Obsidian's `Menu` API or a custom absolutely-positioned `<div>` with class `notor-workflow-activity-dropdown`.
- [ ] `close(): void` — removes the dropdown from the DOM
- [ ] **Entry rendering:** For each `WorkflowExecution` from `tracker.getIndicatorEntries()`, renders a clickable row containing:
  - **Workflow name:** `execution.workflow_name` (e.g., "daily/review")
  - **Trigger source:** `execution.trigger_source` (e.g., "on-save: Research/Climate.md") — smaller/muted text
  - **Status badge:** Visual badge based on `execution.status`:
    - `"running"` → spinning/animated icon or "Running…" label with accent color
    - `"waiting_approval"` → "Waiting for approval" label with amber/warning color — prominent per FR-53
    - `"completed"` → checkmark icon or "Completed" label with success color
    - `"errored"` → error icon or "Errored" label with error color
    - `"stopped"` → stop icon or "Stopped" label with muted color
    - `"queued"` → clock/queue icon or "Queued" label with muted color
  - **Timestamp:** For active workflows: relative time since start (e.g., "2m ago"). For completed: completion timestamp or relative time.
- [ ] **Entry ordering:** Currently running/waiting workflows first (by `started_at` descending), then completed (by `completed_at` descending) — same ordering as `tracker.getIndicatorEntries()`
- [ ] **Empty state:** If no entries exist (no workflows have run since plugin load), show a brief message: "No recent workflow activity"
- [ ] **Dismiss behavior:** Dropdown closes when the user clicks outside it, presses Escape, or clicks the indicator icon again (toggle)
- [ ] Dropdown updates live while open — if a running workflow completes while the dropdown is visible, the entry updates. Driven by `tracker.onChange()` callback.
- [ ] `destroy(): void` — closes dropdown if open, unregisters any listeners

**CSS (in `styles.css`):**
- [ ] `.notor-workflow-activity-dropdown` — positioned absolutely or fixed, z-index above chat content, max-height with overflow-y scroll, background/border consistent with Obsidian theme, shadow/elevation for popover effect, min-width ~280px
- [ ] `.notor-workflow-activity-entry` — flex row, padding, hover highlight, cursor pointer, border-bottom separator
- [ ] `.notor-workflow-activity-entry .workflow-name` — primary text, truncate with ellipsis if long
- [ ] `.notor-workflow-activity-entry .trigger-source` — secondary/muted text, smaller font-size
- [ ] `.notor-workflow-activity-entry .status-badge` — inline badge with status-specific background color and text
- [ ] `.notor-workflow-activity-entry .timestamp` — muted text, right-aligned or after status

### H-005: Conversation navigation from dropdown entries

**Description:** Clicking on a workflow entry in the activity dropdown navigates the user to that workflow's conversation in the main Notor chat panel. This allows the user to review the full conversation, send follow-up messages, approve pending tool calls, or stop the workflow.

**Files:**
- `src/ui/workflow-activity-dropdown.ts` — Add click handlers to entries
- `src/ui/chat-view.ts` — Add or expose a method to switch to a specific conversation by ID

**Dependencies:** H-004

**Acceptance Criteria:**
- [ ] Each workflow entry in the dropdown has a click handler that:
  1. Calls a `switchToConversation(conversationId: string)` method on the chat view (or orchestrator) to display the workflow's conversation
  2. Closes the dropdown after navigation
  3. Reveals and focuses the chat panel if it is not currently visible
- [ ] `switchToConversation(conversationId)` is exposed by `chat-view.ts` (or the conversation manager) — loads the specified conversation's message history and makes it the active conversation in the chat panel
- [ ] If the conversation ID no longer exists (e.g., cleared between plugin reloads — unlikely since executions are in-memory), a non-blocking notice is surfaced: "Conversation not found" and the entry is treated as stale
- [ ] For workflows with status `"waiting_approval"`: clicking the entry navigates to the conversation where the pending tool call approval prompt is visible, allowing the user to approve or reject it. This is the primary mechanism for the user to unblock a paused background workflow per FR-53 and FR-45.
- [ ] For completed/errored workflows: clicking navigates to the full conversation history so the user can review what happened
- [ ] Navigation does not disrupt the current conversation's state — the user can navigate back to their previous conversation via normal conversation switching

---

## Phase 3: Wiring & Validation

### H-006: Wire tracker into workflow execution pipelines

**Description:** Connect the `WorkflowActivityTracker` to the `WorkflowConcurrencyManager` (F-020) so that execution state changes are propagated to the tracker and trigger UI updates. This wiring ensures the indicator stays in sync with actual workflow execution state.

**Files:**
- `src/workflows/workflow-concurrency.ts` — Add notification hooks for state changes
- `src/workflows/workflow-activity-tracker.ts` — Connect to concurrency manager notifications
- `src/main.ts` — Initialize tracker and wire it to concurrency manager and chat view

**Dependencies:** H-003, H-005, F-020 (concurrency manager), F-021 (background execution pipeline)

**Acceptance Criteria:**
- [ ] `WorkflowConcurrencyManager` emits notifications on state changes: extend `submit()`, `onComplete()`, and `updateStatus()` to call a registered notification callback (or emit an event) after mutating state
- [ ] `WorkflowActivityTracker` is initialized in `main.ts` with a reference to the `WorkflowConcurrencyManager`
- [ ] The tracker registers as a state change listener on the concurrency manager — whenever execution state changes, `tracker.notifyChange()` is called, which in turn fires all registered `onChange` callbacks (updating the indicator UI)
- [ ] The `WorkflowActivityIndicator` is created in `chat-view.ts` `onOpen()` with a reference to the tracker, and destroyed in `onClose()`
- [ ] State changes that trigger UI updates:
  - New execution submitted (`queued` or `running`) → badge count may increase, animation may start
  - Execution status updated (`running` → `waiting_approval`) → "waiting for approval" styling applied
  - Execution completed (`completed`, `errored`, `stopped`) → badge count decreases, entry moves to completed section, animation may stop
  - Queued execution starts (`queued` → `running`) → no visible change if already showing active count
- [ ] `destroy()` chain: on plugin unload, `tracker.destroy()` is called which clears callbacks; `indicator.destroy()` is called which removes DOM elements
- [ ] The indicator correctly reflects the concurrency manager's state immediately after wiring — if the plugin is reloaded and there are no executions, the indicator shows idle state with no entries

### H-007: Settings integration — configurable N

**Description:** Add the `workflow_activity_indicator_count` setting to the Notor settings UI and wire it to the tracker so changes take effect immediately without a plugin reload.

**Files:**
- `src/settings.ts` — Add the setting input in an appropriate section (near workflow concurrency limit)
- `src/workflows/workflow-activity-tracker.ts` — Accept runtime updates to `maxEntries`

**Dependencies:** H-006

**Acceptance Criteria:**
- [ ] A "Recent workflow entries" (or "Activity indicator history") numeric input is rendered in **Settings → Notor**, in the same section as the workflow concurrency limit setting
- [ ] The input reads from and writes to `settings.workflow_activity_indicator_count` (default: 5)
- [ ] Help text: "Number of recent workflow executions shown in the activity indicator dropdown."
- [ ] On settings save, calls `tracker.updateMaxEntries(settings.workflow_activity_indicator_count)` to update the tracker at runtime
- [ ] The dropdown immediately reflects the new N value — if N is reduced, excess entries are trimmed from the visible list; if N is increased, more history is available (up to what the concurrency manager retains)
- [ ] Input validation: minimum 1, maximum 50 (reasonable bounds). Non-numeric input is rejected or clamped.

### H-008: End-to-end validation & cleanup

**Description:** Validate the complete workflow activity indicator system end-to-end. Verify indicator visibility, badge counts, animation states, dropdown content, conversation navigation, and settings integration. Fix any integration issues discovered.

**Files:**
- All Group H files — integration testing and bug fixes
- Existing Group E and F files — verify no regressions

**Dependencies:** H-007

**Acceptance Criteria:**
- [ ] **Indicator always visible:** The activity indicator icon is rendered in the chat panel header at all times — when no workflows have run, when workflows are active, and when workflows have completed. It never disappears.
- [ ] **Badge count — zero active:** When no background workflows are running, the numeric badge is hidden (not "0").
- [ ] **Badge count — active workflows:** When 2 background workflows are running, the badge shows "2". When one completes, the badge updates to "1". When both complete, the badge hides.
- [ ] **Animation — idle state:** When no workflows are active, the indicator icon is static with no animation classes.
- [ ] **Animation — running state:** When at least one workflow is running (but none waiting for approval), the indicator has the `is-active` class and shows a subtle animation.
- [ ] **Animation — waiting for approval:** When at least one workflow has status `"waiting_approval"`, the indicator has the `is-waiting-approval` class with a more prominent visual treatment. This is the primary signal to the user that they need to act.
- [ ] **Dropdown — empty state:** When no workflows have executed since plugin load, clicking the indicator opens the dropdown with "No recent workflow activity" message.
- [ ] **Dropdown — active entries:** Running workflows appear at the top with "Running…" status badge and relative timestamp. Queued workflows show "Queued" status.
- [ ] **Dropdown — completed entries:** Completed workflows show checkmark/success badge, trigger source, and completion timestamp. Errored workflows show error badge with error context.
- [ ] **Dropdown — entry ordering:** Active workflows (running/waiting) sorted by start time (newest first), then completed (by completion time, newest first). Total entries bounded by configurable N.
- [ ] **Dropdown — live update:** If a workflow completes while the dropdown is open, the entry updates in place (status badge changes, timestamp updates) without requiring the user to close and reopen.
- [ ] **Conversation navigation — running workflow:** Clicking a running workflow entry opens its conversation in the chat panel. The user can see streaming LLM output and pending tool calls.
- [ ] **Conversation navigation — waiting for approval:** Clicking a "Waiting for approval" entry opens the conversation with the pending tool call approval UI visible. The user can approve/reject, and the workflow resumes.
- [ ] **Conversation navigation — completed workflow:** Clicking a completed workflow entry opens the full conversation history for review.
- [ ] **Settings — configurable N:** Changing `workflow_activity_indicator_count` in Settings from 5 to 3 immediately limits the dropdown to 3 entries. Changing to 10 shows up to 10 entries.
- [ ] **Manual workflows excluded:** Workflows triggered via command palette or slash-command do NOT appear in the activity indicator. Only background (event-triggered) workflows are shown per FR-53.
- [ ] **Plugin unload/reload:** All indicator DOM elements are cleaned up on plugin disable. No dangling event listeners. On re-enable, indicator renders fresh with no stale state.
- [ ] **Reduced motion:** When `prefers-reduced-motion: reduce` is active, animations are disabled or simplified.
- [ ] `npm run build` compiles without errors
- [ ] Plugin loads and unloads without errors in Obsidian console
- [ ] No visual regressions in the chat panel header layout

---

## Cross-Reference: Files Created & Modified

| File | Status | Tasks |
|------|--------|-------|
| `src/workflows/workflow-activity-tracker.ts` | **New** | H-001, H-006 |
| `src/ui/workflow-activity-indicator.ts` | **New** | H-002, H-003 |
| `src/ui/workflow-activity-dropdown.ts` | **New** | H-004, H-005 |
| `src/ui/chat-view.ts` | Modified | H-002, H-005 |
| `src/workflows/workflow-concurrency.ts` | Modified | H-006 |
| `src/settings.ts` | Modified | H-007 |
| `src/main.ts` | Modified | H-006 |
| `styles.css` | Modified | H-002, H-003, H-004 |

## Parallel Execution Opportunities

The following tasks can be implemented in parallel:

| Group | Tasks | Rationale |
|-------|-------|-----------|
| **Phase 1 + Phase 2 start** | H-002, H-004 | H-002 builds the indicator icon/badge; H-004 builds the dropdown. Both depend on H-001 but not on each other — the indicator and dropdown are separate DOM components that can be developed independently. H-003 extends H-002; H-005 extends H-004. |
| **Phase 1 animation + Phase 2 navigation** | H-003, H-005 | H-003 adds animation to the indicator (depends on H-002); H-005 adds click-to-navigate to the dropdown (depends on H-004). These touch different files and can proceed in parallel. |

**Recommended implementation order:**

```
Sprint 1:  H-001
Sprint 2:  H-002 | H-004
Sprint 3:  H-003 | H-005
Sprint 4:  H-006
Sprint 5:  H-007
Sprint 6:  H-008
```

## Design Decisions

| Decision | Rationale | Reference |
|----------|-----------|-----------|
| **Tracker wraps concurrency manager (no duplicated state)** | The `WorkflowConcurrencyManager` (F-020) already maintains `WorkflowExecution` state. The tracker provides UI-focused query methods and change notifications without duplicating the source of truth. This avoids state synchronization issues. | F-020 `getActiveExecutions()`, `getRecentExecutions()` |
| **`onChange` callback pattern for reactive updates** | The indicator DOM must update when execution state changes (new execution, status change, completion). A simple callback pattern avoids introducing a full reactive framework while keeping the UI responsive. Callbacks fire synchronously after state mutation. | FR-53 "reflects the count of active background workflows" |
| **CSS-only animations** | JavaScript-driven animations (timers, requestAnimationFrame) add complexity and can cause performance issues. CSS animations with `@keyframes` are GPU-accelerated, declarative, and automatically respect `prefers-reduced-motion`. | Performance best practice; FR-53 "animated state when workflows running" |
| **`prefers-reduced-motion` respect** | Users with motion sensitivity should not be subjected to constant pulsing/spinning animations. CSS media query makes this automatic with no code overhead. | Accessibility best practice |
| **Indicator always visible (not conditionally rendered)** | FR-53 explicitly states the indicator is "always displayed in the Notor chat panel header area" and "always visible regardless of whether workflows are currently running." This provides a consistent UI anchor for discovering recent workflow history even when nothing is currently active. | FR-53 acceptance criteria, bullets 1 and 3 |
| **Numeric badge hidden when zero** | Showing "0" provides no information and adds visual clutter. FR-53 states "the count badge is hidden but the indicator itself remains visible" when no workflows are running. | FR-53 acceptance criteria, last substantive bullet |
| **Only background workflows in indicator** | FR-53 explicitly states: "Manually triggered workflows that open directly in the chat panel do not appear in the activity indicator — it is exclusively for background event-triggered workflows." Manual workflows are already visible in the foreground chat panel and don't need secondary tracking. | FR-53 acceptance criteria, second-to-last bullet |
| **Dropdown uses custom DOM (not Obsidian Menu)** | Obsidian's `Menu` API is designed for simple context menus with text items. The activity dropdown needs rich content per entry (name, trigger source, status badge, timestamp) and live updates while open, which exceed `Menu`'s capabilities. A custom positioned `<div>` provides full control over layout and styling. | UI complexity; rich entry rendering requirement |
| **Configurable N with immediate effect** | `workflow_activity_indicator_count` controls how many entries appear in the dropdown. Making it configurable respects user preferences — power users may want more history, minimal users may want less. Immediate effect (no reload) via `tracker.updateMaxEntries()` follows the existing settings pattern. | FR-53 "configurable N, default: 5", "Changes take effect immediately" |
| **Conversation navigation as primary approval mechanism** | For background workflows waiting for approval, the activity indicator is the only way for the user to discover and navigate to the pending approval. Clicking the entry opens the conversation where the tool call approval UI is visible. This is explicitly called out in FR-53 and FR-45. | FR-53 "Click a workflow entry to open its conversation", FR-45 "user clicks into the workflow conversation via the activity indicator" |

## Readiness Checklist

### Prerequisites (from other groups)

- [ ] **Group E complete:** Manual workflow execution pipeline, conversation creation with `workflow_path`/`workflow_name`/`is_background` metadata, chat view with conversation display
- [ ] **Group F complete:** `WorkflowConcurrencyManager` (F-020) operational with `getActiveExecutions()`, `getRecentExecutions()`, `updateStatus()` methods; background workflow execution pipeline (F-021) creating background conversations; `WorkflowExecution` state tracking functional
- [ ] **Chat view available:** `src/ui/chat-view.ts` renders the chat panel header with existing controls (gear icon, provider/model selectors)

### Integration Points

| Integration | Source (Group H) | Target | Notes |
|-------------|-----------------|--------|-------|
| Execution state queries | H-001 `getIndicatorEntries()`, `getActiveCount()` | F-020 `getActiveExecutions()`, `getRecentExecutions()` | Tracker delegates to concurrency manager for source data |
| State change notifications | H-006 wiring | F-020 `submit()`, `onComplete()`, `updateStatus()` | Concurrency manager calls `tracker.notifyChange()` after state mutations |
| Indicator rendering | H-002 `WorkflowActivityIndicator` | `chat-view.ts` `onOpen()` / `onClose()` | Indicator created/destroyed with the chat panel lifecycle |
| Conversation navigation | H-005 click handler | `chat-view.ts` `switchToConversation()` | Opens a specific conversation by ID in the chat panel |
| Settings | H-007 | `src/settings.ts` | Adds `workflow_activity_indicator_count` input; calls `tracker.updateMaxEntries()` on save |
| Plugin lifecycle | H-006 | `src/main.ts` `onload()` / `onunload()` | Tracker initialized on load, destroyed on unload |

### Definition of Done

- [ ] All 8 tasks (H-001 through H-008) completed and acceptance criteria met
- [ ] Activity indicator is always visible in the chat panel header
- [ ] Numeric badge shows correct count of active background workflows; hidden when zero
- [ ] Animated state when workflows running; static when idle; prominent state when approval needed
- [ ] Dropdown shows up to N recent/active executions with correct status badges, trigger sources, and timestamps
- [ ] Clicking a dropdown entry navigates to the workflow's conversation in the chat panel
- [ ] "Waiting for approval" entries navigate to the conversation with the pending tool call visible
- [ ] Only background (event-triggered) workflows appear; manual workflows are excluded
- [ ] Configurable N in Settings takes effect immediately
- [ ] Animations respect `prefers-reduced-motion`
- [ ] All DOM elements cleaned up on plugin unload — no leaked listeners or orphaned elements
- [ ] `npm run build` compiles without errors
