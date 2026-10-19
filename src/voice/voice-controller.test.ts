import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../providers/model-metadata", () => ({
	getContextWindow: () => 128_000,
	getModelMetadata: () => null,
	getModelExtendedContext: () => undefined,
}));

import { ConversationManager } from "../chat/conversation";
import { ConversationSession } from "../chat/conversation-session";
import { TurnObserverRegistry } from "../chat/turn-observer";
import { createDefaultSettings } from "../settings/defaults";
import type { NotorSettings } from "../settings/types";
import type { LLMProvider } from "../providers/provider";
import type { Message } from "../types";
import type { AudioSource } from "./audio/audio-capture";
import type { SttBackend, SttStatus, VoiceConfigProblem } from "./stt/types";
import type { SpeakResult, TtsBackend } from "./tts/types";
import type { VoicePromptFiles } from "./shaping-prompts";
import { VoiceController, VoiceStartError, type VoiceOrchestratorLike, type VoiceStatus } from "./voice-controller";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeAudio implements AudioSource {
	readonly sampleRate = 16_000;
	onFrame: ((frame: Float32Array) => void) | null = null;
	started = false;
	stopped = false;
	start(cb: (frame: Float32Array) => void): Promise<void> {
		this.started = true;
		this.onFrame = cb;
		return Promise.resolve();
	}
	stop(): void {
		this.stopped = true;
	}
	/** Feed `ms` of constant-amplitude 10 ms frames. */
	feed(level: number, ms: number): void {
		for (let i = 0; i < Math.round(ms / 10); i++) this.onFrame?.(new Float32Array(160).fill(level));
	}
}

