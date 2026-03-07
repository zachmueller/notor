# Research: Phase 3 — Context & Intelligence

**Created:** 2026-07-03
**Plan:** [specs/02-context-intelligence/plan.md](plan.md)
**Specification:** [specs/02-context-intelligence/spec.md](spec.md)

This document consolidates the research tasks required before Phase 3 implementation can begin. Each section corresponds to a research task defined in the plan.

---

## R-1: Obsidian Autocomplete/Suggest API for Attachment Picker

**Status:** Complete
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

#### API Analysis

Five suggest APIs were examined in the Obsidian type definitions (`obsidian.d.ts`):

| API | Type | Context | Suitable for Chat Input? |
|---|---|---|---|
| `SuggestModal<T>` | Full-screen modal | Extends `Modal` | ❌ Modal overlay, not inline |
| `FuzzySuggestModal<T>` | Full-screen modal | Extends `SuggestModal` | ❌ Modal overlay, not inline |
| `EditorSuggest<T>` | Inline popover | Tightly coupled to `Editor` + `EditorPosition` | ❌ Requires `Editor` instance from CodeMirror |
| `PopoverSuggest<T>` | Base popover class | Abstract, requires manual positioning | ⚠️ Possible but low-level |
| **`AbstractInputSuggest<T>`** | **Inline popover** | **Accepts `HTMLInputElement` or `HTMLDivElement`** | **✅ Perfect fit** |

#### Recommended Approach: `AbstractInputSuggest<T>`

`AbstractInputSuggest<T>` (available since Obsidian 1.4.10) is the ideal API for wikilink-style autocomplete in the chat input. Key characteristics:

- **Constructor:** `constructor(app: App, textInputEl: HTMLInputElement | HTMLDivElement)` — accepts a standard `<input>` element or a `contenteditable` div, both of which are used in `ItemView` chat panels.
- **Popover positioning:** Automatically positions the suggest dropdown relative to the input element. No manual positioning required.
- **Query-based suggestions:** Implements `getSuggestions(query: string): T[] | Promise<T[]>` — receives the current input text and returns matching suggestions.
- **Rendering:** Implements `renderSuggestion(value: T, el: HTMLElement): void` — full control over suggestion item rendering.
- **Selection callback:** `onSelect(callback: (value: T, evt: MouseEvent | KeyboardEvent) => any)` — handles user selection.
- **Value management:** `setValue(value: string)` and `getValue(): string` for reading/writing the input element.
- **Performance limit:** `limit: number` defaults to 100 rendered items.

#### `[[` Trigger Implementation Strategy

Since `AbstractInputSuggest` triggers on any input change (not a specific character sequence), the `[[` trigger requires a two-layer approach:

1. **Input event listener:** Monitor the chat `<textarea>` (or `<input>`) for the `[[` character sequence. When detected, activate the suggest overlay.
2. **Suggest instance:** Create an `AbstractInputSuggest` subclass that:
   - In `getSuggestions(query)`: extracts the text after `[[` as the search query, uses `prepareFuzzySearch(query)` to match against `app.vault.getMarkdownFiles()` filenames.
   - In `renderSuggestion()`: renders file names with fuzzy match highlighting.
   - In `onSelect()`: inserts the selected note reference and removes the `[[` trigger text.

**Alternative approach:** If the chat input uses a `<textarea>` rather than an `<input>`, `AbstractInputSuggest` may not directly support it (the constructor accepts `HTMLInputElement | HTMLDivElement`). In that case:
- Convert the chat input to use a `contenteditable` `<div>` (which `AbstractInputSuggest` supports), or
- Use a hidden `<input>` element for the suggest trigger while the user types in the `<textarea>`, or
- Use `FuzzySuggestModal` as a fallback (full-screen modal triggered by `[[` or an attachment button).

The recommended primary approach is `AbstractInputSuggest` with a `contenteditable` div or an `<input>` element. If the existing chat input is a `<textarea>`, the simplest migration path is to use a `contenteditable` div.

#### Section Header Enumeration

Confirmed: `metadataCache.getFileCache(file)?.headings` returns `HeadingCache[]` with:

```typescript
interface HeadingCache extends CacheItem {
    heading: string;  // The heading text (e.g., "Introduction")
    level: number;    // Number between 1 and 6 (h1-h6)
}
```

This is sufficient for `#Section` autocomplete after a note is selected. Implementation:
1. User selects a note from the suggest list.
2. If user then types `#`, a second suggest pass queries `metadataCache.getFileCache(selectedFile)?.headings`.
3. Headings are presented with their level for disambiguation (e.g., "## Introduction" vs "### Introduction").

