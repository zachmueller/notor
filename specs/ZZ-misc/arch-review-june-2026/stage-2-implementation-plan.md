# Stage 2 — Implementation Plan ("Restructure the loop for the next tier of tool complexity")

**Status:** Ready to implement (after Stage 0 lands; benefits from Stage 1 but not strictly gated by it — see §0)
**Parent spec:** [`../fable-architecture-review-2606.md`](../fable-architecture-review-2606.md) §4 (Stage 2), §5 matrix, §6 risk notes
**Sibling plans:** [`stage-0-implementation-plan.md`](./stage-0-implementation-plan.md) (the `ApprovalDecision` type widening lives there — item 5 below depends on it) · [`stage-1-implementation-plan.md`](./stage-1-implementation-plan.md) (item 3's renderer-registry migration and item 4's serializer split interact — see §0 ordering)
**Source review:** `private/architecture-review-2026-06-11.md` + `private/architecture-review-2026-06-11-code-map.md` (git-ignored)
**Code verified against:** working tree at HEAD `0cd34b6` (which adds *only* the parent spec + Stage-0/1 plans on top of the reviewed `f7049d0`; all `src/` is byte-identical to the commit the review cites). Re-verified by direct read on 2026-06-14 via five parallel read-only agents (one per Stage-2 item).

> **Line-number caveat.** Every `file:line` below was confirmed by direct read at `0cd34b6`. Line numbers
> drift. **Re-locate by symbol name at implementation time, not by line.** Where a range is given it is to
> scope the work, not to be applied as a patch coordinate.

---

## 0. Scope & sequencing

Stage 2 is the **P3 stage**: it removes the four assumptions the agent loop bakes in that wall off the next
tier of tool complexity — positional batch barriers, final-only tool results, a serialization function that
fuses three (really *four*) responsibilities, and binary-only approvals. None of it is a rewrite; each item
is a contained surgery on a well-tested seam, and three of the five items have a strong existing test to
anchor against.

### The five Stage-2 items

| # | Item | Issue | Effort | Risk | Depends on |
|---|------|-------|--------|------|------------|
| 1 | **Mode-keyed readers-writer scheduler** replacing positional batching | 3.4 | M | Med | — (but **write baseline tests first** — zero today) |
| 2 | **Tool-execution event channel** (`emit({progress\|partial-result})`) | 3.7 | M | Med | item 4 *only* for first-class partial transcript elements |
| 3 | **Split `toChatMessages()`** into pure pipeline steps + serializer map | 3.1 | M | Med | — (531-line test anchors) |
| 4 | **Thread token budget + explicit depth** to sub-agents | 3.6 | S | Low | — |
| 5 | **Approval UI affordance** ("modify & approve") | 3.5 (UI half) | S | Low | **Stage 0 item 8** (the `ApprovalDecision` type widening) |

> Renumbering note: this plan numbers items 1–5 for sequencing; the parent-spec issue ids (3.4, 3.7, 3.1,
> 3.6, 3.5) are kept in every heading so the mapping is unambiguous.

### Critical ordering — what gates what

The hard dependency edges are few; most of Stage 2 is parallelizable across disjoint files:

1. **Item 5 (approval UI) requires Stage 0 item 8.** The Stage-0 plan widens `ApprovalCallback` to return
   `ApprovalDecision = { decision; modifiedParams?; message? }` and makes the dispatcher apply
   `modifiedParams` over `parameters` before execution. **Do not start item 5 until that has merged** — the
   UI affordance is meaningless until the wire actually carries `modifiedParams` through to the tool. (See
   the §5 discovery: `replace_in_note` *already* mutates params and silently drops them — Stage 0 builds the
   pipe, Stage 2 connects the faucet.)
2. **Item 2's *first-class partial transcript elements* are gated on item 4 of Stage 1** (the message-pipeline
   serializer split — confusingly that is "Stage 1 item 4"? no: it is **this plan's item 3**, the §4 below).
   Restating cleanly: item 2's *backward-compatible default* (wrap today's `onProgress`) has **no
   dependency** and should land first; making `partial-result` a first-class transcript element must wait
   until **this plan's item 3** (the `toChatMessages` serializer split) exists, because a new transcript
   element type otherwise lands as yet another hand-coded `switch` arm — the exact anti-pattern item 3
   removes. So within Stage 2: **item 3 before item 2's transcript-element phase.**
3. **Item 3 (pipeline split) interacts with Stage 1 item 3 (renderer registry).** Stage 1 migrates *rendering*
   of built-in block kinds onto `ChatBlockRegistry`; this item 3 splits the *wire serialization*
   (`toChatMessages`) into a per-role serializer map. They touch different files (`ui/message-renderer.ts`
   vs `chat/message-pipeline.ts`) and are independent, but both are "make built-ins go through a registrable
   map" moves — coordinate naming so the two maps read as siblings, not rivals.
4. **Items 1 and 4 are fully independent** of everything else and of each other (disjoint files:
   `chat/tool-orchestration.ts` vs `chat/sub-agent-runner.ts` + `tools/use-subagent.ts`). Item 4 is the
   cheapest (S, Low) and a good warm-up; item 1 needs a **test-writing prelude** because the file it rewrites
   has **zero tests today** (verified — no `tool-orchestration.test.ts` exists).

### Recommended landing order

`4 (warm-up) → 1 (with its test prelude) → 3 (serializer split) → 2 (event channel: default first, then transcript elements) → 5 (after Stage 0 item 8)`. Items can overlap where files are disjoint; the only
strict edges are 5⇐Stage0-8 and 2-transcript-elements⇐3.

