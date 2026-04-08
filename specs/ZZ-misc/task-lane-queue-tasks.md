# TaskLaneQueue: Implementation Tasks

**Spec:** [task-lane-queue-design.md](./task-lane-queue-design.md)
**Status:** Phase 1 complete
**Date:** 2026-04-09

---

## Phase 1: Core Class Implementation

Create `src/queue/task-lane-queue.ts` — the `TaskLaneQueue` class and internal `Lane` type.

- [x] **1.1 Create directory and file**
  - Create `src/queue/` directory
  - Create `src/queue/task-lane-queue.ts`
  - Export `TaskLaneQueue` class

- [x] **1.2 Define internal `Lane` interface**
  - `lastCompletionTime: number` — timestamp of last completed task (init `0`)
  - `waitQueue: Array<{ resolve: () => void; delayMs: number }>` — FIFO pending tasks
  - `draining: boolean` — whether a drain loop is active

- [x] **1.3 Implement `enqueue<T>(laneKey, fn, delayMs?)`**
  - Create lane on first access (`lastCompletionTime = 0`, empty queue, `draining = false`)
  - If lane is idle and `Date.now() - lastCompletionTime >= delayMs`: execute `fn` immediately
  - Otherwise: push to `waitQueue` with the caller's `delayMs`, return a Promise that resolves when the task completes
  - After `fn` completes (success or throw): update `lastCompletionTime`, schedule next waiter using *that waiter's* `delayMs`
  - Return `fn`'s return value; if `fn` throws, propagate error to caller and still release the lane
  - Guard against calling after `destroy()` — throw `Error("TaskLaneQueue destroyed")` immediately

- [x] **1.4 Implement drain loop**
  - When a task completes and `waitQueue` is non-empty, compute remaining delay for the *next waiter* (`waiter.delayMs - (Date.now() - lastCompletionTime)`)
  - If remaining delay > 0: `setTimeout` for the remainder, then resolve the waiter
  - If remaining delay <= 0: resolve immediately (microtask)
  - Set `draining = false` when `waitQueue` is empty after the last task completes

- [x] **1.5 Implement `pending(laneKey)`**
  - Return `lane.waitQueue.length` for existing lanes
  - Return `0` for non-existent lane keys

- [x] **1.6 Implement `removeLane(laneKey)`**
  - Delete the lane from the `Map`
  - No-op if the lane doesn't exist
  - Note: this is internal-only, not exposed to extensions

- [x] **1.7 Implement `destroy()`**
  - Set `destroyed` flag (checked by `enqueue`)
  - Iterate all lanes: reject every waiter in every `waitQueue` with `Error("TaskLaneQueue destroyed")`
  - Clear the lane `Map`
  - In-flight tasks (actively executing `fn`) are NOT interrupted — they complete or fail naturally

---

## Phase 2: Unit Tests

Create `src/queue/__tests__/task-lane-queue.test.ts` using Vitest. Follow existing test conventions: `describe`/`it` blocks, `vi.fn()` mocks, `beforeEach` with `vi.clearAllMocks()`.

- [ ] **2.1 Create test file scaffold**
  - Create `src/queue/__tests__/` directory
  - Create `src/queue/__tests__/task-lane-queue.test.ts`
  - Import `TaskLaneQueue`, set up fresh instance in `beforeEach`

- [ ] **2.2 Serial execution tests**
  - Two tasks on same lane execute serially (second waits for first to complete)
  - FIFO ordering — tasks complete in enqueue order

- [ ] **2.3 Per-task delay enforcement tests**
  - Task with `delayMs=100` waits at least 100ms after previous task's completion
  - Two tasks with different `delayMs` on same lane get correct per-task spacing
  - Task with `delayMs=0` fires immediately after previous completion (no artificial delay)

