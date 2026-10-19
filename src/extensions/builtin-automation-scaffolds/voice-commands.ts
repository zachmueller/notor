import type { AutomationTrigger, BuiltinAutomationScaffold } from "../types";

/**
 * Built-in voice-command automation (Milestone B of docs/voice.md).
 *
 * Runs for every utterance recognized while voice mode is on and turns
 * chat-control phrases into `utils.voice` calls. Users customize it exactly
 * like other scaffolds: open the automation definition from Settings to
 * materialize `notor/automations/voice-commands.md`, edit, reload.
 */
export const VOICE_COMMANDS: BuiltinAutomationScaffold = {
	name: "voice-commands",
	displayName: "Voice commands",
	trigger: "on_voice_command" as AutomationTrigger,
	settingsSchema: [],
	scaffoldContent:
`---
notor-type: automation
notor-trigger: on_voice_command
notor-display-name: Voice commands
notor-feature-group: voice
---

Turns spoken phrases into Notor actions while voice mode is on. Fires for every
recognized utterance before it is sent as a message; returning
\`{ handled: true }\` consumes the utterance.

Commands need the trigger phrase from Settings → Notor → Voice (default
"voice command"), except short confirmations — "yes", "no", "approve",
"reject", "answer …" — which also work on their own while Notor is waiting
for your approval or answer.

Edit the code below to add your own phrases (anything in \`utils.voice\` is
available). Reload extensions to apply changes.

\`\`\`ts
// Built-in: voice-commands automation
// Trigger: on_voice_command — context: { transcript, rawTranscript, hasTriggerPhrase,
//   isTurnRunning, isSpeaking, queuedText, pendingApproval, pendingInteraction, conversationId }
// Return { handled: true } to consume the utterance; anything else lets it continue as a chat message.

const voice = utils.voice;
if (!voice) return { handled: false };

const text = String(context.transcript ?? "").trim();
const lower = text.toLowerCase().replace(/[^a-z0-9'\\s]/g, " ").replace(/\\s+/g, " ").trim();
const wordCount = lower ? lower.split(" ").length : 0;
const hasTrigger = context.hasTriggerPhrase === true;
const waiting = Boolean(context.pendingApproval || context.pendingInteraction);
const is = (...phrases) => phrases.some((p) => lower === p || lower.startsWith(p + " "));

// Without the trigger phrase only short confirmations count, and only while Notor is waiting on you.
if (!hasTrigger && !(waiting && wordCount > 0 && wordCount <= 3)) return { handled: false };

// --- Answering the assistant (with or without the trigger phrase while waiting) ---
if (is("approve all", "yes to all", "accept all", "approve everything")) {
  const n = voice.approvePending({ all: true });
  voice.speak(n > 0 ? "Approved " + n + "." : "Nothing to approve.");
  return { handled: true };
}
if (is("approve", "approved", "yes", "yep", "yeah", "sure", "okay", "ok", "go ahead", "accept", "do it", "confirm")) {
  const n = voice.approvePending();
  voice.speak(n > 0 ? "Approved." : "Nothing to approve.");
  return { handled: true };
}
if (is("reject all", "no to all", "deny all", "reject everything")) {
  const n = voice.rejectPending({ all: true });
  voice.speak(n > 0 ? "Rejected " + n + "." : "Nothing to reject.");
  return { handled: true };
}
if (is("reject", "rejected", "no", "nope", "deny", "decline", "don't", "do not")) {
  const n = voice.rejectPending();
  voice.speak(n > 0 ? "Rejected." : "Nothing to reject.");
  return { handled: true };
}
const answer = /^(answer|reply|respond)\\b[\\s,:]*(.*)$/i.exec(text);
if (answer) {
  const ok = voice.answerPending([answer[2].trim()]);
  voice.speak(ok ? "Answered." : "There is no question to answer.");
  return { handled: true };
}

// --- Everything below needs the trigger phrase ---
if (!hasTrigger) return { handled: false };

if (is("stop speaking", "be quiet", "quiet", "hush")) {
  voice.stopSpeaking();
  return { handled: true };
}
if (is("stop listening", "turn off", "voice off", "off", "goodbye", "good bye")) {
  voice.stopListening();
  return { handled: true };
}
if (is("cancel", "stop", "abort")) {
  const ok = voice.cancelTurn();
  voice.speak(ok ? "Cancelled." : "Nothing is running.");
  return { handled: true };
}
if (is("repeat", "say that again", "again")) {
  if (!voice.repeatLast()) voice.speak("Nothing to repeat.");
  return { handled: true };
}
if (is("status", "what's happening", "where are we", "progress")) {
  voice.speak(voice.describeState());
  return { handled: true };
}
if (is("send", "send it", "submit", "go")) {
  const sent = await voice.sendQueued();
  voice.speak(sent ? "Sent." : "Nothing is queued.");
  return { handled: true };
}
if (is("scratch that", "never mind", "nevermind", "clear", "forget it", "discard")) {
  voice.clearQueued();
  voice.speak("Cleared.");
  return { handled: true };
}
if (is("help", "what can i say", "commands")) {
  voice.speak("Say approve, reject, answer followed by your reply, cancel, stop speaking, repeat, status, send, scratch that, or stop listening.");
  return { handled: true };
}

voice.speak("Unknown voice command: " + text);
return { handled: true };
\`\`\`
`,
};
