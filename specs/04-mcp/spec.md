# Phase 4.1 — Custom MCP Servers

**Created:** 2026-09-03
**Status:** Draft
**Branch:** 04-mcp

## Overview

Phase 4.1 extends Notor's tool set beyond built-in tools by enabling users to connect custom MCP (Model Context Protocol) servers. MCP is an open standard that allows AI applications to discover and invoke tools hosted by external servers. By integrating MCP client support, Notor users can register their own MCP servers — local command-line tools (via stdio), remote HTTP services, or both — and have those tools surface to the AI alongside Notor's built-in tools with no special treatment. The AI can discover, invoke, and receive results from custom MCP tools through the same dispatch pipeline that handles built-in tools, including Plan/Act enforcement, auto-approve checks, and the approval UI. This phase also introduces a cooperative Plan/Act state signaling mechanism so MCP servers can make their own decisions about write-type actions based on the user's current mode.

This specification covers Phase 4.1 of the roadmap:

- **MCP server configuration**: users register and configure custom MCP servers in Settings — specifying transport type (stdio for local processes, SSE or Streamable HTTP for remote servers), connection parameters, and per-tool overrides.
- **Tool schema discovery**: on connection, Notor queries each MCP server for its available tools and input schemas via the MCP protocol. Discovered tools are registered in a unified tool registry alongside built-in tools.
- **Uniform tool dispatch**: custom MCP tools go through the same dispatch pipeline as built-in tools — Plan/Act enforcement, auto-approve checks, and approval UI apply equally.
- **Read/write classification**: each custom MCP tool can be classified as read-only or write. The default classification is derived from the server-reported `ToolAnnotations.readOnlyHint`, with user overrides available in Settings.
- **Plan/Act state signaling**: the current Plan/Act mode is communicated to MCP servers on each tool invocation via the `_meta.notor_mode` field so servers can make their own cooperative decisions about write-type actions.
- **Trust and safety**: clear warnings are displayed in the settings UI and documentation, communicating that custom tools bypass built-in safety guarantees.

## User stories

### MCP server configuration

- As a user, I want to register custom MCP servers in Notor's settings so that I can extend the AI's tool set with tools specific to my workflow.
- As a user, I want to connect a locally-running MCP server via stdio (spawning a local process) so that I can use community MCP servers that run as command-line tools on my machine.
- As a user, I want to connect a remote MCP server via HTTP so that I can use cloud-hosted or network-accessible tool servers.
- As a user, I want to enable or disable individual MCP servers without removing their configuration so that I can temporarily stop using a server without losing its settings.
- As a user, I want to see the connection status of each configured MCP server (connected, disconnected, error) so that I can diagnose connectivity issues.

### Tool discovery and invocation

- As a user, I want MCP server tools to appear alongside built-in tools in the AI's tool set so that the AI can use them naturally without me having to do anything special.
- As a user, I want to see MCP tool calls displayed in the chat with the same transparency as built-in tools so that I know exactly what the AI is doing with my custom tools.
- As a user, I want to approve or reject MCP tool calls the same way I approve built-in tool calls so that I maintain control over what actions the AI takes.

### Read/write classification and Plan/Act

- As a user, I want each MCP tool to be classified as read-only or write so that Plan mode blocks write-classified MCP tools the same way it blocks built-in write tools.
- As a user, I want to override the default read/write classification for any MCP tool in Settings so that I can correct a server's classification if it doesn't match my expectations.
- As a user, I want MCP servers to receive the current Plan/Act mode on each tool call so that well-behaved servers can make their own cooperative decisions about write-type actions.

### Auto-approve

- As a user, I want to configure per-tool auto-approve settings for MCP tools so that I can streamline approval for trusted tools while requiring manual approval for sensitive ones.
- As a user who has configured per-persona auto-approve overrides, I want those overrides to apply to MCP tools as well so that my persona-based approval workflow extends to custom tools.

### Trust and safety

- As a cautious user, I want clear warnings when adding MCP servers so that I understand that custom tools run outside Notor's built-in safety guarantees.
- As a user adding a stdio server, I want to be informed that this will spawn a local process with my user permissions so that I can make an informed trust decision.

## Functional requirements

