# Stage 0 + 0.5 — Implementation Plan ("Stop the bleeding" + policy-path deletion)

**Status:** Ready to implement
**Parent spec:** [`../fable-architecture-review-2606.md`](../fable-architecture-review-2606.md) §4 (Stage 0 / Stage 0.5), §5 matrix
**Source review:** `private/architecture-review-2026-06-11.md` + `private/architecture-review-2026-06-11-code-map.md` (git-ignored)
**Code verified against:** working tree at HEAD `e16b061` (which adds *only* the parent spec on top of the
reviewed `f7049d0`; all `src/` is byte-identical to the commit the review cites). Re-verified by direct
read on 2026-06-14.

> **Line-number caveat.** Every `file:line` below was confirmed by direct read at `e16b061`. Line numbers
> drift. **Re-locate by symbol name at implementation time, not by line.** Where a range is given it is to
> scope the work, not to be applied as a patch coordinate.

---

## 0. Scope & sequencing

This document covers the eight Stage-0 quick wins **and** the gated Stage-0.5 policy-path deletion, because
items 8 (widen approval type) and 9 (policy-path deletion) are coupled through `dispatcher.ts` and share a
test surface. Everything here is **S effort except items 7 and 9 (M)**.

### Two independent tracks

The work splits cleanly into two tracks that can land in parallel (different files, no shared edits):

| Track | Items | Files touched | Land order |
|-------|-------|---------------|------------|
| **A — Pure mechanical** | 1 openai-format · 2 schema_version · 3 rename · 5 metadata hygiene | providers/, chat/history, checkpoints/, memory/, workflows/ | any order, independent |
| **B — Dispatcher / hooks** | 4 stale capture · 6 hooks→queue · 8 widen approval · 9 policy-path deletion | main.ts, chat/dispatcher, chat/hook-dispatcher, hooks/, ui/ | 8 before 9; 4 & 6 independent |

**Critical ordering inside Track B:** item 8 (widen `ApprovalDecision`) should land **before** item 9
(policy-path deletion), because deleting the legacy block removes one of the two `raceApprovalSources`
call-sites that consume the approval result — doing 8 first means the widening touches both branches once,
then 9 deletes one of them cleanly.

**Stage 0.5 (item 9) is release-gated.** It requires a tripwire log shipped in one release before the
deletion lands. Items 1–8 can ship in the release that *carries* the tripwire; item 9's deletion lands in
the release *after*.

---

## 1. Share `toOpenAIMessages` / `toOpenAITools` (Issue 4.1) — S, low risk

### Current state (verified)
- `src/providers/openai-provider.ts`: `toOpenAIMessages` is a **module-level, non-exported** function
  (`toOpenAIMessages(messages: ChatMessage[]): Record<string, unknown>[]`), and `toOpenAITools(tools:
  ToolDefinition[]): Record<string, unknown>[] | undefined`. Called from `sendMessage()`. Logger is
  `logger("OpenAIProvider")`.
- `src/providers/local-provider.ts`: the same two functions. `toOpenAITools` is **byte-for-byte identical**.
  `toOpenAIMessages` differs in **exactly one token** — the warn string:
  - openai: `"Dropping image blocks from OpenAI tool result (not supported)"`
  - local: `"Dropping image blocks from local provider tool result (not supported)"`
  - (plus a slightly longer docstring on the local copy).
- Both import `ChatMessage` and `ToolDefinition` from `./provider`.

### Change
1. Create `src/providers/openai-format.ts`:
   ```ts
   import type { ChatMessage, ToolDefinition } from "./provider";
   import { logger } from "../utils/logger"; // match existing import path used in providers

   export function toOpenAIMessages(
     messages: ChatMessage[],
     opts: { providerLabel: string },
   ): Record<string, unknown>[] { /* body from openai-provider, warn string built from opts.providerLabel */ }

   export function toOpenAITools(
     tools: ToolDefinition[],
   ): Record<string, unknown>[] | undefined { /* identical body */ }
   ```
   - Parameterize **only** the warn string: `` `Dropping image blocks from ${opts.providerLabel} tool result (not supported)` ``.
   - Use a module-scoped `logger("openai-format")` (or pass nothing and keep the log at the provider — see
     note). Simplest: log inside the shared module under its own logger tag; the existing tag names are
     cosmetic and not asserted in tests (confirm by grep before deciding).
2. `openai-provider.ts`: delete both local definitions; `import { toOpenAIMessages, toOpenAITools } from
   "./openai-format"`; update the call in `sendMessage()` to `toOpenAIMessages(messages, { providerLabel:
   "OpenAI" })`.
3. `local-provider.ts`: same, with `providerLabel: "local provider"`.

### Verification
- `npm run build` / `tsc` clean.
- Grep that no other file imported these (they were non-exported, so none can have — confirm).
- No behavioral change intended; the only observable difference is the log tag, which is non-load-bearing.

### Risk
Low. Pure mechanical extraction. The one trap: ensure the warn string for `local` keeps the exact phrase
"local provider" if any log-scraping/E2E assertion depends on it — grep `e2e/` and tests for the string
first.

---

