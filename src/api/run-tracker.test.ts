import { describe, it, expect, vi } from "vitest";
import { RunTracker } from "./run-tracker";
import type { NotorRunInfo } from "./types";

const initial = (runId: string): NotorRunInfo => ({ runId, kind: "workflow", name: "wf", status: "running" });

describe("RunTracker", () => {
	it("tracks progress, then the final result", async () => {
		const tracker = new RunTracker();
		let finish!: () => void;
		const handle = tracker.start(initial("r1"), vi.fn(), async (update) => {
			update({ conversationId: "c1" });
			await new Promise<void>((r) => (finish = r));
			return { status: "completed", text: "done" };
		});

		expect(handle.status).toBe("running");
		await Promise.resolve();
		expect(tracker.get("r1")).toMatchObject({ status: "running", conversationId: "c1" });

		finish();
		await expect(handle.done).resolves.toMatchObject({ status: "completed", conversationId: "c1", text: "done" });
		expect(tracker.get("r1")?.status).toBe("completed");
	});

	it("turns a thrown body into a failed result", async () => {
		const tracker = new RunTracker();
		const handle = tracker.start(initial("r2"), vi.fn(), async () => {
			throw new Error("boom");
		});
		await expect(handle.done).resolves.toMatchObject({ status: "failed", error: "boom", errorCode: "run_failed" });
	});

	it("cancels only live runs", async () => {
		const tracker = new RunTracker();
		const cancel = vi.fn();
		const handle = tracker.start(initial("r3"), cancel, () => new Promise(() => {}));
		expect(tracker.cancel("r3")).toBe(true);
		expect(cancel).toHaveBeenCalledOnce();
		expect(tracker.cancel("missing")).toBe(false);
		void handle;
	});

	it("keeps the 50 most recent finished runs", async () => {
		const tracker = new RunTracker();
		const all = Array.from({ length: 55 }, (_, i) =>
			tracker.start(initial(`r${i}`), vi.fn(), async () => ({ status: "completed" })).done,
		);
		await Promise.all(all);
		expect(tracker.get("r0")).toBeUndefined();
		expect(tracker.get("r4")).toBeUndefined();
		expect(tracker.get("r5")?.status).toBe("completed");
		expect(tracker.get("r54")?.status).toBe("completed");
	});
});
