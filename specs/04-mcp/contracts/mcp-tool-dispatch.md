# Contract: MCP Tool Call Dispatch

**Created:** 2026-09-03
**Specification:** [specs/04-mcp/spec.md](../spec.md)
**Data Model:** [specs/04-mcp/data-model.md](../data-model.md)

---

## Overview

Defines how MCP tool calls are identified, routed through the dispatch pipeline, executed against MCP servers, and returned to the LLM. MCP tools go through the same pipeline as built-in tools — Plan/Act enforcement, auto-approve checks, approval UI, execution, and result formatting.

---

## Tool Name Parsing

### Identifying MCP Tools

A tool call is identified as an MCP tool when the tool name contains `__` (double underscore):

```typescript
function isMcpTool(toolName: string): boolean {
  return toolName.includes("__");
}
```

### Extracting Server and Tool Name

Split on the **first** `__` occurrence:

```typescript
function parseMcpToolName(namespacedName: string): { serverName: string; toolName: string } {
  const idx = namespacedName.indexOf("__");
  return {
    serverName: namespacedName.substring(0, idx),
    toolName: namespacedName.substring(idx + 2),
  };
}
```

**Example:** `my-db-server__query` → `{ serverName: "my-db-server", toolName: "query" }`

---

## Dispatch Pipeline

When the LLM requests a tool call, the dispatcher follows this sequence:

### Step 1: Identify Tool Type

```
Is tool name in built-in registry?
  → Yes: dispatch as built-in tool (existing pipeline)
  → No: does tool name contain "__"?
    → Yes: dispatch as MCP tool (this contract)
    → No: return error to LLM ("Unknown tool: {name}")
```

### Step 2: Resolve MCP Target

```typescript
const { serverName, toolName } = parseMcpToolName(requestedToolName);
const connection = mcpHub.getConnection(serverName);

// Check server exists and is connected
if (!connection) {
  return { success: false, output: `MCP server '${serverName}' is not configured.` };
}
if (connection.status !== "connected") {
  return { success: false, output: `MCP server '${serverName}' is unavailable (${connection.status}).` };
}
```

### Step 3: Plan/Act Mode Check

```typescript
const toolMode = mcpRegisteredTool.mode; // "read" or "write"
const conversationMode = conversation.getMode(); // "plan" or "act"

if (conversationMode === "plan" && toolMode === "write") {
  return {
    success: false,
    output: `Tool '${requestedToolName}' is write-only and blocked in Plan mode. Switch to Act mode to use this tool.`,
  };
}
```

### Step 4: Auto-Approve Check

Follow the precedence chain (see [data-model.md](../data-model.md) — Auto-Approve Precedence Chain):

1. Persona override → 2. Server-level per-tool → 3. Global default (require approval)

```typescript
if (isAutoApproved(requestedToolName, activePersona, serverConfig)) {
  // Proceed to execution
} else {
  // Show approval UI; wait for user response
  const approved = await requestApproval(requestedToolName, toolArguments);
  if (!approved) {
    return { success: false, output: "Tool call rejected by user." };
  }
}
```

### Step 5: Execute Tool Call

```typescript
const result = await mcpHub.callTool(serverName, toolName, toolArguments, conversationMode);
```

### Step 6: Return Result to LLM

The `ToolResult` from McpHub.callTool() is returned to the LLM in the same format as built-in tool results.

---

## McpHub.callTool() Contract

### Request

Sends a `tools/call` JSON-RPC request to the target MCP server:

```typescript
async callTool(
  serverName: string,
  toolName: string,
  toolArguments: Record<string, unknown> | undefined,
  mode: "plan" | "act"
): Promise<ToolResult> {
  const connection = this.getConnection(serverName);
  
  const result = await connection.client.request(
    {
      method: "tools/call",
      params: {
        name: toolName,
        arguments: toolArguments ?? {},
        _meta: {
          notor_mode: mode,
        },
      },
    },
    CallToolResultSchema,
    { timeout: connection.config.timeout * 1000 }
  );

  return this.extractToolResult(result);
}
```

### `_meta` Injection

Every `tools/call` request includes `_meta.notor_mode`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "query",
    "arguments": { "sql": "SELECT * FROM users LIMIT 10" },
    "_meta": {
      "notor_mode": "act"
    }
  }
}
```

- **Always present**: `_meta.notor_mode` is included on every `tools/call` request, regardless of mode.
- **Not configurable**: there is no setting to disable Plan/Act signaling.
- **Values**: `"plan"` or `"act"` — matches the current conversation mode.

### Response Processing

```typescript
private extractToolResult(result: CallToolResult): ToolResult {
  const textParts: string[] = [];
  let omittedImages = 0;
  let omittedResources = 0;

  for (const item of result.content) {
    if (item.type === "text") {
      textParts.push(item.text);
    } else if (item.type === "image") {
      omittedImages++;
    } else if (item.type === "resource") {
      omittedResources++;
    }
  }

  let output = textParts.join("\n");

  // Append omission notices
  const omissions: string[] = [];
  if (omittedImages > 0) {
    omissions.push(`${omittedImages} image${omittedImages > 1 ? "s" : ""} omitted`);
  }
  if (omittedResources > 0) {
    omissions.push(`${omittedResources} resource${omittedResources > 1 ? "s" : ""} omitted`);
  }
  if (omissions.length > 0) {
    output += `\n[${omissions.join(", ")}]`;
  }

  return {
    success: !result.isError,
    output: output || "(empty result)",
  };
}
```

---

## Error Handling

All errors are returned to the LLM as `ToolResult` objects with `success: false` — they do not throw exceptions or crash the plugin.

| Error Condition | Output Message |
|---|---|
| Server not configured | `MCP server '{serverName}' is not configured.` |
| Server disconnected | `MCP server '{serverName}' is unavailable (disconnected).` |
| Server in error state | `MCP server '{serverName}' is unavailable (error: {errorMessage}).` |
| Tool not found on server | `Tool '{toolName}' not found on MCP server '{serverName}'.` |
| Request timeout | `Tool call to '{namespacedName}' timed out after {timeout} seconds.` |
| Server returned error | Pass through the server's error text with `success: false`. |
| Malformed response | `MCP server '{serverName}' returned an invalid response.` |
| Transport error | `MCP server '{serverName}' connection error: {errorMessage}.` |

---

## Timeout Behavior

- The timeout is configured per-server in `McpServerConfig.timeout` (default: 60 seconds).
- The timeout applies to the entire `tools/call` round-trip (request sent → response received).
- On timeout, the request is cancelled via the MCP SDK's abort mechanism.
- A timeout error `ToolResult` is returned to the LLM.
- The server connection is NOT closed on timeout — only the specific request is cancelled.
