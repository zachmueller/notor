import { describe, it, expect, vi } from "vitest";

// Mock the logger.
vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Mock mcp-tool-adapter (pulled in via tool-orchestration → dispatcher).
vi.mock("../mcp/mcp-tool-adapter", () => ({ isMcpTool: () => false }));

// Default: large context window so the proximity check doesn't fire.
vi.mock("../providers/model-metadata", () => ({ getContextWindow: () => 128_000 }));

import { RunLoop } from "./run-loop";
import { newRootBudget } from "./budget";
import type { RunContext, RunLoopOptions, RunLoopHooks } from "./types";
import type { LLMProvider, StreamChunk, ToolDefinition } from "../providers/provider";
import type { ToolResult, ConversationMode } from "../types";
import type { ToolDispatcher } from "../chat/dispatcher";

// ---------------------------------------------------------------------------
// Mock factories (mirrors sub-agent-runner.test.ts)
// ---------------------------------------------------------------------------

function mockProvider(...callStreams: StreamChunk[][]): LLMProvider {
	let callIndex = 0;
	return {
		sendMessage: vi.fn((): AsyncIterable<StreamChunk> => {
			const chunks = callStreams[callIndex] ?? [];
			callIndex++;
			return (async function* () {
				for (const chunk of chunks) yield chunk;
			})();
		}),
		listModels: vi.fn(async () => []),
		getTokenCount: vi.fn(() => 0),
		supportsStreaming: vi.fn(() => true),
		validateConnection: vi.fn(async () => true),
	} as unknown as LLMProvider;
}

function mockDispatcher(
	tools: Map<string, { mode: "read" | "write"; execute: (p: Record<string, unknown>) => Promise<ToolResult> }>,
	dispatchSpy?: ReturnType<typeof vi.fn>,
): ToolDispatcher {
	const dispatch = dispatchSpy ?? vi.fn(async (
		toolName: string,
		parameters: Record<string, unknown>,
	): Promise<ToolResult> => {
		const tool = tools.get(toolName);
		if (!tool) return { tool_name: toolName, success: false, result: "", error: "not found" };
		return tool.execute(parameters);
	});
	return {
		hasTool: (n: string) => tools.has(n),
		isWriteTool: (n: string) => tools.get(n)?.mode === "write",
		hasExplicitUserReadClassification: () => false,
		makePartialToolCallHandler: () => undefined,
		dispatch,
	} as unknown as ToolDispatcher;
}

function makeRunContext(overrides: Partial<RunContext> = {}): RunContext {
	return {
		depth: 0,
		maxDepth: 0,
		budget: newRootBudget(Infinity, Infinity),
		subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: 0 },
		abort: new AbortController().signal,
		...overrides,
	};
}

function buildOptions(overrides: Partial<RunLoopOptions> = {}): RunLoopOptions {
	return {
		provider: mockProvider(),
		model: "test-model",
		systemPrompt: "You are a test run.",
		toolDefinitions: [],
		dispatcher: mockDispatcher(new Map()),
		mode: "act" as ConversationMode,
		runContext: makeRunContext(),
		...overrides,
	};
}

function textStream(text: string, input = 10, output = 5): StreamChunk[] {
	return [
		{ type: "text_delta", text },
		{ type: "message_end", input_tokens: input, output_tokens: output },
	];
}

function toolCallStream(id: string, name: string, params: Record<string, unknown>, input = 15, output = 8): StreamChunk[] {
	return [
		{ type: "tool_call_start", id, tool_name: name },
		{ type: "tool_call_delta", id, partial_json: JSON.stringify(params) },
		{ type: "tool_call_end", id },
		{ type: "message_end", input_tokens: input, output_tokens: output },
	];
}

const searchToolDef: ToolDefinition = { name: "search_vault", description: "Search", input_schema: { type: "object" } };
function searchTools() {
	return new Map([
		["search_vault", { mode: "read" as const, execute: vi.fn(async () => ({ tool_name: "search_vault", success: true, result: "ok" })) }],
	]);
}

// ---------------------------------------------------------------------------
// Terminal conditions
// ---------------------------------------------------------------------------

