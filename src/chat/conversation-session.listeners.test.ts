/**
 * `addStatusListener` is the multi-listener seam next to the single-slot
 * `onStatusChange`; both must fire, and a bad listener must not break others.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../providers/model-metadata", () => ({
	getContextWindow: () => 128_000,
	getModelMetadata: () => null,
	getModelExtendedContext: () => undefined,
}));

import { ConversationManager } from "./conversation";
import { ConversationSession } from "./conversation-session";

function makeSession(): ConversationSession {
	const manager = new ConversationManager("act");
	manager.createConversation("p", "m", "act");
	const conv = manager.getActiveConversation()!;
	return new ConversationSession({
		conversationId: conv.id,
		conversationManager: manager,
		abortController: new AbortController(),
		title: "t",
		pinnedPersona: null,
		providerId: "p",
		modelId: "m",
		useExtendedContext: false,
		thinkingLevel: null,
		approvalCallback: async () => "approved" as const,
		initialConfig: { tools: {}, personaName: null } as never,
		initialParsedConfigs: [],
	});
}

describe("ConversationSession.addStatusListener", () => {
	it("fires the legacy slot and every listener, and unsubscribes cleanly", () => {
		const session = makeSession();
		const legacy = vi.fn();
		const a = vi.fn();
		const b = vi.fn();
		session.onStatusChange = legacy;
		const offA = session.addStatusListener(a);
		session.addStatusListener(b);

		session.setStatus("waiting_approval");
		expect(session.status).toBe("waiting_approval");
		expect(legacy).toHaveBeenCalledWith(session);
		expect(a).toHaveBeenCalledWith(session);
		expect(b).toHaveBeenCalledWith(session);

		offA();
		session.setStatus("running");
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(2);
		expect(legacy).toHaveBeenCalledTimes(2);
	});

	it("isolates a throwing listener", () => {
		const session = makeSession();
		const good = vi.fn();
		session.addStatusListener(() => { throw new Error("boom"); });
		session.addStatusListener(good);
		expect(() => session.setStatus("completed")).not.toThrow();
		expect(good).toHaveBeenCalledTimes(1);
	});
});
