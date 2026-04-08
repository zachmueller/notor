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

`TaskLaneQueue` provides this as a reusable primitive: per-key FIFO serialization with optional per-task inter-completion delays.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Location | `src/queue/task-lane-queue.ts` | Generic infrastructure, not tied to web search or MCP. |
| Scope | Plugin-level singleton | Must span all conversations, sub-agents, panels, and extensions. Created in `main.ts`, injected into consumers. |
| Concurrency model | Strictly serial per lane | Safest default. One task executes at a time per lane. Cross-lane tasks are fully concurrent. |
| Delay enforcement | Per-task inter-completion gap | Each `enqueue()` call specifies how long to wait after the previous task's completion before *this* task starts. First request on an idle lane fires immediately. |
| Delay ownership | Per-task, caller-controlled | Each caller independently controls their own delay. Different callers on the same lane can use different delays (e.g., a paid-tier extension may use a shorter delay than the built-in tool). No first-writer-wins — the lane does not store a delay. |
| Error handling | Lane advances on throw | If `fn` throws, the error propagates to the caller. The lane releases and the next waiter proceeds. |
| Lane lifecycle | In-memory only, session-persistent | Lanes persist until `destroy()` is called or plugin unloads. No self-cleaning. Idle lanes consume negligible memory (~100 bytes each). Reset on plugin restart. |
| Extension exposure | Via `utils.queue` in extension runtime context | Extensions get `enqueue()` and `pending()`. No `removeLane()` (internal-only). |

---

## 3. API

**File:** `src/queue/task-lane-queue.ts`

```typescript
export class TaskLaneQueue {
  private lanes = new Map<string, Lane>();

  /**
   * Enqueue an async task on the named lane. The task executes when the
   * lane is available (previous task completed + this task's delay elapsed).
   *
   * @param laneKey - Lane identifier (e.g., "duckduckgo", "mcp:obsidian-mcp")
   * @param fn      - Async function to execute when the lane is ready
   * @param delayMs - Minimum ms since the previous task's completion before
   *                  this task starts. Each call controls its own delay.
   *                  Default: 0 (no delay, but still serialized).
   * @returns The return value of `fn`.
   */
  async enqueue<T>(laneKey: string, fn: () => Promise<T>, delayMs?: number): Promise<T>;

  /** Number of tasks waiting in a lane's queue. 0 for non-existent lanes. */
  pending(laneKey: string): number;

  /** Remove a lane (used for cleanup/testing). Not exposed to extensions. */
  removeLane(laneKey: string): void;

  /**
   * Reject all pending waiters, clear all lanes, mark queue as destroyed.
   * New enqueue() calls after destroy() throw immediately.
   * Called from plugin onunload().
   */
  destroy(): void;
}
```

### 3.1 Internal Lane Structure

```typescript
interface Lane {
  /** Timestamp (ms) of the last completed task in this lane. */
  lastCompletionTime: number;
  /** FIFO queue of pending tasks awaiting this lane's delay window. */
  waitQueue: Array<{ resolve: () => void; delayMs: number }>;
  /** Whether a drain loop is currently running for this lane. */
  draining: boolean;
}
```

Note: `delayMs` is stored per-task (on each wait queue entry), not per-lane. Each task independently controls its own pre-start delay.

### 3.2 Execution Flow

