# Implementation Plan: Phase 4.1 — Custom MCP Servers

**Created:** 2026-09-03
**Specification:** [specs/04-mcp/spec.md](spec.md)
**Status:** Planning

## Technical Context

### Architecture Decisions

- **Platform:** Obsidian community plugin (TypeScript → esbuild → `main.js`) — same as Phases 0–4
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.25+ — pure TypeScript/JavaScript MCP client, transports, and schema validators. No native modules. Tree-shakeable via esbuild (only client-side code bundled; server-side SDK eliminated).
- **Transports:** All three MCP transport types supported:
  - **stdio** (desktop-only): `StdioClientTransport` — spawns child process via `child_process.spawn()`, JSON-RPC over stdin/stdout. Guarded behind `Platform.isDesktopApp`, consistent with `execute_command`.
  - **SSE** (legacy HTTP): `SSEClientTransport` — HTTP with Server-Sent Events for server-to-client streaming. Works on all platforms.
  - **Streamable HTTP** (current standard): `StreamableHTTPClientTransport` — HTTP POST for requests, optional SSE for streaming responses. Works on all platforms.
- **Connection management:** Singleton `McpHub` class manages all server connections (connect, disconnect, reconnect, tool discovery). Initialized in `main.ts` on plugin load; cleanup registered via `this.register()`.
- **Config storage:** MCP server configuration stored in Notor plugin settings (`data.json` via `loadData`/`saveData`), not a separate JSON file. Consistent with all other Notor settings.
- **Credential storage:** HTTP header values and stdio environment variables marked as "sensitive" are stored via Obsidian's secrets manager API (`SecretStorage`), consistent with LLM provider API key storage.
- **Tool namespace:** MCP tools are registered with `{serverName}__{toolName}` naming convention (double underscore separator). Unambiguous because server names are slug-format `[a-z0-9-]` and never contain `__`. Chat UI displays friendlier `server/tool` format.
- **Tool dispatch:** MCP tools plug into the existing `ToolDispatcher` pipeline via a generic `McpToolHandler` that delegates to `McpHub.callTool()`. Same Plan/Act enforcement, auto-approve checks, and approval UI as built-in tools.
- **Plan/Act signaling:** `_meta.notor_mode` field on each `tools/call` request — protocol-compliant, per-invocation, ignorable by servers that don't support it. No capability negotiation required.
- **Read/write classification:** Default from `ToolAnnotations.readOnlyHint`; user-overridable in Settings. User override takes precedence.
- **UI framework:** Obsidian native APIs — extends `PluginSettingTab` with MCP server management section; extends chat panel `ItemView` with MCP status popover.

### Technology Stack Rationale

| Decision | Rationale | Alternatives Considered | Trade-offs |
|---|---|---|---|
| `@modelcontextprotocol/sdk` as direct dependency | Official TypeScript SDK; provides client transports, JSON-RPC handling, schema validation; pure JS (no native modules); moderate bundle size impact (tree-shakeable) | Hand-roll JSON-RPC over transports; use a generic JSON-RPC library | SDK is well-maintained, handles protocol edge cases (version negotiation, error handling), and evolves with the spec; adds dependency but saves significant implementation effort |
| All three transports (stdio, SSE, Streamable HTTP) | stdio covers the vast majority of community MCP servers; HTTP transports enable remote/cloud servers and mobile compatibility; the SDK provides ready-made transport classes for all three | stdio-only (simpler, but excludes remote servers and mobile); HTTP-only (misses most community servers) | More code to maintain; but transport selection is per-server config, and each transport class is self-contained |
| Config in plugin settings (`data.json`) | Consistent with all other Notor settings; uses Obsidian's `loadData`/`saveData`; no file-watcher needed | Separate JSON file (Cline's approach); separate config note in vault | Less flexible for external editing; but simpler and consistent with existing patterns |
| `{serverName}__{toolName}` namespace | Double underscore is unambiguous (server slugs use `[a-z0-9-]`, never `__`); complies with LLM tool name restrictions `[a-zA-Z0-9_-]`; simpler than Cline's UID-based approach | Server UID + magic separator (Cline's `0mcp0`); `server/tool` with `/` (violates LLM API restrictions); registry-level mapping without name encoding | Slightly longer tool names sent to LLM; but human-readable and collision-proof |
| `_meta.notor_mode` for Plan/Act signaling | Protocol-compliant (`_meta` is the spec's designated extension point); per-invocation (no state sync); ignorable by non-supporting servers; simple implementation | Extra tool argument (violates input schema); initialize-time capability (doesn't reflect per-call mode changes); custom notification (complex, stateful) | No existing servers support it yet (by design — signal is cooperative); but forward-compatible and spec-compliant |
| Secrets manager for sensitive env vars and HTTP headers | Consistent with LLM API key storage pattern; OS-level encrypted storage; per-variable "sensitive" toggle keeps simple config values in plain text | All env vars in secrets (too restrictive); all in plain text (insecure for API keys) | Slightly more complex settings UI (toggle per variable); but correct security boundary |

