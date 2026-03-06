# System Prompt Design — Learning from Cline

**Research task:** R-2
**Created:** 2026-06-03
**Status:** Complete
**Blocks:** Phase 0 (system prompt — FR-6)
**Spec reference:** [specs/01-mvp/spec.md](../../specs/01-mvp/spec.md)

---

## 1. Cline's System Prompt Structure

Cline's system prompt is a large, highly structured document (~8,000–10,000 tokens) that governs an AI coding assistant inside VS Code. It is organized into the following major sections, in order:

### 1.1 Role Definition

A brief opening paragraph establishing identity, expertise domain, and high-level capability scope.

```
You are Cline, a highly skilled software engineer with extensive knowledge
in many programming languages, frameworks, design patterns, and best practices.
```

**Key characteristics:**
- Single sentence establishing identity and domain
- Broad capability framing (not narrowly scoped)
- Professional tone, no personality embellishment

### 1.2 Tool Use Instructions

The largest section (~60% of the prompt). For each tool, Cline's prompt includes:

- **Tool name and description**: what the tool does and when to use it
- **Parameter definitions**: name, type, required/optional, description
- **XML-formatted usage syntax**: exact invocation format the LLM must produce
- **Usage guidance**: when to prefer this tool over alternatives (e.g., `replace_in_file` vs `write_to_file`)
- **Behavioral rules per tool**: e.g., "always provide complete file content" for `write_to_file`, "SEARCH content must match exactly" for `replace_in_file`
- **Examples**: concrete usage examples with realistic parameters

**Sub-sections within tool instructions:**
- Tool Use Formatting (general XML syntax)
- Individual tool definitions (one per tool)
- Tool Use Examples (numbered, cross-tool examples)
- Tool Use Guidelines (meta-rules about tool selection and sequencing)

### 1.3 Editing Files (Strategy Guidance)

A dedicated section explaining *when* to use `write_to_file` vs `replace_in_file` — covering:

- Purpose and role of each tool
- Decision criteria for choosing between them
- Auto-formatting considerations (how the editor may modify files after writes)
- Workflow tips (assess scope before editing, prefer single calls with multiple blocks)

This section is notable because it goes beyond parameter documentation into **strategic guidance** about *how to think* about editing.

### 1.4 Mode System (Plan vs Act)

Explains the two modes:
- **ACT MODE**: full tool access, goal is to accomplish the task
- **PLAN MODE**: information gathering and planning, presents plans for user review

Includes behavioral expectations for each mode and transition guidance.

### 1.5 Capabilities Overview

A narrative description of what the assistant can do across all tools, with examples of multi-step workflows. Emphasizes:
- Combining tools for comprehensive analysis
- Using search before editing
- Browser interaction for verification
- MCP server integration

### 1.6 Rules (Behavioral Constraints)

A bulleted list of ~25 rules covering:
- Working directory constraints
- Command execution guidelines (prefer non-interactive, redirect stderr)
- Search pattern crafting
- Project organization conventions
- Code change considerations (compatibility, standards)
- Communication style (no conversational fluff, direct and technical)
- Image analysis instructions
- Environment details interpretation
- Tool sequencing requirements (wait for confirmation)
- Markdown formatting guidelines

### 1.7 System Information

Dynamically injected context about the user's environment:
- Operating system
- IDE
- Default shell
- Home directory
- Current working directory

### 1.8 Objective

A meta-instruction describing the step-by-step methodology:
1. Analyze and set goals
2. Work sequentially with tools
3. Think before acting (use `<thinking>` tags)
4. Use `attempt_completion` when done
5. Incorporate feedback

### 1.9 User Custom Instructions

Dynamically injected at the end:
- `.clinerules/` directory contents (project-level rules)
- `AGENTS.md` file contents (directory-scoped instructions)

These are analogous to Notor's vault-level rule files (FR-23).

---

## 2. Transferable Patterns

The following architectural patterns from Cline's prompt directly apply to Notor's note-writing context.

### 2.1 Structured Tool Documentation (HIGH transfer)

**Cline pattern:** Each tool has a formal block with name, description, parameters, usage syntax, and examples.

