# Notor Community Extensions

A curated gallery of optional extensions for Notor. These extend the AI's capabilities beyond the built-in tools but aren't broadly needed enough to include in core.

Each extension is a single `.md` file that you copy into your vault. No plugin code changes required.

## Available Extensions

| Name | Type | Description | Tested Version |
|------|------|-------------|----------------|
| [read-rendered-note](tools/read-rendered-note.md) | Tool | Read notes with Dataview queries evaluated and rendered as Markdown | 0.7.8 |

## Installation

1. **Browse** this directory and find the extension you want. Open the `.md` file to read what it does and what it requires.

2. **Copy** the `.md` file into the matching directory in your vault:
   - Tool extensions → `{vault}/notor/tools/`
   - Automation extensions → `{vault}/notor/automations/`
   - Block extensions → `{vault}/notor/blocks/`

3. **Reload** extensions in Notor. Either:
   - Open Settings → Notor → Extensions → click "Reload extensions"
   - Or use the command palette: "Notor: Reload extensions"
   - Or simply restart Obsidian

4. **Verify** the extension loaded by checking Settings → Notor → Extensions. The new tool/automation should appear in the list.

## Compatibility

Each extension includes a `tested-notor-version` field in its frontmatter. This indicates the Notor version it was last tested against. It is informational only — the plugin does not enforce version checks at load time. If an extension stops working after a Notor update, check this repo for an updated version.

## Writing Your Own Extensions

See the [Extensions documentation](../../docs/extensions.md) for the full file format specification, available runtime APIs, and examples.
