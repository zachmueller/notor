# Specification Quality Checklist: Orchestration Engine

**Purpose:** Validate specification completeness and quality before proceeding to implementation
**Created:** 2026-06-27
**Feature:** [spec.md](../spec.md)
**Data Model:** [data-model.md](../data-model.md)
**Tasks:** [tasks.md](../tasks.md)
**Contracts:** [contracts/](../contracts/)

## Content Quality
- [ ] No implementation details leak into the user-facing sections (Overview, User Stories, Scope)
- [ ] Focused on user value and operator workflows (autonomous multi-step runs, observability, safety)
- [ ] All mandatory sections completed (Overview, User Stories, Functional Requirements, Key Entities, Out of Scope, Dependencies & Assumptions)
- [ ] Generalized terminology used throughout (orchestration / flow / step / persona / event) — no "hat" terms carried over from [specs/05-ralph/spec.md](../../../05-ralph/spec.md)

## Requirement Completeness
- [ ] No [NEEDS CLARIFICATION] markers remain
- [ ] Every functional requirement is testable and unambiguous
- [ ] Every FR has at least one acceptance criterion (AC) stated inline
- [ ] Acceptance criteria are observable (state changes, files written, events routed, tool results)
- [ ] All seam assumptions verified against HEAD `68f606e` (see [research.md](../research.md))
- [ ] Edge cases identified (orphaned event, stale loop, thrashing, no-emit turn, code-step error, cap exhaustion → `{step}.capped` (FR-117a), interrupted/paused reload, parent-rooted recovery of `run_flow` children, scratchpad overwrite-idempotency, dangling edges after re-run, multi-step cycle / completion-alternation bounded by budget/runtime, concurrent step turns pinning distinct models)
- [ ] Scope is clearly bounded (Out of Scope (v1) enumerates step-subgraph reuse, run-tree node actions, per-node live summaries, aged-out Runs surface, `notor-workflow` migration)
- [ ] Dependencies and assumptions identified (personas, feature-groups, tool-config/path-enforcement, Sucrase compile pipeline, chat history/session model, `WorkflowActivityTracker`/`Notice`)

## Feature Readiness
- [ ] All functional requirements have clear acceptance criteria
- [ ] User scenarios cover the primary flows (implementation loop, research flow, authoring flows, per-step navigation, code steps, recovery, pause/resume, composition, run-tree)
- [ ] Type shapes are defined in [data-model.md](../data-model.md) and not redefined elsewhere
- [ ] The conversation-edge model (`orchestration_edges`) and `child_run_metadata` are sourced from the single authority [contracts/edges.md](../contracts/edges.md)
- [ ] The two-layer limit rule and `RunLoop` hook semantics are sourced from [contracts/run-loop.md](../contracts/run-loop.md)
- [ ] No implementation detail in the spec contradicts the contracts
- [ ] The whole subsystem is gated behind `orchestration_enabled` (default off, mirrors `memory_enabled`)

## Functional Requirement Coverage

One checkbox per FR group. Each names the group and its implementing task IDs from [tasks.md](../tasks.md).
Verify every cited ID exists in tasks.md with the same dependency edges.

