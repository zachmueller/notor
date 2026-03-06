# Tool Schemas Contract

**Created:** 2026-06-03
**Plan:** [specs/01-mvp/plan.md](../plan.md)

JSON Schema definitions for all built-in tools in the Notor MVP (Phases 0–2). These schemas are provided to the LLM as tool definitions and used for parameter validation at the dispatch layer.

---

## Tool Registry Interface

```typescript
interface Tool {
  name: string;
  description: string;
  input_schema: JSONSchema;
  mode: "read" | "write";
  phase: 1 | 2;
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolResult {
  success: boolean;
  result: string | Record<string, unknown>;
  error?: string;
}
```

---

## Phase 1 Tools

### `read_note`

Read the contents of a note in the vault.

```json
{
  "name": "read_note",
  "description": "Read the contents of a note in the vault. Returns the note content as a string. Uses Obsidian's vault API. Defaults to excluding YAML frontmatter unless include_frontmatter is set to true.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Path to the note relative to vault root (e.g., 'Research/Climate.md')"
      },
      "include_frontmatter": {
        "type": "boolean",
        "description": "Whether to include YAML frontmatter in the returned content. Defaults to false.",
        "default": false
      }
    },
    "required": ["path"]
  }
}
```

**Mode:** read (Plan + Act)
**Auto-approve default:** true

**Result format:**
```json
{
  "success": true,
  "result": "# Climate Research\n\nThe introduction section..."
}
```

**Error cases:**
- File not found → `{ "success": false, "error": "Note not found: Research/Climate.md" }`
- Not a note (binary file) → `{ "success": false, "error": "Path is not a Markdown note: images/photo.png" }`

---

### `write_note`

Create a new note or overwrite an existing note's entire content.

```json
{
  "name": "write_note",
  "description": "Create a new note or overwrite an existing note's entire content. Creates intermediate directories if they don't exist. A checkpoint of the existing note is created before writing. Requires user approval unless auto-approved.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Path to the note relative to vault root (e.g., 'Projects/Website Redesign.md')"
      },
      "content": {
        "type": "string",
        "description": "Complete content to write to the note. This will replace the entire file content."
      }
    },
    "required": ["path", "content"]
  }
}
```

**Mode:** write (Act only)
**Auto-approve default:** false

**Pre-execution checks:**
1. Stale content check: if the note exists and was previously read via `read_note`, compare current content against last-read content. Fail if content has changed since last read.
2. Checkpoint: snapshot the existing note content before writing (Phase 2).

**Result format:**
```json
{
  "success": true,
  "result": "Note created: Projects/Website Redesign.md (847 characters)"
}
```

**Error cases:**
- Plan mode → `{ "success": false, "error": "write_note is not available in Plan mode. Switch to Act mode to create or modify notes." }`
- Stale content → `{ "success": false, "error": "Note content has changed since last read. Re-read the note with read_note before retrying." }`
- Write failure → `{ "success": false, "error": "Failed to write note: <vault API error>" }`

---

### `replace_in_note`

Make targeted edits within a note using SEARCH/REPLACE blocks.

```json
{
  "name": "replace_in_note",
  "description": "Make targeted edits within a note using SEARCH/REPLACE blocks for surgical editing without rewriting the entire note. Each search string must match exactly (character-for-character including whitespace). The operation is atomic: if any search block fails to match, no changes are applied. Requires user approval unless auto-approved.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Path to the note relative to vault root"
      },
      "changes": {
        "type": "array",
        "description": "Array of search/replace blocks to apply in sequence. Each block replaces only the first occurrence of the search text.",
        "items": {
          "type": "object",
          "properties": {
            "search": {
              "type": "string",
              "description": "Exact text to find in the note (character-for-character match including whitespace)"
            },
            "replace": {
              "type": "string",
              "description": "Text to replace the matched search text with. Use empty string to delete the matched text."
            }
          },
          "required": ["search", "replace"]
        },
        "minItems": 1
      }
    },
    "required": ["path", "changes"]
  }
}
```

