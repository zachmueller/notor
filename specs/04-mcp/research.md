# Research: Phase 4.1 — Custom MCP Servers

**Created:** 2026-09-03
**Status:** Complete (R-1, R-2)

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

**Status:** ✅ Complete
**Completed:** 2026-09-03

### Research Question

What is the actual bundle size impact of adding `@modelcontextprotocol/sdk` to Notor's `main.js`?

### Methodology

1. Recorded baseline `main.js` bundle size (raw and gzipped) with `npm run build` (production, minified, tree-shaking enabled)
2. Installed `@modelcontextprotocol/sdk@1.27.1` as a dependency
3. Created a test file importing only client-side modules actually needed by Notor: `Client`, `StdioClientTransport`, `SSEClientTransport`, `StreamableHTTPClientTransport`, and type imports for `CallToolResult`, `Tool`, `ListToolsResult`
4. Added a call site in `main.ts` to prevent esbuild from tree-shaking the imports
5. Built with `npm run build` and measured the new bundle size
6. Used esbuild metafile analysis to break down the size contribution by package
7. Cleaned up all test artifacts and verified the build returned to baseline

### Results

| Metric | Baseline (no SDK) | With SDK | Delta | % Increase |
|---|---|---|---|---|
| Raw `main.js` | 1,344 KB | 2,044 KB | **+700 KB** | +52% |
| Gzipped `main.js` | 354 KB | 521 KB | **+166 KB** | +47% |

### Bundle Size Breakdown by Package

Source bytes pulled into the bundle by esbuild metafile analysis:

| Package | Source Bytes | Notes |
|---|---|---|
| `zod` | 720 KB | Schema validation library; SDK's largest transitive dependency. Pulls in v3 + v4 modules. |
| `@modelcontextprotocol/sdk` | 485 KB | SDK core: types (73 KB), protocol (51 KB), client auth (39 KB), client index (30 KB), streamableHttp transport (22 KB), plus others |
| `ajv-formats` | 230 KB | JSON Schema format validators (used by SDK's validation layer). Includes its own ajv copy. |
| `zod-to-json-schema` | 54 KB | Zod-to-JSON-Schema converter |
| `eventsource` | 15 KB | SSE polyfill for Node.js |
| `cross-spawn` | 9 KB | Cross-platform process spawning (used by StdioClientTransport) |
| `eventsource-parser` | 4 KB | SSE stream parser |
| `pkce-challenge` | 3 KB | PKCE for OAuth (pulled in despite OAuth being unused; not tree-shaken) |

**Total MCP-related source input:** ~1,520 KB → minified output delta: ~700 KB raw / ~166 KB gzipped.

### Evaluation Against Success Criteria

- ~~Bundle size increase ≤ 150 KB gzipped → proceed as planned~~
- **Bundle size increase 150–300 KB gzipped → acceptable but investigate selective imports** ← **Result: 166 KB gzipped**
- ~~Bundle size increase > 300 KB gzipped → consider extracting only transport + JSON-RPC code instead of the full SDK~~

**Verdict: Acceptable.** The 166 KB gzipped increase is at the low end of the "acceptable but investigate selective imports" range. The largest contributors are `zod` (720 KB source) and `ajv-formats` (230 KB source) — neither is directly used by Notor, both are transitive dependencies of the SDK's validation and schema layers.

### Recommendations

1. **Proceed with `@modelcontextprotocol/sdk` as planned.** The 166 KB gzipped increase is acceptable for the functionality gained. Notor already bundles the AWS SDK for Bedrock (dynamically imported), making the total plugin size comparable to other feature-rich community plugins.

2. **Investigate selective imports during implementation.** The SDK's `Client` class currently imports from the validation layer (`ajv-provider.js`) and server-side utilities (`zod-compat.js`) at the module level, which pulls in `zod` and `ajv-formats` even though Notor doesn't use schema validation directly. If the SDK restructures its imports in a future version to make validation opt-in, the bundle could drop by ~200 KB+ gzipped.

3. **Monitor SDK updates.** The MCP SDK is actively maintained. Future versions may improve tree-shaking boundaries (e.g., separating validation from the client core). Track releases for size-reduction opportunities.

4. **Fallback remains available.** If bundle size becomes a concern (e.g., due to Obsidian community plugin size guidelines), the transport and JSON-RPC protocol handling can still be implemented directly (~500–800 lines). The SDK's transport classes are thin wrappers around `child_process.spawn()`, `EventSource`, and `fetch()`.

### Key Finding: Tree-Shaking Limitation

esbuild's tree-shaking eliminated server-side SDK code (express, hono, cors, etc. were **not** bundled), but could not eliminate the SDK client's internal imports of `zod` and `ajv-formats` because the `Client` class has module-level imports to the validation layer. This is a known limitation of CJS module bundling — side-effect-laden `require()` chains prevent full tree-shaking. The SDK's ESM build fared similarly because the `Client` constructor references the AJV validation provider unconditionally.
