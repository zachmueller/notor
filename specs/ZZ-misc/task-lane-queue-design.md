# TaskLaneQueue: Generic Per-Lane Serialization Primitive

**Status:** Design complete
**Author:** Design spike
**Date:** 2026-04-09

---

## 1. Motivation

Multiple features in Notor need per-key FIFO serialization of async operations:

- **Web search rate limiting** — DDG throttles concurrent requests (HTTP 202). Each search provider needs its own delay lane (1500ms for DDG, 0ms for API providers). See [`multi-provider-web-search-design.md`](./multi-provider-web-search-design.md).
- **MCP server dispatch** — Many MCP servers are single-threaded. Multi-panel chat (Phase 4) enables cross-session concurrent tool calls to the same server. See [`thread-safe-streaming-multi-panel-design.md`](./thread-safe-streaming-multi-panel-design.md), Phase 4.
- **User extensions** — Extension authors need a simple way to rate-limit HTTP calls to external APIs without building their own queue.

The pattern already exists inline in [`HistoryManager.writeQueues`](../../src/chat/history.ts) (lines 93-138): a `Map<string, Promise<void>>` where each file path gets a serialized promise chain. `TaskLaneQueue` generalizes this into a reusable primitive with an optional inter-completion delay.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Location | `src/queue/task-lane-queue.ts` | Generic infrastructure, not tied to web search or MCP. |
| Scope | Plugin-level singleton | Must span all conversations, sub-agents, panels, and extensions. Created in `main.ts`, injected into consumers. |
| Concurrency model | Strictly serial per lane | Safest default. One task executes at a time per lane. Cross-lane tasks are fully concurrent. |
| Delay enforcement | Inter-completion gap, not pre-request | First request on an idle lane fires immediately. Delay applies between consecutive completions. |
| Delay ownership | First-writer-wins | The `delayMs` is set when a lane is first created. Subsequent callers cannot lower it. Prevents extensions from weakening shared lane protections. |
| Error handling | Lane advances on throw | If `fn` throws, the error propagates to the caller. The lane releases and the next waiter proceeds. Same behavior as `HistoryManager.enqueueWrite`. |
| Lane lifecycle | In-memory only, self-cleaning | Idle lanes are cleaned up via `finally()`. No persistent state. Reset on plugin restart. |
| Extension exposure | Via `utils.queue` in extension runtime context | Extensions get `enqueue()` and `pending()`. No `removeLane()` (internal-only). |

---

## 3. API

**File:** `src/queue/task-lane-queue.ts`

```typescript
export class TaskLaneQueue {
  private lanes = new Map<string, Lane>();

  /**
   * Enqueue an async task on the named lane. The task executes when the
   * lane is available (previous task completed + delay elapsed).
   *
   * @param laneKey - Lane identifier (e.g., "duckduckgo", "mcp:obsidian-mcp")
   * @param fn      - Async function to execute when the lane is ready
   * @param delayMs - Minimum ms between consecutive completions on this lane.
   *                  Only used when the lane is first created (first-writer-wins).
   *                  Default: 0 (no delay, but still serialized).
   * @returns The return value of `fn`.
   */
  async enqueue<T>(laneKey: string, fn: () => Promise<T>, delayMs?: number): Promise<T>;

  /** Number of tasks waiting in a lane's queue. 0 for non-existent lanes. */
  pending(laneKey: string): number;

  /** Remove a lane (used for cleanup/testing). Not exposed to extensions. */
  removeLane(laneKey: string): void;
}
```

### 3.1 Internal Lane Structure

```typescript
interface Lane {
  /** Minimum delay between consecutive task completions (ms). */
  delayMs: number;
  /** Timestamp (ms) of the last completed task in this lane. */
  lastCompletionTime: number;
  /** FIFO queue of pending tasks awaiting this lane's delay window. */
  waitQueue: Array<{ resolve: () => void }>;
  /** Whether a drain loop is currently running for this lane. */
  draining: boolean;
}
```

