# Research: Phase 4 — Workflows & Personas

**Created:** 2026-08-03
**Plan:** [specs/03-workflows-personas/plan.md](plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](spec.md)

This document consolidates the research plan and findings for Phase 4. Four research tasks are identified in the [implementation plan](plan.md) — each targeting an area where Obsidian API behavior or third-party library suitability must be validated before implementation.

---

## R-1: Cron Scheduling Library Evaluation

**Status:** Pending
**Blocking:** Group F (Vault Event Hooks — `on-schedule` hook type)

### Context

Phase 4 introduces scheduled vault event hooks (`on-schedule`) that fire on user-defined cron expressions (e.g., `0 9 * * *` for 9 AM daily). The scheduler must run in-process within Obsidian's Electron renderer — no external cron daemon or OS-level scheduling. The library must be lightweight (small bundle size), have zero native dependencies, and support dynamic job start/stop for lazy activation (FR-50a).

### Questions to Answer

1. **`croner` compatibility:** Does `croner` (~5 KB minified, zero deps) bundle cleanly with esbuild and run without errors in Obsidian's renderer process? Any use of Node.js-specific APIs that break in the browser-like Electron context?
2. **Cron syntax support:** Does it support standard 5-field cron syntax (`minute hour day-of-month month day-of-week`)? Does it support common extensions like `@daily`, `@weekly`, `@hourly`?
3. **Timezone handling:** Does it support timezone-aware scheduling (e.g., "run at 9 AM in the user's local timezone")? How is timezone specified — per-job, globally, or via the system clock?
4. **Dynamic job management:** What is the API for creating, starting, stopping, and destroying scheduled jobs at runtime? Can jobs be individually stopped without affecting others?
5. **Validation API:** Does it provide a way to validate a cron expression without creating a job? (Needed for settings UI validation at configuration time.)
6. **Alternatives evaluation:** How does `croner` compare to `cron-parser` (~15 KB, parse-only), `node-cron` (~larger, Node.js-specific), and a minimal custom implementation (setInterval-based)?

### Success Criteria

- Identify a library that is <20 KB bundled, zero external dependencies, ESM-compatible
- Supports standard 5-field cron syntax
- Supports dynamic job start/stop (for lazy activation)
- Provides validation API for cron expressions
- Runs in Obsidian's Electron renderer process without errors

### Evaluation Plan

1. Create a minimal test: `npm install croner`, write a test script that creates a job, verifies it fires, stops it, validates an expression
2. Bundle with esbuild and verify bundle size impact
3. Test in an Obsidian plugin context (or Electron equivalent)
4. Document API surface relevant to our use case

### Findings

*(To be completed during research phase)*

### Decision

*(To be documented after research)*

---

## R-2: Manual Save Detection via Command Interception

**Status:** Pending
**Blocking:** Group F (Vault Event Hooks — `on-manual-save` hook type, FR-48b)

### Context

Phase 4 introduces an `on-manual-save` vault event hook that fires only when the user explicitly saves a note (Cmd+S / Ctrl+S or "Save current file" command), excluding auto-save events. Obsidian does not provide a native API to distinguish manual saves from auto-saves. The proposed approach is to intercept the `editor:save-file` command via `app.commands`, set a short-lived flag, and check that flag in the subsequent `vault.on('modify', ...)` event handler.

### Questions to Answer

1. **Command interception mechanism:** How can we intercept `editor:save-file` in Obsidian? Options:
   - Wrap/monkey-patch `app.commands.executeCommandById`
   - Register a higher-priority command handler
   - Use Obsidian's `around()` monkey-patching pattern (common in community plugins)
   - Listen for the hotkey event directly (fragile, not recommended)
2. **Event ordering:** When the user presses Cmd+S, what is the exact sequence?
   - Does `editor:save-file` fire before the file is written to disk?
   - Does `vault.on('modify', ...)` fire synchronously after the write, or asynchronously?
   - Is the timing window between command interception and modify event reliable (< 100 ms)?
