# Task Breakdown: Phase 4.1 — Custom MCP Servers

**Created:** 2026-10-03
**Implementation Plan:** [plan.md](plan.md)
**Specification:** [spec.md](spec.md)
**Data Model:** [data-model.md](data-model.md)
**Contracts:** [contracts/](contracts/)
**Status:** In Progress

## Task Summary

**Total Tasks:** 24
**Phases:** 6 (Setup → Foundation → Core → Integration → Quality → Polish)
**Estimated Complexity:** High
**Parallel Execution Opportunities:** 6 task groups

### Feature Group → Phase Mapping

The plan defines five feature groups (A–E) with explicit dependency ordering. Tasks below are organized into implementation phases that respect those dependencies:

```
Phase 0 (Setup)     → ENV-001, ENV-002
Phase 1 (Foundation)→ Group A: ARCH-001, ARCH-002, ARCH-003, ARCH-004, ARCH-005
Phase 2 (Core)      → Group B: FEAT-001, FEAT-002, FEAT-003, FEAT-004, FEAT-005
Phase 3 (Integration)→ Groups C+D+E: INT-001, INT-002, INT-003, INT-004, INT-005, INT-006
Phase 4 (Quality)   → TEST-001, TEST-002, TEST-003, PERF-001
Phase 5 (Polish)    → DOC-001, VAL-001
```

### Critical Path

```
ENV-001 → ENV-002 → ARCH-001 → ARCH-002 → ARCH-003 → FEAT-001 → FEAT-002 → FEAT-003 → INT-003 → TEST-001 → VAL-001
```

## Phase 0: Setup & Environment

### ENV-001: Install MCP SDK and verify bundle
**Description:** Add `@modelcontextprotocol/sdk` as a project dependency and verify that esbuild bundles it correctly (not externalized). Confirm the bundle size increase is within the acceptable range documented in research.md R-2 (~166 KB gzipped).
**FRs:** Prerequisite for all
**Files:**
- `package.json` — add `@modelcontextprotocol/sdk` dependency
- `package-lock.json` — lockfile update
- `esbuild.config.mjs` — verify SDK is NOT in the `external` array
**Dependencies:** None
**Acceptance Criteria:**
- [x] `@modelcontextprotocol/sdk` v1.25+ installed as a direct dependency
- [x] `npm run build` succeeds with no errors
- [x] SDK is bundled into `main.js` (not externalized) — verified by checking `esbuild.config.mjs` externals list
- [x] Bundle size increase is ≤ 200 KB gzipped over baseline (target: ~166 KB per R-2)
- [x] Server-side SDK code (express, hono, cors) is tree-shaken out — not present in `main.js`

**Commands:**
```bash
# Record baseline
gzip -c main.js | wc -c
# Install
npm install @modelcontextprotocol/sdk
# Build and measure
npm run build
gzip -c main.js | wc -c
```

### ENV-002: Create MCP module structure and settings scaffold
**Description:** Create the `src/mcp/` directory structure with empty/skeleton files, and add the `mcp_servers` field to `NotorSettings` with its default value. This scaffolds the foundation so subsequent tasks can work in parallel without file conflicts.
**FRs:** FR-54 (settings scaffold)
**Files:**
- `src/mcp/mcp-types.ts` — empty file with doc comment
- `src/mcp/mcp-hub.ts` — empty file with doc comment
- `src/mcp/mcp-tool-adapter.ts` — empty file with doc comment
- `src/mcp/mcp-tool-handler.ts` — empty file with doc comment
- `src/settings/types.ts` — add `mcp_servers: Record<string, McpServerConfig>` to `NotorSettings`
- `src/settings/defaults.ts` — add default `mcp_servers: {}`
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [x] `src/mcp/` directory exists with four skeleton files
- [x] `NotorSettings` interface includes `mcp_servers` field typed as `Record<string, McpServerConfig>`
- [x] Default settings include `mcp_servers: {}`
- [x] `npm run build` succeeds with no type errors
- [x] Existing functionality unaffected — plugin loads normally with empty MCP config

## Phase 1: Foundation & Architecture (Group A — MCP Core Infrastructure)

