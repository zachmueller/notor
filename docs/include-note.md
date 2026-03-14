# `<include_note>` tag

Dynamically inject the contents of any vault note (or a specific section of one) into [workflow bodies](workflows.md), system prompts, [persona prompts](personas.md), and [vault-level rule files](rules.md).

## Syntax

```markdown
<!-- Vault-relative path -->
<include_note path="Research/Climate.md" section="Key Findings" />

<!-- Obsidian wikilink (rename-safe, recommended) -->
<include_note path="[[Climate Research]]" section="Key Findings" />
```

## Attributes

| Attribute | Required | Description |
|---|---|---|
| `path` | Yes | Vault-relative file path or `[[wikilink]]`. Wikilinks are resolved via Obsidian's standard link resolution and are automatically updated when the referenced note is renamed — the recommended form. |
| `section` | No | Heading text to extract. Only the content from that heading to the next heading of equal or higher level is included. Omit to include the full note body. |
| `mode` | No | `inline` (paste directly into surrounding text) or `attached` (add as a separate attachment in context). Default: `inline`. In system prompts and rule files, `inline` is always used regardless of this attribute. |
| `strip_frontmatter` | No | `true` (default) strips YAML frontmatter before injection; `false` includes frontmatter as-is (useful when the AI needs the note's metadata). |

## Resolution timing

Tags are resolved when the workflow is run or when the system prompt is assembled before each LLM API call — not at note-save time.

## Error handling

If the referenced note or section is not found, the tag is replaced with an inline error marker (e.g., `[include_note error: note 'Research/Deleted.md' not found]`) that is visible to both you and the LLM. Prompt assembly continues normally.

## Multiple tags

Any number of `<include_note />` tags may appear in a single document; each resolves independently.

## No nested resolution

If an included note itself contains `<include_note>` tags, those tags are passed through as literal text (no recursive includes), preventing circular reference loops.