### Integration Points

- **MCP SDK:** `@modelcontextprotocol/sdk` — `Client` class, `StdioClientTransport`, `SSEClientTransport`, `StreamableHTTPClientTransport`, `CallToolResultSchema`, `ListToolsResultSchema`, type definitions
- **Obsidian platform API:** `Platform.isDesktopApp` for stdio guard; `SecretStorage` for sensitive credentials
- **Obsidian plugin lifecycle:** `this.register()` for McpHub cleanup on unload
- **Node.js APIs (desktop):** `child_process.spawn()` via SDK's `StdioClientTransport`; `process.env` for environment variable merging
- **Existing Notor systems:**
  - `src/tools/index.ts` (`ToolRegistry`) — register discovered MCP tools alongside built-in tools
  - `src/tools/tool.ts` (`Tool` interface) — MCP tools adapt to the same interface
  - `src/chat/dispatcher.ts` (`ToolDispatcher`) — route MCP tool calls through Plan/Act + auto-approve pipeline
  - `src/chat/orchestrator.ts` (`ChatOrchestrator`) — `setGetToolDefinitions()` callback includes MCP tools
  - `src/chat/system-prompt.ts` (`SystemPromptBuilder`) — tool definitions section includes MCP tools
  - `src/settings/types.ts` (`NotorSettings`) — add `mcp_servers` config
  - `src/settings/defaults.ts` — add default empty `mcp_servers: {}`
  - `src/settings/settings-tab.ts` — add MCP servers settings section
  - `src/ui/chat-view.ts` — add MCP status indicator in chat panel header
  - `src/main.ts` — initialize `McpHub` on load, register cleanup
  - `src/personas/auto-approve-resolver.ts` — extend to include MCP tools in persona auto-approve UI
- **esbuild config:** `@modelcontextprotocol/sdk` must NOT be in the externals list — it needs to be bundled into `main.js`

---

## Phase 0: Research & Architecture

### Research Tasks

The MCP integration research was completed as a pre-phase task. All major technology decisions are resolved.

#### R-1: MCP Server Integration and Plan/Act State Signaling

**Status:** ✅ Complete

Comprehensive research covering MCP protocol overview, transport mechanisms, Electron/Node.js constraints in Obsidian, implementation architecture (lessons from Cline), configuration design, tool schema discovery, Plan/Act state signaling mechanism, process lifecycle management, trust and safety, and implementation plan.

**Key Decisions:**
- Use `@modelcontextprotocol/sdk` as a direct dependency
- Support all three transports (stdio desktop-only, SSE, Streamable HTTP)
- Store config in plugin settings, not a separate file
- Use `_meta.notor_mode` for Plan/Act state signaling (Approach A — protocol-compliant, per-invocation)
- Default read/write classification from `ToolAnnotations.readOnlyHint`, user-overridable
- Manual reconnect for stdio, auto-reconnect with exponential backoff for HTTP transports
- Cooperative trust model with clear warnings in UI

**Output:** Findings in [design/research/mcp-server-integration.md](../../design/research/mcp-server-integration.md)

#### R-2: MCP SDK Bundle Size Impact

**Status:** ⬜ Pending (to be measured during implementation)

The MCP SDK is pure TypeScript with no native modules. The client-side code (transports + protocol handling) is expected to be lightweight after tree-shaking. Notor already bundles substantial dependencies (AWS SDK, Turndown). The actual bundle size impact should be measured after integration.

