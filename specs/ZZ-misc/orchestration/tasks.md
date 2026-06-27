# Task Breakdown: Orchestration Engine (master)

**Created:** 2026-06-27
**Implementation Plan:** [plan.md](plan.md)
**Specification:** [spec.md](spec.md)
**Data Model:** [data-model.md](data-model.md)
**Research:** [research.md](research.md)
**Contracts:** [contracts/](contracts/)
**Checklist:** [checklists/requirements.md](checklists/requirements.md)
**Status:** Draft

This is the **master** task index. Task **bodies** (description, files, dependencies, acceptance
criteria) live in the per-phase files under [tasks/](tasks/). This file owns the phase→task mapping,
the design-phase cross-reference, the critical path, the parallelism groups, and the per-phase test
gate. Task IDs and their dependency edges defined here are authoritative; per-phase files must match.

## Task Summary

**Total tasks:** ~53 across 8 design phases
**Ships as:** one cohesive implementation (no phase independently shippable)
**Repo phase convention:** Setup → Foundation → Core → Integration → Quality → Polish
**Feature group:** `orchestration_enabled` (default off)

---

## Design-Phase ↔ Repo-Phase ↔ Task-File Mapping

| Design phase | Work area | Repo phase | Task file | Task IDs |
|---|---|---|---|---|
| **0** | Generalized RunLoop substrate | Setup + Foundation | [tasks/phase-0-runloop.md](tasks/phase-0-runloop.md) | ENV-001, ENV-002, ARCH-001…006 |
| **1** | Core engine + flow schema | Core | [tasks/phase-1-engine.md](tasks/phase-1-engine.md) | FEAT-001…011 |
| **2** | Session workspace + tasks + nav | Integration (Lane A) | [tasks/phase-2-session-nav.md](tasks/phase-2-session-nav.md) | INT-001…006 |
| **3** | Programmatic code steps | Integration (Lane B) | [tasks/phase-3-code-steps.md](tasks/phase-3-code-steps.md) | INT-010…013 |
| **4** | Progress notices | Integration (Lane C) | [tasks/phase-4-notices.md](tasks/phase-4-notices.md) | INT-020…021 |
| **5** | Interactive + step→workflow | Integration (Lane D) | [tasks/phase-5-interactive-workflow.md](tasks/phase-5-interactive-workflow.md) | INT-030…031 |
| **6** | Built-in flows + persona | Polish | [tasks/phase-6-builtins.md](tasks/phase-6-builtins.md) | POL-001, POL-002, DOC-001 |
| **7** | Composability + run-tree view | Integration (Lane E) + Polish | [tasks/phase-7-composability.md](tasks/phase-7-composability.md) | INT-040…047, POL-003, POL-004, VAL-001 |
| **Q** | Quality / tests | Quality | (per-phase, listed below) | TEST-001…008 |

> The repo's six-phase convention orders the *work*; the design's Phase 0–7 is carried as a tag on
> every task. Lanes A–E (design Phases 2–5, 7) are independent integration lanes that run concurrently
> once the Phase 1 core (FEAT-010) lands.

---

## Full Task Index (IDs + one-liners + dependencies)

Bodies in the linked per-phase files. `→` = depends on.

### Phase 0 — RunLoop (Setup + Foundation)

| ID | One-liner | Depends on |
|---|---|---|
| ENV-001 | Module scaffolds (`src/run-loop/`, `src/orchestration/`) + `orchestration_enabled` setting + default | — |
| ENV-002 | Feature-group registration (`FEATURE_GROUP_TOGGLES`) + `settings/sections/orchestration.ts` | ENV-001 |
| ARCH-001 | `RunContext` / `RunResult` / `RunLoopOptions` / `RunLoopHooks` types | ENV-001 |
| ARCH-002 | Lift loop into `RunLoop`; refactor `SubAgentRunner` to consume it | ARCH-001 |
| ARCH-003 | `runContext?` on `ToolExecuteOptions`; thread through dispatch + `executeToolBatches` | ARCH-001 |
| ARCH-004 | Replace recursion ban with `depth < maxDepth` check in `use-subagent` | ARCH-002, ARCH-003 |
| ARCH-005 | Two-layer budget helpers (`budget.ts`) + per-turn cost wiring via `calculateCost` | ARCH-002, ARCH-004 |
| ARCH-006 | Shared `Semaphore` generalized into the run-loop layer | ARCH-002 |
| ARCH-007 | Pure `resolvePersonaProviderConfig(...)` → session-pinned provider/model (no global registry mutation) | ARCH-001 |

