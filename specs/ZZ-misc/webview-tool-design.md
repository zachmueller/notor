# Web Viewer Integration Tool — Implementation Design

## Motivation

Notor's existing `fetch_webpage` tool fetches arbitrary URLs via HTTP and converts the HTML to Markdown. However, it cannot access:
- **JavaScript-rendered content** — SPAs, dynamically loaded pages, client-side rendered apps
- **Authenticated sessions** — pages where the user is logged in within Obsidian's Web Viewer
- **The page the user is actively looking at** — there's no bridge between "what's on screen" and what the LLM can see

Obsidian's built-in Web Viewer runs pages inside an **Electron `<webview>` tag**, which provides a `executeJavaScript()` bridge to extract rendered DOM content. This tool leverages that bridge to give the LLM read access to the active Web Viewer tab, plus basic navigation capabilities (click links, load URLs).

**Example use cases:**
- "Summarize the article I'm reading"
- "Extract the pricing table from this page"
- "Click through to the API documentation and find the rate limits"
- "What's on my dashboard right now?" (authenticated page)

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tool structure | Single tool with `action` parameter | Keeps tool count low; LLM sees one cohesive capability. Consistent with `manage_tags` pattern. |
| Actions | `read`, `click`, `navigate` | Covers content extraction + basic browsing. Full form-filling deferred to future iteration. |
| Content format | HTML → Markdown via Turndown | Preserves structure (headings, links, tables). Reuses existing Turndown pipeline from `fetch_webpage`. |
| Click targeting | Visible link text matching | Natural for LLM ("click 'Read More'"). No CSS selector knowledge needed. |
| Tab scope | Conversation-scoped leaf + active fallback | LLM gets a consistent dedicated leaf per conversation; `scope: "active"` lets it read the user's focused leaf on demand. Enables user multitasking. |
| Load timing | Smart readiness polling | Waits for `did-finish-load` + `document.readyState === 'complete'` polling. Handles SPAs better than simple delay. |
| Output size | Truncate at character limit | Reuses `fetch_webpage_max_output_chars` setting. Consistent behavior across web tools. |
| Webview discovery | Multi-strategy with fallbacks | Obsidian internals aren't public API; multiple lookup strategies guard against breaking changes. |
| Read metadata | URL + title + link list + content | Link list helps LLM plan navigation without parsing markdown. Small overhead, high utility. |
| Tool mode | `write` (click/navigate have side effects) | `read` is inherently safe but registered as write for simplicity. Can split later if Plan-mode read is needed. |
| Leaf targeting | `scope` parameter (`conversation` / `active`) | `conversation` uses a dedicated per-conversation leaf (created if needed); `active` reads whatever Web Viewer the user has focused. Allows multitasking. |

---

## Tool Schema

```typescript
name: "webview"
mode: "write"

description:
  "Interact with the active Obsidian Web Viewer tab. " +
  "Use action 'read' to get the current page content as Markdown with URL, title, and clickable links. " +
  "Use action 'click' to click a link by its visible text. " +
  "Use action 'navigate' to load a new URL in the Web Viewer."

input_schema: {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["read", "click", "navigate"],
      description: "The action to perform. 'read' extracts page content, 'click' clicks a link by text, 'navigate' loads a URL."
    },
    scope: {
      type: "string",
      enum: ["conversation", "active"],
      default: "conversation",
      description: "Which Web Viewer leaf to use. 'conversation' uses a dedicated leaf for this conversation (created if needed) — use this for autonomous browsing tasks. 'active' reads whatever Web Viewer the user currently has focused — use when the user says 'the page I'm looking at' or similar."
    },
    text: {
      type: "string",
      description: "For 'click' action: the visible text of the link to click (case-insensitive partial match)."
    },
    url: {
      type: "string",
      description: "For 'navigate' action: the URL to load in the Web Viewer."
    }
  },
  required: ["action"]
}
```

### Action: `read`

**Parameters:** `scope` (optional, default `"conversation"`) — use `"active"` when the user refers to the page they are currently viewing

**Returns:**
```json
{
  "url": "https://example.com/article",
  "title": "Article Title",
  "links": [
    { "text": "Home", "href": "https://example.com/" },
    { "text": "Next Page", "href": "https://example.com/article/2" }
  ],
  "content": "# Article Title\n\nThe markdown content of the page..."
}
```

**Behavior:**
1. Locate the active Web Viewer's `<webview>` element
2. Wait for page readiness (smart polling)
3. Extract `document.title`, `window.location.href` via `executeJavaScript`
4. Extract `document.documentElement.outerHTML` via `executeJavaScript`
5. Convert HTML → Markdown via Turndown (reusing existing singleton)
6. Extract link list: all `<a>` elements with href and visible text
7. Truncate content at character limit
8. Return structured result

