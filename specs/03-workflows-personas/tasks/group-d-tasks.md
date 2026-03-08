# Task Breakdown: Group D — `<include_note>` Tag Resolution

**Created:** 2026-08-03
**Implementation Plan:** [specs/03-workflows-personas/plan.md](../plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](../spec.md)
**Contract:** [specs/03-workflows-personas/contracts/include-note-tag.md](../contracts/include-note-tag.md)
**Status:** Planning

## Task Summary

**Total Tasks:** 12
**Phases:** 5 (Types → Parsing → Resolution → Integration → Validation)
**FRs Covered:** FR-46
**Estimated Complexity:** Medium
**Parallel Execution Opportunities:** 3 task groups

## Dependency Graph

```
D-001 (IncludeNoteTag types)
  │
  └──▶ D-002 (Tag parser — regex extraction)
          │
          ├──▶ D-003 (Path resolution — vault-relative)
          │       │
          │       └──▶ D-005 (Section extraction)
          │               │
          │               └──▶ D-007 (Frontmatter stripping)
          │                       │
          │                       └──▶ D-008 (Inline vs attached modes)
          │
          └──▶ D-004 [P] (Path resolution — wikilink)
                  │
                  └──▶ D-005 (converges)

D-008 ──▶ D-009 (Error handling & edge cases)
              │
              ├──▶ D-010 (System prompt & vault rules integration)
              │
              ├──▶ D-011 [P] (Test vault fixtures & manual validation)
              │
              └──▶ D-012 (Final wiring & validation)
```

---

## Phase 0: Types & Interfaces

### D-001: Define IncludeNoteTag types

**Description:** Add the `IncludeNoteTag` parsed representation interface, `IncludeNotePathType` type, `IncludeNoteMode` type, and the `IncludeNoteResolutionResult` type to the codebase. These types describe the intermediate parsed form of an `<include_note>` tag before resolution and the output after resolution.

**Files:**
- `src/types.ts` — Add `IncludeNoteTag`, `IncludeNotePathType`, `IncludeNoteMode`, and `IncludeNoteResolutionResult` types

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `IncludeNotePathType` type defined: `"vault_relative" | "wikilink"`
- [ ] `IncludeNoteMode` type defined: `"inline" | "attached"`
- [ ] `IncludeNoteTag` interface defined per data-model.md: `raw_tag` (string), `path` (string), `path_type` (IncludeNotePathType), `section` (string | null), `mode` (IncludeNoteMode), `strip_frontmatter` (boolean)
- [ ] `IncludeNoteResolutionResult` interface defined: `inlineContent` (string — text with inline tags resolved), `attachments` (array of `{ path: string; section: string | null; content: string }` — collected attached-mode entries)
- [ ] All types exported from `src/types.ts`
- [ ] TypeScript compiles cleanly with `npm run build`

---

## Phase 1: Tag Parsing

### D-002: Tag parser — regex extraction and attribute parsing

**Description:** Implement the regex-based parser that finds all `<include_note ... />` tags in a given text string and extracts their attributes into `IncludeNoteTag` objects. This is a pure-function parser with no vault access — it operates entirely on the raw text.

**Files:**
- `src/include-note/parser.ts` — New file

**Dependencies:** D-001

**Acceptance Criteria:**
- [ ] `parseIncludeNoteTags(text: string): IncludeNoteTag[]` function exported
- [ ] Uses regex `/<include_note\s+([^>]*?)\s*\/>/g` to find all self-closing `<include_note ... />` tags (per contract)
- [ ] Extracts attributes from each tag using `(\w+)\s*=\s*"([^"]*)"/g` (double-quoted values only; single-quoted values are not supported per contract)
- [ ] `path` attribute: required — if missing or empty, the tag is excluded from the returned array (left as-is in source text)
- [ ] `path_type` detection: if `path` value contains `[[` → `"wikilink"`, otherwise → `"vault_relative"`
- [ ] `section` attribute: defaults to `null` if absent
- [ ] `mode` attribute: defaults to `"inline"` if absent; unrecognized values default to `"inline"`
- [ ] `strip_frontmatter` attribute: defaults to `true`; only the exact string `"false"` sets it to `false`
- [ ] `raw_tag` captures the full original tag text (for replacement during resolution)
- [ ] Attributes not in the supported set (`path`, `section`, `mode`, `strip_frontmatter`) are silently ignored
- [ ] Returns an array of `IncludeNoteTag` objects in the order they appear in the text
- [ ] Handles edge cases: tags with extra whitespace, attributes in any order, tags spanning one line or multiple lines (regex handles `\s` which includes newlines)
- [ ] Pure function — no side effects, no vault access

