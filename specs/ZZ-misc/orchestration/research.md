# Research: Orchestration Engine — Verified Seam Table

**Created:** 2026-06-27
**Specification:** [spec.md](spec.md)
**Data Model:** [data-model.md](data-model.md)
**Tasks:** [tasks.md](tasks.md)
**Contracts:** [contracts/edges.md](contracts/edges.md) · [contracts/run-loop.md](contracts/run-loop.md)
**Status:** Draft

This document records **why each refactor in this feature is safe**. Every assumption about existing
code in [spec.md](spec.md), [data-model.md](data-model.md), and the `contracts/` files was verified
against the working tree at commit **`68f606e`** (the HEAD the spec package was authored against).
The table below is the authority for *where* each seam lives; the type *shapes* live in
[data-model.md](data-model.md), and the edge/`child_run_metadata`/RunLoop contracts live under
[contracts/](contracts/).

**Path translation.** The source design notes (the Obsidian-vault `design/orchestration.md` and the
`ideas/` notes) reference paths under `shared/notor/src/...`. That prefix is a vault artifact and does
**not** exist in this repo — Notor's source is at `src/...`. Every path below has been translated to
its real repo location (`shared/notor/src/X` → `src/X`) and re-verified. The design notes' line
numbers are stale; the line numbers in this table are the verified ones at `68f606e`. Treat this file
(not the design notes) as authoritative for paths and lines.

---

## Findings that shape the design

Three findings from the HEAD verification materially shape the implementation plan. Each is a
load-bearing assumption that a downstream task depends on.

### Finding 1 — Path translation (design notes are vault-relative, not repo-relative)

The design notes were authored inside the Obsidian vault and consistently write `shared/notor/src/...`.
This repo has **no** `shared/notor` directory; the real source root is `src/`. All seam references in
the spec package use the translated `src/...` paths and the line numbers verified at `68f606e`. Any
occurrence of `shared/notor` in a downstream artifact is a bug to be corrected, not a real path.

### Finding 2 — The inline child-run peek card is NET-NEW chat UI (POL-003)

`ToolResult.sub_agent_metadata` (`src/types.ts:270-281`) is **only rendered in HTML export today**, via
`renderSubAgentDetail()` in `src/export/html-exporter.ts:585-603` (the inline expandable
child-conversation card). The live chat renderer does **not** render it: `renderToolResult()` in
`src/ui/message-renderer.ts:506-541` reads `message.tool_result` but has no `sub_agent_metadata`
branch. Therefore POL-003's inline peek card in the chat panel is **fresh UI work**, not a reuse of an
existing chat component. The HTML-export card is a *reference for markup/CSS only* — it is a static,
export-time renderer with no live-update path and no `notor-conversation://` jump wiring. This is why
the sequencing-risk register ([tasks.md](tasks.md) item 7) flags the inline card as a scope risk inside
POL-003.

### Finding 3 — `orchestration_edges` + forward parent→child links are NET-NEW

There is **no** bidirectional run-tree linkage in the codebase today:

- The `Conversation` interface (`src/types.ts:24`) has **no orchestration fields at all** — no
  `orchestration_edges`, no `orchestration_session_id`, nothing. The typed-edge adjacency model is
  entirely additive (see [data-model.md](data-model.md) "Conversation Header Extensions" and the
  single authority [contracts/edges.md](contracts/edges.md)).
- Sub-agents today carry only a **unidirectional, scalar** `parent_conversation_id` in the sub-agent
  conversation header (written by `UseSubagentTool` ~430, read back ~429-430 of
  `src/chat/history.ts`). There is **no forward parent→child pointer**: a parent's children are found
  only by *filename scan* (`isSubAgentFilename()` in `src/chat/sub-agent-history.ts:110-112`, matching
  `filename.includes("_subagent_")`). The flat sidebar excludes them by filtering that predicate in
  `listConversations()` (`src/chat/history.ts:629-630`) and `searchConversations()` (~723-724).

