# Phase 5 — Multi-Hat Orchestration

**Created:** 2026-03-16
**Status:** Draft
**Branch:** feature/ralph-orchestration

## Overview

Notor currently runs AI workflows as single-turn sessions: one prompt, one assistant response, with optional tool calls within that session. Complex tasks — implementing a feature end-to-end, synthesizing research across many sources, conducting an adversarial code review — require multi-step coordination that a single session cannot reliably provide.

Phase 5 adds multi-hat orchestration: a loop where specialized AI roles ("hats") collaborate through named events, each hat getting its own focused instructions and tool access, passing work forward until a terminal signal is reached or safety limits fire. A user defines hats and wires them into an orchestration preset, both stored as vault notes. They then invoke the preset with a prompt, and Notor autonomously routes through the hats until the work is done — with every turn visible in the chat, every piece of state stored as a vault note, and every tool call subject to the same approval controls as today.

The design is based on research into the Ralph orchestrator as a reference implementation. Orchestration state — hats, presets, sessions, tasks, memories — all live in the vault, consistent with Notor's existing vault-native approach.

## User Stories

- As a developer, I want to run a multi-step implementation loop (plan → build → review → finalize) so that complex features are implemented autonomously without me manually chaining prompts together.
- As a researcher, I want to define a multi-phase research workflow (explore → synthesize → verify → summarize) so that large research tasks complete with consistent rigor across each phase.
- As a team lead, I want to author reusable hat roles and preset configurations as vault notes so that teammates can invoke the same orchestration workflows without needing to understand the underlying prompt engineering.
- As a user, I want each hat's turn to be visible in the chat so that I can follow the orchestration's progress and understand what each role did.
- As a user, I want tool approvals to work the same way during orchestration as they do in normal chat so that I retain control over file writes and shell commands.
- As a user, I want orchestration sessions to survive a plugin restart so that a long-running workflow is not lost if Obsidian crashes.
- As a user, I want the orchestration to terminate automatically if it gets stuck in a loop so that a confused AI does not burn unlimited API tokens.
- As a user, I want to pause a running orchestration and answer a question that a hat needs clarified so that work can continue when human judgment is required.
- As a user, I want persistent cross-session memory so that the orchestrator learns from previous runs and avoids repeating past mistakes.
- As a user, I want built-in orchestration presets for common workflows (code implementation, research synthesis, code review) so that I can get started without authoring hats from scratch.

## Functional Requirements

### FR-60: Hat Definition as Vault Note

**Description:** A hat is a named AI role defined as a vault note with YAML frontmatter declaring its event triggers, publishable events, and optional overrides, and a body containing the hat's instructions.

**Acceptance Criteria:**
- Hat notes are discovered by Notor from the `{notor_dir}/orchestrations/hats/` directory.
- The frontmatter schema includes:
  - `notor-type: hat` (required; marks the note as a hat definition)
  - `notor-hat-name` — display name (required; may include emoji)
  - `notor-hat-description` — one-line description (required; displayed in preset picker and topology table)
  - `notor-hat-triggers` — list of event topics that activate this hat (required)
  - `notor-hat-publishes` — list of event topics this hat may emit (required)
  - `notor-hat-default-publishes` — event emitted automatically if the hat completes its turn without emitting an event (optional; prevents stalled loops)
  - `notor-hat-persona` — name of a Notor persona to activate for this hat's turns (optional)
  - `notor-hat-model` — model identifier override for this hat's turns (optional)
- The note body contains the hat's instructions, which are injected into the structured system prompt scaffold at execution time.
- Reserved trigger topics `task.start` and `task.resume` are rejected at preset load time with a clear error message; only the orchestration coordinator uses these.
- Each trigger topic must be assigned to at most one hat per preset; ambiguous routing (two hats with the same trigger) is rejected at preset load time with a clear error.
- Hat notes may use `<include_note>` tags in their body to pull in reference documentation or context from other vault notes, consistent with Notor's existing workflow note system.

---

