# Implementation Plan: Phase 4 — Workflows & Personas

**Created:** 2026-08-03
**Specification:** [specs/03-workflows-personas/spec.md](spec.md)
**Status:** Planning

## Technical Context

### Architecture Decisions

- **Platform:** Obsidian community plugin (TypeScript → esbuild → `main.js`) — same as Phases 0–3
- **UI framework:** Obsidian native APIs — extends existing chat panel (`ItemView`) with persona picker, workflow activity indicator, slash-command autocomplete; extends `PluginSettingTab` with persona auto-approve sub-page, vault event hook configuration, and provider/model identifier reference
- **Persona system:** File-based personas stored as directories under `{notor_dir}/personas/{name}/`, each containing a `system-prompt.md` note. Discovery via `vault.getAbstractFileByPath()` + directory listing. Frontmatter parsed via `metadataCache.getFileCache()`.
- **Workflow system:** File-based workflows stored as Markdown notes under `{notor_dir}/workflows/`, identified by `notor-workflow: true` frontmatter. Recursive directory scan via vault API. Body content provides step-by-step instructions wrapped in `<workflow_instructions>` XML at execution time.
- **`<include_note>` resolution:** Regex-based XML tag parser for self-closing `<include_note ... />` tags. Vault-relative paths resolved via `vault.getAbstractFileByPath()`; wikilink paths resolved via `metadataCache.getFirstLinkpathDest()`. Section extraction uses `metadataCache.getFileCache()?.headings`. Single resolution function shared across system prompts, vault rules, and workflow bodies.
- **Vault event hooks:** Obsidian event system — `app.workspace.on('file-open', ...)` for note open, `app.vault.on('create', ...)` for note create, `app.vault.on('modify', ...)` for save, `app.metadataCache.on('changed', ...)` for tag change detection. Lazy per-hook-type listener activation/deactivation.
- **Manual save detection:** Intercept `editor:save-file` command via `app.commands` — set a short-lived flag, check in subsequent `modify` handler to distinguish manual from auto-save.
- **Cron scheduling:** `croner` v10.x (27.3 KB minified / 8.1 KB gzipped, zero deps, ESM, fully browser/Electron-safe) for in-process cron expression parsing and scheduling. No external cron daemon.
- **Workflow concurrency:** In-memory execution manager with configurable global concurrency limit (default: 3) for background event-triggered workflows. FIFO queue for overflow. Manual workflows not counted against the limit.
- **Slash-command UX:** `AbstractInputSuggest<T>` on the existing contenteditable chat input (same API as `VaultNoteSuggest` for `[[`), triggered by `/` at line start. Automatic dropdown positioning via `PopoverSuggest`. Workflow chips in external `notor-attachment-chips` container. Filters workflow list as user types.
- **Workflow activity indicator:** DOM-based element in chat panel header with dropdown popover for recent/active workflow executions.
- **Infinite loop prevention:** Execution chain tracking — each workflow execution carries a set of "source hooks" that prevent re-triggering the same hook type within the chain.

### Technology Stack Rationale

| Decision | Rationale | Alternatives Considered | Trade-offs |
|---|---|---|---|
| File-based persona discovery (directory scan) | Personas as vault notes are editable in Obsidian's editor; discovery is simple directory listing; no database needed | Settings-based persona definitions, JSON config files | Requires directory scan on picker open (mitigated by <200 ms target for 50 personas); no centralized index |
| File-based workflow discovery (frontmatter scan) | Workflows as vault notes are searchable, linkable, and editable; frontmatter-based identification is consistent with Obsidian conventions | Dedicated config file listing workflows, tags-based identification | Requires recursive scan reading frontmatter only (mitigated by <500 ms target for 200 workflows); notes without `notor-workflow: true` are ignored |
| Regex-based `<include_note>` tag parser | Simple, no external XML parser needed; self-closing tags have predictable structure; handles both path syntaxes | Full XML/HTML parser (e.g., DOMParser), custom AST parser | Cannot handle malformed XML gracefully; but self-closing tags are simple enough that regex is reliable. No nested resolution prevents complexity. |
| Wikilink resolution via `getFirstLinkpathDest()` | Same API Obsidian uses internally; gets automatic link-update on rename; proven reliability | Custom link resolution, vault-wide file search | Depends on Obsidian's metadata cache being up-to-date; ambiguous names use Obsidian's default resolution order |
| `croner` for cron scheduling | 27.3 KB minified / 8.1 KB gzipped, zero dependencies, ESM-compatible, full 5-field cron + shorthand aliases, per-job timezone support, browser/Electron-safe | `cron-parser` (~15 KB + luxon ~70 KB, parse-only — needs custom scheduler), `node-cron` (similar size, Node.js-focused, less maintained), custom implementation (~500+ lines) | Adds a bundled dependency (~8 KB gzipped); but eliminates need to write cron parsing/scheduling from scratch |
| In-memory concurrency manager | Simple, no persistence needed; workflows are ephemeral execution contexts | Database-backed queue, worker threads | State lost on plugin reload (acceptable — running workflows terminate on unload); but simple and sufficient |
| `editor:save-file` command interception for manual save | Only reliable mechanism to distinguish user-initiated save from auto-save in Obsidian | Monitoring keyboard events (fragile), Obsidian API hooks (none exists for this) | Relies on Obsidian command ID stability; but `editor:save-file` is a core command unlikely to change |