### Relationship to other stages (do NOT scope-creep)

- **Stage 0.5 / 3.3 `Tool.policyCheck?()`** — not here; the policy refactor is its own track.
- **Stage 1 item 3 renderer registry** — item 5 below assumes the diff/approval rendering still lives where
  it is today (`message-renderer.ts`); if Stage 1 has already migrated diff/approval into per-tool block
  defs, item 5's UI changes move *into those block defs* instead. Both targets are noted in §5.
- **Stage 4 loop middleware (2.5)** — item 2's event channel is *not* hook middleware; it is tool→dispatcher
  output streaming. Middleware that transforms results is Stage 4 and depends on Runtime API v1.

---

## 1. Mode-keyed readers-writer scheduler (Issue 3.4) — M, medium risk

Positional batching makes one write call a barrier for everything after it: with call order
`[read, write, read, read]`, the trailing reads serialize behind the write even though they are independent.
Because MCP tools default to *unsafe* (write) unless the user explicitly classifies them read, an MCP-heavy
turn degrades to fully sequential. The `mode: "read" | "write"` metadata that *should* drive scheduling
already exists; only the scheduling **shape** is wrong.

### Current state (verified — `src/chat/tool-orchestration.ts`, 308 lines)

- `partitionToolCalls(calls, dispatcher): Batch[]` (~56–77). `Batch = { isConcurrencySafe: boolean; calls:
  ToolCallInfo[] }`. Algorithm: walk calls in order; extend the current batch **only if** it is safe *and*
  the last batch is safe; otherwise start a new batch. So a write starts a new (serial) batch and the next
  safe run cannot rejoin the prior safe batch — a **positional barrier**.
- `isConcurrencySafe(toolName, dispatcher)` (~83–99):
  - unknown tool → `false` (conservative);
  - MCP tool → `dispatcher.hasExplicitUserReadClassification(toolName)` (~93–95) — **unsafe unless the user
    classified the raw MCP tool as `read` in `toolClassifications`**;
  - built-in → `!dispatcher.isWriteTool(toolName)` (~98).
- `DEFAULT_CONCURRENCY_CAP = 5` (~106). Semaphore in `runConcurrentBatch()` (~214–259): `activeCount` +
  `waitQueue`, `acquire()`/`release()`, all batch promises created via `calls.map()` then `Promise.all` so
  **submission order is preserved** within a concurrent batch.
- `executeToolBatches(batches, dispatcher, mode, messageIdMap, abortSignal?, concurrencyCap=5,
  onProgressMap?, policyCtx?, approvalCallback?, sessionContext?, approvalHookDispatcher?,
  interactionCallback?): Promise<ToolCallResult[]>` (~114–190). Accumulates `allResults` in batch order;
  serial batches append per-call (~168–185); concurrent batches push the `Promise.all` result (~151–165).
  **Abort handling:** remaining calls in an aborted batch get synthetic error results (~134–146, 169–180).
- `safeDispatch(call, dispatcher, mode, messageId, abortSignal?, onProgress?, policyCtx?, approvalCallback?,
  sessionContext?, approvalHookDispatcher?, interactionCallback?): Promise<ToolResult>` (~266–308) → calls
  `dispatcher.dispatch(...)` at ~280–292, catches exceptions into a `ToolResult` error (~295–307).
- Dispatcher predicates (`src/chat/dispatcher.ts`): `isWriteTool(name)` → `tool?.mode === "write"` (~732–735);
  `hasExplicitUserReadClassification(name)` → MCP-only, `config.toolClassifications?.[rawName] === "read"`
  (~745–751). MCP `mode` resolution (`src/mcp/mcp-tool-adapter.ts` ~131–153): user override →
  `readOnlyHint === true` → default `"write"`.
- `Tool.mode: "read" | "write"` — `src/tools/tool.ts` ~115. `ToolDefinition.mode?` ~95 (optional in the
  LLM-facing definition).
- **Tests: NONE.** No `tool-orchestration.test.ts` (or similar) exists — verified. This file has **zero unit
  coverage** today.

### Change

**Step 0 (prelude — do this first): write characterization tests for the *current* behavior.** Before
touching the algorithm, add `src/chat/tool-orchestration.test.ts` capturing today's observable contract:
ordering preserved by call index; consecutive safe calls run concurrently capped at 5; a write is a barrier;
MCP tools default serial unless classified read; aborts produce synthetic error results for the unrun tail.
These tests are the **behavioral baseline** the parent spec (§3.4) calls for — they must stay green for the
read-parallel cases and *change deliberately* only for the interleaving cases the new scheduler improves.

**Step 1: replace `partitionToolCalls` with a per-turn readers-writer scheduler.** New shape (keep
`tool-orchestration.ts` as the home):

```ts
// Conceptual contract — names are a design choice.
async function scheduleToolCalls(
  calls: ToolCallInfo[],
  dispatcher: ToolDispatcher,
  concurrencyCap = DEFAULT_CONCURRENCY_CAP,
  /* …the same dispatch dependencies safeDispatch needs… */
): Promise<ToolCallResult[]>;
```

Semantics (a readers-writer lock over a single shared cap):
- A **read** (concurrency-safe per the *unchanged* `isConcurrencySafe` predicate) may run as soon as a
  semaphore slot is free **and** no write is in-flight or waiting ahead of it (preserve the writer's
  exclusivity; do not let a late read starve a queued write).
- A **write** waits for all in-flight reads to drain, then runs **exclusively** (no other call in flight),
  then releases — after which queued reads resume.