describe("RunLoop — terminal conditions", () => {
	it("returns a RunResult with stopReason 'completed' on a text-only response", async () => {
		const loop = new RunLoop(buildOptions({ provider: mockProvider(textStream("The answer is 42.")) }));
		const result = await loop.run("Q?");
		expect(result.text).toBe("The answer is 42.");
		expect(result.structured).toBeNull();
		expect(result.stopReason).toBe("completed");
		expect(result.iterationCount).toBe(1);
		expect(result.tokenUsage).toEqual({ input: 10, output: 5 });
	});

	it("reaches 'iteration_cap' and winds down", async () => {
		const loopStream = toolCallStream("tc", "search_vault", { q: "x" }, 5, 3);
		const streams = [ [...loopStream], [...loopStream], [...loopStream], textStream("Summary.", 8, 4) ];
		const loop = new RunLoop(buildOptions({
			provider: mockProvider(...streams),
			dispatcher: mockDispatcher(searchTools()),
			toolDefinitions: [searchToolDef],
			iterationCap: 3,
		}));
		const result = await loop.run("loop");
		expect(result.stopReason).toBe("iteration_cap");
		expect(result.iterationCount).toBe(3);
		expect(result.text).toContain("[Sub-agent stopped: iteration limit (3 turns)]");
		expect(result.text).toContain("Summary.");
	});

	it("reaches 'token_limit' (post-turn) and winds down", async () => {
		const streams = [ textStream("big turn", 600, 600), textStream("Summary.", 5, 5) ];
		const loop = new RunLoop(buildOptions({
			provider: mockProvider(...streams),
			tokenLimit: 1000,
		}));
		// First turn is text-only → completes before the post-turn token check matters,
		// so use a tool-calling turn to force a second iteration past the limit.
		const toolStreams = [ toolCallStream("tc", "search_vault", {}, 600, 600), textStream("Summary.", 5, 5) ];
		const loop2 = new RunLoop(buildOptions({
			provider: mockProvider(...toolStreams),
			dispatcher: mockDispatcher(searchTools()),
			toolDefinitions: [searchToolDef],
			tokenLimit: 1000,
		}));
		const result = await loop2.run("token heavy");
		expect(result.stopReason).toBe("token_limit");
	});

	it("reaches 'context_window' via the first-iteration heuristic", async () => {
		vi.resetModules();
		const result = await (async () => {
			const loop = new RunLoop(buildOptions({
				provider: mockProvider(textStream("never reached")),
			}));
			// Force a tiny context window so the 50% heuristic trips immediately.
			// model-metadata is module-mocked to 128k by default; instead drive the
			// path by overriding getContextWindow via a fresh loop with a huge prompt.
			return loop.run("x".repeat(400_000));
		})();
		// With a 128k window and a ~100k-token prompt estimate, the 50% heuristic fires.
		expect(result.stopReason).toBe("context_window");
	});

	it("reaches 'cost_cap' when the aggregate cost ceiling is exhausted", async () => {
		// Seed a finite cost cell already at/below zero so the pre-turn gate trips.
		const ctx = makeRunContext({ maxDepth: 1, budget: newRootBudget(100, 0) });
		const loop = new RunLoop(buildOptions({
			provider: mockProvider(textStream("Summary.")),
			runContext: ctx,
		}));
		const result = await loop.run("expensive");
		expect(result.stopReason).toBe("cost_cap");
		expect(result.iterationCount).toBe(0);
	});

	it("reaches 'iteration_cap' when the aggregate iteration ceiling is exhausted", async () => {
		const ctx = makeRunContext({ maxDepth: 1, budget: newRootBudget(0, 5) });
		const loop = new RunLoop(buildOptions({
			provider: mockProvider(textStream("Summary.")),
			runContext: ctx,
		}));
		const result = await loop.run("no iterations left");
		expect(result.stopReason).toBe("iteration_cap");
	});
});

// ---------------------------------------------------------------------------
// Hook ordering & no-op safety
// ---------------------------------------------------------------------------

describe("RunLoop — hooks", () => {
	it("fires onTurnStart → (tool dispatch) → onTurnComplete in order, and onPersist", async () => {
		const order: string[] = [];
		const dispatch = vi.fn(async (): Promise<ToolResult> => {
			order.push("dispatch");
			return { tool_name: "search_vault", success: true, result: "ok" };
		});
		const hooks: RunLoopHooks = {
			onTurnStart: (t) => { order.push(`start:${t}`); },
			onTurnComplete: (t) => { order.push(`complete:${t}`); },
			onPersist: () => { order.push("persist"); },
		};
		const streams = [ toolCallStream("tc", "search_vault", {}), textStream("Done.") ];
		const loop = new RunLoop(buildOptions({
			provider: mockProvider(...streams),
			dispatcher: mockDispatcher(searchTools(), dispatch),
			toolDefinitions: [searchToolDef],
			runContext: makeRunContext({ maxDepth: 1 }),
			hooks,
		}));
		await loop.run("go");

		// Turn 1: start → dispatch → complete → persist. Turn 2: start → complete → persist (text-only).
		expect(order[0]).toBe("start:1");
		expect(order.indexOf("dispatch")).toBeGreaterThan(order.indexOf("start:1"));
		expect(order.indexOf("complete:1")).toBeGreaterThan(order.indexOf("dispatch"));
		expect(order).toContain("persist");
		expect(order).toContain("start:2");
		expect(order).toContain("complete:2");
	});

	it("runs with no hooks supplied (a missing hook is a no-op)", async () => {
		const loop = new RunLoop(buildOptions({ provider: mockProvider(textStream("Hi.")) }));
		const result = await loop.run("hello");
		expect(result.stopReason).toBe("completed");
	});

	it("a throwing hook does not crash the run", async () => {
		const hooks: RunLoopHooks = { onTurnStart: () => { throw new Error("boom"); } };
		const loop = new RunLoop(buildOptions({ provider: mockProvider(textStream("Survived.")), hooks }));
		const result = await loop.run("go");
		expect(result.text).toBe("Survived.");
		expect(result.stopReason).toBe("completed");
	});
});

