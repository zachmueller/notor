# Voice mode

Voice mode lets you have a hands-free conversation with Notor: say **"Hey Notor"**, then what you want. Notor transcribes it locally, sends it to the conversation, and reads a short summary of the reply back to you. It is built for moments when your hands are busy but you still want to think something through — and it can stay on in the background, because nothing you say reaches the conversation until you address Notor.

Voice mode is **macOS-only** and **fully local for audio**: the wake word is spotted on your machine with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), speech recognition runs with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and speech output uses the built-in `say` command. No audio ever leaves your computer, and until the wake word is heard your speech is not even transcribed. Only the two optional text-shaping passes (clean-up and summary) use your configured LLM provider, like any other Notor turn.

## Requirements

1. **whisper.cpp** — install with Homebrew: `brew install whisper-cpp`. This provides the `whisper-server` binary that Notor starts and stops for you.
2. **A whisper model** — download a ggml model file, for example `ggml-base.en.bin` (fast, English) or `ggml-small.en.bin` (more accurate), from [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main), and keep it somewhere stable such as `~/.local/share/whisper/`.
3. **Python 3 with sherpa-onnx** — for the wake word: `python3 -m pip install sherpa-onnx sentencepiece` (tested with sherpa-onnx 2.0.0). A virtual environment works too; point **Python interpreter** at its `bin/python`.
4. **A keyword-spotting model** — download and unpack [sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01](https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2) (about 19 MB, English) somewhere stable such as `~/.local/share/sherpa-onnx/`. Notor needs the unpacked folder (it contains `tokens.txt`, `bpe.model` and the encoder/decoder/joiner `.onnx` files). No training is needed, for any wake word.
5. **Microphone access** — the first time you turn voice mode on, macOS asks whether Obsidian may use the microphone.
6. **Headphones (recommended)** — without them the microphone hears Notor speaking. Voice mode guards against that, but headphones make it reliable.

Waiting for the wake word costs about 1% of one CPU core and under 100 MB of memory.

## Setup

1. Open **Settings → Notor → Voice**.
2. Set **Whisper model file** to the absolute path of your `.bin` model. Leave **Whisper server binary** as `whisper-server` unless you installed it somewhere unusual.
3. Set **Keyword-spotting model folder** to the unpacked sherpa-onnx folder. Leave **Python interpreter** as `python3` unless sherpa-onnx is installed in another Python. The status line under the toggle tells you whether everything was found.
4. Turn on **Enable voice mode**. A microphone button appears in the chat panel's input toolbar (reopen the panel if it was already open).

## Using voice mode

