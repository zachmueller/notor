/**
 * `finalizeRun` — the shared finalize invariant: run.result is appended BEFORE
 * the terminal status lands, the failure report stays gated, and the opt-in
 * automatic evaluation fires for roots only, after the status write.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", async () => {
	const actual = await vi.importActual<typeof import("obsidian")>("obsidian");
	return { ...actual, Notice: class { constructor(_m?: unknown) {} } };
});

import { finalizeRun } from "./run-lifecycle";
import type { CircuitHost } from "./host";
import type { CircuitSessionManager } from "./session-manager";
import type { CircuitRunResult } from "./runner";
import type { Circuit, CircuitSessionMeta } from "./types";
import { newRootBudget } from "../run-loop/budget";

function makeHost(appended: string[]) {
	const files = new Map<string, string>();
	return {
		settings: { notor_dir: "notor", circuits_write_failure_notes: false },
		app: {
			vault: {
				adapter: {
					exists: async (p: string) => files.has(p) || p === "notor/circuits/sessions/s1",
					mkdir: async () => {},
					append: async (p: string, data: string) => {
						appended.push(`append:${p}`);
						files.set(p, (files.get(p) ?? "") + data);
					},
				},
			},
		},
		files,
	} as unknown as CircuitHost & { files: Map<string, string> };
}

function makeSessionManager(calls: string[], meta: Partial<CircuitSessionMeta> = {}) {
	return {
		resolveWorkspace: (id: string) => ({
			sessionId: id,
			sessionDir: `notor/circuits/sessions/${id}`,
			scratchpadPath: `notor/circuits/sessions/${id}/scratchpad`,
			tasksPath: `notor/circuits/sessions/${id}/tasks`,
			metaPath: `notor/circuits/sessions/${id}/session.json`,
			logPath: `notor/circuits/sessions/${id}/session-log.jsonl`,
		}),
		updateStatus: vi.fn(async (id: string, status: string) => {
			calls.push(`status:${status}`);
		}),
		readMeta: vi.fn(async () => ({ session_id: "s1", parent_session_id: null, ...meta }) as CircuitSessionMeta),
	} as unknown as CircuitSessionManager;
}

function flow(over: Partial<Circuit> = {}): Circuit {
	return { name: "Demo", evalAuto: "none", evaluators: [], ...over } as Circuit;
}

function result(status: CircuitRunResult["status"]): CircuitRunResult {
	return {
		status,
		terminal: { topic: status === "completed" ? "FLOW_COMPLETE" : "FLOW_ERROR", payload: "p", source_step: "S", turn: 2, ts: "t" },
		iterations: 2,
		structured: { ok: true },
		text: "closing",
		subtreeConsumed: { costUsd: 0.42, iterations: 2, maxDepthReached: 0 },
		tokenUsage: { input: 10, output: 5 },
		budget: newRootBudget(),
		depth: 0,
	};
}

describe("finalizeRun", () => {
	it("appends run.result before writing the terminal status and maps statuses", async () => {
		const calls: string[] = [];
		const host = makeHost(calls);
		const sm = makeSessionManager(calls);

		expect(await finalizeRun(host, sm, "s1", flow(), result("completed"))).toBe("completed");
		expect(calls).toEqual(["append:notor/circuits/sessions/s1/session-log.jsonl", "status:completed"]);
		const line = JSON.parse(host.files.get("notor/circuits/sessions/s1/session-log.jsonl")!.trim());
		expect(line).toMatchObject({
			type: "run.result",
			status: "completed",
			terminal_topic: "FLOW_COMPLETE",
			text: "closing",
			structured: { ok: true },
			cost_usd: 0.42,
			token_usage: { input: 10, output: 5 },
			iterations: 2,
		});

		expect(await finalizeRun(host, makeSessionManager([]), "s1", flow(), result("error"))).toBe("error");
		expect(await finalizeRun(host, makeSessionManager([]), "s1", flow(), result("cancelled"))).toBe("cancelled");
	});

	it("fires the automatic evaluation for an opted-in root after the status write, with the parent id from session.json", async () => {
		const calls: string[] = [];
		const host = makeHost(calls);
		const sm = makeSessionManager(calls, { parent_session_id: null });
		const autoEvaluate = vi.fn(async () => {
			calls.push("auto-eval");
		});
		const f = flow({ evalAuto: "complete", evaluators: [{ name: "j" }] as Circuit["evaluators"] });
		await finalizeRun(host, sm, "s1", f, result("completed"), { autoEvaluate });
		expect(autoEvaluate).toHaveBeenCalledWith(host, f, "s1", expect.objectContaining({ status: "completed" }), null);
		expect(calls.indexOf("status:completed")).toBeLessThan(calls.indexOf("auto-eval"));
	});

	it("passes the parent session id through so children are never auto-evaluated, and skips when not opted in", async () => {
		const host = makeHost([]);
		const autoEvaluate = vi.fn(async () => {});
		const f = flow({ evalAuto: "both", evaluators: [{ name: "j" }] as Circuit["evaluators"] });
		await finalizeRun(host, makeSessionManager([], { parent_session_id: "parent-1" }), "s1", f, result("error"), { autoEvaluate });
		expect(autoEvaluate).toHaveBeenCalledWith(host, f, "s1", expect.anything(), "parent-1");

		autoEvaluate.mockClear();
		await finalizeRun(host, makeSessionManager([]), "s1", flow({ evalAuto: "none", evaluators: [{ name: "j" }] as Circuit["evaluators"] }), result("completed"), { autoEvaluate });
		await finalizeRun(host, makeSessionManager([]), "s1", flow({ evalAuto: "complete", evaluators: [] }), result("completed"), { autoEvaluate });
		expect(autoEvaluate).not.toHaveBeenCalled();
	});
});
