/**
 * Voice manager — plugin-level owner of voice controllers.
 *
 * One controller per chat panel (leaf), at most one active at a time because
 * the microphone is a single shared resource. Builds the real backends
 * (microphone, whisper-server, `say`) from settings, relays status to the UI,
 * and offers test seams that bypass the microphone.
 */

import { Notice, Platform } from "obsidian";
import type NotorPlugin from "../main";
import type { ChatOrchestrator } from "../chat/orchestrator";
import { logger } from "../utils/logger";
import { getPlanReviewController } from "../plans/plan-review-controller";
import { dispatchOnVoiceCommand } from "../hooks/hook-events";
import { matchVoiceCommand } from "./command-matcher";
import { VoiceController, type VoiceStatus, type VoiceUtteranceContext } from "./voice-controller";
import { WhisperServerBackend } from "./stt/whisper-server-backend";
import type { VoiceConfigProblem } from "./stt/types";
import { CommandTts } from "./tts/command-tts";
import { MicrophoneAudioSource, type AudioSource } from "./audio/audio-capture";
import { createVoicePromptFiles, type VoicePromptFiles } from "./shaping-prompts";
import { buildWhisperInitialPrompt, readVoiceConfig } from "./voice-settings";

const log = logger("VoiceManager");

export const IDLE_VOICE_STATUS: VoiceStatus = { state: "idle" };

export type VoiceCommandHandler = (ctx: VoiceUtteranceContext) => Promise<boolean>;

/** Audio source that never produces frames (test seam: transcripts are injected instead). */
class SilentAudioSource implements AudioSource {
	readonly sampleRate = 16_000;
	start(): Promise<void> {
		return Promise.resolve();
	}
	stop(): void {
		// nothing to release
	}
}

export class VoiceManager {
	private readonly controllers = new Map<string, VoiceController>();
	private readonly statuses = new Map<string, VoiceStatus>();
	private readonly listeners = new Set<(leafId: string, status: VoiceStatus) => void>();
	private commandHandler: VoiceCommandHandler | null = null;
	private disposed = false;

	constructor(private readonly plugin: NotorPlugin) {
		this.commandHandler = (ctx) => this.dispatchVoiceCommand(ctx);
	}

	// -----------------------------------------------------------------------
	// Availability and status
	// -----------------------------------------------------------------------

	/** True when the platform supports voice mode and the user has enabled it. */
	isAvailable(): boolean {
		return Platform.isMacOS && this.plugin.settings.voice_enabled === true;
	}

	/** Environment check without starting anything. */
	preflight(): VoiceConfigProblem[] {
		return this.createStt().preflight();
	}

	getStatus(leafId: string): VoiceStatus {
		return this.statuses.get(leafId) ?? IDLE_VOICE_STATUS;
	}

