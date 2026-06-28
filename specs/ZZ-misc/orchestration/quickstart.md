# Quickstart: Orchestration Engine — End-to-End Walkthrough

**Created:** 2026-06-27
**Specification:** [spec.md](spec.md)
**Data Model:** [data-model.md](data-model.md)
**Tasks:** [tasks.md](tasks.md)
**Contracts:** [contracts/vault-schema.md](contracts/vault-schema.md) · [contracts/edges.md](contracts/edges.md) · [contracts/orchestration-helper.md](contracts/orchestration-helper.md) · [contracts/run-loop.md](contracts/run-loop.md)
**Status:** Draft

This is the hands-on walkthrough that drives **VAL-001** (end-to-end validation). It exercises the
whole feature as a user would: enable the group, author a minimal flow by hand, run it, inspect the
run tree, compose two flows, and recover after a reload. Schema details live in
[data-model.md](data-model.md) and [contracts/vault-schema.md](contracts/vault-schema.md) — this
file shows concrete, copy-pasteable vault content rather than re-deriving the schema.

Throughout, `{notor_dir}` is your configured Notor directory (default `notor/` at the vault root).
The example flow is named `hello-research`; substitute your own vault paths where shown.

---

## Prerequisites

- A development build of Notor installed in a test vault (see [04-mcp/quickstart.md](../../04-mcp/quickstart.md) for the build/install loop: `npm run build` then copy `main.js manifest.json styles.css` into `.obsidian/plugins/notor/`).
- At least one configured LLM provider (the conversation step needs a model).
- For the code-step scenario, the desktop app (code steps may call `utils.executeShellCommand`, desktop-only).

> The orchestration subsystem is gated behind `orchestration_enabled` and is **completely absent**
> when disabled — no command, no scaffolds, no `orchestrations/` directory. Scenario 1 turns it on.

---

## Scenario 1 — Enable the feature group

1. Open **Settings → Notor → Orchestration**.
2. Toggle **Enable orchestrations** on.
3. Observe that the directory `{notor_dir}/orchestrations/` is created and the `orchestration-creator`
   built-in persona becomes available.

**What happens under the hood.** This mirrors the Memory feature group exactly (FR-119). The toggle
sets `orchestration_enabled: true` in settings, then calls
`ctx.plugin.getExtensionManager()` → `manager.reload(false)`, which re-runs scaffold compilation.
Because every orchestration scaffold (`emit_event`, `run_flow`, the four task tools) declares
`featureGroup: "orchestration"` and `FEATURE_GROUP_TOGGLES` maps `orchestration →
"orchestration_enabled"` (`src/extensions/manager.ts`), the scaffolds are only registered once the
toggle is on. The setting section lives at `src/settings/sections/orchestration.ts` (mirror of
`src/settings/sections/memory.ts`); the toggle/default are added in `src/settings/types.ts` and
`src/settings/defaults.ts` (default `false`).

> **Validation point:** with the toggle **off**, the "Notor: Run Orchestration" command does **not**
> appear in the palette and `emit_event` is not in any tool list. Toggle on, and both appear after the
> extension reload. Toggle back off — they disappear again. (Tasks: ENV-001, ENV-002, FEAT-009.)

---

## Scenario 2 — Author a minimal flow by hand

You can use the `orchestration-creator` persona to generate this interactively (FR-160). Here we
author it by hand to show the literal vault content. Full frontmatter schema:
[data-model.md](data-model.md) and [contracts/vault-schema.md](contracts/vault-schema.md).

### 2a. Directory layout

A flow is a directory under `{notor_dir}/orchestrations/` with a `definition.md` and a `steps/`
subdirectory (FR-110, FR-111):

```
{notor_dir}/
  orchestrations/
    hello-research/
      definition.md          # flow topology, loop config, guardrails
      steps/
        plan.md              # conversation step
        gather.md            # conversation step
        check.md             # CODE step (deterministic routing)
        report.md            # conversation step (terminal)
```

The step note bodies are the instructions; the **body of `definition.md` is documentation only** and
is never injected into any prompt (FR-110).

### 2b. `definition.md`

```yaml
---
notor-type: orchestration-flow
notor-flow-name: "Hello Research"
notor-flow-description: "Plan, gather, sanity-check, and report on a small research question."
notor-starting-event: research.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 20
notor-max-runtime-minutes: 30
notor-required-events:
  - gather.done
notor-steps:
  - "[[plan]]"
  - "[[gather]]"
  - "[[check]]"
  - "[[report]]"
notor-guardrails:
  - "Cite a source for every factual claim."
  - "If a step has no new information to add, route forward rather than looping."
---

# Hello Research Flow

Give it a research question as the prompt. The flow plans an approach, gathers findings into
the scratchpad, checks that something was actually gathered, then writes a short report.
```

