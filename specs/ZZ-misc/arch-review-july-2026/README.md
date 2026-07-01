# Architecture hardening — July 2026 review, CRITICAL + HIGH findings

**Source:** `private/architecture-review-2026-07-01.md` (git-ignored), findings F1–F6.
**Method:** every load-bearing claim in each finding was independently re-verified against source at
HEAD `c0d21e9` before speccing (six research passes, one per finding). Discrepancies between the
review text and the code are corrected inline in each spec and flagged as such.
**Scope:** planning only — no code changes accompany this package.

## The specs

| Spec | Finding | Severity | Effort | One-line summary |
|---|---|---|---|---|
| [F1-orchestration-run-lifecycle.md](F1-orchestration-run-lifecycle.md) | F1 | CRITICAL | M–L | Run registry + Stop UI + unload teardown; recovery liveness guard; deterministic child-flow ledger (fixes double-execution on replay); single-instance guard; delete dead thrashing guard |
| [F2-tool-policy-reconciliation.md](F2-tool-policy-reconciliation.md) | F2 | CRITICAL | M | Port scratchpad allow-paths into `evaluateToolPolicy`, thread a real `ToolPolicyContext` through RunLoop/orchestration/sub-agents (command patterns finally enforced headless), then tripwire + delete the 182-line legacy branch |
| [F3-stream-error-masquerades-as-success.md](F3-stream-error-masquerades-as-success.md) | F3 | HIGH | S–M | Honest `error`/`cancelled` stop reasons + `{step}.stream_error` failure channel; wind-down and child-cost budget accounting fixes; the emission-matrix test that was missing |
| [F4-schema-versioning-and-atomic-writes.md](F4-schema-versioning-and-atomic-writes.md) | F4 | HIGH | S–M | `schema_version: 1` in all six persisted formats; history appends via `adapter.append`; atomic header surgery; serialized `session.json` writes |
| [F5-extension-runtime-hardening.md](F5-extension-runtime-hardening.md) | F5 | HIGH | M | `utils.api.version` + enforced `notor-min-api`; execution timeouts for tools/automations (lifting the code-step pattern); facade narrowing of the three live managers; gate `utils.webview` |
| [F6-launch-ts-decomposition.md](F6-launch-ts-decomposition.md) | F6 | HIGH | M–L | Split launch.ts into five modules behind an `OrchestrationHost` interface; make the child ledger and chaining gate unit-testable; land the priority integration tests |

## Recommended land order

Within-slice items are independently shippable; the order minimizes rebase churn on the shared files
(`launch.ts`, `run-loop.ts`, `dispatcher.ts`):

1. **F3** — smallest, unblocks honest failure semantics everywhere; F1's tests assume it.
2. **F4 Part A** (schema stamps) — must precede/accompany F1+F3's session-log entry-shape changes.
3. **F1** — lifecycle correctness; enriches `child.spawned` on the now-versioned log.
4. **F2** — policy reconciliation (touches RunLoop + both launch factories; land after F1 to avoid
   double-rebasing launch.ts); deletion step trails one release behind.
5. **F4 Part B** (atomic writes) — any time; no dependencies.
6. **F5** — independent of all the above (extensions subsystem); three separately landable parts.
7. **F6** — last, by design: the split moves the exact lines F1–F3 edit.

## Cross-spec dependencies (the ones that bite)

- F1 Fix 3 and F3 §3.3.3 both change session-log entry shapes → ride F4's `schema_version` stamp
  (F4 §2.1.4), ideally one combined entry-shape release.
- F3's emission-matrix test is referenced by F6's test plan — write it once, in F3.
- F2's RunLoop threading updates the same regression-gate arity assertions F6's split must not break;
  F2 explicitly does *not* absorb the F8 options-object refactor.
- F1's `OrchestrationRunRegistry` accessor gets added to F6's `OrchestrationHost` if F1 lands first
  (it should).

## Process note

The June review's Stage-0 package (`specs/ZZ-misc/arch-review-june-2026/`) was correct and did not
ship; the July review's top process recommendation is to treat *this* package like a feature: phased
tasks, per-phase commits, same discipline as the orchestration build. F2 and F5 deliberately reuse the
June plans where they remain valid (referenced, not duplicated) so no prior planning work is wasted.
