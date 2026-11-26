import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import { liveConversationIds, subAgentParentId, sweepHistoryOrphans, ORPHAN_MIN_AGE_MS } from "./history-orphans";

const H = ".obsidian/plugins/notor/history";
const C = ".obsidian/plugins/notor/checkpoints";
const NOW = 10 * ORPHAN_MIN_AGE_MS;
const OLD = NOW - 2 * ORPHAN_MIN_AGE_MS;
const FRESH = NOW - 1000;

function fakeAdapter(files: Record<string, number>, folders: Record<string, number>) {
	const removed: string[] = [];
	const adapter = {
		exists: async (p: string) => p === H || p === C || p in files || p in folders,
		list: async (dir: string) => ({
			files: Object.keys(files).filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes("/")),
			folders: Object.keys(folders).filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes("/")),
		}),
		stat: async (p: string) => (p in files ? { mtime: files[p] } : p in folders ? { mtime: folders[p] } : null),
		remove: async (p: string) => { removed.push(p); },
		rmdir: async (p: string) => { removed.push(`${p}/`); },
	};
	return { adapter: adapter as unknown as DataAdapter, removed };
}

describe("history orphan helpers", () => {
	it("collects regular and circuit-step conversation IDs, ignoring sub-agent files and sidecars", () => {
		const ids = liveConversationIds([
			"20260701_000000_conv-a.jsonl",
			"orchestration_step_step-b.jsonl",
			"20260701_000000_conv-a_subagent_inv.jsonl",
			"conv-a.plan.json",
		]);
		expect([...ids].sort()).toEqual(["conv-a", "step-b"]);
	});

	it("reads the parent ID from a sub-agent file name", () => {
		expect(subAgentParentId("20260701_000000_conv-a_subagent_inv-1.jsonl")).toBe("conv-a");
		expect(subAgentParentId("20260701_000000_conv-a.jsonl")).toBeNull();
	});
});

describe("sweepHistoryOrphans", () => {
	it("removes old leftovers of missing conversations only", async () => {
		const { adapter, removed } = fakeAdapter(
			{
				[`${H}/20260701_000000_live.jsonl`]: OLD,
				[`${H}/orchestration_step_step-1.jsonl`]: OLD,
				[`${H}/20260701_000000_live_subagent_a.jsonl`]: OLD, // parent exists
				[`${H}/20260701_000000_step-1_subagent_b.jsonl`]: OLD, // parent is a step conversation
				[`${H}/20260601_000000_gone_subagent_c.jsonl`]: OLD, // orphan
				[`${H}/20260601_000000_gone_subagent_d.jsonl`]: FRESH, // orphan, too recent
				[`${H}/live.plan.json`]: OLD,
				[`${H}/gone.plan.json`]: OLD, // orphan
				[`${H}/gone.webview.json`]: OLD, // orphan
			},
			{
				[`${C}/live`]: OLD,
				[`${C}/step-1`]: OLD,
				[`${C}/gone`]: OLD, // orphan
				[`${C}/gone-recent`]: FRESH, // orphan, too recent
			},
		);
		const result = await sweepHistoryOrphans({ adapter, historyPath: `${H}/`, checkpointPath: `${C}/`, now: NOW });
		expect(removed.sort()).toEqual([
			`${C}/gone/`,
			`${H}/20260601_000000_gone_subagent_c.jsonl`,
			`${H}/gone.plan.json`,
			`${H}/gone.webview.json`,
		]);
		expect(result).toEqual({ subAgentFiles: 1, sidecars: 2, checkpointFolders: 1 });
	});

	it("does nothing when the history folder does not exist", async () => {
		const { adapter, removed } = fakeAdapter({}, {});
		(adapter as unknown as { exists: () => Promise<boolean> }).exists = async () => false;
		await sweepHistoryOrphans({ adapter, historyPath: `${H}/`, checkpointPath: `${C}/`, now: NOW });
		expect(removed).toEqual([]);
	});
});
