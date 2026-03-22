# RT-5 — Integration Risks Round 2: Deeper Codebase Scan

**Status:** Open — 11 risks identified, 5 resolved
**Created:** 2026-03-22
**Source:** Full codebase scan against [spec.md](../spec.md) and [plan.md](../plan.md), building on the resolved risks in [RT-4](RT-4-integration-risks.md)

Each risk entry has:
- **Finding** — what the codebase actually does, with file references
- **Conflict** — what the spec or plan assumes
- **Recommendation** — proposed resolution approach

---

## Risk 1 (HIGH) — `persona_auto_approve` three-state type not converted before merger — RESOLVED

**Status:** Resolved (spec amendment)

**Resolution:** `persona_auto_approve` is removed entirely in Phase 4b. The `<notor_tool_config>` `auto_approve` field in persona notes is the sole mechanism for per-persona auto-approve configuration. The `mergeToolConfigs()` signature no longer accepts a `personaAutoApprove` parameter; the default fill order simplifies to `globalAutoApprove[toolName] ?? false`. The three-state conversion is no longer needed.

**Original Finding:**
The plan's `mergeToolConfigs()` accepts `personaAutoApprove: Record<string, boolean>`, but the actual settings type is:

```typescript
// src/settings/types.ts:201
persona_auto_approve: Record<string, Record<string, string>>
```

Outer key = persona name, inner key = tool name, value = `AutoApproveState` (`"global"` | `"approve"` | `"deny"`). This is a nested, three-state structure — not a flat boolean map.

> Relevant files: `src/settings/types.ts` (line 201), `src/personas/auto-approve-resolver.ts` (lines 47-77), plan § `mergeToolConfigs()` signature

---

## Risk 2 (HIGH) — Orchestrator has no direct `ToolRegistry` reference — RESOLVED

**Status:** Resolved (callback signature change)

**Resolution:** The orchestrator's existing `getToolDefinitionsCallback` signature is widened from `() => ToolDefinition[]` to `(config?: EffectiveToolConfig) => ToolDefinition[]`. `main.ts` closes over the registry in the callback: when a config is passed, it delegates to `toolRegistry.getFilteredToolDefinitions(config)`; otherwise it falls back to `toolRegistry.getToolDefinitions()`. This preserves the existing loose coupling (the orchestrator has no direct `ToolRegistry` dependency) while giving it access to filtered tool definitions. The plan and spec are updated to reflect this approach — the orchestrator no longer lists `toolRegistry: ToolRegistry` as an injected dependency.

**Original Finding:**
The plan says the orchestrator calls `toolRegistry.getFilteredToolDefinitions(config)`, but the orchestrator currently has no reference to `ToolRegistry`. Tool definitions arrive via an opaque callback:

```typescript
// src/chat/orchestrator.ts:957
private getToolDefinitionsCallback?: () => ToolDefinition[];

// src/main.ts:1263
orchestrator.setGetToolDefinitions(() => {
    return toolRegistry.getToolDefinitions();
});
```

> Relevant files: `src/chat/orchestrator.ts` (lines 957-968), `src/main.ts` (lines 1263-1265)

---

## Risk 3 (MEDIUM) — Filtered tool definitions must flow to both `assemble()` and `sendMessage()` — RESOLVED

**Status:** Resolved (plan and spec amendment)

**Resolution:** The plan's orchestrator `resolveEffectiveConfig()` step 7 now explicitly states that filtered tool definitions are computed once per iteration via `getToolDefinitionsCallback(config)` and the same filtered array is passed to both `systemPromptBuilder.assemble()` and `provider.sendMessage()`. The spec's FR-81 is updated to clarify that filtered tool definitions flow to both system prompt assembly and the provider call. This single-computation-dual-use pattern ensures the system prompt only documents tools the LLM can actually call.

**Original Finding:**
The same `toolDefinitions` array flows to two consumers inside `responseLoop()`:

1. `systemPromptBuilder.assemble(mode, toolDefinitions, ...)` — builds tool documentation in the system prompt (line ~1143)
2. `provider.sendMessage(chatMessages, toolDefinitions, ...)` — the actual tool list sent to the LLM (line ~1197)

> Relevant files: `src/chat/orchestrator.ts` (lines 1143, 1197)

---

## Risk 4 (MEDIUM) — `responseLoop()` receives `toolDefinitions` as a parameter, not per-iteration — RESOLVED

**Status:** Resolved (plan and spec amendment)

**Resolution:** The `toolDefinitions` parameter is removed from `responseLoop()`, `handleUserMessage()`, and `executeWorkflow()`. Tool definitions are no longer captured once and threaded through — they are computed fresh inside the `responseLoop()` while-loop body on each iteration, immediately after `resolveEffectiveConfig()` runs. The orchestrator calls `getToolDefinitionsCallback(effectiveConfig)` per iteration, and the same filtered array flows to both `systemPromptBuilder.assemble()` and `provider.sendMessage()`. Callers of `responseLoop()` (`handleUserMessage()`, `executeWorkflow()`, `_backgroundResponseLoop()`) no longer pass or capture `toolDefinitions`. The plan's orchestrator section and spec FR-81 are updated to reflect this change.

**Original Finding:**
```typescript
// src/chat/orchestrator.ts:1116-1118
private async responseLoop(
    toolDefinitions: ToolDefinition[],
    mode: ConversationMode
): Promise<void> {
```

Tool definitions are passed in once at loop entry and reused for every LLM call within the loop. The same pattern exists in `handleUserMessage()` (line 988) and `executeWorkflow()` (line 474), which capture `toolDefinitions` once and pass them to `responseLoop()`.

> Relevant files: `src/chat/orchestrator.ts` (lines 474, 988, 1116-1118, 1143, 1197)

---

## Risk 5 (MEDIUM) — `<include_note>` resolution ownership transfer leaves dual code paths — RESOLVED

**Status:** Resolved (plan amendment)

**Resolution:** `getActiveRuleContent()` is deprecated outright in Phase 4b. All orchestrator call sites (`responseLoop` at line 1132, `_backgroundResponseLoop` at line 728) migrate to `getMatchedRules()` so the builder can process each rule individually (per-file `<include_note>` resolution + per-file tool config extraction with source attribution). No code path in Phase 4b calls `getActiveRuleContent()`, eliminating the dual-path risk where `<notor_tool_config>` blocks embedded via `<include_note>` would survive unextracted. The plan's backward-compatibility language for `getActiveRuleContent()` is replaced with an explicit deprecation statement. This resolution also addresses the background workflow aspect of Risk 8.

**Original Finding:**
Currently, `getActiveRuleContent()` resolves `<include_note>` tags internally for each matched rule:

```typescript
// src/rules/vault-rules.ts:194-200 (inside getActiveRuleContent)
const resolved = await resolveIncludeNotes(
    rule.content, vault, metadataCache, rule.file_path, "vault_rule"
);
```

RT-4 Risk 3 resolved this by introducing `getMatchedRules()` returning raw `VaultRule[]`, with the builder taking over include resolution. The plan says `getActiveRuleContent()` "remains available for backward compatibility."

> Relevant files: `src/rules/vault-rules.ts` (lines 173-223)

---

## Risk 6 (MEDIUM) — Parser needs MCP server config for FR-82 inactive-server Notice

**Finding:**
FR-82 requires: if an unrecognized tool name matches a configured-but-inactive MCP server, emit a specific Notice ("MCP server 'X' is not currently enabled") rather than a generic "tool not found" message.

The plan's `extractToolConfigs()` signature is:
```typescript
function extractToolConfigs(
    text: string,
    source: ParsedToolConfig["source"],
    sourceFile: string,
): { strippedContent: string; configs: ParsedToolConfig[] }
```

