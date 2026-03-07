# Task Breakdown: Phase 3 — Context & Intelligence

**Created:** 2026-07-03
**Implementation Plan:** [plan.md](plan.md)
**Specification:** [spec.md](spec.md)
**Status:** Planning

## Task Summary

**Total Tasks:** 42
**Steps:** 7 (Research → Foundation → Auto-Context → Attachments → Tools → Hooks & Compaction → Quality & Polish)
**Estimated Complexity:** High
**Parallel Execution Opportunities:** 8 task groups

---

## Step 0: Research & Environment Setup

### RES-001: Research Obsidian autocomplete/suggest API (R-1)
**Description:** Investigate how to implement wikilink-style autocomplete in the Notor chat input area. Determine whether `SuggestModal`, `FuzzySuggestModal`, `EditorSuggest`, or a custom dropdown can provide `[[` autocomplete and `#Section` navigation within an `ItemView`.
**Files:** `specs/02-context-intelligence/research.md` § R-1
**Dependencies:** None
**Acceptance Criteria:**
- [ ] Tested `SuggestModal`, `FuzzySuggestModal`, and `EditorSuggest` in an `ItemView` context
- [ ] Determined whether `[[` trigger can be intercepted in a `<textarea>` or contenteditable element
- [ ] Confirmed section header enumeration via `metadataCache.getFileCache()?.headings` works
- [ ] Documented chosen approach (built-in API or custom implementation) in research.md
- [ ] Identified any Obsidian API version requirements

### RES-002 [P]: Research Electron dialog API for external file picker (R-2)
**Description:** Determine the correct way to open an OS-native file dialog from an Obsidian plugin to select external files. Validate `remote.dialog`, `<input type="file">` fallback, and absolute path access.
**Files:** `specs/02-context-intelligence/research.md` § R-2
**Dependencies:** None
**Acceptance Criteria:**
- [ ] Tested `require('electron').remote.dialog.showOpenDialog()` availability
- [ ] If unavailable, tested `<input type="file">` fallback and path access
- [ ] Confirmed file content can be read via `fs.readFileSync` or equivalent
- [ ] Documented desktop-only gating via `Platform.isDesktop`
- [ ] Documented chosen approach in research.md

### RES-003 [P]: Research shell execution environment in Electron (R-3)
**Description:** Validate `child_process.spawn` availability and behavior in Obsidian's Electron plugin context. Test login shell invocation, process termination, and environment variable limits across platforms.
**Files:** `specs/02-context-intelligence/research.md` § R-3
**Dependencies:** None
**Acceptance Criteria:**
- [ ] Confirmed `require('child_process')` is available in Obsidian plugin context
- [ ] Tested login shell invocation on macOS (`$SHELL -l -c`) and documented behavior
- [ ] Verified `process.env.SHELL` is populated in Electron
- [ ] Tested process termination (`SIGTERM` → `SIGKILL`) on timeout
- [ ] Documented environment variable size limits per platform
- [ ] Confirmed `cwd` option works without permission issues

### RES-004 [P]: Research Turndown bundling and HTML conversion quality (R-4)
**Description:** Verify Turndown bundles cleanly with esbuild, assess HTML-to-Markdown conversion quality for common page types, and identify optimal configuration options.
**Files:** `specs/02-context-intelligence/research.md` § R-4
**Dependencies:** None
**Acceptance Criteria:**
- [ ] Turndown installed and builds without esbuild errors
- [ ] Bundle size impact measured (expected ~14 KB)
- [ ] Conversion quality assessed on 5+ representative URLs (Wikipedia, docs, blogs)
- [ ] Recommended Turndown configuration options documented
- [ ] `turndown-plugin-gfm` tested for table support
- [ ] Edge cases tested (malformed HTML, large DOMs, script/style tags)

### ENV-005: Install Turndown dependency
**Description:** Add Turndown and its type definitions as project dependencies. Optionally add GFM plugin for table/strikethrough support.
**Files:** `package.json`, `package-lock.json`
**Dependencies:** RES-004
**Acceptance Criteria:**
- [ ] `turndown` added as a runtime dependency
- [ ] `@types/turndown` added as a dev dependency
- [ ] `turndown-plugin-gfm` added if R-4 findings recommend it
- [ ] `npm run build` succeeds with new dependencies
- [ ] No esbuild bundling errors

---

## Step 1: Foundation & Shared Infrastructure

### FOUND-001: Settings model extensions
**Description:** Extend the existing plugin settings interface and defaults with all new Phase 3 settings fields. This is the foundation for all feature groups.
**Files:** `src/settings.ts`
**Dependencies:** None
**Acceptance Criteria:**
- [ ] Settings interface extended with all 16 new fields from plan (auto-context toggles, compaction settings, fetch_webpage settings, execute_command settings, hooks config, hook timeout, env truncation cap, external file size threshold)
- [ ] Default values match plan specification
- [ ] `HookConfig` interface defined with ordered lists per lifecycle event
- [ ] `Hook` interface defined with id, event, command, label, enabled fields
- [ ] Settings load/save via `loadData`/`saveData` includes new fields with backward compatibility (missing fields get defaults)

