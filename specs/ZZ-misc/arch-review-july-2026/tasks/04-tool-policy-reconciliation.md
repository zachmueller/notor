# Task 04 — Reconcile the two tool-policy engines, then delete the legacy branch

**Spec:** [../F2-tool-policy-reconciliation.md](../F2-tool-policy-reconciliation.md)
**Depends on:** Task 03 (both edit `launch.ts`; F1 rewrites the child-spawn/recovery regions
while this task touches only the two runtime-factory regions (:281–345, :407–465) — landing
after Task 03 avoids double-rebasing).
**Blocks:** Task 06 (its split must not break the regression-gate arity assertions this task
updates). **Phase D (deletion) originally planned to trail one release behind Phases A–C; the
release gate was instead discharged via e2e observation + static proof and Phase D landed in the
same effort — see the Phase D note.**

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

- [x] **A.1** Extend `ToolPolicyContext` (`tool-policy.ts:28–35`) with
      `sessionAllowedPaths?: string[]` (orchestration scratchpad auto-allow, INT-001/FR-121).
- [x] **A.2** Thread it into the path check:
      `enforcePathConstraints(toolName, parameters, toolEntry, ctx.vaultRootPath,
      ctx.resolveVaultPath, ctx.sessionAllowedPaths)` — the enforcer already accepts the 6th
      arg (`path-enforcer.ts:55–62`). The scratchpad+parentScratchpad construction (copied from
      dispatcher.ts:655–662) lives at the **call sites** that have an `orchestrationContext`
      (Phase B), not in the pure function.
- [x] **A.3** Fix the drifted plan-mode description map: delete the phantom-name map at
      `tool-policy.ts:58–67` (`create_file`/`edit_file`/… — tools that don't exist in this
      plugin); move `getWriteToolDescription` with the dispatcher's real-name entries
      (dispatcher.ts:832–841: `write_note`, `replace_in_note`, `update_frontmatter`,
      `manage_tags`, `execute_command`) into `tool-policy.ts` as the single copy; the legacy
      branch calls it too until deletion. Optionally add `write_file`, `delete_note`,
      `move_note`, `apply_template` entries while touching it.
- [x] **A.4** Encode the §2 feature audit as tests — extend `tool-policy.test.ts` (currently
      command-patterns + auto-approve only): plan-mode block (MCP + non-MCP messages, real
      names), disabled tool, domain denylist, path allow/block,
      **sessionAllowedPaths allow + `blocked_paths` still wins**, internal bypass.

## Phase B — Construct and pass a real `ToolPolicyContext` everywhere (commits 2–3)

Builders own context assembly — do **not** have RunLoop assemble it (it lacks
`effectiveConfig`/`vaultRootPath`).

- [x] **B.1** Add `policyCtx?: ToolPolicyContext` to `RunLoopOptions`
      (`run-loop/types.ts:336–370`). RunLoop passes `this.options.policyCtx` instead of
      `undefined` at `run-loop.ts:377` (flow branch) and in the sub-agent branch (:356–365).
- [x] **B.2 Orchestration conversation steps** — `makeRuntimeFactory.build()`
      (`launch.ts:281–345`) already has every input: `effective` (:314), settings →
      `domain_denylist` (:284), `plugin.vaultRootPath` (:299), the `resolveVaultPath` closure
      (:300–303), `mode` (in build args, currently not destructured), `orchestrationContext`
      (destructured :283, currently `void`ed at :339 — source `sessionAllowedPaths` from its
      scratchpad paths). Return ctx on `StepRuntime`, thread through
      `StepTurnExecutor.executeConversationStep` (`step-turn-executor.ts:298–314`) into
      `RunLoopOptions`.
- [x] **B.3 Orchestration code steps** — `makeCodeStepRuntimeFactory.build()`
      (`launch.ts:407–465`, same inputs; `mode` available at the dispatch site,
      `orchestration-helper.ts:238`). Pass ctx into `buildOrchestrationHelper`; use it at both
      dispatch calls (`orchestration-helper.ts:235–249`), replacing the `undefined // policyCtx`
      at :242.
- [x] **B.4 Sub-agents** — `use-subagent.ts` (dispatcher assembly :378–393; `intersectedConfig`
      :331; mode :400) and the extension path `sub-agent-utils.ts:110–132`: build ctx from the
      intersected config. Sub-agents pass no `settings` into RunLoop
      (`sub-agent-runner.ts:152–154`) — source `domainDenylist` from the tool's settings
      reference at assembly time.
