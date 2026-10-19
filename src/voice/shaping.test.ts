import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { Message } from "../types";
import type { NotorSettings } from "../settings/types";
import type { LLMProvider, StreamChunk } from "../providers/provider";
import {
	buildTurnTranscript,
	cleanupTranscript,
	describeToolCall,
	fallbackSpoken,
	formatApprovalAnnouncement,
	formatQuestionAnnouncement,
	formatToolProgressLine,
	resolveShapingTarget,
	summarizeTurnForSpeech,
	turnFallbackText,
	type ShapingDeps,
} from "./shaping";
import { readVoiceConfig } from "./voice-settings";
import type { VoicePromptFiles } from "./shaping-prompts";

function msg(partial: Partial<Message> & Pick<Message, "role">): Message {
	return {
		id: partial.id ?? Math.random().toString(36).slice(2),
		conversation_id: "c1",
		timestamp: "2026-10-18T00:00:00.000Z",
		content: "",
		...partial,
	};
}

const settings = {
	model_presets: [
		{ name: "small", provider_id: "p1", model_id: "m-small", use_extended_context: false, thinking_level: null },
		{ name: "unset", provider_id: null, model_id: null, use_extended_context: false, thinking_level: null },
	],
	voice_input_cleanup_enabled: true,
	voice_speech_summary_max_chars: 600,
	network_retry_max_retries: 0,
} as unknown as NotorSettings;

function fakeProvider(reply: string | StreamChunk[]): LLMProvider {
	const chunks: StreamChunk[] = typeof reply === "string"
		? [{ type: "text_delta", text: reply }, { type: "message_end", input_tokens: 1, output_tokens: 1 }]
		: reply;
	return {
		sendMessage: vi.fn(async function* () {
			for (const c of chunks) yield c;
		}),
	} as unknown as LLMProvider;
}

const prompts: VoicePromptFiles = {
	inputCleanup: { read: async () => ({ text: "CLEANUP", source: "default" }) },
	speechSummary: { read: async () => ({ text: "SUMMARY", source: "default" }) },
} as unknown as VoicePromptFiles;

function deps(provider: LLMProvider | null): ShapingDeps {
	return {
		settings,
		prompts,
		target: provider ? { provider, modelId: "m", useExtendedContext: false, label: "test" } : null,
	};
}

const config = readVoiceConfig(settings);

describe("resolveShapingTarget", () => {
	const registry = { getProvider: vi.fn((id: string) => ({ id }) as unknown as LLMProvider) };
	const fallback = { providerId: "conv", modelId: "conv-model", useExtendedContext: true, thinkingLevel: null, presetName: null };

	it("uses the configured preset when it resolves", () => {
		const target = resolveShapingTarget({ ...config, shapingPreset: "small" }, settings, fallback, registry);
		expect(target).toMatchObject({ modelId: "m-small", label: "preset:small" });
		expect(registry.getProvider).toHaveBeenCalledWith("p1");
	});

	it("falls back to the conversation selection when the preset is unset or unknown", () => {
		expect(resolveShapingTarget({ ...config, shapingPreset: "unset" }, settings, fallback, registry))
			.toMatchObject({ modelId: "conv-model", label: "conversation", useExtendedContext: true });
		expect(resolveShapingTarget({ ...config, shapingPreset: "" }, settings, fallback, registry))
			.toMatchObject({ modelId: "conv-model" });
	});

	it("returns null when nothing is usable", () => {
		const empty = { ...fallback, providerId: "", modelId: "" };
		expect(resolveShapingTarget(config, settings, empty, registry)).toBeNull();
		const throwing = { getProvider: () => { throw new Error("nope"); } };
		expect(resolveShapingTarget(config, settings, fallback, throwing)).toBeNull();
	});
});

