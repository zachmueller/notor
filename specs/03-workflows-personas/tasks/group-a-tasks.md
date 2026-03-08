# Task Breakdown: Group A — Persona System

**Created:** 2026-08-03
**Implementation Plan:** [specs/03-workflows-personas/plan.md](../plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](../spec.md)
**Status:** Planning

## Task Summary

**Total Tasks:** 14
**Phases:** 5 (Types → Discovery → System Prompt Integration → UI → Polish)
**FRs Covered:** FR-37, FR-38, FR-39, FR-39a
**Estimated Complexity:** Medium
**Parallel Execution Opportunities:** 4 task groups

## Dependency Graph

```
A-001 (Persona types)
  │
  ├──▶ A-002 (Discovery service)
  │       │
  │       ├──▶ A-003 (Frontmatter parser)
  │       │       │
  │       │       └──▶ A-004 (Discovery integration tests)
  │       │
  │       └─────────────────────────────────────────┐
  │                                                  │
  ├──▶ A-005 (Persona manager)                      │
  │       │                                          │
  │       ├──▶ A-006 (System prompt integration)     │
  │       │                                          │
  │       └──▶ A-007 (Provider/model switching)      │
  │               │                                  │
  │               └──▶ A-008 [P] (Fallback & notice) │
  │                                                  │
  ├──▶ A-009 (Persona picker UI) ◀──────────────────┘
  │       │
  │       ├──▶ A-010 (Active persona label)
  │       │
  │       └──▶ A-011 (Picker rescan on activate)
  │
  └──▶ A-012 [P] (Provider/model identifier reference)
  
A-010 + A-008 + A-011 ──▶ A-013 (main.ts wiring)
                                │
                                └──▶ A-014 (Manual validation & cleanup)
```

---

## Phase 0: Types & Interfaces

### A-001: Define Persona types and extend settings interface

**Description:** Add the Persona in-memory entity interface, persona-related settings fields, and all supporting types to the codebase. This is the foundational type work that all subsequent tasks depend on.

**Files:**
- `src/types.ts` — Add `Persona` interface and `PersonaPromptMode` type
- `src/settings.ts` — Extend `NotorSettings` with `active_persona` field; add to `DEFAULT_SETTINGS`

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `Persona` interface defined per data-model.md: `name`, `directory_path`, `system_prompt_path`, `prompt_content`, `prompt_mode`, `preferred_provider`, `preferred_model`
- [ ] `PersonaPromptMode` type: `"append" | "replace"`
- [ ] `NotorSettings.active_persona` added as `string` (empty string = no persona active), defaulting to `""`
- [ ] All types exported from `src/types.ts`
- [ ] `DEFAULT_SETTINGS` updated with `active_persona: ""`
- [ ] TypeScript compiles cleanly with `npm run build`

---

## Phase 1: Discovery & Parsing

### A-002: Persona discovery service — directory scanning

**Description:** Implement the persona discovery service that scans `{notor_dir}/personas/` for subdirectories containing a `system-prompt.md` file and returns a list of discovered persona directory entries.

**Files:**
- `src/personas/persona-discovery.ts` — New file

**Dependencies:** A-001

**Acceptance Criteria:**
- [ ] `PersonaDiscoveryService` class (or exported functions) created
- [ ] `discoverPersonas(vault: Vault, notorDir: string): Promise<Persona[]>` scans `{notor_dir}/personas/` for subdirectories
- [ ] Uses `vault.getAbstractFileByPath()` to locate the personas root directory
- [ ] Filters subdirectories to those containing a `system-prompt.md` file
- [ ] Persona names derived from subdirectory names (e.g., `notor/personas/researcher/` → `"researcher"`)
- [ ] If `{notor_dir}/personas/` does not exist, returns an empty array without error
- [ ] Subdirectories without `system-prompt.md` are silently ignored
- [ ] Handles errors gracefully (logs warning, does not throw)

### A-003: Persona frontmatter parser

**Description:** Parse persona frontmatter properties (`notor-persona-prompt-mode`, `notor-preferred-provider`, `notor-preferred-model`) from the `system-prompt.md` file of each discovered persona, and populate the full `Persona` in-memory model.

