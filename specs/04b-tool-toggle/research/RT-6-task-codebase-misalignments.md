# RT-6: Task/Codebase Misalignment Audit

**Created:** 2026-03-22
**Status:** Open
**Scope:** Cross-reference `tasks.md` against the actual codebase, `spec.md`, and `plan.md`

## Summary

11 misalignments identified between the implementation tasks and the current codebase/spec/plan. 2 critical, 4 moderate, 5 minor.

**Resolved:** 2 (RT-6.1, RT-6.2)

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

### RT-6.3: SYS-002 implicitly migrates `<include_note>` resolution for rules

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

**Fix:** Add an explicit AC to SYS-002: "`<include_note>` resolution for individual rules migrates from `VaultRuleManager.getActiveRuleContent()` to the builder. The builder iterates each `VaultRule`, resolves includes, extracts tool configs, and concatenates stripped content. Error handling per-rule follows the existing pattern in `vault-rules.ts:202-210`."

---

### RT-6.4: CLEAN-001 missing e2e test file modifications

**Affected task:** CLEAN-001

**Task CLEAN-001 Files section** lists 8 source files to modify/delete. The plan lists 3 e2e files.

**Actual files containing `persona_auto_approve`** in the e2e directory (4 files):
- `e2e/scripts/auto-approve-test.ts`
- `e2e/scripts/mcp-auto-approve-test.ts`
- `e2e/scripts/workflow-hooks-test.ts`
- `e2e/scripts/activity-indicator-test.ts` ← missed by both the task and the plan

**Fix:** Add all 4 e2e files to CLEAN-001's Files section and add an AC: "No remaining references to `persona_auto_approve` in e2e test files."

---

### RT-6.5: PARSE-002 `showToolConfigError()` needs App access but parser has no dependency injection

**Affected tasks:** PARSE-001, PARSE-002

**Plan shows** helper signature: `showToolConfigError(plugin: NotorPlugin, sourceFile, detail)` — needs `plugin.app.workspace.openLinkText()` for right-click navigation (RT-3 pattern).

**Task PARSE-001** defines: `extractToolConfigs(text, source, sourceFile)` — no `app`/`plugin` parameter.
**Task PARSE-002 AC 11** says: `showToolConfigError()` is "reusable across all validation call sites."

The parser module (`src/tool-config/parser.ts`) is designed as a pure data-processing module. It has no Obsidian dependency injection point in its public API. The Notice helper requires `App` to create right-click-to-navigate handlers.

**Current patterns in codebase:**
- `src/workflows/workflow-executor.ts:297` — creates `new Notice(...)` without navigation
- `src/include-note/resolver.ts` — doesn't create Notices; returns/logs errors
- `src/chat/system-prompt.ts:354-360` — logs warnings, doesn't create Notices

**Fix:** Either:
1. Add `app: App` parameter to `extractToolConfigs()` and thread it through
2. Accept a callback `onValidationError?: (sourceFile: string, detail: string) => void` so the caller provides the Notice logic
3. Return validation errors as structured data and let the caller (builder/orchestrator) create Notices

Option 3 is cleanest for testability — the parser stays pure, the caller handles UI.

---

### RT-6.6: Background loop pre-dispatch auto-approve check not addressed

**Affected task:** ORCH-003

**Current code** at `src/chat/orchestrator.ts:846-847`:
```typescript
const isAutoApproved = this.settings.auto_approve[toolName] ?? false;
```

This check only uses global settings — ignores persona overrides, rule overrides, and workflow overrides. It controls the concurrency manager UI status at lines 849–855 (sets `"waiting_approval"`) and line 867 (restores `"running"`).

**Task ORCH-003** says to wire `resolveEffectiveConfig()` into the background loop and remove the `toolDefinitions` parameter, but doesn't mention updating this pre-dispatch auto-approve status check to use `effectiveToolConfig.tools[toolName]?.auto_approve`.

**Impact:** After Phase 4b, the background workflow's UI status indicator would still reflect only global auto-approve settings, potentially showing `"waiting_approval"` when the effective config auto-approves the tool (or vice versa).

**Fix:** Add an AC to ORCH-003: "Pre-dispatch auto-approve status check (line ~846) updated to use `effectiveToolConfig.tools[toolName]?.auto_approve` instead of `this.settings.auto_approve[toolName]`."

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