**Notor application:** Identical approach. Each tool (`read_note`, `write_note`, `replace_in_note`, `search_vault`, `list_vault`, and Phase 2 tools) should have a structured documentation block. The tool schemas from `contracts/tool-schemas.md` provide the foundation, but the system prompt should add *behavioral guidance* beyond the schema — when to use each tool, common patterns, and pitfalls.

### 2.2 Strategic Editing Guidance (HIGH transfer)

**Cline pattern:** Dedicated section explaining when to use `write_to_file` vs `replace_in_file`, with decision criteria and workflow tips.

**Notor application:** Direct parallel. Notor needs a "Note Editing Strategy" section explaining:
- When to use `write_note` (new notes, complete rewrites) vs `replace_in_note` (targeted edits, section updates)
- Why `replace_in_note` should be the default for existing notes (preserves frontmatter, preserves unread sections, smaller diffs for user review)
- How to construct reliable search blocks (include enough context for unique matching, match whitespace exactly)
- Multi-block editing patterns (list blocks in document order, keep blocks focused)

### 2.3 Mode-Aware Behavior (HIGH transfer)

**Cline pattern:** Prompt explains Plan vs Act mode, what tools are available in each, and behavioral expectations per mode.

**Notor application:** Direct parallel. Notor's Plan/Act mode (FR-14) needs the same treatment:
- Plan mode: read-only operations, information gathering, propose changes without executing
- Act mode: full tool access, can modify notes
- When write tools are blocked, inform the user and suggest switching modes

### 2.4 Step-by-Step Reasoning (HIGH transfer)

**Cline pattern:** Instructions to analyze before acting, use `<thinking>` tags, work iteratively, wait for confirmation after each tool use.

**Notor application:** The same deliberate approach applies to note work:
- Read before editing (always `read_note` before `replace_in_note`)
- Search before creating (check if a note already exists before `write_note`)
- Propose changes, wait for approval, then proceed
- Verify the result of each operation before moving on

### 2.5 Safety and Confirmation Rules (HIGH transfer)

**Cline pattern:** Wait for user confirmation after each tool use. Never assume success. Tool calls that modify state require explicit approval.

**Notor application:** Directly applicable. The approval flow (FR-12, FR-15) maps 1:1. The system prompt should instruct the AI to:
- Respect the approval flow — do not assume a change was applied until confirmed
- When a tool call is rejected, acknowledge and adapt
- Prefer smaller, reviewable changes over large rewrites

### 2.6 Context Injection Pattern (HIGH transfer)

**Cline pattern:** User's custom instructions (`.clinerules/`, `AGENTS.md`) are injected into the system prompt dynamically, with scoping rules.

**Notor application:** Direct parallel to vault-level rules (FR-23). The system prompt should explain that additional instructions may be injected based on which notes are in context, and the AI should follow them.

### 2.7 Error Handling Instructions (MEDIUM transfer)

**Cline pattern:** Rules about handling tool failures — if a search doesn't match, if a command fails, if the file doesn't exist.

**Notor application:** Similar patterns:
- If `replace_in_note` fails (no match), re-read the note and retry with corrected search text
- If `search_vault` returns no results, suggest alternative terms
- If a note doesn't exist for `read_note`, inform the user and offer to create it
- If stale content is detected, re-read before retrying

### 2.8 Communication Style Rules (MEDIUM transfer)

**Cline pattern:** Direct and technical tone. No conversational fluff. Specific formatting rules (Markdown usage, backticks for code/file names).

**Notor application:** Partially transferable. The tone should be adapted for knowledge work:
- Helpful and clear, but less rigidly technical than a coding assistant
- Use Markdown formatting appropriate for Obsidian (wikilinks, callouts, etc.)
- Be concise but not curt — note writing is more collaborative than debugging

---

## 3. Non-Transferable Patterns

The following Cline patterns are specific to software development and should not be carried over to Notor.

### 3.1 Code-Specific Formatting Rules

**Cline pattern:** Rules about code fences, language-specific syntax, compiler error handling, linter integration.

**Not applicable:** Notor operates on Markdown notes, not source code. No need for language-aware formatting rules, build system integration, or compiler error handling.

### 3.2 Project Scaffolding Guidance

