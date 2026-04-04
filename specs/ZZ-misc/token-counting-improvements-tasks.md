# Token Counting Improvements — Implementation Tasks

Cross-referenced against the codebase on 2026-04-05. Line numbers verified via
code reading; re-verify before editing as they may drift with other changes.

---

## Phase 1C: Fix Anthropic Input Token Bug

> Independent, small. Can be done immediately — the bug is confirmed from code reading.

**File:** `src/providers/anthropic-provider.ts`

The Anthropic streaming API sends `input_tokens` in `message_start` (nested at
`data.message.usage.input_tokens`) and `output_tokens` in `message_delta` (at
`data.usage.output_tokens`). Currently `message_start` is ignored (lines 358-362)
and `message_delta` reads `data.usage.input_tokens ?? 0` (line 351) which is
always 0 because `message_delta` never includes `input_tokens`.

- [x] **1C-1.** Add a `streamState` object in `parseAnthropicStream` (line ~244)
  - Declare `const streamState = { pendingInputTokens: 0 };` before the SSE
    parsing loop
  - Pass `streamState` as a third parameter to `handleAnthropicEvent` (called at
    lines 281-284)
- [x] **1C-2.** Update `handleAnthropicEvent` signature (line 302) to accept
  `streamState: { pendingInputTokens: number }` as a third parameter
- [x] **1C-3.** Capture input tokens from `message_start` (lines 358-362)
  - Replace the empty `break` with:
    `streamState.pendingInputTokens = data.message?.usage?.input_tokens ?? 0;`
  - Must use `data.message.usage` (nested), NOT `data.usage` (top-level)
  - Note: `AnthropicEventData` interface (lines 29-35) may need a `message`
    property added with `{ usage?: { input_tokens?: number } }`
- [x] **1C-4.** Use `streamState.pendingInputTokens` in `message_delta` handler
  (lines 346-356)
  - Change `input_tokens: data.usage.input_tokens ?? 0` (line 351) to
    `input_tokens: streamState.pendingInputTokens`
- [ ] **1C-5.** Verify: enable debug logging, send a message via Anthropic
  provider, confirm `inputTokens` is now non-zero in the `message_end` event
  - ⏳ Blocked: no Anthropic API key available for testing

---

## Phase 1A: Add Bedrock Diagnostic Logging

> Independent, small. Bedrock-specific — helps verify whether tool-call output
> tokens are under-reported by the API itself.

**File:** `src/providers/bedrock-provider.ts`

The metadata handler (lines 441-450) looks correct on paper. Logging will reveal
whether `outputTokens` actually includes tool-use content and whether `metadata`
events fire reliably.

- [x] **1A-1.** Add debug log inside `handleBedrockEvent` metadata handler
  (after line 441, before the `if (usage)` guard)
  - Log `event.metadata.usage` fields: `inputTokens`, `outputTokens`,
    `totalTokens`, and `!!usage`
  - Also log when `event.metadata` exists but `usage` is undefined (the current
    `if (usage)` guard at line 442 silently drops this case)
- [x] **1A-2.** Add debug log in `orchestrator.ts` `processStream()` after the
  `message_end` case (line 1913-1916)
  - Log `inputTokens`, `outputTokens`, `accumulatedToolCalls.length` (or
    equivalent indicator of whether this was a tool-call turn)
- [ ] **1A-3.** Manual verification: send a "write a 500-line file" prompt via
  Bedrock, check logs for `message_end` token values. Compare `outputTokens` to
  expected content size. Cross-reference `totalTokens` if `outputTokens` seems
  low.
  - 🔜 Ready for manual testing with Bedrock

---

## Phase 1D: OpenAI Provider Verification

> Independent, small. Likely fine but add logging for consistency.

**File:** `src/providers/openai-provider.ts`

Token extraction at lines 248-254 reads `parsed.usage.prompt_tokens` and
`parsed.usage.completion_tokens` from the final SSE chunk. The request already
sets `stream_options: { include_usage: true }`.

- [x] **1D-1.** Add debug log after the `if (parsed.usage)` block (line 248)
  - Log `prompt_tokens`, `completion_tokens`, and whether the chunk also
    contained tool call content
