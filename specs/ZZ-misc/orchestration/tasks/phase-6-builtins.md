# Task Bodies: Phase 6 — Built-in Flows + Orchestration Creator Persona (Polish)

**Created:** 2026-06-27
**Specification:** [../spec.md](../spec.md) (FR-160 group)
**Data Model:** [../data-model.md](../data-model.md)
**Master Task Index:** [../tasks.md](../tasks.md)
**Contracts:** [../contracts/vault-schema.md](../contracts/vault-schema.md) · [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md) · [../contracts/tools.md](../contracts/tools.md) · [../contracts/edges.md](../contracts/edges.md)
**Status:** Draft

This file holds the full task **bodies** for design Phase 6 (repo phase: **Polish**) — task IDs
**POL-001**, **POL-002**, and **DOC-001**. Task IDs and their dependency edges are owned by
[../tasks.md](../tasks.md); the IDs and edges reproduced here match it exactly. The covered functional
requirements are **FR-160** (orchestration-creator persona) and **FR-161** (reference flows); DOC-001 is
a cross-cutting documentation/persona-maintenance task that also carries the Phase 3 code-step-guidance
work item (`INT-013`).

Design references: [orchestration.md → Built-in Orchestration Creator Persona], [orchestration.md →
Programmatic Code Steps], [orchestration.md → Composition / Flow Handoff], and the reference-flow
sketches in [orchestration.md → Replaces Verification Steps] (canonical vault design doc). Schema
authorities are linked, not redefined: the `definition.md` / step-note frontmatter is the authority of
[../contracts/vault-schema.md](../contracts/vault-schema.md); the `OrchestrationHelper` code-step API is
the authority of [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md); the
`run_flow` / `emit_event` / task-tool I/O is the authority of
[../contracts/tools.md](../contracts/tools.md).

## Phase scope and sequencing

