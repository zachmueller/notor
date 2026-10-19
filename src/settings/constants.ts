/**
 * Notor settings static reference data.
 *
 * Constants used by the settings UI: AWS region list for the Bedrock
 * dropdown and tool display metadata for the auto-approve section.
 */

import { BUILTIN_TOOL_SCAFFOLDS } from "../extensions/builtin-tool-scaffolds";

// ---------------------------------------------------------------------------
// AWS regions for Bedrock dropdown
// ---------------------------------------------------------------------------

export const AWS_REGIONS: Array<{ value: string; label: string }> = [
	{ value: "us-east-1", label: "US East (N. Virginia)" },
	{ value: "us-east-2", label: "US East (Ohio)" },
	{ value: "us-west-2", label: "US West (Oregon)" },
	{ value: "eu-central-1", label: "Europe (Frankfurt)" },
	{ value: "eu-west-1", label: "Europe (Ireland)" },
	{ value: "eu-west-3", label: "Europe (Paris)" },
	{ value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
	{ value: "ap-northeast-2", label: "Asia Pacific (Seoul)" },
	{ value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
	{ value: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
	{ value: "ap-south-1", label: "Asia Pacific (Mumbai)" },
	{ value: "sa-east-1", label: "South America (São Paulo)" },
	{ value: "ca-central-1", label: "Canada (Central)" },
];

// ---------------------------------------------------------------------------
// Tool display names for auto-approve section
// ---------------------------------------------------------------------------

export const TOOL_DISPLAY_NAMES: Record<string, { name: string; desc: string; isWrite: boolean }> = {
	read_note: {
		name: "Read note",
		desc: "Read the full content of a note.",
		isWrite: false,
	},
	search_vault: {
		name: "Search vault",
		desc: "Search across notes using regex or text patterns.",
		isWrite: false,
	},
	list_vault: {
		name: "List vault",
		desc: "List files and folders in the vault.",
		isWrite: false,
	},
	read_frontmatter: {
		name: "Read frontmatter",
		desc: "Read parsed YAML frontmatter from a note.",
		isWrite: false,
	},
	word_count: {
		name: "Word count",
		desc: "Count words and characters in a note or a single section.",
		isWrite: false,
	},
	get_backlinks: {
		name: "Get backlinks",
		desc: "List all notes that link to a given note.",
		isWrite: false,
	},
	get_outlinks: {
		name: "Get outlinks",
		desc: "List all notes that a given note links to.",
		isWrite: false,
	},
	write_note: {
		name: "Write note",
		desc: "Create a new note or overwrite an existing note's full content.",
		isWrite: true,
	},
	replace_in_note: {
		name: "Replace in note",
		desc: "Make targeted find/replace edits.",
		isWrite: true,
	},
	update_frontmatter: {
		name: "Update frontmatter",
		desc: "Add, modify, or remove frontmatter properties.",
		isWrite: true,
	},
	manage_tags: {
		name: "Manage tags",
		desc: "Add or remove tags on a note.",
		isWrite: true,
	},
	move_note: {
		name: "Move note",
		desc: "Move and/or rename a note within the vault.",
		isWrite: true,
	},
	delete_note: {
		name: "Delete note",
		desc: "Delete a note from the vault (moves it to trash).",
		isWrite: true,
	},
	fetch_webpage: {
		name: "Fetch webpage",
		desc: "Fetch a webpage by URL and return its content as Markdown.",
		isWrite: false,
	},
	web_search: {
		name: "Web search",
		desc: "Search the web via DuckDuckGo and return result titles, URLs, and snippets.",
		isWrite: false,
	},
	execute_command: {
		name: "Execute command",
		desc: "Execute a shell command on the user's system (desktop only).",
		isWrite: true,
	},
	read_file: {
		name: "Read file",
		desc: "Read a text file from the filesystem (desktop only).",
		isWrite: false,
	},
	read_docx: {
		name: "Read Word doc",
		desc: "Read a .docx file and return its content as Markdown (desktop only).",
		isWrite: false,
	},
	import_docx: {
		name: "Import Word doc",
		desc: "Parse a .docx file and save its content as a Markdown note in the vault, extracting embedded images (desktop only).",
		isWrite: true,
	},
	write_docx: {
		name: "Write Word doc",
		desc: "Convert Markdown to a .docx file on the filesystem (desktop only).",
		isWrite: true,
	},
	write_file: {
		name: "Write file",
		desc: "Write text content to a file on the filesystem (desktop only).",
		isWrite: true,
	},
	replace_in_file: {
		name: "Replace in file",
		desc: "Make targeted find/replace edits in a text file (desktop only).",
		isWrite: true,
	},
	extract_docx_comments: {
		name: "Extract Word doc comments",
		desc: "Extract review comments from a .docx file into a structured note (desktop only).",
		isWrite: true,
	},
	read_xlsx: {
		name: "Read spreadsheet",
		desc: "Read an .xlsx file and return its content as Markdown tables or JSON (desktop only).",
		isWrite: false,
	},
	write_xlsx: {
		name: "Write spreadsheet",
		desc: "Create an .xlsx file from Markdown tables or JSON data (desktop only).",
		isWrite: true,
	},
	import_xlsx: {
		name: "Import spreadsheet",
		desc: "Parse an .xlsx file and save its content as a Markdown note in the vault (desktop only).",
		isWrite: true,
	},
	list_xlsx_sheets: {
		name: "List spreadsheet sheets",
		desc: "List the worksheet names in an .xlsx file with row and column counts (desktop only).",
		isWrite: false,
	},
	submit_plan: {
		name: "Submit plan",
		desc: "Hand a step-by-step plan to you for review in a dedicated tab (Plan mode). Approving switches to Act mode.",
		isWrite: false,
	},
	use_subagent: {
		name: "Use sub-agent",
		desc: "Spawn a sub-agent to handle a delegated task.",
		isWrite: false,
	},
	sleep: {
		name: "Sleep",
		desc: "Pause execution for a specified duration (cancellable).",
		isWrite: false,
	},
	search_chat_history: {
		name: "Search chat history",
		desc: "Search past conversations by keyword.",
		isWrite: false,
	},
	read_chat_history: {
		name: "Read chat history",
		desc: "Read the full message history of a past conversation.",
		isWrite: false,
	},
	read_notor_settings: {
		name: "Read Notor settings",
		desc: "Read the current Notor plugin settings as JSON.",
		isWrite: false,
	},
	edit_notor_settings: {
		name: "Edit Notor settings",
		desc: "Change a single Notor plugin setting by key path.",
		isWrite: true,
	},
	capture_memory: {
		name: "Capture memory",
		desc: "Save an insight into long-term memory as an Evergreen note.",
		isWrite: true,
	},
	webview: {
		name: "Web viewer",
		desc: "Browse the web via Obsidian's Web Viewer (navigate, read, click links). Desktop only.",
		isWrite: true,
	},
	list_templates: {
		name: "List templates",
		desc: "List available templates from the configured template folder. Detects Templater prompt/suggester calls.",
		isWrite: false,
	},
	apply_template: {
		name: "Apply template",
		desc: "Apply a template to create a new note. For Templater templates, automatically answers prompts and suggestors.",
		isWrite: true,
	},
	// Circuit tools (featureGroup "circuits"): their rows render only while
	// circuits are enabled, because the Tools section intersects this table with
	// the registered extension tools.
	emit_event: {
		name: "Emit circuit event",
		desc: "Publish a circuit event to route the run to its next step. Control flow only; changes nothing in the vault.",
		isWrite: false,
	},
	submit_score: {
		name: "Submit evaluation score",
		desc: "Report an evaluator's per-dimension scores and rationale for a circuit run.",
		isWrite: false,
	},
	circuit_task_list: {
		name: "List circuit tasks",
		desc: "List the current circuit session's tasks, optionally filtered by status.",
		isWrite: false,
	},
	circuit_task_ensure: {
		name: "Ensure circuit task",
		desc: "Create a task in the current circuit session's task registry (idempotent).",
		isWrite: true,
	},
	circuit_task_start: {
		name: "Start circuit task",
		desc: "Mark a circuit task as running.",
		isWrite: true,
	},
	circuit_task_close: {
		name: "Close circuit task",
		desc: "Mark a circuit task as closed.",
		isWrite: true,
	},
	invoke_workflow: {
		name: "Invoke workflow",
		desc: "Run a named workflow from a circuit step and fold its result into the step. The workflow runs uncapped.",
		isWrite: true,
	},
};

/**
 * Default auto-approve for a tool with no explicit per-tool setting.
 *
 * Built-in read tools auto-approve; write tools require approval. This is the
 * single source of truth for the mode-derived default, shared by the settings
 * UI and the tool-config merger so they can never diverge (the divergence that
 * caused enabled read tools like `sleep` to prompt despite an "on" toggle).
 *
 * Resolution order:
 *  1. `TOOL_DISPLAY_NAMES` — built-in tools with a settings row (`!isWrite`).
 *  2. `BUILTIN_TOOL_SCAFFOLDS` — feature-gated scaffolds that may have no
 *     settings row (`emit_event`, `ask_user`, …) derive the default from their
 *     own declared `mode`, so a scaffold can never fall into the MCP/user-tool
 *     branch below (the gap that made every circuit step's `emit_event` prompt
 *     once runs with no chat panel started applying the approval rules).
 *  3. Anything else (MCP, user-extension) defaults to `false` (conservative) —
 *     their auto-approve is sourced elsewhere (e.g. MCP server `autoApprove[]`,
 *     pre-expanded into `globalAutoApprove`).
 */
export function defaultAutoApproveFor(toolName: string): boolean {
	const meta = TOOL_DISPLAY_NAMES[toolName];
	if (meta) return !meta.isWrite;
	const scaffold = BUILTIN_TOOL_SCAFFOLDS.get(toolName);
	if (scaffold) return scaffold.mode === "read";
	return false;
}

// ---------------------------------------------------------------------------
// Tools that default to disabled (user must opt-in via Settings → Tools)
// ---------------------------------------------------------------------------

export const TOOLS_DEFAULT_DISABLED: ReadonlySet<string> = new Set([
	"delete_note",
	"sleep",
	"word_count",
	"search_chat_history",
	"read_chat_history",
	"read_notor_settings",
	"edit_notor_settings",
	"webview",
]);