### Integration Points

- **Obsidian vault API:** `vault.getAbstractFileByPath()` for file existence checks, `vault.read()` for reading persona/workflow/included note content, directory listing for persona/workflow discovery
- **Obsidian metadata cache:** `metadataCache.getFileCache()?.frontmatter` for frontmatter parsing during discovery, `metadataCache.getFileCache()?.headings` for section extraction in `<include_note>`, `metadataCache.getFirstLinkpathDest()` for wikilink resolution, `metadataCache.on('changed', ...)` for tag change detection
- **Obsidian workspace API:** `workspace.on('file-open', ...)` for note open hooks, `workspace.on('active-leaf-change', ...)` for persona revert tracking
- **Obsidian vault events:** `vault.on('create', ...)` for note create hooks, `vault.on('modify', ...)` for save hooks
- **Obsidian commands API:** `app.commands` for `editor:save-file` interception (manual save detection), `addCommand` for "Notor: Run workflow" command palette entry
- **Existing Notor systems:** System prompt assembly (`src/chat/system-prompt.ts`), hook engine (`src/hooks/hook-engine.ts`), hook config (`src/hooks/hook-config.ts`), tool dispatch (`src/chat/dispatcher.ts`), chat orchestrator (`src/chat/orchestrator.ts`), message assembler (`src/context/message-assembler.ts`), settings (`src/settings.ts`), chat view (`src/ui/chat-view.ts`), provider registry (`src/providers/`), auto-approve logic
- **Cron library:** Bundled npm dependency for cron expression parsing and in-process scheduling

---

## Phase 0: Research & Architecture

### Research Tasks

Phase 4 introduces several new interaction patterns with Obsidian's API that require validation before implementation. Four targeted research tasks are identified.

#### R-1: Cron scheduling library evaluation

**Status:** ✅ Complete

Evaluate lightweight JavaScript cron libraries for in-process scheduling within Obsidian's Electron environment.

**Decision:** Use `croner` v10.x — 27.3 KB minified / 8.1 KB gzipped, zero dependencies, ESM-compatible, full 5-field cron + shorthand aliases, dynamic job start/stop via `pause()`/`resume()`/`stop()`, validation via `CronPattern` constructor, per-job timezone support via `Intl.DateTimeFormat`, fully browser/Electron-safe (no Node.js APIs).

**Output:** Findings in [research.md](research.md) § R-1

#### R-2: Manual save detection via command interception

**Status:** ✅ Complete

Validate the approach of intercepting `editor:save-file` to distinguish manual saves from auto-saves.

**Decision:** Direct monkey-patch of `app.commands.executeCommandById` to intercept `editor:save-file`. Flag-based detection with `Map<string, number>` (note path → timestamp), 500 ms window, one-shot consumption. Auto-save correctly excluded (bypasses command system). Works on all desktop platforms (macOS, Windows, Linux). Effectively desktop-only — mobile has no save shortcut. `app.commands` API has been stable since Obsidian 0.15 (2022), relied upon by dozens of major community plugins. Graceful degradation if API unavailable.

**Output:** Findings in [research.md](research.md) § R-2

#### R-3: Tag change detection via metadata cache

**Status:** ✅ Complete

Determine the best approach for detecting frontmatter tag changes to support `on-tag-change` hooks.

