# E2E Test Plan: Phase 4b — `<notor_tool_config>` XML Tag System

**Created:** 2026-03-22
**Specification:** [spec.md](spec.md)
**Implementation Tasks:** [tasks.md](tasks.md)
**Status:** Draft

---

## Overview

This document defines end-to-end Playwright test scripts that validate the `<notor_tool_config>` system through a real Obsidian instance via CDP. Tests follow the existing `e2e/scripts/` conventions: setup vault fixtures, inject settings, launch Obsidian, interact via Playwright, assert via DOM + structured logs + filesystem.

**New test scripts:**
| Script | Focus | LLM Required |
|---|---|---|
| `tool-config-parse-strip-test.ts` | Tag extraction, stripping, validation notices | No |
| `tool-config-disabled-tool-test.ts` | Disabled tool blocking via LLM dispatch | Yes |
| `tool-config-auto-approve-test.ts` | Per-tool auto-approve override via LLM dispatch | Yes |
| `tool-config-path-enforce-test.ts` | Path constraint enforcement via LLM dispatch | Yes |
| `tool-config-precedence-test.ts` | Workflow > persona > rule merge ordering | Yes |
| `tool-config-inspector-test.ts` | Inspector leaf view rendering & live updates | No |
| `tool-config-settings-ui-test.ts` | Copy helper button + Personas settings section | No |

---

## Shared Test Fixtures

All scripts share a common set of vault fixtures created during setup. Each script's `ensureToolConfigFixtures()` function creates the files it needs.

### Persona Fixtures

**`notor/personas/restrictive/system-prompt.md`** — Disables write tools, restricts paths:
```markdown
---
notor-persona-prompt-mode: append
---

You are a read-only research assistant.

<notor_tool_config version="1.0">
write_note:
  enabled: false
replace_in_note:
  enabled: false
read_note:
  auto_approve: true
  allowed_paths:
    - "Notes/"
    - "Research/"
  blocked_paths:
    - "Notes/Private/"
</notor_tool_config>
```

**`notor/personas/permissive/system-prompt.md`** — Auto-approves everything:
```markdown
---
notor-persona-prompt-mode: append
---

You are a fully autonomous assistant.

<notor_tool_config version="1.0">
write_note:
  auto_approve: true
  enabled: true
read_note:
  auto_approve: true
replace_in_note:
  auto_approve: true
search_vault:
  auto_approve: true
</notor_tool_config>
```

**`notor/personas/invalid-config/system-prompt.md`** — Contains validation errors:
```markdown
---
notor-persona-prompt-mode: append
---

You are a test persona with bad config.

<notor_tool_config version="1.0">
nonexistent_tool:
  enabled: true
read_note:
  enabled: "yes"
  auto_approve: 42
  allowed_paths: "not-an-array"
</notor_tool_config>
```

### Workflow Fixtures

**`notor/workflows/override-persona.md`** — Workflow that overrides persona config:
```markdown
---
notor-workflow: true
notor-trigger: manual
notor-workflow-persona: "restrictive"
---

Re-enable write tools for this workflow.

<notor_tool_config version="1.0">
write_note:
  enabled: true
  auto_approve: true
</notor_tool_config>
```

**`notor/workflows/disable-all-writes.md`** — Workflow that disables write tools:
```markdown
---
notor-workflow: true
notor-trigger: manual
---

<notor_tool_config version="1.0">
write_note:
  enabled: false
replace_in_note:
  enabled: false
update_frontmatter:
  enabled: false
manage_tags:
  enabled: false
</notor_tool_config>

Summarize the contents of the vault. Do not modify any files.
```

**`notor/workflows/path-restricted.md`** — Workflow with path constraints:
```markdown
---
notor-workflow: true
notor-trigger: manual
---

Only work within the Journal folder.

<notor_tool_config version="1.0">
read_note:
  auto_approve: true
  allowed_paths:
    - "Journal/"
write_note:
  auto_approve: true
  allowed_paths:
    - "Journal/"
  blocked_paths:
    - "Journal/Private/"
</notor_tool_config>
```

### Vault Rule Fixtures