Consequences for the design: the unified run-tree (POL-003 / FR-178) cannot be built from existing
data — INT-006 must introduce the typed-edge schema *and* backfill `next`/`prev` step chains and write
forward `child`/`parent` edges. The run-tree reads `orchestration_edges` for flow steps and the legacy
scalar `parent_conversation_id` for sub-agents, so it bridges the new bidirectional model and the old
unidirectional one. This is why INT-006 (edges) gates POL-003 ([tasks.md](tasks.md) critical path and
risk item 4), and why the hide-from-list filter must generalize the `isSubAgentFilename`/`_type`
predicate rather than replace it.

---

## Verified seam table

Grouped by subsystem. **Symbol** | **real `src/` path:line** | **how the implementation uses/extends
it** | **why the refactor is safe**. Paths and lines are verbatim from the HEAD verification at
`68f606e`.

### Run-loop / sub-agents

| Symbol | Real path:line | Use / extension | Why safe |
|---|---|---|---|
| `SubAgentRunner` ("a lightweight mini-orchestrator") | `src/chat/sub-agent-runner.ts` ctor `SubAgentRunnerOptions` ~115-143 | ARCH-002 lifts the loop into `RunLoop`; runner becomes a thin adapter | Constructor surface is the seam; adapter maps `RunLoopOptions`→runner inputs without changing callers |
| `run()` main loop `while (iterationCount < this.iterationCap)` | `src/chat/sub-agent-runner.ts` ~151-359 | The body lifted verbatim into `RunLoop` | The `< iterationCap` predicate is the per-run cap; preserved 1:1 (FR-100/101) |
| `runWindDown()` | `src/chat/sub-agent-runner.ts` ~365-445 | Becomes `RunLoop`'s terminal-cap wind-down summarization | Triggered on any terminal cap; behavior carried unchanged |
| Parent abort cascade | `src/chat/sub-agent-runner.ts` ~127-142 | Becomes `RunContext.abort` (AbortSignal cascade) | Same `AbortSignal` plumbing, now carried on `RunContext` |
| `SubAgentResult` `{text, messages, tokenUsage, iterationCount, stopReason}` | `src/chat/sub-agent-runner.ts` ~48-59 | Becomes a strict subset of `RunResult` (`structured` always null) | Additive `structured` slot + widened `stopReason` union are non-breaking (FR-104) |
| `executeToolBatches(...)` call site | `src/chat/sub-agent-runner.ts` ~318 | `RunLoop` dispatches tools through the same call | Batched/parallel intra-turn dispatch inherited unchanged (FR-100 AC) |
| `partitionToolCalls` / `executeToolBatches` (threads `sessionContext`) / `safeDispatch`; `DEFAULT_CONCURRENCY_CAP = 5` | `src/chat/tool-orchestration.ts` ~56 / ~114 / ~266 / ~106 | `runContext?` is threaded alongside `sessionContext` through `executeToolBatches` (ARCH-003) | `runContext?` is optional and additive; existing tools ignore it |
| `ToolDispatcher.dispatch()`; single `ToolExecuteOptions` assembly site | `src/chat/dispatcher.ts` ~388 / ~666 | ARCH-003 adds `runContext` to the one assembly site `{ onProgress, mode, abortSignal, sessionContext, silentNoteOpener, interactionCallback }` | A single assembly point means one edit; `RunContext` rides the existing seam, not a new param everywhere |
| `ToolSessionContext` `{getEffectiveToolConfig, getActiveConversation, setConversationTasks?}`; `ToolExecuteOptions` `{onProgress, mode, abortSignal, sessionContext, silentNoteOpener, interactionCallback}` | `src/tools/tool.ts` ~35-39 / ~41-63 | `runContext?` added to `ToolExecuteOptions`, **not** to `ToolSessionContext` | Different lifecycles: `ToolSessionContext` is a stable per-dispatch read-accessor; `RunContext` is mutable/cascading (FR-102 AC, data-model.md) |
| `UseSubagentTool`: dynamic `get description()` ~113-122; `get input_schema()` (enum of profiles) ~127-143; `SubAgentRunner` instantiation ~382-393; `_isSubAgentContext` flag declared line 64, checked ~201-209; returns ~451-462 with `sub_agent_metadata`; writes `parent_conversation_id` ~430 | `src/tools/use-subagent.ts` | ARCH-004 replaces the `_isSubAgentContext` ban with a `depth < maxDepth` check; the dynamic description/enum pattern is the template `run_flow` (INT-042) mirrors | Sub-agents seed `maxDepth = 0`, so nested `use_subagent` is rejected exactly as today; rejection returns a tool error, not a throw (FR-103) |
| `SUBAGENT_EXCLUDED_TOOLS = new Set(["use_subagent"])`; `filterSubAgentTools`; `SUB_AGENT_CONCURRENCY_CAP = 3`; `SUB_AGENT_ITERATION_CAP = 20`; `SUB_AGENT_TOKEN_LIMIT = 0` | `src/sub-agents/constants.ts` | `ITERATION_CAP`/`TOKEN_LIMIT` become the `RunLoopOptions` defaults; the binary exclusion ban gives way to the depth check | The constants are the per-run defaults; keeping `20`/`0` keeps sub-agent behavior byte-identical (FR-105) |
| `Semaphore(cap)`: `acquire()`/`release()`/`get pending`/`get active` | `src/sub-agents/semaphore.ts` | ARCH-006 generalizes it into the run-loop layer for orchestration child concurrency | Pure counting primitive with no sub-agent deps; cap 3 unchanged for sub-agents (FR-106) |
| `calculateCost(inputTokens, outputTokens, modelId, settings)` (STANDALONE, no orchestrator state) | `src/chat/message-pipeline.ts` ~643-668 | ARCH-005 `budget.ts` imports only `calculateCost` + settings for per-turn aggregate cost | Standalone + no orchestrator deps → importable from the run-loop layer without coupling (risk register item 3) |

