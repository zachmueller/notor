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
- **Connection parameters** — command/args/working directory/environment variables (stdio) or URL/headers/[headers helper](#dynamic-headers-headershelper) (HTTP)
- **Optional per-tool overrides** — read/write classification and auto-approve per tool

The **Add server** form collects the connection parameters up front, so a server that needs an API key in its environment (or an `Authorization` header) connects on the first attempt instead of failing and needing an edit. Everything remains editable afterwards by expanding the server's entry in the list.

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

stdio environment variables and HTTP headers (e.g., `Authorization`) can be individually marked "sensitive" via a toggle in Settings — both when adding a server and when editing one later.

Sensitive values are written to Obsidian's secret storage, the same OS-level encrypted store (macOS Keychain / Windows DPAPI / Linux libsecret) used for provider API keys. You can see the stored entries under **Settings → Keychain**, listed as `notor-mcp-env-…` and `notor-mcp-header-…`. Plugin settings keep only an empty placeholder for the value, so the credential never lands in `data.json` — a sensitive row whose value is already stored shows "Stored in keychain" in place of the masked field. Non-sensitive values are stored as plain text in plugin settings.

Removing a server also removes its stored credentials. Values saved by earlier versions of Notor (which kept them unencrypted in the vault's local storage) are migrated into the encrypted store the first time the server connects, and the plaintext copy is deleted.

## Dynamic headers (`headersHelper`)

Some HTTP servers sit behind a login proxy (an OIDC load balancer, oauth2-proxy, Cloudflare Access, IAP, …). They need a bearer token plus a session cookie that expires after a few hours, which fixed headers can't keep up with. For these, set **Headers helper** on the server, either when adding it or later. It takes a shell command that prints the headers to send. Notor runs it on the desktop app only. The contract matches Claude Code's `headersHelper`, so a helper written for Claude Code works unchanged.

**Output contract** — the command must print exactly one JSON object whose values are all strings:

```json
{"Authorization": "Bearer test-token", "Cookie": "_proxy_session=test-token"}
```

Anything else counts as an error: empty output, invalid JSON, an array, or a non-string value. The connection fails with a message that may include an excerpt of the helper's **stderr**. Its stdout, which holds the credentials, is never shown, logged, or saved.

**How it runs**

- In your shell (`$SHELL -c …`) with your login `PATH`, in the vault root, with a 10-second timeout.
- With these environment variables set, so one script can serve several servers or check it's talking to the right one:
  - `CLAUDE_CODE_MCP_SERVER_NAME` (also `NOTOR_MCP_SERVER_NAME`): the server's name;
  - `CLAUDE_CODE_MCP_SERVER_URL` (also `NOTOR_MCP_SERVER_URL`): the server's URL.
- On every connect and reconnect. Notor doesn't cache the result. Caching or renewing credentials between runs is the helper's job.

**Precedence** — helper headers are added on top of the fixed **Headers** list. When both set the same header name, the helper's value wins.

**Expired sessions** — the server might answer with `401`/`403`, or redirect to a sign-in page on another origin. When that happens, Notor re-runs the helper and retries the request once. If that still fails, the server shows an error and goes into the usual automatic reconnect, which runs the helper again on each attempt.

**Test helper** runs the helper once and lists the header **names** it returned, which is a quick way to check the script without connecting.

Example helper for a server at `https://mcp.example.com/mcp`. Here `my-login-tool` stands in for whatever CLI signs you in to your proxy and prints a fresh cookie:

```sh
#!/bin/sh
set -e
[ "$CLAUDE_CODE_MCP_SERVER_URL" = "https://mcp.example.com/mcp" ] || { echo "unexpected server" >&2; exit 1; }
token=$(cat "$HOME/.config/example/token")
cookie=$(my-login-tool session-cookie --host mcp.example.com)
printf '{"Authorization":"Bearer %s","Cookie":"_proxy_session=%s"}' "$token" "$cookie"
```

The command string itself is stored in plugin settings like a stdio server's command, so keep secrets out of it: read them from a file or keychain inside the script instead. For servers with a headers helper (or a fixed `Cookie` header), desktop Notor sends requests from its Node runtime rather than the app's web view, because the web view silently drops `Cookie` headers. These requests don't use the system proxy settings or the OS certificate store.

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
