/**
 * Shared TypeScript interfaces and types for Notor.
 *
 * All entity definitions sourced from specs/01-mvp/data-model.md.
 */

import type { ContentBlock } from "./media/types";

// ---------------------------------------------------------------------------
// Task tracking
// ---------------------------------------------------------------------------

/** A single task item in the AI's working task list. */
export interface TaskItem {
	content: string;
	status: "pending" | "in_progress" | "completed";
}

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
	 * Tool configs extracted from the workflow's `<notor_tool_config>` blocks,
	 * persisted on the conversation so follow-up turns re-apply them (the
	 * transient `WorkflowAssemblyResult` only lives for the first execution
	 * session). Absent/null for non-workflow conversations or workflows with
	 * no config blocks. Re-hydrated into a minimal `WorkflowAssemblyResult` by
	 * `handleUserMessage()` when `workflow_deactivated` is not true.
	 */
	workflow_tool_configs?: import("./tool-config/types").ParsedToolConfig[] | null;
	/**
	 * Whether the user has explicitly deactivated this conversation's workflow
	 * via the workflow chip. When true, `workflow_tool_configs` are NOT
	 * re-applied on follow-up turns (config reverts to persona/rule/global
	 * precedence). `workflow_path`/`workflow_name` are retained for history.
	 * Omitted (= false) for backward compatibility.
	 */
	workflow_deactivated?: boolean;
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
	/**
	 * Whether the 1M extended context window beta was active when this
	 * conversation was created. Omitted (= false) for back-compat.
	 *
	 * @see private/bedrock-model-picker-overhaul.md — Phase 2e
	 */
	use_extended_context?: boolean;
	/**
	 * ID of the conversation this was forked from (null for non-forked
	 * conversations). Together with `forked_from_message_id`, establishes
	 * fork provenance for lineage navigation.
	 *
	 * @see specs/ZZ-misc/conversation-fork-design.md
	 */
	forked_from_conversation_id?: string | null;
	/**
	 * ID of the message in the parent conversation at which the fork was
	 * created. Messages up to and including this one were copied into the
	 * fork.
	 *
	 * @see specs/ZZ-misc/conversation-fork-design.md
	 */
	forked_from_message_id?: string | null;
	/**
	 * Whether this conversation is marked as a favorite.
	 * Favorites are sorted to the top of the conversation list.
	 * Omitted (= false) for backward compatibility.
	 */
	is_favorite?: boolean;
	/**
	 * Preset name active when conversation was created (null/undefined for pre-preset
	 * conversations or "Custom" manual selection).
	 *
	 * @see specs/ZZ-misc/model-presets-design.md — Section 3.3
	 */
	preset_name?: string | null;
	/**
	 * Unsent input text saved when the user navigated away from this conversation
	 * mid-composition. Restored to the input box when the user returns.
	 * null/undefined means no draft is saved.
	 */
	draft_text?: string | null;
	/**
	 * Structured task list maintained by the AI via the update_tasks tool.
	 * Persisted in the JSONL header. null/undefined = no tasks set.
	 */
	tasks?: TaskItem[] | null;
	/**
	 * Conversation-kind marker for the hidden-from-flat-list filter (INT-006).
	 * Defaults to `"conversation"` when absent (back-compat). Orchestration step
	 * conversations carry `"orchestration_step_conversation"` so they are excluded
	 * from the flat sidebar (the run-tree, POL-003, is their only surface).
	 *
	 * @see specs/ZZ-misc/orchestration/contracts/edges.md — §1 Conversation Header Extensions
	 */
	_type?: "conversation" | "orchestration_step_conversation";
	/** Format version — stamped at creation, default-on-read for legacy files. */
	schema_version?: number;
	/** Owning orchestration session (`sessions/{id}/`). Step conversations only. */
	orchestration_session_id?: string;
	/** `notor-flow-name` of the running flow. Step conversations only. */
	orchestration_flow_name?: string;
	/** `notor-step-name` of the step that produced this turn. Step conversations only. */
	orchestration_step_name?: string;
	/** The flow iteration (turn number) this conversation represents. Step conversations only. */
	orchestration_iteration?: number;
	/**
	 * Typed adjacency list — the structural source for the run-tree (POL-003).
	 * A tree-constrained DAG (no cyclic / sibling / return edges). In Phase 2 the
	 * executor backfills `next`/`prev` to chain a flow's step conversations;
	 * `child`/`parent` are produced by Phase-7 composition.
	 *
	 * @see specs/ZZ-misc/orchestration/contracts/edges.md — §2 OrchestrationEdge
	 */
	orchestration_edges?: OrchestrationEdge[];
}

