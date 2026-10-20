# Task Breakdown: Phase 4d — Dynamic HTTP Headers for MCP Servers

**Created:** 2026-10-20
**Specification:** [spec.md](spec.md)
**Status:** Complete

## Overview

The work is split into small, separately committable steps. Each core module comes with vitest unit tests next to it.

---

### HH-001 — Config field and helper runner
**Files:** `src/mcp/mcp-types.ts`, `src/mcp/headers-helper.ts`, `src/mcp/headers-helper.test.ts`
**Acceptance Criteria:**
- [x] `McpServerConfig.headersHelper?: string`
- [x] `parseHeadersHelperOutput()` validates per FR-181. Its errors never contain stdout.
- [x] `runHeadersHelper()` spawns the user's shell with the FR-181 env vars, a 10 s timeout, and the vault-root cwd. It has a desktop guard.
- [x] Tests: good JSON, non-object, non-string values, empty output, invalid JSON, CR/LF, non-zero exit (stderr excerpt, no stdout), timeout, env vars

### HH-002 — Node-side fetch
**Files:** `src/mcp/node-fetch.ts`, `src/mcp/node-fetch.test.ts`
**Acceptance Criteria:**
- [x] `FetchLike` built on `http`/`https.request`. It returns a WHATWG `Response` with a streaming body.
- [x] Sends `Cookie`. Honours `AbortSignal`. Returns redirects unfollowed.
- [x] Tests against a local `http.createServer`: echoed `Cookie`, incremental SSE, abort, raw `302`

### HH-003 — Auth-refresh fetch wrapper
**Files:** `src/mcp/auth-refresh-fetch.ts`, `src/mcp/auth-refresh-fetch.test.ts`
**Acceptance Criteria:**
- [x] Applies FR-182 precedence
- [x] FR-184: refresh on 401/403/cross-origin 3xx, retry once, single-flight helper, follow same-origin redirects, `onAuthFailure` after a second failure
- [x] Tests for each case, including that no redirect body leaks

### HH-004 — Hub wiring
**Files:** `src/mcp/mcp-hub.ts`, `src/mcp/mcp-hub-headers-helper.test.ts`
**Acceptance Criteria:**
- [x] `createStreamableHttpTransport` runs the helper on every connect. It selects the transport per spec § Transport selection.
- [x] `onAuthFailure` on a connected server → `error` status + `scheduleReconnect`
- [x] The desktop-only configuration error doesn't schedule a reconnect
- [x] Logger hygiene test: no header value reaches the logger

### HH-005 — Settings UI
**Files:** `src/settings/sections/mcp-servers.ts`
**Acceptance Criteria:**
- [x] **Headers helper** field in the add-server form and the HTTP server detail view, validated on save (FR-180)
- [x] **Test helper** button shows header names only, or the error

### HH-006 — Documentation
**Files:** `docs/mcp-servers.md`, `specs/04-mcp/spec.md` (cross-link)
**Acceptance Criteria:**
- [x] Short "Dynamic headers" section with the stdout contract, env vars, precedence, refresh behaviour, and a generic `mcp.example.com` example