- [ ] **1D-2.** Manual verification: send a tool-call-triggering prompt via
  OpenAI, confirm token values look proportional to content
  - ⏳ Blocked: no OpenAI API key available for testing

---

## Phase 2: Real-Time Token Footer Updates

> Independent, small. Can be done in parallel with Phase 1.

**File:** `src/chat/orchestrator.ts`

`updateTokenFooter()` is only called in two places: line 345 (conversation
switch) and line 1414 (final text response). The tool-calls branch (lines
1420-1595) records tokens via `addMessage` at lines 1429-1437 but never refreshes
the footer. Sub-agent token rollup at lines 1553-1561 (foreground) and 997-1005
(background) has the same gap.

- [x] **2-1.** Add `updateTokenFooter` call after tool-call turn tokens are
  recorded (after the `addMessage` block at lines 1429-1437)
  - Read conversation via `this.conversationManager.getActiveConversation()`
  - Call `this.view?.updateTokenFooter(conv.total_input_tokens, conv.total_output_tokens, conv.estimated_cost)`
  - Guard with `if (conv)` null check
- [x] **2-2.** Add `updateTokenFooter` call after each tool_result `addMessage`
  in the foreground tool result loop (after line 1561)
  - Same pattern: get active conversation, call `updateTokenFooter`
  - This captures sub-agent token rollup incrementally so the footer updates as
    each sub-agent completes
- [x] **2-3.** Add `updateTokenFooter` call after each tool_result `addMessage`
  in the background response loop (after line 1005)
  - Same pattern but using `bgConvManager` — check if there's a view reference
    available in the background path; if not, skip (background processing may
    not have a view)
- [x] **2-4.** Verify: start a conversation triggering multiple sequential tool
  calls (e.g., "read these 3 files and summarize them"). Observe that the token
  footer updates after each tool-call round, not just at the end.
  - ✅ Verified via `e2e/scripts/token-footer-realtime-test.ts` (10/10 pass)
  - Footer showed 3 distinct incremental values during single tool-call turn
  - Multi-tool prompt showed monotonically non-decreasing accumulation
  - Sequential prompts confirmed growth across turns

---

## Phase 3: Token-Based Sub-Agent Limits

> Depends on Phase 1 (accurate token counts required). Medium scope.

### 3A: Add the `sub_agent_token_limit` setting

- [x] **3A-1.** Add `sub_agent_token_limit: number` field to settings type
  (`src/settings/types.ts`, near lines 308-314 where `sub_agent_iteration_cap`
  lives)
  - JSDoc: "Maximum total tokens (input + output) per sub-agent invocation.
    0 means no token limit (only iteration cap applies)."
- [x] **3A-2.** Add default value in `src/settings/defaults.ts` (near line 170)
  - `sub_agent_token_limit: 0`
- [x] **3A-3.** Add `SUB_AGENT_TOKEN_LIMIT = 0` constant to
  `src/sub-agents/constants.ts` (near line 45)
- [x] **3A-4.** Add UI control in `src/settings/sections/sub-agents.ts` (after
  the iteration cap setting at lines 53-71)
  - Text input, numeric validation, range 0–10,000,000
  - Placeholder "0" (unlimited)
  - Description: "Maximum total tokens per sub-agent. 0 = no limit."

### 3B: Wire setting into SubAgentRunner

- [x] **3B-1.** Add `tokenLimit` to `SubAgentRunner` constructor options
  (`src/chat/sub-agent-runner.ts`, around line 100)
  - Store as `private readonly tokenLimit: number`
  - Default to `SUB_AGENT_TOKEN_LIMIT` if not provided
- [x] **3B-2.** Pass `tokenLimit` from `UseSubagentTool`
  (`src/tools/use-subagent.ts`, at lines 335-345 where the runner is created)
  - `tokenLimit: this.settings.sub_agent_token_limit ?? SUB_AGENT_TOKEN_LIMIT`

### 3C: Add token limit check in the sub-agent loop

- [x] **3C-1.** Hoist `streamResult` declaration above the `while` loop
  (`src/chat/sub-agent-runner.ts`, before line 145)
  - Declare `let streamResult: ConsumedStreamResult | undefined;`
  - Change line 174 from `const streamResult = ...` to `streamResult = ...`
  - This is needed so the pre-flight check (3C-3) can reference the previous
    iteration's result