### FR-54: MCP server registration and configuration

**Description:** Users register and configure custom MCP servers in **Settings → Notor**, specifying transport type, connection parameters, and optional per-tool overrides. Configuration is persisted in Notor's plugin settings data.

**Acceptance criteria:**
- MCP server configuration is managed in **Settings → Notor** under a dedicated "MCP servers" section.
- Each server configuration includes:
  | Field | Required | Description |
  |---|---|---|
  | Name | yes | A user-chosen display name for the server (used as the unique key in configuration) |
  | Transport type | yes | One of: `stdio`, `sse`, or `streamableHttp` |
  | Command | yes (stdio) | The command to spawn the local process (e.g., `npx`, `python`, a path to a binary) |
  | Arguments | no (stdio) | Command-line arguments for the process |
  | Working directory | no (stdio) | Working directory for the spawned process (defaults to vault root) |
  | Environment variables | no (stdio) | Additional environment variables to set for the spawned process (merged with the system environment) |
  | URL | yes (sse, streamableHttp) | The server endpoint URL |
  | Headers | no (sse, streamableHttp) | Custom HTTP headers (e.g., for API key authentication) |
  | Enabled | no | Whether the server is active (default: `true`). Disabled servers are not connected on plugin load. |
  | Timeout | no | Request timeout in seconds for tool calls to this server (default: 60 seconds) |
- Users can add, edit, and remove server configurations from the Settings UI.
- Users can enable or disable individual servers via a toggle without removing their configuration.
- Server configurations are persisted in Notor's plugin settings data (via `loadData`/`saveData`), not in a separate configuration file.
- The `stdio` transport type is only available on desktop. On mobile, the Settings UI hides the `stdio` option or displays an informational message that local process servers require the desktop app.
- When a server configuration is saved, the plugin connects (or reconnects) to the server automatically if the server is enabled. A manual "Restart" button is available per server for reconnecting after errors or configuration changes.
- Changes to server configuration take effect without requiring a plugin reload.

### FR-55: MCP server connection lifecycle

**Description:** The plugin manages the full lifecycle of MCP server connections — initialization, capability negotiation, operational use, and cleanup — with proper resource management tied to the Obsidian plugin lifecycle.

**Acceptance criteria:**
- On plugin load, the plugin reads the saved MCP server configuration and initiates connections to all enabled servers asynchronously. Server connections do not block plugin startup — the plugin finishes loading while connections are established in the background.
- For each enabled server, the plugin establishes a connection using the appropriate transport:
  - **stdio**: spawns a child process using the configured command, arguments, working directory, and environment variables. Communication is via stdin/stdout using newline-delimited JSON-RPC.
  - **SSE (Server-Sent Events)**: opens an HTTP connection to the configured URL with optional custom headers.
  - **Streamable HTTP**: opens an HTTP connection to the configured URL with optional custom headers.
- After transport establishment, the plugin performs the MCP `initialize` handshake — exchanging client and server information and negotiating capabilities.
- After successful initialization, the plugin queries the server for its tool list (see FR-56).
- Each server's connection status is tracked and displayed in the Settings UI:
  - **Connecting**: connection is being established
  - **Connected**: handshake complete, tools discovered
  - **Disconnected**: not connected (disabled, manually stopped, or not yet connected)
  - **Error**: connection failed (with an error message visible in Settings)
- On plugin unload, all active connections are cleanly closed:
  - stdio: transport is closed and the child process is terminated (SIGTERM, then SIGKILL after a grace period)
  - HTTP transports: connections are closed
- Connection cleanup is registered via Obsidian's `this.register()` helper to ensure cleanup occurs even on unexpected shutdown.
- **Reconnection behavior:**
  - **stdio**: on disconnection (process exit or crash), the server is marked as disconnected. No automatic reconnection. The user can click "Restart" in Settings to re-spawn the process.
  - **HTTP transports (SSE, Streamable HTTP)**: on disconnection, automatic reconnection is attempted with exponential backoff. After repeated failures, the server is marked as errored with a descriptive message.
- If a server's `initialize` handshake fails (e.g., incompatible protocol version, timeout), the server is marked as errored with the failure reason displayed in Settings.

