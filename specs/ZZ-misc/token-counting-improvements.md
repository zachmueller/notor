# Token Counting Improvements

## Context

Notor's token tracking has several issues that compound: (1) the token footer only
refreshes on final text responses (not during tool-call rounds), making it look like
tokens aren't being counted during tool use, (2) the Anthropic provider silently drops
input tokens, (3) Bedrock token reporting for tool calls needs verification and
diagnostic logging, and (4) sub-agent limits are iteration-based rather than
token-based. These need to be fixed in order before we can build the more ambitious
features (token-limited sub-agents, graceful wind-down with auto-summary).

### Token categorization clarification

The APIs already classify tool-call content as **output tokens**. When the LLM generates
`write_file(content="500 lines...")`, that entire response counts as `output_tokens` in
the API response. The large `input_tokens` number seen on tool-call turns is the
**conversation history being re-sent** to the model, not tool content being miscategorized.

The perception that "tokens aren't going up during tool calls" likely stems from one or
more of:
- **(a)** The Anthropic input-tokens-always-0 bug (Phase 1C) makes it look like input
  tokens are 0 for text turns and suddenly large for tool turns — creating the illusion
  of miscategorization.
- **(b)** The footer not updating during tool-call rounds (Phase 2) means accumulated
  tokens from tool turns are invisible until the final text response.
- **(c)** A real Bedrock-specific bug where `outputTokens` doesn't include tool-use
  content for certain models.

**Phase 1A diagnostic logging is the prerequisite** for determining which interpretation
is correct. Do not assume (c) — verify with data first.

---

## Phase 1: Audit & Fix Token Counting Across All Providers

The user primarily uses **Bedrock** and reports that "in cases where the LLM is writing
large files, I don't see the LLM side tokens go up much at all." This could stem from
multiple causes that need to be investigated together.

### 1A: Add Per-Turn Diagnostic Logging

Before fixing anything, add temporary debug logging so we can verify actual token
values flowing through the system. This is critical for Bedrock since the bug may
not be in parsing but in what the API actually returns.

**`src/chat/orchestrator.ts`** — In `processStream()`, after the `message_end` case
(line 1913-1916), add:

```typescript
case "message_end":
    inputTokens = event.inputTokens;
    outputTokens = event.outputTokens;
    log.debug("Stream message_end token counts", {
        inputTokens,
        outputTokens,
        hasToolCalls: accumulatedToolCalls.length > 0,
        toolCallCount: accumulatedToolCalls.length,
    });
    break;
```

**`src/chat/sub-agent-runner.ts`** — In `consumeStream()`, after capturing tokens
from `message_end`, add similar logging.

**`src/providers/bedrock-provider.ts`** — In `handleBedrockEvent()`, in the metadata
handler (line 441-450), add:

```typescript
if (event.metadata) {
    const usage = event.metadata.usage;
    log.debug("Bedrock metadata event", {
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        totalTokens: usage?.totalTokens,
        hasUsage: !!usage,
    });
    // ... existing yield
}
```

### 1B: Bedrock Provider — Verify Tool Call Token Attribution

The Bedrock Converse API's `metadata` event should report both `inputTokens` and
`outputTokens` correctly, with tool-use content included in `outputTokens`. The
current implementation at `src/providers/bedrock-provider.ts:441-450` looks correct
on paper:

```typescript
if (event.metadata) {
    const usage = event.metadata.usage;
    if (usage) {
        yield {
            type: "message_end",
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
        };
    }
}
```

**Potential issues to verify with logging:**

1. **`metadata` event might not fire** — If the stream ends early (e.g., abort signal
   at line 375-377 causes `return` before the `metadata` event arrives), tokens are
   lost. The abort check fires BEFORE yielding the event, so a race condition is
   possible where the metadata event is in the buffer but the abort fires first.
   **Note:** This race exists at two layers — the Bedrock provider level (lines
   375-377) AND the `parseStreamEvents` consumer in `src/chat/stream-utils.ts`
   (which has its own abort check that can discard `message_end` chunks). Both
   layers must be addressed, e.g., by ensuring `message_end` events are always
   processed before yielding a `cancelled` result, or by accumulating token counts
   as a side-channel that survives cancellation.

