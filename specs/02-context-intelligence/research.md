# Research: Phase 3 — Context & Intelligence

**Created:** 2026-07-03
**Plan:** [specs/02-context-intelligence/plan.md](plan.md)
**Specification:** [specs/02-context-intelligence/spec.md](spec.md)

This document consolidates the research tasks required before Phase 3 implementation can begin. Each section corresponds to a research task defined in the plan.

---

## R-1: Obsidian Autocomplete/Suggest API for Attachment Picker

**Status:** Pending
**Blocking:** Feature Group A (Attachment System)
**Priority:** High

### Questions to Answer

1. **Inline suggest in custom views:** Can `SuggestModal` or `FuzzySuggestModal` be embedded inline in a text input within an `ItemView`, or are they always full-screen modals?
2. **`EditorSuggest` reuse:** Obsidian's native editor uses `EditorSuggest` for `[[` autocomplete. Can this API be reused in a custom `ItemView`'s `<textarea>` or `contenteditable` element, or is it tightly coupled to `Editor` instances?
3. **Custom suggest popup positioning:** If the built-in APIs can't be used inline, what is the best approach for building a custom suggest dropdown that:
   - Triggers when the user types `[[` in the chat input
   - Shows matching vault note names with fuzzy matching
   - Supports `#Section` navigation after a note is selected
   - Positions correctly relative to the cursor in the input element
4. **Section header enumeration:** Can `metadataCache.getFileCache(file)?.headings` be used to enumerate section headers for `[[Note#Section]]` autocomplete? What data structure does it return (heading text, level, position)?
5. **Existing community patterns:** Do other Obsidian plugins implement wikilink-style autocomplete outside the editor? What approach do they use?

### Success Criteria

- Identify a working approach (built-in API or custom implementation) for vault note autocomplete in the chat input
- Confirm section header autocomplete is feasible
- Document any Obsidian API version requirements

### Research Approach

1. Review Obsidian API type definitions for `SuggestModal`, `FuzzySuggestModal`, `EditorSuggest`, `PopoverSuggest`
2. Build a minimal test plugin that attempts to use each suggest API in an `ItemView`
3. Inspect 2-3 community plugins that implement file pickers or suggest UIs (e.g., Templater, Dataview, QuickAdd)
4. Test section header enumeration via `metadataCache`

### Findings

*To be completed during research phase.*

### Decision

*To be recorded after research is complete.*

---

## R-2: Electron Dialog API for External File Picker

**Status:** Pending
**Blocking:** Feature Group A (Attachment System — external files only)
**Priority:** Medium

### Questions to Answer

1. **`remote.dialog` availability:** Does Obsidian's Electron configuration expose `require('electron').remote.dialog`? Recent Electron versions deprecate the `remote` module; does Obsidian re-enable it or provide an alternative?
2. **`<input type="file">` fallback:** If the Electron dialog API is unavailable, does the HTML `<input type="file">` element work correctly within an Obsidian plugin `ItemView`? Does it return absolute file paths or `File` objects?
3. **File path access:** Obsidian plugins need the absolute file path to read external files via Node.js `fs`. Does the chosen approach provide absolute paths, or only blob/File references?
4. **Obsidian API wrappers:** Does Obsidian expose any utility for opening a file/folder selection dialog that plugins can use?
5. **Mobile compatibility:** External file attachment is expected to be desktop-only. What is the correct way to detect desktop vs. mobile (`Platform.isDesktop` or similar) and hide the external file option on mobile?

### Success Criteria

- Identify a working approach for opening an OS-native file dialog and obtaining an absolute file path
- Confirm file content can be read via `fs.readFileSync` or equivalent
- Document the desktop-only gating mechanism

### Research Approach

1. Test `require('electron').remote.dialog.showOpenDialog()` in a minimal Obsidian plugin
2. If unavailable, test `<input type="file">` and check what data is accessible
3. Search Obsidian plugin community for patterns (e.g., how Obsidian Importer or local-images plugins handle external file access)
4. Verify `Platform.isDesktop` availability in the Obsidian API

### Findings

*To be completed during research phase.*

### Decision

*To be recorded after research is complete.*

---

## R-3: Shell Execution Environment in Electron

**Status:** Pending
**Blocking:** Feature Group E (`execute_command`), Feature Group F (Hooks)
**Priority:** High

### Questions to Answer

1. **`child_process` availability:** Is `require('child_process')` available in Obsidian's plugin context? Obsidian plugins run in the renderer process with `nodeIntegration: true` — confirm this extends to `child_process.spawn`.
2. **Login shell behavior:**
   - On macOS: Does `spawn($SHELL, ['-l', '-c', command])` reliably source `.zprofile`/`.zshrc` and inherit the user's full PATH?
   - On Linux: Same question for `$SHELL` (typically bash or zsh).
   - On Windows: Does `spawn('powershell.exe', ['-Command', command])` work correctly? What about `cmd.exe /c`?
