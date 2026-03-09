# Quickstart: Phase 4.1 — Custom MCP Servers

**Created:** 2026-09-03
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
| `src/main.ts` | Initialize `McpHub` on load; register cleanup on unload |
| `src/settings/types.ts` | Add `mcp_servers: Record<string, McpServerConfig>` to `NotorSettings` |
| `src/settings/defaults.ts` | Add default `mcp_servers: {}` |
| `src/settings/settings-tab.ts` | Add MCP servers section |
| `src/tools/index.ts` | Support dynamic MCP tool registration/unregistration |
| `src/chat/dispatcher.ts` | Recognize MCP tool names (`__` separator); route through MCP handler |
| `src/chat/orchestrator.ts` | Include MCP tools in `getToolDefinitions()` callback |
| `src/ui/chat-view.ts` | Add MCP status indicator; display MCP tool names with `server/tool` format |
| `src/personas/auto-approve-resolver.ts` | Include MCP tools in persona auto-approve UI |
| `styles.css` | Add styles for MCP status indicator, popover, and trust warnings |

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

Target: ≤ 150 KB gzipped increase.

---

## Manual Testing

### Testing with a stdio MCP Server

The `@modelcontextprotocol/server-filesystem` is a simple community MCP server useful for testing:

```bash
# Ensure npx is available (comes with npm)
npx -y @modelcontextprotocol/server-filesystem /tmp/test-dir
```

To test in Notor:
1. Open **Settings → Notor → MCP servers**
2. Click "Add server"
3. Configure:
   - Name: `filesystem`
   - Transport: `stdio`
   - Command: `npx`
   - Arguments: `-y @modelcontextprotocol/server-filesystem /tmp/test-dir`
4. Save and verify status shows "Connected"
5. Verify tools are discovered (e.g., `read_file`, `write_file`, `list_directory`)
6. Start a conversation and ask the AI to use the filesystem tools

### Testing with an HTTP MCP Server

For Streamable HTTP testing, use any publicly available MCP server or run one locally:

```bash
# Example: run a local HTTP MCP server (if one is available)
# Replace with an actual HTTP MCP server endpoint for testing
```

To test in Notor:
1. Add a server with transport type `streamableHttp`
2. Enter the server URL
3. Add any required headers (e.g., `Authorization: Bearer <token>`)
4. Verify connection and tool discovery

### Key Test Scenarios

| Scenario | How to Test |
|---|---|
| stdio server connects | Add filesystem server → verify "Connected" status |
| Tool discovery | Verify discovered tools appear in settings → tools sub-section |
| Tool invocation | Ask AI to use an MCP tool → verify approval UI → approve → verify result |
| Plan/Act enforcement | Set tool to "Write" → switch to Plan mode → verify AI gets rejection error |
| Auto-approve | Enable auto-approve for a tool → verify no approval prompt on invocation |
| Server disconnect | Kill the MCP server process externally → verify "Disconnected" status |
| Server reconnect | Toggle server off and back on → verify reconnection and tool re-discovery |
| Timeout handling | Set a very short timeout (1s) → invoke a slow tool → verify timeout error |
| Mobile guard | Test on mobile (or mock `Platform.isDesktopApp = false`) → verify stdio option hidden |
| Chat panel MCP status | Verify indicator appears when ≥1 server configured; verify popover shows status |
| Trust warnings | Add a new server → verify trust warning appears |

---

## Debugging

### MCP Protocol Debugging

The MCP SDK communicates via JSON-RPC. To debug protocol messages:

- **stdio**: the SDK writes to the process's stdin and reads from stdout. stderr is captured for logging. Add logging in `McpHub` around `client.request()` calls.
- **HTTP**: browser developer tools (Network tab) can inspect SSE and HTTP requests when running in Electron's renderer process.

### Common Issues

| Issue | Likely Cause | Fix |
|---|---|---|
| "command not found" error on stdio | The command is not in PATH when launched from Obsidian | Ensure the command is an absolute path, or that the shell environment includes the necessary PATH entries. Check `process.env.PATH`. |
| stdio server spawns but handshake times out | Server isn't writing to stdout, or is writing non-JSON-RPC output | Check the server's stdout output. Some servers print startup messages that aren't JSON-RPC. |
| HTTP connection refused | Server not running or wrong URL | Verify the URL is correct and the server is accessible. Check for CORS issues. |
| Tools not appearing after connection | `tools/list` failed silently | Check the server's tool list response. Use "Refresh tools" button in Settings. |
| Bundle size too large | MCP SDK server-side code not tree-shaken | Ensure imports are from specific sub-paths (e.g., `@modelcontextprotocol/sdk/client/stdio.js`), not the root package. |

---

## Architecture Reference

- **Data model:** [data-model.md](data-model.md) — all entity definitions and relationships
- **Tool dispatch contract:** [contracts/mcp-tool-dispatch.md](contracts/mcp-tool-dispatch.md) — dispatch pipeline, `_meta` injection, error handling
- **Connection lifecycle contract:** [contracts/mcp-connection-lifecycle.md](contracts/mcp-connection-lifecycle.md) — McpHub interface, transport behavior, reconnection
- **Research findings:** [design/research/mcp-server-integration.md](../../design/research/mcp-server-integration.md) — comprehensive research output
