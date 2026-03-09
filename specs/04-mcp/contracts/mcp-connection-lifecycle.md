# Contract: MCP Connection Lifecycle

**Created:** 2026-09-03
**Specification:** [specs/04-mcp/spec.md](../spec.md)
**Data Model:** [specs/04-mcp/data-model.md](../data-model.md)

---

## Overview

Defines the full lifecycle of MCP server connections — from plugin load through connection establishment, operational use, error recovery, and cleanup on plugin unload. Covers all three transport types (stdio, SSE, Streamable HTTP) and their platform-specific behavior.

---

## McpHub Interface

The `McpHub` is the central connection manager, instantiated once per plugin lifecycle.

```typescript
class McpHub {
  /** Initialize hub and connect to all enabled servers. Non-blocking. */
  async initialize(settings: NotorSettings, secretStorage: SecretStorage): Promise<void>;

  /** Connect to a single server by name. Idempotent — disconnects first if already connected. */
  async connectServer(serverName: string): Promise<void>;

  /** Disconnect a single server by name. Safe to call if already disconnected. */
  async disconnectServer(serverName: string): Promise<void>;

  /** Get connection state for a server. Returns undefined if server not configured. */
  getConnection(serverName: string): McpConnection | undefined;

  /** Get all connections (for UI display). */
  getAllConnections(): McpConnection[];

  /** Call a tool on a connected server. */
  async callTool(
    serverName: string,
    toolName: string,
    toolArguments: Record<string, unknown> | undefined,
    mode: "plan" | "act"
  ): Promise<ToolResult>;

  /** Re-fetch tool list for a connected server. */
  async refreshTools(serverName: string): Promise<void>;

  /** Get all discovered tools across all connected servers. */
  getAllDiscoveredTools(): { serverName: string; tool: McpDiscoveredTool }[];

  /** Register a callback for connection status changes. */
  onStatusChange(callback: (serverName: string, status: McpConnectionStatus, error?: string) => void): void;

  /** Clean up all connections and resources. Called on plugin unload. */
  async dispose(): Promise<void>;
}
```

---

## Connection Sequence

### Plugin Load

```
1. Plugin.onload()
2. Create McpHub instance
3. Register cleanup: this.register(() => mcpHub.dispose())
4. Call mcpHub.initialize(settings, secretStorage)
   → For each enabled server in settings.mcp_servers:
     → connectServer(serverName)  // async, non-blocking
   → Plugin load completes immediately (does NOT await connections)
5. Chat panel and built-in tools are usable while MCP servers connect in background
```

### Per-Server Connection

```
1. Set status = "connecting"
2. Resolve credentials (sensitive env vars / headers from SecretStorage)
3. Create transport:
   a. stdio: spawn child process via StdioClientTransport
   b. sse: create SSEClientTransport with URL + resolved headers
   c. streamableHttp: create StreamableHTTPClientTransport with URL + resolved headers
4. Create MCP Client instance
5. Connect client to transport
6. Perform initialize handshake:
   - Send: { clientInfo: { name: "Notor", version: "<plugin_version>" } }
   - Receive: server info + capabilities
   - Timeout: 30 seconds for initialize handshake
7. Discover tools:
   - Send: tools/list
   - Receive: array of tool definitions
   - Timeout: per-server timeout setting
8. Register tools in Notor's tool registry
9. Set status = "connected"
```

### Connection Failure

If any step in the connection sequence fails:

```
1. Set status = "error"
2. Set error message (human-readable description of failure)
3. Clean up partially-created resources (close transport, kill process)
4. Do NOT retry automatically for stdio
5. For HTTP: schedule auto-reconnect with exponential backoff
```

---

## Transport-Specific Behavior

### stdio Transport

**Platform guard:**
```typescript
if (config.type === "stdio" && !Platform.isDesktopApp) {
  connection.status = "error";
  connection.error = "stdio MCP servers require the Obsidian desktop app.";
  return;
}
```

**Process spawning:**
```typescript
const env = await resolveEnvironment(config, secretStorage);
const transport = new StdioClientTransport({
  command: config.command,
  args: config.args ?? [],
  cwd: config.cwd || vaultRootPath,
  env: { ...process.env, ...env },
});
```

**Environment resolution:**
1. Start with `process.env` (inherits system environment)
2. Merge non-sensitive env vars from `config.env` (where `sensitive === false`)
3. For sensitive env vars (`sensitive === true`): resolve value from `secretStorage.get("mcp_env_{serverName}_{key}")`
4. Merged env overrides system env for conflicting keys

**Process lifecycle:**
- Capture stderr from `transport.stderr` for error logging
- Monitor for process exit events → set status to "disconnected"
- On disconnect: close transport → SIGTERM to process → SIGKILL after 5-second grace period

**Reconnection:** Manual only. User toggles server off and back on in Settings or chat panel popover.

### SSE Transport

```typescript
const headers = await resolveHeaders(config, secretStorage);
const transport = new SSEClientTransport(new URL(config.url), {
  requestInit: { headers },
});
```

