/**
 * Voice controller — the per-panel hands-free loop.
 *
 * Owns one microphone source, one wake-word detector, one speech recognizer,
 * one speech queue and the silence detector, and is bound to a single
 * conversation for its lifetime:
 *
 *   mic frames → wake word → detector → utterance → STT → (voice command?) →
 *   clean-up → submit or queue → turn observer → announcements → summary → TTS
 *
 * Rules (see docs/voice.md):
 * - Armed by default: frames go only to the wake-word detector, and nothing
 *   reaches speech recognition until the wake word is heard.
 * - Each wake word addresses one utterance, ended by a pause; then it is back
 *   to armed. A bare wake word waits a few seconds for speech to start.
 * - While an approval or question is pending, short unaddressed replies are
 *   also recognized ("yes", "no"); anything else unaddressed is dropped.
 * - The wake word while Notor speaks stops playback only; the agent turn
 *   keeps running.
 * - Speech during a running turn is queued and sent as one message after the
 *   turn's summary has been spoken.
 * - The controller stops itself when its panel shows a different conversation.
 *
 * Browser and plugin specifics are injected so the controller is unit-testable
 * with fakes.
 */

import type { NotorSettings } from "../settings/types";
import type { ModelSelection } from "../chat/model-selection";
import type { ConversationSession, PendingApproval, PendingInteraction } from "../chat/conversation-session";
import type { TurnFinishInfo, TurnObserver, TurnStartInfo } from "../chat/turn-observer";
import type { ProviderRegistry } from "../providers/index";
import { getTextContent } from "../media/types";
import { logger } from "../utils/logger";
import { SilenceDetector, type DetectorEvent } from "./audio/silence-detector";
import { encodeWav16kMono } from "./audio/wav-encoder";
import { MicrophoneCaptureError, type AudioSource } from "./audio/audio-capture";
import type { SttBackend, VoiceConfigProblem } from "./stt/types";
import type { TtsBackend } from "./tts/types";
import { SpeechQueue } from "./tts/speech-queue";
import type { VoicePromptFiles } from "./shaping-prompts";
import { buildWhisperInitialPrompt, readVoiceConfig, type VoiceConfig } from "./voice-settings";
import { stripWakeWord } from "./command-matcher";
import { KwsStartError } from "./wake/sherpa-kws-backend";
import type { WakeHit, WakeWordDetector } from "./wake/types";
import {
	buildTurnTranscript,
	cleanupTranscript,
	formatApprovalAnnouncement,
	formatQuestionAnnouncement,
	formatToolProgressLine,
	resolveShapingTarget,
	summarizeTurnForSpeech,
	turnFallbackText,
	truncateSpokenError,
	type ShapingDeps,
} from "./shaping";
import { toSpeakableText } from "./speech-text";

const log = logger("VoiceController");

/** Longest we wait for the farewell line before releasing the speech backend. */
const FAREWELL_TIMEOUT_MS = 8_000;

/** Recent audio kept so an addressed capture can start just before the wake word ended. */
const RING_MS = 3_000;

/**
 * How far before the spotter's hit the addressed capture starts. Hits arrive
 * 0.4–0.6 s after the wake word ends (spike, 2026-10-23), so starting at the
 * hit would clip the first word of "Hey Notor, summarize…"; the wake word's
 * tail that this pulls in is stripped from the transcript.
 */
const REPLAY_LEAD_MS = 800;

export type VoiceEarcon = "arm" | "wake" | "disarm";

/**
 * `armed`: waiting for the wake word. `listening`: addressed — capturing what
 * the user says after it.
 */
export type VoiceState = "idle" | "starting" | "armed" | "listening" | "transcribing" | "thinking" | "speaking" | "error";

export interface VoiceStatus {
	state: VoiceState;
	/** Short human-readable detail for the status chip / tooltip. */
	detail?: string;
	/** Text waiting to be sent once the current turn and its summary finish. */
	queuedText?: string;
	problems?: VoiceConfigProblem[];
}

/** What a voice-command handler learns about an utterance (Milestone B). */
export interface VoiceUtteranceContext {
	conversationId: string;
	rawTranscript: string;
	/** True after the wake word; false for unaddressed replies while something is pending. */
	addressed: boolean;
	isTurnRunning: boolean;
	isSpeaking: boolean;
	pendingApproval: { toolName: string; parameters: Record<string, unknown>; count: number } | null;
	pendingInteraction: { questions: Array<{ question: string; suggestions?: string[] }> } | { planReview: string } | null;
	queuedText: string;
}

