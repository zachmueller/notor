import { describe, it, expect } from "vitest";
import { sanitizeToolCallId } from "./tool-call-id";

const VALID = /^[a-zA-Z0-9_-]{1,64}$/;

describe("sanitizeToolCallId", () => {
	it("leaves Anthropic/Bedrock-native ids unchanged", () => {
		expect(sanitizeToolCallId("toolu_01AbC-xyz")).toBe("toolu_01AbC-xyz");
		expect(sanitizeToolCallId("tooluse_abc123")).toBe("tooluse_abc123");
	});

	it("rewrites ids with foreign characters into a valid id", () => {
		const out = sanitizeToolCallId("call:abc.123/def");
		expect(out).toMatch(VALID);
		expect(out.startsWith("call_abc_123_def_")).toBe(true);
	});

	it("caps over-long ids at 64 chars", () => {
		const out = sanitizeToolCallId("x".repeat(100));
		expect(out).toMatch(VALID);
		expect(out).toHaveLength(64);
	});

	it("handles an empty id", () => {
		expect(sanitizeToolCallId("")).toMatch(VALID);
	});

	it("is deterministic and keeps distinct ids distinct", () => {
		expect(sanitizeToolCallId("call.1")).toBe(sanitizeToolCallId("call.1"));
		// Same sanitized base, different originals → different results.
		expect(sanitizeToolCallId("call.1")).not.toBe(sanitizeToolCallId("call:1"));
	});
});