No MCP server configuration is passed in.

> Relevant files: plan § `src/tool-config/parser.ts`, spec FR-82

**Conflict:**
The parser cannot distinguish between a completely unknown tool name and a tool belonging to a known-but-disabled MCP server without access to MCP configuration.

**Recommendation:**
Either (a) add a `registeredToolNames: string[]` and `configuredMcpServerNames: string[]` parameter to `extractToolConfigs()` so validation can distinguish the two cases inline, or (b) split validation out of the parser entirely — have the parser skip validation of tool names and defer it to a separate validation pass in the orchestrator where MCP config is accessible. Option (b) keeps the parser pure and testable.

---

## Risk 7 (MEDIUM) — MCP auto-approve code path in dispatcher also needs `effectiveToolConfig` bypass

**Finding:**
The dispatcher has two separate auto-approve resolution paths:

```typescript
// src/chat/dispatcher.ts:382-425
if (isMcpTool(toolName)) {
    // calls resolveMcpAutoApprove() — persona override → server autoApprove[] → false
} else {
    // calls resolveAutoApprove() — persona override → global setting
}
```

> Relevant files: `src/chat/dispatcher.ts` (lines 382-425)

**Conflict:**
The plan says: "the dispatcher does not need to consult `resolveAutoApprove()` at all when `effectiveToolConfig` is active." This only explicitly mentions the built-in path. The MCP path through `resolveMcpAutoApprove()` is a separate branch that must also be bypassed, or MCP tools will ignore the merged `auto_approve` from `effectiveToolConfig`.

**Recommendation:**
In the dispatcher modification, check `effectiveToolConfig.tools[toolName]?.auto_approve` **before** the MCP/built-in branching logic, as a unified early-return. This ensures both tool types use the merged config when active. The existing MCP/built-in branching remains as the fallback when `effectiveToolConfig` is null.

---

## Risk 8 (MEDIUM) — Background workflow execution path also needs `toolConfigs` extraction

**Finding:**
`assembleWorkflowPrompt()` results are consumed in at least two distinct code paths in the orchestrator:

1. `executeWorkflow()` (line ~379) — foreground workflow execution
2. Background execution (line ~536) — background workflow with `_backgroundResponseLoop()`

Both paths call `assembleWorkflowPrompt()` and use the result. Background execution has its own response loop that builds tool definitions independently (line ~644).

> Relevant files: `src/chat/orchestrator.ts` (lines ~379, ~536, ~644)

**Conflict:**
The plan's workflow integration discussion only covers the foreground `executeWorkflow()` path. The background path also needs to feed `WorkflowAssemblyResult.toolConfigs` into `resolveEffectiveConfig()` and use filtered tool definitions.

**Recommendation:**
Ensure `_backgroundResponseLoop()` also calls `resolveEffectiveConfig()` before each provider call, using the workflow's `toolConfigs` from the assembly result. The same pattern applied to the foreground loop should be mirrored in the background loop.

---

## Risk 9 (LOW) — `parseYAML` from `obsidian` is unused and untested in this codebase

**Finding:**
Zero hits for `parseYAML` across all TypeScript files. The only YAML parsing today is:
- A hand-rolled `parseSimpleYaml()` in `src/rules/vault-rules.ts` for rule frontmatter
- Obsidian's `metadataCache` for note frontmatter

No `js-yaml` import exists either.

> Relevant files: `src/rules/vault-rules.ts` (lines 440-467)

**Conflict:**
The plan assumes `parseYAML` from `obsidian` is a known quantity. While it's a real Obsidian export, its edge-case behavior (empty input → `null`, bare scalars → scalar value, arrays → array) has never been exercised in this codebase. RT-4 Risk 8 added a type guard, but the guard's correctness depends on assumptions about `parseYAML`'s return values that haven't been tested here.