/** The orchestrator surface the controller needs (structurally satisfied by ChatOrchestrator). */
export interface VoiceOrchestratorLike {
	hasActiveSession(conversationId: string): boolean;
	getActiveSession(conversationId: string): ConversationSession | undefined;
	handleUserMessage(content: string): Promise<void>;
	addTurnObserver(observer: TurnObserver): () => void;
	addDisplayConversationListener(listener: (conversationId: string | null) => void): () => void;
	getConversationManager(): { getActiveConversation(): { id: string } | null };
	getActiveSelection(): ModelSelection;
}

export interface VoiceControllerDeps {
	orchestrator: VoiceOrchestratorLike;
	leafId: string;
	conversationId: string;
	audio: AudioSource;
	wake: WakeWordDetector;
	stt: SttBackend;
	tts: TtsBackend;
	/** Short non-speech feedback sounds (renderer WebAudio); omitted in tests. */
	earcon?: (kind: VoiceEarcon) => void;
	prompts: VoicePromptFiles;
	providerRegistry: Pick<ProviderRegistry, "getProvider">;
	getSettings: () => NotorSettings;
	onStatus: (status: VoiceStatus) => void;
	/** Milestone B: returns true when the utterance was consumed as a voice command. */
	commandHandler?: (ctx: VoiceUtteranceContext) => Promise<boolean>;
	/** Shown as a Notice when the loop stops on its own. */
	notify?: (message: string) => void;
	/** Remove a stale on-screen prompt after it was settled by voice (the DOM is the panel's business). */
	dismissPrompt?: (messageId: string, kind: "approval" | "interaction", decision?: "approved" | "rejected") => void;
	/** Settle a pending plan review (routed through the PlanReviewController). */
	resolvePlanReview?: (conversationId: string, decision: "approved" | "rejected") => boolean;
	/** Delay before the detector returns to listening onset after Notor stops speaking. Default 300. */
	postSpeechGuardMs?: number;
	setTimeoutFn?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
	now?: () => number;
}

export class VoiceStartError extends Error {
	constructor(public readonly problems: VoiceConfigProblem[], message: string) {
		super(message);
		this.name = "VoiceStartError";
	}
}

export class VoiceController {
	private state: VoiceState = "idle";
	private detail: string | undefined;
	private detector: SilenceDetector | null = null;
	private readonly speech: SpeechQueue;
	private readonly unsubscribers: Array<() => void> = [];
	private sessionUnsubscribe: (() => void) | null = null;
	private stopped = false;
	private started = false;

	private turnRunning = false;
	private summarizing = false;
	private inflightTranscriptions = 0;
	private queuedUtterances: string[] = [];
	private approvalAnnounced = false;
	private questionAnnounced = false;
	private waitingHintSpoken = false;
	private toolCount = 0;
	private lastProgressAt = 0;
	private recognitionFailures = 0;
	private guardTimer: ReturnType<typeof setTimeout> | null = null;

	/** Addressed: the wake word was heard and its utterance has not ended yet. */
	private addressed = false;
	/** Fires when no speech starts after a bare wake word. */
	private listenTimer: ReturnType<typeof setTimeout> | null = null;
	/** Samples given to the wake detector so far (the clock `WakeHit.endSample` uses). */
	private sampleCursor = 0;
	private ring: Array<{ start: number; frame: Float32Array }> = [];
	/** Whether the silence detector received the previous frame. */
	private detectorFed = false;
	/** Samples since the wake word was last heard (stop-on-silence). */
	private idleSamples = 0;

	private readonly setTimeoutFn: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
	private readonly clearTimeoutFn: (id: ReturnType<typeof setTimeout>) => void;
	private readonly now: () => number;