**Success Criteria:** Bundle size increase ≤ 150 KB gzipped. If larger, investigate selective imports or alternative approaches.

**Mitigation:** esbuild tree-shaking eliminates unused server-side SDK code. If impact is too large, consider extracting only the transport and JSON-RPC handling code.

### Architecture Investigation

- **Performance requirements:** MCP server connections must not block plugin startup (async initialization). Tool dispatch adds ≤ 50 ms overhead beyond server response time. Support up to 10 concurrent MCP servers without perceptible degradation.
- **Security analysis:** stdio servers spawn with user permissions (same as `execute_command`); HTTP headers/sensitive env vars stored in secrets manager; Plan/Act enforcement is Notor-side (hard gate); `_meta` signaling is cooperative/advisory; trust warnings mandatory in UI.
- **Memory considerations:** Each `McpConnection` holds a client instance, transport, and tool list (lightweight). stdio transport holds a child process handle. No significant memory concerns for ≤ 10 servers.
- **Mobile considerations:** stdio transport unavailable on mobile (no `child_process`). HTTP transports work. Settings UI hides stdio option on mobile. Consistent with `execute_command` being desktop-only.

---

## Phase 1: Design & Contracts

**Prerequisites:** Research task R-1 complete

### Data Model Design

Full data model is documented in [data-model.md](data-model.md). Key new entities for Phase 4.1:

- **McpServerConfig** — persisted server configuration in plugin settings (name, transport type, connection params, per-tool overrides)
- **McpConnection** — runtime connection state (client, transport, discovered tools, status)
- **McpDiscoveredTool** — tool metadata from `tools/list` (name, description, input schema, annotations)
- **McpRegisteredTool** — adapter that wraps an MCP discovered tool to implement Notor's `Tool` interface
- **McpConnectionStatus** — state machine (Connecting → Connected / Error; Connected → Disconnected; etc.)

### API Contract Generation

Contracts are documented in [contracts/](contracts/). Key new contracts for Phase 4.1:

- **MCP tool call dispatch** — how MCP tool names are parsed, routed to the correct server, and executed with `_meta` injection
- **MCP tool registration** — how discovered tools are adapted to the `Tool` interface and registered in the unified tool registry
- **MCP server configuration schema** — settings structure, validation rules, and slug format enforcement
- **MCP settings UI** — server management, tool list display, classification/auto-approve controls

### Development Environment Setup

Developer setup additions for Phase 4.1 are documented in [quickstart.md](quickstart.md).

---

## Implementation Feature Groups

### Group A: MCP Core Infrastructure (FR-55, FR-56)

**Prerequisites:** None (foundational — new module with no dependencies on other Phase 4.1 groups)

| Component | FRs Covered | Description |
|---|---|---|
| MCP type definitions | FR-55, FR-56 | `src/mcp/mcp-types.ts` — TypeScript interfaces for `McpServerConfig`, `McpConnection`, `McpDiscoveredTool`, `McpConnectionStatus`, and related types |
| McpHub connection manager | FR-55 | `src/mcp/mcp-hub.ts` — singleton class managing all MCP server connections: connect, disconnect, tool discovery, status tracking, cleanup |
| Transport factory | FR-55 | Within McpHub — create `StdioClientTransport`, `SSEClientTransport`, or `StreamableHTTPClientTransport` based on server config type. stdio guarded behind `Platform.isDesktopApp`. |
| MCP initialize handshake | FR-55 | Within McpHub — perform `initialize` exchange (client info, capability negotiation) after transport establishment |
| Tool schema discovery | FR-56 | Within McpHub — send `tools/list` after successful handshake; parse `McpTool` objects including `ToolAnnotations`; store on connection |
| Connection status tracking | FR-55 | State machine: Disconnected → Connecting → Connected / Error. Status exposed per-server for UI consumption. |
| Reconnection logic | FR-55 | stdio: no auto-reconnect (manual toggle off/on). HTTP transports: auto-reconnect with exponential backoff. |
| Process lifecycle management | FR-55 | stdio: SIGTERM on close → SIGKILL after grace period. Register cleanup via `this.register()`. Detect process exit/crash events. |
| Credential resolution | FR-55 | Resolve sensitive env vars and HTTP headers from Obsidian's secrets manager at connection time; merge with non-sensitive values from settings |
| Plugin lifecycle integration | FR-55 | `src/main.ts` — initialize McpHub on load (async, non-blocking); register cleanup on unload |