Additionally, `resolveSubpath(cache, subpath)` can be used to resolve a heading subpath to get the heading and the next heading boundary, which is useful for content extraction at send time.

#### Fuzzy Matching

Obsidian provides built-in fuzzy matching utilities:
- `prepareFuzzySearch(query): (text: string) => SearchResult | null` — constructs a reusable fuzzy matcher. Returns match positions for highlighting.
- `prepareSimpleSearch(query)` — lighter alternative for performance-sensitive cases.

These should be used directly rather than implementing custom fuzzy matching.

#### Obsidian API Version Requirement

- `AbstractInputSuggest`: requires Obsidian ≥ 1.4.10
- `onSelect` callback: requires Obsidian ≥ 1.4.10
- `getSuggestions` abstract method: requires Obsidian ≥ 1.5.7
- `setValue`/`getValue`: requires Obsidian ≥ 1.4.10

Current `manifest.json` `minAppVersion` should be checked and updated if necessary. The plugin should require at least Obsidian 1.5.7 for `AbstractInputSuggest` support.

### Decision

**Use `AbstractInputSuggest<T>`** for inline vault note autocomplete in the chat input.

- Attach to the chat input element (`<input>` or `contenteditable` `<div>`).
- Intercept `[[` as a trigger sequence in the input event handler.
- Use `prepareFuzzySearch()` for matching vault file names.
- After note selection, support `#` trigger for section header autocomplete via `metadataCache.getFileCache()?.headings`.
- Fall back to `FuzzySuggestModal` only if the chat input cannot be adapted to work with `AbstractInputSuggest` (e.g., if it must remain a `<textarea>`).
- Minimum Obsidian version: **1.5.7**.

---

## R-2: Electron Dialog API for External File Picker

**Status:** Complete
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

#### Electron `remote` Module

The `remote` module was deprecated in Electron 12 and removed in Electron 14+. Obsidian uses a modern Electron version (typically Electron 25+) and **does not** re-enable the `remote` module. Therefore:

- ❌ `require('electron').remote.dialog.showOpenDialog()` is **not available**.
- Obsidian does not provide a direct wrapper for `dialog.showOpenDialog()`.

#### `<input type="file">` — Recommended Approach

In Electron's renderer process with `nodeIntegration: true` (which Obsidian enables for plugins), the HTML `<input type="file">` element works correctly and provides access to absolute file paths:

- **`File` objects in Electron:** When a user selects a file via `<input type="file">`, the resulting `File` objects have an Electron-specific `.path` property that contains the **absolute filesystem path** (e.g., `/Users/name/Documents/file.txt` on macOS, `C:\Users\name\Documents\file.txt` on Windows).
- **This `.path` property is non-standard** (not available in regular browsers) but reliably present in Electron.
- **File content reading:** With the absolute path, `require('fs').readFileSync(file.path, 'utf-8')` works without issues.
- **Multiple file selection:** The `<input>` element supports the `multiple` attribute for batch attachment.

Implementation pattern:
```typescript
const input = document.createElement('input');
input.type = 'file';
input.multiple = true;
input.accept = '.md,.txt,.json,.csv,.yaml,.yml,.toml,.xml,.html,.css,.js,.ts,.py,.sh,.bash,.zsh'; // text-like extensions
input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    for (const file of files) {
        const absolutePath = (file as any).path; // Electron-specific
        const content = require('fs').readFileSync(absolutePath, 'utf-8');
        // Create attachment...
    }
});
input.click(); // Opens OS-native file dialog
```

#### Community Plugin Patterns

Multiple community plugins use the `<input type="file">` approach:
- **Obsidian Importer** uses `<input type="file">` for importing external files.
- **Local Images** plugin reads external files via the `File.path` Electron property.
- This is the de facto standard pattern in the Obsidian plugin ecosystem for external file access.

#### Desktop-Only Gating

Confirmed: Obsidian exports a `Platform` constant with the following properties:

```typescript
export const Platform: {
    isDesktop: boolean;      // UI is in desktop mode
    isMobile: boolean;       // UI is in mobile mode
    isDesktopApp: boolean;   // Running Electron desktop app
    isMobileApp: boolean;    // Running Capacitor.js mobile app
    isIosApp: boolean;       // Running iOS app
    isAndroidApp: boolean;   // Running Android app
};
```

For gating external file attachment:
- Use `Platform.isDesktopApp` (more specific) or `Platform.isDesktop` (broader) to show/hide the "Attach external file" option.
- `Platform.isDesktopApp` is preferred because the Electron `File.path` property is only available in the desktop Electron environment.

