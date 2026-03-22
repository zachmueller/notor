# Phase 4b — `<notor_tool_config>` XML Tag System

**Created:** 2026-03-15
**Status:** Draft
**Branch:** 04b-tool-toggle

## Overview

Phase 4b introduces a `<notor_tool_config>` XML tag that allows users to configure per-tool settings directly inside the Markdown files that drive Notor's behavior — persona system prompts, workflow notes, and vault rule files. This is the canonical mechanism for per-persona and per-workflow tool configuration, keeping tool config co-located with the persona or workflow definition it belongs to.

When Notor ingests any of these source files (at system prompt assembly time or workflow execution time), it:

1. Scans for `<notor_tool_config>` blocks
2. Parses the YAML inside them
3. Applies the resulting configuration to the current conversation
4. **Strips the tag and its contents entirely from the text before it is sent to the LLM**

The LLM never sees the config block — it only experiences the downstream effects (which tools are available, which are auto-approved, what paths are permitted).

This specification covers:

- **Tag syntax and YAML schema**: the `<notor_tool_config>` tag format, supported fields, versioning, and multi-block merge rules.
- **Supported contexts**: which source file types support the tag (persona system prompts, workflow notes, rule files).
- **Configuration hierarchy and precedence**: how configs from multiple active sources are merged.
- **Parsing and extraction pipeline**: how tags are extracted and stripped during source file ingestion.
- **Validation**: error handling for malformed YAML, unrecognized tool names, and invalid field values.
- **Settings UI changes**: a new "Copy tool config YAML" helper button and a new Settings → Personas section.
- **Effective Config Inspector**: a dedicated UI for inspecting the merged effective tool config, both before and during conversations.

The per-persona auto-approve overrides introduced in Phase 4 (`persona_auto_approve`) are **removed** in this phase. The `<notor_tool_config>` `auto_approve` field in persona notes fully replaces the settings-UI-based per-persona auto-approve mechanism. The Settings-backed `persona_tool_enabled` structure previously proposed for Phase 4b is also replaced entirely by the `<notor_tool_config>` tag mechanism.

## Clarifications

### Session 2026-03-22

- Q: Can multiple workflows be active simultaneously, and if so which takes precedence within the workflow layer? → A: Only one workflow can be active at a time; invoking a second workflow replaces the first.
- Q: When a workflow ends mid-conversation, how does the tool config revert — recompute from active sources or restore a snapshot? → A: Workflows do not end mid-conversation; a workflow remains active for the duration of the conversation thread. The only way to clear the active workflow is to start a new conversation (or invoke a different workflow, which replaces it).
- Q: Do MCP tools support `allowed_paths`/`blocked_paths` enforcement, or `enabled`/`auto_approve` only? → A: MCP tools support `enabled` and `auto_approve` only. Specifying `allowed_paths` or `blocked_paths` for an MCP tool emits a Notice indicating the fields are not yet implemented for MCP tools. Path enforcement for MCP tools is deferred to a future phase.
- Q: How does the pre-flight inspector evaluate rule trigger conditions without a real conversation? → A: Pre-flight mode is deferred to a future iteration. The MVP inspector operates in live-in-chat mode only, reading the effective tool config directly from the orchestrator during active conversations. This sidesteps the `tag_include` evaluation limitation entirely (see RT-4 Risk 9).
- Q: If a rule activates mid-conversation (trigger keyword appears in a later message), should the EffectiveToolConfig be recomputed per-message to reflect rule changes, or remain static for the conversation duration? → A: Recompute per-message. The EffectiveToolConfig is recomputed before each LLM call, picking up rule activation/deactivation changes dynamically. This matches FR-79's "applies whenever the rule is active" contract and aligns with how rules already work for prompt content.
- Q: How should Phase 4's `persona_auto_approve` be incorporated into the merger so it isn't bypassed by the merger's default fill for tools not configured in any `<notor_tool_config>` block? → A: ~~Pass both `globalAutoApprove` and `personaAutoApprove` to `mergeToolConfigs()`.~~ **Superseded:** `persona_auto_approve` is removed entirely in this phase. The merge default fill order simplifies to: `globalAutoApprove[toolName] ?? false`. See clarification below.
- Q: Should Phase 4's `persona_auto_approve` (settings UI) be kept alongside `<notor_tool_config>`? → A: No. `persona_auto_approve` is removed entirely in this phase. The `<notor_tool_config>` `auto_approve` field in persona notes is the sole mechanism for per-persona auto-approve configuration. No migration is needed (no existing users rely on the settings UI overrides). This simplifies the merger signature (removes the `personaAutoApprove` parameter) and eliminates RT-5 Risk 1 (three-state type conversion).
- Q: What structure should hold parsed tool config metadata for the live inspector's source attribution? → A: Flat private fields on `ChatOrchestrator` (`activeParsedConfigs: ParsedToolConfig[]` and `effectiveToolConfig: EffectiveToolConfig | null`), updated whenever EffectiveToolConfig is recomputed and cleared on conversation end. The inspector reads these via getter methods on the orchestrator. The `Conversation` interface is not modified — these are fully derived runtime values reconstructable from persona/rule/workflow sources on any conversation reload.