- This removes the *positional* barrier: in `[read, write, read, read]` the leading read runs immediately,
  the write waits for it, and the two trailing reads run concurrently after the write — instead of all three
  reads being gated by batch position.
- **Preserve transcript ordering by call index**, exactly as today: results are collected into a
  by-index array regardless of completion order (the current `allResults`-in-batch-order guarantee becomes
  "results sorted by original call index"). This is load-bearing — the message pipeline and renderer assume
  stable call order.

**Step 2: keep `isConcurrencySafe` and the dispatcher predicates unchanged.** The classification logic is
correct; only the *scheduling* changes. MCP-default-unsafe still holds — but now a turn with
`[mcp_read?, builtin_read, builtin_read]` no longer serializes the two builtin reads behind an unclassified
MCP call, because reads no longer barrier each other.

**Step 3: thread `safeDispatch`'s dependency bundle through unchanged.** The scheduler calls the existing
`safeDispatch` per call; `policyCtx`, `approvalCallback`, `approvalHookDispatcher`, `onProgressMap`,
`interactionCallback`, `sessionContext`, `abortSignal` all flow exactly as in `executeToolBatches` today.
Consider collapsing the 11-positional-arg `safeDispatch`/`executeToolBatches` signatures into a single
`deps` object **opportunistically** while you are in the file (it will make the scheduler readable) — but
that is a refactor rider, not the point; keep it in its own commit if done.

**Step 4: abort semantics.** Preserve today's contract: on `abortSignal` firing, calls not yet started get
synthetic "cancelled" error results, in-flight calls are signaled, and the writer lock is released so the
turn can unwind. Test the abort-mid-write and abort-with-queued-reads cases explicitly.

### Verification
- The Step-0 characterization tests stay green for read-parallel, cap-enforcement, and abort cases; the
  *interleaving* tests are updated to assert the new (better) concurrency: trailing reads after a write no
  longer serialize.
- New tests: `[read, write, read, read]` runs the trailing reads concurrently after the write; a turn of
  N unclassified MCP reads still serializes (they are writes by default — unchanged) but mixed with builtin
  reads the builtins parallelize; result array is index-ordered regardless of completion order.
- `tsc` + full suite green.

### Risk
**Medium.** The risk is **subtle concurrency correctness**, not API churn: a readers-writer lock that lets a
read sneak past a queued write, or that releases the writer lock early, can interleave a write with reads of
the same note. Mitigate with the Step-0 baseline tests, explicit interleaving/abort tests, and keeping the
*classification* predicate byte-identical (the bug surface is the lock, not the safety check). The file's
zero-test starting point is itself a risk — the prelude is non-optional.

---

## 2. Tool-execution event channel (Issue 3.7) — M, medium risk

`Tool.execute()` returns a single terminal `ToolResult`; long-running tools block the whole turn with no
partial output, no progress-to-LLM, no backpressure. A `progress` callback exists but is **UI-only** — the
status strings never reach the transcript or the LLM.

### Current state (verified)

- `Tool.execute(params, options?: ToolExecuteOptions): Promise<ToolResult>` — `src/tools/tool.ts` ~127.
- `ToolExecuteOptions.onProgress?: (status: string) => void` — ~43 (alongside `mode`, `abortSignal`,
  `sessionContext`, `silentNoteOpener`, `interactionCallback`).
- `ToolResult` (`src/types.ts` ~225–243): `tool_name`, `success`, `result`, `content_blocks?`, `error?`,
  `duration_ms?`, `tool_call_id?`, `sub_agent_metadata?`. **No progress / partial field.**
- Progress plumbing today (UI-only, end to end):
  1. Orchestrator builds `onProgressMap` keyed by `toolCallId` (`src/chat/orchestrator.ts` ~1292–1302); each
     entry calls `getViewForSession(session)?.updateToolCallProgress(el, status)` (~1299).
  2. `executeToolBatches` / `safeDispatch` pass `onProgressMap?.get(call.toolCallId)` per call
     (`tool-orchestration.ts` ~183).
  3. `dispatcher.dispatch(...)` forwards `onProgress` into `ToolExecuteOptions` at ~644–645
     (`const executeOptions = { onProgress, mode, abortSignal, sessionContext, … }`).
  4. `SubAgentRunner` consumes `onProgress` (`src/chat/sub-agent-runner.ts` ~125, emitted ~218/346/383).
  5. Extensions get `utils.onProgress` injected (`src/extensions/manager.ts` ~96); scaffolds like
     `builtin-tool-scaffolds/sleep.ts` call `utils.onProgress?.(...)`.
  6. UI sink: `message-renderer.ts updateToolCallProgress` writes `.notor-tool-call-progress` text +
     scrolls. **Ephemeral DOM only — never persisted, never sent to the LLM.**
- `convManager.addMessage({ role: "tool_result", content: "", tool_result })` (orchestrator ~1365–1369) and
  `conversation.ts addMessage` (~328–377) have **no progress/partial fields** — confirming progress never
  enters the transcript.

### Change

**Phase A (backward-compatible default — land first, no dependencies).**
1. Add an `emit` channel to `ToolExecuteOptions`:
   ```ts
   type ToolExecutionEvent =
     | { type: "progress"; status: string }
     | { type: "partial-result"; chunk: string | ContentBlock[] };
   // in ToolExecuteOptions:
   emit?: (event: ToolExecutionEvent) => void;
   ```
