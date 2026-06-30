/**
 * INT-031 — step→workflow invocation (`WorkflowExecutor.runWorkflowHeadless`).
 *
 * Asserts the distinctive INT-031 behavior: a named workflow runs to completion
 * through the **background loop** (one `dispatcher.dispatch()` per tool-call
 * iteration, NOT `executeToolBatches`), and its final assistant text + total
 * spend are returned for the invoking step to fold into its context and
 * reconcile into the aggregate budget. (The reconciliation itself is covered in
 * the StepTurnExecutor; here we assert the loop is driven and the result shape.)
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-5-interactive-workflow.md — INT-031
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../mcp/mcp-tool-adapter", () => ({ isMcpTool: () => false }));
vi.mock("../providers/model-metadata", () => ({
	getContextWindow: () => 128_000,
	getModelMetadata: () => null,
}));
// No vault read — return a fixed assembled prompt.
vi.mock("../workflows/workflow-executor", () => ({
	assembleWorkflowPrompt: vi.fn(async () => ({
		assembledMessage: "<workflow_instructions>do the thing</workflow_instructions>",
		workflowName: "summarize",
		attachments: [],
		toolConfigs: [],
	})),
	switchWorkflowPersona: vi.fn(),
	revertWorkflowPersona: vi.fn(),
}));
vi.mock("../context/auto-context", () => ({ buildAutoContextBlock: () => null }));
// os-notification transitively pulls in chat-view → settings-popover (Modal),
// which the obsidian mock doesn't class-export — stub the two used helpers.
vi.mock("../ui/os-notification", () => ({
	showOsNotification: vi.fn(),
	revealChatPanel: vi.fn(),
}));

import { WorkflowExecutor, type WorkflowExecutorDeps } from "./workflow-executor";
import { ConversationManager } from "./conversation";
import type { LLMProvider, StreamChunk } from "../providers/provider";
import type { Workflow } from "../types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A provider whose successive sendMessage() calls yield the given chunk streams. */
function mockProvider(...callStreams: StreamChunk[][]): LLMProvider {
	let i = 0;
	return {
		sendMessage: vi.fn((): AsyncIterable<StreamChunk> => {
			const chunks = callStreams[i] ?? [];
			i++;
			return (async function* () {
				for (const c of chunks) yield c;
			})();
		}),
		listModels: vi.fn(async () => []),
		getTokenCount: vi.fn(() => 0),
		supportsStreaming: vi.fn(() => true),
		validateConnection: vi.fn(async () => true),
	} as unknown as LLMProvider;
}

const TEXT = (text: string): StreamChunk[] => [
	{ type: "text_delta", text } as unknown as StreamChunk,
	{ type: "message_end", inputTokens: 100, outputTokens: 50, stop_reason: "end_turn" } as unknown as StreamChunk,
];
const TOOL = (id: string, name: string): StreamChunk[] => [
	{ type: "tool_call_start", id, tool_name: name } as unknown as StreamChunk,
	{ type: "tool_call_end", id, tool_name: name, parameters: {} } as unknown as StreamChunk,
	{ type: "message_end", inputTokens: 100, outputTokens: 50, stop_reason: "tool_use" } as unknown as StreamChunk,
];

function makeWorkflow(): Workflow {
	return {
		file_path: "notor/workflows/summarize.md",
		file_name: "summarize.md",
		display_name: "summarize",
		aliases: [],
		trigger: "manual",
		schedule: null,
	} as unknown as Workflow;
}

