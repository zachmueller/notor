# Research: Phase 4.1 — Custom MCP Servers

**Created:** 2026-09-03
**Status:** Complete (R-1), Pending measurement (R-2)

## R-1: MCP Server Integration and Plan/Act State Signaling

**Status:** ✅ Complete
**Output:** [design/research/mcp-server-integration.md](../../design/research/mcp-server-integration.md)
**Completed:** 2026-09-03

### Summary

Comprehensive research covering the full MCP integration surface for Notor. The research was conducted as a pre-phase task and covers:

1. **MCP protocol overview** — JSON-RPC 2.0 wire format, `initialize` handshake, `tools/list` and `tools/call` methods
2. **Transport mechanisms** — stdio (desktop-only, most common), SSE (legacy HTTP), Streamable HTTP (current standard)
3. **Electron/Node.js constraints** — confirmed `child_process.spawn()` works in Obsidian plugins (proven by `execute_command`); mobile lacks Node.js APIs (stdio unavailable)
4. **Implementation architecture** — lessons from Cline's McpHub pattern, tool discovery, tool invocation, uniform dispatch pipeline
5. **Configuration design** — plugin settings storage, per-server config structure, settings UI requirements
6. **Tool schema discovery** — `tools/list` response shape, `ToolAnnotations` for read/write hints
7. **Plan/Act state signaling** — evaluated four approaches; recommended `_meta.notor_mode` (Approach A) as protocol-compliant, per-invocation, ignorable
8. **Process lifecycle management** — connection lifecycle, cleanup registration, reconnection strategy
9. **Trust and safety** — cooperative trust model, required warnings, desktop-only guards

### Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| MCP SDK | `@modelcontextprotocol/sdk` v1.25+ | Official SDK; pure TypeScript; provides transports, JSON-RPC, schema validation |
| Transports | All three (stdio, SSE, Streamable HTTP) | stdio for majority of community servers; HTTP for remote/mobile |
| Config storage | Plugin settings (`data.json`) | Consistent with all other Notor settings; no file-watcher needed |
| Tool dispatch | Uniform pipeline (same as built-in tools) | MCP tools go through Plan/Act + auto-approve checks identically |
| Read/write classification | Default from `ToolAnnotations.readOnlyHint`; user-overridable | Server hints are unverified; user override is authoritative |
| Plan/Act signaling | `_meta.notor_mode` on `tools/call` | Protocol-compliant; per-invocation; ignorable by non-supporting servers |
| Process lifecycle | `this.register()` cleanup; manual reconnect for stdio; auto-reconnect for HTTP | Consistent with Obsidian plugin lifecycle; stdio re-spawn requires user awareness |
| Trust model | Cooperative with clear UI warnings | No enforcement beyond Notor's own Plan/Act gate; user responsible for trusting servers |
| OAuth | Deferred to future iteration | Most community servers use API keys or no auth; static bearer tokens via headers sufficient |

---

## R-2: MCP SDK Bundle Size Impact

**Status:** ⬜ Pending (to be measured during implementation)

### Research Question

What is the actual bundle size impact of adding `@modelcontextprotocol/sdk` to Notor's `main.js`?

### Context

The MCP SDK is a pure TypeScript/JavaScript package with no native modules. Notor already bundles substantial dependencies (AWS SDK for Bedrock, Turndown for HTML conversion). The SDK's client-side code (transports + protocol handling) is expected to be lightweight. Server-side code should be eliminated by esbuild tree-shaking.

### Measurement Plan

1. Record current `main.js` bundle size (raw and gzipped) before adding the SDK
2. Add `@modelcontextprotocol/sdk` as a dependency and import only client-side modules
3. Build with `npm run build` and measure the new bundle size
4. Calculate the delta

### Success Criteria

- Bundle size increase ≤ 150 KB gzipped → proceed as planned
- Bundle size increase 150–300 KB gzipped → acceptable but investigate selective imports
- Bundle size increase > 300 KB gzipped → consider extracting only transport + JSON-RPC code instead of the full SDK

### Fallback

If the SDK is too large, the transport and JSON-RPC protocol handling can be implemented directly (~500–800 lines of code). The SDK's transport classes are relatively thin wrappers around `child_process.spawn()`, `EventSource`, and `fetch()`.
