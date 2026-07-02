# Task 05 — Extension runtime: version handshake, execution timeouts, facade narrowing

**Spec:** [../F5-extension-runtime-hardening.md](../F5-extension-runtime-hardening.md), which
re-verifies and reuses `specs/ZZ-misc/arch-review-june-2026/stage-1-implementation-plan.md`
(§1 handshake+facades, §5 timeout — read both before starting; the June plan carries the
implementable detail, the F5 spec the corrections).
**Depends on:** nothing. **Parallelizable** with Tasks 02–04 — this touches only
`src/extensions/`, `src/utils/with-timeout.ts`, settings, and docs; zero overlap with
`launch.ts`/`run-loop.ts`/`dispatcher.ts`. Land before Task 06 to keep the end state stable.

Known June-plan correction (from F5): the scaffold migration set is **8 scaffolds / 7
`createCheckpoint` sites** — the June list omitted `builtin-tool-scaffolds/delete-note.ts:35`.

Three independently landable parts = three phases, each its own commit(s).

---

## Phase 1 — Runtime API v1: `utils.api.version` + `notor-min-api` (commit 1)

- [ ] **1.1** `export const RUNTIME_API_VERSION = 1` in new
      `src/extensions/runtime-context/version.ts` (tiny separate file avoids a
      parser→runtime-context import cycle).
- [ ] **1.2** `buildUtils()` (`runtime-context/index.ts:60–93`) adds non-optional
      `api: { version: RUNTIME_API_VERSION }` to `ExtensionUtils`
      (`runtime-context/types.ts:97–460`). Code steps inherit it for free (same `buildUtils`,
      `launch.ts:441`).
- [ ] **1.3** Parser: recognize optional `notor-min-api` in `parseExtensionFile` after the
      `notor-type` validation (`parser.ts:98–105`), before the type-specific switch (:125).
      Malformed (non-integer) or `> RUNTIME_API_VERSION` → collected
      `ExtensionError { filePath, message }` naming the file, required version, and runtime
      version. Built-in scaffolds (synthetic paths, `manager.ts:314–319`) stay keyless —
      exempt-or-correct by construction.
- [ ] **1.4** No new error UI needed: file-watcher reload already shows a persistent per-file
      Notice (`main.ts:2581–2601`); settings "Reload extensions" shows a summary
      (`tool-shared-settings.ts:50–70`).
