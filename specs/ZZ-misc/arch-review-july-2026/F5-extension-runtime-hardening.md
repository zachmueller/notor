# F5 — Extension runtime: version handshake, execution timeouts, facade narrowing (HIGH)

**Status:** Ready to implement
**Source review:** `private/architecture-review-2026-07-01.md` §F5 (git-ignored)
**Prior art (load-bearing):** `specs/ZZ-misc/arch-review-june-2026/stage-1-implementation-plan.md`
already specifies most of this work in implementable detail — §1 "Runtime API v1 — version handshake +
narrow facades" (lines 63–222) and §5 "Execution timeout + full-privilege acknowledgment" (lines
502–583). **None of it shipped** (grep for `RUNTIME_API_VERSION`, `notor-min-api`,
`extension_execution_timeout_ms`, `with-timeout` in `src/` → zero hits). This spec does not re-derive
that plan; it re-verifies its premises at `c0d21e9`, corrects one error in it, adds what changed since
June (webview exposure, the code-step timeout precedent, the code-step bypass), and re-sequences.
**Code verified against:** HEAD `c0d21e9`, re-verified by direct read on 2026-07-02.
**Effort:** M (~3 days across three independently landable parts).

> **Correction to the June stage-1 plan (§1 step 4):** the scaffold migration list omits
> `delete-note` — `builtin-tool-scaffolds/delete-note.ts:35` also calls
> `utils.checkpointManager.createCheckpoint`. The real set is **8 scaffolds / 7 `createCheckpoint`
> sites** (its own risk note #2 anticipated this). Line numbers in that plan have drifted; symbols hold.

---

## 1. Problem statement (verified current state)

The extension runtime executes user-authored code with the plugin's full trust and no contract:

- **Compile:** Sucrase strip → bare `new AsyncFunction(...)` (`compiler.ts:15–18`, `compileFunction`
  :98–103). No sandbox. Correctly the *single* chokepoint — orchestration code steps reuse it
  (`code-step-executor.ts:46, 185`).
- **Handed to user code:** the live `App` (`manager.ts:125–134` tools; :840–848 automations;
  `launch.ts:455` code steps); raw node `fs`/`crypto`/`path` in `libs`
  (`runtime-context/index.ts:40–42, 101–116`); and three **live manager instances**
  (`plugin-utils.ts:184–188`): `CheckpointManager` (7 methods incl. `restore` — writes user notes),
  `StaleContentTracker` (10 methods incl. `serialize`/`restore`), `NoteOpener` (3 methods).
- **No timeout:** `UserToolAdapter.execute` awaits `compiledFn` bare (`manager.ts:126`);
  `executeAutomation` returns it bare (:840). The only caller-level guard is the blocking
  `on_conversation_start` race (`hook-events.ts:977–996`), which on timeout **detaches** (re-invokes
  unawaited) — user code is never stopped. All other automation call sites plain-await.
- **No version handshake:** `buildUtils()` (`runtime-context/index.ts:60–93`) exposes ~42 members and
  no `api`/`version`; the frontmatter parser (`parser.ts:92–135`) recognizes no version key. Meanwhile
  `docs/extensions.md:515` documents `tested-notor-version` for community sharing as "informational
  only — the plugin does not enforce version checks at load time."
- **Exposure grew since June:**
  - `utils.webview` (`plugin-utils.ts:23–181`) hands every extension/automation/code step a live
    Electron `<webview>` with `executeJavaScript` — arbitrary JS injection into the page —
    unconditionally on desktop, **no settings gate**. The `webview` *tool* is gated (write-mode,
    default-disabled via `TOOLS_DEFAULT_DISABLED`, `settings/constants.ts:224`), but that gates only
    LLM dispatch; extension code reaching `utils.webview` directly is ungated.
  - Orchestration code steps get the identical unscoped `utils`/`libs`/`app` (`launch.ts:438–463`)
    alongside the carefully scoped `orchestration` helper — whose scratchpad path-traversal guard
    (`orchestration-helper.ts:222–229`) and MCP server filter (:261–274) therefore constrain **only
    the helper's own methods**: `libs.fs`, `utils.executeShellCommand`, and `app.vault.adapter` bypass
    them from the same function scope.
- **The counter-example now exists in-repo:** code steps got a timeout —
  `CodeStepExecutor.runWithTimeout` (`code-step-executor.ts:287–302`), default 300 s
  (`constants.ts:70`), per-step `notor-step-timeout-seconds` override, honestly documented as firing
  only at await boundaries, failing into `{step}.code_error`. ~16 lines. Its absence on the
  tool/automation path is now an inconsistency, not just a gap.

Why this is HIGH and not merely hygiene: the runtime cannot *stay* contract-free while docs advertise
community sharing, and prompt-injection → tool call → extension → `utils.webview.executeJavaScript` /
`libs.fs` is a real actuation chain. Worker isolation (the eventual fix) is **unbuildable until the
facades exist** — live class instances cannot cross a worker boundary.

## 2. Change — three independently landable parts

### Part 1 — Runtime API v1: `utils.api.version` + `notor-min-api` (S, ~50 lines)

Implement June stage-1 §1a as written, with these pins:

1. `export const RUNTIME_API_VERSION = 1` in a new tiny `src/extensions/runtime-context/version.ts`
   (avoids parser→runtime-context import cycle; the June plan's own suggestion). `buildUtils()` adds
   non-optional `api: { version: RUNTIME_API_VERSION }` to `ExtensionUtils`
   (`runtime-context/types.ts:97–460`). Code steps inherit it for free (same `buildUtils`,
   `launch.ts:441`).
2. Parser: recognize optional `notor-min-api` in `parseExtensionFile` after the `notor-type`
   validation (`parser.ts:98–105`), before the type-specific `switch` (:125). Malformed (non-integer)
   or `> RUNTIME_API_VERSION` → collected `ExtensionError { filePath, message }` naming the file, the
   required version, and the runtime version. Built-in scaffolds (synthetic paths, `manager.ts:314–319`)
   are exempt-or-correct by construction — keep them keyless.
3. Error surfacing already exists and is good: file-watcher reload shows a persistent per-file Notice
   (`main.ts:2581–2601`); settings "Reload extensions" shows a summary (`tool-shared-settings.ts:50–70`).
   No new UI.
4. Docs: replace the `docs/extensions.md:515` "informational only" paragraph — `tested-notor-version`
   stays informational, `notor-min-api` is the enforced key; document the semantics ("the runtime
   refuses to load an extension requiring a newer API"). Update the tool-creator persona and run the
   `audit-personas-docs` skill afterward (its remit includes exactly this drift).

### Part 2 — Execution timeout for tools + automations (S–M)

Implement June stage-1 §5's timeout half (defer its acknowledgment-modal half — see §4):

1. Lift the proven pattern rather than inventing: new `src/utils/with-timeout.ts` exporting
   `withTimeout<T>(invoke: () => Promise<T>, ms: number): Promise<T>` — the
   `Promise.race` + always-`clearTimeout` shape of `runWithTimeout`
   (`code-step-executor.ts:287–302`), throwing a typed `ExtensionTimeoutError` whose message carries
   the same honest caveat ("fires only at an await boundary; a synchronous loop is not
   interruptible"). Refactor `CodeStepExecutor.runWithTimeout` to delegate to it (three consumers, one
   implementation).
2. Wrap both call sites:
   - `UserToolAdapter.execute` step 5 (`manager.ts:124–134`): timeout → the existing structured error
     ToolResult path (:185–199), so the LLM sees a diagnosable tool error. Compose with, don't
     clobber, the merged `options?.abortSignal` (:92–94).
   - `executeAutomation` (`manager.ts:840–848`): timeout → throw; every caller already try/catches
     into `Notice("Automation error in {displayName}: …")`. Must preserve the `unknown` return-value
     contract (pre_send string-return = injected stdout, `hook-events.ts:499–503`;
     `on_approval_required` interprets `"approved"`/`"rejected"`, :1143–1160) — `withTimeout` is
     transparent on the success path, so this holds by construction.
   - Leave the `on_conversation_start` blocking race (`hook-events.ts:977–996`) as-is — it now
     composes: the inner timeout actually errors the automation; the outer race still bounds the
     *blocking* window.
3. Setting: `extension_execution_timeout_seconds` (default **300**, matching the code-step default;
   `0` = disabled) in `NotorSettings` (`settings/types.ts`, extension cluster near :425–442) +
   `defaults.ts`; rendered next to `renderReloadExtensionsButton` in the Tools section (there is no
   separate Extensions group — a legacy one is even deleted at `settings-tab.ts:156`). Per-extension
   override is out of scope v1 (code steps already have per-step override; tools can gain a
   frontmatter key later if needed).

### Part 3 — Facade narrowing (D-compat) (M) — **the gate for worker isolation**

Implement June stage-1 §1b with the corrected scaffold set:

1. Replace the three live-instance members of `ExtensionUtils` with minimal facades (closures over the
   plugin's lazy getters):
   - `checkpoints: { create(notePath, toolName, messageId) }` — the only method scaffolds use
     (`createCheckpoint` ×7: `delete-note.ts:35`, `import-docx.ts:155`, `manage-tags.ts:41`,
     `move-note.ts:54`, `replace-in-note.ts:101`, `update-frontmatter.ts:45`, `write-note.ts:56`).
     Notably **not** `restore`/`getCheckpoint` — extensions lose the ability to restore arbitrary
     checkpoints, which is the point.
   - `staleContent: { recordRead, check, invalidate, updateAfterWrite, updateAfterFrontmatterWrite }`
     — exactly the 5-of-10 methods scaffolds use (grep verified). `serialize`/`restore`/`clear`/
     `getEntry`/`hasBeenRead` stay internal.
   - `notes: { open(notePath) }` — `openNote` is the only method used (×6). The per-invocation
     `NoteOpener` replacement (`manager.ts:106–114`, `launch.ts:442–446`) becomes an internal detail
     behind the facade (the facade closure reads the invocation-scoped opener, preserving the
     orchestration open-notes decision).
2. Migrate the **8** scaffolds; delete the raw members from `ExtensionUtils` in the same release
   (June's D-compat decision: extensions are pre-1.0, one clean break with a migration note —
   the plan's §1 migration text at lines 191–198 is ready to reuse). Update `docs/extensions.md:398–400`
   rows and the tool-creator persona.
3. Code steps inherit the narrowing automatically (same `buildUtils`) — this is what turns the
   orchestration helper's isolation from advisory to real *for these three surfaces*. `libs.fs` and
   `app` remain (worker isolation is the eventual answer; June §6's design note stays deferred).
4. **New since June — webview gating (small addition, this spec's only novel scope):** gate
   `utils.webview` construction on the same opt-in that gates the tool: in `buildPluginUtils`, expose
   `webview` only when the `webview` tool is enabled in settings (it is in `TOOLS_DEFAULT_DISABLED`,
   so default = absent), otherwise a stub whose methods throw a clear "enable the webview tool in
   Settings → Tools" error. This closes the "tool gated, utils ungated" asymmetry with one conditional
   and no new setting.

## 3. Test plan

| Test | File | Asserts |
|---|---|---|
| Parser version key | `parser.test.ts` (pattern exists) | absent key → loads; `notor-min-api: 1` → loads; `2` → ExtensionError naming file+versions; malformed → ExtensionError |
| `utils.api` | `manager.test.ts` or runtime-context test | `buildUtils().api.version === 1`; code-step utils carries it too |
| Tool timeout | `manager.test.ts` (`UserToolAdapter.execute` harness at :587+ with mock `compiledFn`) | never-resolving fn + tiny timeout → structured error ToolResult with `ExtensionTimeoutError` message; use the zero-timeout trick from `code-step-executor.test.ts:282–305` (no fake timers needed) |
| Automation timeout | `manager.test.ts` | never-resolving automation rejects; fast automation's return value passes through unchanged |
| Facades | scaffold tests (`replace-in-scaffolds.test.ts` etc. compile real fences — they catch renames) + a facade round-trip unit | each facade method delegates; raw members gone from the type |
| Webview gate | runtime-context test | tool disabled → `utils.webview` absent/throwing; enabled → present |

## 4. Deliberately out of scope

- **Worker isolation** — unbuildable until Part 3 lands; June §6's design-note task stands.
- **`extensions_full_privilege_acknowledged` modal** (June §5's other half) — product-facing UX;
  decouple so the mechanical hardening isn't hostage to copy/UX review. Revisit immediately after.
- Scoping `libs.fs`/`app` for code steps specifically — that is the worker-isolation problem in
  miniature; don't half-build it here.
- Per-extension timeout overrides.

## 5. Verification

- `tsc` + suite; then a manual pass: an extension with `notor-min-api: 99` shows the persistent
  Notice and does not load; a tool that `await new Promise(()=>{})`s errors after the configured
  timeout instead of wedging the conversation; `word-count` and the 8 migrated scaffolds still work.
- Run `audit-personas-docs` (docs + tool-creator persona both change here — it exists to catch exactly
  the drift this touches).
- Grep gates: `grep -rn "checkpointManager\|staleTracker\b" src/extensions/builtin-tool-scaffolds/` →
  zero; `grep -rn "notor-min-api" docs/ src/` → parser + docs hits only.

## 6. Risks

- **Facade break is user-visible** for any third-party extension using the raw managers (pre-1.0,
  documented break; the persistent-Notice error surface means users see *which* file broke and why).
- Timeout default too low would kill legitimate long-running tools (large docx imports) — 300 s
  matches the code-step precedent and is generous; the setting is the escape hatch.
- The webview stub-throw could surprise an existing extension that assumed `utils.webview` always
  exists on desktop — acceptable: it previously returned working handles silently; now it names the
  gate. Document in the migration note.
