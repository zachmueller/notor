# F2 — Reconcile the two tool-policy engines, then delete the legacy branch (CRITICAL)

**Status:** Ready to implement
**Source review:** `private/architecture-review-2026-07-01.md` §F2 (git-ignored)
**Prior art:** `specs/ZZ-misc/arch-review-june-2026/stage-0-implementation-plan.md` item 8 planned this
as "prove legacy unreachable, then delete." **That plan's premise is now false** — verification at
`c0d21e9` shows the legacy branch is load-bearing for every headless context AND each path has a
feature the other lacks. Reconcile first; the June deletion sequence then applies.
**Code verified against:** HEAD `c0d21e9`, re-verified by direct read on 2026-07-01/02.
**Effort:** M (~2–3 days incl. tests), plus a release-gated deletion trailing one release.

> **Line-number caveat.** Re-locate by symbol name at implementation time. Note the review text cited
> `src/chat/run-loop.ts`; the actual path is **`src/run-loop/run-loop.ts`**.

---

## 1. Problem statement

`ToolDispatcher.dispatch()` (`src/chat/dispatcher.ts`) forks at :443–447: with a `policyCtx` it uses the
pure `evaluateToolPolicy()` (`src/chat/tool-policy.ts:85`); without one it runs a **182-line legacy
inline branch** (dispatcher.ts:507–688, plus the `tool.internal` bypass else-if at :503–506). Verified
reality:

- **Who runs which engine:**
  - Foreground chat → **pure** (`orchestrator.ts:1575–1580` builds ctx via
    `session.buildPolicyContext`, `conversation-session.ts:144–156`) — *but falls to legacy on mobile*,
    where `getVaultRootPath()` returns undefined (`orchestrator.ts:1818–1821`).
  - Background workflows (hook-triggered + step→workflow `invoke_workflow`) → **pure**
    (`workflow-executor.ts:1093–1098, 1107–1119`) — same mobile fallback. *(The review said foreground
    chat was the only pure-path context; that is wrong — but the substance stands.)*
  - Sub-agents → **legacy** (RunLoop `dispatchBatches` sub-agent branch, `run-loop.ts:356–365`, 5
    positional args, no policyCtx).
  - Orchestration conversation steps → **legacy** (`run-loop.ts:366–385`, explicit
    `undefined, // policyCtx` at :377).
  - Orchestration code steps → **legacy** (`orchestration-helper.ts:235–249`, `undefined, // policyCtx`
    at :242).
  - Both orchestration step-dispatcher factories configure only `setEffectiveToolConfig`
    (`launch.ts:319`, `:436`) — that field is read **exclusively by the legacy branch**.
- **Divergence, pure-path-only:** command-pattern enforcement for `execute_command`
  (`tool-policy.ts:144–162`, `matchCommandPattern` used nowhere else). Consequence on every legacy
  context: `allowed_command_patterns` never auto-approve (headless contexts then hit the no-callback
  warn path and run anyway), and — worse — **`blocked_command_patterns` do not revoke a blanket
  `auto_approve: true`**: a blocked command auto-runs.
- **Divergence, legacy-path-only:** orchestration scratchpad auto-allow — `sessionAllowedPaths` built
  from `orchestrationContext.scratchpadPath`/`parentScratchpadPath` and passed as the 6th arg to
  `enforcePathConstraints` (dispatcher.ts:655–670; `path-enforcer.ts:55–62` supports it).
  `ToolPolicyContext` has no such input — a naive migration of orchestration to the pure path **breaks
  scratchpad access**.
- **Proof-of-drift bug:** the pure path's plan-mode message helper `getWriteToolDescription`
  (`tool-policy.ts:58–67`) names five tools that do not exist in this plugin (`create_file`,
  `edit_file`, `rename_file`, `delete_file`, `create_folder` — zero grep hits elsewhere), so every real
  write tool gets the generic fallback; the dispatcher's private copy (dispatcher.ts:832–841) has the
  real names (`write_note`, `replace_in_note`, `update_frontmatter`, `manage_tags`, `execute_command`).
- **Approval-callback wrinkle:** pure branch uses per-call callback only (dispatcher.ts:467); legacy
  falls back to the instance callback (`perCallApprovalCallback ?? this.approvalCallback`, :599) — the
  sub-agent seam. **Today nothing ever calls `UseSubagentTool.setApprovalCallback`**, so sub-agents and
  all orchestration steps auto-approve everything via the "No approval callback set, auto-approving"
  warn path (dispatcher.ts:607–608). Reconciliation must not silently change this — see §3.4.