describe("cleanupTranscript", () => {
	it("returns the cleaned text and sends the prompt as the system message", async () => {
		const provider = fakeProvider("Please summarize my meeting notes.");
		const out = await cleanupTranscript("um please summarize my uh meeting notes", config, deps(provider));
		expect(out).toBe("Please summarize my meeting notes.");
		const [messages] = (provider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(messages[0]).toEqual({ role: "system", content: "CLEANUP" });
	});

	it("skips the pass for short utterances, when disabled, or without a target", async () => {
		const provider = fakeProvider("SHOULD NOT BE USED");
		expect(await cleanupTranscript("yes do it", config, deps(provider))).toBe("yes do it");
		expect(await cleanupTranscript("one two three four five", { ...config, inputCleanupEnabled: false }, deps(provider))).toBe("one two three four five");
		expect(await cleanupTranscript("one two three four five", config, deps(null))).toBe("one two three four five");
		expect(provider.sendMessage).not.toHaveBeenCalled();
	});

	it("falls back to the raw transcript on stream errors, throws, or runaway output", async () => {
		const raw = "one two three four five";
		const errored = fakeProvider([{ type: "error", error: "boom" }]);
		expect(await cleanupTranscript(raw, config, deps(errored))).toBe(raw);
		const throwing = { sendMessage: () => { throw new Error("down"); } } as unknown as LLMProvider;
		expect(await cleanupTranscript(raw, config, deps(throwing))).toBe(raw);
		const runaway = fakeProvider("x".repeat(500));
		expect(await cleanupTranscript(raw, config, deps(runaway))).toBe(raw);
	});
});

describe("buildTurnTranscript", () => {
	const messages: Message[] = [
		msg({ id: "u0", role: "user", content: "earlier" }),
		msg({ id: "a0", role: "assistant", content: "earlier reply" }),
		msg({ id: "u1", role: "user", content: "find my notes" }),
		msg({ role: "assistant", content: "Let me look." }),
		msg({ role: "tool_call", tool_call: { id: "t1", tool_name: "search_notes", parameters: { query: "meeting" }, status: "success" } }),
		msg({ role: "tool_call", tool_call: { id: "t2", tool_name: "search_notes", parameters: { query: "standup" }, status: "success" } }),
		msg({ role: "tool_result", tool_result: { tool_name: "search_notes", success: true, result: "3 results", tool_call_id: "t1" } }),
		msg({ role: "tool_result", tool_result: { tool_name: "search_notes", success: true, result: "1 result: Standup 2026-10-17", tool_call_id: "t2" } }),
		msg({ role: "tool_call", tool_call: { id: "t3", tool_name: "read_note", parameters: { path: "Meetings/Standup.md", content: "x".repeat(500) }, status: "error" } }),
		msg({ role: "tool_result", tool_result: { tool_name: "read_note", success: false, result: "", error: "not found", tool_call_id: "t3" } }),
		msg({ role: "extension_block" as Message["role"], content: "ignored block" }),
		msg({ role: "assistant", content: "I found **three** notes." }),
	];

	it("includes only this turn, collapses tool runs, and pairs results", () => {
		const transcript = buildTurnTranscript(messages, "u1");
		expect(transcript).not.toContain("earlier");
		expect(transcript).not.toContain("ignored block");
		expect(transcript).toContain("Let me look.");
		expect(transcript).toContain('TOOL search_notes ×2 (first: search_notes(query: "meeting"))');
		expect(transcript).toContain("→ ok: 1 result: Standup 2026-10-17");
		expect(transcript).toContain('TOOL read_note(path: "Meetings/Standup.md", content: <500 chars>)');
		expect(transcript).toContain("→ error: not found");
		expect(transcript.trim().endsWith("I found **three** notes.")).toBe(true);
	});

	it("uses the whole list when the user message id is unknown", () => {
		expect(buildTurnTranscript(messages, null)).toContain("earlier reply");
		expect(buildTurnTranscript(messages, "missing")).toContain("earlier reply");
	});

	it("exposes the last assistant text as the fallback", () => {
		expect(turnFallbackText(messages, "u1")).toBe("I found **three** notes.");
		expect(turnFallbackText([msg({ id: "u", role: "user", content: "hi" })], "u")).toBe("");
	});
});

describe("summarizeTurnForSpeech", () => {
	it("speaks the model's summary with markdown stripped and appends the length limit", async () => {
		const provider = fakeProvider("I **found** three notes.");
		const out = await summarizeTurnForSpeech("TOOL x()\nText", "fallback", config, deps(provider));
		expect(out).toBe("I found three notes.");
		const [messages] = (provider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(messages[0]).toEqual({ role: "system", content: "SUMMARY" });
		expect(messages[1].content).toContain("Length limit: about 600 characters");
	});

	it("falls back to the last assistant message when there is no target or the pass fails", async () => {
		expect(await summarizeTurnForSpeech("transcript", "## Done\nAll **good**.", config, deps(null))).toBe("Done\nAll good.");
		const errored = fakeProvider([{ type: "error", error: "boom" }]);
		expect(await summarizeTurnForSpeech("transcript", "Plain.", config, deps(errored))).toBe("Plain.");
		expect(await summarizeTurnForSpeech("", "Nothing ran.", config, deps(fakeProvider("x")))).toBe("Nothing ran.");
	});

	it("fallbackSpoken truncates to the configured budget", () => {
		const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
		const out = fallbackSpoken(long, { ...config, summaryMaxChars: 120 });
		expect(out.length).toBeLessThanOrEqual(120);
		expect(out.endsWith(".")).toBe(true);
	});
});

describe("spoken templates", () => {
	it("describes tool calls compactly", () => {
		expect(describeToolCall("write_note", { path: "a.md", content: "x".repeat(100), extra: 1, more: 2 }))
			.toBe('write_note(path: "a.md", content: <100 chars>, extra: 1, …)');
	});

	it("formats progress lines from the tool name and parameters", () => {
		expect(formatToolProgressLine("read_note", { path: "Daily/2026-10-18.md" })).toBe("reading 2026-10-18");
		expect(formatToolProgressLine("search_notes", { query: "quarterly plan" })).toBe("searching for quarterly plan");
		expect(formatToolProgressLine("execute_command", { command: "ls" })).toBe("running a command");
		expect(formatToolProgressLine("use_subagent", {})).toBe("delegating to a sub-agent");
		expect(formatToolProgressLine("my_custom_tool", {})).toBe("running my custom tool");
	});

	it("formats approval and question announcements", () => {
		expect(formatApprovalAnnouncement([{ toolName: "write_note", parameters: { path: "Ideas.md" } }]))
			.toBe("Approval needed for writing Ideas. Say approve or reject.");
		expect(formatApprovalAnnouncement([
			{ toolName: "write_note", parameters: { path: "A.md" } },
			{ toolName: "write_note", parameters: { path: "B.md" } },
			{ toolName: "execute_command", parameters: {} },
		])).toBe("3 approvals needed. The first is writing A. Say approve, approve all, or reject.");
		expect(formatApprovalAnnouncement([])).toBe("");
		expect(formatQuestionAnnouncement([{ question: "Which folder?", suggestions: ["Inbox", "Archive"] }, { question: "Tag?" }]))
			.toBe("Which folder? Options: 1, Inbox; 2, Archive. There are 2 questions in total. Say answer, followed by your reply.");
	});
});
