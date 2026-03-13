# Vault Schema Design: Orchestration Notes

> Proposes the vault-native format for defining orchestration presets and hats.
> Designed to be human-readable, editable in Obsidian, and version-controllable.

---

## Design Principles

1. **Vault-native** — everything is a Markdown note; works with Obsidian's editor, graph view, links
2. **Discoverable** — scanning a directory finds all hats and presets automatically
3. **YAML frontmatter for metadata** — stays consistent with Notor's existing workflow/persona conventions
4. **Body = instructions** — the note body is the hat's LLM instructions
5. **Composable** — presets reference hat notes by path or wikilink
6. **Compatible with include_note** — hats can reference other vault notes in their instructions

---

## Hat Note Format

A hat note lives under `{notor_dir}/orchestrations/hats/` (or any location,
since presets reference hats by path).

```yaml
---
notor-type: hat
notor-hat-name: "📋 Planner"
notor-hat-description: "Manages step decomposition and task queue"
notor-hat-triggers:
  - build.start
  - queue.advance
notor-hat-publishes:
  - tasks.ready
  - all_steps.done
notor-hat-default-publishes: tasks.ready
notor-hat-persona: planner-persona     # optional: persona override for this hat's LLM calls
notor-hat-model: claude-opus-4-6       # optional: model override for this hat
---

## PLANNER MODE — Step-Wave Strategy And Runtime Queue Ownership

You own decomposition and queue progression.
Do not implement. Do not review.

### Shared Documentation
...

### Logic
...
```

**Key frontmatter fields:**
- `notor-type: hat` — marks this as a hat definition
- `notor-hat-name` — display name (can include emoji)
- `notor-hat-description` — short description for display in UI
- `notor-hat-triggers` — events that activate this hat
- `notor-hat-publishes` — events this hat can emit
- `notor-hat-default-publishes` — event emitted if hat doesn't call emit_event
- `notor-hat-persona` — optional persona name for system prompt
- `notor-hat-model` — optional model override (uses active provider)

---

## Orchestration Preset Note Format

A preset note lives under `{notor_dir}/orchestrations/` and references hat notes.

```yaml
---
notor-type: orchestration-preset
notor-preset-name: "Code Implementation"
notor-preset-description: "TDD-based implementation with planner, builder, critic, finalizer"
notor-trigger: manual
notor-loop-starting-event: build.start
notor-loop-completion-promise: LOOP_COMPLETE
notor-loop-max-iterations: 100
notor-loop-max-runtime-minutes: 240
notor-hats:
  - notor/orchestrations/hats/planner.md
  - notor/orchestrations/hats/builder.md
  - notor/orchestrations/hats/critic.md
  - notor/orchestrations/hats/finalizer.md
notor-guardrails:
  - "Verification is mandatory — tests must pass"
  - "YAGNI ruthlessly — no speculative features"
  - "Confidence protocol: >80 proceed autonomously; 50-80 document decision; <50 choose safe default"
notor-backpressure-gates:
  - name: tests
    command: "npm test"
    on_fail: "Tests failed. Fix before proceeding."
---

# Code Implementation Workflow

Use this workflow to implement features with TDD. Provide a description of
what needs to be implemented as the prompt.

The workflow runs through planning, implementation, review, and finalization
phases automatically.
```

**Key frontmatter fields:**
- `notor-type: orchestration-preset` — marks this as a preset
- `notor-preset-name` — display name
- `notor-loop-starting-event` — first event to fire when preset starts
- `notor-loop-completion-promise` — terminal event that ends the loop
- `notor-loop-max-iterations` — safety limit on hat turns
- `notor-loop-max-runtime-minutes` — wall-clock time limit
- `notor-hats` — ordered list of hat note paths
- `notor-guardrails` — list of constraints injected into every hat's system prompt
- `notor-backpressure-gates` — instructs the LLM which commands to run before emitting
  `build.done`; the engine validates evidence strings in the payload (not executing the
  commands itself). Notor could optionally execute these commands directly since it has
  shell execution capability — a design choice distinct from Ralph's approach.

---

## Event Definitions (Optional)

An optional note type for defining event semantics:

```yaml
---
notor-type: event-catalog
---

# Event Catalog

## build.start
Triggers the build cycle. Payload: `{ prompt: string }`.

## tasks.ready
A runtime task is ready for building. Payload: `{ task_id, task_key, artifact_path? }`.

## review.ready
An implementation increment is ready for review. Same payload as tasks.ready.

## review.passed
Increment passed adversarial review. Same payload.

## review.rejected
Increment failed review. Payload: `{ task_id, task_key, feedback: string }`.

## queue.advance
Planner should advance the task queue. Payload: same as tasks.ready.

## LOOP_COMPLETE
All work is done. Terminates the orchestration loop.
```

---

## Workspace Notes (Scratchpad)

During orchestration, hats write shared state to vault notes.
Convention: `{notor_dir}/orchestrations/sessions/{session_id}/`

