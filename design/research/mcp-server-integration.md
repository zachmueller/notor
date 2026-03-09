# MCP Server Integration from Obsidian Plugins — Research Findings

**Completed:** 2026-09-03
**Covers:** Pre-Phase 4.1 research tasks — MCP server integration and Plan/Act state signaling
**Sources:** [MCP specification (2025-06-18)](https://spec.modelcontextprotocol.io/specification/2025-06-18/), [@modelcontextprotocol/sdk v1.25+](https://github.com/modelcontextprotocol/typescript-sdk), [Cline VS Code extension source](https://github.com/cline/cline), Notor codebase analysis

---

## 1. MCP Protocol Overview

The Model Context Protocol (MCP) defines a client-server architecture where a **host application** (Notor/Obsidian) runs an MCP **client** that connects to one or more MCP **servers**. Each server exposes tools, resources, and prompts that the client can discover and invoke.

### Protocol Stack

- **Wire format:** JSON-RPC 2.0
- **Schema version:** `2025-06-18` (current as of this research)
- **Lifecycle:** `initialize` handshake → capability negotiation → operational requests → `close`
- **SDK:** `@modelcontextprotocol/sdk` (TypeScript) — provides `Client`, transport classes, and schema validators

### Core Interactions for Notor

| MCP Method | Purpose | Notor Use |
|---|---|---|
| `initialize` | Handshake — exchange capabilities and client/server info | On server connection |
| `tools/list` | Discover available tools and their JSON schemas | Schema discovery for AI |
| `tools/call` | Invoke a specific tool with arguments | Tool dispatch |
| `resources/list` | List available resources | Future: resource access |
| `resources/read` | Read a specific resource by URI | Future: resource access |

---

## 2. Transport Mechanisms

The MCP spec defines three transport types. All are relevant for Notor.

### 2.1 stdio (Standard I/O)

The client spawns a local process and communicates via stdin/stdout using newline-delimited JSON-RPC.

**How it works:**
1. Client spawns a child process using a configured `command` + `args`
2. Client writes JSON-RPC messages to the process's stdin
3. Server writes JSON-RPC responses to stdout
4. Server stderr is captured for logging/diagnostics

**Configuration shape** (from Cline's schema):
```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
  "cwd": "/optional/working/directory",
  "env": { "ADDITIONAL_ENV_VAR": "value" }
}
```

**SDK class:** `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio.js`

**Key implementation details from Cline:**
- Uses `getDefaultEnvironment()` from the SDK to populate base env vars, then merges user-configured `env` overrides
- Captures stderr via `transport.stderr` stream for error logging
- Monitors the child process for exit/error events and surfaces connection status in the UI

**Relevance for Obsidian:** This is the most common MCP server type (most community MCP servers are stdio-based). It requires `child_process.spawn()`, which Notor already uses successfully for `execute_command` (see `src/shell/shell-executor.ts`). Desktop-only.

### 2.2 HTTP/SSE (Server-Sent Events) — Legacy

The client connects to a remote HTTP endpoint that uses Server-Sent Events for server-to-client streaming.

**Configuration shape:**
```json
{
  "type": "sse",
  "url": "https://mcp-server.example.com/sse",
  "headers": { "Authorization": "Bearer <token>" }
}
```

**SDK class:** `SSEClientTransport` from `@modelcontextprotocol/sdk/client/sse.js`

**Relevance for Obsidian:** Works via standard HTTP — no Node.js-specific APIs required beyond `fetch` and `EventSource`. Compatible with both desktop and mobile Obsidian. This transport is considered legacy in favor of Streamable HTTP but is still widely used.

### 2.3 Streamable HTTP (Current Standard)

The newer HTTP-based transport that replaces SSE. Uses standard HTTP POST for requests and optional SSE for streaming responses.

**Configuration shape:**
```json
{
  "type": "streamableHttp",
  "url": "https://mcp-server.example.com/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

**SDK class:** `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js`

**Key implementation detail from Cline:** Includes a compatibility shim that maps 404 responses to 405 for GET requests, because many servers incorrectly return 404 instead of 405 when they don't support SSE streaming on the GET endpoint.

**Relevance for Obsidian:** Same as SSE — HTTP-based, works on all platforms.

### Transport Summary for Notor

| Transport | Desktop | Mobile | Auth | Use Case |
|---|---|---|---|---|
| **stdio** | ✅ | ❌ | N/A (local process) | Local MCP servers (most common) |
| **SSE** | ✅ | ✅ | Headers / OAuth | Remote MCP servers (legacy) |
| **Streamable HTTP** | ✅ | ✅ | Headers / OAuth | Remote MCP servers (current) |

**Recommendation:** Support all three transports. stdio is essential for the majority of MCP servers. HTTP transports enable remote/cloud MCP servers and mobile compatibility.

---

## 3. Electron/Node.js Constraints in Obsidian

### 3.1 Node.js API Access

Obsidian desktop runs in Electron, which provides full Node.js API access. Notor's esbuild config confirms this:

- **Platform target:** `platform: "node"` — the bundle targets Node.js
- **Built-in modules are external:** `...builtinModules` — Node built-ins (`child_process`, `fs`, `net`, `http`, etc.) are not bundled; they resolve from Electron's Node.js runtime
- **Proven precedent:** Notor already uses `child_process.spawn()` in `src/shell/shell-executor.ts` for shell command execution

This means Notor can use the MCP SDK's `StdioClientTransport` (which uses `child_process.spawn` internally) without any compatibility issues on desktop.

### 3.2 Mobile Constraints

On mobile (iOS/Android), Obsidian does not provide Node.js APIs. Key restrictions:

- **No `child_process`:** Cannot spawn local processes → stdio transport is unavailable
- **No `fs` module:** Cannot access the filesystem directly (Obsidian provides vault API instead)
- **HTTP works:** `fetch()` and `EventSource` are available → HTTP/SSE transports work

**Impact:** stdio MCP servers are desktop-only. HTTP-based MCP servers work on all platforms. This aligns with Notor's existing pattern — `execute_command` is already desktop-only (`Platform.isDesktopApp` guard).

### 3.3 Process Management Considerations

When spawning stdio MCP server processes from an Obsidian plugin:

| Concern | Details | Mitigation |
|---|---|---|
| **Process lifecycle** | Child processes must be terminated when the plugin unloads | Use `this.register()` to register cleanup in `onunload()` |
| **Zombie processes** | If Obsidian crashes, child processes may linger | SIGTERM on close + SIGKILL after grace period (same pattern as shell executor) |
| **Resource consumption** | Each stdio server is a separate OS process | Document this in settings UI; limit concurrent connections |
| **Working directory** | MCP servers may need a specific `cwd` | Configurable per-server, default to vault root |
| **Environment variables** | Servers may need PATH, API keys, etc. | Merge `process.env` with user-configured env vars |
| **Shell resolution** | The `command` may require shell PATH resolution | Use the SDK's `getDefaultEnvironment()` which captures the current shell environment |

### 3.4 Bundle Size Impact

The `@modelcontextprotocol/sdk` package needs to be bundled into Notor's `main.js`. Key considerations:

- The SDK is pure TypeScript/JavaScript — no native modules
- Notor already bundles substantial dependencies (AWS SDK, Turndown)
- The SDK's client-side code (transports + protocol handling) is relatively lightweight
- Tree-shaking via esbuild should eliminate unused server-side SDK code

**Recommendation:** Add `@modelcontextprotocol/sdk` as a direct dependency. The bundle size impact should be modest compared to existing dependencies.

---

## 4. Implementation Architecture — Lessons from Cline

Cline's MCP implementation provides a well-tested reference architecture for a client-side MCP integration in an Electron app. Key patterns worth adopting or adapting:

### 4.1 McpHub — Central Connection Manager

Cline uses a singleton `McpHub` class that manages all MCP server connections:

**Responsibilities:**
- Reads server configuration from a JSON settings file
- Maintains an array of `McpConnection` objects (one per server)
- Handles connect/disconnect/reconnect lifecycle for each server
- Fetches tool/resource/prompt lists after connection
- Watches the settings file for changes and hot-reloads connections
- Provides `callTool()`, `readResource()`, `getPrompt()` methods
- Surfaces connection status (connected/connecting/disconnected/error)

**Key data structures:**
```typescript
type McpConnection = {
  server: McpServer;    // name, status, tools[], resources[], config
  client: Client;       // MCP SDK Client instance
  transport: Transport; // StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport
}
```

**Adaptation for Notor:** Notor should implement a similar `McpHub` (or `McpConnectionManager`) that:
- Stores configuration in plugin settings (via `loadData`/`saveData`), not a separate JSON file
- Registers cleanup handlers via `this.register()` for proper Obsidian lifecycle management
- Guards stdio transport behind `Platform.isDesktopApp`

### 4.2 Tool Discovery and Registration

After connecting to a server, Cline fetches the tool list via `tools/list` and stores it on the connection object:

```typescript
connection.server.tools = await this.fetchToolsList(name);
// Each tool has: { name, description, inputSchema, autoApprove }
```

Tools are then surfaced to the AI alongside built-in tools. Cline uses a naming convention to uniquely identify MCP tools:
```
{serverUid}{IDENTIFIER}{toolName}
// e.g.: "c5x2k0mcp0quick_query"
```

The `CLINE_MCP_TOOL_IDENTIFIER` (`"0mcp0"`) separator allows the dispatcher to split the tool name back into server + tool.

**Adaptation for Notor:** Notor should use a similar approach for native tool calling. The tool dispatcher should:
1. Maintain a unified tool registry (built-in + MCP tools)
2. Use a naming convention or lookup table to route MCP tool calls to the correct server
3. Present MCP tools with the same schema format as built-in tools so the AI treats them identically

### 4.3 Tool Invocation

Cline's `McpHub.callTool()` method sends the standard MCP `tools/call` request:

```typescript
const result = await connection.client.request(
  {
    method: "tools/call",
    params: {
      name: toolName,
      arguments: toolArguments,  // Record<string, unknown>
    },
  },
  CallToolResultSchema,
  { timeout }
);
```

**Key observation:** Cline does **not** pass any additional metadata (Plan/Act mode, auto-approve state, etc.) to MCP servers during tool invocation. The tool call uses the standard MCP schema with only `name` and `arguments`.

### 4.4 Uniform Dispatch Pipeline

Cline routes MCP tool calls through the same dispatch pipeline as built-in tools:
1. Tool call is parsed from the LLM response
2. MCP tool names are normalized (split on `CLINE_MCP_TOOL_IDENTIFIER` → extract server + tool)
3. Routed to `UseMcpToolHandler` which handles approval flow
4. Auto-approve is checked (both global and per-tool settings from MCP config)
5. If not auto-approved, user approval UI is shown
6. On approval, `McpHub.callTool()` is invoked
7. Result is formatted and returned to the LLM

**Adaptation for Notor:** Notor's existing tool dispatch pipeline (Plan/Act check → auto-approve check → approval UI → execution → result) can be extended to handle MCP tools with minimal changes:
- Add MCP tools to the tool registry during discovery
- Route MCP tool calls to a generic `McpToolHandler` that delegates to `McpHub.callTool()`
- Apply the same Plan/Act enforcement based on per-tool read/write classification in Notor's config

---

## 5. MCP Server Configuration Design

### 5.1 Settings Storage

Unlike Cline (which stores MCP config in a separate `cline_mcp_settings.json` file), Notor should store MCP server configuration within its standard plugin settings (`data.json` via `loadData`/`saveData`). This is simpler and consistent with how all other Notor settings are managed.

**Proposed config structure:**
```typescript
interface McpServerConfig {
  /** Display name for the server */
  name: string;
  /** Transport type */
  type: "stdio" | "sse" | "streamableHttp";
  /** For stdio: command to spawn */
  command?: string;
  /** For stdio: command arguments */
  args?: string[];
  /** For stdio: working directory */
  cwd?: string;
  /** For stdio: additional environment variables */
  env?: Record<string, string>;
  /** For HTTP transports: server URL */
  url?: string;
  /** For HTTP transports: custom headers */
  headers?: Record<string, string>;
  /** Whether the server is disabled */
  disabled?: boolean;
  /** Per-tool read/write classification overrides */
  toolClassifications?: Record<string, "read" | "write">;
  /** Per-tool auto-approve overrides */
  autoApprove?: string[];
  /** Request timeout in seconds */
  timeout?: number;
}

// In NotorSettings:
interface NotorSettings {
  // ... existing settings ...
  mcpServers: Record<string, McpServerConfig>;
}
```

### 5.2 Settings UI

The MCP server configuration UI in **Settings → Notor** should provide:

1. **Server list:** List of configured servers with status indicators (connected/disconnected/error)
2. **Add server:** Form to add a new server (transport type selector, command/URL fields)
3. **Per-server settings:** Enable/disable toggle, timeout, tool classifications
4. **Tool list:** After connection, show discovered tools with:
   - Name and description
   - Read/write classification selector (default based on `ToolAnnotations.readOnlyHint`)
   - Auto-approve toggle
5. **Trust warning:** Clear notice that custom MCP tools bypass built-in safety guarantees

---

## 6. Tool Schema Discovery

### 6.1 `tools/list` Response

When Notor queries a connected MCP server's tool list, each tool includes:

```typescript
interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: "object";
    properties: Record<string, JsonSchema>;
    required?: string[];
  };
  annotations?: ToolAnnotations;
}
```

### 6.2 ToolAnnotations — Read/Write Hints from Servers

The MCP spec (2025-06-18) defines `ToolAnnotations` on each tool definition:

| Annotation | Type | Default | Meaning |
|---|---|---|---|
| `readOnlyHint` | boolean | `false` | If `true`, the tool does not modify its environment |
| `destructiveHint` | boolean | `true` | If `true`, the tool may perform destructive updates (meaningful only when not read-only) |
| `idempotentHint` | boolean | `false` | If `true`, repeated calls with same args have no additional effect |
| `openWorldHint` | boolean | `true` | If `true`, the tool interacts with external entities |
| `title` | string | — | Human-readable display title |

**Important caveat from the spec:**
> "All properties in ToolAnnotations are **hints**. They are not guaranteed to provide a faithful description of tool behavior. Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers."

**Recommendation for Notor:**
- Use `readOnlyHint` as the **default** read/write classification when a tool is first discovered
- Allow the user to **override** the classification in Notor's settings (per-tool `toolClassifications`)
- The user override takes precedence over the server-reported hint
- Display a note in the settings UI explaining that server-reported hints are not verified

### 6.3 Surfacing MCP Tools to the AI

MCP tools should be presented to the AI in exactly the same format as built-in tools — the AI should not need to know or care whether a tool is built-in or MCP-provided. The tool description sent to the LLM should include:

- Tool name (prefixed or namespaced to avoid collisions with built-in tools)
- Description (from the MCP server)
- Input schema (JSON Schema for parameters)
- Read/write classification (for system prompt instructions about Plan/Act)

---

## 7. Plan/Act State Signaling to MCP Servers

This section addresses the second research task: how to communicate Notor's Plan/Act mode to MCP servers so they can make cooperative decisions about write-type actions.

### 7.1 Approaches Evaluated

#### Approach A: `_meta` Field on Tool Call Requests

The MCP spec defines a `_meta` field on the base `Request` type. Every request's `params` can include a `_meta` object with arbitrary additional properties (beyond the standard `progressToken`):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "write_file",
    "arguments": { "path": "notes/test.md", "content": "..." },
    "_meta": {
      "notor_mode": "plan"
    }
  }
}
```

