# Circuits

Circuits are multi-step, event-driven pipelines that run a sequence of **conversation steps** (LLM turns) and **code steps** (deterministic TypeScript) to a terminal event — with cascading guardrails on depth, iterations, cost, and runtime, plus crash-recovery. A circuit is authored as plain Obsidian notes and run from the command palette or a hook.

Circuits were called **orchestrations** (or *orchestration flows*) in earlier Notor versions. Nothing you built needs to change: every legacy folder, frontmatter key, topic, tool name, setting, and hook keeps working. See [Legacy names](#legacy-names).

> **Feature group.** Circuits are gated behind a master toggle and are **completely absent** when disabled — no command, no tool scaffolds, no run-tree view. Enable them under **Settings → Notor → Circuits** ([Open Circuits](notor-settings://Circuits)). Enabling also seeds the three reference circuits, and makes the `circuit-creator` persona's circuits runnable.

## Vocabulary

- A **circuit** is a designed, multi-step procedure: a `definition.md` plus its step notes.
- A **step** is either an **LLM step** (a conversation step: persona + model + tools + prompt) or a **code step** (deterministic TypeScript, zero tokens). An LLM step can itself call another circuit, so circuits compose.
- **Topics** are a step's named exits. A step finishes by publishing exactly one of the topics it declares, and the engine routes it to the step that triggers on it.
- A **workflow** is essentially a **single-step interactive circuit**: one LLM step that runs in the chat panel, so you can go back and forth with it directly. Use a workflow for an interactive, conversational task. Use a circuit for a headless multi-step pipeline with routing, verification, code steps, or composition.

## Enabling the feature group

Toggle **Enable circuits** under [Settings → Notor → Circuits](notor-settings://Circuits). When enabled, Notor:

- materializes the reference circuits (`code-assist`, `research`, `review`) under `{notor_dir}/circuits/` — preserving any edits you've made on subsequent enables, and skipping any you already have under the legacy `{notor_dir}/orchestrations/`;
- registers the circuit tool scaffolds (`emit_event`, `submit_score`, `run_circuit`, and the four `circuit_task_*` tools) and the **Notor: Run circuit** / **Notor: Evaluate circuit sessions** commands;
- enables the unified **run-tree view** and the `flow-run` entries in the activity indicator.

Toggling it off removes the command and all scaffolds after the extension reload. (Authoring a circuit with the `circuit-creator` persona works regardless — only *running* a circuit needs the group on.)

## Anatomy of a circuit

A circuit is a directory under `{notor_dir}/circuits/{circuit-name}/`. Circuits under the legacy `{notor_dir}/orchestrations/{circuit-name}/` are discovered too. Circuit names must be unique across both folders: if two circuits share a name, the one under `circuits/` wins and Notor shows a Notice naming both.

```
{notor_dir}/circuits/{circuit-name}/
  definition.md        # circuit topology, loop config, guardrails, composition (frontmatter only)
  steps/
    planner.md         # a conversation step
    verify-tests.md    # a code step (notor-step-mode: code)
    ...
```

Steps communicate **only by publishing events**. A step is triggered by a topic, does its work, and emits exactly one next topic. The engine routes each topic to the single step that triggers on it (one topic → one step by default). The body of `definition.md` is documentation and is **never injected into any prompt** — only the frontmatter drives the engine.

### `definition.md` frontmatter

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `notor-type` | `circuit` | yes | — | Discriminator; gates discovery. |
| `notor-circuit-name` | string | yes | — | Display name (picker, conversation titles). |
| `notor-circuit-description` | string | yes | — | Short description for the picker. |
| `notor-starting-event` | string | yes | — | First event published when the circuit starts. |
| `notor-completion-event` | string | no | `CIRCUIT_COMPLETE` | Terminal event; subject to task enforcement. |
| `notor-max-iterations` | number | no | `100` | Aggregate tree-wide ceiling on **LLM turns**. |
| `notor-max-runtime-minutes` | number | no | `60` | Wall-clock runtime cap. |
| `notor-required-events` | string[] | no | `[]` | Events that must be seen before completion is accepted. |
| `notor-fanout-topics` | string[] | no | `[]` | Topics explicitly allowed to route to **more than one** step (ordered). |
| `notor-steps` | wikilink[] | yes | — | Ordered step references (`"[[planner]]"`), resolved under `steps/`. |
| `notor-guardrails` | string[] | no | `[]` | Constraints injected into **every** step prompt. |
| `notor-schedule` | string (cron) | no | `null` | Standard 5-field cron expression; launches the circuit on a schedule (see below). Invalid expressions are ignored with a warning. |
| `notor-daily-start` | boolean | no | `false` | Launch the circuit once a day, the first time you use Obsidian after the day reset time (see below). |
| `notor-circuit-invocable` | boolean | no | `false` | The circuit appears in the `run_circuit` registry (callable by other circuits). |
| `notor-circuit-inputs` | string | no | `null` | Freeform NL description of what the circuit expects to begin. |
| `notor-circuit-returns` | string | no | `null` | Freeform NL description of what the circuit hands back. |
| `notor-on-complete-circuit` | wikilink \| null | no | `null` | Chaining successor launched at the terminal event (one-way handoff). |
| `notor-handoff-isolation` | `isolated` \| `shared` | no | `isolated` | `shared` inherits the parent's scratchpad. |
| `notor-max-depth` | number \| null | no | `null` | Composition-depth cap (`null` = unlimited depth). |
| `notor-max-cost-usd` | number | no | `5.00` | Aggregate tree-wide USD cost ceiling. |
| `notor-open-notes-in-editor` | boolean | no | _(global setting)_ | Open each note this circuit's steps read/write in the editor. Omit to inherit the global **Settings → Circuits → "Open notes in editor"** toggle (default off); set `true`/`false` to force it for this circuit, independent of the General "Open notes on access" chat setting. |
| `notor-evaluators` | wikilink[] | no | `[]` | Evaluator notes under `evals/` that score finished runs (see [Evaluating runs](#evaluating-runs)). A bad evaluator is dropped with a warning; the circuit still loads. |
| `notor-eval-auto` | `none` \| `complete` \| `error` \| `both` | no | `none` | Automatically evaluate a finished **root** run with that status. |
| `notor-eval-schedule` | string (cron) | no | `null` | Periodically evaluate finished runs the current evaluators have not scored yet. Its own row and toggle under **Settings → Automations**. |
| `notor-eval-max-cost-usd` | number \| null | no | `null` | Per-pass USD ceiling for the evaluators. `null` = the circuit's `notor-max-cost-usd`. Separate from, and never counted against, the run's budget. |

> **Every circuit is bounded by construction.** `notor-max-iterations`, `notor-max-runtime-minutes`, and `notor-max-cost-usd` are optional in frontmatter but **never absent at runtime** — the parser injects finite defaults (`100` / `60` / `5.00`, never `Infinity`). So even a hand-authored circuit that sets nothing auto-terminates.

> **Scheduling a circuit.** A circuit with a valid `notor-schedule` cron expression launches itself on that schedule (each run stamped `origin: schedule`) and appears in **Settings → Automations** under "Scheduled" — with a next-run time, an active/inactive status dot, and a per-circuit enable toggle — exactly like a scheduled workflow. Direct scheduling requires circuits to be enabled. For **event-driven** triggers (on-save, on-tag-change, …) wire a "Run a circuit" action under **Settings → Vault Event Hooks** instead.

> **Running a circuit at the start of each day.** Set `notor-daily-start: true` and the circuit launches once a day on your first activity after the day reset time (each run is stamped `origin: daily_start`). It appears in **Settings → Automations** under "Daily start". Before launching, Notor checks that every conversation step's provider is reachable. If one isn't (for example, expired credentials), Notor retries with a long backoff and shows a Notice with the reason. Each device gets its own daily run, so a circuit that writes to a shared note should be safe to run twice. See [Daily start](hooks.md#daily-start).

### Step note frontmatter

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `notor-type` | `circuit-step` | yes | — | Discriminator. |
| `notor-step-name` | string | yes | — | Display name (may include an emoji). |
| `notor-step-description` | string | no | `""` | Short description. |
| `notor-step-triggers` | string[] | yes | — | Topics that activate this step (≤1 step per topic per circuit). |
| `notor-step-publishes` | string[] | yes | — | Topics this step may emit. |
| `notor-step-default-publishes` | string \| null | no | `null` | Topic synthesized if a conversation step ends with no emission. |
| `notor-step-persona` | string \| null | no | `null` | Persona → system prompt, tools, provider/model. Ignored in code mode. |
| `notor-step-model` | string \| null | no | `null` | Model override (takes precedence over the persona's model). |
| `notor-step-mode` | `conversation` \| `code` | no | `conversation` | `conversation` = LLM turn; `code` = deterministic TypeScript. |
| `notor-step-mcp-servers` | string[] \| null | no | `null` | MCP servers active for this step (`null` = inherit all). |
| `notor-step-timeout-seconds` | number \| null | no | `null` (→ 300) | **Code steps only.** Outer timeout for the code-step function. |

The body of a **conversation step** is its instructions (injected into the prompt's EXECUTE section, alongside the always-injected objective, event history, scratchpad path, guardrails, and must-publish rule). The body may use `<include_note>` tags. For a **code step**, the first `ts`/`typescript`/`js`/`javascript` fence is the code that runs.

## Conversation steps

A conversation step runs one LLM turn driven by its persona. The engine **always** injects a must-publish rule: the step MUST call `emit_event` with exactly one of its `notor-step-publishes` topics — narrative text alone never counts. If the step ends its turn without emitting, the engine synthesizes its `notor-step-default-publishes` topic so the loop never stalls.

If a step's provider stream fails, the engine emits `{step}.stream_error`. The payload is `{ step, stopReason, error }`. Before that happens, transient failures (network drops, rate limits, overloaded or 5xx responses) are retried automatically under the [network retry settings](getting-started.md#unstable-connections). Retries don't count toward the step's iteration cap. So `.stream_error` means the provider kept failing, or failed in a way that retrying can't fix. Route it to a recovery step, or let it fail the run.

> **Conversation steps read/write Markdown only.** A conversation step has no `circuit.scratchpad` helper — it touches the scratchpad through its normal note tools (`read_note` / `write_note`), which handle **Markdown (`.md`) only**. Non-Markdown coordination files (e.g. a `.json` manifest) are written and read by **code steps**; a conversation step receives whatever it needs from such a file via the **incoming event payload** — it must not `read_note` a `.json` (that errors). When a downstream conversation step needs structured state a code step produced, have the code step assemble it into the event payload (the reference circuits and the `notor-usage-miner` example follow this pattern).

## Code steps

A code step (`notor-step-mode: code`) runs deterministic TypeScript with **no LLM call, no conversation, and zero tokens**. Use one for verification, conditional/multi-way routing, pre-flight checks, data-fetch, notifications, aggregation, and the reliable **structured return** of an invocable circuit. The step routes by its **return value**.

The code receives the same arg signature as a snippet of a user-defined tool, plus circuit-specific args:

```
[app, obsidian, utils, libs, event, orchestration, circuit]
```

- `app` / `obsidian` / `utils` / `libs` are **identical** to user-defined tools (`utils.executeShellCommand`, `utils.notify`, etc. — see [Extensions](extensions.md)).
- `event` — `{ topic, payload, source_step }`, the incoming trigger (payload is a string; JSON-encode structured data).
- `circuit` — the code-step helper. `orchestration` is the same object under its legacy name; existing code keeps working.

| Member | What it does |
|---|---|
| `emit(topic, payload?, structured?)` | The **only** way a code step routes the next event — you MUST `return` it. On a **terminal** emit, the optional 3rd `structured` arg is the typed return a `run_circuit` caller receives in preference to `text`. |
| `once(key, fn)` | At-least-once guard for non-idempotent external effects (git push, Slack post, deploy). Runs `fn` once, records it, and **skips** it on a recovery re-run. |
| `scratchpad.{read,write,list,exists}` | The shared cross-step working dir. **Overwrite-only** — there is no `append`. |
| `callTool(name, params)` / `callMcpTool(server, tool, params)` | Dispatch a built-in / MCP tool, threading the step's depth + budget + abort (so a code-step `run_circuit` is depth/budget-gated identically to an LLM-step one). |
| `tasks.{list,ensure,start,close}` | The runtime task registry (same backing as the task tools). |
| `flow` | `{ name, iteration, sessionId }` — read-only circuit/session metadata. |
| `eventHistory(limit?)` | Recent event history for the session. |
| `log.{debug,info,warn,error}(message, data?)` | Record the **logic path** this code step took. Persists to the session log and **surfaces in the run-tree** under the step's node (also tees to the DevTools console). Persists regardless of the console log level — prefer it over `utils.logger` inside a code step. Keep `data` JSON-serializable. |

> **`callTool` returns a string — JSON for structured tools.** `callTool` / `callMcpTool` always resolve to a **`string`** (and **throw** on dispatch failure — an uncaught throw becomes `{step}.code_error`). For tools that return structured data the string is `JSON.stringify`'d, so you must **`JSON.parse`** it (`search_chat_history`, `read_chat_history`, `search_vault`, `list_vault`, `read_frontmatter`, `circuit_task_list`); tools that return prose (`read_note`, `get_backlinks`, …) are used directly. Confirm a tool's exact output shape before consuming it — read its definition (user tools live at `{notor_dir}/tools/{name}.md`; for a built-in, open it from Settings → Tools to materialize the same file) or ask the `notor-help` sub-agent. The `circuit-creator` persona walks you through this.

A worked verify step:

````markdown
---
notor-type: circuit-step
notor-step-name: "🔍 Verify Tests"
notor-step-mode: code
notor-step-triggers: [build.done]
notor-step-publishes: [tests.passed, tests.failed]
notor-step-default-publishes: tests.failed
---

```typescript
const result = await utils.executeShellCommand("npm test", {
  cwd: event.payload,        // repo path forwarded by the builder
  timeoutSeconds: 120,
});
// ShellExecuteResult.stdout is COMBINED stdout+stderr (no separate stderr field).
if (result.exitCode === 0 && !result.timedOut) {
  return circuit.emit("tests.passed", event.payload);
}
return circuit.emit("tests.failed", JSON.stringify({ exitCode: result.exitCode, output: result.stdout }));
```
````

A thrown error fires a `{step}.code_error` event (with the stack) and shows an error Notice, while still logging the turn.

> **⚠️ Code-step timeout caveat.** Code steps run as `AsyncFunction` on Obsidian's **main event-loop thread** — there is no Worker isolation in v1. The timeout (default 300 s, overridable via `notor-step-timeout-seconds`) fires **only at `await` boundaries**. An unbounded *synchronous* loop (`while (true) {}`, a long CPU-bound loop with no `await`) is **not interruptible** and freezes the whole plugin. Always insert `await` yield points in long loops and bound iteration counts. The outer step timeout must exceed any inner `utils.executeShellCommand` `timeoutSeconds`.

### Verification + routing discipline

The engine has **no semantic verifier** — a step that emits its success topic is taken at face value (a `completed`-but-wrong emission still advances the circuit). The division of labor is: **conversation steps do work; code steps verify it.** Place a code-step verifier on a step's output edge (`[Builder] → [Verify Tests] → tests.passed / tests.failed`), and route distinct outcomes through **distinct topics** driven by a deterministic code-step router rather than re-firing one topic.

## Session workspace

Each run gets a session directory under `{notor_dir}/{data root}/sessions/{session-id}/`. The **data root** is chosen once per install and never moves: it is `circuits/` on a new install, and the legacy `orchestrations/` on an install that already had that folder (unless runs have already been stored under `circuits/`). Failure reports and `memories.md` live under the same root.

- `session.json` — the run's status (`active` / `interrupted` / `completed` / `cancelled` / `error`), iteration, active step, origin, and parent linkage.
- `session-log.jsonl` — the append-only, write-before-route turn + event log (the crash-recovery source of truth).
- `scratchpad/` — the restriction-free shared working dir for cross-step state. Its path is auto-allowed for the session's steps. **Write overwrite-only** (write the complete current content, or a per-iteration filename) — recovery re-runs a step from fresh context, so an *append* would duplicate content.
- `tasks/` — the runtime task registry (`circuit_task_ensure` / `_start` / `_close` / `_list`). `CIRCUIT_COMPLETE` is rejected and re-triggered while any task is `open`/`running`; `CIRCUIT_CANCELLED` bypasses this.
- `evals.jsonl` — the append-only evaluation log, written only when the session is evaluated (see [Evaluating runs](#evaluating-runs)). The run's own `session-log.jsonl` ends with a `run.result` entry (status, terminal topic, closing text, structured return, cost) that evaluation reads.

A persistent cross-session note, `{notor_dir}/{data root}/memories.md`, is seeded on first use; the prompt scaffold instructs every step to consult it before acting in unfamiliar territory and append fix-memories when blocked.

### Debugging failed runs

The per-session `session.json` / `session-log.jsonl` are raw machine state — useful but not browsable. Enable **Write failed-run debug notes** ([Settings → Notor → Circuits](notor-settings://Circuits)) and any run that ends in `error` also writes a human-readable Markdown report to `{notor_dir}/{data root}/failures/{circuit-slug}-{session-id}.md`. The note distils data already captured — the objective, the failure reason (the terminal `CIRCUIT_ERROR` payload), the failing step + stack (from the `{step}.code_error` event), and a compact turn-by-turn timeline — plus pointers to the raw session files. Open it, or `@`-reference it in a Notor chat, to debug the run. The setting is **off by default** and read at finalize time (no extension reload needed); the note carries `notor-type: circuit-failure-report` so circuit discovery ignores it.

## Evaluating runs

A circuit can declare **evaluators**: rubrics and checks that score a **finished** run after the fact, the way tests attach to code. The two goals are spotting regressions when a model or the circuit changes, and justifying a cheaper model that still clears the bar. Evaluation is **decoupled from the run** — it reads the finished session from disk — so it works the same seconds or days later, on one session or a batch. v1 captures and aggregates scores; it does not drive authoring.

### Declaring evaluators

List evaluator notes in the definition's `notor-evaluators`; they live under `{circuit-name}/evals/`:

```
{notor_dir}/circuits/{circuit-name}/
  definition.md        # notor-evaluators: ["[[report-quality]]", "[[shape]]"]
  evals/
    report-quality.md  # an LLM judge (notor-eval-mode: conversation)
    _rubric.md         # a plain rubric note the judge reads
    shape.md           # a code evaluator (notor-eval-mode: code)
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `notor-type` | `circuit-evaluator` | yes | — | Discriminator (no legacy spelling). |
| `notor-eval-name` | string | yes | — | Display name; slugified into the report's score keys. |
| `notor-eval-description` | string | no | `""` | Short description. |
| `notor-eval-mode` | `conversation` \| `code` | no | `conversation` | An LLM judge, or a deterministic TypeScript snippet. |
| `notor-eval-persona` | string \| null | no | `null` | **Conversation:** the judge persona (system prompt, tools, model). |
| `notor-eval-subagent` | string \| null | no | `null` | **Conversation:** a sub-agent profile as the judge instead. Set at most one of persona / subagent; neither = the active provider and model. |
| `notor-eval-model` | string \| null | no | `null` | **Conversation:** raw model id override (like `notor-step-model`). |
| `notor-eval-rubric` | wikilink \| null | no | `null` | A rubric note under `evals/`; its body is shown to the judge. |
| `notor-eval-dimensions` | list | yes | — | The scored dimensions. A bare name means numeric 1–5; a map `{ name, type: numeric \| boolean, min?, max?, description? }` sets the type and range. |
| `notor-eval-timeout-seconds` | number \| null | no | `null` (→ 300) | **Code evaluators only.** |
| `notor-eval-include-note-contents` | boolean | no | `true` | **Conversation:** show the judge the current contents of the notes the run edited. |

An invalid evaluator (unresolvable link, unknown mode, both persona and subagent set, no dimensions, a code evaluator without a fence, an unresolvable rubric) is dropped with a warning; the circuit itself still loads and runs.

### What an evaluator sees

The circuit objective, the run's terminal status and topic, its closing text and **structured return**, and the vault paths of the notes the run's steps edited (reconstructed from the persisted step tool calls — notes written by a code step directly through `utils`, or deleted since, are not listed). Step transcripts are never included. An LLM judge also receives the edited notes' **current** contents, size-capped and flagged when a note changed after the run finished. Sessions recorded before `run.result` existed still evaluate, with the closing text taken from the terminal event and no structured return.

### LLM judges and `submit_score`

A `conversation` evaluator's body is the judging instructions (it may use `<include_note>`); the rubric note is appended, then the dimensions, objective, outcome, and edited notes. The judge runs in **Plan mode with read-only tools**: `emit_event`, the task tools, `run_circuit`, `invoke_workflow`, `use_subagent`, `ask_user`, and `capture_memory` are disabled regardless of the persona's config, and every allowed read is approved automatically, so a manual or scheduled pass never blocks on an approval dialog. The judge reports by calling **`submit_score`** once, with every declared dimension in `scores` and a `rationale` (optionally an `overall`). The tool validates the submission against the dimensions and tells the model what to fix. A judge that ends without calling it is re-run once with a reminder, then recorded as failed with reason `no_score`.

### Code evaluators

A `code` evaluator's first `ts`/`typescript`/`js`/`javascript` fence runs with the arg signature

```
[app, obsidian, utils, libs, input, evaluation]
```

- `input` — the bundle above: `input.objective`, `input.outcome` (`status`, `terminalTopic`, `text`, `structured`, `costUsd`, `iterations`, `source`), `input.notesEdited`, `input.session` (`sessionId`, `startedAt`, `origin`, `sessionDir`), `input.evaluator.dimensions`.
- `evaluation` — `{ dimensions, callTool(name, params), callMcpTool(server, tool, params), session: { id, dir, scratchpad: { read, list, exists }, readLog() }, log }`. Tool calls dispatch in Plan mode (read tools only); the scratchpad is read-only; `readLog()` returns the session's parsed `session-log.jsonl`.
- It must `return { scores: { dimension: value, … }, rationale, overall? }`. Scores are validated against the dimensions; a bad return is recorded as `invalid_score`, a throw as `error`, a timeout as `timeout`.

A code evaluator is deterministic, costs nothing, and is not budget-gated. Use one for every check that can be computed: tests pass, a file exists, a word count is in range, the structured return has the expected shape.

### Triggers

- **Manual (the main path).** Command palette → **Notor: Evaluate circuit sessions**. Pick a circuit that declares evaluators, then multi-select its finished root sessions. Sessions the current evaluator set has already scored are marked **evaluated** (re-scoring records a new pass); sessions scored by an older evaluator set are marked **older evaluators**. The footer shows how many LLM judge runs the pass will start and its cost ceiling. A progress Notice follows the pass; the summary Notice names the report folder, and a single report opens automatically.
- **Automatic (opt-in).** `notor-eval-auto: complete | error | both` evaluates a finished **root** run with that status right after it finishes. Children of `run_circuit` and cancelled runs are never auto-evaluated. The pass runs in the background and never changes the run's status.
- **Scheduled (opt-in).** `notor-eval-schedule` (5-field cron) periodically evaluates finished root sessions the current evaluator set has not scored yet, newest first, at most 20 per tick. It appears under **Settings → Automations → Scheduled** as its own "circuit eval" row, with a status dot and a toggle independent of the circuit's run schedule.

Editing an evaluator or its rubric changes the evaluator-set **fingerprint**, so earlier passes show as stale and the next manual or scheduled evaluation scores every session again as a new, comparable pass.

### Budget

Each pass gets a **fresh** cost ceiling: `notor-eval-max-cost-usd`, or the circuit's `notor-max-cost-usd` when unset. LLM judges draw it down; once it is spent, the remaining judges in the pass are recorded as failed with reason `budget`. Evaluation spend never touches the run's own budget record or status.

### Where results land

- **`{data root}/sessions/{session-id}/evals.jsonl`** — append-only, beside the run's log, which stays untouched: `eval.pass_start` (circuit, trigger, evaluators, fingerprint, ceiling), one `eval.scored` (scores, rationale, overall, judge model, cost) or `eval.failed` (reason, detail) per evaluator, then `eval.pass_complete`. Every entry carries the `pass_id`.
- **`{data root}/evals/{circuit-slug}-{session-id}-{pass-id}.md`** — one report note per evaluated session per pass, written when **Write evaluation reports** ([Settings → Notor → Circuits](notor-settings://Circuits), on by default) is enabled. Its **flat frontmatter** carries `notor-type: circuit-eval-report`, the circuit, session, pass, trigger, and fingerprint, the run's status, origin, start time, iterations, and cost, the judge models and evaluation cost, the evaluators that failed, and one `notor-score-{evaluator-slug}-{dimension-slug}` key per score (plus `notor-overall-{evaluator-slug}` when given) — so Dataview or Bases can compare runs with no extra tooling. The body repeats the scores as a table and adds the objective, run outcome, rationales, failures, and raw-data pointers. Circuit discovery ignores these notes.

### Reviewing results with Notor

The built-in **`circuit-eval-reviewer`** persona reads the report notes for a circuit, groups them by fingerprint so only comparable passes are compared, ranks sessions per dimension, drills into rationales and outcomes, and recommends which run came out best and which rubric or circuit edits would help. It is read-only.

The reference circuits ship working examples: `research` has an LLM judge with a rubric (`evals/report-quality.md`, `evals/_rubric.md`); `code-assist` has a code evaluator over its structured return (`evals/structured-summary.md`). An install that enabled circuits before evaluators existed gets the `evals/` notes backfilled on the next enable; add `notor-evaluators` to the edited `definition.md` yourself.

## Running a circuit

Open the command palette → **Notor: Run circuit**, pick a circuit, and enter an objective. After each step turn a brief progress **Notice** names the circuit, step, and iteration (right-click a Notice on desktop to jump into that step's conversation).

> **Iteration counter.** The `iteration N` shown in Notices (and `session.json`'s `iteration`) is the **step-turn / hop counter, which includes code steps** — it is **not** the same unit as `notor-max-iterations`, which counts **LLM turns only**. A code-step-heavy circuit's hop counter can climb well past `notor-max-iterations` without tripping it (such circuits are bounded by `notor-max-runtime-minutes` + stale-loop detection instead).

A circuit can also be launched unattended by a **hook** with the `run_circuit` action type (Settings → Notor → Hooks), stamped `origin: "hook"`. Scripts and other plugins can start one with [`runCircuit`](api.md#running-a-circuit), stamped `origin: "api"`.

Step tool calls follow the normal approval rules. A call that needs approval opens an **Approve tool call** dialog, because a circuit has no chat panel to prompt in. `run_flow` children and `notor-on-complete-flow` successors use the same approval channel and Plan/Act mode as the run that started them. For unattended circuits, see [Runs with no chat panel](safety.md#runs-with-no-chat-panel).

Each step turn creates its own conversation, but step conversations are **hidden from the flat conversation sidebar** (the run-tree is their only surface).

## The run-tree view

The **run-tree view** is the unified, navigable tree of a run — circuit steps (via conversation edges) **and** sub-agents (via the sub-agent parent link), in one collapsible hierarchy. Open it from:

- the **"Open run tree"** affordance on a `run_circuit` / `use_subagent` tool-call card (which also shows an inline peek: the direct child's summary + aggregate rollup);
- a **flow-run entry** in the activity indicator;
- (selecting a node loads that node's conversation in the main chat).

The tree also shows **code steps** — interleaved with conversation steps by hop order — even though a code step has no conversation. A code-step node is **not clickable** (there's no conversation to open); beneath it the tree renders the **logic-path logs** the step emitted via `circuit.log` (color-coded by level), so you can see which branches and decisions ran. (Code-step nodes and their logs are read from the session's `session-log.jsonl`, not from conversation files.)

The view is **live** while a run is active (updating as turns complete — a log written mid-turn appears once that turn completes) and **static** once it finishes; a recovered run re-attaches its live subscription. It tolerates dangling edges (a crash-recovery re-run mints new conversation ids) by rendering only resolvable edges.

## Composition

A circuit can call another circuit two ways:

- **`run_circuit` (call/return).** A step (conversation or code) invokes another **invocable** circuit (`notor-circuit-invocable: true`) as a tool. It runs the callee to its terminal event on a **child session**, then returns the child's result — **preferring `structured`** (populated only by a terminal **code step**'s `emit(topic, payload, structured)`), falling back to the closing `text` (shaped by the callee's `notor-circuit-returns`). `run_circuit` is **circuit-context-only** — it returns `success: false` from foreground chat, so a parentless, unrecoverable child circuit can never exist. The child links into the parent's recovery tree via `parent_session_id`; `isolated` (default) gives it a fresh scratchpad, `shared` inherits the parent's.
- **Chaining (`notor-on-complete-circuit`, one-way handoff).** At the terminal event the successor launches **instead of returning** — the chain *is* the end of the predecessor. The engine injects the successor's `notor-circuit-inputs` into the predecessor's terminal step so it shapes the forwarded payload.

### Cascading guardrails

Composition guardrails are **aggregate** across the whole circuit tree, held on a single **shared budget cell** referenced by every descendant run:

- A child spawn (or chaining handoff) proceeds only if `depth < notor-max-depth` **AND** the shared aggregate budget has headroom (`max_iterations` and `max_cost_usd` both `> 0`). Every descendant turn draws down the **same** tree-wide ceiling, so a deep/wide subtree (and an `A → B → A` chaining cycle) is genuinely bounded.
- The cost ceiling is a **soft** ceiling: it can overshoot by at most one full turn per in-flight runner (cost is decremented after a turn, and the gate is strict-positive). A blocked `run_circuit` spawn returns a tool error to the caller; a blocked chaining handoff terminates the chain with `CIRCUIT_ERROR`.

The shared **`child_run_metadata`** block on a `run_circuit` / `use_subagent` tool result carries the aggregate-subtree rollup (cost / iterations / depth / tokens), sourced from each run's own subtree accumulator (not a shared-cell delta), and feeds the inline peek card and the run-tree header.

## Step → workflow (a distinct mechanism)

A conversation step can also invoke a single-turn **workflow** by name and fold its result into the step's context before emitting. This runs on the **background-workflow loop** (not a child circuit — no run-tree nesting), and the workflow runs **uncapped** during the call: its cost/iterations are reconciled into the circuit's shared budget only **after** the call, so a single step→workflow invocation can overshoot the circuit's `notor-max-cost-usd` / `notor-max-iterations` by an unbounded amount (a whole workflow run). Treat it as a deliberate, potentially expensive delegation — distinct from `run_circuit`'s bounded soft ceiling.

## Crash recovery

On plugin load, Notor scans `{data root}/sessions/` for `active`/`interrupted` sessions and offers to resume. Recovery replays `session-log.jsonl` idempotently:

- A dangling `turn.start` re-emits the step's trigger (the step re-runs from fresh context); a dangling `event.emitted` re-publishes the event.
- The aggregate budget is **rebuilt** by replaying each turn's recorded cost/tokens (a `$5.00` cap that had spent `$4.90` resumes at `$0.10`, not `$5.00`), and the stale-loop window + thrashing counters are rehydrated — so reloading does not "unstick" a near-stale loop.
- A `run_circuit` child is reconciled by the parent's replay via its durable `child.spawned` / `child.result` ledger: a **terminal** child's recorded result is **reused** (no re-spawn); a **non-terminal** child is **resumed in place** (it replays its own log) — never tombstoned-and-respawned, so its `once()` markers survive. A **chained successor** whose predecessor has finalized is recovered as a **root**.

> **At-least-once boundary.** Recovery is at-least-once, not exactly-once. Engine bookkeeping (events/turns), budget, and **overwrite-style** scratchpad state replay safely. But a re-run step **repeats any external, non-idempotent side effect** it performed before crashing, and re-spends budget / re-executes intra-step tool calls that are not individually guarded. Wrap every non-idempotent external effect in `circuit.once(key, fn)`, and write scratchpad files overwrite-only.

## Authoring with the persona

The built-in **`circuit-creator`** persona (Settings → Notor → Personas) interactively guides you through authoring a circuit — discussing the topology, writing `definition.md` + step notes (conversation and code), suggesting personas, and validating the topology. Its `write_note` access is scoped to `{notor_dir}/circuits/`, the legacy `{notor_dir}/orchestrations/`, and `{notor_dir}/personas/`. It was called `orchestration-creator` in earlier versions; that name still resolves to it, and a customized copy saved under the old name keeps being used. (Authoring a circuit does not require the feature group; *running* it does.)

## Reference circuits

Enabling the feature group materializes three first-party reference circuits under `{notor_dir}/circuits/` (your edits are preserved on re-enable):

- **`code-assist`** — a TDD build loop (planner → builder → a code-step test verifier → critic → finalizer) that returns a structured summary. Invocable. Ships a **code evaluator** that checks the structured return.
- **`research`** — a multi-phase research loop ending in a code step that returns a **structured** report. Invocable. Ships an **LLM judge** with a rubric that scores the report.
- **`review`** — a composition demo: a code step invokes `code-assist` via `run_circuit`, then a report step composes the result.

## See also

- [Personas](personas.md) — conversation steps reference personas; the `circuit-creator` persona authors circuits.
- [Sub-agents](sub-agents.md) — the run-tree unifies circuit steps and sub-agents; `run_circuit` generalizes the sub-agent pattern from one conversation to a whole circuit.
- [Extensions](extensions.md) — code steps reuse the same `utils` / `libs` runtime as user-defined tools.
- [Workflows](workflows.md) — step→workflow invocation delegates a bounded sub-task to a workflow; a workflow is a single-step interactive circuit.
- [Scripting API](api.md) — start circuits from Templater scripts and other plugins with `runCircuit`.

## Legacy names

Everything below keeps working indefinitely, with no warnings. Write new circuits with the circuit names.

| Circuit name | Legacy name (still accepted) | Notes |
|---|---|---|
| Folder `{notor_dir}/circuits/` | `{notor_dir}/orchestrations/` | Both are scanned. New and reference circuits go in `circuits/`. |
| `notor-type: circuit` / `circuit-step` | `orchestration-flow` / `orchestration-step` | |
| `notor-circuit-name`, `-description`, `-invocable`, `-inputs`, `-returns`, `-allow-concurrent` | `notor-flow-*` | If both are set, the circuit key wins. |
| `notor-on-complete-circuit` | `notor-on-complete-flow` | |
| `CIRCUIT_COMPLETE` / `CIRCUIT_CANCELLED` / `CIRCUIT_ERROR` | `FLOW_COMPLETE` / `FLOW_CANCELLED` / `FLOW_ERROR` | Fully equivalent. Session logs, run results, and `stop_reason` always show the `FLOW_*` spelling. |
| `circuit.tasks_remaining` / `circuit.requirements_unmet` | `flow.tasks_remaining` / `flow.requirements_unmet` | Engine re-trigger topics. |
| Tool `run_circuit` (`{ circuit, payload }`) | `run_flow` (`{ flow, payload }`) | Only the new name is shown to the model; the old name still dispatches. |
| Tools `circuit_task_ensure` / `_start` / `_close` / `_list` | `orchestration_task_*` | Same. Tool settings, persona `<notor_tool_config>` keys, and override files under `{notor_dir}/tools/` keep applying. |
| Code-step helper `circuit` | `orchestration` | Same object. |
| Extension `utils.circuitTasks` / `utils.circuitContext` | `utils.orchestrationTasks` / `utils.orchestrationContext` | Same objects. |
| Setting `circuits_enabled`, `circuits_write_failure_notes`, `circuits_open_notes_in_editor` | `orchestration_*` | Migrated automatically on load. |
| Hook action `run_circuit` with `circuit` | `run_orchestration` with `orchestration_flow` | Migrated on load; legacy values are still read. |
| Persona `circuit-creator` | `orchestration-creator` | |
| Task notes `notor-type: circuit-task`, failure reports `notor-type: circuit-failure-report` | `orchestration-task`, `orchestration-failure-report` | Written by Notor, never read back. Notes created before the rename keep the old value; update any Dataview or Bases queries to match both. |
| Evaluator notes `notor-type: circuit-evaluator`, evaluation reports `notor-type: circuit-eval-report`, keys `notor-evaluators` / `notor-eval-*`, tool `submit_score`, setting `circuits_write_eval_reports` | — | Evaluation is newer than the rename and has no legacy spelling. |
| Settings link `notor-settings://Circuits` | `notor-settings://Orchestration` | |

The command IDs (`notor:run-orchestration`, `notor:stop-orchestration`) are unchanged, so existing hotkeys keep working; the commands are now named **Run circuit** and **Stop circuit**. The newer **Evaluate circuit sessions** command has a circuit-native id, `notor:evaluate-circuit-sessions`.
