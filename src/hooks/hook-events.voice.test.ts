import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, Notice: vi.fn() };
});

import { Notice } from "obsidian";
import { dispatchOnVoiceCommand, type VoiceCommandContext } from "./hook-events";
import type { UserAutomationDefinition } from "../extensions/types";

const context: VoiceCommandContext = {
	conversationId: "c1",
	timestamp: "2026-10-18T00:00:00.000Z",
	rawTranscript: "Hey Notor, approve",
	transcript: "approve",
	addressed: true,
	wakeWord: "Hey Notor",
	isTurnRunning: true,
	isSpeaking: false,
	queuedText: "",
	pendingApproval: { toolName: "write_note", parameters: { path: "a.md" }, count: 1 },
	pendingInteraction: null,
};

function automation(name: string): UserAutomationDefinition {
	return { displayName: name, filePath: `${name}.md`, trigger: "on_voice_command" } as unknown as UserAutomationDefinition;
}

describe("dispatchOnVoiceCommand", () => {
	it("returns not-handled when nothing is registered", async () => {
		expect(await dispatchOnVoiceCommand(context)).toEqual({ handled: false });
		const accessors = { getForTrigger: vi.fn(() => []), execute: vi.fn() };
		expect(await dispatchOnVoiceCommand(context, accessors)).toEqual({ handled: false });
		expect(accessors.getForTrigger).toHaveBeenCalledWith("on_voice_command");
	});

	it("runs automations in order and stops at the first that handles the utterance", async () => {
		const calls: string[] = [];
		const accessors = {
			getForTrigger: () => [automation("first"), automation("second"), automation("third")],
			execute: vi.fn(async (a: UserAutomationDefinition, ctx: Record<string, unknown>) => {
				calls.push(a.displayName!);
				expect(ctx).toMatchObject({ hookEvent: "on_voice_command", transcript: "approve", addressed: true, wakeWord: "Hey Notor" });
				return a.displayName === "second" ? { handled: true } : { handled: false };
			}),
		};
		expect(await dispatchOnVoiceCommand(context, accessors)).toEqual({ handled: true, handledBy: "second" });
		expect(calls).toEqual(["first", "second"]);
	});

	it("accepts `true` and the string \"handled\" as handled, and ignores other returns", async () => {
		for (const [ret, handled] of [[true, true], ["Handled", true], ["approved", false], [undefined, false], [{ handled: "yes" }, false]] as const) {
			const accessors = { getForTrigger: () => [automation("a")], execute: async () => ret };
			expect((await dispatchOnVoiceCommand(context, accessors)).handled).toBe(handled);
		}
	});

	it("reports a throwing automation and continues with the next", async () => {
		const accessors = {
			getForTrigger: () => [automation("broken"), automation("good")],
			execute: async (a: UserAutomationDefinition) => {
				if (a.displayName === "broken") throw new Error("kaboom");
				return true;
			},
		};
		expect(await dispatchOnVoiceCommand(context, accessors)).toEqual({ handled: true, handledBy: "good" });
		expect(Notice).toHaveBeenCalledWith(expect.stringContaining("kaboom"));
	});
});