class FakeStt implements SttBackend {
	status: SttStatus = "stopped";
	problems: VoiceConfigProblem[] = [];
	transcripts: string[] = [];
	wavs: ArrayBuffer[] = [];
	disposed = false;
	restarted = 0;
	private listeners = new Set<(status: SttStatus, detail?: string) => void>();
	preflight(): VoiceConfigProblem[] {
		return this.problems;
	}
	start(): Promise<void> {
		this.status = "ready";
		return Promise.resolve();
	}
	transcribe(wav: ArrayBuffer): Promise<string> {
		this.wavs.push(wav);
		return Promise.resolve(this.transcripts.shift() ?? "");
	}
	dispose(): Promise<void> {
		this.disposed = true;
		this.status = "stopped";
		return Promise.resolve();
	}
	restart(): Promise<void> {
		this.restarted++;
		return Promise.resolve();
	}
	onStatus(listener: (status: SttStatus, detail?: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emit(status: SttStatus, detail?: string): void {
		this.status = status;
		for (const l of this.listeners) l(status, detail);
	}
}

class FakeTts implements TtsBackend {
	spoken: string[] = [];
	stops = 0;
	disposed = false;
	private pending: ((r: SpeakResult) => void) | null = null;
	get isSpeaking(): boolean {
		return this.pending !== null;
	}
	speak(text: string): Promise<SpeakResult> {
		this.spoken.push(text);
		return new Promise((resolve) => {
			this.pending = resolve;
		});
	}
	stop(): void {
		this.stops++;
		const p = this.pending;
		this.pending = null;
		p?.({ interrupted: true });
	}
	dispose(): void {
		this.disposed = true;
		this.stop();
	}
	finish(): void {
		const p = this.pending;
		this.pending = null;
		p?.({ interrupted: false });
	}
}

class FakeOrchestrator implements VoiceOrchestratorLike {
	displayed: string | null = "conv-1";
	readonly sessions = new Map<string, ConversationSession>();
	readonly observers = new TurnObserverRegistry();
	readonly displayListeners = new Set<(id: string | null) => void>();
	readonly sent: string[] = [];
	hasActiveSession(id: string): boolean {
		return this.sessions.has(id);
	}
	getActiveSession(id: string): ConversationSession | undefined {
		return this.sessions.get(id);
	}
	handleUserMessage(content: string): Promise<void> {
		this.sent.push(content);
		return Promise.resolve();
	}
	addTurnObserver(observer: Parameters<TurnObserverRegistry["add"]>[0]): () => void {
		return this.observers.add(observer);
	}
	addDisplayConversationListener(listener: (id: string | null) => void): () => void {
		this.displayListeners.add(listener);
		return () => this.displayListeners.delete(listener);
	}
	getConversationManager() {
		return { getActiveConversation: () => (this.displayed ? { id: this.displayed } : null) };
	}
	getActiveSelection() {
		return { providerId: "p", modelId: "m", useExtendedContext: false, thinkingLevel: null, presetName: null };
	}

	/** Start a turn for conv-1 with the given prior messages (last one is the user's). */
	startTurn(messages: Array<Pick<Message, "role" | "content">>): ConversationSession {
		const manager = new ConversationManager("act");
		manager.createConversation("p", "m", "act");
		for (const m of messages) manager.addMessage(m);
		const conv = manager.getActiveConversation()!;
		const session = new ConversationSession({
			conversationId: "conv-1",
			conversationManager: manager,
			abortController: new AbortController(),
			title: conv.title ?? "t",
			pinnedPersona: null,
			providerId: "p",
			modelId: "m",
			useExtendedContext: false,
			thinkingLevel: null,
			approvalCallback: async () => "approved" as const,
			initialConfig: { tools: {}, personaName: null } as never,
			initialParsedConfigs: [],
		});
		this.sessions.set("conv-1", session);
		const userMessageId = manager.getMessages().filter((m) => m.role === "user").pop()?.id ?? null;
		this.observers.emitTurnStarted(session, { userMessageId });
		return session;
	}

	finishTurn(session: ConversationSession, opts: { status?: "completed" | "errored"; cancelled?: boolean } = {}): void {
		this.sessions.delete(session.conversationId);
		session.setStatus(opts.status ?? "completed");
		const userMessageId = session.conversationManager.getMessages().filter((m) => m.role === "user")[0]?.id ?? null;
		this.observers.emitTurnFinished(session, { status: opts.status ?? "completed", cancelled: opts.cancelled ?? false, userMessageId });
	}

	switchDisplayed(id: string | null): void {
		this.displayed = id;
		for (const l of this.displayListeners) l(id);
	}
}

const prompts: VoicePromptFiles = {
	inputCleanup: { read: async () => ({ text: "CLEANUP", source: "default" }) },
	speechSummary: { read: async () => ({ text: "SUMMARY", source: "default" }) },
} as unknown as VoicePromptFiles;

function summaryProvider(reply: string): LLMProvider {
	return {
		sendMessage: vi.fn(async function* () {
			yield { type: "text_delta", text: reply };
			yield { type: "message_end", input_tokens: 1, output_tokens: 1 };
		}),
	} as unknown as LLMProvider;
}

const tick = () => new Promise((r) => setTimeout(r, 1));
/** Settle promise chains plus the zero-delay guard timer. */
const settle = async () => {
	for (let i = 0; i < 6; i++) await tick();
};

interface Harness {
	controller: VoiceController;
	audio: FakeAudio;
	stt: FakeStt;
	tts: FakeTts;
	orchestrator: FakeOrchestrator;
	statuses: VoiceStatus[];
	settings: NotorSettings;
	notices: string[];
}

function makeHarness(overrides: Partial<NotorSettings> = {}, provider: LLMProvider | null = null): Harness {
	const settings: NotorSettings = {
		...createDefaultSettings(".obsidian"),
		voice_enabled: true,
		voice_input_cleanup_enabled: false,
		network_retry_max_retries: 0,
		...overrides,
	};
	const audio = new FakeAudio();
	const stt = new FakeStt();
	const tts = new FakeTts();
	const orchestrator = new FakeOrchestrator();
	const statuses: VoiceStatus[] = [];
	const notices: string[] = [];
	const controller = new VoiceController({
		orchestrator,
		leafId: "leaf-1",
		conversationId: "conv-1",
		audio,
		stt,
		tts,
		prompts,
		providerRegistry: {
			getProvider: () => {
				if (!provider) throw new Error("no provider in test");
				return provider;
			},
		},
		getSettings: () => settings,
		onStatus: (s) => statuses.push(s),
		notify: (m) => notices.push(m),
		postSpeechGuardMs: 0,
	});
	return { controller, audio, stt, tts, orchestrator, statuses, settings, notices };
}

/** Start voice mode and let the "Voice mode on." greeting finish. */
async function startAndGreet(h: Harness): Promise<void> {
	await h.controller.start();
	expect(h.tts.spoken).toEqual(["Voice mode on."]);
	h.tts.finish();
	await settle();
}

beforeEach(() => {
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("VoiceController start/stop", () => {
	it("refuses to start when preflight reports problems", async () => {
		const h = makeHarness();
		h.stt.problems = [{ code: "model_missing", message: "No model." }];
		await expect(h.controller.start()).rejects.toBeInstanceOf(VoiceStartError);
		expect(h.audio.started).toBe(false);
		const last = h.statuses[h.statuses.length - 1]!;
		expect(last.state).toBe("error");
		expect(last.problems).toEqual([{ code: "model_missing", message: "No model." }]);
	});

	it("starts recognition and the microphone, announces, and listens", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		expect(h.stt.status).toBe("ready");
		expect(h.audio.started).toBe(true);
		expect(h.controller.getStatus().state).toBe("listening");
	});

	it("stop releases everything and reports idle", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		const stopping = h.controller.stop("Turned off.", { announce: true });
		await tick();
		expect(h.tts.spoken).toContain("Voice mode off.");
		h.tts.finish();
		await stopping;
		expect(h.audio.stopped).toBe(true);
		expect(h.stt.disposed).toBe(true);
		expect(h.tts.disposed).toBe(true);
		expect(h.controller.getStatus()).toMatchObject({ state: "idle", detail: "Turned off." });
	});

	it("stops itself when the panel shows another conversation", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		h.orchestrator.switchDisplayed("conv-2");
		await settle();
		expect(h.controller.getStatus().state).toBe("idle");
		expect(h.audio.stopped).toBe(true);
		expect(h.notices.some((n) => n.includes("conversation changed"))).toBe(true);
	});

	it("stops with an announcement when speech recognition fails", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		h.stt.emit("error", "whisper-server stopped repeatedly.");
		await tick();
		expect(h.tts.spoken).toContain("Speech recognition stopped. Voice mode is off.");
		h.tts.finish();
		await settle();
		expect(h.controller.getStatus().state).toBe("idle");
	});
});