2. **`usage` might be undefined** — The `if (usage)` guard silently drops the case
   where `event.metadata` exists but `event.metadata.usage` is undefined. Add logging
   for this case.

3. **Model-specific behavior** — Some Bedrock models may report `outputTokens` that
   do NOT include tool-use content tokens. This would cause the exact symptom the user
   describes. The diagnostic logging will reveal this.

4. **`outputTokens` vs `totalTokens`** — Bedrock's `TokenUsage` type also has a
   `totalTokens` field. If `outputTokens` under-reports, we could compute it as
   `totalTokens - inputTokens` as a fallback. Worth logging `totalTokens` alongside
   the others.

### 1C: Anthropic Provider — Fix Input Token Bug

The Anthropic streaming API splits token reporting across two events:

- `message_start` → `data.message.usage.input_tokens` (nested under `message`)
- `message_delta` → `data.usage.output_tokens` (at top-level `usage`)

In `src/providers/anthropic-provider.ts:358-362`, `message_start` is ignored. The
`message_delta` handler at line 348 falls back to `data.usage.input_tokens ?? 0`,
which is always 0 because `message_delta` does not include `input_tokens`.
**Result: every Anthropic turn reports 0 input tokens.**

**Fix:** `handleAnthropicEvent` is a stateless generator method, so state must be
held in `parseAnthropicStream`. Pass a mutable state object:

- Create `streamState = { pendingInputTokens: 0 }` in `parseAnthropicStream`
- Pass it into `handleAnthropicEvent` as a parameter
- `message_start` writes `data.message?.usage?.input_tokens` to
  `streamState.pendingInputTokens` (**IMPORTANT:** use the nested
  `data.message.usage` path, NOT `data.usage`)
- `message_delta` reads from `streamState.pendingInputTokens` for input_tokens
  and from `data.usage.output_tokens` for output_tokens

### 1D: OpenAI Provider — Verify (likely fine)

`src/providers/openai-provider.ts:248-254` reads `parsed.usage.prompt_tokens` and
`parsed.usage.completion_tokens` from the final chunk. This should be correct — OpenAI
reports both in a single event. Add the same diagnostic logging for consistency.

### Verification

1. Enable debug logging, send a message that triggers a large tool call (e.g.,
   "write a 500-line file") via Bedrock
2. Check logs for the `message_end` event — verify `outputTokens` is proportional
   to the generated content
3. If `outputTokens` is suspiciously low, check `totalTokens` as a cross-reference
4. For Anthropic: verify `inputTokens` is now nonzero

---

## Phase 2: Real-Time Token Footer Updates

**Problem.** `updateTokenFooter()` is called in exactly 2 places in `orchestrator.ts`:

1. Line 345 — when switching conversations (irrelevant to streaming)
2. Line 1414 — in the `result.type === "text"` branch (final text response only)

The `result.type === "tool_calls"` branch (line 1420) records tokens via `addMessage`
at line 1429-1437, which correctly increments `total_input_tokens`/`total_output_tokens`
on the conversation object — but never calls `updateTokenFooter`. During a multi-turn
tool-calling session the footer stays stale until the LLM emits a final text response.

Sub-agent token rollup (line 1554-1561) has the same gap: tokens are added but the
footer isn't refreshed.

### Changes

**`src/chat/orchestrator.ts`**

Add two `updateTokenFooter` calls:

1. **After tool-call turn tokens are recorded** (after line 1437):
   ```typescript
   const convAfterToolTokens = this.conversationManager.getActiveConversation();
   if (convAfterToolTokens) {
       this.view?.updateTokenFooter(
           convAfterToolTokens.total_input_tokens,
           convAfterToolTokens.total_output_tokens,
           convAfterToolTokens.estimated_cost,
       );
   }
   ```

2. **After all tool results are recorded** (after line 1587, closing the tool_result
   loop). This captures sub-agent token rollup:
   ```typescript
   const convAfterResults = this.conversationManager.getActiveConversation();
   if (convAfterResults) {
       this.view?.updateTokenFooter(
           convAfterResults.total_input_tokens,
           convAfterResults.total_output_tokens,
           convAfterResults.estimated_cost,
       );
   }
   ```