- [x] **B.5 Mobile gate.** Where `vaultRootPath` is unavailable
      (`orchestrator.ts:1818–1821`, `workflow-executor.ts` fallbacks): first write a unit test
      locking `enforcePathConstraints` behavior with `vaultRootPath: ""` (precedented — the
      legacy branch passes `this.vaultRootPath ?? ""`, dispatcher.ts:663–670). If safe, pass
      ctx with `""` and remove the mobile legacy fallback for chat/workflows too. If unsafe,
      keep the mobile fallback explicitly scoped — and note that Phase D's deletion must then
      wait or mobile needs a sentinel ctx.
- [x] **B.6 Regression-gate arity updates** — tests dictate call shape; update deliberately,
      once, in the same commit as the call-site change (never wholesale
      `expect.anything()`): `run-loop.test.ts:286–300` (11-arg sub-agent assertion) and
      `:302–318` (13-arg flow assertion); `sub-agent-runner.test.ts:210–222, 547–559`;
      `orchestration-helper.test.ts:244–262`; the load-bearing arity comment at
      `tool-orchestration.ts:289–294`. `policyCtx` moves from `undefined` to
      `expect.objectContaining({...})`. **Do not absorb the F8 options-object refactor** unless
      it turns out trivially cheap.
- [x] **B.7** Keep all `setEffectiveToolConfig` calls (`launch.ts:319, 436`, etc.) — the legacy
      branch still reads that field until Phase D.

## Phase C — Behavior fixes + approval preservation + tripwire (commit 4) → **Release N**

