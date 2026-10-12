/**
 * Regression: a Quick Settings model switch made while a turn is running must
 * survive the turn — neither the end-of-turn display sync-back (revert path
 * #1) nor the session's own JSONL header writes (revert path #2) may restore
 * the selection the session started with.
 *
 * @see ideas/Make Quick Settings model switching robust across providers.md
 */

import { describe, it, expect, vi } from "vitest";
import type { Vault } from "obsidian";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../providers/model-metadata", () => ({
	getContextWindow: () => 128_000,
	getModelMetadata: () => null,
	getModelExtendedContext: () => undefined,
}));

import { ConversationManager } from "./conversation";
import { ConversationSession, syncSessionToDisplay } from "./conversation-session";
import { HistoryManager } from "./history";
import { readSelection, type ModelSelection } from "./model-selection";

const HISTORY = ".obsidian/plugins/notor/history/";

/** Minimal stateful adapter (same shape as history.test.ts). */
function makeStatefulVault(): { vault: Vault; files: Record<string, string> } {
	const files: Record<string, string> = {};
	const dirs = new Set<string>([HISTORY.replace(/\/$/, ""), HISTORY]);
	const adapter = {
		exists: async (p: string) => p in files || dirs.has(p),
		mkdir: async (p: string) => { dirs.add(p); },
		list: async () => ({ files: Object.keys(files), folders: [] }),
		read: async (p: string) => {
			if (!(p in files)) throw new Error(`ENOENT: ${p}`);
			return files[p]!;
		},
		write: async (p: string, data: string) => { files[p] = data; },
		append: async (p: string, data: string) => { files[p] = (files[p] ?? "") + data; },
		process: async (p: string, fn: (content: string) => string): Promise<string> => {
			files[p] = fn(files[p] ?? "");
			return files[p]!;
		},
		stat: async () => ({ mtime: 0, size: 0 }),
	};
	return { vault: { adapter } as unknown as Vault, files };
}

const OLD: ModelSelection = {
	providerId: "bedrock",
	modelId: "opus",
	useExtendedContext: false,
	thinkingLevel: "high",
	presetName: "large",
};
const NEW: ModelSelection = {
	providerId: "anthropic",
	modelId: "sonnet",
	useExtendedContext: false,
	thinkingLevel: null,
	presetName: null,
};

/** Build a display manager + a session snapshotted from it, as createSessionFromDisplay does. */
function makeSession(historyManager?: HistoryManager): { display: ConversationManager; session: ConversationSession } {
	const display = new ConversationManager("act");
	display.createConversation(OLD.providerId, OLD.modelId, "act", {
		thinking_level: OLD.thinkingLevel,
		preset_name: OLD.presetName,
	});
	display.addMessage({ role: "user", content: "start" });
	const conv = display.getActiveConversation()!;

	const sessionManager = new ConversationManager("act");
	if (historyManager) {
		sessionManager.setOnMessageAdded(async (m) => {
			await historyManager.appendMessage(sessionManager.getActiveConversation()!, m);
		});
		sessionManager.setOnConversationChanged(async (c) => {
			await historyManager.updateConversationHeader(c);
		});
	}
	sessionManager.loadConversation(conv, display.getMessages(), { silent: true });
	const session = new ConversationSession({
		conversationId: conv.id,
		conversationManager: sessionManager,
		abortController: new AbortController(),
		title: "t",
		pinnedPersona: null,
		...OLD,
		approvalCallback: async () => "approved" as const,
		initialConfig: { tools: {} } as never,
		initialParsedConfigs: [],
	});
	return { display, session };
}

/** What ChatOrchestrator.commitModelSelection does for a running turn. */
function switchMidTurn(display: ConversationManager, session: ConversationSession, sel: ModelSelection): void {
	display.setModelSelection(sel);
	session.setSelection(sel);
}

describe("ConversationSession.setSelection", () => {
	it("updates the live selection getters", () => {
		const { session } = makeSession();
		expect(session.modelId).toBe("opus");
		session.setSelection(NEW);
		expect(session.selection).toEqual(NEW);
		expect(session.providerId).toBe("anthropic");
		expect(session.modelId).toBe("sonnet");
		expect(session.thinkingLevel).toBeNull();
	});

	it("mirrors the selection onto the session's own conversation header", () => {
		const { session } = makeSession();
		session.setSelection(NEW);
		expect(readSelection(session.conversationManager.getActiveConversation()!)).toEqual(NEW);
	});

	it("returns a copy so callers cannot mutate the live selection", () => {
		const { session } = makeSession();
		const snap = session.selection;
		snap.modelId = "tampered";
		expect(session.modelId).toBe("opus");
	});
});

describe("ConversationManager.setModelSelection", () => {
	// Root cause: getActiveConversation() returns a COPY, so writing the
	// selection onto it (the old Quick Settings path) never reached the
	// in-memory header the next turn resolves from.
	it("updates the live header, unlike mutating the getActiveConversation() copy", () => {
		const { display } = makeSession();
		const copy = display.getActiveConversation()!;
		copy.model_id = "copy-only";
		expect(display.getActiveConversation()!.model_id).toBe("opus");

		display.setModelSelection(NEW, "writer");
		expect(readSelection(display.getActiveConversation()!)).toEqual(NEW);
		expect(display.getActiveConversation()!.persona_name).toBe("writer");
	});
});

describe("syncSessionToDisplay keeps the display selection (revert path #1)", () => {
	it("does not restore the session's stale selection onto the display header", () => {
		const { display, session } = makeSession();
		// Display changed but the session copy was NOT updated (worst case).
		display.setModelSelection(NEW);
		session.conversationManager.addMessage({ role: "assistant", content: "done" });

		syncSessionToDisplay(display, session);

		expect(readSelection(display.getActiveConversation()!)).toEqual(NEW);
		// Messages still sync.
		expect(display.getMessages().map((m) => m.content)).toEqual(["start", "done"]);
	});
});

describe("mid-turn switch persists to JSONL (revert path #2)", () => {
	it("session header writes after the switch carry the new selection", async () => {
		const { vault, files } = makeStatefulVault();
		const historyManager = new HistoryManager(vault, HISTORY, 500, 90);
		const { display, session } = makeSession(historyManager);
		await historyManager.createConversationFile(display.getActiveConversation()!);

		switchMidTurn(display, session, NEW);
		await historyManager.updateConversationHeader(display.getActiveConversation()!);
		// The turn keeps running: each addMessage rewrites the header from the SESSION copy.
		session.conversationManager.addMessage({ role: "assistant", content: "tool round" });
		await historyManager.flushConversation(session.conversationManager.getActiveConversation()!);

		const filePath = Object.keys(files).find((k) => k.endsWith(".jsonl"))!;
		const header = JSON.parse(files[filePath]!.split("\n")[0]!);
		expect(readSelection(header)).toEqual(NEW);

		syncSessionToDisplay(display, session);
		expect(readSelection(display.getActiveConversation()!)).toEqual(NEW);
	});
});