### ARCH-001: MCP type definitions
**Description:** Implement all TypeScript interfaces and types for the MCP subsystem as defined in data-model.md. These types are imported by every other MCP module, so they must be completed first.
**FRs:** FR-54, FR-55, FR-56
**Files:**
- `src/mcp/mcp-types.ts` — `McpServerConfig`, `McpEnvVar`, `McpHeader`, `McpConnection`, `McpConnectionStatus`, `McpDiscoveredTool`, `McpToolCallResult`, `McpContentItem`, `ToolAnnotations`
**Dependencies:** ENV-002
**Acceptance Criteria:**
- [x] `McpServerConfig` interface matches data-model.md exactly (name, type, command, args, cwd, env, url, headers, disabled, timeout, toolClassifications, autoApprove)
- [x] `McpEnvVar` and `McpHeader` interfaces include `key`, `value`, and `sensitive` fields
- [x] `McpConnection` runtime type includes serverName, config, status, client, transport, tools, error fields
- [x] `McpConnectionStatus` is `"disconnected" | "connecting" | "connected" | "error"`
- [x] `McpDiscoveredTool` includes name, description, inputSchema, annotations
- [x] `McpContentItem` discriminated union covers `text`, `image`, and `resource` types
- [x] Secrets manager key format helpers exported: `mcpEnvSecretKey(serverName, key)` → `mcp_env_{serverName}_{key}`, `mcpHeaderSecretKey(serverName, key)` → `mcp_header_{serverName}_{key}`
- [x] Server name validation regex exported: `MCP_SERVER_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/`, max 50 chars
- [x] `npm run build` succeeds with no type errors

### ARCH-002: McpHub connection manager — connect, disconnect, lifecycle
**Description:** Implement the core `McpHub` singleton class that manages all MCP server connections. This task covers the connection lifecycle (connect, disconnect, dispose), transport factory (stdio/SSE/Streamable HTTP), credential resolution from secrets manager, process lifecycle management for stdio, reconnection logic for HTTP transports, and status change notifications. Does NOT yet include tool discovery or `callTool` (those are ARCH-003).
**FRs:** FR-55
**Files:**
- `src/mcp/mcp-hub.ts` — `McpHub` class with `initialize()`, `connectServer()`, `disconnectServer()`, `getConnection()`, `getAllConnections()`, `onStatusChange()`, `dispose()`
**Dependencies:** ARCH-001
**Acceptance Criteria:**
- [x] `McpHub.initialize(settings, secretStorage)` reads `mcp_servers` config and calls `connectServer()` for each enabled server — asynchronously, non-blocking (does not await all connections)
- [x] `connectServer()` creates the correct transport based on `config.type`:
  - stdio: `StdioClientTransport` with command, args, cwd, merged env (system + config + secrets). Guarded behind `Platform.isDesktopApp` — returns error on mobile.
  - sse: `SSEClientTransport` with URL and resolved headers (sensitive from secrets manager)
  - streamableHttp: `StreamableHTTPClientTransport` with URL and resolved headers. Includes Cline's 404→405 compatibility shim.
- [x] `connectServer()` performs MCP `initialize` handshake with `clientInfo: { name: "Notor", version: <from manifest> }`. 30-second handshake timeout.
- [x] Connection status transitions follow the state machine: Disconnected → Connecting → Connected / Error
- [x] stdio: monitors child process for exit/crash events → sets status to "disconnected". Captures stderr for logging. No auto-reconnect.
- [x] HTTP transports: auto-reconnect with exponential backoff (1s initial, 2x factor, 60s max). After 5 consecutive failures → status "error" with message (reconnection continues in background).
- [x] `disconnectServer()` cleanly closes transport. stdio: SIGTERM → 5s grace → SIGKILL. Safe to call if already disconnected.
- [x] `dispose()` disconnects all servers in parallel via `Promise.allSettled()`.
- [x] `onStatusChange(callback)` registers listeners; status changes emit to all registered callbacks.
- [x] Credential resolution: sensitive env vars read from `secretStorage.get(mcpEnvSecretKey(...))` at connection time; sensitive headers from `secretStorage.get(mcpHeaderSecretKey(...))`.