- [ ] **2.4 First-request-on-idle-lane test**
  - First `enqueue` on a new lane fires immediately regardless of `delayMs` value (lane's `lastCompletionTime` is `0`, so `Date.now() - 0` always exceeds any reasonable delay)

- [ ] **2.5 Cross-lane concurrency test**
  - Tasks on different lane keys execute concurrently (not serialized across lanes)

- [ ] **2.6 `pending()` tests**
  - Returns correct count of waiting tasks
  - Returns `0` for non-existent lanes

- [ ] **2.7 Error handling tests**
  - If `fn` throws, the error propagates to the caller via rejected Promise
  - Lane still advances after a throwing task (next waiter proceeds)

- [ ] **2.8 Return value passthrough test**
  - `enqueue` resolves with the value returned by `fn`

- [ ] **2.9 `removeLane()` test**
  - After `removeLane(key)`, the lane no longer exists in the queue

- [ ] **2.10 Lane persistence test**
  - After all tasks drain, the lane object remains in the Map (no self-cleaning)

- [ ] **2.11 `destroy()` tests**
  - All pending waiters receive rejection with `Error("TaskLaneQueue destroyed")`
  - New `enqueue()` calls after `destroy()` throw immediately
  - In-flight task continues to completion (not interrupted)

- [ ] **2.12 Run tests and confirm all pass**
  - `npm run test -- src/queue`

---

## Phase 3: Plugin Wiring

Wire `TaskLaneQueue` as a plugin-level singleton in `src/main.ts`, following the existing lazy-init getter pattern (see `_mcpHub`, `_orchestrator`, etc. around lines 120–149).

- [ ] **3.1 Add import**
  - Add `import { TaskLaneQueue } from "./queue/task-lane-queue"` to the import block in `main.ts` (near line 96, after MCP imports)

- [ ] **3.2 Add private field**
  - Add `private _taskLaneQueue?: TaskLaneQueue;` to the lazy-init field block (around line 149, after `_mcpHub`)

- [ ] **3.3 Add public getter**
  - Add `getTaskLaneQueue(): TaskLaneQueue` method to the getter section (after line ~1143)
  - Lazy-initialize: `if (!this._taskLaneQueue) { this._taskLaneQueue = new TaskLaneQueue(); }`
  - Return `this._taskLaneQueue`

- [ ] **3.4 Add `destroy()` call to `onunload()`**
  - Add `this._taskLaneQueue?.destroy();` to `onunload()` (around line 529, before extension manager destroy)
  - Add corresponding log statement: `log.info("TaskLaneQueue destroyed");`

---

## Phase 4: Extension Exposure

Expose `enqueue` and `pending` to user extensions via `utils.queue` in `src/extensions/runtime-context.ts`. Do NOT expose `removeLane()` or `destroy()`.

- [ ] **4.1 Extend `ExtensionUtils` interface**
  - Add `queue` property to the `ExtensionUtils` interface (after line 103, before `abortSignal`):
    ```typescript
    queue: {
      enqueue: <T>(lane: string, fn: () => Promise<T>, delayMs?: number) => Promise<T>;
      pending: (lane: string) => number;
    };
    ```

- [ ] **4.2 Wire in `buildUtils()`**
  - In the `buildUtils()` function (around line 112–192), add `queue` to the returned object:
    ```typescript
    const tlq = plugin.getTaskLaneQueue();
    // ...in returned object:
    queue: {
      enqueue: (lane, fn, delayMs) => tlq.enqueue(lane, fn, delayMs),
      pending: (lane) => tlq.pending(lane),
    },
    ```
  - Wrap through thin delegates (not exposing the `TaskLaneQueue` instance directly) to prevent extensions from accessing `removeLane()` or `destroy()`

- [ ] **4.3 Verify extension scaffold compatibility**
  - Confirm that the `utils` parameter destructuring in `compiler.ts` and `manager.ts` (`UserToolAdapter.execute()`) will pass the new `queue` property through without changes
  - No changes needed in these files — `buildUtils()` returns the full object and it's spread into the compiled function's `utils` parameter

---

## Phase 5: Verification

- [ ] **5.1 Run full unit test suite**
  - `npm run test` — confirm no regressions

- [ ] **5.2 Smoke test in Obsidian** (manual)
  - Build plugin (`npm run build`)
  - Load in Obsidian dev vault
  - Confirm plugin loads without errors in console
  - Confirm `getTaskLaneQueue()` is accessible (debug breakpoint or console log)

- [ ] **5.3 Commit**
  - Commit all new and modified files with descriptive message
