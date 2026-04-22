# System prompt customization

Notor uses a built-in system prompt that defines the AI's behavior, tool usage guidelines, and interaction style. You can export and customize this prompt to rearrange sections, add domain-specific instructions, or change the AI's base personality.

## Exporting the default prompt

1. Open **Settings → Notor**
2. Click **Customize system prompt**
3. Notor creates `{notor_dir}/prompts/core-system-prompt.md` with the full built-in default and opens it in a new editor tab

Once this file exists, Notor uses it instead of the built-in default. Delete the file to revert to the built-in prompt.

## Template variables

The system prompt supports two kinds of template variables: static variables resolved at load time, and dynamic section markers resolved when the prompt is assembled for each message.

### Static variables

| Variable | Description |
|----------|-------------|
| `{notor_dir}` | Your Notor directory path (e.g., `notor`) |
| `{notor_dir_base}` | Base name of the Notor directory |
| `{vault_name}` | Your vault name |
| `{vault_root}` | Vault root path |

### Dynamic section markers

| Marker | Content injected |
|--------|-----------------|
| `{available_tools}` | Formatted list of all available tools and their parameters |
| `{mode_instructions}` | Plan/Act mode instructions for the current mode |
| `{vault_rules}` | Content from matched vault rules |
| `{auto_context}` | Workspace context (open notes, vault structure, OS info) |
| `{memory_convention}` | Memory interpretation guidance (when memory is enabled) |

### Behavior

- **Backward compatible** — if a dynamic marker is NOT present in your custom prompt, its section is automatically appended at the end, matching the default behavior.
- **Inline placement** — include a marker to control exactly where that section appears in the prompt.
- **Omission** — to drop a section entirely, do not include its marker and remove the corresponding content from the appended sections by leaving the marker text in a location where it produces empty content.

This lets you reorder sections — for example, move `{vault_rules}` above `{available_tools}` to give rules higher prompt priority.

## Template variables in other contexts

Static template variables (`{notor_dir}`, `{vault_name}`, etc.) are also resolved in:

- **Persona system prompts** — use variables in persona files to reference vault-relative paths
- **Sub-agent profiles** — memory sub-agents use `{notor_dir}/memory/` in their `<notor_tool_config>` blocks to scope tool access paths
- **Vault rules** — reference the Notor directory or vault name dynamically
- **Extension tool and automation configs** — `<notor_tool_config>` blocks in extension files support template variables

Variables are resolved in two passes: first in the base content, then again after [`<include_note>`](include-note.md) tags are resolved, so variables appearing in included notes are also substituted.

## Interaction with personas

How the custom system prompt interacts with [personas](personas.md) depends on the persona's prompt mode:

- **Append mode** (default) — the persona's prompt is appended after the base system prompt. Dynamic markers in the base prompt control section placement.
- **Replace mode** — the persona's prompt replaces the base entirely. Dynamic markers in the persona prompt control where sections appear; sections without markers are appended at the end.

## Notes

- [`<include_note>`](include-note.md) tags work inside the custom system prompt file — dynamically inject vault note content.
- Changes to the custom prompt file take effect on the next message sent (no extension reload needed).
- The exported file includes an HTML comment documenting all available static and dynamic template variables for reference.