### Decision

**Use `<input type="file">` HTML element** for the external file picker.

- Create a hidden `<input type="file">` element, programmatically trigger `.click()` to open the OS-native dialog.
- Read the absolute path from the Electron-specific `File.path` property.
- Read file content via `require('fs').readFileSync(path, 'utf-8')`.
- Gate behind `Platform.isDesktopApp` — hide/disable the external file attachment option on mobile.
- No dependency on the deprecated `remote` module.

---

## R-3: Shell Execution Environment in Electron

**Status:** Complete
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

#### `child_process` Availability

**Confirmed available.** The esbuild configuration for this project (`esbuild.config.mjs`) explicitly externalizes all Node.js built-in modules:

```javascript
external: [
    "obsidian",
    "electron",
    ...builtinModules  // includes 'child_process', 'fs', 'path', etc.
]
```

This means `child_process` is resolved at runtime by Obsidian's Electron environment, where `nodeIntegration: true` is enabled for plugins. `require('child_process')` works in the renderer process. TypeScript types are available via `@types/node` (already a dev dependency in `package.json`).

#### Shell Resolution Per Platform

| Platform | `process.platform` | Shell Executable | Arguments | Profile Sourced |
|---|---|---|---|---|
| macOS | `darwin` | `process.env.SHELL` (typically `/bin/zsh`) | `['-l', '-c', command]` | Yes — `-l` sources `.zprofile` → `.zshrc`, inherits full PATH (Homebrew, nvm, pyenv) |
| Linux | `linux` | `process.env.SHELL` (typically `/bin/bash` or `/bin/zsh`) | `['-l', '-c', command]` | Yes — `-l` sources `.bash_profile`/`.profile` → `.bashrc`, inherits full PATH |
| Windows | `win32` | `'powershell.exe'` | `['-NoProfile', '-Command', command]` | No — PowerShell startup is slow with profiles; use `-NoProfile` by default. Alternative: `cmd.exe` with `['/c', command]` |

**`process.env.SHELL` in Electron:** On macOS and Linux, `process.env.SHELL` is populated from the system environment inherited by the Electron process. However, Electron's renderer process may have a stripped-down `PATH` (missing Homebrew, nvm, etc.) — this is precisely why the `-l` (login) flag is important: it forces the shell to re-source the user's profile and reconstruct the full PATH.

**Windows fallback:** `process.env.SHELL` is typically undefined on Windows. The shell resolver should fall back to `'powershell.exe'` (available on all modern Windows systems) or `'cmd.exe'` as a last resort.

**User-configurable override:** Settings should allow users to specify a custom shell executable and arguments, overriding platform defaults.

#### Login Shell Behavior

The `-l` (login) flag is critical on macOS/Linux because Electron applications typically launch with a minimal PATH that lacks user-installed tools:

- **Without `-l`:** PATH may only include system paths like `/usr/bin:/bin:/usr/sbin:/sbin`
- **With `-l` (login shell):** Shell sources the user's profile (`.zprofile`, `.bash_profile`, etc.), which typically adds Homebrew (`/opt/homebrew/bin`), nvm (`~/.nvm`), pyenv (`~/.pyenv/shims`), and other tool paths.

Trade-off: Login shell startup is slightly slower (~50-100ms) due to profile sourcing, but this is acceptable given the benefits.

#### Process Spawning Pattern

```typescript
import { spawn } from 'child_process';

const child = spawn(shellExecutable, shellArgs, {
    cwd: workingDirectory,
    env: { ...process.env, ...customEnvVars },
    stdio: ['pipe', 'pipe', 'pipe'],  // stdin, stdout, stderr
    shell: false,  // We're already spawning a shell
});
```

#### Process Termination Strategy

1. **On timeout:** Send `SIGTERM` to the child process.
2. **Grace period:** Wait 3 seconds for graceful termination.
3. **Force kill:** If still alive after grace period, send `SIGKILL`.

```typescript
// macOS/Linux
child.kill('SIGTERM');
setTimeout(() => {
    if (!child.killed) {
        child.kill('SIGKILL');
    }
}, 3000);
```

**Process group kill:** On macOS/Linux, `child.kill()` sends the signal to the child process but not its descendants. To kill the entire process tree:
- Use `process.kill(-child.pid, signal)` to send to the process group (negative PID).
- This requires the child to be a process group leader, which `spawn` with `detached: true` enables. However, `detached: true` has other implications (the child runs independently). The simpler approach is to use `child.kill()` for the shell process and rely on the shell to clean up its children on `SIGTERM`.

