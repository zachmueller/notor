import { describe, it, expect, vi } from "vitest";
import { PlanStore, planSidecarPath } from "./plan-store";
import type { AnchoredComment } from "../comments/types";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const HISTORY = ".obsidian/plugins/notor/history/";

function makeAdapter() {
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	return {
		files,
		dirs,
		exists: vi.fn(async (p: string) => files.has(p) || dirs.has(p)),
		read: vi.fn(async (p: string) => {
			if (!files.has(p)) throw new Error(`ENOENT ${p}`);
			return files.get(p)!;
		}),
		write: vi.fn(async (p: string, data: string) => {
			files.set(p, data);
		}),
		remove: vi.fn(async (p: string) => {
			files.delete(p);
		}),
		mkdir: vi.fn(async (p: string) => {
			dirs.add(p);
		}),
	};
}

const comment: AnchoredComment = {
	id: "c1",
	anchor: { scopeId: "plan", exact: "step", prefix: "", suffix: "", occurrence: 0 },
	quote: "step",
	body: "why?",
	created_at: "2026-10-11T00:00:00.000Z",
};

describe("planSidecarPath", () => {
	it("joins with or without a trailing slash", () => {
		expect(planSidecarPath(HISTORY, "abc")).toBe(".obsidian/plugins/notor/history/abc.plan.json");
		expect(planSidecarPath(".obsidian/plugins/notor/history", "abc")).toBe(".obsidian/plugins/notor/history/abc.plan.json");
	});
});

describe("PlanStore", () => {
	it("submits, persists to the sidecar and reloads", async () => {
		const adapter = makeAdapter();
		const store = new PlanStore(adapter, () => HISTORY);
		const plan = await store.submit("conv1", "My plan", "1. Do it");
		expect(plan.status).toBe("pending-review");
		const raw = JSON.parse(adapter.files.get(`${HISTORY}conv1.plan.json`)!);
		expect(raw).toMatchObject({ conversation_id: "conv1", title: "My plan", markdown: "1. Do it" });

		const fresh = new PlanStore(adapter, () => HISTORY);
		expect(await fresh.load("conv1")).toMatchObject({ title: "My plan", status: "pending-review", comments: [] });
	});

	it("overwrites on re-submission and drops comments when the markdown changed", async () => {
		const store = new PlanStore(makeAdapter(), () => HISTORY);
		await store.submit("conv1", "Plan", "v1");
		await store.updateComments("conv1", [comment]);
		await store.setStatus("conv1", "changes-requested");
		const revised = await store.submit("conv1", "Plan v2", "v2");
		expect(revised).toMatchObject({ title: "Plan v2", markdown: "v2", status: "pending-review", comments: [] });
	});

	it("keeps comments when the identical plan is re-submitted (reload replay)", async () => {
		const store = new PlanStore(makeAdapter(), () => HISTORY);
		await store.submit("conv1", "Plan", "same");
		await store.updateComments("conv1", [comment]);
		const again = await store.submit("conv1", "Plan", "same");
		expect(again.comments).toEqual([comment]);
	});

	it("sets status and emits change events", async () => {
		const store = new PlanStore(makeAdapter(), () => HISTORY);
		const seen: string[] = [];
		const off = store.onChange((id) => seen.push(id));
		await store.submit("conv1", "Plan", "x");
		await store.setStatus("conv1", "approved");
		expect((await store.load("conv1"))?.status).toBe("approved");
		off();
		await store.setStatus("conv1", "rejected");
		expect(seen).toEqual(["conv1", "conv1"]);
	});

	it("returns null for missing or malformed files and deletes cleanly", async () => {
		const adapter = makeAdapter();
		adapter.files.set(`${HISTORY}bad.plan.json`, "{not json");
		const store = new PlanStore(adapter, () => HISTORY);
		expect(await store.load("missing")).toBeNull();
		expect(await store.load("bad")).toBeNull();

		await store.submit("conv1", "Plan", "x");
		await store.delete("conv1");
		expect(adapter.files.has(`${HISTORY}conv1.plan.json`)).toBe(false);
		expect(await store.load("conv1")).toBeNull();
	});

	it("creates the history directory when missing", async () => {
		const adapter = makeAdapter();
		const store = new PlanStore(adapter, () => HISTORY);
		await store.submit("conv1", "Plan", "x");
		expect(adapter.mkdir).toHaveBeenCalledWith(".obsidian/plugins/notor/history");
	});
});
