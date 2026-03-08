/**
 * Shared TypeScript interfaces and types for Notor.
 *
 * All entity definitions sourced from specs/01-mvp/data-model.md.
 */

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

/** An ordered sequence of messages representing a single AI interaction session. */
export interface Conversation {
	/** Unique identifier (UUID v4). */
	id: string;
	/** Conversation creation timestamp (ISO 8601). */
	created_at: string;
	/** Last activity timestamp (ISO 8601). */
	updated_at: string;
	/** Display title (derived from first user message if not set). */
	title?: string;
	/** Provider type active when conversation started. */
	provider_id: string;
	/** Model ID active when conversation started. */
	model_id: string;
	/** Cumulative input tokens across all messages. */
	total_input_tokens: number;
	/** Cumulative output tokens across all messages. */
	total_output_tokens: number;
	/** Cumulative estimated cost (null if pricing unavailable). */
	estimated_cost: number | null;
	/** Current Plan/Act mode state. */
	mode: ConversationMode;
	/**
	 * Vault-relative path of the workflow note that created this conversation
	 * (null for non-workflow conversations).
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-001
	 */
	workflow_path?: string | null;
	/**
	 * Display name of the workflow (e.g. `"daily/review"`) for UI labeling.
	 * null for non-workflow conversations.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-001
	 */
	workflow_name?: string | null;
	/**
	 * Active persona name at the time the workflow conversation was created
	 * (after any persona switch). null for non-workflow conversations or
	 * workflow conversations without a persona override.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-001
	 */
	persona_name?: string | null;
	/**
	 * Whether this conversation is a background (event-triggered) workflow
	 * execution. false for manual (foreground) workflows; undefined/null
	 * for non-workflow conversations.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-001
	 */
	is_background?: boolean;
}

/** Plan/Act mode. */
export type ConversationMode = "plan" | "act";

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

/** Role of a message within a conversation. */
export type MessageRole = "system" | "user" | "assistant" | "tool_call" | "tool_result";

/** A single message within a conversation. */
export interface Message {
	/** Unique message identifier (UUID v4). */
	id: string;
	/** Parent conversation ID. */
	conversation_id: string;
	/** Message role. */
	role: MessageRole;
	/** Message text content. */
	content: string;
	/** When the message was created (ISO 8601). */
	timestamp: string;
	/** Input token count for this message (null for non-LLM messages). */
	input_tokens?: number | null;
	/** Output token count for this message (null for non-LLM messages). */
	output_tokens?: number | null;
	/** Estimated cost for this message (null if pricing unavailable). */
	cost_estimate?: number | null;
	/** Tool call details (for tool_call role only). */
	tool_call?: ToolCall | null;
	/** Tool result details (for tool_result role only). */
	tool_result?: ToolResult | null;
	/** Whether this message was truncated from the LLM context window. */
	truncated?: boolean;
	/** Auto-context metadata logged for user messages (Phase 3). */
	auto_context?: string | null;
	/** Attachment metadata logged for user messages (Phase 3). */
	attachments?: Array<{
		id: string;
		type: string;
		path: string;
		section: string | null;
		display_name: string;
		content_length: number | null;
		status: string;
	}> | null;
	/** Captured stdout from pre-send hooks (Phase 3). */
	hook_injections?: string[] | null;
	/** Whether this user message is a hook injection (ACI-002). */
	is_hook_injection?: boolean;
	/**
	 * Whether this user message is the opening workflow message (contains
	 * `<workflow_instructions>` content). Used to trigger `<details>`
	 * rendering in the chat UI.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-001
	 */
	is_workflow_message?: boolean;
}

// ---------------------------------------------------------------------------
// Tool Call / Tool Result
// ---------------------------------------------------------------------------

/** Status of a tool invocation. */
export type ToolCallStatus = "pending" | "approved" | "rejected" | "success" | "error";