### FR-56: Tool schema discovery

**Description:** After connecting to an MCP server, the plugin discovers the server's available tools and their input schemas, registering them in the unified tool registry alongside built-in tools.

**Acceptance criteria:**
- After a successful `initialize` handshake, the plugin sends a `tools/list` request to the server.
- Each discovered tool includes: name, description (optional), input schema (JSON Schema for parameters), and optional `ToolAnnotations` (including `readOnlyHint`).
- Discovered tools are registered in Notor's unified tool registry so the AI sees them alongside built-in tools. The AI does not need to distinguish between built-in and MCP tools.
- MCP tools are namespaced in the tool registry to prevent name collisions with built-in tools or tools from other MCP servers. The naming convention is `{serverName}/{toolName}` (e.g., `my-db-server/query`). When the tool is presented to the LLM, the full namespaced name is used.
- The tool descriptions sent to the LLM include the tool name, description, and input schema — in the same format as built-in tools.
- The Settings UI displays the list of discovered tools for each connected server, showing each tool's name, description, read/write classification, and auto-approve status.
- If the `tools/list` request fails, the server is marked as connected but with a warning that tool discovery failed. The user can retry via a "Refresh tools" button in Settings.
- When a server reconnects (after disconnection or manual restart), tool discovery is re-run. If the server's tool list has changed, the tool registry is updated accordingly.

### FR-57: Read/write classification for MCP tools

**Description:** Each MCP tool is classified as read-only or write, enabling Plan/Act mode enforcement. The default classification is derived from the server's `ToolAnnotations`, with user overrides available in Settings.

**Acceptance criteria:**
- When a tool is first discovered, its default read/write classification is set based on the server-reported `ToolAnnotations.readOnlyHint`:
  - If `readOnlyHint` is `true`, the tool defaults to **read-only**.
  - If `readOnlyHint` is `false` or absent, the tool defaults to **write**.
- The user can override the classification for any MCP tool in **Settings → Notor** under the server's tool list. The override takes precedence over the server-reported hint.
- Per-tool classification overrides are persisted in the server's configuration within Notor's plugin settings data.
- When the AI requests a write-classified MCP tool in Plan mode, the tool call is rejected with an error message returned to the LLM — identical to how built-in write tools are blocked in Plan mode.
- When the AI requests a read-only-classified MCP tool in Plan mode, the tool call is allowed.
- The Settings UI displays an informational note next to the classification selector explaining that server-reported hints are not verified and the user's override takes precedence.

### FR-58: Plan/Act state signaling to MCP servers

**Description:** The current Plan/Act mode is communicated to MCP servers on each tool invocation via a metadata field, enabling servers to make cooperative decisions about write-type actions.

**Acceptance criteria:**
- On every `tools/call` request to an MCP server, the plugin includes the current Plan/Act mode in the request's `_meta` field: `_meta: { notor_mode: "plan" }` or `_meta: { notor_mode: "act" }`.
- The `_meta` field is part of the MCP specification's `Request` type and is designed for arbitrary client metadata — this is not a protocol extension or workaround.
- MCP servers that do not inspect `_meta.notor_mode` are unaffected — the field is silently ignored.
- The signal is a simple binary (`"plan"` or `"act"`). No additional context (auto-approve settings, active persona, etc.) is included.
- The trust model is cooperative: MCP servers are trusted to respect the signal, but Notor does not attempt to verify compliance. Notor's own Plan/Act enforcement (FR-57) provides the hard gate; the `_meta` signal is advisory.
- Plan/Act state signaling is always active for all MCP tool calls — it is not configurable.

### FR-59: Uniform tool dispatch for MCP tools

**Description:** MCP tool calls go through the same dispatch pipeline as built-in tools, ensuring consistent enforcement of Plan/Act mode, auto-approve settings, and the approval UI.

**Acceptance criteria:**
- When the LLM requests an MCP tool, the dispatcher:
  1. Identifies the tool as an MCP tool (via the namespaced tool name).
  2. Resolves the target server and tool name from the namespaced identifier.
  3. Checks Plan/Act mode: if in Plan mode and the tool is classified as write, rejects the call with an error returned to the LLM.
  4. Checks auto-approve settings (global → persona override → per-tool MCP override): if auto-approved, proceeds to execution. If not, presents the approval UI and waits for user response.
  5. On approval (or auto-approve), sends the `tools/call` request to the MCP server with `_meta.notor_mode` included (FR-58).
  6. Returns the server's response to the LLM as the tool result.
