# RT-6: Task/Codebase Misalignment Audit

**Created:** 2026-03-22
**Status:** Open
**Scope:** Cross-reference `tasks.md` against the actual codebase, `spec.md`, and `plan.md`

## Summary

11 misalignments identified between the implementation tasks and the current codebase/spec/plan. 2 critical, 4 moderate, 5 minor.

**Resolved:** 6 (RT-6.1, RT-6.2, RT-6.3, RT-6.4, RT-6.5, RT-6.6)

---

## Critical

### RT-6.1: ~~Circular dependency in ORCH-001 / ORCH-002 / SYS-002~~ **RESOLVED**

**Status:** Resolved — Option 1 (two-phase builder split)

**Affected tasks:** SYS-001, SYS-002, ORCH-001, ORCH-002

**The circular dependency:** `assemble()` both (a) produces configs that `resolveEffectiveConfig()` needs and (b) needs filtered tool definitions that `resolveEffectiveConfig()` produces. You cannot call both first.

**Resolution:** Split `SystemPromptBuilder` into a two-phase API:
1. **`extractSourceToolConfigs(matchedRules?, persona?)`** — resolves `<include_note>` tags, extracts `<notor_tool_config>` blocks from persona and rule sources, caches stripped content internally. Returns `{ personaToolConfigs, ruleToolConfigs }`.
2. **`assemble(mode, filteredToolDefinitions, autoContext?)`** — builds the prompt using cached stripped content and the filtered tool definitions.

Orchestrator per-iteration flow: extract (phase 1) → merge → filter → assemble (phase 2).

**Changes applied:**
- `tasks.md`: SYS-001 updated to describe two-phase split; SYS-002 updated to target `extractSourceToolConfigs()`; ORCH-001 updated to call extract → merge → filter → assemble; ORCH-002 updated to reflect two-call pattern
- `plan.md`: SystemPromptBuilder contract rewritten for two-phase API; ChatOrchestrator `resolveEffectiveConfig()` flow updated; integration points table updated; risk assessment and readiness notes updated
- `spec.md`: FR-81 updated to describe two-phase builder; new assumption added

---

### RT-6.2: ~~PARSE-001 regex missing body capture group~~ **RESOLVED**

**Status:** Resolved — PARSE-001 AC 1 regex updated to include body capture group.

**Affected task:** PARSE-001 AC 1

**The misalignment:** The task regex had only 1 capture group (attributes): `/^<notor_tool_config([^>]*)>[\s\S]*?<\/notor_tool_config>/gm`. The spec (FR-81) and plan both have 2 capture groups (attributes + body): `/^<notor_tool_config([^>]*)>([\s\S]*?)<\/notor_tool_config>/gm`. Without the second capture group, the parser cannot extract the YAML body content for parsing.

**Changes applied:**
- `tasks.md`: PARSE-001 AC 1 regex updated to include the body capture group `([\s\S]*?)`

---

## Moderate

### RT-6.3: ~~SYS-002 implicitly migrates `<include_note>` resolution for rules~~ **RESOLVED**

**Status:** Resolved — explicit AC added to SYS-002.

**Affected task:** SYS-002

**Task SYS-002 AC 2 says:** "For each matched rule → `<include_note>` tags resolved, then `extractToolConfigs(resolved, 'rule', rule.file_path)` called"

**Current code:** `<include_note>` resolution for rules happens inside `VaultRuleManager.getActiveRuleContent()` at `src/rules/vault-rules.ts:184-211`. The VaultRuleManager iterates matched rules and calls `resolveIncludeNotes()` directly (lines 194–201), using `this.app.vault` and `this.app.metadataCache`.

The builder (`src/chat/system-prompt.ts`) currently receives pre-resolved rule content as a single string (line 69: `vaultRuleContent?: string`) and does **not** resolve `<include_note>` for rules — only for persona content (lines 81–85, 101–105) via `resolveIncludeNotesIfAvailable()` (lines 337–362).

**Impact:** SYS-002 requires migrating the `<include_note>` resolution loop from `vault-rules.ts:188-211` into the builder. The builder must:
1. Accept `VaultRule[]` instead of a pre-resolved string
2. Iterate each rule, calling `resolveIncludeNotesIfAvailable()` with context `"vault_rule"`
3. Then call `extractToolConfigs()` on the resolved content
4. Concatenate stripped content for the rules section

This is a non-trivial responsibility shift that isn't called out as a distinct acceptance criterion. The builder will also need error handling per-rule (matching the existing try/catch at `vault-rules.ts:202-210`).