describe("VoiceController utterances", () => {
	it("transcribes injected audio and submits the transcript", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		h.stt.transcripts.push("summarize my meeting notes");
		await h.controller.injectAudio(new Float32Array(16_000).fill(0.1));
		expect(h.stt.wavs).toHaveLength(1);
		expect(h.stt.wavs[0]!.byteLength).toBe(44 + 16_000 * 2);
		expect(h.orchestrator.sent).toEqual(["summarize my meeting notes"]);
	});

	it("detects an utterance from microphone frames and submits it after the pause", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		h.stt.transcripts.push("hello from the mic");
		h.audio.feed(0.1, 1000);
		h.audio.feed(0, 2600);
		await settle();
		expect(h.orchestrator.sent).toEqual(["hello from the mic"]);
	});

	it("ignores empty transcripts", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		await h.controller.injectAudio(new Float32Array(16_000));
		expect(h.orchestrator.sent).toEqual([]);
		expect(h.controller.getStatus().state).toBe("listening");
	});

	it("gives the command handler first refusal", async () => {
		const h = makeHarness();
		const handler = vi.fn(async (ctx: { rawTranscript: string }) => ctx.rawTranscript.startsWith("voice command"));
		(h.controller as unknown as { deps: { commandHandler: typeof handler } }).deps.commandHandler = handler;
		await startAndGreet(h);
		await h.controller.injectTranscript("voice command approve");
		await h.controller.injectTranscript("plain message");
		expect(handler).toHaveBeenCalledTimes(2);
		expect(handler.mock.calls[0]![0]).toMatchObject({ conversationId: "conv-1", rawTranscript: "voice command approve", isTurnRunning: false });
		expect(h.orchestrator.sent).toEqual(["plain message"]);
	});
});