**Cline pattern:** Instructions about creating project structures, organizing source files, choosing frameworks.

**Not applicable:** Notor doesn't scaffold projects. Note organization guidance is relevant but takes a completely different form (vault structure, folder conventions, naming patterns).

### 3.3 Terminal/Command Execution Strategy

**Cline pattern:** Extensive rules about command execution — prefer non-interactive commands, redirect stderr, handle long-running processes, check active terminals.

**Not applicable for MVP:** Notor doesn't have command execution in the MVP. When `execute_command` is added in Phase 3, a subset of these rules would become relevant.

### 3.4 Browser Interaction Protocol

**Cline pattern:** Detailed browser automation rules — screenshot analysis, coordinate-based clicking, sequential action model.

**Not applicable:** Notor doesn't have browser capabilities in the MVP.

### 3.5 IDE-Specific Context

**Cline pattern:** VS Code-specific details — visible files, open tabs, terminal state.

**Partially replaced:** Notor should instead inject Obsidian-specific context — active note, open notes, vault structure summary. This is auto-context (Phase 3), not the system prompt itself.

### 3.6 Git Workflow Integration

**Cline pattern:** Commit management, branch awareness, diff generation tools.

**Not applicable:** Notor uses its own checkpoint system (FR-17), not git.

---

## 4. Note Writing Requirements

What a note-writing system prompt must emphasize that Cline's prompt does not cover.

### 4.1 Obsidian-Specific Syntax

The AI must understand and correctly use:
- **Wikilinks:** `[[Note Name]]` and `[[Note Name|Display Text]]`
- **Frontmatter:** YAML block delimited by `---` at the start of a note
- **Callouts:** `> [!type] Title` syntax for callouts (note, warning, tip, etc.)
- **Tags:** `#tag-name` inline tags and `tags:` frontmatter property
- **Embeds:** `![[Note Name]]` for embedding note content
- **Headings:** Standard Markdown `#` through `######`
- **Internal links with headings:** `[[Note Name#Heading]]`
- **Block references:** `[[Note Name#^block-id]]`

The prompt should instruct the AI to prefer Obsidian-native syntax (wikilinks over standard Markdown links) unless the user's vault conventions differ.

### 4.2 Note Editing Safety

Critical safety principles for note editing:

1. **Prefer surgical edits:** Use `replace_in_note` over `write_note` for existing notes. Only use `write_note` when creating new notes or when the user explicitly requests a complete rewrite.
2. **Preserve structure:** Don't reorganize headings, reorder sections, or restructure a note unless asked. Respect the user's organizational choices.
3. **Don't rewrite unnecessarily:** If asked to "improve" a paragraph, change that paragraph only — don't rewrite adjacent sections.
4. **Frontmatter awareness:** Never include frontmatter in `write_note` content unless the user explicitly included it or asked for frontmatter changes. Use `update_frontmatter` / `manage_tags` (Phase 2) for metadata operations.
5. **Read before editing:** Always `read_note` before proposing changes to understand the full context. Never edit a note you haven't read in the current conversation.
6. **Minimal diffs:** Construct the smallest possible change to achieve the goal. Smaller changes are easier for users to review and less likely to cause unintended modifications.

### 4.3 Vault-Aware Behavior

The AI should understand vault concepts:
- **File paths** are relative to vault root (e.g., `Research/Climate.md`)
- **Folder structure** represents the user's organizational system — respect it
- **Tags** serve as cross-cutting categorization — suggest consistent tag usage
- **Frontmatter** is structured metadata — treat it as data, not prose
- **Wikilinks** create a knowledge graph — suggest links to related notes when appropriate

### 4.4 Search and Research Patterns

Guidance for information retrieval:
- Use `search_vault` before claiming information doesn't exist in the vault
- When citing vault content, reference specific note paths and sections
- Use `list_vault` to understand folder organization before suggesting where to create new notes
- Combine search results from multiple notes to synthesize information

### 4.5 User Interaction Style