- [ ] **FR-100 group — Generalized RunLoop substrate** (FR-100…FR-106): `ENV-001`, `ENV-002`, `ARCH-001`, `ARCH-002`, `ARCH-003`, `ARCH-004`, `ARCH-005`, `ARCH-006`, `ARCH-007` — [tasks/phase-0-runloop.md](../tasks/phase-0-runloop.md). Behavior-preserving lift of `SubAgentRunner`'s loop into `src/run-loop/`; `RunContext` on the dispatch seam; depth model replaces the recursion ban; two-layer budget (aggregate `iterationsRemaining` counts **LLM turns only**); shared `Semaphore`; **`ARCH-007` pure `resolvePersonaProviderConfig(...)` → session-pinned provider/model, no global registry mutation (concurrency-correctness prerequisite for FEAT-007)**.
- [ ] **FR-110 group — Core engine + flow schema** (FR-110…FR-119, incl. **FR-117a** `{step}.capped`): `FEAT-001`…`FEAT-011` — [tasks/phase-1-engine.md](../tasks/phase-1-engine.md). Flow/step parsers, `OrchestrationEventEngine` (write-before-route) + `FallbackCoordinator`, `StepPromptBuilder` (always-inject must-publish + overwrite-only scratchpad rule), `StepTurnExecutor` on `RunLoop` (session-pinned model via ARCH-007; synthesizes `{step}.capped` on a non-`completed` turn), `emit_event` scaffold, `LoopSafetyGuards`, `OrchestrationRunner`, command palette.
- [ ] **FR-120 group — Session workspace + tasks + conversation navigation** (FR-120…FR-126): `INT-001`…`INT-006` — [tasks/phase-2-session-nav.md](../tasks/phase-2-session-nav.md). Session dir + scratchpad path auto-allow, 4 task tools, `FLOW_COMPLETE` task enforcement, `memories.md`, idempotent recovery replay, `orchestration_edges` + hidden-from-list filter.
- [ ] **FR-130 group — Programmatic code steps** (FR-130…FR-132): `INT-010`…`INT-013` — [tasks/phase-3-code-steps.md](../tasks/phase-3-code-steps.md). `CodeStepExecutor` (Sucrase, no LLM, no JSONL), `OrchestrationHelper` runtime API ([contracts/orchestration-helper.md](../contracts/orchestration-helper.md)), `FLOW_CANCELLED` terminal event.
- [ ] **FR-140 group — Progress notices** (FR-140…FR-141): `INT-020`, `INT-021` — [tasks/phase-4-notices.md](../tasks/phase-4-notices.md). Per-turn progress Notice synthesis; desktop right-click → `switchToConversationById`.
- [ ] **FR-150 group — Interactive orchestration + step→workflow** (FR-150…FR-151): `INT-030`, `INT-031` — [tasks/phase-5-interactive-workflow.md](../tasks/phase-5-interactive-workflow.md). `user.input.required` pause/resume (recoverable log state); step invokes a single-turn workflow via the background loop in `src/chat/workflow-executor.ts`.
- [ ] **FR-160 group — Built-in flows + orchestration-creator persona** (FR-160…FR-161): `POL-001`, `POL-002`, `DOC-001` — [tasks/phase-6-builtins.md](../tasks/phase-6-builtins.md). `orchestration-creator` registered in `BUILTIN_PERSONA_PROFILES`; reference flows (code-assist, research, review); docs + persona/tool-creator updates.
- [ ] **FR-170 group — Composability + run-tree view** (FR-170…FR-179): `INT-040`…`INT-047`, `POL-003`, `POL-004`, `VAL-001` — [tasks/phase-7-composability.md](../tasks/phase-7-composability.md). Self-describing flow contract, `FlowCompositionManager`, `run_flow` tool, child `RunLoop` execution + structured return, child sessions + isolation modes, chaining handoff, cascading guardrails, shared `child_run_metadata`, unified run-tree `ItemView`, unified activity indicator, end-to-end validation.

## RunLoop Regression Gate

> **RELEASE BLOCKER — must be fully green before Phase 1 (FR-110 group) begins.** This is `TEST-001`.
> The `RunLoop` extraction (`ARCH-002`/`ARCH-004`/`ARCH-005`) is behavior-preserving **by construction**:
> sub-agents seed `maxDepth = 0` and the aggregate budget `Infinity`, so the per-run iteration cap (20)
> remains the only effective limit. **No orchestration code merges until every box below is checked.**

