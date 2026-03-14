# Plan: Obsidian Plugin Review Bot Feedback

**Created:** 2026-03-14
**Source:** Automated scan results in `obsidian-feedback.md`
**Builds on:** `specs/ZZ-guidelines-cleanup/tasks.md` (GUIDE-001 through GUIDE-010)

## Overview

The review bot identified issues across two severity tiers. All issues in the **Required** section must be resolved before the plugin can be accepted. The **Optional** section contains unused-variable warnings that are good to clean up but not blocking.

Existing tasks (GUIDE-001 to GUIDE-010) addressed earlier pre-submission audit findings. Several bot findings partially overlap with those tasks (sentence case, heading API, console logging) but expose additional violations not caught in the first pass.

New tasks are numbered GUIDE-011 onward.

---

## Issue-to-Task Mapping

### Required Issues

| Bot Finding | Task | Notes |
|---|---|---|
| Async methods with no `await` (writeSummary, get, set, delete, execute, onOpen, onClose, initialize, discoverWorkflows, renderBedrockConnectionTestButton) | GUIDE-017 | Remove `async` or add actual await |
| Hardcoded `.obsidian` path — use `Vault#configDir` | GUIDE-019 | 7 occurrences across e2e + src/settings |
| Disallowed console methods (only warn/error/debug allowed) | GUIDE-025 | 35 occurrences — mostly e2e files, 1 in logger.ts |
| Unexpected empty object pattern | GUIDE-022 | 1 occurrence: e2e/lib/obsidian-fixture.ts:L92 |
| Unnecessary escape character: `[` | GUIDE-022 | 1 occurrence: src/chat/conversation.ts:L350 |
| Floating Promises (no await, .catch, or void) | GUIDE-013 | 13 occurrences across chat, settings, ui |
| Undescribed eslint-disable directive comments | GUIDE-014 | 8 occurrences — add reason text to each |
| Unnecessary type assertions | GUIDE-015 | 30 occurrences — remove `as X` where type already matches |
| Promise returned in void-context function argument | GUIDE-013 | 16 occurrences — wrap with `void` or convert handler to async |
| Unnecessary try/catch wrapper | GUIDE-022 | 1 occurrence: src/chat/orchestrator.ts:L789–L822 |
| Lexical declaration in case block | GUIDE-022 | 1 occurrence: src/chat/orchestrator.ts:L1614 |
| Avoid casting to `TFile` — use `instanceof TFile` | GUIDE-016 | 6 occurrences |
| Avoid casting to `TFolder` — use `instanceof TFolder` | GUIDE-016 | 4 occurrences |
| Unexpected aliasing of `this` to local variable | GUIDE-022 | 1 occurrence: src/hooks/manual-save-detector.ts:L134 |
| Expected assignment or function call (no-unused-expressions) | GUIDE-022 | 1 occurrence: src/main.ts:L329 |
| Disabling `@typescript-eslint/no-explicit-any` not allowed | GUIDE-014 | 5 occurrences — must fix underlying `any` type instead |
| Invalid `never` type in template literal expression | GUIDE-022 | 1 occurrence: src/mcp/mcp-hub.ts:L570 |
| `SSEClientTransport` is deprecated | GUIDE-021 | 2 occurrences: src/mcp/mcp-hub.ts:L625, L632 |
| Object default stringification in template literals (raw, value, triggerValue, scheduleValue, actionType) | GUIDE-020 | 7 occurrences across personas, workflows |
| Unexpected use of `fetch` — use Obsidian `requestUrl` | GUIDE-011 | 7 occurrences in 3 provider files |
| Use sentence case for UI text | GUIDE-023 | 53 occurrences across settings sections, chat-view, diff-view, tool-call-ui, mcp-status-indicator |
| Async function 'renderBedrockConnectionTestButton' has no 'await' | GUIDE-017 | Covered in GUIDE-017 above |
| Avoid `element.style.width` — use CSS classes / `setCssProps` | GUIDE-018 | 5 occurrences across settings and ui files |
| Avoid `element.style.height` | GUIDE-018 | 2 occurrences: src/ui/chat-view.ts |
| Avoid `element.style.top` | GUIDE-018 | 1 occurrence: src/ui/workflow-activity-dropdown.ts:L386 |
| Avoid `element.style.position` | GUIDE-018 | 1 occurrence: src/ui/workflow-activity-dropdown.ts:L392 |
| Unexpected `confirm` — use Obsidian Modal | GUIDE-012 | 2 occurrences: mcp-servers.ts:L297, attachment-picker.ts:L425–L429 |
| Use `new Setting(containerEl).setName(...).setHeading()` instead of HTML headings | GUIDE-009 | 1 remaining occurrence: src/settings/settings-tab.ts:L85 — missed in Phase 1 |