### Phase 1 — Core engine (Core)

| ID | One-liner | Depends on |
|---|---|---|
| FEAT-001 | Orchestration domain types (`src/orchestration/types.ts`) | ENV-001, ARCH-001 |
| FEAT-002 | `FlowDefinitionParser` + `StepNoteParser` | FEAT-001 |
| FEAT-006 | `SessionLog` writer (append-only JSONL + write order) | FEAT-001 |
| FEAT-003 | `OrchestrationEventEngine` (pub/sub + wildcard, write-before-route) | FEAT-001, FEAT-006 |
| FEAT-004 | `FallbackCoordinator` (`*` subscriber, pure backstop → `FLOW_ERROR`) | FEAT-003 |
| FEAT-005 | `StepPromptBuilder` (scaffold + always-inject must-publish) | FEAT-001 |
| FEAT-009 | `emit_event` built-in tool scaffold (gated) | ENV-002, FEAT-001 |
| FEAT-007 | `StepTurnExecutor` (conversation path on `RunLoop`, persona wiring) | ARCH-002, ARCH-005, ARCH-007, FEAT-002, FEAT-005, FEAT-006, FEAT-009 |
| FEAT-008 | `LoopSafetyGuards` (iteration/runtime/stale/thrashing) | FEAT-001, FEAT-003 |
| FEAT-010 | `OrchestrationRunner` main loop | FEAT-002, FEAT-003, FEAT-004, FEAT-007, FEAT-008 |
| FEAT-011 | Command palette "Run Orchestration" + flow picker | FEAT-010, ENV-002 |

### Phase 2 — Session/nav (Integration, Lane A)

| ID | One-liner | Depends on |
|---|---|---|
| INT-001 | `OrchestrationSessionManager` (session dir + scratchpad + path auto-allow) | FEAT-006, FEAT-010 |
| INT-002 | 4 task tool scaffolds (ensure/start/close/list), gated | ENV-002, INT-001 |
| INT-003 | `FLOW_COMPLETE` task enforcement | INT-002, FEAT-010 |
| INT-004 | Persistent `memories.md` | INT-001, FEAT-005 |
| INT-005 | Session recovery on reload (idempotent replay) | INT-001, FEAT-006, FEAT-010 |
| INT-006 | `orchestration_edges` schema + hidden-from-list filter | FEAT-007, INT-001 |

### Phase 3 — Code steps (Integration, Lane B)

| ID | One-liner | Depends on |
|---|---|---|
| INT-010 | `CodeStepExecutor` (Sucrase pipeline + timeout) | FEAT-007 |
| INT-011 | `OrchestrationHelper` runtime API | INT-010, INT-001, INT-002 |
| INT-012 | `FLOW_CANCELLED` terminal event (bypasses task enforcement) | FEAT-010, INT-010, INT-003 |
| INT-013 | Code-step guidance (carried into POL-001 / DOC-001) | INT-011 |

### Phase 4 — Notices (Integration, Lane C)

| ID | One-liner | Depends on |
|---|---|---|
| INT-020 | Per-turn progress Notice synthesis | FEAT-010 |
| INT-021 | Right-click Notice → jump to step conversation | INT-020, INT-006 |

### Phase 5 — Interactive + workflow (Integration, Lane D)

| ID | One-liner | Depends on |
|---|---|---|
| INT-030 | `user.input.required` pausing event | FEAT-010, INT-005 |
| INT-031 | Step-to-workflow invocation | FEAT-007 |

### Phase 6 — Built-ins (Polish)