`notor-steps` wikilinks resolve against `steps/`. By default each trigger topic maps to **exactly one**
step in the flow — an undeclared collision (two steps triggering on the same topic) is rejected at load
with a clear error (FR-111). To intentionally fan one topic out to multiple steps, list it in the
flow's `notor-fanout-topics`; those steps then run in `notor-steps` order (FR-112). The parser also runs
**load-time topology validation** (FR-110): it hard-errors if the completion event is unreachable from
the starting event or a required-event is never published, and warns on orphan/dead topics — so
structural mistakes surface at author time, not mid-run.

### 2c. A conversation step — `steps/gather.md`

```yaml
---
notor-type: orchestration-step
notor-step-name: "🔎 Gather"
notor-step-description: "Collects findings into the scratchpad."
notor-step-triggers:
  - plan.done
notor-step-publishes:
  - gather.done
notor-step-default-publishes: gather.done
notor-step-persona: researcher
notor-step-model: null
notor-step-mode: conversation
notor-step-mcp-servers: null
---

## Gather findings

1. Read `plan.md` from the session scratchpad to see the planned angles.
2. Use `web_search` / `fetch_webpage` to collect findings for each angle.
3. Write the **complete** set of findings (with sources) to `findings.md` in the scratchpad —
   **overwrite the whole file** with the full current set; do **not** append incrementally. (Scratchpad
   writes must be overwrite/idempotent so a crash-recovery re-run cannot duplicate content — FR-121/125.)
4. When you have at least one well-sourced finding per planned angle, call
   `emit_event` with topic `gather.done` and a one-line summary as the payload.
```

The body is wrapped by the `StepPromptBuilder` scaffold (orientation → execute → verify → report →
guardrails), which **always** injects the must-publish rule, the objective, the incoming event, the
recent event history, and the scratchpad path (FR-114). `notor-step-persona: researcher` is resolved
via `PersonaManager.getPersonaByName()` **without** mutating global state (FR-115); its
`<notor_tool_config>` governs what `gather` may do, and its preferred provider/model picks the LLM
(overridable by `notor-step-model`). If the model never calls `emit_event`, the engine synthesizes
`default_publishes` (`gather.done`) so the loop does not stall.

> `plan.md` (the first step) triggers on `research.start` and publishes `plan.done`; `report.md`
> (the terminal step) triggers on `check.passed` and emits `FLOW_COMPLETE`. They follow the same
> shape — omitted here for brevity.

### 2d. A code step — `steps/check.md`

A code step (`notor-step-mode: code`) runs deterministic TypeScript with **no LLM call and no JSONL
conversation** (FR-130). It receives `[app, obsidian, utils, libs, event, orchestration]`
(`CODE_STEP_ARG_NAMES`) and routes the flow by its return value. Full helper API:
[contracts/orchestration-helper.md](contracts/orchestration-helper.md).

````markdown
---
notor-type: orchestration-step
notor-step-name: "✅ Check"
notor-step-description: "Verifies findings were actually gathered before reporting."
notor-step-mode: code
notor-step-triggers:
  - gather.done
notor-step-publishes:
  - check.passed
  - FLOW_CANCELLED
notor-step-default-publishes: FLOW_CANCELLED
---

# Check

Routes to the reporter only if the scratchpad actually has findings; otherwise cancels.

```typescript
const findings = await orchestration.scratchpad.read("findings.md");

if (!findings || findings.trim().length === 0) {
  // Nothing was gathered — cancel without tripping task enforcement.
  return orchestration.emit("FLOW_CANCELLED", "No findings were gathered.");
}

await orchestration.scratchpad.write(
  "check.md",
  `Verified ${findings.length} chars of findings at ${new Date().toISOString()}`,
);

return orchestration.emit("check.passed", JSON.stringify({ bytes: findings.length }));
```
````

The code-fence body is extracted, type-stripped via the existing Sucrase pipeline (`stripTypes`), and
compiled to an `AsyncFunction` with the injected args — the same pipeline that powers user-defined
tools (FR-130). A thrown error fires `{step}.code_error` with the stack and shows an error Notice
while still logging `turn.start`/`turn.complete` (FR-130). `FLOW_CANCELLED` is a terminal event that
ends the run with status `cancelled` and **bypasses** completion-task enforcement (FR-132).

