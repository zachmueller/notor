# RT-6b: Additional Task/Codebase Misalignment Audit

**Created:** 2026-03-22
**Status:** Open
**Scope:** Continuation of RT-6. Cross-reference `tasks.md` against the actual codebase, `spec.md`, and `plan.md` for misalignments not found in the original RT-6 audit.

## Summary

8 additional misalignments identified between the implementation tasks and the current codebase/spec/plan. 0 critical, 4 moderate, 4 minor.

**Resolved:** 5

---

## Moderate

### RT-6.12: `handleUserMessage()` public signature change not mentioned

**Status:** Resolved

**Affected tasks:** ORCH-002, MAIN-001

**Task ORCH-002 AC says:**
> "`toolDefinitions` parameter removed from `responseLoop()`"
> "Callers of `responseLoop()` (`handleUserMessage()`, `executeWorkflow()`) no longer pass `toolDefinitions`"

**What the codebase shows:** `handleUserMessage()` is itself a **public method** that accepts `toolDefinitions: ToolDefinition[]` as its second parameter:

```typescript
// src/chat/orchestrator.ts:986-989
async handleUserMessage(
    content: string,
    toolDefinitions: ToolDefinition[],
    attachments?: Attachment[]
): Promise<void> {
```

It is called from `main.ts` in the `setOnSendMessage` callback:

```typescript
// src/main.ts:1280-1286
view.setOnSendMessage(async (content: string, attachments?) => {
    const toolDefinitions = toolRegistry.getToolDefinitions() as import("./providers/provider").ToolDefinition[];
    await orchestrator.handleUserMessage(content, toolDefinitions, attachments);
});
```

Similarly, `executeWorkflow()` captures tool definitions and passes them to `responseLoop()`:

```typescript
// src/chat/orchestrator.ts:474-475
const toolDefinitions = this.getToolDefinitionsCallback?.() ?? [];
await this.responseLoop(toolDefinitions, currentMode);
```

And the background execution path does the same:

```typescript
// src/chat/orchestrator.ts:644-647
const toolDefinitions = this.getToolDefinitionsCallback?.() ?? [];
await this._backgroundResponseLoop(
    bgConversationManager,
    toolDefinitions,
    ...
);
```

**The problem:** ORCH-002 says callers of `responseLoop()` "no longer pass `toolDefinitions`" — which covers the internal calls from `handleUserMessage()` (line 1100) and `executeWorkflow()` (line 475). But ORCH-002 does not state that:

1. `handleUserMessage()`'s **public API signature** itself must change (removing the `toolDefinitions` parameter)
2. The `main.ts` `setOnSendMessage` callback (lines 1280–1286) must stop calling `toolRegistry.getToolDefinitions()` and stop passing `toolDefinitions`
3. The background execution call site (line 644) must also stop capturing `toolDefinitions`

**Impact:** An implementer following ORCH-002 literally would change `responseLoop()` and `_backgroundResponseLoop()` but leave `handleUserMessage()` still accepting (and ignoring) `toolDefinitions`, creating dead code and a misleading public API. The `main.ts` call site would also need updating or would fail to compile.

**Suggested resolution:** Add ACs to ORCH-002:
- "`handleUserMessage()` public signature updated to remove `toolDefinitions` parameter."
- "The `main.ts` `setOnSendMessage` callback (lines 1280–1286) updated to call `handleUserMessage(content, attachments)` without tool definitions."
- "The `executeWorkflow()` method (line 474) and background execution caller (line 644) no longer capture `toolDefinitions` via `getToolDefinitionsCallback()`."

**Resolution:** Applied suggested resolution. Three new ACs added to ORCH-002 in `tasks.md` covering `handleUserMessage()` signature removal, `main.ts` `setOnSendMessage` callback update, and `executeWorkflow()` no longer capturing `toolDefinitions`. Also added a clarifying AC to ORCH-003 for the background execution caller. `plan.md` updated with an explicit "Public API change" paragraph in the orchestrator section documenting the `handleUserMessage()` signature change and caller updates.

---

### RT-6.14: No spec for when `globalAutoApprove` is rebuilt

