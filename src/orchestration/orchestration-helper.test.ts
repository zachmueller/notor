/**
 * TEST-004 (part 1) — `OrchestrationHelper` runtime API (INT-011).
 *
 * Covers the `orchestration` helper surface a code step receives:
 *  - `emit` routing shape + the terminal-only `structured` carriage;
 *  - `once` at-least-once guard (runs once, records `side_effect.committed`,
 *    skips an already-committed key incl. across a recovery-seeded set);
 *  - `scratchpad` round-trip under the session dir (overwrite-only, traversal-safe);
 *  - `callTool` / `callMcpTool` dispatch through `ToolDispatcher.dispatch()`
 *    (threading runContext + orchestrationContext), the `notor-step-mcp-servers`
 *    filter, and dispatch-rejection → thrown error;
 *  - `tasks` delegating to the shared `TaskRegistry` (ensure idempotent, list filter);
 *  - `flow` metadata + `eventHistory(limit?)`.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-3-code-steps.md — INT-011 / TEST-004
 * @see specs/ZZ-misc/orchestration/contracts/orchestration-helper.md
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ToolDispatcher } from "../chat/dispatcher";
import type { OrchestrationToolContext, RunContext } from "../run-loop/types";
import type { ToolResult } from "../types";
import {
	buildOrchestrationHelper,
	projectCodeStepEvent,
	type BuildOrchestrationHelperArgs,
	type ScratchpadFs,
} from "./orchestration-helper";
import { SessionLog, type SessionLogWriter } from "./session-log";
import { TaskRegistry, type TaskFs } from "./task-registry";
import type { OrchestrationEvent } from "./types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** An in-memory scratchpad + task filesystem (vault-relative paths). */
class FakeFs implements ScratchpadFs, TaskFs {
	files = new Map<string, string>();
	dirs = new Set<string>();
	async read(p: string): Promise<string> {
		const v = this.files.get(p);
		if (v === undefined) throw new Error(`ENOENT: ${p}`);
		return v;
	}
	async exists(p: string): Promise<boolean> {
		return this.files.has(p) || this.dirs.has(p);
	}
	async write(p: string, data: string): Promise<void> {
		this.files.set(p, data);
	}
	async mkdir(p: string): Promise<void> {
		this.dirs.add(p);
	}
	async list(dir: string): Promise<string[]> {
		const prefix = `${dir.replace(/\/+$/, "")}/`;
		return [...this.files.keys()].filter((p) => p.startsWith(prefix));
	}
}

/** A ScratchpadFs whose `read` returns null for an absent file (production semantics). */
function scratchpadAdapter(fs: FakeFs): ScratchpadFs {
	return {
		read: async (p) => (fs.files.has(p) ? fs.files.get(p)! : null),
		write: (p, c) => fs.write(p, c),
		exists: (p) => fs.exists(p),
		list: (d) => fs.list(d),
	};
}

class FakeWriter implements SessionLogWriter {
	content = "";
	async append(_path: string, data: string): Promise<void> {
		this.content += data;
	}
	entries(): Array<Record<string, unknown>> {
		return this.content.split("\n").filter(Boolean).map((l) => JSON.parse(l));
	}
}

function ok(result: string): ToolResult {
	return { tool_name: "t", success: true, result };
}
function fail(error: string): ToolResult {
	return { tool_name: "t", success: false, result: "", error };
}

function fakeDispatcher(dispatch: ToolDispatcher["dispatch"]): ToolDispatcher {
	return { dispatch } as unknown as ToolDispatcher;
}

function ctx(over: Partial<OrchestrationToolContext> = {}): OrchestrationToolContext {
	return {
		sessionId: "sess-1",
		scratchpadPath: "notor/orchestrations/sessions/sess-1/scratchpad",
		tasksPath: "notor/orchestrations/sessions/sess-1/tasks",
		pendingEmission: null,
		emissionOverwrites: [],
		...over,
	};
}

function runContext(abort: AbortSignal): RunContext {
	return {
		depth: 0,
		maxDepth: 8,
		budget: { iterationsRemaining: 100, costRemainingUsd: 5 },
		subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: 0 },
		abort,
	};
}

