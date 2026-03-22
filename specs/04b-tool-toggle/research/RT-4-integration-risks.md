# RT-4 — Integration Risks: Phase 4b vs. Current Codebase

**Status:** Open — working through resolutions iteratively
**Created:** 2026-03-22
**Source:** Codebase scan against [spec.md](../spec.md) and [plan.md](../plan.md)

Each risk entry has:
- **Finding** — what the codebase actually does, with file references
- **Conflict** — what the spec or plan assumes
- **Options** — concrete resolution approaches to choose from
- **Resolution** — filled in as we work through each item

---

## Risk 1 (HIGH) — Tool definitions captured once per send, not once per LLM call

**Finding:**
`main.ts:setOnSendMessage` captures `toolRegistry.getToolDefinitions()` once at message-send time and passes the resulting array to `orchestrator.handleUserMessage(content, toolDefinitions, ...)`. The orchestrator stores this array and reuses it for every `provider.sendMessage()` call inside its `responseLoop()`. `main.ts` does not participate in the per-loop LLM calls at all.

> Relevant files: `src/main.ts` (`setOnSendMessage`), `src/chat/orchestrator.ts` (`handleUserMessage`, `responseLoop`)

**Conflict:**
The plan states: "`resolveEffectiveConfig()` runs in `main.ts` before each LLM call." Spec clarification Q5 requires that `EffectiveToolConfig` is recomputed before each LLM call so dynamic rule activation/deactivation is reflected. The current architecture does not support this without changes to the orchestrator.

**Options:**

A. Move `resolveEffectiveConfig()` into `ChatOrchestrator`. The orchestrator already re-calls `systemPromptBuilder.assemble()` on each loop iteration; it can call `resolveEffectiveConfig()` at the same point and pass filtered tool defs to the provider.

B. Give the orchestrator a `getFilteredToolDefinitions: () => ToolDefinition[]` callback, injected from `main.ts`, so the orchestrator calls it fresh on each loop iteration without owning the resolution logic.

C. Relax the per-loop recomputation requirement: accept that rule-based tool config changes take effect on the next user message, not mid-loop. This weakens the spec clarification Q5 contract but significantly simplifies the integration.

**Resolution:** _Open_

---

## Risk 2 (HIGH) — `resolveEffectiveConfig()` in `main.ts` can't reach `assemble()` output

**Finding:**
`SystemPromptBuilder.assemble()` is called inside `ChatOrchestrator` at two points (~line 734 for the initial call, and again ~line 1135+ per tool-result loop iteration for fresh auto-context). `main.ts` constructs the orchestrator and passes the builder to it, but never calls `assemble()` directly. There is no existing path for the orchestrator to surface `personaToolConfigs` upward to `main.ts`.

> Relevant files: `src/main.ts`, `src/chat/orchestrator.ts` (`responseLoop`, ~lines 734, 1135)

**Conflict:**
The plan says: "Add a `resolveEffectiveConfig()` helper [to `main.ts`] that collects `personaToolConfigs` from `SystemPromptBuilder.assemble()` result." This requires `main.ts` to observe the output of a call that only the orchestrator makes.

**Options:**

A. Move `resolveEffectiveConfig()` into `ChatOrchestrator` (same fix as Risk 1 Option A). The orchestrator already has all the ingredients: it calls `assemble()`, holds the rule manager, and knows the active persona.

B. Add an observer/callback on the orchestrator: `onPersonaToolConfigsExtracted: (configs: ParsedToolConfig[]) => void`. The orchestrator fires this immediately after each `assemble()` call; `main.ts` registers a handler that feeds into `resolveEffectiveConfig()`.

C. Change `SystemPromptBuilder.assemble()` return type as the plan describes, but collect and forward `personaToolConfigs` through the orchestrator's existing return/event surface rather than back to `main.ts`.

**Resolution:** _Open_

---

## Risk 3 (HIGH) — No per-rule activation state; `getActiveRuleToolConfigs()` can't be implemented as described

**Finding:**
`VaultRule` struct has fields: `file_path`, `content`, `always_include`, `directory_include`, `tag_include` — no activation flag. Rule activation is evaluated dynamically each time `getActiveRuleContent()` runs, via `evaluateRules()`. `loadRuleFile()` executes when the cache goes dirty (vault change), not per-message. Tool configs attached to `VaultRule` at load time would belong to all loaded rules regardless of activation state.

> Relevant files: `src/rules/vault-rules.ts` (`VaultRule` struct, `loadRuleFile()`, `getActiveRuleContent()`, `evaluateRules()`)