**Files:**
- `src/personas/persona-discovery.ts` — Extend with frontmatter parsing logic

**Dependencies:** A-002

**Acceptance Criteria:**
- [ ] Reads frontmatter from `system-prompt.md` via `metadataCache.getFileCache()?.frontmatter`
- [ ] Parses `notor-persona-prompt-mode`: accepts `"append"` or `"replace"`; defaults to `"append"` for missing/unrecognized values; logs warning for unrecognized values
- [ ] Parses `notor-preferred-provider`: string or null (empty/omitted → null)
- [ ] Parses `notor-preferred-model`: string or null (empty/omitted → null)
- [ ] Extracts body content of `system-prompt.md` after stripping frontmatter → `prompt_content`
- [ ] Populates complete `Persona` object with all fields from data-model.md
- [ ] Malformed YAML frontmatter causes that persona to be excluded with a warning logged; other personas unaffected
- [ ] Empty `prompt_content` is allowed (persona has no custom system prompt text)

### A-004: Discovery service validation

**Description:** Validate persona discovery end-to-end by creating test persona directories in the e2e test vault and confirming correct discovery, parsing, and edge-case handling.

**Files:**
- `e2e/test-vault/notor/personas/researcher/system-prompt.md` — Test persona (append mode)
- `e2e/test-vault/notor/personas/organizer/system-prompt.md` — Test persona (with provider/model overrides)
- `e2e/test-vault/notor/personas/broken/system-prompt.md` — Test persona (invalid YAML)

**Dependencies:** A-003

**Acceptance Criteria:**
- [ ] Test persona files created per quickstart.md test vault setup instructions
- [ ] `researcher` persona: append mode, no provider/model override
- [ ] `organizer` persona: append mode, `notor-preferred-provider: "anthropic"`, `notor-preferred-model: "claude-sonnet-4-20250514"`
- [ ] `broken` persona: malformed YAML frontmatter (e.g., unbalanced quotes) — excluded from discovery with warning
- [ ] Subdirectory without `system-prompt.md` (e.g., `notor/personas/empty-dir/`) is ignored
- [ ] Discovery returns `researcher` and `organizer` but not `broken`

---

## Phase 2: Core Logic

### A-005: Persona manager — activation, switching, and revert

**Description:** Implement the `PersonaManager` class that manages the active persona state, handles switching between personas (including to "None"), and supports revert logic for workflow persona switching (Phase 4 Group E dependency).

**Files:**
- `src/personas/persona-manager.ts` — New file

**Dependencies:** A-001, A-002

**Acceptance Criteria:**
- [ ] `PersonaManager` class created with access to `Vault`, `MetadataCache`, `NotorSettings`, and `ProviderRegistry`
- [ ] `getActivePersona(): Persona | null` returns the currently active persona or null
- [ ] `activatePersona(name: string): Promise<boolean>` discovers and activates the named persona; returns false if not found
- [ ] `deactivatePersona(): void` reverts to global defaults (no persona)
- [ ] `getDiscoveredPersonas(): Promise<Persona[]>` triggers a fresh discovery scan and returns all valid personas
- [ ] Stores active persona name in settings (`active_persona`) and persists via `saveData()`
- [ ] On activation, calls `getDiscoveredPersonas()` to find the persona by name and caches the active `Persona` object
- [ ] `savePersonaState()` / `restorePersonaState()` methods for workflow persona revert (saves current persona name, restores later) — supports Group E integration
- [ ] Switching personas mid-conversation does not retroactively change earlier messages

### A-006: System prompt assembly — persona integration

**Description:** Extend `SystemPromptBuilder` to support persona system prompts in both append and replace modes. When a persona is active, the system prompt assembly pipeline incorporates the persona's prompt content.

**Files:**
- `src/chat/system-prompt.ts` — Extend `assemble()` method to accept optional persona parameter

**Dependencies:** A-005