### Optional Issues

| Bot Finding | Task | Notes |
|---|---|---|
| Unused variables (err, estimateConversationTokens, CompactionRecord, WorkflowHookConfig, hasToolCall, LLMHookEvent, secretStorage, MAX_REDIRECTS, _position, result) | GUIDE-024 | 10 occurrences across 6 files |

---

## New Tasks

### GUIDE-011: Replace `fetch` with Obsidian `requestUrl`

**Guideline:** Use `requestUrl` for network requests so Obsidian can proxy them correctly (CORS, mobile, etc.)

**Scope:** Production provider files only (not e2e).

**Files:**
- `src/providers/anthropic-provider.ts` — lines L165, L390
- `src/providers/local-provider.ts` — lines L56, L191, L334
- `src/providers/openai-provider.ts` — lines L170, L316

**Approach:**

Obsidian's `requestUrl` is a single-shot HTTP call that buffers the entire response before returning. All three providers use streaming (`fetch` with SSE or chunked transfer encoding) to emit tokens in real time as they arrive from the model. These two APIs are fundamentally incompatible: streaming cannot be implemented on top of `requestUrl`.

The correct fix is to keep `fetch` for inference endpoints and add a described `eslint-disable-next-line` comment at each usage site explaining the justification. This satisfies the spirit of the guideline (document the reason for the exception) without breaking streaming.

For each `fetch` call:
```typescript
// eslint-disable-next-line no-restricted-globals -- requestUrl does not support streaming; fetch is required for SSE/chunked inference responses
const response = await fetch(url, { ... });
```

**Acceptance Criteria:**
- [ ] Every bare `fetch()` call in `src/providers/` has a described `eslint-disable-next-line` comment with the streaming justification
- [ ] No `fetch()` call is silently suppressed — each comment is specific to the line
- [ ] Build passes; streaming inference still works for all three providers

---

### GUIDE-012: Replace `confirm()` with Obsidian Modal

**Guideline:** Avoid native browser dialogs; use Obsidian UI APIs for a consistent experience.

**Files:**
- `src/settings/sections/mcp-servers.ts` — line L297: confirmation before deleting an MCP server
- `src/ui/attachment-picker.ts` — lines L425–L429: confirmation before removing an attachment

**Before implementing, research each usage site carefully.** The two locations have meaningfully different contexts and the async nature of modals vs. the synchronous nature of `confirm()` can introduce subtle control-flow issues if not handled correctly.

**Research questions to answer before coding:**

1. **`src/settings/sections/mcp-servers.ts:L297`** — What action is being confirmed? What code runs in the `if (confirm(...))` branch, and what state does it modify? Is the surrounding function already `async`? Does the UI need to be refreshed or re-rendered after the confirmation?

2. **`src/ui/attachment-picker.ts:L425–L429`** — Same questions. The picker is likely inside an event handler — what is the expected behavior if the user opens a modal from within a picker interaction?

3. **Flow control:** `confirm()` blocks synchronously and returns a boolean, so code after it always runs in a defined order. An Obsidian Modal is non-blocking — `open()` returns immediately and the confirm/cancel callbacks fire later. Any code that currently follows the `confirm()` call and relies on its result will need to move inside the callback.

4. **`ConfirmModal` design:** Is a single shared `ConfirmModal` class the right call, or are there UI differences between the two confirmation dialogs (different titles, button labels, destructive styling)? Check whether Obsidian's built-in `Modal` provides a standard destructive-action pattern.