**Conflict:**
The plan says: "Add public method: `getActiveRuleToolConfigs(): ParsedToolConfig[]` — returns all `ParsedToolConfig` objects from currently active rules." This requires knowing which rules are currently active, which is not tracked on the `VaultRule` struct.

**Options:**

A. Fold rule tool config extraction directly into `getActiveRuleContent()`'s existing loop. Extract and strip tool configs from each active rule's resolved content in the same pass that builds the combined rule text. Return both as a new `RuleContentResult { content: string; toolConfigs: ParsedToolConfig[] }` type instead of a plain string.

B. Track activation state: update `VaultRule` with an `isActive: boolean` field set by `evaluateRules()`, then `getActiveRuleToolConfigs()` filters `this.rules` where `isActive === true`.

C. Extract and cache `toolConfigs: ParsedToolConfig[]` at `loadRuleFile()` time (per-file), then in `getActiveRuleToolConfigs()` re-run trigger evaluation against the current `accessedNotes` to determine which rules are active at call time.

**Resolution:** _Open_

---

## Risk 4 (HIGH) — MCP per-server `autoApprove[]` lists silently discarded when `effectiveToolConfig` is active

**Finding:**
The dispatcher has two separate auto-approve resolution paths: `resolveAutoApprove()` for built-in tools (reads `settings.auto_approve` and `settings.persona_auto_approve`) and `resolveMcpAutoApprove()` for MCP tools (reads `McpServerConfig.autoApprove: string[]` stored per-server). The `mergeToolConfigs()` signature in the plan accepts `globalAutoApprove: Record<string, boolean>` and `personaAutoApprove: Record<string, boolean>` — there is no parameter for MCP server-level auto-approve lists.

> Relevant files: `src/personas/auto-approve-resolver.ts` (`resolveMcpAutoApprove`), `src/chat/dispatcher.ts` (~line 387), `src/tool-config/merger.ts` (new)

**Conflict:**
The plan says: "the dispatcher does not need to consult `resolveAutoApprove()` at all when `effectiveToolConfig` is active." This shortcut bypasses `resolveMcpAutoApprove()` too, silently dropping all user-configured MCP server auto-approve lists.

**Options:**

A. Add a third parameter to `mergeToolConfigs()`: `mcpAutoApprove: Record<string, boolean>` (keyed by namespaced tool name, pre-flattened from all `McpServerConfig.autoApprove` arrays by `main.ts`/orchestrator before calling merge). Default fill order becomes: `personaAutoApprove → mcpAutoApprove → globalAutoApprove → false`.

B. Pre-compute a single unified `globalAutoApprove` map in `main.ts`/orchestrator that merges built-in global defaults AND MCP server auto-approve lists before passing to `mergeToolConfigs()`. `mergeToolConfigs()` signature stays as-is; MCP auto-approve is baked into the `globalAutoApprove` input.

C. Keep `resolveMcpAutoApprove()` active in the dispatcher even when `effectiveToolConfig` is set — only bypass `resolveAutoApprove()` for built-ins. This requires conditional branching in the dispatcher's approve resolution path.

**Resolution:** _Open_

---

## Risk 5 (MEDIUM) — `Conversation` is a DB-persisted entity; `activeParsedConfigs` can't be added directly

**Finding:**
`Conversation` in `src/types.ts` maps to a database-stored row with serializable fields only. Adding a runtime-only `activeParsedConfigs: ParsedToolConfig[]` field would either corrupt the DB schema (if the field name collides with a column) or be silently dropped on serialize/deserialize. There is no existing "runtime conversation state" wrapper object that shadows the persisted `Conversation`.

> Relevant files: `src/types.ts` (`Conversation` interface), `src/chat/orchestrator.ts`

**Conflict:**
The spec (FR-88) and plan say: "stored on the conversation context object as `activeParsedConfigs: ParsedToolConfig[]`, updated whenever `EffectiveToolConfig` is recomputed." The live inspector reads this field for source attribution.

**Options:**

A. Add a runtime-only state container to `ChatOrchestrator` (e.g., `private runtimeState: { activeParsedConfigs: ParsedToolConfig[]; effectiveToolConfig: EffectiveToolConfig | null }`). The orchestrator owns this state; the inspector receives a reference or subscribes via a callback. The `Conversation` DB type is untouched.

B. Add a `ConversationRuntimeState` interface to `src/types.ts` (clearly marked as non-persisted) and maintain a `Map<conversationId, ConversationRuntimeState>` in the plugin or orchestrator.

C. Store `activeParsedConfigs` directly in the orchestrator as a flat field (no container struct), cleared on conversation end. Simplest, but less structured.

**Resolution:** _Open_

---

