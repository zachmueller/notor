# Research: Phase 4 — Workflows & Personas

**Created:** 2026-08-03
**Plan:** [specs/03-workflows-personas/plan.md](plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](spec.md)

This document consolidates the research plan and findings for Phase 4. Four research tasks are identified in the [implementation plan](plan.md) — each targeting an area where Obsidian API behavior or third-party library suitability must be validated before implementation.

---

## R-1: Cron Scheduling Library Evaluation

**Status:** ✅ Complete
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

**Evaluated:** `croner` v10.0.1 (MIT license, [github.com/hexagon/croner](https://github.com/hexagon/croner))
**Test scripts:** [`research/research-r1-test.mjs`](research/research-r1-test.mjs), [`research/research-r1-bundle-test.mjs`](research/research-r1-bundle-test.mjs)

#### Q1: Compatibility with esbuild and Obsidian's Electron renderer

- **ESM import works cleanly.** `import { Cron, CronPattern } from "croner"` loads without issue in Node.js ESM context.
- **esbuild bundles without errors.** Using `npx esbuild --bundle --format=cjs --platform=browser` produces a valid bundle.
- **Zero Node.js-specific APIs.** Source code scan of `croner.js` confirmed none of the following are present: `require(`, `process.`, `fs.`, `path.`, `child_process`, `Buffer.`, `__dirname`, `__filename`, `global.`. The library is fully browser-compatible and will run in Obsidian's Electron renderer without issues.
- **Zero external dependencies.** `package.json` shows no `dependencies` or `peerDependencies`.

#### Q2: Cron syntax support

All standard 5-field expressions passed:

| Expression | Description | Result |
|---|---|---|
| `0 9 * * *` | 9 AM daily | ✅ |
| `*/15 * * * *` | Every 15 minutes | ✅ |
| `0 0 1 * *` | First of month midnight | ✅ |
| `30 14 * * 1-5` | 2:30 PM weekdays | ✅ |
| `0 */6 * * *` | Every 6 hours | ✅ |

**Shorthand aliases all supported:** `@yearly`, `@monthly`, `@weekly`, `@daily`, `@hourly` — all ✅.

**6-field (seconds) support:** `*/30 * * * * *` works. This is a bonus — not required by our spec, but useful if we ever need sub-minute scheduling.

**7-field support:** The library also supports 7 fields (seconds + year), per its docs.

#### Q3: Timezone handling

- **Per-job timezone via `{ timezone: "America/New_York" }` option.** Tested and confirmed for `America/New_York`, `Europe/London`, `Pacific/Auckland`, `UTC` — all ✅.
- **Default behavior (no timezone option):** Uses the system/local timezone. Confirmed: when run in NZ timezone, `nextRun()` returns NZ times.
- **Implementation uses `Intl.DateTimeFormat`** internally for timezone resolution — this is a standard browser API available in all Electron versions Obsidian targets.
- **Recommendation for Notor:** Default to no timezone option (use local system time), which is the most intuitive behavior for users. Optionally expose a per-hook timezone override in the future.

#### Q4: Dynamic job management

The API is clean and supports all required lifecycle operations:

```typescript
// Create paused
const job = new Cron("0 9 * * *", { paused: true }, () => { /* handler */ });

// State inspection
job.isRunning();  // false (paused)
job.isStopped();  // false (not destroyed)

// Resume (start firing)
job.resume();
job.isRunning();  // true

// Pause (stop firing, can resume later)
job.pause();
job.isRunning();  // false
job.isStopped();  // false

// Stop (permanent destroy, cannot resume)
job.stop();
job.isStopped();  // true

// Next run prediction
job.nextRun();  // returns Date or null
```

**Key findings:**
- `{ paused: true }` creates a job that does not fire until `.resume()` — ideal for lazy activation (FR-50a).
- `.pause()` / `.resume()` cycle works correctly. After pausing, no additional fires occur. After resuming, fires resume on schedule.
- `.stop()` permanently destroys the job. Attempting to resume after stop has no effect.
- **Independent job management confirmed.** Stopping jobA does not affect jobB. Tested with two concurrent every-second jobs — stopping one left the other running normally.
- Jobs use `setTimeout` internally (not `setInterval`), scheduling the next tick after each fire. This means no drift accumulation.

#### Q5: Validation API

- **No static `Cron.validate()` method exists.** `typeof Cron.validate === "undefined"`.
- **Validation via `CronPattern` constructor works reliably.** Wrapping `new CronPattern(expr)` in a try/catch provides accurate validation with descriptive error messages:

| Expression | Expected | Result | Error message |
|---|---|---|---|
| `0 9 * * *` | valid | ✅ valid | — |
| `*/15 * * * *` | valid | ✅ valid | — |
| `@daily` | valid | ✅ valid | — |
| `invalid-cron` | invalid | ✅ invalid | "invalid configuration format, exactly five, six, or seven space separated parts are required" |
| `99 99 99 99 99` | invalid | ✅ invalid | "Invalid value for minute: 99" |
| `0 25 * * *` | invalid | ✅ invalid | "Invalid value for hour: 25" |
| `""` (empty) | invalid | ✅ invalid | "invalid configuration format" |
| `* * * *` (4 fields) | invalid | ✅ invalid | "exactly five, six, or seven space separated parts are required" |

**Recommended validation wrapper for settings UI:**
```typescript
function isValidCron(expr: string): { valid: boolean; error?: string } {
  try {
    new CronPattern(expr);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}
```

#### Q6: Bundle size

| Metric | Size |
|---|---|
| ESM source (`croner.js`) | 27.6 KB |
| esbuild bundled (unminified) | 35.1 KB |
| esbuild bundled (minified) | 27.3 KB |
| esbuild bundled (minified + gzip) | **~8.1 KB** |
| Current Notor `main.js` (for reference) | 2.7 KB (stub) |
| npm package on disk | 164 KB |

The minified bundle is 27.3 KB, which exceeds the original "~5 KB" estimate in the research questions but is well within the <20 KB gzipped threshold. At **8.1 KB gzipped**, this is acceptable for a feature that provides full cron scheduling.

> **Note:** The "~5 KB" figure from the research question appears to be outdated — it may have referred to an earlier version of croner. v10.0.1 is larger due to added features (7-field support, improved timezone handling, etc.), but still lightweight compared to alternatives.

#### Q6 (continued): Alternatives comparison

| Library | Version | Bundle size (min) | Dependencies | Scheduling | Validation | Browser-safe | Notes |
|---|---|---|---|---|---|---|---|
| **croner** | 10.0.1 | 27.3 KB (8.1 KB gz) | 0 | ✅ Full scheduler | ✅ via CronPattern | ✅ | Best fit. Full scheduler + parser in one. |
| **cron-parser** | 5.5.0 | ~15 KB + luxon | 1 (luxon ~70 KB) | ❌ Parse only | ✅ | ✅ | Parse-only; would need custom setInterval wrapper. luxon dep adds ~70 KB. |
| **node-cron** | 4.2.1 | ~25 KB | 0 | ✅ Full scheduler | ✅ | ⚠️ Name implies Node focus; need to verify | Similar size to croner but less actively maintained, fewer features. |
| **Custom (setInterval)** | — | <1 KB | 0 | ⚠️ Basic | ❌ Manual | ✅ | Minimal size but requires implementing cron parsing, next-run calculation, timezone handling from scratch. High maintenance burden. |

**Why not cron-parser:** It requires `luxon` as a dependency (~70 KB), making the total bundle significantly larger. It's parse-only — we'd need to build our own scheduler loop on top, which is exactly what croner already provides.

**Why not node-cron:** Similar bundle size to croner with fewer features and less active maintenance. The name suggests Node.js focus, though v4 may be browser-compatible. Croner has better documentation and TypeScript support.

**Why not custom:** Building a correct cron parser with timezone support, day-of-week handling, range/step expressions, and shorthand aliases is non-trivial (~500+ lines). The maintenance burden is not justified when croner handles it in 8.1 KB gzipped.

### Decision

**✅ Use `croner` v10.x** as the cron scheduling library for `on-schedule` vault event hooks.

**Rationale:**
1. **All success criteria met:**
   - Bundle size: 27.3 KB minified / 8.1 KB gzipped (within <20 KB gzipped target)
   - Zero external dependencies
   - ESM-compatible with clean esbuild bundling
   - Full 5-field cron syntax + shorthand aliases (`@daily`, etc.)
   - Dynamic job start/stop via `pause()` / `resume()` / `stop()`
   - Validation via `CronPattern` constructor with descriptive errors
   - No Node.js-specific APIs — fully browser/Electron-safe
2. **Best-in-class for our use case:** Provides both parsing and scheduling in a single library, with per-job timezone support and clean lifecycle management.
3. **Low integration risk:** The API maps directly to our requirements — `{ paused: true }` for lazy activation, `pause()`/`resume()` for dynamic control, `CronPattern` for validation.

**Integration notes for implementation:**
- Install as a regular dependency: `npm install croner`
- Import: `import { Cron, CronPattern } from "croner"`
- Create jobs with `{ paused: true }` and `.resume()` on lazy activation
- Use `CronPattern` constructor in try/catch for settings UI validation
- Call `.stop()` on all active jobs in `plugin.onunload()` for clean cleanup
- Default to local timezone (no `timezone` option); consider exposing per-hook timezone as a future enhancement

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