	constructor(private readonly deps: VoiceControllerDeps) {
		// Wrap the globals: in the renderer `window.setTimeout` must not be called
		// with another `this` ("Illegal invocation").
		this.setTimeoutFn = deps.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
		this.clearTimeoutFn = deps.clearTimeoutFn ?? ((id) => clearTimeout(id));
		this.now = deps.now ?? Date.now;
		this.speech = new SpeechQueue(deps.tts, {
			onStart: () => {
				this.cancelGuard();
				this.detector?.setMode("speaking");
				this.refreshState();
			},
			onIdle: () => this.scheduleListeningRestore(),
		});
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	get conversationId(): string {
		return this.deps.conversationId;
	}

	get leafId(): string {
		return this.deps.leafId;
	}

	get isTurnRunning(): boolean {
		return this.turnRunning || this.deps.orchestrator.hasActiveSession(this.deps.conversationId);
	}

	get isSpeaking(): boolean {
		return this.speech.isSpeaking;
	}

	getStatus(): VoiceStatus {
		return {
			state: this.state,
			detail: this.detail,
			queuedText: this.queuedUtterances.length > 0 ? this.queuedUtterances.join("\n") : undefined,
		};
	}

	getQueuedText(): string {
		return this.queuedUtterances.join("\n");
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.setState("starting", "Checking voice configuration…");

		const problems = [...this.deps.stt.preflight(), ...this.deps.wake.preflight()];
		if (problems.length > 0) {
			const message = problems.map((p) => p.message).join(" ");
			this.fail(message, problems);
			throw new VoiceStartError(problems, message);
		}

		this.setState("starting", "Starting speech recognition…");
		try {
			await this.deps.stt.start();
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.fail(message, [{ code: "server_failed", message }]);
			throw new VoiceStartError([{ code: "server_failed", message }], message);
		}

		this.setState("starting", "Opening the microphone…");
		try {
			await this.deps.audio.start((frame) => this.onFrame(frame));
		} catch (e) {
			const problem: VoiceConfigProblem = e instanceof MicrophoneCaptureError
				? { code: e.code, message: e.message }
				: { code: "microphone_unavailable", message: e instanceof Error ? e.message : String(e) };
			void this.deps.stt.dispose();
			this.fail(problem.message, [problem]);
			throw new VoiceStartError([problem], problem.message);
		}

		const config = this.config();
		this.detector = new SilenceDetector({
			sampleRate: this.deps.audio.sampleRate,
			threshold: config.silenceThreshold,
			pauseMs: config.endOfTurnPauseMs,
			minUtteranceMs: config.minUtteranceMs,
			bargeInThresholdMultiplier: config.bargeInMultiplier,
		});

		// Frames flow from here on; the detector counts them while it loads.
		this.setState("starting", "Starting wake-word detection…");
		try {
			await this.deps.wake.start(this.deps.audio.sampleRate);
		} catch (e) {
			const problem: VoiceConfigProblem = e instanceof KwsStartError
				? e.problem
				: { code: "kws_failed", message: e instanceof Error ? e.message : String(e) };
			this.detector = null;
			void this.deps.stt.dispose();
			void this.deps.wake.dispose();
			this.fail(problem.message, [problem]);
			throw new VoiceStartError([problem], problem.message);
		}

		this.unsubscribers.push(
			this.deps.orchestrator.addTurnObserver(this.turnObserver()),
			this.deps.orchestrator.addDisplayConversationListener((id) => {
				if (id !== this.deps.conversationId) {
					this.deps.notify?.("Voice mode turned off: the conversation changed.");
					void this.stop("The conversation changed.", { announce: false });
				}
			}),
			this.deps.stt.onStatus((status, detail) => {
				if (status === "error" && !this.stopped) {
					this.deps.notify?.(`Voice mode turned off: ${detail ?? "speech recognition failed."}`);
					void this.stop(detail ?? "Speech recognition failed.", { announce: true, announcement: "Speech recognition stopped. Voice mode is off." });
				}
			}),
			this.deps.wake.onHit((hit) => this.onWakeHit(hit)),
			this.deps.wake.onStatus((status, detail) => {
				if (status === "error" && !this.stopped) {
					this.deps.notify?.(`Voice mode turned off: ${detail ?? "wake-word detection failed."}`);
					void this.stop(detail ?? "Wake-word detection failed.", { announce: true, announcement: "Wake word detection stopped. Voice mode is off." });
				}
			}),
		);

		if (this.deps.orchestrator.hasActiveSession(this.deps.conversationId)) {
			this.turnRunning = true;
		}
		this.state = "armed";
		this.refreshState();
		this.earcon("arm");
		this.deps.notify?.(`Voice mode on. Say “${config.wakeWord}” to talk.`);
		log.info("Voice mode started", { leafId: this.deps.leafId, conversationId: this.deps.conversationId });
	}

	/**
	 * Stop the loop. Input stops immediately; when `announce` is set the
	 * farewell line is spoken before the speech backend is released.
	 */
	async stop(reason: string, opts: { announce?: boolean; announcement?: string } = {}): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.cancelGuard();
		this.clearListenTimer();
		this.addressed = false;
		this.ring = [];
		for (const unsubscribe of this.unsubscribers.splice(0)) {
			try {
				unsubscribe();
			} catch {
				// ignore
			}
		}
		this.sessionUnsubscribe?.();
		this.sessionUnsubscribe = null;
		this.detector = null;
		this.queuedUtterances = [];
		try {
			this.deps.audio.stop();
		} catch (e) {
			log.warn("audio stop failed", { error: String(e) });
		}
		void this.deps.stt.dispose().catch((e) => log.warn("stt dispose failed", { error: String(e) }));
		void this.deps.wake.dispose().catch((e) => log.warn("wake dispose failed", { error: String(e) }));

		this.speech.interrupt();
		this.earcon("disarm");
		if (opts.announce) {
			let timer: ReturnType<typeof setTimeout> | null = null;
			try {
				await Promise.race([
					this.deps.tts.speak(opts.announcement ?? "Voice mode off."),
					new Promise<void>((resolve) => {
						timer = this.setTimeoutFn(resolve, FAREWELL_TIMEOUT_MS);
					}),
				]);
			} catch {
				// best effort
			} finally {
				if (timer !== null) this.clearTimeoutFn(timer);
			}
		}
		this.deps.tts.dispose();
		log.info("Voice mode stopped", { reason });
		this.setState("idle", reason);
	}

