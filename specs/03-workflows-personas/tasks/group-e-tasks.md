# Task Breakdown: Group E — Manual Workflow Execution

**Created:** 2026-08-03
**Implementation Plan:** [specs/03-workflows-personas/plan.md](../plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](../spec.md)
**Contract:** [specs/03-workflows-personas/contracts/workflow-assembly.md](../contracts/workflow-assembly.md)
**Status:** In Progress

## Task Summary

**Total Tasks:** 16
**Phases:** 6 (Types → Prompt Assembly → Command Palette → Slash-Command UX → Conversation & UI → Wiring & Validation)
**FRs Covered:** FR-42, FR-43, FR-44
**Estimated Complexity:** High
**Parallel Execution Opportunities:** 4 task groups

## Dependency Graph

```
E-001 (Workflow execution types & settings)
  │
  ├──▶ E-002 (Workflow body reader)
  │       │
  │       └──▶ E-003 (<include_note> resolution in workflow body)
  │               │
  │               └──▶ E-004 (Empty workflow guard)
  │                       │
  │                       └──▶ E-005 (<workflow_instructions> wrapping)
  │                               │
  │                               └──▶ E-006 (Workflow prompt assembler — full pipeline)
  │
  ├──▶ E-007 [P] (Persona switching on workflow start)
  │       │
  │       └──▶ E-008 (Persona revert on workflow end)
  │
  ├──▶ E-009 [P] ("Notor: Run workflow" command palette entry)
  │
  └──▶ E-010 [P] (WorkflowSlashSuggest — autocomplete class)
          │
          └──▶ E-011 (WorkflowChipManager — chip rendering)
                  │
                  └──▶ E-012 (Slash-command integration in chat-view.ts)

E-006 + E-008 + E-009 ──▶ E-013 (Workflow conversation creation)
                                │
                                └──▶ E-014 (<details> rendering for workflow messages)

E-012 + E-014 ──▶ E-015 (main.ts wiring — connect all components)
                        │
                        └──▶ E-016 (End-to-end validation & cleanup)
```

---

## Phase 0: Types & Interfaces

### E-001: Define workflow execution types and extend settings/message interfaces

**Description:** Add the types needed for workflow execution, conversation metadata extensions, and message assembly extensions. These types support the workflow prompt assembly pipeline, conversation creation, and UI rendering for Group E. Types that were already defined by Group C (`Workflow`, `WorkflowTrigger`, etc.) are reused — this task adds only execution-specific and conversation-specific types.

**Files:**
- `src/types.ts` — Add `WorkflowExecutionRequest`, `WorkflowAssemblyResult`, `TriggerContext` types; extend `Conversation` with `workflow_path`, `workflow_name`, `persona_name`, `is_background`; extend `Message` with `is_workflow_message`
- `src/context/message-assembler.ts` — Extend `MessageParts` with optional `triggerContext` and `workflowInstructions` fields