**Pros:**
- Part of the MCP specification — `_meta` is a first-class protocol concept with `additionalProperties: {}` (any key-value pairs allowed)
- Sent per-invocation, so it always reflects the current mode at call time
- No special capability negotiation required
- The SDK's `Client.request()` method accepts a `params` object that can include `_meta`

**Cons:**
- MCP servers must explicitly look for and handle this field — most existing servers will ignore it
- The key name (`notor_mode`) is Notor-specific, not a standard MCP convention
- No established community convention for this use case yet

#### Approach B: Extra Tool Argument

Pass the mode as an additional field in the tool's `arguments`:

```json
{
  "method": "tools/call",
  "params": {
    "name": "write_file",
    "arguments": {
      "path": "notes/test.md",
      "content": "...",
      "_notor_mode": "plan"
    }
  }
}
```

**Pros:**
- Simple — no protocol-level changes needed

**Cons:**
- **Violates the tool's declared input schema** — the `_notor_mode` argument isn't in the tool's JSON Schema, which could cause validation errors on strict servers
- Pollutes the tool's business-domain arguments with client-side metadata
- The LLM would need to know about and include this argument, which is fragile

#### Approach C: Client Capabilities / Initialization Context

Communicate the mode during the `initialize` handshake via `clientInfo` or `capabilities.experimental`:

```json
{
  "method": "initialize",
  "params": {
    "capabilities": {
      "experimental": {
        "notor_plan_act": {
          "current_mode": "plan"
        }
      }
    },
    "clientInfo": { "name": "Notor", "version": "0.2.0" }
  }
}
```

**Pros:**
- Uses the MCP spec's `experimental` capabilities mechanism, which is designed for non-standard extensions
- Server can inspect client capabilities during initialization

**Cons:**
- **Mode is set at connection time, not invocation time** — Plan/Act mode changes during a conversation would require re-initialization or a separate notification
- Does not scale to per-call mode communication
- Most servers won't check for this during initialization

#### Approach D: Custom Notification

Send a `notifications/notor/mode_changed` notification when the mode changes:

**Pros:**
- Real-time updates without reconnection
- Uses MCP's notification mechanism

**Cons:**
- Non-standard notification method — servers would need to implement a custom handler
- Requires the server to maintain state about the current mode
- More complex than necessary for a simple binary signal

### 7.2 Recommendation: `_meta` on Tool Call Requests (Approach A)

**`_meta` is the recommended approach** for Plan/Act state signaling. Rationale:

1. **Protocol-compliant:** `_meta` is an explicit part of the MCP spec's `Request` type with `additionalProperties: {}`, meaning any key-value pairs are valid. This is not a hack or workaround — it's the spec's designated extension point for request metadata.

