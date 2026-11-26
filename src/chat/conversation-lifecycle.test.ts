/**
 * ConversationLifecycleManager — opening a conversation stays cheap:
 *  - by ID: resolved from the history directory listing (no full listing) and
 *    only falls back to `listConversations()` on a miss;
 *  - load: no header rewrite (the load is silent) and stale-tracker state comes
 *    from the single load pass (no second read of the file).
 */

import { describe, expect, it, vi } from "vitest";
import { ConversationLifecycleManager } from "./conversation-lifecycle";
import type { HistoryManager, StaleStateEntry } from "./history";
import type { Conversation, Message } from "../types";

function conv(over: Partial<Conversation> = {}): Conversation {
	return {
		id: "conv-1",
		created_at: "2026-07-01T00:00:00Z",
		updated_at: "2026-07-01T00:00:00Z",
		provider_id: "bedrock",
		model_id: "m",
		total_input_tokens: 0,
		total_output_tokens: 0,
		estimated_cost: null,
		mode: "act",
		...over,
	};
}

function setup(opts: {
	byName?: string | null;
	listed?: Array<{ id: string; filename: string }>;
	staleState?: StaleStateEntry[] | null;
} = {}) {
	const conversation = conv();
	const messages: Message[] = [];
	const history = {
		findConversationFilenameById: vi.fn(async () => opts.byName ?? null),
		listConversations: vi.fn(async () => opts.listed ?? []),
		loadConversation: vi.fn(async () => ({ conversation, messages, staleState: opts.staleState ?? null })),
		readRawFile: vi.fn(async () => ""),
		updateConversationHeader: vi.fn(async () => undefined),
		saveDraft: vi.fn(async () => undefined),
	};
	const convManager = {
		loadConversation: vi.fn(),
		getActiveConversation: vi.fn(() => conversation),
		getCurrentContextUsage: vi.fn(() => ({ contextTokens: 0 })),
		setModelSelection: vi.fn(),
	};
	const tracker = { restore: vi.fn(), clear: vi.fn(), serialize: vi.fn(() => []) };
	const noop = () => undefined;
	const lifecycle = new ConversationLifecycleManager(
		() => ({ model_presets: [], default_preset: null }) as never,
		history as unknown as HistoryManager,
		() => convManager as never,
		{ getView: () => undefined, renderMessage: vi.fn() } as never,
		{ getActiveSession: () => undefined } as never,
		{} as never,
		() => undefined,
		() => undefined,
		() => "bedrock",
		() => "m",
		() => false,
		() => null,
		noop,
		noop,
		noop,
		noop,
		() => null,
		noop,
		() => true,
		() => null,
		noop,
		undefined,
		undefined,
		() => tracker as never,
	);
	return { lifecycle, history, convManager, tracker };
}

describe("ConversationLifecycleManager.switchToConversationById", () => {
	it("resolves the file from the directory listing without a full history listing", async () => {
		const { lifecycle, history } = setup({ byName: "20260701_000000_conv-1.jsonl" });
		const switchSpy = vi.spyOn(lifecycle, "switchConversation").mockResolvedValue();
		await expect(lifecycle.switchToConversationById("conv-1")).resolves.toBe(true);
		expect(switchSpy).toHaveBeenCalledWith("20260701_000000_conv-1.jsonl", expect.anything());
		expect(history.listConversations).not.toHaveBeenCalled();
	});

	it("falls back to the full listing (matched by header ID) when no file name matches", async () => {
		const { lifecycle, history } = setup({ byName: null, listed: [{ id: "conv-1", filename: "renamed.jsonl" }] });
		const switchSpy = vi.spyOn(lifecycle, "switchConversation").mockResolvedValue();
		await expect(lifecycle.switchToConversationById("conv-1")).resolves.toBe(true);
		expect(history.listConversations).toHaveBeenCalledTimes(1);
		expect(switchSpy).toHaveBeenCalledWith("renamed.jsonl", expect.anything());
	});

	it("returns false when the conversation is gone", async () => {
		const { lifecycle } = setup({ byName: null, listed: [] });
		const switchSpy = vi.spyOn(lifecycle, "switchConversation").mockResolvedValue();
		await expect(lifecycle.switchToConversationById("missing")).resolves.toBe(false);
		expect(switchSpy).not.toHaveBeenCalled();
	});
});

describe("ConversationLifecycleManager.switchConversation — load path", () => {
	it("loads silently (no header rewrite) and restores stale state from the same pass", async () => {
		const entries = [{ note_path: "a.md", body_hash: "h", timestamp: "t" }];
		const { lifecycle, history, convManager, tracker } = setup({ staleState: entries });
		await lifecycle.switchConversation("20260701_000000_conv-1.jsonl");

		expect(convManager.loadConversation).toHaveBeenCalledWith(expect.anything(), expect.anything(), { silent: true });
		expect(history.updateConversationHeader).not.toHaveBeenCalled();
		expect(history.readRawFile).not.toHaveBeenCalled();
		expect(tracker.restore).toHaveBeenCalledWith(entries);
	});

	it("leaves the tracker alone when the file has no stale state", async () => {
		const { lifecycle, tracker } = setup({ staleState: null });
		await lifecycle.switchConversation("20260701_000000_conv-1.jsonl");
		expect(tracker.restore).not.toHaveBeenCalled();
	});
});
