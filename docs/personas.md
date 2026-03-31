# Personas

Personas let you define specialized AI personalities as vault notes. Each persona shapes the AI's system prompt, model preferences, and approval behavior.

## Defining a persona

Personas are stored as directories under `notor/personas/{persona-name}/`, each containing a `system-prompt.md` file. The note body is the persona's system prompt; frontmatter properties configure behavior.

**Frontmatter properties:**

| Property | Values | Description |
|---|---|---|
| `notor-persona-prompt-mode` | `"append"` (default) or `"replace"` | `append` adds the persona prompt after the global system prompt. `replace` uses only the persona's prompt as the base. Vault-level rule injections always apply regardless of this setting. |
| `notor-preferred-provider` | provider identifier string | Automatically switches to this provider when the persona is active. |
| `notor-preferred-model` | model identifier string | Automatically switches to this model when the persona is active. |

A reference section in **Settings → Notor** lists all configured providers and their available models with exact identifier strings and one-click copy buttons, making it easy to fill in persona frontmatter without guessing.

**Example `system-prompt.md`:**

```markdown
---
notor-persona-prompt-mode: "append"
notor-preferred-provider: "anthropic"
notor-preferred-model: "claude-opus-4-5"
---
You are a focused research assistant. Prefer concise, structured responses.
Always cite the specific vault notes you reference.
```

## Using the persona picker

Access the persona picker from the gear icon in the chat panel header. Selecting a persona immediately updates the active system prompt and model preferences for subsequent messages. The active persona name is shown as a badge near the chat input area.

## Per-persona auto-approve overrides

Configure per-tool approval behavior per persona in **Settings → Notor → Persona auto-approve**. Each tool offers three states:

- **Global default** — inherit the global auto-approve setting for that tool
- **Auto-approve** — always auto-approve this tool when this persona is active
- **Require approval** — always require manual approval, overriding a global auto-approve

Unconfigured tools fall back to global defaults. Configuration is stored in plugin settings data, not in persona frontmatter. Per-persona overrides extend to [MCP tools](mcp-servers.md) alongside built-in tools.

For more fine-grained control, personas also support `<notor_tool_config>` blocks in the `system-prompt.md` body to manage tool enabled/disabled state, auto-approve, and path restrictions declaratively. Persona-level tool config takes precedence over workflow and rule configs. See [Per-context tool configuration](vault-tools.md#per-context-tool-configuration) for the full syntax reference.

## Notes

- Personas are regular Obsidian notes — fully visible in the file explorer, searchable, and editable.
- The plugin rescans the personas directory when Settings is opened or the persona picker is activated; no plugin reload is needed when personas are created or deleted.
