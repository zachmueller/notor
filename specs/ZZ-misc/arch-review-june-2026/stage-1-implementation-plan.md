# Stage 1 (+ 1b) — Implementation Plan ("Define the contracts" + sharing safety)

**Status:** Ready to implement (after Stage 0 lands)
**Parent spec:** [`../fable-architecture-review-2606.md`](../fable-architecture-review-2606.md) §4 (Stage 1 / Stage 1b), §5 matrix, §6 risk notes
**Sibling plan:** [`stage-0-implementation-plan.md`](./stage-0-implementation-plan.md) (must land first — several items here build on it)
**Source review:** `private/architecture-review-2026-06-11.md` + `private/architecture-review-2026-06-11-code-map.md` (git-ignored)
**Code verified against:** working tree at HEAD `a62e637` (which adds *only* the parent spec + Stage-0 plan on top of the reviewed `f7049d0`; all `src/` is byte-identical to the commit the review cites). Re-verified by direct read on 2026-06-14 via five parallel read-only agents (one per Stage-1 contract).

> **Line-number caveat.** Every `file:line` below was confirmed by direct read at `a62e637`. Line numbers
> drift. **Re-locate by symbol name at implementation time, not by line.** Where a range is given it is to
> scope the work, not to be applied as a patch coordinate.

---

## 0. Scope & sequencing