- `ApprovalCallback` remains a bare-string-union type (dispatcher.ts:70) — June Stage-0 item 7 (widen to
  an `ApprovalDecision` object) is still open and is **out of scope here** except where noted.

## 2. Feature-by-feature reconciliation table (verified)

| Feature | Pure path | Legacy branch | Winner for the unified engine |
|---|---|---|---|
| Internal-tool bypass | `tool-policy.ts:91–93`; dispatcher then still fires the auto-approved render (:496–498) | separate else-if (:503–506), **no render** | **Legacy semantics**: internal tools (only `update_tasks`, `update-tasks.ts:39–40`) must stay invisible — suppress the render for internal on the pure path |
| Enabled check (FR-83) | `tool-policy.ts:96–103` (ctx.effectiveConfig required by type) | :511–528, skipped when `effectiveToolConfig === null` | Pure (stricter; all five dispatcher-assembly sites do set the config) |
| Plan-mode write gating (FR-14) | `tool-policy.ts:106–117`; **phantom-name map** :58–67 | :531–550; **real-name map** :832–841 | Pure structure + **legacy's map** (share one map; see §3.1 step 4) |
| Domain denylist (fetch_webpage) | :119–138 via `ctx.domainDenylist` | :553–579 via `this.settings` | Pure (explicit input) |
| Auto-approve by tool config | :140–142 (`toolEntry?.auto_approve ?? false`) | :581–597 same + no-config fallback (`resolveMcpAutoApprove`/`resolveAutoApprove`) | Pure; the no-config fallback becomes dead once ctx is mandatory (delete with legacy) |
| **Command patterns (execute_command)** | :144–162, tested | **absent** | **Pure — the security payoff of this work** |
| Path allowlists (FR-84) | :164–180, evaluated **before** approval | :645–687, evaluated **after** approval | Pure ordering (block before prompting) — mild UX change for legacy contexts: a path-blocked call no longer prompts first; acceptable and safer |
| **Scratchpad sessionAllowedPaths** | **absent** | :655–670 | **Legacy — port into the pure function (§3.1 step 1)** |
| MCP plan-mode message / auto-approve | :108–109; config-resolver pre-expands server autoApprove | :536–537; plus live-server fallback (:592–594) | Equivalent once config guaranteed |
| Approval resolution | per-call only (:467) | per-call ?? instance (:599) | Keep the instance fallback **in the dispatcher** (it is approval, not policy — see §3.4) |
| Block-result emission | single exit (:450–464) | four duplicated inline blocks | Pure |

## 3. Change

Reconciliation first (steps 1–4, one release), deletion trailing (step 5, next release). This ordering
supersedes June Stage-0 item 8's "no back-porting required" conclusion — that was true then; the
scratchpad allow-path has since been added to the legacy branch only (INT-001/FR-121).

### 3.1 Step 1 — Make `evaluateToolPolicy` the superset (S)

1. Extend the context (`tool-policy.ts:28–35`):
   ```ts
   export interface ToolPolicyContext {
       effectiveConfig: EffectiveToolConfig;
       mode: ConversationMode;
       domainDenylist?: string[];
       vaultRootPath: string;
       resolveVaultPath?: (path: string) => string | null;
       /** Orchestration scratchpad auto-allow (INT-001/FR-121): extra allowed roots for this session. */
       sessionAllowedPaths?: string[];
   }
   ```
2. Thread it into the path check: `enforcePathConstraints(toolName, parameters, toolEntry,
   ctx.vaultRootPath, ctx.resolveVaultPath, ctx.sessionAllowedPaths)` (the enforcer already accepts the
   6th arg). Port the exact construction from dispatcher.ts:655–662 (scratchpadPath +
   optional parentScratchpadPath) to the **call sites** that have an `orchestrationContext` (§3.2), not
   into the pure function.
3. Feature audit (already done in §2 — encode as tests): extend `tool-policy.test.ts` (currently
   command-patterns + auto-approve flow-through only) with plan-mode block (MCP + non-MCP messages),
   disabled tool, denylist, path allow/block, **sessionAllowedPaths allow + blocked_paths still wins**,
   and internal bypass.