### FOUND-002: Token estimation utility
**Description:** Implement a lightweight token estimation function using the character/4 heuristic. This utility is used by auto-compaction and token tracking.
**Files:** `src/utils/tokens.ts`
**Dependencies:** None
**Acceptance Criteria:**
- [ ] `estimateTokens(text: string): number` function implemented using `Math.ceil(text.length / 4)`
- [ ] Handles empty strings and null/undefined gracefully
- [ ] Exported for use by compaction and context assembly modules

### FOUND-003: Shell executor (shared infrastructure)
**Description:** Implement the core shell spawning logic shared by `execute_command` tool and hook engine. Handles platform-specific shell resolution, stdio capture, output buffering with size cap, and timeout enforcement.
**Files:** `src/shell/shell-executor.ts`, `src/shell/shell-resolver.ts`, `src/shell/output-buffer.ts`
**Dependencies:** RES-003, FOUND-001
**Acceptance Criteria:**
- [ ] `ShellResolver` determines shell executable and args per platform: `$SHELL -l` on macOS/Linux, PowerShell on Windows, with user-configurable overrides from settings
- [ ] `OutputBuffer` captures combined stdout+stderr into a single string with configurable character cap (default: 50,000); appends truncation notice when exceeded
- [ ] `ShellExecutor.execute(command, options)` spawns a child process with configurable `cwd`, `env`, and timeout
- [ ] Timeout enforcement: `SIGTERM` on timeout, `SIGKILL` after 3-second grace period
- [ ] Returns `{ stdout: string, exitCode: number, timedOut: boolean, truncated: boolean }`
- [ ] Error handling for shell-not-found, spawn failures, and permission issues
- [ ] Desktop-only guard: functions throw or return error if `Platform.isDesktop` is false

### FOUND-004: Message assembler skeleton
**Description:** Create the message assembler module that composes the final user message from multiple content sources in the defined order: auto-context → attachments → hook stdout → user text.
**Files:** `src/context/message-assembler.ts`
**Dependencies:** None
**Acceptance Criteria:**
- [ ] `assembleUserMessage(parts: MessageParts): string` function implemented
- [ ] `MessageParts` interface defined: `{ autoContext?: string, attachments?: string, hookInjections?: string[], userText: string }`
- [ ] Output follows fixed ordering: auto-context block → attachments block → hook stdout (newline-joined) → user text
- [ ] Empty sections are omitted (no empty tags or extra whitespace)
- [ ] Exported for use by the chat orchestrator

---

## Step 2: Auto-Context Injection (Feature Group B — FR-26, FR-27, FR-28)

### CTX-001: Open note paths collector
**Description:** Implement the auto-context source that collects file paths of all currently open notes in the Obsidian workspace.
**Files:** `src/context/auto-context.ts`
**Dependencies:** None
**Acceptance Criteria:**
- [ ] `collectOpenNotePaths(app: App): string[]` function implemented
- [ ] Enumerates all leaves via `workspace.getLeavesOfType("markdown")`
- [ ] Extracts vault-relative file paths from each leaf's view
- [ ] Handles pinned tabs and split panes
- [ ] Returns empty array if no notes are open (no error)
- [ ] Completes in <100 ms for typical workspaces

### CTX-002 [P]: Vault structure collector
**Description:** Implement the auto-context source that lists top-level folder names at the vault root.
**Files:** `src/context/auto-context.ts`
**Dependencies:** None
**Acceptance Criteria:**
- [ ] `collectVaultStructure(app: App): string[]` function implemented
- [ ] Lists only folder names at vault root via `vault.getRoot().children`
- [ ] Filters to `TFolder` instances only (no files)
- [ ] Returns empty array if vault root has no folders

### CTX-003 [P]: OS platform detector
**Description:** Implement the auto-context source that reports the user's operating system.
**Files:** `src/context/auto-context.ts`
**Dependencies:** None
**Acceptance Criteria:**
- [ ] `detectOS(): string` function implemented
- [ ] Maps `process.platform` to human-readable name: `darwin` → `macOS`, `win32` → `Windows`, `linux` → `Linux`
- [ ] Returns a sensible fallback string for unexpected platform values

### CTX-004: Auto-context XML assembly
**Description:** Combine enabled auto-context sources into the `<auto-context>` XML block per the contract specification.
**Files:** `src/context/auto-context.ts`
**Dependencies:** CTX-001, CTX-002, CTX-003, FOUND-001
**Acceptance Criteria:**
- [ ] `buildAutoContextBlock(app: App, settings: Settings): string | null` function implemented
- [ ] Reads per-source enable/disable state from settings
- [ ] Includes `<open-notes>` tag with newline-separated paths when enabled
- [ ] Includes `<vault-structure>` tag with comma-separated folder names when enabled
- [ ] Includes `<os>` tag with platform name when enabled
- [ ] Omits tags for disabled sources
- [ ] Returns `null` if all sources are disabled (no `<auto-context>` block emitted)
- [ ] Output matches the XML format defined in contracts/tool-schemas.md

### CTX-005: Auto-context settings UI
**Description:** Add per-source enable/disable toggles to the Settings → Notor tab for auto-context injection.
**Files:** `src/settings.ts` (settings tab rendering)
**Dependencies:** FOUND-001, CTX-004
**Acceptance Criteria:**
- [ ] Three toggle controls added under an "Auto-context" section heading
- [ ] Labels: "Include open note paths", "Include vault structure", "Include operating system"
- [ ] All default to enabled
- [ ] Changes persist via `saveData` immediately on toggle