**Acceptance Criteria:**
- [ ] `assemble()` method signature extended to accept an optional `persona: Persona | null` parameter
- [ ] When persona is null or `prompt_mode` is `"append"`: global system prompt is assembled first, then persona prompt is appended as a clearly labeled section (e.g., `## Active persona: {name}\n\n{prompt_content}`)
- [ ] When `prompt_mode` is `"replace"`: global system prompt is excluded entirely; only persona prompt is used as base prompt. Vault-level rule injections still apply regardless of mode.
- [ ] Empty persona `prompt_content` with `"append"` mode: no persona section appended (global prompt only)
- [ ] Empty persona `prompt_content` with `"replace"` mode: base prompt is empty (only vault rules and tool definitions remain)
- [ ] Token ceiling enforcement applies to the full assembled prompt (persona content included)
- [ ] Backward-compatible: when no persona is passed (or null), existing behavior is unchanged

### A-007: Provider and model switching on persona activation

**Description:** When a persona specifies `notor-preferred-provider` and/or `notor-preferred-model`, switch the active provider and model at runtime. Integrate with the existing `ProviderRegistry` to perform the switch.

**Files:**
- `src/personas/persona-manager.ts` — Add provider/model switching logic to `activatePersona()`

**Dependencies:** A-005

**Acceptance Criteria:**
- [ ] When `preferred_provider` is non-null and non-empty, call `providerRegistry.switchProvider()` to the specified provider
- [ ] When `preferred_model` is non-null and non-empty, update the active model on the provider
- [ ] On `deactivatePersona()`, revert provider and model to global defaults stored in settings (`active_provider`, provider `model_id`)
- [ ] Provider/model switch takes effect immediately for subsequent messages
- [ ] The chat view's model/provider display is updated to reflect the change (via callback/event)

### A-008 [P]: Provider/model fallback and notice handling

**Description:** Handle cases where a persona's preferred provider or model is unavailable — fall back gracefully and surface a non-blocking notice.

**Files:**
- `src/personas/persona-manager.ts` — Add fallback logic to provider/model switching

**Dependencies:** A-007

**Acceptance Criteria:**
- [ ] If `preferred_provider` is set but the provider is not configured or not available, fall back to the current default provider and surface `new Notice("Provider '{name}' not available; using default.")`
- [ ] If `preferred_model` is set but the model is not available from the active provider, fall back to the provider's current default model and surface `new Notice("Model '{name}' not available; using default.")`
- [ ] If both provider and model are unavailable, both fallbacks apply and both notices surface
- [ ] Settings not explicitly defined in persona frontmatter (null values) fall back to global defaults silently (no notice)
- [ ] Fallback does not disrupt conversation flow — the message is sent with whatever provider/model is available

---

## Phase 3: UI Components

### A-009: Persona picker UI in chat panel

**Description:** Add a persona selection dropdown to the chat panel settings area (gear icon popover), listing all discovered personas plus a "None" option. Integrate with the existing settings popover pattern in `chat-view.ts`.

**Files:**
- `src/ui/persona-picker.ts` — New file for persona picker component logic
- `src/ui/chat-view.ts` — Integrate persona picker into settings popover

**Dependencies:** A-002 (discovery), A-005 (manager)

**Acceptance Criteria:**
- [ ] Persona picker accessible from the chat settings area (gear icon), consistent with existing provider and model selectors
- [ ] Dropdown lists all discovered personas by name plus a "None" option at the top
- [ ] Selecting a persona triggers `personaManager.activatePersona(name)` — updates system prompt, provider, model
- [ ] Selecting "None" triggers `personaManager.deactivatePersona()` — reverts to global defaults
- [ ] Currently active persona is pre-selected in the dropdown when the popover opens
- [ ] Picker triggers a rescan of the personas directory each time it is activated (opened), reflecting newly created or deleted personas without plugin reload
- [ ] Dropdown is visually consistent with the existing provider/model selectors in the settings popover

### A-010: Active persona label in chat panel

**Description:** Display the currently active persona name as a visible label or badge near the chat input area, so the user always knows which persona is in effect.

**Files:**
- `src/ui/chat-view.ts` — Add persona label element and update logic
- `styles.css` — Add styling for persona label

**Dependencies:** A-009