**RunLoop regression gate (TEST-001 — release blocker):** `src/chat/sub-agent-runner.test.ts`,
`src/tools/use-subagent.test.ts` (hard-asserts `iterationCap === 20`), `src/sub-agents/constants.test.ts`.
These three suites must pass **unmodified** through ARCH-002/004/005. See the behavior-preservation
argument below.

### Personas

| Symbol | Real path:line | Use / extension | Why safe |
|---|---|---|---|
| `getPersonaByName()` (resolve WITHOUT activating/mutating global state) | `src/personas/persona-manager.ts` ~106 | `StepTurnExecutor` (FEAT-007) resolves a step's persona per turn via this, **not** `activatePersona()` | Read-only resolution leaves global persona state untouched — many step turns interleave safely |
| `activatePersona()` | `src/personas/persona-manager.ts` ~125 | Deliberately **not** used by step turns | Avoiding it is what keeps concurrent step turns from clobbering global state |
| `applyProviderModelOverrides()` (preset→provider→model) | `src/personas/persona-manager.ts` ~349-453 | Resolves per-step provider/model; `notor-step-model` overrides the persona's preference | Existing precedence chain reused as-is |
| `discoverPersonas()` scans `{notor_dir}/personas/`; frontmatter `notor-persona-prompt-mode` (append\|replace), `notor-preferred-provider/model/preset`, `notor-persona-chip-color/emoji` | `src/personas/persona-discovery.ts` ~42 | The `orchestration-creator` persona (POL-001) is discovered identically | Built-in personas register through the existing discovery/profile mechanism |
| `BUILTIN_PERSONA_PROFILES` (Map: `notor-help` + `tool-creator`); `BuiltinPersonaDefinition {name, description, systemPromptContent}` | `src/personas/builtin-personas.ts` ~318 | POL-001 registers `orchestration-creator` in this Map alongside the existing two | Same registration shape; additive (FR-160 AC) |

### Extensions / feature groups / compile