### Action: `click`

**Parameters:** `text` (required) — visible link text to match

**Returns:**
```json
{
  "clicked": "Read More",
  "new_url": "https://example.com/full-article",
  "new_title": "Full Article"
}
```

**Behavior:**
1. Locate the active webview
2. `executeJavaScript` to find first `<a>` whose `innerText.trim()` contains the target text (case-insensitive)
3. If no match found, return error listing available links (helps LLM retry)
4. `.click()` the element
5. Wait for navigation/readiness
6. Return new URL + title as confirmation

### Action: `navigate`

**Parameters:** `url` (required) — URL to load

**Returns:**
```json
{
  "url": "https://example.com",
  "title": "Example Domain"
}
```

**Behavior:**
1. Validate URL format (http/https only)
2. Check domain denylist (reuse `isDomainBlocked` from `fetch-webpage.ts`)
3. Locate the active webview
4. Call `webview.loadURL(url)`
5. Wait for readiness
6. Return loaded URL + title

---

## Internal Architecture

### Webview Element Discovery

The core challenge: Obsidian's Web Viewer internals aren't part of the public plugin API. The `<webview>` element's location in the DOM and the view's internal properties may change across Obsidian versions.

**Multi-strategy approach (tried in order):**

```
Strategy A: DOM selector
  document.querySelector('.workspace-leaf-content[data-type="webviewer"] webview')
  ↓ if null
Strategy B: Workspace leaf iteration
  app.workspace.iterateAllLeaves() → find leaf where view.getViewType() === 'webviewer'
  → access (view as any).webview or (view as any).frame or (view as any).browser
  ↓ if null
Strategy C: Broad DOM query
  document.querySelector('webview')
  ↓ if null
Return null with error: "No Web Viewer tab found. Open a webpage in Obsidian's Web Viewer first."
```

Each fallback logs a warning so we can detect when the primary strategy breaks.

**Open question:** What is the actual `data-type` value for the Web Viewer leaf? Options include `"webviewer"`, `"web-viewer"`, `"browser"`, or something else. This needs runtime inspection in Obsidian to confirm.

### Smart Readiness Waiting

Pages don't always finish rendering when `did-finish-load` fires — SPAs often continue loading data asynchronously.

```
0. For scope: "conversation" leaves: call app.workspace.revealLeaf(leaf) first.
   Chromium throttles background/hidden tabs, causing did-finish-load to be
   delayed or never fire. Revealing the leaf before waiting prevents this.
   (For scope: "active", the leaf is already visible — skip this step.)

1. Check webview.isLoading()
   ├── true:  wait for 'did-finish-load' event (timeout: 10s)
   └── false: skip to step 2

2. Poll for stability (max 3 attempts, 500ms apart):
   executeJavaScript('document.readyState') === 'complete'

3. Final settle delay: 300ms
   (catches late async renders, image loads, etc.)

4. If timeout exceeded: proceed anyway with whatever content is available
   (better to return partial content than hang)
```

### HTML → Markdown Conversion

Reuses the existing Turndown singleton from `fetch-webpage.ts`. This requires exporting the `getTurndown()` function — currently it's module-private.

The Turndown instance is configured with:
- ATX headings, fenced code blocks, GFM (tables, strikethrough, task lists)
- Strips `<nav>`, `<footer>`, `<aside>`, `<form>`, `<input>`, `<select>`, `<button>`

This is appropriate for webview content too — we want the main content, not chrome.

### Link Extraction

Extracted via `executeJavaScript` running in the webview context:

```javascript
Array.from(document.querySelectorAll('a[href]'))
  .filter(a => a.innerText.trim().length > 0)
  .filter(a => {
    const href = a.getAttribute('href');
    return href && !href.startsWith('#') && !href.startsWith('javascript:');
  })
  .slice(0, 50)  // cap to prevent huge link lists
  .map(a => ({
    text: a.innerText.trim().substring(0, 100),
    href: a.href  // resolved absolute URL
  }))
```

**Cap at 50 links** to prevent link lists from dominating the output. Fragment-only links (`#section`) and `javascript:` are excluded.

### Click Implementation