3. **Flag reliability:** If we set a `Map<string, number>` of `{ notePath: timestamp }` in the command interceptor and check it in the modify handler:
   - What timeout window is safe (e.g., 500 ms)?
   - Are there edge cases where the modify event fires before the command interceptor?
   - Can multiple saves (different notes) overlap in timing?
4. **Platform behavior:**
   - macOS: Cmd+S triggers `editor:save-file` — confirmed?
   - Windows/Linux: Ctrl+S triggers `editor:save-file` — confirmed?
   - Mobile: Is there an equivalent save action, or is all saving auto-save on mobile?
5. **Edge cases:**
   - Multiple panes open: does Cmd+S save only the active pane's note?
   - Split view: which note gets the save command?
   - Third-party plugins that trigger `editor:save-file` programmatically — should these count as "manual"?

### Success Criteria

- Confirm that `editor:save-file` can be intercepted reliably
- Define the flag-based detection mechanism with timing parameters
- Document platform-specific behavior (desktop vs. mobile)
- Identify and document edge cases

### Evaluation Plan

1. Create a test plugin that patches `editor:save-file` and logs timing
2. Measure time delta between command interception and `vault.on('modify', ...)` across 20+ saves
3. Test with auto-save enabled (verify auto-saves do NOT trigger the command)
4. Test with multiple panes, split views
5. Test on macOS (primary) and document expected behavior on Windows/Linux

### Findings

*(To be completed during research phase)*

### Decision

*(To be documented after research)*

---

## R-3: Tag Change Detection via Metadata Cache

**Status:** Pending
**Blocking:** Group F (Vault Event Hooks — `on-tag-change` hook type, FR-49)

### Context

Phase 4 introduces an `on-tag-change` vault event hook that fires when tags are added to or removed from a note's frontmatter. The hook needs to provide the affected note's path, the tags that were added, and the tags that were removed. Obsidian's `metadataCache.on('changed', ...)` fires when a file's metadata cache is updated, but it does not provide the previous state — only the new state. A shadow cache of per-note tags may be needed to compute the diff.

### Questions to Answer

1. **`metadataCache.on('changed', ...)` behavior:**
   - What arguments does the callback receive? (File, old data, new data — or just file and new data?)
   - Does it fire for every frontmatter change, or only when parsed metadata differs from the cached version?
   - Does it fire when tags are changed via Notor's `manage_tags` tool (which uses `processFrontMatter`)?
   - Does it fire when tags are changed via Notor's `update_frontmatter` tool?
   - Does it fire when the user manually edits frontmatter in the editor?
2. **Shadow cache design:**
   - If previous state is not provided by the callback, we need a `Map<string, string[]>` mapping note paths to their last-known tags array.
   - When should the shadow cache be initialized? Options: plugin load (scan all notes), lazily (on first metadata change), or only for notes with active hooks.
   - Memory footprint estimate: 10,000 notes × ~5 tags × ~20 chars = ~1 MB. Acceptable?
   - How to handle cache invalidation when tags are changed outside Notor (e.g., manual edit)?
3. **Tag diff computation:**
   - Compare shadow cache tags with new frontmatter tags to produce `tags_added` and `tags_removed` arrays.
   - How to handle tag normalization (case sensitivity, leading `#` stripping)?
   - How to handle the `tags` property being a string (single tag) vs. array (multiple tags)?
4. **Loop prevention:**
   - When Notor's own tools change tags (within a hook workflow), we need to suppress `on-tag-change` for those changes.
   - Approach: set a "suppress tag change hooks" flag before tool execution within hook workflows; clear after.
   - How to scope this to the specific note being modified (not globally)?
5. **Timing and batching:**
   - If a batch tag operation changes multiple notes rapidly, does `metadataCache.on('changed')` fire once per note or coalesce?
   - Should we debounce tag change events per note path (similar to save events)?

### Success Criteria

- Define tag change detection strategy (shadow cache vs. alternative)
- Quantify memory overhead for shadow cache approach
- Confirm `metadataCache.on('changed')` fires reliably for frontmatter tag changes
- Define loop prevention mechanism
- Document tag normalization rules