- MCP tool calls are displayed in the chat UI with the same transparency as built-in tools: tool name, parameters, and result are shown inline in the conversation.
- If the MCP server returns an error (e.g., tool execution failure, timeout), the error is formatted and returned to the LLM as a tool result (not swallowed), consistent with how built-in tool errors are handled.
- If the MCP server is disconnected when a tool call is attempted, an error is returned to the LLM indicating the server is unavailable.
- The per-server request timeout (FR-54, default: 60 seconds) applies to each `tools/call` request. If the timeout is exceeded, the request is cancelled and a timeout error is returned to the LLM.

### FR-60: Auto-approve settings for MCP tools

**Description:** Users can configure per-tool auto-approve settings for MCP tools, and existing per-persona auto-approve overrides extend to MCP tools.

**Acceptance criteria:**
- Each MCP tool can be individually configured for auto-approve in Settings, under the server's tool list. The default is to require approval (auto-approve off) for all newly discovered MCP tools.
- The auto-approve check for MCP tools follows the same precedence chain as built-in tools: persona override (if a persona is active and has an explicit override for the tool) → server-level per-tool setting → global default for MCP tools (require approval).
- Per-persona auto-approve overrides (from **Settings → Notor → Persona auto-approve**, FR-40) include MCP tools in their tool list. When an MCP server is connected and tools are discovered, those tools appear in the persona auto-approve UI alongside built-in tools.
- If an MCP tool is removed (server disconnected or tool no longer reported by the server), stale entries in auto-approve settings are preserved with a warning indicator, consistent with the stale tool handling defined in FR-40.
- Auto-approve changes take effect on the next tool dispatch — no plugin reload required.

### FR-61: MCP server settings UI

**Description:** The MCP server configuration area in Settings provides a complete management interface for server configuration, connection status, and per-tool settings.

**Acceptance criteria:**
- The "MCP servers" section in **Settings → Notor** displays:
  - A list of all configured servers with: name, transport type, connection status indicator (connected/connecting/disconnected/error), and an enable/disable toggle.
  - An "Add server" button that opens a form for registering a new server (transport type selector, then transport-specific fields).
- Each server entry is expandable to show:
  - Server configuration fields (editable).
  - A "Restart" button to manually reconnect.
  - A "Remove" button to delete the server configuration (with a confirmation prompt).
  - After connection, a "Tools" sub-section listing all discovered tools with:
    - Tool name and description.
    - Read/write classification selector (dropdown: "Read-only" or "Write"), showing the server-reported default and the user's override.
    - Auto-approve toggle per tool.
  - A "Refresh tools" button to re-query the server's tool list.
- **Trust warning on adding any server:** When the user adds a new server, a prominent warning is displayed: "Custom MCP tools run outside Notor's built-in safety guarantees. Only add servers you trust."
- **Additional warning for stdio servers:** When the transport type is `stdio`, an additional notice is displayed: "This will spawn a local process on your machine with your user permissions."
- **Classification advisory:** Next to the read/write classification selector, a brief note: "Server-reported hints are not verified. Your override takes precedence."
- If a server is in an error state, the error message is displayed inline with a suggestion to check configuration or restart.
- The Settings UI is responsive to configuration changes — adding, editing, or removing servers updates the display immediately without a page refresh.

### FR-62: MCP tool display in chat UI

**Description:** MCP tool calls and results are displayed in the chat panel with the same level of transparency and detail as built-in tools.

**Acceptance criteria:**
- MCP tool calls are displayed inline in the chat conversation, showing: the tool name (with server name prefix for disambiguation), parameters passed to the tool, and the tool result.
- The display format is consistent with built-in tool calls — the same collapsible tool-call UI component is used.
- The approval UI for MCP tools is identical to built-in tools: an approve/reject prompt appears inline in the chat when manual approval is required.
- Tool call parameters and results for MCP tools may contain arbitrary content (unlike built-in tools with known parameter shapes). The UI renders parameters as formatted key-value pairs and results as preformatted text, handling unexpected content gracefully (e.g., truncating very large results with an expansion option).