### ARCH-003: McpHub tool discovery and callTool
**Description:** Extend McpHub with tool discovery (`tools/list`) after successful handshake, `callTool()` with `_meta.notor_mode` injection, text-only result extraction, refresh tools, and `getAllDiscoveredTools()`. This completes the McpHub contract from `contracts/mcp-connection-lifecycle.md`.
**FRs:** FR-56, FR-58, FR-59
**Files:**
- `src/mcp/mcp-hub.ts` — add `callTool()`, `refreshTools()`, `getAllDiscoveredTools()`, private `discoverTools()`, private `extractToolResult()`
**Dependencies:** ARCH-002
**Acceptance Criteria:**
- [x] After successful `initialize` handshake, `discoverTools()` sends `tools/list` and parses response into `McpDiscoveredTool[]` stored on the connection
- [x] If `tools/list` fails, server is marked connected with warning (tools array empty, error message set). Does not block connection.
- [x] `callTool(serverName, toolName, args, mode)` sends `tools/call` with `_meta: { notor_mode: mode }` on every request per FR-58
- [x] `callTool()` respects per-server timeout (`config.timeout * 1000` ms). On timeout, request is cancelled, connection is NOT closed.
- [x] `extractToolResult()` extracts only `TextContent` items (concatenated with newlines). Counts and appends notices for omitted images/resources (e.g., `[1 image omitted]`). Returns `(empty result)` if no text content.
- [x] `callTool()` error handling per contract: server not connected → error ToolResult; tool not found → error; timeout → error; malformed response → error; transport error → error. All returned as `ToolResult`, never thrown.
- [x] `refreshTools(serverName)` re-queries `tools/list` for a connected server and updates `connection.tools`
- [x] `getAllDiscoveredTools()` returns `{ serverName, tool }[]` across all connected servers

### ARCH-004 [P]: McpRegisteredTool adapter
**Description:** Implement the `McpRegisteredTool` class that wraps an `McpDiscoveredTool` to implement Notor's `Tool` interface. This adapter enables MCP tools to be registered in the `ToolRegistry` alongside built-in tools. Includes namespaced naming (`{serverName}__{toolName}`), read/write classification logic, and the `execute()` method that delegates to `McpHub.callTool()`.
**FRs:** FR-56, FR-57, FR-59
**Files:**
- `src/mcp/mcp-tool-adapter.ts` — `McpRegisteredTool` class implementing `Tool` interface
**Dependencies:** ARCH-001, ARCH-003
**Acceptance Criteria:**
- [x] `McpRegisteredTool` implements `Tool` from `src/tools/tool.ts`
- [x] `name` property returns `{serverName}__{toolName}` (e.g., `my-db-server__query`)
- [x] `description` passes through from `McpDiscoveredTool.description`
- [x] `input_schema` passes through from `McpDiscoveredTool.inputSchema`, defaults to `{ type: "object" }` if undefined
- [x] `mode` property computed per classification precedence: user override in `toolClassifications` → `readOnlyHint === true` → default `"write"`
- [x] `execute(params)` delegates to `mcpHub.callTool(serverName, toolName, params, currentMode)` — obtains current mode from a mode accessor callback
- [x] Helper functions exported: `isMcpTool(name)` (checks for `__`), `parseMcpToolName(name)` (splits on first `__`)

### ARCH-005 [P]: Plugin lifecycle integration
**Description:** Wire McpHub into the plugin lifecycle in `main.ts`. Initialize McpHub on plugin load (async, non-blocking), register cleanup via `this.register()`, and extend `ToolRegistry` to support dynamic registration/unregistration of MCP tools.
**FRs:** FR-55, FR-56
**Files:**
- `src/main.ts` — initialize McpHub, register cleanup
- `src/tools/index.ts` — add `unregister(name)` method to `ToolRegistry`
**Dependencies:** ARCH-002, ARCH-004
**Acceptance Criteria:**
- [x] `ToolRegistry` gains an `unregister(name: string)` method that removes a tool by name
- [x] `main.ts` creates `McpHub` instance during `onload()` and calls `mcpHub.initialize()` without awaiting — plugin load is not blocked by MCP connections
- [x] Cleanup registered via `this.register(() => mcpHub.dispose())` — ensures all connections closed on unload
- [x] McpHub status change listener wired up to add/remove `McpRegisteredTool` instances in `ToolRegistry` when servers connect/disconnect
- [x] On server connect + tool discovery: tools are registered in `ToolRegistry` and `ToolDispatcher`
- [x] On server disconnect: tools are unregistered from `ToolRegistry` and `ToolDispatcher`
- [x] Plugin loads and unloads cleanly with 0 configured MCP servers (no errors, no regressions)

