# Phase 4d — Dynamic HTTP Headers for MCP Servers (`headersHelper`)

**Created:** 2026-10-20
**Status:** Draft
**Branch:** main
**Extends:** [04-mcp/spec.md](../04-mcp/spec.md) — FR-54, FR-55, FR-61

## Overview

Some HTTP MCP servers sit behind a login proxy (an OIDC-enforcing load balancer, oauth2-proxy, Cloudflare Access, IAP, …). Requests must carry a bearer token plus a short-lived session cookie that expires after a fixed number of hours. The fixed `headers` list from FR-54 can't keep up with credentials that rotate.

Phase 4d adds an optional per-server `headersHelper`: a shell command that Notor runs at connect time. It prints the headers to send as a JSON object on stdout. The contract matches Claude Code's documented `headersHelper`, so helper scripts written for Claude Code work in Notor unchanged.

This specification covers:

- **Configuration**: an optional `headersHelper` command on `sse` / `streamableHttp` servers.
- **Execution contract**: shell, timeout, environment, and output format.
- **Header precedence**: how helper headers merge with fixed headers.
- **Transport**: a Node-side fetch for servers whose headers the renderer would drop.
- **Refresh on auth failure**: detecting an expired session and re-running the helper.
- **Secret hygiene**: helper output never reaches logs, the UI, or `data.json`.

## Background: why the renderer fetch is not enough

A probe against Obsidian 1.14.4 (Electron 43, Chromium 150) established:

| Behaviour | Renderer `fetch` | Node `http`/`https` from the renderer |
|---|---|---|
| `Cookie` request header | Silently dropped (forbidden header name), even with `credentials: "include"` | Sent |
| `Authorization` / custom headers | Sent only after a CORS preflight from `app://obsidian.md`; no request at all if the server lacks CORS headers | Sent; no preflight |
| Cross-origin `302` (e.g. to an identity provider) | `TypeError: Failed to fetch` when followed; `opaqueredirect` with status 0 and no `Location` when `redirect: "manual"` | Raw `302` with its `Location` |
| SSE body streaming | Supported | Supported, by wrapping `IncomingMessage` in a WHATWG `ReadableStream` / `Response` |

Login-proxy sessions are almost always cookies, and an expired session is almost always a cross-origin redirect. Neither works through the renderer fetch. Obsidian's `requestUrl` buffers the whole response, so it can't carry the SSE stream.

## Functional requirements

### FR-180: `headersHelper` configuration

- `McpServerConfig` gains an optional `headersHelper?: string`. It is valid for `sse` and `streamableHttp` servers and ignored for `stdio`.
- Existing configurations keep working unchanged. No migration.
- The command string is stored in plugin settings, as stdio `command`/`args` are. It is a command, not a credential. The docs advise against putting secrets inline in the command.
- Settings UI (FR-61): a **Headers helper** text field in both the add-server form and the per-server detail view for HTTP servers, with a one-line description of the stdout contract.
  - On save the value is trimmed. Empty clears the field. A multi-line value is rejected with an inline error.
  - On mobile, the field carries a note that the helper only runs on the desktop app.
  - A **Test helper** button runs the helper once. It shows either the header **names** it returned or the error.

### FR-181: Execution contract

- **Shell:** the user's shell, `$SHELL -c <command>` (falling back to `/bin/sh`). On Windows, the platform default shell.
  - It is not a login shell, because profile output on stdout would corrupt the JSON.
  - `PATH` is set to the user's login-shell `PATH`, as for stdio servers, so tools installed via Homebrew, nvm, etc. resolve.
- **Working directory:** the vault root.
- **Environment:** the plugin's environment, plus:
  - `CLAUDE_CODE_MCP_SERVER_NAME`: the server's name;
  - `CLAUDE_CODE_MCP_SERVER_URL`: the server's URL;
  - `NOTOR_MCP_SERVER_NAME` / `NOTOR_MCP_SERVER_URL`: aliases with the same values.