	/** Restart speech recognition and wake-word detection in place (after system wake). */
	async restartRecognition(): Promise<void> {
		if (this.stopped) return;
		try {
			await this.deps.stt.restart?.();
		} catch (e) {
			log.warn("Speech recognition restart failed", { error: String(e) });
		}
		await this.restartWakeWord();
	}

	/** Restart wake-word detection in place (after system wake or a wake-word settings change). */
	async restartWakeWord(): Promise<void> {
		if (this.stopped || !this.deps.wake.restart) return;
		try {
			await this.deps.wake.restart();
		} catch (e) {
			log.warn("Wake-word detection restart failed", { error: String(e) });
		}
	}

	/** True while the wake word has been heard and its utterance is still being captured. */
	get isAddressed(): boolean {
		return this.addressed;
	}

	/** Queue a line to speak (announcement priority). */
	speak(text: string, opts: { interrupt?: boolean } = {}): void {
		if (this.stopped) return;
		if (opts.interrupt) this.speech.interrupt();
		this.speech.enqueue(text, "announce");
	}

	stopSpeaking(): void {
		this.speech.interrupt();
	}

	repeatLast(): boolean {
		return this.speech.repeatLast();
	}

	/** Abort the running turn for this conversation (the agent stops; listening continues). */
	cancelTurn(): boolean {
		const session = this.deps.orchestrator.getActiveSession(this.deps.conversationId);
		if (!session) return false;
		session.abortController.abort();
		return true;
	}

	/** Send the queued utterances now (ignored while a turn is running). */
	async sendQueued(): Promise<boolean> {
		if (this.queuedUtterances.length === 0 || this.isBusy()) return false;
		await this.flushQueued();
		return true;
	}

	clearQueued(): void {
		this.queuedUtterances = [];
		this.refreshState();
	}

	/** Pending approvals of the running turn (oldest first). */
	getPendingApprovals(): PendingApproval[] {
		const session = this.deps.orchestrator.getActiveSession(this.deps.conversationId);
		return session ? [...session.pendingApprovals.values()] : [];
	}

	/** Pending interactions (follow-up questions / plan reviews) of the running turn. */
	getPendingInteractions(): PendingInteraction[] {
		const session = this.deps.orchestrator.getActiveSession(this.deps.conversationId);
		return session ? [...session.pendingInteractions.values()] : [];
	}

	/**
	 * Approve the oldest pending tool approval (or all of them). When no tool
	 * approval is pending but a plan review is, approves the plan instead.
	 * Returns how many items were settled.
	 */
	approvePending(opts: { all?: boolean } = {}): number {
		return this.settlePending("approved", opts.all === true);
	}

	/** Reject the oldest pending tool approval (or all), or a pending plan review. */
	rejectPending(opts: { all?: boolean } = {}): number {
		return this.settlePending("rejected", opts.all === true);
	}

	/**
	 * Answer the oldest pending question prompt. `values` are index-aligned with
	 * the prompt's questions; missing answers are left blank. Returns false when
	 * no question is pending.
	 */
	answerPending(values: Array<string | string[]>): boolean {
		const pending = this.getPendingInteractions().find((p) => p.request.type === "ask");
		if (!pending || pending.request.type !== "ask") return false;
		const answers = pending.request.questions.map((question, index) => {
			const value = values[index];
			if (question.multiSelect) return Array.isArray(value) ? value : value ? [value] : [];
			return Array.isArray(value) ? value.join(", ") : (value ?? "");
		});
		pending.resolve({ id: pending.request.id, values: answers });
		this.deps.dismissPrompt?.(pending.messageId, "interaction");
		return true;
	}

	/** One or two spoken sentences describing what voice mode is doing right now. */
	describeState(): string {
		const parts: string[] = [];
		const approvals = this.getPendingApprovals();
		const questions = this.getPendingInteractions();
		if (approvals.length > 0) parts.push(`${approvals.length} approval${approvals.length === 1 ? "" : "s"} pending.`);
		else if (questions.length > 0) parts.push("Waiting for your answer.");
		else if (this.isTurnRunning) parts.push(`The assistant is working; ${this.toolCount} tool call${this.toolCount === 1 ? "" : "s"} so far.`);
		else parts.push(`Idle. Say ${this.config().wakeWord} to talk.`);
		if (this.queuedUtterances.length > 0) parts.push(`${this.queuedUtterances.length} message${this.queuedUtterances.length === 1 ? "" : "s"} queued.`);
		return parts.join(" ");
	}