- [x] **3C-2.** Add post-turn token limit check after token accumulation (after
  lines 177-178)
  - If `this.tokenLimit > 0` and `tokenUsage.input + tokenUsage.output >= this.tokenLimit`,
    trigger wind-down (Phase 4) or early return with token limit marker
  - For now (before Phase 4), return with a marker similar to the cap-reached
    block at lines 280-293
- [x] **3C-3.** Add pre-flight token limit check before the LLM call (after the
  abort check at lines 147-156)
  - Reserve headroom for wind-down: use last turn's `inputTokens` as proxy for
    conversation re-send cost + 4096 for summary response
  - `const lastInputCost = streamResult?.inputTokens ?? 0;`
  - `const windDownReserve = lastInputCost + 4096;`
  - If `tokenUsage.input + tokenUsage.output + windDownReserve >= this.tokenLimit`,
    trigger wind-down or early return

### 3D: Update SubAgentResult reporting

- [x] **3D-1.** Replace `wasCapReached: boolean` with
  `stopReason: "completed" | "iteration_cap" | "token_limit" | "context_window"`
  on the `SubAgentResult` type (lines 39-50 in `sub-agent-runner.ts`)
- [x] **3D-2.** Update all return sites in `run()` to use `stopReason`:
  - Line 149-155 (abort): `stopReason: "completed"` (or a new `"aborted"` value)
  - Line 183-189 (error): `stopReason: "completed"`
  - Line 194-200 (cancelled): `stopReason: "completed"`
  - Line 217-223 (text completion): `stopReason: "completed"`
  - Line 287-293 (iteration cap): `stopReason: "iteration_cap"`
  - New token limit return: `stopReason: "token_limit"`
- [x] **3D-3.** Update callers that check `wasCapReached`:
  - `src/tools/use-subagent.ts` — replaced all `wasCapReached` → `stopReason`
  - `src/types.ts` — replaced `was_cap_reached: boolean` → `stop_reason: string`
  - `src/chat/history.ts` — replaced `was_cap_reached` → `stop_reason`
  - `src/export/html-exporter.ts` — updated to show `stop_reason` label
  - `src/chat/orchestrator.ts` — no references found (confirmed)
  - All tests updated to use new field names
- [x] **3D-4.** Verify: set `sub_agent_token_limit` to 5000, run a sub-agent
  task, confirm it stops with the token limit marker
  - ✅ Verified via `e2e/scripts/sub-agent-token-limit-test.ts` (7/7 pass)
  - Pre-flight check fired at 2,268 tokens used (wind-down reserve 6,142 > limit 5,000)
  - SubAgentRunner logged "approaching token limit (pre-flight)" with stopReason
  - With limit=0, sub-agent completed normally (3 iterations, stopReason: "completed")

---

## Phase 4: Graceful Wind-Down with Auto-Summary

> Depends on Phase 3. Medium-large scope. Break into sub-phases.

### Phase 4A: Implement `runWindDown` method

**File:** `src/chat/sub-agent-runner.ts`

- [x] **4A-1.** Add `runWindDown` private async method with signature:
  ```
  private async runWindDown(
      messages: ChatMessage[],
      tokenUsage: { input: number; output: number },
      iterationCount: number,
      reason: "iteration_cap" | "token_limit" | "context_window",
  ): Promise<SubAgentResult>
  ```
- [x] **4A-2.** Implement reason labels mapping:
  - `iteration_cap` → "iteration limit (N turns)"
  - `token_limit` → "token limit (N tokens)"
  - `context_window` → "context window proximity (~50%)"
- [x] **4A-3.** Append a user message with summarization instructions
  - Tell the model it's about to be stopped and why
  - Request: what was accomplished, what remains, key findings
  - Instruct: "Do NOT call any tools. Respond with text only."
- [x] **4A-4.** Send the summary turn via `this.provider.sendMessage()`
  - Pass `this.toolDefinitions` (NOT empty `[]`) — Bedrock requires `toolConfig`
    when conversation history contains `toolUse`/`toolResult` blocks
  - Pass the abort signal