- Click the **microphone button**, or run **Notor: Toggle voice mode** from the command palette. Notor starts its helpers, opens the microphone, plays a short chime and shows "Voice mode on. Say “Hey Notor” to talk." The button turns softly lit: voice mode is **armed**, waiting for the wake word.
- **Say "Hey Notor", then your request** — in one breath ("Hey Notor, summarize my inbox") or after the chime ("Hey Notor" … "what's on my agenda?"). The button pulses while Notor is listening. When you pause for about 0.6 seconds (configurable), what you said is cleaned up and sent as a message, and Notor goes back to waiting for the wake word.
- **One request per wake word.** Anything else you say — side conversations, the TV, thinking out loud — is ignored, and never transcribed. If you say the wake word and then nothing, Notor gives up after 5 seconds (configurable) and goes back to waiting.
- **Notor replies out loud.** When the assistant's turn finishes, everything it wrote and did (including which tools it ran and what they found) is condensed into a few spoken sentences.
- **Interrupt with the wake word.** Saying "Hey Notor" while Notor is talking stops the speech immediately and listens to you. The assistant keeps working; only the audio stops. **Notor: Stop speaking (voice mode)** does the same from the command palette.
- **Keep talking while it works.** Requests you make during a running turn are held and sent as one message once the reply has been spoken. The status chip shows how much is queued.
- **Approvals and questions are announced.** When a tool call needs your approval or the assistant asks a question, Notor tells you (at the default verbosity), and a short "yes" or "no" works without the wake word. See [Voice commands](#voice-commands).
- Click the microphone again (or run the command, or say "Hey Notor, stop listening") to turn voice mode off.

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
| Wake word | `Hey Notor` | Two to four syllables work best; short or single-word wake words wake Notor by mistake more often |
| Alternative spellings | `Hey Nota, Hey Noter, Hey Noder` | Comma-separated; see [Tuning the wake word](#tuning-the-wake-word) |
| Listen after wake word | 5000 ms | How long a bare wake word waits for you to start talking |
| Wake chime | on | Chime on wake, and when voice mode turns on or off |
| Python interpreter | `python3` | Name on your login-shell PATH or an absolute path; needs `sherpa-onnx` and `sentencepiece` |
| Keyword-spotting model folder | — | Required; the unpacked sherpa-onnx model folder |
| Detection threshold | 0.15 | Lower wakes more easily; raise it if Notor wakes when you did not call it |
| Wake word boost | 2 | Raise it if Notor misses the wake word |
| Detector threads | 1 | CPU threads for wake-word detection |
| Whisper server binary | `whisper-server` | Name on your login-shell PATH or an absolute path |
| Whisper model file | — | Required; absolute path to a ggml `.bin` |
| Server port | 8178 | Loopback only; the next two ports are tried if busy |
| Language | `en` | Whisper language code (`auto` to detect) |
| Vocabulary | — | Names and jargon added to whisper's prompt to improve recognition |
| Extra server arguments | — | Passed to `whisper-server`, e.g. `-t 8` |
| End-of-turn pause | 600 ms | Silence that ends what you say after the wake word |
| Speech threshold | 0.02 | Microphone level counted as speech; raise it in noisy rooms |
| Minimum utterance | 600 ms | Shorter sounds are ignored |
| Turn off when idle | 0 (off) | Optional: turn voice mode off after this long without the wake word |
| Reply-while-speaking sensitivity | 3 | While Notor reads out an approval or question, how much louder than the threshold a reply without the wake word must be |
| Progress verbosity | Needs me | See above |
| Progress interval | 25 000 ms | Spacing of "still working" lines at the periodic level |
| Summary length | 600 characters | Target length of the spoken summary |
| Text-to-speech command | `say` | Any local command that speaks text from stdin |
| Voice / Speech rate | system default | `say -v` and `say -r`; run `say -v ?` in a terminal to list voices |
| Shaping model preset | same as conversation | Model for the clean-up and summary passes |
| Clean up dictated input | on | Run the clean-up pass |

Changes to the wake word and detection settings apply to a running voice mode within a couple of seconds; the others apply the next time it starts or at the next utterance.

### Tuning the wake word

The keyword spotter recognizes any phrase you type — no training — but it spells what it hears with English word pieces, so a made-up word like "Notor" is heard in several ways ("nota", "noter"). **Alternative spellings** lists those; Notor wakes on any of them and strips them from what is sent. If you change the wake word to an invented name, add two or three plausible spellings of it. Real words ("Hey Computer") rarely need any.

- **Notor misses the wake word:** add spellings, lower **Detection threshold** (try 0.1), or raise **Wake word boost**.
- **Notor wakes when you did not call it:** raise **Detection threshold** (try 0.25), lower **Wake word boost**, or remove spellings that sound like everyday words.

## Voice commands

Say the wake word followed by a command to control Notor without sending a message, for example "Hey Notor, approve". Commands are recognized as whole phrases (a trailing "please" is fine); anything else you say after the wake word is sent to the conversation as a request.

| Say | Effect |
|---|---|
| approve / yes / go ahead / okay | Approve the oldest pending tool call (or a pending plan review) |
| approve all | Approve every pending tool call |
| reject / no / deny | Reject the oldest pending tool call (or plan review) |
| reject all | Reject every pending tool call |
| answer … / reply … | Answer the assistant's pending question with the words that follow |
| cancel / stop | Abort the running turn (voice mode stays on) |
| stop speaking / quiet | Cut off the current spoken line |
| repeat / say that again | Re-speak the last announcement or summary |
| status | Hear what Notor is doing and what is pending or queued |
| send | Send queued requests now |
| scratch that / never mind | Discard queued requests |
| stop listening / turn off | Turn voice mode off |
| help | Hear the list of commands |

While Notor is **waiting for your approval or answer**, short replies work without the wake word: a bare "yes", "no", "approve", "reject" or "answer …" of three words or fewer is treated as a reply. Longer answers need the wake word ("Hey Notor, answer put it in the Inbox please"). Anything else said without the wake word is ignored, even while Notor waits — so this is the only time speech is transcribed without being addressed, and only while Notor is waiting on you.

A request that is exactly a command phrase ("Hey Notor, status") runs the command. One that merely starts with a command word ("Hey Notor, send me a summary of today") is sent as a message.

### Customizing and extending

Voice commands are an ordinary built-in [automation](extensions.md) named **Voice commands**, triggered by `on_voice_command`. In **Settings → Notor → Automation**, open its definition to materialize `notor/automations/voice-commands.md`, edit the phrase table or add your own actions, and reload extensions. Any automation with `notor-trigger: on_voice_command` takes part: they run in `notor-automation-order`, and the first one to return `{ handled: true }` consumes the utterance; everything left unhandled is sent as a message (or, without the wake word, dropped).

Inside an automation, `context` carries the transcript (wake word removed), whether it was addressed with the wake word, and what is pending (see [extensions.md](extensions.md#context-object)), and `utils.voice` exposes the controls listed in the [runtime context](extensions.md#notor-utilities) — including `speak`, `approvePending`, `answerPending`, `cancelTurn` and `stopListening` — so you can wire phrases to anything an extension can do.

## Limitations

- macOS only. The plugin's other features are unaffected on other platforms.
- A simple pause detector marks the end of what you say. With the default 0.6-second pause, a long mid-sentence pause sends the first half, and the rest is ignored until you say the wake word again. Lengthen **End-of-turn pause** if that happens to you.
- The wake word is spotted by a small model: it will occasionally miss you or wake on something that sounds similar. See [Tuning the wake word](#tuning-the-wake-word).
- Without headphones, Notor's own voice reaches the microphone. It is ignored unless it sounds like the wake word, and whisper's known silence artifacts are discarded, but speaker setups are less reliable than headphones.
- `whisper-server` and the wake-word helper must be restarted after a system sleep; Notor does this automatically when voice mode is on.
