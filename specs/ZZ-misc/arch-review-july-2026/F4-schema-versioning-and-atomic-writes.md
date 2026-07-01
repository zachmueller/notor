# F4 — Schema-version the six persisted formats; make history/session writes atomic (HIGH)

**Status:** Ready to implement
**Source review:** `private/architecture-review-2026-07-01.md` §F4 (git-ignored)
**Prior art:** `specs/ZZ-misc/arch-review-june-2026/stage-0-implementation-plan.md` item 2 specified
`schema_version` for the *three* formats known in June (history, checkpoints, memory notes). It never
shipped. This spec subsumes it, adds the three formats created since (session log, step-conversation
headers, session.json), and adds the atomicity work the June plan did not cover. Where the June text
already nails the mechanics (checkpoint required-field + `??= 1` normalization), it is referenced, not
re-derived.
**Code verified against:** HEAD `c0d21e9`, re-verified by direct read on 2026-07-01/02.
**Effort:** S–M (~2 days including tests). Pure insurance + crash-window hardening; no behavior change.

> Verified: `grep -rn "schema_version\|notor-schema\|schemaVersion\|formatVersion" src/` → zero hits.
> The only version gate in the repo is the tool-config XML parser (`src/tool-config/parser.ts:24, 89–97`,
> `MAX_SUPPORTED_MAJOR = 1`, skip-and-warn on newer major) — use it as the in-repo precedent for
> reader-side defaulting/gating. Settings migrations are detection-based (`settings/migrations.ts`).

---

## 1. Problem statement

Six persisted formats, none versioned, several vault-resident (they sync to devices running other
plugin versions). The first breaking shape change makes old data fail **undetectably** — the
orchestration session log is explicitly "the crash-recovery source of truth" (`session-log.ts:4`), and
both F1 (child-ledger enrichment) and F3 (`ChildResultEntry` cost fields) are about to change entry
shapes, so stamping is urgent, not theoretical.

Separately, `HistoryManager` mutations are read-modify-**full-rewrite** (`adapter.write(filePath,
existing + line)`) with no temp+rename: a crash mid-write can truncate an **entire conversation**, not
just a tail. `session.json` is a read-modify-write with **no write queue at all** — concurrent
`updateStatus` calls (runner pause seam racing finalize) can interleave and lose a patch.

### 1.1 The six formats (all verified)