## Non-functional requirements

### NFR-14: Performance

**Description:** MCP server connections and tool invocations must not degrade the responsiveness of the chat panel, editor, or plugin startup.

**Acceptance criteria:**
- MCP server connections are established asynchronously after plugin load. The plugin's `onload()` completes without waiting for any MCP server to connect — the chat panel and all built-in tools are usable immediately.
- Tool schema discovery (the `tools/list` request) completes within the per-server timeout. Discovered tools appear in the AI's tool set as soon as discovery completes, without requiring a plugin reload.
- Tool invocation latency is determined by the MCP server's response time plus network overhead. Notor adds no more than 50 ms of dispatch overhead (Plan/Act check, auto-approve check, `_meta` injection, response formatting) beyond the server's own processing time.
- Connecting up to 10 concurrent MCP servers does not cause perceptible degradation in chat panel responsiveness or editor performance.
- stdio server process spawning completes within 10 seconds. If the process does not produce a valid MCP `initialize` response within 30 seconds, the connection is marked as errored and no further retries occur until the user clicks "Restart".

### NFR-15: Security and privacy

**Description:** MCP server integration maintains appropriate trust boundaries and clearly communicates risk to users.

**Acceptance criteria:**
- stdio MCP servers are guarded behind a desktop-only check. On mobile, stdio transport is unavailable and the Settings UI does not offer it as an option.
- stdio server processes are spawned with the same user permissions as the Obsidian process. No privilege escalation is possible through the MCP integration.
- HTTP transport headers (which may contain API keys or tokens) are stored in Notor's plugin settings data. Sensitive header values (e.g., `Authorization`) should use Obsidian's secrets manager API for storage where feasible, consistent with how LLM provider API keys are stored.
- MCP tool calls do not bypass Plan/Act enforcement. Write-classified MCP tools are blocked in Plan mode regardless of what the MCP server reports or does.
- The `_meta.notor_mode` signal is advisory and cooperative. Notor does not attempt to verify that an MCP server respects the signal.
- No MCP server can access Notor's internal state, other MCP servers' data, or vault contents beyond what is explicitly passed as tool arguments by the AI.
- Trust warnings are displayed prominently when adding servers (see FR-61) and cannot be dismissed permanently — they appear each time a new server is added.

### NFR-16: Reliability

**Description:** MCP server failures are isolated and do not disrupt core chat functionality or other MCP server connections.

**Acceptance criteria:**
- A single MCP server crashing, disconnecting, or timing out does not affect built-in tools, other MCP servers, or the active conversation.
- If an MCP server disconnects mid-conversation, any pending tool call to that server returns an error to the LLM. The conversation continues normally — the LLM can use other tools or respond without the failed tool.
- stdio process crashes are detected via process exit events. The server is marked as disconnected and a non-blocking notice is surfaced.
- HTTP transport disconnections trigger automatic reconnection with exponential backoff. Reconnection attempts do not block the UI or other server operations.
- Malformed MCP server responses (invalid JSON-RPC, unexpected schema) are caught and returned as errors to the LLM rather than crashing the plugin.
- Plugin unload cleanly terminates all MCP connections and child processes. No zombie processes are left running after the plugin is disabled or Obsidian is closed.

## User scenarios & testing

### Primary flow: Add and use a stdio MCP server

1. User opens **Settings → Notor → MCP servers** and clicks "Add server".
2. A trust warning is displayed: "Custom MCP tools run outside Notor's built-in safety guarantees. Only add servers you trust."
3. User selects transport type `stdio`, enters name "filesystem", command `npx`, arguments `-y @modelcontextprotocol/server-filesystem /Users/me/documents`.
4. An additional notice appears: "This will spawn a local process on your machine with your user permissions."
5. User saves the configuration. The plugin spawns the process, performs the MCP handshake, and discovers tools (e.g., `read_file`, `write_file`, `list_directory`).
6. The server status shows "Connected" with a green indicator. The discovered tools are listed under the server entry with their names, descriptions, and default classifications.
7. User starts a new conversation in the chat panel. The AI's tool set now includes `filesystem/read_file`, `filesystem/write_file`, and `filesystem/list_directory` alongside built-in tools.
8. User asks: "List the files in my documents folder." The AI invokes `filesystem/list_directory`. The tool call appears inline in the chat. Since MCP tools default to requiring approval, the approval UI appears.
9. User approves the call. The tool executes and returns the directory listing. The result is displayed in the chat and the AI summarizes the contents.