2. **Per-invocation:** The mode is communicated on each tool call, so it always reflects the current state. No reconnection or state synchronization needed when the user toggles Plan/Act mode.

3. **Ignorable by default:** Servers that don't understand `_meta.notor_mode` simply ignore it. There is no schema violation, no validation error, and no behavioral change. This is the correct trust model — cooperative, not enforced.

4. **SDK-compatible:** The MCP SDK's `Client.request()` method passes through the full `params` object, including `_meta`, without stripping or validating custom fields.

5. **Simple implementation:** Notor wraps its `McpHub.callTool()` to inject `_meta` before sending:

```typescript
async callTool(
  serverName: string,
  toolName: string,
  toolArguments: Record<string, unknown> | undefined,
  mode: "plan" | "act"
): Promise<McpToolCallResponse> {
  const connection = this.findConnection(serverName);
  return await connection.client.request(
    {
      method: "tools/call",
      params: {
        name: toolName,
        arguments: toolArguments,
        _meta: {
          notor_mode: mode,
        },
      },
    },
    CallToolResultSchema,
    { timeout }
  );
}
```

### 7.3 `_meta` Key Naming

Use `notor_mode` as the `_meta` key rather than a generic name like `mode` or `client_mode`:

- **Namespaced:** Avoids collisions with other MCP clients that might use `_meta` for their own purposes
- **Discoverable:** MCP server authors who want to support Notor's Plan/Act signal know exactly what to look for
- **Values:** `"plan"` or `"act"` — simple binary string, as specified in the roadmap

