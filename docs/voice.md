# Voice mode

Voice mode lets you have a hands-free conversation with Notor: you talk, Notor transcribes locally, sends the result to the conversation, and reads a short summary of the reply back to you. It is built for moments when your hands are busy but you still want to think something through.

Voice mode is **macOS-only** and **fully local for audio**: speech recognition runs on your machine with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and speech output uses the built-in `say` command. No audio ever leaves your computer. Only the two optional text-shaping passes (clean-up and summary) use your configured LLM provider, like any other Notor turn.

## Requirements

1. **whisper.cpp** — install with Homebrew: `brew install whisper-cpp`. This provides the `whisper-server` binary that Notor starts and stops for you.
2. **A whisper model** — download a ggml model file, for example `ggml-base.en.bin` (fast, English) or `ggml-small.en.bin` (more accurate), from [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main), and keep it somewhere stable such as `~/.local/share/whisper/`.
3. **Microphone access** — the first time you turn voice mode on, macOS asks whether Obsidian may use the microphone.
4. **Headphones (recommended)** — without them the microphone hears Notor speaking. Voice mode guards against that, but headphones make it reliable.

## Setup

1. Open **Settings → Notor → Voice**.
2. Set **Whisper model file** to the absolute path of your `.bin` model. Leave **Whisper server binary** as `whisper-server` unless you installed it somewhere unusual; the status line under the toggle tells you whether both were found.
3. Turn on **Enable voice mode**. A microphone button appears in the chat panel's input toolbar (reopen the panel if it was already open).

## Using voice mode