The AI should be:
- **Concise:** Provide clear, focused responses. Avoid unnecessary elaboration.
- **Helpful:** Proactively suggest related notes, better organization, or useful tags when relevant.
- **Non-destructive:** Default to proposing changes rather than making them. Err on the side of asking before large modifications.
- **Transparent:** When using tools, explain what you're doing and why. If a tool call fails, explain what went wrong and how to fix it.
- **Vault-respecting:** Don't impose organizational opinions unless asked. The user's vault structure is intentional.

---

## 5. Tool Usage Instructions

Specific recommended prompt text for how the AI should use Notor's tools.

### 5.1 `read_note` Guidance

```
Use read_note to read the contents of a note before making any changes to it.
You should always read a note before proposing edits with replace_in_note or
write_note. By default, frontmatter is excluded from the returned content.
Set include_frontmatter to true only when you need to examine or reference
metadata (e.g., tags, properties, dates).
```

### 5.2 `write_note` Guidance

```
Use write_note to create a new note or completely replace the content of an
existing note. For existing notes, prefer replace_in_note for targeted edits
instead of rewriting the entire note.

When creating new notes:
- Choose an appropriate path based on the vault's existing folder structure
- Use list_vault to understand the folder organization before creating notes
  in new locations
- Include appropriate headings and structure

When overwriting existing notes:
- Only use write_note if the user explicitly requests a complete rewrite
- Be aware that write_note replaces the entire file content — any frontmatter
  or content not included in your write will be lost
- Always read_note first to understand what you're replacing
```

### 5.3 `replace_in_note` Guidance

```
Use replace_in_note for targeted edits to existing notes. This is the
preferred tool for modifying notes because it preserves all content you
don't explicitly change.

Rules for constructing search/replace blocks:
- Search text must match the note content exactly, character-for-character,
  including whitespace, line breaks, and indentation
- Include enough surrounding context in the search text to ensure a unique
  match — don't match on just a few common words
- Each block replaces only the first occurrence of the search text
- List multiple blocks in the order they appear in the note
- Use an empty replace string to delete text
- The operation is atomic: if any search block fails to match, no changes
  are applied

If a replace_in_note operation fails because a search block didn't match,
re-read the note with read_note to get the current content, then retry with
corrected search text.
```

### 5.4 `search_vault` Guidance

```
Use search_vault to find information across the vault. Use it before telling
the user that information doesn't exist in their vault. Results include
surrounding context lines to help you understand each match.

Tips:
- Start with a broad search if unsure, then narrow down
- Use the path parameter to scope searches to specific directories
- Use file_pattern to filter by file type if needed
- If no matches are found, suggest alternative search terms to the user
```

### 5.5 `list_vault` Guidance

```
Use list_vault to understand the vault's folder structure. This is useful
before creating new notes (to choose an appropriate location) or when the
user asks about their vault organization.

Tips:
- Use non-recursive listing first to understand top-level structure
- Use recursive listing sparingly on specific subdirectories — large vaults
  can have thousands of files
- Results are paginated; use offset to retrieve additional pages if needed
```

### 5.6 Phase 2 Tool Guidance (Metadata)

```
Use read_frontmatter to examine a note's metadata (tags, properties, dates)
as structured data. This is more reliable than parsing frontmatter from
read_note output.

Use update_frontmatter to modify specific properties without touching the
note body. Never use write_note or replace_in_note to modify frontmatter —
use update_frontmatter instead.

Use manage_tags to add or remove tags. This operates on the frontmatter
'tags' property specifically and handles deduplication and missing-tag
removal gracefully.
```

---

## 6. Draft System Prompt Structure

The following is the recommended section outline for Notor's default system prompt, with descriptions of each section's purpose and approximate token budget.

### Section Outline

| # | Section | Purpose | Est. Tokens |
|---|---------|---------|-------------|
| 1 | **Role definition** | Establish identity and domain (note writing + knowledge management) | 50–80 |
| 2 | **Tool definitions** | Structured documentation for each tool (name, description, parameters, usage format) | 1,200–1,800 |
| 3 | **Tool usage guidelines** | Meta-rules: tool selection strategy, sequencing, error handling, wait for confirmation | 300–500 |
| 4 | **Note editing strategy** | When to use `write_note` vs `replace_in_note`, surgical editing principles, frontmatter safety | 300–400 |
| 5 | **Mode system** | Plan vs Act mode explanation, tool availability per mode, behavioral expectations | 150–250 |
| 6 | **Obsidian syntax reference** | Wikilinks, callouts, frontmatter, tags, embeds — compact reference | 200–300 |
| 7 | **Behavioral rules** | Safety guardrails, communication style, vault-respecting behavior, formatting conventions | 300–500 |
| 8 | **Vault context** | Dynamically injected: active note, vault name, `{notor_dir}` path | 50–100 |
| 9 | **Vault-level rules** | Dynamically injected: content from triggered rule files (FR-23) | Variable |