- [ ] **1.5** Docs: replace the `docs/extensions.md:515` "informational only" paragraph —
      `tested-notor-version` stays informational; `notor-min-api` is the enforced key ("the
      runtime refuses to load an extension requiring a newer API"). Update the tool-creator
      persona.

## Phase 2 — Execution timeouts for tools + automations (commit 2)

- [ ] **2.1** New `src/utils/with-timeout.ts`:
      `withTimeout<T>(invoke: () => Promise<T>, ms: number): Promise<T>` — lift the
      `Promise.race` + always-`clearTimeout` shape from `CodeStepExecutor.runWithTimeout`
      (`code-step-executor.ts:287–302`), throwing a typed `ExtensionTimeoutError` whose message
      carries the honest caveat ("fires only at an await boundary; a synchronous loop is not
      interruptible"). Refactor `runWithTimeout` to delegate — three consumers, one
      implementation.
- [ ] **2.2** Wrap `UserToolAdapter.execute` step 5 (`manager.ts:124–134`): timeout → the
      existing structured-error ToolResult path (:185–199) so the LLM sees a diagnosable tool
      error. Compose with, don't clobber, the merged `options?.abortSignal` (:92–94).
- [ ] **2.3** Wrap `executeAutomation` (`manager.ts:840–848`): timeout → throw; every caller
      already try/catches into `Notice("Automation error in {displayName}: …")`. The `unknown`
      return-value contract must hold (pre_send string = injected stdout,
      `hook-events.ts:499–503`; `on_approval_required` interprets `"approved"`/`"rejected"`,
      :1143–1160) — `withTimeout` is transparent on success, so it holds by construction.
- [ ] **2.4** Leave the `on_conversation_start` blocking race (`hook-events.ts:977–996`) as-is —
      it now composes: the inner timeout actually errors the automation; the outer race bounds
      only the blocking window.
- [ ] **2.5** Setting: `extension_execution_timeout_seconds`, default **300** (matches the
      code-step default, `constants.ts:70`), `0` = disabled — in `NotorSettings`
      (`settings/types.ts`, extension cluster near :425–442) + `defaults.ts`; rendered next to
      `renderReloadExtensionsButton` in the Tools section. Per-extension override deliberately
      out of scope v1.

## Phase 3 — Facade narrowing + webview gate (commits 3–4) — the gate for worker isolation

- [ ] **3.1** Replace the three live-instance members of `ExtensionUtils`
      (`plugin-utils.ts:184–188`) with minimal facades (closures over the plugin's lazy
      getters):
      - `checkpoints: { create(notePath, toolName, messageId) }` — the only method scaffolds
        use. Deliberately **not** `restore`/`getCheckpoint`: extensions lose the ability to
        restore arbitrary checkpoints; that's the point.
      - `staleContent: { recordRead, check, invalidate, updateAfterWrite,
        updateAfterFrontmatterWrite }` — the 5-of-10 methods scaffolds use (grep-verified);
        `serialize`/`restore`/`clear`/`getEntry`/`hasBeenRead` stay internal.
      - `notes: { open(notePath) }` — the per-invocation `NoteOpener` replacement
        (`manager.ts:106–114`, `launch.ts:442–446`) becomes an internal detail behind the
        facade (the closure reads the invocation-scoped opener, preserving the orchestration
        open-notes decision).
- [ ] **3.2** Migrate the **8** scaffolds (7 `createCheckpoint` sites: `delete-note.ts:35`,
      `import-docx.ts:155`, `manage-tags.ts:41`, `move-note.ts:54`, `replace-in-note.ts:101`,
      `update-frontmatter.ts:45`, `write-note.ts:56`; plus staleContent/notes call sites).
      Delete the raw members from `ExtensionUtils` in the **same release** — D-compat clean
      break (pre-1.0), with the migration note (June plan §1 lines 191–198 has ready text).
      Update `docs/extensions.md:398–400` and the tool-creator persona.
- [ ] **3.3** Code steps inherit the narrowing automatically (same `buildUtils`) — this turns
      the orchestration helper's isolation from advisory to real for these three surfaces.
      `libs.fs` and `app` remain: worker isolation is the deferred answer; don't half-build it.
- [ ] **3.4 Webview gate** (this task's only novel scope vs. June): in `buildPluginUtils`,
      expose `utils.webview` (`plugin-utils.ts:23–181`) only when the `webview` **tool** is
      enabled in settings (it's in `TOOLS_DEFAULT_DISABLED`, `settings/constants.ts:224`, so
      default = absent); otherwise a stub whose methods throw a clear "enable the webview tool
      in Settings → Tools" error. Closes the tool-gated/utils-ungated asymmetry with one
      conditional and no new setting.

## Deliberately out of scope (from the spec — don't scope-creep)

Worker isolation; the `extensions_full_privilege_acknowledged` modal (June §5's other half —
product UX, revisit after); scoping `libs.fs`/`app` for code steps; per-extension timeout
overrides.

## Tests

- [ ] Parser version key (`parser.test.ts`): absent → loads; `notor-min-api: 1` → loads; `2` →
      ExtensionError naming file+versions; malformed → ExtensionError.
- [ ] `utils.api` (`manager.test.ts` or runtime-context test): `buildUtils().api.version === 1`;
      code-step utils carries it too.
- [ ] Tool timeout (`manager.test.ts`, `UserToolAdapter.execute` harness at :587+): never-
      resolving fn + tiny timeout → structured error ToolResult with `ExtensionTimeoutError`
      message. Use the zero-timeout trick from `code-step-executor.test.ts:282–305` — no fake
      timers.
- [ ] Automation timeout: never-resolving automation rejects; fast automation's return value
      passes through unchanged.
- [ ] Facades: scaffold tests (`replace-in-scaffolds.test.ts` etc. compile real fences — they
      catch renames) + a facade round-trip unit; raw members gone from the type.
- [ ] Webview gate: tool disabled → `utils.webview` absent/throwing; enabled → present.

## Verification

- [ ] `tsc` + suite green.
- [ ] Manual: extension with `notor-min-api: 99` → persistent Notice, does not load; a tool that
      `await new Promise(()=>{})`s errors after the configured timeout instead of wedging the
      conversation; `word-count` and the 8 migrated scaffolds still work.
- [ ] Run the `audit-personas-docs` skill (docs + tool-creator persona both change here).
- [ ] Grep gates:
      `grep -rn "checkpointManager\|staleTracker\b" src/extensions/builtin-tool-scaffolds/` →
      zero; `grep -rn "notor-min-api" docs/ src/` → parser + docs hits only.
- [ ] Migration note covers: facade break for third-party extensions using raw managers;
      webview stub-throw on desktop where it previously always existed.