2. **Default `emit` wraps today's `onProgress`** so *every existing tool is unchanged*: in the dispatcher,
   when building `executeOptions`, construct
   ```ts
   const emit = options.emit ?? ((e) => { if (e.type === "progress") onProgress?.(e.status); });
   ```
   Keep `onProgress` on the options for now (tools still call `utils.onProgress`); `emit` is the superset.
   Optionally bridge the other direction too (a tool that calls `emit({type:"progress"})` reaches the same
   UI sink) by routing `progress` events through the existing `onProgressMap` callback.
3. Dispatcher forwards `progress` events to the UI immediately (replacing/duplicating the bespoke
   `onProgress` path) and **digests `partial-result` events into the final `ToolResult`** — e.g. accumulate
   chunks and append a digest to `result` (or a new optional `ToolResult.partial_digest?: string`) so the
   LLM sees the streamed output *as part of the terminal result*. No transcript-shape change yet.

**Phase B (first-class partial transcript elements — gated on item 3).**
4. Only after **item 3's serializer split** exists, make `partial-result` a first-class transcript element:
   a new message role/block kind serialized by its own entry in the `Record<Role, serializer>` map (item 3),
   *not* a new arm in the monolithic switch. This is the parent spec's explicit sequencing ("First-class
   partial transcript elements only after 3.1's serializer split"). Wire `partial-result` events to append
   such elements to the conversation as they arrive; the renderer registry (Stage 1 item 3) renders them.

### Verification
- Phase A: an existing tool that calls `utils.onProgress(...)` behaves identically (UI text updates); a tool
  that calls `emit({type:"progress"})` reaches the same UI sink; a tool that calls
  `emit({type:"partial-result"})` has its chunks digested into the final `ToolResult` visible to the LLM.
  `sleep.ts` (the existing progress-emitting scaffold) is the natural regression anchor.
- Phase B: a partial-result element appears in the transcript and round-trips through `toChatMessages` via
  its serializer (no switch edit); persisted + reloaded conversation renders it.
- `tsc` + suite green; SubAgentRunner's progress emission (~218/346/383) still flows.

### Risk
**Medium.** Phase A is genuinely backward-compatible (the `emit ?? onProgress-wrapper` default is the safety
net). The risk concentrates in Phase B's transcript-shape addition — which is *why it is gated on item 3*:
adding a transcript element before the serializer split means hand-editing the switch and both repair passes,
reintroducing the coupling item 3 removes. Do Phase A now; hold Phase B until item 3 lands.

---

## 3. Split `toChatMessages()` into pure pipeline steps + serializer map (Issue 3.1) — M, medium risk

`toChatMessages()` fuses role→wire conversion, orphan repair, and coalescing in one function. Every new
transcript concept (streamed progress, multi-part results, annotations) lands here as another `switch` arm
plus interactions with the repair passes. The `extension_block` case is the precedent that proved the cost.

### Current state (verified — `src/chat/message-pipeline.ts`, 583 lines)

- `toChatMessages(messages: Message[], systemPrompt: string): ChatMessage[]` (~267–532).
- **Phase 1 — role switch** `switch (msg.role)` (~271–361), **six cases**:
  - `system` (~272–277): wrap `systemPrompt`.
  - `user` (~279–284): pass through.
  - `assistant` (~286–302): **silently skips** empty assistant text with `log.warn("Skipping assistant
    message with empty content", { id })` (~293–295).
  - `tool_call` (~304–320): wrap; id precedence `msg.tool_call.id ?? msg.id` (~313).
  - `tool_result` (~322–343): wrap, stringify, error tracking.
  - `extension_block` (~345–356): `getWireText(content, moduleRegistry)` (~346) → wrap in
    `<notor-ext source="…">` (~349–351); **silently drops** the message when `getWireText` returns null
    (~354).
  - `default`: `assertUnreachable(msg.role)`.
- **Phase 2 — orphan repair** (~363–436): inject synthetic `"Tool call was cancelled by the user."`
  (`is_error: true`) results for unmatched `tool_call` ids; `log.warn` per injection (~429–432).
- **Phase 3 — coalesce tool runs** (~438–493): merge consecutive `tool_call`/`tool_result` runs; **absorb
  preceding assistant text** into the coalesced `tool_call` message (~451–469).
- **Phase 4 — same-role coalescing** (~495–521): merge adjacent same-role messages with no
  tool_calls/tool_results (normalizes both to `ContentBlock[]` and concatenates). Handles extension-block
  adjacency **and the Bedrock strict-alternation fix**.

  > **Discovery — the review undercounts the responsibilities.** Both source docs describe *three*
  > responsibilities (convert / repair-orphans / coalesce). There are **four** distinct passes: Phase 4
  > (same-role coalescing, ~495–521) is a separate concern the code-map's "267–436" range and the parent
  > spec's `convertRoles → repairOrphans → coalesceToolRuns` triple both omit. The split must therefore be
  > **four** named steps, not three — see Change.

- Helpers: `getWireText(content, registry?): string | null` (~49–73); `moduleRegistry` stub wired via
  `setChatBlockRegistry()` (~28–40); `getModelMetadata` used by `calculateCost()` (~573, unrelated to the
  switch — leave it).
- `MessageRole = "system" | "user" | "assistant" | "tool_call" | "tool_result" | "extension_block"`
  (`src/types.ts` ~132). `ChatMessage` (`src/providers/provider.ts` ~24–39): role union (**no
  `extension_block`** — it is converted *into* user role), `content`, `tool_calls?`, `tool_results?`.
