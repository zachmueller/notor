/**
 * `utils.voice` — the voice-mode facade for extensions.
 *
 * Non-null only when voice mode is active for the conversation the extension
 * runs in. Lets `on_voice_command` automations (and any other extension)
 * speak, settle pending approvals and questions, cancel the turn, and manage
 * the queued dictation. Everything delegates to the panel's VoiceController;
 * the DOM clean-up for settled prompts stays inside the plugin.
 */

import type { BuilderContext, ExtensionUtils } from "./types";

export function buildVoiceUtils(ctx: BuilderContext): Pick<ExtensionUtils, "voice"> {
	const { plugin, conversationId } = ctx;
	if (!conversationId) return { voice: null };
	const controller = plugin.peekVoiceManager()?.getControllerForConversation(conversationId) ?? null;
	if (!controller) return { voice: null };

	return {
		voice: {
			speak: (text, opts) => controller.speak(text, opts),
			stopSpeaking: () => controller.stopSpeaking(),
			repeatLast: () => controller.repeatLast(),
			stopListening: () => {
				void controller.stop("Stopped by voice command.", { announce: true });
			},
			cancelTurn: () => controller.cancelTurn(),
			approvePending: (opts) => controller.approvePending(opts),
			rejectPending: (opts) => controller.rejectPending(opts),
			answerPending: (values) => controller.answerPending(values),
			sendQueued: () => controller.sendQueued(),
			clearQueued: () => controller.clearQueued(),
			describeState: () => controller.describeState(),
			getState: () => ({
				listening: controller.getStatus().state !== "idle",
				addressed: controller.isAddressed,
				speaking: controller.isSpeaking,
				turnRunning: controller.isTurnRunning,
				queuedText: controller.getQueuedText(),
				pendingApprovals: controller.getPendingApprovals().map((p) => ({ toolName: p.toolName, parameters: p.parameters })),
				pendingQuestions: controller.getPendingInteractions().flatMap((p) =>
					p.request.type === "ask" ? p.request.questions.map((q) => q.question) : [`Plan review: ${p.request.title}`],
				),
			}),
		},
	};
}
