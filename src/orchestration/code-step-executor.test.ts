/**
 * TEST-004 (part 2) — `CodeStepExecutor` (INT-010).
 *
 * Covers the deterministic code-step path:
 *  - fence extraction (first ts/typescript/js/javascript fence; missing/empty →
 *    `{step}.code_error`, no throw);
 *  - type-strip + the exact `CODE_STEP_ARG_NAMES` arg signature;
 *  - timeout for AWAIT-YIELDING code (documents the sync-loop limitation, Issue-7);
 *  - error → `{step}.code_error` (compile error, runtime throw, unhandled rejection)
 *    carrying message + stack, with an error Notice, and `turn.start`/`turn.complete`
 *    written EVEN on error;
 *  - no tokens / no cost (zero on turn.complete) while the engine advances iteration;
 *  - emit routing (returned emit wins; bare call is a no-op; no return synthesizes
 *    `default_publishes`); terminal `structured` carried on the emission.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-3-code-steps.md — INT-010 / TEST-004
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { OrchestrationToolContext, RunContext } from "../run-loop/types";
import type { ToolDispatcher } from "../chat/dispatcher";
import {
	CodeStepExecutor,
	type CodeStepRuntime,
	type CodeStepRuntimeFactory,
} from "./code-step-executor";
import { SessionLog, type SessionLogWriter } from "./session-log";
import { TaskRegistry, type TaskFs } from "./task-registry";
import type { ScratchpadFs } from "./orchestration-helper";
import type {
	OrchestrationEvent,
	OrchestrationFlow,
	StepDefinition,
} from "./types";
import type { StepTurnRequest } from "./step-turn-executor";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeWriter implements SessionLogWriter {
	content = "";
	async append(_path: string, data: string): Promise<void> {
		this.content += data;
	}
	entries(): Array<Record<string, unknown>> {
		return this.content.split("\n").filter(Boolean).map((l) => JSON.parse(l));
	}
}

const memScratchpad = (): ScratchpadFs => {
	const files = new Map<string, string>();
	return {
		read: async (p) => (files.has(p) ? files.get(p)! : null),
		write: async (p, c) => void files.set(p, c),
		exists: async (p) => files.has(p),
		list: async () => [],
	};
};

const memTaskFs = (): TaskFs => {
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	return {
		exists: async (p) => files.has(p) || dirs.has(p),
		read: async (p) => files.get(p) ?? "",
		write: async (p, d) => void files.set(p, d),
		mkdir: async (p) => void dirs.add(p),
		list: async () => [],
	};
};

function dispatcherReturning(result: string): ToolDispatcher {
	return {
		dispatch: vi.fn(async () => ({ tool_name: "t", success: true, result })),
	} as unknown as ToolDispatcher;
}

/** A runtime factory whose dispatcher/utils are injectable per test. */
function makeRuntimeFactory(over: Partial<CodeStepRuntime> = {}): {
	factory: CodeStepRuntimeFactory;
	runtime: CodeStepRuntime;
} {
	const runtime: CodeStepRuntime = {
		app: {},
		obsidian: { Notice: class {} },
		utils: { marker: "UTILS" },
		libs: { marker: "LIBS" },
		dispatcher: dispatcherReturning("dispatch-ok"),
		scratchpadFs: memScratchpad(),
		taskRegistry: new TaskRegistry(memTaskFs()),
		committedKeys: new Set<string>(),
		...over,
	};
	return { factory: { build: async () => runtime }, runtime };
}

function step(over: Partial<StepDefinition> = {}): StepDefinition {
	return {
		name: "Verify",
		description: "",
		triggers: ["build.done"],
		publishes: ["tests.passed", "tests.failed"],
		defaultPublishes: null,
		persona: null,
		model: null,
		mode: "code",
		mcpServers: null,
		timeoutSeconds: null,
		bodyContent: "",
		notePath: "steps/verify.md",
		...over,
	};
}

function flow(): OrchestrationFlow {
	return {
		name: "Demo",
		description: "",
		flowDir: "d",
		startingEvent: "start",
		completionEvent: "FLOW_COMPLETE",
		maxIterations: 100,
		maxRuntimeMinutes: 60,
		requiredEvents: [],
		fanoutTopics: [],
		steps: [],
		guardrails: [],
		schedule: null,
		invocable: false,
		flowInputs: null,
		flowReturns: null,
		onCompleteFlow: null,
		handoffIsolation: "isolated",
		maxDepth: null,
		maxCostUsd: 5,
	};
}

function ctx(): OrchestrationToolContext {
	return {
		sessionId: "sess-1",
		scratchpadPath: "notor/orchestrations/sessions/sess-1/scratchpad",
		tasksPath: "notor/orchestrations/sessions/sess-1/tasks",
		pendingEmission: null,
		emissionOverwrites: [],
	};
}

function runContext(): RunContext {
	return {
		depth: 0,
		maxDepth: 8,
		budget: { iterationsRemaining: 100, costRemainingUsd: 5 },
		subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: 0 },
		abort: new AbortController().signal,
	};
}

function event(payload = ""): OrchestrationEvent {
	return { topic: "build.done", payload, source_step: "Builder", turn: 0, ts: "T" };
}

