import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { TurnObserverRegistry, findTurnUserMessageId } from "./turn-observer";
import type { ConversationSession } from "./conversation-session";
import type { Message, ToolResult } from "../types";

const session = { conversationId: "c1" } as unknown as ConversationSession;

function msg(partial: Partial<Message> & Pick<Message, "role" | "id">): Message {
	return { conversation_id: "c1", timestamp: "t", content: "", ...partial };
}

describe("TurnObserverRegistry", () => {
	it("notifies every observer and returns a working unsubscribe", () => {
		const registry = new TurnObserverRegistry();
		const a = { onTurnStarted: vi.fn(), onTurnFinished: vi.fn() };
		const b = { onToolCallStarted: vi.fn(), onToolCallFinished: vi.fn() };
		const offA = registry.add(a);
		registry.add(b);
		expect(registry.size).toBe(2);

		registry.emitTurnStarted(session, { userMessageId: "u1" });
		registry.emitToolCallStarted(session, "read_note", { path: "a.md" }, "m1");
		const result: ToolResult = { tool_name: "read_note", success: true, result: "ok" };
		registry.emitToolCallFinished(session, "read_note", { path: "a.md" }, result, "m2");
		registry.emitTurnFinished(session, { status: "completed", cancelled: false, userMessageId: "u1" });

		expect(a.onTurnStarted).toHaveBeenCalledWith(session, { userMessageId: "u1" });
		expect(a.onTurnFinished).toHaveBeenCalledWith(session, { status: "completed", cancelled: false, userMessageId: "u1" });
		expect(b.onToolCallStarted).toHaveBeenCalledWith(session, "read_note", { path: "a.md" }, "m1");
		expect(b.onToolCallFinished).toHaveBeenCalledWith(session, "read_note", { path: "a.md" }, result, "m2");

		offA();
		registry.emitTurnStarted(session, { userMessageId: "u2" });
		expect(a.onTurnStarted).toHaveBeenCalledTimes(1);
		expect(registry.size).toBe(1);
	});

	it("isolates a throwing observer from the others", () => {
		const registry = new TurnObserverRegistry();
		const good = { onTurnStarted: vi.fn() };
		registry.add({ onTurnStarted: () => { throw new Error("boom"); } });
		registry.add(good);
		expect(() => registry.emitTurnStarted(session, { userMessageId: null })).not.toThrow();
		expect(good.onTurnStarted).toHaveBeenCalledTimes(1);
	});

	it("clear removes everyone", () => {
		const registry = new TurnObserverRegistry();
		const obs = { onTurnFinished: vi.fn() };
		registry.add(obs);
		registry.clear();
		registry.emitTurnFinished(session, { status: "errored", cancelled: true, userMessageId: null });
		expect(obs.onTurnFinished).not.toHaveBeenCalled();
		expect(registry.size).toBe(0);
	});
});

describe("findTurnUserMessageId", () => {
	it("returns the last real user message, skipping hook injections", () => {
		const messages = [
			msg({ id: "u1", role: "user" }),
			msg({ id: "a1", role: "assistant" }),
			msg({ id: "u2", role: "user" }),
			msg({ id: "h1", role: "user", is_hook_injection: true }),
			msg({ id: "a2", role: "assistant" }),
		];
		expect(findTurnUserMessageId(messages)).toBe("u2");
		expect(findTurnUserMessageId([msg({ id: "a", role: "assistant" })])).toBeNull();
		expect(findTurnUserMessageId([])).toBeNull();
	});
});