- **Timeout:** 10 seconds. On expiry the process gets SIGTERM, then SIGKILL.
- **Output:** stdout must be exactly one JSON object whose values are all strings.
  - Header names must be valid HTTP header tokens. Values must not contain CR or LF.
  - Empty output, invalid JSON, a non-object (array, `null`, number, string), or a non-string value is an error.
- **Failure:** a non-zero exit, a timeout, or invalid output fails the connection attempt with a message.
  - The message may include an excerpt of the helper's **stderr**.
  - It must never include any part of **stdout**. In particular, `JSON.parse` error text is not surfaced, because V8 quotes the input in it.
- **Desktop only:** where a shell can't be spawned (mobile), the connection fails with `headersHelper requires the Obsidian desktop app.` This configuration error doesn't trigger the HTTP auto-reconnect loop.

### FR-182: Header precedence

- Request headers are built in this order, each layer overriding the one before:
  1. the SDK's per-request headers (`content-type`, `accept`, `mcp-session-id`, …);
  2. the fixed `headers` (FR-54, with sensitive values resolved from secret storage);
  3. the helper's headers.
- On a name clash (case-insensitive), the helper wins.

### FR-183: When the helper runs

- The helper runs on every connect and every reconnect: initial load, enable toggle, HTTP auto-reconnect (FR-55), and sleep/wake recovery.
- Notor doesn't cache helper output beyond the lifetime of one transport. Caching or renewing credentials across runs is the helper's job.
- Running the helper on a timer is out of scope.

### FR-184: Refresh on authentication failure

- For a server with a `headersHelper`, any HTTP response that looks like an expired session is an **auth failure**:
  - status `401` or `403`;
  - a `3xx` whose `Location` points to a different origin than the server URL.
- **On an auth failure:**
  - Notor discards the response body;
  - re-runs the helper, with concurrent failures sharing a single run;
  - retries the same request once with the new headers.
- **If the retry also fails auth**, or the helper fails:
  - the request fails with `Authentication failed after refreshing headers` (plus the helper error, if any). The proxy's redirect body is never parsed or shown;
  - a connected server is closed and moved to the `error` status, and enters the HTTP reconnect/backoff path (FR-55). Each reconnect re-runs the helper.
- Same-origin redirects are followed (at most five); they don't count as auth failures.

### Transport selection

- A server that has a `headersHelper`, or a fixed `Cookie` header, uses the Node-side fetch on desktop.
- All other HTTP servers keep the renderer fetch. Node `https` doesn't use Chromium's system proxy settings or the OS certificate store, and switching every server would risk breaking setups that work today.

## Non-functional requirements

### NFR-26: Secret hygiene for helper output

- Header **values** returned by the helper are never logged, displayed, or persisted. Logs record header **names** only, matching the existing `headerKeys` log.
- Nothing returned by the helper is written to `data.json`.
- Error messages may include helper stderr but never helper stdout.

## User scenarios

### Primary flow: Server behind a login proxy

1. The user adds a Streamable HTTP server at `https://mcp.example.com/mcp`, with **Headers helper** set to `~/bin/mcp-login-headers`.
2. On connect, the helper signs in or renews as needed and prints `{"Authorization":"Bearer test-token","Cookie":"_proxy_session=test-token"}`.
3. Notor connects with those headers, and the server's tools are discovered.
4. Hours later the proxy session expires, and the next `tools/call` gets a `302` to the identity provider.
5. Notor re-runs the helper, retries the call with the fresh cookie, and the call succeeds without the user noticing.

### Alternative flow: Helper fails

1. The helper exits 1 and writes `login required` to stderr.
2. The server shows `headersHelper failed (exit 1): login required` in the settings row and in the chat-panel status popover (FR-63).
3. HTTP auto-reconnect keeps retrying with backoff, re-running the helper each time.

## Out of scope

- OAuth and the SDK `authProvider` flow.
- Running the helper on a timer.
- Moving HTTP servers without a helper or `Cookie` header to the Node-side fetch.