	private settlePending(decision: "approved" | "rejected", all: boolean): number {
		const approvals = this.getPendingApprovals();
		if (approvals.length > 0) {
			const targets = all ? approvals : approvals.slice(0, 1);
			for (const pending of targets) {
				pending.resolve(decision);
				this.deps.dismissPrompt?.(pending.messageId, "approval", decision);
			}
			return targets.length;
		}
		const review = this.getPendingInteractions().find((p) => p.request.type === "plan-review");
		if (review && review.request.type === "plan-review" && this.deps.resolvePlanReview) {
			return this.deps.resolvePlanReview(review.request.conversationId, decision) ? 1 : 0;
		}
		return 0;
	}

	/** The running session for this conversation, if any. */
	getSession(): ConversationSession | undefined {
		return this.deps.orchestrator.getActiveSession(this.deps.conversationId);
	}

	/** Test seam: act as if the wake word had just been heard. */
	injectWake(): void {
		this.onWakeHit({ keyword: "injected", endSample: this.sampleCursor });
	}

	/**
	 * Test/automation seam: feed a transcript as if it had just been recognized.
	 * Addressed (said after the wake word) unless `addressed: false`.
	 */
	async injectTranscript(text: string, opts: { addressed?: boolean } = {}): Promise<void> {
		if (this.stopped) return;
		await this.routeTranscript(text.trim(), opts.addressed !== false);
	}

	/** Test seam: feed PCM audio as a complete utterance (bypasses the microphone). */
	async injectAudio(
		samples: Float32Array,
		sampleRate: number = this.deps.audio.sampleRate,
		opts: { addressed?: boolean } = {},
	): Promise<void> {
		if (this.stopped) return;
		await this.handleUtterance(samples, sampleRate, opts.addressed !== false);
	}

	/** Build the context handed to voice-command handlers (Milestone B). */
	buildUtteranceContext(rawTranscript: string, addressed = true): VoiceUtteranceContext {
		const approvals = this.getPendingApprovals();
		const interactions = this.getPendingInteractions();
		let pendingInteraction: VoiceUtteranceContext["pendingInteraction"] = null;
		const first = interactions[0];
		if (first) {
			pendingInteraction = first.request.type === "ask"
				? { questions: first.request.questions.map((q) => ({ question: q.question, suggestions: q.suggestions })) }
				: { planReview: first.request.title };
		}
		return {
			conversationId: this.deps.conversationId,
			rawTranscript,
			addressed,
			isTurnRunning: this.isTurnRunning,
			isSpeaking: this.speech.isSpeaking,
			pendingApproval: approvals[0]
				? { toolName: approvals[0].toolName, parameters: approvals[0].parameters, count: approvals.length }
				: null,
			pendingInteraction,
			queuedText: this.getQueuedText(),
		};
	}

	// -----------------------------------------------------------------------
	// Audio → utterance
	// -----------------------------------------------------------------------

	private onFrame(frame: Float32Array): void {
		if (this.stopped || !this.detector) return;
		const start = this.sampleCursor;
		this.sampleCursor += frame.length;
		this.remember(start, frame);
		this.deps.wake.push(frame);
		this.feedDetector(frame);
		this.trackIdle(frame.length);
	}

	/** Keep the last few seconds of audio for replay after a wake hit. */
	private remember(start: number, frame: Float32Array): void {
		this.ring.push({ start, frame });
		const keepFrom = this.sampleCursor - this.samplesOf(RING_MS);
		while (this.ring.length > 1 && this.ring[0]!.start + this.ring[0]!.frame.length <= keepFrom) this.ring.shift();
	}

	/**
	 * The silence detector only hears audio while the user is addressing Notor,
	 * or while Notor is waiting on an approval or answer (for bare "yes"/"no").
	 */
	private feedDetector(frame: Float32Array): void {
		const detector = this.detector!;
		if (!this.addressed && !this.isAwaitingReply()) {
			if (this.detectorFed) {
				detector.reset();
				this.detectorFed = false;
			}
			return;
		}
		if (!this.detectorFed) {
			detector.reset();
			this.detectorFed = true;
		}
		for (const event of detector.push(frame)) this.handleDetectorEvent(event);
	}