```typescript
// Build the JS to inject — use JSON.stringify to safely embed the text value.
// Never use template literal string interpolation here; JSON.stringify handles
// quotes, backticks, newlines, and Unicode escape sequences correctly.
const safeText = JSON.stringify(params.text); // e.g. '"Read More"'
const js = `
(function(targetText) {
  const links = Array.from(document.querySelectorAll('a'));
  const target = targetText.toLowerCase();
  const match = links.find(a =>
    a.innerText.trim().toLowerCase().includes(target)
  );
  if (match) {
    match.click();
    return { found: true, text: match.innerText.trim(), href: match.href };
  }
  // Return available links to help LLM retry
  const available = links
    .filter(a => a.innerText.trim().length > 0)
    .slice(0, 20)
    .map(a => a.innerText.trim());
  return { found: false, available };
})(${safeText})`;
```

If no match is found, the error response includes a sample of available link texts so the LLM can adjust its request.

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/tools/webview.ts` | **Create** | Full tool implementation (~300-400 lines) |
| `src/utils/turndown.ts` | **Create** | Shared Turndown singleton, extracted from `fetch-webpage.ts` |
| `src/tools/fetch-webpage.ts` | **Modify** | Import `getTurndown` from `src/utils/turndown.ts` instead of defining it locally |
| `src/main.ts` | **Modify** | Add `webviewLeafCache: Map<string, WorkspaceLeaf>`, pass to `WebviewTool` with conversation ID getter; import `WebviewTool`, register in `getToolRegistry()` |
| `src/types/electron.d.ts` | **Create (if needed)** | Minimal type declarations for `Electron.WebviewTag` |

### Electron Type Declarations

The tool uses these `WebviewTag` methods:
- `executeJavaScript(code: string): Promise<any>`
- `loadURL(url: string): Promise<void>`
- `isLoading(): boolean`
- `addEventListener(event: string, handler: Function): void`

If `@electron/types` or Obsidian's type definitions don't cover `WebviewTag`, we'll need a minimal `.d.ts`:

```typescript
declare namespace Electron {
  interface WebviewTag extends HTMLElement {
    executeJavaScript(code: string): Promise<any>;
    loadURL(url: string): Promise<void>;
    isLoading(): boolean;
    getURL(): string;
    getTitle(): string;
  }
}
```

---

## Leaf Targeting & Session Persistence

### The Problem

Obsidian users may have multiple Web Viewer tabs open simultaneously — one for their own browsing and one for the LLM's autonomous research. The `scope` parameter resolves which leaf the tool targets on each call.

### `scope: "conversation"` — Dedicated Leaf (default)

Used for autonomous LLM browsing (`navigate`, `click`, and multi-step research tasks).

**Resolution logic (tried in order):**

1. Look up `conversationId` in the in-memory leaf cache (`Map<string, WorkspaceLeaf>` held by `NotorPlugin`)
2. If found: verify the leaf is still alive via `app.workspace.getLeavesOfType(WEB_VIEWER_VIEW_TYPE)` — use it
3. If stale (leaf closed by user): check JSONL for last persisted URL, create a new Web Viewer leaf, navigate there
4. If no prior URL: create a new Web Viewer leaf at a blank page, pin it to this conversation

The leaf remains open after the conversation ends — the user can inspect what the LLM browsed.

### `scope: "active"` — User's Focused Leaf

Used when the user explicitly refers to the page they are currently viewing ("summarize this article", "what does this dashboard say").

**Resolution logic:**
1. Find the currently focused Web Viewer leaf via `app.workspace.getActiveViewOfType()` or leaf iteration
2. Use it directly — do **not** pin it to the conversation (avoids hijacking the user's browsing session)
3. If no Web Viewer is focused: return error — "No Web Viewer tab is currently active. Switch to a Web Viewer tab and try again."

### In-Memory Leaf Cache

```
NotorPlugin {
  webviewLeafCache: Map<string, WorkspaceLeaf>
  // key = conversation UUID
}
```

Passed to `WebviewTool` at construction time alongside a `getConversationId: () => string | null` getter that reads from the active `ConversationManager`. The getter is only called at `execute()` time to avoid circular initialization.

### URL Persistence via Sidecar File

After each successful `navigate` or `click`, write a sidecar file alongside the conversation's JSONL:

```
{history_path}/{timestamp}_{conversationId}.webview.json
```

Schema:
```json
{ "url": "https://...", "timestamp": "2026-03-28T..." }
```

On reconnection (stale cache entry), the tool reads this sidecar file directly and navigates to its URL in the newly created leaf. If the sidecar doesn't exist, the new leaf starts on a blank page.

**No `HistoryManager` changes required.** Read/write the sidecar directly via `vault.adapter` in `webview.ts`. Locating the file requires the same path-building logic used to locate the JSONL file (pass `historyPath` to the tool constructor alongside `getConversationId`).

This is O(1) read and write — no file scanning. The sidecar is cleaned up by the existing JSONL retention policy if the JSONL file is pruned (retention should also delete the matching `.webview.json`).

---

## Edge Cases & Error Handling

### No Web Viewer Open
- All strategies return null → clear error: "No Web Viewer tab found. Open a webpage in Obsidian's Web Viewer first."

### Web Viewer Still Loading
- Smart wait handles this. If timeout (10s) expires, return whatever content is available with a note: "Page may still be loading."

### Very Large Pages
- Content truncated at `fetch_webpage_max_output_chars` with truncation note (same pattern as `fetch_webpage`)

### Click — No Matching Link
- Return error with list of available link texts (up to 20) so LLM can retry with correct text

### Click — Ambiguous Match (Multiple Links with Similar Text)
- First match wins (consistent with "first `<a>` element" behavior). Could add disambiguation later.

### Navigate — Invalid URL
- Validate URL format before calling `loadURL`. Return clear error for malformed URLs.

### Navigate — Blocked Domain
- Check `isDomainBlocked()` before navigation. Return error with blocked pattern.

### Page with Frames/Iframes
- `executeJavaScript` runs in the top frame only. Content inside iframes won't be extracted. This is a known limitation — document it in the tool description if it becomes a common issue.

### CSP Restrictions
- `executeJavaScript` on Electron `<webview>` bypasses CSP, so this should not be an issue.

### Mobile / Non-Desktop
- Obsidian's Web Viewer is desktop-only (Electron). The tool should check `Platform.isDesktopApp` and return a clear error on mobile.

---

## Open Questions

1. **Web Viewer leaf type string** — What is the exact `getViewType()` return value for Obsidian's Web Viewer? **Must be confirmed via Obsidian console before implementation begins.** Run: `app.workspace.iterateAllLeaves(l => console.log(l.view.getViewType()))` with a Web Viewer tab open. Candidates: `"webviewer"`, `"web-viewer"`, `"browser"`, `"web-browser"`. Hardcode the confirmed value as `WEB_VIEWER_VIEW_TYPE` constant. Keep runtime logging of `getViewType()` during webview discovery as a belt-and-suspenders fallback for detecting version changes.

2. **Webview property name on the view object** — When accessing the webview via `leaf.view`, what's the property name? Candidates: `.webview`, `.frame`, `.browser`, `.webviewEl`. Confirm via console at the same time as §1. Log which property name succeeds so it can be hardened.

3. **Plan mode for `scope: "active"` read** — `scope: "active"` + action `"read"` is the primary case that would benefit from Plan-mode access (no side effects, just reading user's current page). Currently the whole tool is `mode: "write"`. Deferring — start with single write-mode tool, split into `read_webview` + `interact_webview` if Plan-mode reading is requested.

4. **Auto-approve default** — Default to **not auto-approved** since `click`/`navigate` have visible side effects. Users can enable auto-approve per-tool in settings if desired.

~~5. **JSONL persistence mechanism**~~ — **Resolved:** Use sidecar file. See "URL Persistence via Sidecar File" above.

~~6. **Turndown sharing**~~ — **Resolved:** Extract to `src/utils/turndown.ts`. Both tools import from there.

---

## Verification Checklist

Manual smoke tests required before shipping (unit tests are not possible without a live Obsidian + Electron environment):

- [ ] `read` with `scope: "active"` on a known static page returns expected markdown content, URL, title, and link list
- [ ] `read` with `scope: "conversation"` creates a new Web Viewer leaf on first call; subsequent calls reuse it
- [ ] `navigate` loads the target URL, waits for readiness, returns correct URL and title
- [ ] `click` on a link by text navigates and returns the new URL
- [ ] `click` with no matching text returns an error listing available link texts
- [ ] `navigate` with a blocked domain returns the blocked-domain error (not a navigation)
- [ ] `navigate` with a malformed URL returns a clear invalid-URL error
- [ ] Tool returns clear error when no Web Viewer tab is open at all
- [ ] After closing the conversation-scoped leaf and calling `navigate` again, the tool recreates the leaf at the last visited URL (sidecar persistence)
- [ ] On mobile / non-desktop, tool returns a clear "Web Viewer is desktop-only" error

---

## Future Extensions (Not in Initial Implementation)

- **Scroll actions** — scroll to section, scroll down/up for lazy-loaded content
- **Back/forward navigation** — browser history traversal
- **Form interaction** — fill inputs, submit forms
- **Screenshot capture** — `webview.capturePage()` for visual context
- **Multi-tab support** — list all Web Viewer tabs, read from specific one by URL/index
- **Auto-context** — inject active Web Viewer URL/title into system prompt automatically
- **Plan-mode read** — split tool to allow content reading without Act mode