### Evaluation Plan

1. Create a test plugin that listens to `metadataCache.on('changed', ...)` and logs callback arguments
2. Test tag changes via: manual editor edit, `processFrontMatter`, `update_frontmatter` tool, `manage_tags` tool
3. Measure callback timing relative to the actual file write
4. Prototype shadow cache with 1,000+ notes and measure memory
5. Test batch operations (changing tags on 10 notes in rapid succession)

### Findings

*(To be completed during research phase)*

### Decision

*(To be documented after research)*

---

## R-4: Slash-Command Autocomplete in Custom ItemView

**Status:** Pending
**Blocking:** Group E (Manual Workflow Execution — slash-command workflow attachment, FR-42)

### Context

Phase 4 introduces a slash-command UX in the Notor chat input area: when the user types `/` at the start of the input (or after a newline), an autocomplete popup appears listing discovered workflows. Selecting a workflow inserts a visual "chip" in the input area. The Notor chat input is a custom element within an `ItemView` (not Obsidian's native CodeMirror editor), so standard `EditorSuggest` APIs may not be directly applicable.

### Questions to Answer

1. **Current chat input implementation:** What element is the Notor chat input — `<textarea>`, `<div contenteditable>`, or a custom component? This determines the approach.
2. **`EditorSuggest` applicability:** Can `EditorSuggest` (designed for CodeMirror editors) be adapted for non-editor contexts? If not, what is the recommended alternative?
3. **Custom autocomplete patterns in Obsidian plugins:** Do any community plugins implement autocomplete in non-editor views? If so, what approach do they use?
4. **DOM positioning for dropdown:** How to position the autocomplete dropdown relative to the text cursor in a `<textarea>` (which doesn't expose cursor pixel position natively)? Options:
   - Use a hidden mirror div to calculate cursor position
   - Position the dropdown below the input area (simpler, less precise)
   - Switch to `contenteditable` for precise caret tracking
5. **Workflow chip rendering:** How to render a non-editable chip within the input area?
   - If `<textarea>`: cannot embed DOM elements; need a separate chip container outside the textarea (e.g., above or to the left)
   - If `contenteditable`: can insert inline `<span>` elements styled as chips
   - Hybrid: textarea for text input + separate chip display area
6. **`/` trigger precision:** How to ensure `/` only triggers autocomplete at the start of the input or after a newline, not in the middle of a word (e.g., a URL like `http://...`)?
   - Check character before cursor position
   - Only trigger when `/` is the first character in the input or preceded by `\n`

### Success Criteria

- Determine the input element type and whether to change it
- Define the autocomplete dropdown positioning strategy
- Define the chip rendering approach (in-textarea, adjacent container, or contenteditable)
- Document the `/` trigger detection logic
- Provide a prototype or reference implementation approach

### Evaluation Plan

1. Inspect the current Notor chat input implementation (`src/ui/chat-view.ts`)
2. Research Obsidian community plugin patterns for custom autocomplete (e.g., Tasks plugin, Templater, Dataview)
3. Prototype a minimal `/`-triggered dropdown in a test ItemView
4. Test chip rendering approaches (textarea + external chip vs. contenteditable)
5. Document recommended approach with code snippets

### Findings

*(To be completed during research phase)*

### Decision

*(To be documented after research)*

---

## Research Dependencies

```
R-1 (Cron Library) ────▶ Group F: on-schedule hooks
R-2 (Manual Save) ─────▶ Group F: on-manual-save hooks
R-3 (Tag Changes) ─────▶ Group F: on-tag-change hooks
R-4 (Slash-Command) ───▶ Group E: slash-command workflow attachment
```

Research tasks R-1, R-2, R-3, and R-4 are independent and can be conducted in parallel. All must be complete before Group F (Vault Event Hooks) implementation begins. R-4 must be complete before Group E (Manual Workflow Execution) slash-command feature begins (though the command palette workflow execution can proceed without R-4).