## 2. Add `schema_version` to persisted artifacts (Issue 6.1) — S, low risk

This is **insurance**: the field's only job is to make a future v2 *detectable*. No migration logic now.
Readers default missing → 1.

### 2a. JSONL conversation header — `src/chat/history.ts`
- **Write:** the header object `{ _type: "conversation", ...conversation }` (in `createConversationFile()`;
  also rewritten in `updateConversationHeader()`, `importConversation()`, and the sub-agent header in
  `writeSubAgentConversation()`). Add `schema_version: 1` to the written object. **Prefer adding it at the
  serialization boundary** (one helper that builds the header line) so all header write-sites get it
  uniformly — if no such helper exists, add the field at each `_type: "conversation"` write site (there are
  ~4; enumerate by grep `"_type": "conversation"` / `_type: "conversation"`).
- **Message records** (`{ _type: "message", ...message }`): **do not** add a per-message version — the
  header's version governs the file (the code-map's explicit call). Leave message records untouched.
- **Read:** header parse in `loadConversation()` strips `_type` and casts to `Conversation`. Missing fields
  already become `undefined`, so no reader change is strictly required for correctness today; **optionally**
  normalize `header.schema_version ??= 1` after parse so downstream code can rely on it. Keep this minimal.

### 2b. Checkpoint JSON — `src/checkpoints/storage.ts` + `src/types.ts`
- **Type:** add `schema_version: number;` to the `Checkpoint` interface in `src/types.ts` (currently 8
  required fields: `id`, `conversation_id`, `note_path`, `content`, `timestamp`, `description`,
  `tool_name`, `message_id`). **Make it required** in the type, but the reader must tolerate its absence
  (see below) — so set it at every construction site of a `Checkpoint`.
- **Write:** `save()` does `JSON.stringify(checkpoint, …)`. The field flows through automatically once the
  object carries it. Find the **construction** site(s) of `Checkpoint` objects (the checkpoint *creation*
  path, `src/checkpoints/checkpoint.ts`) and set `schema_version: 1` there.
- **Read:** `load()` / `listForConversation()` do `JSON.parse(raw) as Checkpoint` — an unchecked cast. Old
  files lack the field. Add a normalization on read: `obj.schema_version ??= 1` before returning/pushing, so
  the required-typed field is never `undefined` at runtime for legacy data.

### 2c. Memory note frontmatter — `src/memory/note-format.ts`
- **Write:** `serializeNote()` writes `notor-type`, `notor-created-at`, `notor-memory-updated-at`,
  `notor-sources`. `serializePendingNote()` writes those plus `notor-approval-state`,
  `notor-original-action`, `notor-target-path`. Add `notor-schema: 1` to **both** serializers.
- **Read:** `parseNote()` / `parsePendingNote()` use `extractField()` which returns `null` for missing keys
  and callers apply `?? fallback`. Add `const schemaVersion = Number(extractField(fm, "notor-schema")) || 1;`
  if any consumer needs it; otherwise writing the field is sufficient for the insurance goal. Keep minimal.

### Verification
- Round-trip test: write a conversation/checkpoint/memory note, read it back, assert `schema_version === 1`.
- Backward-compat test: hand-craft a legacy artifact **without** the field, read it, assert it defaults to 1
  and nothing throws. (This is the load-bearing test — it proves the retrofit is safe.)
- For checkpoints specifically, fold this into the **checkpoint round-trip test** that §6.4 of the parent
  spec flags as a must-do-now (restore writes user notes — a regression destroys data). See item 9's test
  notes; this is the natural place to add it.

### Risk
Low. The only sharp edge is the checkpoint `as Checkpoint` cast: a *required* `schema_version` in the type
plus legacy files lacking it is a latent `undefined`-typed-as-`number`. The read-side `??= 1` normalization
closes that — do not skip it.

---

## 3. Rename `workflows/workflow-executor.ts` → `workflows/prompt-assembly.ts` (Issue 3.8) — S, low risk

### Current state (verified)
- `src/workflows/workflow-executor.ts` (655 lines) exports 11 functions incl. `assembleWorkflowPrompt`,
  `switchWorkflowPersona`, `revertWorkflowPersona`, `showWorkflowPicker`, `showActiveNoteWorkflowPicker`,
  and several helpers. It defines **no exported types** (all imported from `../types`).