- **Tests:** `src/chat/message-pipeline.test.ts` (531 lines) covers `getWireText` (13 cases) and the
  `extension_block` + coalescing behavior (8 cases incl. extension-block/user coalescing, two-block
  coalescing, hook-injection alternation, ContentBlock normalization). **Gaps:** no explicit tests for the
  orphan-repair pass, the tool-run coalescing, pre-tool-call text absorption, or the assistant empty-skip.

### Change

1. Split into **four pure, independently-testable steps** (the review's three plus the discovered fourth):
   ```ts
   type RoleSerializer = (msg: Message, ctx: SerializeCtx) => ChatMessage | null;
   // ctx carries systemPrompt + moduleRegistry (what the cases read today)

   function convertRoles(messages: Message[], serializers: Record<MessageRole, RoleSerializer>, ctx): ChatMessage[];
   function repairOrphans(wire: ChatMessage[]): ChatMessage[];        // Phase 2
   function coalesceToolRuns(wire: ChatMessage[]): ChatMessage[];     // Phase 3 (incl. text absorption)
   function coalesceSameRole(wire: ChatMessage[]): ChatMessage[];     // Phase 4 (incl. Bedrock alternation)

   export function toChatMessages(messages, systemPrompt): ChatMessage[] {
     const wire = convertRoles(messages, BUILTIN_SERIALIZERS, { systemPrompt, registry: moduleRegistry });
     return coalesceSameRole(coalesceToolRuns(repairOrphans(wire)));
   }
   ```
   - Each `switch` arm becomes a `RoleSerializer` entry in a `BUILTIN_SERIALIZERS: Record<MessageRole, …>`
     map. A serializer returning `null` is the explicit "drop this message" contract (today's silent
     `extension_block`-null-drop and assistant-empty-skip become *named, tested* null returns — and emit the
     same `log.warn` they do today, so behavior is identical).
   - The four step functions are pure (`ChatMessage[] → ChatMessage[]`), so each is unit-testable in
     isolation — directly closing the test gaps above.
2. **Behavioral parity is the contract.** This is a *restructure, not a behavior change*: orphan synthetic
   text, id-precedence, the `<notor-ext>` wrapping, the empty-assistant skip, the Bedrock alternation merge
   must all be byte-identical. The 531-line existing test is the anchor; **add the missing pass-level tests
   as part of the split** (orphan repair, tool-run coalescing, text absorption, same-role merge) so all four
   steps are covered, not just `getWireText`/`extension_block`.
3. **Do NOT make the serializer map registrable in this stage.** Keep `BUILTIN_SERIALIZERS` a private const.
   Making it extension-contributable (so vault-defined transcript elements avoid editing this file) is the
   *payoff* but belongs to a later stage — here we only prove the split with built-ins. (The parent spec:
   "Registrable serializer map later.") This also keeps item 3 from entangling with Runtime API v1.
4. **Coordinate with Stage 1 item 3 (renderer registry).** Both turn built-ins into a registrable-shaped
   map; name `BUILTIN_SERIALIZERS` (wire) and the renderer's built-in registrations (render) as a matched
   pair so a future reader sees "wire serializer + render def" per kind.

### Verification
- `message-pipeline.test.ts` stays green unchanged (the public `toChatMessages` output is identical).
- New per-step tests: `repairOrphans` injects exactly the synthetic result for an unmatched id and nothing
  for matched; `coalesceToolRuns` absorbs pre-tool-call assistant text and merges consecutive runs;
  `coalesceSameRole` merges adjacent extension/user runs and preserves Bedrock alternation; `convertRoles`
  drops (returns null for) empty-assistant and null-wireText extension blocks with the same `log.warn`.
- `tsc` + suite green.

### Risk
**Medium.** The hazard is a **silent behavioral drift** during extraction — the four passes have ordering
dependencies (repair before coalesce; tool-run coalesce before same-role coalesce) and the text-absorption
in Phase 3 is fiddly. Mitigate by extracting one pass at a time behind the unchanged public function, with
the 531-line test green after each extraction, and by *adding* the missing pass tests before relying on
them. The discovered Phase 4 is the easiest to overlook — explicitly account for it.

---

## 4. Thread token budget + explicit depth to sub-agents (Issue 3.6) — S, low risk

The code-map already corrected the review here: sub-agent token usage **is** rolled into parent totals, and
the cap is unlimited-by-default + overridable. Two real gaps remain: (a) no *proactive* budget — a parent
near its context limit can launch an unbounded sub-agent and only learns the cost afterward; (b) the depth-1
invariant is **only half-enforced**.

### Current state (verified)

- Constants (`src/sub-agents/constants.ts`): `USE_SUBAGENT_TOOL_NAME = "use_subagent"` (~15);
  `SUBAGENT_EXCLUDED_TOOLS = new Set([USE_SUBAGENT_TOOL_NAME])` (~24–26) with `filterSubAgentTools()` (~37–39)
  — **but `filterSubAgentTools` is not called in the active tool-building path** (verified: no non-test
  callers); `SUB_AGENT_CONCURRENCY_CAP = 3` (~42); `SUB_AGENT_ITERATION_CAP = 20` (~45);
  `SUB_AGENT_TOKEN_LIMIT = 0` (~48, **0 = unlimited — confirmed**).
- `SubAgentRunner` (`src/chat/sub-agent-runner.ts`): `SubAgentRunnerOptions` (~65–88) has `iterationCap?`,
  `tokenLimit?`, **no `depth`**. Constructor (~115–143): `this.iterationCap = options.iterationCap ??
  SUB_AGENT_ITERATION_CAP` (~121); `this.tokenLimit = options.tokenLimit ?? SUB_AGENT_TOKEN_LIMIT` (~122).
  `getContextWindow(this.model)` at ~193 and ~206 **omit the `useExtendedContext` arg** (latent gap). Token
  usage tracked in `tokenUsage = { input, output }` (~157), accumulated ~237–238, checked against
  `this.tokenLimit`.
- Parent accounting (`src/chat/orchestrator.ts` ~1374–1376): rolls
  `toolResult.sub_agent_metadata?.token_usage` into `convManager.addTokens(input, output)` (`conversation.ts`
  ~585–597) — **after the fact, no pre-flight budget check.**
- **Depth — the split-enforcement discovery:**
  - **Extension-API path** (`utils.runSubAgent`): depth **is** enforced via a closure counter in
    `src/extensions/runtime-context/sub-agent-utils.ts` — `let depth = 0` (~14), `if (depth >= 1) { warn;
    return null }` (~27–30), `depth++` / `depth--` around the run (~164/176). So extension-driven sub-agents
    are hard-capped at depth 1.
  - **LLM `use_subagent` tool path** (`src/tools/use-subagent.ts`): **no depth check.** Depth-1 is *emergent*
    only because `intersectToolConfig` (`src/tool-config/merger.ts` ~142–205) uses **default-deny** — only
    tools named in a sub-agent profile's `<notor_tool_config>` are enabled, and built-in profiles never name
    `use_subagent`, so it is disabled in the intersected set (`enabledToolNames`, use-subagent.ts ~337–361).
    **A user-authored profile that *does* name `use_subagent` would re-enable unbounded recursion** — exactly
    the config foot-gun the parent spec flags. The runner construction is ~382–393: `tokenLimit:
    this.settings.sub_agent_token_limit ?? SUB_AGENT_TOKEN_LIMIT` — **not derived from parent headroom.**
- Extension surface (`src/extensions/runtime-context/types.ts` ~186–195): `runSubAgent({ profileName, task,
  detached?, silent?, onComplete?, iterationCap?, timeout? })` — **no `depth` or `tokenLimit`.**

### Change

1. **Make depth explicit and enforce it in the *one* place all sub-agents pass through — `SubAgentRunner`.**
   - Add `depth?: number` to `SubAgentRunnerOptions`; default `0` for a top-level launch, increment when a
     sub-agent launches a sub-agent.
   - In the runner (or at the `use_subagent` tool boundary), **refuse to launch when `depth >= maxDepth`**
     (config: a new `sub_agent_max_depth` setting, default `1`) with a structured error, not a silent skip.
   - **Unify the two paths:** thread `depth` through both the `use_subagent` tool (`use-subagent.ts` ~382–393)
     and the extension `runSubAgent` (replace the `sub-agent-utils.ts` closure counter with the threaded
     `depth`, or keep the closure as a belt-and-suspenders but have *both* honor `sub_agent_max_depth`). The
     goal: depth is enforced by an explicit counter at the runner, not by the accident of default-deny config
     intersection — so a profile that names `use_subagent` still can't recurse past `maxDepth`.
   - Add `depth` to the `runSubAgent` extension options (~186–195) so nested extension launches carry it.
2. **Derive a proactive default `tokenLimit` from the parent's remaining headroom at launch.** Where the
   `use_subagent` tool constructs the runner (~382–393), if no explicit `tokenLimit` is configured, compute a
   default from `getContextWindow(parentModel, useExtendedContext) - parentTokensUsed` (a fraction thereof),
   instead of falling back to `0`/unlimited. Keep an explicit override (settings / profile / call) able to
   raise or remove it. This makes the parent's accounting *predictive*, not just retrospective.
3. **Fix the `getContextWindow` extended-context omission** (~193/206) as part of this — pass the
   `useExtendedContext` flag (or, if Stage 1 item 4 has landed, go through `provider.getCapabilities(model)
   .contextWindow`). Decide whether the omission was a bug or intentional and document the choice (open
   question §8). **If Stage 1 item 4 is already merged, prefer `getCapabilities` over the free function.**

### Verification
- Depth: a sub-agent profile that *names* `use_subagent` cannot launch a nested sub-agent past
  `sub_agent_max_depth` — it gets a structured error (new test in `use-subagent.test.ts`, which already
  exists). The extension `runSubAgent` path honors the same cap (test the depth-2 refusal).
- Budget: launching a sub-agent from a near-full parent derives a finite `tokenLimit` (not 0); an explicit
  override still wins. The runner's pre-flight token check (~existing) now fires against the derived limit.
- `getContextWindow` for an extended-context model returns the larger window in the runner (regression test
  for the omission fix).
- `sub-agent-runner.test.ts` (562 lines) + `use-subagent.test.ts` stay green.

### Risk
**Low.** Additive and well-tested (the runner and tool both have existing suites). The one judgment call is
the *fraction* of parent headroom to hand a child (too small starves legitimate sub-agents); make it a
setting with a generous default and document it. Unifying the two depth paths is the only structural edit —
keep the extension closure counter as a fallback if removing it feels risky.

---

## 5. Approval UI affordance — "modify & approve" (Issue 3.5, UI half) — S, low risk

The wire-format widening (`ApprovalDecision = { decision; modifiedParams?; message? }`) is **Stage 0 item 8**.
This item is the **UI affordance** that produces `modifiedParams` — and, per the discovery below, *connects a
pipe that is already half-built*.

> **Strict dependency: Stage 0 item 8 must have merged.** Until `ApprovalCallback` returns `ApprovalDecision`
> and the dispatcher applies `modifiedParams` over `parameters` before `tool.execute`, this UI work has
> nowhere to send its output.

### Current state (verified)

- `ApprovalCallback = (toolCall, abortSignal?, messageId?, autoApproved?) => Promise<"approved" |
  "rejected">` — `src/chat/dispatcher.ts` ~68 (Stage 0 widens this).
- `raceApprovalSources()` (~305–345): races UI callback, optional `approval_timeout` (~319; default `0` =
  disabled, `settings/types.ts` ~87 / `defaults.ts` ~130), and the `on_approval_required` hook; a `"pass"`
  hook returns a never-resolving promise (~328–341) and **loser racers are never cancelled** (acknowledged in
  comment ~334).
- Decision consumption (~429–452): approved → execute with original `parameters` at ~645; rejected/timed_out
  → blocked. **`parameters` is never modified by the approval path today.**
- Hook side: `dispatchOnApprovalRequired()` returns `"approved" | "rejected" | "pass"` (`hook-events.ts`
  ~769–850 / verified region ~980–1075); first non-pass wins.
- UI flow:
  - Wiring: `orchestrator.setApprovalCallback(async (toolCall, …, autoApproved) => { … })`
    (`src/ui/wire-view.ts` ~597–645). Stores a pending approval in `session.pendingApprovals` with
    `{ resolve, toolCallId, messageId, toolName, parameters }`, then calls `view.renderDiffApprovalPrompt(...)`
    and resolves the promise with the result.
  - `renderDiffApprovalPrompt(toolCallEl, toolName, parameters, autoApproved=false): Promise<"approved" |
    "rejected">` (`src/ui/message-renderer.ts` ~506–588). Per-tool diff rendering: `write_note` (~518–545)
    via `renderWriteNoteDiffPreview`; `replace_in_note` (~547–585) via `renderReplaceInNoteDiffPreview`;
    generic fallback (~587).
  - **Discovery — `replace_in_note` already mutates `parameters` and drops it on the floor.** At
    `message-renderer.ts` ~580: when the user toggles per-block acceptance, the code does
    `parameters["changes"] = changeBlocks.filter((_, i) => decision.acceptedBlockIndexes!.has(i))` — it
    edits the params object in place — then `return "approved"`. Because the callback can only return a
    *string*, **this modification is never propagated to the dispatcher**; the tool runs with the original
    params. Stage 0 builds `modifiedParams`; **this item makes the existing block-filtering actually take
    effect** (the smallest possible first win) and then adds explicit edit affordances.
  - Diff buttons: `diff-view.ts` `write_note` (~173–198) resolves `{ accepted, finalContent }`;
    `replace_in_note` (~393–465) resolves `DiffDecision { accepted, finalContent?, acceptedBlockIndexes? }`
    (~42–55). Simple fallback approval UI: `src/ui/approval-ui.ts` (~21–60), approve/reject only.
- Persistence: `ToolCall { id?, tool_name, parameters, status }` (`types.ts` ~209–222) stores the *original*
  LLM params in JSONL; no approval metadata persisted. (So `modifiedParams` changes *behavior* — the tool
  runs with edited params and produces a modified result that *is* persisted — but the approval delta itself
  is not separately recorded. Decide if it should be — open question §8.)

### Change

1. **Connect the already-built `replace_in_note` block filtering** (the zero-cost first step). Once Stage 0's
   `ApprovalDecision` is in place, have `renderDiffApprovalPrompt` return
   `{ decision: "approved", modifiedParams: { changes: <accepted blocks> } }` instead of mutating the
   passed-in `parameters` and returning `"approved"`. Thread that through the `session.pendingApprovals`
   resolve (`wire-view.ts` ~597–645) so the dispatcher receives the `modifiedParams` and applies them before
   execution. This alone makes per-block approval *actually work* — today it is silently inert.
2. **Add explicit "modify & approve" affordances** to the diff UI:
   - `write_note`: an "Edit & approve" path that opens the proposed content for editing (reuse the existing
     source/rendered toggle infrastructure) and returns `modifiedParams: { content: <edited> }`.
   - `replace_in_note`: beyond per-block accept/reject (step 1), allow editing a block's replacement text,
     returning the edited `changes` array as `modifiedParams`.
   - The generic fallback (`approval-ui.ts`) optionally grows a "modify & approve" only where a tool declares
     it supports param editing — keep it tool-aware, not universal.
3. **Return shape:** every approval resolution becomes an `ApprovalDecision`. `"approved"`/`"rejected"` map to
   `{ decision }`; modify-and-approve adds `modifiedParams`; an optional free-text note maps to `message`.
   No protocol change is needed beyond Stage 0 — that is the whole point of doing the type first.
4. **If Stage 1 item 3 (renderer registry) has already migrated diff/approval into per-tool block defs**, the
   above changes land *inside those block defs* rather than in `message-renderer.ts`. The behavior is
   identical; only the home moves. Check which has merged before starting.

### Verification
- `replace_in_note` per-block approval: deselecting a block actually drops it from the executed `changes`
  (today it does not — this is the regression-that-becomes-a-feature; add a test asserting the dispatcher
  receives filtered `changes`).
- `write_note` edit-and-approve: edited content reaches the tool (the persisted note matches the *edited*
  content, not the LLM's original).
- Rejected/timed_out paths unchanged; auto-approved collapsed-diff path unchanged.
- The `on_approval_required` hook path still wins/passes correctly under the widened type (Stage 0 adapts the
  string-returning hook at the boundary — confirm it still composes).

### Risk
**Low**, *given Stage 0 item 8 has landed*. The subtle part is the loser-racer pending-promise issue
(`raceApprovalSources` ~334) — adding modify-and-approve does not fix it, but **do not make it worse**: ensure
a modify-and-approve resolution settles the UI promise exactly once and does not leave the hook racer holding
state. The `replace_in_note`-mutation discovery means there is a latent half-feature here; wiring it through
is low-risk *and* fixes a silent bug.

---

## 6. Cross-cutting: build / test / commit hygiene

- **Build gate:** every item ends with `npm run build` / `tsc --noEmit` clean.
- **Test-first where coverage is absent:** item 1 **must** open with characterization tests
  (`tool-orchestration.ts` has zero today); item 3 adds the missing per-pass tests as part of the split; item
  4 extends the existing `sub-agent-runner.test.ts` / `use-subagent.test.ts`. This is the parent spec's
  "attach tests to the migrations that touch each zone" (Issue 6.4), applied to Stage 2.
- **Anchored refactors:** item 3 rides the 531-line `message-pipeline.test.ts`; keep it green after *each*
  pass extraction (extract one pass at a time behind the unchanged public `toChatMessages`).
- **Manual smoke (Obsidian):** item 5 (approval UI) and item 2 Phase B (partial transcript elements) touch
  live UI — run a manual smoke (`debug-in-obsidian` / `run` skills) for those, where unit tests under-cover.
- **Commit granularity** (per repo git rules — use `mcp__git` tools, not raw CLI; one logical unit per
  commit). Suggested commits:
  1. `Add sub-agent depth threading + proactive token budget` (item 4)
  2. `Add characterization tests for tool-orchestration batching` (item 1, prelude)
  3. `Replace positional batching with readers-writer scheduler` (item 1)
  4. `Split toChatMessages into convertRoles/repair/coalesce steps + serializer map` (item 3)
  5. `Add tool-execution emit() channel (backward-compatible default)` (item 2, Phase A)
  6. `Make tool partial-results first-class transcript elements` (item 2, Phase B — after #4)
  7. `Wire replace_in_note block filtering through ApprovalDecision` (item 5, step 1 — after Stage 0 item 8)
  8. `Add modify-and-approve affordance to diff approval UI` (item 5, steps 2–3)

---

## 7. What this plan deliberately does NOT do

- **No `Tool.policyCheck?()` refactor (Issue 3.3)** — that travels with the Stage-0.5 policy-path work, not
  here.
- **No registrable serializer map (Issue 3.1 payoff)** — item 3 stops at splitting into pure steps with a
  *private* `BUILTIN_SERIALIZERS`; making it extension-contributable is a later stage and depends on Runtime
  API v1.
- **No loop middleware / `pre_send_transform` / `on_tool_result_transform` (Issue 2.5)** — Stage 4; the item
  2 event channel is tool→dispatcher output, not hook middleware.
- **No `ApprovalDecision` *type* definition** — that is Stage 0 item 8; item 5 here is purely the UI that
  *produces* `modifiedParams` and the wiring that *delivers* it.
- **No fix to the `raceApprovalSources` loser-racer pending-promise leak** (~334) — noted as a hazard not to
  worsen; cleaning it up is out of scope (it is a pre-existing condition, not introduced by this stage).
- **No dynamic tool-set management / tool search / deferred MCP loading** — the review's P3 "no dynamic
  tool-set management" point is not in the parent spec's Stage 2 and is not scoped here.
- **No change to MCP tool classification semantics (Issue 3.4)** — item 1 changes scheduling *shape* only;
  MCP-default-unsafe and the `isConcurrencySafe` predicate are byte-identical.

---

## 8. Open questions to resolve at implementation time

1. **Readers-writer lock semantics under the shared cap** (item 1): exact policy for a read arriving while a
   write is *queued but not yet running* — let it run (maximize throughput, risk writer starvation) or hold
   it behind the queued write (strict ordering)? Recommended: hold reads behind a queued write to preserve
   the writer's exclusivity guarantee; confirm against the characterization tests.
2. **`partial-result` digest shape** (item 2 Phase A): append chunks to `ToolResult.result` vs add an
   optional `ToolResult.partial_digest?: string`. Recommended: a dedicated optional field so the final result
   stays clean and the digest is opt-in for the LLM context.
3. **Phase 4 (same-role coalescing) ownership** (item 3): is it a true "coalesce" step or a Bedrock-specific
   alternation fix that belongs behind a provider capability? For this stage keep it a provider-agnostic
   pipeline step (parity); flag whether it should later move behind `getCapabilities` (Stage 1 item 4).
4. **Sub-agent headroom fraction + `sub_agent_max_depth` default** (item 4): what fraction of parent remaining
   headroom to hand a child, and is `maxDepth = 1` the right default given D-share's future of shared
   profiles? Recommended: `maxDepth = 1`, headroom fraction generous (e.g. ½), both settings.
5. **Was the `getContextWindow` extended-context omission a bug?** (item 4, ~193/206) — decide and document;
   prefer routing through `provider.getCapabilities` if Stage 1 item 4 has landed.
6. **Should the approval delta be persisted?** (item 5) — today only the *executed* (possibly modified) params
   are reflected in results; the original-vs-modified delta is not recorded. Decide whether `modifiedParams`
   warrants a persisted audit field on `ToolCall` (interacts with Issue 6.1 schema_version).
7. **Item 5 home depends on Stage 1 item 3** — confirm whether diff/approval rendering still lives in
   `message-renderer.ts` or has already migrated to per-tool block defs before starting; the changes are
   identical but land in different files.