**Dependencies:** None (Group C's `Workflow` types assumed available)

**Acceptance Criteria:**
- [x] `WorkflowExecutionRequest` interface defined: `workflow` (Workflow), `supplementaryText` (string | null), `triggerContext` (TriggerContext | null)
- [x] `WorkflowAssemblyResult` interface defined: `assembledMessage` (string — the full user message text), `workflowName` (string — display name for UI), `attachments` (array from `<include_note mode="attached">` resolution)
- [x] `TriggerContext` interface defined per data-model.md: `event` (string), `note_path` (string | null), `tags_added` (string[] | null), `tags_removed` (string[] | null)
- [x] `Conversation` interface extended with optional fields: `workflow_path` (string | null), `workflow_name` (string | null), `persona_name` (string | null), `is_background` (boolean)
- [x] `Message` interface extended with optional field: `is_workflow_message` (boolean)
- [x] `MessageParts` interface extended with optional fields: `triggerContext` (string — pre-formatted XML block), `workflowInstructions` (string — pre-wrapped `<workflow_instructions>` block)
- [x] All types exported from `src/types.ts`
- [x] TypeScript compiles cleanly with `npm run build`

---

## Phase 1: Prompt Assembly Pipeline

### E-002: Workflow body reader — read and strip frontmatter

**Description:** Implement the function that reads a workflow note's full content from the vault and strips its YAML frontmatter to produce the raw body content (the workflow instructions). This is step 1 of the workflow prompt assembly pipeline defined in the [workflow-assembly contract](../contracts/workflow-assembly.md).

**Files:**
- `src/workflows/workflow-executor.ts` — New file; add `readWorkflowBody()` function

**Dependencies:** E-001

**Acceptance Criteria:**
- [x] `readWorkflowBody(file: TFile, vault: Vault): Promise<string>` function exported
- [x] Reads the full note content via `vault.read(file)`
- [x] Strips YAML frontmatter using Obsidian's `getFrontMatterInfo(content)` utility: returns `content.slice(fmInfo.contentStart)`
- [x] If the note has no frontmatter (no leading `---`), returns the full content as-is
- [x] Returns the body content string (may be empty — emptiness is checked in E-004)
- [x] Handles read errors gracefully — throws a descriptive error that callers can catch

### E-003: `<include_note>` resolution in workflow bodies

**Description:** Wire Group D's `resolveIncludeNotes()` function into the workflow prompt assembly pipeline. After the body is read (E-002), all `<include_note ... />` tags in the body are resolved. Both `inline` and `attached` modes are supported in the workflow context (unlike system prompts where only `inline` is supported). This is step 2 of the pipeline.

**Files:**
- `src/workflows/workflow-executor.ts` — Add `resolveWorkflowIncludes()` function

**Dependencies:** E-002, Group D (D-008 — `resolveIncludeNotes()` function available)

**Acceptance Criteria:**
- [x] `resolveWorkflowIncludes(body: string, vault: Vault, metadataCache: MetadataCache, workflowFilePath: string): Promise<IncludeNoteResolutionResult>` function exported
- [x] Calls `resolveIncludeNotes(body, vault, metadataCache, workflowFilePath, "workflow")` from Group D's resolver module
- [x] Passes `"workflow"` as the context parameter so both `inline` and `attached` modes are supported
- [x] The `workflowFilePath` (the workflow note's own vault-relative path) is passed as `sourceFilePath` for wikilink disambiguation
- [x] Returns the `IncludeNoteResolutionResult` containing `inlineContent` (body with inline tags resolved, attached tags removed) and `attachments` (collected attached-mode entries)
- [x] Resolution errors in individual tags produce inline error markers (handled by Group D) — this function does not abort on partial failures
- [x] Nested `<include_note>` tags in resolved content are passed through as literal text (single-pass, handled by Group D)

### E-004: Empty workflow guard

**Description:** Implement the validation check that aborts workflow execution if the workflow body is empty after frontmatter stripping and `<include_note>` resolution. This is step 3 of the pipeline.

**Files:**
- `src/workflows/workflow-executor.ts` — Add `validateWorkflowContent()` function

**Dependencies:** E-003

**Acceptance Criteria:**
- [x] `validateWorkflowContent(resolvedBody: string): boolean` function exported
- [x] Returns `false` if `resolvedBody.trim().length === 0` (body is empty or whitespace-only)
- [x] Returns `true` if the body has non-whitespace content
- [x] When the guard fails (returns `false`), the caller aborts execution and surfaces `new Notice("Workflow has no prompt content.")` per FR-44
- [x] Body consisting entirely of error markers (e.g., `[include_note error: ...]`) is considered non-empty and passes the guard — the LLM receives the error markers and can inform the user

### E-005: `<workflow_instructions>` XML wrapping

**Description:** Implement the function that wraps the resolved workflow body content in a `<workflow_instructions>` XML tag per the assembly contract. This is step 4 of the pipeline.

**Files:**
- `src/workflows/workflow-executor.ts` — Add `wrapWorkflowInstructions()` function

**Dependencies:** E-004

**Acceptance Criteria:**
- [x] `wrapWorkflowInstructions(resolvedBody: string, workflowFileName: string): string` function exported
- [x] Produces the format:
  ```xml
  <workflow_instructions type="{workflowFileName}">
  {resolvedBody}
  </workflow_instructions>
  ```
- [x] The `type` attribute contains the workflow note's **file name** only (e.g., `daily-review.md`), not the full vault-relative path
- [x] Opening tag, content, and closing tag are on separate lines per the contract
- [x] No additional whitespace is inserted around the content
- [x] The resolved body content is included as-is (including any inline error markers from `<include_note>` resolution)

### E-006: Workflow prompt assembler — full pipeline orchestration

**Description:** Implement the top-level `assembleWorkflowPrompt()` function that orchestrates the full pipeline: read body → resolve includes → validate non-empty → wrap in XML → build trigger context (if event-triggered) → compose final message via `assembleUserMessage()`. This is the primary public API of the workflow executor module, combining steps 1–7 of the assembly contract.

**Files:**
- `src/workflows/workflow-executor.ts` — Add `assembleWorkflowPrompt()` orchestrator function
- `src/context/message-assembler.ts` — Extend `assembleUserMessage()` to handle `triggerContext` and `workflowInstructions` fields

**Dependencies:** E-005

**Acceptance Criteria:**
- [x] `assembleWorkflowPrompt(request: WorkflowExecutionRequest, vault: Vault, metadataCache: MetadataCache): Promise<WorkflowAssemblyResult | null>` function exported
- [x] Returns `null` when the empty guard fails (caller surfaces the notice)
- [x] Pipeline steps executed in order: (1) `readWorkflowBody()`, (2) `resolveWorkflowIncludes()`, (3) `validateWorkflowContent()`, (4) `wrapWorkflowInstructions()`, (5) build trigger context XML (if `request.triggerContext` is non-null), (6) compose final message
- [x] **Trigger context formatting:** When `request.triggerContext` is non-null, formats the `<trigger_context>` XML block per the contract:
  ```xml
  <trigger_context>
  event: {event}
  note_path: {note_path}
  </trigger_context>
  ```
  For `on-tag-change` events, includes `tags_added` and `tags_removed` fields (comma-separated). For `scheduled` events, includes only `event` (no note path). For manual triggers, `triggerContext` is null and no block is prepended.
- [x] **Message assembly:** Extends `assembleUserMessage()` to support the Phase 4 message ordering:
  1. `<trigger_context>` block (event-triggered only)
  2. `<attachments>` block (from `<include_note mode="attached">` entries, if any)
  3. `<workflow_instructions>` wrapped block
  4. User's supplementary text (from `request.supplementaryText`, if non-null)
- [x] The `assembleUserMessage()` function is updated to accept the new optional `MessageParts` fields (`triggerContext`, `workflowInstructions`) and insert them in the correct order
- [x] For non-workflow messages (when `workflowInstructions` is undefined), `assembleUserMessage()` behavior is unchanged — backward-compatible
- [x] Collected `attachments` from attached-mode `<include_note>` tags are formatted into an `<attachments>` block using the same `<vault-note>` format established in Phase 2 (reuses `buildAttachmentsBlock()` or equivalent from `src/context/attachment.ts`)
- [x] Returns `WorkflowAssemblyResult` with `assembledMessage`, `workflowName` (the workflow's `display_name`), and `attachments` array

---

## Phase 2: Command Palette & Persona Switching

### E-007 [P]: Persona switching on workflow start

**Description:** Implement the logic that activates a workflow's designated persona before execution begins. When a workflow note includes `notor-workflow-persona` in frontmatter, the named persona is activated — applying its system prompt, provider/model preferences, and auto-approve overrides. The previous persona state is saved for later revert (E-008). This integrates with Group A's `PersonaManager.savePersonaState()` / `activatePersona()` methods.

**Files:**
- `src/workflows/workflow-executor.ts` — Add `switchWorkflowPersona()` function

**Dependencies:** E-001, Group A (A-005 — `PersonaManager` with `savePersonaState()`, `activatePersona()`)

**Acceptance Criteria:**
- [x] `switchWorkflowPersona(personaName: string | null, personaManager: PersonaManager): Promise<{ switched: boolean; previousPersona: string | null }>` function exported
- [x] If `personaName` is null or empty → returns `{ switched: false, previousPersona: null }` (no switch needed)
- [x] If `personaName` is non-empty: calls `personaManager.savePersonaState()` to record the current active persona, then calls `personaManager.activatePersona(personaName)`
- [x] If `activatePersona()` returns `true` (persona found and activated): surfaces `new Notice("Persona '{name}' activated for workflow.")` and returns `{ switched: true, previousPersona: savedState }`
- [x] If `activatePersona()` returns `false` (persona not found): surfaces `new Notice("Persona '{name}' not found; running with current settings.")` and returns `{ switched: false, previousPersona: null }` — does NOT abort workflow execution
- [x] The persona switch applies the persona's system prompt, provider, model, and auto-approve overrides (handled internally by `PersonaManager.activatePersona()`)

### E-008: Persona revert on workflow end

**Description:** Implement the logic that reverts the persona to the saved state when the user leaves a workflow conversation. Per FR-43, the persona switch persists for the entire workflow conversation — it reverts only when the user switches to a different conversation or starts a new one. The revert must happen regardless of whether the workflow succeeded, failed, or was stopped.

**Files:**
- `src/workflows/workflow-executor.ts` — Add `revertWorkflowPersona()` function
- `src/chat/orchestrator.ts` — Wire persona revert on conversation switch

**Dependencies:** E-007

**Acceptance Criteria:**
- [x] `revertWorkflowPersona(previousPersona: string | null, personaManager: PersonaManager): Promise<void>` function exported
- [x] If `previousPersona` is non-null: calls `personaManager.activatePersona(previousPersona)` to restore the previous persona
- [x] If `previousPersona` is null: calls `personaManager.deactivatePersona()` to revert to global defaults (no persona was active before the workflow)
- [x] The revert triggers are wired in `ChatOrchestrator`:
  - When the user switches to a different conversation (via `switchConversation()`)
  - When the user starts a new conversation (via `newConversation()`)
  - When the user explicitly changes the persona via the picker (already handled by `PersonaManager`)
- [x] The orchestrator tracks whether the current conversation is a workflow conversation and stores the `previousPersona` value from `switchWorkflowPersona()` (via `setWorkflowPersonaRevert()`)
- [x] Persona revert occurs regardless of workflow outcome (success, failure, user stop)
- [x] If the revert target persona is no longer available (deleted while workflow was running), the persona reverts to global defaults silently

### E-009 [P]: "Notor: Run workflow" command palette entry

**Description:** Register the Obsidian command palette entry "Notor: Run workflow" that opens a quick-pick list of all discovered workflows, allowing the user to select and execute one. This is one of the two manual workflow trigger mechanisms (the other being slash-command in E-010–E-012).

**Files:**
- `src/workflows/workflow-executor.ts` — Add `showWorkflowPicker()` function
- `src/main.ts` — Register the command via `this.addCommand()`

**Dependencies:** E-001, Group C (C-008 — `getDiscoveredWorkflows()` and `rescanWorkflows()` available)

**Acceptance Criteria:**
- [x] Command registered with `id: "run-workflow"` and `name: "Run workflow"` via `this.addCommand()` in `main.ts`
- [x] When triggered, calls `rescanWorkflows()` to refresh the workflow list (ensuring newly created/deleted workflows are reflected without plugin reload per FR-41)
- [x] Opens an Obsidian `FuzzySuggestModal` (or equivalent quick-pick) listing all discovered workflows by `display_name`
- [x] All discovered workflows are listed regardless of `notor-trigger` type — manual, on-save, scheduled, etc. can all be run manually per FR-42 ("the trigger type does not restrict manual execution")
- [x] Each list entry shows the workflow `display_name` (e.g., `daily/review`, `auto-tag`)
- [ ] When the user selects a workflow, the execution flow proceeds to conversation creation (E-013): assemble prompt, switch persona (if configured), create conversation, send to LLM — *wired in E-013*
- [x] If no workflows are discovered, the picker shows an empty list with an informational message (e.g., "No workflows found in {notor_dir}/workflows/")
- [x] The command is available even when the chat panel is closed — selecting a workflow opens the panel automatically

---

## Phase 3: Slash-Command UX

### E-010 [P]: WorkflowSlashSuggest — autocomplete class

**Description:** Implement the `WorkflowSlashSuggest` class that extends `AbstractInputSuggest<T>` to provide `/`-triggered autocomplete for workflows in the chat input area. This mirrors the existing `VaultNoteSuggest` pattern (used for `[[` autocomplete) on the same contenteditable div. Informed by R-4 research findings in [research.md](../research.md) § R-4.

**Files:**
- `src/ui/workflow-suggest.ts` — New file; add `WorkflowSlashSuggest` class, `WorkflowSuggestion` interface, `detectSlashTrigger()` function

**Dependencies:** E-001 (types only — no dependency on the prompt assembly pipeline)

**Acceptance Criteria:**
- [ ] `WorkflowSuggestion` interface defined: `workflow` (Workflow), `match` (FuzzyMatch or similar)
- [ ] `WorkflowSlashSuggest` class extends `AbstractInputSuggest<WorkflowSuggestion>`
- [ ] Constructor accepts `app: App`, `textInputEl: HTMLDivElement`, and `getWorkflows: () => Workflow[]` callback
- [ ] `getSuggestions(inputStr: string)` implementation:
  - Calls `detectSlashTrigger(inputStr)` to determine if `/` is at a valid trigger position
  - If no valid trigger → returns empty array (popup stays closed)
  - If valid trigger → extracts query text after `/`, filters workflows by `display_name` using `prepareFuzzySearch` (from Obsidian API), returns matching `WorkflowSuggestion[]`
  - When `isActive` flag on the coexisting `VaultNoteSuggest` is true → returns empty array (prevents interference)
- [ ] `detectSlashTrigger(text: string): number | null` function exported:
  - Returns the index of `/` if it's at position 0 OR preceded by `\n`
  - Returns `null` otherwise (e.g., `/` in the middle of text, in a URL, in a path)
  - Additional guard: if the query text after `/` contains another `/`, returns `null` (excludes file paths like `/path/to/file`)
- [ ] `renderSuggestion(suggestion, el)` renders each workflow entry with `📋` icon prefix and `display_name` text
- [ ] `selectSuggestion(suggestion)` calls the `onSelect` callback (wired in E-012) with the selected workflow, then calls `deactivate()`
- [ ] `activate(triggerStartIndex)` / `deactivate()` methods manage an `isActive` flag — when active, the `VaultNoteSuggest` returns empty suggestions and vice versa
- [ ] Uses Obsidian's `prepareFuzzySearch` for fuzzy matching workflow names (same utility used by `VaultNoteSuggest`)
- [ ] Popup dismisses on Escape, click outside (handled by `PopoverSuggest` base class), trigger deletion, or newline in query

### E-011: WorkflowChipManager — chip rendering

**Description:** Implement the `WorkflowChipManager` class that renders a workflow chip (pill-shaped tag) in the existing `notor-attachment-chips` container above the chat input. At most one workflow chip is displayed per message. The chip uses a distinct visual style (📋 icon, purple-tinted background) to differentiate from attachment chips.

**Files:**
- `src/ui/workflow-suggest.ts` — Add `WorkflowChipManager` class
- `styles.css` — Add `.notor-workflow-chip` styling

**Dependencies:** E-010

**Acceptance Criteria:**
- [ ] `WorkflowChipManager` class created with constructor accepting `containerEl: HTMLElement` (the existing `notor-attachment-chips` container) and `onRemove: () => void` callback
- [ ] `setChip(workflow: Workflow): void` — renders a workflow chip in the container; replaces any existing workflow chip (enforces "at most one workflow per message" per FR-42)
- [ ] `removeChip(): void` — removes the current workflow chip from the container and clears internal state
- [ ] `getSelectedWorkflow(): Workflow | null` — returns the currently attached workflow or null
- [ ] `clear(): void` — removes the chip and resets state (called after message send)
- [ ] Chip HTML structure:
  ```html
  <div class="notor-attachment-chip notor-workflow-chip" data-workflow-path="{file_path}">
    <span class="notor-attachment-chip-icon">📋</span>
    <span class="notor-attachment-chip-label">{display_name}</span>
    <span class="notor-attachment-chip-remove">×</span>
  </div>
  ```
- [ ] Clicking the `×` button calls `removeChip()` and triggers the `onRemove` callback
- [ ] CSS styling in `styles.css`: `.notor-workflow-chip` has a purple-tinted border/background (distinct from attachment chips) using Obsidian CSS custom properties for theme compatibility (e.g., `var(--interactive-accent)` with reduced opacity)
- [ ] Chip is visually consistent with existing attachment chips but clearly distinguishable

### E-012: Slash-command integration in chat-view.ts

**Description:** Wire `WorkflowSlashSuggest` and `WorkflowChipManager` into the existing `NotorChatView`. Connect the `/` trigger detection to the input event handler, wire the selection callback to chip insertion, and update `handleSend()` to capture the attached workflow and pass it to the execution pipeline.

**Files:**
- `src/ui/chat-view.ts` — Add `WorkflowSlashSuggest` and `WorkflowChipManager` instances; wire into input events, send handler, and backspace handler

**Dependencies:** E-011

**Acceptance Criteria:**
- [ ] `NotorChatView` gains private fields: `workflowSuggest: WorkflowSlashSuggest`, `workflowChipManager: WorkflowChipManager`, `pendingWorkflow: Workflow | null`
- [ ] In `buildInputArea()`: create `WorkflowSlashSuggest` instance on the same `textInputEl` used by `VaultNoteSuggest`; create `WorkflowChipManager` targeting the existing `attachmentChipContainerEl`
- [ ] **Input event handler** (existing `input` listener on `textInputEl`): alongside the existing `detectWikilinkTrigger()` call, add a call to detect slash trigger. When slash trigger is detected and `VaultNoteSuggest.isActive` is false, activate `WorkflowSlashSuggest`. When no slash trigger, deactivate it.
- [ ] **Selection callback:** When a workflow is selected from the suggest popup, call `workflowChipManager.setChip(workflow)` and set `this.pendingWorkflow = workflow`. Clear the `/query` text from the input.
- [ ] **Send handler** (`handleSend()`): capture `this.pendingWorkflow`, clear it and call `workflowChipManager.clear()`. If a workflow is attached, the send handler passes both the user's typed text (supplementary text) and the workflow to the execution pipeline instead of treating it as a normal user message.
- [ ] **Backspace handler:** Add a `keydown` listener — when Backspace is pressed and the text input is empty and a workflow chip is present, remove the workflow chip (same pattern as attachment chip backspace removal)
- [ ] **Coexistence with VaultNoteSuggest:** The `isActive` flag pattern ensures only one suggest popup is active at a time. When `WorkflowSlashSuggest` is active, `VaultNoteSuggest.getSuggestions()` returns `[]` and vice versa.
- [ ] `setGetWorkflows(callback: () => Workflow[]): void` setter on `NotorChatView` — wired by the orchestrator to provide the workflow discovery results to the suggest popup
- [ ] After sending a message with a workflow, the chip is cleared and the input returns to normal text-only mode

---

## Phase 4: Conversation Creation & UI Rendering

### E-013: Workflow conversation creation and execution flow

**Description:** Implement the orchestration logic that creates a new conversation for a workflow execution, sends the assembled prompt as the first user message, and manages the full execution lifecycle. This is the convergence point where prompt assembly (E-006), persona switching (E-007/E-008), and trigger mechanisms (E-009, E-012) come together. Both command palette and slash-command triggers flow through this single execution path.

**Files:**
- `src/chat/orchestrator.ts` — Add `executeWorkflow()` method to `ChatOrchestrator`
- `src/chat/conversation.ts` — Extend `createConversation()` to accept workflow metadata fields
- `src/chat/history.ts` — Extend JSONL conversation header with workflow fields

**Dependencies:** E-006, E-008, E-009

**Acceptance Criteria:**
- [ ] `ChatOrchestrator.executeWorkflow(workflow: Workflow, supplementaryText?: string): Promise<void>` method added
- [ ] Execution flow sequence:
  1. Resolve the workflow's `TFile` from `workflow.file_path` via `vault.getAbstractFileByPath()`
  2. Call `switchWorkflowPersona()` if `workflow.persona_name` is set (E-007)
  3. Call `assembleWorkflowPrompt()` to build the complete user message (E-006)
  4. If assembly returns `null` (empty guard), surface notice and abort — revert persona if switched
  5. Create a new conversation via `ConversationManager.createConversation()` with workflow metadata: `workflow_path`, `workflow_name`, `persona_name` (active persona after switch), `is_background: false`, `title: "Workflow: {display_name}"`
  6. Open the chat panel if not already open (via `app.workspace.revealLeaf()` or equivalent)
  7. Store the `previousPersona` from step 2 on the orchestrator for later revert (E-008)
  8. Add the assembled message as the first user message with `is_workflow_message: true`
  9. Dispatch the message to the LLM via the existing `responseLoop()` — the AI responds normally with streaming, tool calls, etc.
- [ ] `ConversationManager.createConversation()` extended to accept optional `workflow_path`, `workflow_name`, `persona_name`, `is_background` fields, stored in the `Conversation` object
- [ ] `HistoryManager.createConversationFile()` extended to write the workflow metadata fields into the JSONL conversation header (for persistence and reload)
- [ ] The user can interact with the workflow conversation normally after the first response — sending follow-up messages, approving/rejecting tool calls, stopping the response
- [ ] If the workflow file cannot be found (e.g., deleted between discovery and execution), a notice is surfaced and execution aborts gracefully
- [ ] Error handling: if `assembleWorkflowPrompt()` throws (e.g., vault read error), catch the error, surface a notice ("Workflow execution failed: {error}"), and revert persona if switched

### E-014: `<details>` rendering for `<workflow_instructions>` in chat UI

**Description:** When a message containing `<workflow_instructions>` content is rendered in the chat panel, the workflow block is displayed as a collapsed-by-default `<details>` HTML element so it doesn't dominate the chat view. The user can expand it to inspect the full instructions. Any supplementary user text after the closing tag is rendered normally outside the `<details>` element.

**Files:**
- `src/ui/chat-view.ts` — Extend `renderUserMessage()` to detect and render `<workflow_instructions>` blocks
- `styles.css` — Add styling for the workflow details element

**Dependencies:** E-013

**Acceptance Criteria:**
- [ ] `renderUserMessage()` detects `<workflow_instructions type="...">` blocks in user message content using a regex: `/<workflow_instructions\s+type="([^"]*)">([\s\S]*?)<\/workflow_instructions>/`
- [ ] When detected, the block is rendered as:
  ```html
  <details class="notor-workflow-details">
    <summary>Workflow: {type-attribute-value}</summary>
    <div class="notor-workflow-content">{workflow body content}</div>
  </details>
  ```
- [ ] The `<details>` element is **collapsed by default** (no `open` attribute) so the workflow instructions are hidden initially
- [ ] The summary label shows "Workflow: {workflow-name}" extracted from the `type` attribute (e.g., "Workflow: daily-review.md")
- [ ] Text after the closing `</workflow_instructions>` tag (supplementary user text from slash-command) is rendered **outside** the `<details>` element as normal paragraph text
- [ ] Text before the opening `<workflow_instructions>` tag (e.g., `<trigger_context>` block for event-triggered workflows — future Group F use) is rendered as preformatted context or hidden (per future design; for now, any preceding text is rendered normally)
- [ ] CSS styling: `.notor-workflow-details` has subtle background color, border, and rounded corners. `.notor-workflow-details summary` has cursor pointer and appropriate spacing. Content within uses monospace or the standard note font.
- [ ] Messages without `<workflow_instructions>` are rendered unchanged — backward-compatible
- [ ] The `<workflow_instructions>` content inside the details is rendered as plain text (not parsed as Markdown) to preserve the original workflow structure

---

## Phase 5: Wiring & Validation

### E-015: Main plugin wiring — connect all workflow execution components

**Description:** Wire the workflow executor, persona switching, command palette, slash-command UX, and conversation creation together in `main.ts` and `orchestrator.ts`. This is the integration task that connects all Group E components into a functional end-to-end workflow execution system.

**Files:**
- `src/main.ts` — Register "Notor: Run workflow" command, wire workflow discovery to chat view, connect `executeWorkflow` callback
- `src/chat/orchestrator.ts` — Wire `executeWorkflow()` to handle both command palette and slash-command triggers; wire persona revert on conversation switch; pass workflow discovery to chat view

**Dependencies:** E-012, E-014

**Acceptance Criteria:**
- [ ] **Command registration:** "Notor: Run workflow" command is registered in `main.ts` `onload()` with `id: "run-workflow"`, calling `orchestrator.showWorkflowPicker()` (or the equivalent picker function from E-009)
- [ ] **Chat view wiring:** `orchestrator` calls `view.setGetWorkflows(() => plugin.getDiscoveredWorkflows())` to provide workflow data to the slash-command suggest popup
- [ ] **Send handler integration:** `orchestrator.handleUserMessage()` is extended to detect when a workflow is attached (passed from the chat view's send handler). When present, routes to `executeWorkflow()` instead of the normal message path.
- [ ] **Persona revert wiring:** `orchestrator.newConversation()` and `orchestrator.switchConversation()` check if the current conversation is a workflow conversation with a persona switch, and call `revertWorkflowPersona()` if so
- [ ] **Conversation reload:** When reloading a saved workflow conversation from history (via `switchConversation()`), the workflow metadata (`workflow_path`, `workflow_name`, `persona_name`) is restored from the JSONL header. The `<workflow_instructions>` block in the first message renders as a collapsed `<details>` element.
- [ ] **Panel auto-open:** When `executeWorkflow()` is called and the chat panel is not open, the panel is revealed via `app.workspace.revealLeaf()` before the conversation begins
- [ ] On plugin unload, no stale references from the workflow executor remain
- [ ] Existing non-workflow conversations and message flows are completely unaffected — backward-compatible
- [ ] Build succeeds: `npm run build` produces clean `main.js`
- [ ] No TypeScript errors: `npx tsc --noEmit` passes

### E-016: Playwright E2E validation and cleanup

**Description:** Comprehensive Playwright-based E2E validation of the complete Group E workflow execution system following the user scenarios from spec.md. Create a dedicated E2E test script (`e2e/scripts/workflow-execution-test.ts`) that launches Obsidian via CDP, exercises command palette execution, slash-command execution, persona switching/revert, `<include_note>` resolution, `<details>` rendering, conversation persistence, and all edge cases. Verification is performed via DOM assertions and structured log analysis.

**Files:**
- `e2e/scripts/workflow-execution-test.ts` — New Playwright E2E test script
- All files from E-001 through E-015 (review and polish)

**Dependencies:** E-015

**Acceptance Criteria:**
- [ ] **E2E test script created:** `e2e/scripts/workflow-execution-test.ts` follows the established pattern (build → launch Obsidian → connect Playwright via CDP → `LogCollector` → DOM assertions → structured log verification → screenshots → results JSON)
- [ ] **Primary flow — command palette (E2E):** Test triggers "Notor: Run workflow" command → interacts with `FuzzySuggestModal` to select a workflow → verifies chat panel opens (`.notor-chat-container` visible) → verifies persona label updates if configured → verifies `<details class="notor-workflow-details">` element rendered collapsed in first message → verifies structured logs confirm workflow prompt assembly and LLM dispatch
- [ ] **Primary flow — slash-command (E2E):** Test types `/` in chat input element → verifies autocomplete popup appears with workflow entries → selects a workflow → verifies `.notor-workflow-chip` element appears in chip container → types supplementary text → sends message → verifies chip cleared after send → structured logs confirm workflow execution with supplementary text
- [ ] **`<include_note>` resolution validated (E2E):** Structured logs confirm `<include_note>` tags in workflow body resolved at execution time; IncludeNoteResolver logs show successful resolution; section extraction and error markers verified via log data fields
- [ ] **Attached mode validated (E2E):** Structured logs confirm attached-mode `<include_note>` tags produce `<attachments>` block entries in assembled message
- [ ] **Persona switching validated (E2E):** Structured logs from PersonaManager confirm persona activation on workflow start; `.notor-persona-label` DOM element updates; structured logs confirm persona deactivation on conversation switch
- [ ] **Missing persona validated (E2E):** Test triggers workflow with non-existent persona → structured logs confirm fallback behavior; no error-level logs; execution completes normally
- [ ] **Empty workflow validated (E2E):** Test triggers workflow with empty body → structured logs confirm execution aborted; no conversation created; Notice surfaced
- [ ] **`<details>` rendering validated (E2E):** DOM assertion confirms `.notor-workflow-details` element exists without `open` attribute (collapsed by default) → test clicks `<summary>` → verifies element now has `open` attribute → supplementary text visible outside the `<details>` element
- [ ] **Slash-command edge cases validated (E2E):** Test types `/` in middle of text → verifies no popup; types `/` at start → verifies popup appears; presses Escape → verifies popup dismissed; clicks chip `×` button → verifies chip removed; backspace with empty input and chip present → verifies chip removed
- [ ] **Coexistence with `[[` autocomplete validated (E2E):** Test types `[[` → verifies vault note suggest active; types `/` at start → verifies workflow suggest active (not vault note suggest); both cannot be active simultaneously per DOM assertions
- [ ] **Conversation persistence validated (E2E):** Test creates workflow conversation → navigates away → navigates back → verifies first message still renders `<details>` element with workflow instructions → structured logs confirm conversation reload with workflow metadata
- [ ] **Workflow not found at execution time (E2E):** Test deletes a workflow file after discovery → triggers execution → verifies structured logs show error; no crash; Notice surfaced
- [ ] Build succeeds: `npm run build` produces clean `main.js`
- [ ] No TypeScript errors: `npx tsc --noEmit` passes
- [ ] No workflow/execution-related error-level structured logs during normal test flows (filtered via `LogCollector.getLogsByLevel("error")`)

---

## Cross-Reference: Files Created and Modified

### New Files
| File | Tasks | Description |
|---|---|---|
| `src/workflows/workflow-executor.ts` | E-002, E-003, E-004, E-005, E-006, E-007, E-008, E-009 | Workflow body reading, `<include_note>` wiring, empty guard, XML wrapping, full pipeline assembler, persona switch/revert, workflow picker |
| `src/ui/workflow-suggest.ts` | E-010, E-011 | `WorkflowSlashSuggest` autocomplete class, `WorkflowChipManager` chip rendering, `detectSlashTrigger()` |

### Modified Files
| File | Tasks | Changes |
|---|---|---|
| `src/types.ts` | E-001 | Add `WorkflowExecutionRequest`, `WorkflowAssemblyResult`, `TriggerContext`; extend `Conversation` and `Message` with workflow fields |
| `src/context/message-assembler.ts` | E-001, E-006 | Extend `MessageParts` with `triggerContext` and `workflowInstructions`; update `assembleUserMessage()` assembly order for Phase 4 |
| `src/chat/orchestrator.ts` | E-008, E-013, E-015 | Add `executeWorkflow()` method; wire persona revert on conversation switch; route workflow-attached messages |
| `src/chat/conversation.ts` | E-013 | Extend `createConversation()` to accept workflow metadata fields |
| `src/chat/history.ts` | E-013 | Extend JSONL conversation header with workflow fields for persistence |
| `src/ui/chat-view.ts` | E-012, E-014 | Add `WorkflowSlashSuggest` and `WorkflowChipManager` instances; wire input/send/backspace handlers; add `<details>` rendering for `<workflow_instructions>` blocks; add `setGetWorkflows()` setter |
| `styles.css` | E-011, E-014 | Add `.notor-workflow-chip` styling; add `.notor-workflow-details` styling |
| `src/main.ts` | E-009, E-015 | Register "Notor: Run workflow" command; wire workflow discovery to chat view; connect `executeWorkflow` callback |

### E2E Test Files
| File | Tasks | Description |
|---|---|---|
| `e2e/scripts/workflow-execution-test.ts` | E-016 | Playwright E2E test: command palette execution, slash-command UX, persona switching, `<details>` rendering, conversation persistence |

---

## Parallel Execution Opportunities

The following task groups can be executed in parallel:

1. **After E-001 completes:** E-002 (body reader), E-007 (persona switch), E-009 (command palette), and E-010 (slash suggest) can all proceed simultaneously since they have no mutual dependencies — they operate on independent subsystems (prompt assembly, persona management, command registration, UI component)
2. **After E-010 completes:** E-011 (chip manager) can proceed in parallel with the ongoing prompt assembly chain (E-003 → E-004 → E-005 → E-006)
3. **After E-006 + E-008 + E-009 complete:** E-013 (conversation creation) can begin immediately while E-011 → E-012 (slash-command wiring) proceed in parallel
4. **After E-013 completes:** E-014 (`<details>` rendering) can proceed in parallel with finalizing E-012 (if not already complete)

## Critical Path

```
E-001 → E-002 → E-003 → E-004 → E-005 → E-006 → E-013 → E-014 → E-015 → E-016
```

The longest dependency chain runs through types → body reader → include resolution → empty guard → XML wrapping → full pipeline assembler → conversation creation → details rendering → wiring → validation. Persona switching (E-007 → E-008), command palette (E-009), and slash-command UX (E-010 → E-011 → E-012) can all be developed in parallel with this main chain.

---

## Integration Points with Other Groups

Group E consumes outputs from Groups A, C, and D, and provides the workflow execution foundation for Groups F and H:

### Upstream Dependencies

- **Group A (Persona System):** E-007 and E-008 depend on `PersonaManager` from A-005 — specifically `savePersonaState()`, `activatePersona()`, and `deactivatePersona()` methods. The persona label in the chat panel (A-010) automatically updates when the workflow switches personas.
- **Group C (Workflow Discovery):** E-009 depends on `getDiscoveredWorkflows()` and `rescanWorkflows()` from C-008. The slash-command suggest (E-010) uses the same discovery results via a callback. Workflow `body_content` is read lazily by E-002 at execution time (not during discovery).
- **Group D (`<include_note>` Tag):** E-003 depends on `resolveIncludeNotes()` from D-008. The function is called with context `"workflow"` to enable both inline and attached modes. Group D's integration into system prompts and vault rules (D-010) is separate and independent.

### Downstream Consumers

- **Group F (Vault Event Hooks):** Group F reuses the workflow execution pipeline established by Group E — specifically `assembleWorkflowPrompt()` (E-006) and the conversation creation flow (E-013) — for event-triggered background workflow execution. Group F adds `TriggerContext` population, background execution (no chat panel takeover), concurrency management, and the `WorkflowExecution` state tracker. The `triggerContext` field in `MessageParts` (E-001) and the `<trigger_context>` formatting in `assembleWorkflowPrompt()` (E-006) are designed for Group F's use — manual workflows pass `null` for trigger context.
- **Group H (Workflow Activity Indicator):** Group H tracks workflow executions for its activity indicator UI. It depends on the conversation creation metadata (`workflow_path`, `workflow_name`, `is_background`) established in E-013. Manual (foreground) workflows from Group E do NOT appear in the activity indicator per FR-53 — only background event-triggered workflows from Group F do.

---

## Design Decisions

1. **Single `workflow-executor.ts` module:** All prompt assembly, persona switching, and picker logic lives in one module (`src/workflows/workflow-executor.ts`) rather than being split across multiple files. The module is cohesive (all functions operate on the workflow execution pipeline) and stays within the ~200-300 line guideline. If it grows beyond that during implementation, the trigger context formatting and persona switch/revert functions are natural candidates for extraction.

2. **`assembleUserMessage()` extension over new function:** Rather than creating a separate `assembleWorkflowMessage()` function, the existing `assembleUserMessage()` is extended with optional `triggerContext` and `workflowInstructions` fields. This ensures all message assembly flows through one path, simplifying the codebase and ensuring consistent behavior (e.g., `<attachments>` block handling). When the new fields are absent, behavior is identical to Phase 3 — fully backward-compatible.

3. **Lazy body reading at execution time:** Group C's discovery (C-002/C-003) intentionally sets `body_content` to an empty string during scanning (frontmatter-only reads for performance per NFR-10). Group E reads the full body via `vault.read()` only when a workflow is actually executed (E-002). This ensures workflow discovery stays fast (<500 ms for 200 workflows) while execution always reads the latest content.

4. **External chip container over inline DOM:** Per R-4 research, workflow chips render in the existing `notor-attachment-chips` container above the text input, not as inline DOM elements in the contenteditable div. The contenteditable uses `plaintext-only` mode which strips HTML elements, making inline chips impossible without breaking the input. The external container approach is proven (attachment chips use it) and provides clean state management.

5. **Persona revert on conversation switch (not on LLM response completion):** Per FR-43 clarification, the persona persists for the entire workflow conversation — not just the first response turn. This supports multi-turn workflows where the persona context matters throughout. The revert triggers are conversation-level events (switch, new) rather than message-level events.

6. **`TriggerContext` built into the assembler (not deferred to Group F):** The trigger context formatting and `<trigger_context>` XML generation are implemented in E-006 even though manual workflows always pass `null`. This avoids Group F needing to modify the assembly pipeline — it simply provides a non-null `TriggerContext` object and the existing pipeline handles it. This clean interface boundary reduces cross-group coupling.

## Readiness for Implementation

- [x] All functional requirements (FR-42, FR-43, FR-44) mapped to specific tasks
- [x] Complete assembly contract available with pipeline steps, message ordering, and persona switching rules
- [x] File paths and integration points identified from existing codebase (`message-assembler.ts`, `orchestrator.ts`, `chat-view.ts`, `conversation.ts`, `history.ts`)
- [x] R-4 research complete — slash-command approach validated (`AbstractInputSuggest<T>`, external chip container, `detectSlashTrigger()`, `isActive` coexistence pattern)
- [x] Dependency chain is acyclic and optimized for parallelism (4 parallel execution opportunities)
- [x] Acceptance criteria are specific, measurable, and testable
- [x] Edge cases from spec.md addressed (empty workflow, missing persona, missing workflow file, slash-command trigger precision, chip lifecycle, conversation persistence)
- [x] Upstream dependencies documented (Groups A, C, D) with specific task references
- [x] Downstream integration points documented for Groups F and H
- [x] `TriggerContext` designed for Group F's future use — manual workflows pass `null`, event-triggered workflows provide structured context