function makeDeps(provider: LLMProvider, dispatch: ReturnType<typeof vi.fn>): {
	deps: WorkflowExecutorDeps;
	conversations: ConversationManager[];
} {
	const conversations: ConversationManager[] = [];
	const settings = {
		mode: "act",
		memory_enabled: false,
		model_pricing: {},
	} as unknown as WorkflowExecutorDeps extends { getSettings(): infer S } ? S : never;

	// Patch ConversationManager to track instances created inside runWorkflowHeadless.
	const OrigCM = ConversationManager;
	const dispatcher = {
		dispatch,
		makePartialToolCallHandler: () => () => {},
	};

	const deps = {
		app: { vault: {}, metadataCache: {} },
		providerRegistry: {
			getActiveId: () => "p1",
			getConfig: () => ({ model_id: "m1", use_extended_context: false }),
			getProvider: () => provider,
		},
		systemPromptBuilder: { assemble: vi.fn(async () => "system") },
		dispatcher,
		historyManager: {
			appendMessage: vi.fn(async () => {}),
			updateConversationHeader: vi.fn(async () => {}),
			createConversationFile: vi.fn(async () => {}),
		},
		sessionManager: {},
		configResolver: {
			resolveEffectiveConfig: vi.fn(async () => ({
				effective: { tools: {} },
				toolDefinitions: [],
				parsedConfigs: [],
			})),
		},
		hookDispatcher: {
			dispatchToolCallHook: vi.fn(),
			dispatchToolResultHook: vi.fn(),
			dispatchApprovalRequiredHook: vi.fn(async () => "approved"),
		},
		viewRouter: { getView: () => undefined, getViewForSession: () => undefined },
		getSettings: () => settings,
		getPersonaManager: () => undefined,
		getWorkflowHookOverrideManager: () => undefined,
		getVaultRuleManager: () => undefined,
		getPanelApprovalCallback: () => undefined,
		getPanelInteractionCallback: () => undefined,
		getConversationManager: () => new OrigCM("act"),
		getActiveProviderId: () => "p1",
		getActiveModelId: () => "m1",
		getActiveUseExtendedContext: () => false,
		getActivePersona: () => null,
		setActivePersona: () => {},
		getVaultRootPath: () => undefined,
		getTemplateRegistry: () => undefined,
		getSessionContext: () => ({}),
		runSession: vi.fn(async () => {}),
		setWorkflowPersonaRevert: () => {},
		handleError: () => {},
	} as unknown as WorkflowExecutorDeps;

	return { deps, conversations };
}

describe("WorkflowExecutor.runWorkflowHeadless (INT-031)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("drives the background loop one dispatch() per tool-call iteration, then returns the final assistant text", async () => {
		// Two tool-call turns, then a final text turn.
		const provider = mockProvider(
			TOOL("t1", "read_note"),
			TOOL("t2", "read_note"),
			TEXT("Here is the summary."),
		);
		const dispatch = vi.fn(async () => ({
			tool_name: "read_note",
			success: true,
			result: "ok",
		}));

		const { deps } = makeDeps(provider, dispatch);
		const executor = new WorkflowExecutor(deps);

		const result = await executor.runWorkflowHeadless(makeWorkflow(), "summarize the note");

		// One dispatch per tool-call iteration (background loop: one tool at a time),
		// NOT a batched executeToolBatches call.
		expect(dispatch).toHaveBeenCalledTimes(2);
		// The final assistant text is returned into the step's context.
		expect(result.text).toBe("Here is the summary.");
		// Iterations counted (assistant turns) and cost reported for reconciliation.
		expect(result.iterations).toBeGreaterThanOrEqual(1);
		expect(typeof result.costUsd).toBe("number");
	});

	it("returns immediately (zero dispatches) for a workflow that emits only final text", async () => {
		const provider = mockProvider(TEXT("Direct answer."));
		const dispatch = vi.fn();
		const { deps } = makeDeps(provider, dispatch);
		const executor = new WorkflowExecutor(deps);

		const result = await executor.runWorkflowHeadless(makeWorkflow(), "answer directly");
		expect(dispatch).not.toHaveBeenCalled();
		expect(result.text).toBe("Direct answer.");
	});

	it("throws when the workflow assembles to no prompt content", async () => {
		const wfMod = await import("../workflows/workflow-executor");
		(wfMod.assembleWorkflowPrompt as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
		const provider = mockProvider(TEXT("unused"));
		const { deps } = makeDeps(provider, vi.fn());
		const executor = new WorkflowExecutor(deps);
		await expect(executor.runWorkflowHeadless(makeWorkflow(), "x")).rejects.toThrow(
			/no prompt content/i,
		);
	});
});