| Symbol | Real path:line | Use / extension | Why safe |
|---|---|---|---|
| `UserToolDefinition.featureGroup?` | `src/extensions/types.ts` ~115 | Every orchestration scaffold sets `featureGroup: "orchestration"` | Field already exists; orchestration is just a new value |
| `FEATURE_GROUP_TOGGLES` (`{ memory: "memory_enabled", templates: "templates_enabled" }`); `isFeatureGroupEnabled()`; `reload(isInitialLoad)` (tools filtered ~315) | `src/extensions/manager.ts` ~235-238 / ~244 / ~264 | ENV-002 adds `orchestration: "orchestration_enabled"`; toggling reloads extensions | Identical to the memory toggle; gating is the existing filter path (FR-119, risk item 6) |
| Scaffold helper, `featureGroup?` param ~9 (e.g. `capture-memory.ts`, `execute-command.ts`) | `src/extensions/builtin-tool-scaffolds/_scaffold-helper.ts` | `emit_event` (FEAT-009), 4 task tools (INT-002), `run_flow` (INT-042) authored as scaffolds via this helper | Built-in scaffolds are the proven extension path; gating is automatic via `featureGroup` |
| `stripTypes()` (Sucrase typescript transform) ~31-41; `TOOL_ARG_NAMES = ["app","obsidian","utils","libs","settings","shared","params"]` ~67; `compileToolFunction()` (`new AsyncFunction(...names, code)`) ~76; `compileExtension(rawCode, "tool"\|"automation")` ~140-165 | `src/extensions/compiler.ts` | `CodeStepExecutor` (INT-010) reuses `stripTypes` + `AsyncFunction` with the code-step arg signature `["app","obsidian","utils","libs","event","orchestration"]` | Reuses the proven compile pipeline; only the arg-name list differs (data-model.md `CODE_STEP_ARG_NAMES`) |
| `buildUtils()` ~59-91, `buildLibs()` ~99-114; `notify(message, {duration, onClick, onRightClick})` ~308-330; `utils.executeShellCommand` ~94 (+`readNote`, `requestUrl`, …) | `src/extensions/runtime-context/index.ts`; `…/plugin-utils.ts`; `…/types.ts` | `OrchestrationHelper` (INT-011) builds on this runtime context for code steps; `utils.executeShellCommand` powers verify steps | Code steps inherit the same `utils`/`libs` surface user tools already have |
| `executeShellCommand(cmd, opts)` | `src/shell/shell-executor.ts` ~80 | Backs `utils.executeShellCommand` for build/test verify code steps | Existing executor; no change required |

### Tool-config

| Symbol | Real path:line | Use / extension | Why safe |
|---|---|---|---|
| `enforcePathConstraints(toolName, parameters, entry, vaultRootPath, resolveVaultPath?)` ~45; `TOOL_PATH_PARAMS` ~28 | `src/tool-config/path-enforcer.ts` | INT-001 auto-allows the session `scratchpad/` path for the owning session's steps; `shared` handoff (FR-174) auto-allows the parent scratchpad in the child | Auto-allow is an additive allowance on the existing enforcement, scoped to the owning session |
| `mergeToolConfigs()` (precedence workflow > persona > rule) ~57; `intersectToolConfig()` (sub-agent intersection) ~142 | `src/tool-config/merger.ts` | Per-step tool access flows from the step's persona config through the existing merge | Existing precedence model unchanged; steps are just another persona-config consumer |
| `showToolConfigError()` (Notice + `messageEl.oncontextmenu`, `Platform.isDesktop` guard) ~25-40; `showDraftSavedNotice()` (`oncontextmenu` → `onSwitchBack`) ~52-65 | `src/tool-config/notices.ts` | The right-click-Notice pattern (INT-021, FR-141) reuses this `oncontextmenu` + `Platform.isDesktop` precedent | Mobile already omits the right-click affordance via the existing desktop guard |

### Settings

