# RT-1 — Per-tool path argument inspection

**Status:** Complete
**Date:** 2026-03-22
**Relates to:** FR-84 (`allowed_paths` / `blocked_paths` enforcement)

## Goal

Identify, for each built-in tool, which input parameters carry path values and how those paths should be interpreted at dispatch time so that `allowed_paths` / `blocked_paths` enforcement can be implemented correctly.

## Tool inventory

### Group 1 — Vault-namespace tools

These tools interact with the Obsidian vault exclusively through the vault API (`app.vault.*`, `app.metadataCache`, `app.fileManager`). Path arguments are **vault-relative strings** (e.g. `"Projects/My Note"` or `"Projects/My Note.md"`). The underlying `resolveNote()` helper normalises bare note names and optional `.md` extensions, but the raw argument is always vault-relative.

| Tool | Path param | Required | Semantics |
|---|---|---|---|
| `read_note` | `path` | yes | vault-relative path to target .md note |
| `write_note` | `path` | yes | vault-relative path to target .md note (created if absent) |
| `replace_in_note` | `path` | yes | vault-relative path to target .md note |
| `read_frontmatter` | `path` | yes | vault-relative path to target .md note |
| `update_frontmatter` | `path` | yes | vault-relative path to target .md note |
| `manage_tags` | `path` | yes | vault-relative path to target .md note |
| `search_vault` | `path` | no (default `""`) | vault-relative directory prefix; scopes search to that subtree |
| `list_vault` | `path` | no (default `""`) | vault-relative directory to list |

For `search_vault` and `list_vault`, `path` is a directory scope filter, not a target file. The empty-string default means "entire vault". `allowed_paths` / `blocked_paths` enforcement on these tools restricts which directory subtrees the tool can be pointed at.

### Group 2 — Filesystem-namespace tools

These tools access the filesystem through Node.js `fs` APIs and use `resolveAndValidatePath()` for path resolution, which accepts both vault-relative strings and absolute filesystem paths and normalises them to absolute paths before any I/O.

| Tool | Path param(s) | Required | Semantics |
|---|---|---|---|
| `read_file` | `path` | yes | vault-relative or absolute filesystem path to any text file |
| `read_docx` | `path` | yes | vault-relative or absolute filesystem path to a `.docx` file |
| `write_docx` | `output_path` | no* | vault-relative or absolute output path (full path incl. `.docx`) |
| `write_docx` | `template_path` | no | vault-relative or absolute path to a `.docx` template |

\* `write_docx` requires either `output_path` or (`filename` + configured `write_docx_default_output_dir`). When neither path variant resolves, the tool returns an error before any I/O.

All three filesystem tools are desktop-only. They are gated by `Platform.isDesktopApp` at execution time; no special handling is needed in the dispatcher for mobile.

### Group 3 — Non-path tools

| Tool | Relevant param | Notes |
|---|---|---|
| `execute_command` | `working_directory` | Vault-relative or absolute filesystem path. Named `working_directory`, not `path`. May be empty (defaults to vault root). `allowed_paths` / `blocked_paths` apply to this param. |
| `fetch_webpage` | `url` | HTTP/HTTPS URL. **Not a vault or filesystem path.** `allowed_paths` / `blocked_paths` enforcement is **not applicable**. |

## Path comparison strategies

Two distinct path namespaces require different comparison strategies.

### Vault-namespace (Group 1)

The LLM passes vault-relative strings. `allowed_paths` and `blocked_paths` in `<notor_tool_config>` should use the same vault-relative prefix convention. Comparison: check whether the raw argument starts with any prefix in the list, using normalised forward-slash strings.

```
function vaultPathMatchesPrefix(arg: string, prefix: string): boolean {
  // Normalise: strip leading slash, ensure prefix ends with "/"
  const normArg = arg.replace(/^\//, "");
  const normPrefix = prefix.replace(/^\//, "").replace(/\/?$/, "/");
  return normArg === normPrefix.slice(0, -1) || normArg.startsWith(normPrefix);
}
```

This matches the same behaviour that `search_vault` and `list_vault` use internally when filtering by `path` prefix. For note-target tools (`read_note`, `write_note`, etc.) the prefix is a folder prefix ("Projects/"), and the arg is a note path ("Projects/My Note.md").

### Filesystem-namespace (Group 2 + `execute_command`)