### CTX-006: Auto-context integration with chat dispatch
**Description:** Wire the auto-context assembly into the existing chat message dispatch path so the `<auto-context>` block is prepended to every user message sent to the LLM.
**Files:** `src/chat/orchestrator.ts` (or equivalent dispatch module), `src/context/message-assembler.ts`
**Dependencies:** CTX-004, FOUND-004
**Acceptance Criteria:**
- [ ] Before each message dispatch, `buildAutoContextBlock()` is called and result passed to `assembleUserMessage()`
- [ ] Auto-context data is logged in the JSONL history as part of the message's `auto_context` field
- [ ] No perceptible latency added to message dispatch (<100 ms)
- [ ] When all sources are disabled, no `<auto-context>` block appears in the assembled message

---

## Step 3: Attachment System (Feature Group A — FR-24, FR-25)

### ATT-001: Attachment data model
**Description:** Implement the Attachment entity model with types, validation, and lifecycle management (pending → resolved → error).
**Files:** `src/context/attachment.ts`
**Dependencies:** None
**Acceptance Criteria:**
- [ ] `Attachment` interface implemented matching data-model.md (id, type, path, section, display_name, content, content_length, status, error_message)
- [ ] `AttachmentType` enum: `vault_note`, `vault_note_section`, `external_file`
- [ ] `AttachmentStatus` enum: `pending`, `resolved`, `error`
- [ ] Factory functions for creating each attachment type with UUID generation
- [ ] Duplicate detection: `isDuplicate(existing: Attachment[], candidate: { path, section })` returns boolean

### ATT-002: Vault note content resolution
**Description:** Implement the logic to resolve vault note and section attachment content at send time using Obsidian's vault and metadata cache APIs.
**Files:** `src/context/attachment.ts`
**Dependencies:** ATT-001
**Acceptance Criteria:**
- [ ] `resolveAttachment(app: App, attachment: Attachment): Promise<Attachment>` function implemented
- [ ] For `vault_note`: reads full content via `vault.read(file)`; sets `status: resolved` and `content_length`
- [ ] For `vault_note_section`: reads full content, extracts section from heading to next heading of equal or higher level using `metadataCache.getFileCache(file)?.headings`; takes first match for ambiguous headings
- [ ] For `external_file`: content already populated at attach time; no-op resolution
- [ ] If file not found: sets `status: error`, populates `error_message`
- [ ] If section not found: sets `status: error`, populates `error_message`

### ATT-003: External file reading and validation
**Description:** Implement external file attachment: read file content, validate UTF-8, enforce size threshold confirmation.
**Files:** `src/context/attachment.ts`
**Dependencies:** ATT-001, RES-002, FOUND-001
**Acceptance Criteria:**
- [ ] External file content read at attach time via `fs.readFileSync` (or equivalent)
- [ ] UTF-8 validation: reject binary files with clear error ("Cannot attach binary file: only plain-text files are supported")
- [ ] File size check against configurable threshold (default: 1 MB); returns a flag indicating confirmation is needed if exceeded
- [ ] Desktop-only: gated behind `Platform.isDesktop`
- [ ] Stores original filename as `display_name` (no absolute path exposed)

### ATT-004: Attachment XML serialization
**Description:** Serialize resolved attachments into the `<attachments>` XML block per the contract specification.
**Files:** `src/context/attachment.ts`
**Dependencies:** ATT-001, ATT-002
**Acceptance Criteria:**
- [ ] `buildAttachmentsBlock(attachments: Attachment[]): string | null` function implemented
- [ ] Vault notes serialized as `<vault-note path="...">content</vault-note>`
- [ ] Vault note sections serialized as `<vault-note path="..." section="...">content</vault-note>`
- [ ] External files serialized as `<external-file name="...">content</external-file>`
- [ ] Error-status attachments are omitted from the block
- [ ] Returns `null` if no resolved attachments (no `<attachments>` block emitted)
- [ ] Output matches the XML format defined in contracts/tool-schemas.md

### ATT-005: Attachment picker UI — vault note autocomplete
**Description:** Implement the vault note attachment picker with wikilink-style autocomplete in the chat input area. Includes `[[` trigger, fuzzy matching, and section header navigation.
**Files:** `src/ui/attachment-picker.ts`
**Dependencies:** RES-001, ATT-001
**Acceptance Criteria:**
- [ ] Attachment button in chat input area opens a menu with "Attach vault note" and "Attach external file" options
- [ ] "Attach vault note" opens vault file picker with autocomplete (using approach determined by R-1)
- [ ] Typing `[[` in the chat input triggers the vault picker directly (bypassing the menu)
- [ ] The `[[` autocomplete must use Obsidian's native suggest/autocomplete APIs (e.g., `EditorSuggest`, `SuggestModal`) to guarantee behavior identical to the native wikilink autocomplete in Obsidian's note editor (matching, sort order, visual style). A custom implementation is acceptable only if RES-001 research proves native APIs are unusable in the `ItemView` context.
- [ ] Fuzzy matching of vault note names
- [ ] Section header references supported: after selecting a note, `#` triggers section header autocomplete via `metadataCache`
- [ ] Selected note/section creates an Attachment and triggers chip creation