**`notor/rules/readonly-rule.md`** — Rule that activates on certain notes:
```markdown
---
notor-rule: true
notor-rule-active-note: "^Archive/"
---

This note is archived. Do not modify it.

<notor_tool_config version="1.0">
write_note:
  enabled: false
replace_in_note:
  enabled: false
</notor_tool_config>
```

### Test Notes

- `Notes/Meeting Notes.md` — Standard note for read tests
- `Notes/Private/Secret.md` — Note in blocked path
- `Research/Paper.md` — Note in allowed path
- `Journal/2025-01-15.md` — Note for path-restricted workflow tests
- `Journal/Private/Draft.md` — Note in blocked sub-path
- `Archive/Old Project.md` — Note that triggers the readonly rule

### Shared Config Injection

**`injectToolConfigTestSettings()`** — Base settings for all tool-config tests:
```typescript
{
  auto_approve: {
    read_note: true,
    search_vault: true,
    list_vault: true,
    read_frontmatter: true,
    fetch_webpage: false,
    write_note: false,
    replace_in_note: false,
    update_frontmatter: false,
    manage_tags: false,
    execute_command: false,
  },
  // Provider config for LLM tests (Bedrock)
  active_provider: "bedrock",
  log_level: "debug",
}
```

---

## Script 1: `tool-config-parse-strip-test.ts`

**Purpose:** Validate that `<notor_tool_config>` blocks are parsed, stripped from LLM-visible content, and validation errors surfaced as Notices.

**LLM Required:** No (UI-only + log assertions)

### Tests

| # | Name | Action | Assertion |
|---|---|---|---|
| 1 | Chat panel present | Wait for `.notor-chat-container` | Element found |
| 2 | Activate restrictive persona | Select "restrictive" via settings popover | Persona label shows "restrictive" |
| 3 | Tool config extracted log | Check structured logs | `source: "SystemPromptBuilder"` log contains "extractToolConfigs" or "tool config" with persona source |
| 4 | Config block stripped from system prompt | Check structured logs for assembled system prompt | No `<notor_tool_config>` text in any log showing prompt content sent to LLM |
| 5 | Activate invalid-config persona | Switch to "invalid-config" persona | Persona label shows "invalid-config" |
| 6 | Send a message to trigger config resolution | Type and send any message (will fail due to bad config, but config resolution runs first) | Message sent |
| 7 | Validation error Notices rendered | Check for `.notice` elements or structured logs with validation errors | Errors logged for: unknown tool name, non-boolean `enabled`, non-boolean `auto_approve`, non-array `allowed_paths` |
| 8 | Validation errors contain source file | Check structured log error entries | Each error references `"notor/personas/invalid-config/system-prompt.md"` as `sourceFile` |
| 9 | Deactivate persona | Select "None" | Persona label hidden |
| 10 | No error logs for valid personas | Check error-level logs from tool-config sources | Zero errors from valid persona configs |

### Key Log Sources to Check
- `SystemPromptBuilder` — extraction events
- `ToolConfigParser` or parser-related logs — validation errors
- `ChatOrchestrator` — `resolveEffectiveConfig` events

---

## Script 2: `tool-config-disabled-tool-test.ts`

**Purpose:** Validate that tools with `enabled: false` are blocked at dispatch time (FR-83) and excluded from the LLM tool list.

**LLM Required:** Yes (needs LLM to attempt tool calls)

### Tests

| # | Name | Action | Assertion |
|---|---|---|---|
| 1 | Chat panel present | Wait for `.notor-chat-container` | Element found |
| 2 | Activate restrictive persona | Select "restrictive" via settings popover | Persona label shows "restrictive" |
| 3 | Prompt LLM to use disabled tool | Send: "Please write a note called 'Test' with content 'hello'" | Response received |
| 4 | Write tool blocked | Check response / tool cards | Response does NOT contain a successful `write_note` tool card; response mentions inability or uses alternative approach |
| 5 | Blocked tool log entry | Check structured logs | `source: "ToolDispatcher"`, message contains "Blocked disabled tool" with `write_note` |
| 6 | Error status on tool call | Check structured logs | Tool call status set to `"error"` with message "Tool 'write_note' is disabled" |
| 7 | File not created | Check filesystem | `Test.md` does NOT exist in vault |
| 8 | Prompt LLM to use enabled tool | Send: "Please read the note 'Notes/Meeting Notes.md'" | Response received |
| 9 | Read tool succeeds | Check response / tool cards | `read_note` tool card present with success status |
| 10 | Deactivate persona and retry write | Deactivate persona, send: "Write a note called 'Test2' with content 'world'" | `write_note` tool card present (may need approval if not auto-approved, but tool is not blocked) |
| 11 | No disabled-tool blocking after deactivation | Check structured logs | No "Blocked disabled tool" log for `write_note` after deactivation |