**Mode:** write (Act only)
**Auto-approve default:** false

**Pre-execution checks:**
1. Stale content check (same as `write_note`).
2. Validate all search blocks match before applying any changes (atomic).
3. Checkpoint: snapshot the existing note content before applying (Phase 2).

**Result format:**
```json
{
  "success": true,
  "result": "Applied 2 replacements to Research/Climate.md"
}
```

**Error cases:**
- Plan mode → `{ "success": false, "error": "replace_in_note is not available in Plan mode. Switch to Act mode to edit notes." }`
- No match → `{ "success": false, "error": "Search block 1 did not match any text in Research/Climate.md. No changes were applied. The search text was: \"exact text that was not found...\"" }`
- Stale content → same as `write_note`
- Note not found → `{ "success": false, "error": "Note not found: Research/Climate.md" }`

---

### `search_vault`

Search across notes in the vault using regex or text patterns.

```json
{
  "name": "search_vault",
  "description": "Search across notes in the vault using regex or text patterns, returning matches with surrounding context lines. Results are grouped by file with line numbers.",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Regex pattern or text string to search for"
      },
      "path": {
        "type": "string",
        "description": "Directory to search within, relative to vault root. Defaults to vault root.",
        "default": ""
      },
      "context_lines": {
        "type": "number",
        "description": "Number of surrounding lines to include with each match. Defaults to 3.",
        "default": 3
      },
      "file_pattern": {
        "type": "string",
        "description": "Glob pattern to filter which files to search. Defaults to '*.md'.",
        "default": "*.md"
      }
    },
    "required": ["query"]
  }
}
```

**Mode:** read (Plan + Act)
**Auto-approve default:** true

**Result format:**
```json
{
  "success": true,
  "result": {
    "total_matches": 3,
    "files": [
      {
        "path": "Research/Climate.md",
        "matches": [
          {
            "line": 15,
            "match": "quarterly review of climate data",
            "context": "...surrounding lines..."
          }
        ]
      }
    ]
  }
}
```

**Error cases:**
- Invalid regex → `{ "success": false, "error": "Invalid search pattern: <regex error>" }`
- No matches → `{ "success": true, "result": { "total_matches": 0, "files": [] } }` (not an error)

---

### `list_vault`

List the folder and note structure of the vault or a subdirectory.

```json
{
  "name": "list_vault",
  "description": "List the folder and note structure of the vault or a subdirectory. Returns files and folders with type and basic metadata. Results are paginated.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Directory to list, relative to vault root. Defaults to vault root.",
        "default": ""
      },
      "recursive": {
        "type": "boolean",
        "description": "Whether to list contents recursively. Defaults to false.",
        "default": false
      },
      "limit": {
        "type": "number",
        "description": "Maximum number of items to return. Defaults to 50.",
        "default": 50
      },
      "offset": {
        "type": "number",
        "description": "Number of items to skip for pagination. Defaults to 0.",
        "default": 0
      },
      "sort_by": {
        "type": "string",
        "description": "Sort order: 'last_modified' (newest first) or 'alphabetical'. Defaults to 'last_modified'.",
        "enum": ["last_modified", "alphabetical"],
        "default": "last_modified"
      }
    },
    "required": []
  }
}
```

**Mode:** read (Plan + Act)
**Auto-approve default:** true

**Result format:**
```json
{
  "success": true,
  "result": {
    "path": "Research/",
    "total_count": 127,
    "items": [
      {
        "name": "Climate.md",
        "path": "Research/Climate.md",
        "type": "note",
        "size": 4230,
        "modified": "2026-06-01T10:30:00Z"
      },
      {
        "name": "Images",
        "path": "Research/Images",
        "type": "folder"
      }
    ]
  }
}
```

---

## Phase 2 Tools

### `read_frontmatter`