```
notor/orchestrations/sessions/2025-01-15-abc123/
  context.md         # implementation context, repo patterns, dependencies
  plan.md            # numbered high-level steps
  progress.md        # current step, active wave notes, verification log
  decisions.md       # confidence-protocol decisions (DEC-NNN entries)
  logs/
    build-output.md  # captured build/test results
```

These are regular vault notes:
- Hats write to them via `write-note` and `replace-in-note` tools
- Protected by the checkpoint system
- Visible and editable in Obsidian alongside the orchestration
- Can be referenced by `<include_note>` in hat instructions

---

## Runtime Tasks

A lightweight task tracking system for subtasks within an orchestration.

### Option A: Vault Notes (Recommended)

```
notor/orchestrations/sessions/{session_id}/tasks/
  code-assist_step-01_impl.md      # task note
  code-assist_step-01_tests.md     # task note
```

Task note format:
```yaml
---
notor-type: orchestration-task
notor-task-status: open             # open | running | closed | blocked
notor-task-key: code-assist:step-01:impl
notor-task-created: 2025-01-15T10:00:00Z
notor-task-started: null
notor-task-completed: null
---

# Add `--verbose` flag parsing in the CLI

## Description
Add `--verbose` flag to the CLI entry point with focused tests.

## Acceptance Criteria
- Flag is parsed and accessible
- Focused tests cover the parsing
- No other behavior changes
```

**Tools needed:**
- `orchestration_task_ensure(key, description)` — create if not exists
- `orchestration_task_start(task_id)` — mark as running
- `orchestration_task_close(task_id)` — mark as closed
- `orchestration_task_show(task_id)` — read task details
- `orchestration_task_list(session_id, status?)` — list tasks

### Option B: In-Memory + SQLite

Add `orchestration_tasks` table to the DB:
```sql
CREATE TABLE orchestration_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  error_message TEXT
);
```

**Pros:** Fast queries, no vault clutter
**Cons:** Not visible in Obsidian graph view, not version-controlled

**Recommendation:** Option A (vault notes) for visibility and Obsidian integration,
with a SQLite index for fast queries during orchestration.

---

## Directory Structure Proposal

```
{vault}/
  {notor_dir}/                    # e.g., "notor/" (from settings)
    workflows/                    # existing: simple single-turn workflows
    personas/                     # existing: personas
    rules/                        # existing: vault rules
    orchestrations/               # new: multi-hat orchestrations
      presets/
        code-assist.md            # orchestration preset
        research.md
        review.md
      hats/
        planner.md                # individual hat definitions
        builder.md
        critic.md
        finalizer.md
        researcher.md
      sessions/                   # created at runtime
        {session-id}/
          session.json            # metadata (status, iteration count, etc.)
          context.md              # shared context note
          plan.md                 # shared plan note
          progress.md             # shared progress note
          decisions.md            # confidence decisions
          tasks/                  # runtime tasks
            {task-key}.md
          logs/                   # captured output
            {n}-{hat}-output.md
```

---

## Discovery and Loading

**OrchestrationPresetDiscovery:**
Scans `{notor_dir}/orchestrations/presets/` for notes with `notor-type: orchestration-preset`.
Returns list of available presets (similar to workflow discovery).

**HatNoteLoader:**
Given a list of hat paths from a preset, loads each hat note:
1. Read vault note
2. Parse frontmatter for hat metadata
3. Extract body content as hat instructions
4. Resolve any `<include_note>` tags in instructions (for reference docs)

---

## Wikilink Support for Hat References

Hats can be referenced in preset frontmatter as wikilinks:
```yaml
notor-hats:
  - "[[planner]]"      # wikilink resolved via metadataCache
  - "[[builder]]"
```

Or as vault-relative paths:
```yaml
notor-hats:
  - notor/orchestrations/hats/planner.md
```

This allows using Obsidian's standard link resolution, including aliases and
backlink tracking.

---

## Preset Invocation

Orchestration presets are invoked via:
1. **Command palette**: "Notor: Run orchestration" → picker shows available presets
2. **Slash command in chat**: `/code-assist Implement the --verbose flag`
   - Preset name is the note filename (without extension)
   - Text after the preset name becomes the initial prompt
3. **Vault event hook** (if preset has `notor-trigger: on-save` etc.)

The invocation passes:
- Which preset to run
- The initial prompt text (used as `build.start` event payload or equivalent)
- Optional: which vault context to include

---

## Migration from Ralph YAML Presets

For users who have Ralph YAML presets, provide a migration tool:
- Parse existing `.yml` preset files
- Create vault notes for each hat (body = hat instructions)
- Create preset note referencing the hat notes
- Map YAML fields to frontmatter fields

```
ralph yaml:         notor frontmatter:
name           →    notor-hat-name
description    →    notor-hat-description
triggers       →    notor-hat-triggers
publishes      →    notor-hat-publishes
default_publishes → notor-hat-default-publishes
instructions   →    (becomes the note body)
```
