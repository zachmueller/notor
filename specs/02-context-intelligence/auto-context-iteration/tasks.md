# Task Breakdown: Auto-Context Iteration

**Created:** 2026-07-03
**Parent Specification:** [../spec.md](../spec.md)
**Status:** In Progress

## Summary

This iteration addresses six issues discovered during manual testing of the Phase 3 auto-context and hook injection features. The changes span auto-context injection location, hook output rendering, formatting, open-notes detection reliability, and expanded e2e test coverage.

**Total Tasks:** 12
**Steps:** 3 (Code Changes → E2E Tests → Validation)

---

## Issue Inventory

| ID | Issue | Root Cause | Impact |
|----|-------|-----------|--------|
| I-1 | Auto-context XML visible in chat as part of user message | `buildAutoContextBlock()` output assembled into user message content via `assembleUserMessage()` | User sees `<auto-context>` XML in their own chat bubble |
| I-2 | Hook stdout visible in chat as part of user message | `hookInjections` concatenated into user message content via `assembleUserMessage()` | User sees raw hook output in their own chat bubble |
| I-3 | Auto-context duplicated with every message | `buildAutoContextBlock()` called per-message in `handleUserMessage()`, result stored in each user message | Wastes tokens; redundant context in conversation history |
| I-4 | Vault structure folders not formatted as directories | `collectVaultStructure()` returns bare names; joined with commas | LLM can't distinguish folders from files |
| I-5 | Open notes not reliably detected until clicked | `getLeavesOfType("markdown")` may not enumerate all leaves until they're activated by the user | First message only shows active note; others appear only after clicking |
| I-6 | No active note indicator in open notes list | `collectOpenNotePaths()` returns flat path list with no active leaf marker | LLM doesn't know which note the user is currently viewing |

---

## Step 1: Code Changes

### ACI-001: Move auto-context from user message to system prompt ✅

**Description:** Relocate the `<auto-context>` block from the assembled user message into the system prompt. The auto-context should be built once before each LLM call (not stored per-message) and injected as a dynamic section in `SystemPromptBuilder.assemble()`. This resolves I-1 (visible XML in chat) and I-3 (duplication with every message).

**Files to modify:**
- `src/chat/system-prompt.ts` — Add a new `autoContextBlock` parameter to `assemble()` and include it as a dedicated section
- `src/chat/orchestrator.ts` — Move `buildAutoContextBlock()` call from `handleUserMessage()` into the `responseLoop()` before each `systemPromptBuilder.assemble()` call; remove `autoContext` from `assembleUserMessage()` call and from the `addMessage()` metadata
- `src/context/message-assembler.ts` — Remove `autoContext` from `MessageParts` interface and assembly logic (or keep interface but stop passing it)

**Dependencies:** None

