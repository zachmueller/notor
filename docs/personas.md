# Personas

Personas let you define specialized AI personalities as vault notes. Each persona shapes the AI's system prompt, model preferences, and approval behavior.

## Defining a persona

Personas are stored as directories under `notor/personas/{persona-name}/`, each containing a `system-prompt.md` file. The note body is the persona's system prompt; frontmatter properties configure behavior.

**Frontmatter properties:**

| Property | Values | Description |
|---|---|---|
| `notor-persona-prompt-mode` | `"append"` (default) or `"replace"` | `append` adds the persona prompt after the global system prompt. `replace` uses only the persona's prompt as the base. Vault-level rule injections always apply regardless of this setting. |
| `notor-preferred-preset` | preset name string | Automatically resolves to the preset's provider and model when this persona is active. See [model-presets.md](model-presets.md). |
| `notor-preferred-provider` | provider identifier string | Switches the chat panel (or background workflow run) to this provider when the persona is selected. |
| `notor-preferred-model` | model identifier string | Switches the chat panel (or background workflow run) to this model when the persona is selected. |

**Model resolution priority** (highest to lowest): `notor-preferred-preset` → `notor-preferred-provider` + `notor-preferred-model` → global default preset. If a preset is specified but doesn't exist or isn't configured, a notice is shown and resolution falls through to the legacy provider/model overrides.

A reference section in **Settings → Notor** lists all configured providers and their available models with exact identifier strings and one-click copy buttons, making it easy to fill in persona frontmatter without guessing.

**Example `system-prompt.md`:**

```markdown
---
notor-persona-prompt-mode: "append"
notor-preferred-preset: "large"
---
You are a focused research assistant. Prefer concise, structured responses.
Always cite the specific vault notes you reference.
```

> You can also use `notor-preferred-provider` and `notor-preferred-model` instead of a preset for direct provider/model control.

## Using the persona picker

Access the persona picker from the gear icon in the chat panel header. Selecting a persona immediately updates the active system prompt and model preferences for subsequent messages. The active persona name is shown as a badge near the chat input area.

## Built-in personas

Notor ships with four built-in personas that appear in the persona picker with a "Built-in" badge. Unlike user-defined personas (which live as vault files), built-in personas are bundled with the plugin. You can open them from **Settings → Notor → Personas** and customize them by clicking **Open** — this creates an editable vault file from the default. Click **Reset to default** to restore the original.

| Persona | Chip | Purpose |
|---------|------|---------|
| `notor-help` | ⚙️ | Notor configuration assistant. Reads and edits plugin settings via `read_notor_settings` / `edit_notor_settings` with your approval, and delegates documentation lookups to the `notor-help` sub-agent. Use this persona when you want conversational help configuring the plugin. |
| `tool-creator` | 🔧 | Guides creation of custom tools and automations. Specialized for writing extension Markdown files with correct frontmatter, parameter schemas, and TypeScript logic. |
| `circuit-creator` | 🔀 | Guides authoring of circuits: `definition.md`, conversation and code steps, evaluators, and composition. See [Circuits](circuits.md). |
| `circuit-eval-reviewer` | 📊 | Read-only reviewer of circuit evaluation reports. Compares finished runs of a circuit by their scores (grouped by evaluator fingerprint), drills into rationales, and recommends which run came out best. See [Evaluating runs](circuits.md#evaluating-runs). |

## Per-persona auto-approve

A persona controls which tools run without asking through a `<notor_tool_config>` block in its `system-prompt.md` body. The block also sets which tools are enabled and which paths they may touch:

```markdown
<notor_tool_config>
write_note:
  auto_approve: true
read_note:
  auto_approve: true
execute_command:
  enabled: false
</notor_tool_config>
```

Tools the block doesn't mention, and fields it leaves unset, fall back to **Settings → Notor → Tools**. MCP tools use their `server__tool` names. Precedence, highest first: workflow → persona → rule → global defaults, so a workflow's block can override its persona's. A global **Always ask** path scope still prompts even when the persona auto-approves the tool. See [Per-context tool configuration](vault-tools.md#per-context-tool-configuration) for the full syntax reference.

## Notes

- Personas are regular Obsidian notes — fully visible in the file explorer, searchable, and editable.
- The plugin rescans the personas directory when Settings is opened or the persona picker is activated; no plugin reload is needed when personas are created or deleted.
- **Auto-refresh on file change** — when you save or modify a persona file, every panel using that persona picks up the change, including its tool config, from the next message. If a parse error occurs, the previous persona state remains active and a persistent error Notice is shown.
- **Per-panel isolation** — in multi-panel mode, each chat panel maintains independent persona state. Switching personas in one panel does not affect other open panels.

## Circuits

Personas also drive **circuit** conversation steps: a step note's `notor-step-persona` selects the persona (system prompt, tool config, provider/model) for that step's LLM turn, and an evaluator note's `notor-eval-persona` selects the judge for a circuit evaluation. The built-in `circuit-creator` persona (formerly `orchestration-creator`, a name that still resolves) interactively guides authoring a circuit; `circuit-eval-reviewer` compares evaluated runs. See [Circuits](circuits.md).