**Approach (after research):**
- Create `src/ui/confirm-modal.ts` with a `ConfirmModal extends Modal` accepting a title, message, and `onConfirm` callback
- Move the post-confirmation logic for each site into the `onConfirm` callback
- Replace each `if (confirm("..."))` block with `new ConfirmModal(this.app, title, message, () => { /* moved logic */ }).open()`
- Ensure no code that was previously guarded by `confirm()` now runs unconditionally

**Acceptance Criteria:**
- [ ] No `confirm()` calls remain in `src/`
- [ ] Delete-server and remove-attachment flows show an Obsidian modal instead of browser dialog
- [ ] Cancel correctly aborts the operation with no side effects
- [ ] Confirm executes the same logic as the previous `if (confirm(...))` branch
- [ ] No code that was previously inside the `if` branch now runs outside the callback

---

### GUIDE-013-R: Research — Audit Promise handling sites before fixing

**Pre-requisite for GUIDE-013.** Do not begin GUIDE-013 implementation until this research is complete.

**Purpose:** The 29 Promise-handling violations span critical paths (orchestrator, MCP hub, chat view). Applying a mechanical fix without understanding each site risks silently swallowing errors, changing execution order, or masking real bugs. This research step classifies every site so that GUIDE-013 can be executed with confidence.

**What to investigate at each site:**

For every flagged location, read the surrounding code and answer:

