# Stage 4 — Implementation Plan ("Ecosystem hardening")

**Status:** Ready to implement **when community sharing is live** (P1) — gated on Stage 1's contracts (Runtime API v1, provider capabilities, renderer registry) and benefiting from Stage 3's `PluginServices` home; see §0
**Parent spec:** [`../fable-architecture-review-2606.md`](../fable-architecture-review-2606.md) §4 (Stage 4), §5 matrix, §6 risk notes, §8 decision log (D-share / D-compat)
**Sibling plans:** [`stage-0-implementation-plan.md`](./stage-0-implementation-plan.md) (item 7 widened `ApprovalDecision`; item 6 routed hooks through `TaskLaneQueue` — both are the substrate item 3 below builds on) · [`stage-1-implementation-plan.md`](./stage-1-implementation-plan.md) (**the load-bearing prerequisite** — item 1 Runtime API v1 gates the middleware contract (2.5), item 4 capabilities/`validateConnection` gates `ProviderDescriptor` (4.5), item 3 renderer registry is what 2.6's block-renderer flag opens to users; item 5 already wired a timeout `abortSignal` into automations, which item 2 below extends) · [`stage-2-implementation-plan.md`](./stage-2-implementation-plan.md) (item 2's tool-execution `emit` channel is **not** hook middleware — item 3 below is the hook-side transform; keep them distinct) · [`stage-3-implementation-plan.md`](./stage-3-implementation-plan.md) (`PluginServices` + the settings bus give the new registration seams a clean owner)
**Source review:** `private/architecture-review-2026-06-11.md` + `private/architecture-review-2026-06-11-code-map.md` (git-ignored)
**Code verified against:** working tree at HEAD `deb0856` (which adds *only* the parent spec + Stage-0/1/2/3 plans on top of the reviewed `f7049d0`; all `src/` is byte-identical to the commit the review cites). Re-verified by direct read on 2026-06-14 via three parallel read-only agents (provider registration; hooks/automation dispatch; registration seams / settings / styles / error channel).

> **Line-number caveat.** Every `file:line` below was confirmed by direct read at `deb0856`. Line numbers
> drift. **Re-locate by symbol name at implementation time, not by line.** Where a range is given it is to
> scope the work, not to be applied as a patch coordinate.

---

## 0. Scope & sequencing

Stage 4 is **the P1 stage** — the work that pays off *once third-party / community extension sharing is on*
(decision **D-share**, parent spec §8). It does three things: (1) opens the **closed registration seams**
(providers, settings sections, context sources, and — by exposing Stage 1's renderer registry — built-in
block replacement) so users can extend what is today hard-coded; (2) gives the agent loop the one extension
point power users most want by generalizing the lone **acting hook** (approval) into **transform middleware**;
and (3) hardens the surrounding ecosystem (converged automation invocation context, a standardized error
channel, opportunistic settings namespacing, a styles split). None of it is a rewrite — every item turns an
existing hard-coded fork into a small registration interface, following **the exact recipe the codebase
already uses for chat blocks** (`ChatBlockRegistry`).

**Why it comes last.** Each Stage-4 item rests on a contract an earlier stage produced. Opening a registration
seam through the runtime API is only safe once that API is **versioned and narrow** (Stage 1 item 1) and the
extension execution surface is **sandbox-acknowledged** (Stage 1b item 5) — both are D-share safety
preconditions. The provider seam (4.5) consumes Stage 1 item 4's `getCapabilities()`/`validateConnection()`.
The block-renderer seam reuses Stage 1 item 3's registry. The middleware (2.5) needs Stage 1's stable
transform context *and* automation cancellation (2.3, item 2 here). And the `PluginServices` container
(Stage 3 item 6) is the natural owner for the new registries. **Do not start Stage 4 until Stage 1 has
landed; prefer to have Stage 3 in too.**

### The seven Stage-4 items