---

## Phase 2: Resolution

### D-003: Path resolution — vault-relative paths

**Description:** Implement the vault-relative path resolution branch. Given a `path` attribute value that is a plain file path (not a wikilink), resolve it to a `TFile` via the Obsidian vault API.

**Files:**
- `src/include-note/resolver.ts` — New file

**Dependencies:** D-002

**Acceptance Criteria:**
- [ ] `resolveIncludeNotePath(tag: IncludeNoteTag, vault: Vault, metadataCache: MetadataCache, sourceFilePath: string): TFile | null` function exported
- [ ] For `path_type === "vault_relative"`: calls `vault.getAbstractFileByPath(tag.path)` and checks the result is a `TFile` (not a `TFolder`)
- [ ] Returns `null` if the path does not resolve to a file (triggers error marker in D-009)
- [ ] Vault-scoping security check: after resolution, verifies the resolved file's path does not escape the vault (defensive — Obsidian's API inherently scopes to vault, but this guard prevents edge cases)
- [ ] Delegates to wikilink resolution (D-004) when `path_type === "wikilink"`
- [ ] Handles paths with and without `.md` extension gracefully

### D-004 [P]: Path resolution — wikilink paths

**Description:** Implement the wikilink path resolution branch. Given a `path` attribute value wrapped in `[[...]]`, strip the brackets and resolve using Obsidian's `metadataCache.getFirstLinkpathDest()`.

**Files:**
- `src/include-note/resolver.ts` — Add wikilink resolution branch

**Dependencies:** D-002 (can be developed in parallel with D-003)

**Acceptance Criteria:**
- [ ] For `path_type === "wikilink"`: strips `[[` and `]]` from the path value using `path.replace(/^\[\[|\]\]$/g, "")`
- [ ] Calls `metadataCache.getFirstLinkpathDest(linkPath, sourceFilePath)` with the stripped link path and the source file's vault-relative path for disambiguation context
- [ ] Returns the resolved `TFile` or `null` if the wikilink resolves to nothing
- [ ] Handles wikilinks with subdirectory hints (e.g., `[[Research/Topic A]]`)
- [ ] Handles wikilinks with just a note name (e.g., `[[Topic A]]`) — relies on Obsidian's default resolution order
- [ ] Does not warn on ambiguous note names — uses Obsidian's default resolution (same as `getFirstLinkpathDest()` behavior per spec)

### D-005: Section extraction

**Description:** Implement section extraction logic that, given a `TFile` and a heading name, extracts content from that heading to the next heading of equal or higher level (or end of file). Uses Obsidian's metadata cache headings.

**Files:**
- `src/include-note/resolver.ts` — Add `extractSection()` function

**Dependencies:** D-003 (or D-004 — needs a resolved `TFile`)

**Acceptance Criteria:**
- [ ] `extractSection(content: string, sectionName: string, file: TFile, metadataCache: MetadataCache): string | null` function exported
- [ ] Retrieves headings from `metadataCache.getFileCache(file)?.headings`
- [ ] Finds the first heading whose `heading` text matches `sectionName` (exact match, case-sensitive)
- [ ] Extracts content from the matched heading's `position.start.offset` to the next heading of equal or higher level's `position.start.offset`, or to the end of the content string if no such heading exists
- [ ] Returns the extracted content (including the heading line itself), trimmed
- [ ] Returns `null` if the heading is not found in the file's headings (triggers error marker in D-009)
- [ ] Handles files with no headings (returns `null` if `section` is specified)
- [ ] Handles the last heading in a file (extracts to end of content)
- [ ] Section offsets are computed against the full file content (before frontmatter stripping) — coordinate with D-007 to ensure offset math is correct when `strip_frontmatter` is true