function makeArgs(over: Partial<BuildOrchestrationHelperArgs> = {}): BuildOrchestrationHelperArgs {
	const fs = new FakeFs();
	return {
		flowName: "Demo",
		iteration: 3,
		stepName: "🔍 Verify",
		mcpServers: null,
		orchestrationContext: ctx(),
		runContext: runContext(new AbortController().signal),
		mode: "act",
		dispatcher: fakeDispatcher(vi.fn(async () => ok("output"))),
		scratchpadFs: scratchpadAdapter(fs),
		taskRegistry: new TaskRegistry(fs),
		sessionLog: new SessionLog("sessions/sess-1/session-log.jsonl", new FakeWriter(), () => "T"),
		committedKeys: new Set<string>(),
		eventHistory: [],
		...over,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("projectCodeStepEvent", () => {
	it("projects only topic/payload/source_step (engine-only turn/ts excluded)", () => {
		const event: OrchestrationEvent = {
			topic: "build.done",
			payload: "{\"projectPath\":\"/x\"}",
			source_step: "Builder",
			turn: 7,
			ts: "2026-06-28T00:00:00Z",
		};
		const projected = projectCodeStepEvent(event);
		expect(projected).toEqual({
			topic: "build.done",
			payload: "{\"projectPath\":\"/x\"}",
			source_step: "Builder",
		});
		expect("turn" in projected).toBe(false);
		expect("ts" in projected).toBe(false);
	});
});

describe("OrchestrationHelper.emit", () => {
	it("builds a CodeStepResult with payload defaulting to \"\"", () => {
		const o = buildOrchestrationHelper(makeArgs());
		expect(o.emit("tests.passed")).toEqual({ topic: "tests.passed", payload: "" });
		expect(o.emit("tests.failed", "boom")).toEqual({ topic: "tests.failed", payload: "boom" });
	});

	it("carries structured only when provided (terminal data path)", () => {
		const o = buildOrchestrationHelper(makeArgs());
		const withStructured = o.emit("FLOW_COMPLETE", "done", { filesChanged: ["a.ts"] });
		expect(withStructured).toEqual({
			topic: "FLOW_COMPLETE",
			payload: "done",
			structured: { filesChanged: ["a.ts"] },
		});
		expect("structured" in o.emit("FLOW_COMPLETE", "done")).toBe(false);
	});
});

describe("OrchestrationHelper.once", () => {
	it("runs fn once, records side_effect.committed, and skips an already-committed key", async () => {
		const writer = new FakeWriter();
		const sessionLog = new SessionLog("sessions/sess-1/log.jsonl", writer, () => "T");
		const committedKeys = new Set<string>();
		const o = buildOrchestrationHelper(makeArgs({ sessionLog, committedKeys }));

		const fn = vi.fn(async () => "pushed");
		const first = await o.once("push-main", fn);
		expect(first).toBe("pushed");
		expect(fn).toHaveBeenCalledTimes(1);
		expect(committedKeys.has("push-main")).toBe(true);

		const committed = writer.entries().filter((e) => e.type === "side_effect.committed");
		expect(committed).toHaveLength(1);
		expect(committed[0]).toMatchObject({ key: "push-main", step: "🔍 Verify", turn: 3 });

		// A re-run with the same committed key skips fn and returns undefined.
		const second = await o.once("push-main", fn);
		expect(second).toBeUndefined();
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("dedupes across a recovery-seeded committed set (Issue-2 — markers survive)", async () => {
		const committedKeys = new Set<string>(["deploy"]);
		const o = buildOrchestrationHelper(makeArgs({ committedKeys }));
		const fn = vi.fn(async () => "deployed");
		const result = await o.once("deploy", fn);
		expect(result).toBeUndefined();
		expect(fn).not.toHaveBeenCalled();
	});
});

describe("OrchestrationHelper.scratchpad", () => {
	let fs: FakeFs;
	let o: ReturnType<typeof buildOrchestrationHelper>;
	beforeEach(() => {
		fs = new FakeFs();
		o = buildOrchestrationHelper(makeArgs({ scratchpadFs: scratchpadAdapter(fs) }));
	});

	it("round-trips read/write/exists under sessions/{id}/scratchpad/", async () => {
		expect(await o.scratchpad.read("notes.txt")).toBeNull();
		expect(await o.scratchpad.exists("notes.txt")).toBe(false);
		await o.scratchpad.write("notes.txt", "hello");
		expect(fs.files.has("notor/orchestrations/sessions/sess-1/scratchpad/notes.txt")).toBe(true);
		expect(await o.scratchpad.read("notes.txt")).toBe("hello");
		expect(await o.scratchpad.exists("notes.txt")).toBe(true);
	});

	it("write is overwrite-only (a re-run reproduces, not duplicates)", async () => {
		await o.scratchpad.write("out.txt", "v1");
		await o.scratchpad.write("out.txt", "v2");
		expect(await o.scratchpad.read("out.txt")).toBe("v2");
	});

	it("list returns bare file names relative to scratchpad/", async () => {
		await o.scratchpad.write("a.txt", "1");
		await o.scratchpad.write("b.txt", "2");
		expect((await o.scratchpad.list()).sort()).toEqual(["a.txt", "b.txt"]);
	});

	it("rejects a path-traversal file name", async () => {
		await expect(o.scratchpad.write("../escape.txt", "x")).rejects.toThrow(/traversal/);
	});
});

describe("OrchestrationHelper.callTool / callMcpTool", () => {
	it("dispatches through ToolDispatcher.dispatch threading runContext + orchestrationContext", async () => {
		const abort = new AbortController().signal;
		const rc = runContext(abort);
		const oc = ctx();
		const dispatch = vi.fn(async (..._args: unknown[]) => ok("tool said hi"));
		const o = buildOrchestrationHelper(
			makeArgs({ dispatcher: fakeDispatcher(dispatch), runContext: rc, orchestrationContext: oc }),
		);

		const out = await o.callTool("read_note", { path: "x.md" });
		expect(out).toBe("tool said hi");
		const call = dispatch.mock.calls[0]!;
		expect(call[0]).toBe("read_note"); // toolName
		expect(call[1]).toEqual({ path: "x.md" }); // params
		expect(call[2]).toBe("act"); // mode
		expect(call[4]).toBe(abort); // abortSignal = runContext.abort
		expect(call[11]).toBe(rc); // runContext (12th positional)
		expect(call[12]).toBe(oc); // orchestrationContext (13th positional)
	});

	it("stringifies a non-string tool result", async () => {
		const dispatch = vi.fn(async (): Promise<ToolResult> => ({
			tool_name: "t",
			success: true,
			result: { count: 3 },
		}));
		const o = buildOrchestrationHelper(makeArgs({ dispatcher: fakeDispatcher(dispatch) }));
		expect(await o.callTool("x", {})).toBe(JSON.stringify({ count: 3 }));
	});

	it("throws on a dispatch failure (INT-010 surfaces it as {step}.code_error)", async () => {
		const dispatch = vi.fn(async () => fail("blocked by policy"));
		const o = buildOrchestrationHelper(makeArgs({ dispatcher: fakeDispatcher(dispatch) }));
		await expect(o.callTool("write_note", {})).rejects.toThrow(/blocked by policy/);
	});

	it("callMcpTool namespaces as {server}__{tool} and honors the mcp-servers filter", async () => {
		const dispatch = vi.fn(async (..._args: unknown[]) => ok("posted"));
		// Filter allows only "slack".
		const o = buildOrchestrationHelper(
			makeArgs({ dispatcher: fakeDispatcher(dispatch), mcpServers: ["slack"] }),
		);
		await o.callMcpTool("slack", "post_message", { text: "hi" });
		expect(dispatch.mock.calls[0]![0]).toBe("slack__post_message");

		// A server not in the filter is rejected before dispatch.
		await expect(o.callMcpTool("github", "create_issue", {})).rejects.toThrow(/not permitted/);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it("callMcpTool with a null filter inherits all servers", async () => {
		const dispatch = vi.fn(async (..._args: unknown[]) => ok("ok"));
		const o = buildOrchestrationHelper(
			makeArgs({ dispatcher: fakeDispatcher(dispatch), mcpServers: null }),
		);
		await o.callMcpTool("anyserver", "anytool", {});
		expect(dispatch.mock.calls[0]![0]).toBe("anyserver__anytool");
	});
});

describe("OrchestrationHelper.tasks", () => {
	it("delegates to the shared TaskRegistry (ensure idempotent; list filters by status)", async () => {
		const fs = new FakeFs();
		const registry = new TaskRegistry(fs, () => "2026-06-28T00:00:00Z");
		const o = buildOrchestrationHelper(makeArgs({ taskRegistry: registry }));

		await o.tasks.ensure("step-01", "Implement the flag");
		await o.tasks.ensure("step-01", "Implement the flag"); // idempotent — no duplicate
		const all = await o.tasks.list();
		expect(all).toHaveLength(1);
		expect(all[0]!.status).toBe("open");

		await o.tasks.start("step-01");
		expect((await o.tasks.list({ status: "running" }))).toHaveLength(1);
		expect((await o.tasks.list({ status: "open" }))).toHaveLength(0);

		await o.tasks.close("step-01");
		expect((await o.tasks.list({ status: "closed" }))).toHaveLength(1);
	});
});

describe("OrchestrationHelper.flow / eventHistory", () => {
	it("exposes flow.name/iteration/sessionId for the current turn", () => {
		const o = buildOrchestrationHelper(makeArgs({ flowName: "Code Assist", iteration: 9 }));
		expect(o.flow).toEqual({ name: "Code Assist", iteration: 9, sessionId: "sess-1" });
	});

	it("eventHistory returns recent events newest-last; limit slices the tail; default = all", () => {
		const history: OrchestrationEvent[] = [1, 2, 3, 4].map((n) => ({
			topic: `e${n}`,
			payload: "",
			source_step: null,
			turn: n,
			ts: "T",
		}));
		const o = buildOrchestrationHelper(makeArgs({ eventHistory: history }));
		expect(o.eventHistory().map((e) => e.topic)).toEqual(["e1", "e2", "e3", "e4"]);
		expect(o.eventHistory(2).map((e) => e.topic)).toEqual(["e3", "e4"]);
		expect(o.eventHistory(0)).toEqual([]);
		expect(o.eventHistory(99).map((e) => e.topic)).toEqual(["e1", "e2", "e3", "e4"]);
	});
});

describe("OrchestrationHelper.log", () => {
	it("appends a step.log entry per level, keyed by the turn + step", async () => {
		const writer = new FakeWriter();
		const sessionLog = new SessionLog("sessions/sess-1/log.jsonl", writer, () => "T");
		const o = buildOrchestrationHelper(makeArgs({ sessionLog, iteration: 7, stepName: "🔍 Verify" }));

		o.log.debug("d");
		o.log.info("chose branch A", { n: 3 });
		o.log.warn("slow");
		o.log.error("boom", { code: 1 });
		await new Promise((r) => setTimeout(r, 0)); // drain the fire-and-forget write chain

		const logs = writer.entries().filter((e) => e.type === "step.log");
		expect(logs).toHaveLength(4);
		expect(logs[1]).toMatchObject({
			type: "step.log",
			ts: "T",
			turn: 7,
			step: "🔍 Verify",
			level: "info",
			message: "chose branch A",
			data: { n: 3 },
		});
		expect(logs.map((e) => e.level)).toEqual(["debug", "info", "warn", "error"]);
	});

	it("omits data when not provided", async () => {
		const writer = new FakeWriter();
		const sessionLog = new SessionLog("sessions/sess-1/log.jsonl", writer, () => "T");
		const o = buildOrchestrationHelper(makeArgs({ sessionLog }));
		o.log.info("no data");
		await new Promise((r) => setTimeout(r, 0));
		const entry = writer.entries().find((e) => e.type === "step.log")!;
		expect("data" in entry).toBe(false);
	});

	it("never throws when the session-log append rejects (logging must not crash a run)", () => {
		const writer: SessionLogWriter = {
			append: () => Promise.reject(new Error("disk full")),
		};
		const sessionLog = new SessionLog("sessions/sess-1/log.jsonl", writer, () => "T");
		const o = buildOrchestrationHelper(makeArgs({ sessionLog }));
		expect(() => o.log.error("still fine")).not.toThrow();
	});
});