### ATT-006 [P]: Attachment picker UI — external file dialog
**Description:** Implement the external file picker using the Electron file dialog (or fallback approach determined by R-2).
**Files:** `src/ui/attachment-picker.ts`
**Dependencies:** RES-002, ATT-003
**Acceptance Criteria:**
- [ ] "Attach external file" option opens the OS-native filesystem dialog
- [ ] Selected file is read, validated (UTF-8), and an Attachment is created
- [ ] If file exceeds size threshold, a confirmation dialog is shown with file size before attaching
- [ ] Binary files are rejected with a clear error message
- [ ] Feature is hidden/disabled on mobile (`Platform.isDesktop` check)

### ATT-007: Attachment chip display and management
**Description:** Implement the attachment chip UI in the chat input area showing attached items with removal capability.
**Files:** `src/ui/attachment-chips.ts`
**Dependencies:** ATT-001
**Acceptance Criteria:**
- [ ] Each attachment renders as a labeled chip/tag in the chat input area
- [ ] Vault notes show the note filename; sections show `Filename § Section`
- [ ] External files show the filename with a distinct visual indicator
- [ ] Chips have a remove button (X) that discards the attachment before sending
- [ ] Duplicate attachments (same path + section) are silently ignored
- [ ] Chips are cleared after the message is sent

### ATT-008: Attachment integration with chat dispatch
**Description:** Wire attachment resolution and XML serialization into the message dispatch path. Resolve vault note content at send time, build the `<attachments>` block, and assemble into the user message.
**Files:** `src/chat/orchestrator.ts`, `src/context/message-assembler.ts`
**Dependencies:** ATT-002, ATT-004, FOUND-004, CTX-006
**Acceptance Criteria:**
- [ ] Before message dispatch, all vault note attachments are resolved via `resolveAttachment()`
- [ ] Failed resolutions surface inline warnings in the chat thread; message still sends with remaining valid attachments
- [ ] Resolved attachments are serialized into the `<attachments>` block
- [ ] Block is passed to `assembleUserMessage()` in the correct position (after auto-context, before hooks)
- [ ] Attachments are logged in the JSONL history as part of the message's `attachments` field (metadata only, not full content)
- [ ] Sent message in the chat thread shows attachment chips (name only, no content expansion)

---

## Step 4: Tools — `fetch_webpage` & `execute_command` (Feature Groups D, E)

### TOOL-010: `fetch_webpage` tool implementation
**Description:** Implement the `fetch_webpage` tool core logic: HTTP GET with configurable timeout, redirect following, download size cap, and content-type routing.
**Files:** `src/tools/fetch-webpage.ts`
**Dependencies:** ENV-005, FOUND-001
**Acceptance Criteria:**
- [ ] HTTP GET via native `fetch()` with `User-Agent: Notor/1.0`
- [ ] Redirect following up to 5 hops; error if exceeded
- [ ] Configurable request timeout (default: 15s) via `AbortSignal.timeout()`
- [ ] Raw download size cap (default: 5 MB); abort and error if exceeded
- [ ] Content-type routing: `text/html` → Turndown, `text/*` and `application/json` → as-is, other types → error
- [ ] Output character cap (default: 50,000); truncate with notice if exceeded
- [ ] Returns `{ success, result, error? }` matching contract format

### TOOL-011: Domain denylist matching
**Description:** Implement the domain denylist check that runs before every `fetch_webpage` execution. Supports exact domain and wildcard patterns.
**Files:** `src/tools/fetch-webpage.ts`
**Dependencies:** FOUND-001
**Acceptance Criteria:**
- [ ] `isDomainBlocked(url: string, denylist: string[]): boolean` function implemented
- [ ] Exact domain match: `example.com` blocks only `example.com`
- [ ] Wildcard match: `*.example.com` blocks all sub-domains but not `example.com` itself
- [ ] URL parsing extracts domain correctly for both `http://` and `https://`
- [ ] Returns the matching pattern for inclusion in the error message

### TOOL-012: `fetch_webpage` tool registration
**Description:** Register `fetch_webpage` in the tool registry with proper schema, mode classification, and auto-approve default.
**Files:** `src/tools/fetch-webpage.ts`, `src/tools/index.ts`
**Dependencies:** TOOL-010, TOOL-011
**Acceptance Criteria:**
- [ ] Tool registered with name `fetch_webpage`, input schema matching contract
- [ ] Classified as read-only: available in both Plan and Act modes
- [ ] Auto-approve default: `true`
- [ ] Tool description matches contract specification
- [ ] Domain denylist check runs before execution in the tool's `execute` method

### TOOL-013: Domain denylist settings UI
**Description:** Add a list editor in Settings → Notor for managing the domain denylist entries.
**Files:** `src/settings.ts`
**Dependencies:** FOUND-001
**Acceptance Criteria:**
- [ ] List editor under a "`fetch_webpage`" or "Web fetching" settings section
- [ ] Users can add and remove domain entries
- [ ] Input validated for reasonable domain format
- [ ] Empty by default
- [ ] Additional settings: request timeout, max download size, max output chars

### TOOL-014: `execute_command` tool implementation
**Description:** Implement the `execute_command` tool using the shared shell executor infrastructure. Handles working directory validation, shell spawning, timeout, and output capping.
**Files:** `src/tools/execute-command.ts`
**Dependencies:** FOUND-003, FOUND-001
**Acceptance Criteria:**
- [ ] Accepts `command` and optional `working_directory` parameters
- [ ] Working directory resolution: empty → vault root, relative → resolve from vault root, absolute → use as-is
- [ ] Working directory validation: must be within vault root or user-configured allowed paths; reject with error otherwise
- [ ] Delegates to `ShellExecutor.execute()` for shell spawning
- [ ] Returns combined stdout+stderr, exit code, and timeout/truncation status
- [ ] Error results include exit code and stderr output for non-zero exits
- [ ] Desktop-only: returns error if `Platform.isDesktop` is false