### FR-61: Orchestration Preset as Vault Note

**Description:** An orchestration preset is a vault note that assembles a set of hat roles into a named workflow, configuring the event loop and safety parameters.

**Acceptance Criteria:**
- Preset notes are discovered from `{notor_dir}/orchestrations/presets/`.
- The frontmatter schema includes:
  - `notor-type: orchestration-preset` (required)
  - `notor-preset-name` — display name (required)
  - `notor-preset-description` — brief description of the workflow (optional)
  - `notor-loop-starting-event` — the first event published when the preset starts (required)
  - `notor-loop-completion-promise` — the event topic that terminates the loop cleanly (required; typically `LOOP_COMPLETE`)
  - `notor-loop-max-iterations` — maximum hat turns before the loop is terminated (required; default 100)
  - `notor-loop-max-runtime-minutes` — wall-clock time limit in minutes (required; default 240)
  - `notor-hats` — ordered list of hat note references as Obsidian wikilinks (required)
  - `notor-guardrails` — list of constraint strings injected into every hat's system prompt (optional)
  - `notor-loop-required-events` — list of event topics that must have been seen before `LOOP_COMPLETE` is accepted (optional)
  - `notor-backpressure-gates` — list of named quality checks that the hat is instructed to run before emitting a completion event; the engine validates evidence of these checks in the emitted payload (optional; see FR-66)
- Wikilinks in `notor-hats` are resolved via Obsidian's metadata cache; when a link matches multiple vault notes, the note under `{notor_dir}/orchestrations/hats/` is preferred with a warning if the preference is applied.
- The preset note body is a human-readable description of the workflow displayed in the preset picker.

---

### FR-62: Orchestration Event Engine

**Description:** An in-process pub/sub event engine routes events between hats based on their declared trigger subscriptions.

**Acceptance Criteria:**
- Events are published and routed in-process; no external process or polling file is required.
- Each event consists of a topic string and a payload string.
- The engine matches events to hats by exact topic match; a wildcard subscription (`*`) matches all topics.
- A built-in fallback coordinator subscribes to all events (`*`) and is always registered; it handles any event with no other subscriber, steering the loop back rather than silently stalling. This coordinator cannot be removed or replaced by preset configuration.
- When a hat receives an event, its turn is executed before the next event is dispatched.
- Every published event is written to the session event log (`session-log.jsonl`) before being delivered to any subscriber (write-before-route), ensuring crash recoverability.
- The engine records full event history for the session, accessible for debugging and recovery.

---

### FR-63: Hat Turn Execution

**Description:** Each hat turn is executed as a full LLM session using Notor's existing provider, persona, and tool systems, with a structured system prompt that wraps the hat's instructions.

**Acceptance Criteria:**
- Each hat turn calls the existing `sendMessage()` pipeline — tool approvals, auto-approve settings, streaming output, and checkpoint protection all apply normally.
- The system prompt for each hat turn is assembled by a structured scaffold containing:
  - **Orientation** — role context and state management guidance
  - **Tool discipline** — instructions for using workspace notes, task tools, and memory
  - **Execute** — the hat's custom instructions (from the note body)
  - **Verify** — instructions to confirm work before reporting
  - **Report** — mandatory `emit_event` requirement with the hat's allowed publish topics listed explicitly
  - **Guardrails** — preset-level constraints, numbered with high precedence
  - **Objective** — the original user prompt, injected on every turn
  - **Pending events** — the triggering event topic and payload
- The "must emit" rule is always injected into the Report section even when the hat has explicit custom instructions; omitting it causes LLMs to regularly forget to emit and the loop stalls silently.
- Each hat turn's output is displayed in the chat view as an assistant message, labeled with the hat name and iteration number.
- If a hat's persona or model override is configured, it is activated for the duration of that hat's turn and restored afterward.
- The `emit_event` tool is injected into the tool set for every hat turn and removed when the turn ends; it is not available outside orchestration.

---

### FR-64: `emit_event` Tool