| Symbol | Real path:line | Use / extension | Why safe |
|---|---|---|---|
| `memory_enabled` ~448, `templates_enabled` ~466 | `src/settings/types.ts` | ENV-001 adds `orchestration_enabled: boolean` | Additive boolean field, mirrors `memory_enabled` exactly |
| Memory section toggle: `onChange` sets `settings.memory_enabled` then `const manager = ctx.plugin.getExtensionManager(); await manager.reload(false);` ~69 | `src/settings/sections/memory.ts` ~22-73 | ENV-002 mirrors this as `src/settings/sections/orchestration.ts` | Reuses the exact toggle→save→reload pattern |
| `defaults.ts` | `src/settings/defaults.ts` | ENV-001 adds `orchestration_enabled: false` | New default off; no existing default changed (spec §Scope) |

### Workflows (disambiguation)

There are **two** distinct `workflow-executor.ts` files; the orchestration seam differs by phase.

| Symbol | Real path:line | Use / extension | Why safe |
|---|---|---|---|
| BACKGROUND EXECUTION loop `while(continueLoop)` ~809; single-call `dispatcher.dispatch()` ~951 (ONE tool at a time — **not** `executeToolBatches`) | `src/chat/workflow-executor.ts` | This is the seam for step→workflow invocation (INT-031, FR-151, Phase 5) | The await-result hook is the integration point; orchestration awaits a workflow's result into the step's context |
| PROMPT ASSEMBLY ONLY (no loop): `readWorkflowBody` ~60, `resolveWorkflowIncludes` ~98, `assembleWorkflowPrompt` | `src/workflows/workflow-executor.ts` | Not a loop — referenced to avoid confusing it with the background executor | Prompt-only; flow handoff does **not** touch this file |
| `WorkflowConcurrencyManager` (FIFO queue, single-instance guard, `reconcileAfterWake`; IN-MEMORY, lost on reload) | `src/workflows/workflow-concurrency.ts` ~70 | Reference for the activity-indicator dual-source model (POL-004): in-memory workflow state vs session-file-backed flow state | In-memory state is *lost on reload* — this is why flow runs need session-file-backed recovery, not the same manager (risk: run-tree dual-source) |
| `discoverWorkflows(vault, metadataCache, notorDir)` scans `{notor_dir}/workflows/` ~73; `injectWorkflowFrontmatter` ~15-39 | `src/workflows/workflow-discovery.ts`; `src/workflows/workflow-frontmatter.ts` | `FlowDefinitionParser`/`StepNoteParser` (FEAT-002) mirror these discovery/frontmatter patterns for `{notor_dir}/orchestrations/` | Flow parser is a parallel implementation of a proven pattern, not a change to workflow discovery |
| `WorkflowActivityTracker` ~28-41; `onChange(cb)` (returns unsubscribe) ~118; `notifyChange()` ~129; `getIndicatorEntries()` ~57 | `src/workflows/workflow-activity-tracker.ts` | FR-178 live run-tree subscribes via the `onChange()` pattern; POL-004 generalizes indicator entries to typed entries | `onChange()` is the existing live-update seam; typed entries are additive (do not build a second indicator) |

### Chat core / history / nav

