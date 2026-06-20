import { describe, it, expect } from "vitest";
import { evaluateToolPolicy, ToolPolicyContext } from "./tool-policy";
import type { DispatchableTool } from "./dispatcher";
import type { ResolvedToolConfigEntry } from "../tool-config/types";

function makeCtx(toolEntry: Partial<ResolvedToolConfigEntry> = {}): ToolPolicyContext {
	const entry: ResolvedToolConfigEntry = {
		enabled: true,
		auto_approve: false,
		allowed_paths: [],
		blocked_paths: [],
		allowed_command_patterns: [],
		blocked_command_patterns: [],
		...toolEntry,
	};
	return {
		effectiveConfig: { tools: { execute_command: entry } },
		mode: "act",
		vaultRootPath: "/vault",
	};
}

const EXECUTE_COMMAND_TOOL: DispatchableTool = {
	name: "execute_command",
	mode: "write",
} as any;

describe("evaluateToolPolicy — command pattern auto-approve", () => {
	it("auto_approve false + matching allowed pattern → auto-approved", () => {
		const ctx = makeCtx({
			auto_approve: false,
			allowed_command_patterns: ["git *"],
		});
		const result = evaluateToolPolicy(
			"execute_command",
			{ command: "git status" },
			EXECUTE_COMMAND_TOOL,
			ctx,
		);
		expect(result.allowed).toBe(true);
		expect(result.autoApproved).toBe(true);
	});

	it("auto_approve false + no matching pattern → not auto-approved", () => {
		const ctx = makeCtx({
			auto_approve: false,
			allowed_command_patterns: ["git *"],
		});
		const result = evaluateToolPolicy(
			"execute_command",
			{ command: "rm -rf /" },
			EXECUTE_COMMAND_TOOL,
			ctx,
		);
		expect(result.allowed).toBe(true);
		expect(result.autoApproved).toBe(false);
	});

	it("auto_approve true + matching blocked pattern → NOT auto-approved", () => {
		const ctx = makeCtx({
			auto_approve: true,
			blocked_command_patterns: ["rm *"],
		});
		const result = evaluateToolPolicy(
			"execute_command",
			{ command: "rm -rf /" },
			EXECUTE_COMMAND_TOOL,
			ctx,
		);
		expect(result.allowed).toBe(true);
		expect(result.autoApproved).toBe(false);
	});

	it("auto_approve true + no matching blocked pattern → auto-approved", () => {
		const ctx = makeCtx({
			auto_approve: true,
			blocked_command_patterns: ["rm *"],
		});
		const result = evaluateToolPolicy(
			"execute_command",
			{ command: "git status" },
			EXECUTE_COMMAND_TOOL,
			ctx,
		);
		expect(result.allowed).toBe(true);
		expect(result.autoApproved).toBe(true);
	});

	it("blocked pattern takes precedence over allowed pattern", () => {
		const ctx = makeCtx({
			auto_approve: false,
			allowed_command_patterns: ["*"],
			blocked_command_patterns: ["rm *"],
		});
		const result = evaluateToolPolicy(
			"execute_command",
			{ command: "rm -rf /" },
			EXECUTE_COMMAND_TOOL,
			ctx,
		);
		expect(result.allowed).toBe(true);
		expect(result.autoApproved).toBe(false);
	});

	it("no patterns configured → falls through to base auto_approve", () => {
		const ctx = makeCtx({ auto_approve: false });
		const result = evaluateToolPolicy(
			"execute_command",
			{ command: "git status" },
			EXECUTE_COMMAND_TOOL,
			ctx,
		);
		expect(result.allowed).toBe(true);
		expect(result.autoApproved).toBe(false);
	});

	it("non-string command parameter → falls through to base", () => {
		const ctx = makeCtx({
			auto_approve: false,
			allowed_command_patterns: ["git *"],
		});
		const result = evaluateToolPolicy(
			"execute_command",
			{ command: 123 },
			EXECUTE_COMMAND_TOOL,
			ctx,
		);
		expect(result.allowed).toBe(true);
		expect(result.autoApproved).toBe(false);
	});

	it("does not apply patterns to non-execute_command tools", () => {
		const ctx: ToolPolicyContext = {
			effectiveConfig: {
				tools: {
					write_note: {
						enabled: true,
						auto_approve: false,
						allowed_paths: [],
						blocked_paths: [],
						allowed_command_patterns: ["*"],
						blocked_command_patterns: [],
					},
				},
			},
			mode: "act",
			vaultRootPath: "/vault",
		};
		const writeNoteTool: DispatchableTool = { name: "write_note", mode: "write" } as any;
		const result = evaluateToolPolicy(
			"write_note",
			{ command: "anything" },
			writeNoteTool,
			ctx,
		);
		expect(result.autoApproved).toBe(false);
	});
});

describe("evaluateToolPolicy — read tool auto-approve flows through", () => {
	const SLEEP_TOOL: DispatchableTool = { name: "sleep", mode: "read" } as any;

	function makeSleepCtx(entry: Partial<ResolvedToolConfigEntry>): ToolPolicyContext {
		return {
			effectiveConfig: {
				tools: {
					sleep: {
						enabled: true,
						auto_approve: false,
						allowed_paths: [],
						blocked_paths: [],
						allowed_command_patterns: [],
						blocked_command_patterns: [],
						...entry,
					},
				},
			},
			mode: "act",
			vaultRootPath: "/vault",
		};
	}

	it("read tool with auto_approve=true → auto-approved (no prompt)", () => {
		// Guards the end-to-end contract that the merged auto_approve value
		// reaches the policy decision — the fix for sleep prompting despite
		// an enabled toggle.
		const result = evaluateToolPolicy("sleep", { seconds: 5 }, SLEEP_TOOL, makeSleepCtx({ auto_approve: true }));
		expect(result.allowed).toBe(true);
		expect(result.autoApproved).toBe(true);
	});

	it("read tool with auto_approve=false → requires approval (explicit opt-out honored)", () => {
		const result = evaluateToolPolicy("sleep", { seconds: 5 }, SLEEP_TOOL, makeSleepCtx({ auto_approve: false }));
		expect(result.allowed).toBe(true);
		expect(result.autoApproved).toBe(false);
	});
});