**Description:** The `emit_event` tool is the mechanism by which a hat signals completion and routes work to the next hat.

**Acceptance Criteria:**
- The tool accepts two parameters: `topic` (the event name to publish) and `payload` (evidence or context for the next hat).
- When called, the tool writes the event to the session log before signaling the engine to route, consistent with write-before-route ordering.
- Only events listed in the hat's `notor-hat-publishes` frontmatter are accepted; attempting to emit an unlisted event is rejected with a clear tool result message.
- If the hat turn ends without the tool being called, the hat's `notor-hat-default-publishes` event is synthesized and published automatically. If no default is configured and no event was emitted, the fallback coordinator is triggered.
- The tool result message is shown in the chat tool call UI consistent with other tool calls.

---

### FR-65: Loop Safety Mechanisms

**Description:** Automatic termination conditions prevent infinite loops and token waste when orchestrations get stuck.

**Acceptance Criteria:**
- The following termination conditions are enforced on each iteration:
  | Condition | Trigger |
  |-----------|---------|
  | Max iterations | Iteration count exceeds `notor-loop-max-iterations` |
  | Max runtime | Wall-clock time exceeds `notor-loop-max-runtime-minutes` |
  | Stale loop | The same (topic + payload) combination is emitted three or more times in a row |
  | Thrashing | A hat redispatches three or more tasks that were previously abandoned in the same session |
  | Required events not met | `LOOP_COMPLETE` is emitted before all `notor-loop-required-events` topics have been seen |
- When the `LOOP_COMPLETE` event is emitted but required events have not been seen, the completion is rejected; a `task.resume` event is injected so the loop continues with an explanation of what is missing.
- When a termination condition fires (other than clean completion), the session status is set to `terminated` with the reason recorded, and a summary message is displayed in the chat.
- A graceful cancellation event (`loop.cancel`) terminates the loop without checking required events; preset authors may configure this as an escape hatch.

---

### FR-66: Backpressure Evidence Validation (Phase 3)

**Description:** The engine validates structured evidence claims in event payloads for designated quality-gate events before routing them, substituting a failure event if evidence is missing or shows a failed check.

**Acceptance Criteria:**
- Preset authors configure which events require evidence validation via `notor-backpressure-gates`.
- For a validation-gated event (e.g., `build.done`), the engine parses the payload for named evidence fields (e.g., `tests: pass`, `lint: pass`).
- If required evidence fields are absent or show a non-passing status, the engine substitutes a configured failure event (e.g., `build.blocked`) and the hat that handles `build.blocked` is triggered instead.
- The substituted event's payload includes a description of which evidence was missing or failed.
- The substitution is silent to the LLM — the LLM believes it emitted `build.done`; the engine routes `build.blocked`. This creates a quality gate that the LLM cannot bypass through prompt alone.
- Validation rules (which events, which fields, passing thresholds) are configurable per preset.

---

### FR-67: Session Workspace Notes (Phase 2)

**Description:** When an orchestration session starts, a set of shared workspace vault notes is created for hats to read and write shared state across turns.

**Acceptance Criteria:**
- On session start, the following notes are created under `{notor_dir}/orchestrations/sessions/{session-id}/`:
  - `context.md` — implementation context, project patterns, dependencies
  - `plan.md` — numbered high-level steps for the session
  - `progress.md` — current step, verification log, completion tracking
  - `decisions.md` — confidence-protocol decisions made during the session
- Hat turns log their output to `logs/{n}-{hat}-output.md` (one file per turn).
- All workspace notes are regular vault notes protected by the existing checkpoint system.
- The `HatSystemPromptBuilder`'s Tool Discipline section instructs every hat to read relevant workspace notes at the start of its turn and to write updates at the end.
- Workspace notes are visible in Obsidian's sidebar and can be read and edited by the user during an active session.

---

### FR-68: Runtime Task Registry (Phase 2)

**Description:** Hats can create, track, and close structured subtask notes within a session; the loop enforces that all tasks are closed before accepting `LOOP_COMPLETE`.

