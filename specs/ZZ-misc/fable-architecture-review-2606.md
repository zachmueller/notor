# Notor Architecture Review — Assessment & Roadmap

**Date:** 2026-06-14
**Verified against:** working tree at HEAD `f7049d0`
**Source documents:** `private/architecture-review-2026-06-11.md` and its companion
`private/architecture-review-2026-06-11-code-map.md` (both git-ignored).

This document does three things: (1) cross-references the source review's findings against the live
code, (2) renders a verdict on each proposed improvement, and (3) re-sequences the work into an
actionable roadmap. **It proposes no code changes** — it is a planning artifact. Implementation is
explicitly deferred.

> **Line-number caveat.** Every `src/…:line` reference below was confirmed by direct reads at HEAD
> `f7049d0`. Line numbers drift; re-locate by symbol name at implementation time, not by line.

---

## 1. Context & method

### Why this exists

The plugin's pitch is "extend me." It is graded against three priorities:

- **P1 — End-user extensibility:** the plugin must be highly extensible by end users.
- **P2 — Maintainability:** the source must stay easy to maintain.
- **P3 — Scaling LLM tool interactions:** the architecture must handle parallel calls, streaming
  tools, nested sub-agents, dynamic tool sets, and multi-turn protocols.

The source review ran a six-agent parallel survey; its code-map companion re-verified every claim and
issued corrections. For this assessment I independently re-verified the **load-bearing** claims (the
ones that gate a recommendation) with three parallel read-only agents against the same commit the
code-map cites. The goal was not to re-survey but to confirm the facts a plan would rest on, and to
catch anything the review *understated* (one thing — see §2, D1).

### Product decisions that shape priority

Three decisions were taken with the maintainer on 2026-06-14; they bend the source review's
sequencing and are recorded in the decision log (§8):

| Key | Decision | Consequence for this plan |
|-----|----------|---------------------------|
| **D-share** | Community / third-party extension sharing **is on the roadmap** (users install extensions authored by others). | Sandboxing (Issue 2.2) and Runtime API versioning (Issue 2.1) are **first-tier safety requirements**, not deferred niceties. Untrusted code with full `app` + `fs`/`crypto`/`path` + shell access and no timeout is a vault-destroyer. |
| **D-compat** | Breaking changes to the extension runtime API are **acceptable with a migration note**. | We freeze the runtime surface **narrow** — replace live-manager handouts (`utils.checkpointManager`, `staleTracker`, `noteOpener`) with thin facades — rather than only adding versioning additively. Freeze narrow; widen later is easy, narrow later is impossible. |
| **D-scope** | The spec covers the **full 6-stage roadmap**. | Every finding is assessed and sequenced, with an effort/risk/priority matrix so a starting slice can be chosen. |

### What's genuinely good (do not break)

The source review is right that the problems are in the *seams*, not the decomposition. Confirmed
strengths to preserve through every refactor below:

- `Tool` interface + single `ToolRegistry` + name-based polymorphic dispatch (no tool-type switch in
  the hot path).
- Pure `evaluateToolPolicy()` over a session-scoped `ToolPolicyContext` — the right shape; the goal is
  to make it the *only* path.
- Tool-config precedence merger (workflow > persona > rule > global; sparse merge; sub-agent
  AND-intersection) — well-tested.
- Session-snapshot isolation per turn + null-safe view routing — multi-panel correctness by
  construction.
- Per-file JSONL write queues; `TaskLaneQueue` per-lane serialization.
- Sucrase + `AsyncFunction` compile pipeline as a single shared chokepoint for all user code.
- Type-only back-imports of `NotorPlugin` — no runtime import cycles anywhere.
- Settings migrations: idempotent, two-phase, crash-safe (though versionless — see Issue 6.1).

---

## 2. Verification summary

All checked against HEAD `f7049d0`. Verdicts: **TRUE** (confirmed as stated), **PARTIAL** (true with a
material caveat), **FALSE** (contradicted).

