# Phase 3 — Context & intelligence

**Created:** 2026-07-03
**Status:** Draft
**Branch:** feature/02-context-intelligence

## Overview

Phase 3 extends Notor's core MVP with features that make the AI meaningfully smarter about the user's vault and the broader web. Building on the chat infrastructure, tool dispatch, and trust mechanisms from Phases 0–2, this phase introduces four capabilities: letting users manually attach notes and files to a conversation, automatically surfacing ambient workspace context with every message, managing the context window gracefully over long sessions, and giving the AI the ability to fetch and consume web content. It also adds two power-user features — shell command execution and LLM lifecycle hooks — that open the door to richer automation. Together these features close the gap between a capable AI editor and a genuinely context-aware knowledge work partner.

This specification covers Phase 3 of the roadmap:

- **File/note attachment in chat**: manual attachment of vault notes (with section-level granularity) and external files via a chat input control.
- **Auto-context injection**: ambient workspace signals (open note paths, top-level vault structure, OS platform) automatically included with every message, individually configurable.
- **Auto-compaction**: deterministic, plugin-managed context window summarization that preserves continuity when approaching the token limit.
- **`fetch_webpage` tool**: fetch a URL, convert its HTML to Markdown, and return the result to the AI — with a user-configurable domain denylist.
- **`execute_command` tool**: run cross-platform shell commands from within the AI conversation, with configurable restrictions by mode.
- **LLM interaction hooks**: event-driven callbacks tied to the chat lifecycle (`pre-send`, `on-tool-call`, `on-tool-result`, `after-completion`) for automating follow-up actions.

## User stories

### File and note attachment

- As a note writer, I want to attach a specific note to my message so that the AI has the exact content it needs without me asking it to read the file.
- As a researcher, I want to attach only a section of a long note so that I give the AI focused context without bloating the conversation.
- As a user, I want to attach a file from outside my vault so that the AI can help me work with content that lives elsewhere on my machine.
- As a user, I want to see which notes and files I've attached before sending so that I can review and remove any accidental attachments.

### Auto-context injection

- As a user, I want the AI to know which notes I have open so that it can reference or act on my current workspace without me specifying paths.
- As a user, I want the AI to see the top-level structure of my vault so that it can navigate and suggest relevant directories without a full listing.
- As a user who runs shell commands, I want the AI to know my operating system so that it generates platform-appropriate commands without asking.
- As a user, I want to control which ambient context sources are active so that I can tailor what information is automatically shared with the AI.

### Auto-compaction

- As a user having a long research conversation, I want the context to be automatically summarized when it fills up so that I don't have to manually restart and re-explain my goal.
- As a user, I want to see a clear marker in the chat when context compaction occurs so that I understand why the AI's memory of early conversation may be condensed.
- As a user, I want to configure when compaction triggers so that I can balance context depth against token cost.

### Web fetching

- As a researcher, I want to ask the AI to fetch and summarize a webpage so that I can bring external content into my notes workflow without leaving Obsidian.
- As a user, I want the AI to convert the fetched page to Markdown so that the content fits naturally in my vault and consumes fewer tokens.
- As a privacy-conscious user, I want to block specific domains from being fetched so that the AI cannot retrieve content from sources I consider untrustworthy.

### Shell commands

- As a technical user, I want the AI to run shell commands on my system so that it can automate tasks like running scripts, processing files, or checking system state.
- As a cautious user, I want shell command execution to be restricted to Act mode by default so that I am not surprised by commands running when I'm in a read-only workflow.

### LLM interaction hooks

- As a power user, I want to run an action automatically after the AI finishes responding so that I can chain workflows or trigger follow-up tasks without manual intervention.
- As a user, I want a hook that fires before each message is sent so that I can inject additional context or validate the input programmatically.
- As a user, I want a hook that fires on every tool call so that I can log or audit AI actions in my vault.
- As a user, I want a hook that fires after each tool completes so that I can react to tool output — for example, writing a log entry that includes what the tool returned.
- As a power user, I want hooks to be able to run shell commands so that I can drive complex external automation from within my Notor conversation.

## Functional requirements

### FR-24: Note attachment via file picker

**Description:** Users can attach vault notes to a chat message using a file picker with Obsidian-native autocomplete.

**Acceptance criteria:**
- An attachment button in the chat input area opens a small menu with two options: **Attach vault note** (opens the Obsidian vault file picker with autocomplete) and **Attach external file** (opens the OS filesystem dialog, see FR-25).
- When the user types `[[` in the Notor chat input box, the vault file picker opens directly (bypassing the menu), applying the same wikilink autocomplete behavior as Obsidian's native note editor — showing matching note titles and allowing selection to complete the link.
- Multiple notes can be attached to a single message.
- Section references (`[[Note#Section Header]]`) are supported: when a section reference is used, only the content of that section (from the heading to the next heading of equal or higher level) is included in the attachment, not the full note.
- Attached notes appear as labeled chips/tags in the input area before the message is sent.
- The user can remove individual attachments before sending.
- Duplicate attachments are silently deduplicated: if the same path and section reference is already present as a chip, a second attempt to add it is ignored without showing an error or notification.
- Attached note contents are included in the user message sent to the LLM, formatted as an XML-tagged block prepended to the user message content. Each attachment is wrapped in a descriptive tag within an `<attachments>` container: vault notes use `<vault-note path="...">`, vault note sections use `<vault-note path="..." section="...">`, and external files use `<external-file name="...">`. For example: `<attachments><vault-note path="Research/Climate.md" section="Key Findings">...section content...</vault-note><external-file name="data.csv">...file content...</external-file></attachments>`. This is consistent with the XML-tagged approach used for auto-context injection.
- If a vault note attachment cannot be read at send time (e.g., the note was deleted, renamed, or moved after the chip was added), the message is still sent without the failed attachment's content. An inline warning is surfaced in the chat thread (e.g., "Note 'Research/Climate.md' was not found at send time; attachment omitted"). Remaining valid attachments are included normally.
- Attachments are shown in the sent message in the chat thread as labeled chips (note/file name only). The full attached content is not displayed or expandable in the thread; it is embedded in the message context sent to the LLM but not rendered inline.

