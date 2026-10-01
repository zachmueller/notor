import { describe, it, expect } from "vitest";
import { parseClaudeModelId, pickNearestClaudeEntry, type ClaudeCandidate } from "./model-family";

describe("parseClaudeModelId", () => {
	it("parses Bedrock inference profiles with any geo prefix", () => {
		expect(parseClaudeModelId("us.anthropic.claude-opus-5-5")).toEqual({
			family: "opus", version: [5, 5], shape: "bedrock", geo: "us",
		});
		expect(parseClaudeModelId("global.anthropic.claude-sonnet-5")).toEqual({
			family: "sonnet", version: [5, 0], shape: "bedrock", geo: "global",
		});
		expect(parseClaudeModelId("jp.anthropic.claude-opus-5-5")?.geo).toBe("jp");
	});

	it("parses bare Bedrock foundation IDs with a version suffix", () => {
		expect(parseClaudeModelId("anthropic.claude-opus-5-5-v1:0")).toEqual({
			family: "opus", version: [5, 5], shape: "bedrock", geo: null,
		});
		expect(parseClaudeModelId("us.anthropic.claude-opus-4-6-v1")?.version).toEqual([4, 6]);
	});

	it("parses direct API IDs, stripping dates before reading the version", () => {
		expect(parseClaudeModelId("claude-opus-5-5")).toEqual({
			family: "opus", version: [5, 5], shape: "direct", geo: null,
		});
		expect(parseClaudeModelId("claude-sonnet-4-20250514")?.version).toEqual([4, 0]);
		expect(parseClaudeModelId("us.anthropic.claude-opus-4-5-20251101-v1:0")?.version).toEqual([4, 5]);
		expect(parseClaudeModelId("claude-opus-4-5@20251101")?.version).toEqual([4, 5]);
		expect(parseClaudeModelId("claude-sonnet-4-5-latest")?.version).toEqual([4, 5]);
	});

	it("parses legacy claude-3 naming", () => {
		expect(parseClaudeModelId("claude-3-7-sonnet-20250219")).toEqual({
			family: "sonnet", version: [3, 7], shape: "direct", geo: null,
		});
		expect(parseClaudeModelId("claude-3-opus-20240229")?.version).toEqual([3, 0]);
	});

	it("returns null for anything that is not a Claude model ID", () => {
		for (const id of ["gpt-4o", "us.amazon.nova-pro-v1:0", "llama3:8b", "claude", "claude-opus", "claude-opus-5-5-preview", ""]) {
			expect(parseClaudeModelId(id)).toBeNull();
		}
	});
});

function candidates(ids: string[]): Array<ClaudeCandidate<string>> {
	return ids.map((id) => ({ id, parsed: parseClaudeModelId(id)!, value: id }));
}

describe("pickNearestClaudeEntry", () => {
	const table = candidates([
		"us.anthropic.claude-opus-4-8",
		"eu.anthropic.claude-opus-4-8",
		"us.anthropic.claude-opus-5",
		"global.anthropic.claude-opus-5",
		"us.anthropic.claude-haiku-4-5-20251001-v1:0",
		"us.anthropic.claude-fable-5",
		"claude-opus-5",
	]);

	it("picks the highest known version at or below the target", () => {
		const pick = pickNearestClaudeEntry(parseClaudeModelId("us.anthropic.claude-opus-4-9")!, table);
		expect(pick?.id).toBe("us.anthropic.claude-opus-4-8");
		expect(pick?.newerThanAll).toBe(false);
	});

	it("flags a target newer than every sibling", () => {
		const pick = pickNearestClaudeEntry(parseClaudeModelId("us.anthropic.claude-opus-5-5")!, table);
		expect(pick?.id).toBe("us.anthropic.claude-opus-5");
		expect(pick?.newerThanAll).toBe(true);
	});

	it("falls back to the lowest version above the target", () => {
		const pick = pickNearestClaudeEntry(parseClaudeModelId("us.anthropic.claude-opus-4-1")!, table);
		expect(pick?.id).toBe("us.anthropic.claude-opus-4-8");
	});

	it("prefers version over geo, then same geo, then global", () => {
		// eu.…opus-5-5: version 5 beats the eu-prefixed 4.8; among 5.0 entries global wins.
		expect(pickNearestClaudeEntry(parseClaudeModelId("eu.anthropic.claude-opus-5-5")!, table)?.id)
			.toBe("global.anthropic.claude-opus-5");
		expect(pickNearestClaudeEntry(parseClaudeModelId("eu.anthropic.claude-opus-4-8")!, table)?.id)
			.toBe("eu.anthropic.claude-opus-4-8");
	});

	it("never crosses family or ID shape", () => {
		expect(pickNearestClaudeEntry(parseClaudeModelId("claude-opus-5-5")!, table)?.id).toBe("claude-opus-5");
		expect(pickNearestClaudeEntry(parseClaudeModelId("claude-sonnet-5-5")!, table)).toBeNull();
		expect(pickNearestClaudeEntry(parseClaudeModelId("us.anthropic.claude-haiku-5")!, table)?.id)
			.toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
	});

	it("matches mythos against the fable lineage", () => {
		const pick = pickNearestClaudeEntry(parseClaudeModelId("us.anthropic.claude-mythos-5-1")!, table);
		expect(pick?.id).toBe("us.anthropic.claude-fable-5");
		expect(pick?.newerThanAll).toBe(true);
	});
});