**Acceptance Criteria:**
- Task notes are created at `{notor_dir}/orchestrations/sessions/{session-id}/tasks/{task-key}.md`.
- Task notes use YAML frontmatter to store status (`open`, `running`, `closed`, `blocked`), key, created/started/completed timestamps.
- The following tools are available to hats during orchestration: `orchestration_task_ensure`, `orchestration_task_start`, `orchestration_task_close`, `orchestration_task_list`.
- When `LOOP_COMPLETE` is emitted and open tasks exist, the completion is rejected; a resume event is injected listing which tasks remain open, requiring the LLM to close or fail them before completion is accepted.
- Task notes are visible and editable in Obsidian; an operator can manually flip a task's status directly in the note as an escape hatch if an orchestration is stuck.
- Task state is authoritative on disk; the engine reads task note frontmatter rather than a separate database.

---

### FR-69: Persistent Memory Note (Phase 2)

**Description:** A cross-session memory note accumulates learnings across orchestration runs so the system avoids repeating past mistakes.

**Acceptance Criteria:**
- The memory note lives at `{notor_dir}/orchestrations/memories.md` and is not scoped to any session.
- The note is organized into four sections: `## Patterns`, `## Decisions`, `## Fixes`, `## Context`.
- The `HatSystemPromptBuilder` instructs every hat to search this note before acting in unfamiliar territory and to record a fix memory when blocked by a recurring problem.
- The memory note is a regular vault note; users can read, edit, or prune entries directly in Obsidian.
- Memory entries persist across sessions; they are not deleted when a session ends.

---

### FR-70: Session Recovery (Phase 2)

**Description:** Active orchestration sessions are recoverable after a plugin restart or crash, using the append-only session event log as the source of truth for routing state.

**Acceptance Criteria:**
- The session event log (`session-log.jsonl`) records the following entry types in order: `session.start`, `turn.start` (before sending to the LLM), `event.emitted` (before routing), `turn.complete` (after emit captured, before routing), `session.complete`.
- On plugin load, Notor scans for sessions with status `active` or `interrupted` in their `session.json`.
- For each interrupted session, the log is read to determine the last complete state:
  - If the last entry is `turn.start` with no matching `turn.complete`: the hat turn was interrupted mid-execution; the triggering event is re-emitted so the hat turn retries.
  - If the last entry is `event.emitted` or `turn.complete` with no following `turn.start`: the event was emitted but not routed; the emitted event is re-published to resume routing.
- The user is presented with a summary of the interrupted session and asked to confirm before resuming.
- Hat instructions must be written to be idempotent (check before acting); this is documented as a hat authoring requirement.

---

### FR-71: Interactive Orchestration (Phase 4)

**Description:** A hat can pause the loop and present a question to the user; the user's response is injected as context into the next hat turn.

**Acceptance Criteria:**
- A hat emits the reserved event `user.input.required` with a payload describing the question.
- When the engine receives this event, the loop pauses and the question is displayed in the chat view as a prompt to the user.
- The session status transitions to `waiting_for_input`; no further hat turns execute until the user responds.
- The user types a response in the chat view; the response is injected as a `human.response` event into the next iteration.
- If no response is received within a configurable timeout, a `human.timeout` event is injected instead so the hat can handle the timeout gracefully (e.g., proceed with a safe default).
- Hats may also emit `orchestration_task_progress` for non-blocking status updates that are displayed in the chat without pausing the loop.

---

### FR-72: Lifecycle Hooks (Phase 5)

**Description:** Preset authors can register shell commands that fire at defined points in the loop lifecycle for observability, external integrations, and gating.

**Acceptance Criteria:**
- The following hook phases are supported: `pre.loop.start`, `post.loop.start`, `pre.iteration.start`, `post.iteration.start`, `pre.loop.complete`, `post.loop.complete`, `pre.loop.error`, `post.loop.error`.
- Each hook is a shell command configured in the preset with a name, command, and `on_error` behavior (`warn`, `block`, or `suspend`).
  - `warn`: log the failure and continue.
  - `block`: treat as a fatal error, terminate the loop.
  - `suspend`: pause the loop pending human approval, then continue or abort.
