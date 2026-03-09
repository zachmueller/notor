# Data Model: Phase 4.1 — Custom MCP Servers

**Created:** 2026-09-03
**Specification:** [specs/04-mcp/spec.md](spec.md)
**Plan:** [specs/04-mcp/plan.md](plan.md)

---

## Persisted Entities

These entities are stored in Notor's plugin settings (`data.json` via `loadData`/`saveData`) or in Obsidian's secrets manager.

### McpServerConfig

Represents a single MCP server configuration entry. Stored in the `mcp_servers` map within `NotorSettings`, keyed by the server's slug name.

| Field | Type | Required | Default | Persisted In | Description |
|---|---|---|---|---|---|
| `name` | `string` | yes | — | Settings | Display name and unique key. Slug format: `[a-z0-9-]`, max 50 chars. Also used as the map key in `mcp_servers`. |
| `type` | `"stdio" \| "sse" \| "streamableHttp"` | yes | — | Settings | Transport type for this server. |
| `command` | `string` | yes (stdio) | — | Settings | Command to spawn the local process (e.g., `npx`, `python`, path to binary). |
| `args` | `string[]` | no | `[]` | Settings | Command-line arguments for the spawned process. |
| `cwd` | `string` | no | vault root | Settings | Working directory for the spawned process. |
| `env` | `McpEnvVar[]` | no | `[]` | Settings + Secrets | Environment variables for the spawned process. Each has a key, value, and sensitive flag. See `McpEnvVar`. |
| `url` | `string` | yes (sse, streamableHttp) | — | Settings | Server endpoint URL for HTTP transports. |
| `headers` | `McpHeader[]` | no | `[]` | Settings + Secrets | Custom HTTP headers. Each has a key, value, and sensitive flag. See `McpHeader`. |
| `disabled` | `boolean` | no | `false` | Settings | Whether the server is disabled. Disabled servers are not connected on plugin load. |
| `timeout` | `number` | no | `60` | Settings | Request timeout in seconds for `tools/call` requests to this server. |
| `toolClassifications` | `Record<string, "read" \| "write">` | no | `{}` | Settings | Per-tool read/write classification overrides. Key is the raw tool name (without server namespace prefix). |
| `autoApprove` | `string[]` | no | `[]` | Settings | Tool names (raw, without server namespace prefix) that are auto-approved for this server. |

**Validation rules:**
- `name`: must match `^[a-z0-9][a-z0-9-]*$`, max 50 characters, unique across all configured servers. Input is auto-slugified (trimmed, lowercased, spaces and special characters replaced with hyphens).
- `type`: must be one of the three valid transport types. `stdio` is only valid on desktop (`Platform.isDesktopApp`).
- `command`: required when `type` is `"stdio"`. Must be non-empty.
- `url`: required when `type` is `"sse"` or `"streamableHttp"`. Must be a valid URL.
- `timeout`: must be > 0. Clamped to range [1, 300].
- `toolClassifications` and `autoApprove` keys reference raw tool names as reported by the server.

### McpEnvVar

Represents a single environment variable for an stdio server. Part of `McpServerConfig.env`.

| Field | Type | Required | Default | Persisted In | Description |
|---|---|---|---|---|---|
| `key` | `string` | yes | — | Settings | Environment variable name (e.g., `API_KEY`, `NODE_ENV`). |
| `value` | `string` | yes | — | Settings or Secrets | The variable's value. Stored in secrets manager if `sensitive` is true; plain-text settings if false. |
| `sensitive` | `boolean` | no | `false` | Settings | If true, the value is stored via Obsidian's secrets manager API. |

**Secrets manager key format:** `mcp_env_{serverName}_{key}` — e.g., `mcp_env_my-server_API_KEY`.

When `sensitive` is true, the `value` field in the persisted settings JSON is set to an empty string `""` (placeholder). The actual value is resolved from the secrets manager at connection time.

### McpHeader

Represents a single custom HTTP header for an HTTP-transport server. Part of `McpServerConfig.headers`.

| Field | Type | Required | Default | Persisted In | Description |
|---|---|---|---|---|---|
| `key` | `string` | yes | — | Settings | Header name (e.g., `Authorization`). |
| `value` | `string` | yes | — | Settings or Secrets | Header value. Stored in secrets manager if `sensitive` is true; plain-text settings if false. |
| `sensitive` | `boolean` | no | `false` | Settings | If true, the value is stored via Obsidian's secrets manager API. |