The LLM may pass vault-relative or absolute paths. Both the argument and the `allowed_paths` / `blocked_paths` entries should be resolved to absolute paths before comparison, using the existing `resolveAndValidatePath()` / `isPathWithin()` utilities from `src/utils/path-validation.ts`.

### `fetch_webpage`

`allowed_paths` / `blocked_paths` have no meaning for this tool. If a config block specifies these fields for `fetch_webpage`, they should be silently ignored at enforcement time (a warning Notice may optionally be emitted at parse time to help users notice the misconfiguration, but is not required).

## Per-tool path parameter descriptor

The dispatcher needs a static descriptor table to know which parameter(s) carry path values for each tool and which namespace they belong to. The recommended shape:

```typescript
type PathNamespace = "vault" | "filesystem";

interface ToolPathParam {
  /** Parameter name in the tool's input schema */
  param: string;
  namespace: PathNamespace;
}

const TOOL_PATH_PARAMS: Record<string, ToolPathParam[]> = {
  read_note:        [{ param: "path",             namespace: "vault" }],
  write_note:       [{ param: "path",             namespace: "vault" }],
  replace_in_note:  [{ param: "path",             namespace: "vault" }],
  read_frontmatter: [{ param: "path",             namespace: "vault" }],
  update_frontmatter:[{ param: "path",            namespace: "vault" }],
  manage_tags:      [{ param: "path",             namespace: "vault" }],
  search_vault:     [{ param: "path",             namespace: "vault" }],
  list_vault:       [{ param: "path",             namespace: "vault" }],
  read_file:        [{ param: "path",             namespace: "filesystem" }],
  read_docx:        [{ param: "path",             namespace: "filesystem" }],
  write_docx:       [{ param: "output_path",      namespace: "filesystem" },
                     { param: "template_path",    namespace: "filesystem" }],
  execute_command:  [{ param: "working_directory", namespace: "filesystem" }],
  fetch_webpage:    [],  // no path params
};
```

This table lives in the dispatcher or a dedicated path-enforcement module. MCP tools are not in this table; `allowed_paths` / `blocked_paths` enforcement for MCP tools is out of scope for Phase 4b (see spec Assumptions section).

## Edge cases and notes

### `write_docx` — two path params, different roles

`output_path` is a write destination; `template_path` is a read source. Both should be checked against `allowed_paths` / `blocked_paths` independently. A path blocked for reading (via `blocked_paths`) should block `template_path` access even if `output_path` is in an allowed location, and vice versa. The dispatcher should iterate all path params for the tool and block on the first violation.

### `search_vault` and `list_vault` — optional path defaults to entire vault

When the LLM omits `path` (or passes `""`) for `search_vault` or `list_vault`, it is scoping the operation to the entire vault. If `allowed_paths` is non-empty for these tools, an empty argument should be treated as a request to operate on the vault root (`""`), which does not match any non-empty prefix — so the call would be blocked. This forces the LLM to explicitly scope the operation to a permitted directory.

### `execute_command` — path does not constrain the command itself

`working_directory` enforcement restricts the CWD of the shell process, not the content of the `command` string. A path-blocked working directory does not prevent the command from operating on other paths via absolute paths in the shell command. This is an inherent limitation noted for completeness; full command-content filtering is out of scope for FR-84.

### `write_note` — creates intermediate directories

`write_note` creates intermediate directories if they don't exist. The `allowed_paths` check on `path` should occur before the directory creation step, consistent with the dispatcher-first enforcement model specified in FR-84 ("before executing a tool call").

### Vault-relative path normalisation

The vault tools accept paths with or without a leading `/` and with or without a trailing `.md`. The `allowed_paths` / `blocked_paths` prefix comparison should strip a leading `/` from both the argument and the prefix before comparing, so that `"/Projects/foo"` and `"Projects/foo"` are treated identically. Extension normalisation (`.md`) is not needed for prefix matching — `"Projects/"` correctly prefixes both `"Projects/foo"` and `"Projects/foo.md"`.

## Conclusion

FR-84 requires a static per-tool path parameter descriptor table (recommended above) and two comparison strategies — one for vault-relative strings, one for filesystem-absolute paths. All 13 built-in tools fit into three clear groups with no ambiguous cases. The `fetch_webpage` tool has no path parameter and requires no path enforcement. The `TOOL_PATH_PARAMS` table should be defined once in the dispatcher layer and used for all path-enforcement checks.
