# Custom MCP tool servers

Extend the AI's tool set beyond built-in tools by connecting custom MCP (Model Context Protocol) servers — local command-line processes (stdio) or remote HTTP services.

## Transport types

| Transport | Description | Platforms |
|---|---|---|
| **stdio** | Spawns a local process via the configured command, arguments, working directory, and environment variables. JSON-RPC over stdin/stdout. Compatible with the vast majority of community MCP servers (e.g., `npx -y @modelcontextprotocol/server-filesystem`). | Desktop only |
| **SSE** | HTTP with Server-Sent Events for server-to-client streaming. | All platforms |
| **Streamable HTTP** | HTTP POST for requests with optional SSE for streaming responses. The current MCP standard. | All platforms |

## Configuration

Register and manage servers in **Settings → Notor → MCP servers**. Each server has:

- **Name** — slug format: `[a-z0-9-]`
- **Transport type** — stdio, SSE, or Streamable HTTP
- **Connection parameters** — command/args/working directory (stdio) or URL/headers (HTTP)
- **Optional per-tool overrides** — read/write classification and auto-approve per tool

Configuration is persisted in plugin settings; no separate config file.

> **Trust warning:** A prominent non-dismissible warning is shown each time a new server is added. An additional warning appears for stdio servers noting that a local process will be spawned with your system permissions.

## Tool discovery

After connecting, Notor queries the server for its available tools and input schemas. Discovered tools are registered in the unified tool registry alongside built-in tools. The AI sees and invokes MCP tools the same way as built-in tools — no special prompting required.

**Namespaced tool names** — MCP tools are registered as `{serverName}__{toolName}` (e.g., `filesystem__read_file`) to prevent collisions with built-in tools or tools from other servers. The chat UI displays the friendlier `server/tool` format for readability.

MCP tools appear alongside built-in tools in the unified **Settings → Notor → Tools** section with per-tool Enabled and Auto-approve toggles and a status dot showing server health. Per-context overrides via `<notor_tool_config>` blocks use the `server__tool` naming convention. See [Per-context tool configuration](vault-tools.md#per-context-tool-configuration).

### Wildcard tool configuration

Use `serverName__*` in `<notor_tool_config>` blocks to set defaults for all tools from a given MCP server at once. Individual tool entries override the wildcard for that specific tool.

```yaml
filesystem__*:
  enabled: true
  auto_approve: false
filesystem__read_file:
  auto_approve: true
```

In this example, all `filesystem` tools are enabled with approval required, except `read_file` which is auto-approved.

## Plan/Act enforcement and approval

MCP tool calls go through the same pipeline as built-in tools:

1. Plan/Act enforcement (write-classified tools are blocked in Plan mode)
2. Auto-approve check
3. Approval UI (if not auto-approved)
4. Execution
5. Result display inline in the chat

**Read/write classification** — each MCP tool is classified as read-only or write. The default is derived from the server-reported `ToolAnnotations.readOnlyHint`; you can override the classification per tool in Settings. Write-classified MCP tools are blocked in Plan mode; read-only tools are allowed.

**Plan/Act state signaling** — on every `tools/call` request, Notor includes `_meta: { notor_mode: "plan" | "act" }` so cooperative servers can make their own decisions about write-type actions. Notor's own Plan/Act enforcement is always the hard gate.

**Per-tool auto-approve** — newly discovered MCP tools default to requiring manual approval. Auto-approve can be enabled per tool in Settings. [Per-persona auto-approve overrides](personas.md) extend to MCP tools alongside built-in tools.

## Sensitive credential storage

stdio environment variables and HTTP headers (e.g., `Authorization`) can be individually marked "sensitive" via a toggle in Settings. Sensitive values are stored in Obsidian's secrets manager (OS-level encrypted storage); non-sensitive values are stored in plain-text settings.

## Connection lifecycle

- Servers connect asynchronously after plugin load without blocking startup.
- Connection status per server: Connecting → Connected / Error.
- **Sleep/wake recovery** — Notor detects system sleep (laptop lid close, etc.) via a heartbeat timer. If a gap exceeding 60 seconds is detected, disconnected or errored servers are automatically reconnected after a short stabilization delay.
- stdio servers require a manual toggle off/on to reconnect after other crashes (non-sleep disconnections).
- HTTP transport servers auto-reconnect with exponential backoff.
- Cleanup (process termination, connection close) is registered via Obsidian's plugin lifecycle helpers.

## MCP status indicator

An icon in the chat panel header (visible only when ≥1 server is configured) shows at-a-glance health. Clicking it opens a popover listing all servers with status dots:

- Green = connected
- Yellow = connecting
- Grey = disconnected
- Red = error

Enable/disable toggles are available in the popover — no need to open Obsidian Settings just to restart a server.

## Failure isolation

A single server crashing, timing out, or disconnecting does not affect built-in tools, other MCP servers, or the active conversation. Errors are returned to the LLM as tool results, not swallowed.