| ID | One-liner | Depends on |
|---|---|---|
| POL-001 | `orchestration-creator` built-in persona | FEAT-002, INT-040 |
| POL-002 | Reference flows (code-assist, research, review) | FEAT-010, INT-010, INT-040 |
| DOC-001 | Docs + persona/tool-creator updates | POL-001, INT-011 |

### Phase 7 — Composability + run-tree (Integration Lane E + Polish)

| ID | One-liner | Depends on |
|---|---|---|
| INT-040 | Composition frontmatter + parser extension | FEAT-002 |
| INT-041 | `FlowCompositionManager` (stateless re-scan) | INT-040 |
| INT-042 | `run_flow` tool (dynamic `flow` enum + loose payload), gated | INT-041, ENV-002 |
| INT-043 | Flow-as-tool execution on child `RunLoop` + structured-return capture | INT-042, ARCH-002, ARCH-005, INT-046 |
| INT-044 | Child session + `parent_session_id` + isolation modes | INT-001, INT-043 |
| INT-045 | Chaining at terminal event + input-description injection + optional code adapter | INT-040, INT-043, INT-010 |
| INT-046 | Cascading guardrails + `max_depth` on `RunContext` | ARCH-005, INT-043 |
| INT-047 | Generalize `sub_agent_metadata` → shared `child_run_metadata` | INT-006, INT-043 |
| POL-003 | Unified run-tree `ItemView` leaf + inline peek card (new chat UI) | INT-006, INT-047, FEAT-010 |
| POL-004 | Unified activity indicator (typed entries) | POL-003 |
| VAL-001 | End-to-end validation against [quickstart.md](quickstart.md) | POL-003, TEST-008 |

### Quality — Tests (cross-cutting)

| ID | One-liner | Gate for |
|---|---|---|
| TEST-001 | RunLoop regression gate (existing sub-agent suites green) + `run-loop.test.ts` + `budget.test.ts` | ARCH-002/004/005 — **release blocker** |
| TEST-002 | Event-engine / fallback / safety unit tests | FEAT-003/004/008 |
| TEST-003 | Flow/step parser unit tests | FEAT-002 |
| TEST-004 | Code-step executor + `OrchestrationHelper` unit tests | INT-010/011 |
| TEST-005 | Session-recovery idempotency (truncated-log replay) | INT-005 |
| TEST-006 | Composition unit tests (`run_flow` enum, structured-vs-text, budget/`max_depth`, edge DAG, `child_run_metadata` back-compat) | INT-042…047 |
| TEST-007 | e2e: single flow → `FLOW_COMPLETE`, steps hidden from flat list | FEAT-010 + Lane A |
| TEST-008 | e2e: `run_flow` child + structured return + run-tree live→static | Lane E + POL-003 |

---

## Critical Path

The longest dependency chain through the feature:

```
ENV-001 → ARCH-001 → ARCH-002 → ARCH-004 → ARCH-005
        → FEAT-007 → FEAT-010
        → INT-006 (edges) → INT-043 (flow-as-tool) → INT-047 (child_run_metadata)
        → POL-003 (run-tree view) → TEST-008 → VAL-001
```

**Narrowest waists:** `ARCH-002` (the behavior-preserving loop lift — everything LLM-executing depends
on it) and `FEAT-010` (the runner — every integration lane funnels through it). The Phase-7 tail
(`INT-043 → INT-047 → POL-003`) is the long pole: the run-tree view cannot render until both the edge
schema (INT-006) and the shared metadata shape (INT-047) exist.

## Parallelism Groups

- **After ARCH-001:** ARCH-003 runs parallel to ARCH-002 (different files; both need only the types).
  ARCH-007 (pure persona provider/model resolver) also needs only ARCH-001 and runs in parallel.
- **After FEAT-001:** FEAT-002 (parsers), FEAT-005 (prompt builder), FEAT-006 (session log), FEAT-008
  (safety) are four independent tracks.
- **After FEAT-010:** Lane A (session/nav), Lane B (code steps), Lane C (notices), Lane D (interactive)
  run concurrently. Lane B and Lanes C/D share only INT-001.