### TOOL-015: `execute_command` tool registration
**Description:** Register `execute_command` in the tool registry with proper schema, mode classification, and auto-approve default.
**Files:** `src/tools/execute-command.ts`, `src/tools/index.ts`
**Dependencies:** TOOL-014
**Acceptance Criteria:**
- [ ] Tool registered with name `execute_command`, input schema matching contract
- [ ] Classified as write: available in Act mode only
- [ ] Auto-approve default: `false`
- [ ] Tool description matches contract specification
- [ ] Working directory validation runs before execution

### TOOL-016: `execute_command` settings UI
**Description:** Add settings for execute_command: allowed paths list editor, shell configuration, timeout, and output cap.
**Files:** `src/settings.ts`
**Dependencies:** FOUND-001
**Acceptance Criteria:**
- [ ] Allowed paths list editor (one absolute path per line); vault root noted as always included
- [ ] Shell executable input (empty = platform default)
- [ ] Shell arguments input (empty = platform default)
- [ ] Per-command timeout setting (default: 30s)
- [ ] Max output character setting (default: 50,000)

### TOOL-017: Tool dispatch flow updates
**Description:** Update the tool dispatch layer to include the Phase 3 additions: domain denylist check before `fetch_webpage`, working directory validation before `execute_command`, and hook firing points.
**Files:** `src/chat/dispatcher.ts`
**Dependencies:** TOOL-012, TOOL-015
**Acceptance Criteria:**
- [ ] Dispatch flow includes domain denylist check for `fetch_webpage` (step 5 in updated flow)
- [ ] Dispatch flow includes working directory validation for `execute_command` (step 6)
- [ ] Hook firing points added: `on_tool_call` after approval/before execution, `on_tool_result` after execution/before LLM return (wired in Step 5 task HOOK-004/005)
- [ ] Compaction threshold check added after tool result (wired in Step 5 task COMP-002)
- [ ] Existing dispatch logic (Plan/Act check, auto-approve, stale content, checkpoints) preserved

---

## Step 5: Hooks & Auto-Compaction (Feature Groups F, C)

### HOOK-001: Hook configuration model
**Description:** Implement the hook data model and settings integration: ordered lists of hooks per lifecycle event, with CRUD operations.
**Files:** `src/hooks/hook-config.ts`
**Dependencies:** FOUND-001
**Acceptance Criteria:**
- [ ] `Hook` interface with id (UUID), event, command, label, enabled fields
- [ ] `HookConfig` interface with arrays per event type: `pre_send`, `on_tool_call`, `on_tool_result`, `after_completion`
- [ ] CRUD helpers: `addHook`, `removeHook`, `reorderHooks`, `toggleHook`
- [ ] Hook list ordering is preserved (sequential execution order)
- [ ] Persisted via plugin settings `loadData`/`saveData`

### HOOK-002: Hook execution engine
**Description:** Implement the hook execution engine that spawns shell commands with environment variable metadata injection, handles timeouts, and captures stdout for `pre-send` hooks.
**Files:** `src/hooks/hook-engine.ts`
**Dependencies:** FOUND-003, HOOK-001
**Acceptance Criteria:**
- [ ] Uses shared `ShellExecutor` infrastructure for shell spawning
- [ ] Builds `NOTOR_*` environment variables per event type (see data-model.md Hook entity)
- [ ] Environment variable truncation at configurable cap (default: 10,000 chars) with truncation marker
- [ ] Global hook timeout (default: 10s) terminates shell process on expiry
- [ ] For `pre-send`: captures stdout and returns it; awaited sequentially
- [ ] For other events: fire-and-forget sequential execution; failures do not block
- [ ] Failures surface non-blocking notices via Obsidian `Notice`
- [ ] Individual hook failures do not prevent subsequent hooks from executing
- [ ] Hook shell commands execute with `cwd` set to the vault root (hooks do not support a configurable working directory in Phase 3)
- [ ] The working directory allow-list from `execute_command` settings is enforced for hook shell commands; if a future `cwd` option is added, commands with a working directory outside allowed paths are rejected — vault root always passes since it is implicitly included

### HOOK-003: Hook event dispatching
**Description:** Implement the event dispatching layer that triggers hooks at the correct points in the LLM lifecycle.
**Files:** `src/hooks/hook-events.ts`
**Dependencies:** HOOK-002
**Acceptance Criteria:**
- [ ] `dispatchPreSend(context)` — awaits all enabled `pre_send` hooks sequentially; returns concatenated stdout
- [ ] `dispatchOnToolCall(context)` — fires all enabled `on_tool_call` hooks non-blocking
- [ ] `dispatchOnToolResult(context)` — fires all enabled `on_tool_result` hooks non-blocking
- [ ] `dispatchAfterCompletion(context)` — fires all enabled `after_completion` hooks non-blocking
- [ ] Context objects carry the correct metadata per event (conversation ID, tool name/params/result/status where applicable, timestamp)
- [ ] Disabled hooks are skipped