### Cleanup
- Delete `Test.md` and `Test2.md` if created

---

## Script 3: `tool-config-auto-approve-test.ts`

**Purpose:** Validate that `auto_approve` from `<notor_tool_config>` overrides global auto-approve settings (unified early-return in dispatcher).

**LLM Required:** Yes

### Tests

| # | Name | Action | Assertion |
|---|---|---|---|
| 1 | Chat panel present | Wait for `.notor-chat-container` | Element found |
| 2 | Baseline: write_note requires approval | Global `auto_approve.write_note = false`; no persona active. Send write prompt. | Tool card shows approval UI or `"waiting_approval"` status in logs |
| 3 | Activate permissive persona | Select "permissive" persona | Persona label shows "permissive" |
| 4 | write_note auto-approved via persona config | Send: "Write a note called 'AutoTest' with 'auto-approved content'" | `write_note` executes without approval prompt; structured log confirms auto-approve resolved from effective config |
| 5 | Auto-approve resolution log | Check structured logs | `ToolDispatcher` log shows auto-approve decision sourced from effective tool config, not global settings |
| 6 | File created | Check filesystem | `AutoTest.md` exists with expected content |
| 7 | Activate restrictive persona | Switch to "restrictive" persona | Persona label shows "restrictive" |
| 8 | read_note auto-approved for allowed path | Send: "Read the note 'Notes/Meeting Notes.md'" | `read_note` executes without approval prompt |
| 9 | Deactivate persona | Select "None" | Persona label hidden |
| 10 | Global defaults restored | Send a read prompt | Auto-approve reverts to global setting (`read_note: true` globally) — still auto-approved but via global path, not effective config |

### Cleanup
- Delete `AutoTest.md` if created

---

## Script 4: `tool-config-path-enforce-test.ts`

**Purpose:** Validate `allowed_paths` and `blocked_paths` enforcement at dispatch time (FR-84).

**LLM Required:** Yes

### Tests

| # | Name | Action | Assertion |
|---|---|---|---|
| 1 | Chat panel present | Wait for `.notor-chat-container` | Element found |
| 2 | Activate restrictive persona | Select "restrictive" persona | Persona label shows "restrictive" |
| 3 | Read from allowed path succeeds | Send: "Read 'Notes/Meeting Notes.md'" | `read_note` succeeds; content returned |
| 4 | Read from allowed path (Research) succeeds | Send: "Read 'Research/Paper.md'" | `read_note` succeeds |
| 5 | Read from blocked path fails | Send: "Read 'Notes/Private/Secret.md'" | Tool call returns error; structured log shows path constraint violation |
| 6 | Path enforcement error message | Check structured logs | Message contains "path constraint violation" for `Notes/Private/Secret.md` |
| 7 | Read from disallowed path fails | Send: "Read 'Journal/2025-01-15.md'" | Path not in `allowed_paths` (`Notes/`, `Research/` only) → blocked |
| 8 | Execute path-restricted workflow | Execute `path-restricted` workflow; prompt: "Read 'Journal/2025-01-15.md'" | Succeeds — workflow allows `Journal/` |
| 9 | Workflow blocked path enforced | Within same workflow, prompt: "Write to 'Journal/Private/Draft.md'" | Blocked — `Journal/Private/` is in `blocked_paths` |
| 10 | blocked_paths overrides allowed_paths | Check structured log for test 9 | Path violation error references blocked path taking precedence |
| 11 | Deactivate persona | Select "None" | No path restrictions active |
| 12 | Read from previously blocked path | Send: "Read 'Notes/Private/Secret.md'" | Succeeds (no restrictions without persona) |

---

## Script 5: `tool-config-precedence-test.ts`