Phase 6 is the **prompt-engineering-heavy polish layer** and is flagged **high-risk** in the design's
risk assessment ("Step prompt engineering quality" and "the reference flows in Phase 6 are where this
quality bar is proven"). None of these tasks is on the critical path, but all three depend on real
engine surfaces being in place, so Phase 6 lands late:

- **POL-001** (`orchestration-creator` persona) depends on **FEAT-002** (the flow/step parser — the
  persona must author frontmatter the parser actually accepts) and **INT-040** (the Phase 7 composition
  frontmatter + parser extension — the persona teaches the composition fields `notor-flow-inputs` /
  `notor-flow-returns` / `notor-flow-invocable` / `notor-on-complete-flow`, which only exist once
  INT-040 lands).
- **POL-002** (reference flows) depends on **FEAT-010** (the runner — each reference flow must run
  end-to-end), **INT-010** (the code-step executor — the reference flows demonstrate code steps), and
  **INT-040** (composition frontmatter — the reference flows demonstrate composition, e.g. one flow
  invoking another via `run_flow`).
- **DOC-001** depends on **POL-001** (it documents and aligns the persona it produced) and **INT-011**
  (the `OrchestrationHelper` runtime API — the code-step docs and the persona's code-step guidance must
  describe the API as actually implemented). DOC-001 also discharges **INT-013** (code-step guidance),
  which Phase 3 deliberately deferred "into POL-001 / DOC-001."

**No phase-specific test gate.** Phase 6 has no dedicated `TEST-00x` unit gate in
[../tasks.md](../tasks.md); its quality bar is proven by the all-phase e2e gates (`TEST-007` single
flow; `TEST-008` `run_flow` child + run-tree) — the reference flows of POL-002 are natural fixtures for
those e2e runs — and by the `audit-personas-docs` discipline that DOC-001 institutionalizes (see
DOC-001). Per-task acceptance criteria below are the verifiable bar.

> **Why high-risk, restated.** The engine is only as reliable as the prompts that drive it. The
> `StepPromptBuilder` scaffold (FEAT-005) is the engine's half; the **authored step bodies** and the
> **persona that teaches users to author them well** are the human half. POL-001 and POL-002 are where
> that half is exercised and tuned. Treat the system prompts and reference-flow step bodies as
> iterated artifacts, not one-shot deliverables.

---

## POL-001: `orchestration-creator` built-in persona

**Description:** Add a third built-in persona, `orchestration-creator`, that interactively guides a user
through authoring an orchestration flow — mirroring the two existing built-ins (`notor-help`,
`tool-creator`) in registration shape and authoring discipline. It is a `BuiltinPersonaDefinition`
(`{ name, description, systemPromptContent }`) added to the `BUILTIN_PERSONA_PROFILES` map in
`src/personas/builtin-personas.ts:318` (the map currently holds only `notor-help` and `tool-creator`;
`BUILTIN_PERSONA_NAMES` is derived from its keys, so the addition is picked up automatically). Like the
existing built-ins, the vault file at `{notor_dir}/personas/orchestration-creator/system-prompt.md` is
materialized from this constant on first "Open" in Settings, user edits are preserved, and "Reset to
default" overwrites it.

The persona's job (per [orchestration.md → Built-in Orchestration Creator Persona]):

1. **Discuss the flow concept** with the user — what steps are needed, what events connect them
   (the topology), and where a deterministic **code step** beats an LLM step (pre-flight checks,
   verification, routing, data-fetch, notifications, aggregation).
2. **Create the flow directory + `definition.md`** under `{notor_dir}/orchestrations/{flow-name}/` with
   correct `notor-type: orchestration-flow` frontmatter (the full field set from
   [../contracts/vault-schema.md](../contracts/vault-schema.md)).
3. **Create step notes** under `{flow-dir}/steps/` with `notor-type: orchestration-step` frontmatter —
   both conversation steps (with a `notor-step-persona`) and code steps (`notor-step-mode: code` with a
   TypeScript fence).
4. **Suggest or create personas** for conversation steps that need a distinct role/tool profile (under
   `{notor_dir}/personas/`).
5. **Validate the topology** — every `notor-step-triggers` topic has a publisher, no orphaned events,
   each trigger topic maps to at most one step per flow (the FR-111 load-time invariant), and a path
   exists from `notor-starting-event` to the `notor-completion-event`.

The `systemPromptContent` is `notor-persona-prompt-mode: append` (like both existing built-ins) with a
distinct `notor-persona-chip-emoji` (e.g. a flow/loop glyph), and it MUST include:

- **The vault-schema reference, inlined.** The persona cannot rely on the spec docs at runtime — it must
  carry the `definition.md` and step-note frontmatter field reference in its own prompt body (mirroring
  how `tool-creator` inlines the tool file format and the `utils`/`libs` API). This is the **single
  largest authoring risk**: if this inlined reference drifts from
  [../contracts/vault-schema.md](../contracts/vault-schema.md), the persona writes frontmatter the
  parser (`FEAT-002`) rejects. DOC-001's audit is the standing guard against that drift.
- **Code-step guidance (the `INT-013` work item).** When to choose `notor-step-mode: code`, the arg
  signature `["app", "obsidian", "utils", "libs", "event", "orchestration"]`, the
  `return orchestration.emit(topic, payload?, structured?)` contract (incl. `once(key, fn)` for
  non-idempotent side effects and the terminal-`structured` return), the scratchpad / `callTool` / `callMcpTool` /
  `tasks` helper surface, and the error model (a thrown error fires `{step}.code_error` and shows a
  Notice). The authority is [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md);
  the persona inlines a faithful summary. It MUST also teach the recovery-safety + timeout caveats:
  - **Overwrite-only scratchpad + `once()` for non-idempotent effects.** Scratchpad writes are
    **overwrite-only** (never incrementally append — a crash-recovery re-run would duplicate appended
    content); wrap any external non-idempotent side effect (git push, Slack/MCP post, deploy) in
    `orchestration.once(key, fn)` so a re-run skips an already-committed effect (at-least-once boundary,
    FR-125).
  - **Never write an unbounded synchronous loop in a code step (Issue-7).** Code steps run as
    `new AsyncFunction` on the **main event-loop thread** (no Worker isolation in v1), so the timeout
    (default 300 s) fires **only at `await` boundaries**; an unbounded synchronous loop (`while(true){}`)
    is **not interruptible** and freezes the plugin. Always insert `await` yield points in long loops and
    bound iteration counts.
- **Verification + deterministic routing discipline.** Teach that the engine has **no** semantic verifier
  (a `completed`-but-wrong emission is taken at face value), so authors should **wire a verifier on a
  step's output edge** (the canonical `[Builder] → [Verify Tests] → …` code-step pattern), and route
  distinct outcomes through **distinct topics** driven by a **deterministic code-step router** rather than
  re-firing one topic and relying on the stale-loop guard.
- **The composition fields (depends on `INT-040`).** How to make a flow invocable
  (`notor-flow-invocable: true`), how to write a good `notor-flow-inputs` / `notor-flow-returns`
  natural-language contract, that the reliable return is a terminal **code step** populating
  `structured` (the loose conversation-step `text` is the fallback), and chaining via
  `notor-on-complete-flow` + `notor-handoff-isolation`. Authority:
  [../contracts/tools.md](../contracts/tools.md) (`run_flow`) and the `definition.md` composition fields
  in [../contracts/vault-schema.md](../contracts/vault-schema.md).
- **The must-publish discipline.** Teach that every conversation step body should make the emission
  explicit, that `notor-step-default-publishes` is the no-emit fallback, and that the engine's scaffold
  (FEAT-005) always injects the must-publish rule — so step bodies should not fight it.

**Tool access** — the `<notor_tool_config>` block (from [orchestration.md → Built-in Orchestration
Creator Persona]), with write access **scoped** to the two directories the persona authors into:

```yaml
<notor_tool_config>
write_note:
  enabled: true
  allowed_paths:
    - "{notor_dir}/orchestrations/"
    - "{notor_dir}/personas/"
read_note:
  enabled: true
  auto_approve: true
search_vault:
  enabled: true
  auto_approve: true
list_vault:
  enabled: true
  auto_approve: true
use_subagent:
  enabled: true
web_search:
  enabled: true
fetch_webpage:
  enabled: true
</notor_tool_config>
```

The `allowed_paths` restriction is enforced by the existing path enforcer
(`enforcePathConstraints(...)` at `src/tool-config/path-enforcer.ts:45`; merged through
`mergeToolConfigs()` at `src/tool-config/merger.ts:57`) the same way `tool-creator`'s `write_note`
access works today — this persona may write flow/step/persona notes but not arbitrary vault notes.

> **Note — this persona authors flows; it does not require the orchestration feature group to run.** The
> persona is a normal built-in (it uses `write_note`/`read_note`/`search_vault`, not `emit_event` or
> `run_flow`), so it is usable to *author* a flow even before the user has enabled
> `orchestration_enabled`. It should, however, remind the user that running the authored flow requires
> enabling the orchestration feature group (Settings → Orchestration), and that the orchestration tool
> scaffolds (`emit_event`, task tools, `run_flow`) only register when the group is on.

**FRs:** FR-160 (orchestration-creator built-in persona); carries the code-step-guidance half of FR-130
into the persona surface (the `INT-013` work item, completed jointly with DOC-001).

**Files:**
- `src/personas/builtin-personas.ts` — add the `ORCHESTRATION_CREATOR: BuiltinPersonaDefinition`
  constant and register it in `BUILTIN_PERSONA_PROFILES` (~318) alongside `NOTOR_HELP` and
  `TOOL_CREATOR`. `BUILTIN_PERSONA_NAMES` derives from the map keys — no separate edit.
- (No new discovery code.) `discoverPersonas()` (`src/personas/persona-discovery.ts:42`) and
  `getPersonaByName()` (`src/personas/persona-manager.ts:106`) already resolve built-ins via the map;
  the persona's frontmatter keys (`notor-persona-prompt-mode`, `notor-persona-chip-emoji`) are the
  existing discovered keys.

**Dependencies:** `FEAT-002` (flow/step parser — the persona must emit frontmatter the parser accepts),
`INT-040` (composition frontmatter + parser extension — the persona teaches the composition fields).

**Acceptance Criteria:**
- [x] `orchestration-creator` is registered in `BUILTIN_PERSONA_PROFILES` alongside `notor-help` and
  `tool-creator`, and appears in `BUILTIN_PERSONA_NAMES` (derived from map keys).
- [x] Selecting "Open" in Settings materializes
  `{notor_dir}/personas/orchestration-creator/system-prompt.md`; user edits are preserved; "Reset to
  default" restores the constant (same lifecycle as the existing two built-ins).
- [x] Write access is **scoped** via `<notor_tool_config>` `allowed_paths` to `{notor_dir}/orchestrations/`
  and `{notor_dir}/personas/`; a write outside those prefixes is blocked by the path enforcer.
- [x] The system prompt inlines a faithful summary of the `definition.md` and step-note frontmatter
  (consistent with [../contracts/vault-schema.md](../contracts/vault-schema.md)), the code-step contract
  (consistent with [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md)), and
  the composition fields (consistent with [../contracts/tools.md](../contracts/tools.md)).
- [x] The system prompt carries the recovery-safety + timeout authoring guidance: **overwrite-only
  scratchpad** + **`once(key, fn)` for non-idempotent effects**; **never write an unbounded synchronous
  loop** in a code step and **insert `await` yield points** (the timeout fires only at `await` — Issue-7);
  **wire a verifier on a step's output edge** (the engine has no semantic verifier); and **distinct topics
  per outcome + a deterministic code-step router**.
- [x] A flow authored by following the persona (frontmatter + step notes it produces) parses without
  error under `FlowDefinitionParser` / `StepNoteParser` (FEAT-002) including the composition fields
  (INT-040) — verifiable by feeding a persona-authored sample flow through the parser.
- [x] The persona reminds the user that *running* a flow requires `orchestration_enabled` (the authoring
  persona itself does not).

---

## POL-002: Reference flows (code-assist, research, review)

**Description:** Ship three vault-native reference flows as first-party example assets, demonstrating
the three pillars of the engine — **conversation steps**, **code steps**, and **composition** — so users
have working, copy-able exemplars and so the e2e gates have realistic fixtures. Each is a flow directory
(`definition.md` + `steps/`) under `{notor_dir}/orchestrations/`, materialized when the user enables the
feature group (the orchestration tree is created on first enable; ENV-001 / FR-119), the same
"materialize-on-enable, preserve-user-edits" lifecycle the built-in personas use. The three flows
(matching FR-161 and [spec.md] User Stories):

1. **`code-assist`** — TDD-style implementation loop. **Demonstrates conversation steps + code steps.**
   Topology (illustrative; the authored bodies are the deliverable):
   - `📋 planner` (conversation) — decomposes the objective, owns the task queue via
     `orchestration_task_ensure`/`_start`/`_close`, emits `tasks.ready`.
   - `🛠️ builder` (conversation) — implements against the next task, emits `build.done` with the repo
     path as payload.
   - `🔍 verify-tests` (**code step**) — runs the suite via `utils.executeShellCommand("npm test", {
     cwd, timeout })` and routes deterministically: `return orchestration.emit("tests.passed", ...)` or
     `tests.failed` (this is the design's canonical "replaces verification steps" example). `tests.failed`
     re-triggers the builder; `tests.passed` advances to the critic.
   - `🧐 critic` (conversation) — adversarial review; emits `review.approved` or `review.changes`.
   - `✅ finalizer` (conversation) — closes remaining tasks and emits `FLOW_COMPLETE`.
   - `notor-required-events: [review.approved]`; guardrails: "verification is mandatory", "YAGNI".
   - **Invocable** (`notor-flow-invocable: true`) with a `notor-flow-inputs` ("a feature description +
     target repo path") and `notor-flow-returns` ("a summary + the list of files changed") so it can be
     the callee in the composition demo.

2. **`research`** — multi-phase research loop. **Demonstrates conversation steps + a structured-return
   terminal step.** Topology: `explore` → `synthesize` → `verify` → `summarize`, writing intermediate
   findings to the shared scratchpad and consulting `memories.md`. Its terminal step is authored as a
   **code step** that reads the scratchpad and `return orchestration.emit("FLOW_COMPLETE", ...)` with a
   **structured** payload (the reliable-returns path), so when `research` is invoked via `run_flow` the
   caller receives `structured` rather than loose text. `notor-flow-invocable: true`.

3. **`review`** — adversarial review flow. **Demonstrates composition (the `run_flow` caller side).**
   A `dispatch` step (conversation or code) invokes `code-assist` and/or `research` via the `run_flow`
   tool over the loose `payload` contract (each callee's `notor-flow-inputs` is surfaced in the tool
   description, the `use_subagent` dynamic-enum pattern), awaits the child's `RunResult`, then a
   `report` step composes the final review. This is the fixture that exercises the Phase 7 child-flow
   path end-to-end (the `TEST-008` shape: `run_flow` child + structured return + run-tree live→static).
   A `notor-on-complete-flow` chaining example may also be included here to demonstrate one-way handoff.

The reference flows MUST be authored against the parsers and tools they will actually run on — the
frontmatter is exactly what [../contracts/vault-schema.md](../contracts/vault-schema.md) defines, the
code fences use the [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md) API, and
the `run_flow` calls match [../contracts/tools.md](../contracts/tools.md). They are the primary place the
**high-risk step-prompt-quality** bar is proven (design risk assessment).

> **Authoring discipline (high-risk).** Each step body should be written so the step reliably (a) reads
> the incoming event + scratchpad before acting, (b) stays inside its role boundary (the planner does
> not implement; the critic does not write code), and (c) emits exactly one event from its declared
> `notor-step-publishes`. The engine's scaffold (FEAT-005) injects orientation/verify/report structure
> and the must-publish rule around every body; reference-flow bodies should complement that scaffold,
> not duplicate or fight it. Iterate the bodies against real runs. The reference flows must also model the
> recovery-safety + timeout caveats: **overwrite-only scratchpad writes**, **`orchestration.once(key, fn)`
> around non-idempotent external effects** (at-least-once recovery boundary), and **no unbounded
> synchronous loops in code steps** (the timeout fires only at `await` — Issue-7).

**FRs:** FR-161 (reference flows). Exercises FR-110/111 (flow/step schema), FR-130/131 (code steps +
helper), and FR-172/173 (`run_flow` composition) as authored content.

**Files:**
- `src/orchestration/reference-flows/` (or the established built-in-asset location used for built-in
  personas) — the source-of-truth constants for the three flows' `definition.md` and step-note bodies,
  materialized into `{notor_dir}/orchestrations/{flow-name}/` on feature-group enable. Mirrors the
  built-in-persona "constant in source, materialize-to-vault on first use" pattern
  (`src/personas/builtin-personas.ts`).
- `src/settings/sections/orchestration.ts` — the enable toggle (added by `ENV-002`) triggers
  directory + reference-flow materialization (the design's `ensureOrchestrationDirectory(ctx)` hook;
  see [orchestration.md → Feature Group Settings]); confirm reference flows are seeded there without
  overwriting user edits.
- (Test fixtures.) The three reference flows double as fixtures for `TEST-007` (single flow →
  `FLOW_COMPLETE`) and `TEST-008` (`run_flow` child + structured return + run-tree); no separate test
  task is owned here.

**Dependencies:** `FEAT-010` (runner — each flow must run end-to-end), `INT-010` (code-step executor —
the `verify-tests` / structured-return steps), `INT-040` (composition frontmatter — the `review` flow's
`run_flow` / chaining demo).

**Acceptance Criteria:**
- [x] Three reference flows (`code-assist`, `research`, `review`) are materialized under
  `{notor_dir}/orchestrations/` on feature-group enable, with user edits preserved on subsequent enables
  (idempotent seeding, never overwrites).
- [x] `code-assist` parses and runs end-to-end to `FLOW_COMPLETE`, exercising at least one **code step**
  (`verify-tests`) that routes on `tests.passed` / `tests.failed`, and uses the task registry +
  completion enforcement (`required_events: [review.approved]`).
- [x] `research` runs to a terminal step that populates a **structured** return (the
  reliable-returns path); when invoked via `run_flow`, the caller receives `structured` (preferred over
  `text`).
- [x] `review` demonstrates **composition** — a step invokes another reference flow via `run_flow` and
  consumes its `RunResult` — and the child flow appears under the parent in the run-tree view
  (`child`/`parent` `orchestration_edges`, per [../contracts/edges.md](../contracts/edges.md)).
- [x] Each flow's `definition.md` and step notes conform to
  [../contracts/vault-schema.md](../contracts/vault-schema.md) and parse without error under FEAT-002 +
  INT-040.
- [x] The reference flows serve as the `TEST-007` / `TEST-008` fixtures (each runs in the e2e harness
  without hand-editing).

---

## DOC-001: Docs + persona / tool-creator updates (with code-step guidance)

**Description:** Bring the user-facing documentation and the existing built-in personas up to date with
the orchestration subsystem, and **institutionalize the `audit-personas-docs` discipline** so the new
surfaces do not drift. Three coupled pieces:

1. **New `docs/orchestration.md`** — a user guide for the feature, in the house style of the existing
   `docs/` pages (`docs/extensions.md`, `docs/personas.md`, `docs/sub-agents.md`, `docs/workflows.md`,
   `docs/memory.md`). Covers: enabling the feature group (Settings → Orchestration), the flow/step vault
   schema (linking the canonical reference rather than duplicating it where possible), conversation vs.
   **code steps** (the `INT-013` guidance — when to use code, the arg signature, the
   `return orchestration.emit(...)` contract, the `OrchestrationHelper` surface from
   [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md), and the **code-step
   timeout caveat** — fires only at `await`, never write an unbounded synchronous loop, Issue-7), the
   session workspace / scratchpad / tasks / `memories.md`, running a flow from the command palette, the
   safety/limit model, composition (`run_flow` + chaining), and the run-tree view. It must note the
   **at-least-once recovery boundary** (overwrite-only scratchpad + `orchestration.once(key, fn)` for
   non-idempotent effects) and the **iteration-counter distinction (Issue-13c)** — the progress-Notice /
   `session.json` `iteration` (a step-turn/HOP counter that **includes code steps**) is **not** the same
   unit as `notor-max-iterations` (LLM turns only). It should reference the three POL-002 reference flows
   as worked examples.

2. **Persona / tool-creator updates.** Update the existing built-in personas so their inlined references
   account for the new surfaces, then verify there is **no drift** between code and prose:
   - **`notor-help`** — its inlined **settings deep-link section** must add the new **Orchestration**
     settings section (the `notor-settings://Orchestration` group string) so it can direct users to the
     toggle. Verify against the new `src/settings/sections/orchestration.ts` group name (mirrors
     `src/settings/sections/memory.ts`).
   - **`tool-creator`** — its inlined `utils` / `libs` API reference must stay accurate where code steps
     reuse the same runtime context (`buildUtils()` / `buildLibs()` at
     `src/extensions/runtime-context/index.ts`); if orchestration work added or renamed any `utils`
     member (e.g. anything surfaced to code steps), reflect it. This is a **two-way** audit — flag real
     supported members documented in *neither* the persona nor `docs/extensions.md` as well as stale
     entries.
   - **`orchestration-creator`** (from POL-001) — reconcile its inlined frontmatter / code-step /
     composition references against the contracts after any late engine changes.

3. **Code-step guidance consolidation (`INT-013`).** Phase 3 deferred the code-step guidance "into
   POL-001 / DOC-001." DOC-001 is where the *documentation* half lands (the `docs/orchestration.md`
   code-step section + the `tool-creator` API reconciliation); POL-001 owns the *persona* half. Together
   they discharge `INT-013`.

**The `audit-personas-docs` concern (standing guard).** This repo has an `audit-personas-docs` skill
whose job is exactly "audit the built-in personas (`notor-help`, `tool-creator`) and the repo docs
against the real code, find drift (renamed/removed tools, dead settings deep-links, stale OR missing
utils/libs API entries, missing tools in tables)." Adding a third persona, an Orchestration settings
section, the orchestration tool scaffolds (`emit_event`, the four task tools, `run_flow`), and the
`OrchestrationHelper` API **expands that skill's audit surface**. DOC-001 must:

- Extend the audit's scope to include `orchestration-creator`, the `notor-settings://Orchestration`
  deep-link, the orchestration tool scaffolds in the tools tables, and the `OrchestrationHelper` API
  (both directions — real members missing from docs, and documented members no longer real).
- Leave the personas + docs in a **clean-audit** state at the end of the feature (the skill reports no
  drift). This is the closest thing Phase 6 has to a test gate.

**FRs:** FR-160 (documents and reconciles the persona produced by POL-001); discharges the documentation
half of FR-130's code-step guidance (`INT-013`). No new code behavior — documentation + persona-content
maintenance only.

**Files:**
- `docs/orchestration.md` — new user guide (house style of the existing `docs/` pages).
- `src/personas/builtin-personas.ts` — `NOTOR_HELP.systemPromptContent` settings deep-link list gains
  the **Orchestration** section; `TOOL_CREATOR.systemPromptContent` `utils`/`libs` reference reconciled
  if code steps surfaced new members; `ORCHESTRATION_CREATOR` (POL-001) references reconciled.
- `docs/extensions.md` — if the orchestration code-step runtime exposed new `utils`/`libs` members or a
  code-step authoring note belongs alongside the existing extension docs, reflect it (two-way audit).
- `docs/personas.md`, `docs/sub-agents.md` — cross-link the new orchestration guide where personas /
  sub-agents intersect with orchestration (steps reference personas; the run-tree unifies sub-agents and
  flow steps).
- (Tooling.) The `audit-personas-docs` skill definition / its enumerated audit targets — extend to cover
  the new persona, settings section, scaffolds, and helper API (so future drift is caught).

**Dependencies:** `POL-001` (the persona it documents and reconciles), `INT-011` (the
`OrchestrationHelper` runtime API the code-step docs + persona guidance must describe as built).

**Acceptance Criteria:**
- [ ] `docs/orchestration.md` exists in the house style and covers enabling the feature group, the
  flow/step schema, conversation vs. code steps, session workspace/tasks/memories, running a flow,
  safety/limits, composition (`run_flow` + chaining), and the run-tree view; it references the POL-002
  reference flows.
- [ ] `notor-help`'s inlined settings deep-link list includes the **Orchestration** section matching the
  group name in `src/settings/sections/orchestration.ts` (no dead deep-link).
- [ ] `tool-creator`'s inlined `utils`/`libs` reference matches the real
  `src/extensions/runtime-context/` API after orchestration work (no stale entry; no real-but-undocumented
  member surfaced to code steps).
- [ ] The code-step guidance (`INT-013`) is present in **both** `docs/orchestration.md` and the
  `orchestration-creator` persona, consistent with
  [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md), including the
  **at-least-once + `once()` + overwrite-only-scratchpad + no-unbounded-sync-loop caveats** and the
  **iteration-counter distinction** (HOP counter incl. code steps vs `notor-max-iterations` LLM-turns —
  Issue-13c).
- [ ] The `audit-personas-docs` skill's audit targets are extended to include `orchestration-creator`,
  the `notor-settings://Orchestration` deep-link, the orchestration tool scaffolds, and the
  `OrchestrationHelper` API.
- [ ] Running the `audit-personas-docs` audit at feature completion reports **no drift** (the Phase 6
  documentation/persona gate).
