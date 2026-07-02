# Task 01 — Schema-version the six persisted formats; atomic history/session writes

**Spec:** [../F4-schema-versioning-and-atomic-writes.md](../F4-schema-versioning-and-atomic-writes.md)
**Depends on:** nothing. **Blocks:** Task 02 Phase 3, Task 03 Phase 3 (both add fields to
session-log entries, which must ride a versioned stream).
**Why first:** smallest package item, zero dependencies, and both F1 and F3 change session-log
entry shapes — stamping first means those land complete instead of split across releases.

Policy (uniform across all six formats): **writers stamp `schema_version: 1`; readers default
missing → `1`; no migration logic.** Readers that would misbehave on a future v2 (recovery scan,
checkpoint restore) refuse `> 1` with a clear error, mirroring the in-repo precedent at
`src/tool-config/parser.ts:89–97` (`MAX_SUPPORTED_MAJOR`, skip-and-warn).

---

## Phase A — `schema_version: 1` stamps (commit 1, optionally split per format)

### A.1 Conversation JSONL header

- [x] Add `schema_version?: number` to `Conversation` (`src/types.ts:24` region).
- [x] Set it at creation: `createConversationFile` (`src/chat/history.ts:171–177`) and
      `importConversation` (:400–406). Verify it then flows through every
      `{ _type: "conversation", ...conversation }` spread site: appendMessage header fallback
      (:207–211), `updateConversationHeader` (:323–328), HTML export block
      (`html-exporter.ts:708–722`).
- [x] `writeSubAgentConversation` builds its metadata literal directly (`history.ts:430–443`) —
      add the field explicitly there.
- [x] Readers: normalize `header.schema_version ??= 1` in `loadConversation` (:541–547) and
      `listConversations` (:644–660).
