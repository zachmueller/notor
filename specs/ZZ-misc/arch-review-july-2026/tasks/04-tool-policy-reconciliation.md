# Task 04 — Reconcile the two tool-policy engines, then delete the legacy branch

**Spec:** [../F2-tool-policy-reconciliation.md](../F2-tool-policy-reconciliation.md)
**Depends on:** Task 03 (both edit `launch.ts`; F1 rewrites the child-spawn/recovery regions
while this task touches only the two runtime-factory regions (:281–345, :407–465) — landing
after Task 03 avoids double-rebasing).
**Blocks:** Task 06 (its split must not break the regression-gate arity assertions this task
updates). **Phase D (deletion) trails one release behind Phases A–C.**

The two engines: `ToolDispatcher.dispatch()` forks at `dispatcher.ts:443–447` — with `policyCtx`
it runs pure `evaluateToolPolicy()` (`tool-policy.ts:85`); without, a 182-line legacy inline
branch (:507–688 plus the `tool.internal` bypass at :503–506). Foreground chat and background
workflows are pure (except on mobile); sub-agents, orchestration conversation steps
(`run-loop.ts:377` passes `undefined // policyCtx`), and code steps
(`orchestration-helper.ts:242`) are all legacy. The security payoff: command patterns
(`allowed_command_patterns` / `blocked_command_patterns`) are enforced **only** on the pure path
today — a blocked command auto-runs in every headless context. The blocker for naive migration:
the legacy branch alone honors orchestration scratchpad allow-paths (dispatcher.ts:655–670).

---

## Phase A — Make `evaluateToolPolicy` the superset (commit 1)

- [ ] **A.1** Extend `ToolPolicyContext` (`tool-policy.ts:28–35`) with
      `sessionAllowedPaths?: string[]` (orchestration scratchpad auto-allow, INT-001/FR-121).
- [ ] **A.2** Thread it into the path check:
      `enforcePathConstraints(toolName, parameters, toolEntry, ctx.vaultRootPath,
      ctx.resolveVaultPath, ctx.sessionAllowedPaths)` — the enforcer already accepts the 6th
      arg (`path-enforcer.ts:55–62`). The scratchpad+parentScratchpad construction (copied from
      dispatcher.ts:655–662) lives at the **call sites** that have an `orchestrationContext`
      (Phase B), not in the pure function.
- [ ] **A.3** Fix the drifted plan-mode description map: delete the phantom-name map at
      `tool-policy.ts:58–67` (`create_file`/`edit_file`/… — tools that don't exist in this
      plugin); move `getWriteToolDescription` with the dispatcher's real-name entries
      (dispatcher.ts:832–841: `write_note`, `replace_in_note`, `update_frontmatter`,
      `manage_tags`, `execute_command`) into `tool-policy.ts` as the single copy; the legacy
      branch calls it too until deletion. Optionally add `write_file`, `delete_note`,
      `move_note`, `apply_template` entries while touching it.
- [ ] **A.4** Encode the §2 feature audit as tests — extend `tool-policy.test.ts` (currently
      command-patterns + auto-approve only): plan-mode block (MCP + non-MCP messages, real
      names), disabled tool, domain denylist, path allow/block,
      **sessionAllowedPaths allow + `blocked_paths` still wins**, internal bypass.

## Phase B — Construct and pass a real `ToolPolicyContext` everywhere (commits 2–3)

Builders own context assembly — do **not** have RunLoop assemble it (it lacks
`effectiveConfig`/`vaultRootPath`).

- [ ] **B.1** Add `policyCtx?: ToolPolicyContext` to `RunLoopOptions`
      (`run-loop/types.ts:336–370`). RunLoop passes `this.options.policyCtx` instead of
      `undefined` at `run-loop.ts:377` (flow branch) and in the sub-agent branch (:356–365).
- [ ] **B.2 Orchestration conversation steps** — `makeRuntimeFactory.build()`
      (`launch.ts:281–345`) already has every input: `effective` (:314), settings →
      `domain_denylist` (:284), `plugin.vaultRootPath` (:299), the `resolveVaultPath` closure
      (:300–303), `mode` (in build args, currently not destructured), `orchestrationContext`
      (destructured :283, currently `void`ed at :339 — source `sessionAllowedPaths` from its
      scratchpad paths). Return ctx on `StepRuntime`, thread through
      `StepTurnExecutor.executeConversationStep` (`step-turn-executor.ts:298–314`) into
      `RunLoopOptions`.
- [ ] **B.3 Orchestration code steps** — `makeCodeStepRuntimeFactory.build()`
      (`launch.ts:407–465`, same inputs; `mode` available at the dispatch site,
      `orchestration-helper.ts:238`). Pass ctx into `buildOrchestrationHelper`; use it at both
      dispatch calls (`orchestration-helper.ts:235–249`), replacing the `undefined // policyCtx`
      at :242.