**Acceptance Criteria:**
- [ ] A label or badge element is displayed near the chat input area showing the active persona name (e.g., "🎭 researcher")
- [ ] Label is hidden when no persona is active (persona is "None")
- [ ] Label updates immediately when the user switches personas via the picker
- [ ] Label updates when persona is switched programmatically (e.g., workflow persona switch in Group E)
- [ ] Styling is unobtrusive and visually consistent with the existing chat panel design
- [ ] Label element is registered for cleanup on view close

### A-011: Persona picker rescan on settings open

**Description:** Trigger a persona directory rescan when the Notor settings panel is opened, ensuring newly created or deleted personas are reflected in Settings as well.

**Files:**
- `src/settings.ts` — Add rescan trigger in `display()` method

**Dependencies:** A-002 (discovery)

**Acceptance Criteria:**
- [ ] When the Notor settings tab `display()` method is called, a persona rescan is triggered
- [ ] The rescan result is available for future settings UI elements (Group B will use this for persona auto-approve sub-page)
- [ ] Rescan does not block the settings UI from rendering — it can complete asynchronously
- [ ] No visible UI change in settings tab yet (persona auto-approve UI is Group B) — this task just ensures the rescan hook is in place

### A-012 [P]: Provider and model identifier reference in Settings

**Description:** Add a "Provider & model identifiers" reference section to **Settings → Notor** that lists all configured providers with their identifier strings and available models with copyable identifier strings. This helps users configure `notor-preferred-provider` and `notor-preferred-model` in persona frontmatter.

**Files:**
- `src/settings.ts` — Add `renderProviderModelReferenceSection()` method and call it from `display()`

**Dependencies:** A-001 (types only — no dependency on discovery or manager)

**Acceptance Criteria:**
- [ ] A "Provider & model identifiers" section is rendered in **Settings → Notor** (positioned near the provider sections or as a standalone subsection)
- [ ] Lists each configured provider by its identifier string (the `type` value, e.g., `"anthropic"`, `"local"`) alongside the provider's display name
- [ ] Under each provider, lists available models by their identifier string (model ID, e.g., `"claude-sonnet-4-20250514"`) alongside the model's display name
- [ ] Each identifier string has a copy-to-clipboard button/icon that copies the exact string to the user's clipboard and shows a brief "Copied" confirmation
- [ ] The reference list fetches models from the provider registry's cached model list (does not trigger a new API call)
- [ ] If a provider has no cached models, shows a message like "No models loaded — open the chat panel to refresh"
- [ ] If no providers are configured, the section displays "Configure a provider above to see available identifiers"
- [ ] Uses `navigator.clipboard.writeText()` for copy functionality

---

## Phase 4: Wiring & Validation

### A-013: Main plugin wiring — initialize and connect persona system

**Description:** Wire the persona discovery service, persona manager, and UI components together in `main.ts`. Register the persona manager with the chat orchestrator and chat view so persona state flows through the entire system.

**Files:**
- `src/main.ts` — Initialize `PersonaManager`, connect to orchestrator and view
- `src/chat/orchestrator.ts` — Accept persona manager reference; pass active persona to system prompt assembly

**Dependencies:** A-005, A-006, A-007, A-009, A-010

**Acceptance Criteria:**
- [ ] `PersonaManager` is instantiated in `onload()` with access to `vault`, `metadataCache`, settings, and `ProviderRegistry`
- [ ] `PersonaManager` is passed to `NotorChatView` (for picker and label) and `ChatOrchestrator` (for system prompt assembly)
- [ ] `ChatOrchestrator.handleUserMessage()` passes `personaManager.getActivePersona()` to `SystemPromptBuilder.assemble()` before each LLM call
- [ ] Provider/model changes from persona activation propagate to the chat view's model selector display
- [ ] On plugin unload, persona manager is cleaned up (no stale listeners or references)
- [ ] Existing conversations and non-persona flows remain fully functional (backward-compatible)
- [ ] Active persona is restored from settings on plugin load (if `active_persona` is non-empty, resolve it from discovery)

### A-014: Manual validation and final cleanup

**Description:** End-to-end manual validation of the complete persona system following the "Create and use a persona" user scenario from spec.md, plus edge case verification. Clean up any remaining issues.

**Files:**
- All files from A-001 through A-013 (review and polish)

**Dependencies:** A-013