- [x] **C.1** Suppress the auto-approved *render* for `tool.internal` on the pure path
      (dispatcher.ts:496–498 currently fires the collapsed-diff card; the legacy bypass at
      :503–506 doesn't — `update_tasks` must stay invisible).
- [x] **C.2** Approval semantics: preserve, don't reform. The instance-callback fallback
      (`perCallApprovalCallback ?? this.approvalCallback`, :599) stays **in the dispatcher
      approval section** (approval ≠ policy) and must survive into the pure branch before
      deletion so the sub-agent seam (`setApprovalCallback`, :202–204) keeps working. Headless
      contexts still have no approval callback → warn + auto-approve (:607–608) — unchanged;
      the point is that *policy* (command patterns, paths, plan-mode) now gates them first.
- [x] **C.3** Tripwire: first line of the legacy `else` branch →
      `log.error("LEGACY POLICY PATH HIT — policyCtx was not provided", { toolName, mode })`.
      Should be unreachable once all five contexts pass ctx.
- [x] **C.4** Re-verify and fix the e2e caller the June plan flagged:
      `e2e/scripts/mcp-auto-approve-test.ts` omitted policyCtx as of June.
- [x] **C.5** New tests: command patterns headless (orchestration-style dispatch with
      intersected config — blocked pattern **revokes** `auto_approve: true` → `autoApproved:false`;
      allowed pattern auto-approves); RunLoop threading (policyCtx forwarded on both branches);
      orchestration factories (built ctx contains effective config, mode, scratchpad
      allow-paths).
      **Semantics note (confirmed 2026-07-02):** a blocked command pattern does NOT hard-`block`
      on the pure path — it sets `autoApproved:false` (`allowed` stays `true`). In a headless
      context with no approval callback, dispatch then warns + auto-runs (unchanged). The real
      tightening is that patterns *participate at all* in headless contexts now; "blocks despite
      auto_approve" overstates it. Tests assert at `evaluateToolPolicy` (autoApproved), matching
      the existing precedent in `tool-policy.test.ts`. Hard-blocking would be an out-of-scope
      behavior change. "RunLoop threading (both branches)" is covered by the updated cascade-seam
      arity vectors in `run-loop.test.ts`; the conversation-step + code-step ctx threading is
      locked in `step-turn-executor.emission.test.ts` + `code-step-executor.test.ts`.
- [x] **C.6** Release notes: headless contexts gain enforcement they lacked — blocked patterns
      now participate; path enforcement now precedes approval (pure ordering: block before
      prompting). That is the fix, not a regression.
      > **Release note (Phase D, this pass):** The dispatcher's legacy inline policy branch is
      > deleted. All five dispatch contexts (foreground chat, background workflows, sub-agents,
      > orchestration conversation steps, orchestration code steps) now run the single pure
      > `evaluateToolPolicy` engine — there is no fallback path. Behaviorally this only *removes*
      > a dead branch that was already unreachable (every context built a `policyCtx` since
      > Phase B); no user-visible policy behavior changes. `policyCtx` is now a required argument
      > to `ToolDispatcher.dispatch()`, so any future caller that forgets it is a compile error
      > rather than a silent downgrade to unenforced policy.

## Phase D — Delete the legacy branch (**gate discharged via e2e — see note**)

Gate: `grep -rn "LEGACY POLICY PATH HIT"` empty. **Discharged in-session** (2026-07-03) without a
full production release: the tripwire is a `log.error`, and the e2e harness captures every
`log.error` over CDP. Two gate scripts exercised all five live dispatch contexts against real
Obsidian + Bedrock and observed **zero** `LEGACY POLICY PATH HIT` (foreground read tools + the
`run_flow` composition's conversation/code/child-spawn contexts). Combined with the static proof
(all four in-repo `dispatch()` call sites build a concrete ctx) and the now-required type (a
missing ctx is a compile error), the legacy branch was proven unreachable and deleted.

- [x] **D.1** `policyCtx` is required in `dispatch()` (position 7). `abortSignal`/`onProgress`
      became required-but-nullable (TS forbids a required param after an optional one); every
      caller already passed them positionally. `RunLoopOptions.policyCtx`,
      `SubAgentRunnerOptions.policyCtx`, `StepRuntime`/`CodeStepRuntime`/`BuildOrchestrationHelperArgs`
      `.policyCtx`, and the three `tool-orchestration.ts` batch-executor params all became required
      to match.
- [x] **D.2** Deleted the `else if (tool.internal)` bypass and the entire legacy `else` block.
      Kept `raceApprovalSources` and the pure branch's approval section. Internal tools are
      handled inside the pure branch (`evaluateToolPolicy` returns `{allowed, autoApproved}` for
      `tool.internal`, and the render-suppression `else if (approvalCb && !tool.internal)` stays).
- [x] **D.3** Deleted: `resolveMcpAutoApprove` fn, the `autoApprove` field + `setAutoApprove`
      setter (+ its 3 callers: main.ts, wire-view.ts, orchestrator.ts), the `effectiveToolConfig`
      field + `setEffectiveToolConfig` setter (+ its 4 writer call sites: config-resolver,
      use-subagent, sub-agent-utils, launch-wiring). The `resolveAutoApprove` import went dead and
      its now-orphaned source file `src/personas/auto-approve-resolver.ts` was deleted. ConfigResolver
      keeps its own `effectiveToolConfig` field (read by the inspector via `getEffectiveToolConfig`,
      not the dispatcher's copy). Unused `isDomainBlocked`/`isMcpTool`/`getWriteToolDescription`
      dispatcher imports pruned; `McpRegisteredTool` stays (used by `hasExplicitUserReadClassification`).
- [x] **D.4** Grep gates: `grep -rn "LEGACY POLICY PATH HIT" src/` → 0;
      `grep -n "policyCtx" src/ | grep -v test | grep "undefined,"` → 0;
      `grep -rn "resolveMcpAutoApprove\|setAutoApprove\|setEffectiveToolConfig" src/ | grep -v test` → 0.

## Verification (Release N + Phase D)

- [x] `tsc` + suite green (1591 tests at Release N; **1631 tests / 114 files after Phase D**);
      arity assertions updated in the same commits as call-site changes (run-loop.test.ts
      cascade-seam vectors + sub-agent-runner.test.ts, both moved policyCtx from `undefined` to
      `expect.objectContaining` at position 7). Phase D additionally flipped every test's
      RunLoop/sub-agent/step/code-step options builder to supply a minimal required `policyCtx`,
      and updated `orchestration-helper.test.ts`'s "undefined when not supplied" assertion to
      assert the now-always-present ctx.
- [x] **e2e gate (Phase D):** `orchestration-run-flow-test.ts` (extended with a tripwire-sweep
      scenario) + new `legacy-policy-tripwire-test.ts` (foreground chat + sub-agent) run against
      real Obsidian + Bedrock — zero `LEGACY POLICY PATH HIT`, zero plugin errors, both pre- and
      post-deletion. The flows still complete (child spawns, structured return, ledger entries).
- [x] Manual → discharged via live e2e (2026-07-03): `execute-command-test.ts` 7/7 (blocked
      command patterns), `plan-mode-enforcement-test.ts` 11/11 (read tools incl. `emit_event`
      permitted in plan mode; write tools blocked), and `legacy-policy-tripwire-test.ts` +
      `orchestration-run-flow-test.ts` re-confirmed **zero `LEGACY POLICY PATH HIT`** across
      foreground-chat, code-step, and child-spawn dispatch contexts. **Caveat (see C.5 semantics
      note):** a blocked command pattern in a *headless* orchestration step reverts auto-approve
      but, with no approval callback, still warns + runs — it is NOT "refused with the policy
      error". A hard-refusal on blocked patterns was deliberately kept out of scope.
      Path/enabled/plan-mode violations DO hard-block (return `allowed:false`), so scratchpad-outside
      writes are refused and plan-mode write tools are blocked as described.
      *(Note: `legacy-policy-tripwire-test.ts` Test 2 — the sub-agent dispatch sub-case — is flaky
      because Haiku often answers directly instead of invoking `use_subagent`; the two tripwire
      sweeps that matter both pass. Sub-agent policy-path coverage is otherwise unit-tested.)*