**Changes applied:**
- `tasks.md`: SYS-002 gains explicit AC: "`<include_note>` resolution for individual rules migrates from `VaultRuleManager.getActiveRuleContent()` to the builder. The builder iterates each `VaultRule`, resolves includes via `resolveIncludeNotesIfAvailable()`, extracts tool configs, and concatenates stripped content. Error handling per-rule follows the existing try/catch pattern in `vault-rules.ts:202-210`."
- `spec.md` and `plan.md`: Already describe this migration correctly (FR-81 two-phase API; plan § SystemPromptBuilder phase 1 extraction). No changes needed.

---

### RT-6.4: ~~CLEAN-001 missing e2e test file modifications~~ **RESOLVED**

**Status:** Resolved — all 4 e2e files added to CLEAN-001 Files section; explicit AC added; plan.md updated.

**Affected task:** CLEAN-001

**Task CLEAN-001 Files section** listed 8 source files to modify/delete. The plan listed 3 e2e files.

**Actual files containing `persona_auto_approve`** in the e2e directory (4 files):
- `e2e/scripts/auto-approve-test.ts`
- `e2e/scripts/mcp-auto-approve-test.ts`
- `e2e/scripts/workflow-hooks-test.ts`
- `e2e/scripts/activity-indicator-test.ts` ← missed by both the task and the plan

**Changes applied:**
- `tasks.md`: CLEAN-001 Files section gains all 4 e2e files; new AC: "No remaining references to `persona_auto_approve` in e2e test files."
- `plan.md`: `activity-indicator-test.ts` added to the e2e file list under "Removed: Phase 4 `persona_auto_approve` infrastructure"
- `spec.md`: No changes needed (does not reference e2e files)

---

### RT-6.5: ~~PARSE-002 `showToolConfigError()` needs App access but parser has no dependency injection~~ **RESOLVED**

**Status:** Resolved — Option 3 (return structured error data; callers emit Notices).

**Affected tasks:** PARSE-001, PARSE-002

**The misalignment:** The plan's `showToolConfigError(plugin, sourceFile, detail)` helper needs `plugin.app.workspace.openLinkText()` for right-click navigation (RT-3 pattern), but the parser module (`src/tool-config/parser.ts`) is designed as a pure data-processing module with no Obsidian dependency injection point.

**Resolution:** The parser returns validation errors as structured `ToolConfigValidationError[]` data (with `sourceFile` and `detail` fields) alongside configs and stripped content. The parser has no `obsidian` import. Callers (`SystemPromptBuilder.extractSourceToolConfigs()`, `WorkflowExecutor.assembleWorkflowPrompt()`) iterate the returned errors and emit Obsidian Notices via a shared `showToolConfigError()` helper in `src/tool-config/notices.ts`. This keeps the parser pure and testable without mocking Obsidian APIs.

**Changes applied:**
- `tasks.md`: ENV-001 gains `ToolConfigValidationError` type export. PARSE-001 return type updated to include `errors: ToolConfigValidationError[]`; YAML parse failure ACs updated to say "error added" instead of "Notice". PARSE-002 reworked: validation errors collected as structured data, `showToolConfigError()` moved to `src/tool-config/notices.ts`, callers responsible for emitting Notices.
- `plan.md`: `types.ts` contract updated to export `ToolConfigValidationError`. `parser.ts` contract updated: return type gains `errors` field, internal steps updated to add errors instead of emitting Notices. `showToolConfigError()` section rewritten as `src/tool-config/notices.ts` module. `SystemPromptBuilder` and `WorkflowExecutor` sections note that callers emit Notices for returned errors.
- `spec.md`: FR-81 updated: parser returns structured errors, callers emit Notices. FR-82 description and ACs updated to describe the parser→caller error flow. `ToolConfigValidationError` added to Key entities section.

---

### RT-6.6: ~~Background loop pre-dispatch auto-approve check not addressed~~ **RESOLVED**

**Status:** Resolved — AC added to ORCH-003; plan.md updated.

**Affected task:** ORCH-003

**Current code** at `src/chat/orchestrator.ts:846-847`:
```typescript
const isAutoApproved = this.settings.auto_approve[toolName] ?? false;
```

This check only uses global settings — ignores persona overrides, rule overrides, and workflow overrides. It controls the concurrency manager UI status at lines 849–855 (sets `"waiting_approval"`) and line 867 (restores `"running"`).