| Symbol | Real path:line | Use / extension | Why safe |
|---|---|---|---|
| `ChatOrchestrator implements ToolSessionContext` ~93; passes `this` as `sessionContext` to `executeToolBatches`; `switchToConversationById()` ~741; `switchConversation()` ~737; sub-agent token rollup `convManager.addTokens(...)` ~1635-1637 | `src/chat/orchestrator.ts` | Notice jump-in (INT-021) reuses `switchToConversationById()`; `child_run_metadata` rollup (INT-047) reuses the single `addTokens` rollup site | Reusing existing nav + rollup means one token-rollup path serves both `use_subagent` and `run_flow` (FR-177 AC) |
| `addTokens(input, output)` | `src/chat/conversation.ts` ~696 | The rollup primitive the shared `child_run_metadata` path calls | Unchanged; called from the same one site |
| `ConversationSession` ~61-114 (isolated snapshot: `conversationId`, `abortController`, `effectiveConfig`, pinned persona/provider/model) | `src/chat/conversation-session.ts` | Each step turn (FEAT-007) creates an isolated `ConversationSession` | Isolation is the existing guarantee; step turns are just more sessions |
| `switchToConversationById()` ~488-507; `switchConversation(filename)` ~265-330 | `src/chat/conversation-lifecycle.ts` | Run-tree node selection loads the node's conversation in main chat (FR-178) | Existing nav lifecycle reused unchanged |
| `HistoryManager`; header `_type:"conversation"`; `listConversations()` filters `isSubAgentFilename` ~629-630; `searchConversations()` ~723-724; sub-agent header `_type:"sub_agent_conversation"` ~450 with `parent_conversation_id` ~429-430 | `src/chat/history.ts` | INT-006 adds `_type:"orchestration_step_conversation"` + generalizes the hide-from-list filter; writes `orchestration_edges` | The filter generalizes the existing `isSubAgentFilename`/`_type` predicate rather than replacing it (Finding 3) |
| `isSubAgentFilename(filename)` (`filename.includes("_subagent_")`) ~110-112 | `src/chat/sub-agent-history.ts` | The existing unidirectional/filename-scan child-discovery the run-tree must bridge | Sub-agent children remain found by this predicate; flow steps add typed edges (Finding 3) |
| `SessionManager` ~19-27 (`activeSessions` Map; `getActiveSession`; `onSessionsChanged`) | `src/chat/session-manager.ts` | Reference for `OrchestrationSessionManager` (INT-001) active-session tracking | Parallel manager; does not modify the chat session manager |

### Types / UI

| Symbol | Real path:line | Use / extension | Why safe |
|---|---|---|---|
| `Conversation` interface (NO orchestration fields today) | `src/types.ts` ~24 | INT-006 adds the additive orchestration header fields + `orchestration_edges` | Purely additive; no existing field changes (Finding 3, data-model.md, [contracts/edges.md](contracts/edges.md)) |
| `ToolResult.sub_agent_metadata = { jsonl_filename, token_usage:{input,output}, iteration_count, stop_reason, profile_name } \| null` | `src/types.ts` ~270-281 | INT-047 generalizes to shared `child_run_metadata` (back-compat superset) | Keeps the five existing fields readable for persisted conversations (FR-177 AC, risk item 5) |
| `renderToolResult()` (does **NOT** render `sub_agent_metadata` today) | `src/ui/message-renderer.ts` ~506-541 | POL-003 adds the inline peek card here — **net-new chat UI** | The branch does not exist today, so the card is fresh work, not a regression of an existing render path (Finding 2) |
| `activateConversationLinks()` (`notor-conversation://{id}` → `openChatInNewTab`) ~957-975 | `src/ui/message-renderer.ts` | The peek card "Open run tree" / node jump reuses the `notor-conversation://` scheme | Existing link-activation scheme reused |
| `renderSubAgentDetail()` — THE inline child-conversation card, currently HTML-EXPORT ONLY | `src/export/html-exporter.ts` ~585-603 | Reference for markup/CSS of the peek card — **not a reuse** | Export-time static renderer; no live-update or jump wiring → POL-003 cannot reuse it directly (Finding 2) |
| `NotorChatView extends ItemView` ~55; `CHAT_VIEW_TYPE = "notor-chat-view"` ~36 (`getViewType`/`getDisplayText`/`onOpen`/`onClose`/`onResize`) | `src/ui/chat-view.ts` | The unified run-tree leaf (POL-003) is a new `ItemView` modeled on this | Existing `ItemView` lifecycle is the proven leaf pattern |
| `registerView(CHAT_VIEW_TYPE,...)` ~407-440; `registerView(INSPECTOR_VIEW_TYPE,...)` ~444-450; `loadConversation()` ~1964-2043; `getWorkflowActivityTracker()` | `src/main.ts` | POL-003 registers the run-tree view leaf alongside the existing two; reuses `loadConversation()` for node selection | Additive `registerView` call; existing view registrations unchanged |
| `workflow-activity-indicator.ts` subscribes `tracker.onChange(()=>this.update())` ~138-139; `workflow-activity-dropdown.ts` `renderEntry()` ~261-295; entry click → `onNavigate(conversation_id)` | `src/ui/workflow-activity-indicator.ts`; `src/ui/workflow-activity-dropdown.ts` | POL-004 generalizes entries to typed entries; flow-run entries open the run-tree instead of navigating to a conversation | One indicator with typed entries (FR-179 AC); the `onChange` subscription seam is unchanged |