**Purpose:** Validate the merge precedence order: workflow > persona > rule > global defaults.

**LLM Required:** Yes

### Tests

| # | Name | Action | Assertion |
|---|---|---|---|
| 1 | Chat panel present | Wait for `.notor-chat-container` | Element found |
| 2 | Activate restrictive persona | Select "restrictive" persona | Persona label shows "restrictive" |
| 3 | Persona disables write_note | Send: "Write a note 'PrecTest' with 'test'" | Blocked — persona sets `write_note.enabled: false` |
| 4 | Execute override-persona workflow | Execute `override-persona` workflow with prompt: "Write a note 'PrecTest' with 'workflow override'" | Succeeds — workflow re-enables `write_note` and sets `auto_approve: true` |
| 5 | Workflow overrides persona | Check filesystem + structured logs | `PrecTest.md` created; logs confirm effective config has `write_note.enabled: true` from workflow source |
| 6 | Verify active parsed configs | Check structured logs for `resolveEffectiveConfig` | Both persona and workflow configs listed as contributing sources |
| 7 | Rule-based config applied | Ensure `Archive/Old Project.md` exists (triggers readonly-rule). Send message referencing archived note context. | Rule's tool config should contribute to merge when rule is matched |
| 8 | Rule lower priority than persona | Structured logs show rule config at priority 0, persona at priority 1 | Merge order correct |
| 9 | Global defaults fill unmentioned tools | Check structured logs or inspector data | Tools not mentioned in any config (e.g., `search_vault`, `list_vault`) get defaults: `enabled: true`, `auto_approve` from global settings |

### Cleanup
- Delete `PrecTest.md` if created

---

## Script 6: `tool-config-inspector-test.ts`

**Purpose:** Validate the Effective Config Inspector leaf view (FR-88) renders correctly and updates live.

**LLM Required:** No (inspector is UI-only)

### Tests

| # | Name | Action | Assertion |
|---|---|---|---|
| 1 | Chat panel present | Wait for `.notor-chat-container` | Element found |
| 2 | Open inspector via command palette | Open command palette → search "tool config inspector" → execute | Inspector leaf opens |
| 3 | No conversation message | Check inspector content | Displays "requires active conversation" or equivalent empty state |
| 4 | Activate restrictive persona | Select "restrictive" persona | Persona label shows "restrictive" |
| 5 | Send message to trigger config resolution | Send any message to start conversation | Response received |
| 6 | Inspector shows effective config | Check inspector leaf DOM | Table(s) rendered with tool entries |
| 7 | Disabled tool shown | Find `write_note` in inspector | Shows `enabled: false` |
| 8 | Source link present | Check `write_note` row | Source references `restrictive/system-prompt.md` |
| 9 | Default fields muted style | Check tools at defaults (e.g., `search_vault`) | Fields have muted/dimmed CSS class |
| 10 | Path constraints displayed | Check `read_note` row | `allowed_paths` shows `["Notes/", "Research/"]`; `blocked_paths` shows `["Notes/Private/"]` |
| 11 | Switch persona updates inspector | Switch to "permissive" persona, send another message | Inspector updates: `write_note.enabled: true`, `write_note.auto_approve: true` |
| 12 | Deactivate persona clears config | Deactivate persona, start new conversation | Inspector shows defaults or empty state |

---

## Script 7: `tool-config-settings-ui-test.ts`

**Purpose:** Validate the "Copy tool config YAML" button (UI-001) and the Personas settings section (UI-002).

**LLM Required:** No

### Tests