**Decision:** Shadow cache (`Map<string, Set<string>>`) with eager initialization at plugin load (via `workspace.onLayoutReady()`), `metadataCache.on('changed')` listener, `parseFrontMatterTags()` for frontmatter-only tag extraction. Set-based diff for O(1) membership checks. Tag normalization: strip `#`, trim whitespace, lowercase for comparison, preserve original case for reporting. Memory: ~2.9 MB for 10,000 notes (acceptable). `TagChangeSuppressionManager` with two-phase consume-on-event cleanup for loop prevention. Additional lifecycle handlers for `vault.on('delete')` and `vault.on('rename')` to maintain shadow cache. No debounce needed (discrete events, shadow cache diff handles deduplication).

**Output:** Findings in [research.md](research.md) § R-3

#### R-4: Slash-command autocomplete in custom ItemView

**Status:** ✅ Complete

Investigate how to implement `/`-triggered autocomplete in the Notor chat input area (which is a custom `ItemView`, not Obsidian's native editor).

**Decision:** Use `AbstractInputSuggest<T>` on the existing `<div contenteditable="true">` chat input — the same API and element already used by `VaultNoteSuggest` for `[[` autocomplete. `EditorSuggest` is NOT applicable (requires CodeMirror `Editor` + `TFile` context). Dropdown positioning handled automatically by `PopoverSuggest`. Workflow chips rendered in the existing external `notor-attachment-chips` container (same as attachment chips) — NOT inline in contenteditable (plaintext-only mode strips HTML). `WorkflowChipManager` class (~50 lines) manages single chip lifecycle. `/` trigger fires only at index 0 or after `\n`; excludes paths (query containing `/`). `isActive` flag pattern ensures coexistence with `VaultNoteSuggest`. ~150 lines of new code, ~10 lines of CSS. No new dependencies.

**Output:** Findings in [research.md](research.md) § R-4

### Architecture Investigation

- **Performance requirements:** Persona discovery <200 ms for 50 personas. Workflow discovery <500 ms for 200 workflows (frontmatter-only reads). `<include_note>` resolution <200 ms for 20 tags. Vault event hooks add no perceptible delay to triggering operations (non-blocking execution). Lazy listener activation eliminates overhead for unused event types.
- **Security analysis:** `<include_note>` resolution is vault-scoped — paths resolving outside the vault are rejected. Hook-triggered workflows respect Plan/Act mode, auto-approve, and checkpoint mechanisms. Per-persona auto-approve can only adjust tool strictness — cannot bypass Plan mode restrictions. Workflow frontmatter hooks use the same shell execution restrictions as global hooks.
- **Memory considerations:** Tag change detection requires maintaining a per-note tag cache (lightweight — tags are small arrays). Background workflow execution state is in-memory (bounded by concurrency limit). Workflow activity indicator retains the last N completed workflows (configurable, default: 5).

---

## Phase 1: Design & Contracts

**Prerequisites:** Research tasks R-1 through R-4 complete

### Data Model Design

Full data model is documented in [data-model.md](data-model.md). Key new entities for Phase 4:

- **Persona** — in-memory representation of a discovered persona (name, system prompt content, frontmatter config)
- **PersonaAutoApproveConfig** — per-persona per-tool override settings stored in plugin settings
- **Workflow** — in-memory representation of a discovered workflow (file path, frontmatter properties, body content)
- **IncludeNoteTag** — parsed representation of an `<include_note ... />` tag with resolution logic
- **VaultEventHook** — configured vault event callback with action type (shell command or run workflow)
- **WorkflowScopedHook** — per-workflow LLM lifecycle hook override from frontmatter
- **TriggerContext** — structured event metadata for event-triggered workflows
- **WorkflowExecution** — background workflow execution state tracking

### API Contract Generation

Contracts are documented in [contracts/](contracts/). Key new contracts for Phase 4:

- **`<include_note>` tag resolution** — tag syntax, parsing rules, path resolution algorithm, section extraction, error handling
- **Workflow prompt assembly** — `<workflow_instructions>` wrapping format, `<trigger_context>` block format, message ordering with workflow content
- **Vault event hook configuration** — hook config schema per event type, environment variables, "run workflow" action contract, debounce/concurrency semantics

### Development Environment Setup

Developer setup additions for Phase 4 are documented in [quickstart.md](quickstart.md).

---

## Implementation Feature Groups

### Group A: Persona System (FR-37, FR-38, FR-39, FR-39a)

**Prerequisites:** None (extends existing system prompt assembly and chat panel)

| Component | FRs Covered | Description |
|---|---|---|
| Persona discovery service | FR-37 | Scan `{notor_dir}/personas/` for subdirectories containing `system-prompt.md`; cache results; rescan on settings open and picker activation |
| Persona frontmatter parser | FR-38 | Parse `notor-persona-prompt-mode`, `notor-preferred-provider`, `notor-preferred-model` from system-prompt.md frontmatter |
| System prompt assembly integration | FR-38 | Extend `SystemPromptBuilder` to apply persona prompt in append/replace mode; handle `<include_note>` tags in persona prompts |
| Persona picker UI | FR-39 | Dropdown in chat settings area (gear icon) listing discovered personas + "None" option; active persona label near chat input |
| Provider/model switching on persona activation | FR-38, FR-39 | When persona specifies provider/model, switch at runtime; fallback to defaults with non-blocking notice if unavailable |
| Provider & model identifier reference | FR-39a | Settings section listing all configured providers and their available models with copyable identifier strings |

### Group B: Per-Persona Auto-Approve Overrides (FR-40)

**Prerequisites:** Group A (persona discovery)

| Component | FRs Covered | Description |
|---|---|---|
| Persona auto-approve settings sub-page | FR-40 | Dedicated page in **Settings → Notor** listing all personas with per-tool three-state selector (Global default / Auto-approve / Require approval) |
| Auto-approve override storage | FR-40 | Stored in plugin settings data keyed by persona name; not in persona frontmatter |
| Runtime auto-approve resolution | FR-40 | Extend tool dispatch to check persona overrides first, then fall back to global defaults; respect Plan/Act mode restrictions regardless |
| Stale tool name handling | FR-40 | Display warning indicator for tool names in persona config that no longer exist in the tool registry |

### Group C: Workflow Definition & Discovery (FR-41)

**Prerequisites:** None

| Component | FRs Covered | Description |
|---|---|---|
| Workflow discovery service | FR-41 | Recursive scan of `{notor_dir}/workflows/` for Markdown notes with `notor-workflow: true`; frontmatter-only reads; validate required properties |
| Workflow frontmatter parser | FR-41 | Parse `notor-trigger`, `notor-schedule`, `notor-workflow-persona`, `notor-hooks`; validate trigger types; warn on missing required properties |
| Workflow validation | FR-41 | Exclude invalid workflows (missing `notor-trigger`) with warning logged; support subdirectory organization |

### Group D: `<include_note>` Tag Resolution (FR-46)

**Prerequisites:** None (standalone utility; integrates with Groups A, E, and existing system prompt/vault rules)

| Component | FRs Covered | Description |
|---|---|---|
| Tag parser | FR-46 | Regex-based parser for `<include_note ... />` tags; extract `path`, `section`, `mode`, `strip_frontmatter` attributes |
| Path resolution — vault-relative | FR-46 | Resolve `path="Research/Topic A.md"` via `vault.getAbstractFileByPath()` |
| Path resolution — wikilink | FR-46 | Resolve `path="[[Topic A]]"` via `metadataCache.getFirstLinkpathDest()` |
| Section extraction | FR-46 | Extract content from heading to next heading of equal/higher level using `metadataCache.getFileCache()?.headings` |
| Frontmatter stripping | FR-46 | Strip YAML frontmatter by default (`strip_frontmatter` defaults to `true`); include raw when `false` |
| Inline vs attached modes | FR-46 | Inline: paste content directly; attached: wrap in `<vault-note>` tag within `<attachments>` block |
| Error handling | FR-46 | Replace unresolvable tags with inline error markers; no nested resolution |
| Integration points | FR-46 | Hook into system prompt assembly, vault rule injection, and workflow prompt assembly |

### Group E: Manual Workflow Execution (FR-42, FR-43, FR-44)

**Prerequisites:** Groups A (persona switching), C (workflow discovery), D (`<include_note>` resolution)

| Component | FRs Covered | Description |
|---|---|---|
| "Notor: Run workflow" command | FR-42 | Obsidian command palette entry with quick-pick list of all discovered workflows |
| Slash-command workflow attachment | FR-42 | `/`-triggered autocomplete in chat input; workflow chip insertion; at most one workflow per message |
| Workflow prompt assembly | FR-44 | Resolve `<include_note>` tags, wrap in `<workflow_instructions type="{filename}">`, prepend to user message |
| Conversation creation | FR-42, FR-44 | Create new conversation with assembled workflow prompt as first user message; open chat panel if needed |
| Workflow `<details>` rendering | FR-42 | Render `<workflow_instructions>` block as collapsed `<details>` element in chat UI |
| Persona switching on workflow start | FR-43 | If `notor-workflow-persona` is set, switch persona before execution; surface notice if persona not found |
| Persona revert on workflow end | FR-43 | Revert to previous persona when user leaves the workflow conversation; handle success/failure/stop cases |
| Empty workflow guard | FR-44 | Abort execution with notice if workflow body is empty after frontmatter stripping and tag resolution |

### Group F: Vault Event Hooks (FR-47, FR-48, FR-48a, FR-48b, FR-49, FR-50, FR-50a, FR-51)

**Prerequisites:** Groups C + E (workflow discovery and execution), R-1 (cron library), R-2 (manual save detection), R-3 (tag change detection)

| Component | FRs Covered | Description |
|---|---|---|
| Vault event hook configuration model | FR-47–50 | Extend hook config with vault event types: `on_note_open`, `on_note_create`, `on_save`, `on_manual_save`, `on_tag_change`, `on_schedule` |
| Vault event hook settings UI | FR-47–50 | Grouped, collapsible sections in **Settings → Notor** under "Vault event hooks"; consistent with Phase 3 LLM interaction hook UI pattern |
| "Run a workflow" hook action | FR-51 | New action type for all hooks (LLM lifecycle + vault event); specify workflow by vault-relative path; execute via workflow execution pipeline |
| Lazy listener activation | FR-50a | Register/unregister Obsidian event listeners dynamically based on which event types have hooks or workflow triggers configured |
| `on-note-open` listener | FR-47 | `workspace.on('file-open', ...)` with debounce cooldown (default: 5s per note path) |
| `on-note-create` listener | FR-48a | `vault.on('create', ...)` with loop prevention (notes created by hook workflows don't re-trigger) |
| `on-save` listener | FR-48 | `vault.on('modify', ...)` with debounce cooldown (default: 5s per note path) |
| `on-manual-save` listener | FR-48b | `editor:save-file` command interception + flag check in modify handler; debounce cooldown |
| `on-tag-change` listener | FR-49 | `metadataCache.on('changed', ...)` with tag diff comparison; loop prevention for hook-initiated tag changes |
| `on-schedule` scheduler | FR-50 | Cron library integration; start/stop timers dynamically based on configured hooks; validate cron expressions at config time |
| Trigger context injection | FR-45 | Auto-prepend `<trigger_context>` XML block with event type, note path, changed tags before `<workflow_instructions>` |
| Background workflow execution | FR-45 | Execute event-triggered workflows in background without taking over chat panel; manage via concurrency limiter |
| Concurrency management | FR-45 | Global concurrency limit (default: 3, configurable) for background workflow executions; FIFO queue for overflow |
| Debounce engine | FR-47, FR-48, FR-48b | Per-note-path cooldown tracking; configurable default (5s); prune expired entries |
| Infinite loop prevention | FR-51 | Track execution chain; skip re-triggering the same hook; surface "hook cycle detected" notice |
| Environment variables for vault events | FR-47–50 | `NOTOR_NOTE_PATH`, `NOTOR_TAGS_ADDED`, `NOTOR_TAGS_REMOVED` for shell command actions |

### Group G: Workflow Frontmatter Hooks (FR-52)

**Prerequisites:** Group F (vault event hooks and "run workflow" action)

| Component | FRs Covered | Description |
|---|---|---|
| Workflow `notor-hooks` frontmatter parser | FR-52 | Parse YAML mapping of lifecycle event to array of hook action definitions; validate action types and required fields |
| Runtime hook override | FR-52 | During workflow execution, replace global hooks for overridden lifecycle events; non-overridden events continue using global hooks |
| Hook revert on workflow end | FR-52 | Restore global hook configuration when workflow execution ends (success, failure, or user stop) |
| Invalid hook handling | FR-52 | Log warnings for invalid hook definitions; skip invalid, apply valid |

### Group H: Workflow Activity Indicator (FR-53)

**Prerequisites:** Groups E + F (manual and event-triggered workflow execution)

| Component | FRs Covered | Description |
|---|---|---|
| Activity indicator UI element | FR-53 | Persistent icon/badge in chat panel header; animated state when workflows running; static when idle |
| Workflow execution tracker | FR-53 | In-memory list of recent workflow executions (configurable N, default: 5); track status, trigger source, timestamps |
| Dropdown/popover list | FR-53 | Click to open list showing active and recently completed workflows; status badges (running, waiting for approval, completed, errored) |
| Conversation navigation | FR-53 | Click a workflow entry to open its conversation in the main chat panel |
| Numeric badge | FR-53 | Show count of active background workflows; hide when none running |

### Settings Additions

New settings required for Phase 4 (extends existing settings model):

| Setting | Type | Default | Description |
|---|---|---|---|
| `persona_auto_approve` | Record<string, Record<string, string>> | `{}` | Per-persona per-tool auto-approve overrides (values: `"global"`, `"approve"`, `"deny"`) |
| `vault_event_hooks` | VaultEventHookConfig | `{ on_note_open: [], ... }` | Vault event hook configurations grouped by event type |
| `vault_event_debounce_seconds` | number | `5` | Debounce cooldown for vault event hooks (seconds) |
| `workflow_concurrency_limit` | number | `3` | Maximum simultaneous background workflow executions |
| `workflow_activity_indicator_count` | number | `5` | Number of recent workflow executions to display in the activity indicator |

---

## Implementation Readiness Validation

### Technical Completeness Check

- [x] Technology choices made and documented
- [x] R-1: Cron scheduling library evaluated — `croner` v10.x selected
- [x] R-2: Manual save detection mechanism validated — `app.commands.executeCommandById` monkey-patch confirmed
- [x] R-3: Tag change detection strategy defined — shadow cache with eager init, `parseFrontMatterTags`, Set-based diff
- [x] R-4: Slash-command autocomplete approach determined — `AbstractInputSuggest<T>` on existing contenteditable
- [x] Data model covers all functional requirements (see data-model.md)
- [x] Contracts defined for new systems (see contracts/)
- [x] Security requirements addressed (vault-scoped `<include_note>`, Plan/Act enforcement, loop prevention)
- [x] Performance considerations documented (NFR-10: discovery times, non-blocking hooks, lazy listeners)
- [x] Integration points defined (Obsidian APIs, existing Notor systems, cron library)

### Quality Validation

- [x] Architecture extends existing Phase 0–3 systems without breaking changes
- [x] Security model addresses new surfaces (persona auto-approve escalation, hook loops, vault-scoped includes)
- [x] Data model supports all business rules
- [x] Design follows established patterns (file-based config, XML context injection, grouped settings UI)
- [x] Documentation complete for all major decisions

---

## Risk Assessment

### Technical Risks

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| ~~**Cron library too large or incompatible with esbuild**~~ | ~~Medium~~ | ~~Low~~ | ✅ **Mitigated by R-1:** `croner` v10.x confirmed — 8.1 KB gzipped, zero deps, bundles cleanly with esbuild, fully browser/Electron-safe |
| ~~**Manual save detection unreliable across platforms**~~ | ~~Medium~~ | ~~Medium~~ | ✅ **Mitigated by R-2:** `app.commands.executeCommandById` monkey-patch confirmed reliable on all desktop platforms; graceful degradation if unavailable; desktop-only (mobile all-autosave documented) |
| ~~**Tag change detection race conditions**~~ | ~~Medium~~ | ~~Medium~~ | ✅ **Mitigated by R-3:** Shadow cache with eager init eliminates first-event false positives; `parseFrontMatterTags` avoids inline tag false positives; `TagChangeSuppressionManager` with two-phase cleanup prevents loops; no race conditions possible (interceptor is synchronous) |
| ~~**Slash-command autocomplete complexity in custom view**~~ | ~~Low~~ | ~~Medium~~ | ✅ **Mitigated by R-4:** `AbstractInputSuggest<T>` on existing contenteditable div; proven pattern already in use (`VaultNoteSuggest`); ~150 lines new code; no new dependencies |
| **Background workflow execution state management** | Medium — orphaned workflows, resource leaks | Low | Bounded concurrency limit; cleanup on plugin unload; skip-if-running prevents accumulation |
| **Infinite loop detection edge cases** | High — runaway LLM conversations | Low | Execution chain tracking + per-workflow single-instance guard; conservative approach (skip with notice) |
| **Persona `system-prompt.md` with invalid YAML** | Low — persona excluded | Medium | Graceful exclusion with warning; other personas unaffected |
| **Workflow frontmatter `notor-hooks` complex YAML parsing** | Low — workflow hooks silently skipped | Medium | Validate at discovery time; log warnings for invalid definitions; skip invalid, apply valid |

### Dependencies and Assumptions

- **External dependencies:** `croner` v10.x (27.3 KB minified / 8.1 KB gzipped npm package); no other new runtime dependencies
- **Existing system dependencies:** Phase 4 builds on Phase 0 (LLM providers, streaming, settings, system prompt), Phase 1 (tool dispatch, Plan/Act mode, chat panel, auto-approve), Phase 2 (JSONL history, checkpoints, frontmatter tools, vault rules), and Phase 3 (hook engine, shell execution, attachment system, auto-context, message assembly)
- **Technical assumptions:** `metadataCache.getFirstLinkpathDest()` reliably resolves wikilinks in non-editor contexts (i.e., when the wikilink appears in a `path` attribute rather than standard Markdown link syntax); `app.commands` supports command interception for manual save detection; `metadataCache.on('changed', ...)` provides access to new frontmatter state (previous state requires a shadow cache); Obsidian's event system fires `file-open`, `create`, and `modify` events in a deterministic order; cron library runs reliably in Electron's renderer process
- **Business assumptions:** Users create persona and workflow directories manually (no creation wizard in Phase 4); users familiar with YAML frontmatter for workflow configuration; cron expressions are a familiar concept for power users configuring scheduled hooks
- **Mobile considerations:** Vault event hooks, personas, workflows, and `<include_note>` resolution all work on mobile (vault API and metadata cache are available). `on-manual-save` is effectively desktop-only — mobile has no save shortcut and all saving is via auto-save (confirmed by R-2); scheduled hooks only fire while the app is active. Shell command hook actions are desktop-only (gated behind `Platform.isDesktop`).

---

## Next Phase Preparation

### Task Breakdown Readiness

- [x] Clear technology choices and architecture
- [x] Complete data model and contract specifications
- [x] Development environment and tooling defined
- [x] Quality standards and testing approach specified
- [x] Integration requirements and dependencies clear

### Implementation Prerequisites

- [x] R-1: Cron scheduling library research complete — `croner` v10.x selected
- [x] R-2: Manual save detection research complete — `app.commands` monkey-patch confirmed
- [x] R-3: Tag change detection research complete — shadow cache + `parseFrontMatterTags` + Set-based diff
- [x] R-4: Slash-command autocomplete research complete — `AbstractInputSuggest<T>` on existing contenteditable
- [x] Development environment requirements specified (see quickstart.md)
- [x] Existing Phase 0–3 infrastructure available as foundation
- [x] Quality assurance approach defined (e2e tests with Playwright, manual testing)

### Recommended Implementation Order

Feature groups have the following dependency relationships:

```
A (Personas) ──────────────────────┐
                                   │
D (<include_note>) ────────────────┼──▶ E (Manual Workflow Execution) ──┐
                                   │                                    │
C (Workflow Discovery) ────────────┘                                    │
                                                                        │
B (Per-Persona Auto-Approve) ──── depends on A                         │
                                                                        │
F (Vault Event Hooks) ──── depends on C + E ──▶ G (Workflow Frontmatter Hooks)
                                                                        │
H (Workflow Activity Indicator) ──── depends on E + F ◀────────────────┘
```

**Recommended order:**
1. **A (Personas)** — foundational; enables persona picker, system prompt integration, and provider/model switching
2. **C (Workflow Discovery)** — foundational; standalone scanning with no UI dependencies
3. **D (`<include_note>` Tag)** — standalone utility; needed by A (persona prompts), E (workflow assembly), and existing system prompt/vault rules
4. **B (Per-Persona Auto-Approve)** — depends on A; Settings UI sub-page and runtime override logic
5. **E (Manual Workflow Execution)** — depends on A + C + D; command palette, slash-command UX, prompt assembly, conversation creation
6. **F (Vault Event Hooks)** — depends on C + E; event listeners, debounce, background execution, concurrency management
7. **G (Workflow Frontmatter Hooks)** — depends on F; extends hook override mechanism
8. **H (Workflow Activity Indicator)** — depends on E + F; UI element for background workflow visibility