### D-006: Note content reading

**Description:** Implement the note content reading step — read the full content of a resolved `TFile` from the vault. This is a small utility that encapsulates `vault.read()` with error handling.

**Files:**
- `src/include-note/resolver.ts` — Add `readNoteContent()` helper

**Dependencies:** D-003

**Acceptance Criteria:**
- [ ] `readNoteContent(file: TFile, vault: Vault): Promise<string>` function exported
- [ ] Calls `vault.read(file)` and returns the raw content string
- [ ] Returns the full content including frontmatter (frontmatter stripping is a separate step in D-007)
- [ ] Throws or returns null on read failure (caught by error handling in D-009)
- [ ] No caching — always reads the latest content from vault (per contract: "Tags are always resolved with the latest note content — there is no caching of resolved content between calls")

### D-007: Frontmatter stripping

**Description:** Implement the frontmatter stripping logic that, when `strip_frontmatter` is `true` (the default), removes the YAML frontmatter block from the note content before injection.

**Files:**
- `src/include-note/resolver.ts` — Add `stripNoteFrontmatter()` function

**Dependencies:** D-005, D-006

**Acceptance Criteria:**
- [ ] `stripNoteFrontmatter(content: string): string` function exported
- [ ] Uses Obsidian's `getFrontMatterInfo(content)` utility (from `obsidian` package) to reliably determine the frontmatter boundary
- [ ] Returns `content.slice(fmInfo.contentStart)` — the body content after the closing `---` delimiter
- [ ] If the content has no frontmatter (no leading `---`), returns the full content as-is
- [ ] When `strip_frontmatter` is `false`, this function is not called — the full raw content (including YAML block) is used
- [ ] **Section extraction coordination:** When both `section` and `strip_frontmatter` are active, section extraction runs on the full content first (using metadata cache offsets which are based on the full file), and then frontmatter stripping is applied only if the extracted section happens to start before the frontmatter boundary (edge case — normally sections are body headings that appear after frontmatter). In the common case, section extraction already produces body-only content since headings are in the body.

### D-008: Inline vs attached mode assembly

**Description:** Implement the two injection modes for resolved `<include_note>` content. In `inline` mode, the tag is replaced with the resolved content directly in the surrounding text. In `attached` mode, the tag is removed from the text and the content is collected into a separate `<attachments>` block.

**Files:**
- `src/include-note/resolver.ts` — Add mode-aware assembly logic to the main `resolveIncludeNotes()` function

**Dependencies:** D-007

**Acceptance Criteria:**
- [ ] `resolveIncludeNotes(text: string, vault: Vault, metadataCache: MetadataCache, sourceFilePath: string, context: "workflow" | "system_prompt" | "vault_rule"): Promise<IncludeNoteResolutionResult>` function exported — this is the main public API
- [ ] **Inline mode (`mode="inline"`):** The `<include_note ... />` tag in the text is replaced with the resolved content directly. The surrounding text flows naturally around the injected content.
- [ ] **Attached mode (`mode="attached"`):** The `<include_note ... />` tag in the text is replaced with an empty string. The resolved content is added to the `attachments` array in the result as a `<vault-note>` element:
  ```xml
  <vault-note path="{resolved-path}" section="{section-if-specified}">
  {resolved content}
  </vault-note>
  ```
- [ ] Multiple attached-mode tags are collected into a single `attachments` array — the caller wraps them in an `<attachments>` block
- [ ] **Context-specific rules enforced:** When `context` is `"system_prompt"` or `"vault_rule"`, the `mode` attribute is ignored and all tags are resolved as `inline` (per contract and FR-46). When `context` is `"workflow"`, both modes are supported.
- [ ] Tags are resolved in order of appearance in the text — earlier tags don't affect the offsets of later tags (use string replacement on the `raw_tag` match, not offset-based replacement)
- [ ] **No nested resolution:** If resolved content itself contains `<include_note>` tags, they are passed through as literal text (single-pass resolution per contract)
- [ ] The `inlineContent` field of the result contains the text with all inline-resolved tags replaced and attached-mode tags removed
- [ ] The `attachments` field contains the collected attached-mode entries (empty array if none)

