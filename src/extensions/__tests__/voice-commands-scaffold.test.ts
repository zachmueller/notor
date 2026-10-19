import { describe, it, expect, vi } from "vitest";
import { VOICE_COMMANDS } from "../builtin-automation-scaffolds/voice-commands";
import { extractCodeFence } from "../parser";
import { compileExtension } from "../compiler";

// ---------------------------------------------------------------------------
// Compile the real voice-commands scaffold and drive it with a fake utils.voice.
// Invocation order: fn(app, obsidian, utils, libs, settings, shared, context).
// ---------------------------------------------------------------------------

function compileScaffold() {
	const fence = extractCodeFence(VOICE_COMMANDS.scaffoldContent);
	if (!fence) throw new Error("No code fence found in scaffold");
	const compiled = compileExtension(fence.code, "automation");
	if ("error" in compiled) throw new Error(compiled.error);
	return compiled.fn;
}

function fakeVoice() {
	return {
		speak: vi.fn(),
		stopSpeaking: vi.fn(),
		repeatLast: vi.fn(() => true),
		stopListening: vi.fn(),
		cancelTurn: vi.fn(() => true),
		approvePending: vi.fn(() => 1),
		rejectPending: vi.fn(() => 1),
		answerPending: vi.fn(() => true),
		sendQueued: vi.fn(async () => true),
		clearQueued: vi.fn(),
		describeState: vi.fn(() => "Idle and listening."),
		getState: vi.fn(),
	};
}

interface RunOpts {
	transcript: string;
	hasTriggerPhrase?: boolean;
	pendingApproval?: boolean;
	pendingInteraction?: boolean;
	voice?: ReturnType<typeof fakeVoice> | null;
}

async function run(opts: RunOpts) {
	const fn = compileScaffold();
	const voice = opts.voice === null ? null : (opts.voice ?? fakeVoice());
	const context = {
		hookEvent: "on_voice_command",
		conversationId: "c1",
		transcript: opts.transcript,
		rawTranscript: opts.transcript,
		hasTriggerPhrase: opts.hasTriggerPhrase ?? true,
		isTurnRunning: false,
		isSpeaking: false,
		queuedText: "",
		pendingApproval: opts.pendingApproval ? { toolName: "write_note", parameters: {}, count: 1 } : null,
		pendingInteraction: opts.pendingInteraction ? { questions: [{ question: "Which?" }] } : null,
	};
	const result = (await fn({}, {}, { voice }, {}, {}, {}, context)) as { handled?: boolean } | undefined;
	return { handled: result?.handled === true, voice };
}

describe("voice-commands scaffold", () => {
	it("compiles and declares the right trigger and feature group", () => {
		expect(VOICE_COMMANDS.trigger).toBe("on_voice_command");
		expect(VOICE_COMMANDS.scaffoldContent).toContain("notor-feature-group: voice");
		expect(() => compileScaffold()).not.toThrow();
	});

	it("does nothing when voice mode is off for the conversation", async () => {
		const { handled } = await run({ transcript: "approve", voice: null });
		expect(handled).toBe(false);
	});

	it("approves, rejects and answers with the trigger phrase", async () => {
		const approve = await run({ transcript: "Approve." });
		expect(approve.handled).toBe(true);
		expect(approve.voice!.approvePending).toHaveBeenCalledWith();
		expect(approve.voice!.speak).toHaveBeenCalledWith("Approved.");

		const all = await run({ transcript: "approve all" });
		expect(all.voice!.approvePending).toHaveBeenCalledWith({ all: true });
		expect(all.voice!.speak).toHaveBeenCalledWith("Approved 1.");

		const reject = await run({ transcript: "no" });
		expect(reject.voice!.rejectPending).toHaveBeenCalledWith();

		const answer = await run({ transcript: "answer Put it in the Inbox, please" });
		expect(answer.voice!.answerPending).toHaveBeenCalledWith(["Put it in the Inbox, please"]);
		expect(answer.voice!.speak).toHaveBeenCalledWith("Answered.");
	});

	it("accepts bare confirmations only while something is pending", async () => {
		const waiting = await run({ transcript: "yes", hasTriggerPhrase: false, pendingApproval: true });
		expect(waiting.handled).toBe(true);
		expect(waiting.voice!.approvePending).toHaveBeenCalled();

		const asking = await run({ transcript: "answer the Inbox", hasTriggerPhrase: false, pendingInteraction: true });
		expect(asking.handled).toBe(true);
		expect(asking.voice!.answerPending).toHaveBeenCalledWith(["the Inbox"]);

		const idle = await run({ transcript: "yes", hasTriggerPhrase: false });
		expect(idle.handled).toBe(false);
		expect(idle.voice!.approvePending).not.toHaveBeenCalled();

		const long = await run({ transcript: "yes but first check the other note", hasTriggerPhrase: false, pendingApproval: true });
		expect(long.handled).toBe(false);
	});

	it("needs the trigger phrase for control commands", async () => {
		const cancel = await run({ transcript: "cancel" });
		expect(cancel.voice!.cancelTurn).toHaveBeenCalled();
		expect(cancel.voice!.speak).toHaveBeenCalledWith("Cancelled.");

		const quiet = await run({ transcript: "stop speaking" });
		expect(quiet.voice!.stopSpeaking).toHaveBeenCalled();
		expect(quiet.voice!.cancelTurn).not.toHaveBeenCalled();

		const off = await run({ transcript: "stop listening" });
		expect(off.voice!.stopListening).toHaveBeenCalled();

		const send = await run({ transcript: "send" });
		expect(send.voice!.sendQueued).toHaveBeenCalled();
		expect(send.voice!.speak).toHaveBeenCalledWith("Sent.");

		const clear = await run({ transcript: "scratch that" });
		expect(clear.voice!.clearQueued).toHaveBeenCalled();

		const status = await run({ transcript: "status" });
		expect(status.voice!.speak).toHaveBeenCalledWith("Idle and listening.");

		const bare = await run({ transcript: "cancel", hasTriggerPhrase: false, pendingApproval: true });
		expect(bare.handled).toBe(false);
	});

	it("answers unknown trigger-phrase commands aloud and consumes them", async () => {
		const { handled, voice } = await run({ transcript: "make me a sandwich" });
		expect(handled).toBe(true);
		expect(voice!.speak).toHaveBeenCalledWith("Unknown voice command: make me a sandwich");
	});
});
