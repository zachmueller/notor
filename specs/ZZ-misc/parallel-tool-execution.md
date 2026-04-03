# Design Doc: Parallel Tool Execution & Async Conversation Loop for Notor

## 1. Context & Motivation

Notor is an Obsidian plugin that integrates LLM-powered chat with vault operations. A planned sub-agent feature will allow the LLM to spawn concurrent child conversations. For that to be useful, the underlying conversation loop must support **executing multiple tool calls in parallel** within a single LLM turn — today it cannot.

Currently, Notor's response loop ([`/Volumes/workplace/notor/src/chat/orchestrator.ts:1317-1607`](/Volumes/workplace/notor/src/chat/orchestrator.ts#L1317-L1607)) processes **one tool call per LLM turn**: the stream parser exits on the first `tool_call_end`, dispatches that single tool, adds the result, and re-enters the loop for another LLM call. If the LLM emits 3 tool_use blocks in one response, only the first is seen — the rest of the stream (including the other tool calls and the `message_end` token counts) is discarded.

Claude Code solves this problem comprehensively. This document distills its approach into a design tailored to Notor's architecture.

---

## 2. How Claude Code Does It — Detailed Reference

### 2.1 Full Stream Consumption

**File:** [`/Volumes/workplace/claude-code-fork/src/services/api/claude.ts`](/Volumes/workplace/claude-code-fork/src/services/api/claude.ts) (lines 1940+)

Claude Code's streaming layer processes the **entire** Anthropic SSE stream before yielding control. Each `content_block_start/delta/stop` event is handled — text blocks become text content, tool_use blocks are accumulated into `ToolUseBlock` objects (type, id, name, input). The stream is never abandoned mid-response.

**File:** [`/Volumes/workplace/claude-code-fork/src/query.ts`](/Volumes/workplace/claude-code-fork/src/query.ts) (lines 829-861)

In the main query loop, as `AssistantMessage` objects arrive from the stream, each message's content blocks are inspected. Every `tool_use` block is pushed onto a `toolUseBlocks: ToolUseBlock[]` array and a `needsFollowUp` flag is set. This means by the time streaming ends, the loop has **all** tool calls collected, not just the first.

### 2.2 Tool Partitioning into Concurrent/Serial Batches

**File:** [`/Volumes/workplace/claude-code-fork/src/services/tools/toolOrchestration.ts`](/Volumes/workplace/claude-code-fork/src/services/tools/toolOrchestration.ts) (lines 86-116)

The `partitionToolCalls()` function groups the collected tool_use blocks into ordered batches using a reduce:

```
Input:  [Read_A, Read_B, Write_C, Read_D, Read_E]
Output: [
  { isConcurrencySafe: true,  blocks: [Read_A, Read_B] },
  { isConcurrencySafe: false, blocks: [Write_C] },
  { isConcurrencySafe: true,  blocks: [Read_D, Read_E] },
]
```

**Rules:**
- Each tool's `isConcurrencySafe(parsedInput)` method is called to determine eligibility.
- Consecutive concurrency-safe tools are grouped into one batch.
- Each non-concurrent tool becomes its own batch.
- If `isConcurrencySafe()` throws or schema parsing fails, the tool is conservatively treated as non-concurrent (lines 99-107).

### 2.3 Concurrent Execution with Capped Parallelism

**File:** [`/Volumes/workplace/claude-code-fork/src/services/tools/toolOrchestration.ts`](/Volumes/workplace/claude-code-fork/src/services/tools/toolOrchestration.ts) (lines 152-177)

The `runTools()` async generator iterates batches in order:
- **Concurrent batch** → `runToolsConcurrently()` wraps each tool in an async generator via `runToolUse()`, then passes all generators to the `all()` utility.
- **Serial batch** → `runToolsSerially()` runs each tool one-at-a-time, applying context modifiers immediately.

**File:** [`/Volumes/workplace/claude-code-fork/src/utils/generators.ts`](/Volumes/workplace/claude-code-fork/src/utils/generators.ts) (lines 32-72)

The `all()` function implements capped-concurrency fan-out:
1. Maintains a set of active promises, capped at `concurrencyCap` (default: 10, configurable via `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` env var).
2. Uses `Promise.race()` on the active set. When one resolves, its generator is advanced (or a queued generator is started).
3. Values are yielded as they arrive — no waiting for the full batch to complete.

**Important note on ordering:** Claude Code's `all()` yields results in **completion order** (via `Promise.race`), NOT submission order. Notor's design uses `Promise.all` instead, which preserves submission order. If ever switching to a race-based approach, a reorder step would be needed.

### 2.4 Streaming Tool Executor (Alternate Path)

**File:** [`/Volumes/workplace/claude-code-fork/src/services/tools/StreamingToolExecutor.ts`](/Volumes/workplace/claude-code-fork/src/services/tools/StreamingToolExecutor.ts) (lines 40-531)

When enabled via feature gate, tools begin executing **while the stream is still in progress** (not just after). Tools are queued via `addTool()` as each `content_block_stop` fires. The executor maintains a state machine per tool (`queued → executing → completed → yielded`) and enforces the same concurrency rules:

- `canExecuteTool()` (lines 129-134): returns `true` if (a) nothing is executing, OR (b) both the new tool and all executing tools are concurrency-safe.
- Non-concurrent tools wait for all executing tools to finish.
- Results are yielded in FIFO order via `getCompletedResults()` (non-blocking) and `getRemainingResults()` (blocking, used after streaming ends).

**Error cascading** (lines 209-230): If a Bash tool errors, a sibling abort controller is signaled so concurrent Bash siblings can short-circuit with synthetic errors rather than continuing pointlessly. Only Bash tools trigger this cascade — other tool failures are independent.

**Context modifiers:** The streaming executor does NOT apply context modifiers for concurrent tools (lines 388-395). This is intentional and documented with an inline comment — modifiers are collected but only applied when the tool is non-concurrent. Serial tools apply modifiers immediately.

### 2.5 Result Collection and Next-Turn Message Assembly

**File:** [`/Volumes/workplace/claude-code-fork/src/query.ts`](/Volumes/workplace/claude-code-fork/src/query.ts) (lines 1366-1475)

After all tool results are collected:
1. Each result is yielded to the UI (`yield update.message`).
2. Results are accumulated in `toolResults[]` and normalized for the API.
3. The next state is assembled: `messagesForQuery + assistantMessages + toolResults`.
4. The `while (true)` loop continues with this new state, sending the full conversation (including all tool results) back to the LLM.

The LLM then sees the natural Anthropic API format: one assistant message with N `tool_use` blocks, followed by one user message with N `tool_result` blocks.

### 2.6 Message Queuing (Separate Concern)

**File:** [`/Volumes/workplace/claude-code-fork/src/utils/messageQueueManager.ts`](/Volumes/workplace/claude-code-fork/src/utils/messageQueueManager.ts) (lines 52-548)

Users can enqueue follow-up messages while the assistant is processing. Queued commands have priority levels (`now > next > later`) and are drained between turns (query.ts lines 1570-1590). This is orthogonal to parallel tool execution and can be added later.

---

## 3. Current Notor Architecture (What Needs to Change)

### 3.1 The Response Loop — Serial, Single-Tool

**File:** [`/Volumes/workplace/notor/src/chat/orchestrator.ts`](/Volumes/workplace/notor/src/chat/orchestrator.ts) (lines 1317-1607)

```
while (continueLoop):
    [steps 0-6: compaction, rules, config, prompt, messages, context, send to LLM]
    result = await processStream(stream)    ← returns on FIRST tool_call_end
    if result.type === "tool_call":
        toolResult = await dispatcher.dispatch(result.toolName, ...)  ← ONE tool
        conversationManager.addMessage(tool_result)
        continueLoop = true                 ← loop back to LLM with single result
```

### 3.2 Stream Processing — Early Exit on First Tool Call

**File:** [`/Volumes/workplace/notor/src/chat/orchestrator.ts`](/Volumes/workplace/notor/src/chat/orchestrator.ts) (lines 1850-1973)

`processStream()` iterates over `AsyncIterable<StreamChunk>`. On `tool_call_end` (line 1902), it **immediately returns** with `{ type: "tool_call", toolCallId, toolName, parameters, ... }`. Any subsequent tool_call or message_end chunks in the stream are never consumed.

**Existing bug — lost tokens and text:** Because `processStream` returns before `message_end`, `inputTokens` and `outputTokens` are always 0 for tool call responses. The token-tracking assistant message (lines 1556-1564) is guarded by `if (result.inputTokens || result.outputTokens)`, so it's never created for tool calls. Additionally, any text the LLM produces before tool calls (`result.text`) is rendered in the UI but never persisted in the conversation history. The full-stream-consumption change in Section 4.1 fixes both issues.

### 3.3 Provider Streaming — Already Supports Multiple Tool Calls

All three Notor providers already emit multiple `tool_call_start/delta/end` sequences when the LLM produces multiple tool_use blocks in one response:

- **Anthropic** ([`/Volumes/workplace/notor/src/providers/anthropic-provider.ts`](/Volumes/workplace/notor/src/providers/anthropic-provider.ts), lines 301-382): Maps Anthropic `content_block_start/delta/stop` events to `tool_call_start/delta/end` StreamChunks. Each tool_use content block in the response generates its own sequence.

- **OpenAI** ([`/Volumes/workplace/notor/src/providers/openai-provider.ts`](/Volumes/workplace/notor/src/providers/openai-provider.ts), lines 236-307): Tracks `activeToolCalls` by index. Each `delta.tool_calls` entry with a new `tc.id` emits a `tool_call_start`; accumulated `tc.function.arguments` emit `tool_call_delta`; `finish_reason === "tool_calls"` triggers `tool_call_end` for all active calls.

- **Bedrock** ([`/Volumes/workplace/notor/src/providers/bedrock-provider.ts`](/Volumes/workplace/notor/src/providers/bedrock-provider.ts), lines 230-434): Maps `contentBlockStart/Delta/Stop` events using an `activeToolBlockIndices` Map (blockIndex → toolUseId). Each tool_use block gets its own start/delta/stop sequence.

**Conclusion:** The provider streaming layer needs zero changes. The stream already contains all tool calls — `processStream()` just stops listening too early.

### 3.4 Tool Dispatcher — Single Tool, Synchronous

**File:** [`/Volumes/workplace/notor/src/chat/dispatcher.ts`](/Volumes/workplace/notor/src/chat/dispatcher.ts) (lines 262-532)