### Primary flow: Add and use an HTTP MCP server

1. User opens **Settings → Notor → MCP servers** and clicks "Add server".
2. User selects transport type `streamableHttp`, enters name "my-api", URL `https://my-mcp-server.example.com/mcp`, and adds an `Authorization` header with a bearer token.
3. User saves. The plugin connects via HTTP, completes the handshake, and discovers tools.
4. The server shows "Connected". Discovered tools appear in the settings UI.
5. User uses the tools in conversation. The AI invokes the HTTP-based tools the same way as built-in tools — full transparency, approval flow, and result display.

### Primary flow: Configure read/write classification and auto-approve

1. User has a connected MCP server "db-tools" with discovered tools `query` and `execute_sql`.
2. In Settings, user sets `query` to "Read-only" and `execute_sql` to "Write". User enables auto-approve for `query`.
3. In Plan mode, the AI can invoke `db-tools/query` (read-only, auto-approved — executes without approval prompt). The AI attempts `db-tools/execute_sql` but it is blocked — the LLM receives an error: "Tool 'db-tools/execute_sql' is write-only and blocked in Plan mode."
4. User switches to Act mode. The AI invokes `db-tools/execute_sql`. Since it is not auto-approved, the approval UI appears. User approves and the SQL is executed.

### Primary flow: Persona auto-approve override for MCP tools

1. User has a persona "data-analyst" with auto-approve overrides configured in **Settings → Notor → Persona auto-approve**.
2. Under the "data-analyst" persona, user sets `db-tools/query` to "Auto-approve" and `db-tools/execute_sql` to "Require approval".
3. User activates the "data-analyst" persona and asks the AI to analyze some data.
4. The AI invokes `db-tools/query` — auto-approved via persona override, no prompt.
5. The AI invokes `db-tools/execute_sql` — requires approval per persona override, approval UI appears.

### Alternative flow: MCP server fails to connect