> **Validation point:** running the flow produces step conversations for `plan`/`gather`/`report` but
> **no** conversation file for `check` (zero tokens, no JSONL). (Tasks: FEAT-002, FEAT-005, INT-010,
> INT-011, INT-012.)

---

## Scenario 3 — Run it

1. Open the command palette → **Notor: Run Orchestration**.
2. Pick **Hello Research** from the flow picker.
3. Enter a prompt, e.g. `What are the tradeoffs of event-sourcing for a small app?`
4. Press run.

**What you see.** After each step turn, a brief **progress Notice** names the flow, step, and
iteration — e.g. `Hello Research · 🔎 Gather · iteration 2` (FR-140). (That `iteration N` is the
**step-turn / HOP counter, which INCLUDES code steps** — it is **not** the same unit as
`notor-max-iterations`, which counts **LLM turns only**; a code step advances the HOP counter but not the
LLM-turn budget.) The starting event
(`research.start`) carries your prompt; routing then proceeds
`research.start → plan → plan.done → gather → gather.done → check → check.passed → report →
FLOW_COMPLETE`. The original objective is re-injected into every step turn, so each step is grounded
even though it starts from fresh context.

**What you do not see in the flat list.** Each step turn creates its own conversation (its own JSONL
file), but step conversations are **hidden from the flat conversation sidebar** — exactly as
sub-agent conversations already are (`_type: "orchestration_step_conversation"` is excluded from
`listConversations()`/`searchConversations()`, generalizing the `isSubAgentFilename` filter; FR-126).
The run tree (Scenario 4) is where you see them.

The engine writes `session-log.jsonl` write-before-route under
`{notor_dir}/orchestrations/sessions/{session-id}/`, and the session scratchpad (`scratchpad/`) is the
restriction-free shared workspace each step reads/writes (FR-120, FR-121) — its path is auto-allowed
in path enforcement for the owning session's steps.

> **Validation points:** (a) per-turn Notices appear; (b) the run terminates on `FLOW_COMPLETE`;
> (c) if all four steps run but `findings.md` is empty, the run instead terminates `cancelled` via the
> code step; (d) none of the step conversations show in the flat sidebar. (Tasks: FEAT-010, FEAT-011,
> INT-020, INT-006; e2e gate TEST-007.)

---

## Scenario 4 — Inspect the run tree

The **run-tree view** is the only surface where hidden step conversations are visible. It is unified —
one tree renders orchestration steps (via `orchestration_edges`) *and* sub-agents (via
`parent_conversation_id`) (FR-178). Detailed UX: the Run-tree view design note; data model:
[contracts/edges.md](contracts/edges.md).

**Three ways in (all land in the same panel, rooted at the whole run):**

1. **Click the spawning tool-call card** in the main chat (a `run_flow` / sub-agent card). It first
   shows an inline one-level **peek card** — the direct child's summary plus the aggregate rollup —
   with an **"Open run tree"** affordance (FR-179).
2. **Click a flow-run entry in the activity indicator** (the unified indicator with typed entries;
   flow-run entries open the run tree).
3. **Right-click a progress Notice** → **"Open run tree"** (or **"Jump to this step"** for that one
   conversation), reusing the desktop `oncontextmenu` Notice pattern (FR-141).

**Navigating nodes.** Selecting a node loads that node's conversation in the main chat panel (via
`switchToConversationById`); the tree stays open with the node highlighted. **Selected** (what you are
reading) and **active** (what is executing) are visually distinct — you can read an earlier completed
step while a later one runs. Smart auto-expand opens the spine to the active/most-recent node and
collapses finished branches; manual collapse is ephemeral (not persisted). Descending into a child
flow or sub-agent is just expanding its `child` edge; ascending is one hop up `parent`.

**Aggregate rollup.** The root header shows the whole-subtree totals — cost / iterations / max depth —
sourced from the root run's `RunContext.subtreeConsumed` accumulator (the root subtree is the whole tree;
FR-176, FR-177), and reconstructed on reload by replaying `turn.complete` `cost_usd`/`token_usage`. For a
single flow this is the flow's own totals; with composition (Scenario 5) it sums the entire child tree.

**Live → static.** While the run is active, the tree shows a `[⟳ live]` badge and updates as turns
complete (subscribed via the `WorkflowActivityTracker.onChange()` pattern over the `turn.start` /
`turn.complete` / `event.emitted` log write points). When the run finishes it renders `[● done]`,
static from the persisted log. A recovered run (Scenario 6) re-attaches its live subscription.