	private onWakeHit(hit: WakeHit): void {
		if (this.stopped || !this.detector || this.addressed) return;
		log.info("Wake word heard", { keyword: hit.keyword });
		if (this.speech.isSpeaking) {
			log.debug("Barge-in: stopping speech");
			this.speech.interrupt();
		}
		this.addressed = true;
		this.idleSamples = 0;
		this.earcon("wake");
		this.startListenTimer();

		// Start the capture just before the wake word ended, so "Hey Notor,
		// summarize…" said in one breath keeps its first word.
		const detector = this.detector;
		detector.reset();
		detector.setMode("listening");
		this.detectorFed = true;
		const from = hit.endSample - this.samplesOf(REPLAY_LEAD_MS);
		for (const { start, frame } of [...this.ring]) {
			if (start + frame.length <= from) continue;
			const part = start >= from ? frame : frame.subarray(from - start);
			for (const event of detector.push(part)) this.handleDetectorEvent(event);
			if (this.stopped || !this.addressed) break;
		}
		this.refreshState();
	}

	private handleDetectorEvent(event: DetectorEvent): void {
		switch (event.type) {
			case "speech_start":
				if (this.addressed) this.clearListenTimer();
				break;
			case "utterance_end": {
				// One utterance per wake word: back to armed straight away.
				const addressed = this.addressed;
				this.addressed = false;
				this.clearListenTimer();
				this.idleSamples = 0;
				void this.handleUtterance(event.samples, this.deps.audio.sampleRate, addressed);
				break;
			}
			case "utterance_discarded":
				log.debug("Discarded short utterance", { durationMs: Math.round(event.durationMs) });
				// Often just the wake word's tail; keep waiting for the real prompt.
				if (this.addressed && this.listenTimer === null) this.startListenTimer();
				break;
			case "silence_timeout":
				break;
		}
	}

	private startListenTimer(): void {
		this.clearListenTimer();
		this.listenTimer = this.setTimeoutFn(() => {
			this.listenTimer = null;
			if (this.stopped || !this.addressed || this.detector?.isInSpeech) return;
			log.debug("Nothing said after the wake word");
			this.addressed = false;
			this.earcon("disarm");
			this.refreshState();
		}, this.config().wakeListenTimeoutMs);
	}

	private clearListenTimer(): void {
		if (this.listenTimer !== null) {
			this.clearTimeoutFn(this.listenTimer);
			this.listenTimer = null;
		}
	}

	/** Stop-on-silence: turn off after a long stretch with no wake word and nothing going on. */
	private trackIdle(samples: number): void {
		const stopMs = this.config().stopOnSilenceMs;
		if (stopMs <= 0 || this.addressed || this.isBusy() || this.inflightTranscriptions > 0 || this.isAwaitingReply()) {
			this.idleSamples = 0;
			return;
		}
		this.idleSamples += samples;
		if (this.idleSamples >= this.samplesOf(stopMs)) {
			this.idleSamples = 0;
			this.deps.notify?.("Voice mode turned off after silence.");
			void this.stop("Turned off after silence.", { announce: true, announcement: "Voice mode off after silence." });
		}
	}

	/** True while the bound conversation waits on an approval, question or plan review. */
	private isAwaitingReply(): boolean {
		const session = this.getSession();
		return session !== undefined && (session.pendingApprovals.size > 0 || session.pendingInteractions.size > 0);
	}

	private async handleUtterance(samples: Float32Array, sampleRate: number, addressed: boolean): Promise<void> {
		if (this.stopped) return;
		this.inflightTranscriptions++;
		this.refreshState();
		try {
			const wav = encodeWav16kMono(samples, sampleRate);
			const prompt = buildWhisperInitialPrompt(this.config());
			const transcript = (await this.deps.stt.transcribe(wav, prompt ? { prompt } : undefined)).trim();
			this.recognitionFailures = 0;
			if (!transcript) return;
			log.info("Transcript", { chars: transcript.length, addressed, text: transcript.slice(0, 200) });
			await this.routeTranscript(transcript, addressed);
		} catch (e) {
			this.recognitionFailures++;
			log.warn("Transcription failed", { error: String(e) });
			if (this.recognitionFailures === 1 && addressed) {
				this.speech.enqueue("Sorry, speech recognition failed for that.", "announce");
			}
		} finally {
			this.inflightTranscriptions--;
			this.refreshState();
		}
	}

	// -----------------------------------------------------------------------
	// Transcript → command / chat
	// -----------------------------------------------------------------------

