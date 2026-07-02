import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { evaluateToolPolicy, ToolPolicyContext } from "./tool-policy";
import type { DispatchableTool } from "./dispatcher";
import type { ResolvedToolConfigEntry } from "../tool-config/types";
import { TOOL_PATH_PARAMS } from "../tool-config/path-enforcer";

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

// ---------------------------------------------------------------------------
// Feature audit (F2 §2) — the checks the legacy branch also performed, encoded
// so the pure engine is a verified superset before the legacy branch is deleted.
// ---------------------------------------------------------------------------

/** Build a ctx around a single named tool entry (defaults: enabled, no auto-approve). */
function makeToolCtx(
	toolName: string,
	entry: Partial<ResolvedToolConfigEntry> = {},
	over: Partial<ToolPolicyContext> = {},
): ToolPolicyContext {
	const resolved: ResolvedToolConfigEntry = {
		enabled: true,
		auto_approve: false,
		allowed_paths: [],
		blocked_paths: [],
		allowed_command_patterns: [],
		blocked_command_patterns: [],
		...entry,
	};
	return {
		effectiveConfig: { tools: { [toolName]: resolved } },
		mode: "act",
		vaultRootPath: "/vault",
		...over,
	};
}

describe("evaluateToolPolicy — internal-tool bypass", () => {
	it("internal tools are always allowed + auto-approved, regardless of config", () => {
		const internalTool: DispatchableTool = { name: "update_tasks", mode: "write", internal: true } as any;
		// Even a disabled entry + plan mode does not block an internal tool.
		const ctx = makeToolCtx("update_tasks", { enabled: false }, { mode: "plan" });
		const result = evaluateToolPolicy("update_tasks", {}, internalTool, ctx);
		expect(result).toEqual({ allowed: true, autoApproved: true });
	});
});

describe("evaluateToolPolicy — enabled check (FR-83)", () => {
	it("a disabled tool is blocked with the disabled error", () => {
		const tool: DispatchableTool = { name: "write_note", mode: "write" } as any;
		const result = evaluateToolPolicy("write_note", {}, tool, makeToolCtx("write_note", { enabled: false }));
		expect(result.allowed).toBe(false);
		expect(result.error).toMatch(/disabled/);
	});
});

describe("evaluateToolPolicy — plan-mode write gating (FR-14)", () => {
	it("non-MCP write tool blocked in Plan mode uses the real-name description", () => {
		const tool: DispatchableTool = { name: "write_note", mode: "write" } as any;
		const result = evaluateToolPolicy("write_note", {}, tool, makeToolCtx("write_note", {}, { mode: "plan" }));
		expect(result.allowed).toBe(false);
		// Real-name map (post map-fix): no longer the generic "use write_note" fallback.
		expect(result.error).toBe(
			"write_note is not available in Plan mode. Switch to Act mode to create or modify notes.",
		);
	});

	it("MCP write tool blocked in Plan mode uses the MCP-specific message", () => {
		const tool: DispatchableTool = { name: "server__do_write", mode: "write" } as any;
		const result = evaluateToolPolicy(
			"server__do_write",
			{},
			tool,
			makeToolCtx("server__do_write", {}, { mode: "plan" }),
		);
		expect(result.allowed).toBe(false);
		expect(result.error).toBe(
			"Tool 'server__do_write' is write-only and blocked in Plan mode. Switch to Act mode to use this tool.",
		);
	});

	it("read tool is not blocked in Plan mode", () => {
		const tool: DispatchableTool = { name: "search_vault", mode: "read" } as any;
		const result = evaluateToolPolicy("search_vault", {}, tool, makeToolCtx("search_vault", {}, { mode: "plan" }));
		expect(result.allowed).toBe(true);
	});
});

describe("evaluateToolPolicy — domain denylist (fetch_webpage)", () => {
	const FETCH_TOOL: DispatchableTool = { name: "fetch_webpage", mode: "read" } as any;

	it("blocks a URL whose host matches the denylist", () => {
		const ctx = makeToolCtx("fetch_webpage", {}, { domainDenylist: ["evil.com"] });
		const result = evaluateToolPolicy("fetch_webpage", { url: "https://evil.com/x" }, FETCH_TOOL, ctx);
		expect(result.allowed).toBe(false);
		expect(result.error).toMatch(/evil\.com is blocked/);
	});

	it("allows a URL not on the denylist", () => {
		const ctx = makeToolCtx("fetch_webpage", {}, { domainDenylist: ["evil.com"] });
		const result = evaluateToolPolicy("fetch_webpage", { url: "https://good.com/x" }, FETCH_TOOL, ctx);
		expect(result.allowed).toBe(true);
	});
});

describe("evaluateToolPolicy — path allowlists (FR-84) + sessionAllowedPaths (INT-001)", () => {
	const WRITE_FILE_TOOL: DispatchableTool = { name: "write_file", mode: "write" } as any;

	// write_file is a filesystem-namespace tool with a `path` param; register it so
	// enforcePathConstraints applies (tools absent from the table are exempt).
	beforeAll(() => {
		TOOL_PATH_PARAMS["write_file"] = [{ paramName: "path", namespace: "filesystem" }];
	});
	afterAll(() => {
		delete TOOL_PATH_PARAMS["write_file"];
	});

	it("blocks a path outside allowed_paths", () => {
		const ctx = makeToolCtx("write_file", { allowed_paths: ["allowed"] });
		const result = evaluateToolPolicy("write_file", { path: "secret/x.txt" }, WRITE_FILE_TOOL, ctx);
		expect(result.allowed).toBe(false);
		expect(result.error).toMatch(/path constraint/);
	});

	it("allows a path inside allowed_paths", () => {
		const ctx = makeToolCtx("write_file", { allowed_paths: ["allowed"] });
		const result = evaluateToolPolicy("write_file", { path: "allowed/x.txt" }, WRITE_FILE_TOOL, ctx);
		expect(result.allowed).toBe(true);
	});

	it("sessionAllowedPaths allows a scratchpad path outside allowed_paths", () => {
		const ctx = makeToolCtx(
			"write_file",
			{ allowed_paths: ["allowed"] },
			{ sessionAllowedPaths: ["scratch"] },
		);
		const result = evaluateToolPolicy("write_file", { path: "scratch/notes.txt" }, WRITE_FILE_TOOL, ctx);
		expect(result.allowed).toBe(true);
	});

	it("blocked_paths still wins over a session-allowed path", () => {
		const ctx = makeToolCtx(
			"write_file",
			{ allowed_paths: ["allowed"], blocked_paths: ["scratch/secret"] },
			{ sessionAllowedPaths: ["scratch"] },
		);
		const result = evaluateToolPolicy(
			"write_file",
			{ path: "scratch/secret/x.txt" },
			WRITE_FILE_TOOL,
			ctx,
		);
		expect(result.allowed).toBe(false);
		expect(result.error).toMatch(/blocked by path constraint/);
	});

	it("absent sessionAllowedPaths → unchanged (byte-identical to today)", () => {
		const ctx = makeToolCtx("write_file", { allowed_paths: ["allowed"] });
		const blocked = evaluateToolPolicy("write_file", { path: "scratch/x.txt" }, WRITE_FILE_TOOL, ctx);
		expect(blocked.allowed).toBe(false);
	});
});