## User stories

### Persona-scoped tool configuration

- As a user, I want to configure which tools are available to a persona by editing that persona's system prompt note, so the persona definition is fully self-contained.
- As a user, I want a "researcher" persona to have only read-only tools enabled, so it cannot modify my vault.
- As a user, I want a "writer" persona to have all write tools enabled while a "read-only" persona has them disabled, giving each persona a tailored capability set.
- As a user, I want to share a persona folder with someone and have its tool configuration travel with it, without needing to export any plugin settings.

### Workflow-scoped tool configuration

- As a power user, I want a workflow note to declare exactly which tools it needs, so the AI operates with only the capabilities relevant to that workflow.
- As a user, I want a workflow to be able to disable `execute_command` for its duration, so I can run it safely without the AI having shell access.
- As a user, I want per-workflow tool config to take precedence over my persona's config, so workflows can further restrict or extend capabilities as needed.

### Path restrictions

- As a user, I want a persona to restrict `write_note` to a specific folder, so the AI can only create notes in approved locations.
- As a user, I want to block a tool from accessing a specific path even if I otherwise allow it, so sensitive vault areas remain protected.

### Rule-driven constraints

- As a user, I want a vault rule file to disable `execute_command` whenever a certain rule is active, so I can enforce safety constraints without persona-specific configuration.

### Settings and discoverability

- As a user, I want a helper button that generates a starter `<notor_tool_config>` snippet from my current settings, so I can quickly bootstrap persona config without writing YAML from scratch.
- As a user, I want a Settings → Personas section that lists my configured personas and lets me open their system prompt notes directly.

### Transparency and diagnostics

- As a user, I want to inspect the merged effective tool config before starting a conversation, so I know exactly what capabilities the AI will have.
- As a user, I want to inspect the live effective tool config during a conversation and see which source note is driving each setting, so I can diagnose unexpected tool behavior.

## Functional requirements

### FR-78: `<notor_tool_config>` tag syntax and YAML schema

**Description:** The `<notor_tool_config>` tag is an XML-style block with a YAML body. It may appear in persona system prompt notes, workflow notes, and vault rule files. The tag and its contents are stripped from source content before it is sent to the LLM.

**Acceptance criteria:**
- The tag uses opening and closing delimiters (not self-closing): `<notor_tool_config ...>...</notor_tool_config>`.
- The opening tag accepts an optional `version` attribute specifying the schema version (e.g., `version="1.0"`). The `version` attribute is optional; when absent, the plugin parses using the latest available parser version with no warning.
- The YAML body contains one top-level key per tool being configured. Only tools explicitly listed are affected; unlisted tools inherit from lower levels in the hierarchy.
- Multiple `<notor_tool_config>` blocks per file are allowed. They are parsed and merged in document order; for the same field of the same tool, the last occurrence within a single file wins.
- A single block may configure any number of tools.
- The supported YAML fields per tool entry are:

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | Whether the tool is included in the LLM's tool list |
| `auto_approve` | boolean | Whether tool calls are auto-approved without user confirmation (no effect when `enabled` is `false`) |
| `allowed_paths` | string[] | Path prefixes the tool is permitted to operate on (empty = no restriction) |
| `blocked_paths` | string[] | Path prefixes explicitly forbidden; takes precedence over `allowed_paths` (empty = no blocked paths) |

**Example:**
```xml
<notor_tool_config version="1.0">
write_note:
  enabled: true
  auto_approve: false
  allowed_paths:
    - "Projects/"
    - "Research/"
  blocked_paths:
    - "Research/Private/"
execute_command:
  enabled: false
</notor_tool_config>
```

### FR-79: Supported contexts

**Description:** The `<notor_tool_config>` tag is supported in the same file types that support `<include_note>`.

**Acceptance criteria:**
- The tag is supported in: persona system prompt notes (`system-prompt.md`), workflow note bodies, and vault rule files (`notor/rules/*.md`).
- When present in a persona system prompt, the config applies for the full duration of any conversation using that persona.
- When present in a workflow note, the config applies only for the duration of that workflow execution.
- When present in a rule file, the config applies whenever the rule is active (same trigger conditions as the rule itself).
- In all cases, the tag is extracted and stripped before the file's content is sent to the LLM.

### FR-80: Configuration hierarchy and precedence

**Description:** When the same tool is configured at multiple levels simultaneously, configs are merged using a defined precedence order, with higher-priority levels overriding lower ones on a field-by-field basis.

