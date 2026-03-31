# Vault-level instruction files

Store Markdown rule files under `notor/rules/` in your vault to inject instructions automatically into the AI's context when relevant notes are in play.

## Trigger properties

Use frontmatter properties to control when a rule file is injected:

| Property | Value | When injected |
|---|---|---|
| `notor-always-include` | `true` | Always injected into every conversation |
| `notor-directory-include` | `<path>` | Injected when the AI accesses a note under the given directory path |
| `notor-tag-include` | `<tag>` | Injected when the AI accesses a note with the given tag |

## Creating rules from Settings

Rules can also be created from **Settings → Notor → Rules & Workflows**. The **Create** button prompts for:

1. **Name** — used as the filename
2. **Trigger type** — Always include, Directory, or Tag
3. **Trigger value** — the directory path or tag (for directory and tag triggers)

A skeleton rule file is generated with the chosen trigger preconfigured in frontmatter. Existing rules are listed in the same section with **Open** buttons to jump to each file.

## Notes

- Rule files are regular Markdown notes — fully visible and editable in Obsidian.
- Rule file bodies support [`<include_note>`](include-note.md) tags for dynamic content injection at the time the system prompt is assembled.
- Multiple rule files can match simultaneously; all matching rules are injected.
- Tool availability can be customized per-rule using `<notor_tool_config>` blocks. See [Per-context tool configuration](vault-tools.md#per-context-tool-configuration) for syntax and precedence.
