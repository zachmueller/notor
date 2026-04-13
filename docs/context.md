# Context: attachments, auto-context, and compaction

## Attach notes and files to your messages

You can provide the AI with specific content directly — no `read_note` tool call required:

- **Vault note attachment** — click the attachment button or type `[[` in the chat input to open the file picker with fuzzy autocomplete. Supports section-level references (`[[Note#Section]]`) that include only the content of that heading.
- **External file attachment** — attach text files from outside your vault via the OS-native file dialog.
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

## Ambient workspace context (auto-context)

Every message automatically includes a snapshot of your current workspace state in the system prompt — no manual effort required:

- **Open note paths** — the vault-relative paths of all notes currently open in any tab, including pinned tabs and split panes. The currently active note is marked `(active)`.
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