- [x] Verify (don't assume) that `toggleFavorite` (:363) and `updateConversationHeader` preserve
      the field — both spread the parsed header; lock with a test (Phase C).

### A.2 Checkpoint JSON

- [x] Add required `schema_version: number` to `Checkpoint` (`src/types.ts:389–406`).
- [x] Stamp at the single construction site (`src/checkpoints/checkpoint.ts:97–106`).
- [x] Reader `??= 1` normalization in `CheckpointStorage.load` (`storage.ts:92–93`) and
      `listForConversation` (:116–117). The normalization is what keeps the required-in-type field
      honest against legacy files — do not skip it.
- [x] While touching the blind `JSON.parse(raw) as Checkpoint` cast: add minimal shape validation
      (id / conversation_id / note_path / content present → else warn + skip). Restore writes user
      notes; garbage in must not restore garbage out.
- [x] Future-version gate: `schema_version > 1` → skip-with-warn, not crash.

### A.3 Memory note frontmatter

- [x] Add a `notor-schema: 1` line in both serializers: `serializeNote`
      (`src/memory/note-format.ts:25–31`) and `serializePendingNote` (:89–107).
- [x] Readers (`parseNote` :40–71, `parsePendingNote` :109–143) extract with `?? 1` default.
- [x] Confirm `patchFrontmatterField` (:156–184) composes (it inserts after the last `notor-*`
      line — should be fine; assert in a test).
- [x] PR note: `MemoryNote` is extension-API-visible (`runtime-context/types.ts:283–293`); an
      optional added field is non-breaking.

### A.4 Orchestration session log ← **the one Tasks 02/03 wait on**

- [x] Version the **stream, not every entry**: add `schema_version: number` to
      `SessionStartEntry` (`src/orchestration/session-log.ts:37–44`), stamped by
      `appendSessionStart` (:204). The runner writes `session.start` at `runner.ts:226`.
- [x] `SessionLogReader.parse` (`session-log-reader.ts:52–101`): read it off the first entry when
      present, default 1, expose on `ParsedSessionLog`.
- [x] Recovery (`session-recovery.ts`) refuses `> 1` with a diagnosable scan error — the loud
      error path at `launch.ts:1151–1155` already exists for this shape of failure.
- [x] Leave the truncated-final-line tolerance (`session-log-reader.ts:87–97`) untouched.

### A.5 Step-conversation JSONL header

- [x] One field in `buildStepConversationHeader`
      (`src/orchestration/step-conversation-store.ts:76–104`).
- [x] Default-on-read in the run-tree scan (`run-tree-view.ts:201–225`) and both backfills
      (`backfillNextEdge` :148–174; `backfillParentEdge` `launch.ts:1045–1076`). The backfills
      mutate the parsed object so the field survives automatically — assert in tests.

### A.6 session.json

- [x] Field on `OrchestrationSessionMeta` (`src/orchestration/types.ts:150–169`), stamped in
      `createSession` (`session-manager.ts:131–141`).
- [x] Default in `readMeta` (:153–157 — choke point for two of the three readers) **and** in the
      recovery scan's independent parse (`session-recovery.ts:275–281`).

## Phase B — Atomic / append writes (commit 2)

### B.1 Convert the two true rewrite-appends in history.ts

- [x] `appendMessage` (`history.ts:202–203`) and `appendStaleState` (:237–238) →
      `await this.vault.adapter.append(filePath, line + "\n")`, staying inside `enqueueWrite`
      (:142–153) — ordering vs. header rewrites still matters.
- [x] **Sharp edge:** `adapter.append` creates-if-absent. The current catch-fallback that writes
      header+line on missing file (:204–212) must become an explicit `adapter.exists` check
      *before* the append, else a missing file silently becomes a header-less JSONL that
      `loadConversation` rejects.

### B.2 Atomic header surgery

- [x] New shared helper `src/utils/atomic-write.ts`:
      `atomicRewrite(adapter, path, mutate: (content: string) => string)` via `adapter.process`
      (documented atomic, `obsidian.d.ts:1649`).
- [x] Use it at the direct-adapter sites: `toggleFavorite` (`history.ts:370`),
      `updateConversationHeader` (:328), `backfillParentEdge` (`launch.ts:1071`).
- [x] For the seam-mediated sites — `backfillNextEdge` (via `StepConversationFs.write`,
      `step-conversation-store.ts:170`) and `writeMeta` (via `SessionFs.write`,
      `session-manager.ts:166`) — keep the seam's `write` signature and implement temp+rename in
      the **production adapters** only, so pure cores and test fakes stay unchanged. If copying
      the `dedup-cache.ts:51–77` pattern, note its remove-before-rename gap: prefer plain
      rename-over-existing (works on desktop adapter) or document the gap.

### B.3 Serialize session.json writes

- [x] Per-session promise chain on `OrchestrationSessionManager` (the `SessionLog.writeChain`
      pattern, `session-log.ts:285–302`) wrapping `readMeta → mutate → writeMeta` inside
      `updateStatus` (:174–184), so the runner pause seam and finalize can't interleave and lose
      a patch.

### B.4 Explicit non-changes

- [x] Batch creates stay plain writes (`createConversationFile`, `importConversation`,
      `writeSubAgentConversation`, step-store `persist`) — single-shot creation has no
      torn-state reader. Note in the PR.

## Phase C — Tests (commit 3, or folded into A/B commits per format)

- [x] Round-trip stamp per format: `session-manager.test.ts`, `session-log.test.ts` +
      `session-log-reader.test.ts`, `step-conversation-store.test.ts`, `note-format.test.ts`,
      **new** `storage.test.ts` for checkpoints (currently zero coverage).
- [x] Legacy tolerance (load-bearing): hand-crafted artifact *without* the field parses,
      defaults to 1, nothing throws — per format.
- [x] Future-version gate: `schema_version: 2` → recovery scan error / checkpoint
      skip-with-warn.
- [x] Append conversion: upgrade the `makeVault` fake in `history.test.ts:23–36` (write is a
      no-op today) to a stateful adapter with `append`/`process`/`exists`, modeled on
      `FakeSessionFs`. Assert: append on existing file adds exactly one line; on missing file
      creates header+line; header rewrite preserves messages + `schema_version`.
- [x] Header preservation: `toggleFavorite` / both backfills preserve unknown fields including
      `schema_version`.
- [x] session.json serialization: two concurrent `updateStatus` calls both land.

## Verification

- [x] `tsc` + full suite green.
- [x] e2e orchestration scripts that assert on `session.json` / `session-log.jsonl` (e.g.
      `orchestration-inbox-triage-test.ts:361–375`) still pass — the stamp is additive. **Verified
      2026-07-03:** all 10 orchestration e2e scripts green against live Obsidian + Bedrock
      (single-flow, inbox-triage, run-flow, terminal-paths, runtree-notices, meeting-notes,
      draft-critique, vault-health, weekly-review, zettelkasten).
      **⚠ This live run surfaced a Phase-B regression** (see the atomic-write note below).
- [x] Manual → converted to a unit drive (more precise than a live click). `history.test.ts`:
      a legacy conversation JSONL with **no** `schema_version` header loads with messages intact
      (the reader defaults it to 1 — `loadConversation`), and `toggleFavorite` on a legacy file
      adds `is_favorite` while preserving messages. **Note:** the toggle does NOT stamp
      `schema_version` (raw-header rewrite); the reader-side default is the safety net — so
      "field appears on toggle" from the original premise was inaccurate; the version defaults on
      *load*, not on toggle.
- [x] Grep gate: `grep -rn "adapter.write(.*existing" src/chat/history.ts` → zero hits.
- [x] Risk smoke-checked (by inspection — desktop harness can't drive the mobile adapter):
      `adapter.process` is documented as atomic in the Obsidian `DataAdapter` contract
      (`obsidian.d.ts:1642` — "Atomically read, modify, and save"), which both desktop and mobile
      (Capacitor) adapters implement, and `atomicRewrite` uses it directly. The one custom
      temp+rename path (`VaultSessionFs.write`) is orchestration-only and desktop-gated. The
      documented temp+rename fallback is in place. **Mobile live smoke-check remains N/A on the
      desktop Playwright harness.**

### ⚠ Regression found + fixed during live verification (2026-07-03)

Phase B's `VaultSessionFs.write` used `write(tmp)` → `rename(tmp, target)` with a comment
asserting "rename-over-existing is atomic on the desktop adapter." That assumption is **wrong**:
Obsidian's desktop `adapter.rename` throws `"Destination file already exists!"` when the target
exists. Effect: `session.json` finalize (`updateStatus` → `writeMeta`) threw, leaving **every
completed orchestration flow stuck at status `active`** (and step-conversation edge backfill
failed the same way). This is the exact "remove-before-rename gap" B.2 noted but assumed away; no
unit test caught it because the fake-fs doubles modeled `rename` as a silent overwrite.
**Fix (commit `fe16705`):** remove the target before rename (matching the working idiom in
`dedup-cache.ts`), plus a `launch-wiring.test.ts` regression using a rename-strict fake adapter.
Re-verified: single-flow reaches `completed` in ~12s and all 10 orchestration scripts pass.