- [ ] **B.4 Sub-agents** — `use-subagent.ts` (dispatcher assembly :378–393; `intersectedConfig`
      :331; mode :400) and the extension path `sub-agent-utils.ts:110–132`: build ctx from the
      intersected config. Sub-agents pass no `settings` into RunLoop
      (`sub-agent-runner.ts:152–154`) — source `domainDenylist` from the tool's settings
      reference at assembly time.
- [ ] **B.5 Mobile gate.** Where `vaultRootPath` is unavailable
      (`orchestrator.ts:1818–1821`, `workflow-executor.ts` fallbacks): first write a unit test
      locking `enforcePathConstraints` behavior with `vaultRootPath: ""` (precedented — the
      legacy branch passes `this.vaultRootPath ?? ""`, dispatcher.ts:663–670). If safe, pass
      ctx with `""` and remove the mobile legacy fallback for chat/workflows too. If unsafe,
      keep the mobile fallback explicitly scoped — and note that Phase D's deletion must then
      wait or mobile needs a sentinel ctx.
- [ ] **B.6 Regression-gate arity updates** — tests dictate call shape; update deliberately,
      once, in the same commit as the call-site change (never wholesale
      `expect.anything()`): `run-loop.test.ts:286–300` (11-arg sub-agent assertion) and
      `:302–318` (13-arg flow assertion); `sub-agent-runner.test.ts:210–222, 547–559`;
      `orchestration-helper.test.ts:244–262`; the load-bearing arity comment at
      `tool-orchestration.ts:289–294`. `policyCtx` moves from `undefined` to
      `expect.objectContaining({...})`. **Do not absorb the F8 options-object refactor** unless
      it turns out trivially cheap.
- [ ] **B.7** Keep all `setEffectiveToolConfig` calls (`launch.ts:319, 436`, etc.) — the legacy
      branch still reads that field until Phase D.

## Phase C — Behavior fixes + approval preservation + tripwire (commit 4) → **Release N**

- [ ] **C.1** Suppress the auto-approved *render* for `tool.internal` on the pure path
      (dispatcher.ts:496–498 currently fires the collapsed-diff card; the legacy bypass at
      :503–506 doesn't — `update_tasks` must stay invisible).
- [ ] **C.2** Approval semantics: preserve, don't reform. The instance-callback fallback
      (`perCallApprovalCallback ?? this.approvalCallback`, :599) stays **in the dispatcher
      approval section** (approval ≠ policy) and must survive into the pure branch before
      deletion so the sub-agent seam (`setApprovalCallback`, :202–204) keeps working. Headless
      contexts still have no approval callback → warn + auto-approve (:607–608) — unchanged;
      the point is that *policy* (command patterns, paths, plan-mode) now gates them first.
- [ ] **C.3** Tripwire: first line of the legacy `else` branch →
      `log.error("LEGACY POLICY PATH HIT — policyCtx was not provided", { toolName, mode })`.
      Should be unreachable once all five contexts pass ctx.
- [ ] **C.4** Re-verify and fix the e2e caller the June plan flagged:
      `e2e/scripts/mcp-auto-approve-test.ts` omitted policyCtx as of June.
- [ ] **C.5** New tests: command patterns headless (orchestration-style dispatch with
      intersected config — blocked pattern blocks despite `auto_approve: true`; allowed pattern
      auto-approves); RunLoop threading (policyCtx forwarded on both branches);
      orchestration factories (built ctx contains effective config, mode, scratchpad
      allow-paths).
- [ ] **C.6** Release notes: headless contexts gain enforcement they lacked — blocked patterns
      now block; path enforcement now precedes approval (pure ordering: block before
      prompting). That is the fix, not a regression.

## Phase D — Delete the legacy branch (**Release N+1**, separate branch/PR)

Gate: `grep -rn "LEGACY POLICY PATH HIT"` in captured logs empty for a full release.

- [ ] **D.1** Make `policyCtx` required in `dispatch()` (position 7 of 13,
      dispatcher.ts:406–420).
- [ ] **D.2** Delete the `else if (tool.internal)` bypass (:503–506), the legacy block
      (:507–688), and the four duplicated block-result blocks. Keep `raceApprovalSources`.
- [ ] **D.3** Delete now-dead helpers after repo-wide grep: `resolveMcpAutoApprove` (:47–59),
      the `resolveAutoApprove` import, the `autoApprove` field. Remove
      `setEffectiveToolConfig` + field **only if** nothing else reads it —
      `ConfigResolver.updateDisplayConfig` (`config-resolver.ts:131–135`) writes it; trace
      whether the display-sync path has any remaining reader first (and confirm the F7
      settings-sync findings don't depend on it).
- [ ] **D.4** Grep gates: `grep -n "policyCtx" src/ | grep -v test` shows no `undefined,`
      placeholders.

## Verification (Release N)

- [ ] `tsc` + suite green; arity assertions updated in the same commits as call-site changes.
- [ ] Manual: orchestration flow → `execute_command` with a blocked pattern refused with the
      policy error; scratchpad writes still work; plan-mode orchestration launch still permits
      `emit_event` (classified read — unchanged).