- Each hook receives a JSON payload on stdin with session ID, iteration number, active hat, open task count, and elapsed time.
- Hooks are distinct from Notor's existing vault event hooks (on-save, on-open, etc.) and from hat event routing; they are a meta-layer for observability and external integration only.
- A default timeout of 30 seconds applies per hook command.

---

### FR-73: Command Palette and Slash Command Invocation

**Description:** Users can start an orchestration from the command palette or via a slash command in the chat view.

**Acceptance Criteria:**
- The command palette exposes "Notor: Run orchestration" which opens a preset picker showing all discovered orchestration presets with their names and descriptions.
- Selecting a preset opens a prompt input where the user types the initial task description.
- The chat view supports `/preset-name <initial prompt>` as a slash command, where `preset-name` is the preset's note filename without extension.
- Both invocation paths create a new conversation in the chat view labeled with the preset name and session ID.
- An active orchestration is indicated in the chat with a status label showing the current hat and iteration count.
- The user can stop an active orchestration via a "Stop" button in the chat view; this publishes `loop.cancel` if a cancellation event is configured, or terminates immediately if not.

---

### FR-74: Built-in Preset Library (Phase 6)

**Description:** Notor ships with a set of vault-native orchestration presets for common workflows, accessible out of the box without requiring users to author hats.

**Acceptance Criteria:**
- The following built-in presets are included:
  - **Code implementation** — planner → builder → critic → finalizer; TDD-based implementation with backpressure quality gates.
  - **Research synthesis** — explorer → synthesizer → verifier → summarizer; multi-phase research with citation tracking.
  - **Code review** — reviewer → commenter → responder; adversarial code review with structured feedback.
- Built-in presets are installed as vault notes in `{notor_dir}/orchestrations/presets/` and `{notor_dir}/orchestrations/hats/` on first launch or via a "Restore built-in presets" command.
- Built-in preset notes are regular vault notes; users can copy and modify them to create customized variants.
- Hat instructions in built-in presets encode role boundaries, decision protocols, confidence scoring, and explicit output contracts sufficient for reliable autonomous execution.

---

### FR-75: Ralph YAML Preset Migration Tool (Phase 6)

**Description:** Users who have existing Ralph YAML preset configurations can migrate them to vault notes.

**Acceptance Criteria:**
- A command palette action "Notor: Import Ralph YAML preset" accepts a `.yml` file path or a pasted YAML block.
- The importer creates vault notes for each hat (body = hat instructions) and a preset note referencing them.
- Ralph YAML fields are mapped to Notor frontmatter fields: `name` → `notor-hat-name`, `triggers` → `notor-hat-triggers`, `publishes` → `notor-hat-publishes`, `default_publishes` → `notor-hat-default-publishes`, `instructions` → note body.
- The user is shown a summary of the notes created before confirming the import.

## Non-Functional Requirements

### NFR-1: Safety and Token Economy

**Description:** Orchestrations must not silently consume unbounded tokens or run indefinitely.

**Acceptance Criteria:**
- Every preset requires both `notor-loop-max-iterations` and `notor-loop-max-runtime-minutes`; presets missing these fields are rejected at load time.
- Stale loop detection (same event+payload emitted 3+ times in a row) terminates the loop and displays a diagnostic message before the loop can repeat more than a small number of times.
- Thrashing detection (3+ re-dispatches of previously abandoned tasks) terminates the loop.
- Session cost is tracked cumulatively and displayed in the chat status alongside the iteration count.
- When a loop terminates abnormally, the session log and workspace notes preserve enough context for the user to diagnose what happened.

### NFR-2: Vault-Native State

**Description:** All orchestration state is stored as vault notes, consistent with Notor's vault-first design.