- This is **not** the same file as `src/chat/workflow-executor.ts` — the `chat` one holds the
  `WorkflowExecutor` class and *imports* `assembleWorkflowPrompt` etc. from the `workflows` one. The naming
  collision is the only problem (confirmed non-issue in the review: it's delegation, not duplication).
- **Import sites of `workflows/workflow-executor` (4 to update):**
  - `src/chat/conversation-lifecycle.ts` — `revertWorkflowPersona`
  - `src/chat/workflow-executor.ts` — `revertWorkflowPersona, switchWorkflowPersona, assembleWorkflowPrompt`
  - `src/hooks/vault-event-dispatcher.ts` — `assembleWorkflowPrompt, switchWorkflowPersona`
  - `src/commands/index.ts` — `showWorkflowPicker, showActiveNoteWorkflowPicker`
  - (`src/chat/orchestrator.ts` imports `WorkflowExecutor` from `./workflow-executor` — the **chat** file —
    do **not** touch that import.)

### Change
1. `git mv src/workflows/workflow-executor.ts src/workflows/prompt-assembly.ts` (use `mcp__git` per repo git
   rules — but the move itself is a filesystem rename; stage it via the git tooling).
2. Update the 4 import paths above from `"../workflows/workflow-executor"` →
   `"../workflows/prompt-assembly"` (and the relative `"./workflow-executor"` inside
   `src/chat/workflow-executor.ts` is `"../workflows/workflow-executor"` → `"../workflows/prompt-assembly"`).
3. Grep once more for any stragglers: `grep -rn "workflows/workflow-executor" src/ e2e/`.

### Note on Issue 6.5 (lazy type import)
`src/types.ts` has a lazy `import("./tool-config/types").ParsedToolConfig[]` inside `WorkflowAssemblyResult`.
The parent spec (6.5) suggests this *could* move to a future `workflows/types.ts` during this rename. **Do
not** do that here — the rename is mechanical and `WorkflowAssemblyResult` is unaffected (different module).
Leave 6.5 as a deferred follow-up; mention it only so the implementer doesn't get tempted to scope-creep.

### Verification
`tsc` clean; `grep -rn "workflows/workflow-executor"` returns zero hits.

### Risk
Low. Filename-only change. No symbol renames, so call sites need only path edits.

---

## 4. Fix `_personaManager` stale capture in `getDispatcherDeps()` (Issue 1.2) — S, low risk

### Current state (verified) — sharper than the review states
- `getDispatcherDeps()` at `src/main.ts` (~908–927) is an **arrow that is rebuilt on every vault event**:
  it is invoked fresh at the two `dispatchVaultEventHooks(... getDispatcherDeps())` call sites
  ([main.ts ~937](../../../src/main.ts) and [~983](../../../src/main.ts)) and inside the scheduler's
  `setDispatch`. It is **not** captured once at startup.
- Every other field is already lazy/live (`orchestrator: this.getActiveOrchestrator()`,
  `templateRegistry: this.getTemplateRegistry()`, `getSettings: () => this.settings`, the extension
  accessors) **except** `personaManager: this._personaManager` — a direct field read.
- **The actual bug shape:** because the deps object is rebuilt per-event, this is *not* a frozen-stale
  reference. It is a **lazy-construction miss**: if a vault event fires *before* `_personaManager` is
  constructed, the deps get `undefined`, whereas `getPersonaManager()` would lazily construct it. (`getPersonaManager()`
  in main.ts lazily builds on first call.) Narrower than the review's framing, but still a real latent
  `undefined`.
- **Consumer:** `DispatcherDeps` is defined in `src/hooks/vault-event-dispatcher.ts` (~46–80) with
  `personaManager?: PersonaManager` (a **value**, optional). It is read **once per workflow execution**
  (~line 532: `if (workflow.persona_name && deps.personaManager) { switchWorkflowPersona(...,
  deps.personaManager) }`), not repeatedly.

### Decision: keep it a value, not an accessor
Because the deps object is **rebuilt on every dispatch**, the minimal correct fix is to make the value
resolve through the lazy getter **at build time**:

```ts
// in getDispatcherDeps()
personaManager: this.getPersonaManager(),   // was: this._personaManager
```

This requires **no type change** (`personaManager?: PersonaManager` stays a value) and **no consumer
change** (still read as `deps.personaManager`). It lazily constructs the manager if a vault event arrives
before the eager construction path has run. This is simpler than the review's `() => this.getPersonaManager()`
accessor suggestion, which would force a type change in `DispatcherDeps` and a call-site edit in
`vault-event-dispatcher.ts` — unnecessary given the per-event rebuild.

> Confirm before finalizing: that `getPersonaManager()` is safe to call at the earliest moment any vault
> event could fire (it lazily constructs, so it should be — but verify it has no hard dependency on a
> not-yet-initialized field). If `getPersonaManager()` can itself throw early, fall back to the accessor
> form `personaManager: () => this.getPersonaManager()` + the type/consumer edits.

### Verification
- `tsc` clean.
- Reasoning check: trace that no vault event can fire before `getPersonaManager()` is callable. The
  existing eager creation and `onLayoutReady` ordering should make this moot in practice, but the fix makes
  it correct by construction.

### Risk
Low. One-line change with no type/consumer ripple in the chosen (value) form.

---

## 5. Model-metadata hygiene: geo-prefix normalization + warn-on-fallback (Issue 4.2) — S, low risk

### Current state (verified) — `src/providers/model-metadata.ts`
- `DEFAULT_CONTEXT_WINDOW = 128_000` (~line 24).
- `MODEL_METADATA` table (~59–597): **74 entries, 48 of them geo-prefixed** (`us.`=17, `eu.`=12,
  `apac.`=11, `global.`=8). The 26 non-prefixed are direct Anthropic/OpenAI ids.
- `THINKING_PATTERNS` (~687–698): 7 regexes, **4** repeat `(us|eu|apac|global)\.` alternation.
- `LEGACY_ENABLED_THINKING_PATTERNS` (~705–723): 10 regexes, **6** repeat the geo alternation.
- Lookups are **exact key match** (`MODEL_METADATA[modelId]`) with **no normalization anywhere**.
  - `getModelMetadata()` (~605–617): returns `null` on miss (no log).
  - `getContextWindow()` (~630–636): `entry?.context_window ?? DEFAULT_CONTEXT_WINDOW` — **silent** fallback.
  - `getThinkingMode()` (~744–748): regex-tests `LEGACY_ENABLED_THINKING_PATTERNS`, defaults `"effort"`
    silently.
- No logger imported in this file today (it's a pure data module).
- Test: `src/providers/model-metadata.test.ts` (~46 lines) covers **only `getContextWindow`** (8 cases),
  including the us/eu/apac/global 1M-context variants — so geo-prefixed lookups are *asserted* and must keep
  passing.

### Change — two cheap structural fixes, scoped inside this file
1. **Normalize the model id once.** Add a private helper:
   ```ts
   const GEO_PREFIX = /^(us|eu|apac|global)\./;
   function normalizeModelId(modelId: string): string {
     return modelId.replace(GEO_PREFIX, "");
   }
   ```
   Apply it **at the lookup boundary** in `getModelMetadata`, `getContextWindow`, `getThinkingMode`,
   `supportsThinking`, `enrichModelInfo` — i.e. look up `MODEL_METADATA[normalizeModelId(modelId)]` and
   `.test(normalizeModelId(modelId))`.
   - **Then collapse** the 48 geo-duplicated table entries into their 26 base ids, and **drop the
     `(us|eu|apac|global)\.` alternations** from `THINKING_PATTERNS` / `LEGACY_ENABLED_THINKING_PATTERNS`
     (they become base-id patterns).
   - ⚠️ **Sequencing within this item:** introduce `normalizeModelId` and apply it at *all* call sites
     **first** (behavior-preserving — the table still has the geo entries, they're just also reachable via
     base id), run the existing test green, **then** delete the duplicate entries / alternations as a second
     commit. Deleting first would break the geo-variant test. Keep the test green at each step; consider
     *adding* a test that a geo-prefixed id and its base id resolve identically before collapsing, to lock
     the equivalence.
2. **Warn on fallback.** Import the project logger (`const log = logger("model-metadata")`, matching the
   convention in sibling provider files) and add:
   - in `getModelMetadata` miss: `log.warn("Unknown model, no metadata entry", { modelId })`.
   - in `getContextWindow` fallback to `DEFAULT_CONTEXT_WINDOW`: `log.warn("Unknown model, using default
     context window", { modelId, default: DEFAULT_CONTEXT_WINDOW })`.
   - Optionally in `getThinkingMode` when it defaults to `"effort"` for an id matching no pattern — but only
     if that path is genuinely a "miss" and not the intended default for modern models. **Verify**: modern
     effort-mode models are *expected* to fall to `"effort"`, so a warn there would be noise. Likely **skip
     the thinking-mode warn**; warn only on the two genuine "unknown model" paths.

### Interaction with the `audit-bedrock-thinking` skill
The geo-prefix collapse touches `LEGACY_ENABLED_THINKING_PATTERNS` — the exact set that skill audits. After
this change the patterns are base-id form; the skill's expectations (and any snapshot it compares against)
may need a refresh. Flag this in the PR description and run the skill's audit post-change to confirm no model
silently re-classifies.

### Verification
- Existing `model-metadata.test.ts` stays green through **both** commits (normalize, then collapse).
- Add: a geo-prefixed id (`us.anthropic.claude-...`) and its base id return identical metadata / context
  window / thinking mode.
- Add: an unknown model id triggers the `log.warn` (spy on logger) and returns the default.

### Risk
Low — but the collapse step is where a transcription error could drop a model. Mitigate by the
"normalize-first, collapse-second, test-green-between" sequencing above. Net: **48 entries → 26**, 6+4 geo
alternations gone.

---

## 6. Route fire-and-forget hooks through `TaskLaneQueue` + error surfacing (Issue 6.2) — M, medium risk

### Current state (verified)
- `src/chat/hook-dispatcher.ts` exposes three `void` (fire-and-forget) methods, each already receiving a
  `conversationId`:
  - `dispatchToolCallHook(conversationId, toolName, toolParams)` → calls `dispatchOnToolCall(...)` un-awaited.
  - `dispatchToolResultHook(conversationId, toolName, toolParams, toolResult)` → `dispatchOnToolResult(...)`.
  - `dispatchAfterCompletionHooks(conversationId?)` → `dispatchAfterCompletion(...)`.
- `src/hooks/hook-events.ts`: the underlying `dispatchOnToolCall` / `dispatchOnToolResult` /
  `dispatchAfterCompletion` each run a `void (async () => { ... })()` IIFE. Inside, **per-automation
  try/catch already exists** (`log.error(...)` + `new Notice("Automation error in ...")`). So errors of
  *user automations* are surfaced today; what is **not** surfaced is a throw escaping the IIFE itself, and
  there is **no serialization** between independent hook firings.
- `dispatchOnApprovalRequired` is the lone **acting/awaited** hook — **leave it entirely alone**.
- Dispatch sites in `src/chat/orchestrator.ts`: after-completion at ~1528 (in `responseLoop`'s `finally`,
  un-awaited); conversation-start automations are dispatched *awaited* (~864) — **leave conversation-start
  alone**, it's already ordered. The fire-and-forget targets are tool-call / tool-result / after-completion.
- `src/queue/task-lane-queue.ts`: `enqueue<T>(laneKey: string, fn: () => Promise<T>, delayMs = 0):
  Promise<T>`. **Each `laneKey` gets an independent queue; cross-lane tasks run concurrently.** This is
  exactly what we need: **lane key = conversation id** serializes a single conversation's hooks against each
  other while letting different conversations proceed in parallel. `conversationId` is in scope at all three
  dispatch methods.

### Change
1. Give `HookDispatcher` access to the shared `TaskLaneQueue` (the plugin already owns a
   `_taskLaneQueue` — confirm the instance and thread it into `HookDispatcher`'s construction; do **not**
   create a second queue).
2. In each of the three fire-and-forget dispatch methods, wrap the underlying call:
   ```ts
   // dispatchToolCallHook(conversationId, ...)
   void this.taskLaneQueue
     .enqueue(`hooks:${conversationId}`, () => dispatchOnToolCall(/* ...args... */))
     .catch((err) => {
       log.error("on_tool_call hook dispatch failed", { conversationId, error: err });
       reportHookFailure("on_tool_call", err); // throttled Notice — see below
     });
   ```
   - Use a lane key like `` `hooks:${conversationId}` `` (namespaced so it can't collide with web-search/MCP
     lanes that share the queue).
   - For `dispatchAfterCompletionHooks(conversationId?)` where the id may be `undefined`, fall back to a
     stable lane (e.g. `` `hooks:${conversationId ?? "global"}` ``) — but **prefer** resolving the id at the
     call site in orchestrator (~1528 already computes `completionConvId`), so `undefined` should be rare.
3. **Crucial subtlety:** the underlying `dispatchOn*` functions *currently* fire their own internal IIFE.
   If we enqueue a function that *itself* fires-and-forgets internally, `enqueue` resolves immediately and we
   gain no serialization. **The IIFE must move out** — `enqueue` must wrap the **actual async work**, i.e.
   the body currently inside `void (async () => {...})()`. Refactor `dispatchOnToolCall` /
   `dispatchOnToolResult` / `dispatchAfterCompletion` in `hook-events.ts` to **return the promise** of their
   inner async body (drop the `void (async()=>{})()` wrapper, make the function `async` / return the
   promise) so the queue actually awaits the work. The dispatcher (`hook-dispatcher.ts`) becomes the single
   place that decides "fire-and-forget via queue."
4. **Error surfacing:** add a small throttled-Notice helper (or reuse one if present) so a broken hook shows
   `Notice("Hook \"<trigger>\" failed — see console")` at most once per throttle window, plus the
   structured `log.error`. The per-automation try/catch inside the IIFE bodies can stay (it gives
   per-automation granularity); the new `.catch` on the enqueued promise catches anything that escapes.
   - This is the natural first adopter site for the `ErrorReporter` floated in §6.3 of the parent spec — but
     **do not build `ErrorReporter` here** (that's Stage 4, opportunistic). A local throttled-Notice
     function in `hook-dispatcher.ts` is sufficient for Stage 0.

### Lane-keying verification (the parent spec's explicit caveat — risk note #5)
**Confirm `laneKey === conversationId` (namespaced), never a single global lane.** The verified
`TaskLaneQueue` semantics (independent queue per key, concurrent across keys) satisfy this. Add a test:
enqueue two hooks for conversation A and one for conversation B; assert A's two run in order and B's is not
blocked behind A.

### Verification
- New tests in `src/hooks/` (currently a **zero-test zone** — this also dents §6.4):
  - two `on_tool_result` hooks for the same conversation execute **in enqueue order** (serialized);
  - hooks for different conversations are **not** serialized against each other;
  - a hook that throws produces a `log.error` and a (throttled) Notice, and does **not** reject the caller.
- Manual: trigger a vault-mutating `after_completion` hook twice rapidly in one conversation; confirm no
  interleave.

### Risk
**Medium** — this is the one Stage-0 item that changes control flow. The two real hazards:
1. **The internal-IIFE removal (step 3)** is the load-bearing refactor; if the inner body still
   fire-and-forgets, serialization is silently a no-op. Test for ordering explicitly.
2. **Don't serialize too much:** only the three observe-only triggers go through the queue. The awaited
   `on_conversation_start` and the acting `on_approval_required` stay synchronous/awaited as today.

---

## 7. Widen the `ApprovalDecision` type (Issue 3.5) — S, low risk (do before item 9)

### Current state (verified)
- `ApprovalCallback` (`src/chat/dispatcher.ts` ~68): `(toolCall, abortSignal?, messageId?, autoApproved?) =>
  Promise<"approved" | "rejected">`. Note: the callback type is **narrower** than what the system actually
  produces — `raceApprovalSources` (~305–345) returns `"approved" | "rejected" | "timed_out"` (the
  `"timed_out"` originates from the timeout racer; the approval-hook `"pass"` becomes a never-resolving
  promise so it never wins).
- Consumers branch on the string in **both** dispatch branches: pure path ~434 (`userDecision === "rejected"
  || userDecision === "timed_out"`) and legacy path ~573 (same). Item 9 deletes the legacy branch — hence
  **do item 7 first** so the widening touches both, then 9 removes one.
- Producers: UI (`src/ui/message-renderer.ts` `renderApprovalPrompt` ~426 returns `"approved" |
  "rejected"`; diff-approval paths ~544/~584); the hook side `dispatchOnApprovalRequired`
  (`src/hooks/hook-events.ts` ~980–1075) returns `"approved" | "rejected" | "pass"`.
- **Persistence:** approval outcome is persisted as `ToolCall.status` (`ToolCallStatus =
  "pending"|"approved"|"rejected"|"success"|"error"` in `src/types.ts` ~206), serialized into the JSONL
  transcript and rendered via `updateToolCallStatus`. Today `"timed_out"` is **normalized to `"rejected"`**
  at status-write time.

### Change — define the wire shape now; keep behavior identical
1. In `src/chat/dispatcher.ts` (or a small shared types spot) add:
   ```ts
   export type ApprovalDecision = {
     decision: "approved" | "rejected" | "timed_out";
     modifiedParams?: Record<string, unknown>;
     message?: string;
   };
   ```
2. Widen `ApprovalCallback` to return `Promise<ApprovalDecision>`. Update `raceApprovalSources` to return
   `Promise<ApprovalDecision>`.
3. **Mechanical migration of producers:** UI handlers return `{ decision: "approved" }` /
   `{ decision: "rejected" }`; the timeout racer returns `{ decision: "timed_out" }`.
4. **Hook adapter at the boundary:** `dispatchOnApprovalRequired` keeps returning its string union
   (`"approved"|"rejected"|"pass"`) — adapt at the dispatcher boundary where it's consumed: map `"approved"`
   /`"rejected"` → `{ decision }`, and `"pass"` keeps its existing "never wins the race" semantics
   (don't wrap it into an `ApprovalDecision`; it's a control signal, not a decision). Keeping hooks on
   strings avoids touching `hook-events.ts`'s contract in Stage 0.
5. **Consumers:** both branch sites change from `x === "rejected" || x === "timed_out"` to
   `x.decision === "rejected" || x.decision === "timed_out"`. Apply `modifiedParams` over `parameters`
   when present **right before execution** — a few lines: `const effectiveParams = decision.modifiedParams
   ?? parameters;` then execute with `effectiveParams`. (No UI yet produces `modifiedParams`, so this is
   inert plumbing today — but the wire format is locked.)
6. **Persistence:** leave `ToolCallStatus` as-is for Stage 0 (continue normalizing `"timed_out"` →
   `"rejected"` for the persisted status). Adding `"timed_out"` as a distinct persisted status + its CSS
   would be a UI change out of scope here; note it as a deferred enhancement. The *protocol* widening (the
   expensive, hard-to-change-later part) is what we lock now; the persisted status is cheap to widen later.

### Verification
- `tsc` clean across dispatcher, ui/message-renderer, hooks adapter.
- Existing approval E2E tests (`e2e/scripts/ask-user-test.ts`) still pass — they assert behavior, which is
  unchanged.
- Add a unit test: a callback returning `{ decision: "approved", modifiedParams: {...} }` causes the tool to
  execute with the modified params (proves the plumbing, even with no UI).

### Risk
Low. Purely additive to the wire shape; behavior preserved. The only churn is mechanical (string →
`{decision}`). Doing it before item 9 means the two-branch edit collapses to one-branch after 9.

---

## 8. (Stage 0.5) Delete the legacy dual policy path (Issues 3.2 / 3.3) — M, medium risk, **release-gated**

### Current state (verified) — control flow in `dispatcher.dispatch()`
```
if (policyCtx)            { /* PURE: evaluateToolPolicy(...) */ }     // ~405–460
else if (tool.internal)   { /* bypass: status=approved */ }          // ~461–464
else                      { /* LEGACY inline checks */ }             // ~465–630
```
Legacy sub-sections (verified ranges): enabled check ~468–486 · Plan/Act ~488–508 · `fetch_webpage`
denylist ~510–537 · auto-approve resolution ~539–555 · approval loop ~559–597 · mark-approved ~599–601 ·
path enforcement ~603–630.

`evaluateToolPolicy` (`src/chat/tool-policy.ts` ~85–186) returns `PolicyDecision { allowed, autoApproved,
error? }` and covers: internal bypass (~91), enabled (~95), Plan/Act (~105), `fetch_webpage` denylist
(~119), auto-approve (~140), **`execute_command` command-pattern override (~144–162)**, path enforcement
(~164).

`dispatch()` signature: `policyCtx` is the **7th positional param** and **optional**.

### The D1 nuance, re-confirmed and sharpened
The legacy branch is **reachable** today via:
1. **`policyCtx`-omitting callers** — `e2e/scripts/mcp-auto-approve-test.ts:284` calls
   `dispatcher.dispatch(toolName, {}, "plan", "test-plan-block")` with only 4 args (no `policyCtx`).
   (`e2e/scripts/ask-user-test.ts` *does* pass `policyCtx` at both its dispatch sites.)
2. **The `tool.internal` bypass** sits between pure and legacy — internal tools touch neither policy path.
3. **Any future non-session caller** lands in legacy.

**Production callers both pass `policyCtx`:** `src/chat/tool-orchestration.ts` (~280, policyCtx at pos 7)
and `src/chat/workflow-executor.ts` (~829, policyCtx at pos 7). So the legacy path is **near-dead in
production** but **not dead in tests**.

### ⚠️ New finding that *reduces* risk (and rewrites the porting story)
The parent spec's D1 says "port any legacy-only behavior into `evaluateToolPolicy` before deleting." Direct
diff shows the legacy path is a **strict subset** of `evaluateToolPolicy`, **minus** one thing:
**`execute_command` command-pattern matching (`blocked_command_patterns` / `allowed_command_patterns`)
exists ONLY in the pure path** (`tool-policy.ts` ~144–162) and is **absent from the legacy block**
(`grep blocked_command|allowed_command|command_pattern src/chat/dispatcher.ts` → **none**).

**Implication:** there is **nothing in legacy that the pure path lacks** — so **no back-porting is
required**. The legacy path is simply *less safe* (it skips command-pattern enforcement). This means:
- Making `policyCtx` mandatory and routing everything through `evaluateToolPolicy` is a **safety
  improvement**, not just a dedup.
- The gate is therefore **"prove legacy is unreachable in production,"** not "reconcile behavior." The
  tripwire is still warranted (item 1 below) because a non-session caller hitting legacy today would
  *silently bypass* command-pattern policy — exactly the kind of latent gap worth confirming gone.

### Change — gated sequence (two releases)

**Release N (ships with Stage-0 items 1–7):**
1. **Tripwire.** Add `log.error("LEGACY POLICY PATH HIT — policyCtx was not provided", { toolName, mode })`
   as the **first line** of the `else` (legacy) branch (~466). Ship it. The goal: confirm it never fires for
   real users across one release cycle.
2. **Fix the test that omits `policyCtx`.** Update `e2e/scripts/mcp-auto-approve-test.ts:284` to pass a
   `policyCtx` (build one the way the other E2E test / `orchestrator.ts ~1305` does). This removes the one
   *known* legacy caller so the tripwire's signal is clean (any fire = a real, unexpected caller).
   - Decide: do you want the test to still exercise *something*? Re-point it at the pure path with a proper
     `policyCtx` so it keeps asserting Plan-mode blocking — that coverage is valuable and should not be lost.
3. **Reconcile `tool.internal`.** Fold the bypass into `evaluateToolPolicy` as an explicit short-circuit
   (it already has `if (tool.internal) return { allowed:true, autoApproved:true }` at ~91!). So once
   `policyCtx` is mandatory, the dispatcher's separate `else if (tool.internal)` branch is **redundant** and
   can be removed in Release N+1 along with legacy — internal tools flow through the pure path and hit the
   same early return. **Verify** the pure path's internal short-circuit is behaviorally identical to the
   dispatcher's current bypass (it sets `status="approved"` + fires `onToolCallStatusChanged`; ensure the
   pure path does the equivalent status transition after `evaluateToolPolicy` returns auto-approved). This is
   the one behavioral check to get right.

**Release N+1 (after tripwire confirmed silent):**
4. Make `policyCtx` a **required** parameter of `dispatch()` (drop the `?`). This forces every caller —
   incl. any future one — to provide it; the type system now prevents the legacy fall-through.
5. **Delete** the `else if (tool.internal)` bypass (~461–464) and the entire legacy `else` block
   (~465–630). The control flow becomes: always `evaluateToolPolicy`, then approval, then execute.
6. Remove now-dead helpers used **only** by the legacy block (audit each before deleting): e.g.
   `this.autoApprove` field, `resolveAutoApprove`, `resolveMcpAutoApprove`, the instance-level
   `this.approvalCallback` fallback (~557), `this.effectiveToolConfig` reads in dispatcher — **only if** no
   other code path references them. Grep each symbol repo-wide before removing; several may still be used by
   sub-agent dispatchers that set approval via `setApprovalCallback` on their own dispatcher instance (the
   legacy approval loop comment at ~561 calls this out — **verify the sub-agent runner path** before
   removing `this.approvalCallback`).
7. Pairs with **Issue 3.3**: with legacy gone, the `fetch_webpage` denylist exists in exactly one place
   (`evaluateToolPolicy`). The full 3.3 refactor (move per-tool checks behind `Tool.policyCheck?()`) is
   **out of scope for Stage 0.5** — note it as the immediate Stage-1-adjacent follow-up. The Stage-0.5 win
   is just collapsing to the single pure path.

### Call-site audit checklist (run before Release N+1 deletion)
- `grep -rn "\.dispatch(" src/ e2e/` — enumerate every dispatcher `.dispatch(` call. Verified set:
  - `src/chat/tool-orchestration.ts:~280` — passes policyCtx ✓
  - `src/chat/workflow-executor.ts:~829` — passes policyCtx ✓
  - `e2e/scripts/ask-user-test.ts:~764, ~918` — passes policyCtx ✓
  - `e2e/scripts/mcp-auto-approve-test.ts:~284` — **does NOT** (fixed in step 2)
- **Check the sub-agent runner** (`src/chat/sub-agent-runner.ts`) — the review flags it as a possible
  dispatch path. Confirm whether it dispatches tools and, if so, whether it passes `policyCtx`. If it
  constructs its own `ToolDispatcher` and relies on the legacy approval-callback fallback, that path **must**
  be migrated to `policyCtx` before deletion, or it breaks. **This is the single highest-risk unknown** —
  resolve it explicitly during the audit.

### Verification
- Tripwire release: monitor logs (telemetry / user reports) for the `log.error` string; zero hits across the
  release window is the green light.
- New tests (the §6.4 "do immediately" item — `dispatchOnApprovalRequired` decision precedence is separate;
  here we want **policy** coverage): port the behaviors the legacy E2E asserted into unit tests over
  `evaluateToolPolicy` (Plan-mode block, disabled-tool block, denylist, auto-approve, command-pattern,
  path enforcement). `tool-policy.test.ts` (~158 lines) is the anchor — extend it.
- After deletion: full `tsc` + test suite; the `partitionToolCalls`/dispatch E2E flows must stay green.

### Risk
**Medium.** Two specific hazards, both addressable:
1. **Sub-agent runner dispatch path** — unverified whether it passes `policyCtx`. Resolve in the audit; if
   it uses the legacy approval fallback, migrate it first. **Do not delete `this.approvalCallback` until this
   is settled.**
2. **`tool.internal` bypass equivalence** — confirm the pure path's `tool.internal` early-return produces
   the identical status transition the dispatcher's separate bypass does, before removing the bypass branch.

---

## 9. Cross-cutting: build / test / commit hygiene

- **Build gate:** every item ends with `npm run build` (or `tsc --noEmit`) clean. Several items (4, 7, 8)
  are type-driven and `tsc` is the primary safety net.
- **Test zones touched:** items 2, 6, 8 add tests to currently **zero-test** or thin areas
  (`src/hooks/`, checkpoint round-trip, `model-metadata.test.ts`, `tool-policy.test.ts`). This is the
  parent spec's §6.4 "weave tests into the migrations that touch each zone" — honor it; do not skip.
- **Commit granularity (per repo git rules — use `mcp__git` tools, not raw CLI):** one logical unit per
  commit. Suggested commits:
  1. `Extract shared providers/openai-format.ts` (item 1)
  2. `Add schema_version to JSONL/checkpoint/memory artifacts` (item 2)
  3. `Rename workflows/workflow-executor.ts → prompt-assembly.ts` (item 3)
  4. `Resolve personaManager via lazy getter in getDispatcherDeps` (item 4)
  5. `Normalize geo-prefixed model ids + warn on metadata fallback` (item 5; optionally split
     normalize/collapse into two commits)
  6. `Serialize fire-and-forget hooks via TaskLaneQueue + surface failures` (item 6)
  7. `Widen ApprovalDecision wire shape (UI/behavior unchanged)` (item 7)
  8. `Add legacy-policy-path tripwire + fix policyCtx-omitting E2E test` (item 8, Release N)
  9. *(Release N+1)* `Make policyCtx required; delete legacy dual policy path` (item 8, Release N+1)

---

## 10. What this plan deliberately does NOT do

- **No `ErrorReporter` (§6.3)** — item 6 uses a local throttled-Notice helper; the shared reporter is Stage 4.
- **No `Tool.policyCheck?()` refactor (§3.3 full form)** — item 8 only collapses to the single pure path;
  moving `fetch_webpage`/`execute_command` checks into tool implementations is the Stage-1-adjacent follow-up.
- **No persisted `"timed_out"` status / "modify & approve" UI** — item 7 locks only the wire shape.
- **No `workflows/types.ts` extraction (§6.5)** — the rename (item 3) stays mechanical.
- **No model-metadata move behind `provider.getCapabilities()` (§4.3)** — item 5 is in-file hygiene only.

---

## 11. Open questions to resolve at implementation time

1. **Sub-agent runner dispatch path (item 8, high priority):** does `src/chat/sub-agent-runner.ts` dispatch
   tools, and does it pass `policyCtx`? This gates whether `this.approvalCallback` / the legacy approval
   fallback can be removed. **Resolve before any deletion.**
2. **`getPersonaManager()` early-call safety (item 4):** confirm it can't throw if invoked at the earliest
   moment a vault event could fire; if it can, use the accessor-function form instead of the value form.
3. **Log-tag / string assertions (items 1, 5):** grep `e2e/` and tests for the exact "OpenAI"/"local
   provider"/thinking-pattern strings before changing them, in case any test scrapes them.
4. **Shared `TaskLaneQueue` instance (item 6):** confirm `HookDispatcher` can reach the plugin's existing
   `_taskLaneQueue` rather than spawning a second queue.