- [ ] `src/chat/sub-agent-runner.test.ts` passes unmodified (loop, wind-down, parent-abort cascade byte-identical)
- [ ] `src/tools/use-subagent.test.ts` passes unmodified — including the hard assertion `iterationCap === 20`
- [ ] `src/sub-agents/constants.test.ts` passes unmodified (`SUB_AGENT_CONCURRENCY_CAP = 3`, `SUB_AGENT_ITERATION_CAP = 20`, `SUB_AGENT_TOKEN_LIMIT = 0`)
- [ ] Sub-agent adapter seeds `RunContext` with `maxDepth = 0`, a fresh both-`Infinity` `budget` cell, and `orchestrationContext: undefined` (no persistence hooks); nested `use_subagent` still rejected via `depth < maxDepth` (not `_isSubAgentContext`)
- [ ] New `src/run-loop/run-loop.test.ts` added and green (terminal `stopReason` set, `executeToolBatches` dispatch inherited, hooks fire)
- [ ] New `src/run-loop/budget.test.ts` added and green (a turn proceeds iff `localIterations < iterationCap AND budget.iterationsRemaining > 0 AND budget.costRemainingUsd > 0`; the **shared** `budget` cell decrements in place and a child's decrement is visible to the parent; exhaustion blocks new child spawns only)
- [ ] Per-turn cost wiring reuses standalone `calculateCost` (`src/chat/message-pipeline.ts`) — no orchestrator dependency pulled into `budget.ts`
- [ ] `ARCH-007` resolves a persona's provider/model via a **pure** `resolvePersonaProviderConfig(...)` (value object) — **no** `providerRegistry.switchProvider`/`updateConfig` call; the global active provider/model is unchanged by a step turn (concurrent step turns with different models do not race)
- [ ] `enforcePathConstraints(...)` gains an optional `sessionAllowedPaths?` param (`INT-001`); existing path-enforcer tests pass **unmodified** when it is `undefined` (non-orchestration calls byte-identical)

## Notes

- **Path translation finding.** The source design notes (Obsidian vault) reference `shared/notor/src/...`. That is a vault artifact and is wrong for this repo. Every path in these specs is translated to the real repo source root `src/...` (e.g. `src/chat/sub-agent-runner.ts`). This checklist and its siblings contain **zero** occurrences of `shared/notor`.
- **Inline peek card is NEW chat UI (scope risk).** `ToolResult.sub_agent_metadata` is currently rendered only by the HTML exporter (`src/export/html-exporter.ts` `renderSubAgentDetail()` ~585) — `src/ui/message-renderer.ts` `renderToolResult()` ~506 does **not** render it in the chat panel today. FR-179 / `POL-003` therefore introduces a brand-new in-panel inline peek card; treat the HTML-export markup/CSS as a reference, **not** a reuse. (Sequencing-Risk Register item 7.)
- **`orchestration_edges` is net-new.** The `Conversation` type at `src/types.ts` ~24 has no orchestration fields today; the typed-edge adjacency list and the `orchestration_step_conversation` `_type` marker are additive header fields introduced by `INT-006`, with the single contract authority in [contracts/edges.md](../contracts/edges.md). Hide step conversations from the flat sidebar the moment `FEAT-007` writes them (Sequencing-Risk Register item 4), generalizing the existing `isSubAgentFilename` / `_type` filter in `src/chat/history.ts`.
- **Per-step model is session-pinned, never global (ARCH-007 — review-resolved).** `applyProviderModelOverrides()` (`src/personas/persona-manager.ts` ~349-453) mutates the **global** `ProviderRegistry`; step turns must **not** use it. ARCH-007 adds a pure `resolvePersonaProviderConfig(...)` (mirroring `resolveWorkflowProviderConfig()` in `src/chat/workflow-executor.ts`) pinned into the `ConversationSession`, so concurrent step turns / `run_flow` children never race on model selection. See [research.md](../research.md) Finding 5 (resolved). (Sequencing-Risk Register item 13.)
- **`notor-max-iterations` counts LLM turns only (review-resolved).** It maps to `AggregateBudget.iterationsRemaining`, decremented per LLM turn. **Code steps do not count** toward it (zero tokens, not an LLM turn); a code-step-only flow/cycle is bounded by `notor-max-runtime-minutes` + stale-loop detection. Authority: [contracts/run-loop.md](../contracts/run-loop.md) + [contracts/event-engine.md](../contracts/event-engine.md).
- **Capped turns and semantic verification (review-resolved).** A non-`completed` step turn synthesizes `{step}.capped` (FR-117a), not the success topic, so a cut-off turn never silently advances. The engine has **no** semantic verifier — a `completed`-but-wrong emission is the **author's** job to gate via a verifier step (the code-step verify pattern). The stale detector catches self-loops only; multi-step cycles / completion-alternation rely on budget + runtime (no general cycle detection in v1).
- **Recovery is parent-rooted + overwrite-idempotent (review-resolved).** Only root (`origin: "user"`) sessions are recovered by the top-level scan; `run_flow`/chaining children are reconciled by the parent's replay (reuse a terminal child's result, or tombstone-and-respawn a non-terminal one) — preventing duplicate child runs. Scratchpad writes are **overwrite-only** (no append) so a re-run reproduces, not duplicates; `next`/`prev` edges may dangle after a re-run and are skipped by consumers. Code-step `callTool`/`callMcpTool` thread `runContext`, so a code-step `run_flow` cannot bypass `max_depth`/the aggregate budget. Code-step timeout defaults to 300 s (overridable via `notor-step-timeout-seconds`; must exceed any inner shell timeout).