### Group B: Tool Registration and Dispatch (FR-56, FR-57, FR-58, FR-59)

**Prerequisites:** Group A (McpHub provides discovered tools)

| Component | FRs Covered | Description |
|---|---|---|
| McpRegisteredTool adapter | FR-56, FR-57 | `src/mcp/mcp-tool-adapter.ts` — wraps an `McpDiscoveredTool` to implement Notor's `Tool` interface (`name`, `description`, `input_schema`, `mode`, `execute()`) |
| Namespaced tool naming | FR-56 | Apply `{serverName}__{toolName}` convention when registering. Parse namespace on dispatch to resolve target server + tool. |
| Read/write classification | FR-57 | Default from `ToolAnnotations.readOnlyHint` (true → read, false/absent → write). User override from `McpServerConfig.toolClassifications` takes precedence. |
| MCP tool handler | FR-59 | `src/mcp/mcp-tool-handler.ts` — `execute()` implementation that: resolves server connection → checks server is connected → sends `tools/call` via MCP client → extracts text content → returns `ToolResult` |
| `_meta.notor_mode` injection | FR-58 | Within MCP tool handler — inject `_meta: { notor_mode: "plan" | "act" }` on every `tools/call` request |
| Text-only result extraction | FR-59 | Extract `TextContent` items from MCP tool results. Discard `ImageContent`/`EmbeddedResource` with notice (e.g., "[1 image omitted]"). |
| Error handling | FR-59 | Server disconnected → error returned to LLM. Server timeout → cancel and error. Malformed response → error. All errors are tool results, not exceptions. |
| Tool registry integration | FR-56 | Extend `ToolRegistry` (or create a parallel `McpToolRegistry`) to hold MCP tools. Ensure `getToolDefinitions()` and `isWriteTool()` include MCP tools. |
| Dispatcher integration | FR-59 | Extend `ToolDispatcher` to recognize MCP tool names (contains `__`), resolve to `McpRegisteredTool`, and route through standard Plan/Act + auto-approve pipeline |
| Dynamic tool registration | FR-56 | When servers connect/disconnect/reconnect, update the tool registry. Re-run tool discovery on reconnect; add/remove tools as needed. |

### Group C: Auto-Approve for MCP Tools (FR-60)

**Prerequisites:** Group B (MCP tools registered in dispatcher)

| Component | FRs Covered | Description |
|---|---|---|
| Per-tool auto-approve config | FR-60 | Store per-MCP-tool auto-approve settings in `McpServerConfig.autoApprove` (string array of tool names). Default: off (require approval) for all newly discovered MCP tools. |
| Auto-approve precedence chain | FR-60 | Extend existing precedence: persona override → server-level per-tool setting → global default (require approval). |
| Persona auto-approve UI extension | FR-60 | Add MCP tools to the persona auto-approve UI (`src/settings/sections/persona-auto-approve.ts`). When servers connect and tools are discovered, those tools appear alongside built-in tools. |
| Stale tool handling | FR-60 | If an MCP tool is removed (server disconnected or tool no longer reported), preserve auto-approve entries with a stale warning indicator. Consistent with FR-40 pattern. |

### Group D: Settings UI (FR-54, FR-61)

**Prerequisites:** Group A (McpHub for connection status), Group B (tool list for per-tool settings)