### 7.4 Future Considerations

If the MCP community establishes a standard convention for client mode signaling (e.g., a `readOnly` hint on tool call requests), Notor should adopt that standard in addition to or instead of the Notor-specific key. The `_meta` approach is forward-compatible — adding new keys or migrating to a standard key is non-breaking.

---

## 8. Process Lifecycle Management

### 8.1 Connection Lifecycle

```
Plugin onload() → Initialize McpHub → Read config → Connect to configured servers
                                                        ├── stdio: spawn process
                                                        ├── SSE: open EventSource
                                                        └── streamableHttp: HTTP POST

Plugin onunload() → McpHub.dispose() → Close all connections
                                          ├── stdio: close transport → kill process
                                          ├── SSE: close EventSource
                                          └── streamableHttp: close transport
```

### 8.2 Cleanup Registration

Using Obsidian's `this.register()` ensures cleanup happens even if the plugin is disabled or Obsidian shuts down:

```typescript
// In plugin onload():
const mcpHub = new McpHub(/* ... */);
this.register(() => mcpHub.dispose());
```

### 8.3 Reconnection Strategy

Cline implements reconnection for HTTP transports (using `ReconnectingEventSource` for SSE and a custom `StreamableHttpReconnectHandler`). For stdio, reconnection means re-spawning the process.

**Recommendation for Notor:**
- **stdio:** On disconnection, mark the server as disconnected. Provide a manual "Restart" button in settings. Do not auto-reconnect (spawning processes without user awareness is a trust issue).
- **HTTP transports:** Auto-reconnect with exponential backoff (use `ReconnectingEventSource` or equivalent).

---

## 9. Trust and Safety

### 9.1 Trust Model

Custom MCP tools operate outside Notor's built-in safety guarantees:

- **No content validation:** Notor cannot verify what an MCP tool actually does with its arguments
- **No execution sandboxing:** stdio servers run as full OS processes with the user's permissions
- **Cooperative Plan/Act:** The Plan/Act signal via `_meta` is advisory — a malicious or buggy server can ignore it

### 9.2 Required Warnings

The settings UI and documentation must clearly communicate:

1. **On adding any MCP server:** "Custom MCP tools run outside Notor's built-in safety guarantees. Only add servers you trust."
2. **On stdio servers specifically:** "This will spawn a local process on your machine with your user permissions."
3. **On Plan/Act classification:** "Read/write classifications are user-configured hints. The MCP server is trusted to respect the Plan/Act mode signal, but Notor cannot enforce this externally."

### 9.3 Desktop-Only Guard

stdio transport must be guarded behind `Platform.isDesktopApp`, consistent with `execute_command`:

```typescript
if (config.type === "stdio" && !Platform.isDesktopApp) {
  // Surface error: stdio MCP servers are only available on desktop
  return;
}
```

---

## 10. Implementation Plan Summary

### Dependencies to Add

| Package | Purpose | Size Impact |
|---|---|---|
| `@modelcontextprotocol/sdk` | MCP client, transports, schema validation | Moderate (tree-shakeable) |

### New Source Files

| File | Purpose |
|---|---|
| `src/mcp/mcp-hub.ts` | Central connection manager (connect, disconnect, tool/resource discovery) |
| `src/mcp/mcp-types.ts` | TypeScript types for MCP server config, connection state, tool metadata |
| `src/mcp/mcp-tool-handler.ts` | Tool dispatch handler for MCP tool calls (plugs into existing dispatcher) |
| `src/settings/sections/mcp-settings.ts` | Settings UI section for MCP server configuration |

### Integration Points

| Existing Module | Change |
|---|---|
| `src/tools/index.ts` (tool registry) | Register discovered MCP tools alongside built-in tools |
| `src/chat/dispatcher.ts` | Route MCP tool calls through `mcp-tool-handler` → `mcp-hub.callTool()` |
| `src/settings/types.ts` | Add `mcpServers` to `NotorSettings` interface |
| `src/settings/defaults.ts` | Add default empty `mcpServers: {}` |
| `src/main.ts` | Initialize `McpHub` on load, register cleanup on unload |

### What Notor Does NOT Need from Cline's Implementation

- **Marketplace / download system:** Notor uses manual configuration only
- **Remote config sync:** Enterprise feature, not relevant
- **OAuth flow:** Can be deferred to a later iteration (most community MCP servers use API keys or are auth-free)
- **File watcher for settings:** Notor uses Obsidian's settings API, not a separate JSON file
- **Server UID generation for tool names:** Notor can use a simpler namespacing approach since it has fewer constraints on tool name length

---

## 11. Risks and Open Questions

| Risk | Severity | Mitigation |
|---|---|---|
| MCP SDK bundle size bloats `main.js` | Medium | Measure after integration; tree-shake aggressively |
| stdio process spawning is blocked by future Obsidian sandbox changes | Low | Monitor Obsidian release notes; `execute_command` has the same risk |
| MCP servers with long startup times block plugin load | Medium | Connect to servers asynchronously after plugin load; don't await connections in `onload()` |
| Tool name collisions between MCP servers or with built-in tools | Medium | Namespace MCP tools as `{serverName}/{toolName}` in the registry |
| `_meta` ignored by all existing MCP servers (Plan/Act signal has no effect) | Expected | This is by design — the signal is cooperative. Document for MCP server authors who want to support it |
| OAuth-requiring MCP servers cannot connect | Low | Defer OAuth support; document as a known limitation in Phase 4.1 |

---

## Recommendation Summary

| Decision | Recommendation |
|---|---|
| **MCP SDK** | Use `@modelcontextprotocol/sdk` as a direct dependency |
| **Transports** | Support all three: stdio (desktop-only), SSE, Streamable HTTP |
| **Config storage** | In Notor plugin settings (`data.json`), not a separate file |
| **Tool discovery** | Fetch via `tools/list` on connection; store on connection object |
| **Tool dispatch** | Uniform pipeline — MCP tools go through same Plan/Act + auto-approve checks as built-in tools |
| **Read/write classification** | Default from `ToolAnnotations.readOnlyHint`; user-overridable in settings |
| **Plan/Act signaling** | `_meta.notor_mode` on each `tools/call` request (Approach A) |
| **Process lifecycle** | Register cleanup via `this.register()`; manual reconnect for stdio, auto-reconnect for HTTP |
| **Trust model** | Cooperative — clear warnings in UI; no enforcement beyond Plan/Act dispatch gating |
| **OAuth** | Defer to a future iteration; not required for Phase 4.1 |