> **Validation points:** (a) all three entry points open the same rooted tree; (b) the code step
> appears as a node even though it has no conversation to open into (it has no JSONL — selecting it is
> a no-op / shows step metadata only); (c) the header rollup matches per-step token sums; (d) the live
> badge flips to done at terminal. (Tasks: POL-003, POL-004, INT-006, INT-047.)

---

## Scenario 5 — Compose two flows

Make `hello-research` callable from another flow, then call it.

### 5a. Mark the callee invocable

Add composition frontmatter to `hello-research/definition.md` (inert unless the feature group is
enabled; FR-170):

```yaml
notor-flow-invocable: true
notor-flow-inputs: "A single research question as a plain string."
notor-flow-returns: "A short markdown report with at least one cited source per angle."
notor-handoff-isolation: isolated
notor-max-depth: 3
```

The contract lives in the **callee**, so callers stay decoupled. `notor-flow-inputs` /
`notor-flow-returns` are deliberately freeform natural language (FR-170).

### 5b. Call it from another flow's step

In a second flow, a step calls `run_flow`. The tool's `flow` parameter is a **dynamic enum of
discovered invocable flows**, with each flow's `notor-flow-inputs` surfaced in the description —
mirroring `UseSubagentTool`'s dynamic `get description()` / `get input_schema()` (FR-172). A
conversation step instruction:

```markdown
Call `run_flow` with flow `Hello Research` and a payload containing the user's research question.
Use the returned report as the basis for your summary.
```

A code step can call it programmatically via `orchestration.callTool("run_flow", { flow: "...",
payload: "..." })`.

**What happens.** `run_flow` is **orchestration-context-only** — it returns `success: false` if called
outside a flow step (e.g. from a foreground chat), so a parentless, unrecoverable child flow cannot exist
(FR-172). From a step, it runs the child flow to its terminal event in a **child session** on a **child
`RunLoop`**, then returns the child's result to the caller — preferring `structured` and falling back to
`text` (FR-173). `structured` is populated **only** when the child's *terminal* step is
a **code step** that passes a third argument to `emit`, e.g. `return orchestration.emit("FLOW_COMPLETE",
"3 angles covered.", { report, sources })` — the runner lifts that object onto `RunResult.structured`
verbatim. If the terminal step is instead a conversation step (as in the `report` step above), the
caller receives its closing `text` (shaped by `notor-flow-returns`). To make `hello-research` return
`structured`, give it a terminal code step that aggregates the scratchpad and emits the completion event
with the structured object. The child session records `parent_session_id` and links into the parent's
recovery tree; `isolated` (default) gives it a fresh scratchpad/tasks, while `shared` would inherit the
parent's scratchpad and auto-allow its path (FR-174). Cascading guardrails gate the spawn: it proceeds
only if `depth < maxDepth` AND the **shared** aggregate-budget cell has headroom (FR-176).

**What you observe.**

- The calling step's tool-call card renders the shared **`child_run_metadata`** peek (direct child
  summary + aggregate subtree rollup) — the same rendering path `use_subagent` uses (FR-177; single
  authority [contracts/edges.md](contracts/edges.md)). The per-subtree numbers come from the child run's
  **`RunContext.subtreeConsumed`** accumulator (its own subtree only) — **not** a delta of the shared
  aggregate-budget cell, which would absorb concurrent siblings' spend (FR-176/177).
- Opening the run tree shows the **child flow's subtree** nested under the calling step via a `child`
  edge carrying `session_id` and `via_tool_call_id`; the header rollup now includes the child tree's
  cost/iterations/depth.
- The structured return appears as the tool result fed back into the calling step's context.

> **Validation points:** (a) `Hello Research` appears in the `run_flow` enum once invocable, and
> disappears if you set `notor-flow-invocable: false`; (b) the child subtree appears under the caller
> in the run tree; (c) the returned value is the child's `structured` payload when its **terminal step
> is a code step** that called `emit(topic, payload, structured)`, else its closing `text`; (d) setting
> `notor-max-depth: 1` and nesting a third level blocks the deepest spawn and surfaces that to the
> caller; (e) the deep-spawn block is over the *shared* budget cell — a child's spend is visible to the
> root rollup. (Tasks: INT-040, INT-041, INT-042, INT-043, INT-044, INT-046, INT-047; e2e gate
> TEST-008.)

---

## Scenario 6 — Recovery after reload