- **Within Phase 7:** INT-040 → INT-041 is serial; once INT-043 lands, INT-044 and INT-046 proceed in
  parallel.
- **Quality:** TEST-001 can be authored the moment ARCH-002 is in progress (it *is* the existing
  suite). TEST-002/003/004 parallelize across Core / Lane-B work.

## Per-Phase Test Gate

| Phase | Gate |
|---|---|
| 0 | **TEST-001 is a release blocker.** Existing sub-agent suites must pass unmodified; add `run-loop.test.ts` + `budget.test.ts`. No orchestration code merges until green. |
| 1 | TEST-002 + TEST-003 green; `step-prompt-builder` asserts must-publish always injected. |
| 2 | TEST-005 (recovery idempotency) green; `history` test confirms step conversations hidden from list. |
| 3 | TEST-004 green (fence extraction, timeout, error→`{step}.code_error`, helper dispatch). |
| 4–5 | Notice synthesis unit; pause/resume + paused-session recovery; context-menu jump in e2e. |
| 7 | TEST-006 green (incl. `child_run_metadata` back-compat parse + edge-DAG no-cycle invariant). |
| All | TEST-007 + TEST-008 e2e green; VAL-001 walks [quickstart.md](quickstart.md) end-to-end. |

---

## Sequencing-Risk Register

The hazards that govern ordering (full rationale in [plan.md](plan.md)):

1. **RunLoop extraction must be behavior-preserving (highest severity).** Gate ARCH-002/004/005 on the
   three sub-agent test files; do not touch the runner until they pass.
2. **Depth seed before ban removal.** ARCH-003 (default `runContext`, `maxDepth=0` for sub-agents) must
   land before ARCH-004 removes `_isSubAgentContext`, or nested sub-agents silently become possible.
3. **Cost reachability.** `budget.ts` imports only `calculateCost` + settings — no orchestrator deps.
4. **`orchestration_edges` (INT-006) before run-tree (POL-003);** hide step conversations the moment
   they're written (FEAT-007) or the flat sidebar fills with noise.
5. **`child_run_metadata` (INT-047) is a back-compat superset, not a breaking rename;** before POL-003.
6. **Feature-group gating (ENV-002) before any scaffold registration** (FEAT-009, INT-002, INT-042).
7. **Inline peek card is NEW UI** (scope risk in POL-003) — not a reuse of the HTML-export card.
8. **`FLOW_CANCELLED` (INT-012) must bypass `FLOW_COMPLETE` enforcement (INT-003)** — INT-003 first.
9. **Recovery idempotency (INT-005) ⇄ interactive pause (INT-030)** — treat paused-on-input as a
   recoverable log state; INT-005 before INT-030.
10. **Chaining adapter (INT-045) depends on code steps (INT-010)** — don't parallelize across Lane B.
11. **Finalize `use-subagent.ts` (Phase 0) before `run_flow` (INT-042) mirrors its dynamic-tool
    pattern.**
12. **Parent-rooted recovery (FR-125) — root-only scan in INT-005, child reconciliation in INT-044.**
    Recovery's top-level scan recovers only root sessions (`origin: "user"`); child sessions
    (`origin ∈ {run_flow, chaining}`) are reconciled by the parent's replay (reuse a terminal child's
    result, or tombstone-and-respawn a non-terminal one) — never recovered independently, or a crash
    mid-`run_flow` duplicates the child. INT-005 defines the root-only contract; INT-044 (composition)
    wires the reuse/respawn. `once(...)` keys are per-session and cannot dedupe a respawn, so the
    parent-rooted rule is the mechanism, not per-effect guarding.
13. **Session-pinned provider/model (ARCH-007) before any concurrent step turn (FEAT-007).** Step turns
    must resolve provider/model via the pure `resolvePersonaProviderConfig(...)` pinned into the
    `ConversationSession` — never the global-mutating `applyProviderModelOverrides()` — or concurrent
    step turns / `run_flow` children clobber each other's model. ARCH-007 is a Phase-0 correctness
    prerequisite for FEAT-007; see [research.md](research.md) Finding 5.