1. User adds a stdio server with an invalid command (e.g., a binary that doesn't exist).
2. The plugin attempts to spawn the process. The spawn fails immediately.
3. The server status shows "Error" with the message: "Failed to spawn process: command not found."
4. The user corrects the command in Settings and clicks "Restart". The server connects successfully.

### Alternative flow: MCP server disconnects mid-conversation

1. User is mid-conversation and the AI invokes an MCP tool. The MCP server process crashes during execution.
2. The tool call returns an error to the LLM: "MCP server 'filesystem' is unavailable (disconnected)."
3. A non-blocking notice appears: "MCP server 'filesystem' disconnected."
4. The server status in Settings updates to "Disconnected". The user can click "Restart" to re-spawn.
5. The conversation continues normally — the LLM can use built-in tools or other MCP servers.

### Alternative flow: Tool discovery fails

1. An MCP server connects and the handshake succeeds, but the `tools/list` request times out.
2. The server shows "Connected" with a warning: "Tool discovery failed."
3. No tools from this server appear in the AI's tool set.
4. User clicks "Refresh tools" in Settings. The `tools/list` request succeeds this time and tools appear.

### Alternative flow: stdio on mobile

1. User opens **Settings → Notor → MCP servers** on mobile (iOS/Android).
2. The transport type selector shows only `sse` and `streamableHttp`. The `stdio` option is not available.
3. An informational note explains: "Local process (stdio) servers require the Obsidian desktop app."
4. User can still add HTTP-based MCP servers and use them on mobile.

### Edge case: Plan/Act state signaling is cooperative

1. User has an MCP server that exposes a `deploy` tool. User classifies it as "Write" in Settings.
2. In Plan mode, Notor blocks the tool call at the dispatch level — the `tools/call` request is never sent.
3. In Act mode, Notor sends the `tools/call` request with `_meta: { notor_mode: "act" }`. The server processes the request normally.
4. User switches to Plan mode. Notor would send `_meta: { notor_mode: "plan" }` on calls, but since the tool is write-classified, the call is blocked before reaching the server.
5. A read-only MCP tool in Plan mode receives `_meta: { notor_mode: "plan" }`. A well-behaved server can use this signal to limit its behavior further, but Notor does not verify compliance.

### Edge case: Server tool list changes on reconnect

1. An MCP server reconnects after a temporary disconnection.
2. Tool discovery re-runs. The server now exposes one new tool and has removed one old tool.
3. The new tool appears in the tool registry and is available to the AI. The removed tool is no longer in the registry.
4. User-configured classification and auto-approve settings for the removed tool are preserved in Settings with a stale warning indicator, but have no runtime effect.

### Edge case: Tool name collision prevention

1. Two MCP servers each expose a tool called `search`. Server A is named "web-search" and server B is named "vault-search".
2. The tools are registered as `web-search/search` and `vault-search/search` — no collision.
3. The AI sees both tools with their distinct namespaced names and can invoke either one specifically.

### Edge case: Server timeout on tool call

1. The AI invokes an MCP tool. The server takes longer than the configured timeout (default: 60 seconds) to respond.
2. The request is cancelled and a timeout error is returned to the LLM: "Tool call to 'my-server/slow-tool' timed out after 60 seconds."
3. The conversation continues — the LLM can retry or take an alternative approach.

## Success criteria

1. **Users can register and connect custom MCP servers** — stdio (local process) and HTTP (remote) MCP servers can be added, configured, enabled/disabled, and connected from Settings with clear status feedback, all without a plugin reload.
2. **Custom tools are indistinguishable from built-in tools in the AI's experience** — MCP tools appear alongside built-in tools in the AI's tool set. The AI discovers, invokes, and receives results from MCP tools the same way as built-in tools, with no special prompting or user intervention required.
3. **Plan/Act enforcement extends to custom tools** — write-classified MCP tools are blocked in Plan mode. Users can override the default read/write classification per tool. The current mode is communicated to MCP servers via `_meta` on each call so cooperative servers can make their own decisions.
4. **Approval workflow is consistent** — MCP tool calls go through the same auto-approve and manual approval flow as built-in tools. Per-tool auto-approve settings and per-persona overrides apply to MCP tools.
5. **Trust boundaries are clear** — users see prominent warnings when adding MCP servers and when configuring stdio servers. The distinction between Notor's built-in safety guarantees and the cooperative trust model for MCP tools is communicated in the Settings UI.
6. **Failures are isolated** — a single MCP server crashing, disconnecting, or timing out does not affect built-in tools, other MCP servers, or the active conversation. The user can diagnose and recover via Settings.
7. **Plugin startup is not degraded** — MCP server connections are established asynchronously after plugin load. The chat panel and built-in tools are usable immediately, even if MCP servers are still connecting.

## Key entities

### McpServerConfig
- Represents a single MCP server configuration entry in Notor's plugin settings.
- Fields: name (unique key), transport type (`stdio` | `sse` | `streamableHttp`), transport-specific connection parameters (command/args/cwd/env for stdio; url/headers for HTTP), enabled flag, request timeout, per-tool classification overrides, per-tool auto-approve list.
- Stored in `mcpServers` map within Notor's plugin settings data (`data.json` via `loadData`/`saveData`).

### McpConnection
- Represents a live connection to an MCP server at runtime.
- State: connecting → connected → disconnected | error.
- Holds a reference to the MCP client instance, the transport, and the list of discovered tools.
- Created when a server is enabled and connected; disposed on disconnect, server removal, or plugin unload.

### McpTool (discovered)
- Represents a single tool discovered from an MCP server via `tools/list`.
- Properties: name, description, input schema (JSON Schema), `ToolAnnotations` (including `readOnlyHint`).
- Registered in Notor's unified tool registry with a namespaced name (`{serverName}/{toolName}`).
- Classification (read/write) is derived from `readOnlyHint` by default, overridable by user in Settings.
- Auto-approve is off by default for all MCP tools, configurable per-tool.

### Connection status
- A state machine with four states: `Connecting`, `Connected`, `Disconnected`, `Error`.
- Transitions:
  - `Disconnected` → `Connecting` (on enable, restart, or plugin load)
  - `Connecting` → `Connected` (handshake + tool discovery succeed)
  - `Connecting` → `Error` (handshake fails, timeout, spawn fails)
  - `Connected` → `Disconnected` (process exit for stdio, network loss for HTTP)
  - `Error` → `Connecting` (on restart or config edit + save)
- Displayed in Settings UI with a visual indicator per server.

## Assumptions

- The MCP protocol specification version `2025-06-18` (or compatible) is the target. The `@modelcontextprotocol/sdk` TypeScript package provides client transport classes and schema validators.
- Notor's existing tool dispatch pipeline (Plan/Act check → auto-approve check → approval UI → execution → result) can be extended to route MCP tool calls without architectural changes.
- Notor's existing `child_process.spawn()` usage for `execute_command` (in `src/shell/shell-executor.ts`) confirms that process spawning works reliably from within the Obsidian Electron environment on desktop.
- The MCP SDK is a pure TypeScript/JavaScript package with no native modules. It can be bundled into `main.js` via esbuild without compatibility issues.
- Most community MCP servers use the stdio transport. Supporting all three transports (stdio, SSE, Streamable HTTP) covers the vast majority of existing MCP servers.
- Server-reported `ToolAnnotations` (including `readOnlyHint`) are treated as hints, not guarantees. The user's override in Settings is the authoritative classification. This is consistent with the MCP specification's own guidance that annotations are not guaranteed to faithfully describe tool behavior.
- OAuth-based authentication for MCP servers is not required for the initial implementation. Most community MCP servers use either no authentication (local stdio) or simple API key headers (HTTP). OAuth support can be added in a future iteration.
- The `_meta` field on MCP `tools/call` requests is supported by the MCP SDK's `Client.request()` method, which passes through the full `params` object including `_meta` without stripping custom fields.
- Obsidian's mobile environment (iOS/Android) does not provide `child_process` APIs. stdio transport is desktop-only, consistent with the existing `execute_command` tool's desktop-only restriction.
- MCP server configuration does not need file-watching or hot-reload from external changes. All configuration is managed through the Settings UI and persisted via Obsidian's plugin data API.

## Out of scope

The following are explicitly excluded from Phase 4.1 and deferred to later phases or iterations:

- **MCP server marketplace or download system**: users configure servers manually. There is no built-in catalog, search, or one-click install for MCP servers.
- **OAuth authentication flows**: MCP servers requiring OAuth (authorization code flow, token refresh, etc.) are not supported in Phase 4.1. Users can provide static bearer tokens via HTTP headers. Full OAuth support is deferred.
- **MCP resources and prompts**: the MCP protocol defines resources (`resources/list`, `resources/read`) and prompts (`prompts/list`, `prompts/get`) in addition to tools. Phase 4.1 implements only tool discovery and invocation. Resource and prompt support may be added in a future iteration.
- **In-process custom tools**: all custom tools in Phase 4.1 are hosted externally as MCP servers. A future capability to run user-defined tools directly within the Obsidian plugin process (without an external server) is out of scope.
- **MCP server notifications and subscriptions**: the MCP protocol supports server-to-client notifications (e.g., `notifications/tools/list_changed`). Phase 4.1 does not subscribe to or handle these notifications. Tool list updates are triggered by reconnection or manual "Refresh tools" actions.
- **Multi-agent MCP tool access** (Phase 5): when multi-agent support is added, MCP tool access per agent will need scoping. This is out of scope for Phase 4.1.
- **MCP server logging/diagnostics UI**: detailed logging of MCP JSON-RPC traffic for debugging. Phase 4.1 surfaces connection status and errors but does not provide a protocol-level debug view.
- **Automatic tool classification inference**: inferring read/write classification from tool names or descriptions using heuristics or LLM analysis. Phase 4.1 relies on `ToolAnnotations.readOnlyHint` and user overrides only.
- **MCP server health monitoring**: periodic health checks or heartbeat pings to detect unresponsive servers proactively. Failures are detected reactively when tool calls fail or connections drop.
