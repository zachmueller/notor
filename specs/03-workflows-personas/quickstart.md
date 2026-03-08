# Quickstart: Phase 4 — Workflows & Personas

**Created:** 2026-08-03
**Plan:** [specs/03-workflows-personas/plan.md](plan.md)

This document covers development environment additions for Phase 4. It supplements the setup guides from [specs/01-mvp/quickstart.md](../01-mvp/quickstart.md) and [specs/02-context-intelligence/quickstart.md](../02-context-intelligence/quickstart.md).

---

## Prerequisites

- Existing Notor development environment (Phase 0–3) set up per previous quickstart guides
- Node.js 18+ and npm
- esbuild bundler (already configured)
- A test vault with the Notor plugin installed

---

## New Dependency

Phase 4 adds one new npm dependency for cron scheduling:

```bash
# After R-1 research confirms the library choice (e.g., croner)
npm install croner
```

**Note:** The specific cron library depends on R-1 research findings. `croner` is the current leading candidate (~5 KB, zero deps, ESM). If research identifies a better alternative, substitute accordingly.

---

## New Source Modules

Phase 4 introduces the following new source modules under `src/`:

```
src/
  personas/
    persona-discovery.ts    # Scan {notor_dir}/personas/ for persona directories
    persona-manager.ts      # Persona activation, switching, revert logic
  workflows/
    workflow-discovery.ts   # Scan {notor_dir}/workflows/ for workflow notes
    workflow-executor.ts    # Workflow prompt assembly and execution pipeline
    workflow-manager.ts     # Concurrency management, execution tracking
    include-note.ts         # <include_note> tag parser and resolver
  hooks/
    vault-event-hooks.ts    # Vault event hook configuration and listener management
    vault-event-engine.ts   # Event handler dispatch, debounce, loop prevention
    cron-scheduler.ts       # Cron expression scheduling (wraps cron library)
  ui/
    persona-picker.ts       # Persona selection dropdown in chat panel
    workflow-suggest.ts     # Slash-command autocomplete for workflow attachment
    workflow-chip.ts        # Workflow chip rendering in chat input
    workflow-indicator.ts   # Workflow activity indicator in chat panel header
```

### Module Responsibilities

| Module | Purpose |
|---|---|
| `persona-discovery.ts` | Scans persona directories, parses frontmatter, returns `Persona[]` |
| `persona-manager.ts` | Manages active persona state, handles switching/revert, integrates with system prompt builder and provider registry |
| `workflow-discovery.ts` | Scans workflow directory recursively, parses frontmatter, validates, returns `Workflow[]` |
| `workflow-executor.ts` | Reads workflow body, resolves `<include_note>` tags, wraps in `<workflow_instructions>`, assembles trigger context, creates conversation |
| `workflow-manager.ts` | Concurrency limiter, execution queue, single-instance guard, activity tracking for UI indicator |
| `include-note.ts` | Parses `<include_note ... />` tags, resolves paths (vault-relative and wikilink), extracts sections, handles errors |
| `vault-event-hooks.ts` | Configuration model for vault event hooks, CRUD operations (mirroring `hook-config.ts` pattern) |
| `vault-event-engine.ts` | Registers/unregisters Obsidian event listeners, dispatches hooks, manages debounce, handles loop prevention |
| `cron-scheduler.ts` | Wraps cron library for creating/destroying scheduled jobs, validates cron expressions |
| `persona-picker.ts` | UI component for persona selection in chat panel settings area |
| `workflow-suggest.ts` | `/`-triggered autocomplete dropdown for workflow selection |
| `workflow-chip.ts` | Visual chip element representing an attached workflow in chat input |
| `workflow-indicator.ts` | Activity indicator badge/icon in chat panel header with dropdown for recent workflows |

---

## Existing Modules to Extend

Phase 4 modifies several existing modules:

| Existing Module | Changes |
|---|---|
| `src/settings.ts` | Add `persona_auto_approve`, `vault_event_hooks`, `vault_event_debounce_seconds`, `workflow_concurrency_limit`, `workflow_activity_indicator_count` to `NotorSettings`. Add settings UI sections: persona auto-approve sub-page, vault event hooks, provider/model identifier reference. Extend hook UI to support "run workflow" action type. |
| `src/chat/system-prompt.ts` | Integrate persona system prompt (append/replace modes). Call `<include_note>` resolver on global prompt, persona prompt, and vault rule bodies. |
| `src/chat/dispatcher.ts` | Add persona auto-approve override resolution in tool dispatch flow (step 7 in updated dispatch). |
| `src/chat/orchestrator.ts` | Support workflow conversation creation, background execution, persona switching lifecycle. |
| `src/context/message-assembler.ts` | Support `<trigger_context>` block prepending, `<workflow_instructions>` wrapping, `<include_note mode="attached">` collection into `<attachments>` block. |
| `src/hooks/hook-config.ts` | Add `action_type` and `workflow_path` fields to `Hook` interface. Add CRUD helpers for vault event hooks. |
| `src/hooks/hook-engine.ts` | Support "run workflow" action type alongside "execute command". Support workflow-scoped hook overrides. |
| `src/rules/vault-rules.ts` | Call `<include_note>` resolver on vault rule file bodies during injection. |
| `src/ui/chat-view.ts` | Add persona picker, workflow activity indicator, slash-command autocomplete, workflow chip display, `<details>` rendering for `<workflow_instructions>` blocks. |
| `src/main.ts` | Initialize persona manager, workflow manager, vault event engine. Register "Notor: Run workflow" command. Wire new managers to view. |
| `src/types.ts` | Add TypeScript interfaces for Persona, Workflow, VaultEventHook, WorkflowExecution, etc. |