1. Start a `hello-research` run.
2. While it is mid-run (e.g. during the `gather` turn), reload the plugin
   (**Settings → Community plugins → toggle Notor off/on**, or reload Obsidian).
3. On load, Notor scans `orchestrations/sessions/` for sessions with status `active` / `interrupted`
   and offers a **"Resume orchestration?"** prompt summarizing where it left off.
4. Confirm the prompt — the run resumes.

**How recovery works (FR-125).** Recovery replays `session-log.jsonl` idempotently. The top-level scan
selects recovery roots by `origin` (which is **always set** at creation, never null — an absent/unexpected
origin is surfaced as a **loud diagnostic**, not silently skipped): **`origin: "user"`** roots always, and
**`origin: "chaining"` successors whose predecessor is already terminal are recovered as roots** (a chained
successor is fire-and-forget — its predecessor finalized before it launched, so it has no live parent to
reconcile it). `origin: "run_flow"` children are **not** scanned at the top level — they are reconciled by
the parent's replay.

- A dangling `turn.start` with no matching `turn.complete` means a turn was interrupted → the engine
  **re-emits the triggering event** so the step retries from fresh context.
- A dangling `event.emitted` with no following `turn.start` means an event was written but not routed
  → the engine **re-publishes the event**.
- A replayed parent turn that invoked `run_flow` is reconciled from the parent's durable
  **`child.spawned` / `child.result`** ledger: a child with a recorded `child.result` (terminal) is
  **reused** — the recorded `structured`/`text` + `stop_reason` is fed back, the parent does **not**
  re-spawn; a `child.spawned` with **no** `child.result` (non-terminal) is **resumed in place** — that
  child session replays its **own** log and the parent awaits it. The child is **never
  tombstoned-and-respawned**, so its `once()` `side_effect.committed` markers survive the crash and an
  already-committed external effect is not re-run.
- **Budget + safety are rebuilt on reload**, not reset: the in-memory aggregate-budget cell is rebuilt by
  replaying each `turn.complete`'s `cost_usd` / `token_usage` (a `$5.00` cap that had spent `$4.90`
  resumes at `$0.10` remaining, **not** `$5.00`), and the stale-loop window + per-task thrashing counters
  are rehydrated from the replayed event/task history (a near-stale self-loop fires on the next repeat
  post-reload, not N more).

Replay is **at-least-once, not exactly-once.** The engine's own bookkeeping (events, turns) replays
idempotently, and vault state is safe to repeat **provided scratchpad writes are overwrite/idempotent**
(a re-run step rewrites the whole file, so re-running just reproduces the same content). This is a real
authoring constraint, not an automatic guarantee: a step that *appends* to a scratchpad file would
**duplicate** content on a recovery re-run, and `once(...)` does **not** cover scratchpad state (it
guards only external effects). The scaffold, reference flows, and `orchestration-creator` persona all
instruct steps to **overwrite, never append** (write the complete current content, or use a
per-iteration filename like `findings-{iteration}.md`). With that constraint honored, recovery is safe
for vault state. But a re-run step **repeats any external, non-idempotent side effect** it performed
before crashing —
e.g. a `git push`, a Slack/MCP post, a deploy. A plugin cannot make those transactional, so steps with
such effects must be idempotent or **guard themselves with `orchestration.once(key, fn)`** (FR-131),
which records a `side_effect.committed` log entry so a re-run skips the already-committed effect
(best-effort — it cannot cover a crash *during* the effect). The prompt scaffold and the
`orchestration-creator` persona instruct authors to wrap non-idempotent effects this way. A run paused
on `user.input.required` (FR-150) is treated as a recoverable log state and resumes at the prompt after
a reload. A recovered run re-attaches its run-tree live subscription, flipping the badge back to
`[⟳ live]`.

> **Validation points:** (a) the resume prompt appears after reloading mid-run; (b) confirming resumes
> to completion; (c) re-running recovery twice (e.g. reload again immediately) does not duplicate
> *engine events/turns*; (d) a side effect wrapped in `orchestration.once(key, fn)` is **not** repeated
> on re-run (a `side_effect.committed` entry was written), whereas an unguarded external effect **may**
> repeat — the at-least-once boundary. (Tasks: INT-005, INT-001, FEAT-006; e2e/unit gate TEST-005.)

---

## Validation checklist (VAL-001)

Observable outcomes to confirm the feature end-to-end. Each maps to FRs in [spec.md](spec.md) and
tasks in [tasks.md](tasks.md).