4. Fix the drifted description map: delete the phantom map at `tool-policy.ts:58–67`; export the real
   map (or the helper) from one home — recommended: move `getWriteToolDescription` with the dispatcher's
   entries (dispatcher.ts:832–841) into `tool-policy.ts` as the single copy, and have the dispatcher's
   legacy branch call it too until deletion. Optionally add entries for the other high-traffic write
   tools (`write_file`, `delete_note`, `move_note`, `apply_template`) while touching it.

### 3.2 Step 2 — Construct and pass a real `ToolPolicyContext` in RunLoop + orchestration (M)

All inputs are verified in scope; the one genuine gap is that RunLoop cannot read the dispatcher's
private config.

1. **Thread the context through `RunLoopOptions`** (`run-loop/types.ts:336–370`): add
   `policyCtx?: ToolPolicyContext`. RunLoop passes `this.options.policyCtx` instead of `undefined` at
   `run-loop.ts:377` and in the sub-agent branch (:356–365 — see arity note below).
   Do **not** have RunLoop assemble the context itself (it lacks `effectiveConfig`/`vaultRootPath`;
   adding getters to ToolDispatcher just to reconstruct what the caller already had is backwards). The
   builders own it:
   - **Orchestration conversation steps** — `makeRuntimeFactory.build()` (`launch.ts:281–345`): it
     already has `effective` (:314), `settings` (:284 → `domain_denylist`), `plugin.vaultRootPath`
     (:299), the `resolveVaultPath` closure (:300–303), `mode` (in the build args, currently not
     destructured), and the `orchestrationContext` (destructured :283, currently `void`ed at :339 —
     use it for `sessionAllowedPaths`). Return the ctx on `StepRuntime` and thread through
     `StepTurnExecutor.executeConversationStep` (`step-turn-executor.ts:298–314`) into `RunLoopOptions`.
   - **Orchestration code steps** — `makeCodeStepRuntimeFactory.build()` (`launch.ts:407–465`) has the
     same inputs (`effective` :435, settings :409, root :422, resolver :423–426, orchestrationContext
     :408); `mode` is available at the dispatch site (`orchestration-helper.ts:238`). Pass the ctx into
     `buildOrchestrationHelper` and use it at the two dispatch calls (`orchestration-helper.ts:235–249`),
     replacing the `undefined // policyCtx` at :242.
   - **Sub-agents** — `use-subagent.ts` (dispatcher assembly :378–393; `intersectedConfig` :331, mode
     :400) and the extension path `sub-agent-utils.ts:110–132`: build the ctx from the intersected
     config. **Note:** sub-agents currently pass no `settings` into RunLoop (`sub-agent-runner.ts:152–154`)
     — source `domainDenylist` from the tool's settings reference at assembly time.
   - **Mobile:** where `vaultRootPath` is unavailable, keep passing ctx with `vaultRootPath: ""` **only
     if** `enforcePathConstraints` is verified safe with an empty root (it receives `"" ` today from the
     legacy branch via `this.vaultRootPath ?? ""`, dispatcher.ts:663–670, so behavior is precedented);
     this *removes* the mobile legacy fallback for chat/workflows too. Verify with a unit test over
     `enforcePathConstraints` with empty root before flipping; if unsafe, keep the mobile fallback and
     scope it explicitly.
2. **Regression-gate arity updates** (tests dictate call shape; update them deliberately, once):
   - `run-loop.test.ts:286–300` (11-arg sub-agent assertion) and `:302–318` (13-arg flow assertion),
   - `sub-agent-runner.test.ts:210–222, 547–559`,
   - `orchestration-helper.test.ts:244–262` (positional index assertions),
   - the load-bearing comment at `tool-orchestration.ts:289–294` explaining the conditional arity.
   **Recommended:** do the F8 dispatch-options-object collapse *here only if cheap*; otherwise keep
   positional args and just update the asserted vectors (policyCtx moves from `undefined` to
   `expect.objectContaining({...})`). Do not let this spec absorb F8.
3. **Keep `setEffectiveToolConfig` calls in place** during the transition (legacy branch still reads
   them until deletion). They become dead with §3.5.

### 3.3 Step 3 — Pure-path behavior fixes surfaced by the audit (S)

- Suppress the auto-approved **render** for `tool.internal` on the pure path (dispatcher.ts:496–498
  currently fires the collapsed-diff card for internal tools — an accidental divergence from the legacy
  bypass; `update_tasks` should stay invisible).
- Single block-result exit already exists on the pure path — no change.

### 3.4 Step 4 — Approval semantics: preserve, don't reform (S)

Reconciliation must be behavior-preserving on approvals:

