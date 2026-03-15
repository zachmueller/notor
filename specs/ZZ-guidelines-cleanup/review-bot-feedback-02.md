# Plan: Obsidian Plugin Review Bot Feedback — Round 2

**Created:** 2026-03-15
**Source:** Automated scan of commit `c350aec` — results in `/Volumes/workplace/obsidian-feedback.md`
**Builds on:** `specs/ZZ-guidelines-cleanup/plan-review-bot-feedback.md` (GUIDE-011 through GUIDE-025)

## Overview

The second automated scan produced four findings. Two are genuinely new violations not caught or covered by the first-round plan. One is a small addition to an existing task scope. One is already fully tracked and simply awaiting implementation.

The bot scanned commit `c350aec` (pre-bugfix), which predates the recent MCP fix commits. None of those fixes addressed guidelines-cleanup tasks, so the scan reflects the current state of all guidelines-related files.

---

## Finding-to-Task Mapping

| Bot Finding | Files / Lines | Status | Action |
|---|---|---|---|
| Floating promises — no await / .catch / void | `conversation.ts:L124,L142,L247,L248,L310` | **NEW** | Amend GUIDE-013 |
| Async method `rescanWorkflows` has no `await` | `main.ts:L1086` (method at L1092) | **NEW** | Amend GUIDE-017 |
| Use sentence case for UI text (29 occurrences) | settings sections + mcp-status-indicator | Already tracked in GUIDE-023 | No new task — implement GUIDE-023 |
| Promise returned in void-context function argument | `mcp-servers.ts:L573–L576` | **NEW** | Amend GUIDE-013 |

---

## Amendments to Existing Tasks

### Amendment A — GUIDE-013: Add `conversation.ts` floating-promise sites

**Background:** The five flagged calls in `ConversationManager` were not in the original GUIDE-013-R audit list. The callbacks are typed as `(arg) => void | Promise<void>` — callers can pass async functions, making each invocation potentially a floating Promise.

**Lines:**
- `src/chat/conversation.ts:L124` — `this.onConversationChanged?.(conversation)`
- `src/chat/conversation.ts:L142` — `this.onConversationChanged?.(this.activeConversation)`
- `src/chat/conversation.ts:L247` — `this.onMessageAdded?.(message)`
- `src/chat/conversation.ts:L248` — `this.onConversationChanged?.(this.activeConversation)`
- `src/chat/conversation.ts:L310` — `this.onConversationChanged?.(this.activeConversation)`

**Classification (pre-researched, low risk):**

All five are fire-and-forget event notifications — the `ConversationManager` dispatches the event and has no need to wait for the listener's side-effects (UI re-render, history persistence) to complete before returning. The callbacks themselves are error-handled at their call sites in the callers. There is no ordering dependency between these calls and the lines that follow within `ConversationManager`.

**Correct fix for all five:** `void` prefix.

```typescript
// Before
this.onConversationChanged?.(conversation);

// After
void this.onConversationChanged?.(conversation);
```

**Acceptance criteria additions for GUIDE-013:**
- [x] All five `conversation.ts` callback invocations prefixed with `void`
- [x] No change to callback semantics — callers still receive notifications

---

### Amendment B — GUIDE-013: Add `mcp-servers.ts:L573–L576` void-context site

**Background:** `removeBtn.addEventListener("click", async () => { ... })` was not in the original GUIDE-013-R list of `no-misused-promises` sites for `mcp-servers.ts`. The line range was in a different function than the previously audited locations.

**Location:**
```typescript
// src/settings/sections/mcp-servers.ts:L573–L576
removeBtn.addEventListener("click", async () => {
    await onRemove();
    rowEl.remove();
});
```

**Classification:** `no-misused-promises` — async callback in a void-return event listener. Intent is correct: `onRemove()` must complete before `rowEl.remove()` is called. The `async` keyword is needed for the `await`. The fix is to wrap the async IIFE so the listener itself is synchronous.

**Correct fix:**
```typescript
removeBtn.addEventListener("click", () => {
    void (async () => {
        await onRemove();
        rowEl.remove();
    })();
});
```

**Acceptance criteria additions for GUIDE-013:**
- [x] `mcp-servers.ts:L573–L576` event listener no longer passes an async function to `addEventListener`
- [x] `onRemove()` is still awaited; `rowEl.remove()` still executes after it completes

---

### Amendment C — GUIDE-017: Add `rescanWorkflows` to async-without-await list

**Background:** `rescanWorkflows` in `src/main.ts` was not in the original GUIDE-017 table. The method is declared `async` and returns `Promise<Workflow[]>`, but its body contains no `await` expression — `discoverWorkflows(...)`, `evaluateListeners()`, and `syncJobs(...)` are all synchronous calls.

**Location:**
```typescript
// src/main.ts:L1092
async rescanWorkflows(): Promise<Workflow[]> {
    const workflows = discoverWorkflows(...);  // synchronous
    this._discoveredWorkflows = workflows;
    // ... synchronous state updates ...
    return workflows;
}
```

**Before implementing, verify:**
1. Search all callers of `rescanWorkflows()` — check whether any `await` the result. Removing `async` changes the return type from `Promise<Workflow[]>` to `Workflow[]`. Existing `await rescanWorkflows()` call sites are still valid (awaiting a non-Promise returns the value), but the type signatures at those sites should be updated for clarity.
2. Check whether any interface or base-class contract declares this method as returning `Promise<Workflow[]>`. If so, keep `async` (or return `Promise.resolve(workflows)`) to satisfy the interface rather than change the interface.

**Correct fix (if no interface constraint):**
```typescript
rescanWorkflows(): Workflow[] {
    const workflows = discoverWorkflows(...);
    this._discoveredWorkflows = workflows;
    // ...
    return workflows;
}
```

**Acceptance criteria additions for GUIDE-017:**
- [ ] `rescanWorkflows` has `async` removed and return type updated to `Workflow[]`
- [ ] All callers compile cleanly with the updated signature
- [ ] No interface or abstract method constraint violated

---

## Note on Sentence Case Findings (GUIDE-023)

The 29 sentence-case violations are a subset of what GUIDE-023 already tracks (53 occurrences from the first-round scan). The bot re-scanned the pre-fix commit, so these are unfixed violations that were already planned.

**One line that may be net-new:** `connection-test.ts:L100`. GUIDE-023 lists `L66` for that file; the bot now flags `L100`. These could be the same string whose line number shifted after code changes, or a genuinely separate violation in the description text. When implementing GUIDE-023, read both L66 and L100 in `connection-test.ts` and fix whichever strings are not in sentence case.

**No new task required.** Implement GUIDE-023 as specified in `plan-review-bot-feedback.md`.

---

## Revised Execution Order

No changes to the overall phase structure from the first-round plan. The three amendments slot into their parent tasks:

- **Amendment A + B** (GUIDE-013 additions): addressed when GUIDE-013 is implemented
  - Note: The `conversation.ts` sites do not require GUIDE-013-R research — they are pre-classified above as `void` fire-and-forget
- **Amendment C** (GUIDE-017 addition): addressed when GUIDE-017 is implemented
- **GUIDE-023**: unchanged — implement as planned

The first-round execution order from `plan-review-bot-feedback.md` remains correct. Amendments A, B, and C require no re-ordering.
