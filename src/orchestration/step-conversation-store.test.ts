/**
 * INT-006 — step-conversation persistence + `orchestration_edges` backfill.
 *
 * Each step conversation header carries the orchestration metadata + a typed
 * edge list; consecutive turns are chained by reciprocal `prev`/`next` edges; the
 * `_type` marker hides them from the flat list; no cyclic edges are produced.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-006
 * @see specs/ZZ-misc/orchestration/contracts/edges.md — §1/§2 header + edges
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
	VaultStepConversationStore,
	buildStepConversationHeader,
	type StepConversationFs,
	type StepConversationRecord,
} from "./step-conversation-store";
import { isHiddenFromConversationList } from "../chat/sub-agent-history";
import type { OrchestrationEdge } from "../types";

class FakeFs implements StepConversationFs {
	files = new Map<string, string>();
	dirs = new Set<string>();
	async exists(p: string): Promise<boolean> {
		return this.files.has(p) || this.dirs.has(p);
	}
	async read(p: string): Promise<string> {
		const v = this.files.get(p);
		if (v === undefined) throw new Error(`ENOENT: ${p}`);
		return v;
	}
	async write(p: string, data: string): Promise<void> {
		this.files.set(p, data);
	}
	async mkdir(p: string): Promise<void> {
		this.dirs.add(p);
	}
}

const HISTORY = "notor/conversations";

function rec(over: Partial<StepConversationRecord> = {}): StepConversationRecord {
	return {
		conversationId: "conv-1",
		sessionId: "sess-A",
		flowName: "Code Implementation",
		stepName: "📋 Planner",
		iteration: 1,
		prevConversationId: null,
		createdAtMs: 1719500000000,
		providerId: "bedrock",
		modelId: "claude-opus-4-8",
		messages: [{ role: "user", content: "do it" }],
		...over,
	};
}

function header(fs: FakeFs, conversationId: string): Record<string, unknown> {
	const path = `${HISTORY}/orchestration_step_${conversationId}.jsonl`;
	const content = fs.files.get(path)!;
	return JSON.parse(content.split("\n")[0]!) as Record<string, unknown>;
}

let fs: FakeFs;
let store: VaultStepConversationStore;

beforeEach(() => {
	fs = new FakeFs();
	store = new VaultStepConversationStore(fs, HISTORY);
});

describe("buildStepConversationHeader", () => {
	it("carries the orchestration metadata + the step-conversation _type marker", () => {
		const h = buildStepConversationHeader(rec({ iteration: 3 }));
		expect(h._type).toBe("orchestration_step_conversation");
		expect(h.orchestration_session_id).toBe("sess-A");
		expect(h.orchestration_flow_name).toBe("Code Implementation");
		expect(h.orchestration_step_name).toBe("📋 Planner");
		expect(h.orchestration_iteration).toBe(3);
		expect(h.title).toBe("[Code Implementation] 📋 Planner — iteration 3");
	});

	it("the marker makes the conversation hidden from the flat list (INT-006)", () => {
		const h = buildStepConversationHeader(rec());
		expect(isHiddenFromConversationList("orchestration_step_conv-1.jsonl", h._type as string)).toBe(true);
	});

	it("the first turn has no prev edge", () => {
		const h = buildStepConversationHeader(rec({ prevConversationId: null }));
		expect(h.orchestration_edges).toEqual([]);
	});

	it("a later turn carries a prev edge to its predecessor", () => {
		const h = buildStepConversationHeader(rec({ conversationId: "conv-2", prevConversationId: "conv-1" }));
		expect(h.orchestration_edges).toEqual([{ kind: "prev", conversation_id: "conv-1" }]);
	});
});

describe("VaultStepConversationStore — persist + edge backfill", () => {
	it("persists the header + messages as JSONL", async () => {
		await store.persist(rec());
		const path = `${HISTORY}/orchestration_step_conv-1.jsonl`;
		expect(fs.files.has(path)).toBe(true);
		const lines = fs.files.get(path)!.trim().split("\n");
		expect(JSON.parse(lines[0]!)._type).toBe("orchestration_step_conversation");
		expect(JSON.parse(lines[1]!)).toMatchObject({ _type: "message", role: "user" });
	});

	it("backfills a reciprocal next edge on the predecessor when the next turn links prev", async () => {
		await store.persist(rec({ conversationId: "conv-1", iteration: 1, prevConversationId: null }));
		await store.persist(rec({ conversationId: "conv-2", iteration: 2, prevConversationId: "conv-1" }));

		const edges1 = header(fs, "conv-1").orchestration_edges as OrchestrationEdge[];
		const edges2 = header(fs, "conv-2").orchestration_edges as OrchestrationEdge[];
		expect(edges1).toContainEqual({ kind: "next", conversation_id: "conv-2" });
		expect(edges2).toContainEqual({ kind: "prev", conversation_id: "conv-1" });
	});

	it("chains three turns without producing a cyclic edge (DAG invariant)", async () => {
		await store.persist(rec({ conversationId: "c1", iteration: 1, prevConversationId: null }));
		await store.persist(rec({ conversationId: "c2", iteration: 2, prevConversationId: "c1" }));
		await store.persist(rec({ conversationId: "c3", iteration: 3, prevConversationId: "c2" }));

		const e1 = header(fs, "c1").orchestration_edges as OrchestrationEdge[];
		const e2 = header(fs, "c2").orchestration_edges as OrchestrationEdge[];
		const e3 = header(fs, "c3").orchestration_edges as OrchestrationEdge[];

		// c1 → next c2; c2 → prev c1 + next c3; c3 → prev c2. No edge points backward
		// to form a cycle (no next that points at an earlier node, no prev forward).
		expect(e1).toEqual([{ kind: "next", conversation_id: "c2" }]);
		expect(e2).toContainEqual({ kind: "prev", conversation_id: "c1" });
		expect(e2).toContainEqual({ kind: "next", conversation_id: "c3" });
		expect(e3).toEqual([{ kind: "prev", conversation_id: "c2" }]);

		// Assert acyclicity: following `next` edges strictly increases and terminates.
		const nextOf = (id: string): string | null => {
			const edges = header(fs, id).orchestration_edges as OrchestrationEdge[];
			return edges.find((e) => e.kind === "next")?.conversation_id ?? null;
		};
		const visited = new Set<string>();
		let cur: string | null = "c1";
		while (cur) {
			expect(visited.has(cur)).toBe(false); // no revisit ⇒ no cycle
			visited.add(cur);
			cur = nextOf(cur);
		}
		expect([...visited]).toEqual(["c1", "c2", "c3"]);
	});

	it("next-edge backfill is idempotent (re-persisting does not duplicate)", async () => {
		await store.persist(rec({ conversationId: "c1", iteration: 1, prevConversationId: null }));
		await store.persist(rec({ conversationId: "c2", iteration: 2, prevConversationId: "c1" }));
		// Re-link c2 → c1 again (simulating a re-run): no duplicate next edge.
		await store.persist(rec({ conversationId: "c2", iteration: 2, prevConversationId: "c1" }));
		const edges1 = (header(fs, "c1").orchestration_edges as OrchestrationEdge[]).filter(
			(e) => e.kind === "next",
		);
		expect(edges1).toHaveLength(1);
	});
});
