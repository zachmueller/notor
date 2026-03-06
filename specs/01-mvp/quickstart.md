# Developer Quickstart: Notor

**Created:** 2026-06-03
**Plan:** [specs/01-mvp/plan.md](plan.md)

Guide for setting up the Notor development environment and getting started with plugin development.

---

## Prerequisites

- **Node.js:** LTS version (18+ recommended)
- **npm:** Comes with Node.js
- **Obsidian:** Desktop application installed (macOS, Windows, or Linux)
- **Git:** For version control
- **An LLM provider** (for testing): Ollama (recommended for local development), or an API key for OpenAI/Anthropic/Bedrock

---

## Initial Setup

### 1. Clone and install

```bash
git clone https://github.com/zachmueller/notor.git
cd notor
npm install
```

### 2. Set up an Obsidian test vault

Create or choose an Obsidian vault for development testing. The e2e test framework includes a vault setup script:

```bash
npm run e2e:setup-vault
```

This creates a test vault at `e2e/test-vault/` with the plugin structure pre-configured.

### 3. Link the plugin to a vault for manual testing

For manual testing in your own Obsidian vault, copy or symlink the build output:

```bash
# Create the plugin directory in your vault
mkdir -p "/path/to/your/vault/.obsidian/plugins/notor"

# Option A: Symlink (recommended for development — changes reflect immediately after rebuild)
ln -s "$(pwd)/main.js" "/path/to/your/vault/.obsidian/plugins/notor/main.js"
ln -s "$(pwd)/manifest.json" "/path/to/your/vault/.obsidian/plugins/notor/manifest.json"
ln -s "$(pwd)/styles.css" "/path/to/your/vault/.obsidian/plugins/notor/styles.css"

# Option B: Copy (for one-off testing)
cp main.js manifest.json styles.css "/path/to/your/vault/.obsidian/plugins/notor/"
```

### 4. Enable the plugin

1. Open Obsidian and go to **Settings → Community plugins**.
2. Enable community plugins if prompted.
3. Find **Notor** in the installed plugins list and enable it.

---

## Development Workflow

### Build commands

| Command | Description |
|---|---|
| `npm run dev` | Start esbuild in watch mode — rebuilds `main.js` on every source change |
| `npm run build` | Production build with TypeScript checking (`tsc -noEmit`) + esbuild |
| `npm run lint` | Run eslint on the project |

### Dev mode (watch)

```bash
npm run dev
```

This starts esbuild in watch mode. Every time you save a source file, `main.js` is rebuilt. To see changes in Obsidian:

1. **Reload the plugin:** Open the Obsidian command palette (Cmd/Ctrl+P) and run "Reload app without saving" or disable/re-enable the plugin in settings.
2. **Hot reload plugin (community):** For faster iteration, install the [Hot-Reload](https://github.com/pjeby/hot-reload) community plugin, which automatically reloads plugins when `main.js` changes.

### Project structure

```
notor/
├── src/                    # TypeScript source code
│   ├── main.ts             # Plugin entry point (lifecycle only)
│   ├── settings.ts         # Settings interface and defaults
│   └── utils/
│       └── logger.ts       # Logging utility
├── design/                 # Design documentation
│   ├── architecture.md
│   ├── roadmap.md
│   ├── tools.md
│   └── ux.md
├── specs/                  # Feature specifications
│   └── 01-mvp/
│       ├── spec.md
│       ├── plan.md
│       ├── research.md
│       ├── data-model.md
│       ├── quickstart.md
│       └── contracts/
├── e2e/                    # End-to-end tests (Playwright)
├── build/                  # Build configuration
├── manifest.json           # Obsidian plugin manifest
├── styles.css              # Plugin styles
├── esbuild.config.mjs      # esbuild configuration
├── tsconfig.json           # TypeScript configuration
└── package.json
```

### Planned source structure (post-implementation)

As implementation progresses, the `src/` directory should follow these conventions:

```
src/
├── main.ts                 # Plugin entry point — lifecycle only (onload, onunload)
├── settings.ts             # Settings interface, defaults, PluginSettingTab
├── types.ts                # Shared TypeScript interfaces and types
├── providers/              # LLM provider implementations
│   ├── index.ts            # Provider registry and factory
│   ├── provider.ts         # LLMProvider interface definition
│   ├── local-provider.ts   # Local OpenAI-compatible provider
│   ├── anthropic-provider.ts
│   ├── openai-provider.ts
│   └── bedrock-provider.ts
├── tools/                  # Tool implementations
│   ├── index.ts            # Tool registry
│   ├── tool.ts             # Tool interface definition
│   ├── read-note.ts
│   ├── write-note.ts
│   ├── replace-in-note.ts
│   ├── search-vault.ts
│   ├── list-vault.ts
│   ├── read-frontmatter.ts     # Phase 2
│   ├── update-frontmatter.ts   # Phase 2
│   └── manage-tags.ts          # Phase 2
├── chat/                   # Chat system
│   ├── conversation.ts     # Conversation management
│   ├── dispatcher.ts       # Tool dispatch logic
│   ├── history.ts          # JSONL persistence
│   └── context.ts          # Context window management
├── ui/                     # UI components
│   ├── chat-view.ts        # Chat panel (ItemView)
│   ├── diff-view.ts        # Diff preview component
│   ├── approval-ui.ts      # Tool approval prompts
│   └── checkpoint-ui.ts    # Checkpoint timeline (Phase 2)
├── checkpoints/            # Phase 2
│   ├── checkpoint.ts       # Checkpoint creation and management
│   └── storage.ts          # Checkpoint persistence
├── rules/                  # Phase 2
│   └── vault-rules.ts      # Vault-level rule evaluation
└── utils/
    ├── logger.ts           # Logging utility
    ├── secrets.ts          # Secrets manager wrapper
    └── tokens.ts           # Token counting utilities
```

---

## Testing

### End-to-end tests

The project uses Playwright for e2e testing against a running Obsidian instance:

```bash
# Set up the test vault
npm run e2e:setup-vault

# Run e2e tests
npm run e2e

# Quick run (10s duration)
npm run e2e:run:quick
```

See `e2e/README.md` for detailed e2e testing documentation.

### Manual testing checklist

When testing changes manually:

1. **Plugin loads without errors:** Check the Obsidian developer console (Cmd/Ctrl+Shift+I) for errors on startup.
2. **Settings render correctly:** Open **Settings → Notor** and verify all settings are visible and functional.
3. **Chat panel opens:** Verify the chat panel can be opened from the sidebar or command palette.
4. **Provider connection:** Configure an LLM provider and verify it connects successfully.
5. **Streaming works:** Send a message and verify the response streams token-by-token.
6. **Tools execute:** Test each tool (read, write, search, list) and verify results appear in the chat.
7. **Plan/Act mode:** Toggle modes and verify write tools are blocked in Plan mode.
8. **Plugin unloads cleanly:** Disable the plugin and verify no errors or leaked resources.

---

## Local LLM Setup (Ollama)

For local development without cloud API keys:

### Install Ollama

```bash
# macOS
brew install ollama

# Or download from https://ollama.ai
```

### Pull a model

```bash
ollama pull llama3.2
```

### Start the server

```bash
ollama serve
```

Ollama serves an OpenAI-compatible API at `http://localhost:11434/v1` by default. This matches Notor's default local provider endpoint.

---

## Debugging

### Obsidian developer console

Open with **Cmd+Shift+I** (macOS) or **Ctrl+Shift+I** (Windows/Linux). Plugin logs, errors, and network requests are visible here.

### Source maps

The esbuild configuration generates source maps in dev mode, so stack traces in the developer console point to the original TypeScript source files.

### Useful Obsidian APIs for debugging

```typescript
// Access the plugin instance
const plugin = app.plugins.plugins["notor"];

// Access vault files
app.vault.getFiles();
app.vault.getMarkdownFiles();

// Read a file
const file = app.vault.getAbstractFileByPath("path/to/note.md");
if (file instanceof TFile) {
  const content = await app.vault.read(file);
}

// Check metadata cache
app.metadataCache.getFileCache(file);
```

---

## Key Dependencies

| Package | Purpose | Phase |
|---|---|---|
| `obsidian` | Obsidian plugin API types | 0 |
| `@aws-sdk/client-bedrock-runtime` | Bedrock model invocation | 0 |
| `@aws-sdk/client-bedrock` | Bedrock model listing | 0 |
| `@aws-sdk/credential-providers` | AWS credential chain resolution | 0 |

**Note:** The AWS SDK packages are not yet in `package.json`. They will be added during Phase 0 implementation. All other LLM providers (local, Anthropic, OpenAI) use raw HTTP requests via the built-in `fetch` API — no additional dependencies required.

---

## Code Conventions

- **TypeScript strict mode:** `"strict": true` in `tsconfig.json`
- **Keep `main.ts` minimal:** Only plugin lifecycle (`onload`, `onunload`, `addCommand`). Delegate to modules.
- **File size limit:** If a file exceeds ~200-300 lines, split into smaller modules.
- **Single responsibility:** Each file has one well-defined purpose.
- **Async/await:** Prefer over promise chains. Always handle errors.
- **Register cleanup:** Use `this.register*` helpers for all listeners, intervals, and DOM elements.
- **Obsidian API:** Use vault API (not raw filesystem) for all file operations.
- **No telemetry:** No analytics, tracking, or external calls beyond user-configured LLM endpoints.