**Acceptance Criteria:**
- [ ] **Primary flow validated:** Create persona directory → open chat panel → gear icon shows picker → select persona → persona label appears → send message → AI responds with persona prompt shaping → switch to "None" → label disappears → model/provider revert to defaults
- [ ] **Provider/model override validated:** Persona with `notor-preferred-provider` and `notor-preferred-model` switches the active provider/model; model selector in chat reflects the change
- [ ] **Replace mode validated:** Persona with `notor-persona-prompt-mode: "replace"` excludes global system prompt; only persona prompt + vault rules + tools remain
- [ ] **Fallback validated:** Persona with unavailable provider/model falls back gracefully with notice
- [ ] **Invalid persona validated:** Persona with malformed YAML is excluded from picker with warning logged
- [ ] **Missing directory validated:** No `{notor_dir}/personas/` directory → picker shows only "None", no errors
- [ ] **Provider/model reference validated:** Settings section shows providers and models with working copy buttons
- [ ] **Rescan validated:** Create new persona while plugin is running → open picker → new persona appears without reload
- [ ] Build succeeds: `npm run build` produces clean `main.js`
- [ ] No TypeScript errors: `npx tsc --noEmit` passes
- [ ] No console errors during normal operation

---

## Cross-Reference: Files Created and Modified

### New Files
| File | Tasks | Description |
|---|---|---|
| `src/personas/persona-discovery.ts` | A-002, A-003 | Persona directory scanning and frontmatter parsing |
| `src/personas/persona-manager.ts` | A-005, A-007, A-008 | Active persona state, switching, provider/model management |
| `src/ui/persona-picker.ts` | A-009 | Persona selection dropdown component |

### Modified Files
| File | Tasks | Changes |
|---|---|---|
| `src/types.ts` | A-001 | Add `Persona` interface, `PersonaPromptMode` type |
| `src/settings.ts` | A-001, A-011, A-012 | Add `active_persona` setting, rescan hook, provider/model reference section |
| `src/chat/system-prompt.ts` | A-006 | Extend `assemble()` for persona prompt append/replace |
| `src/chat/orchestrator.ts` | A-013 | Accept persona manager, pass active persona to system prompt |
| `src/ui/chat-view.ts` | A-009, A-010 | Persona picker in settings popover, active persona label |
| `styles.css` | A-010 | Persona label styling |
| `src/main.ts` | A-013 | Initialize and wire persona manager |

### Test Vault Files
| File | Tasks | Description |
|---|---|---|
| `e2e/test-vault/notor/personas/researcher/system-prompt.md` | A-004 | Test persona (append mode) |
| `e2e/test-vault/notor/personas/organizer/system-prompt.md` | A-004 | Test persona (provider/model override) |
| `e2e/test-vault/notor/personas/broken/system-prompt.md` | A-004 | Test persona (invalid YAML) |

---

## Parallel Execution Opportunities

The following task groups can be executed in parallel:

1. **After A-001 completes:** A-002 (discovery) and A-012 (provider/model reference) can proceed simultaneously since they have no mutual dependencies
2. **After A-005 completes:** A-006 (system prompt), A-007 (provider switching), and A-009 (picker UI) can proceed in parallel
3. **After A-007 completes:** A-008 (fallback logic) can proceed in parallel with A-009/A-010 (UI work)
4. **After A-009 completes:** A-010 (label) and A-011 (rescan) can proceed in parallel

## Critical Path

```
A-001 → A-002 → A-003 → A-005 → A-006 → A-013 → A-014
```

The longest dependency chain runs through types → discovery → parsing → manager → system prompt integration → wiring → validation. Provider/model switching (A-007, A-008), UI components (A-009, A-010, A-011), and settings reference (A-012) can be developed in parallel with the core logic chain.

## Readiness for Implementation

- [x] All functional requirements (FR-37, FR-38, FR-39, FR-39a) mapped to specific tasks
- [x] File paths and integration points identified from existing codebase
- [x] Dependency chain is acyclic and optimized for parallelism
- [x] Acceptance criteria are specific, measurable, and testable
- [x] Edge cases from spec.md addressed (invalid YAML, missing directory, unavailable provider/model)
- [x] Group E integration point identified (persona save/restore for workflow persona switching)