- Keep the legacy instance-callback fallback **inside the dispatcher approval section**, not in the
  policy function (approval ≠ policy). When the pure branch becomes the only branch (§3.5), carry the
  `perCallApprovalCallback ?? this.approvalCallback` resolution into it so the sub-agent seam
  (`setApprovalCallback`, dispatcher.ts:202–204) keeps working.
- Orchestration/sub-agent contexts today have **no** approval callback → warn + auto-approve
  (dispatcher.ts:607–608). Unchanged by this spec — but now the *policy* layer (command patterns,
  paths, plan-mode) actually gates them, which is the point. Flag in the PR description: headless
  contexts gain enforcement they previously lacked; a user whose orchestration relied on
  blocked-pattern commands auto-running will see new blocks. That is the fix, not a regression.

### 3.5 Step 5 — Tripwire, then delete (release-gated; M)

Follows June Stage-0 item 8's sequence, now unblocked:

1. Release N (with steps 1–4): first line of the legacy `else` branch gets
   `log.error("LEGACY POLICY PATH HIT — policyCtx was not provided", { toolName, mode })`. After steps
   1–4 the branch should be unreachable in production (all five contexts pass ctx).
2. Release N+1: make `policyCtx` **required** in `dispatch()` (position 7 of 13, dispatcher.ts:406–420);
   delete the `else if (tool.internal)` bypass (:503–506) and the legacy block (:507–688); delete
   now-dead helpers after repo-wide grep: `resolveMcpAutoApprove` (:47–59), `resolveAutoApprove` import,
   the `autoApprove` field, `setEffectiveToolConfig` + field **only if** nothing else reads it
   (`ConfigResolver.updateDisplayConfig`, `config-resolver.ts:131–135`, writes it — trace whether the
   display-sync path has any remaining reader before removing), and the four duplicated block-result
   blocks. Keep `raceApprovalSources` (used by the surviving branch).
3. The e2e caller audit from the June plan still applies (`e2e/scripts/mcp-auto-approve-test.ts` omitted
   policyCtx as of June — re-verify and fix as part of Release N).

## 4. Test plan

| Test | File | Asserts |
|---|---|---|
| sessionAllowedPaths | `tool-policy.test.ts` | scratchpad path allowed; parent scratchpad allowed; `blocked_paths` still wins; absent field → unchanged behavior |
| Policy matrix | `tool-policy.test.ts` | plan-mode MCP + non-MCP messages (real tool names post-map-fix), disabled tool, denylist, internal bypass |
| Command patterns headless | new dispatcher-level or RunLoop-level test | orchestration-style dispatch (ctx with intersected config): blocked pattern blocks despite `auto_approve: true`; allowed pattern auto-approves |
| RunLoop threading | `run-loop.test.ts` | policyCtx forwarded on both branches (updated arity vectors) |
| Orchestration factories | new `launch`-side test or extend `orchestration-helper.test.ts` | built ctx contains effective config, mode, scratchpad allow-paths |
| Empty-root path enforcement | `path-enforcer` test | behavior with `vaultRootPath: ""` documented/locked before mobile flip |
| Tripwire | manual/log | legacy log line never fires across Release N |

## 5. Verification

- `tsc` + suite green; the regression-gate assertions updated in the same commit as the call-site
  change (never loosened to `expect.anything()` wholesale).
- Manual: in an orchestration flow, `execute_command` with a blocked pattern is refused with the
  policy error; scratchpad writes still work; plan-mode orchestration launch still permits `emit_event`
  (classified read — unchanged).
- Grep gates before deletion: `grep -n "policyCtx" src/ | grep -v test` shows no `undefined,`
  placeholders; `grep -rn "LEGACY POLICY PATH HIT"` in captured logs is empty for a full release.

## 6. Risks

- **Behavioral tightening in headless contexts is intended but user-visible** (blocked patterns now
  block; path enforcement now precedes approval). Release-note it.
- The mobile empty-root flip is the only step with real uncertainty — gate it on the
  `enforcePathConstraints("")` unit test; fall back to keeping the mobile `undefined` ctx (and thus the
  legacy branch alive on mobile until resolved) if the semantics surprise. If mobile keeps legacy
  temporarily, the §3.5 deletion must wait or the mobile path must get an explicit ctx with a sentinel.
- `ConfigResolver.updateDisplayConfig`'s shared-dispatcher sync becomes vestigial after deletion —
  remove only after confirming the F7 settings-sync findings don't still depend on it.