## Phase 2: Core Feature Implementation (Group B — Tool Registration & Dispatch)

### FEAT-001: Dispatcher integration for MCP tools
**Description:** Extend `ToolDispatcher` to recognize MCP tool names (containing `__`), resolve the target server and tool via `parseMcpToolName()`, and route MCP tool calls through the standard Plan/Act + auto-approve pipeline. This is the central wiring that makes MCP tools callable from the LLM.
**FRs:** FR-59
**Files:**
- `src/chat/dispatcher.ts` — extend `dispatch()` to handle MCP tools; import `isMcpTool`, `parseMcpToolName` from adapter
**Dependencies:** ARCH-004, ARCH-005
**Acceptance Criteria:**
- [x] `dispatch()` recognizes MCP tools via `isMcpTool(toolName)` — tool names containing `__`
- [x] MCP tool calls go through the same pipeline as built-in: Plan/Act check → pre-execution checks → auto-approve check → approval UI → execute → result
- [x] Write-classified MCP tools are blocked in Plan mode with error message: `"Tool '{name}' is write-only and blocked in Plan mode. Switch to Act mode to use this tool."`
- [x] If MCP server is disconnected when tool is called, returns error ToolResult to LLM (does not crash)
- [x] Tool execution delegates to `McpRegisteredTool.execute()` (which calls McpHub.callTool internally)
- [x] All tool call events emitted correctly (onToolCallStarted, onToolCallResult, onToolCallStatusChanged)
- [x] Existing built-in tool dispatch is unaffected — no regressions

### FEAT-002: MCP auto-approve resolution
**Description:** Extend the auto-approve resolution chain to include MCP server-level per-tool auto-approve settings. The precedence is: persona override → MCP server per-tool → global default (require approval for all MCP tools).
**FRs:** FR-60
**Files:**
- `src/chat/dispatcher.ts` — `resolveMcpAutoApprove()` module-level function implements MCP precedence chain; `McpRegisteredTool.getServerConfig()` and `getRawToolName()` expose config for resolution
- `src/mcp/mcp-tool-adapter.ts` — added `getServerConfig()` and `getRawToolName()` accessor methods
**Dependencies:** FEAT-001
**Acceptance Criteria:**
- [x] For MCP tools, auto-approve precedence is: active persona override → `McpServerConfig.autoApprove` array → default `false` (require approval)
- [x] Persona override values: `"approve"` → auto-approve, `"deny"` → require approval, `"global"` or absent → fall through to server-level
- [x] Server-level: if raw tool name (without namespace) is in `config.autoApprove[]` → auto-approve
- [x] Global default: all newly discovered MCP tools require manual approval
- [x] Changes to auto-approve settings take effect on next dispatch (no reload required)
- [x] Built-in tool auto-approve resolution unchanged — no regressions

### FEAT-003: Orchestrator and system prompt integration
**Description:** Ensure MCP tools are included in the `getToolDefinitions()` callback used by `ChatOrchestrator` and `SystemPromptBuilder`. MCP tools must appear alongside built-in tools in the tool definitions sent to the LLM.
**FRs:** FR-56, FR-59
**Files:**
- `src/chat/orchestrator.ts` — verified: `setGetToolDefinitions()` callback calls `toolRegistry.getToolDefinitions()` which includes MCP tools automatically (no changes required)
- `src/chat/system-prompt.ts` — verified: `buildToolDefinitionsSection()` renders all tool definitions uniformly (no changes required)
**Dependencies:** FEAT-001
**Acceptance Criteria:**
- [x] `getToolDefinitions()` returns both built-in and MCP tools in a single array
- [x] MCP tool definitions include namespaced name (`server__tool`), description, and input_schema
- [x] System prompt tool section renders MCP tools in the same format as built-in tools — AI cannot distinguish between them
- [x] When MCP servers connect/disconnect mid-conversation, the next LLM call uses the updated tool set
- [x] No performance degradation with up to 10 servers × ~10 tools each = ~100 additional tool definitions