## Risk 6 (MEDIUM) — Workflow body extraction is more invasive than the plan states

**Finding:**
`assembleWorkflowPrompt()` is a standalone exported `async function` (not a class method). Its pipeline:
1. Read body (strip frontmatter)
2. Resolve `<include_note>` tags
3. Validate non-empty
4. **Wrap in `<workflow_instructions>` XML** ← resolved body disappears into `assembledMessage` here
5. Build trigger context block
6. Build attachments block
7. Compose final `assembledMessage`

After step 4, the resolved body is embedded in XML and becomes part of the string that goes to the LLM. There is no separate handle on the raw body after step 4.

> Relevant files: `src/workflows/workflow-executor.ts` (`assembleWorkflowPrompt`, steps 2–4)

**Conflict:**
The plan says: "pipe the resolved body through `extractToolConfigs()`. Use `strippedContent` as the workflow body." This implies extraction is a simple pipeline step added after include resolution. In reality, extraction must be inserted between steps 2 and 4 inside `assembleWorkflowPrompt()`, modifying the function's internal flow.

**Options:**

A. Insert `extractToolConfigs()` call inside `assembleWorkflowPrompt()` between include resolution (step 2) and XML wrapping (step 4). Capture `strippedContent` from the result; pass `strippedContent` to the XML wrapper instead of the raw resolved body. Include `configs` in `WorkflowAssemblyResult`.

B. Run `extractToolConfigs()` in a pre-pass before calling `assembleWorkflowPrompt()`, operating directly on the raw file content before includes are resolved. This breaks the spec's ordering requirement (`<include_note>` must resolve first).

C. Run `extractToolConfigs()` as a post-pass on `assembledMessage` after `assembleWorkflowPrompt()` returns, extracting and stripping from the full XML-wrapped message. Technically works but requires the regex to handle content inside `<workflow_instructions>` tags and is fragile.

**Resolution:** _Open_

---

## Risk 7 (MEDIUM) — `WorkflowAssemblyResult.toolConfig: ParsedToolConfig | null` wrong for multi-block files

**Finding:**
FR-78 explicitly allows multiple `<notor_tool_config>` blocks per file with document-order merge. `extractToolConfigs()` returns `ParsedToolConfig[]` (one entry per block). The plan's `WorkflowAssemblyResult` has field `toolConfig: ParsedToolConfig | null` (singular), and the plan says "attach `configs[0]`" — which silently ignores all blocks after the first.

> Relevant files: `src/types.ts` (`WorkflowAssemblyResult`), `src/workflows/workflow-executor.ts`

**Conflict:**
The plan implies within-file merging is done before attaching to `WorkflowAssemblyResult`, but `extractToolConfigs()` does not do within-file merging — that is the merger's responsibility.

**Options:**

A. Change `WorkflowAssemblyResult.toolConfig` to `toolConfigs: ParsedToolConfig[]` (plural). Pass the full array from `extractToolConfigs()` directly. The caller (`resolveEffectiveConfig()`) feeds all items into `mergeToolConfigs()` which handles document-order merge natively.

B. Perform a within-file pre-merge inside `assembleWorkflowPrompt()` using `mergeToolConfigs()` with a synthetic single-source call, and store the result as `toolConfig: ParsedToolConfig | null`. Adds merge logic into the workflow executor where it otherwise doesn't belong.

C. Extend `extractToolConfigs()` to return a single `ParsedToolConfig | null` (pre-merging blocks within the file), making the result singular everywhere. The per-block `documentPosition` ordering is handled internally. This is a different API shape than the current plan but self-contained.

**Resolution:** _Open_

---

## Risk 8 (MEDIUM) — `parseYAML` (Obsidian) may return `undefined`/non-object without throwing

**Finding:**
Obsidian's `parseYAML` wraps `js-yaml`. Known behavior: returns `null` or `undefined` for empty/null input without throwing; throws `YAMLException` for structurally invalid YAML; returns the parsed value without throwing for valid YAML with a non-object root (e.g., a bare string `"hello"` or a list `[1, 2, 3]`). The plan's parser uses a `try/catch` to detect YAML errors, which will not catch the non-throwing non-object case.

> Relevant files: `src/tool-config/parser.ts` (new)

**Conflict:**
The plan says: "verify it throws rather than returning `undefined` on invalid YAML, so the `try/catch` catches it correctly." This is partially wrong — the `try/catch` catches structural errors but not wrong-type returns.

**Options:**

A. After `parseYAML()`, add an explicit type guard: `if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) { /* emit Notice, skip block */ }`. This handles all non-throwing non-object cases.