| # | Name | Action | Assertion |
|---|---|---|---|
| 1 | Chat panel present | Wait for `.notor-chat-container` | Element found |
| 2 | Open plugin settings | Navigate to Settings → Notor | Settings panel visible |
| 3 | Copy tool config button present | Find "Copy tool config YAML" button in Tools & permissions section | Button element found |
| 4 | Click copy button | Click the button | No error thrown |
| 5 | Clipboard content valid | Read clipboard (or check structured log / Notice) | Contains `<notor_tool_config version="1.0">`, YAML body, only tools differing from default `false` |
| 6 | Snippet reflects current auto-approve state | Compare clipboard content to injected `auto_approve` settings | Tools with `auto_approve: true` (read_note, search_vault, etc.) present; tools at default `false` absent |
| 7 | Personas section present | Find "Personas" section heading in settings | Section rendered |
| 8 | Existing personas listed | Check persona list items | "restrictive", "permissive", "invalid-config" visible |
| 9 | Open system prompt button | Find "Open system prompt" button for "restrictive" | Button element found |
| 10 | Click open system prompt | Click the button | Editor opens with `system-prompt.md` content (or structured log confirms `openLinkText` called) |
| 11 | Create new persona button | Find "Create new persona" button | Button element found |
| 12 | Create persona flow | Click button, enter name "e2e-test-persona" in prompt | New persona directory created at `notor/personas/e2e-test-persona/` |
| 13 | Skeleton includes tool config | Read created `system-prompt.md` | Contains `<notor_tool_config>` placeholder block |
| 14 | New persona appears in list | Re-check personas list | "e2e-test-persona" visible |
| 15 | Close settings | Press Escape | Settings closed |

### Cleanup
- Delete `notor/personas/e2e-test-persona/` directory

---

## Cross-Cutting Concerns

### Log Sources for Assertions

| Source | Key Events |
|---|---|
| `SystemPromptBuilder` | `extractToolConfigs` called, stripped content cached |
| `ChatOrchestrator` | `resolveEffectiveConfig` called, effective config stored |
| `ToolDispatcher` | Blocked disabled tool, path constraint violation, auto-approve resolved from effective config |
| `ToolConfigParser` | Validation errors (unknown tool, wrong type, MCP path field) |
| `PersonaManager` | Persona activated/deactivated |
| `WorkflowExecutor` | Workflow prompt assembled, tool configs extracted |

### Assertions That Do NOT Require LLM

These can run without a provider configured (faster, cheaper):
- Tag stripping from content (log-based)
- Validation error surfacing (log + Notice DOM)
- Inspector view rendering (DOM-based)
- Settings UI elements (DOM-based)
- Persona creation flow (filesystem + DOM)

### Assertions That Require LLM

These need a real LLM to generate tool calls:
- Disabled tool blocking (LLM must attempt the call)
- Auto-approve override (LLM must trigger dispatch)
- Path enforcement (LLM must call tool with specific path)
- Precedence verification (LLM must exercise overridden config)

### Error Scenarios Covered

| Scenario | Script | Test # |
|---|---|---|
| Unknown tool name in config | parse-strip | 7 |
| Wrong type for `enabled` field | parse-strip | 7 |
| Wrong type for `auto_approve` field | parse-strip | 7 |
| Non-array `allowed_paths` | parse-strip | 7 |
| Disabled tool dispatch attempt | disabled-tool | 4–6 |
| Path outside allowed_paths | path-enforce | 7 |
| Path in blocked_paths | path-enforce | 5 |
| blocked overrides allowed | path-enforce | 9–10 |
| No persona → global fallback | auto-approve | 10 |
| Workflow overrides persona | precedence | 4–5 |

---

## Execution Order

Scripts are independent but the recommended execution order minimizes fixture setup overhead:

1. `tool-config-settings-ui-test.ts` (no LLM, fast)
2. `tool-config-parse-strip-test.ts` (no LLM, fast)
3. `tool-config-inspector-test.ts` (no LLM, fast — but needs a message sent for config resolution)
4. `tool-config-disabled-tool-test.ts` (LLM required)
5. `tool-config-auto-approve-test.ts` (LLM required)
6. `tool-config-path-enforce-test.ts` (LLM required)
7. `tool-config-precedence-test.ts` (LLM required)

---

## Implementation Notes

- Each script follows the existing pattern: `ensureFixtures()` → `injectSettings()` → `launchObsidian()` → `connectPlaywright()` → tests → `writeSummary()` → cleanup
- Use `LogCollector.getStructuredLogs()` filtered by source for most assertions
- Screenshot at each test boundary for debugging failed runs
- LLM-dependent tests should use 90s timeout for responses (matching `tool-interaction-test.ts`)
- All test notes created in `ensureToolConfigFixtures()` should be idempotent (overwrite if exists)
- Results written to `e2e/results/tool-config-{script-name}-results.json`