### FR-25: External file attachment

**Description:** Users can attach files from outside the vault to a chat message.

**Acceptance criteria:**
- The "Attach external file" option in the attachment menu (FR-24) opens the OS-native filesystem dialog, allowing the user to select files from outside the vault.
- Attached external files are read and included in the user message context.
- External files are labeled as such in the attachment chips so the user can distinguish them from vault notes.
- File size limits apply: if a file exceeds a configurable threshold (default: 1 MB), a confirmation dialog is shown highlighting the file size and asking the user to confirm before attaching. The user can proceed or cancel.
- Any file may be selected regardless of extension. At attach time, the file is read and validated as UTF-8 text. If the file is binary or cannot be decoded as UTF-8, attachment is rejected with a clear error (e.g., "Cannot attach binary file: only plain-text files are supported"). No explicit extension allowlist is enforced.

### FR-26: Auto-context — open note paths

**Description:** The paths of all currently open notes in the Obsidian workspace are automatically included with each message sent to the LLM.

**Acceptance criteria:**
- Before each message is sent, the plugin collects the file paths of all notes open in any leaf/tab view in the Obsidian workspace (including pinned tabs and split panes).
- Only file paths are included — full note contents are not automatically injected.
- The auto-context is injected into the message context (not the system prompt) so it reflects the workspace state at the time of sending. All enabled auto-context sources are assembled into a single XML-tagged block (e.g., `<auto-context><open-notes>...</open-notes><vault-structure>...</vault-structure><os>...</os></auto-context>`). Disabled sources are omitted from the block; if all sources are disabled, no `<auto-context>` block is included.
- The assembled user message content follows a fixed ordering: (1) `<auto-context>` block (ambient workspace signals), (2) `<attachments>` block (user-attached notes/files), (3) `pre-send` hook stdout output (programmatic injections), (4) the user's typed message text. This orders content from least to most salient, with the user's actual instruction always last.
- This source can be individually enabled or disabled in **Settings → Notor**.
- When disabled, no open note paths are injected.

### FR-27: Auto-context — vault structure

**Description:** The top-level directory listing of the vault is automatically included with each message.

**Acceptance criteria:**
- The top-level folder names at the vault root are included in the auto-context.
- Individual file names at the root level are not included (only folder names).
- Recursive subdirectory contents are not included.
- This source can be individually enabled or disabled in **Settings → Notor**.
- When disabled, no vault structure is injected.

### FR-28: Auto-context — operating system

**Description:** The user's operating system platform is automatically included with each message.

**Acceptance criteria:**
- The OS platform (macOS, Windows, or Linux) is included in the auto-context.
- This enables the LLM to generate platform-appropriate shell commands and tailor OS-specific guidance.
- This source can be individually enabled or disabled in **Settings → Notor**.
- When disabled, no OS information is injected.

### FR-29: Auto-compaction

**Description:** When the conversation approaches the active model's context window limit, the plugin automatically summarizes the conversation and continues in a new, condensed context window.