- [x] **4A-5.** Consume the stream and accumulate tokens
  - If the model makes tool calls anyway, ignore them and use whatever text was
    generated
- [x] **4A-6.** Build and return `SubAgentResult`:
  - Prepend `[Sub-agent stopped: <reason label>]` marker
  - Include summary text (or fallback message if no text returned)
  - Set `stopReason` to the `reason` parameter
- [x] **4A-7.** Call `this.onProgress?.()` with a status message before the
  summary turn so the user sees "Summarizing progress..." in the UI

### Phase 4B: Context Window Proximity Trigger

**File:** `src/chat/sub-agent-runner.ts`

- [x] **4B-1.** Import `getContextWindow` from `src/providers/model-metadata.ts`
  (function at line 578)
- [x] **4B-2.** Add context window check inside the `while` loop, before the LLM
  call (after the abort check at lines 147-156)
  - Use `streamResult?.inputTokens` (last turn's actual API-reported input
    tokens) as the most accurate measure of current context size
  - Compute `windDownReserve = lastInputTokens + 4096`
  - If `lastInputTokens + windDownReserve >= contextLimit`, trigger
    `runWindDown(..., "context_window")`
  - Guard: only check when `contextLimit > 0` and `streamResult` exists (skip
    first iteration)
- [x] **4B-3.** Add `estimateConversationTokens` fallback method for the first
  iteration (when `streamResult` is undefined)
  - Must account for `tool_calls` and `tool_results` arrays on messages, not
    just `msg.content` (which is `""` for tool messages)
  - Use `estimateTokenCount()` from `src/utils/tokens.ts` (line 39)
  - Use 50% threshold (not 70%) to compensate for heuristic inaccuracy on
    code/JSON content
- [x] **4B-4.** Note: `getContextWindow()` falls back to
  `DEFAULT_CONTEXT_WINDOW = 128_000` for unknown models (line 584 in
  `model-metadata.ts`). This is conservative enough — triggering at ~64K tokens.
  Acceptable edge case for now.

### Phase 4B-half: Ensure Cancelled Streams Report Tokens

**File:** `src/chat/sub-agent-runner.ts`

When abort fires, `parseStreamEvents` (`src/chat/stream-utils.ts`, lines 55-58)
yields `{ type: "cancelled", text }` without token fields. The `consumeStream`
method's `cancelled` branch (around line 345) may return 0 tokens even if
`message_end` was received before cancellation.

- [x] **4B½-1.** In `consumeStream` (lines 308-363), verify that
  `inputTokens`/`outputTokens` are accumulated as side-channel state that
  persists regardless of result type
  - Check the `ConsumedStreamResult` cancelled variant (lines 370-373) — it
    already includes `inputTokens`/`outputTokens` fields
  - Verify the `cancelled` case in the event loop populates these from the
    accumulated values (not from the event, which doesn't have token fields)
  - ✅ Verified: `consumeStream` (lines 477-532) declares `inputTokens`/`outputTokens`
    as local variables that persist across the event loop. `message_end` sets them
    (line 500-501), and the `cancelled` return path (lines 514-521) returns these
    accumulated values. Already correct — no fix needed.
- [x] **4B½-2.** If the cancelled variant returns 0 tokens despite `message_end`
  having been received earlier in the stream, fix by ensuring the `cancelled`
  return path uses the accumulated `inputTokens`/`outputTokens` variables
  - ✅ Already correct — no fix needed (see 4B½-1 verification)

### Phase 4C: Wire Wind-Down into Existing Paths

**File:** `src/chat/sub-agent-runner.ts`

- [x] **4C-1.** Replace iteration-cap-reached block (lines 280-293) with:
  `return await this.runWindDown(messages, tokenUsage, iterationCount, "iteration_cap");`
- [x] **4C-2.** Replace the Phase 3 temporary token-limit return (task 3C-2)
  with: `return await this.runWindDown(messages, tokenUsage, iterationCount, "token_limit");`
  - Also replaced pre-flight token-limit return (task 3C-3) with wind-down call
- [ ] **4C-3.** Verify iteration cap wind-down: set cap to 3, run a research
  sub-agent, confirm structured summary instead of raw "[Results may be
  incomplete]" marker
  - ✅ Unit test passes: iteration cap → wind-down summary turn fires, marker
    format is `[Sub-agent stopped: iteration limit (N turns)]` + summary text
  - 🔜 Ready for manual E2E testing