/**
 * A typed edge on an orchestration step conversation's header.
 *
 * **Single authority:** specs/ZZ-misc/orchestration/contracts/edges.md §2 — this
 * declaration must remain byte-consistent with it.
 *
 *  - `next` / `prev` chain a flow's step conversations in execution order (no
 *    `session_id` — they never cross a flow boundary).
 *  - `child` links a calling step → a child flow's entry conversation (carries
 *    `session_id`; `via_tool_call_id` only for a `run_flow` tool call).
 *  - `parent` is the back-link from a child entry → its caller's step.
 *
 * A crash-recovery re-run mints new conversation ids, so a pre-crash `next`/`prev`
 * may dangle; consumers render only resolvable edges and skip dangling ones.
 */
export interface OrchestrationEdge {
	kind: "next" | "prev" | "child" | "parent";
	/** The conversation this edge points at. */
	conversation_id: string;
	/** Present on child/parent edges that cross a flow-session boundary. */
	session_id?: string;
	/** Present on child edges originating from a `run_flow` tool call. */
	via_tool_call_id?: string;
}

/** Plan/Act mode. */
export type ConversationMode = "plan" | "act";

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

/** Role of a message within a conversation. */
export type MessageRole = "system" | "user" | "assistant" | "tool_call" | "tool_result" | "extension_block" | "error";

/**
 * Diagnostic detail for a failed turn, persisted so a raw provider error
 * survives into the conversation JSONL (previously errors were UI-only and
 * lost on reload). `offending_fields` lists the request-field keys that may
 * have triggered a rejection (e.g. `thinking`, `output_config`).
 */
export interface MessageError {
	/** Underlying exception name (e.g. "ValidationException", "ProviderError"). */
	name?: string;
	/** Raw provider error message. */
	message: string;
	/** Keys of the request fields that may have caused the rejection. */
	offending_fields?: string[];
}

