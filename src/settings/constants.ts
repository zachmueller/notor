/**
 * Notor settings static reference data.
 *
 * Constants used by the settings UI: AWS region list for the Bedrock
 * dropdown and tool display metadata for the auto-approve section.
 */

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
		desc: "Make targeted edits using SEARCH/REPLACE blocks.",
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
		desc: "Make targeted SEARCH/REPLACE edits in a text file (desktop only).",
		isWrite: true,
	},
	extract_docx_comments: {
		name: "Extract Word doc comments",
		desc: "Extract review comments from a .docx file into a structured note (desktop only).",
		isWrite: true,
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
};

// ---------------------------------------------------------------------------
// Tools that default to disabled (user must opt-in via Settings → Tools)
// ---------------------------------------------------------------------------

export const TOOLS_DEFAULT_DISABLED: ReadonlySet<string> = new Set([
	"sleep",
	"search_chat_history",
	"read_chat_history",
]);