/** Structured record of a tool invocation requested by the LLM. */
export interface ToolCall {
	/**
	 * Provider-assigned tool call identifier (e.g., Bedrock `toolUseId`).
	 * Stored so the provider can correctly correlate tool results to calls
	 * when the conversation history is replayed on subsequent LLM turns.
	 */
	id?: string;
	/** Name of the tool being invoked. */
	tool_name: string;
	/** Tool parameters as key-value pairs. */
	parameters: Record<string, unknown>;
	/** Current status of the tool call. */
	status: ToolCallStatus;
}

/** Output from a completed tool execution. */
export interface ToolResult {
	/** Name of the tool that was invoked. */
	tool_name: string;
	/** Whether the tool execution succeeded. */
	success: boolean;
	/** Tool output. */
	result: string | Record<string, unknown>;
	/** Error message if execution failed. */
	error?: string | null;
	/** Execution time in milliseconds. */
	duration_ms?: number;
	/**
	 * Provider-assigned tool call ID this result responds to.
	 * Must match the `id` on the corresponding `ToolCall` so that
	 * providers like Bedrock can validate the conversation history.
	 */
	tool_call_id?: string;
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

/** A snapshot of a single note's content at a point in time. */
export interface Checkpoint {
	/** Unique checkpoint identifier (UUID v4). */
	id: string;
	/** Conversation that triggered the checkpoint. */
	conversation_id: string;
	/** Vault-relative path of the snapshotted note. */
	note_path: string;
	/** Full note content at snapshot time (including frontmatter). */
	content: string;
	/** When the snapshot was taken (ISO 8601). */
	timestamp: string;
	/** Human-readable description. */
	description: string;
	/** The write tool that triggered this checkpoint. */
	tool_name: string;
	/** The message ID of the tool call that triggered this checkpoint. */
	message_id: string;
}

// ---------------------------------------------------------------------------
// LLM Provider Configuration
// ---------------------------------------------------------------------------

/** Supported LLM provider types. */
export type LLMProviderType = "local" | "bedrock" | "anthropic" | "openai";

/** AWS Bedrock authentication method. */
export type AWSAuthMethod = "profile" | "keys";

/** Configuration for a single LLM provider connection. */
export interface LLMProviderConfig {
	/** Provider type. */
	type: LLMProviderType;
	/** Whether this provider is configured and available. */
	enabled: boolean;
	/** User-facing label. */
	display_name: string;
	/** Custom endpoint URL (required for local, optional for openai). */
	endpoint?: string | null;
	/** AWS region (for bedrock only). */
	region?: string | null;
	/** AWS profile name (for bedrock with profile auth). */
	aws_profile?: string | null;
	/** AWS authentication method (for bedrock only). */
	aws_auth_method?: AWSAuthMethod | null;
	/** Currently selected model ID. */
	model_id?: string | null;
	/** Cached model list from last fetch. */
	model_cache?: ModelInfo[] | null;
	/** When the model list was last fetched (ISO 8601). */
	model_cache_timestamp?: string | null;
}

// ---------------------------------------------------------------------------
// Model Info
// ---------------------------------------------------------------------------

/** Cached information about a model available from a provider. */
export interface ModelInfo {
	/** Model identifier (as used in API calls). */
	id: string;
	/** Human-readable model name. */
	display_name: string;
	/** Maximum context window in tokens. */
	context_window?: number | null;
	/** Cost per 1K input tokens. */
	input_price_per_1k?: number | null;
	/** Cost per 1K output tokens. */
	output_price_per_1k?: number | null;
	/** Model provider name (useful for Bedrock). */
	provider?: string | null;
}

// ---------------------------------------------------------------------------
// Vault Rule
// ---------------------------------------------------------------------------

/** In-memory representation of a vault-level instruction file. */
export interface VaultRule {
	/** Vault-relative path to the rule file. */
	file_path: string;
	/** If true, always inject this rule. */
	always_include?: boolean;
	/** Directory path trigger. */
	directory_include?: string | null;
	/** Tag trigger. */
	tag_include?: string | null;
	/** Rule body content (frontmatter stripped) to inject into system prompt. */
	content: string;
}

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

/**
 * How a persona's system prompt relates to the global system prompt.
 *
 * - `"append"` — persona prompt is appended after the global system prompt.
 * - `"replace"` — persona prompt replaces the global system prompt entirely
 *   (vault-level rules still apply).
 */
export type PersonaPromptMode = "append" | "replace";

/**
 * In-memory representation of a discovered persona, loaded from a
 * subdirectory under `{notor_dir}/personas/`.
 *
 * Not persisted as structured data — personas are discovered at runtime
 * by scanning the persona directory.
 *
 * @see specs/03-workflows-personas/data-model.md — Persona entity
 */
export interface Persona {
	/** Persona name, derived from subdirectory name (e.g., `"researcher"`). */
	name: string;
	/** Vault-relative path to the persona directory (e.g., `"notor/personas/researcher/"`). */
	directory_path: string;
	/** Vault-relative path to `system-prompt.md` (e.g., `"notor/personas/researcher/system-prompt.md"`). */
	system_prompt_path: string;
	/** Body content of `system-prompt.md` after stripping frontmatter — the persona's system prompt text. */
	prompt_content: string;
	/** How the persona prompt relates to the global system prompt. Default: `"append"`. */
	prompt_mode: PersonaPromptMode;
	/** Override LLM provider identifier (null = use global default). */
	preferred_provider: string | null;
	/** Override model identifier (null = use global default). */
	preferred_model: string | null;
}

// ---------------------------------------------------------------------------
// Auto-Approve Override (Per-Persona)
// ---------------------------------------------------------------------------

/**
 * Per-persona auto-approve override state for a single tool.
 *
 * - `"global"` — no override; the global auto-approve setting applies.
 * - `"approve"` — tool is auto-approved when this persona is active.
 * - `"deny"` — tool requires manual approval when this persona is active.
 *
 * @see specs/03-workflows-personas/data-model.md — PersonaAutoApproveConfig
 */
export type AutoApproveState = "global" | "approve" | "deny";

/**
 * Per-persona per-tool auto-approve override configuration.
 *
 * Not persisted as a standalone entity — stored in plugin settings
 * as `persona_auto_approve: Record<string, Record<string, string>>`.
 *
 * @see specs/03-workflows-personas/data-model.md — PersonaAutoApproveConfig
 */
export interface PersonaAutoApproveConfig {
	/** Name of the persona these overrides apply to. */
	persona_name: string;
	/** Map of tool name → override state. */
	overrides: Record<string, AutoApproveState>;
}

// ---------------------------------------------------------------------------
// Stale Content Check
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

/**
 * Valid trigger types for workflow notes.
 *
 * - `"manual"` — triggered via command palette or slash-command.
 * - `"on-note-open"` — fired when a note is opened.
 * - `"on-note-create"` — fired when a new note is created.
 * - `"on-save"` — fired on any save (auto or manual).
 * - `"on-manual-save"` — fired on explicit Cmd/Ctrl+S save only.
 * - `"on-tag-change"` — fired when frontmatter tags change.
 * - `"scheduled"` — fired on a cron schedule.
 *
 * @see specs/03-workflows-personas/data-model.md — Workflow entity
 */
export type WorkflowTrigger =
	| "manual"
	| "on-note-open"
	| "on-note-create"
	| "on-save"
	| "on-manual-save"
	| "on-tag-change"
	| "scheduled";

/**
 * Constant array of all valid `WorkflowTrigger` values, used for
 * validation during workflow discovery.
 */
export const VALID_WORKFLOW_TRIGGERS: readonly WorkflowTrigger[] = [
	"manual",
	"on-note-open",
	"on-note-create",
	"on-save",
	"on-manual-save",
	"on-tag-change",
	"scheduled",
] as const;

/**
 * LLM lifecycle hook event types for per-workflow hook overrides.
 *
 * @see specs/03-workflows-personas/data-model.md — WorkflowScopedHook entity
 */
export type LLMHookEvent =
	| "pre_send"
	| "on_tool_call"
	| "on_tool_result"
	| "after_completion";

/**
 * A single per-workflow LLM lifecycle hook override.
 *
 * Defined in workflow frontmatter under `notor-hooks` and parsed
 * at discovery time. Overrides global hooks for the corresponding
 * lifecycle event during the workflow's execution.
 *
 * @see specs/03-workflows-personas/data-model.md — WorkflowScopedHook entity
 */
export interface WorkflowScopedHook {
	/** Lifecycle event this hook fires on. */
	event: LLMHookEvent;
	/** Action to perform when the hook fires. */
	action_type: "execute_command" | "run_workflow";
	/** Shell command (required when action_type is "execute_command"). */
	command: string | null;
	/** Vault-relative workflow path (required when action_type is "run_workflow"). */
	workflow_path: string | null;
}

/**
 * Per-workflow hook configuration — optional arrays of
 * `WorkflowScopedHook` keyed by lifecycle event.
 *
 * Only events with at least one valid action are present.
 *
 * @see specs/03-workflows-personas/data-model.md — WorkflowHookConfig
 */
export interface WorkflowHookConfig {
	pre_send?: WorkflowScopedHook[];
	on_tool_call?: WorkflowScopedHook[];
	on_tool_result?: WorkflowScopedHook[];
	after_completion?: WorkflowScopedHook[];
}

/**
 * In-memory representation of a discovered workflow note.
 *
 * Not persisted as structured data — workflows are discovered at
 * runtime by scanning the workflows directory. The structured
 * representation describes the in-memory model.
 *
 * @see specs/03-workflows-personas/data-model.md — Workflow entity
 */
export interface Workflow {
	/** Vault-relative path to the workflow note (e.g., `notor/workflows/daily/review.md`). */
	file_path: string;
	/** File name of the workflow note (e.g., `review.md`). */
	file_name: string;
	/** Human-readable display name (e.g., `review` or `daily/review` for nested workflows). */
	display_name: string;
	/** Trigger type from `notor-trigger` frontmatter. */
	trigger: WorkflowTrigger;
	/** Cron expression from `notor-schedule` (required when trigger is `"scheduled"`). */
	schedule: string | null;
	/** Persona to activate from `notor-workflow-persona` (null = use current persona). */
	persona_name: string | null;
	/** Per-workflow LLM lifecycle hook overrides from `notor-hooks`. */
	hooks: WorkflowHookConfig | null;
	/** Body content of the workflow note (empty string during discovery; read lazily at execution time). */
	body_content: string;
}

// ---------------------------------------------------------------------------
// Stale Content Check
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// IncludeNoteTag
// ---------------------------------------------------------------------------

/**
 * Whether the path in an `<include_note>` tag is a vault-relative path
 * or a wikilink.
 *
 * - `"vault_relative"` — plain file path, resolved via `vault.getAbstractFileByPath()`.
 * - `"wikilink"` — path wrapped in `[[…]]`, resolved via `metadataCache.getFirstLinkpathDest()`.
 *
 * @see specs/03-workflows-personas/data-model.md — IncludeNoteTag entity
 */
export type IncludeNotePathType = "vault_relative" | "wikilink";

/**
 * Injection mode for a resolved `<include_note>` tag.
 *
 * - `"inline"` — resolved content replaces the tag directly in the surrounding text.
 * - `"attached"` — resolved content is collected into a separate `<attachments>` block.
 *
 * @see specs/03-workflows-personas/contracts/include-note-tag.md — Supported Attributes
 */
export type IncludeNoteMode = "inline" | "attached";

/**
 * Parsed representation of a single `<include_note ... />` tag, extracted
 * from workflow bodies, system prompts, or vault rule files at resolution time.
 *
 * Not persisted — tags are parsed and resolved at execution time. This
 * interface describes the intermediate parsed form before resolution.
 *
 * @see specs/03-workflows-personas/data-model.md — IncludeNoteTag entity
 * @see specs/03-workflows-personas/contracts/include-note-tag.md
 */
export interface IncludeNoteTag {
	/** The full original tag text as found in the source (for replacement). */
	raw_tag: string;
	/** The `path` attribute value — vault-relative path or wikilink. */
	path: string;
	/** Whether the path is a vault-relative path or a wikilink. */
	path_type: IncludeNotePathType;
	/** The `section` attribute value — heading to extract (null = full note). */
	section: string | null;
	/** Injection mode. Default: `"inline"`. */
	mode: IncludeNoteMode;
	/** Whether to strip YAML frontmatter before injection. Default: `true`. */
	strip_frontmatter: boolean;
}

/**
 * Result of resolving all `<include_note>` tags in a text string.
 *
 * - `inlineContent` — the text with inline-mode tags replaced and attached-mode tags removed.
 * - `attachments` — collected attached-mode entries (empty array if none).
 *
 * @see specs/03-workflows-personas/contracts/include-note-tag.md — Resolution Algorithm
 */
export interface IncludeNoteResolutionResult {
	/** Text with inline tags resolved and attached-mode tags removed. */
	inlineContent: string;
	/** Collected attached-mode entries. */
	attachments: Array<{
		path: string;
		section: string | null;
		content: string;
	}>;
}

// ---------------------------------------------------------------------------
// Stale Content Check
// ---------------------------------------------------------------------------

/** Tracks the last-read content for a note path within a conversation. */
export interface StaleContentEntry {
	/** Vault-relative path. */
	note_path: string;
	/** Full content as returned by the last read_note call. */
	last_read_content: string;
	/** When the content was last read (ISO 8601). */
	last_read_timestamp: string;
}

// ---------------------------------------------------------------------------
// Workflow Execution (Group E)
// ---------------------------------------------------------------------------

/**
 * Structured context about the event that triggered a workflow execution.
 *
 * Populated by Group F (event-triggered workflows) and passed to
 * `assembleWorkflowPrompt()`. Manual triggers pass `null`.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-001
 * @see specs/03-workflows-personas/contracts/workflow-assembly.md — Step 5
 */
export interface TriggerContext {
	/** The event type that triggered the workflow (e.g. `"on-save"`, `"scheduled"`). */
	event: string;
	/** Vault-relative path of the note that caused the event (null for scheduled events). */
	note_path: string | null;
	/** Tags added to the note (only for `on-tag-change` events). */
	tags_added: string[] | null;
	/** Tags removed from the note (only for `on-tag-change` events). */
	tags_removed: string[] | null;
}

/**
 * Input to the workflow prompt assembly pipeline.
 *
 * Passed to `assembleWorkflowPrompt()` to produce the complete user
 * message for a workflow execution.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-001
 * @see specs/03-workflows-personas/contracts/workflow-assembly.md — Pipeline
 */
export interface WorkflowExecutionRequest {
	/** The discovered workflow to execute. */
	workflow: Workflow;
	/**
	 * Optional supplementary text typed by the user alongside the workflow
	 * chip (slash-command UX). Null for command-palette executions.
	 */
	supplementaryText: string | null;
	/**
	 * Event context for event-triggered executions (Group F).
	 * Null for manual (command palette / slash-command) executions.
	 */
	triggerContext: TriggerContext | null;
}

/**
 * Output of the workflow prompt assembly pipeline.
 *
 * Returned by `assembleWorkflowPrompt()` on successful assembly.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-001
 */
export interface WorkflowAssemblyResult {
	/** The fully assembled user message string, ready for dispatch to the LLM. */
	assembledMessage: string;
	/** Display name of the workflow (used for UI labeling and conversation title). */
	workflowName: string;
	/**
	 * Attachments collected from `<include_note mode="attached">` tags in the
	 * workflow body. Empty array if no attached-mode tags were resolved.
	 */
	attachments: Array<{
		path: string;
		section: string | null;
		content: string;
	}>;
}
