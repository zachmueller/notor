---
name: update-bedrock-models
description: Find the latest AWS Bedrock models and bring the plugin's model metadata up to date. Enumerates the live Bedrock catalog, diffs it against MODEL_METADATA to find chat models missing context-window/pricing entries, probes each new model's real 1M-context + thinking behavior, then adds correct entries to src/providers/model-metadata.ts. Use when new Bedrock/Claude models ship, when a model falls back to the 128K default context window, or to answer "which Bedrock models is the plugin missing?".
---

# Update Bedrock Model Metadata

The plugin keys context-window sizes and pricing off a static table,
`MODEL_METADATA` in [src/providers/model-metadata.ts](src/providers/model-metadata.ts).
Any Bedrock model **not** in that table still works if selected, but silently falls
back to `DEFAULT_CONTEXT_WINDOW` (128K) and shows no pricing/label — so context
assembly, compaction, and sub-agent wind-down all budget against the wrong window.
This skill keeps the table in sync with the live Bedrock catalog.

Two things must be right for each model: its **context window** (200K base, 1M with
the `context-1m` beta for recent Claude) and, for Claude models, its **thinking
protocol** (`enabled` = visible transcript vs `effort` = adaptive/encrypted). Both are
verified against **live wire behavior**, never guessed from the name.

> Paths below are relative to the repo root (`<unit>/` = the repo). The driver lives at
> `.claude/skills/update-bedrock-models/coverage.ts`. **Read-only tools** (AWS list/probe
> calls, the driver) are safe to run anytime; the only writes are your hand edits to
> `model-metadata.ts` in step 3.

## Prerequisites

- AWS CLI on PATH with a Bedrock-enabled profile. This repo uses profile **`zmueller`**,
  region **`us-east-1`** (the region only exposes `us.`/`global.` geo prefixes).
  Needs `bedrock:ListInferenceProfiles` and `bedrock-runtime:Converse`.
- `npx tsx` (already a dev dependency — the driver and `classify.ts` run under it).
- No `apt-get` / build step: this is a metadata edit, not an app launch.

## Run the driver (agent path) — START HERE

One command enumerates the live catalog, applies the plugin's own filters
(`NON_CHAT_ID_PATTERNS` + `status === "ACTIVE"`), diffs against `MODEL_METADATA`, and
joins the plugin's real thinking classifier onto every Anthropic id:

```bash
npx tsx .claude/skills/update-bedrock-models/coverage.ts --profile zmueller --region us-east-1
```

Output (verified this session):

```
profile=zmueller region=us-east-1
profiles=63 active=63 chat-eligible=44 missing=0

✅ Full coverage — every chat-eligible profile has metadata.

Anthropic thinking classification (missing? / supportsThinking / mode):
  [  ok   ] us.anthropic.claude-opus-5    think=true  mode=effort
  ...
```

- **`missing=0`** → nothing to do; the table already covers every selectable model.
- **A `❌ MISSING` list** → those profiles need entries (step 2–3). The `think=/mode=`
  column tells you which thinking bucket each Anthropic model *currently* classifies
  into — verify it against a live probe before trusting it (step 2).

Add `--json` for machine-readable output. The driver imports the plugin's **real**
`getKnownModelIds` / `supportsThinking` / `getThinkingMode`, so it can never drift from
what the plugin actually ships. (It keeps a copy of `NON_CHAT_ID_PATTERNS` inline —
if [bedrock-provider.ts](src/providers/bedrock-provider.ts) changes that list, update
the copy at the top of `coverage.ts`.)

## Step 2: Probe each missing model's real behavior

Never classify from the name. For **each missing Claude model**, run two `converse`
probes to ground-truth its config. Both commands were run this session.

**A. Does it accept the 1M context beta?** (decides whether the entry gets an
`extended_context` block)

```bash
aws bedrock-runtime converse --region us-east-1 --profile zmueller \
  --model-id us.anthropic.claude-opus-4-7 \
  --messages '[{"role":"user","content":[{"text":"Say OK."}]}]' \
  --inference-config '{"maxTokens":16}' \
  --additional-model-request-fields '{"anthropic_beta":["context-1m-2025-08-07"]}' \
  --output json
```

Returns text (e.g. `"OK"`) → beta accepted → add `extended_context` (1M). An error
naming the beta flag → base 200K only.

**B. Which thinking protocol?** Send legacy `thinking.type=enabled` and inspect the
returned `reasoningText.text` length — **populated = `enabled` (visible), empty (or
rejected) = `effort`**. Presence of a `signature`/`reasoningContent` block alone does
NOT decide it; the text field does:

```bash
aws bedrock-runtime converse --region us-east-1 --profile zmueller \
  --model-id us.anthropic.claude-opus-4-5-20251101-v1:0 \
  --messages '[{"role":"user","content":[{"text":"What is 17*23? Think first."}]}]' \
  --inference-config '{"maxTokens":3000}' \
  --additional-model-request-fields '{"thinking":{"type":"enabled","budget_tokens":1500}}' \
  --output json \
  | python3 -c "import sys,json; d=json.load(sys.stdin); b=d.get('output',{}).get('message',{}).get('content',[]); rc=next((x['reasoningContent'] for x in b if 'reasoningContent' in x),None); t=(rc or {}).get('reasoningText',{}).get('text',''); print(f'reasoningText len={len(t)} -> {\"VISIBLE=enabled\" if t else \"EMPTY/none=effort\"}')"
```