### 3.2 Execution Flow

1. Caller enters the lane via `enqueue(laneKey, fn, delayMs)`.
2. If the lane doesn't exist, create it with the provided `delayMs` (default 0).
3. If `Date.now() - lane.lastCompletionTime >= delayMs`, the task executes immediately.
4. Otherwise, the caller is enqueued in `waitQueue` and a Promise resolves after the remaining delay.
5. After the task completes (success or failure), `lane.lastCompletionTime` is updated and the next waiter (if any) is scheduled.
6. The return value of `fn` is returned to the caller. If `fn` throws, the error propagates to the caller and the lane is still released.
7. Empty lanes self-clean: when `waitQueue` is empty and `draining` ends, the lane entry is removed from the map.

### 3.3 Cross-Lane Concurrency

Lanes are fully independent. A DDG lane waiting through its 1500ms delay does not block a Tavily lane from firing immediately. This is the key difference from a global semaphore.

### 3.4 Relationship to Existing Patterns

With `delayMs = 0`, `TaskLaneQueue.enqueue()` is functionally identical to [`HistoryManager.enqueueWrite()`](../../src/chat/history.ts) (lines 127-138). The delay feature is additive. `HistoryManager` is left unchanged — the existing inline implementation is adequate for its single-consumer use case.

The pattern is also related to the inline semaphore in [`tool-orchestration.ts:186-243`](../../src/chat/tool-orchestration.ts), but that is a capacity-based concurrent semaphore (N-at-a-time), whereas `TaskLaneQueue` is strictly serial (1-at-a-time per lane) with optional delay.

---

## 4. Lane Naming Convention

Lane keys are opaque strings. No enforcement in `TaskLaneQueue` itself. Convention by documentation:

| Consumer | Lane key pattern | Examples |
|----------|-----------------|----------|
| Web search providers | `"{provider}"` | `"duckduckgo"`, `"tavily"`, `"brave"`, `"serpapi"` |
| MCP servers | `"mcp:{serverName}"` | `"mcp:obsidian-mcp"`, `"mcp:filesystem"` |
| User extensions | Any string | `"deepl-api"`, `"my-ext:duckduckgo"` |

**Shared lane semantics:** Two callers using the same lane key are serialized together. An extension calling `enqueue("duckduckgo", ...)` shares the lane with the built-in web search tool's DDG requests. This is intentional — the point of shared lanes is preventing aggregate request rates from exceeding provider limits.

**Isolated lane semantics:** An extension wanting independent throughput to DDG can use a different lane name (e.g., `"my-ext:duckduckgo"`), accepting that DDG may throttle if both lanes fire concurrently.

---

## 5. Wiring

### 5.1 Plugin Singleton

**File:** `src/main.ts`

```typescript
private _taskLaneQueue?: TaskLaneQueue;

getTaskLaneQueue(): TaskLaneQueue {
  if (!this._taskLaneQueue) {
    this._taskLaneQueue = new TaskLaneQueue();
  }
  return this._taskLaneQueue;
}
```

`getTaskLaneQueue()` is **public** because it is accessed by `buildUtils()` in [`src/extensions/runtime-context.ts`](../../src/extensions/runtime-context.ts) for extension wiring.

### 5.2 Extension Exposure

**File:** `src/extensions/runtime-context.ts`

Add to `ExtensionUtils` interface:

```typescript
queue: {
  enqueue: <T>(lane: string, fn: () => Promise<T>, delayMs?: number) => Promise<T>;
  pending: (lane: string) => number;
};
```

In `buildUtils()`:

```typescript
const queue = plugin.getTaskLaneQueue();
return {
  // ... existing utils ...
  queue: {
    enqueue: (lane, fn, delayMs) => queue.enqueue(lane, fn, delayMs),
    pending: (lane) => queue.pending(lane),
  },
};
```

