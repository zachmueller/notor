# Getting started with Notor

## Requirements

- Obsidian **1.11.4** or later (desktop only)
- Node.js 18+ (for building from source)
- A running LLM provider (local or cloud)

## Install and build

```bash
git clone https://github.com/zachmueller/notor.git
cd notor
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault:

```
<Vault>/.obsidian/plugins/notor/
```

Reload Obsidian and enable **Notor** in **Settings → Community plugins**.

## Development (watch mode)

```bash
npm run dev
```

## Configure a provider

1. Open **Settings → Notor**
2. Choose a provider (defaults to local OpenAI-compatible at `http://localhost:11434/v1`)
3. Enter credentials if required (stored securely via Obsidian's secrets manager)
4. Select a model from the dropdown (or type a model ID if the list is unavailable)
5. Open the Notor chat panel from the sidebar ribbon and start a conversation

You can control which tools are available and configure auto-approve in **Settings → Notor → Tools**. See [vault-tools.md](vault-tools.md#enabling-and-disabling-tools) for details.

### AWS Bedrock

AWS Bedrock uses the Converse API with two authentication methods:

1. **Named profile** (recommended) — uses your `~/.aws/config` and `~/.aws/credentials` files.
   - Set the **Region** dropdown to your preferred AWS region (default: `us-east-1`).
   - Enter your **AWS profile name** (default: `default`).
   - Leave the access key fields empty — credentials are loaded from disk via `fromIni()`.

2. **Direct keys** — enter an AWS access key ID and secret access key directly.
   - Credentials are stored securely via Obsidian's secrets manager.
   - Use this method when you don't have a local AWS config file (e.g., on a shared machine).

Required IAM permissions: `bedrock:InvokeModelWithResponseStream` (for chat) and `bedrock:ListInferenceProfiles` (for model discovery).

## Command palette reference

All Notor commands are accessible via the Obsidian command palette (Ctrl/Cmd+P):

| Command | Description |
|---------|-------------|
| **Notor: Open chat panel** | Opens the main Notor chat interface |
| **Notor: New conversation** | Creates a fresh conversation |
| **Notor: Compact context** | Manually compacts the current conversation's context window |
| **Notor: Run workflow** | Opens a workflow picker to select and run a workflow |
| **Notor: Export conversation** | Exports the active conversation to HTML or Markdown |
| **Notor: Import conversation from HTML** | Imports a previously exported HTML conversation |
| **Notor: Open tool config inspector** | Opens a debugging view showing the effective tool configuration |

## Create your first persona

Personas let you define specialized AI personalities with their own system prompt, model preferences, and approval behavior. See [personas.md](personas.md) for the full reference.

1. Create the directory `notor/personas/my-persona/` in your vault
2. Create `system-prompt.md` inside it — the body content is the persona's system prompt
3. Optionally add frontmatter:
   ```yaml
   ---
   notor-persona-prompt-mode: "append"
   notor-preferred-provider: "anthropic"
   notor-preferred-model: "claude-opus-4-5"
   ---
   ```
4. Open the Notor chat panel → click the gear icon → select your persona

## Create your first workflow

Workflows are reusable instruction sets stored as vault notes that guide the AI through structured tasks. See [workflows.md](workflows.md) for the full reference.

1. Create `notor/workflows/my-workflow.md` in your vault
2. Add frontmatter and write the instructions:
   ```markdown
   ---
   notor-workflow: true
   notor-trigger: manual
   notor-workflow-persona: "my-persona"
   ---
   # My workflow

   ## Step 1
   Search the vault for notes tagged #todo.

   ## Step 2
   Summarize the action items found across all matching notes.
   ```
3. Open the command palette → **Notor: Run workflow** → select your workflow

> You can also create workflows (and rules) from **Settings → Notor → Rules & Workflows** instead of creating files manually.

## Connect your first MCP server

> **Desktop only** for stdio servers. HTTP-based servers (SSE, Streamable HTTP) work on all platforms.

MCP servers extend the AI's built-in tool set with custom tools from local or remote sources. See [mcp-servers.md](mcp-servers.md) for the full reference.

The example below uses the community filesystem MCP server, which gives the AI access to a directory on your machine:

1. Open **Settings → Notor → MCP servers** and click **Add server**
2. Acknowledge the trust warning, then configure:
   - **Name:** `filesystem`
   - **Transport:** `stdio`
   - **Command:** `npx` (use the absolute path if Obsidian can't find it — run `which npx` in your terminal)
   - **Arguments:** `-y @modelcontextprotocol/server-filesystem /path/to/your/directory`
3. Save — Notor spawns the process and performs the MCP handshake automatically
4. The status dot turns green and discovered tools appear in the server's settings entry (e.g., `read_file`, `write_file`, `list_directory`)
5. Open the Notor chat panel — the MCP status icon in the header confirms the server is connected
6. Ask the AI something like "List the files in my directory" — the AI will invoke `filesystem/list_directory`, the approval UI will appear, and after you approve, the result is returned inline in the chat

To connect a remote HTTP server instead:
1. Click **Add server**, select transport **Streamable HTTP** (or **SSE**)
2. Enter the server's URL and any required headers (mark `Authorization` values as **Sensitive** to store them encrypted)
3. Save — the server connects and tools are discovered automatically; HTTP servers auto-reconnect if the connection drops

## Set up sub-agents

Sub-agents let the AI spawn focused child conversations for tasks like vault search or web research. Three built-in profiles are ready to use out of the box. See [sub-agents.md](sub-agents.md) for the full reference.

The built-in profiles (`search-vault`, `search-web`, `notor-help`) are enabled by default — the AI will use them automatically when appropriate. To create your own:

1. Open **Settings → Notor → Sub-agents** and click **Create new sub-agent**
2. Enter a name — Notor creates the profile directory and skeleton file
3. Edit the `system-prompt.md` that opens:
   - Write a `notor-description` in the frontmatter (so the AI knows when to use it)
   - Add a system prompt describing the agent's purpose
   - Add a `<notor_tool_config>` block enabling only the tools the agent needs
4. The profile is immediately available — ask the AI something that would benefit from focused investigation

> Sub-agents use default-deny tool access. A sub-agent can only use tools that are both enabled in its profile AND enabled in the parent conversation. See [sub-agents.md](sub-agents.md#tool-access) for details.

## Configure Word & file tools

> **Desktop only.** These tools are unavailable on mobile.

The `read_file`, `read_docx`, and `write_docx` tools let the AI read text files, read Word documents as Markdown, and generate new `.docx` files. All three require at least one allowed path before they can access anything outside the vault. See [vault-tools.md](vault-tools.md#word--file-tools) for the full tool reference.

1. Open **Settings → Notor → Word & file tools**
2. Under **Allowed read/write paths**, click **Add path** and enter a directory the tools should be able to access (e.g. `~/Documents`). The vault root is always implicitly allowed — no need to add it.
3. Optionally set a **Default output directory** — a vault-relative or absolute path where `write_docx` saves files when no `output_path` is specified per call (e.g. `exports` or `/Users/you/Documents/reports`).
4. Optionally set a **Default template path** — a path to a `.docx` file whose fonts, margins, headers, and footers will be applied to every generated document unless overridden. The field validates on blur and shows an inline error if the file doesn't exist or isn't a `.docx`.
5. Open the Notor chat panel and try it out:
   - "Read `~/Documents/report.docx` and summarize the key points."
   - "Write a project brief based on my notes and save it as `brief.docx`."