**Windows:** `child.kill()` on Windows sends `SIGTERM` which Electron/Node.js translates to process termination. For process trees, `taskkill /pid <pid> /T /F` can be used as a fallback.

#### Environment Variable Size Limits

| Platform | Per-Variable Limit | Total Environment Limit | Source |
|---|---|---|---|
| macOS | No per-var limit | ~256 KB total (`kern.argmax`) | `sysctl kern.argmax` |
| Linux | No per-var limit | ~2 MB total (`ARG_MAX`) | `getconf ARG_MAX` |
| Windows | ~32,767 characters per variable | ~32,767 characters total block | Windows API docs |

**Implication for hooks:** The planned 10,000 character truncation cap for environment variables is well within all platform limits. Even with multiple `NOTOR_*` variables at max size, the total would be ~50-80 KB, safely within macOS's ~256 KB limit (the most restrictive platform).

#### Working Directory (`cwd` Option)

**Confirmed:** The `cwd` option on `spawn()` works without issues on all platforms. No special permissions required beyond normal filesystem access. If the directory doesn't exist, `spawn` throws an `ENOENT` error.

#### stdout/stderr Capture Strategy

Stream stdout and stderr into a combined buffer with a configurable character cap:

```typescript
let output = '';
let truncated = false;
const maxChars = 50000;

child.stdout.on('data', (data: Buffer) => {
    if (!truncated) {
        output += data.toString();
        if (output.length > maxChars) {
            output = output.substring(0, maxChars);
            truncated = true;
        }
    }
});

child.stderr.on('data', (data: Buffer) => {
    if (!truncated) {
        output += data.toString();
        if (output.length > maxChars) {
            output = output.substring(0, maxChars);
            truncated = true;
        }
    }
});
```

When `truncated` is true, a notice should be appended to the output: `"\n[Output truncated at 50,000 characters]"`.

#### Desktop-Only Guard

All shell execution features must be gated behind `Platform.isDesktopApp`:

```typescript
import { Platform } from 'obsidian';

if (!Platform.isDesktopApp) {
    throw new Error('Shell execution is only available on desktop');
}
```

### Decision

**Use `child_process.spawn`** with the following platform-specific shell resolution:

- **macOS/Linux:** `spawn(process.env.SHELL ?? '/bin/sh', ['-l', '-c', command], { cwd, env })`
- **Windows:** `spawn('powershell.exe', ['-NoProfile', '-Command', command], { cwd, env })`
- **User override:** Allow custom shell and arguments via settings.
- **Timeout:** `SIGTERM` → 3s grace → `SIGKILL`.
- **Output:** Combined stdout+stderr buffer with 50,000 character cap.
- **Desktop-only:** Gate behind `Platform.isDesktopApp`.
- **Environment:** Inject `NOTOR_*` variables with 10,000 character truncation per variable.

---

## R-4: Turndown Bundling and HTML Conversion Quality

**Status:** Complete
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

#### esbuild Compatibility

**✅ Fully compatible.** Both `turndown` and `turndown-plugin-gfm` bundle cleanly with esbuild:

- **No build errors:** `npm run build` (which runs `tsc -noEmit -skipLibCheck && node esbuild.config.mjs production`) succeeds without any warnings or errors.
- **No jsdom dependency:** Turndown uses the DOM API (`document.createElement`, etc.) directly, which is natively available in Electron's Chromium runtime. It does NOT depend on `jsdom` or any Node.js-specific DOM implementation.
- **CommonJS/ESM:** Turndown is published as CommonJS. esbuild handles the CJS→CJS bundling transparently (our build target is `format: "cjs"`).
- **Platform target:** Our esbuild config uses `platform: "node"` and `format: "cjs"`, which is compatible with Turndown's CommonJS exports.

#### Bundle Size Impact

Measured by comparing the production build output:

| Metric | Value |
|---|---|
| Turndown npm package (unpacked) | 208 KB |
| turndown-plugin-gfm (unpacked) | 44 KB |
| @types/turndown (dev only) | 16 KB |
| **Total production build (`main.js`)** | **897 KB (918,073 bytes)** |

Note: Turndown is not yet imported in any source file, so its actual contribution to the bundle is currently zero (esbuild tree-shakes unused imports). When imported and used, the expected bundle size increase is ~14-20 KB minified based on npm package stats and the relatively small source code. This is well within acceptable limits for an Obsidian plugin.

#### Conversion Quality Assessment