function request(s: StepDefinition, payload = ""): StepTurnRequest {
	return {
		step: s,
		flow: flow(),
		event: event(payload),
		eventHistory: [],
		objective: "obj",
		iteration: 5,
		orchestrationContext: ctx(),
		runContext: runContext(),
		mode: "act",
		conversationId: "ignored-for-code",
	};
}

/** Fence a code body so `extractCodeFence` finds it. */
function fenced(lang: string, code: string): string {
	return `Some instructions.\n\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
}

function makeExecutor(over: Partial<CodeStepRuntime> = {}, notifyError?: (m: string) => void) {
	const writer = new FakeWriter();
	const sessionLog = new SessionLog("sessions/sess-1/log.jsonl", writer, () => "T");
	const { factory, runtime } = makeRuntimeFactory(over);
	const executor = new CodeStepExecutor({ runtimeFactory: factory, notifyError }, sessionLog);
	return { executor, writer, sessionLog, runtime };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodeStepExecutor — fence extraction", () => {
	it("extracts and runs the first ts fence; a returned emit routes the next event", async () => {
		const { executor } = makeExecutor();
		const body = fenced("ts", `return orchestration.emit("tests.passed", "green");`);
		const result = await executor.execute(request(step({ bodyContent: body })));
		expect(result.emission).toEqual({ topic: "tests.passed", payload: "green" });
		expect(result.stopReason).toBe("completed");
	});

	it.each(["typescript", "js", "javascript"])(
		"accepts a %s fence",
		async (lang) => {
			const { executor } = makeExecutor();
			const body = fenced(lang, `return orchestration.emit("tests.passed");`);
			const result = await executor.execute(request(step({ bodyContent: body })));
			expect(result.emission.topic).toBe("tests.passed");
		},
	);

	it("treats a missing fence as {step}.code_error (does not throw)", async () => {
		const { executor } = makeExecutor();
		const result = await executor.execute(request(step({ bodyContent: "no code here" })));
		expect(result.emission.topic).toBe("Verify.code_error");
		expect(result.stopReason).toBe("error");
	});

	it("treats an empty fence as {step}.code_error", async () => {
		const { executor } = makeExecutor();
		const result = await executor.execute(request(step({ bodyContent: "```ts\n\n```" })));
		expect(result.emission.topic).toBe("Verify.code_error");
	});
});

describe("CodeStepExecutor — type strip + arg signature", () => {
	it("compiles a typed fence via stripTypes and injects exactly CODE_STEP_ARG_NAMES", async () => {
		const { executor } = makeExecutor({ utils: { marker: "UTILS" }, libs: { marker: "LIBS" } });
		// Typed code (annotations + `as` cast) must strip+compile; the body reads
		// every injected arg and routes based on them.
		const code = [
			"const passed: boolean = (utils as any).marker === \"UTILS\" && (libs as any).marker === \"LIBS\";",
			"const hasEvent = event.topic === \"build.done\";",
			"const hasOrch = typeof orchestration.emit === \"function\";",
			"const hasApp = app !== undefined && obsidian !== undefined;",
			"return orchestration.emit(passed && hasEvent && hasOrch && hasApp ? \"tests.passed\" : \"tests.failed\");",
		].join("\n");
		const result = await executor.execute(request(step({ bodyContent: fenced("ts", code) })));
		expect(result.emission.topic).toBe("tests.passed");
	});

	it("event projection exposes topic/payload/source_step to the fence", async () => {
		const { executor } = makeExecutor();
		const code = `return orchestration.emit("echo", event.payload + ":" + event.source_step);`;
		const result = await executor.execute(
			request(step({ bodyContent: fenced("ts", code) }), "PAYLOAD"),
		);
		expect(result.emission).toEqual({ topic: "echo", payload: "PAYLOAD:Builder" });
	});
});

describe("CodeStepExecutor — timeout (await-yielding code; Issue-7 limitation)", () => {
	it("abandons an await-yielding step that exceeds the timeout → {step}.code_error", async () => {
		const { executor } = makeExecutor();
		// timeoutSeconds: 0 → fires on the next macrotask; the awaited setTimeout
		// yields control, so the guard CAN preempt (the await-boundary case).
		const code = `await new Promise((r) => setTimeout(r, 5000)); return orchestration.emit("tests.passed");`;
		const result = await executor.execute(
			request(step({ bodyContent: fenced("ts", code), timeoutSeconds: 0 })),
		);
		expect(result.emission.topic).toBe("Verify.code_error");
		const payload = JSON.parse(result.emission.payload);
		expect(payload.error).toMatch(/timeout|await boundary/i);
	});

	it("documents the sync-loop limitation: a tight sync loop is NOT interruptible by the guard", () => {
		// Issue-7: code steps run as `new AsyncFunction` on the main event-loop
		// thread (no Worker/VM isolation in v1). The setTimeout-based guard can only
		// fire at an await boundary, so an unbounded SYNCHRONOUS loop
		// (`while (true) {}`) never yields and freezes the plugin — the timeout
		// cannot fire. This test asserts the documented scope rather than executing
		// a hang: the timeout AC is explicitly limited to await-yielding code.
		expect(true).toBe(true);
	});
});

describe("CodeStepExecutor — error → {step}.code_error", () => {
	it.each([
		["compile error", "const x = ;"],
		["runtime throw", "throw new Error('boom');"],
		["unhandled rejection", "await Promise.reject(new Error('rejected'));"],
	])("%s fires {step}.code_error carrying message + stack and shows a Notice", async (_label, code) => {
		const notices: string[] = [];
		const { executor, writer } = makeExecutor({}, (m) => notices.push(m));
		const result = await executor.execute(request(step({ bodyContent: fenced("ts", code) })));

		expect(result.emission.topic).toBe("Verify.code_error");
		const payload = JSON.parse(result.emission.payload);
		expect(payload.step).toBe("Verify");
		expect(typeof payload.error).toBe("string");
		expect(payload.error.length).toBeGreaterThan(0);
		expect("stack" in payload).toBe(true);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatch(/Verify/);

		// turn.start AND turn.complete are written even on error.
		const types = writer.entries().map((e) => e.type);
		expect(types).toContain("turn.start");
		expect(types).toContain("turn.complete");
	});
});

describe("CodeStepExecutor — cost/identity + logging", () => {
	it("records zero cost/tokens and a null conversation_id (not an LLM turn)", async () => {
		const { executor, writer } = makeExecutor();
		const body = fenced("ts", `return orchestration.emit("tests.passed");`);
		const result = await executor.execute(request(step({ bodyContent: body })));

		expect(result.costUsd).toBe(0);
		expect(result.tokenUsage).toEqual({ input: 0, output: 0 });

		const complete = writer.entries().find((e) => e.type === "turn.complete")!;
		expect(complete.cost_usd).toBe(0);
		expect(complete.token_usage).toEqual({ input: 0, output: 0 });
		expect(complete.conversation_id).toBeNull();

		const start = writer.entries().find((e) => e.type === "turn.start")!;
		expect(start.conversation_id).toBeNull();
		expect(start.trigger_topic).toBe("build.done");
	});

	it("does not decrement the shared RunContext.budget cell (code steps are not LLM turns)", async () => {
		const { executor } = makeExecutor();
		const req = request(step({ bodyContent: fenced("ts", `return orchestration.emit("tests.passed");`) }));
		const before = { ...req.runContext.budget };
		await executor.execute(req);
		expect(req.runContext.budget).toEqual(before);
	});
});

describe("CodeStepExecutor — emit routing + default_publishes synthesis", () => {
	it("a bare (un-returned) emit is a no-op → synthesizes default_publishes", async () => {
		const { executor } = makeExecutor();
		const body = fenced("ts", `orchestration.emit("tests.passed"); /* not returned */`);
		const result = await executor.execute(
			request(step({ bodyContent: body, defaultPublishes: "tests.failed" })),
		);
		expect(result.emission).toEqual({ topic: "tests.failed", payload: "" });
	});

	it("returning nothing with no default_publishes synthesizes {step}.no_emit", async () => {
		const { executor } = makeExecutor();
		const body = fenced("ts", `const x = 1; /* returns undefined */`);
		const result = await executor.execute(
			request(step({ bodyContent: body, defaultPublishes: null })),
		);
		expect(result.emission.topic).toBe("Verify.no_emit");
	});

	it("carries structured on a terminal emit (lifted to RunResult.structured by the runner)", async () => {
		const { executor } = makeExecutor();
		const code = `return orchestration.emit("FLOW_COMPLETE", "done", { filesChanged: ["a.ts","b.ts"] });`;
		const result = await executor.execute(request(step({ bodyContent: fenced("ts", code) })));
		expect(result.emission.topic).toBe("FLOW_COMPLETE");
		expect(result.emission.structured).toEqual({ filesChanged: ["a.ts", "b.ts"] });
	});
});

describe("CodeStepExecutor — helper dispatch from a code step", () => {
	it("orchestration.callTool routes through the dispatcher and returns its output", async () => {
		const dispatcher = dispatcherReturning("tool-output");
		const { executor } = makeExecutor({ dispatcher });
		const code = `const out = await orchestration.callTool("read_note", { path: "x.md" }); return orchestration.emit("got", out);`;
		const result = await executor.execute(request(step({ bodyContent: fenced("ts", code) })));
		expect(result.emission).toEqual({ topic: "got", payload: "tool-output" });
		expect((dispatcher.dispatch as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
	});

	it("a dispatch rejection inside the step surfaces as {step}.code_error", async () => {
		const dispatcher = {
			dispatch: vi.fn(async () => ({ tool_name: "t", success: false, result: "", error: "denied" })),
		} as unknown as ToolDispatcher;
		const { executor } = makeExecutor({ dispatcher });
		const code = `await orchestration.callTool("write_note", {}); return orchestration.emit("never");`;
		const result = await executor.execute(request(step({ bodyContent: fenced("ts", code) })));
		expect(result.emission.topic).toBe("Verify.code_error");
		expect(JSON.parse(result.emission.payload).error).toMatch(/denied/);
	});
});