| # | Claim | Verdict | Note / code site |
|---|-------|---------|------------------|
| 1 | `main.ts` is a god object | **TRUE** | 73 imports, 51 `private _` fields, 28 `getX()` methods + `vaultRootPath` getter |
| 2 | `getDispatcherDeps()` captures `this._personaManager` directly | **TRUE** | `personaManager: this._personaManager` — not a lazy getter; latent stale-ref. [main.ts ~917](../../src/main.ts) |
| 3 | `saveSettings()` ad-hoc propagation if-chain | **TRUE** | 13 if-blocks; ~8 settings-derived components absent from the chain. [main.ts ~1234–1335](../../src/main.ts) |
| 4 | Dual policy path in dispatcher | **TRUE (nuance)** | Pure path `if (policyCtx)` @405; legacy `else` @461–631. **Not dead** — see D1. [dispatcher.ts](../../src/chat/dispatcher.ts) |
| 5 | All `dispatch()` callers pass `policyCtx` | **PARTIAL** | Both *production* callers do; an E2E test (`mcp-auto-approve-test.ts:284`) omits it, and `tool.internal` is a third branch |
| 6 | `ApprovalCallback` → `"approved" \| "rejected"` (no room to grow) | **TRUE** | [dispatcher.ts:68](../../src/chat/dispatcher.ts) |
| 7 | `evaluateToolPolicy()` pure; hard-codes `fetch_webpage` + `execute_command` | **TRUE** | [tool-policy.ts:85](../../src/chat/tool-policy.ts), :120, :146 (the latter is command-pattern matching, not a flat denylist) |
| 8 | Runtime API has no version field; zero `notor-min-api` hits | **TRUE** | repo-wide grep clean; no `apiVersion`/`api.version` either |
| 9 | Bare `AsyncFunction`; real `app` passed first → whitelist decorative | **TRUE** | [compiler.ts:77](../../src/extensions/compiler.ts); [manager.ts:110](../../src/extensions/manager.ts) |
| 10 | `libs` exposes raw node `fs`/`crypto`/`path` | **TRUE** | [runtime-context/types.ts:350–352](../../src/extensions/runtime-context/types.ts) |
| 11 | 5 parallel discovery pipelines; divergent error handling | **TRUE** | sub-agent discovery failures are **log-only**, invisible to the user. [sub-agents/discovery.ts:124](../../src/sub-agents/discovery.ts) |
| 12 | `toOpenAIMessages` char-identical in openai/local except warn string | **TRUE** | no shared module. [openai-provider.ts:54](../../src/providers/openai-provider.ts) / [local-provider.ts:76](../../src/providers/local-provider.ts) |
| 13 | OpenAI/local drop image blocks in tool results; Anthropic/Bedrock preserve | **TRUE** | real behavioral divergence |
| 14 | `use_extended_context` on common `SendMessageOptions`, Bedrock-only read | **TRUE** | [provider.ts:87](../../src/providers/provider.ts); read at bedrock ~411 |
| 15 | `getContextWindow()` silent fallback to 128k, no logging | **TRUE** | [model-metadata.ts:630](../../src/providers/model-metadata.ts) |
| 16 | 42 `setOn*`/`setGet*` setters; single `wireView()`; observers already exist | **TRUE** | `onSessionsChanged`/`setOnPersonaChanged` already return unregister fns. [chat-view.ts:272–574](../../src/ui/chat-view.ts), [wire-view.ts](../../src/ui/wire-view.ts) |
| 17 | Renderer caste system; per-tool diff rendering (write_note/replace_in_note) | **TRUE** | [message-renderer.ts](../../src/ui/message-renderer.ts) (built-in branches 77–588; registry path 810–869) |
| 18 | `toChatMessages()` role switch + repair passes in one function | **TRUE** | switch 271–361; orphan repair 363–436; coalescing 438–521. [message-pipeline.ts](../../src/chat/message-pipeline.ts) |
| 19 | No `schema_version` in JSONL header / checkpoint / memory frontmatter | **TRUE** | all versionless |
| 20 | Fire-and-forget hooks (void IIFE, swallowed errors); approval is lone acting hook | **TRUE** | [orchestrator.ts:1528](../../src/chat/orchestrator.ts); IIFEs at [hook-events.ts:508/625/743](../../src/hooks/hook-events.ts); `dispatchOnApprovalRequired` returns a decision |
| 21 | 7 zero-test dirs | **TRUE** | workflows/, hooks/, personas/, checkpoints/, include-note/, rules/, export/ |

**Net result:** not one load-bearing claim is *wrong*. The code-map's own corrections to the original
review (sub-agent cap is `SUB_AGENT_TOKEN_LIMIT = 0` = unlimited, not "50K hard cap"; `NotorSettings`
is **89 fields** not 469; **42** setters not 46; sub-agent depth-1 is *emergent* from tool
availability, not enforced) all hold. **This spec adopts the code-map's corrected facts throughout.**

### D1 — The one nuance the source review understates

Both source docs frame *"delete the legacy policy path (dispatcher.ts:461–631), make `policyCtx`
mandatory"* as a low-risk **Stage-0 mechanical** win. Verification shows the legacy `else` branch is
**still reachable**, in three ways:

1. **Callers that omit `policyCtx`.** The E2E test `tests/e2e/mcp-auto-approve-test.ts:284` calls
   `dispatcher.dispatch(toolName, {}, "plan", "test-plan-block")` with no `policyCtx`. (The
   `ask-user-test.ts` caller *does* pass it, so behavior is genuinely split across tests.)
2. **The `tool.internal` bypass sits between the two paths.** The control flow is
   `if (policyCtx) {pure} else if (tool.internal) {bypass} else {legacy}` — so internal tools never
   touch either policy path, and the legacy block is the fall-through for everything else.
3. **Any future non-session caller** (a new automation entry point, a script) would land in legacy.

**Assessment:** downgrade this item from "mechanical" to **"small but real."** The correct sequence is
(a) add a tripwire `log.error` in the legacy branch and ship one release to confirm it never fires in
production; (b) port any legacy-only behavior (verify the auto-approve resolution at 539–601 against
`evaluateToolPolicy`) into the pure function *with a test*; (c) reconcile the `tool.internal` bypass —
either fold it into `evaluateToolPolicy` as an explicit short-circuit or keep it as a named pre-check;
(d) update the E2E test to pass a `policyCtx`; (e) *then* delete 461–631. This is the single most
important correction this assessment adds on top of the two source documents.

---

## 3. Per-finding assessment

Verdict legend: **AGREE** (do as the review proposes) · **MODIFY** (do it, but the approach needs a
change) · **RE-PRIORITIZE** (the *what* is right, the *when* changes given D-share/D-compat) ·
**DEFER** (real but low payoff) · **NON-ISSUE** (verified not worth working).

### Theme 1 — `main.ts` god object / composition root

| Issue | Verdict | Recommended action |
|-------|---------|--------------------|
| 1.1 Getter-surface-as-API (28 getters, 3 whole-plugin consumers) | **AGREE** (Stage 3) | Extract `PluginServices` container owning the 51 fields + getters; narrow the 3 consumers (`ExtensionManager`, `wire-view`, `commands`) to interface slices. Do *after* contracts exist so consumers move onto interfaces, not a renamed god object. |
| 1.2 Three inconsistent dependency-flow styles; `_personaManager` stale capture | **AGREE** | **Stage 0:** fix the one-line `personaManager: this._personaManager` → `() => this.getPersonaManager()` (requires making the deps field an accessor). **Stage 3:** collapse the 8 orchestrator setters into one `OrchestratorWiring` constructor arg. |
| 1.3 Init-order races managed by 3 defensive mechanisms | **AGREE** (Stage 3) | Introduce explicit init phases with awaitable barriers (`ready.registries`, `ready.discovery`); view-restore and MCP `onStatusChange` await them; delete the re-sync loop (~637–643) and microtask catch-up (~1175–1177). Keep eager registry creation (~574–578). |
| 1.4 `saveSettings()` 13-block if-chain (8 components absent) | **AGREE** (Stage 3) | Replace with a settings subscription bus: components register `onSettingsChanged(cb)` at construction; `saveSettings()` emits. Migrate the 13 blocks mechanically, then audit the 8 absent components. |
| 1.5 Teardown asymmetry in `onunload()` | **AGREE** (Stage 3) | Either make `onunload` async and `await Promise.race([allDestroys, timeout(2500)])` before Phase 2, or have `SessionManager.destroy()` synchronously snapshot pending JSONL into the per-file write queue. Move timer clearing to the top regardless. |
| 1.6 Three sources of truth for "active orchestrator" | **AGREE** (Stage 3) | Extract `OrchestratorHub` owning the leaf→orchestrator map, focus pointer, and session guard; the focus handler's hidden persona-sync side effect becomes a visible `onFocusChanged` subscriber. |

### Theme 2 — Extensibility: rich surface, no contract

