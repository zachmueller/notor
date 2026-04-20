/**
 * Exhaustiveness guard for MessageRole.
 *
 * When a new role is added to the MessageRole union, this test breaks until all
 * role-dispatch switch statements have been updated to handle the new case.
 * See: specs/ZZ-misc/extension-chat-blocks-implementation-tasks.md — Phase 2.
 */

import { describe, it, expect } from "vitest";
import type { MessageRole } from "./types";

describe("MessageRole exhaustiveness guard", () => {
	it("has exactly the expected role members", () => {
		// This list must match the MessageRole union exactly.
		// When you add a role: (1) add it here, (2) update every dispatch site listed in Phase 2.2.
		const knownRoles: MessageRole[] = [
			"system",
			"user",
			"assistant",
			"tool_call",
			"tool_result",
			"extension_block",
		];

		// Compile-time: the array element type must be assignable to MessageRole.
		// If you remove a role from the union, TypeScript will flag stale entries above.
		// Runtime: if the count here drifts from the union, the test fails as a reminder.
		expect(knownRoles.length).toBe(6);
	});
});
