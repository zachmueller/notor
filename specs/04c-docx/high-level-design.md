# High-Level Design: `.docx` Read/Write Tools

## Overview

This document captures the high-level design for three new Notor built-in tools that enable the AI to read and write files on the native filesystem — including parsing and generating Word (`.docx`) documents. These tools follow the same security and architectural patterns established by `execute_command`.

All three tools are **desktop-only** (Obsidian's Electron environment). They are not supported on mobile.

All libraries used are **free npm packages** (MIT licensed). No external binaries, no commercial modules, no Python dependencies.

---

## Motivation

Users often maintain documentation, reports, and structured writing as Word documents. Notor currently has no way to bridge those files with a user's vault notes or AI conversations. The desired workflows are:

1. **Import**: A user has a `.docx` (e.g., a research paper, a draft brief) and wants the AI to read it, write its content into a vault note, summarize it, or use it as context.
2. **Export**: A user iterates on ideas or outlines within their vault, then has the AI draft a polished first-draft document and write it directly to a `.docx` file — formatted using a company or personal Word template.

A general-purpose `read_file` tool is also introduced as a foundational primitive, enabling the AI to read arbitrary text files from the filesystem beyond vault notes (e.g., reading a config file, a CSV, or a script from another directory).

---

## Three New Tools

### 1. `read_file`

**Purpose**: Read any text-based file from the filesystem.

**Mode**: `read`
**Desktop-only**: Yes
**Auto-approve default**: `false`

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to the file. Vault-relative or absolute. |
| `encoding` | string | No | File encoding. Default: `utf-8`. |

**Behavior**:
- Accepts vault-relative paths (resolved from vault root) or absolute filesystem paths.
- Vault root is always implicitly allowed. Additional paths are whitelisted via the `read_file_allowed_paths` setting.
- Path traversal attempts are blocked using the same boundary-check logic as `execute_command`.
- Scoped to text-based files only. Binary files return an error directing the user to a purpose-built tool (e.g., `read_docx`).
- Returns the raw file contents as the tool result.

**Security**: Mirrors `execute_command`'s `allowed_paths` model. Uses `read_file_allowed_paths: string[]` in settings.

---

### 2. `read_docx`

**Purpose**: Read a `.docx` file and return its content as Markdown.

**Mode**: `read`
**Desktop-only**: Yes
**Auto-approve default**: `false`

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to the `.docx` file. Vault-relative or absolute. |

**Behavior**:
- Accepts vault-relative or absolute paths.
- Uses `mammoth` to convert `.docx` → HTML, then `turndown` (already in the Notor codebase) to convert HTML → Markdown.
- Returns the parsed Markdown as the tool result. The AI can then write it to a vault note, summarize it, or use it as conversation context.
- Word styles (headings, bold, italic, tables) are mapped to their Markdown equivalents by mammoth's default style map.
- Embedded images are represented as `[image]` placeholders (image extraction is out of scope for this version).

**Security**: Shares the `read_file_allowed_paths` whitelist (both tools are read operations on arbitrary filesystem paths).

**Library**: `mammoth` + `turndown`

---

### 3. `write_docx`

**Purpose**: Convert Markdown content to a `.docx` file, optionally applying styles and layout from a user-supplied Word template.

**Mode**: `write`
**Desktop-only**: Yes
**Auto-approve default**: `false`

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | Markdown content to convert to `.docx`. |
| `output_path` | string | Conditional | Full vault-relative or absolute output path for the generated file. Required if `write_docx_default_output_dir` is not configured and `filename` is not provided. |
| `filename` | string | No | Output filename without `.docx` extension. Used with `write_docx_default_output_dir` to construct the output path. |
| `template_path` | string | No | Path to a `.docx` template. Vault-relative or absolute. Overrides the `write_docx_default_template_path` setting. |

**Output path resolution**:
1. If `output_path` is given, use it directly.
2. Else if `filename` + `write_docx_default_output_dir` are both available, combine them.
3. Otherwise, return an error asking the user to provide an output path or configure a default output directory in settings.

**Template system — `pizzip` body-replacement hybrid**:

The template approach works at the ZIP level. A `.docx` file is a ZIP archive; the body content lives in `word/document.xml`. The pipeline:

1. Parse Markdown and build content using the `docx` npm API (headings, paragraphs, tables, etc.)
2. Render to an in-memory `.docx` buffer via `Packer.toBuffer()`
3. Use `pizzip` to unzip the buffer and extract the `<w:body>` XML
4. Use `pizzip` to unzip the user's template
5. Replace the `<w:body>` in the template's `word/document.xml` with the generated body, preserving the template's `<w:sectPr>` (page margins, orientation, header/footer links)
6. Repack and write to the output path

Because only the body content is replaced, the output file inherits the template's styles, fonts, margins, page setup, headers, and footers.

**Template contract**: The user's template `.docx` requires no special structure and no placeholder tags of any kind — it is simply a `.docx` file with the desired styles, margins, page setup, and headers/footers defined. The document title should be the first `# H1` heading in the Markdown `content`, which renders as a "Heading 1" paragraph at the top of the generated document.

**Style name matching**: Content is generated using Word's standard built-in style names ("Heading 1"–"Heading 6", "Normal", "List Paragraph"). Templates using these standard names will render correctly. Templates with fully custom style names for body/headings will fall back gracefully — the text appears correctly but without the custom style applied. Custom style name mapping is a future enhancement.

**No-template fallback**: When no template is provided, `docx` npm generates a clean `.docx` with Word's default built-in styles.

**Libraries**: `docx` (content generation) + `pizzip` (ZIP manipulation) + `marked` (Markdown parsing)

See [research/write-docx-implementation.md](research/write-docx-implementation.md) for the full analysis.

---

## Settings Additions

Three new settings entries are needed in `NotorSettings`:

| Setting Key | Type | Default | Description |
|-------------|------|---------|-------------|
| `read_file_allowed_paths` | `string[]` | `[]` | Additional filesystem paths allowed for `read_file` and `read_docx`. Mirrors `execute_command_allowed_paths`. |
| `write_docx_default_output_dir` | `string` | `""` | Default output directory for `write_docx`. Accepts vault-relative or absolute path. |
| `write_docx_default_template_path` | `string` | `""` | Default template `.docx` path. Accepts vault-relative or absolute path. Overridable per `write_docx` call. |

---

## Architecture Notes

- All three tools follow the standard `Tool` interface (`name`, `description`, `input_schema`, `mode`, `execute`).
- Registered in `main.ts` at plugin load time alongside existing tools.
- Path resolution and allowed-paths validation logic will be extracted into a shared utility (reused by `read_file`, `read_docx`, and `write_docx`) to avoid duplicating the `execute_command` logic.
- Checkpoint support (`CheckpointManager`) is not applicable to `read_file` or `read_docx`. For `write_docx`, if the output path points to an existing file, a checkpoint should be created before overwriting — to be decided in the spec.
- `write_docx` does not interact with the vault or `StaleContentTracker` since it writes to the native filesystem, not a vault note.

---

## Out of Scope (This Version)

- Mobile support for any of the three tools
- Reading embedded images from `.docx` (image extraction)
- PDF read or write
- XLSX or other Office formats
- Custom style name mapping (template style names → generated content style names)
- DOCX-to-DOCX transformation or editing an existing `.docx` in place