- Rejected with `"thinking.type.enabled" is not supported … use adaptive` → **`effort`**.
- Accepted, `reasoningText.text` populated → **`enabled`** (legacy visible transcript).
- `budget_tokens` must be ≥ 1024 and < `maxTokens`, or you get a validation error that
  is about the budget, not the protocol — re-run with a valid budget before concluding.

For the full model-classification audit (all ids, with the classifier + probe
guidance), the sibling skill [audit-bedrock-thinking](../audit-bedrock-thinking/SKILL.md)
covers the thinking side in depth; this skill focuses on the metadata table.

## Step 3: Add the entries to `MODEL_METADATA`

Edit [src/providers/model-metadata.ts](src/providers/model-metadata.ts). Match the
table's existing conventions **exactly**:

- **Anthropic** entries carry `display_name` and, when the 1M beta was accepted
  (probe A), an `extended_context` block with `beta_flag: "context-1m-2025-08-07"`.
  Add both the geo-prefixed Bedrock key(s) the driver reported (e.g.
  `us.`/`global.anthropic.claude-<model>`) **and** the matching direct-API alias.
  Mirror pricing from the nearest sibling tier and flag guesses with `// verify`.
- **Non-Anthropic** (Nova/Meta/Mistral/Writer/DeepSeek) entries carry `context_window`
  + pricing only — **no** `display_name`, **no** `extended_context`. All pricing gets
  `// verify` (Bedrock partner rates are not exposed by the control plane).
- Only add the geo prefixes the driver actually returned. Don't speculate `eu.`/`apac.`.

**Thinking needs a code change only if the driver's `mode=` is wrong** vs your probe:
- New model probes as `effort` and driver already shows `effort` → **no change**
  (`getThinkingMode` defaults new models to `effort`). This is the common case.
- New model whose id shape isn't matched by `THINKING_PATTERNS` at all (driver shows
  `think=false` but it should think) → add a pattern to `THINKING_PATTERNS`.
- New model probes **visible** (`enabled`) but isn't matched by
  `LEGACY_ENABLED_THINKING_PATTERNS` → add it there (rare; that set is nearly closed).

Then add/extend tests in the sibling test files (mirror the existing cases):
[model-metadata.test.ts](src/providers/model-metadata.test.ts) (context windows),
[thinking-config.test.ts](src/providers/thinking-config.test.ts) (`supportsThinking` /
`getThinkingMode`), [model-grouping.test.ts](src/providers/model-grouping.test.ts)
(label + 1M-variant synthesis).

## Step 4: Verify

```bash
# 1. Coverage is now complete — the driver's missing set is empty.
npx tsx .claude/skills/update-bedrock-models/coverage.ts --profile zmueller --region us-east-1

# 2. Thinking classification unchanged/correct for the whole live chat list.
#    (classify.ts is the audit-bedrock-thinking driver; reuse it.)
echo '["us.anthropic.claude-opus-4-7","us.anthropic.claude-opus-4-5-20251101-v1:0"]' \
  | npx tsx .claude/skills/audit-bedrock-thinking/classify.ts

# 3. Tests + typecheck.
npx vitest run src/providers/model-metadata.test.ts src/providers/thinking-config.test.ts src/providers/model-grouping.test.ts
npx vitest run
npx tsc --noEmit
```

All four commands were run this session; the full suite passes (1159 tests) and the
driver reports `missing=0`.

## Gotchas

- **The driver enumerates via inference *profiles*, not foundation models — and so does
  the plugin.** A model whose *foundation* entry is `LEGACY`/EOL can still have an
  `ACTIVE` inference profile that the picker shows (Llama 3.2 is exactly this). Register
  metadata for the ACTIVE profile regardless of foundation lifecycle.
- **`get-foundation-model` does NOT return the context window.** The Bedrock control
  plane exposes modalities and lifecycle, not token limits — so context-window values
  come from vendor docs (flag `// verify`), never from the API. Confirmed this session.
- **Metadata lookups are exact-key.** `getContextWindow` / `enrichModelInfo` do
  `MODEL_METADATA[modelId]` — a differently-suffixed live id (e.g. `-v1:0` vs bare, or
  `claude-opus-4-6-v1` with no date) misses and falls back to 128K. Copy the id the
  driver prints **verbatim** as the key.
- **The thinking probe's signal is `reasoningText.text` length, not the presence of a
  `reasoningContent`/`signature` block.** Both visible and encrypted reasoning carry a
  block; only the *text* distinguishes `enabled` from `effort`. A too-small
  `budget_tokens` (< 1024) errors on the budget, masking the protocol — use ≥ 1024.
- **Keep the `NON_CHAT_ID_PATTERNS` copy in `coverage.ts` in sync** with
  bedrock-provider.ts. If the plugin starts excluding a new non-chat provider, the
  driver's chat-eligible count will drift until you mirror the change.
- **Region determines geo prefixes.** `us-east-1` returns only `us.`/`global.`. Running
  the driver against `eu-*`/`ap-*` would surface `eu.`/`apac.` ids — add those keys only
  when you actually run in (or confirm) those regions.

## Troubleshooting

- **`ExpiredTokenException` / "security token … expired"** → the driver prints a refresh
  hint; run your SSO login for the profile (e.g. `aws sso login --profile zmueller`) and
  retry.
- **`AccessDeniedException` on list** → the profile lacks `bedrock:ListInferenceProfiles`.
- **`converse` ValidationException mentioning `budget_tokens`** → budget < 1024 or ≥
  `maxTokens`; that's a budget error, not the thinking protocol. Fix the budget and re-probe.
- **Driver shows `missing=N` after you edited the table** → the key you added doesn't
  byte-match the live id. Diff your key against the exact string in the driver's MISSING
  list (suffix/date mismatches are the usual cause).