Stage 1 is **the strategic move**: it converts "everything is implicitly frozen / logic lives at call
sites" into "these are the stable internal contracts; everything else may change." Five contracts, plus the
promoted **Stage 1b sharing-safety** work (combined into this doc per the parent spec, because 1b's
execution-timeout is cheap and rides alongside Stage 1, and its Phase-2 design note is *only* expressible
once 2.1's facades exist).

### The five Stage-1 contracts + 1b

| # | Item | Issue | Effort | Risk | Depends on |
|---|------|-------|--------|------|------------|
| 1 | **Runtime API v1** — `utils.api.version`, `notor-min-api` key, narrow facades over live managers | 2.1 | L | Med | — (keystone) |
| 2 | **Unified `discoverVaultContent` engine** — one discovery pass, unified error aggregation | 2.4 | L | Med | — |
| 3 | **Renderer registry for built-in block kinds** | 5.2 | L | Med-High | — |
| 4 | **Provider capability interface** — `getCapabilities()` + `resolveThinkingConfig()` | 4.2(½)/4.3 | M | Med | Stage 0 item 5 (metadata hygiene) |
| 5 | **1b — Execution timeout + full-privilege ack + capability doc** | 2.2 Phase 1 | S | Low | — |
| 6 | **1b — Worker-isolation design note (NOT build)** | 2.2 Phase 2 | — | — | item 1 (facades) |

### Critical ordering — what gates what

The dependency edges are **load-bearing, not preference** (parent spec §6 risk notes #4, #6):

1. **Item 1 (facades) is the keystone.** It gates item 6 (you cannot proxy live manager objects across a
   worker boundary — the facade must exist first). It is *independent* of items 2–5, so it can run in
   parallel with them, but it should be the **first L item scheduled** because the worker-isolation design
   note (item 6) and any future third-party-provider/registration work all rest on a frozen surface.
2. **Item 4 builds on Stage 0 item 5.** The Stage-0 plan already adds geo-prefix normalization +
   warn-on-fallback *inside* `model-metadata.ts`. Item 4 here is the **next increment**: move the data
   *behind* `provider.getCapabilities(modelId)`. Do not start item 4 until Stage 0 item 5 has landed, or the
   two will conflict in the same file.
3. **Items 2, 3, 5 are independent** of each other and of 1/4 — they touch disjoint files
   (`*/discovery.ts`, `ui/`, `extensions/manager.ts` respectively) and can land in any order.
4. **Item 5 (timeout + ack) is cheap and should land early** as the visible safety win; item 6 is a
   *document*, written last (after item 1's facades exist so it can reference them concretely).

### Relationship to other stages (do NOT scope-creep into these)

- **2.5 loop middleware (Stage 4)** depends on item 1's stable transform context — not in scope here.
- **2.6 / 4.5 open registration seams (Stage 4)** depend on item 1 + item 4 — item 4 does the *prep*
  (`ProviderDescriptor`-shaped consolidation is **explicitly deferred** to Stage 4; this plan only adds the
  capability methods to the existing interface).
- **3.1 pipeline split (Stage 2)** is what makes partial/streamed transcript elements first-class; item 3
  here stops at migrating the *existing* built-in kinds onto the registry, streamed text **last**.
- **3.3 `Tool.policyCheck?()`** is Stage-1-adjacent but belongs with the Stage-0.5 policy work — not here.

---

## 1. Runtime API v1 — version handshake + narrow facades (Issue 2.1) — L, medium risk

This is **the keystone**. Today every one of the ~40 `utils` members + 12 `libs` + 8 `obsidian` exports is
*implicitly* frozen — any rename silently breaks user vaults on update — and three members hand out **live
manager instances** whose entire public method surface is transitively frozen too. v1 makes the freeze
*explicit and narrow*.

### Current state (verified)

**The injected parameter contract** (`src/extensions/compiler.ts`):
- `TOOL_ARG_NAMES = ["app", "obsidian", "utils", "libs", "settings", "shared", "params"]` (~line 67);
  `AUTOMATION_ARG_NAMES` identical but `"context"` replaces `"params"` (~line 70).
- `AsyncFunction` captured at ~15–17; `compileToolFunction` ~76–78, `compileAutomationFunction` ~84–86,
  `compileBlockModule` ~103–127, `compileExtension(rawCode, type)` pipeline ~140–163.

**The surface** (`src/extensions/runtime-context/types.ts`):
- `ExtensionUtils` (~49–327): ~40 members. **No version field anywhere.**
- `ExtensionLibs` (~340–353): 12 libs incl. raw node `fs`/`crypto`/`path` (~350–352).
- `ExtensionObsidianExports` (~356–365): 8 members.
- **Live-manager members** (the freeze hazard):
  - `staleTracker: StaleContentTracker` (~51)
  - `checkpointManager: CheckpointManager` (~52)
  - `noteOpener: NoteOpener` (~53)

**Where the object is built** (`src/extensions/runtime-context/plugin-utils.ts`):
```ts
staleTracker: plugin.getStaleTracker(),          // ~176
checkpointManager: plugin.getSharedCheckpointManager(),  // ~178
noteOpener: plugin.getNoteOpener(),              // ~180
```
(`buildUtils(plugin, conversationId?, sourceExtensionName?)` is the entry, `runtime-context/index.ts` ~59–91.)

**The transitive freeze surface — what the three managers expose**, and crucially **what is actually
consumed**. Grepping the built-in scaffolds (`src/extensions/builtin-tool-scaffolds/*` — which double as the
canonical usage examples) for real call sites:

| Manager | Full public surface (would-be frozen if handed raw) | **Actually consumed by built-in scaffolds** |
|---------|------------------------------------------------------|---------------------------------------------|
| `CheckpointManager` (`src/checkpoints/checkpoint.ts`) | `setConversationId`, `clearConversationId`, `createCheckpoint`, `listCheckpoints`, `getCheckpoint`, `restore`, `getCurrentContent` (7) | **`createCheckpoint` only** (×6) |
| `StaleContentTracker` (`src/chat/stale-tracker.ts`) | `recordRead`, `check`, `hasBeenRead`, `getEntry`, `clear`, `invalidate`, `updateAfterWrite`, `updateAfterFrontmatterWrite`, `serialize`, `restore` (10) | `recordRead` (×4), `check` (×2), `invalidate` (×1), `updateAfterWrite` (×3), `updateAfterFrontmatterWrite` (×2) — **5 methods** |
| `NoteOpener` (`src/tools/note-opener.ts`) | `setEnabled`, `setFocusEnabled`, `openNote` (3) | **`openNote` only** (×6) |

> **This grep is the single most useful fact for the facade design.** The review's strawman
> (`utils.checkpoints = { create, list, restore }`) over-shoots: real consumption is far narrower. The
> facade should cover **what the scaffolds actually call + what `docs/extensions.md` documents** — nothing
> more. `setConversationId`/`clearConversationId`, `serialize`/`restore`, `setEnabled`/`setFocusEnabled`
> are plugin-internal lifecycle/persistence methods that **must not** leak into the frozen surface.

**Docs** (`docs/extensions.md`, 529 lines): §"Runtime context" (~375–434) documents the utils/libs/obsidian
surface as prose + tables; lines ~398–400 already name `utils.staleTracker` / `utils.checkpointManager` /
`utils.noteOpener` (so the rename is a **documented breaking change** — exactly what D-compat permits). The
`audit-personas-docs` skill audits this file and the `tool-creator` persona, so both must be updated in
lockstep or the skill will flag drift.

**Frontmatter validation** (`src/extensions/parser.ts`): `parseExtensionFile` validates `notor-type`
(~98–105), `notor-tool-name`/`notor-description`/`notor-mode` (~147–161), `notor-trigger` (~223–229). **No
`notor-min-api` handling** (repo-wide grep clean — confirmed zero hits). Natural insertion: after the
`notor-type` validation, before type-specific validation.

### Change

**1a. Version handshake.**
1. Add to `ExtensionUtils` (types.ts) a non-optional `api` member:
   ```ts
   /** Runtime API contract version. Bump on any breaking change to the utils/libs/obsidian surface. */
   api: { version: number };
   ```
   Define a module constant `export const RUNTIME_API_VERSION = 1;` (a natural home is
   `runtime-context/index.ts` or a tiny `runtime-context/version.ts` so the parser can import it without a
   cycle). Assign `api: { version: RUNTIME_API_VERSION }` in `buildUtils()` / `plugin-utils.ts`.
2. Add an optional `notor-min-api` frontmatter key. In `parser.ts`, after `notor-type` validation:
   ```ts
   const minApi = frontmatter["notor-min-api"];
   if (minApi !== undefined) {
     const required = Number(minApi);
     if (!Number.isFinite(required)) { /* push ExtensionError: malformed notor-min-api */ }
     else if (required > RUNTIME_API_VERSION) {
       /* push ExtensionError: "requires API v{required}, this build provides v{RUNTIME_API_VERSION}" */
     }
   }
   ```
   This must produce a **collected, user-visible** `ExtensionError` (the same channel tools/automations
   already use), not a silent skip. The error message names the extension file and the version mismatch.
3. `RUNTIME_API_VERSION` stays `1` for this entire change — bumping it is a *future* event. v1's whole job
   is to make a future v2 *detectable and declarable*.

**1b. Narrow facades over the three live managers** (per D-compat — this is the breaking change that lets
the freeze actually constrain the surface). Replace the three raw-instance members with facades whose method
set is exactly the consumed surface above:

```ts
// in ExtensionUtils (types.ts) — REPLACES staleTracker / checkpointManager / noteOpener
checkpoints: {
  /** Snapshot a note's current content for later rollback. Returns null on failure (non-blocking). */
  create(notePath: string, toolName: string, messageId: string): Promise<Checkpoint | null>;
};
staleContent: {
  recordRead(notePath: string, content: string): void;
  check(notePath: string, currentContent: string): StaleCheckResult;
  invalidate(notePath: string): void;
  updateAfterWrite(notePath: string, newContent: string): void;
  updateAfterFrontmatterWrite(notePath: string, newFullContent: string): void;
};
notes: {
  open(notePath: string): Promise<void>;
};
```
- Names are a design choice; the table above is the *required method set*. (`checkpoints.create` maps to
  `checkpointManager.createCheckpoint`; `notes.open` → `noteOpener.openNote`.) Pick names once and document
  them — they are now frozen.
- Build the facades in `plugin-utils.ts` as thin closures over the live managers:
  ```ts
  checkpoints: { create: (p, t, m) => plugin.getSharedCheckpointManager().createCheckpoint(p, t, m) },
  notes: { open: (p) => plugin.getNoteOpener().openNote(p) },
  staleContent: { recordRead: (p, c) => plugin.getStaleTracker().recordRead(p, c), /* …4 more… */ },
  ```
  Resolve through the **lazy getters** (not captured field reads) for the same reason as Stage-0 item 4.
4. **Migrate the seven built-in tool scaffolds** that use the old members
   (`read-note`, `write-note`, `import-docx`, `move-note`, `replace-in-note`, `manage-tags`,
   `update-frontmatter`) to the facade names. These are TS string-fence scaffolds — update the embedded code
   and re-verify they compile via the extension compiler test path. **This is the bulk of the risk:** the
   scaffolds are real, executed code, not docs.
5. **`docs/extensions.md`** (~398–400 + the runtime-context table): replace the three rows with the facade
   surface, add a "Runtime API version" subsection documenting `utils.api.version` and `notor-min-api`, and
   add a short "Frozen surface" note. Update the `tool-creator` persona similarly. Then **run the
   `audit-personas-docs` skill** to confirm no drift remains (the parent spec calls this out as the
   honesty-keeper).

### Migration note (ships with the release)

Per D-compat, this is a **breaking change** to the runtime API and requires a migration note for users with
vault extensions that reference `utils.checkpointManager` / `utils.staleTracker` / `utils.noteOpener`:
> "v1 replaces the live `utils.checkpointManager` / `staleTracker` / `noteOpener` objects with the narrow
> facades `utils.checkpoints` / `utils.staleContent` / `utils.notes`. Update `checkpointManager.createCheckpoint(...)`
> → `checkpoints.create(...)`, `noteOpener.openNote(...)` → `notes.open(...)`, and the staleTracker methods
> to `staleContent.*`. Declare `notor-min-api: 1` in frontmatter to require this API."

### Verification
- `tsc` clean across `extensions/`, scaffolds, `docs` consumers.
- Extension compiler/manager tests (`src/extensions/__tests__/`, incl. the 1,106-line `manager.test.ts`)
  green — these exercise scaffold compilation, so they catch a broken facade reference.
- New parser tests: (a) `notor-min-api: 2` on a v1 build produces a collected `ExtensionError` naming the
  file; (b) `notor-min-api: 1` loads cleanly; (c) malformed `notor-min-api: "abc"` errors; (d) absent key
  loads cleanly.
- New facade test: a tool scaffold calling `utils.checkpoints.create(...)` actually creates a checkpoint
  (round-trip), proving the closure wiring.
- `audit-personas-docs` skill reports no drift after the doc/persona edits.

### Risk
**Medium.** Two real hazards:
1. **Scaffold migration (step 4)** — the seven scaffolds are executed code; a missed call site is a runtime
   break, not a type error if the old member is fully removed (it will be a type error *because* we remove
   the member from `ExtensionUtils` — so `tsc` is the safety net; verify the scaffolds are type-checked, not
   just string-embedded). **Confirm the scaffold `.ts` files are part of the `tsc` graph** before relying on
   this; if they are raw template strings not type-checked, add a compile-test that runs each through the
   extension compiler.
2. **Transitive-surface audit (parent spec risk #4)** — before finalizing the facade method sets, re-grep
   the scaffolds *and* any built-in automation/block scaffolds (not just tools) for these three identifiers,
   in case a non-tool scaffold uses a method the table above missed. The grep was tools-only; widen it.

---

## 2. Unified `discoverVaultContent` engine (Issue 2.4) — L, medium risk

Five pipelines each reimplement: directory scan → metadata-cache-first frontmatter read with manual-YAML
fallback → `notor-*` validation → error collection → (sometimes) scaffold injection. A frontmatter edge case
must be fixed in up to five places, and **two pipelines silently swallow failures**.

### Current state (verified)

| Pipeline | File | LOC | Layout | Scan | Error handling | Scaffolds | Tests |
|----------|------|-----|--------|------|----------------|-----------|-------|
| extensions (tools/automations/blocks) | `src/extensions/discovery.ts` | 258 | file, flat | `collectMarkdownFiles()` ~178–193 | **`errors[]` array** (good) ~75 | manager-level | integration via `manager.test.ts` |
| personas | `src/personas/persona-discovery.ts` | 370 | **directory** | `personasRoot.children` ~59–68 | optional `errors?` param ~47/65 | built-ins ~72–78 | **none** |
| sub-agents | `src/sub-agents/discovery.ts` | 401 | **directory** | `root.children` ~62–72 | **LOG-ONLY ~124** (silent) | built-ins ~79–84 | **`discovery.test.ts` (723 lines)** |
| workflows | `src/workflows/workflow-discovery.ts` | 487 | file, **recursive** | own `collectMarkdownFiles()` ~290–302 | logged per-validation ~349 | none | **none** |
| rules | `src/rules/vault-rules.ts` | 498 | file, flat, lazy/event | `vault.adapter.list()` ~276 | **LOG-ONLY ~335** (silent) | none | **none** |

**Signatures (verified):**
- `discoverExtensions(vault, metadataCache, notorDir, parseYAML, templateRegistry?): Promise<DiscoveryResult>`
  where `DiscoveryResult = { tools, automations, blocks, sharedSettings, errors }` (~43–49).
- `discoverPersonas(vault, metadataCache, notorDir, templateRegistry?, errors?): Promise<Persona[]>` (~42–48).
- `discoverSubAgentProfiles(vault, metadataCache, notorDir, knownToolNames?, parseYAML?, templateRegistry?): Promise<SubAgentProfile[]>` (~47–54).
- `discoverWorkflows(vault, metadataCache, notorDir): Workflow[]` (**synchronous**, ~73–77).
- rules: `loadRules()` (~264–295), lazy/event-driven, uses its own `parseSimpleYaml` (~471–498) — **does not
  use the metadata cache at all**.

**The silent-failure sites the engine fixes for free:**
- sub-agents `discovery.ts:124`: `log.warn("Failed to parse sub-agent profile, skipping", …)` — not collected.
- rules `vault-rules.ts:335`: `log.warn("Failed to load rule file", …)` — not collected.

**Shared sub-patterns the engine consolidates** (the metadata-cache-first read is near-identical across
extensions ~240–251, personas ~147–169, sub-agents ~149–177; workflows ~319–321 uses cache-only with no
fallback; rules uses a bespoke parser). Already-extracted good counter-examples to reuse/extend:
`extractToolConfigs()` (`src/tool-config/parser.ts` ~75–253, used by sub-agents + workflows) and the
frontmatter helpers.

### Change

1. Build `src/extensions/discover-vault-content.ts` (or `src/discovery/` — pick one home):
   ```ts
   export interface DiscoverOptions<T> {
     root: string;                          // notorDir-relative subdir
     layout: "file" | "directory";          // file-per-item vs directory-per-item
     recursive?: boolean;                   // file layout only (workflows)
     promptFileName?: string;               // directory layout: e.g. "system-prompt.md"
     parse: (ctx: ParseContext) => T | null | { error: DiscoveryError };
     validate?: (frontmatter: Record<string, unknown>, path: string) => DiscoveryError[];
     scaffolds?: () => T[];                 // built-ins to merge (personas/sub-agents)
   }
   export interface DiscoverResult<T> { items: T[]; errors: DiscoveryError[]; }
   export async function discoverVaultContent<T>(deps, opts: DiscoverOptions<T>): Promise<DiscoverResult<T>>;
   ```
   - Centralize the **metadata-cache-first + manual-YAML fallback** read (the one currently triplicated) as
     the engine's single frontmatter step.
   - Centralize **error aggregation** — every pipeline returns `{ items, errors }`; the engine never
     log-and-drops. This is what fixes sub-agents (~124) and rules (~335) silent failures.
   - Parameterize `layout` (parent spec risk #3 — **do not force one layout**; personas/sub-agents are
     directory-per-item, the rest file-per-item).
2. **Migrate in risk order = best-tested first** (so a regression is caught by an existing suite):
   1. **sub-agents** — it has the 723-line `discovery.test.ts`. Migrating it first means the engine is
      validated against the strongest suite before riskier migrations. *(Note: this reorders the parent
      spec's "extensions first" suggestion — extensions has only integration coverage via `manager.test.ts`,
      whereas sub-agents has a dedicated 723-line discovery suite. Best-tested-first favors sub-agents.
      Flag this reorder in the PR.)*
   2. **extensions** — integration-tested via `manager.test.ts`; the most consequential pipeline.
   3. **personas** — no tests; add them as part of migration.
   4. **workflows** — no tests; **carries the `recursive` flag** (the only recursive pipeline) — exercise it.
   5. **rules** — no tests, lazy/event-driven, uses a bespoke parser and the vault adapter (not the metadata
      cache). **Riskiest and most divergent** — migrate last, and consider whether its event-driven lazy
      model even fits the one-shot engine (it may keep its event loop but call the engine for the actual
      scan; do not force the engine's shape onto its laziness).
3. **Add tests per migration** (this is how Stage 1 also dents Issue 6.4's zero-test zones — workflows,
   personas, rules each gain their first discovery tests).

### Verification
- Each migration keeps its pipeline's existing behavior: same items discovered, same scaffolds injected,
  same `notor-*` validation. The sub-agent suite (723 lines) is the anchor for migration #1.
- New tests assert **errors are now collected, not swallowed**: a malformed sub-agent profile and a malformed
  rule file each produce a `DiscoveryError` in the result (the regression that proves the silent-failure fix).
- `tsc` + full suite green after each migration (land them as separate commits, one per pipeline).

### Risk
**Medium**, concentrated in the **rules** pipeline (bespoke parser, event-driven, adapter-based — least like
the others) and in **not over-abstracting**: keep `layout`/`recursive` as explicit knobs. Migrate one
pipeline per commit so a regression is bisectable to a single pipeline.

---

## 3. Renderer registry for built-in block kinds (Issue 5.2) — L, medium-high risk

Extension blocks go through `ChatBlockRegistry`; the six built-in kinds (user/assistant-text/thinking/
tool-call/tool-result/diff-approval) are hard-coded branches in `message-renderer.ts`. Users can add new
block kinds but cannot touch the ones that matter, and the renderer grows a branch per built-in concept.

### Current state (verified)

**`src/ui/message-renderer.ts`** (877 lines), hard-coded branches:
- `renderUserMessage` ~77–103 (hook-injection special case ~78–80 → `renderHookInjection`).
- `finalizeAssistantMessage` ~227–304 (thinking block ~246–260, markdown render ~276–282, link activation
  ~291–293, token display ~295–301).
- `renderToolCall` ~325–352.
- `renderToolResult` ~354–389.
- `renderDiffApprovalPrompt` ~506–588 with **per-tool-name diff rendering**: `write_note` ~518–545,
  `replace_in_note` ~547–585 (extracts `changes[]`, supports selected-block filtering), generic fallback
  ~587. (Same special-casing shape as policy Issue 3.3, in UI form.)
- Extension-block registry path `populateExtensionBlockEl` ~810–869: `registry.get(b.kind)` ~831,
  `renderLoading` ~835–842, `render` ~846–852, unregistered fallback ~854–866.

**Dispatch point** (`src/chat/view-router.ts` ~54–81): `switch (message.role)` routes built-in roles to the
hard-coded methods and **only** `extension_block` to the registry path. This switch is the
built-in-vs-registry fork.

**`src/ui/chat-blocks/registry.ts`** (60 lines):
- `ChatBlockDefinition` (~24–32): `kind`, `displayName`, `icon?`, `render(container, data, ctx)`,
  `toLLMText?`, `excludeFromCompaction?`, `renderLoading?(container, ctx)`. **No `onStreamChunk` / `dispose`
  lifecycle.**
- `register()` (~37–43): **keeps-first, silently rejects duplicates** (`log.error` + return). **No
  `priority`/override flag.**
- `ChatBlockRenderContext` (~15–22): `message`, `app`, `openInternalLink`, `collapsibleCard`,
  `pendingMemoryManager`.

**Streaming machinery (migration risk — goes LAST):**
- `appendStreamChunk` ~113–129: `data-raw` attribute (~114/116) + **100ms** debounce timer (~121).
- thinking indicator: `startThinkingIndicator` ~162–173 (`setInterval` @ 1000ms ~168), `stopThinkingIndicator`
  ~198–214, cleared in `destroy()` ~640.
- `appendThinkingChunk` ~216–225 (`data-raw` ~220/222).

**Renderer deps** (`MessageRendererDeps` ~50–62): `getMessageListEl`, `getTokenFooterEl`, `app`, `component`,
`getSettings`, `getChatBlockRegistry`, `getPendingMemoryManager`, `scrollToBottom`, `openInternalLink`,
`openChatInNewTab`, `onOpenSettingsGroup?`. Diff rendering (`renderWriteNoteDiffPreview`,
`renderReplaceInNoteDiffPreview` from `diff-view.ts`) needs `app` + `component` to read vault content — a
per-tool block def will need equivalent access.

### Change — migrate built-ins onto the registry, static → streaming (the order is the risk gradient)

1. **diff/approval first** (most self-contained, highest payoff — kills the per-tool-name branching). Move
   `write_note` and `replace_in_note` diff rendering into **per-tool block definitions** registered as
   built-ins. The registry contract already carries `render(container, data, ctx)`; the per-tool diff defs
   need vault read access — **extend `ChatBlockRenderContext`** with what `diff-view.ts` needs (`component`,
   and a note-read accessor) rather than reaching around the context. The generic approval fallback becomes
   the default block def.
2. **tool-call / tool-result** next (static, no timers).
3. **thinking** — carries the 1000ms `setInterval`. **First add an optional `onStreamChunk?`/`dispose?`
   lifecycle to `ChatBlockDefinition`** (the contract has none today), then migrate thinking so its timer
   lives in the block's lifecycle, not the renderer.
4. **streamed assistant text LAST** — the `data-raw` + 100ms debounce machinery (~113–129) is the highest-risk
   path; migrate only after 1–3 are proven. (Parent spec risk #1 + §6.)
5. **Built-in registration vs duplicate-rejection:** built-ins must register *before* user blocks (they do
   today). Add a `priority`/override flag to `register()` **only when** deliberately opening built-in
   replacement to users — **not in this stage**. For now built-ins register first and win, preserving current
   semantics.
6. As each kind migrates, the corresponding `switch` arm in `view-router.ts` (~54–81) collapses to the
   registry path; `message-renderer.ts` shrinks toward a thin dispatcher.

### Verification
- Visual/behavioral parity per kind: the existing UI for each migrated kind renders identically (diff preview
  with selected-block filtering for `replace_in_note` is the fiddliest — verify block selection still
  filters the `changes[]` array on approve).
- Streaming parity (the LAST step): assistant-text debounce + thinking timer behave identically; no double
  renders, no orphaned `setInterval` (check `destroy()` still clears it).
- `tsc` + UI smoke test in Obsidian (the `debug-in-obsidian` / `run` skills) after the streaming migration —
  this is the one area where unit tests under-cover and manual verification matters.

### Risk
**Medium-high** — the only Stage-1 item touching live streaming paths. Mitigate strictly by the
static-first / streaming-last order, one kind per commit, and a manual Obsidian smoke test before merging the
streamed-text migration. Keep the hard-coded branches in git history as the behavioral reference.

---

## 4. Provider capability interface (Issues 4.2 Stage-1 half + 4.3) — M, medium risk

Capability data lives in a free-function module (`model-metadata.ts`) and provider-specific knobs
(`use_extended_context`, `thinking_level` semantics, the Bedrock connection-test branch) leak through the
common interface. Re-seal behind two provider methods.

> **Depends on Stage-0 item 5.** That item already added geo-prefix normalization + warn-on-fallback *inside*
> `model-metadata.ts`. This item moves the **data behind the interface**. Start only after Stage-0 item 5 has
> merged, to avoid same-file conflicts.

### Current state (verified)

**`LLMProvider`** (`src/providers/provider.ts` ~151–204): `sendMessage`, `listModels`, `getTokenCount`,
`supportsStreaming`, `validateConnection(): Promise<boolean>`, `resetCredentials?`. **No capability method.**
- `SendMessageOptions` (~74–90): `use_extended_context?: boolean` (~87), `thinking_level?: string | null` (~89).
- `StreamChunk` union ~97–105 (8 variants).

**`model-metadata.ts`** free functions (the data to relocate behind `getCapabilities`):
- `getModelMetadata(modelId): ModelInfo | null` ~605–617.
- `getContextWindow(modelId, useExtendedContext?): number` ~630–636 (`DEFAULT_CONTEXT_WINDOW = 128_000` ~24).
- `getThinkingMode(modelId): ThinkingMode` ~744–748.
- `supportsThinking(modelId): boolean` ~727–729.
- `enrichModelInfo`, `getModelExtendedContext`, `getKnownModelIds`.
- `ModelMetadataEntry` (~41–47): `context_window`, prices, `display_name?`, `extended_context?`.

**Free-function call sites to migrate** (exhaustive grep):
- `getContextWindow`: `src/chat/context.ts` (×3 — ~110/235/248), `src/chat/sub-agent-runner.ts` (×2 —
  ~193/206, **and these omit the `useExtendedContext` arg — a latent gap to fix during migration**),
  `src/context/compaction.ts` (~260, plus indirect via `getContextWindowForModel` ~192).
- `getModelMetadata`: `src/chat/message-pipeline.ts` ~573.
- `supportsThinking`: `orchestrator.ts` ~1172, the 3 providers (`anthropic` ~216, `bedrock` ~423, `openai`
  ~213), `settings/sections/model-presets.ts` ~208, `ui/settings-popover.ts` ~365.
- `getThinkingMode`: internal to `thinking-config.ts` ~46.

**`thinking-config.ts`**: `resolveAnthropicThinking(level, modelId)` ~37–65 (called anthropic ~217, bedrock
~424), `resolveOpenAIReasoning(level)` ~67–84 (called openai ~214). Test: `thinking-config.test.ts` (6.4 KB,
comprehensive — the refactor anchor).

**`use_extended_context` plumbing** (the cross-cutting move): declared on `SendMessageOptions`
(provider.ts ~87), `LLMProviderConfig` (types.ts ~322), `ModelPreset` (types.ts ~366, **required**),
message (types.ts ~81, for fork preservation). **Read only by Bedrock** (bedrock-provider.ts ~411 injects
`anthropic_beta`; also referenced ~507). Many write sites (model-presets, provider-add, wire-view,
orchestrator ~223/~1651, conversation-lifecycle ~341, persona-manager). **Also feeds context-window math**
(`context.ts`, `compaction.ts`, `sub-agent-runner.ts`) — so it is **not purely a Bedrock send-time concern**;
moving it requires care (see risk).

**Connection-test branch** (`src/settings/sections/connection-test.ts` ~35–37): `if (type === "bedrock")`
diverts to `renderBedrockConnectionTestButton` with a bespoke STS `GetCallerIdentity` flow (~122–162). The
generic branch (~42–86) already calls `provider.validateConnection()`. **`validateConnection(): Promise<boolean>`
already exists on all four providers** (anthropic ~565, openai ~430, bedrock ~883, local ~426).

### Change

1. **Add `getCapabilities(modelId)` to `LLMProvider`:**
   ```ts
   getCapabilities(modelId: string): {
     contextWindow: number;
     supportsThinking: boolean;
     thinkingMode: ThinkingMode;
     supportsExtendedContext: boolean;
     supportsImageToolResults: boolean;   // captures the OpenAI/local-drop vs Anthropic/Bedrock-preserve divergence
   };
   ```
   Implement on each provider. The shared data (`MODEL_METADATA` table + patterns) **stays in
   `model-metadata.ts`** as the data layer; providers call into it. So the free functions don't vanish —
   they become the providers' private data source, and **external callers move to `provider.getCapabilities()`**.
   Migrate the call sites enumerated above (context.ts, compaction.ts, sub-agent-runner.ts, message-pipeline.ts,
   orchestrator.ts) to go through the active provider's `getCapabilities()` instead of importing the free
   functions directly. (Settings UI call sites — model-presets, settings-popover — may legitimately keep
   using the data module since they operate on not-yet-instantiated providers; decide per-site. Document
   which stay.)
2. **Add `resolveThinkingConfig(level, modelId)` to `LLMProvider`:** the two `thinking-config.ts` functions
   become provider methods (Anthropic/Bedrock wrap `resolveAnthropicThinking`, OpenAI wraps
   `resolveOpenAIReasoning`, local returns undefined). The provider `sendMessage` bodies call `this.resolveThinkingConfig(...)`
   instead of the free function. Keep `thinking-config.ts`'s pure functions as the implementation the methods
   delegate to (so `thinking-config.test.ts` still anchors them).
3. **Move `use_extended_context` out of `SendMessageOptions` into Bedrock provider config.** Bedrock reads
   its own config at send time instead of receiving it per-message. **But** the context-window math
   (`context.ts`/`compaction.ts`/`sub-agent-runner.ts`) currently derives the window from this flag — route
   that through `getCapabilities(modelId).contextWindow` + a provider-level "extended context active" query
   instead, so removing it from `SendMessageOptions` doesn't silently break window sizing. **Fix the
   sub-agent-runner omission** (~193/206) as part of this — it currently ignores extended context entirely.
4. **Replace the connection-test branch** with `provider.validateConnection(): Promise<{ ok: boolean; detail?: string }>`.
   Widen the existing `Promise<boolean>` return to the richer shape; Bedrock's implementation does the STS
   `GetCallerIdentity` check and returns account/ARN as `detail`; the others return `{ ok }`. Delete the
   `if (type === "bedrock")` fork in `connection-test.ts`.

### Scope guard
This item **does not** build the `ProviderDescriptor` single-registration module (Issue 4.5) — that is
Stage-4 work. It only adds the two capability methods + the connection-test unification, which is the
*prep* the parent spec calls "Stage 1 prep" for 4.5.

### Verification
- `thinking-config.test.ts` stays green (methods delegate to the same pure functions).
- `model-metadata.test.ts` stays green (data layer unchanged).
- New: a `getCapabilities()` test per provider asserting context window / thinking mode / extended-context /
  image-tool-result support for representative models.
- Context-window regression test: extended-context-on Bedrock model still computes the larger window after
  `use_extended_context` leaves `SendMessageOptions` (the load-bearing test for step 3).
- Connection-test: Bedrock STS path still works via `validateConnection()`; generic providers unaffected.

### Risk
**Medium.** The sharp edge is step 3: `use_extended_context` is **not** purely a send-time Bedrock knob —
it feeds context-window sizing in three modules. Removing it from `SendMessageOptions` without rerouting the
window math would silently mis-size context. Do step 3 last, with the regression test above as the gate.

---

## 5. (Stage 1b) Execution timeout + full-privilege acknowledgment + capability doc (Issue 2.2 Phase 1) — S, low risk

Promoted from Stage 4 by **D-share** (community sharing on the roadmap → untrusted full-privilege code is a
vault-destroyer). This is the **cheap half** of sandboxing — no isolation, just a timeout + an explicit
acknowledgment + an honest capability list.

### Current state (verified)

**The two `compiledFn` call sites** (`src/extensions/manager.ts`):
- Tool: `UserToolAdapter.execute()` ~108–118 — `await compiledFn(this.plugin.app, obsidian, utils, libs,
  settings, shared, params)`. **No timeout/AbortSignal wrapping today.**
- Automation: `executeAutomation(automation, context)` ~823–831 — same shape with `context`. **No timeout,
  and no abortSignal at all** (automations don't get one — review confirmed).

**AbortSignal availability:**
- Tools: `abortSignal` is merged into `utils` per-invocation if present (~88–103:
  `if (options?.abortSignal) utils.abortSignal = options.abortSignal`). Declared `abortSignal?: AbortSignal`
  on `ExtensionUtils` (~287–288).
- Automations: none.
- **Timeout precedent exists**: `src/shell/shell-executor.ts` ~104–206 (setTimeout + SIGTERM/SIGKILL). No
  reusable `withTimeout` helper in `src/utils/` — **add one** (`withTimeout(promise, ms, onTimeout?)` that
  races a timer and aborts a controller).

**The escalation surface to document** (the capability list):
- `libs.fs` / `libs.crypto` / `libs.path` (`runtime-context/types.ts` ~350–352; imported from `node:*` in
  `runtime-context/index.ts` ~39–41, bundled in `buildLibs()` ~110–112).
- `utils.executeShellCommand` (declared ~59; wired in `runtime-context/file-utils.ts` ~26–27 →
  `src/shell/shell-executor.ts` ~79–206).
- The real `app` passed first to every `compiledFn` (manager.ts ~111/~824) — full Obsidian API.

**Settings/ack patterns:**
- `NotorSettings` (`src/settings/types.ts`) — master-toggle precedent: `memory_enabled` (~435),
  `templates_enabled` (~454). **No existing "acknowledged"/"dismissed"/"onboarded" flag** (grep clean).
- Defaults: `src/settings/defaults.ts` `createDefaultSettings()`.
- Modal precedent: `src/ui/confirm-modal.ts` (extends `Modal`). No existing first-run modal; migrations are
  the one-time-setup precedent.
- Extension load entry: `ExtensionManager.reload(isInitialLoad: boolean)` (~264), called `reload(true)` from
  `main.ts` `onLayoutReady` (~632) and `reload(false)` from the user command (~2277).

### Change

1. **Execution timeout.** Add `src/utils/with-timeout.ts`: `withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T>`
   that creates an `AbortController`, races the work against a timer, aborts on timeout, and throws a typed
   `ExtensionTimeoutError`. Wrap **both** `compiledFn` call sites:
   - Tools: thread the timeout's signal into the existing `utils.abortSignal` merge (so a well-behaved tool
     that honors `abortSignal` stops promptly; the timer is the backstop for one that doesn't).
   - Automations: this is also where automations **gain an `abortSignal`** for the first time (wire the
     timeout controller's signal into their `utils`). That doubles as prep for Issue 2.3 (automation
     invocation context) and 6.2 (automations racing user actions) — but **scope here is only the timeout
     signal**, not the full 2.3 convergence.
   - Default timeout: generous (e.g. 5 min), **configurable** via a new setting `extension_execution_timeout_ms`.
     A timeout produces a structured `ToolResult` error (tools) / logged+noticed error (automations), not a
     hung turn.
2. **Full-privilege acknowledgment.** Add `extensions_full_privilege_acknowledged: boolean` to `NotorSettings`
   (default `false` in `defaults.ts`). On the **first** extension load that would execute user code
   (natural gate: top of `ExtensionManager.reload()` when discovery finds ≥1 *user-authored* extension and
   the flag is false), show a one-time modal (reuse the `ConfirmModal` pattern) stating "Extensions run with
   full privileges — full vault access, filesystem, and shell. Only enable extensions you trust." On accept,
   set the flag and persist; built-in scaffolds are exempt (they're first-party). Decline → skip compiling
   user extensions this session (built-ins still load).
   - **Decide the gate granularity at implementation time** (open question §8): block *all* user-extension
     execution until acknowledged, vs. acknowledge-once-then-run. Recommended: acknowledge-once (the flag),
     so it's not nagware.
3. **Documented capability list.** Add a "Security & capabilities" subsection to `docs/extensions.md`
   (it has a thin §"Security" at ~517 today) enumerating exactly what extension code can reach: full `app`,
   `libs.fs`/`crypto`/`path`, `utils.executeShellCommand`, and the new timeout behavior. This is the honest
   "here's the blast radius" list D-share requires. Update the `tool-creator` persona to mention it; re-run
   `audit-personas-docs`.

### Verification
- Timeout test: a tool whose `compiledFn` never resolves is aborted after the configured ms and yields a
  structured error (not a hung promise). Same for an automation.
- A well-behaved tool that finishes well under the timeout is unaffected (no behavior change).
- Acknowledgment: fresh vault (flag false) + a user extension → modal appears; accept → flag persists, never
  re-prompts; built-ins load regardless.
- Docs: `audit-personas-docs` clean.

### Risk
**Low.** Additive. The one subtlety: wiring the timeout signal into the **existing** `utils.abortSignal`
merge for tools (don't clobber a caller-supplied abort signal — compose them, e.g. abort on *either*). For
automations there's no prior signal, so it's a clean addition.

---

## 6. (Stage 1b) Worker-isolation design note — DOCUMENT ONLY, do not build (Issue 2.2 Phase 2)

This item produces **a design document, not code.** It is the real-isolation half of sandboxing, and per the
parent spec (§6 risk #6) it is **unbuildable until item 1's facades exist** — you cannot proxy live manager
objects across a worker boundary. Writing the note now (after item 1 lands) captures the design while the
facade work is fresh.

### What the note must cover (verified constraints)
- **Current reality:** all extension code runs on the main thread with full `app` + `libs.fs`/`crypto`/`path`
  + `utils.executeShellCommand`. No worker infra exists.
- **Why facades are the prerequisite:** the worker boundary requires everything in `utils` to be
  *serializable or proxiable*. Item 1's facades (`checkpoints`/`staleContent`/`notes` as thin method
  closures) are proxiable across `postMessage`/Comlink-style RPC; the old live `CheckpointManager` instance
  was not. The note enumerates each `utils` member and classifies it: pure-data (copy), method-facade (RPC
  proxy), or main-thread-only (must stay un-isolated or be redesigned — e.g. anything handing out live
  Obsidian objects like `TFile`).
- **The hard cases to call out:** the first-arg `app` (the whole point of isolation is to *not* hand this
  across), `libs.fs`/`crypto`/`path` (Node built-ins — a worker would need a brokered, policy-checked FS),
  `utils.executeShellCommand` (must be brokered + policy-gated), and anything returning Obsidian DOM/TFile
  objects.
- **Trust tiers:** first-party scaffolds + author-written extensions run in-thread (today's model, gated by
  item 5's acknowledgment); *untrusted/shared* extensions run isolated. The note proposes the boundary
  between tiers and how an extension is classified.
- **Sequencing dependency:** explicitly state this builds on Runtime API v1 (item 1) and the capability doc
  (item 5), and is itself Stage-2+/Stage-4 *build* work — the note does not schedule the build.

### Deliverable
A markdown design note (suggest `specs/ZZ-misc/arch-review-june-2026/worker-isolation-design-note.md`)
covering the above. **No `src/` changes.**

---

## 7. Cross-cutting: build / test / commit hygiene

- **Build gate:** every item ends with `npm run build` / `tsc --noEmit` clean. Items 1 and 4 are type-driven;
  `tsc` is the primary safety net (especially item 1's facade removal — removing the old `utils` members
  turns every stale reference into a compile error).
- **Test zones touched:** items 1, 2, 3, 4 add tests to currently thin/zero-test areas — item 2 in
  particular gives `workflows/`, `personas/`, `rules/` their **first discovery tests** (denting Issue 6.4 as
  the parent spec intends: weave tests into the migrations, not as a separate campaign).
- **Skills to run:** `audit-personas-docs` after items 1 and 5 (doc/persona edits); `audit-bedrock-thinking`
  after item 4 if the thinking-mode resolution moves (it shouldn't change classification, but confirm).
  Manual Obsidian smoke test (`debug-in-obsidian` / `run`) after item 3's streamed-text migration.
- **Commit granularity** (per repo git rules — use `mcp__git` tools, not raw CLI; one logical unit per
  commit). Suggested commits:
  1. `Add Runtime API v1 version handshake (utils.api + notor-min-api)` (item 1a)
  2. `Replace live-manager utils members with narrow facades` (item 1b — incl. scaffold + doc migration)
  3. `Add discoverVaultContent engine + migrate sub-agents pipeline` (item 2, migration #1)
  4. `Migrate extensions discovery onto discoverVaultContent` (item 2, #2)
  5. `Migrate personas discovery + add tests` (item 2, #3)
  6. `Migrate workflows discovery (recursive) + add tests` (item 2, #4)
  7. `Migrate rules discovery + add tests` (item 2, #5)
  8. `Migrate diff/approval rendering onto ChatBlockRegistry` (item 3, step 1)
  9. `Migrate tool-call/tool-result rendering onto registry` (item 3, step 2)
  10. `Add block lifecycle hooks + migrate thinking renderer` (item 3, step 3)
  11. `Migrate streamed assistant text onto registry` (item 3, step 4)
  12. `Add provider.getCapabilities() + migrate call sites` (item 4, steps 1–2)
  13. `Move use_extended_context into Bedrock config; unify validateConnection` (item 4, steps 3–4)
  14. `Add extension execution timeout + full-privilege acknowledgment` (item 5)
  15. `Add worker-isolation design note` (item 6 — doc only)

---

## 8. What this plan deliberately does NOT do

- **No `ProviderDescriptor` single-registration module / `registerProvider()` (Issue 4.5)** — Stage 4. Item 4
  only adds capability methods + connection-test unification (the Stage-1 *prep*).
- **No loop middleware / `pre_send_transform` (Issue 2.5)** — Stage 4; depends on this stage's stable
  contracts.
- **No `Tool.policyCheck?()` refactor (Issue 3.3)** — belongs with the Stage-0.5 policy work.
- **No message-pipeline serializer-map split (Issue 3.1)** — Stage 2; item 3 stops at migrating *existing*
  built-in kinds onto the registry, not making the role serialization registrable.
- **No `priority`/override flag on `ChatBlockRegistry.register()`** — added only when built-in *replacement*
  is deliberately opened to users (a Stage-4-adjacent decision).
- **No worker isolation BUILD (Issue 2.2 Phase 2)** — item 6 is a design note only.
- **No `ErrorReporter` (Issue 6.3)** — item 2 unifies discovery error *aggregation* into `{ items, errors }`;
  the shared cross-subsystem reporter is Stage 4.

---

## 9. Open questions to resolve at implementation time

1. **Are the built-in scaffold `.ts` files in the `tsc` graph?** (item 1) If yes, removing the old `utils`
   members makes a missed facade migration a compile error (safe). If they're raw template strings not
   type-checked, add a per-scaffold compile-test through the extension compiler before removing the old
   members. **Resolve before deleting any `utils` member.**
2. **Widen the transitive-surface grep beyond tool scaffolds** (item 1): re-grep automation + block scaffolds
   for `checkpointManager`/`staleTracker`/`noteOpener` in case a non-tool scaffold uses a method the facade
   table omits.
3. **Does the rules pipeline fit the `discoverVaultContent` shape?** (item 2) It is event-driven/lazy and
   uses the vault adapter + a bespoke YAML parser, not the metadata cache. Decide whether it calls the engine
   for the scan while keeping its own event loop, vs. a partial migration. Do not force the engine's one-shot
   shape onto its laziness.
4. **`getCapabilities` call-site policy for settings UI** (item 4): some callers (`model-presets`,
   `settings-popover`) operate on not-yet-instantiated providers. Decide per-site whether they keep using the
   `model-metadata` data module directly or get a static capability lookup. Document the split.
5. **`use_extended_context` window-math rerouting** (item 4, step 3): confirm every context-window
   computation that reads the flag (`context.ts`, `compaction.ts`, `sub-agent-runner.ts`) is rerouted before
   the flag leaves `SendMessageOptions`. The sub-agent-runner already *omits* it (~193/206) — decide whether
   that's a bug to fix or intended, and document.
6. **Acknowledgment gate granularity** (item 5): block-until-acknowledged vs acknowledge-once. Recommended:
   acknowledge-once (a one-time modal that sets the flag), to avoid nagware.