---

## Behavior-preservation argument (RunLoop extraction)

The highest-severity hazard ([tasks.md](tasks.md) risk item 1) is that extracting `RunLoop` from
`SubAgentRunner` (ARCH-002) silently changes sub-agent behavior. The argument that it does **not** is
structural, not empirical — it holds *by construction*, and the three regression-gate suites stay green
without modification.

**The two-layer limit collapses to one layer for sub-agents.** A turn proceeds iff
`localIterations < iterationCap` **AND** `RunContext.iterationsRemaining > 0` **AND**
`RunContext.costRemainingUsd > 0` (the decision rule, authority [contracts/run-loop.md](contracts/run-loop.md)).
The `SubAgentRunner` adapter seeds its `RunContext` with:

- `maxDepth = 0` → the `depth < maxDepth` spawn gate is `0 < 0 = false`, so nested `use_subagent` is
  rejected exactly as the old `_isSubAgentContext` / `SUBAGENT_EXCLUDED_TOOLS` ban did.
- `iterationsRemaining = Infinity` and `costRemainingUsd = Infinity` → both aggregate predicates are
  **always true**, so they can never be the binding constraint.

With both aggregate predicates permanently true, the *only* effective limit is the per-run
`iterationCap`, defaulted to `SUB_AGENT_ITERATION_CAP = 20` (`src/sub-agents/constants.ts`). The loop
condition reduces to today's `while (iterationCount < this.iterationCap)` from
`src/chat/sub-agent-runner.ts:151-359`. Wind-down (`runWindDown()` ~365-445), the abort cascade
(~127-142), and the `executeToolBatches` dispatch (~318) are lifted verbatim, so caps, wind-down, and
abort behavior are byte-identical.

**Why the gate suites stay green by construction:**

- `src/tools/use-subagent.test.ts` **hard-asserts `iterationCap === 20`.** The adapter passes
  `SUB_AGENT_ITERATION_CAP` as the `RunLoopOptions.iterationCap` default, so the asserted value is
  unchanged.
- `src/sub-agents/constants.test.ts` asserts the constant values (`CONCURRENCY_CAP = 3`,
  `ITERATION_CAP = 20`, `TOKEN_LIMIT = 0`, `SUBAGENT_EXCLUDED_TOOLS`). ARCH does not edit these
  constants — it *consumes* them as `RunLoop` defaults — so the suite is untouched.
- `src/chat/sub-agent-runner.test.ts` exercises the loop, wind-down, and abort end-to-end against the
  `SubAgentResult` shape. Because `SubAgentResult` is a strict subset of `RunResult` (`structured`
  always null; `stopReason` union only *widened* with the unreachable `cost_cap`/`depth_cap`), the
  asserted shape still matches.

This is why TEST-001 is the **release blocker** that gates ARCH-002/004/005: the suites must pass
*unmodified*. The new `run-loop.test.ts` + `budget.test.ts` (TEST-001) add coverage for the
aggregate-budget path that sub-agents never exercise (because they seed `Infinity`), keeping the new
behavior tested without disturbing the preserved behavior.

**Ordering safeguard.** Risk item 2 requires ARCH-003 (default `runContext`, `maxDepth = 0` for
sub-agents, threaded through dispatch) to land **before** ARCH-004 removes `_isSubAgentContext`.
Otherwise, between the two edits, nested sub-agents would silently become possible (no ban *and* no
depth gate). The seam that makes this a single safe edit is the **one** `ToolExecuteOptions` assembly
site at `src/chat/dispatcher.ts:666` — `runContext` is assembled once and rides the existing dispatch
seam to `executeToolBatches`, so existing tools that ignore it are unaffected.
