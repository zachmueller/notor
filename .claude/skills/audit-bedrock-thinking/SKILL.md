---
name: audit-bedrock-thinking
description: Hit the Bedrock model-describer (control-plane) APIs to enumerate available models and audit how each is classified for thinking — visible "enabled"/budget vs adaptive "effort" — flagging any new or unclassified model and verifying ambiguous Anthropic models against live wire behavior. Use when new Bedrock/Claude models appear, when reviewing LEGACY_ENABLED_THINKING_PATTERNS in model-metadata.ts, or when a model's thinking transcript regresses.
---

# Audit Bedrock Models & Thinking Classification

Notor decides a model's thinking protocol with a single classifier,
`getThinkingMode(modelId)` in `src/providers/model-metadata.ts`. It buckets every
thinking-capable model into one of two wire protocols:

- **`"enabled"`** — legacy `thinking.type=enabled` + `budget_tokens`. Bedrock streams a
  **visible** reasoning transcript. Driven by a **closed** allowlist,
  `LEGACY_ENABLED_THINKING_PATTERNS` (Claude 3.5/3.7, Sonnet/Opus 4.0–4.6). This list is
  declared final and **never grows**.
- **`"effort"`** — adaptive thinking + `output_config.effort`. Reasoning is returned
  **encrypted** (no visible transcript) and `thinking.type=enabled` is **rejected** by
  Bedrock. This is the **default** for everything not in the legacy set (Opus 4.8+ and
  all future models).

Because the default is `"effort"`, a **misclassification fails silently**: a genuinely
legacy model that's missing from the allowlist just loses its visible thinking
transcript with no error. This skill is the safety net — it enumerates the models that
actually exist in your account/region via the Bedrock control plane, runs each through
the repo's real classifier, and flags anything that needs a human decision.

> **This skill is read-only.** It enumerates, classifies, probes, and reports. It must
> **not** edit `model-metadata.ts` or any source file. The engineer decides whether to
> update `LEGACY_ENABLED_THINKING_PATTERNS`.

**Prerequisites:** the AWS CLI (`aws`) on PATH, valid Bedrock credentials, and
`bedrock:ListInferenceProfiles` (and ideally `bedrock:ListFoundationModels` +
`bedrock:InvokeModelWithResponseStream` for the live probe) on the role.

---

## Step 0: Orient — read the source of truth

Read the classification you're auditing **fresh each run** (never hardcode a copy — the
patterns change):

- `src/providers/model-metadata.ts` — `THINKING_PATTERNS`,
  `LEGACY_ENABLED_THINKING_PATTERNS`, `getThinkingMode`, `supportsThinking` (the block
  near the bottom of the file).
- `src/providers/thinking-config.ts` — `resolveAnthropicThinking` (how the mode becomes
  the wire request).
- `src/providers/bedrock-provider.ts` — `listModels()` (~line 740) for the exact filters
  and credential/region setup the plugin uses; the CLI calls below mirror it.

**Resolve the AWS profile + region the same way the plugin does**, so the audit matches
what users actually see. Check the plugin's `data.json` (the Obsidian vault's
`.obsidian/plugins/notor/data.json`) for the bedrock provider entry's `aws_profile` and
`region`; default to profile `default` and region `us-east-1` if not found. Bedrock
returns only the inference profiles for the configured region's geo group, so **the
report must state which region/profile it audited**.

---

## Step 1: Enumerate models (control plane, AWS CLI)

Mirror `bedrock-provider.ts listModels()`, but via the CLI. Substitute the resolved
`<region>` and `<profile>`:

```bash
aws bedrock list-inference-profiles --type-equals SYSTEM_DEFINED \
  --region <region> --profile <profile> --output json

aws bedrock list-foundation-models --by-output-modality TEXT \
  --by-inference-type ON_DEMAND --region <region> --profile <profile> --output json
```

`list-inference-profiles` paginates — if the response has a `nextToken`, pass it back
via `--next-token <token>` until it's absent.

Apply the **same filters the provider applies** so the audit set matches the in-app set:

- **Inference profiles:** keep only `status == "ACTIVE"`; drop IDs matching the
  `NON_CHAT_ID_PATTERNS` in `bedrock-provider.ts` (stability / twelvelabs /
  `cohere.embed` / `amazon.titan-embed`).
- **Foundation models:** drop `modelLifecycle.status == "LEGACY"` and the same non-chat
  patterns; de-dupe against the base model IDs already covered by inference profiles
  (inference-profile IDs carry a geo prefix like `us.` / `global.` — strip it to
  compare).

To confirm a single ambiguous model's modalities/lifecycle:

```bash
aws bedrock get-foundation-model --model-identifier <id> \
  --region <region> --profile <profile> --output json
```