**Recommendation:**
Write targeted unit tests for `parseYAML` edge cases before relying on it: `null` input, empty string, bare scalar (`"hello"`), array-at-root (`[1, 2]`), valid object, and structurally invalid YAML. Confirm the type guard from RT-4 Risk 8 fires correctly for each non-object case.

---

## Risk 10 (LOW) — Dispatcher maintains a separate tool map from ToolRegistry

**Finding:**
The dispatcher has its own internal tool map maintained via `registerTool()`/`unregisterTool()`, independent of `ToolRegistry`. When MCP tools connect/disconnect, both are updated:

```typescript
// src/main.ts:629-630
toolRegistry.register(registeredTool);
toolDispatcher.registerTool(registeredTool);
```

> Relevant files: `src/main.ts` (lines 629-630, 641-652), `src/chat/dispatcher.ts`

**Conflict:**
The plan adds `getFilteredToolDefinitions()` to `ToolRegistry` (controls what the LLM sees) and an enabled check in `dispatch()` (safety net). These are two independent enforcement mechanisms that could diverge. A tool disabled in `EffectiveToolConfig` would be excluded from the LLM's tool list (registry filtering) AND blocked at dispatch time (dispatcher check). If either mechanism has a bug, the other catches it — which is good. But it also means the dispatcher's tool map always contains all tools regardless of `effectiveToolConfig`, which could be confusing during debugging.

**Recommendation:**
No code change needed, but add a comment in the dispatcher's enabled check clarifying the dual-enforcement design: registry filtering prevents the LLM from seeing disabled tools, dispatcher check is a defense-in-depth safety net for hallucinated tool calls.

---

## Risk 11 (LOW) — System prompt token ceiling interacts with stripped content

**Finding:**
`SystemPromptBuilder` truncates the final system prompt if it exceeds `MAX_SYSTEM_PROMPT_TOKENS` (8000):

```typescript
// src/chat/system-prompt.ts:132-143
const tokenEstimate = estimateTokenCount(fullPrompt);
if (tokenEstimate > MAX_SYSTEM_PROMPT_TOKENS) { /* truncate */ }
```

> Relevant files: `src/chat/system-prompt.ts` (lines 132-143)

**Conflict:**
No functional conflict — stripping `<notor_tool_config>` blocks before assembly is a net positive (less content = less likely to hit the ceiling). However, if a persona prompt is dominated by a large `<notor_tool_config>` block with minimal actual prose, stripping could result in a surprisingly short persona section. Additionally, if the tool config blocks are large enough to push the prompt over the ceiling *before* stripping, but the builder receives pre-stripped content, the ceiling is never hit — which is correct behavior.

**Recommendation:**
No action needed. Informational only — the stripping happens before `assemble()` receives the content, so the ceiling check operates on the final content correctly.

---

## Summary Table

| # | Risk | Severity | Status |
|---|------|----------|--------|
| 1 | `persona_auto_approve` three-state → boolean conversion unstated | HIGH | Resolved (removed) |
| 2 | Orchestrator lacks direct `ToolRegistry` reference | HIGH | Resolved (callback) |
| 3 | Filtered tool defs must go to both `assemble()` and `sendMessage()` | MEDIUM | Resolved (plan+spec) |
| 4 | `toolDefinitions` captured once at loop entry, not per-iteration | MEDIUM | Resolved (plan+spec) |
| 5 | `<include_note>` resolution ownership leaves dual code paths | MEDIUM | Resolved (plan amendment) |
| 6 | Parser needs MCP server config for FR-82 inactive-server Notice | MEDIUM | Open |
| 7 | MCP auto-approve path needs `effectiveToolConfig` bypass too | MEDIUM | Open |
| 8 | Background workflow path needs `toolConfigs` extraction | MEDIUM | Open |
| 9 | `parseYAML` unused and untested in codebase | LOW | Open |
| 10 | Dispatcher maintains separate tool map from ToolRegistry | LOW | Open |
| 11 | System prompt token ceiling interaction with stripped content | LOW | Open |
