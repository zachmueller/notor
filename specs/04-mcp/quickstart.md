# Quickstart: Phase 4.1 — Custom MCP Servers

**Created:** 2026-09-03
**Updated:** 2026-10-03 (post-implementation)
**Specification:** [specs/04-mcp/spec.md](spec.md)
**Plan:** [specs/04-mcp/plan.md](plan.md)

---

## Prerequisites

- Node.js 18+ (LTS)
- npm (included with Node.js)
- Existing Notor development environment set up (Phases 0–4 built and working)
- An Obsidian vault with the Notor plugin installed for manual testing

---

## New Dependency

Phase 4.1 adds one new npm dependency:

```bash
npm install @modelcontextprotocol/sdk
```

This installs the official MCP TypeScript SDK (client transports, JSON-RPC protocol handling, schema validators). The package is pure TypeScript/JavaScript with no native modules.

**esbuild note:** The SDK must be **bundled** into `main.js` (not externalized). Verify that `@modelcontextprotocol/sdk` is NOT listed in the `external` array in `esbuild.config.mjs`. Node.js built-in modules (`child_process`, `net`, etc.) remain external — they resolve from Electron's runtime.

**Tree-shaking note:** Import from specific sub-paths (e.g., `@modelcontextprotocol/sdk/client/stdio.js`, `@modelcontextprotocol/sdk/client/sse.js`) rather than the root package. This ensures server-side SDK code (express, hono, cors) is tree-shaken out of the bundle.

---

## New Source Files

Phase 4.1 introduces a new `src/mcp/` module:

```
src/mcp/
  mcp-types.ts          # TypeScript interfaces (McpServerConfig, McpConnection, McpDiscoveredTool, etc.)
  mcp-hub.ts            # Central connection manager (connect, disconnect, tool discovery, callTool)
  mcp-tool-adapter.ts   # McpRegisteredTool — adapts MCP tools to Notor's Tool interface
  mcp-tool-handler.ts   # Tool execution handler (callTool with _meta injection, result extraction)

src/settings/sections/
  mcp-servers.ts        # Settings UI section for MCP server management
```

---

## Modified Source Files

| File | Change |
|---|---|
| `src/main.ts` | Initialize `McpHub` on load via `_initMcpHub()`; register cleanup via `this.register()` on unload |
| `src/settings/types.ts` | Add `mcp_servers: Record<string, McpServerConfig>` to `NotorSettings` |
| `src/settings/defaults.ts` | Add default `mcp_servers: {}` |
| `src/settings/settings-tab.ts` | Add MCP servers section |
| `src/tools/index.ts` | Add `unregister(name)` to `ToolRegistry` for dynamic MCP tool removal |
| `src/chat/dispatcher.ts` | Recognize MCP tool names (`__` separator); route through MCP handler; `unregisterTool(name)` |
| `src/chat/orchestrator.ts` | Includes MCP tools via `getToolDefinitions()` callback — no changes required |
| `src/ui/chat-view.ts` | Add MCP status indicator; display MCP tool names with `server/tool` format |
| `src/ui/tool-call-ui.ts` | `formatToolDisplayName()` converts `server__tool` → `server/tool` for display |
| `src/personas/auto-approve-resolver.ts` | Include MCP tools in persona auto-approve UI |
| `styles.css` | Add styles for MCP status indicator, popover, trust warnings, tool list |

---

## Development Workflow

### Build and Watch

```bash
npm run dev
```

This starts esbuild in watch mode. Changes to `src/mcp/*.ts` and other files are automatically recompiled.

### Production Build

```bash
npm run build
```