---

## Phase 3: Error Handling & Edge Cases

### D-009: Error handling and error markers

**Description:** Implement comprehensive error handling for all resolution failure modes. Unresolvable tags are replaced with inline error markers per the contract, and failures do not abort the rest of the resolution pipeline.

**Files:**
- `src/include-note/resolver.ts` — Add error handling throughout the resolution pipeline

**Dependencies:** D-008

**Acceptance Criteria:**
- [ ] **Note not found (vault-relative):** Tag replaced with `[include_note error: note '{path}' not found]`
- [ ] **Note not found (wikilink):** Tag replaced with `[include_note error: note '[[{path}]]' not found]` (preserves wikilink syntax in the error)
- [ ] **Section not found:** Tag replaced with `[include_note error: section '{section}' not found in '{path}']` (uses the resolved file path, not the original path attribute)
- [ ] **Path resolves outside vault:** Treated identically to "note not found" — same error marker (vault-scoping check from D-003)
- [ ] **File read failure:** Tag replaced with `[include_note error: note '{path}' not found]` (generic "not found" — no internal error details leaked)
- [ ] Error markers are inserted inline at the position of the original tag — the surrounding text is unaffected
- [ ] **Partial resolution:** If one tag fails, other tags in the same document continue to resolve normally. Resolution never aborts due to a single failure.
- [ ] Each error is logged via `logger("IncludeNoteResolver")` at `warn` level with details (path, section, error type) for debugging
- [ ] **Missing `path` attribute:** Tags without a `path` attribute are left as-is in the text (not replaced with an error marker) — this was handled in D-002 by excluding them from the parsed array

---

## Phase 4: Integration & Validation

### D-010: Integration with system prompt assembly and vault rules

**Description:** Wire `resolveIncludeNotes()` into the existing system prompt assembly pipeline (`SystemPromptBuilder`) and vault rule evaluation (`VaultRuleManager`). After this task, `<include_note>` tags in the global system prompt, persona system prompts, and vault-level rule files are resolved automatically before each LLM API call.

**Files:**
- `src/chat/system-prompt.ts` — Call `resolveIncludeNotes()` on the base prompt content and persona prompt content
- `src/rules/vault-rules.ts` — Call `resolveIncludeNotes()` on each rule file's body content during evaluation

**Dependencies:** D-009

