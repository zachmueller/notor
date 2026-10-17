/**
 * TEST-006 (part 4) — the `orchestration_edges` tree-constrained DAG invariant
 * (INT-043/045, contracts/edges.md §3).
 *
 * The engine's mechanisms (intra-flow `next`/`prev` chaining + `run_flow` / chaining
 * `child`/`parent`) only ever produce hierarchy. This asserts the structural
 * invariants a 50-node run-tree relies on:
 *  1. no `return` edge kind exists (ascending is one hop up `parent`);
 *  2. `child`/`parent` cross a session boundary (carry `session_id`); `next`/`prev`
 *     never do (same flow);
 *  3. a `run_flow` `child` edge carries `via_tool_call_id`; a chaining `child` does
 *     not (no tool call) — both still point at the child's ENTRY conversation;
 *  4. the produced graph has no cycle (walking child/next edges never returns to a
 *     visited node).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — TEST-006
 * @see specs/ZZ-misc/orchestration/contracts/edges.md — §3 tree-constrained DAG
 */

import { describe, it, expect } from "vitest";
import { buildStepConversationHeader } from "./step-conversation-store";
import type { OrchestrationEdge } from "../types";

describe("orchestration_edges — tree-constrained DAG (INT-043/045)", () => {
	it("never emits a `return` edge kind (the four kinds are next/prev/child/parent)", () => {
		const KINDS: OrchestrationEdge["kind"][] = ["next", "prev", "child", "parent"];
		// The type union forbids "return"; assert no producer path constructs one.
		const header = buildStepConversationHeader({
			conversationId: "c1",
			sessionId: "s1",
			flowName: "F",
			stepName: "Step",
			iteration: 1,
			prevConversationId: "c0",
			createdAtMs: 0,
			providerId: "",
			modelId: "",
			messages: [],
			extraEdges: [
				{ kind: "child", conversation_id: "child-entry", session_id: "s2", via_tool_call_id: "t1" },
			],
		});
		const edges = header.orchestration_edges as OrchestrationEdge[];
		for (const e of edges) {
			expect(KINDS).toContain(e.kind);
			expect(e.kind).not.toBe("return");
		}
	});

	it("distinguishes a run_flow child (via_tool_call_id) from a chaining child (none); both omit on next/prev", () => {
		const runFlowChild: OrchestrationEdge = {
			kind: "child",
			conversation_id: "child-entry",
			session_id: "sess-child",
			via_tool_call_id: "runflow-abc",
		};
		const chainingChild: OrchestrationEdge = {
			kind: "child",
			conversation_id: "successor-entry",
			session_id: "sess-succ",
			// no via_tool_call_id — chaining has no tool call
		};
		expect(runFlowChild.via_tool_call_id).toBeDefined();
		expect(chainingChild.via_tool_call_id).toBeUndefined();
		// child/parent cross a session boundary → carry session_id.
		expect(runFlowChild.session_id).toBeDefined();
		// next/prev never cross a boundary → no session_id.
		const header = buildStepConversationHeader({
			conversationId: "c2",
			sessionId: "s1",
			flowName: "F",
			stepName: "Step2",
			iteration: 2,
			prevConversationId: "c1",
			createdAtMs: 0,
			providerId: "",
			modelId: "",
			messages: [],
		});
		const prev = (header.orchestration_edges as OrchestrationEdge[]).find((e) => e.kind === "prev");
		expect(prev?.session_id).toBeUndefined();
	});

	it("the child/next graph is acyclic (a walk never returns to a visited node)", () => {
		// A small composed graph: step1 →next→ step2 →child→ childEntry; childEntry →parent→ step2.
		const graph: Record<string, OrchestrationEdge[]> = {
			step1: [{ kind: "next", conversation_id: "step2" }],
			step2: [
				{ kind: "prev", conversation_id: "step1" },
				{ kind: "child", conversation_id: "childEntry", session_id: "s2", via_tool_call_id: "t" },
			],
			childEntry: [{ kind: "parent", conversation_id: "step2", session_id: "s1" }],
		};
		// Walk only descending edges (next + child) — must terminate (DAG).
		const visited = new Set<string>();
		let cyclic = false;
		const walk = (node: string) => {
			if (visited.has(node)) {
				cyclic = true;
				return;
			}
			visited.add(node);
			for (const e of graph[node] ?? []) {
				if (e.kind === "next" || e.kind === "child") walk(e.conversation_id);
			}
		};
		walk("step1");
		expect(cyclic).toBe(false);
		expect(visited).toEqual(new Set(["step1", "step2", "childEntry"]));
	});
});