### HOOK-004: Hook integration — `pre-send` in chat dispatch
**Description:** Wire the `pre-send` hook dispatcher into the message dispatch path so hook stdout is captured and included in the assembled user message.
**Files:** `src/chat/orchestrator.ts`, `src/context/message-assembler.ts`
**Dependencies:** HOOK-003, CTX-006, ATT-008
**Acceptance Criteria:**
- [ ] Before message dispatch (after auto-context and attachment resolution), `dispatchPreSend()` is called
- [ ] Captured stdout strings are passed to `assembleUserMessage()` as `hookInjections`
- [ ] Empty stdout (hook produced no output) is omitted
- [ ] Hook failures/timeouts surface notices but do not block message dispatch
- [ ] Hook stdout is logged in the JSONL history as part of the message's `hook_injections` field

### HOOK-005: Hook integration — tool call and completion events
**Description:** Wire `on_tool_call`, `on_tool_result`, and `after_completion` hook dispatchers into the tool dispatch and conversation turn lifecycle.
**Files:** `src/chat/dispatcher.ts`, `src/chat/orchestrator.ts`
**Dependencies:** HOOK-003, TOOL-017
**Acceptance Criteria:**
- [ ] `on_tool_call` hooks fire after tool approval, before tool execution
- [ ] `on_tool_result` hooks fire after tool execution, before result is returned to LLM
- [ ] `after_completion` hooks fire after the LLM's full response turn (including all tool call cycles) is complete
- [ ] All three event types are non-blocking fire-and-forget
- [ ] Hook failures surface non-blocking notices

### HOOK-006: Hook settings UI
**Description:** Add the hooks configuration UI in Settings → Notor, grouped by lifecycle event with collapsible subsections and add/remove/reorder capabilities per event.
**Files:** `src/settings.ts`
**Dependencies:** HOOK-001
**Acceptance Criteria:**
- [ ] Four collapsible subsections: `pre-send`, `on-tool-call`, `on-tool-result`, `after-completion`
- [ ] Each subsection shows an ordered list of configured hooks
- [ ] Per hook: displays label (or command if no label), enabled toggle, edit/delete buttons
- [ ] Add button creates a new hook with a command input field and optional label
- [ ] Reorder capability (drag or up/down buttons) to control execution order
- [ ] Global hook timeout setting
- [ ] Environment variable truncation cap setting

### COMP-001: Compaction threshold check
**Description:** Implement the compaction threshold check that runs before every LLM API call (user messages and tool-result round-trips). Uses the token estimation utility to track cumulative conversation token usage.
**Files:** `src/context/compaction.ts`
**Dependencies:** FOUND-002, FOUND-001
**Acceptance Criteria:**
- [ ] `shouldCompact(conversation, settings, modelContextWindow): boolean` function implemented
- [ ] Calculates cumulative tokens across all messages in the active context window using `estimateTokens()`
- [ ] Compares against `settings.compaction_threshold * modelContextWindow`
- [ ] Returns `true` if threshold is crossed
- [ ] For models where context window is null/unknown, returns `false` (falls back to existing truncation)

### COMP-002: Compaction summarization request
**Description:** Implement the compaction flow: send conversation to LLM with the compaction system prompt, receive summary, and construct the new context window.
**Files:** `src/context/compaction.ts`
**Dependencies:** COMP-001
**Acceptance Criteria:**
- [ ] Sends the current conversation to the active LLM provider with the compaction system prompt (built-in default or user override)
- [ ] Uses the same provider and model as the current conversation
- [ ] On success: constructs new context window with synthetic user/assistant exchange — summary as user message prefixed with "Summary of prior conversation: …", followed by canned assistant acknowledgment
- [ ] Current user message follows the synthetic exchange as the next turn
- [ ] On failure: falls back to existing truncation behavior (dropping oldest messages); surfaces error notice
- [ ] Compaction can be triggered manually via a command or button (in addition to automatic threshold)
- [ ] Logs a `CompactionRecord` in the JSONL conversation file at the compaction point

### COMP-003: Compaction system prompt
**Description:** Implement the built-in default compaction system prompt and user-override mechanism.
**Files:** `src/context/compaction.ts`, `src/settings.ts`
**Dependencies:** FOUND-001
**Acceptance Criteria:**
- [ ] Built-in default compaction prompt focused on producing a concise, faithful summary of the conversation
- [ ] User override via `compaction_prompt_override` setting in Settings → Notor
- [ ] When override is set and non-empty, it is used for all compaction requests
- [ ] Clearing the override (empty string) restores the default
- [ ] Compaction threshold setting (default: 0.8) exposed in settings UI

### COMP-004: Compaction UI — chat markers and status indicator
**Description:** Implement the chat UI elements for auto-compaction: the "Compacting context…" inline indicator during summarization, and the permanent "Context compacted" marker.
**Files:** `src/ui/compaction-marker.ts`, `src/ui/chat-view.ts`
**Dependencies:** COMP-002
**Acceptance Criteria:**
- [ ] While compaction summarization is in flight, an inline "Compacting context…" indicator appears in the chat thread
- [ ] Chat input remains enabled during compaction (user can compose or queue a message)
- [ ] Once summary is received, indicator transitions to permanent "Context compacted" marker
- [ ] Marker shows timestamp and token count at compaction on hover or expand
- [ ] LLM-generated summary text is NOT displayed in the UI (retained in JSONL only)
- [ ] Manual compaction trigger available via command palette ("Notor: Compact context") and/or button
- [ ] `compact-context` command registered via `this.addCommand()` in `main.ts` with a stable command ID; command name displayed as "Compact context" in the palette

