# Export & import

Notor lets you export conversations to portable files and import them back into the plugin.

## Exporting a conversation

Open the command palette and run **Notor: Export conversation**. You'll be prompted to choose a format:

### HTML

Produces a self-contained HTML document with embedded CSS — no external dependencies. Key features:

- **Readable layout** — messages, tool calls, tool results, and metadata are clearly formatted with collapsible `<details>` sections.
- **Sub-agent conversations** — if the conversation used sub-agents, their full conversation histories are included as expandable sections within the parent conversation.
- **Re-importable** — the HTML file embeds the full conversation data as JSONL in a hidden `<script>` block, allowing it to be imported back into Notor (see below).
- **Thinking blocks** — if extended thinking was enabled, thinking content appears as collapsible `<details>` sections with muted styling, allowing reviewers to see the AI's reasoning process.
- **Token and cost summary** — input/output token counts and estimated cost are displayed in the footer.

### Markdown

Produces an Obsidian-native Markdown note using callout syntax for tool calls, tool results, and attachments. Key features:

- **Renders natively in Obsidian** — tool calls, results, and metadata use callout blocks that render as collapsible sections.
- **Frontmatter metadata** — includes conversation ID, provider, model, timestamps, and token counts.
- **Sub-agent summaries** — sub-agent results are included as summary text (not full conversation transcripts).

## Importing a conversation

Open the command palette and run **Notor: Import conversation from HTML**. Select a previously exported HTML file — Notor extracts the embedded JSONL data, assigns fresh conversation and message IDs, and adds the conversation to your history. The imported conversation becomes the active conversation immediately.

Only HTML exports can be imported (Markdown exports are read-only snapshots and do not contain the structured data needed for import).

## Conversation forking

Fork a conversation to explore alternative directions without losing the original thread. The forked conversation contains all messages up to and including the fork point and is fully independent from that point forward.

**Two ways to fork:**

- **Right-click** any completed message and select **Fork conversation**.
- **Hover** over a message to reveal the fork button (branch icon in the top-right corner) and click it.

**Behavior details:**

- If you fork at a tool call message, the paired tool result is automatically included so the forked conversation is never left with an unpaired tool call.
- The fork uses your current session's provider, model, and Plan/Act mode — not the parent conversation's stored settings.
- The forked conversation's title is set to "Fork of [original title]".
- The original conversation is not modified.

**Fork badge in conversation list:** Forked conversations show a branch icon badge next to their title. Clicking the badge navigates to the parent conversation.

## Favorite conversations

Right-click a conversation in the history list and select **Add to favorites** (or **Remove from favorites** to undo). Favorited conversations display a star icon and are sorted to the top of the conversation list. A filter toggle in the list header switches between showing all conversations and showing only favorites.