**Task ORCH-003** says to wire `resolveEffectiveConfig()` into the background loop and remove the `toolDefinitions` parameter, but doesn't mention updating this pre-dispatch auto-approve status check to use `effectiveToolConfig.tools[toolName]?.auto_approve`.

**Impact:** After Phase 4b, the background workflow's UI status indicator would still reflect only global auto-approve settings, potentially showing `"waiting_approval"` when the effective config auto-approves the tool (or vice versa).

**Changes applied:**
- `tasks.md`: ORCH-003 gains new AC: "Pre-dispatch auto-approve status check (line ~846) updated to use `effectiveToolConfig.tools[toolName]?.auto_approve` instead of `this.settings.auto_approve[toolName]`, so the concurrency manager UI status reflects the effective config, not just global settings."
- `plan.md`: Background response loop section updated to describe the auto-approve status check migration.
- `spec.md`: No changes needed — FR-81 already mandates that both loops compute `resolveEffectiveConfig()` per-iteration, which implicitly covers all auto-approve checks.

---

## Minor

### RT-6.7: ORCH-001 step numbering gap

**Affected task:** ORCH-001

Acceptance criteria numbering jumps from step 3 ("Collects `workflowToolConfigs`...") to step 5 ("Stores contributing `ParsedToolConfig[]`..."). Step 4 is missing. The plan (`plan.md`) has the same gap. All 7 logical steps are present — purely a numbering typo.

**Fix:** Renumber steps 5–7 to 4–6, or insert a placeholder step 4.

---

### RT-6.8: MERGE-001 doesn't specify MCP tool name format for `allToolNames`

**Affected task:** MERGE-001

MERGE-001 AC 5 says default fill uses `globalAutoApprove[toolName]`. AC 6 says `globalAutoApprove` includes MCP server-level entries. But the `allToolNames: string[]` parameter isn't specified as requiring MCP-namespaced format (`server__tool`).

MCP tool naming convention uses `__` separator — see `src/chat/dispatcher.ts:386` where `isMcpTool(toolName)` checks for this pattern. If `allToolNames` contains MCP tools in a different format, the default fill won't match `globalAutoApprove` keys.

**Fix:** Add a note to MERGE-001 that `allToolNames` must use the same namespaced `server__tool` format as `globalAutoApprove` keys.

---

### RT-6.9: REG-001 defensive check vs merger guarantee

**Affected task:** REG-001

REG-001 AC 4 says: "Handles empty `EffectiveToolConfig.tools` gracefully (returns all tools if tool not in config)."
MERGE-001 AC 5 says the merger fills defaults for ALL tools not mentioned in any config.

If the merger works correctly, every registered tool will have an entry in `EffectiveToolConfig.tools`. REG-001 AC 4 describes a condition the merger guarantees can't happen. This is defensive coding (fine), but could confuse implementers about whether the merger's guarantee is reliable.

**Fix:** Add a note to REG-001 AC 4: "This is a defensive fallback — the merger should always produce entries for all tools, but this handles the edge case gracefully."

---

### RT-6.10: DISP-003 implicit dependency on `vaultRootPath`

**Affected task:** DISP-003

DISP-003 AC 2 says `enforcePathConstraints()` is called with "vault root path." The dispatcher has `this.vaultRootPath?: string` (set at `src/chat/dispatcher.ts:166-168`, called from `src/main.ts:973-974`). The field is optional — it could be `undefined`.

The plan handles this with `this.vaultRootPath ?? ""` as a fallback, but the task doesn't specify this behavior.

**Fix:** Add a note to DISP-003: "Uses `this.vaultRootPath ?? ''` as fallback when vault root path is not set."

---

### RT-6.11: SYS-001 doesn't mention unchanged parameters

**Affected task:** SYS-001

SYS-001 describes changing `vaultRuleContent` → `matchedRules` and the return type, but doesn't mention the full current signature at `src/chat/system-prompt.ts:66-72`:

```typescript
async assemble(
  mode: ConversationMode,
  toolDefinitions: ToolDefinition[],
  vaultRuleContent?: string,      // ← changed
  autoContextBlock?: string,
  persona?: Persona | null
): Promise<string>                // ← changed
```

The other parameters (`mode`, `toolDefinitions`, `autoContextBlock`, `persona`) are not mentioned. Given that `toolDefinitions` is involved in the circular dependency (RT-6.1), its continued presence as a parameter is relevant.

**Fix:** Add a note to SYS-001: "Parameters `mode`, `toolDefinitions`, `autoContextBlock`, and `persona` remain unchanged."