/** A single message within a conversation. */
export interface Message {
	/** Unique message identifier (UUID v4). */
	id: string;
	/** Parent conversation ID. */
	conversation_id: string;
	/** Message role. */
	role: MessageRole;
	/** Message content — plain text or an array of content blocks (text, image, document). */
	content: string | ContentBlock[];
	/** When the message was created (ISO 8601). */
	timestamp: string;
	/** Input token count for this message (null for non-LLM messages). */
	input_tokens?: number | null;
	/** Output token count for this message (null for non-LLM messages). */
	output_tokens?: number | null;
	/** Estimated cost for this message (null if pricing unavailable). */
	cost_estimate?: number | null;
	/** Thinking/reasoning content from extended thinking (null if disabled). */
	thinking?: string | null;
	/** Elapsed wall-clock time the model spent thinking, in ms (null if none). */
	thinking_duration_ms?: number | null;
	/** Tool call details (for tool_call role only). */
	tool_call?: ToolCall | null;
	/** Tool result details (for tool_result role only). */
	tool_result?: ToolResult | null;
	/** Provider/turn error diagnostics (for `role === "error"` only). */
	error?: MessageError | null;
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
	/**
	 * Extension name that produced this message (`role === "extension_block"` only).
	 *
	 * @see specs/ZZ-misc/extension-chat-blocks-design.md
	 */
	source_extension?: string | null;
	/**
	 * When true, this block is excluded from compaction summarizer input.
	 * The message still survives compaction (re-appended between summary and pending).
	 *
	 * @see specs/ZZ-misc/extension-chat-blocks-design.md
	 */
	exclude_from_compaction?: boolean;
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
	/** Optional media output from tool execution (images, documents). When present, `result` still contains a text summary for fallback. */
	content_blocks?: ContentBlock[];
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
	/**
	 * Shared cross-run rollup block (INT-047 / FR-177), used by **both**
	 * `use_subagent` (single-run totals) and `run_flow` (aggregate-subtree totals).
	 * Generalizes the legacy `sub_agent_metadata` into one block with **one
	 * rendering path** (the inline peek card, POL-003) and **one token-rollup path**
	 * (`src/chat/orchestrator.ts`).
	 *
	 * **Back-compat superset, not a breaking rename.** A `ToolResult` persisted
	 * before INT-047 carries `sub_agent_metadata` with `{ jsonl_filename,
	 * token_usage, iteration_count, stop_reason, profile_name }`; those five fields
	 * stay readable here (`profile_name` is the legacy alias of the generalized
	 * `name`). New fields (`entry_conversation_id`, `session_id`, `cost_usd`,
	 * `depth`, `name`) are optional and simply absent on legacy records. Readers use
	 * {@link readChildRunMetadata} so a record carrying either key parses.
	 *
	 * **Single authority for the shape:** specs/ZZ-misc/orchestration/contracts/edges.md §5.
	 */
	child_run_metadata?: ChildRunMetadata | null;
	/**
	 * Legacy alias of {@link child_run_metadata} (kept readable so already-persisted
	 * `use_subagent` results still parse — INT-047 back-compat). New code writes
	 * {@link child_run_metadata} and reads via {@link readChildRunMetadata}; this
	 * field is a permanent read-compat shim, never written by new code.
	 */
	sub_agent_metadata?: ChildRunMetadata | null;
}

/**
 * The shared `use_subagent` / `run_flow` rollup block (INT-047 / FR-177). For
 * flows the rollup numbers are **aggregate subtree** totals (from the child run's
 * `RunContext.subtreeConsumed`); for sub-agents they are single-run totals.
 *
 * **Single authority:** specs/ZZ-misc/orchestration/contracts/edges.md §5 — this
 * declaration must remain byte-consistent with it.
 */
export interface ChildRunMetadata {
	// --- identity / structure ---
	/** Back-compat: sub-agent conversation filename (relative to history dir). */
	jsonl_filename?: string;
	/** Flow: the child flow's entry conversation id (pairs with the `child` edge). */
	entry_conversation_id?: string;
	/** Flow: the child session id (absent for sub-agents). */
	session_id?: string;

	// --- rollup (AGGREGATE SUBTREE for flows; SINGLE-RUN for sub-agents) ---
	token_usage: { input: number; output: number };
	/** New; per-turn `calculateCost` accumulation over the subtree. */
	cost_usd?: number;
	iteration_count: number;
	/** New; subtree max depth (sub-agents = own depth). */
	depth?: number;

	// --- outcome / label ---
	/** `RunResult.stopReason` / terminal status. */
	stop_reason: string;
	/** Generalized label: flow name (`run_flow`) OR profile name (sub-agent). */
	name?: string;

	// --- back-compat alias (kept readable for persisted sub-agent conversations) ---
	/** Legacy sub-agent label; `name` is the generalized form (read-compat only). */
	profile_name?: string;
}

/**
 * Read the shared {@link ChildRunMetadata} off a `ToolResult`, tolerating the
 * legacy `sub_agent_metadata` key on already-persisted records (INT-047
 * back-compat). Returns `null` when neither is present.
 */