**Total estimated base tokens: 2,550–3,930** (excluding dynamic injections)

### Recommended Token Budget

- **Target base prompt:** ~3,000 tokens (before dynamic injections)
- **Maximum with rules:** ~5,000 tokens (with vault-level rule injections)
- **Hard ceiling:** 8,000 tokens (to leave ample room for conversation context)

For comparison, Cline's system prompt is ~8,000–10,000 tokens, but Cline has many more tools and extensive code-specific rules. Notor's tool set is smaller and the domain is simpler, so a more compact prompt is achievable and desirable.

### Section 1: Role Definition (Draft)

```
You are Notor, an AI assistant integrated into Obsidian for note writing
and knowledge management. You help users read, create, search, and edit
notes in their vault. You have access to tools that interact with the
vault through Obsidian's APIs.

You are concise, helpful, and non-destructive. You respect the user's
vault structure and organizational choices. You prefer targeted edits
over wholesale rewrites, and you always read before editing.
```

### Section 5: Mode System (Draft)

```
You operate in one of two modes:

- **Plan mode** (read-only): You can read notes, search the vault, and
  list files. You cannot create or modify notes. Use this mode to research,
  analyze, and propose changes without risk.

- **Act mode** (full access): You can use all tools, including creating
  and editing notes. Write operations require user approval unless
  auto-approved.

If you attempt a write operation in Plan mode, the tool will return an
error. Inform the user and suggest switching to Act mode if they want
to proceed with modifications.
```

### Section 7: Behavioral Rules (Draft)

```
Rules:
- Always read a note with read_note before proposing edits to it.
- Prefer replace_in_note over write_note for existing notes.
- Never modify frontmatter using write_note or replace_in_note — use
  update_frontmatter or manage_tags instead.
- When creating new notes, use list_vault to understand folder organization
  and choose an appropriate location.
- Use search_vault before claiming information doesn't exist in the vault.
- Construct replace_in_note search blocks with exact character-for-character
  matches, including whitespace and line breaks.
- If a tool call fails, explain what went wrong and suggest how to resolve it.
- Do not reorganize, rename, or restructure notes unless explicitly asked.
- Keep responses concise and focused on the user's request.
- Use Obsidian-native syntax (wikilinks, callouts) when writing note content.
- When suggesting links to other notes, use [[wikilink]] format.
- After each tool use, wait for confirmation before proceeding.
```

---

## 7. Safety Guardrails

Built-in behavioral constraints for the system prompt.

### 7.1 Confirmation Before Large Changes

The AI should ask for confirmation before:
- Overwriting an existing note with `write_note` (distinct from the tool approval flow — this is a behavioral guardrail in the prompt)
- Making changes spanning multiple notes in a single turn
- Deleting significant amounts of content (large empty `replace` strings)
- Creating notes in new directories that don't yet exist

### 7.2 Destructive Operation Warnings

The AI should explicitly warn when:
- A `write_note` on an existing note will replace all content
- A `replace_in_note` with an empty replace string will delete content
- A proposed change affects frontmatter (before Phase 2 metadata tools are available)

### 7.3 Failure Reporting

The AI must:
- Report tool failures clearly with the error message
- Suggest corrective actions (re-read the note, try different search text, check the path)
- Never pretend a failed operation succeeded
- Never silently retry without informing the user

### 7.4 Scope Constraints