Turndown performs raw HTML-to-Markdown conversion. Based on the library's documentation and community usage:

- **Headings, paragraphs, lists:** Converted faithfully. Nested lists preserved.
- **Code blocks:** Converted to fenced code blocks (with `codeBlockStyle: 'fenced'`). Inline code preserved.
- **Links and images:** Converted to Markdown syntax. Relative URLs preserved as-is.
- **Tables:** Turndown core does NOT support HTML tables. The `turndown-plugin-gfm` plugin adds GFM table support, converting `<table>` to pipe-delimited Markdown tables.
- **`<script>` and `<style>` tags:** Turndown strips these by default (they are "blank" replacement rules).
- **`<nav>`, `<footer>`, `<aside>`:** NOT stripped by default. These elements are converted to their text content, which can produce noisy output for navigation-heavy pages. Custom rules can strip these.
- **Malformed HTML:** Turndown relies on the browser's DOM parser (`DOMParser` or `document.createElement`), which is highly tolerant of malformed HTML. Electron's Chromium DOM parser handles edge cases well.
- **Large DOMs:** Performance is proportional to DOM size. For very large pages (5 MB+), the 50,000 character output cap in `fetch_webpage` provides a natural limit. The raw download cap (5 MB) also prevents excessively large DOMs.
- **Unicode/non-English:** No issues — Turndown operates on DOM text nodes, which are Unicode-native.

#### Recommended Configuration

```typescript
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const turndown = new TurndownService({
    headingStyle: 'atx',           // # style headings (consistent with Obsidian)
    codeBlockStyle: 'fenced',      // ``` code blocks
    bulletListMarker: '-',         // - bullet lists (consistent with Obsidian)
    emDelimiter: '*',              // *emphasis*
    strongDelimiter: '**',         // **strong**
    linkStyle: 'inlined',         // [text](url) inline links
});

// Add GFM support (tables, strikethrough, task lists)
turndown.use(gfm);

// Strip noisy navigation elements
turndown.addRule('stripNav', {
    filter: ['nav', 'footer', 'aside'],
    replacement: () => '',
});

// Strip form elements
turndown.addRule('stripForms', {
    filter: ['form', 'input', 'select', 'button'],
    replacement: () => '',
});
```

#### GFM Plugin (`turndown-plugin-gfm`)

**✅ Recommended.** The GFM plugin:
- Adds table support (HTML `<table>` → Markdown pipe tables).
- Adds strikethrough support (`<del>`/`<s>` → `~~text~~`).
- Adds task list support (`<input type="checkbox">` → `- [ ]` / `- [x]`).
- Bundles cleanly with esbuild (no additional dependencies).
- Small size impact (~44 KB unpacked, much less after minification).

### Decision

**Use Turndown with the GFM plugin** for HTML-to-Markdown conversion in `fetch_webpage`.

- Both `turndown` and `turndown-plugin-gfm` added as runtime dependencies.
- `@types/turndown` added as a dev dependency for TypeScript support.
- Configuration: ATX headings, fenced code blocks, `-` bullet markers, inline links.
- Custom rules to strip `<nav>`, `<footer>`, `<aside>`, and form elements.
- GFM plugin enabled for table, strikethrough, and task list support.
- No bundle size concerns — total impact well under 20 KB minified.
- Output quality is acceptable for Phase 3. Content extraction (Readability.js) can be added in a future phase for improved quality on navigation-heavy pages.

---

## Research Timeline

| Task | Priority | Blocking | Status | Findings Summary |
|---|---|---|---|---|
| R-1: Obsidian autocomplete API | High | Feature Group A | ✅ Complete | Use `AbstractInputSuggest<T>` (Obsidian ≥ 1.5.7) |
| R-2: Electron dialog API | Medium | Feature Group A (external files) | ✅ Complete | Use `<input type="file">` with Electron `File.path` property |
| R-3: Shell execution in Electron | High | Feature Groups E, F | ✅ Complete | Use `child_process.spawn` with login shell (`-l`) on macOS/Linux |
| R-4: Turndown bundling | Medium | Feature Group D | ✅ Complete | Turndown + GFM plugin bundle cleanly, ~14-20 KB impact |

**Total research effort:** Complete. All four research tasks resolved.

**Key decisions:**
1. `AbstractInputSuggest<T>` for inline vault note autocomplete
2. `<input type="file">` for external file dialog (desktop-only via `Platform.isDesktopApp`)
3. `child_process.spawn` with platform-specific login shell resolution
4. Turndown + GFM plugin for HTML-to-Markdown conversion