**Acceptance criteria:**
- The precedence order is (highest first): `workflow > persona > rule > global defaults`.
- Only one workflow may be active at a time. Invoking a second workflow while one is already active replaces the first workflow's config entirely — there is no stacking of multiple workflow configs.
- A workflow remains active for the full duration of the conversation thread. Workflows do not expire or revert mid-conversation. The workflow layer is cleared only when a new conversation starts, or when a new workflow is invoked (replacing the current one).
- Merging is field-by-field (sparse): a field omitted at a higher-priority level does not override a value set at a lower-priority level.
- The global defaults layer is the base of the hierarchy:
  - For `enabled`: hardcoded as all tools enabled. There is no Settings UI to change global tool enabled state — the `<notor_tool_config>` tag is the only mechanism.
  - For `auto_approve`: the per-tool auto-approve toggles in **Settings → Tools & permissions** are the global defaults for built-in tools. For MCP tools, per-server `McpServerConfig.autoApprove[]` lists are pre-flattened into the same `globalAutoApprove` map (keyed by namespaced `server__tool` name) before the merge runs — this ensures MCP server-level auto-approve settings are preserved when `effectiveToolConfig` is active and the dispatcher's `resolveMcpAutoApprove()` path is bypassed. The `globalAutoApprove` map is rebuilt per-iteration inside `resolveEffectiveConfig()` by reading `settings.auto_approve` and `settings.mcp_servers` at call time — it is not a static injected map. This ensures changes to MCP server `autoApprove[]` lists (e.g., new server connections, settings reloads) are always reflected without requiring an explicit rebuild trigger. Disabled servers (`config.disabled === true`) may be skipped when expanding `autoApprove[]` lists, since their tools are never registered; including them is functionally harmless (unused keys are ignored by the merger's default fill, which only fills entries for tools in `allToolNames`). The merge default fill order is: `globalAutoApprove[toolName]` (includes both built-in and MCP server-level defaults) → `false`. (Phase 4's `persona_auto_approve` settings UI mechanism is removed in this phase — see clarifications.)
- `allowed_paths` and `blocked_paths` use **replace semantics**: the highest-priority level that specifies the field replaces all lower-level values entirely (no merging of path lists).
- When `effectiveToolConfig` is active, the dispatcher uses the merged `auto_approve` value from `effectiveToolConfig.tools[toolName]` as a unified early-return **before** its existing MCP/built-in auto-approve branching logic (`resolveMcpAutoApprove()` / `resolveAutoApprove()`). Neither branch is consulted when the effective config provides a value. The existing branching remains as the fallback when `effectiveToolConfig` is null.
- `blocked_paths` always takes precedence over `allowed_paths` within the same effective config level: if a path matches both lists, the blocked effect wins.
- **Example:** With global default `write_note` enabled and not auto-approved; a rule setting `auto_approve: true`; a persona setting `allowed_paths: ["Projects/"]`; and a workflow setting `enabled: false` — the effective config during that workflow is: `enabled: false` (workflow), `auto_approve: true` (rule), `allowed_paths: ["Projects/"]` (persona), no blocked paths.

### FR-81: Parsing and extraction pipeline

**Description:** `<notor_tool_config>` blocks are extracted and stripped as part of the source file ingestion pipeline, after `<include_note>` resolution.

**Acceptance criteria:**
- `<include_note>` tags are resolved **first**, then `<notor_tool_config>` blocks are extracted and stripped. This ordering allows a shared note containing a `<notor_tool_config>` block to be pulled into multiple persona or workflow notes via `<include_note>`.
- `<include_note>` tags appearing *inside* a `<notor_tool_config>` block are explicitly unsupported and result in YAML parse errors or unexpected behavior (no special handling required).
- The extraction regex captures the full opening tag (for attribute extraction) and the inner YAML body: `/^<notor_tool_config([^>]*)>([\s\S]*?)<\/notor_tool_config>/gm`. The `^` anchor (with the `m` flag) restricts matching to line-boundary occurrences, which matches the block-level authoring contract and eliminates a pathological slowdown when content contains many inline `<notor_tool_config>` occurrences (e.g., in code examples).
- For each matched block, the plugin:
  1. Parses the `version` attribute from the opening tag.
  2. If `version` major is unrecognized (higher than the maximum supported) → emits a console warning and skips the block.
  3. Otherwise → parses the inner body as YAML. If the result is `null`, `undefined`, not a plain object, or an array (non-throwing non-object returns from `parseYAML`) → adds a structured validation error and skips the block.
  4. Validates the parsed structure (per FR-82). Validation errors are collected as structured `ToolConfigValidationError` data (not emitted as Notices by the parser).
  5. Stores the parsed config alongside its source context (`persona` / `workflow` / `rule`) and document position for within-file merge ordering.
- The parser returns structured validation errors alongside the parsed configs and stripped content. The parser module has no Obsidian dependency — it is a pure data-processing layer. Callers (e.g., `SystemPromptBuilder`, `WorkflowExecutor`) are responsible for iterating the returned errors and emitting Obsidian Notices via a shared `showToolConfigError()` helper.
- Each full tag (opening tag + body + closing tag) is replaced with an empty string in the content passed downstream to the LLM.
- After all source files are processed, the precedence merge runs to produce the `EffectiveToolConfig` for this message.
- The `EffectiveToolConfig` is recomputed before each LLM call (to reflect dynamic rule activation/deactivation), applied to the tool registry and dispatcher, and reverted to global defaults when the conversation ends. To resolve the circular dependency between config extraction (which produces tool configs) and tool definition filtering (which needs the merged config), the `SystemPromptBuilder` exposes a two-phase API: (1) `extractSourceToolConfigs()` resolves `<include_note>` tags, extracts `<notor_tool_config>` blocks from persona and rule sources, and caches stripped content internally; (2) `assemble()` builds the prompt using cached stripped content and the now-available filtered tool definitions. The orchestrator calls phase 1, runs the precedence merge, computes filtered tool definitions, then calls phase 2. The filtered tool definitions (reflecting enabled/disabled state) are computed fresh inside the response loop on each iteration (not captured once at loop entry) and passed to both system prompt assembly (so the prompt only documents available tools) and the provider call (the actual tool list sent to the LLM). Callers of the response loop do not pass or pre-compute tool definitions. This applies equally to both the foreground `responseLoop()` and the background `_backgroundResponseLoop()` used for background workflow execution — both paths compute `resolveEffectiveConfig()` per-iteration and use the workflow's `toolConfigs` from its `WorkflowAssemblyResult`.
- The active `ParsedToolConfig[]` contributing to the current `EffectiveToolConfig` are stored as flat private fields on `ChatOrchestrator` (`activeParsedConfigs` and `effectiveToolConfig`), updated on each recomputation and cleared on conversation end. Cleanup is performed in `orchestrator.newConversation()` — the single site for conversation-end tool config state cleanup. `newConversation()` clears `activeParsedConfigs`, `effectiveToolConfig`, and calls `dispatcher.setEffectiveToolConfig(null)` to revert the dispatcher to global defaults. The live inspector reads these via getter methods on the orchestrator.

### FR-82: Validation and error reporting

**Description:** Invalid YAML or unrecognized fields should not crash the plugin. All validation errors are reported to the user with enough context to locate and fix the source. The parser itself is a pure data-processing module with no Obsidian dependency — it returns validation errors as structured data (`ToolConfigValidationError[]`). Callers are responsible for surfacing these errors as Obsidian Notices via the shared `showToolConfigError()` helper.

**Acceptance criteria:**
- YAML parse failure → parser records a structured error; caller emits an Obsidian Notice with the source file name; skips the block.
- Unrecognized top-level key (tool name not in the registry) → parser records a structured error; caller emits Notice stating the tool name was not found; skips that tool entry. Processing continues for the rest of the block.
- Unrecognized field within a tool entry (e.g., `auto_aprove` typo) → error recorded; caller emits Notice; skips that field.
- `enabled` not a boolean → error recorded; caller emits Notice; skips that field.
- `auto_approve` not a boolean → error recorded; caller emits Notice; skips that field.
- `allowed_paths` not an array of strings → error recorded; caller emits Notice; skips that field.
- `blocked_paths` not an array of strings → error recorded; caller emits Notice; skips that field.
- `allowed_paths` or `blocked_paths` specified for an MCP tool → error recorded; caller emits Notice stating that path enforcement for MCP tools is not yet implemented; skips those fields. The tool's `enabled` and `auto_approve` values (if present) are still applied.
- All Obsidian Notices for validation errors must:
  - Identify the source file by name.
  - Include the text "right-click to jump to note" so users know they can navigate directly to the source.
  - Trigger a jump to the relevant note when right-clicked.

> **RT-3 resolved** — see [`research/RT-3-notice-right-click.md`](research/RT-3-notice-right-click.md).
>
> The `Notice` class exposes a `noticeEl: HTMLElement` property. BRAT attaches a plain DOM `oncontextmenu` handler to it: `notice.noticeEl.oncontextmenu = () => callback()`. No private API is involved. For Notor the callback calls `app.workspace.openLinkText(sourceFile, "", false)` to navigate to the source note. The jump hint and handler must be gated on `Platform.isDesktop` (imported from `obsidian`) since right-click has no mobile equivalent.

### FR-83: Dispatcher blocking for disabled tools

**Description:** If the LLM generates a tool call for a tool that is disabled in the effective config, the dispatcher blocks execution and returns a clear error result.

**Acceptance criteria:**
- The dispatcher checks each tool call against the effective `enabled` state before proceeding to Plan/Act mode checks or any other validation.
- If the tool is disabled, the tool call status is set to `"error"`, the `onToolCallStatusChanged` event is emitted, and a `ToolResult` is returned with:
  - `success: false`
  - `error: "Tool '{toolName}' is disabled and cannot be used in this context."`
- A disabled tool is never executed regardless of auto-approve settings or any other state.
- Log entry emitted at `info` level: "Blocked disabled tool" with `toolName`.

### FR-84: `allowed_paths` and `blocked_paths` enforcement

**Description:** When the effective tool config specifies `allowed_paths` or `blocked_paths` for a tool, the dispatcher enforces these constraints at dispatch time by inspecting the tool call's path arguments.

**Acceptance criteria:**
- Before executing a tool call (after the enabled check, FR-83), the dispatcher inspects the tool's path-related arguments against the effective `allowed_paths` and `blocked_paths`.
- If a path argument does not match any prefix in `allowed_paths` (when `allowed_paths` is non-empty) → tool call is blocked; `ToolResult` returned with `success: false` and an error message identifying the blocked path.
- If a path argument matches any prefix in `blocked_paths` → tool call is blocked; `ToolResult` returned with `success: false` and an error message identifying the blocked path.
- `blocked_paths` enforcement takes precedence over `allowed_paths`: a path matching both is blocked.
- When `allowed_paths` is empty, no path allowlist restriction applies for that tool.
- When `blocked_paths` is empty, no path blocklist restriction applies for that tool.

> **RT-1 resolved** — see [`research/RT-1-path-argument-inspection.md`](research/RT-1-path-argument-inspection.md).
>
> `allowed_paths` and `blocked_paths` enforcement applies to **built-in tools only**. MCP tools are exempt from path enforcement in this phase (path control for MCP tools is deferred; specifying these fields for an MCP tool emits a Notice — see FR-82). All 13 built-in tools fall into three groups: (1) vault-namespace tools with a `path` param (vault-relative string prefix matching), (2) filesystem-namespace tools — `read_file`, `read_docx`, `write_docx`, `execute_command` — where `write_docx` has two path params (`output_path` and `template_path`) and `execute_command` uses `working_directory`, both requiring absolute-path comparison via the existing `resolveAndValidatePath` / `isPathWithin` utilities, and (3) `fetch_webpage`, which has no path param and is exempt from `allowed_paths` / `blocked_paths` enforcement. A static `TOOL_PATH_PARAMS` descriptor table in the dispatcher maps each tool name to its path parameter names and namespace.

### FR-85: Tag versioning

**Description:** The `version` attribute on the `<notor_tool_config>` opening tag communicates which schema version the YAML body uses, enabling forward compatibility.

**Acceptance criteria:**
- The version format is `MAJOR.MINOR`. Minor bumps (e.g., `1.0` → `1.1`) are cosmetic and do not affect parse logic. Major bumps indicate a schema change requiring different parsing behavior.
- `version` is optional. When absent, the plugin parses using the latest available parser version with no warning — omitting `version` is a valid authoring pattern.
- If the plugin encounters a major version number it does not recognize (higher than its maximum supported major version), it skips the block entirely and emits a console warning.
- Version `1.0` is the schema defined by this specification.
- The "Copy tool config YAML" helper button (FR-86) always includes the `version` attribute in its generated output.

### FR-86: "Copy tool config YAML" helper button

**Description:** A new button in **Settings → Tools & permissions** generates a starter `<notor_tool_config>` snippet to help users bootstrap persona or workflow config.

**Acceptance criteria:**
- A "Copy tool config YAML" button appears in **Settings → Tools & permissions**.
- When clicked, the button generates a `<notor_tool_config>` snippet containing only the tools whose current auto-approve settings **differ from global defaults** — not a full scaffold of every registered tool. This reinforces the sparse configuration model.
- A comment at the top of the generated block notes that unlisted tools inherit global defaults.
- The generated snippet is copied to the clipboard.
- **Example output** (assuming only `execute_command` has auto-approve enabled, differing from the default `false`):
```xml
<notor_tool_config version="1.0">
# Only tools that differ from global defaults are listed.
# Unlisted tools inherit their settings from global defaults.
execute_command:
  auto_approve: true
</notor_tool_config>
```

### FR-87: Settings → Personas section

**Description:** A new top-level **Settings → Personas** section provides a central entry point for discovering and managing personas configured in the vault.

**Acceptance criteria:**
- A new **Settings → Personas** section is introduced at the top level of Notor plugin settings.
- The section contains a **Create new persona** button. When clicked, it prompts the user for a persona name, then creates a skeleton `system-prompt.md` note at `<notor-top-level-dir>/personas/<persona-name>/system-prompt.md` upon confirmation. The skeleton includes a placeholder `<notor_tool_config>` block.
- The section contains an **Existing personas list** showing all personas detected in the vault, each with the persona name and a link/button to open its `system-prompt.md` note directly in the editor.
- The list is populated by scanning `<notor-top-level-dir>/personas/` at settings UI open time. It refreshes each time the settings panel is opened but does not live-update while open.
- This section does not replicate tool configuration controls — tool enabled/disabled state is managed entirely within persona files via `<notor_tool_config>` tags.

### FR-88: Effective Config Inspector

**Description:** A standalone leaf view for inspecting the merged effective tool config during a live conversation.

**Acceptance criteria:**
- The inspector is a standalone leaf view that can be opened alongside the Notor chat panel via a button in the chat panel or a command palette action.
- **Live in-chat mode:** the inspector can be opened at any point during a real conversation. Each field shows its current effective value and a source link to the specific note driving it, making it easy to diagnose unexpected tool behavior mid-conversation.
- **Runtime tool config state:** the parsed tool config contributed by each source file is stored as flat private fields on `ChatOrchestrator` (`activeParsedConfigs: ParsedToolConfig[]` and `effectiveToolConfig: EffectiveToolConfig | null`), updated each time the `EffectiveToolConfig` is recomputed and cleared on conversation end via `orchestrator.newConversation()`. The live inspector reads these via getter methods on the orchestrator, correctly reflecting the full accumulated state even as additional tool configs are ingested mid-conversation (e.g., when a workflow is invoked after conversation start, or when rules activate/deactivate). These are fully derived runtime values — they are not persisted to the JSONL conversation history and are reconstructed from persona/rule/workflow sources when a conversation is reopened.
- **Critical:** the inspector is built on top of the shared functions used during real prompt assembly: tool config parsing, precedence merging, and effective config resolution. No inspector-specific logic duplicates any part of this pipeline. Any change to resolution behavior automatically reflects in the inspector.
- **Deferred:** pre-flight mode (selecting a persona/workflow before starting a conversation to preview the merged config) is planned for a future iteration.

## Non-functional requirements

### NFR-22: Performance

**Description:** `<notor_tool_config>` parsing and merging add negligible overhead to message processing and source file ingestion.

**Acceptance criteria:**
- Parsing is O(n) where n = total character length of source files being ingested. The regex scan and YAML parse complete synchronously and add no async overhead to the ingestion pipeline.
- The precedence merge is O(t × l) where t = number of configured tools and l = number of active config levels (typically ≤ 4). No async operations or vault reads are required.
- No perceptible latency increase on message send or workflow execution.
- When no `<notor_tool_config>` blocks are present in any active source file, the extraction pass returns immediately and behavior is identical to the pre-feature baseline.

### NFR-23: Portability and self-containment

**Description:** Personas and workflows that use `<notor_tool_config>` tags are fully self-contained and portable — no plugin settings export or import is required to transfer them between vaults.

**Acceptance criteria:**
- A persona folder containing a `system-prompt.md` with a `<notor_tool_config>` block can be copied to another vault running Notor and the tool configuration takes effect without any additional settings changes.
- Workflow notes with `<notor_tool_config>` blocks are similarly portable.
- No tool configuration state derived from `<notor_tool_config>` is stored in `data.json`. The tag is the sole source of truth for this configuration.

### NFR-24: Robustness and graceful degradation

**Description:** Malformed or unrecognized `<notor_tool_config>` blocks degrade gracefully without crashing the plugin or silently misconfiguring the tool set.

**Acceptance criteria:**
- A YAML parse error in a `<notor_tool_config>` block causes the block to be skipped entirely with a user-visible Notice (FR-82). All other source file content and any other valid `<notor_tool_config>` blocks continue to be processed normally.
- An unrecognized tool name or field causes only that entry or field to be skipped — the rest of the block is still applied.
- An unrecognized major `version` causes the whole block to be skipped with a console warning, but does not affect other blocks or source files.
- Under no error condition does the plugin fall into an unrecoverable state or crash Obsidian.

### NFR-25: Inspector fidelity

**Description:** The Effective Config Inspector (FR-88) must always reflect the true effective tool config computed by the real resolution pipeline.

**Acceptance criteria:**
- The inspector is built entirely on top of the shared functions used during real prompt assembly: `<notor_tool_config>` parsing, precedence merging, and `EffectiveToolConfig` resolution. No inspector-specific logic duplicates any part of this pipeline.
- Any change to resolution behavior automatically reflects in the inspector without separate inspector-side updates.
- The inspector's source attribution (which note drives each field) is derived directly from the structured `ParsedToolConfig` objects produced during ingestion, not reconstructed separately.

## User scenarios & testing

### Primary flow: Persona with restricted write access

1. User edits their "researcher" persona's `system-prompt.md` and adds a `<notor_tool_config>` block disabling `write_note`, `replace_in_note`, `update_frontmatter`, `manage_tags`, and `execute_command`.
2. User activates the "researcher" persona in the chat panel.
3. The AI's tool set now contains only the read-only tools: `read_note`, `search_vault`, `list_vault`, `read_frontmatter`, `fetch_webpage`.
4. User switches to the default (no persona) state. All tools are available again.

### Primary flow: Workflow with path restrictions

1. User creates a workflow note containing a `<notor_tool_config>` block setting `write_note` with `allowed_paths: ["Projects/Active/"]`.
2. User invokes the workflow. During execution, `write_note` is restricted to `Projects/Active/`.
3. The AI attempts to write a note to `Archive/` — the dispatcher blocks the call and returns a path-blocked error.
4. The path restrictions remain active for the rest of the conversation. They are lifted only when a new conversation starts or a different workflow is invoked.

### Primary flow: Bootstrapping a persona config with the helper button

1. User opens **Settings → Tools & permissions** and clicks "Copy tool config YAML".
2. A `<notor_tool_config>` snippet is copied to the clipboard, listing only the tools that differ from global defaults.
3. User opens their persona's `system-prompt.md`, pastes the snippet, and adjusts the values as needed.

### Primary flow: Creating a new persona from Settings

1. User opens **Settings → Personas** and clicks "Create new persona".
2. User enters the name "analyst". Notor creates `notor/personas/analyst/system-prompt.md` with a skeleton including a placeholder `<notor_tool_config>` block.
3. The new persona appears in the existing personas list with an "Open system prompt" link.

### Alternative flow: LLM calls a disabled tool

1. User has `execute_command` disabled in their active persona's `<notor_tool_config>` block.
2. The LLM generates an `execute_command` tool call.
3. The dispatcher catches the call: tool call status set to `"error"`, error result returned: "Tool 'execute_command' is disabled and cannot be used in this context."
4. The LLM acknowledges it cannot run the command and adjusts its response.

### Alternative flow: Malformed YAML in a config block

1. User makes a YAML indentation error in their persona's `<notor_tool_config>` block.
2. On the next message, the ingestion pipeline encounters the YAML parse error.
3. An Obsidian Notice appears: "[persona system-prompt.md] notor_tool_config block could not be parsed — right-click to jump to note."
4. The block is skipped; the rest of the persona's system prompt is sent to the LLM normally. The tool set falls back to global defaults for any tools that block would have configured.
5. User right-clicks the Notice, is navigated to the system prompt note, and fixes the YAML error.

### Alternative flow: Unrecognized tool name

1. User's `<notor_tool_config>` block references `my-mcp-server__search`, but the tool is not currently registered (e.g., the MCP server is disabled).
2. An Obsidian Notice appears: "[workflow.md] notor_tool_config: Tool 'my-mcp-server__search' not found. Right-click to jump to note."
3. That tool entry is skipped; the rest of the block is applied normally.

### Alternative flow: Unrecognized major version

1. User copies a `<notor_tool_config version="2.0">` block from a future version of Notor into their current vault.
2. The plugin's maximum supported major version is `1`. A console warning is emitted: "Skipping notor_tool_config block with unsupported version '2.0' in [file]."
3. The block is skipped entirely; no tool configuration from it is applied.

### Alternative flow: Pre-flight inspection (deferred)

> **Deferred to a future iteration.** The MVP inspector supports live-in-chat mode only. The following scenario describes planned future behavior.

1. User opens the Effective Config Inspector before starting a conversation.
2. User selects the "researcher" persona and the "daily-review" workflow.
3. The inspector shows the merged effective config: `write_note` disabled (from persona), `execute_command` disabled (from workflow), all other tools at global defaults.
4. User sees source links pointing to `personas/researcher/system-prompt.md` and `workflows/daily-review.md` for the relevant fields.

### Edge case: Shared config via `<include_note>`

1. User creates a shared note `notor/shared/safety-config.md` containing a `<notor_tool_config>` block that disables `execute_command`.
2. Two persona system prompt notes each include `<include_note path="notor/shared/safety-config.md" />`.
3. During ingestion, `<include_note>` is resolved first, embedding the shared config in each persona's content. `<notor_tool_config>` extraction then finds and processes the embedded block as if it were authored directly in the persona note.

### Edge case: `<include_note>` inside a `<notor_tool_config>` block

1. User attempts to use `<include_note>` inside a `<notor_tool_config>` YAML body.
2. Since `<include_note>` resolution runs before `<notor_tool_config>` extraction, the `<include_note>` tag is not present in the source at extraction time (it was already resolved) — or if the tag appears literally in the YAML, it becomes part of the YAML body and causes a parse error.
3. A YAML parse error Notice is emitted. The block is skipped. This usage pattern is explicitly unsupported.

### Edge case: No active persona or workflow

1. No persona is active and no workflow is running.
2. No `<notor_tool_config>` blocks contribute to the config. The effective tool config is the global defaults: all tools enabled, auto-approve per global settings.

## Success criteria

1. **Personas are self-contained** — a persona folder with a `<notor_tool_config>` block in its system prompt is portable across vaults without any settings changes.
2. **Workflows can declare their tool requirements** — a workflow note with a `<notor_tool_config>` block correctly restricts or adjusts the tool set for the duration of the conversation. The workflow config persists until the conversation ends or a new workflow replaces it.
3. **Rule files can enforce tool constraints** — a rule file with a `<notor_tool_config>` block correctly applies when the rule is active.
4. **The LLM never sees the config block** — the tag and its contents are fully stripped from source content before it reaches the LLM in all supported contexts.
5. **Precedence merging is correct** — workflow > persona > rule > global, with field-by-field merging and replace semantics for path lists.
6. **Validation errors are surfaced clearly** — malformed or unrecognized blocks produce actionable Notices without crashing the plugin or silently misconfiguring the tool set.
7. **The Effective Config Inspector is accurate** — live mode reflects the true merged config using the real resolution pipeline. Pre-flight mode is deferred to a future iteration.

## Key entities

### ParsedToolConfig

The structured output of parsing a single `<notor_tool_config>` block from a source file.

```typescript
interface ParsedToolConfig {
  source: "persona" | "workflow" | "rule";
  sourceFile: string;
  documentPosition: number; // for within-file merge ordering
  tools: Record<string, ToolConfigEntry>;
}

interface ToolConfigEntry {
  enabled?: boolean;
  auto_approve?: boolean;
  allowed_paths?: string[];
  blocked_paths?: string[];
}
```

All fields on `ToolConfigEntry` are optional, supporting the sparse configuration model.

### ToolConfigValidationError

A structured validation error returned by the parser. The parser collects these without importing from `obsidian`; callers surface them as Notices.

```typescript
interface ToolConfigValidationError {
  sourceFile: string;  // vault-relative path to the source note
  detail: string;      // human-readable error description
}
```

### EffectiveToolConfig

The fully merged result of applying the precedence chain across all active `ParsedToolConfig` objects for a given conversation or execution.

```typescript
interface EffectiveToolConfig {
  tools: Record<string, ResolvedToolConfigEntry>;
}

interface ResolvedToolConfigEntry {
  enabled: boolean;
  auto_approve: boolean;
  allowed_paths: string[];
  blocked_paths: string[];
}
```

Unlike `ParsedToolConfig`, all fields on `ResolvedToolConfigEntry` are present and non-optional — defaults are filled in during resolution.

## Assumptions

- `<include_note>` resolution runs before `<notor_tool_config>` extraction in the ingestion pipeline. This is a firm ordering constraint.
- Tool enabled/disabled state is **not** exposed in the global Settings UI. The `<notor_tool_config>` tag is the only mechanism for customizing which tools are enabled. This is by design — see the design plan for motivation.
- The existing `ToolRegistry.getToolDefinitions()` returns all registered tools unfiltered. A new `getFilteredToolDefinitions(config)` method is added to `ToolRegistry`. The orchestrator accesses it via its existing `getToolDefinitionsCallback`, whose signature is widened to `(config?: EffectiveToolConfig) => ToolDefinition[]`. `main.ts` closes over the registry in the callback implementation, preserving the orchestrator's loose coupling from `ToolRegistry`.
- `SystemPromptBuilder` is split into a two-phase API to resolve the circular dependency between config extraction and tool definition filtering: `extractSourceToolConfigs()` (phase 1) extracts configs and caches stripped content; `assemble()` (phase 2) builds the prompt using cached stripped content and filtered tool definitions. The orchestrator calls phase 1 → merge → filter → phase 2 on each iteration.
- Provider implementations handle empty `tools` arrays correctly (no tools in request body), consistent with how providers behave when no tools are registered.
- The `EffectiveToolConfig` is recomputed before each LLM call (to reflect dynamic rule activation/deactivation) and does not persist between conversations.
- The Notor top-level directory value (used by FR-87 to locate persona folders) is the value configured in plugin settings.

## Out of scope

The following are explicitly excluded from Phase 4b and deferred to later iterations:

- **Settings-backed per-persona tool enabled overrides** (`persona_tool_enabled` in `data.json`): this approach was the original Phase 4b proposal and is replaced entirely by `<notor_tool_config>`. No Settings UI for per-tool enable/disable exists in this phase outside of the "Copy tool config YAML" helper.
- **Global tool enabled/disabled toggles in Settings UI**: tool enabled state lives exclusively in `<notor_tool_config>` tags. A global Settings toggle for individual tools is not provided.
- **Tool groups or categories**: grouping tools into named bundles that can be toggled as a unit. All configuration is per-tool.
- **Enabling/disabling tools from the chat panel**: tool configuration is a file-editing concern in Phase 4b. There is no quick-toggle in the chat panel UI.
- **`allowed_paths`/`blocked_paths` enforcement for MCP tools**: MCP tools support `enabled` and `auto_approve` only. Path enforcement for MCP tools is deferred to a future phase; specifying path fields for an MCP tool emits a "not yet implemented" Notice.
- **`<include_note>` inside `<notor_tool_config>` blocks**: explicitly unsupported (see Edge Cases above).
- **Version migration tooling**: when the schema is updated to a new major version, a migration prompt or automated migration is deferred. Silent backward-compat behavior vs. explicit migration notices is an open question (OQ-5) to be resolved when a major version bump is actually needed.

## Open questions

| # | Question | Impact |
|---|---|---|
| OQ-5 | Version migration path: silent backward-compat shim vs. explicit migration notice when a major version bump occurs? | User experience on schema updates |

## Research tasks

| # | Task |
|---|---|
| RT-1 | ~~Per-tool path argument inspection: research how each built-in tool represents path arguments in its schema, to support dispatch-time `allowed_paths` / `blocked_paths` enforcement (FR-84)~~ **Complete** — see [`research/RT-1-path-argument-inspection.md`](research/RT-1-path-argument-inspection.md) |
| RT-2 | ~~Regex vs. line-by-line parser for `<notor_tool_config>` extraction: benchmark both approaches for performance on large source files before finalizing the implementation (FR-81)~~ **Complete** — see [`research/RT-2-extraction-parser-benchmark.md`](research/RT-2-extraction-parser-benchmark.md) |
| RT-3 | ~~BRAT plugin right-click Notice behavior: research how BRAT implements right-click-to-navigate on Obsidian Notices before finalizing the validation warning UX (FR-82)~~ **Complete** — see [`research/RT-3-notice-right-click.md`](research/RT-3-notice-right-click.md) |
| RT-4 | ~~Integration risk audit: codebase scan to identify unstated risks in the spec and plan before implementation~~ **Complete** — see [`research/RT-4-integration-risks.md`](research/RT-4-integration-risks.md) |
| RT-5 | ~~Integration risks round 2: deeper codebase scan building on RT-4 findings~~ **Complete** (3 LOW/informational risks remain open) — see [`research/RT-5-integration-risks-round-2.md`](research/RT-5-integration-risks-round-2.md) |