The AI must not:
- Access files outside the vault
- Make network requests (the AI itself doesn't; only the LLM provider connection does)
- Suggest executing system commands (not available in MVP)
- Claim capabilities it doesn't have

---

## 8. Size and Token Efficiency Considerations

### 8.1 Context Window Constraints

Different models have different context windows:
- **Small models (Ollama local):** 4K–8K tokens — system prompt must be very compact
- **Medium models (Claude Haiku, GPT-4o-mini):** 128K–200K tokens — plenty of room
- **Large models (Claude Opus, GPT-4o):** 128K–200K tokens — plenty of room

The system prompt should be designed for the *smallest* reasonable target while remaining effective. A 3,000-token base prompt works within even an 8K context window (leaving ~5K for conversation).

### 8.2 Token Efficiency Techniques

1. **Structured over narrative:** Use tables, lists, and terse descriptions rather than flowing prose.
2. **Examples only where essential:** Include 1–2 usage examples for complex tools (`replace_in_note`), skip examples for simple tools (`read_note`).
3. **Deduplicate:** Don't repeat tool parameters in both a table and prose. Pick one format.
4. **Dynamic sections:** Only inject what's needed:
   - Phase 2 tool definitions only after Phase 2 is implemented
   - Vault rules only when triggered
   - Active note context only when relevant
5. **Tiered prompt:** Consider a compact base prompt + expanded guidance that's injected only for smaller conversations (where context budget allows).

### 8.3 Token Budget Recommendation

| Component | Budget | Notes |
|---|---|---|
| Role + behavioral rules | 500 tokens | Compact, essential |
| Tool definitions (Phase 1: 5 tools) | 1,200 tokens | Structured format |
| Tool definitions (Phase 2: 3 tools) | 500 tokens | Added when available |
| Tool usage guidelines + editing strategy | 500 tokens | Strategic guidance |
| Mode system | 200 tokens | Brief |
| Obsidian syntax reference | 200 tokens | Compact reference |
| Dynamic vault context | 100 tokens | Injected per-conversation |
| Vault-level rules (FR-23) | 0–2,000 tokens | Variable, user-controlled |
| **Total base (Phase 1)** | **~2,600 tokens** | |
| **Total base (Phase 2)** | **~3,100 tokens** | |
| **Total max with rules** | **~5,100 tokens** | |

---

## 9. Recommendations

### 9.1 Proceed with the Structured Prompt Architecture

Adopt Cline's structured approach with adaptations for note writing:
- Formal tool documentation blocks (transferred directly)
- Strategic editing guidance section (adapted from Cline's file editing strategy)
- Explicit behavioral rules list (adapted for vault context)
- Dynamic injection for vault-level rules (parallel to `.clinerules`)

### 9.2 Keep the Base Prompt Compact

Target ~3,000 tokens for the base system prompt (without dynamic injections). This supports small local models while leaving room for vault rules and conversation context.

### 9.3 Prioritize Safety in Prompt Design

Three safety principles should be embedded throughout:
1. **Read before write** — always read a note before editing it
2. **Surgical over wholesale** — prefer `replace_in_note` over `write_note` for edits
3. **Transparent failures** — always report tool errors, never pretend they didn't happen

### 9.4 Support User Customization

Per FR-6, users can override the system prompt via `{notor_dir}/prompts/core-system-prompt.md`. The default prompt should be well-structured and commented so users understand what each section does and can customize confidently.

### 9.5 Implementation Notes

- The system prompt should be stored as a TypeScript string constant (the internal default) that gets written to the vault file on first customization
- Tool definitions within the prompt should be generated from the tool registry (single source of truth) rather than hardcoded in the prompt text
- Vault-level rule injection (FR-23) should append to the prompt, not replace any section
- The mode indicator (Plan/Act) should be injected dynamically rather than being static in the prompt, so it always reflects current state

---

## 10. Risks and Limitations

| Risk | Impact | Mitigation |
|---|---|---|
| Small local models may struggle with long system prompts | Degraded tool use accuracy | Tiered prompt system; compact base version for small contexts |
| Users may customize the prompt and break tool usage | Tools may not be called correctly | Include a "do not remove" notice on the tool definitions section; validate tool calls at dispatch |
| Vault-level rules could inject conflicting instructions | Unpredictable AI behavior | Document best practices for rule writing; cap total injection size |
| Different LLM providers parse tool definitions differently | Inconsistent behavior across providers | Test prompt with all four providers; use provider-native tool calling where available (not prompt-based) |