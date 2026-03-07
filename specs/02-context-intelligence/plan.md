# Implementation Plan: Phase 3 — Context & Intelligence

**Created:** 2026-07-03
**Specification:** [specs/02-context-intelligence/spec.md](spec.md)
**Status:** Planning

## Technical Context

### Architecture Decisions

- **Platform:** Obsidian community plugin (TypeScript → esbuild → `main.js`) — same as MVP
- **UI framework:** Obsidian native APIs — extends existing chat panel (`ItemView`) with attachment controls, auto-context display, compaction markers, and hook configuration in `PluginSettingTab`
- **Attachment picker:** Obsidian's `SuggestModal` / `FuzzySuggestModal` for vault note autocomplete (wikilink-style); Electron `dialog.showOpenDialog` for external file selection
- **Web fetching:** Native `fetch` API (available in Obsidian's Electron environment) for HTTP requests; Turndown (~14 KB minified) bundled as an npm dependency for HTML-to-Markdown conversion
- **Shell execution:** Node.js `child_process.spawn` (available in Obsidian's Electron environment) for `execute_command` and hook shell commands; login shell resolution via `$SHELL` on macOS/Linux, PowerShell on Windows
- **Token estimation:** Lightweight local approximation (character count / 4 heuristic, or simple BPE tokenizer) — no provider API calls for token counting
- **Context assembly:** XML-tagged blocks prepended to user message content, following fixed ordering: `<auto-context>` → `<attachments>` → `pre-send` hook stdout → user text
- **Hook execution model:** Shell commands via `child_process.spawn` with environment variable metadata injection; `pre-send` hooks are awaited sequentially, all other hooks are fire-and-forget sequential
- **Data persistence:** Extends existing JSONL conversation log with compaction records; settings persisted via Obsidian `loadData`/`saveData`

### Technology Stack Rationale

| Decision | Rationale | Alternatives Considered | Trade-offs |
|---|---|---|---|
| Turndown for HTML→Markdown | Lightweight (~14 KB), well-maintained, no native deps, bundleable via esbuild | Mozilla Readability.js (content extraction), Cheerio + custom conversion | Turndown returns raw conversion without stripping boilerplate; readability filtering deferred to future iteration |
| `child_process.spawn` for shell execution | Available in Electron; provides full control over shell selection, environment, stdio, and timeout; supports login shell invocation with `-l` flag | `child_process.exec` (simpler but buffer-limited), `execa` (adds dependency) | Requires manual stream buffering and output size capping; but avoids additional deps and provides fine-grained control |
| Character/4 token estimation | Zero dependencies, fast, sufficient accuracy for 80% threshold trigger | tiktoken (accurate BPE), provider tokenization APIs | ~10-20% error margin acceptable given conservative default threshold; avoids bundling large tokenizer or making API calls |
| XML-tagged context blocks | Consistent, parseable structure; matches Claude/GPT conventions for structured context injection | JSON blocks, Markdown headers, system message injection | Slightly more verbose than plain text; but provides clear boundaries the LLM can parse reliably |
| Login shell with `-l` flag | Inherits user's full PATH (Homebrew, nvm, pyenv, etc.) which Electron typically strips | Non-login shell, explicit PATH configuration | Slightly slower shell startup; but solves the critical problem of missing user-installed tools in Electron's stripped environment |

### Integration Points

- **Obsidian workspace API:** `workspace.getLeavesOfType("markdown")` for open note paths; `workspace.getActiveFile()` for current file context
- **Obsidian vault API:** `vault.read()` for attachment content resolution at send time; `vault.getAbstractFileByPath()` for file existence checks
- **Obsidian metadata cache:** `metadataCache.getFileCache()?.headings` for section-level attachment extraction
- **Electron dialog API:** `remote.dialog.showOpenDialog()` for external file picker
- **Node.js `child_process`:** `spawn()` for `execute_command` tool and hook shell command execution
- **Native `fetch` API:** For `fetch_webpage` HTTP requests (available in Electron's Chromium runtime)
- **Turndown library:** Bundled npm dependency for HTML-to-Markdown conversion
- **Existing Notor systems:** Tool dispatch layer (Phase 1), JSONL history persistence (Phase 2), checkpoint system (Phase 2), settings framework (Phase 0), system prompt assembly (Phase 0)

---

## Phase 0: Research & Architecture

### Research Tasks

Phase 3 has fewer unknowns than the MVP — most technology choices are extensions of the existing stack. However, several areas warrant targeted investigation before implementation.

#### R-1: Obsidian autocomplete/suggest API for attachment picker

**Status:** Pending

Investigate how to implement wikilink-style autocomplete in the Notor chat input area. Key questions:
- Can `SuggestModal` or `FuzzySuggestModal` be embedded inline in a text input (rather than as a popup modal)?
- How does Obsidian's native editor implement `[[` autocomplete, and can the same `EditorSuggest` API be reused in a custom `ItemView`?
- Is there a way to trigger the suggest popup from a specific cursor position in a `<textarea>` or contenteditable element?
- Can section headers (`#Section`) be included in the suggest results?

**Output:** Findings in [research.md](research.md) § R-1

#### R-2: Electron dialog API for external file picker

**Status:** Pending

Determine the correct way to open an OS-native file dialog from within an Obsidian plugin. Key questions:
- Is `require('electron').remote.dialog` available, or has Obsidian disabled `remote` module access?
- If `remote` is unavailable, can the `<input type="file">` HTML element serve as a fallback?
- Are there Obsidian API wrappers for file/folder selection dialogs?
- What are the implications for mobile compatibility (external file attachment will be desktop-only)?

**Output:** Findings in [research.md](research.md) § R-2

#### R-3: Shell execution environment in Electron

**Status:** Pending

Validate the `child_process.spawn` approach for shell commands within Obsidian's Electron sandbox. Key questions:
- Is `require('child_process')` available in the Obsidian plugin context (renderer process with `nodeIntegration`)?
- Does the `-l` (login) flag reliably source the user's shell profile across macOS, Linux, and Windows?
- What is the correct approach to reading `$SHELL` on macOS/Linux, and spawning PowerShell on Windows?
- How should long-running processes be killed on timeout — `process.kill('SIGTERM')` vs `SIGKILL`?
- What environment variable size limits exist across platforms (relevant for hook metadata injection)?

**Output:** Findings in [research.md](research.md) § R-3

#### R-4: Turndown bundling and HTML conversion quality

**Status:** Pending

Verify Turndown integration and assess conversion quality. Key questions:
- Does Turndown bundle cleanly with esbuild (no Node.js-specific APIs that break in Electron)?
- What is the output quality for common page types (Wikipedia articles, documentation sites, blog posts)?
- Are there configuration options (heading style, code block handling, link reference style) that improve output quality?
- What is the bundle size impact after tree-shaking?

**Output:** Findings in [research.md](research.md) § R-4

### Architecture Investigation

- **Performance requirements:** Auto-context collection must complete in <100 ms for typical vaults. Attachment resolution must not add perceptible latency. Token estimation must be O(n) on message length. Hook execution must not block the UI thread.
- **Security analysis:** `fetch_webpage` introduces the first outbound network calls — must be user-initiated only, domain-denylist-enforced, with no background requests. `execute_command` introduces system-level access — must be approval-gated, working-directory-restricted, and timeout-enforced. Hook shell commands use the same restrictions.
- **Memory considerations:** Large fetched pages (up to 5 MB raw) and command outputs (up to 50K chars) need streaming/chunked processing to avoid memory spikes. Attachment content for vault notes is read at send time (not cached in memory).

---

## Phase 1: Design & Contracts

**Prerequisites:** Research tasks R-1 through R-4 complete

### Data Model Design

Full data model is documented in [data-model.md](data-model.md). Key new entities for Phase 3:

- **Attachment** — vault note, vault note section, or external file attached to a user message
- **AutoContextSource** — configurable ambient context source (open notes, vault structure, OS)
- **CompactionRecord** — event logged when auto-compaction occurs in a conversation
- **Hook** — configured shell command callback tied to a lifecycle event
- **DomainDenylistEntry** — blocked domain pattern for `fetch_webpage`

### API Contract Generation

Tool schemas and dispatch contracts are documented in [contracts/](contracts/). Key new contracts for Phase 3:

- **`fetch_webpage` tool schema** — URL parameter, content-type handling, output truncation
- **`execute_command` tool schema** — command string, working directory, timeout, output truncation
- **Attachment format contract** — XML-tagged structure for message context injection
- **Auto-context format contract** — XML-tagged structure for ambient context injection
- **Hook execution contract** — environment variable names, execution semantics, timeout behavior

### Development Environment Setup

Developer setup additions for Phase 3 are documented in [quickstart.md](quickstart.md).

---

## Implementation Phases

### Feature Group A: Attachment System (FR-1, FR-2)

**Prerequisites:** R-1 (autocomplete API), R-2 (Electron dialog API) complete

| Component | FRs Covered | Description |
|---|---|---|
| Attachment button + menu | FR-1, FR-2 | Attachment button in chat input area with two-option menu: vault note picker, external file picker |
| Vault note autocomplete | FR-1 | Wikilink-style autocomplete with section header support (`[[Note#Section]]`); uses Obsidian suggest API |
| External file picker | FR-2 | OS-native file dialog via Electron; UTF-8 validation on attach; size threshold confirmation (default: 1 MB) |
| Attachment chip UI | FR-1, FR-2 | Labeled chips in input area showing attached items; removal via click/X; deduplication |
| Attachment resolution at send | FR-1, FR-2 | Vault notes read at send time; external files read at attach time; graceful failure with inline warning for missing notes |
| XML-tagged message assembly | FR-1, FR-2 | `<attachments>` block with `<vault-note>` and `<external-file>` tags prepended to user message |

### Feature Group B: Auto-Context Injection (FR-3, FR-4, FR-5)

**Prerequisites:** None (uses existing Obsidian APIs)

| Component | FRs Covered | Description |
|---|---|---|
| Open note paths collector | FR-3 | Enumerate all open leaves/tabs via `workspace.getLeavesOfType("markdown")`; extract file paths |
| Vault structure collector | FR-4 | List top-level folder names at vault root via `vault.getRoot().children`; filter to folders only |
| OS platform detector | FR-5 | Read `process.platform` and map to human-readable name (macOS/Windows/Linux) |
| Auto-context settings | FR-3, FR-4, FR-5 | Per-source enable/disable toggles in **Settings → Notor** (all default to enabled) |
| XML-tagged context assembly | FR-3, FR-4, FR-5 | `<auto-context>` block with `<open-notes>`, `<vault-structure>`, `<os>` tags; omit disabled sources; omit entire block if all disabled |
| Message ordering integration | FR-3, FR-4, FR-5 | Fixed ordering: `<auto-context>` → `<attachments>` → `pre-send` hook output → user text |

### Feature Group C: Auto-Compaction (FR-6)

**Prerequisites:** Token estimation utility; existing JSONL persistence and conversation management

| Component | FRs Covered | Description |
|---|---|---|
| Token estimation utility | FR-6 | Lightweight character-based approximation (chars/4); used for cumulative conversation token tracking |
| Compaction threshold check | FR-6 | Evaluated before every LLM API call (user messages and tool-result round-trips); configurable threshold (default: 80%) |
| Compaction summarization request | FR-6 | Send conversation to LLM with compaction system prompt; receive condensed summary |
| Compaction system prompt | FR-6 | Built-in default; user-overridable in **Settings → Notor** |
| New context window assembly | FR-6 | Synthetic user/assistant exchange with summary; current user message follows as next turn |
| Compaction UI | FR-6 | Inline "Compacting context…" indicator during summarization; permanent "Context compacted" marker with timestamp and token count on hover |
| Manual compaction trigger | FR-6 | Button or command to trigger compaction on demand |
| Compaction failure fallback | FR-6 | Fall back to oldest-message truncation; surface error notice |
| JSONL compaction record | FR-6 | Log `CompactionRecord` event in conversation JSONL file |

### Feature Group D: `fetch_webpage` Tool (FR-7, FR-8)

**Prerequisites:** R-4 (Turndown bundling) complete

| Component | FRs Covered | Description |
|---|---|---|
| `fetch_webpage` tool implementation | FR-7 | HTTP GET via `fetch()`; neutral User-Agent; redirect following (max 5); timeout (default: 15s) |
| Content-type routing | FR-7 | `text/html` → Turndown conversion; `text/*` and `application/json` → return as-is; other types → error |
| Download size cap | FR-7 | Configurable raw download limit (default: 5 MB); abort and error if exceeded |
| Output size cap | FR-7 | Configurable character cap (default: 50,000 chars); truncate with notice if exceeded |
| Domain denylist check | FR-7, FR-8 | Pre-fetch domain matching (exact + wildcard); reject with user-configurable error message |
| Domain denylist settings UI | FR-8 | List editor in **Settings → Notor** for add/remove domain entries |
| Tool registration | FR-7 | Register in tool registry as read-only, Phase 3, auto-approve default: true |

### Feature Group E: `execute_command` Tool (FR-9)

**Prerequisites:** R-3 (shell execution in Electron) complete

| Component | FRs Covered | Description |
|---|---|---|
| `execute_command` tool implementation | FR-9 | `child_process.spawn` with configurable shell; combined stdout+stderr capture |
| Login shell resolution | FR-9 | `$SHELL` with `-l` flag on macOS/Linux; PowerShell on Windows; user-configurable shell and flags in settings |
| Working directory validation | FR-9 | Must be vault root or within user-configured allow-list; reject with error otherwise |
| Allowed paths settings UI | FR-9 | List editor in **Settings → Notor** (one absolute path per line); vault root always implicitly included |
| Per-command timeout | FR-9 | Configurable (default: 30s); kill process and return timeout error |
| Output size cap | FR-9 | Configurable character cap (default: 50,000 chars); truncate with notice if exceeded |
| Shell configuration settings | FR-9 | Configurable shell executable and launch arguments per platform in **Settings → Notor** |
| Tool registration | FR-9 | Register in tool registry as write, Phase 3, auto-approve default: false, Act-only |

### Feature Group F: LLM Interaction Hooks (FR-10, FR-11, FR-12, FR-13)

**Prerequisites:** R-3 (shell execution in Electron) complete; `execute_command` shell infrastructure shared

| Component | FRs Covered | Description |
|---|---|---|
| Hook configuration data model | FR-10–13 | Ordered list of hooks per lifecycle event; each hook has a shell command string |
| Hook settings UI | FR-10–13 | Grouped by lifecycle event; collapsible subsections; add/remove/reorder per event |
| Hook execution engine | FR-10–13 | Shell command execution via shared `child_process.spawn` infrastructure; metadata as environment variables |
| Environment variable injection | FR-10–13 | `NOTOR_CONVERSATION_ID`, `NOTOR_HOOK_EVENT`, `NOTOR_WORKFLOW_NAME`, `NOTOR_TIMESTAMP`, `NOTOR_TOOL_NAME`, `NOTOR_TOOL_PARAMS`, `NOTOR_TOOL_RESULT`, `NOTOR_TOOL_STATUS` (varies by event) |
| Environment variable truncation | FR-10–13 | Large values truncated at configurable cap (default: 10,000 chars) with marker |
| Global hook timeout | FR-10–13 | Configurable (default: 10s); shared across all lifecycle events; terminate process on timeout |
| `pre-send` hook integration | FR-10 | Awaited sequentially before message dispatch; stdout captured and appended to message context; continue on failure |
| `on-tool-call` hook integration | FR-11 | Non-blocking fire-and-forget after approval, before execution; tool name + params in env vars |
| `on-tool-result` hook integration | FR-12 | Non-blocking fire-and-forget after tool execution; tool name + params + result + status in env vars |
| `after-completion` hook integration | FR-13 | Non-blocking fire-and-forget after LLM turn completes |

### Settings Additions

New settings required for Phase 3 (extends existing settings model):

| Setting | Type | Default | Description |
|---|---|---|---|
| `auto_context_open_notes` | boolean | `true` | Enable open note paths auto-context |
| `auto_context_vault_structure` | boolean | `true` | Enable vault structure auto-context |
| `auto_context_os` | boolean | `true` | Enable OS platform auto-context |
| `compaction_threshold` | number | `0.8` | Fraction of context window that triggers auto-compaction |
| `compaction_prompt_override` | string | `""` | Custom compaction system prompt (empty = use default) |
| `fetch_webpage_timeout` | number | `15` | HTTP request timeout in seconds |
| `fetch_webpage_max_download_mb` | number | `5` | Maximum raw download size in MB |
| `fetch_webpage_max_output_chars` | number | `50000` | Maximum output character count |
| `domain_denylist` | string[] | `[]` | Blocked domains for `fetch_webpage` |
| `execute_command_timeout` | number | `30` | Per-command timeout in seconds |
| `execute_command_max_output_chars` | number | `50000` | Maximum command output character count |
| `execute_command_allowed_paths` | string[] | `[]` | Additional allowed working directory paths |
| `execute_command_shell` | string | `""` | Custom shell executable (empty = platform default) |
| `execute_command_shell_args` | string[] | `[]` | Custom shell launch arguments (empty = platform default) |
| `external_file_size_threshold_mb` | number | `1` | File size threshold for confirmation dialog |
| `hooks` | HookConfig | `{}` | Hook configurations grouped by lifecycle event |
| `hook_timeout` | number | `10` | Global hook timeout in seconds |
| `hook_env_truncation_chars` | number | `10000` | Max environment variable value size for hooks |

---

## Implementation Readiness Validation

### Technical Completeness Check

- [x] Technology choices made and documented
- [ ] R-1: Obsidian autocomplete/suggest API researched
- [ ] R-2: Electron dialog API for external files researched
- [ ] R-3: Shell execution environment in Electron validated
- [ ] R-4: Turndown bundling verified
- [ ] Data model covers all functional requirements (see data-model.md)
- [ ] Tool schemas defined for new tools (see contracts/)
- [x] Security requirements addressed (outbound network gated, shell execution restricted, approval-enforced)
- [x] Performance considerations documented (NFR-1: <100 ms context collection, timeouts, output caps)
- [x] Integration points defined (Obsidian APIs, Electron APIs, Node.js child_process, fetch, Turndown)

### Quality Validation

- [x] Architecture extends existing MVP systems without breaking changes
- [x] Security model addresses new attack surfaces (network, shell, hooks)
- [ ] Data model supports all business rules (pending research completion)
- [x] API design follows established patterns (XML-tagged context, JSON Schema tools, JSONL persistence)
- [x] Documentation complete for all major decisions

---

## Risk Assessment

### Technical Risks

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| **Obsidian suggest API cannot be embedded inline in chat input** | Medium — may need custom autocomplete UI | Medium | R-1 will determine approach; fallback: custom dropdown with vault file search |
| **Electron `remote` module disabled in Obsidian** | Low — affects external file picker only | Medium | R-2 will validate; fallback: HTML `<input type="file">` element |
| **`child_process` unavailable in Obsidian renderer** | High — blocks `execute_command` and hooks | Low | Very unlikely — Obsidian plugins have Node.js integration; R-3 will confirm |
| **Turndown produces poor quality output for complex pages** | Low — feature still usable | Medium | Acceptable for Phase 3; content extraction (Readability.js) can be added later |
| **Token estimation inaccuracy causes premature/late compaction** | Medium — poor UX | Medium | Conservative 80% default threshold provides buffer; users can adjust; exact tokenization deferred |
| **Large `fetch_webpage` responses cause memory spikes** | Medium — could degrade Obsidian performance | Low | 5 MB raw download cap + 50K char output cap provide hard limits |
| **Hook shell commands leak processes on timeout** | Medium — resource leak | Low | `SIGTERM` followed by `SIGKILL` after grace period; process group kill |
| **Environment variable size limits on Windows** | Low — affects hook metadata only | Medium | 10K char truncation cap is well within OS limits (~32K per var on Windows) |

### Dependencies and Assumptions

- **External dependencies:** Turndown (~14 KB, npm package); no other new runtime dependencies
- **Existing system dependencies:** Phase 3 builds on Phase 0 (LLM providers, streaming, settings), Phase 1 (tool dispatch, Plan/Act mode, chat panel), and Phase 2 (JSONL history, checkpoints, frontmatter tools)
- **Technical assumptions:** `child_process` module available in Obsidian plugins (Electron with `nodeIntegration`); `fetch` API available in Obsidian's Chromium runtime; Turndown bundles cleanly with esbuild; `process.platform` accurately reports the OS
- **Business assumptions:** Users who want `execute_command` have a working shell environment; auto-compaction summary quality depends on the active LLM's summarization capability; hook users are comfortable writing shell commands
- **Mobile considerations:** `execute_command`, hooks, and external file attachment are desktop-only features. `fetch_webpage`, auto-context, attachments (vault notes), and auto-compaction work on mobile. If any feature requires `child_process`, it must be gated behind desktop detection (`Platform.isDesktop`).

---

## Next Phase Preparation

### Task Breakdown Readiness

- [x] Clear technology choices and architecture
- [ ] Complete data model and tool specifications (pending research)
- [x] Development environment and tooling defined
- [x] Quality standards and testing approach specified
- [x] Integration requirements and dependencies clear

### Implementation Prerequisites

- [ ] R-1: Obsidian autocomplete/suggest API research complete
- [ ] R-2: Electron dialog API research complete
- [ ] R-3: Shell execution in Electron research complete
- [ ] R-4: Turndown bundling research complete
- [x] Development environment requirements specified (see quickstart.md)
- [x] Existing Phase 0–2 infrastructure available as foundation
- [x] Quality assurance approach defined (e2e tests with Playwright, manual testing)

### Recommended Implementation Order

Feature groups have the following dependency relationships:

```
B (Auto-Context) ─────────────────────┐
                                      ├──▶ Integration & message assembly
A (Attachments) ──────────────────────┤
                                      │
C (Auto-Compaction) ──────────────────┤
                                      │
D (fetch_webpage) ────────────────────┤
                                      │
E (execute_command) ──┬───────────────┤
                      │               │
F (Hooks) ────────────┘               │
                                      ▼
                              Settings UI consolidation
```

**Recommended order:**
1. **B (Auto-Context)** — minimal dependencies, extends existing message dispatch
2. **A (Attachments)** — depends on research R-1/R-2, but can parallelize UI work
3. **D (`fetch_webpage`)** — self-contained tool, depends on R-4
4. **E (`execute_command`)** — depends on R-3; establishes shell infrastructure for hooks
5. **F (Hooks)** — depends on E's shell infrastructure
6. **C (Auto-Compaction)** — most complex; benefits from all other features being stable