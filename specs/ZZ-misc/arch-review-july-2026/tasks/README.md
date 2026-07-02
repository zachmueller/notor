# Implementation task files — July 2026 architecture hardening

Breaks the six specs in the parent directory into six end-to-end task files. Each task file is a
self-contained unit of work: one branch, phased commits, shippable when its verification section
passes. Checkboxes are the tracking mechanism; tick as you land.

## Land order (revised from the parent README — see rationale)

| # | Task file | Spec(s) | Effort | Hard dependencies |
|---|---|---|---|---|
| 1 | [01-schema-versioning-and-atomic-writes.md](01-schema-versioning-and-atomic-writes.md) | F4 (Parts A + B) | ~2 days | none |
| 2 | [02-honest-stream-errors.md](02-honest-stream-errors.md) | F3 | ~2 days | Task 01 Phase A.4 (session-log stamp) for Phase 3 only |
| 3 | [03-run-lifecycle.md](03-run-lifecycle.md) | F1 | ~2–4 days | Task 01 Phase A.4; Task 02 (its tests assume honest stop reasons) |
| 4 | [04-tool-policy-reconciliation.md](04-tool-policy-reconciliation.md) | F2 | ~2–3 days + trailing deletion | Task 03 (avoids double-rebasing launch.ts) |
| 5 | [05-extension-runtime-hardening.md](05-extension-runtime-hardening.md) | F5 | ~3 days | none — **parallelizable with tasks 02–04** (different subsystem) |
| 6 | [06-launch-decomposition.md](06-launch-decomposition.md) | F6 | ~3–4 days | Tasks 02, 03, 04 merged (the split moves the exact lines they edit) |

## Order changes vs. the parent README, and why

The parent README's order was `F3 → F4A → F1 → F2 → F4B → F5 → F6`. Two changes, both verified
against source at `c0d21e9`:

1. **F4 moved from slots 2+5 to slot 1 (whole spec, Parts A+B together).** The README's own
   cross-dependency section says F1 Fix 3 and F3 §3.3.3 "both change session-log entry shapes →
   ride F4's `schema_version` stamp" — but it slotted F3 *before* F4A, which would force F3 to
   either ship `ChildResultEntry.cost_usd`/`iterations` on an unversioned log or split §3.3.3 out.
   F4 Part A is the smallest item in the package (~half day) with zero dependencies; putting it
   first dissolves the circularity and F3/F1 land complete in one pass each. Part B (atomic
   writes) is "any time; no dependencies" per the README — folding it into the same branch keeps
   the persistence-hardening sweep in one review and touches nothing F1–F3 edit (history.ts,
   session-manager.ts, step-conversation-store.ts; the one launch.ts site, `backfillParentEdge`
   :1045–1076, is outside F1's edit ranges).
2. **F5 flagged explicitly parallelizable.** It touches only `src/extensions/` +
   `src/utils/with-timeout.ts` + settings; zero overlap with `launch.ts`/`run-loop.ts`/
   `dispatcher.ts`. It can proceed on a second track any time before F6 (F6 doesn't touch it
   either, but sequencing it before F6 matches the parent README and keeps the end state stable).

Everything else confirmed as-is: F3 before F1 (F1's replay/liveness tests assume honest stop
reasons; F3 is smaller), F1 before F2 (both touch launch.ts — F1 rewrites the child-spawn and
recovery regions, F2 only the two factory regions :281–345/:407–465, so F2 rebases cheaply over
F1 but not vice versa), F6 strictly last (pure-move split of the lines everything else edits).

## Shared conventions

- **Line numbers are anchors, not addresses.** Every `file:line` was verified at `c0d21e9` but
  will drift as earlier tasks land. Re-locate by symbol name.
- **Per-phase commits** via the Git MCP tools, one logical unit each (process note in the parent
  README: treat this package like a feature build).
- **Baseline gate before starting each task:** `tsc` clean + full vitest suite green (1,496 tests
  at baseline; the number grows as tasks land).
- **Cross-file suffix lists, entry shapes, and regression-gate arity assertions** are called out
  inline in each task — never loosen an arity assertion to `expect.anything()`; update the
  asserted vector deliberately.