Read the parsed YAML frontmatter of a note as structured data.

```json
{
  "name": "read_frontmatter",
  "description": "Read the parsed YAML frontmatter of a note as structured key-value data. Returns an empty object if the note has no frontmatter.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Path to the note relative to vault root"
      }
    },
    "required": ["path"]
  }
}
```

**Mode:** read (Plan + Act)
**Auto-approve default:** true

**Result format:**
```json
{
  "success": true,
  "result": {
    "title": "Climate Research",
    "tags": ["research", "climate"],
    "created": "2026-01-15",
    "status": "draft"
  }
}
```

---

### `update_frontmatter`

Add, modify, or remove specific frontmatter properties.

```json
{
  "name": "update_frontmatter",
  "description": "Add, modify, or remove specific frontmatter properties without touching the note body content. Uses Obsidian's frontmatter APIs for safe structured updates. Creates a frontmatter section if the note has none and 'set' is provided.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Path to the note relative to vault root"
      },
      "set": {
        "type": "object",
        "description": "Key-value pairs to add or update in the frontmatter",
        "additionalProperties": true
      },
      "remove": {
        "type": "array",
        "description": "List of frontmatter keys to remove",
        "items": {
          "type": "string"
        }
      }
    },
    "required": ["path"]
  }
}
```

**Mode:** write (Act only)
**Auto-approve default:** false

**Pre-execution checks:**
1. Checkpoint: snapshot the note before modifying (Phase 2).
2. Uses Obsidian's `processFrontMatter` API (or equivalent) for safe updates.

**Result format:**
```json
{
  "success": true,
  "result": "Updated frontmatter on Research/Climate.md: set 2 properties, removed 1 property"
}
```

---

### `manage_tags`

Add or remove tags on a note via the frontmatter `tags` property.

```json
{
  "name": "manage_tags",
  "description": "Add or remove tags on a note by operating on the frontmatter 'tags' property. Does not duplicate existing tags when adding. Gracefully handles removal of tags that don't exist.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Path to the note relative to vault root"
      },
      "add": {
        "type": "array",
        "description": "Tags to add to the note",
        "items": {
          "type": "string"
        }
      },
      "remove": {
        "type": "array",
        "description": "Tags to remove from the note",
        "items": {
          "type": "string"
        }
      }
    },
    "required": ["path"]
  }
}
```

**Mode:** write (Act only)
**Auto-approve default:** false

**Pre-execution checks:**
1. Checkpoint: snapshot the note before modifying.
2. Uses Obsidian's frontmatter APIs.

**Result format:**
```json
{
  "success": true,
  "result": "Tags updated on Research/Climate.md: added [review-needed], removed [draft]"
}
```

---

## Tool Dispatch Contract

### Dispatch Flow

```
1. Parse tool call from LLM response
2. Look up tool in registry by name
3. IF tool not found → return error to LLM
4. IF mode is "plan" AND tool.mode is "write" → return Plan mode error to LLM
5. IF auto_approve is false for tool → show approval UI, wait for user response
   5a. IF rejected → return rejection message to LLM
6. IF tool is write AND note was previously read → perform stale content check
   6a. IF stale → return stale content error to LLM
7. IF tool is write → create checkpoint (Phase 2)
8. Execute tool
9. IF tool is read AND accesses a note → update last-read cache, re-evaluate vault rules
10. Return result to LLM
11. Display tool call inline in chat thread (name, params, result, status)
```

### Diff Preview Flow (for write tools)

```
1. Tool execution produces proposed changes
2. Generate diff (before/after)
3. IF auto_approve → apply changes immediately, show collapsed diff in chat
4. IF manual approval required:
   a. Show diff in chat with accept/reject controls
   b. For replace_in_note with multiple blocks: per-change accept/reject + accept all / reject all
   c. Wait for user decision
   d. Apply only accepted changes
   e. Return result reflecting what was actually applied