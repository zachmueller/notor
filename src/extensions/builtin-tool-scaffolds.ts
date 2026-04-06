/**
 * Built-in tool scaffold definitions for the Extensions settings section.
 *
 * Each scaffold provides a complete `.md` file template that can be written
 * to `notor/tools/{name}.md` so the user can customize the built-in tool.
 * The vault file overrides the built-in implementation on next reload.
 *
 * Follows the same pattern as `src/sub-agents/builtin-profiles.ts`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Definition of a built-in tool scaffold (code-side constant). */
export interface BuiltinToolScaffold {
	/** Tool name (matches the vault filename without `.md`). */
	name: string;
	/** Short description for the settings UI. */
	description: string;
	/** Tool mode. */
	mode: "read" | "write";
	/**
	 * Full content of the `.md` scaffold file including frontmatter,
	 * YAML params fence, and TS code fence.
	 */
	scaffoldContent: string;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function scaffold(
	name: string,
	description: string,
	mode: "read" | "write",
	paramsYaml: string,
): BuiltinToolScaffold {
	const trimmedParams = paramsYaml.trimEnd();
	return {
		name,
		description,
		mode,
		scaffoldContent:
`---
notor-type: tool
notor-tool-name: ${name}
notor-description: "${description}"
notor-mode: ${mode}
---

Customizable override for the built-in \`${name}\` tool. Edit the code below and reload extensions to apply changes.

\`\`\`yaml
${trimmedParams}
\`\`\`

\`\`\`ts
// Built-in tool override. Customize the code below.
// The built-in implementation runs when this file doesn't exist.
return "Not yet customized — remove this line and add your implementation.";
\`\`\`
`,
	};
}

// ---------------------------------------------------------------------------
// Scaffold definitions
// ---------------------------------------------------------------------------

const READ_NOTE = scaffold(
	"read_note",
	"Read the contents of a note in the vault.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root. The '.md' extension is optional."
    path_namespace: vault
  include_frontmatter:
    type: boolean
    description: "Whether to include YAML frontmatter in the returned content."
    default: false`,
);

const SEARCH_VAULT = scaffold(
	"search_vault",
	"Search across notes in the vault using regex or text patterns.",
	"read",
	`params:
  query:
    type: string
    description: "Regex pattern or text string to search for"
  path:
    type: string
    description: "Directory to search within, relative to vault root."
    default: ""
    path_namespace: vault
  context_lines:
    type: number
    description: "Number of surrounding lines to include with each match."
    default: 3
  file_pattern:
    type: string
    description: "Glob pattern to filter which files to search."
    default: "*.md"
  sort_by:
    type: string
    description: "Sort order for results: 'match_count', 'backlinks', or 'modified'."
    enum:
      - match_count
      - backlinks
      - modified
    default: "match_count"
  limit:
    type: number
    description: "Maximum number of files to return."
    default: 20
  offset:
    type: number
    description: "Number of files to skip for pagination."
    default: 0`,
);

const LIST_VAULT = scaffold(
	"list_vault",
	"List the folder and note structure of the vault or a subdirectory.",
	"read",
	`params:
  path:
    type: string
    description: "Directory to list, relative to vault root."
    default: ""
    path_namespace: vault
  recursive:
    type: boolean
    description: "Whether to list contents recursively."
    default: false
  limit:
    type: number
    description: "Maximum number of items to return."
    default: 50
  offset:
    type: number
    description: "Number of items to skip for pagination."
    default: 0
  sort_by:
    type: string
    description: "Sort order: 'last_modified' or 'alphabetical'."
    enum:
      - last_modified
      - alphabetical
    default: "last_modified"`,
);

const READ_FRONTMATTER = scaffold(
	"read_frontmatter",
	"Read the parsed YAML frontmatter of a note as structured key-value data.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault`,
);

const GET_BACKLINKS = scaffold(
	"get_backlinks",
	"Returns all notes in the vault that link TO the specified note.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault`,
);

const GET_OUTLINKS = scaffold(
	"get_outlinks",
	"Returns all notes that the specified note links TO.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault`,
);

const WRITE_NOTE = scaffold(
	"write_note",
	"Create a new note or overwrite an existing note's entire content.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
  content:
    type: string
    description: "Complete content to write to the note."`,
);

const REPLACE_IN_NOTE = scaffold(
	"replace_in_note",
	"Make targeted edits within a note using SEARCH/REPLACE blocks.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
  changes:
    type: "object[]"
    description: "Array of search/replace blocks to apply in sequence. Each block replaces only the first occurrence of the search text."
    properties:
      search:
        type: string
        description: "Exact text to find in the note (character-for-character match including whitespace)."
      replace:
        type: string
        description: "Text to replace the matched search text with. Use empty string to delete the matched text."
    required_items:
      - search
      - replace`,
);

const UPDATE_FRONTMATTER = scaffold(
	"update_frontmatter",
	"Add, modify, or remove specific frontmatter properties.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
  set:
    type: string
    description: "JSON-encoded object of key-value pairs to add or update in the frontmatter."
  remove:
    type: "string[]"
    description: "List of frontmatter keys to remove."`,
);

const MANAGE_TAGS = scaffold(
	"manage_tags",
	"Add or remove tags on a note via the frontmatter 'tags' property.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
  add:
    type: "string[]"
    description: "Tags to add to the note."
  remove:
    type: "string[]"
    description: "Tags to remove from the note."`,
);

const MOVE_NOTE = scaffold(
	"move_note",
	"Move and/or rename a note within the vault.",
	"write",
	`params:
  path:
    type: string
    description: "Current path of the note relative to vault root."
    path_namespace: vault
  new_path:
    type: string
    description: "New path for the note relative to vault root."
    path_namespace: vault
  add_alias:
    type: boolean
    description: "If true, append the old name to the note's frontmatter aliases."
    default: false`,
);

const FETCH_WEBPAGE = scaffold(
	"fetch_webpage",
	"Fetch a webpage by URL and return its content converted to Markdown.",
	"read",
	`params:
  url:
    type: string
    description: "URL of the webpage to fetch."`,
);

const WEB_SEARCH = scaffold(
	"web_search",
	"Search the web using DuckDuckGo and return results with titles, URLs, and snippets.",
	"read",
	`params:
  query:
    type: string
    description: "Search query string."
  num_results:
    type: number
    description: "Number of results to return. Maximum 10."
    default: 5`,
);

const EXECUTE_COMMAND = scaffold(
	"execute_command",
	"Execute a shell command on the user's system and return the output.",
	"write",
	`params:
  command:
    type: string
    description: "Shell command to execute."
  working_directory:
    type: string
    description: "Working directory for the command, relative to vault root or absolute."
    default: ""
    path_namespace: filesystem`,
);

const READ_FILE = scaffold(
	"read_file",
	"Read a text file, image, or PDF from the filesystem.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the file. Vault-relative or absolute."
    path_namespace: filesystem
  encoding:
    type: string
    description: "File encoding."
    default: "utf-8"
  pages:
    type: string
    description: "Page range for PDF files (e.g. '1-5')."`,
);

const READ_DOCX = scaffold(
	"read_docx",
	"Read a .docx file and return its content as Markdown.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the .docx file. Vault-relative or absolute."
    path_namespace: filesystem`,
);

const WRITE_DOCX = scaffold(
	"write_docx",
	"Convert Markdown to a .docx file on the filesystem.",
	"write",
	`params:
  note_name:
    type: string
    description: "Path to an existing vault note to convert. Mutually exclusive with content."
  content:
    type: string
    description: "Markdown content to convert. Mutually exclusive with note_name."
  output_path:
    type: string
    description: "Full output path including .docx extension."
    path_namespace: filesystem
  filename:
    type: string
    description: "Output filename without .docx extension."
  template_path:
    type: string
    description: "Path to a .docx template."
    path_namespace: filesystem`,
);

const WRITE_FILE = scaffold(
	"write_file",
	"Write text content to a file on the filesystem.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the file. Vault-relative or absolute."
    path_namespace: filesystem
  content:
    type: string
    description: "Complete text content to write to the file."
  encoding:
    type: string
    description: "File encoding."
    default: "utf-8"`,
);

const REPLACE_IN_FILE = scaffold(
	"replace_in_file",
	"Make targeted edits within a text file using SEARCH/REPLACE blocks.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the file. Vault-relative or absolute."
    path_namespace: filesystem
  changes:
    type: "object[]"
    description: "Array of search/replace blocks to apply in sequence. Each block replaces only the first occurrence of the search text."
    properties:
      search:
        type: string
        description: "Exact text to find in the file (character-for-character match including whitespace)."
      replace:
        type: string
        description: "Text to replace the matched search text with. Use empty string to delete the matched text."
    required_items:
      - search
      - replace`,
);

const EXTRACT_DOCX_COMMENTS = scaffold(
	"extract_docx_comments",
	"Extract review comments from a .docx file and write them as a structured note.",
	"write",
	`params:
  docx_path:
    type: string
    description: "Path to the .docx file."
    path_namespace: filesystem
  output_path:
    type: string
    description: "Vault-relative path for the output note."
    path_namespace: vault
  include_resolved:
    type: boolean
    description: "Include resolved/done comments."
    default: false`,
);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * All built-in tool scaffolds, keyed by tool name.
 *
 * Used by:
 * - `ExtensionManager.ensureBuiltinToolVaultFile()` to create vault files on demand
 * - `ExtensionManager.resetBuiltinToolToDefault()` to restore vault files
 * - Extensions settings section to enumerate built-in tools
 */
export const BUILTIN_TOOL_SCAFFOLDS: ReadonlyMap<string, BuiltinToolScaffold> =
	new Map([
		[READ_NOTE.name, READ_NOTE],
		[SEARCH_VAULT.name, SEARCH_VAULT],
		[LIST_VAULT.name, LIST_VAULT],
		[READ_FRONTMATTER.name, READ_FRONTMATTER],
		[GET_BACKLINKS.name, GET_BACKLINKS],
		[GET_OUTLINKS.name, GET_OUTLINKS],
		[WRITE_NOTE.name, WRITE_NOTE],
		[REPLACE_IN_NOTE.name, REPLACE_IN_NOTE],
		[UPDATE_FRONTMATTER.name, UPDATE_FRONTMATTER],
		[MANAGE_TAGS.name, MANAGE_TAGS],
		[MOVE_NOTE.name, MOVE_NOTE],
		[FETCH_WEBPAGE.name, FETCH_WEBPAGE],
		[WEB_SEARCH.name, WEB_SEARCH],
		[EXECUTE_COMMAND.name, EXECUTE_COMMAND],
		[READ_FILE.name, READ_FILE],
		[READ_DOCX.name, READ_DOCX],
		[WRITE_DOCX.name, WRITE_DOCX],
		[WRITE_FILE.name, WRITE_FILE],
		[REPLACE_IN_FILE.name, REPLACE_IN_FILE],
		[EXTRACT_DOCX_COMMENTS.name, EXTRACT_DOCX_COMMENTS],
	]);