### FEAT-004 [P]: Dynamic tool registry updates
**Description:** Implement the dynamic registration/unregistration flow that fires when MCP servers connect, disconnect, or have their tools refreshed. Ensure the tool registry and dispatcher stay in sync with McpHub's connection state.
**FRs:** FR-56
**Files:**
- `src/chat/dispatcher.ts` — added `unregisterTool(name)` method to `ToolDispatcher`
- `src/main.ts` — fixed disconnect handler to call both `toolRegistry.unregister()` and `toolDispatcher.unregisterTool()`
**Dependencies:** ARCH-005, FEAT-001
**Acceptance Criteria:**
- [x] When a server connects and tools are discovered, `McpRegisteredTool` instances are created and registered in both `ToolRegistry` and `ToolDispatcher`
- [x] When a server disconnects, all its tools are unregistered from `ToolRegistry` and `ToolDispatcher`
- [x] When `refreshTools()` is called and the tool list changes, stale tools are removed and new tools are added
- [x] User-configured `toolClassifications` and `autoApprove` entries are preserved for tools that still exist after refresh
- [x] No duplicate registrations if a server reconnects with the same tool set

### FEAT-005 [P]: MCP tool display name formatting
**Description:** In the chat UI, display MCP tool names in the friendlier `server/tool` format for human readability, while the LLM and registry continue to use the `server__tool` format. Add the `getWriteToolDescription()` mapping for MCP tools.
**FRs:** FR-62
**Files:**
- `src/ui/tool-call-ui.ts` — added `formatToolDisplayName()` exported helper; `renderToolCallCard()` uses it for display
- `src/chat/dispatcher.ts` — `getWriteToolDescription()` already returns generic fallback `"perform write operations"` for unknown (including MCP) tools
**Dependencies:** FEAT-001
**Acceptance Criteria:**
- [x] Tool call UI displays MCP tools as `server/tool` (e.g., `my-db-server/query`) instead of `my-db-server__query`
- [x] Tool parameters displayed as formatted key-value pairs (arbitrary content from MCP tools handled gracefully)
- [x] Tool results displayed as preformatted text with existing truncation-with-expansion for large results
- [x] `getWriteToolDescription()` returns `"perform write operations"` for MCP tools (generic fallback)
- [x] Approval UI for MCP tools is identical to built-in tools — approve/reject prompt inline

## Phase 3: Integration & UI (Groups C + D + E — Auto-Approve, Settings UI, Chat Panel)

### INT-001: MCP servers settings section — server list and add form
**Description:** Implement the "MCP servers" section in **Settings → Notor** with the server list (name, transport, status indicator, enable/disable toggle) and the "Add server" form (transport type selector, transport-specific fields, server name validation/auto-slugification, trust warnings). This is the primary user-facing configuration surface for MCP.
**FRs:** FR-54, FR-61
**Files:**
- `src/settings/sections/mcp-servers.ts` — new settings section component
- `src/settings/settings-tab.ts` — register MCP servers section
- `styles.css` — styles for server list, status indicators, trust warning banners
**Dependencies:** ARCH-002 (McpHub for connection status), FEAT-001 (dispatch wired)
**Acceptance Criteria:**
- [x] "MCP servers" section appears in **Settings → Notor**
- [x] Server list displays all configured servers with: name, transport type, connection status indicator (green/yellow/grey/red dot), enable/disable toggle
- [x] "Add server" button opens form with transport type selector (`stdio` / `sse` / `streamableHttp`)
- [x] Transport-specific fields shown/hidden based on selection:
  - stdio: command (required), arguments, working directory, environment variables
  - sse: URL (required), headers
  - streamableHttp: URL (required), headers
- [x] Server name auto-slugified on input (trim, lowercase, spaces→hyphens). Validated against `MCP_SERVER_NAME_REGEX`, max 50 chars. Uniqueness checked against existing servers.
- [x] Trust warning displayed on add: "Custom MCP tools run outside Notor's built-in safety guarantees. Only add servers you trust."
- [x] Additional stdio warning: "This will spawn a local process on your machine with your user permissions."
- [x] On mobile, stdio option hidden or shows informational message per FR-54
- [x] Saving a new server config triggers `McpHub.connectServer()` if enabled