**Acceptance Criteria:**
- [ ] **System prompt integration:** In `SystemPromptBuilder.getBasePrompt()`, after reading the custom system prompt file content (or getting the default), call `resolveIncludeNotes(content, vault, metadataCache, customPromptPath, "system_prompt")` to resolve any `<include_note>` tags. Use only `inlineContent` from the result (attached mode ignored in system prompt context).
- [ ] **Persona prompt integration:** In the persona prompt section of `SystemPromptBuilder.assemble()` (to be added by Group A's A-006), resolve `<include_note>` tags in the persona's `prompt_content` using `resolveIncludeNotes(promptContent, vault, metadataCache, persona.system_prompt_path, "system_prompt")`. Use only `inlineContent`.
- [ ] **Vault rules integration:** In `VaultRuleManager.getActiveRuleContent()` (or at the point where each rule's body content is assembled), call `resolveIncludeNotes(rule.content, vault, metadataCache, rule.file_path, "vault_rule")` for each applicable rule. Use only `inlineContent`.
- [ ] `SystemPromptBuilder` constructor is extended to accept `MetadataCache` in addition to `Vault` (needed for wikilink resolution and section extraction)
- [ ] `VaultRuleManager` already has access to `App` (which provides both `vault` and `metadataCache`) — no constructor change needed
- [ ] Resolution errors in system prompts and vault rules produce inline error markers visible to the LLM — the rest of the prompt assembles normally
- [ ] Performance: resolution is fast enough to not noticeably delay system prompt assembly (per NFR-10: <200 ms for up to 20 tags)
- [ ] Backward-compatible: when no `<include_note>` tags are present, existing behavior is unchanged (the resolver returns the original text unmodified)
- [ ] **Note:** Workflow body resolution (Group E) is NOT wired here — Group E's prompt assembly task will call `resolveIncludeNotes()` directly with context `"workflow"`

### D-011 [P]: Test vault fixtures and Playwright E2E validation

**Description:** Create test notes and `<include_note>` usage examples in the e2e test vault, and build a Playwright E2E test script (`e2e/scripts/include-note-test.ts`) to validate all resolution paths: vault-relative paths, wikilinks, section extraction, frontmatter stripping, error cases, and nested tag pass-through. The E2E test launches Obsidian, triggers system prompt assembly and/or sends a message that exercises `<include_note>` resolution, then verifies correct resolution via structured logs (the `IncludeNoteResolver` logger source) and assembled prompt content.

**Files:**
- `e2e/test-vault/Research/Climate.md` — Test note with multiple headings (target for section extraction)
- `e2e/test-vault/Research/Energy.md` — Test note with frontmatter and body content
- `e2e/test-vault/notor/prompts/core-system-prompt.md` — Extended with `<include_note>` tags for system prompt integration testing
- `e2e/test-vault/notor/rules/include-test-rule.md` — Test rule file with `<include_note>` tags
- `e2e/scripts/include-note-test.ts` — New Playwright E2E test script

**Dependencies:** D-009 (can be developed in parallel with D-010)

**Acceptance Criteria:**
- [ ] **E2E test script created:** `e2e/scripts/include-note-test.ts` follows the established pattern (build → launch Obsidian → connect Playwright via CDP → `LogCollector` → structured log verification → screenshots → results JSON)
- [ ] `Research/Climate.md` created with frontmatter (tags, title) and multiple headings (`## Key Findings`, `## Methodology`, `## Conclusions`) — each heading has distinct body content
- [ ] `Research/Energy.md` created with frontmatter and body content — used for full-note inclusion tests
- [ ] **Vault-relative path test (E2E):** Structured logs confirm `<include_note path="Research/Climate.md" section="Key Findings" />` resolved successfully with correct section content
- [ ] **Wikilink test (E2E):** Structured logs confirm `<include_note path="[[Climate]]" section="Key Findings" />` resolved via wikilink to the same section
- [ ] **Full note inclusion test (E2E):** Structured logs confirm `<include_note path="Research/Energy.md" />` resolved to full body content (frontmatter stripped by default)
- [ ] **Frontmatter preserved test (E2E):** Structured logs confirm `<include_note path="Research/Energy.md" strip_frontmatter="false" />` resolved with YAML frontmatter intact
- [ ] **Missing note test (E2E):** Structured logs confirm warn-level entry from IncludeNoteResolver for `Research/Deleted.md` not found; error marker present in resolved text
- [ ] **Missing section test (E2E):** Structured logs confirm warn-level entry from IncludeNoteResolver for section `Nonexistent` not found; error marker present in resolved text
- [ ] **Nested tag pass-through test (E2E):** If `Research/Climate.md` contains an `<include_note>` tag in its body, structured logs confirm single-pass resolution (nested tag passed through as literal text)
- [ ] **System prompt integration test (E2E):** `notor/prompts/core-system-prompt.md` with an `<include_note>` tag — structured logs confirm resolution during system prompt assembly
- [ ] **Vault rule integration test (E2E):** `notor/rules/include-test-rule.md` with `notor-always-include: true` and an `<include_note>` tag — structured logs confirm resolution during rule evaluation
- [ ] No error-level structured logs from IncludeNoteResolver source during test execution (E2E)

### D-012: Final wiring and Playwright E2E validation

**Description:** End-to-end Playwright-based validation of the complete `<include_note>` system across all integration points (system prompts, vault rules). The D-011 E2E test script covers individual resolution paths; this task extends validation to the full integration by verifying that assembled system prompts contain correctly resolved `<include_note>` content via structured logs. Ensure backward compatibility, performance, and correct error handling. Clean up any remaining issues.

**Files:**
- All files from D-001 through D-011 (review and polish)

**Dependencies:** D-010, D-011

**Acceptance Criteria:**
- [ ] **System prompt with `<include_note>` validated (E2E):** D-011 E2E test verifies structured logs confirm system prompt assembly includes resolved `<include_note>` content from custom system prompt file
- [ ] **Vault rule with `<include_note>` validated (E2E):** D-011 E2E test verifies structured logs confirm rule file body with `<include_note>` tags resolves correctly during rule evaluation
- [ ] **Error markers validated (E2E):** Structured logs confirm warn-level entries for missing note/section; error markers present in assembled prompt content
- [ ] **Frontmatter stripping validated (E2E):** Structured logs confirm default stripping behavior and `strip_frontmatter="false"` preservation
- [ ] **Section extraction validated (E2E):** Structured logs confirm section boundaries are correct — content runs from target heading to next heading of equal or higher level
- [ ] **Wikilink resolution validated (E2E):** Structured logs confirm wikilink paths resolve correctly via Obsidian's metadata cache
- [ ] **Nested tags validated (E2E):** Structured logs confirm single-pass resolution — nested `<include_note>` tags in included content passed through as literal text
- [ ] **No `<include_note>` tags scenario validated (E2E):** Documents without tags pass through unchanged — no IncludeNoteResolver structured log entries emitted
- [ ] **Multiple tags in one document validated (E2E):** Structured logs confirm multiple tags in the same document each resolve independently
- [ ] **Performance validated (E2E):** Resolution of 5+ tags completes without perceptible delay (no timeout errors in E2E test)
- [ ] Build succeeds: `npm run build` produces clean `main.js`
- [ ] No TypeScript errors: `npx tsc --noEmit` passes
- [ ] No error-level structured logs from IncludeNoteResolver during test execution
- [ ] **Note:** Attached mode and workflow integration will be validated as part of Group E tasks — this validation focuses on inline mode and system prompt / vault rule contexts

---

## Cross-Reference: Files Created and Modified

### New Files
| File | Tasks | Description |
|---|---|---|
| `src/include-note/parser.ts` | D-002 | Regex-based tag parser — finds and extracts `<include_note>` tags from text |
| `src/include-note/resolver.ts` | D-003, D-004, D-005, D-006, D-007, D-008, D-009 | Path resolution, section extraction, frontmatter stripping, mode assembly, error handling |

### Modified Files
| File | Tasks | Changes |
|---|---|---|
| `src/types.ts` | D-001 | Add `IncludeNoteTag`, `IncludeNotePathType`, `IncludeNoteMode`, `IncludeNoteResolutionResult` types |
| `src/chat/system-prompt.ts` | D-010 | Accept `MetadataCache` in constructor; call `resolveIncludeNotes()` on base prompt and persona prompt content |
| `src/rules/vault-rules.ts` | D-010 | Call `resolveIncludeNotes()` on each rule file's body content during evaluation |

### Test Vault Files
| File | Tasks | Description |
|---|---|---|
| `e2e/test-vault/Research/Climate.md` | D-011 | Test note with multiple headings for section extraction |
| `e2e/test-vault/Research/Energy.md` | D-011 | Test note with frontmatter for inclusion and stripping tests |
| `e2e/test-vault/notor/prompts/core-system-prompt.md` | D-011 | Extended with `<include_note>` tags for system prompt testing |
| `e2e/test-vault/notor/rules/include-test-rule.md` | D-011 | Test rule file with `<include_note>` tags |

### E2E Test Files
| File | Tasks | Description |
|---|---|---|
| `e2e/scripts/include-note-test.ts` | D-011 | Playwright E2E test: `<include_note>` resolution paths, section extraction, error markers, structured log verification |

---

## Parallel Execution Opportunities

The following task groups can be executed in parallel:

1. **After D-002 completes:** D-003 (vault-relative resolution) and D-004 (wikilink resolution) can proceed simultaneously since they are independent resolution branches that converge in the same file
2. **After D-009 completes:** D-010 (integration) and D-011 (test fixtures) can proceed in parallel since D-010 wires the resolver into existing code while D-011 creates test data independently
3. **Within Phase 2:** D-006 (note content reading) is a small utility that can be implemented alongside D-005 (section extraction) since they are independent helper functions within the resolver module

## Critical Path

```
D-001 → D-002 → D-003 → D-005 → D-007 → D-008 → D-009 → D-010 → D-012
```

The longest dependency chain runs through types → parser → vault-relative resolution → section extraction → frontmatter stripping → mode assembly → error handling → integration → final validation. Wikilink resolution (D-004), note reading (D-006), and test fixtures (D-011) can be developed in parallel with this main chain.

## Integration Points with Other Groups

Group D provides the `<include_note>` resolution utility that several groups consume:

- **Group A (Persona System):** Persona system prompts support `<include_note>` tags (inline mode only). Task A-006 (system prompt integration) depends on the `resolveIncludeNotes()` function being available. The integration is wired in D-010 — when the persona prompt path is passed to the resolver, persona prompts with `<include_note>` tags resolve automatically.
- **Group E (Manual Workflow Execution):** Workflow prompt assembly (FR-44) calls `resolveIncludeNotes()` with context `"workflow"` to resolve tags in workflow bodies before wrapping in `<workflow_instructions>`. Both `inline` and `attached` modes are supported in this context. Group E wires this directly — it is NOT wired in D-010.
- **Existing system prompt assembly (`src/chat/system-prompt.ts`):** D-010 wires `<include_note>` resolution into the base prompt reading path. Tags in the global custom system prompt file resolve before the prompt is assembled.
- **Existing vault rules (`src/rules/vault-rules.ts`):** D-010 wires `<include_note>` resolution into rule content evaluation. Tags in vault rule file bodies resolve before the rule content is injected into the system prompt.

## Design Decisions

1. **Two-file module structure:** The `<include_note>` logic is split into `parser.ts` (pure text parsing, no vault dependencies) and `resolver.ts` (vault-aware resolution logic). This separation keeps the parser testable in isolation and follows the single-responsibility principle.
2. **String-replacement approach over offset-based:** Tags are replaced using the `raw_tag` string match rather than character offsets. This avoids the complexity of adjusting offsets as earlier tags are replaced (which changes the text length). The trade-off is a theoretical edge case where duplicate identical tags could collide, but since each `<include_note>` tag has a unique `path`+`section`+`mode` combination, this is extremely unlikely in practice. Processing order (first occurrence replaced first) handles any edge case.
3. **`context` parameter enforces mode rules:** Rather than relying on callers to remember that system prompts only support inline mode, the `resolveIncludeNotes()` function accepts a `context` parameter and enforces the mode restriction internally. This makes the API safer for all integration points.
4. **No caching of resolved content:** Per the contract, tags are always resolved with the latest note content. This ensures freshness and avoids stale content issues, at the cost of re-reading notes on every LLM API call. Given the performance target (<200 ms for 20 tags), this is acceptable.

## Readiness for Implementation

- [x] All functional requirements (FR-46) mapped to specific tasks
- [x] Complete contract available with parsing algorithm, resolution algorithm, and error handling specification
- [x] File paths and integration points identified from existing codebase (`system-prompt.ts`, `vault-rules.ts`, `message-assembler.ts`)
- [x] Dependency chain is acyclic and optimized for parallelism
- [x] Acceptance criteria are specific, measurable, and testable
- [x] Edge cases from spec.md and contract addressed (missing notes, missing sections, vault scoping, nested tags, no-frontmatter content, attached mode)
- [x] Downstream integration points documented for Groups A and E
- [x] Context-specific mode enforcement rules documented (system prompt/vault rule → always inline; workflow → both modes)
