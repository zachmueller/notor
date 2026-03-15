# High-Level Design: `.docx` Read/Write Tools

## Overview

This document captures the high-level design for three new Notor built-in tools that enable the AI to read and write files on the native filesystem — including parsing and generating Word (`.docx`) documents. These tools follow the same security and architectural patterns established by `execute_command`.

All three tools are **desktop-only** (Obsidian's Electron environment). They are not supported on mobile.

All libraries used must be available via **npm** (no external binaries, no Python dependencies).

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
| `title` | string | No | Document title. Substituted into the `{title}` placeholder in the template wherever it appears. |
| `output_path` | string | Conditional | Full vault-relative or absolute output path. Required if `write_docx_default_output_dir` is not configured and `filename` is not provided. |
| `filename` | string | No | Output filename without extension. Used with `write_docx_default_output_dir` to construct the output path. |
| `template_path` | string | No | Path to a `.docx` template. Vault-relative or absolute. Overrides the `write_docx_default_template_path` setting. |

**Output path resolution**:
1. If `output_path` is given, use it directly.
2. Else if `filename` + `write_docx_default_output_dir` are both available, combine them.
3. Otherwise, return an error asking the user to provide an output path or configure a default output directory.

**Template system**:

The approach uses `docxtemplater` + `pizzip` (both npm packages). The template is a standard `.docx` file containing two special placeholders:

| Placeholder | Type | Description |
|-------------|------|-------------|
| `{title}` | Plain text | Replaced with the `title` parameter. May appear anywhere in the document — cover page, running header, title field, etc. Optional: if no `{title}` placeholder exists in the template, the `title` parameter is a no-op. |
| Body content placeholder | HTML block | The entire Markdown-converted content, injected as a single block. Exact syntax TBD in research spike (see below). |

`docxtemplater` operates directly on the template's underlying ZIP/XML structure, so the output inherits the template's styles, fonts, margins, page setup, and headers/footers without any additional extraction step. The user only needs to place these two tags — there is no requirement to structure the template around a specific heading count or content schema.

When no template is provided, the tool falls back to generating a plain `.docx` using Word's default styles.

**Markdown → HTML conversion**: `marked` or the `unified`/`remark` pipeline (TBD in research spike) converts the Markdown `content` parameter to HTML before injection into the template.

**Library**: `docxtemplater` + `pizzip` + a Markdown-to-HTML library

---

## Settings Additions

Three new settings entries are needed in `NotorSettings`:

| Setting Key | Type | Default | Description |
|-------------|------|---------|-------------|
| `read_file_allowed_paths` | `string[]` | `[]` | Additional filesystem paths allowed for `read_file` and `read_docx`. Mirrors `execute_command_allowed_paths`. |
| `write_docx_default_output_dir` | `string` | `""` | Default output directory for `write_docx`. Accepts vault-relative or absolute path. |
| `write_docx_default_template_path` | `string` | `""` | Default template `.docx` path. Accepts vault-relative or absolute path. Overridable per `write_docx` call. |

---

## Pre-Spec Research

One research spike is needed before writing functional requirements:

### `write_docx` Implementation Details

**File**: `specs/04c-docx/research/write-docx-implementation.md`

The library choice (`docxtemplater` + `pizzip`) is decided. The research spike should nail down:

**Q1 — HTML injection syntax**: Confirm the exact placeholder syntax for the body content block. `docxtemplater` has multiple HTML injection mechanisms (e.g., `docxtemplater-module-html` uses `{~html}` or `{^^html}`; other approaches exist). Identify the right module, its placeholder syntax, and how it maps HTML elements to Word style names (e.g., `<h1>` → "Heading 1", `<p>` → "Normal").

**Q2 — Style name mapping**: By default, docxtemplater's HTML module maps HTML elements to Word's built-in style names ("Heading 1", "Heading 2", "Normal", etc.). Confirm this default mapping is configurable, so users with templates that use custom style names (e.g., "Report Heading") can override the mapping — either via a settings entry or a future per-template config file.

**Q3 — Markdown-to-HTML library**: Confirm which Markdown-to-HTML library to use upstream of docxtemplater. The plugin already bundles `turndown` (HTML → Markdown) for `read_docx`; assess whether a reciprocal library (e.g., `marked`, `remark`/`rehype`) is appropriate or if a simpler approach suffices.

**Q4 — No-template fallback**: Confirm the cleanest approach when no template is provided. Options: (a) use `docx` npm package to generate a basic styled document from scratch, (b) ship a minimal built-in template as a bundled asset.

**Research output**: Implementation recommendations for each question above, with relevant code snippets or proof-of-concept.

---

## Architecture Notes

- All three tools follow the standard `Tool` interface (`name`, `description`, `input_schema`, `mode`, `execute`).
- Registered in `main.ts` at plugin load time alongside existing tools.
- Path resolution and allowed-paths validation logic will be extracted into a shared utility (reused by `read_file`, `read_docx`, and `write_docx`) to avoid duplicating the `execute_command` logic.
- Checkpoint support (`CheckpointManager`) is not applicable to `read_file` or `read_docx`. It may apply to `write_docx` if an existing `.docx` is being overwritten — to be decided in the spec.
- `write_docx` does not interact with the vault or `StaleContentTracker` since it writes to the native filesystem, not a vault note.

---

## Out of Scope (This Version)

- Mobile support for any of the three tools
- Reading embedded images from `.docx` (image extraction)
- PDF read or write
- XLSX or other Office formats
- Custom style name mapping configuration (HTML element → Word style name override) — noted as a future enhancement after the default mapping is validated
- DOCX-to-DOCX transformation or editing an existing `.docx` in place