`dispatch()` handles a single tool: lookup → enabled check → Plan/Act check → pre-execution checks → approval gate → path enforcement → `tool.execute(params)`. Returns a single `ToolResult`. No batching, no concurrency awareness.

### 3.5 Tool Interface — Has `mode` but No Concurrency Flag

**File:** [`/Volumes/workplace/notor/src/tools/tool.ts`](/Volumes/workplace/notor/src/tools/tool.ts) (lines 53-72)

```typescript
interface Tool {
  name: string;
  description: string;
  input_schema: JSONSchema;
  mode: "read" | "write";
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}
```

The `mode` property is used for Plan/Act gating but can also serve as the concurrency signal: `"read"` tools are inherently safe to run in parallel (they don't mutate vault state). All 18 built-in tools were audited — every mode assignment is correct (no "read" tools that mutate, no "write" tools that are read-only).

### 3.6 Message Types — One Tool Call Per Message

**File:** [`/Volumes/workplace/notor/src/types.ts`](/Volumes/workplace/notor/src/types.ts) (lines 95-189)

The `Message` interface carries at most one `tool_call?: ToolCall` or one `tool_result?: ToolResult`. The conversation history models tool interactions as individual messages: `tool_call_msg_1, tool_result_msg_1, tool_call_msg_2, tool_result_msg_2, ...`

### 3.7 Message Conversion — 1:1 Mapping

**File:** [`/Volumes/workplace/notor/src/chat/orchestrator.ts`](/Volumes/workplace/notor/src/chat/orchestrator.ts) (lines 2001-2109)

`toChatMessages()` maps each internal `Message` to a single `ChatMessage`. Consecutive `tool_call` messages become consecutive `ChatMessage { role: "tool_call" }` entries. This works for serial execution but doesn't produce the provider-expected format for parallel tool use (one assistant message with multiple tool_use blocks → one user message with matching tool_result blocks).

### 3.8 Orphaned Tool Call Safety Net

**File:** [`/Volumes/workplace/notor/src/chat/orchestrator.ts`](/Volumes/workplace/notor/src/chat/orchestrator.ts) (lines 2072-2098)

`toChatMessages()` includes a safety net that detects `tool_call` messages without a following `tool_result` and injects synthetic error results. This is critical and must be preserved (and extended) for parallel execution where multiple tool calls could be in-flight.

**Caveat for multi-tool ordering:** The current safety net checks if `chatMessages[i+1]` is a `tool_result`. With grouped ordering (all tool_calls before all tool_results), consecutive tool_call messages would each trigger synthetic result injection. The safety net update (Change 6) must land together with or before the grouped message ordering — see Phase 2/3 notes in Section 5.

### 3.9 Conversation Manager — Simple Array Push

**File:** [`/Volumes/workplace/notor/src/chat/conversation.ts`](/Volumes/workplace/notor/src/chat/conversation.ts) (lines 276-355)

`ConversationManager.addMessage()` creates a `Message` with a UUID, pushes it to `this.messages[]`, updates conversation metadata (tokens, cost, timestamps), and fires callbacks. Messages are always appended in call order. There's no concept of grouping or batching messages.

**Concurrency note:** `addMessage` fires callbacks via `void this.onMessageAdded?.(message)` (fire-and-forget). Since tool_call messages are added in a synchronous loop before dispatch, and tool_result messages are added sequentially from the `Promise.all` result array, callbacks won't race. However, if the result-collection loop is ever made async (e.g., for streaming results), verify the persistence layer handles concurrent `onMessageAdded` calls.

### 3.10 Background Workflow Concurrency (Existing Pattern)

**File:** [`/Volumes/workplace/notor/src/workflows/workflow-concurrency.ts`](/Volumes/workplace/notor/src/workflows/workflow-concurrency.ts)

Notor already has a concurrency manager for background workflows (default limit: 3). This manages how many event-triggered workflow conversations can run simultaneously — a separate concern from within-conversation tool concurrency, but evidence that Notor already handles some concurrent execution patterns.

---

## 4. Detailed Design

### 4.1 Change 1: `processStream()` Collects All Tool Calls

**File to modify:** [`/Volumes/workplace/notor/src/chat/orchestrator.ts`](/Volumes/workplace/notor/src/chat/orchestrator.ts), `processStream()` method (lines 1850-1973)

**Current behavior:** Returns immediately on `tool_call_end` with a single tool call.

**New behavior:** Accumulate tool calls into an array. Only return after stream exhaustion or `message_end`.

**New return type:**

```typescript
// Current StreamResult (simplified):
type StreamResult =
  | { type: "text"; text: string; inputTokens: number; outputTokens: number; contentEl?: HTMLElement }
  | { type: "tool_call"; toolCallId: string; toolName: string; parameters: Record<string, unknown>; text: string; inputTokens: number; outputTokens: number; contentEl?: HTMLElement }
  | { type: "cancelled"; ... }
  | { type: "error"; ... }

// New StreamResult — tool_call variant carries an array:
type StreamResult =
  | { type: "text"; text: string; inputTokens: number; outputTokens: number; contentEl?: HTMLElement }
  | { type: "tool_calls"; calls: Array<{ toolCallId: string; toolName: string; parameters: Record<string, unknown> }>; text: string; inputTokens: number; outputTokens: number; contentEl?: HTMLElement }
  | { type: "cancelled"; ... }
  | { type: "error"; ... }
```

**Implementation sketch for the `tool_call_end` case (replacing lines 1902-1935):**

Instead of `return`ing on `tool_call_end`, push the completed tool call onto an accumulator array and reset the per-call state variables (`currentToolCallId`, `currentToolName`, `toolCallJson`). After the `for await` loop exits naturally (stream exhausted), check if the accumulator is non-empty and return the `tool_calls` result type.

**Key detail:** The `message_end` chunk (which carries `input_tokens` and `output_tokens`) arrives after all content blocks. By consuming the full stream, we now correctly capture token counts that were previously lost when we bailed early on `tool_call_end`.

### 4.2 Change 2: New Tool Orchestration Module

**New file:** `/Volumes/workplace/notor/src/chat/tool-orchestration.ts`

This module sits between `processStream()` and `dispatcher.dispatch()`. It receives an array of tool calls and executes them with appropriate concurrency.

**Modeled on:** [`/Volumes/workplace/claude-code-fork/src/services/tools/toolOrchestration.ts`](/Volumes/workplace/claude-code-fork/src/services/tools/toolOrchestration.ts)

**Partitioning function:**

```typescript
type ToolCallInfo = {
  toolCallId: string;
  toolName: string;
  parameters: Record<string, unknown>;
};

type Batch = {
  isConcurrencySafe: boolean;
  calls: ToolCallInfo[];
};

function partitionToolCalls(
  calls: ToolCallInfo[],
  tools: Map<string, Tool>   // from dispatcher's tool registry
): Batch[]
```

**Algorithm** (same as Claude Code):
1. For each call, look up the tool in the registry and check `tool.mode`.
2. `mode === "read"` → concurrency-safe. `mode === "write"` → non-concurrent.
3. MCP tools ([`/Volumes/workplace/notor/src/mcp/mcp-tool-adapter.ts`](/Volumes/workplace/notor/src/mcp/mcp-tool-adapter.ts)) **always default to non-concurrent**, regardless of their `mode` property. MCP tools execute arbitrary server-side code and even a `mode: "read"` MCP tool could have side effects the plugin doesn't know about. The partitioning must check tool provenance (built-in vs MCP) separately from mode. Future extension: an explicit `concurrent_safe` flag in `McpServerConfig` to opt in specific MCP servers.
4. Consecutive concurrency-safe calls are grouped. Non-concurrent calls get their own batch.
5. If tool lookup fails or mode cannot be determined, conservatively treat as non-concurrent (matching Claude Code's pattern at toolOrchestration.ts lines 96-108).

**Execution function:**

```typescript
type ToolCallResult = {
  call: ToolCallInfo;
  result: ToolResult;
};

async function executeToolBatches(
  batches: Batch[],
  dispatcher: ToolDispatcher,
  mode: ConversationMode,
  messageIdMap: Map<string, string>,  // toolCallId → messageId (for dispatch)
  abortSignal?: AbortSignal,
  concurrencyCap?: number             // default: 5
): Promise<ToolCallResult[]>
```

**Algorithm:**
1. Iterate batches in order.
2. For a concurrent batch: `await Promise.all(batch.calls.map(call => safeDispatch(call)))`, capped at `concurrencyCap` using a simple semaphore. **`Promise.all` is chosen specifically because it preserves submission order** — results are returned in the same order as the input calls, regardless of completion order. Each `dispatcher.dispatch()` call is wrapped in a try/catch (`safeDispatch`) that converts unexpected throws into error `ToolResult`s. This matches the existing error-handling pattern at `responseLoop()` lines 1478-1491 and prevents a single unexpected throw from discarding all concurrent sibling results via `Promise.all`'s fail-fast behavior.
3. For a serial batch (single call): `await safeDispatch(call)`.
4. If `abortSignal` fires mid-batch, remaining calls in the batch produce synthetic error results (matching the existing orphan safety net pattern).
5. Return all results in original call order.

**`safeDispatch` wrapper:**

```typescript
async function safeDispatch(
  call: ToolCallInfo,
  dispatcher: ToolDispatcher,
  mode: ConversationMode,
  messageId: string,
  abortSignal?: AbortSignal
): Promise<ToolResult> {
  try {
    return await dispatcher.dispatch(
      call.toolName, call.parameters, mode, messageId, abortSignal
    );
  } catch (e) {
    return {
      tool_name: call.toolName,
      success: false,
      result: "",
      error: `Tool call failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
```

**Why not the StreamingToolExecutor approach?** The streaming executor starts tools before the stream finishes, which is an optimization for latency. For Notor's initial implementation, the simpler batch approach (collect all calls first, then execute) is sufficient and much less complex. The streaming approach can be added as a follow-up if profiling shows the benefit.

### 4.3 Change 3: Update `responseLoop()` to Handle Multiple Tool Calls

**File to modify:** [`/Volumes/workplace/notor/src/chat/orchestrator.ts`](/Volumes/workplace/notor/src/chat/orchestrator.ts), `responseLoop()` method (lines 1317-1607)

**Current flow (lines 1434-1567):** Handle a single `result.type === "tool_call"` by dispatching one tool and adding one `tool_call` + one `tool_result` message.

**New flow for `result.type === "tool_calls"`:**

```
0. Add an assistant message carrying result.text and token counts
   (see "Pre-tool-call text handling" below)

1. For each call in result.calls:
   a. Add a tool_call message via conversationManager.addMessage()
   b. Render tool call UI via view.renderToolCall()
   c. Fire on_tool_call hooks (sequentially — see Section 7.5)

2. Partition calls into batches via partitionToolCalls()

3. Execute batches via executeToolBatches()
   - Concurrent batches run in parallel (via safeDispatch wrapper)
   - Serial batches run one-at-a-time
   - All pre-execution checks (approval, path enforcement, etc.) still
     happen inside dispatcher.dispatch() per-tool

4. For each result (in original call order):
   a. Update tool call status badge in UI
   b. Propagate tool_call_id
   c. Record note access for vault rules
   d. Add tool_result message via conversationManager.addMessage()
   e. Render tool result UI
   f. Fire on_tool_result hooks (sequentially — see Section 7.5)

5. If abortSignal fired during execution, break

6. continueLoop = true
```

**Important sequencing detail:** All `tool_call` messages must be added to the conversation **before** any `tool_result` messages. This ensures that `toChatMessages()` can correctly group them when building the API request (see Change 4).

**Pre-tool-call text handling:** When the LLM produces text before tool calls, `result.text` contains that text. An **assistant `Message`** is added to the conversation **before** the tool_call messages (step 0), carrying both `result.text` as content and the token counts from `message_end` (`result.inputTokens`, `result.outputTokens`). This reuses the existing token-tracking pattern at lines 1556-1564 but moves it to the correct position — before tool_calls rather than after tool_results.

This placement matters for three reasons:
1. **Coalescing in `toChatMessages()`:** The coalescing logic detects the pattern `assistant(text + tokens) → tool_call × N` and merges them into a single API assistant message with a text content block followed by tool_use content blocks, matching the Anthropic API's native format.
2. **Compaction safety:** `extractPendingMessages()` scans backward for the last assistant message. With the assistant message placed before tool_calls, tool_call and tool_result messages are correctly identified as "pending" (after the last assistant) and re-appended after compaction.
3. **Token attribution:** Token counts are now correctly associated with the LLM turn that produced them, not orphaned after the tool results.

### 4.4 Change 4: Update `toChatMessages()` for Multi-Tool Turns

**File to modify:** [`/Volumes/workplace/notor/src/chat/orchestrator.ts`](/Volumes/workplace/notor/src/chat/orchestrator.ts), `toChatMessages()` method (lines 2001-2109)

**Problem:** The Anthropic (and Bedrock) API expects a single `assistant` message containing multiple `tool_use` content blocks, followed by a single `user` message containing matching `tool_result` blocks. Notor's current 1:1 message mapping produces separate messages.

**Solution:** Detect runs of consecutive `tool_call` messages and coalesce them into a single assistant `ChatMessage` with multiple tool_use entries. Similarly, coalesce the matching run of `tool_result` messages into a single user `ChatMessage` with multiple tool_result entries.

**Sketch:**

```typescript
// When iterating messages and encountering a tool_call:
// 1. Check if the preceding message is an assistant message (the pre-tool-call
//    text + token carrier from Change 3 step 0). If so, use its content as the
//    text content block for the coalesced assistant message.
// 2. Look ahead to collect all consecutive tool_call messages
// 3. Emit ONE assistant ChatMessage with:
//    - A text content block (from the preceding assistant message, if any)
//    - All tool_use blocks from the consecutive tool_call messages
// 4. Skip ahead past the tool_calls
// 5. Collect matching consecutive tool_result messages  
// 6. Emit ONE user ChatMessage with all tool_result blocks
//
// The preceding assistant message is "absorbed" into the coalesced message
// and should NOT also be emitted as a separate ChatMessage.
```

**The `ChatMessage` type** ([`/Volumes/workplace/notor/src/providers/provider.ts`](/Volumes/workplace/notor/src/providers/provider.ts), lines 23-37) currently supports only one `tool_call?` and one `tool_result?` per message. Replace singular fields with array fields:

```typescript
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  tool_calls?: Array<{        // replaces tool_call?
    id: string;
    tool_name: string;
    parameters: Record<string, unknown>;
  }>;
  tool_results?: Array<{      // replaces tool_result?
    tool_call_id: string;
    tool_name: string;
    result: string;
    is_error: boolean;
  }>;
}
```

This is an **atomic arrays-only** migration — no dual singular/array fields. All consumers of `ChatMessage.tool_call` and `ChatMessage.tool_result` must be updated in the same change. Before starting, run `grep -r '\.tool_call\b' --include='*.ts'` and `grep -r '\.tool_result\b' --include='*.ts'` across the codebase to enumerate all consumers (providers, compaction, history export, tests, etc.). For a single tool call, the array has one element.

**Provider impact:** Each provider's message-building code needs updating:

- **Anthropic** ([`/Volumes/workplace/notor/src/providers/anthropic-provider.ts`](/Volumes/workplace/notor/src/providers/anthropic-provider.ts)): The Anthropic SDK already accepts arrays of content blocks. The provider just needs to map `tool_calls[]` → `content: [{ type: "tool_use", ... }, ...]` and `tool_results[]` → `content: [{ type: "tool_result", ... }, ...]`.

- **OpenAI** ([`/Volumes/workplace/notor/src/providers/openai-provider.ts`](/Volumes/workplace/notor/src/providers/openai-provider.ts)): OpenAI's API naturally supports `tool_calls[]` on assistant messages and separate `tool` role messages per result.

- **Bedrock** ([`/Volumes/workplace/notor/src/providers/bedrock-provider.ts`](/Volumes/workplace/notor/src/providers/bedrock-provider.ts)): Bedrock's ConverseStream API accepts `toolUse` content blocks in assistant messages and `toolResult` blocks in user messages, both as arrays.

### 4.5 Change 5: Approval UX for Batched Tool Calls

**File to modify:** [`/Volumes/workplace/notor/src/chat/dispatcher.ts`](/Volumes/workplace/notor/src/chat/dispatcher.ts), approval logic (lines 392-433)

**Minimum viable approach (recommended for initial implementation):**

- Auto-approved tools execute in parallel without user interaction (the common case in Act mode with auto-approve on).
- Non-auto-approved tools within a concurrent batch fall back to serial approval: each one pauses for user approval before executing, same as today.
- This means concurrent batches with mixed auto-approve status effectively become serial for the non-approved tools, but auto-approved ones still run concurrently with each other.

**Note on approval UI:** The current approval flow is inline/promise-based in [`/Volumes/workplace/notor/src/ui/approval-ui.ts`](/Volumes/workplace/notor/src/ui/approval-ui.ts) (not modal). Each tool call card renders its own approve/reject buttons that resolve a Promise. This works for concurrent execution — multiple approval prompts appear simultaneously, each resolving independently.

**Future enhancement:** A batch approval modal showing all pending tool calls at once with approve-all / reject-all / per-tool buttons.

### 4.6 Change 6: Extend the Orphaned Tool Call Safety Net

**File to modify:** [`/Volumes/workplace/notor/src/chat/orchestrator.ts`](/Volumes/workplace/notor/src/chat/orchestrator.ts) (lines 2072-2098)

The existing safety net in `toChatMessages()` detects unpaired `tool_call` messages and injects synthetic error `tool_result` messages. With parallel execution, there can be multiple unpaired tool calls if execution is interrupted mid-batch.

**New algorithm:** Instead of checking if the immediate next message is a `tool_result`, scan a run of consecutive `tool_call` messages as a group, then check that a matching run of `tool_result` messages follows. Inject synthetic results only for tool_calls that have no matching tool_result in the subsequent run.

### 4.7 UI Considerations

**File:** [`/Volumes/workplace/notor/src/ui/chat-view.ts`](/Volumes/workplace/notor/src/ui/chat-view.ts)

Multiple tool calls rendered simultaneously need clear visual grouping:
- All tool calls from a single LLM turn should appear together, possibly with a visual container indicating they're part of the same batch.
- Results should appear next to their corresponding call as they complete (not all at once at the end).
- The "responding" state indicator should persist while any tool in the batch is still executing.

---

## 5. Implementation Order

> **Hard gate on Phases 2 and 3:** These phases MUST be implemented, tested, and merged as a single unit (same PR). The orphaned tool_call safety net (lines 2076-2098) checks `chatMessages[i + 1]` — with Phase 2's grouped ordering (`tool_call, tool_call, tool_result, tool_result`), the first tool_call's next message is another tool_call, triggering **false positive** synthetic result injection that corrupts the conversation. Phase 3's updated safety net eliminates this failure mode. No intermediate state where grouped ordering exists without the updated safety net is acceptable.

### Phase 1: Stream Collection (Low Risk) — ✅ COMPLETE (2026-04-03)
1. ✅ Modify `processStream()` to accumulate all tool calls and return `tool_calls` array
2. ✅ Update the `StreamResult` type — replaced `tool_call` variant with `tool_calls` (carries `calls: ToolCallInfo[]`)
3. ✅ This change is backwards-compatible: if LLM returns 1 tool call, the array has 1 element
4. ✅ Updated `responseLoop()` to handle `result.type === "tool_calls"` with serial dispatch loop
5. ✅ Token counts now correctly captured from `message_end` (previously lost due to early return)

### Phase 2: Serial Multi-Tool (Medium Risk) — ✅ COMPLETE (2026-04-03)
1. ✅ Update `responseLoop()` to handle `result.type === "tool_calls"` (done in Phase 1)
2. ✅ Execute all tools serially with grouped message ordering (all tool_call messages first, then dispatch, then all tool_result messages)
3. ✅ Add all `tool_call` messages first, then all `tool_result` messages — validates stream collection and grouped ordering without introducing concurrency
4. ✅ Update orphaned tool_call safety net to handle consecutive tool_call runs (scans runs and matches by tool_call_id instead of checking `chatMessages[i+1]`) — required co-change per Section 5 hard gate

### Phase 3: Message Coalescing (Medium Risk)
1. Replace `ChatMessage` singular `tool_call?`/`tool_result?` fields with `tool_calls?`/`tool_results?` arrays
2. Update `toChatMessages()` to coalesce consecutive tool_call/tool_result messages
3. Include pre-tool-call text as a text content block in the coalesced assistant message
4. Update provider `sendMessage()` implementations to handle the new array fields
5. ✅ Update the orphaned tool call safety net for consecutive tool_call runs (completed in Phase 2 — required co-change per Section 5 hard gate)

### Phase 4: Parallel Execution (Higher Risk)
1. Create `src/chat/tool-orchestration.ts` with partitioning and parallel execution
2. Add concurrency-safety determination (based on `tool.mode` for built-in tools; always non-concurrent for MCP tools)
3. Wire into `responseLoop()` — replace serial dispatch with batch orchestration
4. Add concurrency cap (default: 5)

### Phase 5: Polish
1. Batch approval UX (if needed)
2. UI grouping for multi-tool turns
3. Error cascading for related tools (optional, modeled on Claude Code's sibling abort)

---

## 6. Files to Modify (Summary)

| File | Change |
|------|--------|
| [`/Volumes/workplace/notor/src/chat/orchestrator.ts`](/Volumes/workplace/notor/src/chat/orchestrator.ts) | `processStream()`, `responseLoop()`, `toChatMessages()`, `StreamResult` type, orphan safety net |
| [`/Volumes/workplace/notor/src/providers/provider.ts`](/Volumes/workplace/notor/src/providers/provider.ts) | Replace `tool_call?`/`tool_result?` with `tool_calls?`/`tool_results?` arrays on `ChatMessage` |
| [`/Volumes/workplace/notor/src/providers/anthropic-provider.ts`](/Volumes/workplace/notor/src/providers/anthropic-provider.ts) | Handle `tool_calls[]`/`tool_results[]` in message building |
| [`/Volumes/workplace/notor/src/providers/openai-provider.ts`](/Volumes/workplace/notor/src/providers/openai-provider.ts) | Handle `tool_calls[]`/`tool_results[]` in message building |
| [`/Volumes/workplace/notor/src/providers/bedrock-provider.ts`](/Volumes/workplace/notor/src/providers/bedrock-provider.ts) | Handle `tool_calls[]`/`tool_results[]` in message building |
| [`/Volumes/workplace/notor/src/chat/dispatcher.ts`](/Volumes/workplace/notor/src/chat/dispatcher.ts) | No structural changes needed — called per-tool as before |
| [`/Volumes/workplace/notor/src/tools/tool.ts`](/Volumes/workplace/notor/src/tools/tool.ts) | Optionally add `isConcurrencySafe?: boolean` override (defaults to `mode === "read"`) |
| `/Volumes/workplace/notor/src/chat/tool-orchestration.ts` | **New file:** partitioning + parallel execution |
| [`/Volumes/workplace/notor/src/ui/chat-view.ts`](/Volumes/workplace/notor/src/ui/chat-view.ts) | Visual grouping for multi-tool turns |

**Additional files to verify** (not structurally changed but may need attention):
- History persistence layer — ensure concurrent `onMessageAdded` callbacks are safe
- Compaction logic — verify it handles consecutive tool_call messages correctly
- Conversation forking — fork button logic assumes 1:1 tool_call:message; verify fork works with multi-tool turns

---

## 7. Key Design Decisions & Tradeoffs

### 7.1 Batch-First vs Streaming Execution

Claude Code has two paths: batch (`toolOrchestration.ts`) and streaming (`StreamingToolExecutor.ts`). The streaming path starts tools before the LLM stream finishes, saving latency for long responses with tools at the end.

**Recommendation for Notor:** Start with batch-only. The streaming executor adds significant complexity (per-tool state machine, progress tracking, sibling abort controllers) and the latency benefit is marginal for Notor's use case where tool calls are typically the entire response (not appended after long text blocks). This can always be added later.

### 7.2 Concurrency Signal: `mode` vs Explicit `isConcurrencySafe`

Claude Code uses an explicit `isConcurrencySafe(input)` method that can inspect the tool's parsed input to decide (e.g., a Bash tool running `ls` is safe, but `rm -rf` is not).

**Recommendation for Notor:** Use `tool.mode === "read"` as the concurrency signal for built-in tools. This is simpler and correct — all Notor read tools genuinely don't mutate state (confirmed by audit of all 18 tools). For MCP tools, **always treat as non-concurrent regardless of mode** — MCP tools execute arbitrary server-side code where even "read" operations could have side effects. Add an optional `isConcurrencySafe?: boolean` to the `Tool` interface for future fine-grained control.

### 7.3 Internal Message Model: Extend vs Restructure

Two approaches for storing multi-tool turns:
- **A) Keep individual messages, coalesce in `toChatMessages()`:** Lower risk, no migration, but the internal model diverges from the API model.
- **B) Restructure `Message` to support arrays of tool_call/tool_result:** Cleaner long-term, but requires updating ConversationManager, HistoryManager, UI rendering, compaction, and every place that reads/writes messages.

**Recommendation for Notor:** Approach A. The coalescing logic in `toChatMessages()` is straightforward and avoids a large cross-cutting refactor. The internal message-per-tool-call model is easy to reason about and works well with the existing persistence/history/compaction code.

### 7.4 Abort Behavior During Parallel Execution

If the user clicks Stop while 3 tools are running in parallel:
- **Claude Code:** Sibling abort controllers can cascade errors for related tools.
- **Notor's existing pattern:** The `AbortSignal` is raced against `tool.execute()` in `dispatcher.dispatch()` (lines 475-491). The first tool to detect the abort returns an error result; the others continue running but their results are discarded.

**Recommendation for Notor:** The existing per-tool abort race is sufficient. When `abortSignal` fires, `Promise.all` will resolve with a mix of real results and abort errors. The safety net ensures all tool_calls get matching tool_results. No additional abort plumbing needed.

### 7.5 Hook Execution During Parallel Tools

`on_tool_call` and `on_tool_result` hooks (lines 1449-1465, 1532-1553) currently fire once per tool. With parallel execution, multiple hooks could fire concurrently.

**Recommendation for Notor:** Fire hooks **sequentially** even when tools execute in parallel. This preserves the current invariant that hooks don't race, avoids surprising behavior for hook scripts that assume exclusive execution, and has minimal latency impact since hooks are lightweight. Hooks are fired in the result-collection loop (step 4 in Change 3), which iterates results in order.

---

## 8. Verification Plan

### Unit Tests
- `processStream()`: Feed a mock stream with 0, 1, 2, 3 tool calls and verify the returned array
- `processStream()`: Feed a mock stream with text content followed by tool calls, verify text is captured in `result.text`
- `partitionToolCalls()`: Test grouping logic with various read/write tool sequences
- `partitionToolCalls()`: Test that MCP tools are always treated as non-concurrent regardless of mode
- `partitionToolCalls()`: Test that unknown tools are treated as non-concurrent
- `safeDispatch()`: Verify that an unexpected throw from `dispatcher.dispatch()` is caught and converted to an error `ToolResult`
- `toChatMessages()` coalescing: Verify `assistant(text) → tool_call × N → tool_result × N` produces one API assistant message (text + tool_use blocks) + one API user message (tool_result blocks)
- `toChatMessages()` coalescing: Verify pre-tool-call text is included as text content block in coalesced assistant message
- Orphan safety net: Verify synthetic results are injected for each unpaired tool_call in a multi-call scenario
- Orphan safety net: Verify no false positives — consecutive tool_calls with matching tool_results don't trigger injection

### Integration Tests
- End-to-end: Send a prompt that triggers multiple tool calls (e.g., "read notes A, B, and C") and verify all three execute and their results appear in the conversation
- Abort mid-batch: Start a multi-tool turn, abort during execution, verify all tool_calls have matching tool_results
- Provider round-trip: Verify that the coalesced ChatMessage format is correctly consumed by each provider (Anthropic, OpenAI, Bedrock) on the next LLM turn
- Compaction round-trip: Trigger compaction after a multi-tool turn, verify `extractPendingMessages()` correctly identifies tool_call/tool_result messages as pending and re-appends them after compaction

### Manual Testing
- Verify UI shows all tool calls grouped in a single turn
- Verify approval gates work correctly for non-auto-approved tools in a batch
- Verify token counts are correctly captured from `message_end` (previously lost)
- Verify conversation forking still works from individual tool calls within a multi-tool turn

---

## 9. Review Notes (2026-04-03)

This section documents findings from a code-level review of both the Notor and Claude Code codebases against the claims in this design doc.

### 9.1 All Architecture Claims Verified

Every claim in Sections 2 and 3 was confirmed by code inspection:

- `processStream()` returns on first `tool_call_end` (line 1926), discarding remaining stream + `message_end` tokens ✓
- `responseLoop()` handles single `result.type === "tool_call"` per iteration ✓
- `toChatMessages()` has 1:1 mapping + orphan safety net checking `chatMessages[i+1]` ✓
- `Message` type carries singular `tool_call?` / `tool_result?` ✓
- `ChatMessage` type carries singular `tool_call?` / `tool_result?` ✓
- `addMessage()` is simple array push with fire-and-forget callbacks ✓
- All 18 built-in tools have correct `mode` assignments (10 read, 8 write) ✓
- Dispatcher handles single tool with try/catch that always returns `ToolResult` (lines 510-531) ✓
- All 3 providers already emit multiple `tool_call_start/delta/end` sequences ✓
- MCP tools distinguishable via `isMcpTool()` at `mcp-tool-adapter.ts:32-34` (checks for `__` separator) ✓
- Approval UI is inline/promise-based, returns `Promise<"approved" | "rejected">` ✓
- Hooks are fire-and-forget (`void` dispatch) ✓
- Claude Code's `partitionToolCalls()`, `all()`, and `StreamingToolExecutor` all work as described ✓

### 9.2 Remaining Low-Priority Notes

**Concurrent HTTP tools:** `fetch_webpage` and `web_search` (both `mode: "read"`) make external HTTP requests. Running these concurrently is fine in general, but external services may rate-limit rapid concurrent requests. No code change needed — just worth a comment in the concurrency-safety determination if these tools are frequently batched.

**Hook overlap:** The doc says hooks fire "sequentially" (Section 7.5). More precisely: hook *initiation* is sequential (the result-collection loop iterates in order), but hooks are fire-and-forget (`void` dispatch). If a hook takes 5 seconds, the next hook's initiation won't wait for it. This is the correct behavior for Notor (no blocking), but hook scripts that assume exclusive execution should be aware that overlap is possible across tools in the same batch.

**Abort + background tools:** When abort fires during `Promise.all`, the dispatcher's `Promise.race` returns the abort error immediately, but `tool.execute()` continues in the background (lines 467-494). For concurrent read tools, this means N background operations may complete after the user clicks Stop. This is pre-existing behavior, not introduced by this design.