**Error handling** (match the provider's messaging):
- `AccessDeniedException` / "not authorized" → the `bedrock:ListInferenceProfiles` IAM
  permission is required. Surface this and stop.
- `ExpiredTokenException` / "security token ... expired" → credentials expired; refresh
  (e.g. re-run SSO login) and retry.

---

## Step 2: Classify each model statically (use the repo's real functions)

Do **not** re-implement the regexes — run the enumerated IDs through the code the plugin
actually ships. Write the filtered ID list to a temp JSON file and run the bundled
classifier helper:

```bash
# from the repo root; <ids.json> is a JSON array of model-id strings
npx tsx .claude/skills/audit-bedrock-thinking/classify.ts <ids.json>
```

`classify.ts` imports `supportsThinking` and `getThinkingMode` from
`src/providers/model-metadata.ts` and prints, for each id, a JSON row:
`{ id, supportsThinking, thinkingMode, matchedLegacyPattern }`.

`matchedLegacyPattern` distinguishes the two ways a model can land in a mode:
- a model in `"enabled"` mode is always there because it matched the closed allowlist;
- a model in `"effort"` mode may be there because it's a real adaptive model **or**
  only because it hit the **default fallback** — that distinction is what Step 3 flags.

This guarantees the audit uses the same code path as production, not a hand-copied regex
that can drift.

---

## Step 3: Flag the cases that need a decision

From the classifier output, call out — in priority order:

1. **Unclassified Anthropic thinking models defaulting to `"effort"`** (the risk cases):
   any `*anthropic.claude-*` model where `supportsThinking` is true but
   `matchedLegacyPattern` is false. If Bedrock actually returns a *visible* transcript
   for one of these, it's been silently misrouted to adaptive (the exact regression class
   this skill guards against). **Escalate each to the Step 4 live probe.**
2. **New models** absent from `MODEL_METADATA` (no pricing/context enrichment) — cosmetic,
   but note them so metadata can be added.
3. **Sanity check:** every model whose ID matches the closed legacy set should still
   appear in the live list. If an allowlisted pattern matches nothing live, note it
   (a model may have been retired) — but do **not** remove patterns; the list is
   intentionally closed.

If Step 1 surfaced no unclassified Anthropic thinking models, you can skip Step 4 and go
straight to the report.

---

## Step 4: Live wire probe for ambiguous Anthropic models (only the flagged ones)

The control plane can't tell us a model's thinking protocol — only the runtime can. For
**each flagged unclassified Anthropic model**, ground-truth it with a real, minimal
Bedrock round-trip:

```bash
aws bedrock-runtime converse-stream \
  --region <region> --profile <profile> \
  --model-id <id> \
  --messages '[{"role":"user","content":[{"text":"Briefly: what is 2+2? Think first."}]}]' \
  --inference-config '{"maxTokens":2048}' \
  --additional-model-request-fields '{"thinking":{"type":"enabled","budget_tokens":1024}}' \
  --output json
```

Keep `budget_tokens` small (1024) and `maxTokens` comfortably above it. Interpret the
result exactly as the e2e tests do (see `e2e/scripts/opus-48-thinking-test.ts`):

- **Rejected** with a message containing `thinking.type.enabled` and/or
  `is not supported` → the model is **`"effort"`**. Correctly served by the default —
  **no allowlist change needed.**
- **Accepted, and the stream contains a visible `reasoningContent` *text* delta** → the
  model is legacy **`"enabled"`** and **MUST be added** to
  `LEGACY_ENABLED_THINKING_PATTERNS`, or it will lose its visible transcript.
- **Accepted, but reasoning arrives only as a signed/encrypted `reasoningContent` block**
  (no text delta) → effectively `"effort"`; leave it on the default.

Record a verdict for every probed model.

---

## Step 5: Emit the audit report

Print a Markdown table — one row per enumerated model:

| model id | provider | supportsThinking | getThinkingMode | matched legacy pattern? | live probe verdict | action |
|----------|----------|------------------|-----------------|-------------------------|--------------------|--------|

Below the table, a short **Findings** section:

- **Models to add to `LEGACY_ENABLED_THINKING_PATTERNS`** — list each, with a *suggested*
  regex line (e.g. `/^(us|eu|apac|global)\.anthropic\.claude-sonnet-4-7/`), but **do not
  apply it** — this is read-only.
- **New models missing from `MODEL_METADATA`.**
- **Region/profile audited**, model counts, and any access errors encountered.

End with an explicit note: **this skill made no edits.** The engineer decides whether to
update `src/providers/model-metadata.ts`.

---

## DO / DO NOT

### DO
- Resolve and report the exact region + profile audited.
- Reuse the repo's `supportsThinking` / `getThinkingMode` via `classify.ts` — never
  hand-roll the regexes.
- Reuse the provider's `NON_CHAT_ID_PATTERNS` and lifecycle filters verbatim.
- Use the rejection markers `thinking.type.enabled` / `is not supported` as the
  live-probe signal.
- Keep the live probe minimal (small budget, short prompt) and probe only flagged models.

### DO NOT
- **Never edit** `model-metadata.ts` or any source file — output suggestions only.
- Never remove anything from the closed `LEGACY_ENABLED_THINKING_PATTERNS` set.
- Never classify a model from its name alone — for the ambiguous Anthropic cases, the
  live probe is the source of truth.
- Never silently pass over an access/credential error — surface it with the provider's
  guidance.