### INT-002: MCP servers settings — server detail view and per-tool settings
**Description:** Implement the expandable per-server detail view showing editable config fields, remove button, and the "Tools" sub-section listing discovered tools with read/write classification and auto-approve controls. Includes the "Refresh tools" button.
**FRs:** FR-57, FR-60, FR-61
**Files:**
- `src/settings/sections/mcp-servers.ts` — expand with server detail view, tool list rendering, per-tool controls
- `styles.css` — styles for tool list, classification dropdown, auto-approve toggles
**Dependencies:** INT-001
**Acceptance Criteria:**
- [x] Each server entry expandable to show: editable config fields, enable/disable toggle, "Remove" button (with confirmation prompt)
- [x] After connection, "Tools" sub-section lists discovered tools with: tool name, description, read/write classification dropdown ("Read-only" / "Write"), auto-approve toggle
- [x] Classification dropdown shows server-reported default and highlights user override. Advisory note: "Server-reported hints are not verified. Your override takes precedence."
- [x] Auto-approve toggle per tool — defaults to off for all newly discovered tools
- [x] "Refresh tools" button re-queries `tools/list` via `McpHub.refreshTools()` and updates the tool list display
- [x] Error state: if server is errored, error message displayed inline with suggestion to check config or toggle off/on
- [x] Classification and auto-approve changes persisted to `McpServerConfig` via `saveData()` immediately

### INT-003: Sensitive credential management in settings UI
**Description:** Implement the per-environment-variable and per-header "sensitive" toggle in the settings UI. Sensitive values are stored/retrieved via Obsidian's `SecretStorage` API; non-sensitive values remain in plain-text settings. Includes the secrets read/write flow at save time and the credential display masking in the UI.
**FRs:** FR-54, NFR-15
**Files:**
- `src/settings/sections/mcp-servers.ts` — add sensitive toggles to env var and header input rows
- `src/mcp/mcp-hub.ts` — credential resolution already implemented in ARCH-002, verify integration
**Dependencies:** INT-001, ARCH-002
**Acceptance Criteria:**
- [x] Each env var row has: key input, value input, "Sensitive" toggle
- [x] Each header row has: key input, value input, "Sensitive" toggle
- [x] When "Sensitive" is toggled on and value is saved, value is written to `SecretStorage` with key format `mcp_env_{serverName}_{key}` or `mcp_header_{serverName}_{key}`
- [x] Sensitive values in settings JSON stored as empty string `""` (placeholder)
- [x] When settings UI loads, sensitive values are read from `SecretStorage` and populated in the input fields (masked display)
- [x] When "Sensitive" is toggled off, value is moved from `SecretStorage` back to plain-text settings

### INT-004 [P]: Persona auto-approve UI extension for MCP tools
**Description:** Extend the persona auto-approve settings UI to include MCP tools alongside built-in tools. When MCP servers are connected and tools are discovered, those tools appear in the persona auto-approve tool list with the namespaced name.
**FRs:** FR-60
**Files:**
- `src/personas/auto-approve-resolver.ts` — no changes needed (FEAT-002 covers logic)
- `src/settings/sections/persona-auto-approve.ts` (or equivalent) — add MCP tools to the per-persona tool list
**Dependencies:** FEAT-002, INT-002
**Acceptance Criteria:**
- [x] Persona auto-approve UI lists MCP tools (namespaced `server__tool` format) alongside built-in tools
- [x] MCP tools grouped visually by server name for readability
- [x] Per-persona override options: "Global" (use server-level setting), "Auto-approve", "Require approval"
- [x] Stale MCP tools (server disconnected or tool removed) shown with a warning indicator per FR-40 pattern

### INT-005 [P]: Chat panel MCP status indicator and popover
**Description:** Add an MCP status indicator to the chat panel header area (visible only when ≥1 MCP server is configured). Clicking it opens a popover listing all configured servers with status dots, enable/disable toggles, and brief error summaries. Indicator shows healthy/warning state at a glance.
**FRs:** FR-63
**Files:**
- `src/ui/chat-view.ts` — add MCP status indicator icon/badge to chat panel header; implement popover component
- `styles.css` — styles for status indicator, popover, status dots, toggle switches
**Dependencies:** ARCH-002 (McpHub status), FEAT-001 (dispatch wired)
**Acceptance Criteria:**
- [x] MCP status indicator visible in chat panel header when ≥1 MCP server is configured. Hidden when no servers configured.
- [x] Indicator state: normal/healthy (all enabled servers connected) vs. warning (any enabled server errored/disconnected)
- [x] Click opens popover listing all configured servers with: name, colored status dot (green=connected, yellow=connecting, grey=disconnected, red=error), enable/disable toggle
- [x] Enable/disable toggle synced with Settings — toggling updates `McpServerConfig.disabled` and triggers connect/disconnect immediately
- [x] Error state: brief error summary shown next to status dot (e.g., "command not found"). Full error in Settings.
- [x] Popover reflects real-time status changes while open (McpHub `onStatusChange` events update the UI)