---

## Test Vault Setup

### Persona Testing

Create test personas in the test vault:

```bash
# Create persona directories
mkdir -p e2e/test-vault/notor/personas/researcher
mkdir -p e2e/test-vault/notor/personas/organizer

# Create researcher persona
cat > e2e/test-vault/notor/personas/researcher/system-prompt.md << 'EOF'
---
notor-persona-prompt-mode: "append"
notor-preferred-model: ""
---
You are a research assistant focused on finding connections between ideas, identifying gaps in knowledge, and suggesting areas for further investigation.
EOF

# Create organizer persona with model override
cat > e2e/test-vault/notor/personas/organizer/system-prompt.md << 'EOF'
---
notor-persona-prompt-mode: "append"
notor-preferred-provider: "anthropic"
notor-preferred-model: "claude-sonnet-4-20250514"
---
You are an organization assistant focused on categorizing notes, managing tags, and maintaining vault structure.
EOF
```

### Workflow Testing

Create test workflows:

```bash
# Create workflow directories
mkdir -p e2e/test-vault/notor/workflows/daily

# Create a manual workflow
cat > e2e/test-vault/notor/workflows/daily/review.md << 'EOF'
---
notor-workflow: true
notor-trigger: manual
notor-workflow-persona: "organizer"
---
# Daily note review

Review today's daily notes and create a summary.

## Step 1: Find today's notes
Search for notes created or modified today in the Daily/ folder.

## Step 2: Create summary
Write a summary note with key themes and action items.
EOF

# Create an on-save workflow
cat > e2e/test-vault/notor/workflows/auto-tag.md << 'EOF'
---
notor-workflow: true
notor-trigger: on-save
---
# Auto-tag on save

Read the note that triggered this workflow and suggest appropriate tags based on its content.
EOF
```

### `<include_note>` Testing

Create test notes for include resolution:

```bash
# Create a note to be included
cat > e2e/test-vault/Research/Climate.md << 'EOF'
---
tags: [research, climate]
---
# Climate Research

## Key Findings

Global temperatures have risen by 1.2°C since pre-industrial levels.

## Methodology

Data collected from 500 weather stations worldwide.
EOF

# Create a workflow that uses <include_note>
cat > e2e/test-vault/notor/workflows/analyze-climate.md << 'EOF'
---
notor-workflow: true
notor-trigger: manual
---
# Analyze climate data

Review the key findings from climate research:

<include_note path="Research/Climate.md" section="Key Findings" />

Suggest three follow-up research questions based on these findings.
EOF
```

---

## Development Workflow

### Build and Watch

```bash
# Standard dev mode (unchanged from previous phases)
npm run dev
```

### Testing Phase 4 Features

1. **Persona testing:**
   - Create persona directories in the test vault
   - Open Settings → Notor → verify persona discovery
   - Open chat panel → gear icon → verify persona picker
   - Select a persona → verify system prompt changes

2. **Workflow testing:**
   - Create workflow notes in the test vault
   - Open command palette → "Notor: Run workflow" → verify workflow list
   - Run a manual workflow → verify conversation creation and prompt assembly
   - Verify `<workflow_instructions>` collapsed rendering in chat

3. **`<include_note>` testing:**
   - Create workflows with `<include_note>` tags
   - Run the workflow → verify tag resolution and content injection
   - Test with missing notes → verify error markers
   - Test with section extraction → verify heading-level boundaries

4. **Vault event hook testing:**
   - Configure hooks in Settings → Notor → Vault event hooks
   - Test `on-save` with a shell command → verify execution and `NOTOR_NOTE_PATH`
   - Test `on-save` with "run workflow" action → verify background execution
   - Test debounce by saving rapidly → verify only first save triggers

5. **E2e test scripts (new):**
   - `e2e/scripts/persona-test.ts` — persona discovery, switching, revert
   - `e2e/scripts/workflow-test.ts` — workflow discovery, manual execution, prompt assembly
   - `e2e/scripts/include-note-test.ts` — tag resolution, error handling, section extraction
   - `e2e/scripts/vault-event-hook-test.ts` — event hook firing, debounce, loop prevention

---

## Key Implementation Notes

### Pattern: File-Based Discovery

Both persona and workflow discovery follow the same pattern:
1. Get the root directory via `vault.getAbstractFileByPath()`
2. List children (personas: subdirectories; workflows: recursive Markdown files)
3. Filter by marker (personas: `system-prompt.md` exists; workflows: `notor-workflow: true` frontmatter)
4. Parse frontmatter via `metadataCache.getFileCache()?.frontmatter`
5. Build in-memory model objects

### Pattern: Hook Extension

Phase 4 extends the Phase 3 hook system in two ways:
1. **New event types:** Vault events alongside LLM lifecycle events
2. **New action type:** "Run a workflow" alongside "execute shell command"

Both extensions preserve backward compatibility — existing hook configurations continue to work unchanged.

### Pattern: XML Context Injection

Phase 4 adds two new XML blocks to the message assembly:
- `<trigger_context>` — event metadata for event-triggered workflows
- `<workflow_instructions>` — wrapped workflow body content

These follow the same XML-tagged pattern established in Phase 3 for `<auto-context>` and `<attachments>`.
