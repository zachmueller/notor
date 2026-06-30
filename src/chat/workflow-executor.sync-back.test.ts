/**
 * Regression: manual (foreground) workflow turns must sync their final session
 * state back into the **display** ConversationManager, so follow-up messages —
 * which snapshot the display manager — see the full workflow turn (assistant +
 * tool messages), not just the initial workflow user message.
 *
 * Without the sync-back, the workflow turn lives only in the isolated session
 * manager (and on disk), and the panel's follow-up turn assembles from stale
 * display state — the "follow-ups ignore all prior context" detach bug.
 *
 * Two layers are covered:
 *  - `syncSessionToDisplay()` directly (the canonical reconcile helper that
 *    ChatOrchestrator.runSession() calls), including the switched-away guard.
 *  - the WorkflowExecutor foreground path delegating to the injected
 *    `runSession` bridge so the reconcile actually happens.
 *
 * @see ideas/Workflow chat panel conversation detaches from active chat.md
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
vi.mock("../ui/os-notification", () => ({
	showOsNotification: vi.fn(),
	revealChatPanel: vi.fn(),
}));

import { WorkflowExecutor, type WorkflowExecutorDeps } from "./workflow-executor";
import { ConversationManager } from "./conversation";
import { ConversationSession, syncSessionToDisplay } from "./conversation-session";
import type { Workflow } from "../types";

type NotorSettingsLike = WorkflowExecutorDeps extends { getSettings(): infer S } ? S : never;

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

/** Build a minimal session whose isolated manager mirrors the display one. */
function makeSession(displayManager: ConversationManager): ConversationSession {
	const conv = displayManager.getActiveConversation()!;
	const sessionManager = new ConversationManager("act");
	sessionManager.loadConversation(conv, displayManager.getMessages());
	return new ConversationSession({
		conversationId: conv.id,
		conversationManager: sessionManager,
		abortController: new AbortController(),
		title: conv.title ?? "Untitled",
		pinnedPersona: null,
		providerId: "p1",
		modelId: "m1",
		useExtendedContext: false,
		thinkingLevel: null,
		approvalCallback: async () => "approved" as const,
		initialConfig: { tools: {} } as never,
		initialParsedConfigs: [],
	});
}

describe("syncSessionToDisplay", () => {
	it("loads the session's final messages into the display manager (same conversation)", () => {
		const display = new ConversationManager("act");
		display.createConversation("p1", "m1", "act", { title: "Workflow: summarize" });
		display.addMessage({ role: "user", content: "kick off", is_workflow_message: true });

		const session = makeSession(display);
		session.conversationManager.addMessage({ role: "assistant", content: "Working." });
		session.conversationManager.addMessage({ role: "tool_result", content: "tool result" });
		session.conversationManager.addMessage({ role: "assistant", content: "Done." });

		syncSessionToDisplay(display, session);

		const roles = display.getMessages().map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "tool_result", "assistant"]);
		expect(display.getMessages().some((m) => m.content === "Done.")).toBe(true);
	});

	it("skips the sync (no clobber) when the display manager switched to another conversation", () => {
		const display = new ConversationManager("act");
		display.createConversation("p1", "m1", "act", { title: "Workflow: summarize" });
		display.addMessage({ role: "user", content: "kick off", is_workflow_message: true });

		const session = makeSession(display);
		session.conversationManager.addMessage({ role: "assistant", content: "Workflow answer." });

		// User navigates away mid-turn.
		display.createConversation("p1", "m1", "act", { title: "Other chat" });
		display.addMessage({ role: "user", content: "unrelated" });

		syncSessionToDisplay(display, session);

		expect(display.getActiveConversation()?.title).toBe("Other chat");
		expect(display.getMessages().some((m) => m.content === "Workflow answer.")).toBe(false);
	});
});

/**
 * Deps for the foreground executor path. `runSession` mimics the orchestrator's
 * real lifecycle just enough: run the preLoop, simulate the LLM turn on the
 * session's isolated manager, then reconcile via the real syncSessionToDisplay.
 */
function makeDeps(displayManager: ConversationManager): WorkflowExecutorDeps {
	const settings = {
		mode: "act",
		memory_enabled: false,
		model_pricing: {},
	} as unknown as NotorSettingsLike;

	const runSession = vi.fn(
		async (
			session: ConversationSession,
			_mode: unknown,
			opts?: { preLoop?: () => Promise<void> },
		) => {
			if (opts?.preLoop) await opts.preLoop();
			session.conversationManager.addMessage({ role: "assistant", content: "Working on it." });
			session.conversationManager.addMessage({ role: "tool_result", content: "tool result" });
			session.conversationManager.addMessage({ role: "assistant", content: "Done — here is the summary." });
			syncSessionToDisplay(displayManager, session);
		},
	);

	return {
		app: { vault: {}, metadataCache: {} },
		providerRegistry: {
			getActiveId: () => "p1",
			getConfig: () => ({ model_id: "m1", use_extended_context: false }),
			getProvider: () => ({}),
		},
		systemPromptBuilder: { assemble: vi.fn(async () => "system") },
		dispatcher: { dispatch: vi.fn(), makePartialToolCallHandler: () => () => {} },
		historyManager: {
			appendMessage: vi.fn(async () => {}),
			updateConversationHeader: vi.fn(async () => {}),
			createConversationFile: vi.fn(async () => {}),
			flushConversation: vi.fn(async () => {}),
		},
		sessionManager: {
			checkSessionGuards: vi.fn(() => null),
			registerSession: vi.fn(),
			unregisterSession: vi.fn(),
		},
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
		getConversationManager: () => displayManager,
		getActiveProviderId: () => "p1",
		getActiveModelId: () => "m1",
		getActiveUseExtendedContext: () => false,
		getActivePersona: () => null,
		setActivePersona: () => {},
		getVaultRootPath: () => undefined,
		getTemplateRegistry: () => undefined,
		getSessionContext: () => ({}),
		runSession,
		setWorkflowPersonaRevert: () => {},
		handleError: (e: unknown) => { throw e; },
	} as unknown as WorkflowExecutorDeps;
}

describe("WorkflowExecutor foreground path → display sync-back", () => {
	beforeEach(() => vi.clearAllMocks());

	it("delegates to runSession and leaves the workflow turn in the display manager", async () => {
		const display = new ConversationManager("act");
		const executor = new WorkflowExecutor(makeDeps(display));

		await executor.executeWorkflow(makeWorkflow(), "summarize the note");

		const messages = display.getMessages();
		const roles = messages.map((m) => m.role);
		expect(roles).toContain("assistant");
		expect(roles).toContain("tool_result");
		expect(messages.some((m) => m.content === "Done — here is the summary.")).toBe(true);
		// The initial workflow user message is still present.
		expect(messages.some((m) => m.role === "user" && m.is_workflow_message)).toBe(true);
	});
});