- [ ] **4C-4.** Verify token limit wind-down: set low token limit, confirm
  summary triggers on token exhaustion
  - 🔜 Ready for manual E2E testing
- [ ] **4C-5.** Verify context window wind-down: feed a sub-agent a task that
  generates huge tool results, confirm the context window check triggers and
  produces a summary
  - 🔜 Ready for manual E2E testing

---

## Phase 5: Fix Sub-Agent Token Inflation of Compaction/Truncation

> Independent of Phase 4. Small scope. Fixes a confirmed bug.

**Bug:** Sub-agent cumulative token counts were stored on tool_result messages'
`input_tokens`/`output_tokens` fields. Both `estimateConversationTokens()`
(compaction) and `estimateMessageTokens()` (truncation) interpreted these as
the message's actual context window footprint — e.g. a sub-agent using 10,000
tokens across 5 iterations made a ~500-token tool_result look like 10,000
tokens, triggering premature compaction.

**Fix:** Stop storing sub-agent tokens on per-message fields. Accumulate them
directly on the conversation totals via a new `addTokens()` method.

- [x] **5-1.** Add `addTokens(input, output)` method to `ConversationManager`
  (`src/chat/conversation.ts`, after `getEstimatedCost()`)
  - Increments `conversation.total_input_tokens` / `total_output_tokens` directly
  - Does NOT attach tokens to any message (so compaction/truncation estimation
    correctly falls through to content-based sizing)
- [x] **5-2.** Update foreground sub-agent token rollup in orchestrator
  (`src/chat/orchestrator.ts`, line ~1573)
  - Remove `input_tokens` / `output_tokens` from `addMessage()` call
  - Call `addTokens()` separately for sub-agent metadata
- [x] **5-3.** Update background sub-agent token rollup in orchestrator
  (`src/chat/orchestrator.ts`, line ~997)
  - Same pattern with `bgConvManager`
- [x] **5-4.** Fix `prepareFork()` re-summation (`src/chat/conversation.ts`,
  line ~202) to include sub-agent tokens from
  `m.tool_result?.sub_agent_metadata?.token_usage`
- [x] **5-5.** Add unit tests for `addTokens()` and sub-agent-aware
  `prepareFork()` — 279/279 tests pass
- [ ] **5-6.** Verify via E2E: sub-agent conversation does NOT trigger
  premature compaction
  - 🔜 Ready for manual testing or E2E extension

---

## Implementation Order & Dependencies

```
Phase 1C (Anthropic fix)  ─── independent ──────────── small
Phase 1A (Bedrock logging) ── independent ──────────── small
Phase 1D (OpenAI logging)  ── independent ──────────── small
Phase 2  (Footer updates)  ── independent ──────────── small
Phase 3A (Setting)         ── independent ──────────── small
Phase 3B (Wire setting)   ─── depends on 3A ─────────  small
Phase 3C (Token check)    ─── depends on 3B, Phase 1 ─ medium
Phase 3D (Reporting)       ── depends on 3C ─────────  small
Phase 4A (runWindDown)     ── depends on 3D ─────────  medium
Phase 4B (Context window)  ── depends on 4A ─────────  medium
Phase 4B½ (Cancelled fix) ─── depends on 4A ─────────  small
Phase 4C (Wire up)        ─── depends on 4A,4B,4B½ ── small
Phase 5  (Compaction fix)  ── independent ──────────── small
```

Recommended groupings for implementation sessions:

1. **Session 1:** Phase 1C + Phase 2 (both independent, both small)
2. **Session 2:** Phase 1A + Phase 1D (logging, can verify manually together)
3. **Session 3:** Phase 3A + 3B + 3D (settings + types, no runtime logic yet)
4. **Session 4:** Phase 3C (token limit check — requires accurate counts from
   Session 1)
5. **Session 5:** Phase 4A + 4B½ (core wind-down infra)
6. **Session 6:** Phase 4B + 4C (context window check + final wiring)