**Acceptance criteria:**
- A compaction threshold (configurable, default: 80% of the model's context window token limit) triggers the auto-compaction process. The token count is estimated using a lightweight local approximation (no provider API call); a small margin of error is acceptable given the conservative default threshold.
- The compaction threshold is checked before every LLM API call — this includes user message dispatches as well as tool-result-to-LLM round-trips within a multi-tool-call turn. When the threshold is crossed, the plugin sends a summarization request to the LLM with the accumulated conversation, using the configured compaction system prompt, before proceeding with the pending API call.
- The LLM returns a condensed summary of the conversation so far.
- The plugin begins a new context window with the summary injected as a synthetic `user`/`assistant` exchange: a `user` message containing the summary prefixed with a label (e.g., "Summary of prior conversation: …"), immediately followed by a brief canned `assistant` acknowledgment (e.g., "Understood. I have context of our prior conversation."). The current user message follows this exchange as the next turn.
- While the compaction summarization request is in flight, an inline status indicator ("Compacting context…") appears in the chat thread at the compaction point. Chat input remains enabled — the user can continue composing or queue a message, which is dispatched after compaction completes. Once the summary is received, the indicator transitions to the permanent "Context compacted" marker.
- The "Context compacted" marker clearly indicates that earlier conversation history has been condensed.
- The full un-compacted conversation history is still accessible in the persisted JSONL log; compaction only affects what is sent to the LLM.
- Compaction can be triggered manually by the user via a button or command.
- The compaction threshold is configurable globally in **Settings → Notor**. There is no per-conversation override.
- The compaction system prompt has a built-in default focused on producing a concise, faithful summary of the conversation. Users can override this prompt in **Settings → Notor** (following the same pattern as the main system prompt override). When overridden, the user-supplied prompt is used for all compaction requests; clearing the override restores the default.
- If the summarization request itself fails, the plugin falls back to the existing truncation behavior (dropping oldest messages) and surfaces an error notice.

### FR-30: `fetch_webpage` tool

**Description:** Fetch a webpage by URL and return its content as Markdown for use in the conversation.

**Acceptance criteria:**
- Accepts a single `url` parameter.
- Fetches the page HTML via HTTP GET request using a neutral `Notor/1.0` User-Agent header (not the Electron/Obsidian default).
- Silently follows HTTP redirects up to a maximum of 5 hops; if the redirect limit is exceeded, returns an error to the LLM.
- Both `http://` and `https://` URLs are accepted; no protocol enforcement is applied.
- Converts the HTML to Markdown using the Turndown library bundled into the plugin.
- Returns the converted Markdown content in the tool result. Does not write to a note.
- If the URL is unreachable or returns a non-200 HTTP status, returns a clear error to the LLM (including the HTTP status code).
- If the response `Content-Type` is `text/html`, converts the HTML to Markdown using Turndown. If the `Content-Type` is `text/*` (e.g., `text/plain`) or `application/json`, the response body is returned as-is without Turndown conversion. For all other content types (binary, PDF, images, etc.), the tool returns a clear error to the LLM indicating the content type is not supported.
- If the domain matches a configured denylist entry, the request is rejected and a user-configurable error message is returned to the LLM indicating the domain is blocked.
- A configurable maximum raw download size (default: 5 MB) is applied at the HTTP level. If the response body exceeds this limit, the download is aborted and a clear error is returned to the LLM indicating the page was too large (including the size at which download was aborted). The cap is configurable in **Settings → Notor**.
- A configurable maximum output size (default: 50,000 characters) is applied to the returned Markdown (after Turndown conversion or for non-HTML text responses). When the converted/returned content exceeds this limit, the tool returns content up to the cap and appends a truncation notice to the LLM (e.g., "Note: page was truncated at 50,000 characters; total fetched length was X characters"). The cap is configurable in **Settings → Notor**.
- Classified as read-only — available in both Plan and Act modes.

### FR-31: Domain denylist for `fetch_webpage`

**Description:** A user-configurable list of blocked domains that `fetch_webpage` cannot access.

**Acceptance criteria:**
- Users can add and remove domain entries in **Settings → Notor** via a list editor.
- Matching is exact-domain only: denylisting `example.com` blocks only `example.com` itself, not its sub-domains. To block sub-domains, users must add separate wildcard entries (e.g., `*.example.com`).
- When a blocked domain is requested, the tool returns an error to the LLM indicating the domain is blocked by the user, without making a network request.
- The denylist is empty by default.
- The denylist is a user preference control, not a security mechanism.

### FR-32: `execute_command` tool

**Description:** Execute a shell command on the user's system and return the output to the AI.

**Acceptance criteria:**
- Accepts a `command` string and an optional `working_directory` (defaults to vault root).
- Executes the command in a shell appropriate for the user's OS. On macOS/Linux, the default shell is the user's login shell (read from the `$SHELL` environment variable, typically `/bin/zsh` on modern macOS), spawned with the `-l` (login) flag so it sources the user's shell profile (`.zprofile`, `.bash_profile`, etc.) and inherits their full PATH — ensuring tools installed via Homebrew, nvm, pyenv, etc. are available. On Windows, the default shell is PowerShell. On all platforms, the shell executable and any launch arguments are user-configurable in **Settings → Notor** (e.g., users can switch to `/bin/bash`, `cmd`, or a custom shell path, and customize flags like `-l` or `--login`). If the configured shell is not found at runtime, the tool returns an error to the LLM.
- Returns combined stdout and stderr output to the LLM.
- Classified as write — available in Act mode only by default, configurable.
- Requires user approval unless auto-approved (write tool default: approval required).
- A configurable per-command timeout (default: 30 seconds) terminates long-running commands and returns a timeout error.
- A configurable maximum output size (default: 50,000 characters) is applied to the returned stdout+stderr. When command output exceeds this limit, the tool returns output up to the cap and appends a truncation notice to the LLM (e.g., "Note: command output was truncated at 50,000 characters; total output length was X characters"). The cap is configurable in **Settings → Notor**.
- The working directory must be within the vault root or a user-specified allow-list of absolute paths. Requests with a working directory outside these allowed paths are rejected.
- The vault root is always implicitly included in the allowed paths and cannot be removed.
- Additional allowed paths are configured in **Settings → Notor** via a list editor (one absolute path per line), using the same pattern as the domain denylist.

### FR-33: LLM interaction hooks — `pre-send`

**Description:** A hook that fires before each user message is sent to the LLM.

**Acceptance criteria:**
- The `pre-send` hook is triggered after the user submits a message but before it is dispatched to the LLM provider.
- Hooks are configured to execute a shell command.
- Context injection via a `pre-send` hook is achieved through a shell command: whatever the command prints to stdout is captured and appended as a string to the outgoing message context. Shell command stdout is the injection mechanism.
- When a hook executes a shell command, conversation metadata is made available to the command as environment variables, including at minimum: conversation UUID, active workflow name (if any), hook event name, and a UTC timestamp. Additional metadata fields may be added over time.
- If a hook fails, the message is still sent and the hook failure is logged and surfaced as a non-blocking notice.
- Hooks are configured in **Settings → Notor** under a hooks section grouped by lifecycle event, with each event subsection being collapsible and containing its own add/remove/reorder list. (Workflow frontmatter hook configuration is deferred to Phase 4.)
- The hook configuration is persisted across plugin reloads.
- All `pre-send` hooks are awaited (up to a configurable timeout, default: 10 seconds) before the message is dispatched to the LLM. If a hook times out, the message is still sent and the timeout is surfaced as a non-blocking notice.
- Hook failures and timeouts are independent: if one `pre-send` hook fails or times out, the remaining hooks in the sequence still execute. Each failure or timeout is surfaced as a separate non-blocking notice.

### FR-34: LLM interaction hooks — `on-tool-call`

**Description:** A hook that fires each time the LLM requests a tool invocation, before the tool is executed.

**Acceptance criteria:**
- The `on-tool-call` hook is triggered after the tool call has been approved (or auto-approved) and immediately before tool execution.
- The hook receives the tool name and parameters as context.
- When a hook executes a shell command, conversation metadata is available as environment variables, including at minimum: conversation UUID, active workflow name (if any), hook event name, tool name, tool parameters (serialized), and a UTC timestamp.
- Use cases include: executing a shell command to log or audit AI actions (e.g., appending to a vault note via a script).
- Hook execution is non-blocking with respect to the tool dispatch pipeline: if a hook fails, tool execution proceeds and the failure is surfaced as a notice. (Note: unlike `pre-send`, `on-tool-call` hooks do not block tool dispatch.)
- Configured in **Settings → Notor**, persisted across reloads. (Workflow frontmatter configuration is deferred to Phase 4.)

### FR-35: LLM interaction hooks — `on-tool-result`

**Description:** A hook that fires after each tool call completes and the result is available.

**Acceptance criteria:**
- The `on-tool-result` hook is triggered after tool execution finishes and the result (or error) has been captured, but before the result is returned to the LLM.
- The hook receives the tool name, parameters, result output, and success/error status as context.
- When a hook executes a shell command, conversation metadata is available as environment variables, including at minimum: conversation UUID, active workflow name (if any), hook event name, tool name, tool parameters (serialized), tool result (serialized), result status (success or error), and a UTC timestamp.
- Use cases include: executing a shell command in response to tool results (e.g., logging tool outputs, auditing tool behavior).
- Hook execution is non-blocking: if a hook fails, the tool result is still returned to the LLM and the failure is surfaced as a notice.
- Configured in **Settings → Notor**, persisted across reloads. (Workflow frontmatter configuration is deferred to Phase 4.)

### FR-36: LLM interaction hooks — `after-completion`

**Description:** A hook that fires after the LLM finishes a complete response turn.

**Acceptance criteria:**
- The `after-completion` hook is triggered after the LLM's full response (including any tool call cycles) is complete and the response is displayed in the chat panel.
- Use cases include: auto-saving the conversation summary to a note, appending a log entry, or executing a shell command to trigger follow-up actions.
- The hook receives the completed conversation turn as context (user message + assistant response + any tool calls/results).
- When a hook executes a shell command, conversation metadata is available as environment variables, including at minimum: conversation UUID, active workflow name (if any), hook event name, and a UTC timestamp.
- Hook failures are non-blocking: the conversation continues and failures are surfaced as notices.
- Configured in **Settings → Notor**, persisted across reloads. (Workflow frontmatter configuration is deferred to Phase 4.)

## Non-functional requirements

### NFR-6: Performance

**Description:** Phase 3 features must not degrade the responsiveness of the chat panel or Obsidian editor.

**Acceptance criteria:**
- Auto-context injection (open note paths, vault structure, OS) adds no perceptible latency to message dispatch — context collection completes in under 100 ms for typical vault sizes.
- `fetch_webpage` has a configurable request timeout (default: 15 seconds) after which the request is cancelled and an error returned to the LLM.
- Auto-compaction summarization is transparent to the user: the "Context compacted" marker appears and the conversation continues without manual intervention.
- Hook execution is asynchronous and does not block the chat pipeline. All hooks (both blocking `pre-send` and non-blocking `on-tool-call`, `on-tool-result`, `after-completion`) share a single global hook timeout (default: 10 seconds, configurable in **Settings → Notor**). Slow hooks time out independently; timed-out hook processes are terminated and do not stall message flow or leak resources.

### NFR-7: Security and privacy

**Description:** Phase 3 introduces the first outbound network calls (web fetching) and system-level access (shell commands). These must be handled with appropriate safeguards.

**Acceptance criteria:**
- `fetch_webpage` only makes network requests to user-initiated URLs (LLM-requested during an active conversation). No background or automatic web requests.
- `execute_command` only executes commands the LLM has explicitly requested and the user has approved (or auto-approved). No background command execution.
- The domain denylist provides users a mechanism to block untrusted sources from `fetch_webpage`.
- `execute_command` working directory is restricted to the vault or a user-configured allow-list; commands cannot be directed to arbitrary filesystem paths outside this scope.
- No auto-context data (open note paths, vault structure) is transmitted to any party other than the configured LLM provider.
- Hooks cannot initiate arbitrary network calls or filesystem writes outside the normal Notor tool and LLM pipeline. Hook shell commands are executed using the same runtime and path restrictions as the `execute_command` tool; they do not bypass Notor's working directory allow-list.

### NFR-8: Usability and transparency

**Description:** New Phase 3 capabilities are discoverable, clearly surfaced in the chat UI, and safe by default.

**Acceptance criteria:**
- The attachment control in the chat input area is visually discoverable without requiring documentation to find.
- Auto-context injection is on by default for all three sources; users can disable individual sources in settings.
- The "Context compacted" marker in the chat clearly communicates that earlier conversation history has been condensed. On hover or expand, the marker shows the timestamp and token count at the time of compaction. The LLM-generated summary text is not shown in the UI; it is retained in the JSONL log only.
- `execute_command` follows the same tool call transparency pattern as all other tools: the command and output are shown inline in the chat thread.
- Auto-approve defaults: `fetch_webpage` defaults to auto-approved (read-only); `execute_command` defaults to approval required (write).
- `execute_command` is restricted to Act mode by default.

### NFR-9: Reliability

**Description:** Failures in Phase 3 features are handled gracefully and do not disrupt the core chat or vault operations.

**Acceptance criteria:**
- `fetch_webpage` failures (network error, timeout, blocked domain, non-200 response) return structured error messages to the LLM rather than crashing or hanging.
- `execute_command` failures (non-zero exit code, timeout, restricted path) return the exit code and any stderr output to the LLM.
- Auto-compaction failure falls back to truncation (existing MVP behavior) and notifies the user via a notice.
- Hook failures are non-blocking; they log the failure and surface a notice but do not interrupt the conversation.
- Attachment of oversized files returns a clear user-facing error and does not attempt to send the oversized content.

## User scenarios & testing

### Primary flow: Attach a note section and ask about it

1. User opens the Notor chat panel.
2. User clicks the attachment button and types `[[Research/Climate#Key Findings]]` into the picker.
3. The "Key Findings" section of `Research/Climate.md` appears as an attachment chip in the input area.
4. User types: "Summarize the key findings and suggest three follow-up research questions."
5. The message is sent with the section content embedded. The AI responds with a summary and three questions.
6. No `read_note` tool call is needed — the content was already provided via attachment.

### Primary flow: AI fetches a webpage and saves content to a note

1. User types: "Fetch https://en.wikipedia.org/wiki/A_Mathematical_Theory_of_Communication and create a note at Research/Information Theory.md with the key points."
2. The AI invokes `fetch_webpage` with the URL. The tool call appears inline showing the URL and a result summary (e.g., "Fetched 4,200 characters of Markdown").
3. The AI processes the Markdown and invokes `write_note` to create the note.
4. A diff preview appears; user approves. The note is created and opened in the editor.

### Primary flow: Long research session with auto-compaction

1. User has a multi-hour research conversation that approaches the context window limit.
2. The plugin detects the threshold has been crossed before the next message dispatch.
3. A summarization request is sent; the LLM returns a condensed summary.
4. A "Context compacted" marker appears in the chat UI with the timestamp.
5. The conversation continues seamlessly. The full history remains in the JSONL log.

### Primary flow: Shell command assistance

1. User asks: "List all Markdown files in my vault modified in the last 7 days."
2. The AI invokes `execute_command` with an appropriate `find` or `Get-ChildItem` command based on the auto-injected OS context.
3. An approval prompt appears (auto-approve is off by default for `execute_command`). User approves.
4. The command output is returned to the AI, which formats the results into a readable list.

### Primary flow: After-completion hook saves a conversation summary

1. User has configured an `after-completion` hook that appends a one-sentence summary of each AI turn to `notor/logs/session.md`.
2. After the AI's response completes, the hook fires automatically.
3. The hook invokes `replace_in_note` (or `write_note`) to append the summary line.
4. The note is updated silently; a success notice is briefly shown.

### Alternative flow: Blocked domain fetch

1. The AI attempts to invoke `fetch_webpage` with a URL from a domain the user has denylisted.
2. The tool returns an error to the AI: "Domain example-tracker.com is blocked by your denylist."
3. The AI informs the user and asks if they want to try an alternative source.

### Alternative flow: Execute command in Plan mode

1. User is in Plan mode and asks: "Run `ls -la` in my vault root."
2. The AI attempts to invoke `execute_command`.
3. The tool dispatch blocks the call and returns an error: write tools are unavailable in Plan mode.
4. The AI informs the user and suggests switching to Act mode.

### Alternative flow: Compaction summarization fails

1. The conversation approaches the context limit; auto-compaction triggers.
2. The summarization request to the LLM times out or fails.
3. The plugin falls back to the existing truncation strategy (dropping oldest messages).
4. A user notice appears: "Context compaction failed; oldest messages were trimmed instead."
5. The user's message is still sent using the truncated context.

### Edge case: Attachment of oversized file

1. User attempts to attach a 5 MB PDF from outside the vault.
2. The plugin detects the file exceeds the configurable threshold (default: 1 MB).
3. A confirmation dialog appears: "This file is 5 MB, which is larger than the recommended limit. Attaching it may consume significant context window space. Attach anyway?"
4. If the user confirms, the file is attached and appears as a chip in the input area. If the user cancels, nothing is attached.

### Edge case: Auto-context with no open notes

1. User sends a message with no notes open in the workspace.
2. The open note paths auto-context source contributes an empty list (or is omitted from the injected context).
3. No error occurs; the message is sent normally with vault structure and OS context still included.

### Edge case: Vault note deleted after attachment chip added

1. User attaches `[[Research/Climate.md]]` — the chip appears in the input area.
2. Before sending, the user (or another process) deletes or renames `Research/Climate.md`.
3. The user sends the message. At send time, the plugin attempts to read the note and fails.
4. The message is sent without the failed attachment. An inline warning appears: "Note 'Research/Climate.md' was not found at send time; attachment omitted."
5. Any other valid attachments on the same message are included normally.

### Edge case: Section reference to non-existent heading

1. User attaches `[[Research/Climate#Nonexistent Section]]`.
2. The plugin cannot find the heading in the note.
3. An error is surfaced in the attachment chips: "Section 'Nonexistent Section' not found in Research/Climate.md."
4. The attachment is not added until the user corrects the reference.

### Edge case: `execute_command` working directory outside allowed paths

1. The AI proposes `execute_command` with `working_directory: "/etc"`.
2. The plugin checks the path against the vault root and any configured allow-list.
3. The tool execution is rejected with a message to the AI: "Working directory is outside the allowed paths."
4. The AI informs the user and asks for an alternative.

### Edge case: Hook failure does not block message

1. User has an `after-completion` hook configured that calls a workflow.
2. The workflow fails (e.g., references a non-existent note).
3. The failure is caught; a brief notice is shown: "After-completion hook failed: <reason>."
4. The chat conversation is unaffected and continues normally.

## Success criteria

1. **Users can provide explicit context without tool calls** — attaching a note or note section delivers its content directly to the LLM, visibly reflected in the chat UI, without requiring a `read_note` invocation.
2. **The AI is ambient-context-aware by default** — every message includes the user's current workspace state (open notes, vault structure, OS) without any manual effort, and each source can be individually disabled.
3. **Long sessions remain productive** — conversations that exceed the context window do not abruptly terminate or require manual restart; auto-compaction preserves continuity, and the full history is always retained in the JSONL log.
4. **The AI can retrieve and work with external web content** — users can direct the AI to fetch a URL and the returned Markdown content integrates naturally into the conversation and note editing workflow.
5. **Shell commands can be executed through the AI conversation** — with approval required by default, commands run in the user's environment and output is returned to the AI, enabling automation beyond vault operations.
6. **LLM lifecycle hooks enable automation** — users can configure at least one hook type (`pre-send`, `on-tool-call`, `on-tool-result`, `after-completion`) that fires reliably, executes its configured action, and does not interrupt the conversation on failure.
7. **Phase 3 features are safe and transparent** — `fetch_webpage` and `execute_command` are surfaced in the chat thread with the same transparency as all other tools; no background network or system calls occur without user-visible AI-initiated requests.

## Key entities

### Attachment
- Belongs to a user message.
- Has a type: vault note, vault note section, or external file.
- For vault notes and vault note sections: stores only the vault-relative path and optional section reference. The note content is read from the vault at send time, not when the chip is added. This ensures the AI always receives the current saved version of the note.
- For external files: stores the filename and file content at the time of attachment (external files are read immediately on attach since they are outside the vault and may not be accessible at send time).
- Content is embedded into the message context at send time.

### AutoContextSource
- Enumeration of injectable ambient context sources: open note paths, vault structure, OS platform.
- Each source has an enabled/disabled state persisted in settings.
- Sources are evaluated and assembled immediately before each message dispatch.

### CompactionRecord
- Recorded in the JSONL conversation log when an auto-compaction event occurs.
- Stores the timestamp, the token count at compaction, and the summary generated by the LLM.
- Displayed as a "Context compacted" marker in the chat UI. On hover or expand, the marker surfaces the timestamp and token count only; the summary text is not rendered in the UI.

### Hook
- A configured callback tied to a lifecycle event: `pre-send`, `on-tool-call`, `on-tool-result`, or `after-completion`.
- Multiple hooks can be configured per lifecycle event. Hooks for the same event are executed sequentially in the order they appear in the configuration list.
- Has a trigger event and an action: execute a shell command.
- For `pre-send` hooks, context injection is the shell command's stdout mechanism: the plugin captures stdout from the shell command and appends it as a string to the outgoing message context.
- When the action is a shell command, conversation metadata (conversation UUID, active workflow name, hook event name, tool name/parameters/result where applicable, UTC timestamp) is passed to the command as environment variables. Large environment variable values (e.g., tool result, tool parameters) are truncated at a configurable cap (default: 10,000 characters) with a truncation marker appended; the full data remains in the JSONL log.
- Persisted in plugin settings. Configured via **Settings → Notor** only; workflow frontmatter configuration is deferred to Phase 4.
- Execution timing depends on event type: `pre-send` hooks are fully awaited sequentially before message dispatch; all other hook events (`on-tool-call`, `on-tool-result`, `after-completion`) are non-blocking fire-and-forget executed sequentially.
- All hooks share a single global timeout (default: 10 seconds, configurable in **Settings → Notor**). When any hook exceeds the timeout, the shell process is terminated and a non-blocking notice is surfaced.

### DomainDenylistEntry
- A single domain string or wildcard pattern (e.g., `*.example.com`) in the user-configured denylist for `fetch_webpage`.
- Exact-domain entries match only that domain. Wildcard entries (e.g., `*.example.com`) match all sub-domains of the specified domain.
- Persisted in plugin settings.

## Clarifications

### Session 2026-07-03

- Q: How should timing work for context-injecting `pre-send` hooks, given the spec states hooks are async/non-blocking? → A: All `pre-send` hooks are fully awaited before message dispatch. Only after all `pre-send` hooks complete (or time out) is the message sent to the LLM provider. Other hook events (`on-tool-call`, `on-tool-result`, `after-completion`) remain non-blocking.
- Q: Should hook configuration via workflow frontmatter be in scope for Phase 3, given workflows are deferred to Phase 4? → A: Settings-only in Phase 3. Hook configuration via workflow frontmatter is deferred to Phase 4 alongside the workflow definition system.
- Q: Should hook shell commands require per-execution approval like the `execute_command` tool, or is configuration-time setup sufficient? → A: Approved at configuration time. When a user configures a hook shell command in Settings, that constitutes implicit approval for that command pattern. No per-execution approval prompt is shown when the hook fires.
- Q: Should the `on-tool-call` hook fire before or after the user approval check? → A: After approval (or auto-approval), immediately before tool execution. The hook only fires for tool calls that will actually run; rejected tool calls do not trigger the hook.
- Q: Should `fetch_webpage` have a maximum output size cap given that large pages could consume most or all of the context window? → A: Yes — a configurable character cap (default: 50,000 characters, approximately 12,500 tokens). When the fetched Markdown exceeds the cap, the tool returns content up to the cap and appends a truncation notice to the LLM indicating the page was truncated and including the total fetched length.
- Q: Should the auto-compaction threshold be configurable per-conversation as well as globally? → A: No per-conversation override. The compaction threshold is configurable globally in Settings only; there is no per-conversation mechanism.
- Q: Should "run a workflow" be a valid hook action in Phase 3, given the workflow system is deferred to Phase 4? → A: Remove entirely from Phase 3. The sole Phase 3 hook action is execute a shell command (with stdout serving as the context injection path for `pre-send` hooks). "Run a workflow" will be added as a hook action type when the workflow system ships in Phase 4.
- Q: How should the `execute_command` working directory allow-list be configured — UI, settings file only, or vault root only? → A: List editor in Settings → Notor, one absolute path per line (same pattern as the domain denylist). The vault root is always implicitly included. Additional absolute paths can be added or removed via the list editor.
- Q: How should attachments be rendered in the sent message thread — collapsed chip with expansion, full content inline, or chip only? → A: Chip only, no expansion. Attachments appear as labeled name chips in the sent message. The full attached content is not displayed or expandable in the thread; it is embedded in the message context sent to the LLM but not rendered inline.
- Q: What User-Agent, redirect policy, and protocol restrictions should `fetch_webpage` use? → A: Neutral `Notor/1.0` User-Agent; silently follow up to 5 redirects (error to LLM if exceeded); both http:// and https:// URLs accepted with no protocol enforcement.
- Q: What form does the "inject context" action take for `pre-send` hooks — fixed string, vault note, or shell command output? → A: Shell command stdout is the injection mechanism. The hook executes a shell command; whatever the command prints to stdout is captured and appended as a string to the outgoing message context. The sole Phase 3 hook action is "execute shell command," with stdout serving as the context injection path for `pre-send` hooks.
- Q: Can multiple hooks be configured for the same lifecycle event, and if so, how are they ordered? → A: Multiple hooks per event are allowed. Hooks for the same event execute sequentially in configuration list order. This applies to both awaited `pre-send` hooks and fire-and-forget hooks on other events.
- Q: What is the default timeout for `pre-send` hooks, which are fully awaited before message dispatch? → A: 10 seconds. This is configurable in Settings → Notor. If a hook exceeds the timeout, the message is still sent and the timeout is surfaced as a non-blocking notice.
- Q: When is vault note content read for attachments — when the chip is added or at send time? → A: At send time. The attachment chip stores only the vault path and optional section reference; the note content is read from the vault immediately before the message is dispatched. External files are an exception: they are read at chip-add time since they may not be accessible at send time.
- Q: Is the auto-compaction summarization prompt hardcoded or user-configurable? → A: User-configurable with a solid default. The plugin ships with a built-in default compaction prompt; users can override it in Settings → Notor (same pattern as the main system prompt override). Clearing the override restores the default.
- Q: Which model/provider handles the auto-compaction summarization request? → A: The same provider and model currently active for the conversation. No separate compaction model configuration exists.
- Q: If a `pre-send` hook fails or times out, do subsequent `pre-send` hooks in the sequence still execute? → A: Yes — continue on failure. Each `pre-send` hook runs independently. A failed or timed-out hook surfaces a notice but does not prevent the remaining hooks in the sequence from executing.
- Q: Which shell does `execute_command` use on Windows — PowerShell, cmd, or user-configurable? → A: PowerShell by default, user-configurable. On Windows, the shell defaults to PowerShell but can be switched to cmd in Settings → Notor. On macOS/Linux, the default is the user's login shell (`$SHELL`), also user-configurable.
- Q: What does the "Context compacted" marker show on hover/expand — metadata only, full summary, or a summary excerpt? → A: Metadata only. The marker shows the timestamp and token count at the time of compaction. The LLM-generated summary text is not displayed in the UI; it is retained in the JSONL log only.
- Q: How does the plugin count tokens to determine when the compaction threshold is crossed — local estimation, provider API, or character count only? → A: Local estimation. A lightweight bundled approximation (e.g., character count divided by a fixed ratio, or a simple BPE heuristic) is used. No provider tokenization API call is made. A small margin of error is acceptable given the 80% default threshold.
- Q: How should `fetch_webpage` handle non-HTML content types (e.g., JSON, plain text, PDF, binary)? → A: Content-type-aware handling. `text/html` responses are converted to Markdown via Turndown. `text/*` (e.g., `text/plain`) and `application/json` responses are returned as-is without Turndown conversion. All other content types (binary, PDF, images, etc.) return a clear error to the LLM indicating the content type is not supported.
- Q: How should the hook settings UI be structured in **Settings → Notor**? → A: Grouped by lifecycle event. The hooks settings section is divided into four subsections — one per lifecycle event (`pre-send`, `on-tool-call`, `on-tool-result`, `after-completion`) — each collapsible and containing its own add/remove/reorder list of configured hooks for that event.
- Q: What file types should be accepted for external file attachment (FR-25) — allowlist by extension, or runtime validation? → A: Runtime UTF-8 validation, no extension allowlist. Any file may be selected; at attach time, the plugin attempts to read it as UTF-8 text. If the file is binary or fails UTF-8 decoding, the attachment is rejected with a clear error. No extension-based allowlist is enforced.
- Q: What message role should the compaction summary be injected as in the new context window? → A: Synthetic user/assistant exchange. The summary is sent as a `user` message labeled "Summary of prior conversation: …" immediately followed by a canned `assistant` acknowledgment (e.g., "Understood. I have context of our prior conversation."). The current user message follows as the next turn. This pattern is broadly compatible across all providers.
- Q: Should duplicate note/file attachments (same path + section reference) in a single message be allowed, silently deduplicated, or rejected with a warning? → A: Silently deduplicate. If the same path and section reference is already present as a chip, a second attempt to add it is ignored without any error or notification.
- Q: How should auto-context sources be formatted and positioned in the message sent to the LLM? → A: XML-tagged block prepended to the user message content. Each source is wrapped in a descriptive XML tag within an `<auto-context>` container (e.g., `<auto-context><open-notes>path1, path2</open-notes><vault-structure>folder1, folder2</vault-structure><os>macOS</os></auto-context>`). This is prepended to the user message, not injected as a separate system message.
- Q: Should "append to vault note" be a dedicated hook action type alongside "execute shell command"? → A: No — remove "append to vault note" as a hook action. Shell commands are the sole hook action type; users can achieve vault note appending via shell commands (e.g., `echo "..." >> note.md`). This simplifies the hook system to a single extensibility surface.
- Q: Should `execute_command` have a configurable output size cap to prevent unbounded command output from consuming the context window? → A: Yes — a configurable character cap (default: 50,000 characters, same as `fetch_webpage`). When command output exceeds the cap, the tool returns output up to the cap and appends a truncation notice to the LLM. This provides symmetry with `fetch_webpage` and protects the context window.
- Q: How does the user choose between vault notes and external files from the single attachment button? → A: The attachment button opens a small menu with two options: "Attach vault note" (opens the Obsidian file picker with autocomplete) and "Attach external file" (opens the OS filesystem dialog). The `[[` shortcut in the chat input bypasses the menu and opens the vault picker directly.
- Q: Should compaction also be checked between tool call rounds within a single AI turn, or only before user messages? → A: Before every LLM API call. The compaction threshold is checked before user message dispatches and before tool-result-to-LLM round-trips within a multi-tool-call turn. This prevents mid-turn context window overflow when tool results push the conversation past the limit.
- Q: What should the user see in the chat UI while the auto-compaction summarization request is in progress? → A: An inline status indicator ("Compacting context…") appears in the chat thread at the compaction point while the summarization LLM call is in flight. Chat input remains enabled — the user can continue composing or queue a message, which will be dispatched after compaction completes. Once the summary is received, the indicator transitions to the permanent "Context compacted" marker.
- Q: How should the plugin handle large payloads (e.g., tool results) passed as environment variables to hook shell commands, given OS-imposed env var size limits? → A: Truncate at a configurable cap (default: 10,000 characters). When a hook environment variable value (e.g., tool result, tool parameters) exceeds the cap, the value is truncated and a truncation marker is appended (e.g., `[truncated at 10,000 chars; full length: 48,231 chars]`). The full data remains available in the JSONL conversation log. The cap is configurable in **Settings → Notor**.
- Q: When auto-compaction summarizes the conversation, how should user-attached note/file content from earlier messages be handled? → A: No special handling. Attachments are part of the conversation history and are summarized along with everything else during compaction. No attachment contents are re-injected or preserved separately in the post-compaction context window. Users can re-attach notes if detailed content is needed after compaction. The full original content remains in the JSONL log.
- Q: Should non-blocking hooks (`on-tool-call`, `on-tool-result`, `after-completion`) have a timeout to prevent leaked processes? → A: Yes — a single global "hook timeout" setting (default: 10 seconds) applies to all hook lifecycle events. When any hook (blocking or non-blocking) exceeds the timeout, the shell process is terminated and a non-blocking notice is surfaced. The existing `pre-send` hook timeout references in the spec now refer to this same global setting.
- Q: How should attachment contents be structured/delimited in the user message sent to the LLM? → A: XML-tagged block with type and path labels, consistent with the auto-context approach. Attachments are wrapped in an `<attachments>` container prepended to the user message content, with each attachment in a descriptive tag: `<vault-note path="..." section="...">` for vault notes/sections, `<external-file name="...">` for external files.
- Q: How should `execute_command` select which shell to use on macOS/Linux, and how should it handle Electron's limited PATH? → A: Use the user's default login shell (`$SHELL` env var) with the `-l` (login) flag to source the user's shell profile and inherit their full PATH. This is user-configurable on all platforms in **Settings → Notor** — users can customize the shell executable and launch arguments (e.g., switch to `/bin/bash`, remove `-l`, etc.).
- Q: What is the relative ordering of auto-context, attachments, and `pre-send` hook injections within the user message? → A: Fixed order: (1) `<auto-context>` block, (2) `<attachments>` block, (3) `pre-send` hook stdout output, (4) user's typed message text. This orders content from least to most salient — ambient signals first, user instruction last.
- Q: What happens if a vault note attachment cannot be read at send time (e.g., note was deleted/renamed after the chip was added)? → A: Non-blocking — send the message without the failed attachment's content, surface an inline warning in the chat thread, and include the remaining valid attachments. This is consistent with the graceful-failure pattern used across Phase 3 features.
- Q: Should `fetch_webpage` have a raw download size limit in addition to the 50K-character output cap? → A: Yes — a configurable raw download cap (default: 5 MB) applied at the HTTP level. If the response body exceeds this limit, the download is aborted and an error returned to the LLM. This protects against memory exhaustion without adding complexity; the 50K output cap operates independently on the converted/text content after download.

## Assumptions

- The LLM provider in use supports the summarization prompt format required for auto-compaction. All providers supported in Phase 0 are assumed capable of producing a coherent summary from a conversation history.
- The Turndown library (~14 KB minified) can be bundled into the plugin without significant size impact. If a readability extraction layer is needed in the future (e.g., Mozilla Readability.js), it can be added without breaking the interface.
- `execute_command` uses Node.js `child_process` APIs available in Obsidian's Electron environment. If mobile compatibility is required, this tool must be gated behind desktop-only detection.
- Section header attachment (`[[Note#Section]]`) follows Obsidian's standard heading anchor format. Ambiguous or duplicated heading names are resolved by taking the first match.
- The per-model context window token limit (needed for auto-compaction threshold calculation) is sourced from the model metadata already tracked in Phase 0/1 provider configuration. For models where this metadata is unavailable, auto-compaction falls back to the MVP truncation behavior.
- Token counting for compaction threshold purposes uses a local lightweight approximation rather than a provider tokenization API. The approximation is expected to be close enough for the 80% default threshold to function correctly in practice; exact precision is not required.
- Hooks that execute shell commands rely on the same `execute_command` runtime used by the tool of the same name, including the working directory and path restriction model. Hook shell commands are approved at configuration time (configuring the hook in Settings constitutes implicit user approval); they do not trigger the per-execution approval UI that governs `execute_command` tool calls from the LLM.

## Out of scope

The following are explicitly excluded from Phase 3 and deferred to later phases:

- **Personas** (Phase 4): per-persona auto-approve overrides are not in scope; all Phase 3 features use global settings.
- **Workflows** (Phase 4): while hooks can trigger workflows by name, the workflow definition system itself is Phase 4.
- **Hook configuration via workflow frontmatter** (Phase 4): in Phase 3, hooks are configured only in **Settings → Notor**. Per-workflow hook overrides via frontmatter are deferred to Phase 4 alongside the workflow definition system.
- **`<include_notes>` tag** (Phase 4): dynamic note injection via inline tags in system prompts or workflow bodies.
- **Vault event hooks** (Phase 4): on-note-open, on-save, on-tag-change, on-schedule triggers are Phase 4.
- **"Run a workflow" hook action** (Phase 4): triggering a named workflow from a hook is deferred to Phase 4 alongside the workflow definition system. The sole Phase 3 hook action is execute a shell command (with stdout optionally injected into message context for `pre-send` hooks).
- **Content extraction / readability filtering for `fetch_webpage`**: the initial implementation returns raw Turndown conversion without stripping navigation, ads, or boilerplate.
- **Pagination of `fetch_webpage` output**: no multi-page chunking or sequential fetching. A single configurable character cap (default: 50,000 characters) applies; content beyond the cap is truncated in one pass with a notice to the LLM.
- **Background or scheduled auto-fetch**: `fetch_webpage` is only invoked by an explicit LLM tool call during an active conversation.
- **Multi-agent and background agents** (Phase 5).
- **Custom MCP tools** (Phase 5).
- **Browser capabilities / Obsidian Web Viewer integration** (Phase 5).
- **External file access beyond attachment** (Phase 5): external files can be attached to messages, but the AI cannot autonomously read external files via a tool call.
- **"Append to vault note" hook action**: users can achieve vault note appending via shell commands (e.g., `echo "..." >> note.md`), so a dedicated "append to vault note" action type is not provided. Shell commands are the sole hook action type, providing a single extensibility surface for all automation.
- **Arbitrary hook scripts beyond shell commands**: hooks can run shell commands (with metadata context), but cannot execute arbitrary in-process code or dynamically loaded scripts. Shell commands provide the extensibility surface for complex automation.