| Component | FRs Covered | Description |
|---|---|---|
| MCP servers settings section | FR-54, FR-61 | `src/settings/sections/mcp-servers.ts` — "MCP servers" section in **Settings → Notor** with server list, status indicators, enable/disable toggles |
| Add server form | FR-54, FR-61 | Transport type selector (stdio / sse / streamableHttp), then transport-specific fields. Auto-slugify server name. Uniqueness validation. |
| Trust warnings | FR-61 | Prominent warning on add: "Custom MCP tools run outside Notor's built-in safety guarantees. Only add servers you trust." Additional stdio warning: "This will spawn a local process on your machine with your user permissions." |
| Server detail view | FR-61 | Expandable per-server: config fields (editable), enable/disable toggle, remove button (with confirmation), tools sub-section |
| Per-tool settings UI | FR-57, FR-60, FR-61 | For each discovered tool: name + description, read/write classification dropdown, auto-approve toggle. Classification advisory note. |
| Refresh tools button | FR-56, FR-61 | Re-query `tools/list` for a connected server and update the tool registry |
| Sensitive env var toggle | FR-54 | Per-environment-variable "sensitive" toggle. Sensitive values stored in secrets manager; non-sensitive in plain-text settings. |
| Mobile stdio guard | FR-54 | On mobile, hide stdio transport option or show informational message |
| Server name validation | FR-54 | Slug format: lowercase alphanumeric + hyphens, max 50 chars. Auto-slugify on input. Uniqueness check. |

### Group E: Chat Panel MCP Status (FR-62, FR-63)

**Prerequisites:** Group A (connection status), Group B (MCP tool display)

| Component | FRs Covered | Description |
|---|---|---|
| MCP tool display in chat | FR-62 | MCP tool calls displayed using same collapsible tool-call UI component as built-in tools. Parameters as formatted key-value pairs; results as preformatted text. Approval UI identical. |
| MCP status indicator | FR-63 | Icon/badge in chat panel header area, visible only when ≥1 MCP server configured. Healthy/warning state based on server statuses. |
| MCP status popover | FR-63 | Click indicator → popover listing all servers: name, status dot (green/yellow/grey/red), enable/disable toggle (synced with Settings), brief error summary for errored servers. |
| Real-time status updates | FR-63 | Popover reflects connection status changes in real-time while open. Toggle changes persist to settings immediately. |
| Chat UI tool name display | FR-62 | Display MCP tools with `server/tool` format for human readability (even though LLM sees `server__tool`). |

### Settings Additions

New settings required for Phase 4.1 (extends existing settings model):

| Setting | Type | Default | Description |
|---|---|---|---|
| `mcp_servers` | `Record<string, McpServerConfig>` | `{}` | MCP server configurations keyed by server name (slug) |

The `McpServerConfig` type contains all per-server settings including per-tool classification overrides, auto-approve lists, timeout, and transport-specific parameters. See [data-model.md](data-model.md) for the full type definition.

---

## Implementation Readiness Validation

### Technical Completeness Check

- [x] All technology choices made and documented
- [x] R-1: MCP integration research complete — SDK, transports, Plan/Act signaling, process lifecycle, trust model
- [ ] R-2: Bundle size impact — to be measured during implementation (success criteria defined)
- [x] Data model covers all functional requirements (see data-model.md)
- [x] Contracts defined for new systems (see contracts/)
- [x] Security requirements addressed (stdio guard, secrets manager, Plan/Act enforcement, trust warnings)
- [x] Performance considerations documented (async startup, ≤50 ms dispatch overhead, 10 concurrent servers)
- [x] Integration points defined (MCP SDK, Obsidian APIs, existing Notor tool/dispatch/settings systems)
- [x] Development environment specified (see quickstart.md)

### Quality Validation

- [x] Architecture extends existing Phase 0–4 systems without breaking changes
- [x] Security model addresses new surfaces (stdio process spawning, cooperative trust, credential storage)
- [x] Data model supports all business rules (slug naming, classification overrides, auto-approve precedence)
- [x] Design follows established patterns (Tool interface adapter, ToolDispatcher extension, Settings sections, secrets manager)
- [x] Documentation complete for all major decisions

---

## Risk Assessment