export function readChildRunMetadata(result: ToolResult): ChildRunMetadata | null {
	return result.child_run_metadata ?? result.sub_agent_metadata ?? null;
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
	/** Format version — stamped at creation, default-on-read for legacy files. */
	schema_version: number;
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
	/** Unique instance identifier (immutable after creation). */
	id: string;
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
	/** Whether to use the extended (1M) context window beta for the selected model. */
	use_extended_context?: boolean;
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
// Model Preset
// ---------------------------------------------------------------------------

/**
 * A named model preset mapping a user-facing name to concrete provider+model details.
 *
 * @see specs/ZZ-misc/model-presets-design.md — Section 3.1
 */
export interface ModelPreset {
	/** User-visible name — unique key (e.g., "tiny", "small", "medium", "large", or custom). */
	name: string;
	/** Provider instance ID this preset maps to (null = not yet configured by user). */
	provider_id: string | null;
	/** Model ID this preset maps to (null = not yet configured by user). */
	model_id: string | null;
	/** Whether to use extended context (1M) for this model. */
	use_extended_context: boolean;
	/** Thinking/reasoning level for this preset (null = off/disabled). */
	thinking_level: string | null;
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
	/**
	 * Override preset name (null = use global default). Takes precedence over
	 * preferred_provider/preferred_model when set and the preset is valid.
	 * Parsed from frontmatter key `notor-preferred-preset`.
	 *
	 * @see specs/ZZ-misc/model-presets-design.md — Section 3.4
	 */
	preferred_preset: string | null;
	/** Custom hex colour for the persona chip (null = use accent default). Parsed from `notor-persona-chip-color`. */
	chip_color: string | null;
	/** Custom emoji for the persona chip (null = default 🎭). Parsed from `notor-persona-chip-emoji`. */
	chip_emoji: string | null;
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
 * - `"on-schedule"` — fired on a cron schedule.
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
	| "on-schedule";

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
	"on-schedule",
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
	action_type: "execute_command" | "run_workflow" | "run_orchestration";
	/** Shell command (required when action_type is "execute_command"). */
	command: string | null;
	/** Vault-relative workflow path (required when action_type is "run_workflow"). */
	workflow_path: string | null;
	/**
	 * Orchestration flow name or flow-directory path (required when action_type
	 * is "run_orchestration"; gated on `orchestration_enabled`, FR-119b).
	 */
	orchestration_flow?: string | null;
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
	/** Alternative names from the standard Obsidian `aliases` frontmatter property. */
	aliases: string[];
	/** Trigger type from `notor-trigger` frontmatter. */
	trigger: WorkflowTrigger;
	/** Cron expression from `notor-schedule` (required when trigger is `"on-schedule"`). */
	schedule: string | null;
	/** Persona to activate from `notor-workflow-persona` (null = use current persona). */
	persona_name: string | null;
	/** Per-workflow conversation mode override from `notor-conversation-mode` (null = inherit). */
	mode: ConversationMode | null;
	/** Per-workflow model preset override from `notor-model-preset` (null = use active/default). */
	model_preset: string | null;
	/** Per-workflow thinking level override from `notor-thinking-level` (null = use preset). */
	thinking_level: string | null;
	/** Per-workflow hook delay from `notor-hook-delay` in ms (null = no delay preference). */
	hook_delay: number | null;
	/** Per-workflow LLM lifecycle hook overrides from `notor-hooks`. */
	hooks: WorkflowHookConfig | null;
	/** Template string from `notor-active-note-prompt` frontmatter (null if not set). Contains `{active_note}` placeholder. */
	active_note_prompt: string | null;
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
// Vault Event Hooks (Group F)
// ---------------------------------------------------------------------------

/**
 * Vault event types that can trigger hooks or workflows.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-001
 */
export type VaultEventHookType =
	| "on_note_open"
	| "on_note_create"
	| "on_save"
	| "on_manual_save"
	| "on_tag_change"
	| "on_schedule";

/**
 * A single vault event hook — an action tied to a vault event type.
 *
 * @see specs/03-workflows-personas/data-model.md — VaultEventHook entity
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-001
 */
export interface VaultEventHook {
	/** Unique identifier (UUID v4). */
	id: string;
	/** The vault event type that triggers this hook. */
	event: VaultEventHookType;
	/** Action to perform when the hook fires. */
	action_type: "execute_command" | "run_workflow" | "run_orchestration";
	/** Shell command to execute (required when action_type is "execute_command"). */
	command: string | null;
	/** Vault-relative workflow path (required when action_type is "run_workflow"). */
	workflow_path: string | null;
	/**
	 * Orchestration flow name or flow-directory path (required when action_type
	 * is "run_orchestration"; gated on `orchestration_enabled`, FR-119b).
	 */
	orchestration_flow?: string | null;
	/** Human-readable label (optional; falls back to command or workflow_path). */
	label: string;
	/** Whether this hook is active. */
	enabled: boolean;
	/** Cron expression (required when event is "on_schedule"). */
	schedule: string | null;
	/** Delay in ms before executing this hook after the event fires (null = inherit from workflow, 0 = immediate, >0 = override). Acts as debounce. */
	delay_ms: number | null;
}

/**
 * Ordered lists of vault event hooks grouped by event type.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-001
 */
export interface VaultEventHookConfig {
	on_note_open: VaultEventHook[];
	on_note_create: VaultEventHook[];
	on_save: VaultEventHook[];
	on_manual_save: VaultEventHook[];
	on_tag_change: VaultEventHook[];
	on_schedule: VaultEventHook[];
}

/**
 * Status of a background workflow execution.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-001
 */
export type WorkflowExecutionStatus =
	| "queued"
	| "running"
	| "waiting_approval"
	| "completed"
	| "errored"
	| "stopped";

/**
 * Tracks the state of a single background (event-triggered) workflow execution.
 *
 * In-memory only — not persisted across plugin reloads.
 *
 * @see specs/03-workflows-personas/data-model.md — WorkflowExecution entity
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-001
 */
export interface WorkflowExecution {
	/** Unique execution identifier (UUID v4). */
	id: string;
	/** Vault-relative path of the workflow note being executed. */
	workflow_path: string;
	/** Display name of the workflow (e.g. `"daily/review"`). */
	workflow_name: string;
	/** ID of the background conversation created for this execution. */
	conversation_id: string;
	/** The vault event type that triggered this execution. */
	trigger_event: string;
	/** Vault-relative path of the note that caused the trigger (null for scheduled). */
	trigger_source: string | null;
	/** Current execution status. */
	status: WorkflowExecutionStatus;
	/** When the execution started (ISO 8601). */
	started_at: string;
	/** When the execution completed (ISO 8601), or null if still running. */
	completed_at: string | null;
	/** Error message if status is "errored". */
	error_message: string | null;
}

/**
 * Tracks the chain of hook events that have fired within a single execution
 * context, used to detect and prevent infinite hook-to-workflow loops.
 *
 * Carried through the background workflow execution pipeline.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-001
 */
export interface ExecutionChain {
	/** Set of hook event types that have fired in this chain (loop detection). */
	sourceHooks: Set<string>;
	/** Set of note paths created or modified by hook-initiated workflows (create-loop prevention). */
	modifiedNotePaths: Set<string>;
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
	/** MD5 hash of body content (after frontmatter). Computed lazily on first mismatch. */
	body_hash?: string;
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
	/** The event type that triggered the workflow (e.g. `"on-save"`, `"on-schedule"`). */
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
	/**
	 * Tool configs extracted from `<notor_tool_config>` blocks in the workflow body.
	 * Empty array if no config blocks were found.
	 *
	 * @see specs/04b-tool-toggle/tasks.md — WF-001
	 */
	toolConfigs: import("./tool-config/types").ParsedToolConfig[];
}