**Acceptance Criteria:**
- No orchestration-specific database tables are added; all authoritative state is in vault notes or the append-only session event log (a JSONL file in the session directory).
- Session state is visible in Obsidian's file explorer alongside regular notes.
- Users can manually edit workspace notes, task notes, and the memory note at any time to correct or supplement the AI's work.
- Session notes are created in the user's configured `notor_dir`, respecting their vault layout preferences.

### NFR-3: Incremental Rollout

**Description:** The feature is delivered in six phases, each independently shippable, so users get value earlier and each phase can be validated before the next begins.

**Acceptance Criteria:**
- Phase 1 (core loop) delivers a working end-to-end orchestration with hat routing, safety guards, and chat visibility.
- Phase 2 (workspace + tasks + memory + recovery) adds session state and crash safety.
- Phase 3 (backpressure) adds quality gate enforcement.
- Phase 4 (interactive) adds human-in-the-loop pausing.
- Phase 5 (lifecycle hooks) adds external integration.
- Phase 6 (built-in presets) adds out-of-box workflows.
- Each phase ships without breaking the previous phase's functionality.

### NFR-4: Transparent Execution

**Description:** Every action taken during orchestration is visible to and controllable by the user.

**Acceptance Criteria:**
- Every hat turn and its output is shown in the chat view with the hat name and iteration number.
- Tool calls made by any hat are rendered with the same approval UI and diff view as regular chat tool calls.
- The active hat, iteration count, and session status are visible in the chat header during a running orchestration.
- Session workspace notes and task notes are accessible in Obsidian's file explorer and can be opened at any time.

## User Scenarios & Testing

### Primary Flow: Running a Code Implementation Preset

1. User opens the command palette and selects "Notor: Run orchestration".
2. The preset picker shows available presets; user selects "Code Implementation".
3. User types: "Add a `--verbose` flag to the CLI entry point with focused tests."
4. Notor creates a session, publishes `build.start`, and the planner hat activates.
5. Planner hat creates task notes and emits `tasks.ready` with a task ID.
6. Builder hat activates, reads the task note, implements the feature using vault and shell tools (user approves file writes via the normal approval UI), and emits `review.ready`.
7. Critic hat activates, independently re-runs tests, and emits `review.passed`.
8. Finalizer hat confirms all planned tasks are closed and emits `LOOP_COMPLETE`.
9. The loop ends; a completion message with session summary is shown in the chat.

### Alternative Flow: Safety Termination

1. An orchestration runs for 25 iterations without progressing toward completion.
2. The stale loop detector observes the same `build.blocked` event emitted three times in a row.
3. The loop terminates with status `stale`; the user sees a message: "Orchestration terminated: loop appears stuck (same event emitted 3 times in a row). Review `progress.md` and `decisions.md` for context."
4. No further API calls are made.

### Alternative Flow: Human Pause

1. The builder hat cannot determine the correct API endpoint and emits `user.input.required` with the payload "Which API endpoint should be used for the search feature? Options: `/api/v1/search` or `/api/v2/query`."
2. The loop pauses; the question appears in the chat view as a user-facing prompt.
3. The user types: "Use `/api/v2/query`."
4. The response is injected and the loop resumes with the builder hat receiving the answer.

### Edge Case: Crash Recovery

1. Obsidian crashes while the builder hat is mid-execution on iteration 7.
2. User reopens Obsidian. On load, Notor detects an `active` session in `session.json`.
3. The session log shows `turn.start` for iteration 7 with no matching `turn.complete`.
4. Notor displays: "Orchestration session detected (code-assist / iteration 7). Resume?" with session details.
5. User confirms; the triggering event is re-published and iteration 7 retries cleanly.

### Edge Case: Premature Completion Attempt

1. The builder hat emits `LOOP_COMPLETE` after completing only the first of three planned tasks.
2. The engine checks `required_events`; `review.approved` has not been seen.
3. Completion is rejected; a `task.resume` event is injected: "LOOP_COMPLETE rejected: required event `review.approved` has not been seen. Complete all planned phases before signaling completion."
4. The loop continues from the coordinator hat.