### COMP-005: Compaction integration with chat dispatch
**Description:** Wire the compaction threshold check into the message dispatch and tool-result round-trip paths so compaction fires automatically when needed.
**Files:** `src/chat/orchestrator.ts`, `src/chat/dispatcher.ts`
**Dependencies:** COMP-002, COMP-004
**Acceptance Criteria:**
- [ ] Compaction threshold checked before every LLM API call: user message dispatches and tool-result-to-LLM round-trips
- [ ] When threshold is crossed, compaction runs before the pending API call proceeds
- [ ] If compaction succeeds, the new context window is used for the pending call
- [ ] If compaction fails, fallback to truncation and proceed
- [ ] JSONL log records the compaction event interleaved at the correct position

---

## Step 6: Quality, Testing & Polish

### TEST-001: Auto-context end-to-end testing
**Description:** Create e2e tests validating auto-context collection and injection into messages.
**Files:** `e2e/scripts/auto-context-test.ts`
**Dependencies:** CTX-006
**Acceptance Criteria:**
- [ ] Test: open multiple notes → send message → verify open note paths appear in JSONL log `auto_context` field
- [ ] Test: verify vault structure (top-level folders only) appears in auto-context
- [ ] Test: verify OS platform appears in auto-context
- [ ] Test: disable a source in settings → verify it is omitted from auto-context
- [ ] Test: all sources disabled → verify no `<auto-context>` block in message

### TEST-002 [P]: Attachment end-to-end testing
**Description:** Create e2e tests validating attachment flow from picker to message assembly.
**Files:** `e2e/scripts/attachment-test.ts`
**Dependencies:** ATT-008
**Acceptance Criteria:**
- [ ] Test: attach a vault note → send message → verify content appears in JSONL log
- [ ] Test: attach a section reference → verify only section content is included
- [ ] Test: delete a note after attaching → send → verify inline warning and message still sends
- [ ] Test: attach an external text file → verify content included
- [ ] Test: attempt to attach a binary file → verify rejection error

### TEST-003 [P]: `fetch_webpage` end-to-end testing
**Description:** Create e2e tests for the `fetch_webpage` tool using a mock HTTP server.
**Files:** `e2e/scripts/fetch-webpage-test.ts`
**Dependencies:** TOOL-012
**Acceptance Criteria:**
- [ ] Test: fetch an HTML page → verify Markdown conversion returned
- [ ] Test: fetch a plain text URL → verify returned as-is
- [ ] Test: fetch a JSON URL → verify returned as-is
- [ ] Test: fetch a blocked domain → verify denylist error returned
- [ ] Test: fetch a URL exceeding download size cap → verify error
- [ ] Test: fetch a large page exceeding output cap → verify truncation notice

### TEST-004 [P]: `execute_command` end-to-end testing
**Description:** Create e2e tests for the `execute_command` tool with safe commands.
**Files:** `e2e/scripts/execute-command-test.ts`
**Dependencies:** TOOL-015
**Acceptance Criteria:**
- [ ] Test: run `echo hello` → verify output returned
- [ ] Test: run a command in Plan mode → verify blocked with error
- [ ] Test: specify working directory outside allowed paths → verify rejection
- [ ] Test: run a command that times out → verify timeout error with partial output
- [ ] Test: run a command with output exceeding cap → verify truncation

### TEST-005 [P]: Hook execution testing
**Description:** Create e2e tests validating hook execution across all lifecycle events.
**Files:** `e2e/scripts/hook-execution-test.ts`
**Dependencies:** HOOK-005
**Acceptance Criteria:**
- [ ] Test: configure `pre-send` hook (`echo "injected"`) → send message → verify stdout appears in message context
- [ ] Test: configure `after-completion` hook → verify it fires after response completes
- [ ] Test: configure a hook that exceeds timeout → verify timeout notice and process termination
- [ ] Test: configure a failing hook → verify non-blocking behavior (message still sends, notice surfaced)
- [ ] Test: disable a hook → verify it does not fire

### TEST-006: Auto-compaction testing
**Description:** Create e2e tests for auto-compaction using a mock model with a small context window.
**Files:** `e2e/scripts/compaction-test.ts`
**Dependencies:** COMP-005
**Acceptance Criteria:**
- [ ] Test: conversation exceeds threshold → verify compaction fires and "Context compacted" marker appears
- [ ] Test: verify JSONL log contains `CompactionRecord` event
- [ ] Test: trigger manual compaction → verify it works
- [ ] Test: compaction failure → verify fallback to truncation with notice

### DOC-001: Update system prompt for Phase 3 tools
**Description:** Update the default system prompt to include instructions for the two new Phase 3 tools (`fetch_webpage` and `execute_command`) so the LLM knows how and when to use them.
**Files:** `src/chat/default-system-prompt.ts`
**Dependencies:** TOOL-012, TOOL-015
**Acceptance Criteria:**
- [ ] System prompt includes `fetch_webpage` tool description and usage guidance
- [ ] System prompt includes `execute_command` tool description, safety guidance, and platform awareness
- [ ] System prompt mentions that OS context is available in auto-context for platform-appropriate commands
- [ ] System prompt guidance is consistent with existing tool descriptions

