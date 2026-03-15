# High-Level Design: `.docx` Read/Write Tools

## Overview

This document captures the high-level design for three new Notor built-in tools that enable the AI to read and write files on the native filesystem — including parsing and generating Word (`.docx`) documents. These tools follow the same security and architectural patterns established by `execute_command`.

All three tools are **desktop-only** (Obsidian's Electron environment). They are not supported on mobile.

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

**Purpose**: Convert Markdown content to a `.docx` file, optionally applying styles from a user-supplied Word template.

**Mode**: `write`
**Desktop-only**: Yes
**Auto-approve default**: `false`

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | Markdown content to convert to `.docx`. |
| `output_path` | string | Conditional | Full vault-relative or absolute output path. Required if `write_docx_default_output_dir` is not configured and `filename` is not provided. |
| `filename` | string | No | Output filename without extension. Used with `write_docx_default_output_dir` to construct the output path. |
| `template_path` | string | No | Path to a `.docx` template for style inheritance. Vault-relative or absolute. Overrides the `write_docx_default_template_path` setting. |

**Output path resolution**:
1. If `output_path` is given, use it directly.
2. Else if `filename` + `write_docx_default_output_dir` are both available, combine them.
3. Otherwise, return an error asking the user to provide an output path or configure a default output directory.

**Template system — style inheritance**:

The primary template approach is modeled on the existing Python reference script (`md_to_docx.py`), which uses:

```
pandoc --reference-doc=template.docx input.md -o output.docx
```

With pandoc's `--reference-doc` flag, the output `.docx` inherits all styles, fonts, margins, page setup, and headers/footers from the template. The template file itself requires no special placeholder syntax — it simply needs the desired Word styles defined (e.g., custom "Heading 1", "Body Text", caption styles). Pandoc maps Markdown heading levels and formatting to the corresponding named styles in the template.

This is the same mechanism that makes the Python script work: the template acts as a style dictionary and page layout source, while pandoc fills it with content from Markdown.

If no template is provided, pandoc generates a `.docx` with Word's built-in default styles.

**Library decision — research required**: See [Pre-Spec Research](#pre-spec-research) below.

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

Before writing functional requirements and implementation tasks, one research spike is needed:

### `write_docx` Library Selection

**File**: `specs/04c-docx/research/write-docx-library.md`

The core question is how to invoke pandoc (or a suitable alternative) from within an Obsidian plugin:

**Q1 — Pandoc via `child_process`**: Obsidian's Electron environment supports Node.js `child_process` in the main process. The existing `execute_command` shell executor already uses this mechanism. Confirm that `child_process.spawn` with pandoc is viable, and how to resolve the pandoc binary PATH in the same way `execute_command` handles shell PATH resolution on macOS.

**Q2 — Pandoc availability**: Since pandoc is an external binary, users may not have it installed. Define the strategy:
- **Option A** — Require pandoc; return a clear error with installation instructions if not found.
- **Option B** — Auto-detect pandoc and fall back to a pure-JS library if not available.
- **Option C** — Pure-JS only (no pandoc dependency).

**Q3 — Pure-JS fallback candidates** (if Option B or C):
- `docx` npm package: programmatic `.docx` generation with manual Markdown-to-style mapping
- `docxtemplater` + `pizzip`: mail-merge template filling (template must contain `{content}` placeholders — less ideal for style inheritance, but simpler)
- Other options

**Research output**: A recommendation on which option to adopt, with rationale, and any relevant code pointers.

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
- Automatic git metadata injection (present in the Python reference script but not relevant to Notor)
- Author alias replacement in template headers (Python-specific workflow)
- DOCX-to-DOCX transformation or editing an existing `.docx` in place