	private async routeTranscript(transcript: string, addressed: boolean): Promise<void> {
		if (!transcript || this.stopped) return;
		const config = this.config();

		if (this.deps.commandHandler) {
			try {
				if (await this.deps.commandHandler(this.buildUtteranceContext(transcript, addressed))) return;
			} catch (e) {
				log.error("Voice command handler threw", { error: String(e) });
			}
			if (this.stopped) return;
		}

		// Unaddressed speech is only ever a reply to a pending prompt.
		if (!addressed) {
			log.debug("Dropped unaddressed utterance", { chars: transcript.length });
			return;
		}

		const text = stripWakeWord(transcript, config.wakeWordSpellings);
		if (!text) {
			// Only the wake word was recognized: keep listening for the prompt.
			if (!this.addressed) {
				this.addressed = true;
				this.startListenTimer();
				this.refreshState();
			}
			return;
		}

		if (!this.isBoundConversationDisplayed()) {
			this.deps.notify?.("Voice mode turned off: the conversation changed.");
			await this.stop("The conversation changed.", { announce: false });
			return;
		}

		const cleaned = await cleanupTranscript(text, config, this.shapingDeps(config));
		if (!cleaned || this.stopped) return;

		if (this.isBusy()) {
			this.queuedUtterances.push(cleaned);
			log.info("Queued utterance during turn", { queued: this.queuedUtterances.length });
			const session = this.getSession();
			if (session?.status === "waiting_approval" && !this.waitingHintSpoken && config.verbosity !== "silent") {
				this.waitingHintSpoken = true;
				this.speech.enqueue("I'm waiting for your approval. Say approve or reject; your message is queued.", "announce");
			}
			this.refreshState();
			return;
		}
		const queued = this.queuedUtterances.splice(0);
		await this.submit([...queued, cleaned].join("\n"));
	}

	private async submit(text: string): Promise<void> {
		if (this.stopped) return;
		if (!this.isBoundConversationDisplayed()) {
			this.deps.notify?.("Voice mode turned off: the conversation changed.");
			await this.stop("The conversation changed.", { announce: false });
			return;
		}
		log.info("Submitting utterance", { chars: text.length });
		// Resolves only when the turn ends — observers drive the rest.
		this.deps.orchestrator.handleUserMessage(text).catch((e) => {
			log.error("handleUserMessage failed", { error: String(e) });
		});
	}

	private async flushQueued(): Promise<void> {
		if (this.stopped || this.queuedUtterances.length === 0 || this.isBusy()) return;
		const text = this.queuedUtterances.join("\n");
		this.queuedUtterances = [];
		this.refreshState();
		await this.submit(text);
	}

	/** True while anything would make a submit inappropriate right now. */
	private isBusy(): boolean {
		return this.isTurnRunning || this.summarizing || this.speech.isSpeaking;
	}

	private isBoundConversationDisplayed(): boolean {
		return this.deps.orchestrator.getConversationManager().getActiveConversation()?.id === this.deps.conversationId;
	}

	// -----------------------------------------------------------------------
	// Turn lifecycle → speech
	// -----------------------------------------------------------------------

	private turnObserver(): TurnObserver {
		const mine = (session: ConversationSession) => session.conversationId === this.deps.conversationId;
		return {
			onTurnStarted: (session, info) => {
				if (!mine(session)) return;
				this.onTurnStarted(session, info);
			},
			onToolCallStarted: (session, toolName, parameters) => {
				if (!mine(session)) return;
				this.onToolCallStarted(toolName, parameters);
			},
			onTurnFinished: (session, info) => {
				if (!mine(session)) return;
				this.onTurnFinished(session, info);
			},
		};
	}

	private onTurnStarted(session: ConversationSession, _info: TurnStartInfo): void {
		this.turnRunning = true;
		this.toolCount = 0;
		this.lastProgressAt = this.now();
		this.approvalAnnounced = false;
		this.questionAnnounced = false;
		this.waitingHintSpoken = false;
		this.sessionUnsubscribe?.();
		this.sessionUnsubscribe = session.addStatusListener((s) => this.onSessionStatus(s));
		this.refreshState();
	}

	private onToolCallStarted(toolName: string, parameters: Record<string, unknown>): void {
		this.toolCount++;
		const config = this.config();
		if (config.verbosity === "every_tool") {
			this.speech.enqueue(formatToolProgressLine(toolName, parameters), "progress");
		} else if (config.verbosity === "periodic") {
			const elapsed = this.now() - this.lastProgressAt;
			if (elapsed >= config.progressIntervalMs) {
				this.lastProgressAt = this.now();
				this.speech.enqueue(
					`Still working. ${this.toolCount} tool call${this.toolCount === 1 ? "" : "s"} so far; now ${formatToolProgressLine(toolName, parameters)}.`,
					"progress",
				);
			}
		}
	}

	private onSessionStatus(session: ConversationSession): void {
		if (session.status === "running") {
			// Blocked episode over; a later one gets announced again.
			this.approvalAnnounced = false;
			this.questionAnnounced = false;
			this.refreshState();
			return;
		}
		if (session.status !== "waiting_approval") return;
		// The interaction path sets the status before populating its map; read lazily.
		this.setTimeoutFn(() => {
			this.announceWaiting(session);
			this.refreshState();
		}, 0);
	}