Note: `removeLane()` is intentionally not exposed to extensions.

### 5.3 Consumers

| Consumer | Injected via | Lane keys | Delay |
|----------|-------------|-----------|-------|
| `WebSearchQueue` | Constructor parameter | Provider type strings | Per-provider (1500ms DDG, 0ms API) |
| `McpHub` | Constructor parameter | `"mcp:{serverName}"` | 0ms (pure serialization) |
| User extensions | `utils.queue` | Free-form | Caller-specified |

---

## 6. Edge Cases

### 6.1 Lane Starvation Under Heavy Load

If DDG has a 1500ms delay and 10 requests are queued, the last waits ~15s. Mitigations are consumer-specific (round-robin, per-request timeouts). The queue itself does not enforce fairness across lanes.

### 6.2 Plugin Unload

If the plugin unloads while tasks are enqueued, pending promises never resolve. Same behavior as any async work interrupted by plugin unload. No special cleanup needed in `TaskLaneQueue` itself — consumers (e.g., `ChatOrchestrator.destroy()`) handle graceful shutdown of their own sessions.

### 6.3 First-Writer-Wins Edge Case

If two callers race to create the same lane with different delays, the first one wins. The second caller's `delayMs` is silently ignored. This is acceptable because:
- Built-in consumers always use the same delay for a given lane (DDG is always 1500ms)
- Extension authors are documented to understand this behavior
- The alternative (throwing on mismatch) is too disruptive for a queue primitive

### 6.4 Concurrent Lane Access Correctness

JavaScript's single-threaded event loop guarantees that the queue operations (create lane, enqueue waiter, drain loop) are atomic. No external locking needed.

---

## 7. Files to Create / Modify

| File | Change |
|------|--------|
| `src/queue/task-lane-queue.ts` | **Create** — `TaskLaneQueue` class |
| `src/queue/task-lane-queue.test.ts` | **Create** — Unit tests |
| `src/main.ts` | **Modify** — Add `_taskLaneQueue` field and `getTaskLaneQueue()` public getter |
| `src/extensions/runtime-context.ts` | **Modify** — Add `queue` to `ExtensionUtils` interface and `buildUtils()` |

---

## 8. Verification Plan

### Unit Tests

| Test | What it verifies |
|------|-----------------|
| Two tasks on same lane execute serially | FIFO ordering, no concurrency within a lane |
| Delay enforcement | Completions spaced by at least `delayMs` |
| Different lanes execute concurrently | Cross-lane independence |
| `pending()` returns correct count | Queue depth tracking |
| First-writer-wins | Second `enqueue` with different `delayMs` uses original delay |
| Error in `fn` releases lane | Lane advances even when `fn` throws |
| Error propagation | Thrown error reaches the original caller |
| `removeLane()` clears state | Lane no longer exists after removal |
| Self-cleaning | Idle lane removed from map after last task completes |
| First request fires immediately | No delay before the first task on an idle lane |
| Return value passthrough | `enqueue` returns the value from `fn` |

### Integration Tests (run by consuming specs)

- Web search: 3 DDG-only requests spaced >= 1500ms apart
- MCP: Two panels dispatch tools to same server — calls are serialized
- Extensions: `utils.queue.enqueue("test-lane", fn, 100)` works end-to-end
- Shared lane: Extension and built-in sharing `"duckduckgo"` lane are properly serialized

---

## 9. Future Considerations (Out of Scope)

- **Configurable concurrency per lane** — Allow `concurrency: N` for lanes where parallel requests are safe but a rate cap is still needed. Not needed for initial implementation; serial is the safest default.
- **Circuit breaker** — Temporarily deprioritize a lane after repeated failures. Consumer-level concern, not queue-level.
- **Queue depth limits** — Reject new tasks when a lane exceeds N pending. Could prevent starvation but adds complexity.
- **Per-provider usage statistics** — Request counts, error rates. Useful for settings UI. Deferred to follow-up.
