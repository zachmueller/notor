import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskLaneQueue } from "../task-lane-queue";

describe("TaskLaneQueue", () => {
	let q: TaskLaneQueue;

	beforeEach(() => {
		vi.clearAllMocks();
		q = new TaskLaneQueue();
	});

	// ── Serial execution ────────────────────────────────────────────

	describe("serial execution", () => {
		it("two tasks on same lane execute serially", async () => {
			let running = false;
			let overlapDetected = false;

			const run = async () => {
				if (running) overlapDetected = true;
				running = true;
				await new Promise((r) => setTimeout(r, 10));
				running = false;
			};

			await Promise.all([
				q.enqueue("lane", run),
				q.enqueue("lane", run),
			]);

			expect(overlapDetected).toBe(false);
		});

		it("tasks complete in FIFO order", async () => {
			const order: number[] = [];
			let resolver: (() => void) | undefined;

			// First task blocks until manually resolved
			const p1 = q.enqueue(
				"lane",
				() =>
					new Promise<void>((r) => {
						resolver = r;
					}),
			);

			const p2 = q.enqueue("lane", async () => {
				order.push(2);
			});
			const p3 = q.enqueue("lane", async () => {
				order.push(3);
			});

			// p2 and p3 should be waiting
			await Promise.resolve();
			expect(order).toEqual([]);

			// Release p1
			resolver!();
			await Promise.all([p1, p2, p3]);

			expect(order).toEqual([2, 3]);
		});
	});

	// ── Per-task delay enforcement ──────────────────────────────────

	describe("per-task delay enforcement", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("task waits at least delayMs after previous completion", async () => {
			const order: number[] = [];

			const p1 = q.enqueue("lane", async () => {
				order.push(1);
			});
			const p2 = q.enqueue(
				"lane",
				async () => {
					order.push(2);
				},
				100,
			);

			// Flush microtasks — task 1 completes, drain sets setTimeout(100)
			await vi.advanceTimersByTimeAsync(0);
			expect(order).toEqual([1]);

			// 99ms is not enough
			await vi.advanceTimersByTimeAsync(99);
			expect(order).toEqual([1]);

			// 1 more ms — task 2 fires
			await vi.advanceTimersByTimeAsync(1);
			expect(order).toEqual([1, 2]);

			await p1;
			await p2;
		});

		it("two tasks with different delayMs get correct per-task spacing", async () => {
			const order: number[] = [];

			const p1 = q.enqueue("lane", async () => {
				order.push(1);
			});
			const p2 = q.enqueue(
				"lane",
				async () => {
					order.push(2);
				},
				50,
			);
			const p3 = q.enqueue(
				"lane",
				async () => {
					order.push(3);
				},
				200,
			);

			// task 1 completes
			await vi.advanceTimersByTimeAsync(0);
			expect(order).toEqual([1]);

			// task 2 fires after 50ms
			await vi.advanceTimersByTimeAsync(50);
			expect(order).toEqual([1, 2]);

			// task 3 has its own 200ms delay from task 2's completion
			await vi.advanceTimersByTimeAsync(199);
			expect(order).toEqual([1, 2]);

			await vi.advanceTimersByTimeAsync(1);
			expect(order).toEqual([1, 2, 3]);

			await p1;
			await p2;
			await p3;
		});

		it("delayMs=0 fires immediately after previous completion", async () => {
			const order: number[] = [];

			const p1 = q.enqueue("lane", async () => {
				order.push(1);
			});
			const p2 = q.enqueue(
				"lane",
				async () => {
					order.push(2);
				},
				0,
			);

			// Both should complete after microtask flush (no setTimeout needed)
			await vi.advanceTimersByTimeAsync(0);
			expect(order).toEqual([1, 2]);

			await p1;
			await p2;
		});
	});

	// ── First request on idle lane ──────────────────────────────────

	describe("first request on idle lane", () => {
		it("fires immediately regardless of delayMs value", async () => {
			let ran = false;
			await q.enqueue(
				"lane",
				async () => {
					ran = true;
				},
				5000,
			);
			expect(ran).toBe(true);
		});
	});

	// ── Cross-lane concurrency ──────────────────────────────────────

	describe("cross-lane concurrency", () => {
		it("tasks on different lanes execute concurrently", async () => {
			let aRunning = false;
			let bRunning = false;
			let bothRanConcurrently = false;

			const resolvers: { a?: () => void; b?: () => void } = {};

			const pA = q.enqueue(
				"a",
				() =>
					new Promise<void>((r) => {
						aRunning = true;
						resolvers.a = r;
						if (bRunning) bothRanConcurrently = true;
					}),
			);

			const pB = q.enqueue(
				"b",
				() =>
					new Promise<void>((r) => {
						bRunning = true;
						resolvers.b = r;
						if (aRunning) bothRanConcurrently = true;
					}),
			);

			expect(aRunning).toBe(true);
			expect(bRunning).toBe(true);
			expect(bothRanConcurrently).toBe(true);

			resolvers.a!();
			resolvers.b!();
			await pA;
			await pB;
		});
	});

	// ── pending() ───────────────────────────────────────────────────

	describe("pending()", () => {
		it("returns correct count of waiting tasks", async () => {
			let resolver: () => void;
			const p1 = q.enqueue(
				"lane",
				() =>
					new Promise<void>((r) => {
						resolver = r;
					}),
			);

			const p2 = q.enqueue("lane", async () => {});
			const p3 = q.enqueue("lane", async () => {});

			expect(q.pending("lane")).toBe(2);

			resolver!();
			await Promise.all([p1, p2, p3]);
		});

		it("returns 0 for non-existent lanes", () => {
			expect(q.pending("no-such-lane")).toBe(0);
		});
	});

	// ── Error handling ──────────────────────────────────────────────

	describe("error handling", () => {
		it("fn error propagates to the caller via rejected Promise", async () => {
			const p = q.enqueue("lane", async () => {
				throw new Error("boom");
			});

			await expect(p).rejects.toThrow("boom");
		});

		it("lane advances after a throwing task", async () => {
			let secondRan = false;

			const p1 = q.enqueue("lane", async () => {
				throw new Error("boom");
			});

			const p2 = q.enqueue("lane", async () => {
				secondRan = true;
			});

			await expect(p1).rejects.toThrow("boom");
			await p2;

			expect(secondRan).toBe(true);
		});
	});

	// ── Return value passthrough ────────────────────────────────────

	describe("return value passthrough", () => {
		it("enqueue resolves with the value returned by fn", async () => {
			const result = await q.enqueue("lane", async () => 42);
			expect(result).toBe(42);
		});
	});

	// ── removeLane() ────────────────────────────────────────────────

	describe("removeLane()", () => {
		it("after removeLane(key), the lane no longer exists", async () => {
			// Complete a task to set lastCompletionTime on the lane
			await q.enqueue("lane", async () => {});

			q.removeLane("lane");

			// A fresh lane has lastCompletionTime=0, so Date.now()-0 exceeds
			// any reasonable delayMs → fires immediately. This proves the
			// old lane (with its recent lastCompletionTime) was removed.
			let ran = false;
			await q.enqueue(
				"lane",
				async () => {
					ran = true;
				},
				5000,
			);
			expect(ran).toBe(true);
		});

		it("is a no-op for non-existent lanes", () => {
			q.removeLane("no-such-lane"); // should not throw
		});
	});

	// ── Lane persistence ────────────────────────────────────────────

	describe("lane persistence", () => {
		it("lane persists after all tasks drain (no self-cleaning)", async () => {
			vi.useFakeTimers({ now: 1000 });

			// Complete a task — sets lastCompletionTime to 1000
			await q.enqueue("lane", async () => {});

			// If the lane persisted, lastCompletionTime=1000 and
			// Date.now()-1000=0 < 100 → must wait (delay enforced).
			// If cleaned up, a fresh lane would have lastCompletionTime=0
			// and Date.now()-0=1000 >= 100 → would fire immediately.
			let ran = false;
			const p = q.enqueue(
				"lane",
				async () => {
					ran = true;
				},
				100,
			);

			await vi.advanceTimersByTimeAsync(0);
			expect(ran).toBe(false); // Proves lane persisted

			await vi.advanceTimersByTimeAsync(100);
			expect(ran).toBe(true);

			await p;
			vi.useRealTimers();
		});
	});

	// ── destroy() ───────────────────────────────────────────────────

	describe("destroy()", () => {
		it("rejects all pending waiters with destroy error", async () => {
			let resolver: () => void;
			const p1 = q.enqueue(
				"lane",
				() =>
					new Promise<void>((r) => {
						resolver = r;
					}),
			);

			const p2 = q.enqueue("lane", async () => {});
			const p3 = q.enqueue("lane", async () => {});

			q.destroy();

			await expect(p2).rejects.toThrow("TaskLaneQueue destroyed");
			await expect(p3).rejects.toThrow("TaskLaneQueue destroyed");

			// Release in-flight task so test doesn't hang
			resolver!();
			await p1;
		});

		it("new enqueue() calls after destroy() throw immediately", async () => {
			q.destroy();

			await expect(
				q.enqueue("lane", async () => {}),
			).rejects.toThrow("TaskLaneQueue destroyed");
		});

		it("in-flight task continues to completion (not interrupted)", async () => {
			let resolver: () => void;

			const p = q.enqueue(
				"lane",
				() =>
					new Promise<string>((r) => {
						resolver = () => r("done");
					}),
			);

			q.destroy();

			// Resolve the in-flight task — should complete normally
			resolver!();
			const result = await p;

			expect(result).toBe("done");
		});
	});
});