// ---------------------------------------------------------------------------
// Abort cascade
// ---------------------------------------------------------------------------

describe("RunLoop — abort cascade", () => {
	it("a parent abort (runContext.abort, pre-aborted) cancels the run before the LLM call", async () => {
		const parent = new AbortController();
		parent.abort();
		const provider = mockProvider(textStream("should not run"));
		const loop = new RunLoop(buildOptions({
			provider,
			runContext: makeRunContext({ abort: parent.signal }),
		}));
		const result = await loop.run("task");
		expect(result.text).toContain("[Sub-agent cancelled]");
		expect(result.iterationCount).toBe(0);
		expect(provider.sendMessage).not.toHaveBeenCalled();
	});

	it("cleans up the parent abort listener on completion (one add + one remove)", async () => {
		const parent = new AbortController();
		const addSpy = vi.spyOn(parent.signal, "addEventListener");
		const removeSpy = vi.spyOn(parent.signal, "removeEventListener");
		const loop = new RunLoop(buildOptions({
			provider: mockProvider(textStream("Done.")),
			runContext: makeRunContext({ abort: parent.signal }),
		}));
		await loop.run("task");
		expect(addSpy).toHaveBeenCalledOnce();
		expect(removeSpy).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// Cascade seam threading (ARCH-003)
// ---------------------------------------------------------------------------

describe("RunLoop — cascade seam threading", () => {
	it("sub-agent runs (maxDepth 0, no orchestrationContext) dispatch with EXACTLY 11 positional args", async () => {
		const dispatch = vi.fn(async (): Promise<ToolResult> => ({ tool_name: "search_vault", success: true, result: "ok" }));
		const streams = [ toolCallStream("tc", "search_vault", { q: "x" }), textStream("Done.") ];
		const loop = new RunLoop(buildOptions({
			provider: mockProvider(...streams),
			dispatcher: mockDispatcher(searchTools(), dispatch),
			toolDefinitions: [searchToolDef],
			runContext: makeRunContext({ maxDepth: 0 }),
		}));
		await loop.run("go");
		expect(dispatch).toHaveBeenCalledWith(
			"search_vault", { q: "x" }, "act", "tc", expect.anything(),
			undefined, undefined, undefined, undefined, undefined, undefined,
		);
	});

	it("flow runs (maxDepth ≥ 1) thread runContext as the 12th positional arg to dispatch", async () => {
		const dispatch = vi.fn(async (): Promise<ToolResult> => ({ tool_name: "search_vault", success: true, result: "ok" }));
		const streams = [ toolCallStream("tc", "search_vault", { q: "x" }), textStream("Done.") ];
		const ctx = makeRunContext({ maxDepth: 2 });
		const loop = new RunLoop(buildOptions({
			provider: mockProvider(...streams),
			dispatcher: mockDispatcher(searchTools(), dispatch),
			toolDefinitions: [searchToolDef],
			runContext: ctx,
		}));
		await loop.run("go");
		expect(dispatch).toHaveBeenCalledWith(
			"search_vault", { q: "x" }, "act", "tc", expect.anything(),
			undefined, undefined, undefined, undefined, undefined, undefined,
			ctx, undefined,
		);
	});
});

// ---------------------------------------------------------------------------
// Budget accounting
// ---------------------------------------------------------------------------

describe("RunLoop — budget accounting", () => {
	it("decrements the shared aggregate cell once per turn (finite cell)", async () => {
		const ctx = makeRunContext({ maxDepth: 1, budget: newRootBudget(10, 5) });
		const streams = [ toolCallStream("tc", "search_vault", {}), textStream("Done.") ];
		const loop = new RunLoop(buildOptions({
			provider: mockProvider(...streams),
			dispatcher: mockDispatcher(searchTools()),
			toolDefinitions: [searchToolDef],
			runContext: ctx,
		}));
		await loop.run("go");
		// Two LLM turns ran → iterationsRemaining 10 - 2 = 8.
		expect(ctx.budget.iterationsRemaining).toBe(8);
		expect(ctx.subtreeConsumed.iterations).toBe(2);
	});

	it("an Infinity cell (sub-agent seed) is unchanged after turns", async () => {
		const ctx = makeRunContext({ budget: newRootBudget(Infinity, Infinity) });
		const loop = new RunLoop(buildOptions({ provider: mockProvider(textStream("Done.")), runContext: ctx }));
		await loop.run("go");
		expect(ctx.budget.iterationsRemaining).toBe(Infinity);
		expect(ctx.budget.costRemainingUsd).toBe(Infinity);
	});
});