### Technical Risks

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| **MCP SDK bundle size bloats `main.js`** | Medium — larger plugin download | Medium | Measure after integration; tree-shake aggressively via esbuild; fallback: extract only transport + JSON-RPC code |
| **MCP servers with long startup times block tool availability** | Low — tools unavailable until server ready | Medium | Connect asynchronously after plugin load; tools appear incrementally as servers connect; chat panel usable immediately |
| **Tool name collisions between MCP servers or with built-in tools** | Medium — wrong tool invoked | Low | `{serverName}__{toolName}` namespace prevents collisions; server names are unique slugs; built-in tools never contain `__` |
| **`_meta` ignored by all existing MCP servers** | Expected — no immediate Plan/Act cooperation | Expected | By design — signal is cooperative. Notor's own Plan/Act enforcement (read/write classification) provides the hard gate. Document for MCP server authors. |
| **stdio process spawning blocked by future Obsidian sandbox changes** | High — stdio transport breaks | Low | `execute_command` has the same risk; monitor Obsidian release notes; HTTP transports unaffected |
| **Malformed MCP server responses crash the plugin** | High — plugin instability | Low | Wrap all MCP client calls in try/catch; validate against SDK schemas; return errors to LLM as tool results |
| **OAuth-requiring MCP servers cannot connect** | Low — user can't use specific servers | Low | Documented as out of scope for Phase 4.1; users can provide static bearer tokens via HTTP headers |
| **Streamable HTTP compatibility issues** | Low — some servers don't implement it correctly | Medium | Include Cline's compatibility shim (map 404 → 405 on GET); fall back to SSE transport if needed |

### Dependencies and Assumptions

- **External dependencies:** `@modelcontextprotocol/sdk` v1.25+ (npm package — pure TypeScript, no native modules); no other new runtime dependencies
- **Existing system dependencies:** Phase 4.1 builds on Phase 0 (settings, secrets manager), Phase 1 (tool dispatch, Plan/Act mode, chat panel, auto-approve, tool registry), Phase 3 (shell executor pattern for process management), and Phase 4 (persona auto-approve for MCP tool extension)
- **Technical assumptions:** `child_process.spawn()` works from Obsidian desktop plugins (confirmed — `execute_command` uses it); MCP SDK's `Client.request()` passes through `_meta` without stripping custom fields; `StdioClientTransport` uses `child_process.spawn` internally (confirmed from SDK source); esbuild can tree-shake the MCP SDK's server-side code; Obsidian's `SecretStorage` API supports arbitrary key-value pairs for sensitive env vars
- **Business assumptions:** Most community MCP servers use stdio transport; users familiar with MCP server configuration (command + args for stdio, URL for HTTP); OAuth support not needed for initial release (API key headers sufficient); no MCP marketplace needed (manual configuration only)
- **Mobile considerations:** stdio transport unavailable; HTTP transports (SSE, Streamable HTTP) work on mobile; Settings UI hides stdio option on mobile; consistent with `execute_command` being desktop-only

---

## Next Phase Preparation

### Task Breakdown Readiness

- [x] Clear technology choices and architecture
- [x] Complete data model and contract specifications
- [x] Development environment and tooling defined
- [x] Quality standards and testing approach specified
- [x] Integration requirements and dependencies clear

### Implementation Prerequisites

- [x] R-1: MCP integration research complete
- [ ] R-2: Bundle size measurement (during implementation)
- [x] Development environment requirements specified (see quickstart.md)
- [x] Existing Phase 0–4 infrastructure available as foundation
- [x] Quality assurance approach defined (e2e tests, manual MCP server testing)

### Recommended Implementation Order

Feature groups have the following dependency relationships:

```
A (MCP Core Infrastructure) ──▶ B (Tool Registration & Dispatch) ──▶ C (Auto-Approve for MCP)
         │                              │
         │                              │
         ▼                              ▼
D (Settings UI) ◀─────────────────── needs A + B
         │
         ▼
E (Chat Panel MCP Status) ◀──────── needs A + B
```

**Recommended order:**
1. **A (MCP Core Infrastructure)** — foundational; McpHub, transports, connection lifecycle, tool discovery. No UI dependencies. Can be tested with manual `McpHub` instantiation.
2. **B (Tool Registration & Dispatch)** — depends on A; McpRegisteredTool adapter, namespace handling, dispatcher integration, `_meta` injection. Enables end-to-end tool calling.
3. **D (Settings UI)** — depends on A + B; server management, per-tool settings, trust warnings. Enables user-facing configuration.
4. **C (Auto-Approve for MCP Tools)** — depends on B; per-tool auto-approve, persona integration, stale handling. Small scope; can be done in parallel with D.
5. **E (Chat Panel MCP Status)** — depends on A + B; status indicator, popover, tool display. Final UI polish.
