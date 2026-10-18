/**
 * External API facade: readiness, gates, option validation, and delegation.
 * Runs against a narrow fake host; circuit launches and panels are covered
 * end to end in e2e/scripts/external-api-test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { createNotorApi } from "./notor-api";
import type { NotorApiHost } from "./host";
import { NotorApiError } from "./types";
import { ToolDispatcher, type DispatchableTool } from "../chat/dispatcher";
import { CircuitRunRegistry } from "../circuits/run-registry";
import type { Circuit } from "../circuits/types";
import type { Workflow } from "../types";

// The circuit runner's interactive-pause modal isn't exercised here.
vi.mock("../ui/circuit-modals", () => ({ requestCircuitInput: vi.fn() }));

// Discovery reads the fake host's fixture lists instead of a vault.
vi.mock("./discovery", () => ({
	discoverCircuitsNow: async (host: { settings: { circuits_enabled: boolean }; circuits?: Circuit[] }) =>
		host.settings.circuits_enabled ? (host.circuits ?? []) : [],
	discoverWorkflowsNow: (host: { workflows?: Workflow[] }) => host.workflows ?? [],
}));

function makeHost(over: Partial<Record<string, unknown>> = {}) {
	const settings = {
		external_api_enabled: true,
		external_api_allow_auto_approve: false,
		circuits_enabled: true,
		mode: "plan",
		domain_denylist: [],
		auto_approve: {},
		tool_enabled: {},
		path_scope_rules: [],
		history_path: "notor/history/",
		...(over.settings as object),
	};
	const dispatcher = new ToolDispatcher();
	const registry = new CircuitRunRegistry();
	const approval = vi.fn(async () => "approved" as const);
	const headless = {
		runWorkflowHeadless: vi.fn(async (_w: Workflow, _text: string, opts?: { onConversationCreated?: (id: string) => void }) => {
			opts?.onConversationCreated?.("conv-1");
			return { text: "Summary.", costUsd: 0.01, iterations: 1, conversationId: "conv-1" };
		}),
		destroy: vi.fn(async () => {}),
	};
	const host = {
		app: { vault: { getFileByPath: () => null }, metadataCache: { getFirstLinkpathDest: () => null } },
		settings,
		vaultRootPath: "/vault",
		circuits: over.circuits as Circuit[] | undefined,
		workflows: over.workflows as Workflow[] | undefined,
		getCircuitRunRegistry: () => registry,
		getToolDispatcher: () => dispatcher,
		getSystemPromptBuilder: () => ({
			extractSourceToolConfigs: async () => ({ personaToolConfigs: [], ruleToolConfigs: [] }),
		}),
		getPersonaManager: () => ({ getActivePersona: () => null }),
		getRunApproval: () => ({ callback: approval }),
		createHeadlessOrchestrator: () => headless,
	} as unknown as NotorApiHost;
	return { host, dispatcher, registry, approval, headless };
}

const ready = () => Promise.resolve();
const code = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e as NotorApiError).code);

const circuit = { name: "Wrap-up", flowDir: "notor/circuits/wrap-up", description: "d", invocable: true } as Circuit;
const workflow = {
	display_name: "summarize",
	file_path: "notor/workflows/summarize.md",
	file_name: "summarize.md",
	aliases: [],
} as unknown as Workflow;

describe("createNotorApi — readiness and gates", () => {
	it("holds calls until ready resolves", async () => {
		const { host } = makeHost({ workflows: [workflow] });
		let open!: () => void;
		const { api } = createNotorApi(host, new Promise<void>((r) => (open = r)));
		let settled = false;
		const pending = api.listWorkflows().then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);
		open();
		await pending;
		expect(settled).toBe(true);
	});

	it("rejects calls when the API is turned off, and after unload", async () => {
		const off = createNotorApi(makeHost({ settings: { external_api_enabled: false } }).host, ready());
		expect(await code(off.api.listWorkflows())).toBe("api_disabled");

		const live = createNotorApi(makeHost().host, ready());
		live.dispose();
		expect(await code(live.api.listCircuits())).toBe("unloaded");
	});

	it("is frozen and versioned", () => {
		const { api } = createNotorApi(makeHost().host, ready());
		expect(api.version).toBe(1);
		expect(Object.isFrozen(api)).toBe(true);
	});
});

describe("listing", () => {
	it("lists circuits as plain data, or nothing when circuits are off", async () => {
		const { api } = createNotorApi(makeHost({ circuits: [circuit] }).host, ready());
		await expect(api.listCircuits()).resolves.toEqual([
			{ name: "Wrap-up", description: "d", path: "notor/circuits/wrap-up", invocable: true },
		]);
		const off = createNotorApi(makeHost({ circuits: [circuit], settings: { circuits_enabled: false } }).host, ready());
		await expect(off.api.listCircuits()).resolves.toEqual([]);
	});

	it("lists workflows", async () => {
		const { api } = createNotorApi(makeHost({ workflows: [workflow] }).host, ready());
		await expect(api.listWorkflows()).resolves.toEqual([
			{ name: "summarize", path: "notor/workflows/summarize.md", aliases: [] },
		]);
	});
});

describe("runCircuit — validation", () => {
	it("throws for disabled circuits, unknown names, and bad options", async () => {
		const disabled = createNotorApi(makeHost({ circuits: [circuit], settings: { circuits_enabled: false } }).host, ready());
		expect(await code(disabled.api.runCircuit("Wrap-up"))).toBe("circuits_disabled");

		const { api } = createNotorApi(makeHost({ circuits: [circuit] }).host, ready());
		expect(await code(api.runCircuit("Nope"))).toBe("not_found");
		expect(await code(api.runCircuit("Wrap-up", { mode: "yolo" as never }))).toBe("invalid_option");
		expect(await code(api.runCircuit("Wrap-up", { display: "side" as never }))).toBe("invalid_option");
		expect(await code(api.runCircuit("Wrap-up", { approval: "auto" }))).toBe("auto_approve_not_allowed");
	});

	it("reports an already-running circuit as a failed result", async () => {
		const { host, registry } = makeHost({ circuits: [circuit] });
		registry.register({ sessionId: "s1", flowName: "Wrap-up", controller: new AbortController(), lastProgressAt: 0 });
		const { api } = createNotorApi(host, ready());
		const result = await api.runCircuit("Wrap-up");
		expect(result).toMatchObject({ status: "failed", errorCode: "already_running", kind: "circuit" });
		await expect(result.done).resolves.toMatchObject({ status: "failed" });
	});
});

describe("runWorkflow — headless", () => {
	it("awaits the run and reports conversation, text, and cost", async () => {
		const { host, headless } = makeHost({ workflows: [workflow] });
		const { api } = createNotorApi(host, ready());
		const result = await api.runWorkflow("summarize", { prompt: "Go", mode: "act" });

		expect(result).toMatchObject({
			kind: "workflow",
			name: "summarize",
			status: "completed",
			conversationId: "conv-1",
			text: "Summary.",
			costUsd: 0.01,
		});
		const [, text, opts] = headless.runWorkflowHeadless.mock.calls[0]!;
		expect(text).toBe("Go");
		expect(opts).toMatchObject({ mode: "act", title: "Workflow: summarize" });
		expect(headless.destroy).toHaveBeenCalled();
		expect(api.getRun(result.runId)?.status).toBe("completed");
	});

	it("returns a running handle when wait is false", async () => {
		const { api } = createNotorApi(makeHost({ workflows: [workflow] }).host, ready());
		const handle = await api.runWorkflow("summarize", { wait: false });
		expect(handle.status).toBe("running");
		await expect(handle.done).resolves.toMatchObject({ status: "completed", conversationId: "conv-1" });
	});

	it("drops details not in include", async () => {
		const { api } = createNotorApi(makeHost({ workflows: [workflow] }).host, ready());
		const result = await api.runWorkflow("summarize", { include: ["text"] });
		expect(result.text).toBe("Summary.");
		expect(result.conversationId).toBeUndefined();
		expect(result.costUsd).toBeUndefined();
	});
});

describe("runTool", () => {
	function tool(name: string, mode: "read" | "write", internal = false): DispatchableTool {
		return {
			name,
			mode,
			internal,
			execute: vi.fn(async () => ({ tool_name: name, success: true, result: { ok: true } })),
		};
	}

	it("rejects unknown and session-only tools", async () => {
		const { host, dispatcher } = makeHost();
		dispatcher.registerTool(tool("update_tasks", "write", true));
		dispatcher.registerTool(tool("ask_user", "read"));
		const { api } = createNotorApi(host, ready());
		expect(await code(api.runTool("nope", {}))).toBe("not_found");
		expect(await code(api.runTool("update_tasks", {}))).toBe("unsupported_tool");
		expect(await code(api.runTool("ask_user", {}))).toBe("unsupported_tool");
	});

	it("dispatches through policy: read tools run, Plan mode blocks writes", async () => {
		const { host, dispatcher } = makeHost({ settings: { auto_approve: { read_note: true } } });
		dispatcher.registerTool(tool("read_note", "read"));
		dispatcher.registerTool(tool("write_note", "write"));
		const { api } = createNotorApi(host, ready());

		await expect(api.runTool("read_note", { path: "a.md" })).resolves.toMatchObject({
			toolName: "read_note",
			success: true,
			result: { ok: true },
		});
		const blocked = await api.runTool("write_note", { path: "a.md" });
		expect(blocked.success).toBe(false);
		expect(blocked.error).toMatch(/plan/i);
	});

	it("asks the run's approver for calls that need approval", async () => {
		const { host, dispatcher, approval } = makeHost();
		dispatcher.registerTool(tool("write_note", "write"));
		const { api } = createNotorApi(host, ready());
		const result = await api.runTool("write_note", { path: "a.md" }, { mode: "act", approval: "prompt" });
		expect(approval).toHaveBeenCalledOnce();
		expect(result.success).toBe(true);
	});
});