**Acceptance Criteria:**
- [x] `SystemPromptBuilder.assemble()` accepts an optional `autoContextBlock?: string` parameter
- [x] When provided, auto-context block is inserted as a new section (after vault rules, before end) with a `## Workspace context` heading
- [x] Auto-context is freshly built before each LLM API call in `responseLoop()` (including tool-result round-trips), so open-notes and vault structure reflect the latest state
- [x] Auto-context XML no longer appears in user message `content` field
- [x] Auto-context is no longer stored per-message in JSONL `auto_context` field (it's ephemeral system prompt content)
- [x] `assembleUserMessage()` no longer includes `autoContext` in its output
- [x] User's chat bubble shows only their typed message text (no XML)
- [x] The `<auto-context>` block is still in XML format within the system prompt for LLM parsing consistency

### ACI-002: Move hook stdout to collapsible chat UI element ✅

**Description:** Instead of injecting pre-send hook stdout directly into the user message content, render it as a separate collapsible UI element in the chat panel. Behind the scenes, the hook output is sent as a distinct `user` message in the conversation (so the LLM still sees it), but it's displayed as a collapsible block rather than inline in the user's typed message. This resolves I-2.

**Files to modify:**
- `src/chat/orchestrator.ts` — After collecting `hookInjections`, instead of passing them to `assembleUserMessage()`, insert a separate user message with the hook output content (if non-empty), then insert the user's actual typed message as a second user message
- `src/context/message-assembler.ts` — Remove `hookInjections` from `MessageParts` interface (or stop passing it)
- `src/ui/chat-view.ts` — Add `renderHookInjection(message: Message): void` method that renders a collapsible `<details><summary>Hook output</summary>…</details>` UI element; style distinctly from regular user messages
- `src/types.ts` — Consider adding an optional `is_hook_injection?: boolean` flag to `Message` to allow the chat view to distinguish hook output messages from regular user messages
- `styles.css` — Add styles for `.notor-hook-injection` collapsible element

**Dependencies:** None

**Acceptance Criteria:**
- [x] Pre-send hook stdout no longer appears in the user's typed message bubble
- [x] Hook output renders as a collapsible element in the chat panel (collapsed by default)
- [x] Collapsible element shows a summary label like "Hook output" with the hook content inside
- [x] Behind the scenes, the hook output is sent as a distinct `user` message in the conversation so the LLM can see it
- [x] Hook output message is logged in JSONL with `is_hook_injection: true` (or similar marker)
- [x] When no hooks produce output, no collapsible element or extra message is created
- [x] When loading a conversation from history, hook injection messages render as collapsible elements (not as regular user messages)

### ACI-003: Fix formatting — each note/folder on its own line, directories appended with `/` ✅

**Description:** Update the auto-context XML assembly to ensure each open note path and each vault folder is printed on its own line. Append `/` to each directory name in vault structure to make it unambiguous. This resolves I-4 and part of I-6 (line-per-note prerequisite).

**Files to modify:**
- `src/context/auto-context.ts` — In `buildAutoContextBlock()`:
  - `<open-notes>`: already uses newline-separated paths; verify each path is on its own line with a leading newline after the tag and proper indentation
  - `<vault-structure>`: change from `folders.join(", ")` to `folders.map(f => f + "/").join("\n")` with newlines, matching the open-notes pattern

**Dependencies:** None

**Acceptance Criteria:**
- [x] Each open note path in `<open-notes>` is on its own separate line
- [x] Each folder in `<vault-structure>` is on its own separate line
- [x] Each folder name in `<vault-structure>` ends with `/` (e.g., `Research/`, `Daily/`)
- [x] Empty lists produce empty tags (no stray whitespace)
- [x] XML output is well-formed and parseable

### ACI-004: Fix open notes detection — enumerate all leaves reliably ✅

**Description:** Investigate and fix the bug where `collectOpenNotePaths()` only detects notes that the user has recently clicked on, rather than all notes that are currently open in tabs. The root cause is likely that `app.workspace.getLeavesOfType("markdown")` only returns leaves whose views have been initialized (Obsidian lazily initializes tab views). This resolves I-5.

**Files to modify:**
- `src/context/auto-context.ts` — Rework `collectOpenNotePaths()` to also enumerate leaves that haven't been activated yet. Potential approaches:
  - Iterate `app.workspace.getLeavesOfType("markdown")` and also check `leaf.view.getState()?.file` as a fallback for uninitialized views
  - Use `app.workspace.iterateAllLeaves()` which may enumerate all leaves regardless of activation state, filtering for those with a markdown file state
  - Access the workspace layout serialization (`app.workspace.getLayout()`) to find all open file paths

**Dependencies:** None

**Acceptance Criteria:**
- [x] All currently open markdown tabs are detected on the first message send, not just the active one
- [x] Notes in pinned tabs, split panes, and stacked tabs are all detected
- [x] Notes that have never been clicked/activated since Obsidian launch are still detected
- [x] Performance remains under 100ms for typical workspaces (< 50 open tabs)
- [x] No errors or exceptions for leaves without a file (e.g., empty new tabs)

### ACI-005: Add `(active)` marker to the active note in open notes list ✅

**Description:** When building the open notes auto-context, identify the active leaf and append ` (active)` to its path in the list. This resolves I-6.

**Files to modify:**
- `src/context/auto-context.ts` — Modify `collectOpenNotePaths()` (or `buildAutoContextBlock()`) to:
  1. Get the active leaf via `app.workspace.getActiveViewOfType(MarkdownView)` or `app.workspace.activeLeaf`
  2. Compare each collected path against the active leaf's file path
  3. Append ` (active)` to the matching path

**Dependencies:** ACI-003 (each note must be on its own line for the marker to be clear), ACI-004 (detection must be reliable first)

**Acceptance Criteria:**
- [x] Exactly one note in the `<open-notes>` list has ` (active)` appended to its path
- [x] The active marker is only present when an active markdown leaf exists
- [x] If the active leaf is not a markdown view (e.g., settings, graph), no note is marked active
- [x] The marker is ` (active)` (space, parenthesized, lowercase) — e.g., `Research/Climate.md (active)`

### ACI-006: Clean up message assembler after ACI-001 and ACI-002 ✅

**Description:** After auto-context and hook injections are removed from the user message assembly, simplify the `MessageParts` interface and `assembleUserMessage()` function. If attachments are the only remaining "extra" section, consider whether the assembler abstraction is still needed or if it can be simplified.

**Files to modify:**
- `src/context/message-assembler.ts` — Remove `autoContext` and `hookInjections` fields from `MessageParts`; simplify assembly to: attachments (if any) → user text
- `src/chat/orchestrator.ts` — Update call site to match simplified interface

**Dependencies:** ACI-001, ACI-002

**Acceptance Criteria:**
- [x] `MessageParts` interface only has `attachments?: string` and `userText: string`
- [x] `assembleUserMessage()` concatenates attachments block + user text (or just user text if no attachments)
- [x] No dead code paths referencing removed fields
- [x] Existing attachment functionality is unaffected

---

## Step 2: E2E Tests

### ACI-TEST-001: Auto-context in system prompt (not user message) ✅

**Description:** Create e2e test scenarios validating that auto-context appears in the system prompt and NOT in the user message content after the ACI-001 migration.

**Files:** `e2e/scripts/auto-context-test.ts` (rewritten with ACI-TEST-001 scenarios)

**Dependencies:** ACI-001

**Acceptance Criteria:**
- [x] Test: send a message → verify JSONL user message `content` does NOT contain `<auto-context>` XML (ACI-TEST-001-a)
- [x] Test: send a message → verify JSONL user message `auto_context` field is absent/null (ACI-TEST-001-b)
- [x] Test: send multiple messages → verify auto-context is NOT duplicated across user messages in the conversation history (ACI-TEST-001-c)
- [x] Test: intercept or log the system prompt sent to the LLM → verify it contains the `<auto-context>` block with expected content (open notes, vault structure, OS) (ACI-TEST-001-d/e)

**Implementation notes:**
- Added `log.debug("System prompt assembled", { systemPrompt })` to `src/chat/orchestrator.ts` so tests can intercept the assembled system prompt via the `LogCollector` (CDP console capture)
- Rewrote `e2e/scripts/auto-context-test.ts` with 7 sub-tests (a–g) covering: content absent, metadata absent, no duplication, system prompt sections, per-call rebuild, disabled source omission, all disabled
- Added `getSystemPromptLogs()` / `getLatestSystemPrompt()` helpers that filter the `LogCollector` structured logs for `ChatOrchestrator` / `"System prompt assembled"` entries

### ACI-TEST-002: Open notes detection — all tabs detected on first message ✅

**Description:** Create e2e test scenarios specifically targeting the open-notes detection reliability issue (I-5). These tests must open multiple notes programmatically and verify all are detected without requiring manual tab clicks.

**Files:** `e2e/scripts/auto-context-test.ts` (extend)

**Dependencies:** ACI-004

**Acceptance Criteria:**
- [x] Test: programmatically open 3+ notes in separate tabs → send first message → verify ALL opened note paths appear in auto-context (not just the active one)
- [x] Test: open notes in split panes → verify all detected
- [x] Test: open a note, then switch to a different note without closing the first → verify both appear
- [x] Test: close a note tab → send message → verify closed note no longer appears in auto-context
- [x] Test: open notes from different vault folders → verify full vault-relative paths are correct

### ACI-TEST-003: Active note marker ✅

**Description:** Create e2e tests validating the `(active)` marker on the currently active note.

**Files:** `e2e/scripts/auto-context-test.ts` (extend)

**Dependencies:** ACI-005

**Acceptance Criteria:**
- [x] Test: open multiple notes → send message → verify exactly one note has ` (active)` suffix in auto-context
- [x] Test: switch active note → send another message → verify the active marker moved to the new note
- [x] Test: the active marker matches the note that is currently in the foreground/focused leaf

### ACI-TEST-004: Vault structure formatting ✅

**Description:** Create e2e tests validating the vault structure formatting changes (line-per-folder, trailing `/`).

**Files:** `e2e/scripts/auto-context-test.ts` (extend)

**Dependencies:** ACI-003

**Acceptance Criteria:**
- [x] Test: verify each folder in `<vault-structure>` is on its own line
- [x] Test: verify each folder name ends with `/`
- [x] Test: verify folders are not comma-separated

**Implementation notes:**
- Added `extractVaultStructureRaw()` helper to preserve raw inner content for comma-detection
- Added `extractVaultStructure()` helper to parse entries into a trimmed, non-empty line array
- ACI-TEST-004-a (`testVaultStructureFoldersOnOwnLines`): sends a message, parses `<vault-structure>` entries, asserts ≥2 entries are present with no commas inside any single entry (single-entry and empty vaults handled gracefully)
- ACI-TEST-004-b (`testVaultStructureFoldersHaveTrailingSlash`): sends a second message in the same conversation, checks every parsed entry ends with `/`
- ACI-TEST-004-c (`testVaultStructureNotCommaSeparated`): sends a third message, inspects the raw inner content for `, ` (the separator used by the old `join(", ")` implementation)
- Tests run after a fresh page reload with `auto_context_vault_structure: true` to ensure the source is enabled
- Wired into `main()` as the ACI-TEST-004 block after ACI-TEST-003

### ACI-TEST-005: Hook output rendering

**Description:** Create e2e tests validating that hook output renders as a collapsible element rather than inline in the user message.

**Files:** `e2e/scripts/hook-execution-test.ts` (extend or create new file)

**Dependencies:** ACI-002

**Acceptance Criteria:**
- [ ] Test: configure a `pre-send` hook that echoes output → send message → verify the chat panel shows a collapsible hook output element (`.notor-hook-injection` or `<details>`)
- [ ] Test: verify the user's chat bubble does NOT contain the hook stdout text
- [ ] Test: verify the hook output is still sent to the LLM as a separate user message in the conversation
- [ ] Test: configure a hook that produces no output → verify no collapsible element appears

### ACI-TEST-006: Auto-context not duplicated across messages

**Description:** Create an e2e test that sends multiple messages in a single conversation and verifies auto-context content is not duplicated in the conversation history.

**Files:** `e2e/scripts/auto-context-test.ts` (extend)

**Dependencies:** ACI-001

**Acceptance Criteria:**
- [ ] Test: send 3 messages in sequence → read JSONL history → verify no user message `content` contains `<auto-context>` (all auto-context is in system prompt only)
- [ ] Test: verify token count is not inflated by repeated auto-context blocks across messages

---

## Step 3: Validation

### ACI-VAL-001: End-to-end validation

**Description:** Run all modified and new e2e tests, plus manual spot checks, to confirm all six issues are resolved and no regressions introduced.

**Dependencies:** All ACI-* and ACI-TEST-* tasks

**Acceptance Criteria:**
- [ ] All ACI-TEST-001 through ACI-TEST-006 pass
- [ ] Existing auto-context e2e tests (TEST-001) updated and pass
- [ ] Existing hook execution e2e tests (TEST-005) updated and pass
- [ ] Manual check: send a message with open notes → user chat bubble shows only typed text
- [ ] Manual check: hook output appears as collapsible element in chat panel
- [ ] Manual check: switching active note and sending another message shows updated active marker
- [ ] No regressions in attachment handling, compaction, or tool dispatch

---

## Dependency Graph

```
Step 1: Code Changes
  ACI-001 (auto-context → system prompt)     ─┐
  ACI-002 (hooks → collapsible UI)            ─┤─→ ACI-006 (assembler cleanup)
  ACI-003 (formatting: lines + dir slash)     ─┤
  ACI-004 (fix open notes detection)          ─┤
  ACI-005 (active note marker)               ─┘
    ↑ depends on ACI-003 + ACI-004

Step 2: E2E Tests
  ACI-TEST-001 (system prompt location)       depends on ACI-001
  ACI-TEST-002 (open notes reliability)       depends on ACI-004
  ACI-TEST-003 (active marker)               depends on ACI-005
  ACI-TEST-004 (vault structure formatting)   depends on ACI-003
  ACI-TEST-005 (hook rendering)              depends on ACI-002
  ACI-TEST-006 (no duplication)              depends on ACI-001

Step 3: Validation
  ACI-VAL-001                                depends on all above
```

## Critical Path

```
ACI-004 (fix detection) → ACI-005 (active marker) → ACI-TEST-002/003 → ACI-VAL-001
```

## Parallel Execution Opportunities

| Group | Tasks | Notes |
|-------|-------|-------|
| Core changes | ACI-001, ACI-002, ACI-003, ACI-004 | All four are independent of each other |
| Tests | ACI-TEST-001 through ACI-TEST-006 | All independent once their dependencies are met |
| Cleanup | ACI-006 | Blocked on ACI-001 + ACI-002 |