- [ ] **Gating on:** enabling `orchestration_enabled` creates `{notor_dir}/orchestrations/`, registers
      the `emit_event` / task / `run_flow` scaffolds, and surfaces "Notor: Run Orchestration". (FR-119)
- [ ] **Gating off:** disabling it removes the command and all scaffolds after the extension reload.
      (FR-119)
- [ ] **Authoring:** a hand-authored flow (`definition.md` + `steps/`) is discovered and appears in the
      flow picker; the `definition.md` body is never injected into a prompt. (FR-110, FR-111)
- [ ] **Finite ceiling defaults:** a `definition.md` that omits `notor-max-iterations` /
      `notor-max-runtime-minutes` / `notor-max-cost-usd` still runs bounded — the parser injects finite
      defaults (`100` / `60` / `5.00`, never `Infinity`). (FR-117/FR-119a)
- [ ] **Orphan hard-error:** a published-but-unsubscribed non-terminal topic is rejected at **load**
      (hard error, not a runtime fallback). (FR-110)
- [ ] **Routing + breadth-first FIFO fan-out:** the run routes
      `research.start → plan → gather → check → report → FLOW_COMPLETE` with one step per trigger topic;
      a declared fan-out drains breadth-first FIFO (all direct subscribers, then their consequences in
      order). (FR-112, FR-118)
- [ ] **No-progress completion guard:** a `FLOW_COMPLETE` re-blocked from the same step with a
      non-shrinking open-task / missing-required-event set terminates with `FLOW_ERROR` at the threshold
      (default 3), rather than draining the budget. (FR-123)
- [ ] **Must-publish always injected:** a step with no `emit_event` call still advances via its
      `default_publishes`. (FR-114, FR-115)
- [ ] **Code step:** `check` runs with no conversation file and zero tokens; its return value routes
      the flow; an error fires `{step}.code_error`. The timeout (default 300 s) fires only at `await`
      boundaries — an unbounded synchronous loop is **not** interruptible (no Worker isolation in v1), so
      step bodies avoid them and insert `await` yield points. (FR-130, FR-131)
- [ ] **Cancellation:** an empty `findings.md` drives `FLOW_CANCELLED`, terminating with status
      `cancelled` and bypassing task enforcement. (FR-132)
- [ ] **Progress Notices:** a per-turn Notice names flow + step + iteration; right-click (desktop)
      jumps into the step conversation. (FR-140, FR-141)
- [ ] **Hidden from flat list:** step conversations do not appear in the flat sidebar or search.
      (FR-126)
- [ ] **Run tree:** reachable from the spawning card, the activity indicator, and a progress Notice;
      one tree renders steps and sub-agents; selecting a node loads its conversation; the header shows
      the aggregate rollup; live while running, static when done. (FR-178, FR-179)
- [ ] **Composition:** an invocable flow appears in the `run_flow` enum; `run_flow` is
      **orchestration-context-only** (`success: false` outside a flow step); calling it runs a child
      session on a child `RunLoop`; the structured return is preferred over text; the child subtree
      nests in the run tree via a `child` edge with `via_tool_call_id`; the per-subtree rollup numbers
      come from the child run's `subtreeConsumed` (not a shared-cell delta). (FR-170…FR-174, FR-177)
- [ ] **Cascading guardrails:** a spawn is gated on `depth < maxDepth` AND the **shared** aggregate
      budget cell (tree-wide, decrements visible to parent/siblings); a blocked spawn surfaces to the
      caller and in-flight runs finish their current turn; a two-flow on-complete (`A → B → A`) chaining
      cycle terminates at `max_depth` / the aggregate budget (successor shares the cell by reference).
      (FR-176)
- [ ] **Recovery (at-least-once):** reloading mid-run offers a resume prompt; resuming completes the
      run; engine-bookkeeping replay is idempotent (including a paused-on-input session). A `run_flow`
      child is **reused** from its recorded `child.result` (terminal) or **resumed in place** (non-terminal
      — never tombstone-and-respawn, so its `once()` markers survive); a chained successor whose
      predecessor is terminal is recovered as a **root**; the aggregate budget is **rebuilt** on reload
      (a cost cap is not reset to full). An `orchestration.once`-guarded side effect is not repeated on
      re-run, while unguarded external effects may repeat (documented boundary). (FR-125, FR-131, FR-150)
- [ ] **Sub-agent regression gate (foundation):** existing sub-agent suites pass unmodified after the
      `RunLoop` extraction — no behavioral change. (FR-101; release-blocker TEST-001)