	onStatusChange(listener: (leafId: string, status: VoiceStatus) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getController(leafId: string): VoiceController | null {
		return this.controllers.get(leafId) ?? null;
	}

	getControllerForConversation(conversationId: string): VoiceController | null {
		for (const controller of this.controllers.values()) {
			if (controller.conversationId === conversationId) return controller;
		}
		return null;
	}

	/** The active controller, if voice mode is on anywhere. */
	getActiveController(): VoiceController | null {
		return [...this.controllers.values()][0] ?? null;
	}

	/**
	 * Replace the voice-command handler (default: `on_voice_command` automations
	 * via the extension manager). Pass null to send every utterance as chat.
	 */
	setCommandHandler(handler: VoiceCommandHandler | null): void {
		this.commandHandler = handler;
	}

	getPromptFiles(): VoicePromptFiles {
		return createVoicePromptFiles(this.plugin.app.vault, this.plugin.settings.notor_dir);
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	/** Turn voice mode on or off for the panel behind `orchestrator`. */
	async toggle(orchestrator: ChatOrchestrator): Promise<void> {
		const leafId = orchestrator.getView()?.leaf.id;
		if (!leafId) {
			new Notice("Open a chat panel to use voice mode.");
			return;
		}
		const existing = this.controllers.get(leafId);
		if (existing) {
			await existing.stop("Turned off.", { announce: true });
			return;
		}
		await this.startForOrchestrator(orchestrator);
	}

	/**
	 * Start voice mode for a panel, bound to its displayed conversation (a new
	 * one is created when the panel shows none). Returns null when it could not
	 * start; the reason has been shown as a Notice.
	 */
	async startForOrchestrator(
		orchestrator: ChatOrchestrator,
		opts: { withoutCapture?: boolean } = {},
	): Promise<VoiceController | null> {
		if (this.disposed) return null;
		const view = orchestrator.getView();
		if (!view) {
			new Notice("Open a chat panel to use voice mode.");
			return null;
		}
		const leafId = view.leaf.id;
		if (!Platform.isMacOS) {
			new Notice("Voice mode is only available on macOS.");
			return null;
		}
		if (!this.plugin.settings.voice_enabled) {
			this.noticeWithSettingsLink("Voice mode is turned off. Enable it in Settings → Notor → Voice.");
			return null;
		}
		const running = this.controllers.get(leafId);
		if (running) return running;

		const conversationManager = orchestrator.getConversationManager();
		if (!conversationManager.hasActiveConversation()) {
			await orchestrator.newConversation();
		}
		const conversationId = conversationManager.getActiveConversation()?.id;
		if (!conversationId) {
			new Notice("Voice mode needs an open conversation.");
			return null;
		}

		// The microphone is exclusive: voice mode lives in one panel at a time.
		for (const [otherLeaf, other] of [...this.controllers]) {
			if (otherLeaf === leafId) continue;
			await other.stop("Voice mode moved to another panel.", { announce: false });
			new Notice("Voice mode moved to this panel.");
		}

		const config = readVoiceConfig(this.plugin.settings);
		const controller = new VoiceController({
			orchestrator,
			leafId,
			conversationId,
			audio: opts.withoutCapture ? new SilentAudioSource() : new MicrophoneAudioSource(),
			stt: this.createStt(),
			tts: new CommandTts({ command: config.ttsCommand, voice: config.ttsVoice, rate: config.ttsRate }),
			prompts: this.getPromptFiles(),
			providerRegistry: this.plugin.getProviderRegistry(),
			getSettings: () => this.plugin.settings,
			onStatus: (status) => this.handleStatus(leafId, status),
			commandHandler: (ctx) => (this.commandHandler ? this.commandHandler(ctx) : Promise.resolve(false)),
			notify: (message) => {
				new Notice(message);
			},
			dismissPrompt: (messageId, kind, decision) => {
				const view = orchestrator.getView();
				if (!view) return;
				const toolCallEl = view.getToolCallEl(messageId);
				if (kind === "interaction") {
					toolCallEl?.querySelectorAll(".notor-interaction-prompt").forEach((el) => el.remove());
					return;
				}
				// A voice decision settles the dispatcher's promise, not the prompt's own,
				// so its buttons would stay on screen. Inline prompts live in the tool-call
				// card; diff previews are appended to the message list oldest-first, so the
				// first one still showing actions belongs to the approval just settled.
				const inline = toolCallEl ? Array.from(toolCallEl.querySelectorAll(".notor-approval-prompt")) : [];
				if (inline.length > 0) {
					inline.forEach((el) => el.remove());
					return;
				}
				const actions = view.containerEl.querySelector(".notor-diff-actions");
				if (!actions) return;
				const wrapper = actions.parentElement;
				actions.remove();
				if (!wrapper || !decision) return;
				const rejected = decision === "rejected";
				wrapper.createDiv({
					cls: `notor-diff-status ${rejected ? "notor-diff-status-rejected" : "notor-diff-status-applied"}`,
					text: rejected ? "✗ Rejected by voice" : "✓ Approved by voice",
				});
			},
			resolvePlanReview: (reviewConversationId, decision) =>
				getPlanReviewController()?.resolve(
					reviewConversationId,
					decision === "approved" ? { kind: "approve" } : { kind: "reject", reason: "Rejected by voice command." },
				) ?? false,
		});
		this.controllers.set(leafId, controller);

		try {
			await controller.start();
		} catch (e) {
			this.controllers.delete(leafId);
			const message = e instanceof Error ? e.message : String(e);
			log.warn("Voice mode failed to start", { leafId, error: message });
			this.noticeWithSettingsLink(`Voice mode could not start: ${message}`);
			return null;
		}
		return controller;
	}

	/** Stop voice mode for a panel (used when the panel closes). */
	async stopForLeaf(leafId: string): Promise<void> {
		const controller = this.controllers.get(leafId);
		if (!controller) return;
		await controller.stop("Panel closed.", { announce: false });
	}

	async stopAll(reason = "Stopped."): Promise<void> {
		for (const controller of [...this.controllers.values()]) {
			await controller.stop(reason, { announce: false });
		}
	}

	/** After system wake the whisper server may be gone; restart it for any active controller. */
	async restartRecognitionAfterWake(): Promise<void> {
		for (const controller of [...this.controllers.values()]) {
			await controller.restartRecognition();
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.stopAll("Plugin unloading.");
		this.listeners.clear();
		this.statuses.clear();
	}

	// -----------------------------------------------------------------------
	// Test and automation seams (bypass the microphone)
	// -----------------------------------------------------------------------

	startWithoutCapture(orchestrator: ChatOrchestrator): Promise<VoiceController | null> {
		return this.startForOrchestrator(orchestrator, { withoutCapture: true });
	}

	injectTranscript(leafId: string, text: string): Promise<void> {
		const controller = this.controllers.get(leafId);
		if (!controller) return Promise.reject(new Error(`No voice controller for leaf ${leafId}`));
		return controller.injectTranscript(text);
	}

	injectAudio(leafId: string, samples: ArrayLike<number>, sampleRate = 16_000): Promise<void> {
		const controller = this.controllers.get(leafId);
		if (!controller) return Promise.reject(new Error(`No voice controller for leaf ${leafId}`));
		return controller.injectAudio(Float32Array.from(samples), sampleRate);
	}

	// -----------------------------------------------------------------------

	/**
	 * Default command handler: match the trigger phrase, run `on_voice_command`
	 * automations in order, and never let a trigger-phrase utterance reach the
	 * conversation even when no automation claims it.
	 */
	private async dispatchVoiceCommand(ctx: VoiceUtteranceContext): Promise<boolean> {
		const controller = this.getControllerForConversation(ctx.conversationId);
		if (!controller) return false;
		const config = readVoiceConfig(this.plugin.settings);
		const match = matchVoiceCommand(ctx.rawTranscript, config.triggerPhrase);
		const extensions = this.plugin.getExtensionManager();
		const result = await dispatchOnVoiceCommand(
			{
				conversationId: ctx.conversationId,
				timestamp: new Date().toISOString(),
				rawTranscript: ctx.rawTranscript,
				transcript: match ? match.command : ctx.rawTranscript,
				hasTriggerPhrase: match !== null,
				isTurnRunning: ctx.isTurnRunning,
				isSpeaking: ctx.isSpeaking,
				queuedText: ctx.queuedText,
				pendingApproval: ctx.pendingApproval,
				pendingInteraction: ctx.pendingInteraction,
			},
			{
				getForTrigger: (trigger) => extensions.getAutomationsForTrigger(trigger),
				execute: (automation, context) => extensions.executeAutomation(automation, context),
			},
		);
		if (result.handled) return true;
		if (match) {
			log.info("Voice command not handled by any automation", { command: match.command });
			controller.speak(`Unknown voice command: ${match.command || "nothing"}.`);
			return true;
		}
		return false;
	}

	private createStt(): WhisperServerBackend {
		const config = readVoiceConfig(this.plugin.settings);
		return new WhisperServerBackend({
			serverPath: config.whisperServerPath,
			modelPath: config.whisperModelPath,
			port: config.whisperPort,
			language: config.whisperLanguage,
			initialPrompt: buildWhisperInitialPrompt(config),
			extraArgs: config.whisperExtraArgs,
		});
	}

	private handleStatus(leafId: string, status: VoiceStatus): void {
		if (status.state === "idle" || status.state === "error") {
			this.controllers.delete(leafId);
		}
		if (status.state === "idle") this.statuses.delete(leafId);
		else this.statuses.set(leafId, status);
		for (const listener of this.listeners) {
			try {
				listener(leafId, status);
			} catch (e) {
				log.error("voice status listener threw", { error: String(e) });
			}
		}
	}

	private noticeWithSettingsLink(message: string): void {
		const notice = new Notice(`${message} Click to open settings.`, 12_000);
		notice.messageEl.addEventListener("click", () => {
			this.plugin.scrollSettingsToGroup("Voice");
			notice.hide();
		});
	}
}