### DOC-002: JSONL schema extensions documentation
**Description:** Ensure the JSONL conversation log correctly records all new Phase 3 data: attachments, auto-context, hook injections, and compaction records.
**Files:** `src/chat/history.ts`
**Dependencies:** CTX-006, ATT-008, HOOK-004, COMP-002
**Acceptance Criteria:**
- [ ] User messages include `attachments` field (metadata only) when attachments are present
- [ ] User messages include `auto_context` field when auto-context is injected
- [ ] User messages include `hook_injections` field when `pre-send` hooks produce output
- [ ] `CompactionRecord` entries are written to JSONL at the correct position in the conversation
- [ ] All new JSONL fields are backward-compatible (older logs without these fields still parse correctly)

### POLISH-001: Settings UI consolidation
**Description:** Consolidate and organize all Phase 3 settings into a coherent layout within the Settings → Notor tab. Ensure logical grouping, consistent styling, and clear descriptions.
**Files:** `src/settings.ts`
**Dependencies:** CTX-005, TOOL-013, TOOL-016, HOOK-006, COMP-003
**Acceptance Criteria:**
- [ ] Settings organized into clear sections: Auto-context, Web fetching, Shell commands, Hooks, Context compaction, File attachments
- [ ] Each section has a heading and brief description
- [ ] List editors (domain denylist, allowed paths, hooks) have consistent add/remove patterns
- [ ] All settings have tooltip or description text explaining their purpose
- [ ] Settings tab scrolls smoothly with many sections

### VAL-001: Final validation against specification
**Description:** End-to-end validation of all Phase 3 features against the specification's success criteria and functional requirements.
**Files:** All Phase 3 source files
**Dependencies:** All previous tasks
**Acceptance Criteria:**
- [ ] FR-24 through FR-36: all functional requirements satisfied per spec acceptance criteria
- [ ] NFR-6 (Performance): auto-context <100 ms, timeouts enforced, hooks non-blocking
- [ ] NFR-7 (Security): no background network/shell calls, denylist enforced, working directory restricted
- [ ] NFR-8 (Usability): attachment control discoverable, auto-context on by default, compaction marker clear, tool transparency maintained
- [ ] NFR-9 (Reliability): all failure modes handled gracefully (fetch errors, command failures, hook timeouts, compaction failures, missing attachments)
- [ ] All seven success criteria from spec.md verified
- [ ] Manual testing checklist from quickstart.md completed

---

## Dependency Graph

```
Step 0: Research & Environment
  RES-001 ─────────────────────────────────────────────────▶ ATT-005
  RES-002 ─────────────────────────────────────────────────▶ ATT-003, ATT-006
  RES-003 ─────────────────────────────────────────────────▶ FOUND-003
  RES-004 ─────────────────────────────────────────────────▶ ENV-005

Step 1: Foundation
  FOUND-001 ──▶ (used by nearly all subsequent tasks)
  FOUND-002 ──▶ COMP-001
  FOUND-003 ──▶ TOOL-014, HOOK-002
  FOUND-004 ──▶ CTX-006, ATT-008, HOOK-004

Step 2: Auto-Context
  CTX-001/002/003 ──▶ CTX-004 ──▶ CTX-006

Step 3: Attachments
  ATT-001 ──▶ ATT-002/003/004/005/007
  ATT-002 + ATT-004 ──▶ ATT-008

Step 4: Tools
  TOOL-010 + TOOL-011 ──▶ TOOL-012
  TOOL-014 ──▶ TOOL-015
  TOOL-012 + TOOL-015 ──▶ TOOL-017

Step 5: Hooks & Compaction
  HOOK-001 ──▶ HOOK-002 ──▶ HOOK-003 ──▶ HOOK-004, HOOK-005
  COMP-001 ──▶ COMP-002 ──▶ COMP-004, COMP-005

Step 6: Quality
  All feature tasks ──▶ TEST-*, DOC-*, POLISH-001, VAL-001
```

## Critical Path

```
RES-003 → FOUND-003 → TOOL-014 → TOOL-015 → TOOL-017 → HOOK-005 → COMP-005 → VAL-001
```

The longest dependency chain runs through shell infrastructure → execute_command → tool dispatch updates → hook integration → compaction integration → final validation. Auto-context (Feature Group B) has no research dependencies and can begin immediately in parallel.

## Parallel Execution Opportunities

| Group | Parallelizable Tasks | Notes |
|---|---|---|
| Research | RES-001, RES-002, RES-003, RES-004 | All four research tasks are independent |
| Auto-context sources | CTX-001, CTX-002, CTX-003 | Three collectors are independent |
| Attachment pickers | ATT-005, ATT-006 | Vault and external pickers are independent |
| Tools | TOOL-010/002/003 ∥ TOOL-014/006 | `fetch_webpage` and `execute_command` are independent |
| Settings UI | CTX-005, TOOL-013, TOOL-016, HOOK-006 | Settings UI sections are independent |
| Hooks & Compaction | HOOK-001–006 ∥ COMP-001–005 | Hook and compaction systems are independent until integration |
| Testing | TEST-001 through TEST-006 | All test suites are independent |
| Foundation | FOUND-001, FOUND-002, FOUND-004 | Settings, tokens, and assembler are independent |
