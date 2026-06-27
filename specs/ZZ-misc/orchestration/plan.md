# Implementation Plan: Orchestration Engine

**Created:** 2026-06-27
**Specification:** [spec.md](spec.md)
**Data Model:** [data-model.md](data-model.md)
**Tasks:** [tasks.md](tasks.md)
**Research:** [research.md](research.md)
**Contracts:** [contracts/](contracts/)
**Status:** Draft

This plan covers the **entire orchestration feature as one cohesive implementation** (design Phases
0–7). No phase is independently shippable; the structure exists to order the work and isolate the
regression-critical foundation (the `RunLoop` extraction). The subsystem is gated behind a feature
group (`orchestration_enabled`, default off), mirroring memory.

Type shapes are **not** redefined here — see [data-model.md](data-model.md). The conversation-edge
model and `child_run_metadata` are the single authority of [contracts/edges.md](contracts/edges.md);
the two-layer limit rule and `RunLoop` hook semantics are the authority of
[contracts/run-loop.md](contracts/run-loop.md).

---

## Technical Context

### Architecture Decisions

- **Platform:** Obsidian community plugin (TypeScript → esbuild → `main.js`) — same constraints as the
  rest of Notor. No new native modules; the code-step pipeline reuses the already-bundled Sucrase
  transform.