1. **Intent** — Is this intentionally fire-and-forget (the caller doesn't need to wait), or should the caller actually be waiting?
2. **Error visibility** — If the Promise rejects, is that error currently observable anywhere (try/catch upstream, `.catch`, event handler)? Would the proposed fix change whether errors surface?
3. **Execution order sensitivity** — Does any code on the lines immediately following depend on the Promise having completed? Would adding `void` vs `await` change observable behavior?
4. **Correct fix** — One of:
   - `void fn()` — intentional fire-and-forget, errors are either non-critical or handled elsewhere
   - `.catch(err => log.error(...))` — fire-and-forget but errors must not be silent
   - Convert surrounding function to `async` + `await fn()` — caller actually needs to wait
   - `void (async () => { await fn(); })()` — async callback in void-return context (event handler)
5. **Risk level** — Low (mechanical `void` prefix), Medium (requires async conversion of caller), High (unclear intent or potential behavioral change)

**Files to audit (floating promises — 13 occurrences):**
- `src/chat/history.ts` — L125–L129
- `src/chat/orchestrator.ts` — L1846
- `src/main.ts` — L1446, L1454
- `src/settings/sections/connection-test.ts` — L32
- `src/settings/sections/mcp-servers.ts` — L562
- `src/settings/sections/provider-reference.ts` — L62–L67, L110–L115
- `src/ui/chat-view.ts` — L305, L332, L595, L1520
- `src/ui/persona-picker.ts` — L104–L108

**Files to audit (promise-in-void-context — 16 occurrences):**
- `src/chat/orchestrator.ts` — L100–L105, L107–L109, L591–L596, L597–L599
- `src/mcp/mcp-hub.ts` — L751–L791
- `src/settings/sections/mcp-servers.ts` — L557–L558, L564–L567, L592–L605, L654–L663, L671–L679
- `src/ui/chat-view.ts` — L645, L1413–L1425, L1517, L1549–L1556, L1564–L1580

**Output:** Write findings to `specs/ZZ-guidelines-cleanup/research/GUIDE-013-promise-audit.md`. Structure it as a table or per-file sections with: location, intent, error visibility, correct fix, risk level, and any notes. Flag any sites where intent is ambiguous and a decision is needed before proceeding.

**Acceptance Criteria:**
- [ ] Every flagged location has a documented classification and recommended fix
- [ ] All High-risk sites are explicitly called out with rationale
- [ ] Research file committed before GUIDE-013 implementation begins

---

### GUIDE-013: Fix floating and void-context Promise issues

**Pre-requisite:** GUIDE-013-R must be complete. Use the research output to drive every fix decision.

**Guideline:** Unhandled Promises hide errors. Either await, chain `.catch`, or explicitly mark fire-and-forget with `void`.

Two related lint rules:
- `@typescript-eslint/no-floating-promises` — Promise expression result discarded with no handling
- `@typescript-eslint/no-misused-promises` — async callback passed where `void`-return is expected

**Files:** See GUIDE-013-R for the full list (29 occurrences across both rule categories).

**Approach:** Apply the fix classified in the research for each site:
- `void fn()` — intentional fire-and-forget
- `.catch(err => log.error(...))` — fire-and-forget where errors must surface
- `await fn()` — caller needs to wait; convert surrounding function to `async` if needed
- `void (async () => { await fn(); })()` — async body inside a void-return event handler

**Acceptance Criteria:**
- [ ] Zero `no-floating-promises` lint errors in `src/`
- [ ] Zero `no-misused-promises` lint errors in `src/`
- [ ] Every fix matches the classification in GUIDE-013-R; no site fixed without documented rationale
- [ ] No regressions in chat send, MCP operations, or settings interactions

---

### GUIDE-014: Fix undescribed eslint-disable directive comments

**Guideline:** Directive comments without a description provide no context for why the rule is suppressed.

**Files (8 occurrences of undescribed `eslint-disable-next-line` or `// @ts-ignore`):**
- `src/chat/history.ts` — L254, L265
- `src/context/attachment.ts` — L368
- `src/mcp/mcp-hub.ts` — L460
- `src/providers/anthropic-provider.ts` — L294
- `src/providers/bedrock-provider.ts` — L90, L140, L461

**Also covered here — `no-explicit-any` disable not allowed (5 occurrences):**
- These cannot be suppressed via directive. The underlying `any` type must be replaced with a proper type or `unknown`.
  - `src/mcp/mcp-hub.ts` — L460
  - `src/providers/anthropic-provider.ts` — L294
  - `src/providers/bedrock-provider.ts` — L90, L140, L461

**Approach:**
- For each undescribed directive: add a brief reason (e.g., `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK callback type is untyped`)
- For `no-explicit-any` directives that cannot be suppressed: replace `any` with the narrowest appropriate type (`unknown`, a discriminated union, or the specific SDK type)

**Acceptance Criteria:**
- [ ] All `eslint-disable` comments include a description after `--`
- [ ] No `no-explicit-any` disables remain; underlying types are explicit
- [ ] Build passes with no type errors

---

### GUIDE-015: Remove unnecessary type assertions

**Guideline:** Assertions that don't change the type add noise and can mask real type issues.

**Files (30 occurrences):**
- `src/chat/history.ts` — L368
- `src/context/attachment.ts` — L215, L231
- `src/context/compaction.ts` — L263
- `src/hooks/vault-event-dispatcher.ts` — L156, L176
- `src/include-note/parser.ts` — L62
- `src/personas/auto-approve-resolver.ts` — L128, L131, L136
- `src/personas/persona-discovery.ts` — L59, L64, L98
- `src/providers/local-provider.ts` — L52
- `src/rules/vault-rules.ts` — L281, L285, L366
- `src/settings/sections/mcp-servers.ts` — L398, L404, L481, L486
- `src/tools/list-vault.ts` — L227
- `src/ui/chat-view.ts` — L943, L1098, L1126
- `src/ui/diff-view.ts` — L482
- `src/ui/tool-call-ui.ts` — L93
- `src/workflows/workflow-discovery.ts` — L93, L275, L277

**Approach:**
- For each location, read the surrounding type context and remove the `as X` cast if TypeScript already knows the correct type
- In some cases (e.g., where the assertion was compensating for a missing `instanceof` guard) the fix should be GUIDE-016 instead — coordinate

**Acceptance Criteria:**
- [ ] Zero `no-unnecessary-type-assertion` lint errors
- [ ] No new type errors introduced
- [ ] Build passes

---

### GUIDE-016: Replace `as TFile`/`as TFolder` casts with `instanceof` type narrowing

**Guideline:** Casting bypasses type safety. Use runtime checks to narrow the type safely.

**Files:**

`TFile` casts (6 occurrences):
- `src/context/attachment.ts` — L215, L231
- `src/personas/persona-discovery.ts` — L98
- `src/rules/vault-rules.ts` — L366
- `src/tools/list-vault.ts` — L227
- `src/workflows/workflow-discovery.ts` — L277

`TFolder` casts (4 occurrences):
- `src/personas/persona-discovery.ts` — L59, L64
- `src/workflows/workflow-discovery.ts` — L93, L275

**Approach:**
- Replace `someAbstractFile as TFile` with a conditional guard:
  ```typescript
  if (!(file instanceof TFile)) return; // or throw / continue
  // file is now TFile
  ```
- For array filter patterns: use a type predicate helper:
  ```typescript
  function isTFile(f: TAbstractFile): f is TFile { return f instanceof TFile; }
  files.filter(isTFile)
  ```
- Note: some of these will resolve GUIDE-015 violations at the same locations

**Acceptance Criteria:**
- [ ] No `as TFile` or `as TFolder` casts remain in `src/`
- [ ] Narrowing is done via `instanceof` at each location
- [ ] Build passes; no logic regressions in persona/workflow/vault-rules discovery

---

### GUIDE-017: Remove `async` from methods/functions with no `await`

**Guideline:** Marking a method `async` when it has no `await` is misleading and triggers lint errors.

**Files:**

| Location | Method |
|---|---|
| `e2e/lib/log-collector.ts:L176` | `writeSummary` |
| `src/main.ts:L647` | `get` (getter) |
| `src/settings/sections/mcp-servers.ts:L79` | `get` |
| `src/settings/sections/mcp-servers.ts:L86` | `set` |
| `src/settings/sections/mcp-servers.ts:L92` | `delete` |
| `src/mcp/mcp-hub.ts:L108` | `initialize` |
| `src/tools/list-vault.ts:L94` | `execute` |
| `src/tools/read-frontmatter.ts:L46` | `execute` |
| `src/ui/chat-view.ts:L437` | `onOpen` |
| `src/ui/chat-view.ts:L453` | `onClose` |
| `src/workflows/workflow-discovery.ts:L72` | `discoverWorkflows` |
| `src/settings/sections/connection-test.ts:L91` | `renderBedrockConnectionTestButton` |

**Approach:**
- For each method: check if the method body actually has no async operations (no `await`, no `Promise.all`, etc.)
- If truly sync: remove the `async` keyword and update the return type annotation (e.g., `Promise<void>` → `void`)
- If callers `await` the result: the removal is safe since a non-Promise return is automatically resolved by existing `await` calls
- Check for interface/base class method signatures that declare the method as returning `Promise<T>` — if the interface requires `Promise<T>`, keep `async` or return `Promise.resolve(value)` explicitly

**Acceptance Criteria:**
- [ ] Zero `require-await` lint errors for the listed methods
- [ ] Return type annotations updated where needed
- [ ] Build passes; callers that await these methods still compile correctly

---

### GUIDE-018: Replace inline `element.style.*` assignments with CSS / `setCssProps`

**Guideline:** Inline style mutations bypass theme variables and break maintainability.

**Files:**

`style.width` (5 occurrences in settings):
- `src/settings/sections/hooks.ts` — L157
- `src/settings/sections/model-pricing.ts` — L51, L57, L63
- `src/settings/sections/vault-event-hook-subsection.ts` — L194

`style.height` (2 occurrences):
- `src/ui/chat-view.ts` — L581, L684

`style.top` + `style.position` (2 occurrences):
- `src/ui/workflow-activity-dropdown.ts` — L386 (top), L392 (position)

**Note:** The `style.top` and `style.position` in `workflow-activity-dropdown.ts` are used for dynamic positioning calculations (dropdown placement relative to viewport). These are a special case — a static CSS class cannot encode a runtime-computed pixel offset. The correct fix here is `el.setCssProps({ '--dropdown-top': computedTop + 'px' })` paired with a CSS rule `top: var(--dropdown-top)`, or use `setCssStyles` if available.

**Approach:**
- For static widths in settings (e.g., `el.style.width = '100%'`): add a CSS class in `styles.css` and use `el.addClass('notor-full-width')` etc.
- For dynamic height in chat-view (if it's a computed value): use `el.setCssProps({ '--notor-input-height': value + 'px' })` with a corresponding CSS var
- For the dynamic top/position in workflow dropdown: use `el.setCssProps(...)` with CSS variable-driven positioning

**Acceptance Criteria:**
- [ ] No `element.style.width`, `.height`, `.top`, or `.position` direct assignments remain in `src/`
- [ ] Layout and positioning behavior unchanged visually
- [ ] Dropdown still positions correctly relative to the trigger element

---

### GUIDE-019: Use `Vault#configDir` instead of hardcoded `.obsidian`

**Guideline:** The Obsidian config folder is user-configurable. Using `.obsidian` hardcoded breaks alternate vault configurations.

**Files (7 occurrences):**
- `e2e/lib/obsidian-fixture.ts` — L40
- `src/settings/defaults.ts` — L91, L94
- `src/settings/sections/checkpoints.ts` — L25, L30
- `src/settings/sections/history.ts` — L25, L30

**Approach:**
- In production code (`src/`): pass `this.app.vault.configDir` (or `app.vault.configDir`) where `.obsidian` is currently hardcoded as a path segment
- In `defaults.ts`: the default value may need to remain as a static string if it's used before `app` is available — evaluate each usage and consider making those defaults lazy or accepting `configDir` as a parameter
- In `e2e/` fixture: the fixture is constructing a test vault path; it may need to read the config dir from the Obsidian process rather than hardcode it, or use a known fixture value for the test vault

**Acceptance Criteria:**
- [ ] No `.obsidian` string literals used as path components in `src/`
- [ ] Settings and history paths use `app.vault.configDir`
- [ ] E2E vault fixture uses the correct config directory path
- [ ] Build passes

---

### GUIDE-020: Fix object-to-string coercion in template literals

**Guideline:** Using an object directly in a template literal produces `[object Object]` — almost certainly a bug.

**Files (7 occurrences):**
- `src/personas/persona-discovery.ts` — L194 (`raw`), L213 (`value`)
- `src/workflows/workflow-discovery.ts` — L159 (`triggerValue`), L169 (`triggerValue`), L176 (`scheduleValue`), L404 (`value`)
- `src/workflows/workflow-hook-parser.ts` — L206 (`actionType`)

**Approach:**
- For each location, read the surrounding code to understand what the object contains
- Use `JSON.stringify(value)` for debug/logging output, or extract the specific property that should be interpolated (e.g., `value.name` or `value.type`)
- For `actionType` (L206): likely wants `.type` or `.name` from a discriminated union — check the type definition

**Acceptance Criteria:**
- [ ] No variables of object type interpolated directly in template literals in the listed files
- [ ] The correct string representation is used (property access or JSON.stringify)
- [ ] Build passes; no behavioral changes to workflow/persona parsing

---

### GUIDE-021: Migrate deprecated `SSEClientTransport` to `StreamableHTTPClientTransport`

**Guideline:** The MCP SDK deprecates SSEClientTransport in favor of StreamableHTTPClientTransport.

**File:**
- `src/mcp/mcp-hub.ts` — L625, L632

**Approach:**
- Replace `new SSEClientTransport(url)` with `new StreamableHTTPClientTransport(url)` at both locations
- Replace the `SSEClientTransport` import with `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk`
- Remove any now-unused SSE-specific code paths

The MCP ecosystem has moved on. Requiring users to run servers that support Streamable HTTP is a reasonable stance and avoids maintaining two transport code paths indefinitely.

**Acceptance Criteria:**
- [ ] `SSEClientTransport` removed from `src/mcp/mcp-hub.ts`
- [ ] `StreamableHTTPClientTransport` used at both former SSE sites
- [ ] Build passes with no type errors

---

### GUIDE-022: Fix miscellaneous code quality issues

A collection of small, isolated fixes that don't warrant individual tasks.

**Sub-tasks:**

**a. Unnecessary escape character (`src/chat/conversation.ts:L350`)**
- Remove the `\[` escape — inside a regex character class, `[` does not need escaping; use `[` directly

**b. Unexpected empty object pattern (`e2e/lib/obsidian-fixture.ts:L92`)**
- Replace the empty destructure `{}` with `_` or remove the parameter if unused

**c. Unnecessary try/catch wrapper (`src/chat/orchestrator.ts:L789–L822`)**
- Remove the outer try/catch if it only re-throws without transformation; keep any actual error-handling logic

**d. Lexical declaration in case block (`src/chat/orchestrator.ts:L1614`)**
- Wrap the `case` body in braces `{ }` to create a block scope, or hoist the declaration before the `switch`

**e. Unexpected aliasing of `this` (`src/hooks/manual-save-detector.ts:L134`)**
- Replace `const self = this` pattern with an arrow function to capture `this` lexically

**f. No-unused-expressions (`src/main.ts:L329`)**
- The expression evaluates but its result is discarded. Either assign the result, wrap in a function call, or remove if truly dead code. Read the context to determine intent.

**g. Invalid `never` type in template literal (`src/mcp/mcp-hub.ts:L570`)**
- Investigate why the type is inferred as `never` — likely an unreachable branch or exhaustive switch. Add a default case or cast properly.

**Acceptance Criteria:**
- [ ] Zero lint errors for the listed sub-tasks
- [ ] Build passes
- [ ] No behavioral regressions

---

### GUIDE-023: Fix remaining sentence case violations in UI text

**Guideline:** Obsidian guidelines require sentence case (not title case) for all user-visible UI strings.

**Note:** GUIDE-001 addressed group headings in `settings-tab.ts` and audited settings sections, but the review bot found 53 additional violations across a wider set of files.

**Files (53 occurrences):**
- `src/settings/sections/active-provider.ts` — L19
- `src/settings/sections/auto-context.ts` — L54
- `src/settings/sections/checkpoints.ts` — L25, L30
- `src/settings/sections/connection-test.ts` — L66
- `src/settings/sections/fetch-webpage.ts` — L42, L112
- `src/settings/sections/file-attachments.ts` — L25
- `src/settings/sections/general.ts` — L25
- `src/settings/sections/history.ts` — L25, L36
- `src/settings/sections/mcp-servers.ts` — L120, L167, L338, L429, L463, L510, L712, L715, L717, L750, L752, L784, L786
- `src/settings/sections/model-pricing.ts` — L44
- `src/settings/sections/persona-auto-approve.ts` — L179, L181
- `src/settings/sections/provider-anthropic.ts` — L21
- `src/settings/sections/provider-bedrock.ts` — L19, L35, L36, L60, L79, L86, L99, L112
- `src/settings/sections/provider-local.ts` — L18, L25, L29
- `src/settings/sections/provider-openai.ts` — L18, L24
- `src/ui/chat-view.ts` — L131, L552, L970, L1017, L1710
- `src/ui/diff-view.ts` — L115, L225, L269
- `src/ui/mcp-status-indicator.ts` — L80, L146, L153
- `src/ui/tool-call-ui.ts` — L67, L130

**Sentence case rule:** Only the first word and proper nouns are capitalized. Examples:
- "Provider Setup" → "Provider setup"
- "Enable Auto Context" → "Enable auto context"
- "API Key" → "API key" (API is an acronym, keep caps; "key" is lowercase)

**Acceptance Criteria:**
- [ ] All 53 flagged strings are in sentence case
- [ ] Proper nouns and acronyms (API, MCP, URL, AI, AWS, OpenAI, Anthropic, Bedrock) retain their capitalization
- [ ] Build passes; no visual regression in settings or UI

---

### GUIDE-024 (Optional): Remove unused variables and imports

**Files:**

| File | Symbol | Type |
|---|---|---|
| `e2e/run-and-collect.ts:L60` | `err` | unused catch binding |
| `src/chat/orchestrator.ts:L32` | `estimateConversationTokens` | unused import |
| `src/chat/orchestrator.ts:L33` | `CompactionRecord` | unused import |
| `src/chat/orchestrator.ts:L39` | `WorkflowHookConfig` | unused import |
| `src/chat/orchestrator.ts:L1601` | `hasToolCall` | assigned but never read |
| `src/hooks/hook-events.ts:L33` | `LLMHookEvent` | unused export |
| `src/main.ts:L642` | `secretStorage` | assigned but never read |
| `src/tools/fetch-webpage.ts:L129` | `MAX_REDIRECTS` | assigned but never read |
| `src/tools/read-frontmatter.ts:L84` | `_position` | assigned but never read |
| `src/ui/chat-view.ts:L1733` | `result` | assigned but never read |

**Approach:**
- Remove unused imports entirely
- For assigned-but-never-read variables: remove the assignment if the RHS has no side effects; if it does (e.g., a function call), replace with `void expr` or restructure
- For `err` in catch: replace with `_err` or `_` if the catch block is intentionally empty

**Acceptance Criteria:**
- [ ] Zero `no-unused-vars` warnings in the listed locations
- [ ] No dead code introduced
- [ ] Build passes

---

### GUIDE-025: Fix disallowed console method usage

**Guideline:** Only `console.warn`, `console.error`, and `console.debug` are allowed. All other methods (`console.log`, `console.info`, `console.table`, etc.) are forbidden.

**Scope of flagged files:**
- `e2e/lib/obsidian-fixture.ts` — L66 (1 occurrence)
- `e2e/lib/obsidian-launcher.ts` — L174, L175, L197, L198, L199, L212, L216, L224, L227, L229, L246, L255, L267 (13 occurrences)
- `e2e/run-and-collect.ts` — L48, L49, L53, L59, L65, L69, L81, L92, L99, L120, L126–L130, L133, L135, L136, L143, L144 (20 occurrences)
- `src/utils/logger.ts` — L62 (1 occurrence)

**Approach:**
- `e2e/` files: The e2e framework is test infrastructure (not the plugin bundle) but the scanner still flags them. Replace `console.log(...)` with `console.debug(...)` where the output is informational tracing, or `console.error(...)` where it's error reporting.
- `src/utils/logger.ts:L62`: This is the logger's internal `console.*` call. If it's using `console.log` or `console.info`, change to `console.debug` for non-error entries.

**Acceptance Criteria:**
- [ ] No `console.log` or `console.info` calls remain anywhere in the repo
- [ ] E2E output verbosity is unchanged (debug is equivalent for test purposes)
- [ ] Logger still emits structured JSON entries to the console

---

### GUIDE-009 Remaining Work

One occurrence was missed in Phase 1:

- `src/settings/settings-tab.ts:L85` — still using a raw HTML heading element instead of `new Setting(containerEl).setName(...).setHeading()`

**Fix:** Apply the same pattern as the rest of the file; use the Obsidian `Setting` API.

---

## Execution Order

**Phase A: Isolated text/lint fixes (no behavioral risk)**
1. GUIDE-022 (misc small fixes)
2. GUIDE-014 (add directive comment descriptions)
3. GUIDE-015 (remove unnecessary assertions)
4. GUIDE-017 (remove spurious async)
5. GUIDE-023 (sentence case)
6. GUIDE-009 remaining (settings-tab heading)
7. GUIDE-024 optional (unused vars)

**Phase B: Type safety and API correctness**
8. GUIDE-016 (instanceof checks for TFile/TFolder)
9. GUIDE-019 (configDir)
10. GUIDE-020 (object stringification)
11. GUIDE-013-R (Promise audit research — must precede GUIDE-013)
12. GUIDE-013 (floating promises — implement per research findings)

**Phase C: API migration and structural changes**
13. GUIDE-011 (fetch → eslint-disable with streaming justification)
14. GUIDE-012 (confirm → Modal)
15. GUIDE-018 (inline styles → CSS)
16. GUIDE-021 (SSE transport migration)
17. GUIDE-025 (console methods in e2e)