	private announceWaiting(session: ConversationSession): void {
		if (this.stopped || this.config().verbosity === "silent") return;
		if (session.pendingApprovals.size > 0 && !this.approvalAnnounced) {
			this.approvalAnnounced = true;
			this.speech.enqueue(formatApprovalAnnouncement([...session.pendingApprovals.values()]), "announce");
			return;
		}
		if (session.pendingInteractions.size > 0 && !this.questionAnnounced) {
			this.questionAnnounced = true;
			const first = [...session.pendingInteractions.values()][0]!;
			const line = first.request.type === "ask"
				? formatQuestionAnnouncement(first.request.questions)
				: `A plan is ready for review: ${first.request.title}. Review it on screen, or say approve or reject.`;
			this.speech.enqueue(line, "announce");
		}
	}

	private onTurnFinished(session: ConversationSession, info: TurnFinishInfo): void {
		this.turnRunning = false;
		this.sessionUnsubscribe?.();
		this.sessionUnsubscribe = null;
		void this.finishTurn(session, info);
	}

	private async finishTurn(session: ConversationSession, info: TurnFinishInfo): Promise<void> {
		if (this.stopped) return;
		this.summarizing = true;
		this.refreshState();
		let spoken = "";
		try {
			const config = this.config();
			const messages = session.conversationManager.getMessages();
			if (info.cancelled) {
				spoken = "Cancelled.";
			} else if (info.status === "errored") {
				const error = [...messages].reverse().find((m) => m.role === "error");
				const headline = error ? truncateSpokenError(toSpeakableText(getTextContent(error.content))) : "";
				spoken = headline ? `The last turn failed: ${headline}` : "The last turn failed.";
			} else {
				const transcript = buildTurnTranscript(messages, info.userMessageId);
				const fallback = turnFallbackText(messages, info.userMessageId);
				spoken = await summarizeTurnForSpeech(transcript, fallback, config, this.shapingDeps(config));
			}
		} catch (e) {
			log.warn("finishTurn failed", { error: String(e) });
		} finally {
			this.summarizing = false;
		}
		if (this.stopped) return;
		if (spoken) {
			this.speech.enqueue(spoken, "final");
		} else {
			this.refreshState();
			await this.flushQueued();
		}
	}

	// -----------------------------------------------------------------------
	// Speech-state plumbing
	// -----------------------------------------------------------------------

	private scheduleListeningRestore(): void {
		this.cancelGuard();
		const delay = this.deps.postSpeechGuardMs ?? 300;
		this.guardTimer = this.setTimeoutFn(() => {
			this.guardTimer = null;
			if (this.stopped) return;
			this.detector?.setMode("listening");
			this.refreshState();
			void this.flushQueued();
		}, delay);
	}

	private cancelGuard(): void {
		if (this.guardTimer !== null) {
			this.clearTimeoutFn(this.guardTimer);
			this.guardTimer = null;
		}
	}

	private refreshState(): void {
		if (this.stopped) return;
		if (this.state === "starting" || this.state === "error") return;
		const queued = this.queuedUtterances.length > 0 ? `${this.queuedUtterances.length} queued` : undefined;
		if (this.inflightTranscriptions > 0) this.setState("transcribing", queued);
		else if (this.speech.isSpeaking) this.setState("speaking", queued);
		else if (this.summarizing) this.setState("thinking", "Summarizing the reply…");
		else if (this.addressed) this.setState("listening", queued);
		else if (this.isAwaitingReply()) this.setState("armed", queued ?? "Waiting for your reply");
		else if (this.turnRunning) this.setState("armed", queued ?? "Working…");
		else this.setState("armed", queued ?? `Say “${this.config().wakeWord}”`);
	}

	private setState(state: VoiceState, detail?: string): void {
		this.state = state;
		this.detail = detail;
		try {
			this.deps.onStatus(this.getStatus());
		} catch (e) {
			log.error("onStatus threw", { error: String(e) });
		}
	}

	private fail(message: string, problems: VoiceConfigProblem[]): void {
		this.state = "error";
		this.detail = message;
		this.stopped = true;
		try {
			this.deps.audio.stop();
		} catch {
			// not started
		}
		this.deps.onStatus({ state: "error", detail: message, problems });
	}

	private config(): VoiceConfig {
		return readVoiceConfig(this.deps.getSettings());
	}

	private earcon(kind: VoiceEarcon): void {
		if (!this.deps.earcon || !this.config().wakeEarconEnabled) return;
		try {
			this.deps.earcon(kind);
		} catch (e) {
			log.debug("earcon failed", { error: String(e) });
		}
	}

	private samplesOf(ms: number): number {
		return Math.round((ms / 1000) * this.deps.audio.sampleRate);
	}

	private shapingDeps(config: VoiceConfig): ShapingDeps {
		const settings = this.deps.getSettings();
		return {
			settings,
			prompts: this.deps.prompts,
			target: resolveShapingTarget(config, settings, this.deps.orchestrator.getActiveSelection(), this.deps.providerRegistry),
		};
	}
}