| # | Format | Writer(s) | Reader(s) | Vault-resident / syncs? |
|---|---|---|---|---|
| 1 | Conversation JSONL header (`_type: "conversation"`) | `createConversationFile` (`history.ts:171–177`), appendMessage fallback (:207–211), `updateConversationHeader` (:323–328), `importConversation` (:400–406), `writeSubAgentConversation` (:452–461), HTML export block (`html-exporter.ts:708–722`) | `loadConversation` (:541–547, blind cast), `listConversations` (:644–660), `searchConversations` (:745–750), `toggleFavorite` (:363), `run-tree-view.ts:218` | under `.obsidian/plugins/notor/history/` — syncs with file-level sync tools |
| 2 | Checkpoint JSON | `CheckpointStorage.save` (`storage.ts:59–74`); object built at `checkpoint.ts:97–106` | `load` (:92–93, `JSON.parse(raw) as Checkpoint`), `listForConversation` (:116–117) | same |
| 3 | Memory note frontmatter | `serializeNote` (`note-format.ts:25–31`), `serializePendingNote` (:89–107) | `parseNote` (:40–71 — **no frontmatter → silently returns empty-field note**), `parsePendingNote` (:109–143) | **vault notes — definitely syncs**; also API-visible to extensions via `utils.memory` (`runtime-context/types.ts:283–293`) |
| 4 | Orchestration `session-log.jsonl` | `SessionLog` append methods (`session-log.ts:204–276`) via `SessionLogWriter.append` → `adapter.append` (`launch.ts:190–197`) | `SessionLogReader.parse` (`session-log-reader.ts:52–101`) + **two ad-hoc tolerant readers**: `reconcileChildLedger` (`launch.ts:917–927`), `resolveChildEntryConversationId` (`launch.ts:1029–1037`) | **vault-resident** (`{notor_dir}/orchestrations/sessions/{id}/`) — syncs |
| 5 | Step-conversation JSONL header (`_type: "orchestration_step_conversation"`) | `buildStepConversationHeader` (`step-conversation-store.ts:76–104`), `persist` (:121–145) | `backfillNextEdge` (:148–174), `backfillParentEdge` (`launch.ts:1045–1076`), run-tree scan (`run-tree-view.ts:201–225`) | history dir (as #1) |
| 6 | `session.json` (`OrchestrationSessionMeta`, `orchestration/types.ts:150–169`) | `createSession` (`session-manager.ts:131–141`), `writeMeta` (:160–167), `updateStatus` (:174–184) | `readMeta` (:153–157, blind cast), recovery scan (`session-recovery.ts:275–281`), child resume (`launch.ts:973`) | **vault-resident** — syncs |

Adjacent formats deliberately **out of scope** (note for a future pass): task notes
(`task-registry.ts:35–48`), memory dedup cache / dream cursor (`dedup-cache.ts`), `memories.md`
(explicitly free-form).

### 1.2 Atomicity findings (verified)

- True rewrite-appends (convertible to `adapter.append`): `appendMessage` (`history.ts:202–203`),
  `appendStaleState` (:237–238). *(The review's site list cited :406/:461 as rewrites — those are
  single-shot batch creates; and it omitted :238. Corrected here.)*
- Header-surgery full rewrites (need atomic replace): `updateConversationHeader` (:328),
  `toggleFavorite` (:370), `backfillNextEdge` (`step-conversation-store.ts:170` via
  `StepConversationFs.write`), `backfillParentEdge` (`launch.ts:1071`, direct adapter), `writeMeta`
  (`session-manager.ts:166` via `SessionFs.write`).
- All history mutations already funnel through the per-file write queue
  (`HistoryManager.enqueueWrite`, `history.ts:142–153`; drains via `flush()` :952–957) — so the append
  conversion is **localized to history.ts**; no caller changes.
- `session.json` has **no** write serialization.
- Available adapter API (verified in `obsidian.d.ts`): `append` (:1640), `process` (:1649 —
  "**Atomically** read, modify, and save the contents of a plaintext file"), `rename`, `remove`,
  `copy`. In-repo temp+rename precedent: `dedup-cache.ts:51–77` (`.tmp` write → remove → rename; note
  its remove-before-rename gap — prefer `adapter.process` where applicable).
- Gold standard already in-repo: `SessionLog.write` (`session-log.ts:285–302`) — serialized promise
  chain over true `adapter.append`.

---

## 2. Change

### 2.1 Part A — `schema_version: 1` in all six formats (S)

Uniform policy (June item 2's doctrine, extended): **writers stamp `1`; readers default missing → `1`;
no migration logic until a v2 exists.** Optional-but-recommended gate: readers that would *misbehave*
on a future v2 (recovery, checkpoints-restore) refuse versions `> 1` with a clear error, mirroring
`tool-config/parser.ts`.

1. **Conversation header:** add `schema_version?: number` to `Conversation` (`types.ts:24`) — it then
   flows through every `{ _type: "conversation", ...conversation }` spread automatically once set at
   creation (`createConversationFile`, `importConversation`) — verify each of the six writer sites in
   §1.1 row 1 emits it; `writeSubAgentConversation`'s metadata literal (`history.ts:430–443`) needs the
   explicit field. Readers: normalize `header.schema_version ??= 1` in `loadConversation` and
   `listConversations`; `toggleFavorite`/`updateConversationHeader` must **preserve** the field (they
   spread the parsed header — verify, don't assume). HTML export/import round-trips through
   `importConversation`, so it inherits the stamp.
2. **Checkpoints:** per June item 2b verbatim — required `schema_version: number` on `Checkpoint`
   (`types.ts:389–406`), set at the single construction site (`checkpoint.ts:97–106`), reader `??= 1`
   normalization at `storage.ts:93` and `:117`. Add the minimal shape validation the blind cast lacks
   (id/conversation_id/note_path/content present → else warn + skip) while touching it — restore writes
   user notes; garbage in must not restore garbage out.
3. **Memory notes:** per June item 2c — `notor-schema: 1` line in both serializers
   (`note-format.ts:25–31, 89–107`); readers extract with `?? 1` default. `patchFrontmatterField`
   (:156–184) inserts after the last `notor-*` line — composes fine. Note in the PR that `MemoryNote`
   is extension-API-visible; adding an optional field is non-breaking.
4. **Session log:** version the **stream, not every entry**: extend `SessionStartEntry`
   (`session-log.ts:37–44`) with `schema_version: number` stamped by `appendSessionStart`.
   `SessionLogReader.parse` reads it off the first entry when present, defaults 1, and exposes it on
   `ParsedSessionLog`; recovery (`session-recovery.ts`) refuses versions `> 1` with a diagnosable scan
   error (the loud-error path at `launch.ts:1151–1155` already exists for exactly this kind of
   failure). Per-entry `v` fields are noise — a log is written by one plugin version per lifetime, and
   the truncated-final-line policy (`session-log-reader.ts:87–97`) is unaffected. **Do this before or
   with F1/F3's entry-shape changes** so those ride a versioned format.
5. **Step-conversation header:** one field in `buildStepConversationHeader`
   (`step-conversation-store.ts:86–103`); default-on-read in the run-tree scan and both backfills
   (which must preserve it on rewrite — they mutate the parsed object, so it survives automatically;
   assert in tests).
6. **session.json:** field on `OrchestrationSessionMeta` (`orchestration/types.ts:150`), stamped in
   `createSession` (`session-manager.ts:131–141`), defaulted in `readMeta` (choke point for two of the
   three readers) **and** in the recovery scan's independent parse (`session-recovery.ts:281`).

### 2.2 Part B — Atomic/append writes (S–M)

1. **Convert the two true appends** (`appendMessage` :203, `appendStaleState` :238) to
   `await this.vault.adapter.append(filePath, line + "\n")`, keeping them inside `enqueueWrite`
   (ordering vs. header rewrites still matters). **Sharp edge:** `adapter.append` creates-if-absent, so
   the current catch-fallback that writes header+line on missing file (:204–212) must become an
   explicit `adapter.exists` check *before* the append — otherwise a missing file silently becomes a
   header-less JSONL that `loadConversation` will reject.
2. **Atomic header surgery:** introduce one shared helper (suggested home `src/utils/atomic-write.ts`):
   `atomicRewrite(adapter, path, mutate: (content: string) => string)` implemented with
   `adapter.process(path, mutate)` (atomic per the API contract). Where a seam interface intervenes
   (`StepConversationFs`, `SessionFs`), either extend the seam with `process`-like semantics or keep
   `write` and implement temp+rename in the production adapter (`VaultSessionFs`,
   `VaultStepConversationStore`'s fs) — **pick `adapter.process` for direct-adapter sites
   (`toggleFavorite`, `updateConversationHeader`, `backfillParentEdge`) and temp+rename inside the
   production seam adapters**, so the pure cores stay unchanged and fakes stay trivial. Fix the
   remove-before-rename gap if copying the `dedup-cache.ts` pattern (rename over existing file works on
   the desktop adapter; verify on mobile adapter or keep remove-then-rename with the gap documented).
3. **Serialize session.json writes:** give `OrchestrationSessionManager` a per-session promise chain
   (the `SessionLog.writeChain` pattern, `session-log.ts:285–302`) wrapping `readMeta→mutate→writeMeta`
   in `updateStatus`, so runner-seam and finalize writers can't interleave. Combined with temp+rename
   (step 2), this closes both the lost-patch race and the truncation window that currently sends
   recovery to the `error` path.
4. Batch creates (`createConversationFile`, `importConversation`, `writeSubAgentConversation`,
   step-store `persist`) stay plain writes — single-shot creation has no torn-state reader.

## 3. Test plan

| Test | File | Asserts |
|---|---|---|
| Round-trip stamp | per-format existing test files (`session-manager.test.ts`, `session-log.test.ts` + reader test, `step-conversation-store.test.ts`, `note-format.test.ts`; **new** `storage.test.ts` for checkpoints — currently zero) | write → read → `schema_version === 1` |
| Legacy tolerance (load-bearing) | same | hand-crafted artifact **without** the field parses, defaults to 1, nothing throws |
| Future-version gate | `session-log-reader.test.ts`, checkpoint test | `schema_version: 2` → recovery scan error / checkpoint skip-with-warn (not a crash) |
| Append conversion | `history.test.ts` — needs a **stateful** fake adapter with `append`/`process`/`exists` (current `makeVault` fake at :23–36 has write-as-no-op; upgrade it, modeled on `FakeSessionFs`) | appendMessage on existing file appends exactly one line; on missing file creates header+line; header rewrite preserves messages + `schema_version` |
| Header preservation | history + step-store tests | `toggleFavorite`/backfills preserve unknown fields incl. `schema_version` |
| session.json serialization | `session-manager.test.ts` | two concurrent `updateStatus` calls both land (no lost patch) |

## 4. Verification

- `tsc` + suite green; e2e orchestration scripts (which assert on `session.json` / `session-log.jsonl`,
  e.g. `orchestration-inbox-triage-test.ts:361–375`) still pass — the stamp is additive.
- Manual: open a pre-change conversation (no version field) → loads; favorite-toggle it → field
  appears and messages intact.
- Grep gate: `grep -rn "adapter.write(.*existing" src/chat/history.ts` → zero.

## 5. Risks & sequencing

- **Coordinate with F1/F3** (both enrich session-log entries): land Part A step 4 first or in the same
  release, so the entry-shape changes are the first "v1-stamped" additions rather than another
  unversioned drift.
- `adapter.process` availability/atomicity on the **mobile** adapter should be smoke-checked once
  (the API contract says atomic; mobile file systems differ). Fallback is documented temp+rename.
- The checkpoint `schema_version` is required-in-type but absent in legacy files — the `??= 1`
  read normalization is what keeps the type honest (June item 2's exact "do not skip" warning).
- This is the third review cycle for this item. It is deliberately scoped to be one-sitting shippable:
  Part A alone (~half day) removes the undetectable-break risk; Part B can trail by a few days without
  blocking F1/F3.
