# Model presets

Model presets let you create named aliases — like `tiny`, `small`, `medium`, and `large` — that each map to a specific provider and model. Instead of managing separate provider and model dropdowns, you select a single preset and Notor resolves the rest.

## Default presets

Notor ships with four built-in preset names, all unconfigured:

| Preset | Purpose (suggested) |
|--------|---------------------|
| `tiny` | Cheapest/fastest model for simple tasks |
| `small` | Lightweight model for short interactions |
| `medium` | General-purpose model (default for new conversations) |
| `large` | Most capable model for complex tasks |

These names are suggestions — you can rename them, delete all but the default, or add custom presets with any name you like.

## Configuring presets

Open **Settings → Notor → Models**. Each preset appears as a row with:

- **Name** — editable text field (must be unique across presets)
- **Provider** dropdown — lists only enabled and configured providers
- **Model** dropdown — populated from the selected provider's model list. Extended context (1M) variants appear with an `(1M)` suffix.
- **Reorder** buttons (↑ ↓) — controls display order in the chat panel dropdown
- **Delete** button — removes the preset (disabled for the current default preset)

**Default preset selector** — a dropdown at the top of the section. The selected preset is used for all new conversations. Only presets with both a provider and model assigned appear as options.

**Add preset** — click the button to create a new unconfigured preset. It receives an auto-generated name (`preset-1`, etc.) that you can rename immediately.

### Migration from pre-preset installations

When upgrading an existing Notor installation, the four default presets are auto-initialized and the `medium` preset is configured from your current active provider and model. No manual reconfiguration is needed — existing conversations continue working.

## Using presets in the chat panel

Click the gear icon in the chat panel header to open the settings popover. The **Model Preset** dropdown shows:

- All configured presets with provider and model details in lighter text
- Unconfigured presets greyed out and marked "(not configured)"
- A separator
- **Custom...** — reveals the legacy provider and model dropdowns for one-off selections

Selecting a preset sets the provider and model for subsequent messages. The current preset is marked with a checkmark.

### Custom escape hatch

Select **Custom...** to bypass presets entirely and pick a provider and model directly. Custom selections are not saved as a preset — the conversation stores `preset_name: null` and falls back to the concrete provider and model.

## Stale preset detection

If a conversation was created with a preset that has since been reconfigured (different provider or model), Notor detects the mismatch. The dropdown falls back to **Custom** and shows a notice: *"Preset 'X' has changed since this conversation was created."* The original provider and model are preserved on the conversation.

## Persona preset override

Personas can specify a preferred preset via `notor-preferred-preset` in their frontmatter. When the persona is active, the preset's provider and model are used automatically. See [personas.md](personas.md) for details and resolution priority.

## Memory preset requirements

The [knowledge memory](memory.md) feature requires the **tiny** and **large** presets to be configured. Memory sub-agents use `tiny` for search, capture, and concept resolution tasks (lightweight, fast operations), and `large` for the Dream consolidation pipeline (complex cross-session analysis). Enabling memory validates these presets and shows an error if either is missing.

## Title generation

Notor includes a built-in **Title Generation** automation that uses an LLM call to auto-generate a short descriptive title for new conversations.

**Configuration** — in **Settings → Notor → Extensions**, the Title Generation automation has:

- **Enabled** toggle (default: off)
- **Preset** selector — the model preset used for the title generation call (default: `small`)

When enabled, the automation fires once per conversation on the first user message. If the LLM call fails, the conversation keeps a truncated title from the first message as a fallback.

The title generation automation is a built-in scaffold. To customize the prompt or behavior, click **Open** in its settings row to create a vault file (`notor/automations/title-generation.md`), then edit and reload extensions.