Verify the output `main.js` includes the MCP SDK code and the bundle size is within acceptable limits (see [research.md — R-2](research.md#r-2-mcp-sdk-bundle-size-impact)).

### Bundle Size Check

Before and after adding the MCP SDK, measure the bundle size:

```bash
# Record pre-SDK size
ls -la main.js
gzip -c main.js | wc -c

# After adding SDK and building
npm run build
ls -la main.js
gzip -c main.js | wc -c
```

Target: ≤ 200 KB gzipped increase (actual observed: ~166 KB per R-2).

---

## Installation into Vault

After building, copy the release artifacts to your test vault:

```bash
# Replace <vault-path> with the path to your Obsidian vault
cp main.js manifest.json styles.css "<vault-path>/.obsidian/plugins/notor/"
```

Then reload Obsidian and re-enable the plugin under **Settings → Community plugins**.

---

## Manual Testing

### Testing with a stdio MCP Server

The `@modelcontextprotocol/server-filesystem` is a simple community MCP server useful for testing:

```bash
# Create a temp directory for the filesystem server to access
mkdir -p /tmp/mcp-test-dir

# Verify the server runs standalone before adding it to Notor
npx -y @modelcontextprotocol/server-filesystem /tmp/mcp-test-dir
# Should print: "Filesystem MCP Server running on stdio"
# Press Ctrl+C to stop
```

To add this server in Notor:
1. Open **Settings → Notor → MCP servers**
2. Click **Add server**
3. Configure:
   - **Name:** `filesystem`
   - **Transport:** `stdio`
   - **Command:** `npx`
   - **Arguments:** `-y @modelcontextprotocol/server-filesystem /tmp/mcp-test-dir`
4. Save — the server connects automatically
5. Verify status dot turns green ("Connected")
6. Expand the server entry to see discovered tools (e.g., `read_file`, `write_file`, `list_directory`)

> **Gotcha:** Obsidian launches stdio processes with a restricted PATH. If `npx` is not found, use its absolute path (e.g., `/usr/local/bin/npx` on macOS with Homebrew, or `/Users/<you>/.nvm/versions/node/<version>/bin/npx` with nvm). You can find the path by running `which npx` in your terminal.

> **Gotcha (nvm):** If you use nvm, the `npx` binary path changes with each Node version switch. Consider using an absolute path to the filesystem server script instead of relying on `npx`.

### Testing with an HTTP MCP Server

For Streamable HTTP testing, use any publicly available MCP server or run one locally:

```bash
# Example: run a local HTTP MCP server (replace with an actual HTTP MCP server)
# Refer to the MCP server's own documentation for startup instructions
```

To add an HTTP server in Notor:
1. Open **Settings → Notor → MCP servers**
2. Click **Add server**
3. Configure:
   - **Transport:** `streamableHttp` or `sse`
   - **URL:** the server's endpoint URL
   - **Headers:** add `Authorization: Bearer <token>` if required (mark as **Sensitive** to store in SecretStorage)
4. Save and verify connection status

### Key Test Scenarios

| Scenario | How to Test | Expected Result |
|---|---|---|
| stdio server connects | Add filesystem server with valid command | Green status dot, tools appear in server detail |
| HTTP server connects | Add server with valid URL | Green status dot, tools appear |
| Tool discovery | Expand server in settings | Tools listed with name, description, classification |
| Tool invocation | Ask AI to list files or read a file | Approval UI → approve → result returned to LLM |
| Plan/Act enforcement | Set tool classification to "Write" → switch to Plan mode → ask AI to use it | AI receives rejection error message |
| `_meta.notor_mode` signaling | Inspect logs or MCP server logs | `_meta: { notor_mode: "act" }` present on every `tools/call` |
| Auto-approve | Enable auto-approve for a specific tool in server settings | Tool executes without approval prompt |
| Persona override | Configure persona auto-approve with MCP tool override | Persona override takes precedence over server setting |
| Server disconnect | Kill the stdio process externally (`kill <pid>`) | Status turns grey ("Disconnected") |
| Server reconnect | Toggle server off then on in Settings or chat panel popover | Reconnects, tools re-registered |
| HTTP reconnect | Stop HTTP server → wait → restart | Auto-reconnects with exponential backoff |
| Timeout handling | Set timeout to `1` second → invoke slow tool | Error ToolResult returned; connection stays open |
| Mobile guard | Test on mobile or mock `Platform.isDesktopApp = false` | stdio option hidden or shows informational message |
| Chat panel MCP status | Configure ≥1 server | Status indicator appears in chat panel header |
| Status popover | Click status indicator | Popover lists servers with status dots and toggles |
| Sensitive credentials | Add env var with "Sensitive" toggle | Value stored in SecretStorage, not in `data.json` |
| Trust warnings | Click "Add server" | Trust warning banner displayed (non-dismissible) |
| stdio trust warning | Select `stdio` transport | Additional stdio-specific process spawn warning shown |
| Tool name display | Invoke MCP tool via AI | Chat UI shows `server/tool` format (not `server__tool`) |

---

## Sensitive Credential Storage

Sensitive environment variables and HTTP headers are stored in **Obsidian's SecretStorage** (OS-level encrypted storage), not in the plugin's `data.json`.

**Key format:**
- Environment variables: `mcp_env_{serverName}_{key}` (e.g., `mcp_env_my-server_API_KEY`)
- HTTP headers: `mcp_header_{serverName}_{key}` (e.g., `mcp_header_my-server_Authorization`)

In the settings JSON (`data.json`), sensitive fields are stored as empty strings `""` as placeholders. The actual values are resolved from SecretStorage at connection time.

> **Note on the current SecretStorage implementation:** Phase 4.1 uses `app.loadLocalStorage()` as a compatibility shim. This is a known limitation — a future release should migrate to Obsidian's native `SecretStorage` API once it is more broadly available in community plugin builds.

---

## Debugging

### MCP Protocol Debugging

The MCP SDK communicates via JSON-RPC. To debug protocol messages:

- **stdio**: the SDK writes to the process's stdin and reads from stdout. The child process's stderr is captured by `McpHub` and forwarded to the Notor logger. Check Obsidian developer tools console (`Ctrl+Shift+I` / `Cmd+Option+I`) and filter for `[McpHub]`.
- **HTTP**: the browser developer tools Network tab (in Electron: **View → Toggle Developer Tools → Network**) can inspect SSE event streams and HTTP POST requests.
- **Tool call logging**: every `callTool()` invocation is logged with server name, tool name, and result status. Filter console for `[McpHub]` to see all MCP activity.

### Server Name Validation

Server names must match `[a-z0-9][a-z0-9-]*` (max 50 characters). The settings UI auto-slugifies names on input (trims, lowercases, replaces spaces with hyphens). Names must be unique across all configured servers.

### Common Issues

| Issue | Likely Cause | Fix |
|---|---|---|
| "command not found" on stdio | Command not in PATH when launched from Obsidian | Use an absolute path (find it with `which <command>` in your terminal) |
| stdio server spawns but handshake times out | Server writing non-JSON-RPC output to stdout on startup | Redirect startup logs to stderr in the server. Check if the server requires additional setup steps. |
| HTTP connection refused | Server not running or wrong URL | Verify URL and that the server is running. Check for CORS issues in the developer tools console. |
| Tools not appearing after connection | `tools/list` failed silently | Check the console for `[McpHub]` warnings. Use the **Refresh tools** button in the server settings. |
| Bundle size too large | MCP SDK server-side code not tree-shaken | Ensure imports are from specific sub-paths (e.g., `@modelcontextprotocol/sdk/client/stdio.js`), not the root package. |
| MCP tools not appearing in chat | Tools registered but dispatcher not updated | Check that `_toolDispatcher` is initialized before `_initMcpHub()` fires its first status change. In practice this is safe because `_initMcpHub()` only calls the status change listener when `_toolRegistry` and `_toolDispatcher` are both non-null. |
| Sensitive value not loaded in settings UI | SecretStorage key mismatch | Verify the key format: `mcp_env_{serverName}_{varKey}` — server name is the slug, not the display name. |
| stdio server not available on mobile | Expected behavior | MCP stdio transport is guarded behind `Platform.isDesktopApp`. The setting UI hides or disables the option on mobile. |

---

## Architecture Reference

- **Data model:** [data-model.md](data-model.md) — all entity definitions and relationships
- **Tool dispatch contract:** [contracts/mcp-tool-dispatch.md](contracts/mcp-tool-dispatch.md) — dispatch pipeline, `_meta` injection, error handling
- **Connection lifecycle contract:** [contracts/mcp-connection-lifecycle.md](contracts/mcp-connection-lifecycle.md) — McpHub interface, transport behavior, reconnection
- **Research findings:** [design/research/mcp-server-integration.md](../../design/research/mcp-server-integration.md) — comprehensive research output
- **Architecture overview:** [design/architecture.md](../../design/architecture.md#mcp-subsystem-phase-41) — MCP subsystem in the broader plugin architecture
- **Tool classification:** [design/tools.md](../../design/tools.md#mcp-tool-classification-and-planact-awareness) — read/write classification, Plan/Act enforcement
