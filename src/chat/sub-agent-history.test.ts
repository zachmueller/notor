/**
 * INT-006 (Phase-2 gate) — hidden-from-flat-list predicate.
 *
 * `listConversations()` / `searchConversations()` consult
 * `isHiddenFromConversationList` to exclude BOTH sub-agent conversations (legacy
 * filename + `_type`) and orchestration step conversations (header `_type`), via
 * one generalized predicate. The legacy `isSubAgentFilename` path is preserved.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-006 / TEST gate
 * @see specs/ZZ-misc/orchestration/contracts/edges.md — §4 Hidden-From-Flat-List Rule
 */

import { describe, it, expect } from "vitest";
import { isSubAgentFilename, isHiddenFromConversationList } from "./sub-agent-history";

describe("isSubAgentFilename (unchanged, back-compat)", () => {
	it("matches the legacy sub-agent filename convention", () => {
		expect(isSubAgentFilename("2026_subagent_abc.jsonl")).toBe(true);
		expect(isSubAgentFilename("2026_conversation_abc.jsonl")).toBe(false);
	});
});

describe("isHiddenFromConversationList (generalized, INT-006)", () => {
	it("hides legacy sub-agent files by filename even without a header type", () => {
		expect(isHiddenFromConversationList("x_subagent_y.jsonl")).toBe(true);
	});

	it("hides orchestration step conversations by header _type", () => {
		expect(
			isHiddenFromConversationList("orchestration_step_abc.jsonl", "orchestration_step_conversation"),
		).toBe(true);
	});

	it("hides sub-agent conversations by header _type", () => {
		expect(isHiddenFromConversationList("anything.jsonl", "sub_agent_conversation")).toBe(true);
	});

	it("does NOT hide an ordinary conversation", () => {
		expect(isHiddenFromConversationList("2026_conversation_abc.jsonl", "conversation")).toBe(false);
		expect(isHiddenFromConversationList("2026_conversation_abc.jsonl")).toBe(false);
	});
});