- Click the **microphone button**, or run **Notor: Toggle voice mode** from the command palette. Notor starts the whisper server, opens the microphone, and says "Voice mode on". The button pulses while listening.
- **Talk normally.** When you pause for about 2.5 seconds (configurable), what you said is cleaned up and sent as a message. Listening stays on — you never have to touch anything between turns.
- **Notor replies out loud.** When the assistant's turn finishes, everything it wrote and did (including which tools it ran and what they found) is condensed into a few spoken sentences.
- **Interrupt any time.** Speaking while Notor is talking stops the speech immediately. The assistant keeps working; only the audio stops. **Notor: Stop speaking (voice mode)** does the same from the command palette.
- **Keep talking while it works.** Anything you say during a running turn is held and sent as one message once the reply has been spoken. The status chip shows how much is queued.
- **Approvals and questions are announced.** When a tool call needs your approval or the assistant asks a question, Notor tells you (at the default verbosity). Resolving them by voice is covered under [Voice commands](#voice-commands).
- Click the microphone again (or run the command) to turn voice mode off.

Voice mode is bound to the conversation that was open when you turned it on and keeps working while another tab or window has focus. It turns itself off if that panel switches to a different conversation or is closed.

## Spoken progress verbosity

**Settings → Notor → Voice → Progress verbosity** controls how much you hear while the assistant works. The final summary is always spoken.

| Level | What is spoken mid-turn |
|---|---|
| Silent | Nothing |
| Needs me (default) | Approval requests and questions |
| Periodic | The above, plus a brief "still working" line at most every 25 seconds (configurable) |
| Every tool | The above, plus one short line per tool call ("reading Daily note", "searching for quarterly plan") |

## Shaping prompts

Two LLM passes shape the loop, and both prompts are yours to edit — exactly like the [core system prompt](system-prompt.md):

- **Input clean-up** fixes punctuation, drops filler words and false starts, and applies spoken corrections before your words are sent. It is skipped for very short utterances. Turn it off with **Clean up dictated input** if you prefer verbatim transcripts.
- **Speech summary** turns the finished turn (assistant text plus condensed tool calls and results) into a listenable script of about 600 characters (configurable).

Click **Customize clean-up prompt** or **Customize speech summary prompt** in settings to export the built-in prompt to `notor/prompts/voice-input-cleanup.md` or `notor/prompts/voice-speech-summary.md` and open it. Edits take effect on the next utterance or reply. Delete the file (or leave it blank) to return to the default.

**Shaping model preset** chooses which model runs these passes. By default they use the conversation's current model; pick a small, fast [preset](model-presets.md) if you prefer.

## Settings reference

| Setting | Default | Notes |
|---|---|---|
| Whisper server binary | `whisper-server` | Name on your login-shell PATH or an absolute path |
| Whisper model file | — | Required; absolute path to a ggml `.bin` |
| Server port | 8178 | Loopback only; the next two ports are tried if busy |
| Language | `en` | Whisper language code (`auto` to detect) |
| Vocabulary | — | Names and jargon added to whisper's prompt to improve recognition |
| Extra server arguments | — | Passed to `whisper-server`, e.g. `-t 8` |
| End-of-turn pause | 2500 ms | Silence that ends an utterance; listening continues |
| Speech threshold | 0.02 | Microphone level counted as speech; raise it in noisy rooms |
| Minimum utterance | 600 ms | Shorter sounds are ignored |
| Stop listening after silence | 0 (off) | Optional: turn voice mode off after prolonged silence |
| Barge-in sensitivity | 3 | How much louder than the threshold you must be to interrupt Notor |
| Progress verbosity | Needs me | See above |
| Progress interval | 25 000 ms | Spacing of "still working" lines at the periodic level |
| Summary length | 600 characters | Target length of the spoken summary |
| Text-to-speech command | `say` | Any local command that speaks text from stdin |
| Voice / Speech rate | system default | `say -v` and `say -r`; run `say -v ?` in a terminal to list voices |
| Shaping model preset | same as conversation | Model for the clean-up and summary passes |
| Clean up dictated input | on | Run the clean-up pass |
| Trigger phrase | `voice command` | Prefix for [voice commands](#voice-commands) |

## Voice commands

Say the **trigger phrase** (default `voice command`, configurable) followed by a command to control Notor without sending a message, for example "voice command approve". Punctuation and casing do not matter, and "voice commands" is accepted too.

| Say | Effect |
|---|---|
| approve / yes / go ahead / okay | Approve the oldest pending tool call (or a pending plan review) |
| approve all | Approve every pending tool call |
| reject / no / deny | Reject the oldest pending tool call (or plan review) |
| reject all | Reject every pending tool call |
| answer … / reply … | Answer the assistant's pending question with the words that follow |
| cancel / stop | Abort the running turn (listening continues) |
| stop speaking / quiet | Cut off the current spoken line |
| repeat / say that again | Re-speak the last announcement or summary |
| status | Hear what Notor is doing and what is pending or queued |
| send | Send queued dictation now |
| scratch that / never mind | Discard queued dictation |
| stop listening / turn off | Turn voice mode off |
| help | Hear the list of commands |

While Notor is **waiting for your approval or answer**, the short confirmations work without the trigger phrase: a bare "yes", "no", "approve", "reject" or "answer …" (three words or fewer, except after "answer") is treated as a command rather than a message. Anything longer is queued as dictation and sent after the turn, with a one-time spoken reminder that an approval is pending.

An unrecognized phrase after the trigger is answered with "Unknown voice command" and is not sent to the conversation.

### Customizing and extending

Voice commands are an ordinary built-in [automation](extensions.md) named **Voice commands**, triggered by `on_voice_command`. In **Settings → Notor → Automation**, open its definition to materialize `notor/automations/voice-commands.md`, edit the phrase table or add your own actions, and reload extensions. Any automation with `notor-trigger: on_voice_command` takes part: they run in `notor-automation-order`, and the first one to return `{ handled: true }` consumes the utterance.

Inside an automation, `context` carries the transcript, whether the trigger phrase was present, and what is pending (see [extensions.md](extensions.md#context-object)), and `utils.voice` exposes the controls listed in the [runtime context](extensions.md#notor-utilities) — including `speak`, `approvePending`, `answerPending`, `cancelTurn` and `stopListening` — so you can wire phrases to anything an extension can do.

## Limitations

- macOS only. The plugin's other features are unaffected on other platforms.
- A simple pause detector marks the end of each utterance; long mid-sentence pauses can split a thought. The clean-up pass does not merge fragments, so lengthen **End-of-turn pause** if that happens to you.
- Without headphones, Notor's own voice reaches the microphone. Voice mode raises the barge-in threshold while speaking and discards whisper's known silence artifacts, but speaker setups can still self-interrupt.
- `whisper-server` must be restarted after a system sleep; Notor does this automatically when voice mode is on.