- **The `RunLoop` substrate is THE central decision.** Orchestration step turns do **not** run on the
  heavyweight `ChatOrchestrator.responseLoop()` (persistence, compaction, view rendering, persona
  switching) and do **not** introduce a third hand-rolled loop. Instead, a generalized headless
  turn-engine `RunLoop` is **extracted from `SubAgentRunner`** (which already calls itself "a
  lightweight mini-orchestrator") into a new `src/run-loop/` module. `SubAgentRunner`
  (`src/chat/sub-agent-runner.ts`) is refactored into a thin adapter over it **from day one** — shared
  engine, not converge-later. `RunLoop` owns the turn loop (stream-parse → `executeToolBatches` →
  repeat), per-run safety caps, wind-down summarization, parent-abort cascade, and a minimal optional
  hook surface (`onTurnStart`/`onTurnComplete`/`onPersist`/`onProgress`). Orchestration attaches
  per-step JSONL persistence, progress Notices, and run-tree navigation through those hooks **without**
  baking them into the engine. This single decision makes arbitrary-depth nesting, cascading budgets,
  and reliable structured returns implementable without fighting the sub-agent system's deliberate
  constraints. Authority: [contracts/run-loop.md](contracts/run-loop.md); types in
  [data-model.md](data-model.md) § Run-Loop Substrate Types.
- **Two-layer limit model.** A per-run iteration cap (unchanged, `SUB_AGENT_ITERATION_CAP = 20` in
  `src/sub-agents/constants.ts`) and a new **aggregate tree-wide budget** (`iterationsRemaining` /
  `costRemainingUsd` on `RunContext`) coexist. A turn proceeds iff **both** layers have headroom; the
  aggregate is layered *on top of* the per-run cap, never replacing it. Sub-agents seed `maxDepth = 0`
  and the aggregate budget to `Infinity`, so the per-run cap is the only effective limit — equivalence
  to today's behavior is *provable by construction*, not coincidental. Conflating these two layers is
  the single most common way to break behavior-preservation during the extraction.
- **Depth model replaces the binary recursion ban.** The sub-agent no-nesting rule
  (`SUBAGENT_EXCLUDED_TOOLS` + the `_isSubAgentContext` flag) is replaced by a `depth < maxDepth` check
  on `RunContext`. Sub-agents pass `maxDepth = 0` (nested `use_subagent` still rejected, identically);
  flows pass `maxDepth = N` or unlimited. Same mechanism, different policy.
- **`RunContext` rides the existing dispatch seam — it is not merged into `ToolSessionContext`.**
  `RunContext = { depth, maxDepth, iterationsRemaining, costRemainingUsd, abort }` is added as an
  optional `runContext?` field on `ToolExecuteOptions` (`src/tools/tool.ts`), assembled **once** at the
  single `ToolExecuteOptions` assembly site in `ToolDispatcher.dispatch()` (`src/chat/dispatcher.ts`)
  and threaded through `executeToolBatches` (`src/chat/tool-orchestration.ts`). `ToolSessionContext` is
  a stable per-dispatch read-accessor ("whose session am I in?"); `RunContext` is mutable, cascading,
  tree-scoped ("how deep / how much budget left?"). Different lifecycles — composed, not conflated.
- **Vault-native flow directories.** A flow is a directory
  `{notor_dir}/orchestrations/{flow-name}/` with a `definition.md` (topology, loop config, guardrails,
  composition contract) and a `steps/` subdirectory of step notes. Discovery mirrors
  `src/workflows/workflow-discovery.ts` (which scans `{notor_dir}/workflows/`) and persona discovery
  (`src/personas/persona-discovery.ts`, scanning `{notor_dir}/personas/`). Frontmatter uses a
  `notor-type: orchestration-flow` / `orchestration-step` discriminator. Note bodies are documentation
  (`definition.md`) or instructions/code (step notes) — `definition.md`'s body is never injected into a
  prompt. Schema: [data-model.md](data-model.md); frontmatter: [contracts/vault-schema.md](contracts/vault-schema.md).
- **Per-step persona.** Each step references a persona by name. `StepTurnExecutor` resolves it with
  `PersonaManager.getPersonaByName()` (`src/personas/persona-manager.ts`) **without** calling
  `activatePersona()` (which mutates global state). The persona drives system prompt
  (append/replace via `SystemPromptBuilder`), tool access + path enforcement (its
  `<notor_tool_config>`), and provider/model (its preset/provider/model preferences, applied via
  `applyProviderModelOverrides()`). `notor-step-model` overrides the persona's model. This lets a
  cheap/fast model plan and a capable model build.
- **Feature-group gating.** A single `orchestration_enabled` setting (`src/settings/types.ts`,
  default `false` in `src/settings/defaults.ts`) gates the subsystem. Registration adds
  `orchestration: "orchestration_enabled"` to `FEATURE_GROUP_TOGGLES` in `src/extensions/manager.ts`;
  every orchestration scaffold sets `featureGroup: "orchestration"`. Toggling the setting in the new
  `src/settings/sections/orchestration.ts` section reloads extensions (`manager.reload(false)`),
  registering/unregistering all scaffolds and the command — exactly the memory pattern
  (`src/settings/sections/memory.ts`).
- **Code steps via Sucrase.** A step with `notor-step-mode: code` executes a TypeScript code fence
  deterministically — no LLM call, no JSONL conversation, zero tokens — through the **existing**
  extension compile pipeline (`src/extensions/compiler.ts`: `stripTypes()` + `AsyncFunction` arg
  injection). The arg signature is `CODE_STEP_ARG_NAMES = ["app","obsidian","utils","libs","event",
  "orchestration"]` (the extension `TOOL_ARG_NAMES` set plus the two orchestration-specific args). The
  injected `orchestration` helper is built on `src/extensions/runtime-context/`. Code steps wholly
  replace the superseded "verification step" concept and are strictly more general (arbitrary routing,
  data fetch, notifications, aggregation). A code error fires `{step}.code_error` and shows an error
  Notice while still logging `turn.start`/`turn.complete`.
- **Composition via `run_flow` + chaining over one loose contract.** Each flow self-describes
  freeform natural-language `notor-flow-inputs` / `notor-flow-returns` in its own `definition.md`
  (the contract lives in the **callee**, keeping callers decoupled). Two mechanisms share it:
  (A) **flow-as-invocable-tool** — a single gated `run_flow` tool with a dynamic `flow` enum of
  discovered invocable flows (mirroring `UseSubagentTool`'s `get description()` / `get input_schema()`
  in `src/tools/use-subagent.ts`) runs the child flow to its terminal event on a **child `RunLoop`**
  and returns its `RunResult` (prefer `structured`, fall back to `text`); (B) **chaining** — at the
  terminal event, if `notor-on-complete-flow` is set, the runner launches the successor instead of
  finalizing (one-way handoff, no return). Discovery is a stateless `FlowCompositionManager` that
  re-scans on demand, mirroring `SubAgentManager`. Cascading `max_depth` / aggregate budgets on
  `RunContext` gate child spawns.
- **Unified run-tree view.** Step conversations and sub-agent conversations are both **hidden from the
  flat sidebar** (generalizing the existing sub-agent `isSubAgentFilename` / `_type` filter in
  `src/chat/history.ts`) and surfaced via a new contextual `ItemView` leaf that renders the whole run
  as a navigable, collapsible tree — reading `orchestration_edges` (steps) **and** the sub-agents'
  existing `parent_conversation_id`. It is live for active runs (subscribing to runner state via the
  `WorkflowActivityTracker.onChange()` pattern) and static for completed runs (re-rendered from the
  persisted `session-log.jsonl`). Reachable from the spawning tool-call card, the activity indicator,
  and a progress Notice; selecting a node loads its conversation in the main chat. The inline peek card
  on the spawning card is **new chat UI** (today `sub_agent_metadata` renders only in HTML export via
  `src/export/html-exporter.ts:585` — reference for markup, not a reuse). UX/data authority:
  [contracts/edges.md](contracts/edges.md).

### Technology / Reuse Decisions

| Decision | Rationale | Alternatives Considered | Trade-offs |
|---|---|---|---|
| Extract a shared `RunLoop` from `SubAgentRunner` (new `src/run-loop/`) rather than reuse `ChatOrchestrator` or hand-roll | `SubAgentRunner` is *already* the lean headless loop (stream-parse → `executeToolBatches` → repeat, caps, wind-down, abort); an orchestration step turn is conceptually identical to a sub-agent run. One engine for sub-agents, step turns, and flow-as-tool. | Run step turns on `ChatOrchestrator.responseLoop()` (drags in persistence/compaction/view/persona-switching); build a third independent loop (duplicate caps/abort/wind-down logic, drift risk) | Refactoring load-bearing `SubAgentRunner` carries regression risk — mitigated by gating on its existing test suites (the RunLoop regression gate, TEST-001) and making sub-agent equivalence provable (`maxDepth=0`, budget `Infinity`) |
| `RunContext` as `runContext?` on `ToolExecuteOptions`, assembled once in `dispatcher.dispatch()` | Rides the existing `sessionContext` dispatch seam that `executeToolBatches` already threads; existing tools ignore it; `use_subagent` / `run_flow` opt in. Single assembly site keeps the change localized. | Merge into `ToolSessionContext` (wrong lifecycle — that interface is a stable read-accessor, not mutable tree state); add a new positional arg to `executeToolBatches` (touches every caller) | An optional field readers must null-check; but the alternative pollutes a stable contract or a hot signature |
| Two-layer limit model (per-run cap + aggregate tree budget), both must pass | Per-run cap stops one loop spinning; aggregate ceiling stops a deep/wide tree collectively over-spending. Keeping them independent makes the sub-agent refactor behavior-preserving *by construction* (`Infinity` aggregate → cap is the only limit). | Replace the per-run cap with the aggregate counter (silently changes sub-agent behavior; breaks `use-subagent.test.ts`'s hard `iterationCap === 20` assert); per-run cap only (no tree ceiling — deep trees over-spend) | Two counters checked per turn instead of one; but correctness and provable equivalence outweigh it |
| Code steps reuse the extension Sucrase pipeline (`stripTypes` + `AsyncFunction`) | Already bundled, already battle-tested for user tools; identical compile + runtime-context plumbing (`src/extensions/runtime-context/`); zero new infra. | A sandboxed VM (heavy, no API parity); a constrained DSL (far less powerful than the superseded verification steps) | Code steps run with full plugin privileges (mitigated by a timeout guard + error→`{step}.code_error`); but parity with user-defined tools is the point |
| `run_flow` mirrors `UseSubagentTool`'s dynamic-description pattern (enum of discovered flows + loose `payload`) | The exact precedent already ships and is tested; flow names as enum *values* sidestep collisions; per-flow `notor-flow-inputs` surfaces in the description like sub-agent profile names. | A statically-typed per-flow input schema (defeats the deliberately loose NL contract; brittle); one tool per flow (name collisions, registry churn) | LLM may under-fill the loose `payload`; but the contract leans on LLM coercion by design |
| Generalize `sub_agent_metadata` → shared `child_run_metadata` (back-compat superset) | One rendering path + one token-rollup path for both `use_subagent` and `run_flow`; flows carry aggregate-subtree numbers, sub-agents single-run totals. | A second parallel metadata block for flows (duplicate render/rollup paths, drift); a breaking rename (already-persisted conversations stop parsing) | Must keep the old field names readable forever; modest, and the cost of any rename is worse |
| Vault-native flow dirs (discovery mirrors workflows/personas) | Consistent with Notor's vault-native model; reuses the established frontmatter-discovery pattern; flows are editable, diffable, shareable notes. | Flows in `data.json` settings (opaque, not shareable, no `<include_note>`); a separate index file (extra sync surface) | Per-run file I/O for parsing/recovery; acceptable and consistent with existing subsystems |
| Unified run-tree view (one tree for steps **and** sub-agents) instead of two surfaces | Both are hidden-from-list child conversations; one `ItemView` reading `orchestration_edges` + `parent_conversation_id` is simpler to navigate and maintain than parallel UIs. | A second sub-agent-only navigator (parallel UI to maintain); rendering only in HTML export (no live navigation) | The inline peek card is net-new chat UI (scope risk, flagged in the register); but a single observability surface is the right shape |

### Integration Points

Existing Notor systems this feature touches (real `src/` paths from [research.md](research.md)'s
verified seam table):

- **Run loop / sub-agents:**
  - `src/chat/sub-agent-runner.ts` — `SubAgentRunner` loop refactored to consume `RunLoop`; `SubAgentResult` → subset of `RunResult`.
  - `src/chat/tool-orchestration.ts` — `executeToolBatches` (the batch-dispatch engine `RunLoop` is built on; `DEFAULT_CONCURRENCY_CAP = 5`) threads `runContext`.
  - `src/chat/dispatcher.ts` — `ToolDispatcher.dispatch()`; the single `ToolExecuteOptions` assembly site gains `runContext`.
  - `src/tools/tool.ts` — `ToolExecuteOptions` gains `runContext?`; `ToolSessionContext` unchanged.
  - `src/tools/use-subagent.ts` — `_isSubAgentContext` ban replaced by a `RunContext` depth check; the dynamic-tool precedent `run_flow` mirrors.
  - `src/sub-agents/constants.ts` — `SUB_AGENT_ITERATION_CAP` (20), `SUB_AGENT_CONCURRENCY_CAP` (3), `SUB_AGENT_TOKEN_LIMIT` (0); recursion ban generalized into the depth model.
  - `src/sub-agents/semaphore.ts` — `Semaphore` generalized into the run-loop layer for child-run concurrency.
  - `src/chat/message-pipeline.ts` — `calculateCost()` (standalone; reachable from the run-loop layer with no orchestrator deps) feeds per-turn aggregate cost decrement.
- **Personas:**
  - `src/personas/persona-manager.ts` — `getPersonaByName()` (resolve without mutating global state), `applyProviderModelOverrides()`.
  - `src/personas/builtin-personas.ts` — `BUILTIN_PERSONA_PROFILES` gains the `orchestration-creator` persona.
- **Extensions / feature groups / compile:**
  - `src/extensions/manager.ts` — `FEATURE_GROUP_TOGGLES` gains `orchestration`; `reload(false)` re-registers scaffolds.
  - `src/extensions/types.ts` — `UserToolDefinition.featureGroup`.
  - `src/extensions/builtin-tool-scaffolds/_scaffold-helper.ts` — scaffold helper for `emit_event`, `run_flow`, the four task tools.
  - `src/extensions/compiler.ts` — `stripTypes()` + `compileToolFunction()` reused for code steps; `TOOL_ARG_NAMES` is the base of `CODE_STEP_ARG_NAMES`.
  - `src/extensions/runtime-context/index.ts` (`buildUtils`/`buildLibs`) + `plugin-utils.ts` (`notify`, `executeShellCommand`) — the base the `OrchestrationHelper` extends.
  - `src/shell/shell-executor.ts` — `executeShellCommand()` for code-step build/test verification.
- **Tool config / path enforcement:**
  - `src/tool-config/path-enforcer.ts` — `enforcePathConstraints()`; the session scratchpad path is auto-allowed for the owning session's steps (and the parent scratchpad for `shared` handoff).
  - `src/tool-config/merger.ts` — `mergeToolConfigs()` precedence and `intersectToolConfig()` (sub-agent intersection model).
  - `src/tool-config/notices.ts` — `oncontextmenu` Notice pattern reused for right-click jump-in.
- **Settings:**
  - `src/settings/types.ts` (`orchestration_enabled`), `src/settings/defaults.ts` (default `false`), new `src/settings/sections/orchestration.ts` (mirrors `src/settings/sections/memory.ts`).
- **Workflows (disambiguated):**
  - `src/chat/workflow-executor.ts` — the **background** single-call loop; the seam for step→workflow invocation (Phase 5).
  - `src/workflows/workflow-discovery.ts` / `workflow-frontmatter.ts` — the discovery/frontmatter pattern the flow parser mirrors.
  - `src/workflows/workflow-activity-tracker.ts` — `WorkflowActivityTracker.onChange()` is the live-update pattern reused by the run-tree view and the unified activity indicator.
- **Chat core / history / navigation:**
  - `src/chat/orchestrator.ts` — `ChatOrchestrator` (implements `ToolSessionContext`); `switchToConversationById()` for node navigation; `addTokens(...)` rollup path generalized for `child_run_metadata`.
  - `src/chat/conversation-session.ts` — `ConversationSession` isolated snapshot, created per step turn.
  - `src/chat/history.ts` — header `_type`; `listConversations()` / `searchConversations()` filters extended to hide orchestration step conversations.
  - `src/chat/sub-agent-history.ts` — `isSubAgentFilename()`, the precedent for the hidden-from-list filter.
  - `src/chat/session-manager.ts` — `SessionManager` active-session tracking.
- **Types / UI:**
  - `src/types.ts` — `Conversation` header gains orchestration fields; `ToolResult.sub_agent_metadata` generalized to `child_run_metadata`.
  - `src/ui/message-renderer.ts` — `renderToolResult()` extended to render the inline peek card (net-new); `activateConversationLinks()` (`notor-conversation://`) reused for node jump.
  - `src/export/html-exporter.ts` — `renderSubAgentDetail()` is the markup/CSS reference for the inline child-conversation card (not a reuse).
  - `src/ui/chat-view.ts` / `src/main.ts` — `registerView` pattern for the new run-tree `ItemView` leaf.
  - `src/ui/workflow-activity-indicator.ts` / `workflow-activity-dropdown.ts` — generalized to one indicator with typed entries (flow-run entries open the run-tree).

---

## Six-Phase Mapping (repo convention) ↔ design Phases 0–7

The repo's six-phase convention (**Setup → Foundation → Core → Integration → Quality → Polish**) orders
the *work*; the design's Phase 0–7 is carried as a **tag** on every task. The full phase→task→design
mapping table, every task body, dependency edges, and the per-phase test gate live in
[tasks.md](tasks.md) and the per-phase files under [tasks/](tasks/) — **not duplicated here**.

| Repo phase | Design phase(s) | Work area | Task IDs | Task file |
|---|---|---|---|---|
| **Setup + Foundation** | 0 | Generalized `RunLoop` substrate | ENV-001, ENV-002, ARCH-001…006 | [tasks/phase-0-runloop.md](tasks/phase-0-runloop.md) |
| **Core** | 1 | Core engine + flow schema | FEAT-001…011 | [tasks/phase-1-engine.md](tasks/phase-1-engine.md) |
| **Integration (Lane A)** | 2 | Session workspace + tasks + nav | INT-001…006 | [tasks/phase-2-session-nav.md](tasks/phase-2-session-nav.md) |
| **Integration (Lane B)** | 3 | Programmatic code steps | INT-010…013 | [tasks/phase-3-code-steps.md](tasks/phase-3-code-steps.md) |
| **Integration (Lane C)** | 4 | Progress notices | INT-020…021 | [tasks/phase-4-notices.md](tasks/phase-4-notices.md) |
| **Integration (Lane D)** | 5 | Interactive + step→workflow | INT-030…031 | [tasks/phase-5-interactive-workflow.md](tasks/phase-5-interactive-workflow.md) |
| **Integration (Lane E) + Polish** | 7 | Composability + run-tree view | INT-040…047, POL-003, POL-004, VAL-001 | [tasks/phase-7-composability.md](tasks/phase-7-composability.md) |
| **Polish** | 6 | Built-in flows + persona | POL-001, POL-002, DOC-001 | [tasks/phase-6-builtins.md](tasks/phase-6-builtins.md) |
| **Quality** | cross-cutting | Tests | TEST-001…008 | per-phase (gate table in [tasks.md](tasks.md)) |

Lanes A–E (design Phases 2–5, 7) are independent integration lanes that run **concurrently** once the
Phase 1 core (FEAT-010, the `OrchestrationRunner`) lands.

---

## Critical Path

The longest dependency chain through the feature (copied from [tasks.md](tasks.md)):

```
ENV-001 → ARCH-001 → ARCH-002 → ARCH-004 → ARCH-005
        → FEAT-007 → FEAT-010
        → INT-006 (edges) → INT-043 (flow-as-tool) → INT-047 (child_run_metadata)
        → POL-003 (run-tree view) → TEST-008 → VAL-001
```

**Narrowest waists:**

- **ARCH-002** (the behavior-preserving loop lift) — everything that executes an LLM turn depends on it
  (sub-agents today; `StepTurnExecutor`, flow-as-tool tomorrow).
- **FEAT-010** (the `OrchestrationRunner`) — every integration lane (A–E) funnels through the runner.

The Phase-7 tail (`INT-043 → INT-047 → POL-003`) is the **long pole**: the run-tree view cannot render
until both the edge schema (INT-006) and the shared metadata shape (INT-047) exist.

## Parallelism Groups

- **After ARCH-001:** `ARCH-003` (thread `runContext` through dispatch) runs parallel to `ARCH-002`
  (the loop lift) — different files; both need only the types.
- **After FEAT-001:** `FEAT-002` (parsers), `FEAT-005` (prompt builder), `FEAT-006` (session log), and
  `FEAT-008` (safety) are four independent tracks.
- **After FEAT-010:** Lane A (session/nav), Lane B (code steps), Lane C (notices), and Lane D
  (interactive) run concurrently. Lane B and Lanes C/D share only `INT-001`.
- **Within Phase 7:** `INT-040 → INT-041` is serial; once `INT-043` lands, `INT-044` and `INT-046`
  proceed in parallel.
- **Quality:** `TEST-001` can be authored the moment `ARCH-002` is in progress (it *is* the existing
  sub-agent suite). `TEST-002`/`003`/`004` parallelize across Core and Lane-B work.

---

## Sequencing-Risk Register

The hazards that govern ordering. Each item is also indexed in [tasks.md](tasks.md) §
Sequencing-Risk Register; the one-paragraph rationale is the load-bearing detail here.

1. **RunLoop extraction must be behavior-preserving (highest severity).** `SubAgentRunner` is
   load-bearing — `use_subagent` is built on it and three test files exercise it
   (`sub-agent-runner.test.ts`, `use-subagent.test.ts` which hard-asserts `iterationCap === 20`,
   `constants.test.ts`). The extraction (ARCH-002) and the changes that ride it (ARCH-004 depth check,
   ARCH-005 budget wiring) must produce byte-identical caps, wind-down, and abort behavior. Gate all
   three on those suites (TEST-001, the **release blocker**): no orchestration code merges until they
   pass *unmodified*. Equivalence is provable rather than coincidental because sub-agents seed
   `maxDepth = 0` and the aggregate budget to `Infinity`, making the per-run cap the only effective
   limit — but provability only holds if the suite confirms it.

2. **Depth seed before ban removal.** ARCH-003 (add the default `runContext` to `ToolExecuteOptions`,
   with `maxDepth = 0` for sub-agents and the assembly defaulting in `dispatcher.dispatch()`) must land
   **before** ARCH-004 removes the `_isSubAgentContext` flag / `SUBAGENT_EXCLUDED_TOOLS` ban. If the ban
   is removed before the depth check is reliably populated on the dispatch seam, a nested `use_subagent`
   call would silently become possible — a real recursion-safety regression. The depth gate must be
   live and defaulted everywhere the old ban covered before the old ban comes out.

3. **Cost reachability (`budget.ts` has no orchestrator deps).** ARCH-005's per-turn cost decrement
   depends on `calculateCost()` (`src/chat/message-pipeline.ts`), which is standalone (no orchestrator
   state). `src/run-loop/budget.ts` must import only `calculateCost` + settings — never
   `ChatOrchestrator` or other heavyweight chat deps. If the budget helper drags in orchestrator state,
   the run-loop layer stops being a clean shared substrate and the sub-agent adapter inherits weight it
   must not. Confirm cost is reachable from the run-loop layer before wiring the aggregate decrement.

4. **`orchestration_edges` (INT-006) before run-tree (POL-003), and hide step conversations the moment
   they are written (FEAT-007).** The typed-edge adjacency list is what the run-tree view renders, so
   the edge schema must exist before the view. Independently, step conversations must be excluded from
   `listConversations()` / `searchConversations()` (`src/chat/history.ts`) as soon as `StepTurnExecutor`
   (FEAT-007) starts writing them — otherwise the flat conversation sidebar fills with per-turn
   step-conversation noise during all of Phases 1–6, before the run-tree exists to surface them
   properly. Write the header marker and the filter together with the first step conversation.

5. **`child_run_metadata` (INT-047) is a back-compat superset, not a breaking rename; land it before
   POL-003.** Generalizing `ToolResult.sub_agent_metadata` (`src/types.ts:270`) into the shared
   `child_run_metadata` block must keep the existing fields (`jsonl_filename`, `token_usage`,
   `iteration_count`, `stop_reason`, `profile_name`) readable so already-persisted conversations still
   parse. The run-tree view (POL-003) and its inline peek card consume the unified shape with its single
   rendering + single token-rollup path, so the metadata generalization must precede the view. A
   breaking rename would orphan persisted sub-agent conversations and force two render paths — the exact
   thing the generalization exists to avoid. Authority: [contracts/edges.md](contracts/edges.md).

6. **Feature-group gating (ENV-002) before any scaffold registration.** The `orchestration:
   "orchestration_enabled"` entry in `FEATURE_GROUP_TOGGLES` and the settings section that triggers
   `manager.reload(false)` must exist before `emit_event` (FEAT-009), the four task tools (INT-002), and
   `run_flow` (INT-042) are registered. If a scaffold is registered before the toggle gates it, the tool
   leaks into the tool list while the feature is disabled — breaking the "absent when disabled" contract
   and exposing half-wired orchestration tools to ordinary chat. The gate must precede every scaffold it
   governs.

7. **The inline peek card is NEW UI (scope risk in POL-003), not a reuse of the HTML-export card.**
   `renderSubAgentDetail()` (`src/export/html-exporter.ts:585`) renders the child-conversation detail
   **only in HTML export**; `renderToolResult()` (`src/ui/message-renderer.ts:506`) does **not** render
   `sub_agent_metadata` in the live chat panel today. The inline peek card on the spawning tool-call
   card is therefore net-new chat UI, not a lift of the export markup. Budgeting it as "reuse the export
   card" under-scopes POL-003; treat the export markup as a *visual reference* only and plan for new
   rendering, event wiring, and "Open run tree" affordances in the chat panel.

8. **`FLOW_CANCELLED` (INT-012) must bypass `FLOW_COMPLETE` enforcement (INT-003) — INT-003 first.**
   `FLOW_CANCELLED` is a terminal event (from code *or* conversation steps) that ends the loop with
   status `cancelled` and explicitly **bypasses** the open-tasks completion check. That bypass can only
   be implemented against an existing enforcement path, so the `FLOW_COMPLETE` task-enforcement logic
   (INT-003 — reject completion with open/running tasks, re-emit `flow.tasks_remaining`) must land
   first. Building cancellation before enforcement risks two divergent terminal-event code paths instead
   of one enforcement gate with a documented bypass.

9. **Recovery idempotency (INT-005) ⇄ interactive pause (INT-030) — INT-005 first.** Session recovery
   replays `session-log.jsonl` (dangling `turn.start` re-emits the trigger; dangling `event.emitted`
   re-publishes) and must be idempotent. Interactive pause (INT-030, `user.input.required`) introduces a
   *paused* state that must itself be a recoverable log entry — a session paused on input has to survive
   a reload and resume correctly. Treating paused-on-input as just another recoverable log state means
   the recovery machinery (INT-005) must exist and be idempotent **before** the pause state is added, or
   the new log entry types land without a recovery path and a reload silently loses a paused run.

10. **Chaining adapter (INT-045) depends on code steps (INT-010) — do not parallelize across Lane B.**
    Chaining at the terminal event injects the successor's `notor-flow-inputs` into the predecessor's
    terminal step; the default is free prompt-injection, but non-trivial payload reshaping uses an
    **optional code-step adapter** (deterministic, preferred over a fuzzy LLM turn). Because the adapter
    *is* a code step, INT-045 depends on `CodeStepExecutor` (INT-010) from Lane B. Although Phase 7 is a
    distinct integration lane (E), the chaining task cannot be scheduled as if Lane E were fully
    independent — the code-step substrate from Lane B is a hard prerequisite for the adapter path.

11. **Finalize `use-subagent.ts` (Phase 0) before `run_flow` (INT-042).** `run_flow` mirrors
    `UseSubagentTool`'s dynamic-tool pattern (`src/tools/use-subagent.ts`: `get description()` /
    `get input_schema()` with an enum of discovered names, and the `RunContext`-based spawn gate that
    replaced the recursion ban). If `run_flow` is built before the sub-agent tool's Phase-0 refactor is
    finalized, it would mirror a moving target — copying a depth/spawn pattern still in flux. Stabilize
    the `use_subagent` precedent (ARCH-002/004 complete) before cloning it for flows.

---

## Testing Strategy

The orchestration suites and their per-phase gates are defined in [tasks.md](tasks.md) (§ Quality —
Tests and § Per-Phase Test Gate). Summary of the gating posture:

- **Phase 0 — the release blocker.** TEST-001 is the **RunLoop regression gate**: the existing
  sub-agent suites (`sub-agent-runner.test.ts`, `use-subagent.test.ts`, `constants.test.ts`) must pass
  **unmodified**, plus net-new `run-loop.test.ts` + `budget.test.ts`. No orchestration code merges until
  green. This is the structural guarantee that the extraction is behavior-preserving.
- **Phase 1 — Core.** TEST-002 (event engine / fallback / safety) + TEST-003 (flow/step parsers) green;
  the step-prompt-builder test asserts the must-publish rule is **always** injected, even with custom
  step instructions.
- **Phase 2 — Session/nav.** TEST-005 (recovery idempotency against a truncated-log replay) green; a
  history test confirms step conversations are hidden from `listConversations()` / `searchConversations()`.
- **Phase 3 — Code steps.** TEST-004 green: fence extraction, timeout guard, error → `{step}.code_error`,
  and `OrchestrationHelper` dispatch (`callTool` / `callMcpTool` / scratchpad / tasks).
- **Phases 4–5.** Notice-synthesis unit; pause/resume + paused-session recovery; context-menu jump-in in e2e.
- **Phase 7 — Composability.** TEST-006 green: `run_flow` enum reflects discovered invocable flows,
  structured-vs-text return selection, budget / `max_depth` cascade gating, the edge-DAG no-cycle
  invariant, and `child_run_metadata` back-compat parse of persisted `sub_agent_metadata`.
- **All — e2e + validation.** TEST-007 (single flow → `FLOW_COMPLETE`, steps hidden from the flat list)
  and TEST-008 (`run_flow` child + structured return + run-tree live→static) green; VAL-001 walks
  [quickstart.md](quickstart.md) end-to-end.