describe("VoiceController during a turn", () => {
	it("queues speech while a turn runs and sends it after the summary is spoken", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		const session = h.orchestrator.startTurn([{ role: "user", content: "first request" }]);
		await h.controller.injectTranscript("and also this");
		await h.controller.injectTranscript("one more thing");
		expect(h.orchestrator.sent).toEqual([]);
		expect(h.controller.getStatus()).toMatchObject({ state: "listening", queuedText: "and also this\none more thing" });

		session.conversationManager.addMessage({ role: "assistant", content: "All **done**." });
		h.orchestrator.finishTurn(session);
		await settle();
		// No shaping model in this harness → the last assistant message is spoken as the summary.
		expect(h.tts.spoken).toEqual(["Voice mode on.", "All done."]);
		expect(h.orchestrator.sent).toEqual([]);
		h.tts.finish();
		await settle();
		expect(h.orchestrator.sent).toEqual(["and also this\none more thing"]);
		expect(h.controller.getQueuedText()).toBe("");
	});

	it("uses the shaping model for the summary when one is available", async () => {
		const provider = summaryProvider("I finished the report and found two issues.");
		const h = makeHarness({}, provider);
		await startAndGreet(h);
		const session = h.orchestrator.startTurn([{ role: "user", content: "check the report" }]);
		session.conversationManager.addMessage({ role: "assistant", content: "Long markdown reply…" });
		h.orchestrator.finishTurn(session);
		await settle();
		expect(h.tts.spoken[1]).toBe("I finished the report and found two issues.");
		const [messages] = (provider.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(messages[0]).toEqual({ role: "system", content: "SUMMARY" });
	});

	it("barge-in stops playback but leaves the turn running", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		const session = h.orchestrator.startTurn([{ role: "user", content: "go" }]);
		h.controller.speak("A long announcement that the user talks over.");
		await tick();
		expect(h.tts.isSpeaking).toBe(true);
		h.audio.feed(0.1, 420); // > 3× threshold, sustained past 400 ms
		await tick();
		expect(h.tts.stops).toBe(1);
		expect(h.tts.isSpeaking).toBe(false);
		expect(session.abortController.signal.aborted).toBe(false);
		expect(h.orchestrator.hasActiveSession("conv-1")).toBe(true);
	});

	it("announces approvals once per blocked episode and questions with their options", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		const session = h.orchestrator.startTurn([{ role: "user", content: "write it" }]);
		session.pendingApprovals.set("m1", { resolve: () => {}, toolCallId: "t1", messageId: "m1", toolName: "write_note", parameters: { path: "Ideas.md" } });
		session.setStatus("waiting_approval");
		await settle();
		expect(h.tts.spoken[1]).toBe("Approval needed for writing Ideas. Say approve or reject.");
		h.tts.finish();
		await settle();
		session.setStatus("waiting_approval"); // second status ping in the same episode
		await settle();
		expect(h.tts.spoken).toHaveLength(2);

		session.pendingApprovals.clear();
		session.setStatus("running");
		session.pendingInteractions.set("m2", {
			resolve: () => {},
			reject: () => {},
			messageId: "m2",
			request: { type: "ask", id: "ask-1", questions: [{ question: "Which folder?", suggestions: ["Inbox", "Archive"] }] },
		});
		session.setStatus("waiting_approval");
		await settle();
		expect(h.tts.spoken[2]).toBe("Which folder? Options: 1, Inbox; 2, Archive. Say answer, followed by your reply.");
	});

	it("speaks tool progress at the every_tool level and stays quiet at needs_me", async () => {
		const quiet = makeHarness({ voice_progress_verbosity: "needs_me" });
		await startAndGreet(quiet);
		const s1 = quiet.orchestrator.startTurn([{ role: "user", content: "x" }]);
		quiet.orchestrator.observers.emitToolCallStarted(s1, "read_note", { path: "Daily.md" }, "m");
		await tick();
		expect(quiet.tts.spoken).toEqual(["Voice mode on."]);

		const chatty = makeHarness({ voice_progress_verbosity: "every_tool" });
		await startAndGreet(chatty);
		const s2 = chatty.orchestrator.startTurn([{ role: "user", content: "x" }]);
		chatty.orchestrator.observers.emitToolCallStarted(s2, "read_note", { path: "Daily.md" }, "m");
		chatty.orchestrator.observers.emitToolCallStarted(s2, "search_notes", { query: "plans" }, "m");
		await tick();
		expect(chatty.tts.spoken.slice(1)).toEqual(["reading Daily"]);
		chatty.tts.finish();
		await settle();
		expect(chatty.tts.spoken.slice(1)).toEqual(["reading Daily", "searching for plans"]);
	});

	it("reports cancelled and failed turns", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		const s1 = h.orchestrator.startTurn([{ role: "user", content: "a" }]);
		h.orchestrator.finishTurn(s1, { cancelled: true });
		await settle();
		expect(h.tts.spoken[1]).toBe("Cancelled.");
		h.tts.finish();
		await settle();

		const s2 = h.orchestrator.startTurn([{ role: "user", content: "b" }]);
		s2.conversationManager.addMessage({ role: "error", content: "Provider returned **500**." });
		h.orchestrator.finishTurn(s2, { status: "errored" });
		await settle();
		expect(h.tts.spoken[2]).toBe("The last turn failed: Provider returned 500.");
	});

	it("cancelTurn aborts the running session and does not stop listening", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		const session = h.orchestrator.startTurn([{ role: "user", content: "a" }]);
		expect(h.controller.cancelTurn()).toBe(true);
		expect(session.abortController.signal.aborted).toBe(true);
		expect(h.controller.getStatus().state).toBe("listening");
		h.orchestrator.finishTurn(session, { cancelled: true });
		expect(h.controller.cancelTurn()).toBe(false);
	});

	it("restartRecognition delegates to the backend", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		await h.controller.restartRecognition();
		expect(h.stt.restarted).toBe(1);
	});
});