| Issue | Verdict | Recommended action |
|-------|---------|--------------------|
| 2.1 Unversioned runtime API; 50+ frozen members; live managers handed out | **RE-PRIORITIZE → first-tier** (Stage 1) | Add `utils.api = { version: 1 }` + optional `notor-min-api` frontmatter key validated in discovery. **Per D-compat, freeze narrow:** replace `utils.checkpointManager`/`staleTracker`/`noteOpener` (live manager instances) with thin facades (`utils.checkpoints = { create, list, restore }`). Document the frozen surface in `docs/extensions.md` (the `audit-personas-docs` skill keeps it honest). |
| 2.2 No sandboxing; whitelist advisory; `app`+fs+shell+no timeout | **RE-PRIORITIZE → first-tier** (Stage 1b) | Per D-share this is now safety-critical. Phase 1 (cheap): `AbortSignal`-aware execution timeout around both `compiledFn` call sites + a one-time "extensions run with full privileges" acknowledgment + documented capability list. Phase 2 (real isolation): worker-isolated runtime with `utils` proxied across — **only buildable after 2.1's facades exist** (you cannot proxy live manager objects). |
| 2.3 Tools vs automations: divergent invocation/error semantics | **AGREE** | Converge on one invocation context: give automations `abortSignal` (wired to a per-dispatch controller — also addresses 6.2's race) and `ask`/`onProgress` where a conversation exists. Document `__toolError` as tool-only or generalize it. Prerequisite for loop middleware (2.5). |
| 2.4 Five parallel discovery pipelines; sub-agent failures silent | **AGREE** (Stage 1) | Build `discoverVaultContent({ root, layout: "file"\|"directory", recursive, parse, validate, scaffolds })` returning `{ items, errors }`. Migrate in risk order: extensions (best tests) → workflows → personas/sub-agents (parameterize layout — do **not** force one). Unify error aggregation, fixing sub-agents' silent failures for free. Add tests per migration (kills part of 6.4). |
| 2.5 Hooks observe but cannot act (except approval) | **AGREE** (Stage 4) | Generalize the `on_approval_required` acting pattern into `pre_send_transform(ctx) → {message?} \| "pass"` and `on_tool_result_transform(ctx) → {result?} \| "pass"`, dispatched sequentially with per-transform timeouts; keep observe-only triggers untouched. Gate behind a setting. Do *after* Runtime API v1 so the transform context is a stable contract. |
| 2.6 Closed registration seams (providers, blocks, settings sections, context sources) | **AGREE** (Stage 4) | Open in priority order: providers (→ 4.5) → built-in block renderers (→ 5.2) → loop middleware (2.5) → context sources. Same recipe the codebase already uses for chat blocks. |

### Theme 3 — Agent loop rigidity

| Issue | Verdict | Recommended action |
|-------|---------|--------------------|
| 3.1 `toChatMessages()`: 3 responsibilities in one switch | **AGREE** (Stage 2) | Split into pure pipeline steps: `convertRoles(messages, serializers) → repairOrphans → coalesceToolRuns`, where `serializers` is a `Record<Role, (msg) => ChatMessage \| null>` map. 531-line existing test anchors the refactor. Registrable serializer map later lets extension-defined transcript elements avoid editing this file. |
| 3.2 Dual policy path | **MODIFY** (Stage 0.5 — needs audit, **per D1**) | NOT mechanical. Tripwire-log the legacy branch one release → port any legacy-only behavior into `evaluateToolPolicy` with tests → reconcile the `tool.internal` bypass → fix the omitting E2E test → then delete 461–631. |
| 3.3 Per-tool special cases in policy code (`fetch_webpage`, `execute_command`) | **AGREE** | Add optional `policyCheck?(params, settings) => PolicyVerdict` to the `Tool` interface; `evaluateToolPolicy` calls it generically; move the two checks into their tool implementations. The dispatcher copy disappears with 3.2. |
| 3.4 Positional batch scheduling (one unsafe call = barrier) | **AGREE** (Stage 2) | Replace `partitionToolCalls()` with a per-turn readers-writer scheduler keyed on the existing `mode: "read"\|"write"` metadata: reads run concurrently under the cap; a write waits for in-flight reads, runs exclusively, releases. Preserve transcript ordering by call index. Keep `partitionToolCalls` tests as a behavioral baseline. |
| 3.5 Approval protocol can't grow | **AGREE — do the type now** (Stage 0) | Widen to `type ApprovalDecision = { decision: "approved"\|"rejected"\|"timed_out"; modifiedParams?: Record<string, unknown>; message? }`. Mechanical migration (callbacks return `{decision:"approved"}`); dispatcher applies `modifiedParams` over `parameters` when present; hooks keep returning strings, adapted at the boundary. UI grows "modify & approve" whenever — **wire format is the expensive part to change later**, so lock it now. |
| 3.6 Sub-agent budgets/accounting | **MODIFY** (less broken than original review claimed) | The code-map corrected this: token usage *is* rolled into parent totals ([orchestrator.ts:1374](../../src/chat/orchestrator.ts)); cap is unlimited-by-default and overridable. Real gaps: (a) no *proactive* budget — derive a default `tokenLimit` from parent's remaining headroom at launch; (b) make depth explicit — thread a `depth` and refuse `> max` (cheap insurance against a `use_subagent`-in-sub-agent config foot-gun). Defer anything fancier. |
| 3.7 Tool results are final-only | **AGREE** (Stage 2) | Introduce a tool-execution event channel: `execute(params, { emit })` where `emit({ type: "progress"\|"partial-result" })`, defaulting to a wrapper over today's UI-only `onProgress` so existing tools are unchanged. Dispatcher forwards `progress` to UI and digests `partial-result`s into the final `ToolResult`. First-class partial transcript elements only after 3.1's serializer split. |
| 3.8 `workflow-executor` naming | **AGREE** (Stage 0, mechanical) | Rename `workflows/workflow-executor.ts` → `workflows/prompt-assembly.ts`; fix ~2 import sites. Confirmed *not* duplication — `chat/workflow-executor.ts:46` imports `assembleWorkflowPrompt` from it. |

### Theme 4 — Providers

| Issue | Verdict | Recommended action |
|-------|---------|--------------------|
| 4.1 Verbatim-duplicated `toOpenAIMessages`/`toOpenAITools` | **AGREE** (Stage 0, mechanical) | New `src/providers/openai-format.ts` exporting `toOpenAIMessages(messages, { providerLabel })` + `toOpenAITools`; both providers import it. Next increment (Stage 1): extract the ~70% shared core of `toAnthropicMessages`/`toBedrockMessages` into a shared anthropic-format module. |
| 4.2 Hand-maintained capability oracle; silent fallback | **AGREE** (Stage 0 hygiene + Stage 1 structure) | **Stage 0:** normalize the model id once (strip `^(us\|eu\|apac\|global)\.`) before table lookup and pattern matching — 48 geo-duplicated entries collapse, regex alternations vanish; add `log.warn` on `getModelMetadata`/`getContextWindow` fallback (turns silent misclassification into a discoverable event). **Stage 1:** move the data behind `provider.getCapabilities(modelId)` (→ 4.3). |
| 4.3 Capability leakage through common interface | **AGREE** (Stage 1) | Add `getCapabilities(modelId)` + `resolveThinkingConfig(level, modelId)` to `LLMProvider` (the two `thinking-config.ts` functions become provider methods); move `use_extended_context` out of `SendMessageOptions` into Bedrock's provider config; replace the `if (type === "bedrock")` connection-test branch with `provider.validateConnection() → { ok, detail }`. |
| 4.4 Duck-typed Bedrock stream normalization (5 shapes, silent drop) | **AGREE** | Extract `normalizeBedrockThinkingDelta(rawDelta) → StreamChunk \| null` chokepoint; add the missing **fail-loudly** branch: thinking-suggestive keys matching no shape → `log.warn("Unrecognized thinking delta shape", { keys })`. Unit-test the 5 shapes + an unknown. (Relevant to the `bedrock-thinking-wire-shape` memory + `audit-bedrock-thinking` skill.) |
| 4.5 Provider registration closed across 7 files (dual factory sites already drifted) | **AGREE** (Stage 4 open; Stage 1 prep) | Consolidate to a single `ProviderDescriptor = { type, displayName, factory, renderSettingsSection, validateConnection, getCapabilities }` registered in **one** module consumed by both `main.ts` and `registry-factory.ts` (kills the dual sites + dropdown edit; the union type derives from the descriptor list). Then `registerProvider(descriptor)` via the runtime API is a small step — take it once sandboxing/versioning justify third-party providers. |

### Theme 5 — UI

| Issue | Verdict | Recommended action |
|-------|---------|--------------------|
| 5.1 42 hand-wired callback setters; forgotten wire = silent no-op | **AGREE** (Stage 3 territory) | Don't boil the ocean. Split by direction: the ~24 view→app `setOn*` become one typed `ViewActions` interface (`view.setActions(actions)` — a missing handler is a *type error*, not a silent no-op); the ~9 app→view `setGet*` become a `ViewDataSource` interface. Migrate group-by-group (provider/model selection first — 11 setters of pure plumbing). Full event bus optional after. |
| 5.2 Renderer caste system; per-tool diff rendering | **AGREE** (Stage 1) | Migrate built-ins onto `ChatBlockRegistry` static→streaming: diff/approval first (move write_note/replace_in_note diff rendering into per-tool block defs), then tool-call/tool-result, then thinking (needs an optional `onStreamChunk`/`dispose` lifecycle on the registry contract first), then streamed assistant text **last** (the `data-raw` + 100ms debounce machinery). Add `priority`/override to `register()` only when deliberately opening built-in replacement to users. |
| 5.3 Renderer-local message cache (`renderedMessages` map) | **AGREE** | Replace the partially-populated map with a `getMessageById(id)` lookup routed to the conversation manager (via the renderer's existing `deps`); on miss show a Notice instead of silent no-op; delete the map + 3 maintenance sites. |
| 5.4 Settings schema monolith (89 fields — *not* 469) | **DEFER / opportunistic** | Moderate, not urgent. When touched, group fields into namespaced sub-objects (`settings.compaction.*`) one group at a time via the existing two-phase migration machinery; define per-section `{ types, defaults, render }` modules. Worth doing opportunistically, not as a campaign. Unlocks extension-contributed settings sections (2.6). |
| 5.5 Monolithic styles.css (91KB) | **DEFER (lowest payoff)** | If addressed: split into `styles/*.css` by feature + a trivial concat step in `copyPluginAssets()`. Pure mechanics, no risk, low payoff. |

### Theme 6 — Cross-cutting infrastructure

| Issue | Verdict | Recommended action |
|-------|---------|--------------------|
| 6.1 No schema version in any persisted artifact | **AGREE** (Stage 0 — trivial now, impossible to retrofit) | Add `schema_version: 1` to the JSONL conversation header ([history.ts:168](../../src/chat/history.ts)), `Checkpoint` interface + write ([storage.ts:64](../../src/checkpoints/storage.ts), [types.ts:272](../../src/types.ts)), and memory-note frontmatter as `notor-schema: 1` ([note-format.ts:25](../../src/memory/note-format.ts)). Readers default missing → 1. No migration logic until a v2 exists; the field's whole job is making v2 *possible*. |
| 6.2 Fire-and-forget hook dispatch (races + swallowed errors) | **MODIFY** (Stage 0) | Don't make dispatch blocking (a slow hook would stall the turn). Route fire-and-forget hook executions through the existing `TaskLaneQueue` so they serialize, and replace silent `.catch` swallows with `log.error` + a throttled Notice. **Caveat to verify:** lane keying must be conversation-id so independent conversations don't serialize against each other. |
| 6.3 No standardized error channel (4 coexisting strategies; 203 `new Notice`) | **AGREE** (opportunistic) | Small `ErrorReporter` in `utils/`: `report(subsystem, message, { error, notify?, throttleKey? })` → always structured-log, optionally throttled Notice. Adopt at silent-failure sites first (sub-agent discovery, hook dispatch, model-metadata fallback). Keep deliberate null-returns (checkpoints) but route them through `report(..., { notify: false })` so intent is recorded. |
| 6.4 Test coverage anti-correlates with extensibility surfaces (7 zero-test dirs) | **AGREE** | Don't write tests as a standalone campaign — attach them to the migrations that touch each zone (2.4 covers workflows/personas/rules; 6.2 covers hooks). Two exceptions worth doing immediately because the logic is pure and high-stakes: `dispatchOnApprovalRequired` decision precedence and checkpoint create/restore round-trip (restore writes user notes — a regression destroys data). |
| 6.5 Lazy type import marker (`types.ts:851`) | **DEFER** | Fold into the 3.8 rename: when workflow-assembly types get their own home (`workflows/types.ts`), the lazy import disappears. Not worth standalone action. |

### Confirmed non-issues (explicitly **not** worked)

- **`chat/workflow-executor.ts` vs `workflows/workflow-executor.ts` is not duplication** — verified
  delegation (`chat` imports `assembleWorkflowPrompt` from `workflows`). Only the name confuses; the
  3.8 rename fixes that.
- **Sub-agent token accounting is not "invisible"** — it *is* rolled into parent totals. Only the
  *proactive* budget and *explicit* depth cap are real gaps (3.6).
- **Settings migrations are not "version-done-right"** — they're versionless like everything else, but
  the idempotent two-phase *mechanism* is sound and needs no change beyond optionally adding a
  `settings_version` field alongside 6.1.

---

## 4. Re-sequenced roadmap

The source review's Stage 0–4, amended so the **community-sharing safety work (D-share) is promoted**
and the **policy-path deletion is gated (D1)**. No stage is a rewrite; each de-risks the next.

### Stage 0 — Stop the bleeding (small, immediate)
- Share `toOpenAIMessages`/`toOpenAITools` via new `providers/openai-format.ts` (4.1).
- Add `schema_version`/`notor-schema` to JSONL header, checkpoints, memory frontmatter (6.1).
- Model-metadata hygiene: geo-prefix normalization + warn-on-fallback (4.2 Stage-0 half).
- Rename `workflows/workflow-executor.ts` → `prompt-assembly.ts` (3.8).
- Fix the `_personaManager` stale capture in `getDispatcherDeps()` (1.2 one-liner).
- Widen the `ApprovalDecision` type now; UI unchanged (3.5).
- Route fire-and-forget hooks through `TaskLaneQueue` + error surfacing (6.2) — *verify lane keying*.

### Stage 0.5 — Policy-path deletion (needs audit, **per D1**)
- Tripwire-log the legacy dispatcher branch for one release; port legacy-only behavior into
  `evaluateToolPolicy` with tests; reconcile the `tool.internal` bypass; fix the omitting E2E test;
  then delete 461–631 and make `policyCtx` required (3.2). Pairs with `Tool.policyCheck?()` (3.3).

### Stage 1 — Define the contracts (the strategic move; now safety-gated)
- **Runtime API v1** — `utils.api.version`, `notor-min-api` frontmatter key, and **narrow facades**
  replacing live-manager handouts (2.1, enabled by D-compat). The keystone: converts "everything is
  implicitly frozen" into "this is stable, the rest may change."
- **Unified `discoverVaultContent` engine** — migrate extensions → workflows → personas/sub-agents,
  adding tests per migration (2.4, also dents 6.4).
- **Renderer registry for built-in block kinds** (5.2).
- **Provider capability interface** — `getCapabilities()` + `resolveThinkingConfig()`; shrink
  `model-metadata.ts` to data behind it; move `use_extended_context` into Bedrock config (4.2/4.3).

### Stage 1b — Sharing safety (promoted from Stage 4 by D-share)
- Execution timeout around both `compiledFn` call sites + full-privilege acknowledgment + documented
  capability list (2.2 Phase 1 — cheap, do alongside Stage 1).
- Design note (not yet build) for a worker-isolated runtime with proxied `utils` for untrusted
  extensions — only practical *after* Stage 1's facades exist (2.2 Phase 2).

### Stage 2 — Restructure the loop for the next tier of tool complexity (P3)
- Mode-keyed readers-writer scheduler replacing positional batching (3.4).
- Widen approval already done in Stage 0; here, add the UI affordance if desired.
- Tool-execution event channel (progress/partial-result) (3.7).
- Split `toChatMessages()` into pure pipeline steps with a serializer map (3.1).
- Thread token budget + explicit depth to sub-agents (3.6).

### Stage 3 — Decompose the composition root (P2, after contracts exist)
- `PluginServices` container (1.1); explicit init phases with awaitable barriers, deleting the 3
  race-compensation mechanisms (1.3); settings-change subscription bus (1.4); awaited teardown (1.5);
  `OrchestratorHub` (1.6); `OrchestratorWiring` constructor arg (1.2 medium half). Typed
  `ViewActions`/`ViewDataSource` over the 42 setters (5.1).

### Stage 4 — Ecosystem hardening (P1, when sharing is live)
- `ProviderDescriptor` single-registration module → then `registerProvider()` via runtime API (4.5).
- Agent-loop middleware: `pre_send_transform`/`on_tool_result_transform` generalizing the approval
  acting-hook (2.5); converge automation invocation context (2.3).
- Open settings-section + context-source registration (2.6); settings namespacing (5.4); styles split
  (5.5); `ErrorReporter` adoption sweep (6.3).

---

## 5. Effort / risk / priority matrix

Effort: **S** ≤ ½ day · **M** 1–3 days · **L** > 3 days. Risk = chance of regression.

| Issue | Stage | Effort | Risk | Priorities | Notes |
|-------|-------|--------|------|------------|-------|
| 4.1 openai-format | 0 | S | Low | P2 | pure mechanical |
| 6.1 schema_version | 0 | S | Low | P3 | insurance |
| 4.2 metadata hygiene | 0 | S | Low | P2/P3 | test anchored |
| 3.8 rename | 0 | S | Low | P2 | ~2 imports |
| 1.2 stale capture | 0 | S | Low | P2 | latent bug |
| 3.5 widen approval type | 0 | S | Low | P3 | wire-format insurance |
| 6.2 hooks via queue | 0 | M | Med | P2/P3 | verify lane keying |
| 3.2 / 3.3 policy path | 0.5 | M | Med | P2 | **D1 — needs audit + 1 release tripwire** |
| 2.1 Runtime API v1 + facades | 1 | L | Med | P1/P2 | keystone; breaking per D-compat |
| 2.4 discovery engine | 1 | L | Med | P2 | migrate incrementally + tests |
| 5.2 renderer registry | 1 | L | Med-High | P1/P2 | streaming path last |
| 4.3 provider capabilities | 1 | M | Med | P2/P3 | |
| 2.2 timeout + ack | 1b | S | Low | P1 | safety; cheap half of sandboxing |
| 2.2 worker isolation | 1b | L | High | P1 | design note only for now |
| 3.4 RW scheduler | 2 | M | Med | P3 | metadata already exists |
| 3.7 tool event channel | 2 | M | Med | P3 | backward-compatible default |
| 3.1 pipeline split | 2 | M | Med | P3 | 531-line test anchors |
| 3.6 sub-agent budget/depth | 2 | S | Low | P3 | smaller than review claimed |
| 1.1/1.3/1.4/1.5/1.6 root | 3 | L | Med-High | P2 | after contracts |
| 5.1 ViewActions/DataSource | 3 | M | Med | P1/P2 | group-by-group |
| 5.3 renderer cache | 3 | S | Low | P2 | |
| 4.5 ProviderDescriptor | 4 | M | Med | P1/P2 | kills dual factory drift |
| 2.5 loop middleware | 4 | M | Med | P1 | after 2.1 |
| 2.3 automation context | 4 | M | Med | P1 | prereq for 2.5 |
| 6.3 ErrorReporter | 4 | S | Low | P2 | opportunistic |
| 5.4 settings namespacing | defer | M | Low | P1/P2 | opportunistic |
| 5.5 styles split | defer | S | Low | P2 | low payoff |
| 6.4 tests | woven | M | Low | P2 | attach to migrations |

**Suggested first slice:** all of Stage 0 (every item is S except 6.2's M), then Stage 0.5 once the
tripwire release has shipped. Stage 1's Runtime API v1 is the highest-leverage single item but is L —
schedule it as a dedicated effort.

---

## 6. Risk notes on the recommendations themselves

Carried from the source review, plus what verification surfaced:

1. **Renderer-registry migration touches streaming paths** (`appendStreamChunk`'s `data-raw` + 100ms
   debounce, thinking timers). Migrate static blocks first, streamed assistant text last.
2. **Making `policyCtx` mandatory requires the D1 audit.** Both production callers pass it, but the
   `tool.internal` bypass and an E2E test do not — do not delete blind.
3. **Discovery unification will tempt over-abstraction.** Personas/sub-agents are directory-per-item;
   tools/workflows/rules are file-per-item. Parameterize layout; don't force one.
4. **Freezing Runtime API v1 means auditing what `utils` exposes *transitively*.** Any live manager
   still handed out drags its entire public method surface into the freeze. Enumerate it before
   freezing; replace with facades where possible (D-compat permits the break).
5. **Hook dispatch via `TaskLaneQueue` must not serialize independent conversations.** Confirm the
   lane key is conversation-id (or finer), not a single global lane, before routing.
6. **The worker-isolated sandbox (2.2 Phase 2) is unbuildable until 2.1's facades exist** — you cannot
   proxy live manager objects across a worker boundary. Sequencing is load-bearing, not preference.

---

## 7. Non-goals

- **No code changes in this document.** Implementation is deferred to the stages above, each its own
  effort.
- **No re-run of the 6-agent survey.** This assessment verified the load-bearing claims (those gating a
  recommendation), not every claim exhaustively.
- **The confirmed non-issues in §3 are explicitly not worked** (workflow-executor naming beyond the
  rename, sub-agent token accounting, settings migration mechanism).

---

## 8. Decision log

| ID | Date | Decision | Rationale |
|----|------|----------|-----------|
| D-share | 2026-06-14 | Community/third-party extension sharing is on the roadmap. | Promotes sandboxing (2.2) + API versioning (2.1) to first-tier safety work; untrusted full-privilege code is a vault-destroyer. |
| D-compat | 2026-06-14 | Breaking runtime-API changes are acceptable with a migration note. | Enables freezing the surface *narrow* (facades over live managers) — the only freeze that actually constrains the surface. |
| D-scope | 2026-06-14 | Spec covers the full 6-stage roadmap. | Whole-codebase prioritization, not just near-term. |
| D1 | 2026-06-14 | Legacy-policy-path deletion is "small but real," not mechanical. | Verification found the legacy branch reachable via `policyCtx`-omitting callers, the `tool.internal` bypass, and an E2E test. Needs audit + tripwire release before deletion. |

---

*Assessment cross-referenced against HEAD `f7049d0` on 2026-06-14 via three parallel read-only
verification agents over the six review themes. Source documents live in `private/` (git-ignored); this
spec is the actionable, committed companion. Re-locate code references by symbol at implementation time.*