### UI enhancement: "pending" indicator

The user also asked for a visual cue that token counts are about to change (e.g., when
waiting for output tokens while input tokens are already known). One lightweight approach:

- When `processStream()` begins, add a CSS class (e.g., `notor-tokens-updating`) to the
  footer element
- Remove the class after `updateTokenFooter()` is called
- Style: a subtle pulsing opacity or a small spinner icon next to the count that's pending

This is optional polish and can be deferred.

### Verification

Start a conversation that triggers multiple tool calls in sequence (e.g., "read these
3 files and summarize them"). Observe that the token footer updates after each tool-call
round, not just at the end.

---

## Phase 3: Token-Based Sub-Agent Limits

**Problem.** Sub-agents are limited by iteration count only (default 20). Some iterations
are cheap (reading a small file) and others are expensive (writing large files or
performing web searches that return huge results). Token consumption is a better proxy
for cost and context pressure.

### Design Decision: Additional Ceiling, Not Replacement

The iteration cap stays as a safety bound against infinite loops. The token limit adds
cost control. Either limit triggers the same graceful wind-down path (Phase 4).

Rationale for keeping both:
- Iteration cap catches degenerate loops regardless of token cost
- Token limit catches "few turns but each is huge" scenarios
- Users can set either to 0/high to effectively disable it

### Changes

**`src/settings/types.ts`** — Add field (near `sub_agent_iteration_cap`):
```typescript
/**
 * Maximum total tokens (input + output) per sub-agent invocation.
 * 0 means no token limit (only iteration cap applies).
 */
sub_agent_token_limit: number;
```

**`src/settings/defaults.ts`** — Default value:
```typescript
sub_agent_token_limit: 0,  // No token limit by default (iteration cap is primary)
```

> Open question: should the default be 0 (unlimited, iteration cap only) or a concrete
> value like 200,000? Unlimited is safer for backward compat. A concrete default is
> better for cost protection. Leaning toward 0 for now, with a settings UI description
> that recommends a value.

**`src/settings/sections/sub-agents.ts`** — Add UI control after iteration cap
(same pattern: text input, numeric validation, range 0-10,000,000).

**`src/chat/sub-agent-runner.ts`**:

1. Add `tokenLimit` to constructor options and store as `private readonly tokenLimit: number`

2. Add check inside the `while` loop, after token accumulation (line 178):
   ```typescript
   // Check token limit (Phase 3)
   if (this.tokenLimit > 0) {
       const totalTokens = tokenUsage.input + tokenUsage.output;
       if (totalTokens >= this.tokenLimit) {
           return await this.runWindDown(messages, tokenUsage, iterationCount, "token_limit");
       }
   }
   ```

3. Also add a **pre-flight check** before the LLM call (after the abort check at line 147).
   The threshold must reserve headroom for the wind-down summary turn (which re-sends
   the full conversation). Use the last turn's `inputTokens` as a proxy for wind-down cost:
   ```typescript
   // Pre-flight: ensure we have enough token budget left for at least one
   // more turn PLUS a wind-down summary turn.
   if (this.tokenLimit > 0) {
       const totalTokens = tokenUsage.input + tokenUsage.output;
       // Reserve: last input cost (conversation will be at least this big)
       // + estimated max output (~4096 tokens for summary)
       const lastInputCost = streamResult?.inputTokens ?? 0;
       const windDownReserve = lastInputCost + 4096;
       if (totalTokens + windDownReserve >= this.tokenLimit) {
           return await this.runWindDown(messages, tokenUsage, iterationCount, "token_limit");
       }
   }
   ```

**`src/tools/use-subagent.ts`** — Pass setting through (near line 342):
```typescript
tokenLimit: this.settings.sub_agent_token_limit,
```

**`src/sub-agents/constants.ts`** — Add constant:
```typescript
/** Default total-token limit per sub-agent invocation (0 = no limit). */
export const SUB_AGENT_TOKEN_LIMIT = 0;
```

### Reporting

`SubAgentResult.wasCapReached` currently covers only iteration cap. Options:

A. Keep single boolean, reinterpret as "was the sub-agent stopped early for any reason"
B. Replace `wasCapReached` with `stopReason: "completed" | "iteration_cap" | "token_limit" | "context_window"`

**Recommendation:** Option B. The `stopReason` field gives the parent orchestrator
(and the user via the UI) clear info about WHY the sub-agent stopped. **Remove
`wasCapReached` entirely** — it overlaps with `stopReason`. Callers that checked
`wasCapReached` should check `stopReason !== "completed"` instead. Update call sites
in `src/tools/use-subagent.ts` and `src/chat/orchestrator.ts`.

### Verification

Set `sub_agent_token_limit` to a low value (e.g., 5000). Run a sub-agent task that
would normally use more tokens. Verify it stops with the token limit marker and a
summary.

---

## Phase 4: Graceful Wind-Down with Auto-Summary

**Problem.** When a sub-agent hits its limit, it just appends a `[Results may be
incomplete]` marker to whatever text it last had. This is poor UX — the last text
might be empty (if the last turn was tool calls), and there's no structured summary
of what was accomplished vs. what remains.

### Design

When any limit is reached (iteration cap, token limit, or context window proximity),
the sub-agent gets one final "summary turn":

1. Append a user message with explicit summarize instructions
2. Send to LLM with **empty tool definitions** (forcing text-only response)
3. Return the summary as the sub-agent result

Using empty tool definitions instead of a system message is critical — it's the only
way to guarantee the LLM won't try to make more tool calls in the summary turn.

**Bedrock caveat:** Bedrock may reject requests where the conversation history contains
`toolUse`/`toolResult` content blocks but no `toolConfig` is provided (since
`toBedrockToolConfig([])` returns `undefined`, omitting the config entirely). This
must be tested explicitly with Bedrock. Fallback approach: include tool definitions
but rely on the prompt instruction "Do NOT call any tools" — less reliable but avoids
API compatibility issues.

### Phase 4A: `runWindDown` method

**`src/chat/sub-agent-runner.ts`** — New private method:

```typescript
private async runWindDown(
    messages: ChatMessage[],
    tokenUsage: { input: number; output: number },
    iterationCount: number,
    reason: "iteration_cap" | "token_limit" | "context_window",
): Promise<SubAgentResult> {
    const reasonLabels: Record<string, string> = {
        iteration_cap: `iteration limit (${this.iterationCap} turns)`,
        token_limit: `token limit (${(tokenUsage.input + tokenUsage.output).toLocaleString()} tokens)`,
        context_window: "context window proximity (70%)",
    };

    this.onProgress?.(`Summarizing progress (reached ${reasonLabels[reason]})...`);

    messages.push({
        role: "user",
        content: [
            `You are about to be stopped because you have reached your ${reasonLabels[reason]}.`,
            "Provide a concise summary of:",
            "1. What you accomplished",
            "2. What remains incomplete or was not attempted",
            "3. Key findings, results, or artifacts produced",
            "",
            "Do NOT call any tools. Respond with text only.",
        ].join("\n"),
    });

    const stream = this.provider.sendMessage(
        messages,
        [],  // No tools — force text-only response
        { model: this.model, abort_signal: this.abortController.signal },
    );

    const result = await this.consumeStream(stream);
    tokenUsage.input += result.inputTokens;
    tokenUsage.output += result.outputTokens;

    if (result.text) {
        messages.push({ role: "assistant", content: result.text });
    }

    const marker = `[Sub-agent stopped: ${reasonLabels[reason]}]`;
    const text = result.text
        ? `${marker}\n\n${result.text}`
        : `${marker}\n\n[Summary generation failed — no text returned]`;

    return {
        text,
        messages,
        tokenUsage,
        iterationCount,
        wasCapReached: true,
        stopReason: reason,  // New field from Phase 3
    };
}
```

### Phase 4B: Context Window Proximity Trigger

**`src/chat/sub-agent-runner.ts`** — Inside the `while` loop, before the LLM call
(after the abort check).

**Preferred approach: Use actual API token counts** instead of character-based
estimation. The sub-agent already tracks `tokenUsage.input` which reflects the actual
input token count from the last turn. This IS the current conversation context size
(the API re-reads the full conversation each turn). This is far more accurate than
the `estimateTokenCount` heuristic (which uses `CHARS_PER_TOKEN = 4` and can be
25-40% off for code/JSON content).

```typescript
// Check context window proximity (Phase 4B)
// Use actual API-reported input tokens from last turn as the most accurate
// measure of current context size. Reserve headroom for wind-down turn.
const contextLimit = getContextWindow(this.model);
if (contextLimit > 0 && tokenUsage.input > 0) {
    // lastInputTokens = input tokens from the most recent API response
    // This equals the full conversation context the model processed
    const lastInputTokens = streamResult?.inputTokens ?? 0;
    const windDownReserve = lastInputTokens + 4096; // room for summary turn
    if (lastInputTokens + windDownReserve >= contextLimit) {
        return await this.runWindDown(messages, tokenUsage, iterationCount, "context_window");
    }
}
```

**Fallback (if actual token counts aren't available on the first iteration):**
Use `estimateConversationTokens` as a floor estimate, but it MUST account for
tool content in `tool_calls` and `tool_results` arrays (not just `msg.content`,
which is `""` for tool messages):

```typescript
private estimateConversationTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
        total += estimateTokenCount(msg.content);
        if (msg.tool_calls) {
            // tool_call messages have content="" — the real tokens are here
            total += estimateTokenCount(JSON.stringify(msg.tool_calls));
        }
        if (msg.tool_results) {
            // tool_result messages have content="" — the real tokens are here
            total += estimateTokenCount(JSON.stringify(msg.tool_results));
        }
    }
    return total;
}
```

Use 50% threshold (not 70%) with the estimation fallback to compensate for the
heuristic's inaccuracy on code/JSON content.

### Phase 4C: Wire into existing cap-reached path

Replace the current cap-reached block (lines 280-293):
```typescript
// OLD:
const capMarker = `[Sub-agent reached iteration limit ...]`;
return { text: ..., wasCapReached: true };

// NEW:
return await this.runWindDown(messages, tokenUsage, iterationCount, "iteration_cap");
```

### Verification

1. Set iteration cap to 3. Run a research sub-agent. Verify it produces a structured
   summary after 3 turns instead of the raw `[Results may be incomplete]` marker.
2. Set token limit to a low value. Verify summary triggers on token exhaustion.
3. Feed a sub-agent a task that generates huge tool results. Verify the context window
   check triggers at ~70% and produces a summary.

---

## Implementation Order

```
Phase 1  ──────────────────────────────────────  (independent, small)
Phase 2  ──────────────────────────────────────  (independent, small)
Phase 3  ──── depends on Phase 1 ─────────────  (medium)
Phase 4  ──── depends on Phase 3 ─────────────  (medium-large)
         4A: runWindDown method
         4B: context window check
         4C: wire into existing paths
```

Phases 1 and 2 are independent bug fixes (~30 min each). Phase 3 adds the token limit
setting and check. Phase 4 builds the summary infrastructure on top.

---

## Open Questions

1. **Default token limit value:** 0 (unlimited) vs. concrete default? See Phase 3 notes.
2. ~~**Summary turn token budget:**~~ **RESOLVED.** Pre-flight checks now reserve
   headroom based on last turn's `inputTokens` + 4096 for the summary response.
3. ~~**`stopReason` on `SubAgentResult`:**~~ **RESOLVED.** Replace `wasCapReached` with
   `stopReason` enum. Update all call sites.
4. **Footer "pending" indicator:** Worth the UX polish, or skip for now?
5. **Bedrock empty-tools compatibility:** Does Bedrock accept requests with no
   `toolConfig` when conversation history contains `toolUse`/`toolResult` blocks?
   Must be tested before committing to the Phase 4A approach.
6. **Root cause of user's token concern:** Is it (a) the Anthropic input-tokens-always-0
   bug, (b) footer not updating during tool rounds, or (c) a real Bedrock model-specific
   issue? Phase 1A logging should answer this before Phase 3+ work begins.