describe("VoiceController settling prompts by voice", () => {
	function withHooks(h: Harness) {
		const dismissed: Array<[string, string, string | undefined]> = [];
		const reviews: Array<[string, string]> = [];
		const deps = (h.controller as unknown as {
			deps: {
				dismissPrompt?: (id: string, kind: string, decision?: string) => void;
				resolvePlanReview?: (id: string, decision: string) => boolean;
			};
		}).deps;
		deps.dismissPrompt = (id, kind, decision) => {
			dismissed.push([id, kind, decision]);
		};
		deps.resolvePlanReview = (id, decision) => {
			reviews.push([id, decision]);
			return true;
		};
		return { dismissed, reviews };
	}

	it("approvePending and rejectPending settle tool approvals oldest-first and dismiss their prompts", async () => {
		const h = makeHarness();
		const { dismissed } = withHooks(h);
		await startAndGreet(h);
		const session = h.orchestrator.startTurn([{ role: "user", content: "write" }]);
		const decisions: string[] = [];
		session.pendingApprovals.set("m1", { resolve: (d) => decisions.push(`m1:${d}`), toolCallId: "t1", messageId: "m1", toolName: "write_note", parameters: {} });
		session.pendingApprovals.set("m2", { resolve: (d) => decisions.push(`m2:${d}`), toolCallId: "t2", messageId: "m2", toolName: "write_note", parameters: {} });

		expect(h.controller.approvePending()).toBe(1);
		expect(decisions).toEqual(["m1:approved"]);
		session.pendingApprovals.delete("m1"); // the panel's approval closure does this after a decision
		expect(h.controller.rejectPending({ all: true })).toBe(1);
		expect(decisions).toEqual(["m1:approved", "m2:rejected"]);
		expect(dismissed).toEqual([["m1", "approval", "approved"], ["m2", "approval", "rejected"]]);
		session.pendingApprovals.clear();
		expect(h.controller.approvePending()).toBe(0);
	});

	it("approve/reject fall back to a pending plan review", async () => {
		const h = makeHarness();
		const { reviews } = withHooks(h);
		await startAndGreet(h);
		const session = h.orchestrator.startTurn([{ role: "user", content: "plan" }]);
		session.pendingInteractions.set("m9", {
			resolve: () => {},
			reject: () => {},
			messageId: "m9",
			request: { type: "plan-review", id: "pr-1", conversationId: "conv-1", title: "Reorganize notes" },
		});
		expect(h.controller.approvePending()).toBe(1);
		expect(h.controller.rejectPending()).toBe(1);
		expect(reviews).toEqual([["conv-1", "approved"], ["conv-1", "rejected"]]);
		// A plan review is not a question: answerPending leaves it alone.
		expect(h.controller.answerPending(["yes"])).toBe(false);
	});

	it("answerPending resolves the oldest question prompt with index-aligned answers", async () => {
		const h = makeHarness();
		const { dismissed } = withHooks(h);
		await startAndGreet(h);
		const session = h.orchestrator.startTurn([{ role: "user", content: "ask" }]);
		const responses: unknown[] = [];
		session.pendingInteractions.set("m3", {
			resolve: (r) => responses.push(r),
			reject: () => {},
			messageId: "m3",
			request: { type: "ask", id: "ask-1", questions: [{ question: "Folder?" }, { question: "Tags?", multiSelect: true }] },
		});
		expect(h.controller.answerPending(["Inbox"])).toBe(true);
		expect(responses).toEqual([{ id: "ask-1", values: ["Inbox", []] }]);
		expect(dismissed).toEqual([["m3", "interaction", undefined]]);
		session.pendingInteractions.clear();
		expect(h.controller.answerPending(["again"])).toBe(false);
	});

	it("describeState reports pending work and queued dictation", async () => {
		const h = makeHarness();
		await startAndGreet(h);
		expect(h.controller.describeState()).toBe("Idle and listening.");
		const session = h.orchestrator.startTurn([{ role: "user", content: "go" }]);
		h.orchestrator.observers.emitToolCallStarted(session, "read_note", {}, "m");
		await h.controller.injectTranscript("and one more thing");
		expect(h.controller.describeState()).toBe("The assistant is working; 1 tool call so far. 1 message queued.");
		session.pendingApprovals.set("m1", { resolve: () => {}, toolCallId: "t", messageId: "m1", toolName: "write_note", parameters: {} });
		expect(h.controller.describeState()).toBe("1 approval pending. 1 message queued.");
	});
});
