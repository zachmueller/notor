# Developer Quickstart: Phase 3 — Context & Intelligence

**Created:** 2026-07-03
**Plan:** [specs/02-context-intelligence/plan.md](plan.md)

Additions to the development environment for Phase 3 features. This supplements the base quickstart guide at [specs/01-mvp/quickstart.md](../01-mvp/quickstart.md).

---

## New Dependencies

### Turndown (HTML-to-Markdown conversion)

Phase 3 introduces [Turndown](https://github.com/mixmark-io/turndown) as a runtime dependency for the `fetch_webpage` tool.

```bash
npm install turndown
npm install --save-dev @types/turndown
```

**Optional GFM plugin** (for table and strikethrough support):

```bash
npm install turndown-plugin-gfm
```

Bundle size impact is minimal (~14 KB minified for Turndown core). Both packages are pure JavaScript with no native dependencies, and bundle cleanly with esbuild.

---

## Updated Project Structure

Phase 3 adds the following source directories and files to the structure documented in [specs/01-mvp/quickstart.md](../01-mvp/quickstart.md):

```
src/
├── ... (existing Phase 0–2 modules)
├── context/                    # Phase 3: Context assembly
│   ├── auto-context.ts         # Auto-context source collectors (open notes, vault structure, OS)
│   ├── attachment.ts           # Attachment model, resolution, and XML serialization
│   ├── message-assembler.ts    # User message assembly (auto-context + attachments + hooks + text)
│   └── compaction.ts           # Auto-compaction logic, threshold checking, summarization
├── hooks/                      # Phase 3: LLM lifecycle hooks
│   ├── hook-engine.ts          # Hook execution engine (shell spawning, env vars, timeout)
│   ├── hook-config.ts          # Hook configuration model and settings integration
│   └── hook-events.ts          # Event dispatching (pre-send, on-tool-call, on-tool-result, after-completion)
├── shell/                      # Phase 3: Shell execution (shared by execute_command + hooks)
│   ├── shell-executor.ts       # Core shell spawning logic (child_process.spawn wrapper)
│   ├── shell-resolver.ts       # Platform-specific shell resolution ($SHELL, PowerShell, custom)
│   └── output-buffer.ts        # Stdout/stderr buffering with size cap and truncation
├── tools/
│   ├── ... (existing Phase 1–2 tools)
│   ├── fetch-webpage.ts        # Phase 3: fetch_webpage tool
│   └── execute-command.ts      # Phase 3: execute_command tool
├── ui/
│   ├── ... (existing Phase 1–2 UI)
│   ├── attachment-picker.ts    # Phase 3: Attachment button, vault note autocomplete, file picker
│   ├── attachment-chips.ts     # Phase 3: Attachment chip display and management
│   └── compaction-marker.ts    # Phase 3: Compaction indicator and marker UI
```

---

## Feature-Specific Development Notes

### Auto-Context (Feature Group B)

No external dependencies. Uses existing Obsidian APIs:

```typescript
// Open note paths
const leaves = this.app.workspace.getLeavesOfType("markdown");
const paths = leaves
  .map(leaf => (leaf.view as any).file?.path)
  .filter(Boolean);

// Top-level vault folders
const rootChildren = this.app.vault.getRoot().children ?? [];
const folders = rootChildren
  .filter(child => child instanceof TFolder)
  .map(folder => folder.name);

// OS platform
const platform = process.platform; // "darwin" | "win32" | "linux"
const osName = platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";
```

### Attachments (Feature Group A)

Depends on research R-1 (autocomplete API) and R-2 (Electron dialog). Key Obsidian APIs:

```typescript
// Section header enumeration for [[Note#Section]] support
const file = this.app.vault.getAbstractFileByPath("Research/Climate.md");
if (file instanceof TFile) {
  const cache = this.app.metadataCache.getFileCache(file);
  const headings = cache?.headings ?? [];
  // headings: Array<{ heading: string, level: number, position: { start, end } }>
}

// Reading note content at send time
const content = await this.app.vault.read(file);
```

### Shell Execution (Feature Groups E, F)

Depends on research R-3. Core pattern:

```typescript
import { spawn } from "child_process";

const shell = process.env.SHELL || "/bin/zsh";
const child = spawn(shell, ["-l", "-c", command], {
  cwd: workingDirectory,
  env: { ...process.env, ...notorEnvVars },
});

let output = "";
child.stdout.on("data", (data) => { output += data.toString(); });
child.stderr.on("data", (data) => { output += data.toString(); });

const timeout = setTimeout(() => {
  child.kill("SIGTERM");
  setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 3000);
}, timeoutMs);

child.on("close", (code) => {
  clearTimeout(timeout);
  // handle result
});
```

### Web Fetching (Feature Group D)

Depends on research R-4. Core pattern:

```typescript
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

const response = await fetch(url, {
  headers: { "User-Agent": "Notor/1.0" },
  redirect: "follow",
  signal: AbortSignal.timeout(timeoutMs),
});

const contentType = response.headers.get("content-type") ?? "";
const body = await response.text();

let result: string;
if (contentType.includes("text/html")) {
  result = turndown.turndown(body);
} else {
  result = body;
}
```

---

## Testing Phase 3 Features

### Manual Testing Checklist

In addition to the MVP manual testing checklist:

1. **Attachments:**
   - Attach a vault note via the button menu → verify chip appears
   - Type `[[` in chat input → verify autocomplete opens
   - Attach a section reference (`[[Note#Section]]`) → verify only section content is sent
   - Attach an external text file → verify content is included
   - Attempt to attach a binary file → verify error message
   - Attach a file > 1 MB → verify confirmation dialog
   - Delete a note after attaching → send message → verify inline warning

2. **Auto-context:**
   - Open several notes → send a message → verify open note paths in LLM context (check via tool transparency or JSONL log)
   - Disable auto-context sources in settings → verify they are omitted
   - Send a message with no notes open → verify no error

3. **Auto-compaction:**
   - Have a long conversation approaching context limit → verify "Compacting context…" indicator appears
   - After compaction → verify "Context compacted" marker with timestamp
   - Trigger manual compaction → verify it works
   - Check JSONL log → verify compaction record is present

4. **`fetch_webpage`:**
   - Ask AI to fetch a URL → verify Markdown content returned
   - Fetch a plain text URL → verify returned as-is
   - Add a domain to denylist → attempt fetch → verify blocked
   - Fetch a large page → verify truncation notice

5. **`execute_command`:**
   - Ask AI to run a command in Act mode → verify approval prompt and output
   - Attempt in Plan mode → verify blocked
   - Set working directory outside vault → verify rejection
   - Run a long command → verify timeout behavior

6. **Hooks:**
   - Configure a `pre-send` hook (e.g., `echo "hook output"`) → send message → verify output in context
   - Configure an `after-completion` hook → verify it fires after response
   - Configure a hook with a timeout-exceeding command → verify timeout notice
   - Disable a hook → verify it does not fire

### E2E Test Extensions

Extend the Playwright e2e test suite with:

- Attachment resolution and message assembly tests
- Auto-context collection correctness tests
- `fetch_webpage` with mock HTTP server
- `execute_command` with safe test commands (e.g., `echo`, `pwd`)
- Hook execution with captured stdout verification
- Compaction threshold detection (with a mock model that has a small context window)

---

## Debugging Phase 3 Features

### Useful Console Commands

```typescript
// Check auto-context output
const plugin = app.plugins.plugins["notor"];

// Inspect open leaves
app.workspace.getLeavesOfType("markdown").map(l => (l.view as any).file?.path);

// Check vault root children
app.vault.getRoot().children?.map(c => c.name);

// Inspect hook configuration
plugin.settings.hooks;

// Check domain denylist
plugin.settings.domain_denylist;
```

### JSONL Log Inspection

Phase 3 adds new record types to the JSONL conversation logs. To inspect:

```bash
# Find the latest conversation log
ls -la /path/to/vault/.obsidian/plugins/notor/history/

# View compaction records
grep '"type":"compaction"' /path/to/vault/.obsidian/plugins/notor/history/*.jsonl

# View messages with attachments
grep '"attachments"' /path/to/vault/.obsidian/plugins/notor/history/*.jsonl | head -5

# View auto-context data
grep '"auto_context"' /path/to/vault/.obsidian/plugins/notor/history/*.jsonl | head -5
```

---

## Desktop-Only Features

The following Phase 3 features require Node.js APIs and are desktop-only:

| Feature | Requires | Mobile Available |
|---|---|---|
| `execute_command` | `child_process` | ❌ |
| LLM hooks | `child_process` | ❌ |
| External file attachment | `fs` + Electron dialog | ❌ |
| Vault note attachment | Obsidian vault API | ✓ |
| Auto-context | Obsidian workspace API | ✓ |
| Auto-compaction | LLM API | ✓ |
| `fetch_webpage` | `fetch` API | ✓ |

Gate desktop-only features with:

```typescript
import { Platform } from "obsidian";

if (Platform.isDesktop) {
  // Register execute_command, hooks, external file picker
}