**Status:** Resolved

**Affected task:** MAIN-001

**Task MAIN-001 AC 1-2 say:**
> "`globalAutoApprove: Record<string, boolean>` built by merging built-in defaults (`settings.auto_approve`) with MCP server-level `autoApprove[]` lists"
> "`globalAutoApprove` injected into orchestrator"

**What the codebase shows:** The task says `globalAutoApprove` is "built" and "injected" but does not specify **when** this happens or **when it needs to be rebuilt**.

MCP server auto-approve is currently resolved **live at dispatch time** — `resolveMcpAutoApprove()` reads `tool.getServerConfig().autoApprove` directly:

```typescript
// src/chat/dispatcher.ts:60-64
const serverConfig = tool.getServerConfig();
if (serverConfig?.autoApprove?.includes(rawToolName)) {
    return true;
}
```

This means the current implementation always reflects the latest server config. If `globalAutoApprove` is built once and injected as a static map, it becomes stale when:

1. A new MCP server connects and registers tools (tool registration happens dynamically at `main.ts:629`)
2. An existing MCP server's `autoApprove` list is edited via Settings
3. Settings are reloaded (e.g., at new conversation start, `main.ts:1303`)

Settings changes propagate through `saveSettings()` (`main.ts:720-747`), and the `setOnNewConversation` callback reloads settings (`main.ts:1303`). But within a single conversation, edits to MCP `autoApprove` lists would not be reflected in a static `globalAutoApprove` map.

