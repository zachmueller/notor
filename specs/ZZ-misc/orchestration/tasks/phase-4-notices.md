# Tasks — Phase 4 / Lane C: Progress Notices

**Created:** 2026-06-27
**Specification:** [spec.md](../spec.md) — FR-140 group (progress notices)
**Data Model:** [data-model.md](../data-model.md)
**Master task index:** [tasks.md](../tasks.md) — Phase 4 (Integration, Lane C): INT-020, INT-021
**Contracts:** [contracts/run-loop.md](../contracts/run-loop.md) (the `onTurnComplete` hook these Notices fire from), [contracts/edges.md](../contracts/edges.md) (conversation-id resolution + run-tree surfacing)
**Status:** Draft

This file carries the **bodies** (description, FRs, files, dependencies, acceptance criteria) for the
two Lane C tasks. The master [tasks.md](../tasks.md) owns the authoritative IDs and dependency edges;
the IDs and `→` edges below are reproduced from it and must stay byte-consistent.

---

## Lane overview

Lane C is the **user-visibility** lane for a running flow. It is the smallest integration lane — two
tasks — and depends only on the runner (`FEAT-010`) plus, for the jump-in affordance, the edge/hide
work in Lane A (`INT-006`). It runs concurrently with Lanes A/B/D once the Phase 1 core
(`FEAT-010`) lands (see [tasks.md](../tasks.md) Parallelism Groups: "After FEAT-010: Lane A
(session/nav), Lane B (code steps), Lane C (notices), Lane D (interactive) run concurrently").

Both tasks are **Obsidian-`Notice`-layer** work that reuses two precedents verbatim:

- **`Notice` construction + right-click affordance** — `src/tool-config/notices.ts`:
  `showToolConfigError()` (`~25-40`) and especially `showDraftSavedNotice()` (`~52-65`), whose
  `messageEl.oncontextmenu` + `Platform.isDesktop` guard is the exact pattern INT-021 mirrors.
- **Conversation navigation** — `switchToConversationById()` (`src/chat/conversation-lifecycle.ts:488`,
  re-exported `src/chat/orchestrator.ts:741`) and the `notor-conversation://{id}` link primitive
  (`src/ui/message-renderer.ts:957` `activateConversationLinks()`).

### The Notice synthesis seam (where INT-020 fires from)

The progress Notice is **not** open-coded inside the runner loop. It fires from the `RunLoop`
`onTurnComplete(turn, result: TurnOutcome)` hook, which [contracts/run-loop.md](../contracts/run-loop.md)
defines as the orchestration attachment point: *"After a turn's tool batch settles … synthesize the
per-turn progress Notice (FR-140); roll up token usage."* `OrchestrationRunner` (FEAT-010) supplies
the `RunLoopHooks` to `StepTurnExecutor`; INT-020 adds the Notice-synthesis call inside the
`onTurnComplete` body it already owns, alongside the `turn.complete` session-log write. This keeps the
Notice out of the `RunLoop` engine (the engine never imports `obsidian`'s `Notice`) and confines it to
the orchestration consumer — consistent with the hook contract ("Notices stay out of the engine").

> **Code steps do not fire a per-turn Notice the same way.** A `notor-step-mode: code` step runs no
> `RunLoop` turn and produces no `onTurnComplete`; it has its own error Notice path
> (`{step}.code_error`, FR-130 / INT-010). INT-020 covers **conversation-step** turns. A code step's
> routing still appears in the run-tree's live updates (FR-178), so visibility is not lost.

### Cross-cutting concern — Notice fatigue (governs both tasks)

A heavily-looping flow (e.g. `notor-max-iterations: 100`) would otherwise emit up to one Notice per
turn — a wall of toasts that buries the signal and trains the user to ignore them. Both tasks must be
authored against this concern:

- The per-turn Notice (INT-020) MUST be **suppressible / rate-limitable**, and the run-tree's **live
  updates** (FR-178, `WorkflowActivityTracker.onChange()` over the `session-log.jsonl` write points)
  are the always-on, non-intrusive progress surface. Notices are the *opt-in interrupt*; the run-tree
  is the *ambient monitor*. INT-020 must not assume the Notice is the only progress channel.
- Suppression is a property of INT-020 (it decides whether to materialise a `Notice`), not of the
  runner or the hook. When suppressed, the turn still writes `turn.complete` and still updates the
  run-tree — only the toast is withheld.

---

## INT-020 — Per-turn progress Notice synthesis

**Design phase:** 4 · **Repo phase:** Integration (Lane C) · **Depends on:** `FEAT-010`

### Description

After each **conversation-step** turn completes, synthesize a brief progress `Notice` that names the
flow, the step, and the iteration, plus a one-line summary of what the turn accomplished and what comes
next (the just-emitted event topic). The Notice is built in the orchestration consumer's
`onTurnComplete(turn, result: TurnOutcome)` hook body — the same place that writes the `turn.complete`
session-log entry — so the engine stays Notice-free
(see [contracts/run-loop.md](../contracts/run-loop.md), Hooks table).

Reuse the `Notice` shape from `src/tool-config/notices.ts` (a short multi-line message + a numeric
timeout); a new exported helper (`showOrchestrationProgressNotice(...)`, in
`src/orchestration/notices.ts`) keeps the markup consistent with `showDraftSavedNotice()` and gives
INT-021 a single function to extend with the right-click handler.

**Message content (the AC contract):** the Notice names **flow + step + iteration**, drawn from the
step turn's context (`orchestration_flow_name` / `orchestration_step_name` / `orchestration_iteration`
— the same fields written to the conversation header per [contracts/edges.md](../contracts/edges.md) §1).
The "what's next" line is the topic the turn emitted (or the synthesized `default_publishes` topic, per
FR-115). Example: `[Code Implementation] 📋 Planner · iter 3 → tasks.ready`.

**Notice-fatigue handling (required, not optional — see Lane overview):** the synthesizer must support
**suppression / rate-limiting** so a long-running loop does not emit one toast per turn. The exact
policy is an implementation choice (e.g. only the first turn of each step, or coalesce within a short
window, or a per-flow "quiet" flag), but the design constraint is fixed: when a turn's Notice is
suppressed, the turn still writes `turn.complete` and still updates the live run-tree
(`WorkflowActivityTracker.onChange()`); only the toast is withheld. The run-tree is the always-on
progress surface; the Notice is the opt-in interrupt.

### Functional Requirements

- **FR-140** — Per-turn progress Notice (each turn synthesizes a Notice naming the flow, step, and
  iteration).

### Files

| File | Change |
|---|---|
| `src/orchestration/notices.ts` | **New.** `showOrchestrationProgressNotice({ flowName, stepName, iteration, emittedTopic, ... })` — mirrors the `Notice` construction in `src/tool-config/notices.ts` (`showDraftSavedNotice` ~52-65). Holds the suppression/rate-limit policy. Built to be extended by INT-021 (it owns the `oncontextmenu` attach point). |
| `src/orchestration/step-turn-executor.ts` | In the `onTurnComplete` hook body it supplies to `RunLoop` (FEAT-007/FEAT-010 wiring), call `showOrchestrationProgressNotice(...)` after capturing the emitted/default-published topic, passing flow/step/iteration + topic. No engine change. |
| `src/orchestration/runner.ts` | (If the hook is assembled at the runner level rather than the executor) thread the flow name + iteration counter into the `RunLoopHooks` it constructs. Owner of the per-flow suppression flag if a flow-scoped policy is chosen. |
| `src/orchestration/notices.test.ts` | **New.** Unit-test the message synthesis (flow + step + iteration + topic present) and the suppression/rate-limit policy. |

> No change to `src/run-loop/` — the engine never constructs a `Notice`. The Notice is attached purely
> through the `onTurnComplete` hook the orchestration layer already owns
> ([contracts/run-loop.md](../contracts/run-loop.md): "All hooks are optional. Sub-agents pass no
> persistence hooks" — and never a Notice hook either).

### Dependencies

- **`FEAT-010`** (`OrchestrationRunner` main loop) — the runner is what owns/assembles the
  `RunLoopHooks` (`onTurnComplete`) the Notice fires from, and supplies the flow name + iteration. This
  matches the edge in [tasks.md](../tasks.md) (INT-020 → FEAT-010).

### Acceptance Criteria

- **AC-1 (FR-140):** Each completed conversation-step turn synthesizes a progress `Notice` whose
  message contains the **flow name**, the **step name**, and the **iteration number**.
- **AC-2:** The "what's next" line names the topic the turn emitted (or the synthesized
  `default_publishes` topic when the step emitted nothing).
- **AC-3:** The Notice is produced from the `onTurnComplete` hook, **not** from `src/run-loop/` — the
  `RunLoop` engine constructs no `Notice` (verifiable: `src/run-loop/` imports no `Notice` from
  `obsidian`).
- **AC-4 (Notice fatigue):** Under a heavily-looping flow the synthesizer suppresses / rate-limits
  per-turn Notices per its policy; a suppressed turn still writes `turn.complete` and still drives the
  live run-tree update, so progress remains observable without toast spam.
- **AC-5:** Code steps (which produce no `onTurnComplete`) do not emit a per-turn progress Notice via
  this path; their error path (`{step}.code_error`, INT-010) is unaffected.
- **Gate:** [tasks.md](../tasks.md) Phase 4–5 gate — "Notice synthesis unit" — `notices.test.ts`
  asserts the flow/step/iteration message contract and the suppression policy.

---

## INT-021 — Right-click Notice → jump to step conversation

**Design phase:** 4 · **Repo phase:** Integration (Lane C) · **Depends on:** `INT-020`, `INT-006`

### Description

On **desktop**, right-clicking a progress Notice (the one INT-020 synthesizes) opens that turn's step
conversation in the chat. This reuses the established Notice right-click pattern verbatim —
`messageEl.oncontextmenu` guarded by `Platform.isDesktop`, exactly as `showDraftSavedNotice()`
(`src/tool-config/notices.ts:52-65`) does for "switch back to the previous conversation". The append to
the message of a `(right-click to open step conversation)` hint is the same desktop-only convention
those helpers use.

Navigation resolves the step turn's `conversation_id` and calls
`switchToConversationById(conversationId)` (`src/chat/conversation-lifecycle.ts:488`, re-exported at
`src/chat/orchestrator.ts:741`) — the same primitive behind the `notor-conversation://{id}` chat link
(`src/ui/message-renderer.ts:957`). The step conversation's id is the one written to the orchestration
conversation header by FEAT-007 / INT-006 (`orchestration_edges` + the `orchestration_*` header fields,
[contracts/edges.md](../contracts/edges.md) §1); INT-021 carries that id into the Notice synthesizer so
the handler has a concrete target. **This is why INT-021 depends on INT-006:** the step conversation
must be written *and discoverable by id* (and hidden from the flat list — INT-006's second half) before
a Notice can jump into it. Jumping to a conversation that the flat sidebar excludes is precisely the
case the run-tree + this Notice exist to serve.

**Mobile parity:** mobile **omits** the right-click affordance and the hint line, exactly as the
existing `notices.ts` helpers do (the `Platform.isDesktop` guard). The Notice still appears on mobile;
it just is not right-clickable.

INT-021 **extends** the `src/orchestration/notices.ts` helper INT-020 created — it does not add a second
Notice. The synthesizer gains an `onJumpToConversation` callback (and the `conversationId` to target),
attaching `messageEl.oncontextmenu` only when `Platform.isDesktop`.

### Functional Requirements

- **FR-141** — Right-click Notice jump-in (desktop right-click opens the step's conversation, reusing
  the `oncontextmenu` Notice pattern + `switchToConversationById`; mobile omits the affordance).

### Files

| File | Change |
|---|---|
| `src/orchestration/notices.ts` | Extend `showOrchestrationProgressNotice(...)` (from INT-020) to accept `{ conversationId, onJumpToConversation }`. When `Platform.isDesktop`, set `notice.messageEl.oncontextmenu = () => onJumpToConversation()` and append the `(right-click to open step conversation)` hint — mirroring `showDraftSavedNotice` (`~52-65`). |
| `src/orchestration/step-turn-executor.ts` (or `runner.ts`) | Pass the just-created step conversation's id + a jump callback into the synthesizer. The callback closes over the chat orchestrator's `switchToConversationById(conversationId)` (`src/chat/orchestrator.ts:741`). |
| `src/orchestration/notices.test.ts` | Add desktop-vs-mobile cases: desktop attaches `oncontextmenu` and invokes the jump callback with the right `conversationId`; mobile attaches no handler and adds no hint. |

> Reuses, does **not** reimplement: `switchToConversationById` (`src/chat/conversation-lifecycle.ts:488`)
> and the `Platform.isDesktop` + `messageEl.oncontextmenu` idiom (`src/tool-config/notices.ts`). No new
> navigation primitive is introduced — the same path the `notor-conversation://` link uses.

### Dependencies

- **`INT-020`** — INT-021 extends the very Notice INT-020 synthesizes (the right-click handler is added
  to that helper). Edge per [tasks.md](../tasks.md) (INT-021 → INT-020).
- **`INT-006`** (`orchestration_edges` schema + hidden-from-list filter) — the step conversation must
  be written with a discoverable `conversation_id` (and excluded from the flat sidebar) before a Notice
  can navigate to it. The run-tree / this Notice are the *only* navigational entry points for hidden
  step conversations ([contracts/edges.md](../contracts/edges.md) §4). Edge per [tasks.md](../tasks.md)
  (INT-021 → INT-020, INT-006).

### Acceptance Criteria

- **AC-1 (FR-141):** On desktop, right-clicking the progress Notice navigates to the step's conversation
  via `switchToConversationById(conversationId)` — the same conversation written by FEAT-007/INT-006.
- **AC-2 (FR-141):** On mobile, the Notice carries **no** right-click affordance and no hint line
  (consistent with the existing `notices.ts` helpers and their `Platform.isDesktop` guard).
- **AC-3:** The target id is the step conversation's id from the orchestration conversation header
  ([contracts/edges.md](../contracts/edges.md) §1); right-clicking a Notice for a step conversation that
  is hidden from the flat list (INT-006) still opens it.
- **AC-4:** No new navigation primitive is added — the jump reuses `switchToConversationById`
  (`src/chat/conversation-lifecycle.ts:488` / `src/chat/orchestrator.ts:741`), the same path as
  `notor-conversation://`.
- **AC-5 (Notice fatigue, inherited):** When INT-020's policy suppresses a turn's Notice, there is no
  Notice to right-click for that turn; the run-tree (FR-178) remains the reachable navigation surface.
- **Gate:** [tasks.md](../tasks.md) Phase 4–5 gate — "context-menu jump in e2e"; the `notices.test.ts`
  desktop/mobile unit cases plus an e2e assertion that a right-click opens the hidden step conversation.

---

## Lane C exit check

- [ ] INT-020: per-turn progress Notice names flow + step + iteration + next topic, fired from
  `onTurnComplete` (engine stays Notice-free), with a working suppression/rate-limit policy.
- [ ] INT-021: desktop right-click opens the step conversation via `switchToConversationById`; mobile
  omits the affordance; targets the INT-006 step-conversation id even though it is hidden from the flat
  list.
- [ ] The run-tree (FR-178, POL-003) — not these Notices — is the always-on progress surface; Notices
  are the opt-in interrupt, suppressible under heavy looping.
