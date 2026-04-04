import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the logger
vi.mock("../utils/logger", () => ({
	logger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

// Mock mcp-tool-adapter (required by tool-orchestration → dispatcher)
vi.mock("../mcp/mcp-tool-adapter", () => ({
	isMcpTool: () => false,
}));

// Mock model-metadata — return a large context window so it doesn't trigger
vi.mock("../providers/model-metadata", () => ({
	getContextWindow: () => 128_000,
}));

import { SubAgentRunner, type SubAgentResult, type SubAgentRunnerOptions } from "./sub-agent-runner";
import type { LLMProvider, ChatMessage, StreamChunk, SendMessageOptions, ToolDefinition } from "../providers/provider";
import type { ToolResult, ConversationMode } from "../types";
import type { ToolDispatcher } from "./dispatcher";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * Create a mock provider that yields the given stream chunks for each
 * successive call to sendMessage().
 */
function mockProvider(
	...callStreams: StreamChunk[][]
): LLMProvider {
	let callIndex = 0;
	return {
		sendMessage: vi.fn((): AsyncIterable<StreamChunk> => {
			const chunks = callStreams[callIndex] ?? [];
			callIndex++;
			return (async function* () {
				for (const chunk of chunks) {
					yield chunk;
				}
			})();
		}),
		listModels: vi.fn(async () => []),
		getTokenCount: vi.fn(() => 0),
		supportsStreaming: vi.fn(() => true),
		validateConnection: vi.fn(async () => true),
	} as unknown as LLMProvider;
}

/**
 * Create a minimal mock ToolDispatcher.
 */
function mockDispatcher(
	tools: Map<string, { mode: "read" | "write"; execute: (params: Record<string, unknown>) => Promise<ToolResult> }>,
): ToolDispatcher {
	return {
		hasTool: (name: string) => tools.has(name),
		isWriteTool: (name: string) => tools.get(name)?.mode === "write",
		hasExplicitUserReadClassification: () => false,
		dispatch: vi.fn(async (
			toolName: string,
			parameters: Record<string, unknown>,
			_mode: ConversationMode,
			_messageId: string,
			_abortSignal?: AbortSignal,
		): Promise<ToolResult> => {
			const tool = tools.get(toolName);
			if (!tool) {
				return {
					tool_name: toolName,
					success: false,
					result: "",
					error: `Tool not found: ${toolName}`,
				};
			}
			return tool.execute(parameters);
		}),
	} as unknown as ToolDispatcher;
}

/** Build default runner options, overriding specific fields. */
function buildOptions(overrides: Partial<SubAgentRunnerOptions> = {}): SubAgentRunnerOptions {
	return {
		provider: mockProvider(),
		model: "test-model",
		systemPrompt: "You are a test sub-agent.",
		toolDefinitions: [],
		dispatcher: mockDispatcher(new Map()),
		parentAbortSignal: new AbortController().signal,
		mode: "act" as ConversationMode,
		...overrides,
	};
}

// Helper: text-only response stream
function textStream(text: string, inputTokens = 10, outputTokens = 5): StreamChunk[] {
	return [
		{ type: "text_delta", text },
		{ type: "message_end", input_tokens: inputTokens, output_tokens: outputTokens },
	];
}

// Helper: tool call stream followed by text on next turn
function toolCallStream(
	id: string,
	name: string,
	params: Record<string, unknown>,
	inputTokens = 15,
	outputTokens = 8,
): StreamChunk[] {
	return [
		{ type: "tool_call_start", id, tool_name: name },
		{ type: "tool_call_delta", id, partial_json: JSON.stringify(params) },
		{ type: "tool_call_end", id },
		{ type: "message_end", input_tokens: inputTokens, output_tokens: outputTokens },
	];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SubAgentRunner", () => {
	describe("basic completion", () => {
		it("returns immediately on text-only first response", async () => {
			const provider = mockProvider(textStream("The answer is 42."));
			const runner = new SubAgentRunner(buildOptions({ provider }));

			const result = await runner.run("What is the meaning of life?");

			expect(result.text).toBe("The answer is 42.");
			expect(result.iterationCount).toBe(1);
			expect(result.stopReason).toBe("completed");
			expect(result.tokenUsage.input).toBe(10);
			expect(result.tokenUsage.output).toBe(5);
		});

		it("includes system and user messages in result", async () => {
			const provider = mockProvider(textStream("Done."));
			const runner = new SubAgentRunner(buildOptions({
				provider,
				systemPrompt: "Test system prompt",
			}));

			const result = await runner.run("Task prompt");

			// system + user + assistant (final response)
			expect(result.messages).toHaveLength(3);
			expect(result.messages[0]!.role).toBe("system");
			expect(result.messages[0]!.content).toBe("Test system prompt");
			expect(result.messages[1]!.role).toBe("user");
			expect(result.messages[1]!.content).toBe("Task prompt");
			expect(result.messages[2]!.role).toBe("assistant");
			expect(result.messages[2]!.content).toBe("Done.");
		});
	});

	describe("tool call loop", () => {
		it("dispatches tool call then returns text response", async () => {
			const searchResult: ToolResult = {
				tool_name: "search_vault",
				success: true,
				result: "Found 3 notes about testing.",
			};

			const tools = new Map([
				["search_vault", {
					mode: "read" as const,
					execute: vi.fn(async () => searchResult),
				}],
			]);

			const toolDefs: ToolDefinition[] = [{
				name: "search_vault",
				description: "Search the vault",
				input_schema: { type: "object", properties: { query: { type: "string" } } },
			}];

			const provider = mockProvider(
				// Turn 1: LLM requests a tool call
				toolCallStream("tc-1", "search_vault", { query: "testing" }),
				// Turn 2: LLM returns final text
				textStream("I found 3 notes about testing.", 12, 6),
			);

			const dispatcher = mockDispatcher(tools);
			const runner = new SubAgentRunner(buildOptions({
				provider,
				dispatcher,
				toolDefinitions: toolDefs,
			}));

			const result = await runner.run("Search for notes about testing");

			expect(result.text).toBe("I found 3 notes about testing.");
			expect(result.iterationCount).toBe(2);
			expect(result.stopReason).toBe("completed");
			// Token usage accumulated across both turns
			expect(result.tokenUsage.input).toBe(15 + 12);
			expect(result.tokenUsage.output).toBe(8 + 6);
			// Dispatcher was called
			expect(dispatcher.dispatch).toHaveBeenCalledWith(
				"search_vault",
				{ query: "testing" },
				"act",
				"tc-1",
				expect.anything(), // AbortSignal
				undefined, // onProgress (not used by sub-agent runner)
			);
		});

		it("handles multiple tool calls in a single turn", async () => {
			const tools = new Map([
				["search_vault", {
					mode: "read" as const,
					execute: vi.fn(async () => ({
						tool_name: "search_vault",
						success: true,
						result: "Result A",
					})),
				}],
				["read_note", {
					mode: "read" as const,
					execute: vi.fn(async () => ({
						tool_name: "read_note",
						success: true,
						result: "Note content",
					})),
				}],
			]);

			const toolDefs: ToolDefinition[] = [
				{ name: "search_vault", description: "Search", input_schema: { type: "object" } },
				{ name: "read_note", description: "Read", input_schema: { type: "object" } },
			];

			const provider = mockProvider(
				// Turn 1: two tool calls
				[
					{ type: "tool_call_start", id: "tc-1", tool_name: "search_vault" },
					{ type: "tool_call_delta", id: "tc-1", partial_json: '{"query":"test"}' },
					{ type: "tool_call_end", id: "tc-1" },
					{ type: "tool_call_start", id: "tc-2", tool_name: "read_note" },
					{ type: "tool_call_delta", id: "tc-2", partial_json: '{"path":"note.md"}' },
					{ type: "tool_call_end", id: "tc-2" },
					{ type: "message_end", input_tokens: 20, output_tokens: 10 },
				],
				// Turn 2: final text
				textStream("Combined results ready.", 8, 4),
			);

			const dispatcher = mockDispatcher(tools);
			const runner = new SubAgentRunner(buildOptions({
				provider,
				dispatcher,
				toolDefinitions: toolDefs,
			}));

			const result = await runner.run("Search and read");

			expect(result.text).toBe("Combined results ready.");
			expect(result.iterationCount).toBe(2);
			expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
		});
	});

	describe("iteration cap", () => {
		it("returns with stopReason 'iteration_cap' when iteration limit is hit", async () => {
			// Provider always returns tool calls, never text-only
			const toolStream = toolCallStream("tc-loop", "search_vault", { q: "x" }, 5, 3);
			const streams: StreamChunk[][] = Array.from({ length: 3 }, () => [...toolStream]);
			// 4th stream: wind-down summary response
			const summaryStream = textStream("Summary: searched 3 times.", 8, 4);
			streams.push(summaryStream);

			const tools = new Map([
				["search_vault", {
					mode: "read" as const,
					execute: vi.fn(async () => ({
						tool_name: "search_vault",
						success: true,
						result: "Found something",
					})),
				}],
			]);

			const provider = mockProvider(...streams);
			const runner = new SubAgentRunner(buildOptions({
				provider,
				dispatcher: mockDispatcher(tools),
				toolDefinitions: [{ name: "search_vault", description: "Search", input_schema: { type: "object" } }],
				iterationCap: 3,
			}));

			const result = await runner.run("Keep searching");

			expect(result.stopReason).toBe("iteration_cap");
			expect(result.iterationCount).toBe(3);
			// Wind-down produces a structured marker + summary
			expect(result.text).toContain("[Sub-agent stopped: iteration limit (3 turns)]");
			expect(result.text).toContain("Summary: searched 3 times.");
			// Token usage: 3 iterations × (5 input + 3 output) + wind-down (8 + 4)
			expect(result.tokenUsage.input).toBe(23);
			expect(result.tokenUsage.output).toBe(13);
		});
	});

	describe("error handling", () => {
		it("fails fast on provider stream error", async () => {
			const provider = mockProvider([
				{ type: "text_delta", text: "Partial..." },
				{ type: "error", error: "Rate limit exceeded" },
			]);

			const runner = new SubAgentRunner(buildOptions({ provider }));
			const result = await runner.run("Do something");

			expect(result.text).toContain("Sub-agent error");
			expect(result.text).toContain("Rate limit exceeded");
			expect(result.iterationCount).toBe(1);
			expect(result.stopReason).toBe("completed");
		});

		it("feeds tool execution errors back to the LLM", async () => {
			const tools = new Map([
				["search_vault", {
					mode: "read" as const,
					execute: vi.fn(async () => ({
						tool_name: "search_vault",
						success: false,
						result: "",
						error: "Index not available",
					})),
				}],
			]);

			const provider = mockProvider(
				// Turn 1: tool call
				toolCallStream("tc-err", "search_vault", { query: "test" }),
				// Turn 2: LLM responds to error with text
				textStream("Search failed, the index is not available."),
			);

			const dispatcher = mockDispatcher(tools);
			const runner = new SubAgentRunner(buildOptions({
				provider,
				dispatcher,
				toolDefinitions: [{ name: "search_vault", description: "Search", input_schema: { type: "object" } }],
			}));

			const result = await runner.run("Search for test");

			expect(result.text).toBe("Search failed, the index is not available.");
			expect(result.iterationCount).toBe(2);
			// The error result was sent back to the LLM as a tool_result
			const toolResultMsg = result.messages.find(
				m => m.role === "tool_result" && m.tool_results?.[0]?.is_error,
			);
			expect(toolResultMsg).toBeDefined();
			expect(toolResultMsg!.tool_results![0]!.result).toBe("Index not available");
		});
	});

	describe("abort handling", () => {
		it("returns partial result when parent aborts before LLM call", async () => {
			const parentController = new AbortController();
			parentController.abort(); // Already aborted

			const provider = mockProvider(textStream("Should not reach this"));
			const runner = new SubAgentRunner(buildOptions({
				provider,
				parentAbortSignal: parentController.signal,
			}));

			const result = await runner.run("Task");

			expect(result.text).toContain("[Sub-agent cancelled]");
			expect(result.iterationCount).toBe(0);
			expect(result.stopReason).toBe("completed");
			// Provider should not have been called
			expect(provider.sendMessage).not.toHaveBeenCalled();
		});

		it("returns partial result when aborted during stream", async () => {
			const parentController = new AbortController();

			// Provider that aborts mid-stream
			const provider: LLMProvider = {
				sendMessage: vi.fn((): AsyncIterable<StreamChunk> => {
					return (async function* () {
						yield { type: "text_delta" as const, text: "Partial output" };
						// Simulate abort happening during streaming
						parentController.abort();
						yield { type: "text_delta" as const, text: " more" };
						yield { type: "message_end" as const, input_tokens: 10, output_tokens: 5 };
					})();
				}),
				listModels: vi.fn(async () => []),
				getTokenCount: vi.fn(() => 0),
				supportsStreaming: vi.fn(() => true),
				validateConnection: vi.fn(async () => true),
			} as unknown as LLMProvider;

			const runner = new SubAgentRunner(buildOptions({
				provider,
				parentAbortSignal: parentController.signal,
			}));

			const result = await runner.run("Task");

			expect(result.text).toContain("[Sub-agent cancelled]");
			expect(result.stopReason).toBe("completed");
		});

		it("cleans up parent abort listener on completion", async () => {
			const parentController = new AbortController();
			const provider = mockProvider(textStream("Done."));

			const addSpy = vi.spyOn(parentController.signal, "addEventListener");
			const removeSpy = vi.spyOn(parentController.signal, "removeEventListener");

			const runner = new SubAgentRunner(buildOptions({
				provider,
				parentAbortSignal: parentController.signal,
			}));

			await runner.run("Task");

			expect(addSpy).toHaveBeenCalledOnce();
			expect(removeSpy).toHaveBeenCalledOnce();
		});
	});

	describe("onProgress callback", () => {
		it("calls onProgress after each iteration", async () => {
			const onProgress = vi.fn();

			const tools = new Map([
				["search_vault", {
					mode: "read" as const,
					execute: vi.fn(async () => ({
						tool_name: "search_vault",
						success: true,
						result: "Found it",
					})),
				}],
			]);

			const provider = mockProvider(
				toolCallStream("tc-1", "search_vault", { q: "x" }),
				textStream("Done."),
			);

			const runner = new SubAgentRunner(buildOptions({
				provider,
				dispatcher: mockDispatcher(tools),
				toolDefinitions: [{ name: "search_vault", description: "Search", input_schema: { type: "object" } }],
				onProgress,
			}));

			await runner.run("Search");

			// onProgress called: once at start of turn 1, once after tool exec, once at start of turn 2
			expect(onProgress).toHaveBeenCalled();
			// First call should indicate turn number
			const firstCall = onProgress.mock.calls[0]![0];
			expect(firstCall).toContain("1/");
		});
	});

	describe("token accumulation", () => {
		it("accumulates tokens across multiple iterations", async () => {
			const tools = new Map([
				["search_vault", {
					mode: "read" as const,
					execute: vi.fn(async () => ({
						tool_name: "search_vault",
						success: true,
						result: "OK",
					})),
				}],
			]);

			const provider = mockProvider(
				toolCallStream("tc-1", "search_vault", {}, 100, 50),
				toolCallStream("tc-2", "search_vault", {}, 200, 80),
				textStream("Final answer.", 150, 60),
			);

			const runner = new SubAgentRunner(buildOptions({
				provider,
				dispatcher: mockDispatcher(tools),
				toolDefinitions: [{ name: "search_vault", description: "Search", input_schema: { type: "object" } }],
			}));

			const result = await runner.run("Multi-step search");

			expect(result.tokenUsage.input).toBe(100 + 200 + 150);
			expect(result.tokenUsage.output).toBe(50 + 80 + 60);
			expect(result.iterationCount).toBe(3);
		});
	});

	describe("Plan mode enforcement", () => {
		it("passes Plan mode to dispatcher for tool execution", async () => {
			const tools = new Map([
				["write_note", {
					mode: "write" as const,
					execute: vi.fn(async () => ({
						tool_name: "write_note",
						success: false,
						result: "",
						error: "Write tools are blocked in Plan mode",
					})),
				}],
			]);

			const provider = mockProvider(
				toolCallStream("tc-1", "write_note", { path: "test.md", content: "hello" }),
				textStream("Could not write — blocked in Plan mode."),
			);

			const dispatcher = mockDispatcher(tools);
			const runner = new SubAgentRunner(buildOptions({
				provider,
				dispatcher,
				toolDefinitions: [{ name: "write_note", description: "Write", input_schema: { type: "object" } }],
				mode: "plan",
			}));

			const result = await runner.run("Write a note");

			// Dispatcher was called with "plan" mode
			expect(dispatcher.dispatch).toHaveBeenCalledWith(
				"write_note",
				expect.anything(),
				"plan",
				expect.anything(),
				expect.anything(), // AbortSignal
				undefined, // onProgress
			);
			expect(result.iterationCount).toBe(2);
		});
	});
});