## Success Criteria

- A user with no prior orchestration experience can invoke a built-in preset, provide a prompt, and receive a completed multi-step workflow outcome without writing any hat instructions.
- An orchestration involving four hat roles (planner, builder, critic, finalizer) completes a task end-to-end with no human intervention beyond the initial prompt and standard tool approvals.
- A stuck orchestration (e.g., a hat repeatedly emitting the same blocked event) terminates automatically within five iterations of becoming stuck.
- An orchestration interrupted by an Obsidian crash resumes from its last complete state without data loss after the user confirms recovery.
- All hat turns, tool calls, and workspace note changes are visible in the chat view and vault during an active session.
- A user can author a new hat note and wire it into a working preset using only Obsidian's markdown editor.
- Orchestration sessions do not require any external CLI tools, external processes, or network resources beyond the existing LLM provider API.

## Key Entities

### Hat
- **Attributes:** name, description, trigger topics (list), publish topics (list), default-publish topic, instructions (note body), persona override (optional), model override (optional)
- **Relationships:** belongs to one or more presets; persona is an existing Notor persona note
- **Validation:** trigger topics must be unique per preset; reserved topics (`task.start`, `task.resume`) are prohibited as triggers

### Orchestration Preset
- **Attributes:** name, description, starting event, completion promise, max iterations, max runtime, required events (list), guardrails (list), backpressure gates (list)
- **Relationships:** references an ordered list of hat notes via wikilinks
- **State transitions:** none (static definition)

### Orchestration Session
- **Attributes:** session ID (timestamp + random suffix), preset name, status (`active`, `waiting_for_input`, `completed`, `terminated`, `interrupted`), current iteration, started-at timestamp
- **Relationships:** belongs to one preset; owns workspace notes, task notes, session log

### Orchestration Task
- **Attributes:** task key, description, status (`open`, `running`, `closed`, `blocked`), created/started/completed timestamps
- **Relationships:** belongs to one session
- **Validation:** `LOOP_COMPLETE` is rejected if any task has status `open` or `running`

### Orchestration Event
- **Attributes:** topic, payload, emitting hat, iteration number, timestamp
- **Relationships:** produced by a hat turn; consumed by the next hat turn
- **Storage:** append-only in `session-log.jsonl`

### Persistent Memory
- **Attributes:** section (patterns / decisions / fixes / context), entry ID, content, timestamp
- **Relationships:** shared across all sessions; not scoped to a session
- **Storage:** single vault note at `{notor_dir}/orchestrations/memories.md`

## Assumptions

- Each trigger topic is owned by at most one hat per preset; multiple hats subscribing to the same topic within a preset is a configuration error.
- Hat instructions must be written to be idempotent (safe to retry if interrupted mid-turn); this is a documented authoring requirement, not an enforced constraint.
- The LLM provider must support function/tool calling; providers that do not support tool use cannot run orchestrations.
- Hat instructions should be detailed and explicit (typically 50–400 lines); short, vague instructions reliably produce unreliable hat behavior. This is a prompt engineering concern, not a system constraint.
- Parallel orchestration (multiple loops running simultaneously on separate git worktrees) is not in scope for this phase.
- The existing Notor context compaction system applies within hat turns; very long hat turns may compact earlier tool results.
- Workspace notes created during a session are not automatically deleted when the session ends; they remain in the vault for the user's reference.

## Out of Scope

- Parallel orchestration loops (multiple sessions running simultaneously on separate branches or worktrees).
- Per-hat MCP server activation/deactivation (per-hat tool set scoping is deferred; all MCP servers available to the user are available to all hats).
- A visual workflow graph editor for designing orchestration topologies.
- Streaming hat turn output to an external service or notification channel (e.g., Telegram, Slack).
- Automatic post-session cleanup or archiving of session directories.
- Ralph CLI subprocess integration; the implementation is entirely in-process.
- Any orchestration running outside the Obsidian plugin context (no standalone CLI or server mode).