**Secrets manager key format:** `mcp_header_{serverName}_{key}` — e.g., `mcp_header_my-api_Authorization`.

Same placeholder pattern as `McpEnvVar` — when `sensitive` is true, the `value` in settings JSON is `""` and the real value is resolved from secrets at connection time.

### NotorSettings Extension

The `mcp_servers` field is added to the existing `NotorSettings` interface:

```typescript
interface NotorSettings {
  // ... existing settings ...

  /**
   * MCP server configurations keyed by server name (slug format).
   *
   * @see specs/04-mcp/data-model.md — McpServerConfig
   */
  mcp_servers: Record<string, McpServerConfig>;
}
```

**Default value:** `{}` (empty object — no servers configured).

---

## Runtime Entities

These entities exist only in memory during plugin execution. They are not persisted.

### McpConnection

Represents a live connection to an MCP server. Created when a server is enabled and connected; disposed on disconnect, server removal, or plugin unload.

| Field | Type | Description |
|---|---|---|
| `serverName` | `string` | The server's slug name (matches key in `mcp_servers` config). |
| `config` | `McpServerConfig` | Reference to the server's persisted configuration. |
| `status` | `McpConnectionStatus` | Current connection state. |
| `client` | `Client \| null` | MCP SDK `Client` instance. Null when disconnected. |
| `transport` | `Transport \| null` | MCP SDK transport instance (`StdioClientTransport`, `SSEClientTransport`, or `StreamableHTTPClientTransport`). Null when disconnected. |
| `tools` | `McpDiscoveredTool[]` | Tools discovered via `tools/list`. Empty array before discovery or on failure. |
| `error` | `string \| null` | Error message if status is `Error`. Null otherwise. |

### McpConnectionStatus

State machine representing the connection lifecycle. Four states:

```
┌──────────────┐     enable/connect      ┌──────────────┐
│ Disconnected │ ──────────────────────▶ │  Connecting  │
└──────────────┘                         └──────────────┘
       ▲                                   │           │
       │                          success  │           │ failure
       │                                   ▼           ▼
       │                            ┌───────────┐  ┌─────────┐
       │◀───── disable/exit ────────│ Connecte  │  │  Error  │
       │                            └───────────┘  └─────────┘
       │                                   │           │
       │◀── process crash / net loss ──────┘           │
       │◀── user disables ─────────────────────────────┘
```

| State | Description | Transitions To |
|---|---|---|
| `Disconnected` | Not connected. Server is disabled, manually stopped, or not yet connected. | `Connecting` (user toggles on or plugin loads) |
| `Connecting` | Connection is being established (transport creation + initialize handshake + tool discovery). | `Connected` (success), `Error` (failure) |
| `Connected` | Handshake complete, tools discovered and registered. | `Disconnected` (process exit, network loss, user toggles off) |
| `Error` | Connection failed with a reason (spawn failure, handshake timeout, protocol error). | `Disconnected` (user toggles off) |

```typescript
type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
```

### McpDiscoveredTool

Represents a single tool discovered from an MCP server via `tools/list`.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Raw tool name as reported by the server (e.g., `query`, `read_file`). |
| `description` | `string` | Tool description from the server. Empty string if not provided. |
| `inputSchema` | `JSONSchema \| undefined` | JSON Schema for tool input parameters. |
| `annotations` | `ToolAnnotations \| undefined` | MCP `ToolAnnotations` object, including `readOnlyHint`, `destructiveHint`, etc. |

```typescript
interface ToolAnnotations {
  readOnlyHint?: boolean;      // default: false
  destructiveHint?: boolean;   // default: true
  idempotentHint?: boolean;    // default: false
  openWorldHint?: boolean;     // default: true
  title?: string;
}
```

### McpRegisteredTool

Adapter that wraps an `McpDiscoveredTool` to implement Notor's `Tool` interface, enabling uniform registration in the `ToolRegistry` alongside built-in tools.

| Field | Type | Source | Description |
|---|---|---|---|
| `name` | `string` | Computed | Namespaced name: `{serverName}__{toolName}` (e.g., `my-db-server__query`). |
| `description` | `string` | `McpDiscoveredTool.description` | Passed through from MCP server. |
| `input_schema` | `JSONSchema` | `McpDiscoveredTool.inputSchema` | Passed through from MCP server. Defaults to `{ type: "object" }` if undefined. |
| `mode` | `"read" \| "write"` | Computed | Determined by: user override in `McpServerConfig.toolClassifications` (if present) → `ToolAnnotations.readOnlyHint` (if `true` → `"read"`) → default `"write"`. |
| `execute()` | method | Delegates to McpHub | Resolves server → sends `tools/call` with `_meta.notor_mode` → extracts text results → returns `ToolResult`. |