B. Wrap the result in a schema validator (e.g., a hand-written check that the top-level value is a plain object) before iterating its keys. Emit a Notice on failure.

C. Use `js-yaml.load()` directly (available in the Obsidian bundler environment) instead of `parseYAML`, since its behavior under edge inputs is better documented in the js-yaml source. Add both `try/catch` and type guard.

**Resolution:** _Open_ — Option A is the minimal fix and should be added to the parser spec regardless of which YAML function is used.

---

## Risk 9 (MEDIUM) — Pre-flight inspector cannot evaluate `tag_include` rules from typed prompt text

**Finding:**
`VaultRuleManager.ruleMatches()` evaluates three trigger types:
- `always_include: true` → always matches
- `directory_include` → prefix-match on paths in `accessedNotes` (a `Set<string>` of vault paths)
- `tag_include` → checks MetadataCache for notes with that tag in `accessedNotes`

The `tag_include` trigger requires MetadataCache lookups on real vault note files. A typed prompt string cannot be mapped to a set of tagged notes.

> Relevant files: `src/rules/vault-rules.ts` (`ruleMatches()`), `src/ui/effective-config-inspector.ts` (new)

**Conflict:**
The plan says: "a thin adapter in the inspector will map the typed prompt into a synthetic accessed-notes set (e.g., extract note path mentions)." Extracting path mentions covers `directory_include` but `tag_include` rules will always evaluate as inactive, silently under-representing rule configs in the inspector.

**Options:**

A. Document `tag_include` as a known limitation in the pre-flight inspector UI. Show a notice: "Tag-based rules cannot be pre-evaluated — start a conversation to see their effect." Add this limitation to FR-88's acceptance criteria.

B. Add a "Simulated accessed notes" multi-picker to the pre-flight inspector UI. Users select vault notes directly; the inspector evaluates `tag_include` triggers using those notes' actual tags via MetadataCache. More accurate but more complex UI.

C. In the pre-flight inspector, show all rules that have `tag_include` triggers as "conditionally active — depends on accessed notes" with their tool config displayed but visually distinguished. Users can see what would apply if those rules triggered, without false certainty about whether they will.

**Resolution:** _Open_

---

## Risk 10 (LOW) — `ToolDispatcher` has no `vaultRootPath`; injection point undefined

**Finding:**
`ToolDispatcher` constructor currently takes no vault root path parameter. Per-tool path validation is handled inside each tool's own `execute()` method using the tool's reference to `app.vault`. The path utilities (`resolveAndValidatePath`, `isPathWithin`) take an explicit `vaultRoot: string` parameter.

> Relevant files: `src/chat/dispatcher.ts` (constructor), `src/main.ts` (`getToolDispatcher()`), `src/utils/path-validation.ts`

**Conflict:**
The plan adds `this.vaultRootPath` to the dispatcher for use in `enforcePathConstraints()`, but doesn't specify how or when this value is injected.

**Options:**

A. Add `vaultRootPath: string` as a constructor parameter on `ToolDispatcher`. Inject `app.vault.adapter.getBasePath()` (or equivalent) from `main.ts:getToolDispatcher()` at construction time.

B. Add a `setVaultRootPath(path: string): void` method on `ToolDispatcher` (matching the pattern of `setAutoApprove()`, `setPersonaAutoApprove()` already present). Call it from `main.ts` immediately after dispatcher construction.

C. Pass `vaultRootPath` as a parameter to `enforcePathConstraints()` at call time (retrieved fresh from the plugin on each dispatch). Avoids adding state to the dispatcher.

**Resolution:** _Open_ — Option B matches existing initialization patterns in the dispatcher.

---

## Working Through Resolutions

Use this section to record agreed resolutions as we work through each risk. Update the **Resolution** field on each risk entry above when resolved.

| # | Risk | Severity | Resolution |
|---|---|---|---|
| 1 | Tool defs captured once per send | HIGH | _Open_ |
| 2 | `resolveEffectiveConfig()` placement | HIGH | _Open_ |
| 3 | No per-rule activation state | HIGH | _Open_ |
| 4 | MCP `autoApprove[]` discarded | HIGH | _Open_ |
| 5 | `Conversation` is DB-persisted | MEDIUM | _Open_ |
| 6 | Workflow extraction invasiveness | MEDIUM | _Open_ |
| 7 | `toolConfig` singular vs. multi-block | MEDIUM | _Open_ |
| 8 | `parseYAML` non-throwing edge cases | MEDIUM | _Open_ |
| 9 | `tag_include` unevaluable in pre-flight | MEDIUM | _Open_ |
| 10 | `vaultRootPath` injection undefined | LOW | _Open_ |