**Impact:** If `globalAutoApprove` is built once and never rebuilt, persona/rule/workflow overrides via `<notor_tool_config>` would correctly apply (they don't depend on `globalAutoApprove`), but the **default fill** for MCP tools not mentioned in any `<notor_tool_config>` block would reflect stale `autoApprove` lists. This is a regression from the current live-resolution behavior.

**Suggested resolution:** MAIN-001 should specify one of:
- **(a)** `globalAutoApprove` is rebuilt per-iteration inside `resolveEffectiveConfig()` by reading `settings.auto_approve` and `settings.mcp_servers` at call time. This is simplest and consistent with the per-iteration recompute pattern already established.
- **(b)** `globalAutoApprove` is rebuilt whenever settings are propagated (in the `saveSettings()` → orchestrator path) and at new-conversation time.
- **(c)** The merger accepts a callback rather than a static map, resolving defaults lazily.

Option (a) is recommended.

**Resolution:** Applied option (a). `globalAutoApprove` is no longer built as a static map by `main.ts` and injected into the orchestrator. Instead, the orchestrator builds it per-iteration inside `resolveEffectiveConfig()` by reading `this.settings.auto_approve` and `this.settings.mcp_servers` at call time. Changes applied: `spec.md` FR-80 updated with per-iteration rebuild clarification; `plan.md` orchestrator section updated to show `globalAutoApprove` construction as step 3 of `resolveEffectiveConfig()`, dependency injection list updated to note `globalAutoApprove` is not injected, `main.ts` section and Integration Points table updated to remove static build/injection; `tasks.md` MAIN-001 ACs updated to reflect no static map, ORCH-001 AC added for per-iteration `globalAutoApprove` construction.

---

### RT-6.15: Conversation-end cleanup location unspecified

**Status:** Resolved

**Affected tasks:** ORCH-004, MAIN-001

**Task ORCH-004 AC 3 says:**
> "Both fields cleared on conversation end"

**Task MAIN-001 AC 4 says:**
> "On conversation end: `dispatcher.setEffectiveToolConfig(null)` called and orchestrator's `activeParsedConfigs`/`effectiveToolConfig` cleared"

**What the codebase shows:** There is no dedicated "conversation end" event or method. The closest equivalent is the "New conversation" flow, which splits between two locations:

**Location 1 — `main.ts` `setOnNewConversation` callback (line 1294):**
```typescript
// src/main.ts:1294-1319
view.setOnNewConversation(() => {
    const staleTracker = this.getStaleTracker();
    staleTracker.clear?.();
    const vaultRuleManager = this.getVaultRuleManager();
    vaultRuleManager.clearAccessedNotes();

    this.loadSettings().then(() => {
        toolDispatcher.setAutoApprove(this.settings.auto_approve);
        toolDispatcher.setPersonaAutoApprove(this.settings.persona_auto_approve);
        // ...
        if (this._orchestrator) {
            this._orchestrator.updateSettings(this.settings);
        }
    });
    // Then calls orchestrator.newConversation()
});
```

**Location 2 — `orchestrator.newConversation()` (line 196):**
```typescript
// src/chat/orchestrator.ts:196-209
async newConversation(): Promise<void> {
    await this.maybeRevertWorkflowPersona();
    // ... creates new conversation, clears messages
}
```

`activeParsedConfigs` and `effectiveToolConfig` are described as **private fields on the orchestrator** (ORCH-004). Clearing private fields from `main.ts` would require either public clear methods or doing it inside `orchestrator.newConversation()`.

Neither task specifies whether the clear happens in `main.ts`'s callback (which runs first, including an async `loadSettings()` chain) or in `orchestrator.newConversation()` (which runs after).

**Impact:** If cleanup is added to the wrong location, the effective config might not be cleared before the new conversation's first `resolveEffectiveConfig()` call. The `main.ts` callback's async `loadSettings()` chain creates a timing consideration — if `dispatcher.setEffectiveToolConfig(null)` is placed after `loadSettings()`, there's a window where stale config remains.

**Suggested resolution:** Specify that `orchestrator.newConversation()` clears `activeParsedConfigs`, `effectiveToolConfig`, and calls `dispatcher.setEffectiveToolConfig(null)` — since it already owns orchestrator internal state cleanup (persona revert, etc.). Update both ORCH-004 AC 3 and MAIN-001 AC 4 to point to `orchestrator.newConversation()` as the single cleanup site.

**Resolution:** Applied suggested resolution. `orchestrator.newConversation()` is now specified as the single cleanup site for conversation-end tool config state. Changes applied: `spec.md` FR-81 and FR-88 updated to specify `newConversation()` as the cleanup location; `plan.md` orchestrator section updated with a "Conversation-end cleanup" paragraph documenting that `newConversation()` clears `activeParsedConfigs`, `effectiveToolConfig`, and calls `dispatcher.setEffectiveToolConfig(null)`, and `main.ts` section updated to note it does not perform separate cleanup; `tasks.md` ORCH-004 AC 3 updated to specify `newConversation()` as cleanup site including `dispatcher.setEffectiveToolConfig(null)` call, MAIN-001 AC updated to note cleanup is owned by `orchestrator.newConversation()` not `main.ts`.

---

### RT-6.16: `getMatchedRules()` must include dirty-check lazy-reload

**Status:** Resolved

**Affected task:** RULE-001

**Task RULE-001 AC 1-2 say:**
> "New public method `getMatchedRules(): Promise<VaultRule[]>` added"
> "Method exposes existing `evaluateRules()` logic"

**What the codebase shows:** `evaluateRules()` is a private synchronous method that only evaluates the cached `this.rules` array:

```typescript
// src/rules/vault-rules.ts:318-328
private evaluateRules(): VaultRule[] {
    // ... filters this.rules based on trigger conditions
}
```

The critical lazy-reload guard lives separately in `getActiveRuleContent()`, **not** in `evaluateRules()`:

```typescript
// src/rules/vault-rules.ts:173-177
async getActiveRuleContent(): Promise<string> {
    // Reload rule files if cache is stale
    if (this.dirty) {
        await this.loadRules();
    }
    // ... then calls evaluateRules() at line 181
```

The `dirty` flag is set to `true` when the file watcher detects changes to rule files (via `registerFileWatcher()`). `loadRules()` reads rule files from disk and resets `dirty = false`.

**The problem:** RULE-001 says "exposes existing `evaluateRules()` logic" without mentioning the dirty-check guard. `evaluateRules()` alone does **not** include the dirty check — that's a responsibility of `getActiveRuleContent()`, which wraps `evaluateRules()`.

**Impact:** If an implementer creates `getMatchedRules()` that just calls `this.evaluateRules()`, rule file changes made mid-conversation (e.g., user edits a rule file in another tab) won't be picked up. This breaks the existing behavior where rules are re-evaluated fresh each turn.

**Suggested resolution:** Add AC to RULE-001: "`getMatchedRules()` checks the `dirty` flag and calls `loadRules()` if stale, mirroring the lazy-reload pattern in `getActiveRuleContent()` (lines 174–177), before calling `evaluateRules()`."

**Resolution:** Applied suggested resolution. New AC added to RULE-001 in `tasks.md` specifying that `getMatchedRules()` checks the `dirty` flag and calls `loadRules()` if stale before calling `evaluateRules()`. `plan.md` VaultRuleManager section updated to document the dirty-check lazy-reload pattern in the `getMatchedRules()` contract.

---

## Minor

### RT-6.13: `globalAutoApprove` may include disabled MCP servers

**Status:** Resolved

**Affected task:** MAIN-001

**Task MAIN-001 AC 1 says:**
> "`globalAutoApprove: Record<string, boolean>` built by merging built-in defaults (`settings.auto_approve`) with MCP server-level `autoApprove[]` lists (expanded into namespaced `server__tool` keys)"

**What the codebase shows:** `McpServerConfig` has an optional `disabled?: boolean` field. If MAIN-001 iterates all entries in `settings.mcp_servers` to build `globalAutoApprove`, it would include servers with `disabled === true`. A disabled server's tools are never registered in the tool registry and never appear in `allToolNames`, so including their `autoApprove` entries in `globalAutoApprove` is functionally harmless (they become unused keys), but it is imprecise and could confuse debugging or inspector output.

**Impact:** Low — unused keys in `globalAutoApprove` are ignored by the merger's default fill (it only fills entries for tools in `allToolNames`).

**Suggested resolution:** Add clarifying note to MAIN-001 AC 1: "Disabled servers (`config.disabled === true`) may be skipped when building `globalAutoApprove`, since their tools are never registered. Including them is functionally harmless."

**Resolution:** Applied suggested resolution. Clarifying note added to `tasks.md` MAIN-001 AC 1, `spec.md` FR-80 `globalAutoApprove` description, and `plan.md` orchestrator `resolveEffectiveConfig()` step 3 — all noting that disabled servers may be skipped during `autoApprove[]` expansion since their tools are never registered, and including them is functionally harmless.

---

### RT-6.17: `resolveIncludeNotesIfAvailable()` silently skips without metadataCache

**Status:** Open

**Affected task:** SYS-002

**Task SYS-002 AC 3 says:**
> "The builder iterates each `VaultRule`, resolves includes via `resolveIncludeNotesIfAvailable()`, extracts tool configs, and concatenates stripped content."

**What the codebase shows:** The builder's `resolveIncludeNotesIfAvailable()` silently returns the original text when `metadataCache` is absent:

```typescript
// src/chat/system-prompt.ts:342-344
if (!this.metadataCache) {
    return text;
}
```

Currently, `<include_note>` resolution for rules happens in `VaultRuleManager.getActiveRuleContent()`, which always has `this.app.metadataCache` access (lines 194–201). After SYS-002 migrates this responsibility to the builder, the builder's `metadataCache` is the gating factor. The builder's `metadataCache` is optional (constructor parameter at line 32).

In practice, `main.ts` always passes `metadataCache` when constructing the builder, so this is unlikely to be a problem. But the migration silently changes the failure mode: from "always resolves" (VaultRuleManager path) to "silently skips" (builder path without metadataCache).

**Impact:** If a future code path constructs a `SystemPromptBuilder` without `metadataCache`, rule `<include_note>` tags would silently stop resolving — a silent regression from current behavior.

**Suggested resolution:** Add clarifying note to SYS-002: "The builder must have `metadataCache` set (guaranteed by the current `main.ts` constructor at `getSystemPromptBuilder()`) for rule `<include_note>` resolution to work. Consider adding a warning log if `metadataCache` is absent and rules contain `<include_note>` tags."

---

### RT-6.18: WF-001 extraction after validation means config-only workflows produce empty body

**Status:** Open

**Affected task:** WF-001

**Task WF-001 AC 2 says:**
> "Extraction happens after `<include_note>` resolution (step 2) and validation (step 3), but **before** XML wrapping (step 4)"

**What the codebase shows:** The `assembleWorkflowPrompt()` pipeline at `src/workflows/workflow-executor.ts:258-334`:

```
Step 1 (line 281): Read body via readWorkflowBody()
Step 2 (line 284): Resolve <include_note> tags via resolveWorkflowIncludes()
Step 3 (line 293): Validate non-empty content via validateWorkflowContent()
Step 4 (line 302): Wrap in <workflow_instructions> via wrapWorkflowInstructions()
```

WF-001 inserts extraction between steps 3 and 4 (between lines 299 and 302). This means `validateWorkflowContent()` (step 3) runs on content that **still contains** `<notor_tool_config>` blocks. A workflow whose *entire body* is a `<notor_tool_config>` block and nothing else would:

1. Pass the `<include_note>` resolution step (no includes to resolve)
2. Pass validation (non-empty — the config block counts as content)
3. Have its config block extracted, producing empty `strippedContent`
4. Wrap the empty content in `<workflow_instructions></workflow_instructions>`

The result: an empty workflow instruction block sent to the LLM.

**Impact:** Edge case — a config-only workflow with no prompt content is unusual. But the current validation would not catch it, producing a confusing empty workflow message.

**Suggested resolution:** Either:
- **(a)** Move extraction **before** validation so `validateWorkflowContent()` checks the stripped content — cleaner, preserves existing user experience for empty workflows.
- **(b)** Add AC to WF-001: "If stripped content is empty after extraction, treat as validation failure and abort with the same notice as step 3."

Option (a) is recommended. This would change the insertion point to: "after `<include_note>` resolution (step 2) but **before** validation (step 3)."

---

### RT-6.19: Combined dispatch ordering across DISP-002/003/004 not documented

**Status:** Open

**Affected tasks:** DISP-001, DISP-002, DISP-003, DISP-004

**What the tasks say (separately):**
- DISP-002 AC 1: "Enabled check runs **before** existing mode check in `dispatch()`"
- DISP-003 AC 1: "Path enforcement runs after approve/mode checks, before `tool.execute()`"
- DISP-004 AC 1: "`effectiveToolConfig.tools[toolName]?.auto_approve` is checked as a unified early-return **before** the MCP/built-in branching"

**What the codebase shows:** The current `dispatch()` flow at `src/chat/dispatcher.ts:273-471`:

```
Line 280: Tool lookup
Line 302: Plan/Act mode check
Line 326: fetch_webpage domain denylist
Line 355: execute_command working dir validation
Line 385: Auto-approve resolution (MCP vs built-in branching)
Line 402: User approval request
Line 432: Tool execution
```

**The combined ordering after all DISP tasks would be:**

1. Tool lookup (existing, line 280)
2. **Enabled check** (DISP-002 — new, before Plan/Act at line 302)
3. Plan/Act mode check (existing, line 302)
4. fetch_webpage domain denylist (existing, line 326)
5. execute_command working dir validation (existing, line 355)
6. **Unified auto-approve from effectiveToolConfig** (DISP-004 — new, before line 385)
7. MCP/built-in auto-approve fallback (existing, line 385)
8. User approval request (existing, line 402)
9. **Path enforcement** (DISP-003 — new, after approval, before line 432)
10. Tool execution (existing, line 432)

Each DISP task describes its insertion point relative to existing checks, but the full combined ordering is never shown in one place.

**Impact:** Low — the ordering is logically derivable from the three tasks. But an implementer working on multiple DISP tasks needs to mentally compose the full ordering, which increases the chance of misordering.

**Suggested resolution:** Add a note to DISP-001 (the base task that all others depend on): "After all DISP-00x tasks, the full `dispatch()` check ordering is: lookup → enabled (DISP-002) → Plan/Act → domain/cwd checks → auto-approve (DISP-004 + fallback) → user approval → path enforcement (DISP-003) → execute."