**Implements:** `Tool` interface from `src/tools/tool.ts`.

### McpToolCallResult

Internal representation of an MCP `tools/call` response before conversion to `ToolResult`.

| Field | Type | Description |
|---|---|---|
| `content` | `McpContentItem[]` | Array of content items returned by the server. |
| `isError` | `boolean` | Whether the server reported the result as an error. |

```typescript
type McpContentItem =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string } };
```

**Text extraction rule (Phase 4.1):** Only `type: "text"` items are extracted and concatenated (newline-separated) into the `ToolResult` output. Non-text items are counted and a notice is appended (e.g., `"\n[1 image omitted]"`).

---

## Tool Naming and Resolution

### Namespace Convention

MCP tools are registered in the tool registry with a namespaced name:

```
{serverName}__{toolName}
```

- `serverName`: the server's slug name from config (e.g., `my-db-server`)
- `__`: double underscore separator
- `toolName`: the raw tool name from the server (e.g., `query`)

**Example:** `my-db-server__query`

### Name Resolution on Dispatch

When the LLM requests a tool with a name containing `__`:

1. Split on the **first** `__` occurrence: `serverName` = left part, `toolName` = right part
2. Look up `serverName` in McpHub's connection map
3. Look up `toolName` in the connection's discovered tools
4. Route to `McpRegisteredTool.execute()` → McpHub.callTool()

**Edge case:** If the tool name itself contains `__`, the split on **first** occurrence ensures the server name is correctly extracted (server names are slugs that never contain `__`).

### Display Name Convention

The chat UI displays MCP tool names in a friendlier format:

```
server/tool
```

**Example:** `my-db-server/query`

This is purely a display transformation — the registry key and LLM tool name always use the `__` format.

---

## Auto-Approve Precedence Chain

For MCP tools, the auto-approve check follows this precedence (first match wins):

1. **Persona override** (if a persona is active): check `persona_auto_approve[personaName][namespacedToolName]`
   - `"approve"` → auto-approve
   - `"deny"` → require approval
   - `"global"` or absent → fall through
2. **Server-level per-tool setting**: check `McpServerConfig.autoApprove` array
   - Tool name (raw) in array → auto-approve
   - Tool name not in array → fall through
3. **Global default for MCP tools**: require approval (all MCP tools default to requiring manual approval)

This extends the existing auto-approve precedence chain from Phase 4 (personas) without changing the semantics for built-in tools.

---

## Classification Override Precedence

For determining a tool's read/write mode:

1. **User override** in `McpServerConfig.toolClassifications[toolName]`
   - If present → use the user's classification (`"read"` or `"write"`)
2. **Server-reported hint** from `ToolAnnotations.readOnlyHint`
   - If `readOnlyHint === true` → `"read"`
   - If `readOnlyHint === false` or absent → `"write"`
3. **Default**: `"write"` (conservative — blocks in Plan mode unless explicitly classified as read)

---

## Entity Relationship Summary

```
NotorSettings
  └── mcp_servers: Record<string, McpServerConfig>
        ├── env: McpEnvVar[] ──────── sensitive values → SecretStorage
        ├── headers: McpHeader[] ──── sensitive values → SecretStorage
        ├── toolClassifications: Record<string, "read" | "write">
        └── autoApprove: string[]

McpHub (runtime singleton)
  └── connections: Map<string, McpConnection>
        ├── config → McpServerConfig (reference)
        ├── status: McpConnectionStatus
        ├── client: Client (MCP SDK)
        ├── transport: Transport (MCP SDK)
        └── tools: McpDiscoveredTool[]
              └── → adapted as McpRegisteredTool → registered in ToolRegistry

ToolRegistry
  ├── built-in tools: Tool[]
  └── MCP tools: McpRegisteredTool[] (implement Tool interface)

ToolDispatcher
  └── dispatches to Tool.execute()
        ├── built-in: direct execution
        └── MCP: McpRegisteredTool.execute() → McpHub.callTool() → MCP server
```