**Reconnection:** Automatic with exponential backoff.
- Initial delay: 1 second
- Maximum delay: 60 seconds
- Backoff factor: 2x
- Maximum attempts: unlimited (continues until server is manually disabled or connects successfully)
- After 5 consecutive failures: set status to "error" with descriptive message (reconnection continues in background)

### Streamable HTTP Transport

```typescript
const headers = await resolveHeaders(config, secretStorage);
const transport = new StreamableHTTPClientTransport(new URL(config.url), {
  requestInit: { headers },
});
```

**Compatibility shim:** Following Cline's pattern, map 404 → 405 on GET requests to handle servers that incorrectly return 404 instead of 405 when they don't support SSE streaming on the GET endpoint.

**Reconnection:** Same as SSE — automatic with exponential backoff.

### Header Resolution

```typescript
async function resolveHeaders(
  config: McpServerConfig,
  secretStorage: SecretStorage
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const header of config.headers ?? []) {
    if (header.sensitive) {
      const value = await secretStorage.get(`mcp_header_${config.name}_${header.key}`);
      if (value) headers[header.key] = value;
    } else {
      headers[header.key] = header.value;
    }
  }
  return headers;
}
```

---

## Tool Discovery

### After Successful Handshake

```typescript
async function discoverTools(connection: McpConnection): Promise<McpDiscoveredTool[]> {
  const result = await connection.client.request(
    { method: "tools/list", params: {} },
    ListToolsResultSchema,
    { timeout: connection.config.timeout * 1000 }
  );

  return result.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}
```

### Tool Registration

After discovery, tools are adapted and registered:

```typescript
for (const discoveredTool of connection.tools) {
  const registeredTool = new McpRegisteredTool(
    connection.serverName,
    discoveredTool,
    connection.config,
    mcpHub
  );
  toolRegistry.register(registeredTool);
}
```

### Tool Re-Discovery on Reconnect

When a server reconnects after disconnection:

1. Run `tools/list` again
2. Compare new tool list with previously discovered tools
3. Remove stale tools from the tool registry
4. Add new tools to the tool registry
5. Update existing tools if schemas changed
6. Preserve user-configured classification and auto-approve overrides for tools that still exist

---

## Disconnect and Cleanup

### Single Server Disconnect

```typescript
async disconnectServer(serverName: string): Promise<void> {
  const connection = this.getConnection(serverName);
  if (!connection || connection.status === "disconnected") return;

  // Remove tools from registry
  for (const tool of connection.tools) {
    toolRegistry.unregister(`${serverName}__${tool.name}`);
  }

  // Close transport (triggers process termination for stdio)
  if (connection.transport) {
    await connection.transport.close();
  }

  // Clear connection state
  connection.client = null;
  connection.transport = null;
  connection.tools = [];
  connection.status = "disconnected";
  connection.error = null;
}
```

### Plugin Unload (dispose)

```typescript
async dispose(): Promise<void> {
  // Disconnect all servers in parallel
  await Promise.allSettled(
    Array.from(this.connections.keys()).map((name) => this.disconnectServer(name))
  );
  this.connections.clear();
}
```

**Obsidian lifecycle registration:**
```typescript
// In Plugin.onload():
const mcpHub = new McpHub(/* ... */);
this.register(() => mcpHub.dispose());
```

This ensures cleanup runs even if:
- The plugin is disabled via Settings
- Obsidian is closed normally
- An unexpected shutdown occurs (best-effort)

---

## Status Change Notifications

McpHub emits status change events so the UI can react in real-time:

```typescript
// McpHub maintains a callback list
private statusCallbacks: Array<(serverName: string, status: McpConnectionStatus, error?: string) => void> = [];

onStatusChange(callback: (serverName: string, status: McpConnectionStatus, error?: string) => void): void {
  this.statusCallbacks.push(callback);
}

private emitStatusChange(serverName: string, status: McpConnectionStatus, error?: string): void {
  for (const callback of this.statusCallbacks) {
    callback(serverName, status, error);
  }
}
```

**Consumers:**
- Settings UI: updates server status indicators
- Chat panel MCP popover: updates status dots and enable/disable toggles
- Chat panel MCP indicator: updates healthy/warning badge state
- Tool registry: adds/removes tools on connect/disconnect

---

## Initialize Handshake Details

### Client Info

```typescript
{
  clientInfo: {
    name: "Notor",
    version: pluginVersion, // from manifest.json
  },
  capabilities: {},  // No special client capabilities needed for Phase 4.1
}
```

### Handshake Timeout

- Default: 30 seconds for the `initialize` round-trip
- If the server does not respond within 30 seconds, the connection is marked as errored
- For stdio: if the process does not produce a valid `initialize` response within 30 seconds, SIGTERM is sent

### Capability Negotiation

Phase 4.1 uses only basic capabilities:
- **tools**: required — Notor needs `tools/list` and `tools/call`
- **resources**: not used in Phase 4.1 (deferred)
- **prompts**: not used in Phase 4.1 (deferred)
- **notifications**: not subscribed to in Phase 4.1 (deferred — tool list changes detected on reconnect or manual refresh)