1. Caller enters the lane via `enqueue(laneKey, fn, delayMs)`.
2. If the lane doesn't exist, create it with `lastCompletionTime = 0`, empty `waitQueue`, `draining = false`.
3. If `Date.now() - lane.lastCompletionTime >= delayMs` (this task's delay), the task executes immediately.
4. Otherwise, the caller is enqueued in `waitQueue` (with its `delayMs`) and a Promise resolves after the remaining delay.
5. After the task completes (success or failure), `lane.lastCompletionTime` is updated and the next waiter (if any) is scheduled using *that waiter's* `delayMs`.
6. The return value of `fn` is returned to the caller. If `fn` throws, the error propagates to the caller and the lane is still released.

Lanes persist until `destroy()` is called. No self-cleaning.

### 3.3 Cross-Lane Concurrency

Lanes are fully independent. A DDG lane waiting through its 1500ms delay does not block a Tavily lane from firing immediately. This is the key difference from a global semaphore.

---

## 4. Lane Naming Convention

Lane keys are opaque strings. No enforcement in `TaskLaneQueue` itself. Convention by documentation:

| Consumer | Lane key pattern | Examples |
|----------|-----------------|----------|
| Web search providers | `"{provider}"` | `"duckduckgo"`, `"tavily"`, `"brave"`, `"serpapi"` |
| MCP servers | `"mcp:{serverName}"` | `"mcp:obsidian-mcp"`, `"mcp:filesystem"` |
| User extensions | Any string | `"deepl-api"`, `"my-ext:duckduckgo"` |

**Shared lane semantics:** Two callers using the same lane key are serialized together. An extension calling `enqueue("duckduckgo", fn, 1500)` shares the lane with the built-in web search tool's DDG requests. Each caller controls its own delay — the built-in tool passes `1500` to respect DDG's rate limits, while a paid-tier extension might pass `200` for its higher-limit API key. Serialization (one-at-a-time) is guaranteed regardless of delay values.

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

Note: `removeLane()` and `destroy()` are intentionally not exposed to extensions.

`utils.queue` is added to `ExtensionUtils` as part of this spec's implementation. `utils.webSearch` (web search spec) depends on this and lands separately.

### 5.3 Consumers

| Consumer | Injected via | Lane keys | Typical `delayMs` |
|----------|-------------|-----------|-------------------|
| `WebSearchQueue` | Constructor parameter | Provider type strings | 1500ms (DDG), 0ms (API providers) |
| `McpHub` | Constructor parameter (added in thread-safe streaming Phase 4) | `"mcp:{serverName}"` | 0ms (pure serialization) |
| User extensions | `utils.queue` | Free-form | Caller-specified per task |

---

## 6. Edge Cases

### 6.1 Lane Starvation Under Heavy Load

If DDG tasks use a 1500ms delay and 10 requests are queued, the last waits ~15s. Mitigations are consumer-specific (round-robin, per-request timeouts). The queue itself does not enforce fairness across lanes. Idle lanes consume negligible memory (~100 bytes each) and do not contribute to starvation.

### 6.2 Plugin Unload

`TaskLaneQueue.destroy()` is called from `main.ts` `onunload()`. It:
1. Sets a `destroyed` flag — new `enqueue()` calls throw `Error("TaskLaneQueue destroyed")` immediately.
2. Rejects all pending waiters in all lanes with `Error("TaskLaneQueue destroyed")`.
3. Clears the lane map.

Currently in-flight tasks (the `fn` that is actively executing) are not interrupted — they will complete or fail on their own. Only *waiting* tasks (in `waitQueue`) are rejected.

### 6.3 Per-Task Delay Interaction

Two callers on the same lane can use different delays. This is intentional — each caller controls its own rate-limiting posture. A built-in web search task with `delayMs=1500` always gets at least 1500ms since the previous completion. An extension with `delayMs=0` fires immediately after the previous completion, accepting the risk of rate-limiting. The lane provides serialization (one-at-a-time); delay enforcement is each caller's responsibility.

### 6.4 Concurrent Lane Access Correctness

JavaScript's single-threaded event loop guarantees that the queue operations (create lane, enqueue waiter, drain loop) are atomic. No external locking needed.

---

## 7. Files to Create / Modify

| File | Change |
|------|--------|
| `src/queue/task-lane-queue.ts` | **Create** — `TaskLaneQueue` class |
| `src/queue/task-lane-queue.test.ts` | **Create** — Unit tests |
| `src/main.ts` | **Modify** — Add `_taskLaneQueue` field, `getTaskLaneQueue()` public getter, and `this._taskLaneQueue?.destroy()` in `onunload()` |
| `src/extensions/runtime-context.ts` | **Modify** — Add `queue` to `ExtensionUtils` interface and `buildUtils()` |

---

## 8. Verification Plan

### Unit Tests

| Test | What it verifies |
|------|-----------------|
| Two tasks on same lane execute serially | FIFO ordering, no concurrency within a lane |
| Per-task delay enforcement | Two tasks with different `delayMs` on same lane get correct per-task spacing |
| Task with `delayMs=0` fires immediately | No delay after previous completion when caller specifies 0 |
| Different lanes execute concurrently | Cross-lane independence |
| `pending()` returns correct count | Queue depth tracking |
| Error in `fn` releases lane | Lane advances even when `fn` throws |
| Error propagation | Thrown error reaches the original caller |
| `removeLane()` clears state | Lane no longer exists after removal |
| Lanes persist after draining | Idle lane remains in map (no self-cleaning) |
| First request fires immediately | No delay before the first task on an idle lane |
| Return value passthrough | `enqueue` returns the value from `fn` |
| `destroy()` rejects pending waiters | All queued tasks receive rejection error |
| `enqueue()` throws after `destroy()` | New tasks are immediately rejected |

### Integration Tests (run by consuming specs)

- Web search: 3 DDG-only requests with `delayMs=1500` spaced >= 1500ms apart
- MCP: Two panels dispatch tools to same server — calls are serialized (Phase 4)
- Extensions: `utils.queue.enqueue("test-lane", fn, 100)` works end-to-end
- Shared lane: Extension and built-in sharing `"duckduckgo"` lane are properly serialized
- Per-task delay: Two callers on same lane with different delays each get their specified spacing

---

## 9. Future Considerations (Out of Scope)

- **Configurable concurrency per lane** — Allow `concurrency: N` for lanes where parallel requests are safe but a rate cap is still needed. Not needed for initial implementation; serial is the safest default.
- **Circuit breaker** — Temporarily deprioritize a lane after repeated failures. Consumer-level concern, not queue-level.
- **Queue depth limits** — Reject new tasks when a lane exceeds N pending. Could prevent starvation but adds complexity.
- **Per-provider usage statistics** — Request counts, error rates. Useful for settings UI. Deferred to follow-up.