3. **`$SHELL` resolution:** How to correctly read the `$SHELL` environment variable from within Electron? Is `process.env.SHELL` populated, or does Electron strip it?
4. **Process termination:** What is the correct approach for killing a timed-out process?
   - Does `process.kill('SIGTERM')` work on macOS/Linux?
   - Does process group kill (`-pid`) work to terminate child processes spawned by the shell?
   - What is the Windows equivalent for terminating a shell process tree?
5. **Environment variable limits:** What are the per-variable and total environment size limits on each platform?
   - macOS: ~256 KB total (`sysctl kern.argmax`)
   - Linux: ~2 MB total (`getconf ARG_MAX`)
   - Windows: ~32 KB per variable, ~32 KB total block
6. **Working directory:** Can `spawn` use a `cwd` option to set the working directory? Any permission issues?
7. **stdout/stderr capture:** What is the correct approach for streaming stdout+stderr into a single buffer with size limits?

### Success Criteria

- Confirm `child_process.spawn` works in Obsidian plugins on all three platforms
- Document the correct shell invocation pattern per platform
- Identify process termination strategy
- Confirm environment variable size limits and truncation approach

### Research Approach

1. Build a minimal Obsidian plugin that spawns a shell command and captures output
2. Test on macOS (primary), document expected behavior on Linux and Windows
3. Test login shell behavior: verify PATH includes Homebrew, nvm, pyenv paths
4. Test timeout and kill behavior with a `sleep` command
5. Measure environment variable limits with a test payload

### Findings

*To be completed during research phase.*

### Decision

*To be recorded after research is complete.*

---

## R-4: Turndown Bundling and HTML Conversion Quality

**Status:** Pending
**Blocking:** Feature Group D (`fetch_webpage`)
**Priority:** Medium

### Questions to Answer

1. **esbuild compatibility:** Does Turndown bundle cleanly with esbuild? Are there any CommonJS/ESM issues, Node.js-specific APIs (e.g., `jsdom` dependency), or platform-specific code that breaks in Electron's Chromium runtime?
2. **Bundle size impact:** What is the final bundle size contribution after esbuild tree-shaking? (Expected: ~14 KB minified based on npm package stats.)
3. **Conversion quality:** How does Turndown handle common page structures?
   - Wikipedia articles (tables, references, infoboxes)
   - Documentation sites (code blocks, nested lists, sidebar navigation)
   - Blog posts (headers, images, embedded media)
   - News articles (ads, related articles, navigation)
4. **Configuration options:** What Turndown options are available and which improve output quality?
   - `headingStyle`: `atx` vs `setext`
   - `codeBlockStyle`: `fenced` vs `indented`
   - `bulletListMarker`: `-` vs `*`
   - Link reference style
   - Custom rules for stripping elements (e.g., `<nav>`, `<footer>`, `<aside>`)
5. **Plugin system:** Does Turndown's plugin system (e.g., `turndown-plugin-gfm` for GitHub Flavored Markdown tables and strikethrough) bundle cleanly and improve output quality?
6. **Edge cases:** How does Turndown handle:
   - Malformed HTML
   - Very large DOMs (e.g., 5 MB HTML)
   - Embedded `<script>` and `<style>` tags
   - Non-English content and Unicode

### Success Criteria

- Confirm Turndown bundles with esbuild without errors
- Document recommended configuration options
- Assess output quality as acceptable for Phase 3 (raw conversion without readability filtering)
- Measure bundle size impact

### Research Approach

1. Add Turndown as a dev dependency and test the esbuild build
2. Write a test script that fetches 5-10 representative URLs and converts them
3. Evaluate output quality and identify configuration improvements
4. Test with `turndown-plugin-gfm` for table support
5. Measure bundle size before and after adding Turndown

### Findings

*To be completed during research phase.*

### Decision

*To be recorded after research is complete.*

---

## Research Timeline

| Task | Priority | Blocking | Estimated Effort |
|---|---|---|---|
| R-1: Obsidian autocomplete API | High | Feature Group A | 2-4 hours |
| R-2: Electron dialog API | Medium | Feature Group A (external files) | 1-2 hours |
| R-3: Shell execution in Electron | High | Feature Groups E, F | 2-4 hours |
| R-4: Turndown bundling | Medium | Feature Group D | 1-2 hours |

**Total estimated research effort:** 6-12 hours

**Parallelization:** R-1/R-2 (attachment-related) and R-3/R-4 (tool-related) can be researched in parallel. Feature Group B (Auto-Context) has no research dependencies and can begin implementation immediately.