| # | Item | Issue | Effort | Risk | Depends on |
|---|------|-------|--------|------|------------|
| 1 | **`ErrorReporter` + adoption sweep** at silent-failure sites | 6.3 | S | Low | — (warm-up; foundational utility) |
| 2 | **Converge automation invocation context** — `abortSignal` + `ask`/`onProgress`, unified error model | 2.3 | M | Med | Stage 1 item 5 (automations gained a timeout `abortSignal`) |
| 3 | **Agent-loop middleware** — `pre_send_transform` / `on_tool_result_transform` generalizing the approval acting-hook | 2.5 | M | Med | **Stage 1 item 1** (Runtime API v1); item 2 (2.3); Stage 0 items 6/7 |
| 4 | **`ProviderDescriptor` single-registration module → `registerProvider()`** | 4.5 | M | Med | **Stage 1 item 4** (`getCapabilities` + unified `validateConnection`) |
| 5 | **Open settings-section + context-source registration** (+ block-renderer override flag) | 2.6 | M-L | Med | Stage 1 item 3 (block registry); item 4 (providers seam); Stage 3 (home) |
| 6 | **Settings namespacing** — group flat keys into sub-objects | 5.4 | M | Low | — (opportunistic; pairs with item 5's settings-section seam) |
| 7 | **Styles split** — `styles/*.css` + concat step | 5.5 | S | Low | — (lowest payoff; fully independent) |

> Renumbering note: this plan numbers items 1–7 for sequencing; the parent-spec issue ids (6.3, 2.3, 2.5,
> 4.5, 2.6, 5.4, 5.5) are kept in every heading so the mapping is unambiguous.

### Critical ordering — what gates what

1. **Item 3 (middleware) is doubly gated.** Per parent spec §2.5 it must come **after Runtime API v1**
   (Stage 1 item 1) so the transform context is a *stable contract* — otherwise every middleware author binds
   to an unversioned surface that the internal refactors will break. It also depends on **item 2 (2.3)** here:
   the parent spec (§2.3, code-map Issue 2.3) is explicit that *"this is a prerequisite for any agent-loop
   middleware extension point — middleware needs cancellation."* So **2 → 3**.
2. **Item 4 (`ProviderDescriptor`) consumes Stage 1 item 4.** The descriptor's shape is
   `{ type, displayName, factory, renderSettingsSection, validateConnection, getCapabilities }` — two of those
   members (`getCapabilities`, the *unified* `validateConnection(): { ok, detail }`) **only exist after Stage 1
   item 4 lands.** Building the descriptor before then means inventing those methods twice. **Stage 1 item 4 → item 4.**
3. **Item 5 (2.6) is the umbrella seam-opener and depends on items 3 & 4 + Stage 1 item 3.** Parent spec §2.6
   says to open seams *in priority order: providers (→ 4.5) → built-in block renderers (→ 5.2) → loop
   middleware (2.5) → context sources.* In this plan those four are distributed: **providers = item 4**,
   **block renderers = Stage 1 item 3's registry + a new override flag (here in item 5)**, **loop middleware =
   item 3**, and the **genuinely new seams — settings-section + context-source registration — are item 5's own
   deliverable.** Item 5 therefore lands *after* 3 and 4 so all four seams use one consistent recipe and one
   runtime-API registration convention.
4. **Item 1 (`ErrorReporter`) is the recommended warm-up and is foundational.** It is small, low-risk, and the
   other items want it: item 2's automation error model, item 3's per-transform failure surfacing, item 4's
   provider-registration failures, and item 5's discovery/registration failures all *should* route through it.
   Build it first so the later items adopt it as they go rather than re-inventing throttled Notices.
5. **Items 6 & 7 are opportunistic / deferred** (parent spec: 5.4 "opportunistic, not a campaign"; 5.5 "lowest
   payoff"). Item 6 (settings namespacing) **pairs naturally with item 5's settings-section registration** —
   the parent spec notes namespacing *"unlocks extension-contributed settings sections."* Do item 6 alongside
   or just after item 5 if settings sections are being opened anyway; otherwise defer. Item 7 (styles split) is
   pure mechanics and can land any time, by anyone, independent of everything.

### Recommended landing order

`1 (ErrorReporter warm-up) → 2 (automation context) → 3 (middleware, after Stage 1 + item 2) → 4 (ProviderDescriptor, after Stage 1 item 4) → 5 (settings/context seams, after 3 & 4) → 6 (settings namespacing, with/after 5, opportunistic) → 7 (styles split, any time)`.
Hard edges: **2 → 3**, **Stage1-item1 → 3**, **Stage1-item4 → 4**, **{3, 4, Stage1-item3} → 5**.

### One runtime-API convention for every new seam (read once, applies to items 3–5)

Every registration surface this stage adds — `registerProvider`, `registerContextSource`,
`registerSettingsSection`, and the middleware transform hooks — must be exposed **through the versioned
runtime API (Stage 1 item 1's `utils.api.version`)**, not by handing out a live registry. Adding new `utils`
members is **additive and non-breaking**, so `RUNTIME_API_VERSION` stays `1`; but each new member joins the
*frozen surface*, so name it deliberately and document it in `docs/extensions.md` (then run the
`audit-personas-docs` skill — it audits that file and the `tool-creator` persona). Internally, built-ins
register through the **same** interface they expose to extensions (the `ChatBlockRegistry` precedent: built-ins
are just the first registrants). This is the whole architectural point of Stage 4 — *no more two-tier
"built-ins are hard-coded, extensions get a registry."*

### Corrections this plan folds in (verified at `deb0856`)

Direct re-reads turned up several drifted line numbers and counts in the source docs; the plan uses the
verified facts:

- **`dispatchOnApprovalRequired` lives at `hook-events.ts` ~980–1075, not ~769–850.** Both source docs cite
  the old range. The function — the **acting-hook precedent** item 3 generalizes — is materially larger and
  lower in the file than documented. Re-locate by symbol.
- **`pre_send` hook output is injected as a *separate user message* (ACI-002), not inline system-prompt
  injection.** The source review predates this change. It matters for item 3: `pre_send_transform` is a
  *distinct, stronger* contract (rewrite the outgoing message) that must **coexist** with the existing
  observe-only `pre_send` injection — not replace it. (`dispatchPreSend` returns `string[]`; orchestrator
  injects them as a flagged user message ~`orchestrator.ts:823–835`.)
- **Settings groups: 15, not 13** (`settings-tab.ts` `display()` ~162–241). **Section files: 35, not 33**
  (`src/settings/sections/`). Item 5's registry must cover 15 groups / 35 sections.
- **`NotorSettings`: 77 top-level fields**, not 89 (code-map) and not 469 (original review)
  (`settings/types.ts` ~69–468). Item 6 is sized to 77 flat keys.
- **`styles.css`: 583 rule sets**, 93,236 bytes, 4,186 lines (review said ~618). Item 7 splits 583 rules.
- **`new Notice(` count: 203 — exactly as the review claims** (verified `grep -rn "new Notice(" src/ | wc -l`).
  No correction; the figure is accurate.
- **`registry-factory.ts` excludes Bedrock — confirmed and *intentional*** (AWS SDK `@aws-sdk/credential-providers`
  is Node-only and breaks esbuild resolution; module comment ~8–15). Item 4's descriptor must **preserve** this
  lazy/excluded-from-bundle behavior, not "fix" it into eager registration.

### Relationship to other stages (do NOT scope-creep)

- **Stage 1 item 1 (Runtime API v1)** is the contract every new `utils.register*` member joins — item 3/4/5
  consume it; they do **not** re-version the API.
- **Stage 1 item 3 (renderer registry)** built the block registry with "built-ins register first and win."
  Item 5 here adds *only* the `priority`/override flag that deliberately opens built-in *replacement* to users
  — the migration of built-ins onto the registry is Stage 1's, already done.
- **Stage 1 item 4 (capabilities + `validateConnection`)** produced the two methods item 4's descriptor
  composes. Item 4 **consolidates registration**; it does not re-derive capability data.
- **Stage 0 item 6 (hooks via `TaskLaneQueue`)** and **item 7 (`ApprovalDecision` widening)** are the substrate
  item 3 builds on — middleware dispatch reuses the queue's serialization and the widened decision shape. If
  Stage 0 has not landed, item 3 cannot assume either.
- **Stage 2 item 2 (tool-execution `emit` channel)** is tool→dispatcher output streaming — **not** hook
  middleware. Item 3 here is the hook-side `on_tool_result_transform`. They touch different layers; keep them
  separate (the parent spec is explicit).
- **Stage 3 item 6 (`PluginServices`)** is the home for the new registries; if Stage 3 has not landed, the
  registries can live on the plugin temporarily and move into the container later (same pattern Stage 3 used).

---

## 1. `ErrorReporter` + adoption sweep (Issue 6.3) — S, low risk — recommended warm-up

Four error strategies coexist with no policy, so whether a failure is *visible to the user* depends on which
subsystem it happened in. The worst case is the silent-failure sites: a sub-agent profile that fails to parse,
a rule file that fails to load, an unknown model that silently gets the default context window — all log-only,
invisible. A small standardized reporter, **adopted at those sites first**, fixes the visibility gap without a
sweep.

### Current state (verified)

- **Four coexisting strategies:**
  1. **Return-null-by-design** — `src/checkpoints/checkpoint.ts` `createCheckpoint()` (~76–120): **7 distinct
     null-return paths** (~78/86/94/119 in create + ~141/205/209 elsewhere); comment ~117 *"Checkpoint failure
     should not block the write operation."* Deliberate, correct — but the *intent* is implicit.
  2. **Throw** — `src/memory/note-format.ts` `assertPendingMemoryPath` (~212–232) and `assertMemoryPath`
     (~250–275): explicit `throw new Error(...)` on invalid paths.
  3. **Notice** — **203** `new Notice(` calls repo-wide (verified exact), concentrated in `main.ts` (20),
     `commands/index.ts` (19), `hooks/vault-event-dispatcher.ts` (13), `ui/` (~60+), `settings/sections/` (~35+).
  4. **Structured-log-only** — `src/utils/logger.ts` (~71–89): `logger(source)` returns
     `{ debug, info, warn, error }`, each emitting a JSON `LogEntry` (`[NOTOR_LOG]` prefix) via `console.*`.
     User-invisible.
- **The silent-failure sites the reporter should adopt FIRST** (parent spec §6.3):
  - `src/sub-agents/discovery.ts:124` — `log.warn("Failed to parse sub-agent profile, skipping", …)` →
    profile silently omitted, no UI feedback. (Stage 1 item 2's `discoverVaultContent` engine *collects* this
    error into `{ items, errors }`; the reporter is how those collected errors reach the user.)
  - `src/rules/vault-rules.ts:335` — `log.warn("Failed to load rule file", …)` → rule silently ignored.
  - `src/providers/model-metadata.ts:630–636` — `getContextWindow()` silent fallback to
    `DEFAULT_CONTEXT_WINDOW`. **Still silent** at `deb0856` (Stage 0 item 5, which adds a `log.warn` here, has
    not landed in `src/`). If Stage 0 item 5 *has* landed by Stage 4, this site already warns — route it
    through the reporter instead.
- **No existing `ErrorReporter` / `reportError` / `report(` utility** (grep clean). **No existing throttled-Notice
  helper anywhere** (`grep -rn "throttle" src/` → none). Stage 0 item 6 proposes a *local* throttled-Notice in
  `hook-dispatcher.ts`; this item **generalizes that into the shared utility** the parent spec names.

### Change

1. **Add `src/utils/error-reporter.ts`:**
   ```ts
   // Conceptual contract — names are a design choice.
   interface ErrorReport {
     error?: unknown;
     notify?: boolean;        // default false — structured-log only unless asked
     throttleKey?: string;    // dedupe Notices within a window
   }
   class ErrorReporter {
     report(subsystem: string, message: string, opts?: ErrorReport): void;
     // always structured-log via logger(subsystem); if notify, show a throttled Notice.
   }
   ```
   - **Always** structured-log (so nothing gets *less* visible). The Notice is opt-in (`notify: true`) and
     **throttled** by `throttleKey` (at most one Notice per key per window — the codebase has no throttle
     primitive today, so implement a small last-fired-timestamp map here; it becomes the canonical one).
   - If **Stage 0 item 6** already added a local throttled-Notice helper in `hook-dispatcher.ts`, **fold it
     into this reporter and have hook-dispatcher call the reporter** — do not leave two throttle implementations.
2. **Adopt at the three silent-failure sites first** (the parent spec's explicit order):
   - sub-agent discovery (~124) and rules (~335): `report("sub-agents"/"rules", "Failed to parse …", { error, notify: true, throttleKey })`
     — surfaces the failure once, audibly, instead of vanishing into the console. (Coordinate with Stage 1
     item 2: if `discoverVaultContent` returns `{ items, errors }`, report the aggregated `errors` at the
     discovery call site rather than deep in the loop.)
   - `model-metadata.ts` fallback (~630): `report("model-metadata", "Unknown model, using default context window", { notify: false, throttleKey: modelId })`
     — log-level visibility is enough here (a Notice per unknown model would be noise), but it is now recorded
     through one channel.
3. **Record intent at the deliberate-null sites without changing behavior.** Have `checkpoint.ts`'s null
   returns call `report("checkpoints", "…", { notify: false })` so the design intent ("we swallow this on
   purpose") is *recorded in one place*, not just implied by a comment. **Do not** change the null-return
   contract — checkpoints must keep returning null (the parent spec is explicit).
4. **This is a *sweep adopted opportunistically*, not a 203-Notice migration.** Do **not** convert all 203
   `new Notice` calls. The deliberate user-facing Notices (command feedback, settings validation) stay as they
   are. The reporter's job is the *silent* failures + a single throttle primitive — adopt it where visibility
   is currently wrong, and let future work route through it.

### Verification
- A malformed sub-agent profile and a malformed rule file each produce **one** (throttled) Notice + a
  structured log — instead of vanishing (the regression that proves the fix). Tests in `src/sub-agents/` /
  `src/rules/` (the latter is a zero-test zone — this adds its first; coordinate with Stage 1 item 2's tests).
- `model-metadata` fallback logs through the reporter (spy on the reporter) and does **not** Notice-spam on
  repeated unknown-model lookups (throttle by `modelId`).
- Checkpoint null-return behavior is byte-identical; the reporter call is `notify: false`.
- `tsc` + suite green.

### Risk
**Low.** Additive utility + targeted adoption. The only subtlety is the throttle map's lifetime (don't leak
keys forever — bound it or expire entries). Keep it in its own commit so the later items can adopt the
reporter from a stable base.

---

## 2. Converge automation invocation context (Issue 2.3) — M, medium risk

Tools and automations diverge in invocation context and error semantics: a user who learns the tool model
(cancel, progress, ask, structured errors) gets silently different behavior in automations. Converging them is
a usability fix **and the prerequisite for middleware (item 3)** — a transform that can't be cancelled can't
be middleware.

### Current state (verified — `src/extensions/manager.ts`)

- **Tools get four per-invocation utils merged** in `UserToolAdapter.execute()` (~88–103): `abortSignal`,
  `onProgress`, `interactionCallback`, and a silent-mode `noteOpener` override. `compiledFn` is called with the
  real `app` first (~110–117): `await compiledFn(this.plugin.app, obsidian, utils, libs, settings, shared, params)`.
- **Automations get none of them.** `executeAutomation()` (~771–832) builds `utils = buildUtils(this.plugin, conversationId, extensionName)`
  with **no per-invocation merge** (~817–831) and calls `compiledFn(this.plugin.app, obsidian, utils, libs, settings, shared, context)`
  (~823–831). An automation **cannot be cancelled, cannot report progress, cannot `ask`.**
- **Error model divergence:** tools support the `__toolError` sentinel and catch exceptions into a structured
  `ToolResult` (~152–166); automation errors propagate up to the dispatch site (e.g. `hook-events.ts` per-automation
  try/catch ~417–432) which logs + Notices but has **no structured channel back**.
- **The type already declares the missing members.** `ExtensionUtils` (`runtime-context/types.ts`) declares
  `abortSignal?` (~287), `onProgress?` (~289), `interactionCallback?` (~291–296, `@internal`), and the
  higher-level `ask`/`askMany` (~310–326) — with a comment noting they are *"only set per-invocation by
  UserToolAdapter."* So convergence is *wiring*, not new type surface.
- **Stage 1 item 5 already wired a timeout `abortSignal` into automations** (for the execution-timeout
  backstop). This item builds on that: the signal exists; now make it a *meaningful* cancellation signal (turn
  abort / user cancel), not only the timeout backstop, and add `onProgress`/`ask` where a conversation exists.

### Change

1. **Give automations the same per-invocation merge tools get.** In `executeAutomation()`, after `buildUtils`,
   merge in (where available from the automation's invocation context):
   - `abortSignal` — wired to a **per-dispatch `AbortController`** so an automation can be cancelled by turn
     abort / user cancel, not just the Stage-1b timeout. (Code-map §2.3: this *also* addresses Issue 6.2's
     "automations race user actions" — a cancellable automation can be aborted when the user does something
     that invalidates it.)
   - `onProgress` — where the automation runs in a conversation context that has a UI sink (the lifecycle
     triggers `on_conversation_start`, `after_completion` do; vault-event triggers like `on_note_create` may
     not — pass `undefined` there, don't fabricate a sink).
   - `ask`/`interactionCallback` — only where a conversation/view exists to host the prompt; otherwise omit
     (an automation firing on a background vault event has no one to ask).
2. **Unify the error model.** Decide and document `__toolError` as **tool-only** *or* generalize it:
   - **Recommended:** generalize — let automations also return the `__toolError`-shaped sentinel and have
     `executeAutomation` map it into a structured result + route through the **`ErrorReporter` (item 1)**
     (`report("automations", …, { notify: true })`) instead of the ad-hoc per-dispatch try/catch. This gives
     automations the same structured, surfaced failure path tools have.
   - Document the chosen semantics in `docs/extensions.md` + the `tool-creator` persona; run `audit-personas-docs`.
3. **Add `depth`-style context only if needed** — *not* in scope here; this item is purely the
   abortSignal/progress/ask/error convergence. (Sub-agent depth is Stage 2 item 4.)
4. **Keep the invocation-context shape identical between tools and automations** so a future middleware
   transform (item 3) can run in *either* and get the same `abortSignal`/`ask` surface. This is the property
   item 3 depends on.

### Verification
- An automation in a conversation context receives a live `abortSignal`; aborting the turn cancels an
  in-flight automation (test the cancel path). A background vault-event automation gets `abortSignal` (timeout)
  but `onProgress`/`ask` undefined (test that omission is graceful, not a crash).
- An automation that returns the `__toolError` sentinel (if generalized) produces a structured, **surfaced**
  error (Notice via `ErrorReporter`), not a swallowed log.
- `extensions/__tests__/manager.test.ts` (1,106 lines) stays green and gains automation-context cases.
- `tsc` + suite green; `audit-personas-docs` clean after doc edits.

### Risk
**Medium.** The hazards: (a) wiring `abortSignal` for automations that previously *couldn't* be cancelled may
expose code that assumes it always runs to completion — test the cancel path on the built-in automation
scaffolds; (b) `ask` in a context with no view must degrade cleanly (return null / no-op), never hang. Mitigate
by gating `ask`/`onProgress` strictly on "is there a conversation+view here," and by composing — not clobbering
— any signal Stage 1b already merged.

---

## 3. Agent-loop middleware: `pre_send_transform` / `on_tool_result_transform` (Issue 2.5) — M, medium risk — **gated on Stage 1 item 1 + item 2**

Hooks observe but cannot act — *except* approval. `dispatchOnApprovalRequired` already proves a middleware-style
contract works in this codebase (sequential dispatch, first non-`pass` decision wins). Generalize that one
ad-hoc acting hook into two transform variants so users can rewrite an outgoing message or a tool result — the
agent-loop extension power users most want.

> **Gate: Stage 1 item 1 (Runtime API v1) must have landed**, so the transform context is a *stable, versioned*
> contract (parent spec §2.5). And **item 2 (2.3) must have landed** — a transform that can't be cancelled
> isn't middleware. If either is missing, stop.

### Current state (verified)

- **12 automation triggers** (`extensions/types.ts` ~128–140): `pre_send`, `on_tool_call`, `on_tool_result`,
  `after_completion`, `on_approval_required`, `on_conversation_start`, `on_note_open`, `on_note_create`,
  `on_save`, `on_manual_save`, `on_tag_change`, `on_schedule`.
- **All observe-only except approval:**
  - `dispatchPreSend` (`hook-events.ts` ~323–444) returns `string[]`; the orchestrator injects them as a
    **separate flagged user message** (ACI-002, `orchestrator.ts` ~823–835) — it **appends context, it does
    not rewrite** the outgoing message.
  - `dispatchOnToolCall` (~466–562), `dispatchOnToolResult` (~581–685), `dispatchAfterCompletion` (~704–799):
    each runs a fire-and-forget `void (async () => …)()` IIFE (~508 / ~625 / ~743); **return values discarded.**
  - **`dispatchOnApprovalRequired` (~980–1075 — note: NOT ~769–850 as the source docs say)** is the lone acting
    hook: returns `"approved" | "rejected" | "pass"`; iterates shell hooks then automations **sequentially**,
    **first non-`pass` wins** (short-circuits ~1019/1023/1049/1056), returns `"pass"` if all pass (~1074).
- **No transform hooks exist** (`grep` for `pre_send_transform` / `on_tool_result_transform` / `_transform` →
  zero).
- **Dispatch wiring:** `hook-dispatcher.ts` (~40–169) wraps the events; orchestrator dispatch sites — `pre_send`
  awaited ~795, `on_conversation_start` ~864, `on_tool_call` fire-and-forget ~1269, `on_approval_required`
  **awaited** ~1314, `on_tool_result` fire-and-forget ~1384–1386, `after_completion` fire-and-forget ~1528.
- **Substrate from Stage 0:** item 6 routed the fire-and-forget triggers through `TaskLaneQueue` (lane =
  conversation id); item 7 widened `ApprovalDecision`. (Confirm both landed — at `deb0856` the IIFE pattern is
  still present, i.e. Stage 0 is not yet in `src/`.)

### Change

1. **Add two transform triggers**, modeled exactly on `dispatchOnApprovalRequired`'s contract:
   ```ts
   // pre_send_transform: rewrite the OUTGOING message (distinct from observe-only pre_send injection).
   pre_send_transform(ctx: PreSendTransformCtx): { message?: string } | "pass";
   // on_tool_result_transform: rewrite a tool RESULT before it enters the transcript / reaches the LLM.
   on_tool_result_transform(ctx: ToolResultTransformCtx): { result?: ToolResult } | "pass";
   ```
   - **Sequential dispatch, chained** (not "first wins" like approval — for transforms, each transform sees the
     prior's output, so the chain composes): run registered transforms in order; a `"pass"` leaves the value
     unchanged; a `{ message }` / `{ result }` replaces it for the next transform. This is the natural
     generalization — approval *decides* (first non-pass wins), transforms *rewrite* (compose in sequence).
   - **Per-transform timeout** (reuse Stage 1b's `withTimeout` + the per-dispatch `AbortController` from item
     2): a slow/hung transform is aborted and treated as `"pass"` (fail-open — a broken middleware must not
     wedge the turn), with the failure surfaced via **`ErrorReporter` (item 1)**.
2. **`pre_send_transform` coexists with observe-only `pre_send`.** They are different contracts: `pre_send`
   *appends* a context message (ACI-002, unchanged); `pre_send_transform` *rewrites* the outgoing message.
   Keep `pre_send` untouched; add `pre_send_transform` as the acting variant. Document the distinction loudly —
   it is the single most confusable part of this item (the source review predates ACI-002 and conflates them).
3. **`on_tool_result_transform` runs at the result-ingestion point**, where `on_tool_result` fires today
   (`orchestrator.ts` ~1384) but **awaited and chained** rather than fire-and-forget — because its output feeds
   the transcript. Apply the transform to the `ToolResult` *before* it is added to the conversation /
   serialized. (This is the hook-side counterpart to Stage 2 item 2's tool→dispatcher `emit` channel — they
   operate at different layers; do not merge them.)
4. **Gate behind a setting**, off by default (parent spec §2.5: *"Gate behind a setting"*). Acting middleware on
   untrusted shared extensions is a D-share risk surface; require explicit opt-in. The setting also lets the
   feature ship dark and be enabled per-vault.
5. **Keep all observe-only triggers untouched** — only `pre_send_transform` and `on_tool_result_transform` are
   new acting contracts; `on_tool_call`/`after_completion`/the vault-event triggers stay observe-only.
6. **Expose registration through the runtime API** per §0's convention (these are new frontmatter trigger
   values + the existing automation surface; the *context* objects are the new frozen contract — version them
   under `utils.api.version`). Document in `docs/extensions.md` + `tool-creator`; run `audit-personas-docs`.

### Verification
- A `pre_send_transform` that returns `{ message }` actually changes the outgoing message the provider
  receives (assert against the wire payload); a `"pass"` leaves it identical; two transforms **compose** (the
  second sees the first's output).
- An `on_tool_result_transform` rewrites a `ToolResult` before it enters the transcript (persisted conversation
  shows the transformed result); a `"pass"` is a no-op.
- A transform that throws or hangs is aborted at the per-transform timeout, treated as `"pass"`, and surfaced
  via `ErrorReporter` — the turn completes (fail-open).
- The feature is **off** with the setting disabled (no behavior change for existing vaults).
- `src/hooks/` tests (a zero-test zone — this adds the first transform tests, alongside Stage 0 item 6's
  hook-dispatch tests). `tsc` + suite green; `audit-personas-docs` clean.

### Risk
**Medium.** Real hazards: (a) **`pre_send_transform` vs `pre_send` confusion** — a misimplementation that
*replaces* the ACI-002 injection instead of adding alongside it would silently drop context; keep them
strictly separate and test both fire. (b) **Fail-open discipline** — a buggy/hostile transform must never wedge
or silently corrupt a turn; the per-transform timeout + treat-error-as-pass is load-bearing, test it. (c)
**Ordering/compose semantics** — document and test that transforms *chain* (not first-wins) so authors aren't
surprised. Mitigate by shipping behind the off-by-default setting and modeling the dispatch loop directly on
the already-working `dispatchOnApprovalRequired`.

---

## 4. `ProviderDescriptor` single-registration module → `registerProvider()` (Issue 4.5) — M, medium risk — **gated on Stage 1 item 4**

Adding a provider today touches **seven** files (union type, factory site #1, factory site #2, dropdown,
settings section, connection test, model-metadata) — and the dual factory sites **have already drifted**
(`registry-factory.ts` registers only 3 of 4). Consolidate to a single descriptor consumed everywhere; then
`registerProvider()` via the runtime API is a small final step.

> **Gate: Stage 1 item 4 must have landed.** The descriptor composes `getCapabilities(modelId)` and the
> *unified* `validateConnection(): { ok, detail }` — both are produced by Stage 1 item 4. Before then they
> don't exist to put in the descriptor.

### Current state (verified)

- **Provider union** — `src/types.ts:296`: `export type LLMProviderType = "local" | "bedrock" | "anthropic" | "openai";`
  (`use_extended_context` on `LLMProviderConfig` ~322 and `ModelPreset` ~366 — but Stage 1 item 4 moves the
  former into Bedrock config; coordinate).
- **Factory site #1** — `src/main.ts` (owner: `ProviderRegistry`): `registerFactory("local"|"anthropic"|"openai", …)`
  at ~1351–1359; Bedrock registered **lazily** — a placeholder factory that *throws* (~1363–1372) plus
  `initBedrockProvider()` which `await import("./providers/bedrock-provider")` then `registerFactory("bedrock", …)`
  (~1375–1399). **The lazy Bedrock import is load-bearing** (AWS SDK is heavy/Node-only).
- **Factory site #2** — `src/providers/registry-factory.ts` ~41–54: registers `local`/`anthropic`/`openai`
  **only — Bedrock intentionally excluded** (module comment ~8–15: `@aws-sdk/credential-providers` is Node-only,
  breaks esbuild). This is the "already-drifted dual site" — but the drift is *deliberate*, not a bug to erase.
- **Dropdown** — `src/settings/sections/provider-add.ts` ~56–60: four hard-coded `dropdown.addOption(...)`.
- **Settings sections** — `src/settings/sections/provider-{local,anthropic,openai,bedrock,reference}.ts`;
  dispatched by a `switch (config.type)` in `settings-tab.ts` ~168–184 → `render{Local,Anthropic,OpenAI,Bedrock}ProviderSection`.
- **Connection test** — `src/settings/sections/connection-test.ts` ~35–37: `if (providerConfig.type === "bedrock")`
  diverts to `renderBedrockConnectionTestButton` (STS `GetCallerIdentity`, dynamic-imports `@aws-sdk/client-sts`
  + `credential-providers` ~122–175); the generic branch ~66–86 calls `provider.validateConnection()`.
- **Interface** — `src/providers/provider.ts:197`: `validateConnection(): Promise<boolean>` (all four implement:
  anthropic ~565, openai ~430, bedrock ~883, local ~426). `getCapabilities`/`resolveThinkingConfig` **not yet
  present** (Stage 1 item 4 adds them).
- **No `registerProvider` on `ExtensionUtils`** (grep clean) — providers are not extension-registerable today.

### Change

1. **Define `ProviderDescriptor` in one module** (`src/providers/provider-descriptor.ts` or similar):
   ```ts
   interface ProviderDescriptor {
     type: string;                                            // was the union member
     displayName: string;                                     // dropdown label
     factory: (config, app) => LLMProvider;                   // OR an async/lazy factory — see step 3
     renderSettingsSection: (container, ctx, config) => void; // the provider-*.ts render fn
     validateConnection: (config, app) => Promise<{ ok: boolean; detail?: string }>; // Stage 1 item 4 shape
     getCapabilities: (modelId) => Capabilities;              // Stage 1 item 4 (may delegate to the provider instance)
   }
   const BUILTIN_PROVIDERS: ProviderDescriptor[] = [ /* local, anthropic, openai, bedrock */ ];
   ```
2. **Both `main.ts` and `registry-factory.ts` consume `BUILTIN_PROVIDERS`** — kills the dual factory sites and
   the dropdown edit. The dropdown (`provider-add.ts`) maps over the descriptor list; `settings-tab.ts`'s
   `switch` becomes "look up the descriptor by `config.type`, call `descriptor.renderSettingsSection`"; the
   `LLMProviderType` union **derives from the descriptor list** (e.g. a `keyof`/`as const` derivation or a
   runtime-validated string).
3. **Preserve Bedrock's lazy/excluded behavior — do not regress it.** The descriptor for Bedrock must:
   - use a **lazy/async factory** (`() => import("./bedrock-provider")…`) so the AWS SDK stays out of the main
     bundle path, exactly as `initBedrockProvider()` does today;
   - be **flagged as unavailable in the `registry-factory.ts` (settings-test) context** — e.g. a
     `descriptor.bundleSafe: false` (or an explicit "excluded from the test registry" predicate) so
     `registry-factory.ts` skips it the way the hand-written code does now, with the *reason* recorded once on
     the descriptor instead of in a comment in a second file. This turns the silent drift into an explicit,
     single-sourced property.
4. **Fold the connection-test branch into the descriptor.** `connection-test.ts`'s `if (type === "bedrock")`
   fork disappears: it calls `descriptor.validateConnection(config, app)` for every provider and renders
   `detail` (Bedrock's returns the STS account/ARN as `detail`; others return `{ ok }`). This *requires* Stage
   1 item 4's `{ ok, detail }` return shape — hence the gate. (Stage 1 item 4 already plans to delete this
   fork; if it has, this step is "consume the unified method via the descriptor.")
5. **Then expose `registerProvider(descriptor)` through the runtime API** (§0 convention) — a small step once
   descriptors exist. Per parent spec §4.5 + D-share, **take this step only when sandboxing/versioning justify
   third-party providers** — i.e. it is the *last* sub-step, gated on Stage 1b's full-privilege acknowledgment
   being in place. A third-party provider runs arbitrary network/credential code; it must sit behind the same
   trust gate as any other shared extension. Ship the consolidation (steps 1–4) first; add `registerProvider`
   when the trust story is ready.

### Verification
- Adding a hypothetical 5th provider touches **one** place (a new `ProviderDescriptor` entry) — demonstrate by
  adding a trivial test descriptor and asserting it appears in the dropdown, gets a settings section, and is
  connection-testable, with no edits to `main.ts`/`registry-factory.ts`/the union.
- Bedrock still works end-to-end: lazy import preserved (AWS SDK not in the main bundle — check the build),
  excluded from the settings-test registry, STS connection test returns account/ARN as `detail`.
- The three bundle-safe providers register in both contexts identically; `tsc` + provider suites green.
- `registerProvider` (when added) is gated on the full-privilege acknowledgment and versioned under the runtime
  API; a registered third-party provider is connection-testable through the same path.

### Risk
**Medium.** The sharp edges: (a) **regressing Bedrock's lazy import** — if the descriptor eagerly imports the
AWS SDK, the bundle breaks; keep the factory lazy and verify the build output. (b) **deriving the union from a
runtime list** — `LLMProviderType` is used in many `switch`/type positions; ensure the derivation still gives
compile-time exhaustiveness where it matters (a `const` tuple → union is safer than a fully-dynamic string).
(c) **the `registerProvider` trust gate** — do not ship runtime-API provider registration before Stage 1b's
acknowledgment; a third-party provider is maximally privileged. Mitigate by landing steps 1–4 (pure
consolidation, no new capability) first and `registerProvider` as a separate, trust-gated commit.

---

## 5. Open settings-section + context-source registration (Issue 2.6) — M-L, medium risk — **after items 3 & 4 + Stage 1 item 3**

Issue 2.6 is the umbrella: open the closed registration seams using the `ChatBlockRegistry` recipe. Providers
(item 4) and loop middleware (item 3) are done elsewhere; **this item delivers the two genuinely-new seams —
settings-section and context-source registration — plus the small flag that opens Stage 1's block registry to
user *replacement*.**

### Current state (verified)

- **The recipe already exists** — `src/ui/chat-blocks/registry.ts`: `ChatBlockDefinition` (~24–32:
  `kind`, `displayName`, `icon?`, `render`, `toLLMText?`, `excludeFromCompaction?`, `renderLoading?`);
  `register()` (~37–42) **keeps-first, silently rejects duplicates** (`if (has(kind)) { log.error; return }`).
  **No `priority`/override flag.** Stage 1 item 3 migrated the six built-in block kinds onto this registry, but
  deliberately left it "built-ins register first and win" — *replacement* by users was explicitly deferred to
  this stage.
- **Settings sections — hard-coded, no registration point.** `settings-tab.ts` `display()` (~162–241): **15
  groups** via `createSettingsGroup(...)` calls, each invoking hard-coded `render*Section(...)` functions from
  the **35** files in `src/settings/sections/`. No interface to contribute a section.
- **Context sources — hard-coded, no "contribute context" interface.** `src/chat/system-prompt.ts` assembles
  the turn's system prompt from **7 hard-coded `DYNAMIC_SECTION_MARKERS`** (~34–42, incl. `vault_rules` ~37);
  the three sources are called explicitly by name:
  - vault rules — `src/rules/vault-rules.ts` (`VaultRuleManager`);
  - auto-context — `src/context/auto-context.ts` (injected into the system prompt per ACI-001, not message
    assembly);
  - include-note — `src/include-note/{parser,resolver}.ts`.
  There is no registry; adding a context source means editing `system-prompt.ts`'s marker list.

### Change

**5a. Block-renderer override flag (the small piece that finishes 5.2's "open to users").**
1. Add an optional `priority?: number` (or `override?: boolean`) to `ChatBlockDefinition` and change
   `register()` from keeps-first to **highest-priority-wins** (built-ins register at a low/base priority; a
   user block with higher priority replaces a built-in). This is the *only* registry change — Stage 1 already
   migrated the built-ins; this opens deliberate replacement. Per parent spec §5.2, add this **only now**, when
   built-in replacement is deliberately opened to users.
2. Surface duplicate/override decisions through **`ErrorReporter` (item 1)** instead of the silent `log.error`,
   so a user shadowing a built-in sees it acknowledged.

**5b. Settings-section registration.**
3. Define a `SettingsSectionDescriptor` registry following the block recipe:
   ```ts
   interface SettingsSectionDescriptor {
     id: string;
     group: string;            // which of the 15 groups it renders under (or a new "Extensions" group)
     order?: number;
     render: (container, ctx) => void;
   }
   ```
   Built-in sections register as descriptors (mechanically wrap the existing 35 `render*Section` functions);
   `settings-tab.ts` `display()` iterates the registry per group instead of hard-coding the call sequence.
   Extension-contributed sections register via the runtime API (§0 convention) under an "Extensions" group.
4. **This pairs with item 6 (settings namespacing).** An extension-contributed section needs a namespaced place
   to store its settings (`settings.extensions.<name>.*`) — the parent spec notes 5.4 *"unlocks
   extension-contributed settings sections."* If item 6 is being done, coordinate the namespace; if not, scope
   extension sections to the existing `user_extension_settings` / `user_shared_settings` keys.

**5c. Context-source registration.**
5. Define a `ContextSourceDescriptor` registry:
   ```ts
   interface ContextSourceDescriptor {
     id: string;
     gather: (ctx: TurnContext) => string | null;   // returns the section body, or null to contribute nothing
     marker?: string;                                // optional placement among DYNAMIC_SECTION_MARKERS
   }
   ```
   The three built-in sources (vault rules, auto-context, include-note) register as descriptors; `system-prompt.ts`
   iterates registered sources instead of hard-coding the 7-marker list. Extension-contributed sources register
   via the runtime API. **Respect the parent spec's over-abstraction warning** (§6 risk #3 is about discovery
   layout, but the spirit applies): keep the descriptor minimal; do not force the bespoke auto-context (ACI-001
   system-prompt injection) and the rules manager into one rigid shape if their placement/lifecycle genuinely
   differ — parameterize via `marker`.
6. Route all three new seams' registration through the **versioned runtime API** (§0). Built-ins register
   internally through the *same* interfaces. Document each in `docs/extensions.md` + `tool-creator`; run
   `audit-personas-docs`.

### Verification
- **Blocks:** a user block def with higher priority **replaces** a built-in kind (render the user version); a
  same-priority duplicate is reported (Notice), not silently dropped.
- **Settings:** all 15 groups / 35 built-in sections render identically after the registry migration (visual
  parity); an extension-registered section appears under "Extensions" and persists its values.
- **Context:** vault rules / auto-context / include-note still contribute identical content (parity); an
  extension-registered context source's `gather()` output appears in the assembled system prompt; a source
  returning `null` contributes nothing (no empty section).
- `tsc` + suite green; manual Obsidian smoke (`debug-in-obsidian` / `run`) for the settings tab + a turn with a
  custom context source; `audit-personas-docs` clean.

### Risk
**Medium.** Settings-section migration is wide (35 sections, 15 groups) but mechanical — risk is a section
landing in the wrong group or losing its order; migrate group-by-group with visual parity checks (mirror Stage
3 item 7's group-by-group discipline). Context-source registration touches `system-prompt.ts`, which feeds
*every* turn — a regression silently changes the system prompt; keep built-in parity tests and migrate the
three sources one at a time. The block override flag is small but changes registry semantics (keeps-first →
priority) — ensure built-ins still win by default (register at base priority) so existing vaults are unchanged.

---

## 6. Settings namespacing (Issue 5.4) — M, low risk — opportunistic, pairs with item 5

`NotorSettings` is a flat monolith — **77 top-level fields** (verified; *not* 89 or 469), prefix-grouped by
convention (`compaction_*`, `checkpoint_*`, `auto_context_*`, …) but not structurally. Moderate, not urgent:
the parent spec says do it **opportunistically, not as a campaign.** The trigger to do it now is item 5 —
namespacing is what lets extension-contributed settings sections have a place to live.

### Current state (verified)

- `NotorSettings` — `src/settings/types.ts` ~69–468: **77 flat top-level fields**, prefix pseudo-grouped
  (`compaction_threshold`, `compaction_prompt_override`, `checkpoint_path`, `checkpoint_max_per_conversation`,
  `checkpoint_max_age_days`, `auto_context_*`, `sub_agent_*`, `memory_*`, `templates_*`, `workflow_*`, …).
- Defaults — `src/settings/defaults.ts` `createDefaultSettings()` (~124; file ~243 lines).
- Rendering **already modular** (35 section files / 15 groups, item 5) — only the *schema* is flat.
- Migrations — `src/settings/migrations.ts` (~16–163, file ~324 lines): **versionless**, idempotent via
  field-presence detection + **two-phase write** (Phase 1 copy+save ~130–131, Phase 2 strip-old ~133–160); 5
  migrations registered. **No `settings_version` field** (Stage 0 item 2 optionally adds one alongside
  `schema_version`; the migration *mechanism* is sound and unchanged).

### Change
1. **Group flat keys into namespaced sub-objects one group at a time** using the **existing two-phase migration
   machinery** — e.g. `compaction_threshold` → `settings.compaction.threshold`, `checkpoint_*` →
   `settings.checkpoints.*`. Each group is one migration: Phase 1 writes the nested shape alongside the flat
   keys, Phase 2 strips the flat keys (crash-safe, idempotent — exactly what the mechanism is built for).
2. **Define per-section `{ types, defaults, render }` modules** so a section is one file instead of three
   (types + defaults + section renderer scattered). This dovetails with item 5's `SettingsSectionDescriptor` —
   a descriptor can carry its own `defaults` and `types`, making an extension-contributed section
   self-contained and giving it a namespace (`settings.extensions.<name>.*`).
3. **Opportunistic scope.** Do **not** namespace all 77 fields in one pass. Do the groups item 5's
   extension-settings story needs first (a clean `settings.extensions.*` namespace), then convert the obvious
   clusters (`compaction`, `checkpoints`, `sub_agent`, `memory`) as they're touched. Leave the rest flat until
   something touches them. The parent spec is explicit: *not a campaign.*

### Verification
- Each namespaced group round-trips: a vault with flat keys migrates to nested on load (two-phase), reads back
  identically, and a fresh vault gets nested defaults. The migration is idempotent (running twice is a no-op).
- The 35 section renderers read their (possibly nested) keys correctly; settings UI behaves identically.
- `tsc` + suite green; `settings/migrations` tests extended per group migrated.

### Risk
**Low** — the migration mechanism is proven and crash-safe. The only hazard is a half-migrated key (a reader
expecting flat while the writer went nested) — mitigate by migrating one group per commit, Phase 1 (additive)
and Phase 2 (strip) both shipping together, and keeping readers tolerant during the window. Don't touch the
migration *mechanism*; only add migrations.

---

## 7. Styles split (Issue 5.5) — S, low risk — lowest payoff, fully independent

`styles.css` is a 93,236-byte / 4,186-line / **583-rule-set** monolith organized by comment banners. Splitting
it into per-feature files matches `src/`'s modular structure. Pure mechanics, no risk — and the parent spec's
**lowest-payoff** item, so do it only opportunistically (or hand it to anyone; it gates nothing).

### Current state (verified)
- `/Volumes/workplace/notor/styles.css`: 93,236 bytes, 4,186 lines, ~583 rule sets, ~40+ comment-banner
  sections.
- `esbuild.config.mjs` `copyPluginAssets()` (~59–68): line ~63 `copyFileSync(resolve(__dirname, 'styles.css'), resolve(buildDir, 'styles.css'))`
  — **verbatim copy, no concatenation step** (Obsidian requires a single `styles.css` artifact).

### Change
1. Split `styles.css` into `styles/*.css` by feature (mirror the comment-banner sections → files:
   `styles/chat.css`, `styles/settings.css`, `styles/diff.css`, …).
2. Add a **trivial concat step** to `copyPluginAssets()` in `esbuild.config.mjs`: read `styles/*.css` (in a
   stable order), concatenate, write the single `styles.css` artifact the build currently copies. The build
   already owns producing the artifact; this only changes *how* it's produced.
3. No selector changes, no renames — a pure reorganization. Keep the concatenation order deterministic so
   cascade behavior is unchanged.

### Verification
- The concatenated artifact is byte-equivalent (modulo whitespace/order-preserving) to today's `styles.css` —
  diff the build output; the rendered UI is visually identical (manual Obsidian smoke).
- `npm run build` produces a single `styles.css` in the build dir as before.

### Risk
**Low.** The only trap is **cascade order** — if the concat order differs from the original top-to-bottom
order, later-overriding selectors could flip. Mitigate by concatenating in the original section order and
diffing the produced artifact against the current file. Genuinely low payoff; skip if time-constrained.

---

## 8. Cross-cutting: build / test / commit hygiene

- **Build gate:** every item ends with `npm run build` / `tsc --noEmit` clean. Items 3, 4, 5 are
  contract-driven; `tsc` is a primary safety net (descriptor/interface omissions become type errors).
- **Test zones touched:** items 1, 3, 5 reach into zero-test zones (`src/hooks/`, `src/rules/`,
  context-source assembly) — attach tests to the migration, per parent spec §6.4. Item 4 extends the provider
  suites; item 6 extends `settings/migrations` tests per group.
- **Manual smoke is non-optional for the seam items.** Item 3 (a transform actually rewriting a message/result
  in a live turn), item 5 (settings tab + a custom context source in a real prompt), and item 7 (visual CSS
  parity) are under-covered by unit tests — run `debug-in-obsidian` / `run`.
- **Skills:** run **`audit-personas-docs`** after items 2, 3, 4, 5 (every doc/persona-touching change), since
  Stage 4 adds the most new user-facing extension surface of any stage. Run **`audit-bedrock-thinking`** after
  item 4 if the provider consolidation moves anything in the Bedrock capability path (it shouldn't change
  classification — confirm).
- **Runtime-API discipline (§0):** every new `utils.register*` member is part of the frozen v1 surface. Adding
  members is additive (`RUNTIME_API_VERSION` stays 1), but name each deliberately and document it; do not hand
  out live registries — expose thin registration functions, mirroring Stage 1 item 1's facade discipline.
- **Trust-gate discipline (D-share):** the two maximally-privileged new surfaces — `registerProvider` (item 4,
  arbitrary credential/network code) and acting middleware (item 3, rewrites turns) — ship **behind a setting /
  the full-privilege acknowledgment**, off by default. Do not enable either by default.
- **Commit granularity** (per repo git rules — use `mcp__git` tools, not raw CLI; one logical unit per commit).
  Suggested commits:
  1. `Add ErrorReporter utility + adopt at silent-failure sites` (item 1)
  2. `Converge automation invocation context (abortSignal/ask/progress + error model)` (item 2)
  3. `Add pre_send_transform / on_tool_result_transform middleware (gated, off by default)` (item 3 — after Stage 1 + item 2)
  4. `Consolidate provider registration into ProviderDescriptor module` (item 4, steps 1–4 — after Stage 1 item 4)
  5. `Expose registerProvider via runtime API (trust-gated)` (item 4, step 5)
  6. `Add ChatBlockRegistry priority/override flag` (item 5a)
  7. `Open settings-section registration` (item 5b)
  8. `Open context-source registration` (item 5c)
  9. `Namespace settings groups via two-phase migration` (item 6 — per group, splittable)
  10. `Split styles.css into per-feature files + concat step` (item 7)

---

## 9. What this plan deliberately does NOT do

- **No new runtime API *version*.** Every new `utils.register*` member is additive; `RUNTIME_API_VERSION` stays
  `1` (Stage 1 item 1 owns versioning). Stage 4 *uses* the versioned API; it does not bump it.
- **No worker-isolated sandbox build (Issue 2.2 Phase 2).** That is Stage 1b's design note + later build work;
  Stage 4's trust gates (settings, full-privilege ack) are the interim control for the new privileged seams.
- **No replacement of the observe-only `pre_send` injection.** Item 3 *adds* `pre_send_transform` alongside the
  ACI-002 injection; the existing observe-only triggers are untouched.
- **No "fix" to Bedrock's lazy-import / registry-factory exclusion.** Item 4 *preserves* it (it's intentional —
  AWS SDK is Node-only); the descriptor records the reason once instead of erasing the behavior.
- **No 203-Notice migration.** Item 1 adopts `ErrorReporter` at the *silent-failure* sites and as the single
  throttle primitive; deliberate user-facing Notices stay.
- **No full settings-schema rewrite.** Item 6 namespaces groups *opportunistically* via the existing migration
  machinery — not all 77 fields, not a campaign.
- **No selector/CSS rewrite.** Item 7 reorganizes files and adds a concat step; zero rule changes.
- **No agent-loop / dispatcher / message-pipeline changes.** Those are Stages 2/3; item 3 here only *adds*
  transform dispatch points, it does not restructure the loop.

---

## 10. Open questions to resolve at implementation time

1. **Middleware compose vs first-wins** (item 3): transforms should *chain* (each sees the prior's output),
   unlike approval's first-non-pass-wins. Confirm chaining is the desired semantics for `pre_send_transform`
   and `on_tool_result_transform`, and document it loudly — authors will assume one or the other.
2. **`pre_send_transform` placement relative to ACI-002 injection** (item 3): does the transform see the
   message *before* or *after* the observe-only `pre_send` injection is appended? Recommended: transform the
   user's outgoing message, then append injection — but confirm against the orchestrator's send ordering
   (~`orchestrator.ts:795` / ~823–835).
3. **Middleware enablement granularity** (item 3): one global setting, or per-extension opt-in? Recommended:
   a global off-by-default gate first; per-extension grant later if needed (don't over-build before sharing
   demand is real).
4. **`LLMProviderType` union derivation** (item 4): derive the compile-time union from a `const` descriptor
   tuple (preserves exhaustiveness in `switch` sites) vs a runtime-validated `string`. Recommended: `const`
   tuple → union for built-ins; runtime validation only for `registerProvider`-added third-party types.
5. **`registerProvider` trust gate** (item 4 step 5): which gate exactly — the Stage-1b full-privilege
   acknowledgment, a separate "allow third-party providers" setting, or both? Recommended: both (a third-party
   provider is maximally privileged); ship steps 1–4 without it and add the gated registration separately.
6. **Context-source descriptor placement** (item 5c): can auto-context's ACI-001 system-prompt injection and
   the rules manager genuinely share one `ContextSourceDescriptor`, or do their lifecycles differ enough to
   warrant a `marker`/placement parameter? Enumerate the 7 `DYNAMIC_SECTION_MARKERS` before forcing one shape.
7. **Settings-section group for extensions** (item 5b): a dedicated "Extensions" group vs letting an extension
   target any existing group. Recommended: a dedicated group (predictable, avoids extensions interleaving with
   core settings) unless a concrete need arises.
8. **Item 6 namespace shape for extensions** (items 5b + 6): `settings.extensions.<name>.*` vs the existing
   `user_extension_settings` map. Recommended: reuse/extend `user_extension_settings` if it already namespaces
   by extension; introduce `settings.extensions.*` only if a structural section is needed.
9. **Did Stage 0 land?** (items 1, 3): item 1 should *absorb* any local throttled-Notice Stage 0 item 6 added;
   item 3 assumes Stage 0 item 6 (hooks via `TaskLaneQueue`) + item 7 (`ApprovalDecision`) are in. Confirm
   before starting — at `deb0856` they are not yet in `src/`.
```