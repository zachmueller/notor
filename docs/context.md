# Context: attachments, auto-context, and compaction

## Attach notes and files to your messages

You can provide the AI with specific content directly — no `read_note` tool call required:

- **Vault note attachment** — click the attachment button or type `[[` in the chat input to open the file picker with fuzzy autocomplete. Supports section-level references (`[[Note#Section]]`) that include only the content of that heading.
- **External file attachment** — attach files from outside your vault via the OS-native file dialog. Text files are attached as plain text. `.docx` files are converted to plain text automatically. Images and PDFs are processed through the same pipeline as vault attachments (see [Image and PDF processing](#image-and-pdf-processing) below).
- **Attachment chips** — attached items appear as labeled chips in the input area before sending. Each chip can be individually removed. Attachments are deduplicated silently.
- **Graceful failures** — if an attached note is deleted or renamed after the chip is added, the message still sends without that attachment and an inline warning is shown.
- Attachment contents are embedded in the message context sent to the LLM but are not rendered in full in the chat thread (chips only).

### Image and PDF processing

When images or PDFs are attached to messages, Notor processes them before sending to the LLM. These settings are configurable in **Settings → Notor**:

| Setting | Default | Description |
|---------|---------|-------------|
| Image max dimension | 2000 px | Maximum width or height in pixels. Larger images are resized proportionally. |
| Image compression quality | 80 | JPEG compression quality (0–100) used during the compression cascade. |
| PDF max size (native) | 10 MB | Maximum file size for sending PDFs as native document blocks. |
| PDF max text chars | 400,000 | Maximum characters extracted when using text-based PDF processing. |
| PDF prefer native | true | Use native PDF document blocks when the provider supports them; falls back to text extraction otherwise. |

## Searching chat history

The conversation history panel supports text search across past conversations. Searches match against conversation titles, message previews, and full message content. Matching is case-insensitive, and results are ordered by most recent activity.

## Find in messages

Run **Notor: Find in messages** from the command palette (or assign a custom hotkey in **Settings → Hotkeys**) to open the find bar at the top of the message list.

- **Search** — case-insensitive. Matches are highlighted in message content, tool call names, tool result summaries, and extension block text.
- **Navigate** — **Enter** for next match, **Shift+Enter** for previous match, or click the arrow buttons. Match position is shown as `N / total`.
- **Close** — **Escape** or the × button clears highlights and dismisses the bar.

## Copy affordances and message context menu

Each message has a floating **copy button** (clipboard icon) that appears on hover. Clicking it copies the full message content as plain text.

Right-clicking on the message list opens a context menu:

| Action | Description |
|--------|-------------|
| Copy message contents | Copies the full content of the hovered message |
| Copy selected text | Copies the currently selected text (only shown when text is selected) |
| Fork here | Creates a new conversation branching from the hovered message |
| /btw | Forks to a new panel using the `/btw` slash command |
| Copy conversation ID | Copies the current conversation's UUID |

## Citation popovers

When the AI produces inline superscript references (e.g., `[1]`, `[2]`), Notor renders them as clickable citation popovers. Hovering or clicking a superscript shows the referenced content in a tooltip. This is a display-only enhancement — it does not affect what the AI sends or receives.

## Ambient workspace context (auto-context)

Every message automatically includes a snapshot of your current workspace state in the system prompt — no manual effort required:

- **Open file paths** — the vault-relative paths of all files currently open in any tab, including pinned tabs and split panes. This includes non-Markdown files (PDFs, images, canvas files, and other file-backed views). The currently active file is marked `(active)`.
- **Vault structure** — top-level folder names at the vault root (no recursive listing, no individual file names).
- **Operating system** — your OS platform (macOS, Windows, or Linux), so the AI generates platform-appropriate shell commands without asking.

Each source can be individually enabled or disabled in **Settings → Notor**. All three are on by default.

## Token usage and cost tracking

Notor tracks cumulative input and output token counts for each conversation, displayed in the chat footer. Token counts and costs are also included in HTML and Markdown exports.

### Configuring model pricing

Open **Settings → Notor → Model pricing** to configure cost estimates. Each entry maps a model ID (e.g., `claude-sonnet-4-5`, `gpt-4o`) to input and output costs in USD per 1,000 tokens. If no pricing entry exists for the active model, token counts are still displayed but cost estimates are omitted. Changes take effect for subsequent messages immediately.

## Auto-compaction for long sessions

When a conversation approaches the active model's context window limit, Notor automatically summarizes it and continues in a new context window:

- The compaction threshold is configurable (default: 80% of the model's context window). Token usage is estimated locally — no provider API call is made.
- While summarization is in progress, a "Compacting context…" indicator appears inline in the chat thread. Chat input remains enabled.
- Once complete, the indicator is replaced by a permanent **Context compacted** marker showing the timestamp and token count at compaction.
- The AI continues seamlessly. The full conversation history is always retained in the JSONL log; compaction only affects what is sent to the LLM.
- The compaction system prompt has a built-in default and can be overridden in **Settings → Notor**.
- Manual compaction is available via the command palette (**Notor: Compact context**).

### How Notor determines a model's context window

Compaction triggers at a fraction of the active model's context window, so Notor needs to know that window. It resolves it in this order:

1. **Your override** — set in **Settings → Notor → Reference → Model context limits**. An override for a model ID applies to both its standard and 1M variants; add `::1m` to the model ID (e.g. `us.anthropic.claude-sonnet-4-6::1m`) to override only the 1M variant.
2. **The Anthropic models API** — for the Anthropic provider, Notor reads each model's context window from the model list.
3. **Built-in data** — a table of known models.
4. **A related model** — for a Claude model Notor doesn't recognize yet (for example a newly released Bedrock profile), it borrows the limits of the nearest known model in the same family. A *new* Sonnet, Opus or Fable version (newer than any Notor knows) is assumed to have a 1M window; on Bedrock, Notor sends the 1M context beta automatically for it. If Bedrock rejects that beta, Notor stops sending it and falls back to the related model's standard window.
5. **128K tokens** — for anything else. Notor shows a one-time notice per model per session when it falls back to this default; add an override to silence it.

**Learned limits.** When a provider rejects a request for exceeding the context window, Notor records the real limit (from the error message, or — when the message has no number — from its own estimate of the request) and uses it from then on, so the next message compacts at the right point. Learned limits only ever lower a window. They appear under **Detected limits** in the same settings section, where you can forget one if a model's limit increases.

Pricing is never inferred: models without built-in or configured pricing show token counts but no cost.