### INT-006 [P]: Settings UI styles and trust warning polish
**Description:** Final styling pass for all MCP-related settings UI elements — trust warning banners, status indicator colors, server list layout, tool list formatting, error states, mobile responsiveness. Ensure visual consistency with existing Notor settings sections.
**FRs:** FR-61, FR-63
**Files:**
- `styles.css` — comprehensive MCP-related styles
**Dependencies:** INT-001, INT-002, INT-005
**Acceptance Criteria:**
- [x] Trust warning banners styled prominently (e.g., yellow/amber background, warning icon) — not dismissible
- [x] Status dots use consistent colors: green (#4caf50), yellow (#ff9800), grey (#9e9e9e), red (#f44336)
- [x] Server list layout clean and scannable — name, transport badge, status dot, toggle aligned in a row
- [x] Tool list indented under server, with classification dropdown and auto-approve toggle aligned
- [x] Error messages styled distinctly (red text or error banner) with clear call-to-action
- [x] Mobile: form fields stack vertically, toggles remain accessible, no horizontal overflow

## Phase 4: Quality & Testing

### TEST-001: E2E test — stdio MCP server lifecycle
**Description:** Create an e2e test script that validates the primary stdio MCP server flow end-to-end: add server config → connect → tool discovery → tool invocation (with approval) → result display → disconnect → reconnect via toggle. Uses the `@modelcontextprotocol/server-filesystem` or a lightweight test MCP server.
**FRs:** FR-54, FR-55, FR-56, FR-59
**Files:**
- `e2e/scripts/mcp-stdio-test.ts` — e2e test script for stdio server lifecycle
- `e2e/scripts/setup-vault.ts` — extend vault setup to include MCP server config if needed
**Dependencies:** All Phase 1–3 tasks
**Acceptance Criteria:**
- [ ] Test configures a stdio MCP server (e.g., filesystem server pointed at a temp directory)
- [ ] Verify server connects successfully and status shows "Connected"
- [ ] Verify tools are discovered and appear in the tool registry
- [ ] Verify a tool call (e.g., `list_directory`) goes through approval UI → execution → result returned to LLM
- [ ] Verify server disconnect (kill process) → status shows "Disconnected" → toggle off/on → reconnects
- [ ] Verify Plan mode blocks write-classified MCP tools
- [ ] Verify Act mode allows write-classified MCP tools with approval
- [ ] Test covers error scenarios: invalid command → "Error" status with message; timeout → error ToolResult

### TEST-002 [P]: E2E test — HTTP MCP server and chat panel status
**Description:** Create an e2e test script that validates HTTP transport (SSE or Streamable HTTP) MCP server flow and the chat panel MCP status indicator/popover.
**FRs:** FR-55, FR-62, FR-63
**Files:**
- `e2e/scripts/mcp-http-test.ts` — e2e test script for HTTP server + status indicator
**Dependencies:** All Phase 1–3 tasks
**Acceptance Criteria:**
- [ ] Test configures an HTTP-based MCP server (SSE or Streamable HTTP)
- [ ] Verify connection, tool discovery, and tool invocation work over HTTP
- [ ] Verify chat panel MCP status indicator is visible when ≥1 server configured
- [ ] Verify status indicator shows healthy state when all servers connected, warning when any errored
- [ ] Verify popover opens on click, lists servers with correct status dots
- [ ] Verify enable/disable toggle in popover works and syncs with Settings
- [ ] Verify MCP tool calls displayed in chat with `server/tool` format
- [ ] Verify tool parameters and results rendered correctly (key-value pairs, preformatted text)

### TEST-003 [P]: E2E test — auto-approve and persona overrides for MCP tools
**Description:** Create an e2e test script that validates MCP tool auto-approve settings and persona override interactions.
**FRs:** FR-60
**Files:**
- `e2e/scripts/mcp-auto-approve-test.ts` — e2e test for MCP auto-approve flows
**Dependencies:** FEAT-002, INT-004
**Acceptance Criteria:**
- [ ] Test configures MCP server with auto-approve enabled for one tool, disabled for another
- [ ] Verify auto-approved tool executes without approval prompt
- [ ] Verify non-auto-approved tool shows approval UI
- [ ] Test configures persona with MCP tool overrides (approve one, deny another)
- [ ] Verify persona override takes precedence over server-level auto-approve
- [ ] Verify stale tool handling: disconnect server → auto-approve entries preserved with warning

### PERF-001 [P]: Performance and reliability validation
**Description:** Validate NFR-14 (performance), NFR-15 (security), and NFR-16 (reliability) requirements through manual and automated testing.
**FRs:** NFR-14, NFR-15, NFR-16
**Files:**
- Manual testing against quickstart.md scenarios
**Dependencies:** All Phase 1–3 tasks
**Acceptance Criteria:**
- [ ] Plugin `onload()` completes without waiting for MCP connections — chat panel usable immediately
- [ ] Tool dispatch overhead ≤ 50 ms beyond MCP server response time (measured via logs)
- [ ] 10 concurrent MCP servers configured — no perceptible UI degradation
- [ ] stdio process spawning completes within 10 seconds; handshake timeout at 30 seconds works correctly
- [ ] Single MCP server crash does not affect built-in tools, other MCP servers, or active conversation
- [ ] Malformed MCP server response → error ToolResult (not plugin crash)
- [ ] Plugin unload cleanly terminates all MCP connections and child processes — no zombie processes
- [ ] stdio transport guarded behind `Platform.isDesktopApp` — not available on mobile
- [ ] Sensitive credentials stored in SecretStorage, not in plain-text `data.json`
- [ ] Trust warnings non-dismissible — appear every time a new server is added

## Phase 5: Documentation & Final Validation

### DOC-001: Update quickstart and spec documentation
**Description:** Update quickstart.md with final testing instructions based on the implemented feature. Verify all spec cross-references are accurate. Update architecture documentation if any deviations from plan occurred during implementation.
**Files:**
- `specs/04-mcp/quickstart.md` — update testing instructions, add any discovered gotchas
- `design/architecture.md` — add MCP subsystem to architecture overview if not already present
- `design/tools.md` — add MCP tool classification documentation
**Dependencies:** All Phase 0–4 tasks
**Acceptance Criteria:**
- [ ] quickstart.md testing instructions match actual implementation
- [ ] All file paths in quickstart.md, plan.md, and spec.md are accurate
- [ ] architecture.md updated with MCP subsystem overview (McpHub, transport layer, tool adapter)
- [ ] tools.md updated with MCP tool classification behavior (default write, readOnlyHint override, user override)

### VAL-001: Final end-to-end validation against specification
**Description:** Systematic walkthrough of all spec.md user scenarios and success criteria. Verify every FR and NFR is satisfied. Run through the primary flows, alternative flows, and edge cases documented in spec.md.
**Files:**
- Validation against spec.md scenarios
**Dependencies:** DOC-001
**Acceptance Criteria:**
- [ ] **SC-1:** Users can register and connect stdio + HTTP MCP servers from Settings without plugin reload
- [ ] **SC-2:** MCP tools appear alongside built-in tools — AI discovers, invokes, and receives results identically
- [ ] **SC-3:** Write-classified MCP tools blocked in Plan mode; `_meta.notor_mode` sent on every `tools/call`; classification overridable per-tool
- [ ] **SC-4:** MCP tools go through same auto-approve + approval flow as built-in; persona overrides apply
- [ ] **SC-5:** Trust warnings displayed on server add; stdio spawning warning shown; warnings non-dismissible
- [ ] **SC-6:** Single server failure isolated — no impact on built-in tools, other servers, or conversation
- [ ] **SC-7:** Plugin startup not degraded — MCP connections async, chat panel usable immediately
- [ ] All primary flows from spec.md user scenarios pass (stdio server, HTTP server, classification/auto-approve, persona overrides)
- [ ] All alternative flows pass (connection failure, mid-conversation disconnect, tool discovery failure, stdio on mobile)
- [ ] All edge cases pass (cooperative Plan/Act signaling, tool list changes on reconnect, name collision prevention, timeout)
