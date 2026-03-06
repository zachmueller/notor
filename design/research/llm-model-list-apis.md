# Research: LLM Provider Model List APIs

**Research Task:** R-4
**Status:** Updated (2026-07-03) — Bedrock section revised to use inference profiles
**Blocks:** Phase 0 (model selection — FR-3)
**Plan:** [specs/01-mvp/plan.md](../../specs/01-mvp/plan.md)
**Contract:** [specs/01-mvp/contracts/llm-provider.md](../../specs/01-mvp/contracts/llm-provider.md)

---

## Summary

All four supported providers (OpenAI, Anthropic, AWS Bedrock, local OpenAI-compatible) expose model list APIs. However, the metadata available per model varies significantly — none of the cloud APIs return context window size or pricing in their list endpoints. Notor must maintain a supplementary metadata table for context window and pricing information, keyed by model ID.

Analysis of the Cline codebase (Section 5) confirms this is the **industry-standard approach**: Cline uses hardcoded static metadata tables for all direct API providers, user-provided settings for local models, and sane defaults (128k) for unknown models. No production AI tool dynamically fetches context window sizes from OpenAI, Anthropic, or Bedrock APIs — they all maintain static lookup tables.

**Bedrock update (2026-07-03):** The original design used `ListFoundationModels` as the model discovery API for Bedrock. This has been superseded by `ListInferenceProfiles`. See Section 3 for the full updated analysis and the rationale for switching.

---

## 1. OpenAI API

### Endpoint

```
GET https://api.openai.com/v1/models
```

### Authentication

- **Header:** `Authorization: Bearer $OPENAI_API_KEY`
- Any valid API key can list models — no special scopes or permissions required.

### Request

No query parameters. Returns all models accessible to the API key (including fine-tuned models).

### Response Format

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4o",
      "object": "model",
      "created": 1686935002,
      "owned_by": "openai"
    },
    {
      "id": "gpt-4o-mini",
      "object": "model",
      "created": 1686935002,
      "owned_by": "openai"
    },
    {
      "id": "text-embedding-3-small",
      "object": "model",
      "created": 1686935002,
      "owned_by": "openai"
    }
  ]
}
```

### Response Fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Model identifier used in API calls (e.g., `gpt-4o`, `gpt-4o-mini`) |
| `object` | string | Always `"model"` |
| `created` | number | Unix timestamp (seconds) of model creation |
| `owned_by` | string | Organization that owns the model (e.g., `"openai"`, `"system"`, or org ID for fine-tuned) |

### Filtering

- **No server-side filtering.** The endpoint returns all models including chat, embedding, image, audio, and fine-tuned models.
- **Client-side filtering required.** To show only chat-capable models, we must filter by model ID prefix/pattern. There are no capability flags in the response.
- **Recommended heuristic:** Filter to models whose `id` starts with `gpt-`, `o1-`, `o3-`, `o4-`, `chatgpt-`, or other known chat model prefixes. Alternatively, maintain an allowlist of known chat model prefixes.

### Rate Limits

- The `/v1/models` endpoint is subject to standard API rate limits but is very lightweight.
- No specific rate limit documentation for this endpoint; in practice it can be called frequently without issues.

### Notable Limitations

- **No context window size** in response.
- **No pricing information** in response.
- **No capability flags** (chat, embedding, image, etc.) in response.
- **No display name** — only the model `id`, which must be used as the display name.
- Returns fine-tuned models alongside base models (filtered by `owned_by` containing the org ID).

---

## 2. Anthropic API

### Endpoint

```
GET https://api.anthropic.com/v1/models
```

### Authentication

- **Header:** `x-api-key: $ANTHROPIC_API_KEY`
- **Header:** `anthropic-version: 2023-06-01` (required)

### Request — Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `after_id` | string | No | Cursor for forward pagination (returns results after this ID) |
| `before_id` | string | No | Cursor for backward pagination (returns results before this ID) |
| `limit` | number | No | Number of items per page |

### Response Format

```json
{
  "data": [
    {
      "id": "claude-opus-4-6",
      "created_at": "2026-02-04T00:00:00Z",
      "display_name": "Claude Opus 4.6",
      "type": "model"
    },
    {
      "id": "claude-sonnet-4-5-20250514",
      "created_at": "2025-05-14T00:00:00Z",
      "display_name": "Claude Sonnet 4.5",
      "type": "model"
    }
  ],
  "first_id": "claude-opus-4-6",
  "has_more": true,
  "last_id": "claude-sonnet-4-5-20250514"
}
```

### Response Fields (per model)

| Field | Type | Description |
|---|---|---|
| `id` | string | Model identifier used in API calls (e.g., `claude-opus-4-6`) |
| `created_at` | string | ISO 8601 timestamp of model creation |
| `display_name` | string | Human-readable model name (e.g., `"Claude Opus 4.6"`) |
| `type` | string | Always `"model"` |

### Pagination Fields (top-level)

| Field | Type | Description |
|---|---|---|
| `first_id` | string | First ID in `data` list; use as `before_id` for previous page |
| `has_more` | boolean | Whether more results exist in the requested direction |
| `last_id` | string | Last ID in `data` list; use as `after_id` for next page |

### Additional Endpoints

- **Get a Model:** `GET /v1/models/{model_id}` — returns the same `ModelInfo` fields for a single model. Can resolve model aliases to concrete model IDs.

### Header Parameters

- `anthropic-beta`: optional array of `AnthropicBeta` — specify beta version(s) to use.

### Notable Limitations

- **No context window size** in response.
- **No pricing information** in response.
- **No capability flags** — all listed models are message-capable, so no filtering needed.
- **Pagination required** for complete list — must follow `has_more` / `after_id` cursor.
- **`display_name` is provided** — unlike OpenAI, Anthropic returns a human-readable name.
- **More recently released models are listed first** — newest models appear at the top.

---

## 3. AWS Bedrock — Inference Profiles (Updated 2026-07-03)

> **Note:** The original design (2026-06-03) used `ListFoundationModels` for Bedrock model discovery. This section supersedes that approach. The `ListFoundationModels` analysis is preserved in [Section 3b](#3b-deprecated-listfoundationmodels-original-approach) for historical reference.

### 3a. Recommended Approach: `ListInferenceProfiles`

#### Why Inference Profiles Instead of Foundation Models

AWS introduced **system-defined cross-region inference profiles** in mid-2024 and has progressively shifted toward them as the recommended model invocation mechanism. The key differences:

| Aspect | `ListFoundationModels` | `ListInferenceProfiles` (SYSTEM_DEFINED) |
|---|---|---|
| **Model coverage** | Foundation models available in a single region | Cross-region profiles (newer models may only appear here) |
| **Model IDs for invocation** | `anthropic.claude-sonnet-4-20250514-v1:0` | `us.anthropic.claude-sonnet-4-20250514-v1:0` |
| **Resilience** | Single-region; fails if that region is degraded | Auto-routes across 2–5 regions |
| **Latest models** | May lag; some new models added only to profiles | Includes newest Anthropic, Amazon Nova, Llama 4, etc. |
| **Human-readable names** | `modelName` field present | `inferenceProfileName` field present |
| **Descriptions** | None | `description` field (e.g., "Routes requests to ... in us-east-1 and us-west-2.") |
| **IAM permission** | `bedrock:ListFoundationModels` | `bedrock:ListInferenceProfiles` |
| **Non-text models** | Requires `byOutputModality=TEXT` filter | Requires client-side filtering |

**Critical finding:** Several newer models (including `us.anthropic.claude-opus-4-6-v1`, `us.anthropic.claude-sonnet-4-6`, the Llama 4 series, and Amazon Nova Premier) appear **only** in `ListInferenceProfiles` and not reliably in `ListFoundationModels` for all regions. Using `ListFoundationModels` alone would cause Notor to show an incomplete or stale model list.

The inference profile ID (e.g., `us.anthropic.claude-sonnet-4-20250514-v1:0`) is the value that should be passed as `modelId` to the Converse API — AWS now recommends using inference profile IDs over bare foundation model IDs for all standard invocations.

#### SDK Call

```typescript
import { BedrockClient, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";

const client = new BedrockClient({ region: "us-east-1" });
const response = await client.send(new ListInferenceProfilesCommand({
  typeEquals: "SYSTEM_DEFINED",
}));
```

#### HTTP Equivalent

```
GET /inference-profiles?typeEquals=SYSTEM_DEFINED
```

#### Authentication

- **AWS SDK credential chain:** Named profile (`fromIni({ profile })`), environment variables, direct keys (`fromCredentials({ accessKeyId, secretAccessKey })`), or instance role.
- **Required IAM permission:** `bedrock:ListInferenceProfiles`
- This is a **read-only** permission — separate from `bedrock:InvokeModel`.
- Note: if the existing IAM policy only grants `bedrock:ListFoundationModels`, it must be updated to also include `bedrock:ListInferenceProfiles`.

#### Request — Query Parameters

| Parameter | Type | Valid Values | Description |
|---|---|---|---|
| `typeEquals` | string | `SYSTEM_DEFINED`, `APPLICATION` | Filter by profile type. Use `SYSTEM_DEFINED` for AWS-managed cross-region profiles. |

**Pagination:** `ListInferenceProfiles` is a paginated operation. Use `nextToken` / `maxResults` parameters to iterate if needed (in practice, all SYSTEM_DEFINED profiles for a region fit in a single page).

#### Response Format

```json
{
  "inferenceProfileSummaries": [
    {
      "inferenceProfileName": "US Claude Sonnet 4",
      "description": "Routes requests to Claude Sonnet 4 in us-east-1, us-east-2 and us-west-2.",
      "createdAt": "2025-05-14T00:00:00+00:00",
      "updatedAt": "2025-05-28T00:00:00+00:00",
      "inferenceProfileArn": "arn:aws:bedrock:us-east-1:639628476385:inference-profile/us.anthropic.claude-sonnet-4-20250514-v1:0",
      "models": [
        {
          "modelArn": "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0"
        },
        {
          "modelArn": "arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0"
        },
        {
          "modelArn": "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0"
        }
      ],
      "inferenceProfileId": "us.anthropic.claude-sonnet-4-20250514-v1:0",
      "status": "ACTIVE",
      "type": "SYSTEM_DEFINED"
    },
    {
      "inferenceProfileName": "Global Anthropic Claude Opus 4.6",
      "description": "Routes requests to Anthropic Claude Opus 4.6 globally across all supported AWS Regions.",
      "createdAt": "2026-02-03T19:06:46.193626+00:00",
      "updatedAt": "2026-03-05T22:14:18.607230+00:00",
      "inferenceProfileArn": "arn:aws:bedrock:us-east-1:639628476385:inference-profile/global.anthropic.claude-opus-4-6-v1",
      "models": [
        {
          "modelArn": "arn:aws:bedrock:::foundation-model/anthropic.claude-opus-4-6-v1"
        },
        {
          "modelArn": "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-6-v1"
        }
      ],
      "inferenceProfileId": "global.anthropic.claude-opus-4-6-v1",
      "status": "ACTIVE",
      "type": "SYSTEM_DEFINED"
    }
  ],
  "nextToken": null
}
```

#### Response Fields (per `InferenceProfileSummary`)

| Field | Type | Description |
|---|---|---|
| `inferenceProfileId` | string | **Use this as `modelId` in Converse API calls.** E.g., `us.anthropic.claude-sonnet-4-20250514-v1:0` |
| `inferenceProfileName` | string | Human-readable name (e.g., `"US Claude Sonnet 4"`) |
| `description` | string | Routing description (e.g., `"Routes requests to ... in us-east-1 and us-west-2."`) |
| `inferenceProfileArn` | string | Full ARN; can also be used as `modelId` |
| `models` | object[] | List of underlying foundation model ARNs this profile routes to |
| `models[].modelArn` | string | ARN of a constituent foundation model |
| `status` | string | `"ACTIVE"` when ready to use |
| `type` | string | `"SYSTEM_DEFINED"` (AWS-managed) or `"APPLICATION"` (user-created) |
| `createdAt` | timestamp | ISO 8601 creation timestamp |
| `updatedAt` | timestamp | ISO 8601 last-updated timestamp |

#### Inference Profile ID Format and Geographic Prefixes

System-defined inference profiles use a **geographic prefix** to indicate the routing region group:

| Prefix | Region Group | Example |
|---|---|---|
| `us.` | US regions (us-east-1, us-east-2, us-west-2) | `us.anthropic.claude-sonnet-4-20250514-v1:0` |
| `eu.` | EU regions (eu-west-1, eu-west-3, eu-central-1) | `eu.anthropic.claude-sonnet-4-20250514-v1:0` |
| `apac.` | APAC regions (ap-southeast-1, ap-northeast-1, etc.) | `apac.anthropic.claude-3-5-sonnet-20240620-v1:0` |
| `global.` | Global (routes across US + other regions) | `global.anthropic.claude-opus-4-6-v1` |

**When querying from a given region**, the API returns profiles relevant to that region:
- Querying `us-east-1` → returns `us.*` and `global.*` profiles (59 total as of 2026-07)
- Querying `eu-west-1` → returns `eu.*` and `global.*` profiles (30 total as of 2026-07)
- Querying `ap-southeast-1` → returns `apac.*` and `global.*` profiles (17 total as of 2026-07)

**Practical implication:** When displaying models to the user, the `inferenceProfileId` (e.g., `us.anthropic.claude-sonnet-4-20250514-v1:0`) is the value passed directly to the Converse API as `modelId`. No transformation needed.

#### Real Data Sample (us-east-1, July 2026)

Subset of relevant chat-capable profiles returned from `us-east-1`:

| `inferenceProfileId` | `inferenceProfileName` |
|---|---|
| `us.anthropic.claude-opus-4-6-v1` | US Anthropic Claude Opus 4.6 |
| `global.anthropic.claude-opus-4-6-v1` | Global Anthropic Claude Opus 4.6 |
| `us.anthropic.claude-sonnet-4-6` | US Anthropic Claude Sonnet 4.6 |
| `global.anthropic.claude-sonnet-4-6` | Global Anthropic Claude Sonnet 4.6 |
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | US Anthropic Claude Sonnet 4.5 |
| `global.anthropic.claude-sonnet-4-5-20250929-v1:0` | Global Claude Sonnet 4.5 |
| `us.anthropic.claude-haiku-4-5-20251001-v1:0` | US Anthropic Claude Haiku 4.5 |
| `global.anthropic.claude-haiku-4-5-20251001-v1:0` | Global Anthropic Claude Haiku 4.5 |
| `us.anthropic.claude-sonnet-4-20250514-v1:0` | US Claude Sonnet 4 |
| `global.anthropic.claude-sonnet-4-20250514-v1:0` | Global Claude Sonnet 4 |
| `us.anthropic.claude-opus-4-20250514-v1:0` | US Claude Opus 4 |
| `us.anthropic.claude-3-7-sonnet-20250219-v1:0` | US Anthropic Claude 3.7 Sonnet |
| `us.anthropic.claude-3-5-sonnet-20241022-v2:0` | US Anthropic Claude 3.5 Sonnet v2 |
| `us.anthropic.claude-3-5-haiku-20241022-v1:0` | US Anthropic Claude 3.5 Haiku |
| `us.amazon.nova-premier-v1:0` | US Nova Premier |
| `us.amazon.nova-pro-v1:0` | US Nova Pro |
| `us.amazon.nova-lite-v1:0` | US Nova Lite |
| `us.amazon.nova-micro-v1:0` | US Nova Micro |
| `global.amazon.nova-2-lite-v1:0` | GLOBAL Amazon Nova 2 Lite |
| `us.meta.llama4-maverick-17b-instruct-v1:0` | US Llama 4 Maverick 17B Instruct |
| `us.meta.llama4-scout-17b-instruct-v1:0` | US Llama 4 Scout 17B Instruct |
| `us.deepseek.r1-v1:0` | US DeepSeek-R1 |

#### Client-Side Filtering for Chat Models

`ListInferenceProfiles` returns all profile types including image generation and embedding models. Filter client-side by excluding known non-chat provider prefixes in the profile ID:

```typescript
const NON_CHAT_ID_PATTERNS = [
  /stability\./,         // Stable Diffusion image models
  /twelvelabs\./,        // Video/multimodal embedding models
  /cohere\.embed/,       // Embedding-only models
];

function isChatProfile(profileId: string): boolean {
  return !NON_CHAT_ID_PATTERNS.some(pattern => pattern.test(profileId));
}
```

Alternatively, filter by inferring provider from the ID segment (everything between the geographic prefix and the version suffix):

```typescript
const CHAT_PROVIDERS = ["anthropic", "amazon.nova", "meta", "deepseek", "mistral", "writer"];
```

#### Errors

| Error | HTTP Code | Description |
|---|---|---|
| `AccessDeniedException` | 403 | Missing `bedrock:ListInferenceProfiles` IAM permission |
| `ThrottlingException` | 429 | Rate limit exceeded |
| `ValidationException` | 400 | Invalid parameter (e.g., unknown `typeEquals` value) |
| `InternalServerException` | 500 | AWS service error |

#### IAM Permission Update Required

The original design required only `bedrock:ListFoundationModels`. The updated implementation requires:

```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock:ListInferenceProfiles",
    "bedrock:InvokeModelWithResponseStream"
  ],
  "Resource": "*"
}
```

`bedrock:ListFoundationModels` is no longer needed and can be removed, though keeping it is harmless.

#### Notable Characteristics

- **Better model coverage** — newer models are added to inference profiles first or exclusively.
- **Built-in cross-region resilience** — automatic failover across 2–5 underlying regions.
- **Human-readable names and descriptions** provided in the response.
- **Profile IDs are the correct `modelId` for Converse API** — no mapping or transformation step needed.
- **No context window size** in response (same limitation as `ListFoundationModels`).
- **No pricing information** in response.
- **Paginated** but in practice all SYSTEM_DEFINED profiles fit on one page.

---

### 3b. Deprecated: `ListFoundationModels` (Original Approach)

> **Status:** Superseded by `ListInferenceProfiles`. Preserved here for historical reference.

The original implementation used:

```typescript
import { BedrockClient, ListFoundationModelsCommand } from "@aws-sdk/client-bedrock";

const client = new BedrockClient({ region: "us-east-1" });
const response = await client.send(new ListFoundationModelsCommand({
  byOutputModality: "TEXT",
  byInferenceType: "ON_DEMAND",
}));
```

**Why this was replaced:**

1. **Incomplete model list.** Newer models (Claude Sonnet 4.6, Opus 4.6, Llama 4, Nova Premier, DeepSeek R1) appear in inference profiles only, or appear in `ListFoundationModels` with different/bare IDs that differ from what inference profiles expose. A user selecting from `ListFoundationModels` may end up passing a bare model ID (e.g., `anthropic.claude-opus-4-6-v1`) that works but bypasses cross-region routing.

2. **Wrong model IDs for invocation.** AWS now recommends using inference profile IDs (e.g., `us.anthropic.claude-sonnet-4-20250514-v1:0`) rather than bare foundation model IDs in Converse API calls. Listing foundation models returns the bare IDs, requiring a separate mapping step to get the inference profile equivalent.

3. **No cross-region benefit.** Foundation model IDs route to a single region. Inference profile IDs route to the nearest available region across 2–5 options, improving availability.

The original `ListFoundationModels` response format and fields are documented in the June 2026 version of this file in git history.

---

## 4. Local OpenAI-Compatible (Ollama, LM Studio, etc.)

### 4a. OpenAI-Compatible Endpoint (shared)

Both Ollama and LM Studio expose an OpenAI-compatible models endpoint:

```
GET {base_url}/v1/models
```

- **Ollama default:** `http://localhost:11434/v1/models`
- **LM Studio default:** `http://localhost:1234/v1/models`

### Authentication

- **Typically no authentication required** for local servers.
- Some configurations may use an optional API key, but this is uncommon for local setups.
- The provider implementation should support an optional API key header for flexibility.

### Response Format (OpenAI-compatible)

The response follows the OpenAI format:

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-r1:latest",
      "object": "model",
      "created": 1686935002,
      "owned_by": "library"
    },
    {
      "id": "llama3.2:latest",
      "object": "model",
      "created": 1686935002,
      "owned_by": "library"
    }
  ]
}
```

### 4b. Ollama Native API

Ollama also has a richer native endpoint:

```
GET http://localhost:11434/api/tags
```

**Response:**

```json
{
  "models": [
    {
      "name": "deepseek-r1:latest",
      "model": "deepseek-r1:latest",
      "modified_at": "2025-05-10T08:06:48.639712648-07:00",
      "size": 4683075271,
      "digest": "0a8c266910232fd3291e71e5ba1e058cc5af9d411192cf88b6d30e92b6e73163",
      "details": {
        "parent_model": "",
        "format": "gguf",
        "family": "qwen2",
        "families": ["qwen2"],
        "parameter_size": "7.6B",
        "quantization_level": "Q4_K_M"
      }
    }
  ]
}
```

**Native fields per model:**

| Field | Type | Description |
|---|---|---|
| `name` | string | Model name with tag (e.g., `deepseek-r1:latest`) |
| `model` | string | Same as name |
| `modified_at` | string | ISO 8601 timestamp of last modification |
| `size` | number | Model file size in bytes |
| `digest` | string | SHA256 digest of the model |
| `details.format` | string | Model format (e.g., `gguf`) |
| `details.family` | string | Model family (e.g., `qwen2`, `llama`) |
| `details.families` | string[] | All model families |
| `details.parameter_size` | string | Human-readable parameter count (e.g., `7.6B`, `3.2B`) |
| `details.quantization_level` | string | Quantization type (e.g., `Q4_K_M`) |

### 4c. LM Studio

- **Endpoint:** `GET http://localhost:1234/v1/models`
- **Format:** OpenAI-compatible (same as above)
- **No authentication** required by default.
- LM Studio loads models on-demand; the model list reflects currently loaded and available models.

### Error Handling for Local Providers

Common error scenarios:

| Scenario | Error | Handling |
|---|---|---|
| Server not running | `ECONNREFUSED` | Fall back to free-text input; display "Could not connect to local server" |
| Server starting up | `ECONNREFUSED` or timeout | Same as above |
| Invalid endpoint URL | DNS/connection error | Fall back to free-text input |
| Empty model list | 200 with empty `data` | Show "No models found. Pull/load a model first." |

### Recommendation for Local Providers

- **Use the OpenAI-compatible `/v1/models` endpoint** for consistency across Ollama, LM Studio, and other OpenAI-compatible servers.
- The `Local OpenAI-Compatible` provider type should work with any server implementing the OpenAI models list format.
- Do NOT use Ollama's native `/api/tags` endpoint — it would require a separate code path and the OpenAI-compatible endpoint provides sufficient information for model selection.

---

## 5. Reference Architecture: Cline's Approach to Context Window Sizes

**Source:** Cline codebase (`../cline/`), reviewed 2026-06-03

Cline (an AI coding assistant for VS Code) solves the same problem Notor faces — none of the direct cloud APIs return context window sizes. Cline's approach provides a proven, battle-tested pattern we should replicate.

### 5a. Architecture Overview

Cline uses a **three-tier strategy** for model metadata:

| Tier | Source | Context Window | Pricing | Used For |
|---|---|---|---|---|
| **1. Hardcoded static tables** | `shared/api.ts` | ✅ Yes | ✅ Yes | Direct API providers (Anthropic, OpenAI, Bedrock) |
| **2. Dynamic API fetching** | Provider-specific APIs | ✅ Yes (some) | ✅ Yes (some) | Aggregator providers (OpenRouter) |
| **3. User-provided settings** | Plugin settings UI | ✅ User-specified | N/A | Local providers (Ollama, LM Studio) |

### 5b. Tier 1: Hardcoded Static Metadata Tables (Primary Strategy)

This is Cline's **primary mechanism** and covers the majority of providers. In `shared/api.ts`, Cline defines typed `Record<string, ModelInfo>` objects keyed by model ID — one per provider:

```typescript
// Cline's ModelInfo interface (shared/api.ts)
export interface ModelInfo {
  name?: string;
  maxTokens?: number;        // max output tokens
  contextWindow?: number;    // context window size
  supportsImages?: boolean;
  supportsPromptCache: boolean;
  supportsReasoning?: boolean;
  inputPrice?: number;       // price per million tokens
  outputPrice?: number;      // price per million tokens
  cacheWritesPrice?: number;
  cacheReadsPrice?: number;
  description?: string;
  // ... additional fields
}
```

Each provider has its own hardcoded table:

| Provider | Table Variable | Example Model Count |
|---|---|---|
| Anthropic | `anthropicModels` | ~15 models |
| OpenAI Native | `openAiNativeModels` | ~20 models |
| Bedrock | `bedrockModels` | ~30 models |
| Vertex AI | `vertexModels` | ~30 models |
| DeepSeek | `deepSeekModels` | 2 models |
| Mistral | `mistralModels` | ~15 models |
| Gemini | `geminiModels` | ~15 models |

**How `getModel()` works for direct API providers:**

```typescript
// Anthropic handler — representative of all direct API providers
getModel(): { id: AnthropicModelId; info: ModelInfo } {
  const modelId = this.options.apiModelId;
  if (modelId && modelId in anthropicModels) {
    const id = modelId as AnthropicModelId;
    return { id, info: anthropicModels[id] };
  }
  return {
    id: anthropicDefaultModelId,
    info: anthropicModels[anthropicDefaultModelId],
  };
}
```

The model ID (selected by the user or configured in settings) is used as a key to look up the full metadata from the static table. If the model ID isn't found, it falls back to the provider's default model.

**Key insight:** Cline does **not** call any model list API to get context window sizes. The `GET /v1/models` endpoints (OpenAI, Anthropic) are not used for metadata — they're only used for populating the model selection dropdown. The metadata (context window, pricing) comes entirely from the hardcoded tables.

### 5c. Tier 2: Dynamic API Fetching (OpenRouter)

OpenRouter is an **aggregator** that proxies requests to multiple providers, and its API **does** return context window sizes and pricing. Cline leverages this:

```typescript
// From refreshOpenRouterModels.ts
interface OpenRouterRawModelInfo {
  id: string;
  name: string;
  description: string | null;
  context_length: number | null;          // ← Context window!
  top_provider: {
    max_completion_tokens: number | null;  // ← Max output tokens!
    context_length: number | null;
    is_moderated: boolean | null;
  } | null;
  pricing: {
    prompt: string;                        // ← Input price!
    completion: string;                    // ← Output price!
    input_cache_read: string;
    input_cache_write: string;
    // ...
  } | null;
  // ...
}
```

Cline fetches `GET https://openrouter.ai/api/v1/models`, parses the response, and maps it to its internal `ModelInfo` format:

```typescript
const modelInfo: ModelInfo = {
  name: rawModel.name,
  maxTokens: rawModel.top_provider?.max_completion_tokens ?? 0,
  contextWindow: rawModel.context_length ?? 0,     // Direct from API
  inputPrice: parsePrice(rawModel.pricing?.prompt),  // Direct from API
  outputPrice: parsePrice(rawModel.pricing?.completion),
  // ...
};
```

However, even with dynamic fetching, Cline **overrides certain values** with hardcoded data for specific models (e.g., forcing Anthropic models to 200k context window instead of 1M to reduce costs, adding cache pricing that OpenRouter doesn't report).

**Caching:** OpenRouter model data is cached in-memory via `StateManager` and persisted to a JSON file on disk (`openrouter_models.json`) for offline fallback.

### 5d. Tier 3: User-Provided Settings (Local Providers)

For local providers, the context window is unknowable at the API level, so Cline relies on user configuration:

**Ollama:**
```typescript
// Default context window, overridable via settings
const DEFAULT_CONTEXT_WINDOW = 32768;

getModel(): { id: string; info: ModelInfo } {
  return {
    id: this.options.ollamaModelId || "",
    info: {
      ...openAiModelInfoSaneDefaults,
      contextWindow: Number(this.options.ollamaApiOptionsCtxNum), // User setting
    },
  };
}
```

**LM Studio:**
```typescript
getModel(): { id: string; info: ModelInfo } {
  const info = { ...openAiModelInfoSaneDefaults }; // Default: 128_000
  const maxTokens = Number(this.options.lmStudioMaxTokens);
  if (!Number.isNaN(maxTokens)) {
    info.contextWindow = maxTokens; // User-provided override
  }
  return { id: this.options.lmStudioModelId || "", info };
}
```

**Sane defaults** when no user configuration is provided:
```typescript
export const openAiModelInfoSaneDefaults: OpenAiCompatibleModelInfo = {
  maxTokens: -1,
  contextWindow: 128_000,  // Conservative default for unknown models
  supportsImages: true,
  supportsPromptCache: false,
  inputPrice: 0,
  outputPrice: 0,
};
```

### 5e. How Context Window Sizes Are Used

Cline uses context window sizes for several critical functions:

1. **Context truncation:** When token usage approaches the context window, Cline truncates conversation history (`context-window-utils.ts`):
   ```typescript
   export function getContextWindowInfo(api: ApiHandler) {
     let contextWindow = api.getModel().info.contextWindow || 128_000;
     let maxAllowedSize: number;
     switch (contextWindow) {
       case 64_000:  maxAllowedSize = contextWindow - 27_000; break;
       case 128_000: maxAllowedSize = contextWindow - 30_000; break;
       case 200_000: maxAllowedSize = contextWindow - 40_000; break;
       default:      maxAllowedSize = Math.max(contextWindow - 40_000, contextWindow * 0.8); break;
     }
     return { contextWindow, maxAllowedSize };
   }
   ```

2. **Auto-condensation:** Triggers context summarization when usage exceeds a threshold (e.g., 75% of context window).

3. **Usage display:** Shows `"X / YK tokens used (Z%)"` in the UI.

4. **Error detection:** Detects context window exceeded errors from API responses.

### 5f. Key Takeaways for Notor

1. **Hardcoded static tables are the industry-standard approach.** Cline — a major, widely-used AI tool — uses this exact pattern for all direct API providers. No dynamic fetching of context window sizes from OpenAI, Anthropic, or Bedrock APIs.

2. **The static table approach works well in practice.** Context windows change infrequently (typically only when new model versions are released), so staleness is manageable.

3. **Graceful degradation is essential.** Unknown models fall back to sane defaults (128k context window). The system continues to work even with missing metadata.

4. **User-provided values for local models.** Local providers cannot report context window sizes, so a settings field (with a sensible default) is the correct approach.

5. **Keep metadata in a data file, not scattered across code.** Cline keeps all model metadata centralized in `shared/api.ts`, making updates straightforward.

6. **Prices are stored per million tokens** (not per 1K as in our current `ModelInfo`). This is Cline's convention; we should pick one and be consistent.

---

## 6. Cross-Provider Analysis

### 6a. Unified Model Representation

Based on our `ModelInfo` interface from [llm-provider.md](../../specs/01-mvp/contracts/llm-provider.md):

```typescript
interface ModelInfo {
  id: string;
  display_name: string;
  context_window: number | null;
  input_price_per_1k: number | null;
  output_price_per_1k: number | null;
  provider: string | null;
}
```

**Field mapping by provider:**

| ModelInfo Field | OpenAI | Anthropic | Bedrock (Inference Profiles) | Local |
|---|---|---|---|---|
| `id` | `data[].id` | `data[].id` | `inferenceProfileSummaries[].inferenceProfileId` | `data[].id` |
| `display_name` | `data[].id` (no display name) | `data[].display_name` | `inferenceProfileSummaries[].inferenceProfileName` | `data[].id` (no display name) |
| `context_window` | ❌ Not available | ❌ Not available | ❌ Not available | ❌ Not available |
| `input_price_per_1k` | ❌ Not available | ❌ Not available | ❌ Not available | N/A (free) |
| `output_price_per_1k` | ❌ Not available | ❌ Not available | ❌ Not available | N/A (free) |
| `provider` | `"openai"` (hardcoded) | `"anthropic"` (hardcoded) | derived from `inferenceProfileId` prefix | `"local"` (hardcoded) |

**Deriving `provider` from a Bedrock inference profile ID:**

The `inferenceProfileId` encodes both the geographic scope and the provider in its structure: `{geo}.{provider}.{model-name}-{version}`. For example:
- `us.anthropic.claude-sonnet-4-20250514-v1:0` → provider `"Anthropic"`
- `us.amazon.nova-pro-v1:0` → provider `"Amazon"`
- `us.meta.llama4-maverick-17b-instruct-v1:0` → provider `"Meta"`

Extract the provider segment by splitting on `.` and capitalizing the second element.

### 6b. Supplementary Metadata Table

Since **no provider returns context window or pricing** in their list API, Notor must maintain a built-in metadata lookup table for well-known models:

```typescript
const MODEL_METADATA: Record<string, { context_window?: number; input_price_per_1k?: number; output_price_per_1k?: number }> = {
  // OpenAI
  "gpt-4o": { context_window: 128000, input_price_per_1k: 0.0025, output_price_per_1k: 0.01 },
  "gpt-4o-mini": { context_window: 128000, input_price_per_1k: 0.00015, output_price_per_1k: 0.0006 },
  "o3": { context_window: 200000, input_price_per_1k: 0.01, output_price_per_1k: 0.04 },
  "o3-mini": { context_window: 200000, input_price_per_1k: 0.0011, output_price_per_1k: 0.0044 },
  "o4-mini": { context_window: 200000, input_price_per_1k: 0.0011, output_price_per_1k: 0.0044 },

  // Anthropic
  "claude-opus-4-6": { context_window: 200000, input_price_per_1k: 0.015, output_price_per_1k: 0.075 },
  "claude-sonnet-4-6": { context_window: 200000, input_price_per_1k: 0.003, output_price_per_1k: 0.015 },
  "claude-sonnet-4-5-20250929": { context_window: 200000, input_price_per_1k: 0.003, output_price_per_1k: 0.015 },
  "claude-sonnet-4-20250514": { context_window: 200000, input_price_per_1k: 0.003, output_price_per_1k: 0.015 },
  "claude-haiku-4-5-20251001": { context_window: 200000, input_price_per_1k: 0.0008, output_price_per_1k: 0.004 },

  // Bedrock — inference profile IDs (geographic prefix + bare model ID)
  // US profiles
  "us.anthropic.claude-opus-4-6-v1": { context_window: 200000, input_price_per_1k: 0.015, output_price_per_1k: 0.075 },
  "us.anthropic.claude-sonnet-4-6": { context_window: 200000, input_price_per_1k: 0.003, output_price_per_1k: 0.015 },
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": { context_window: 200000, input_price_per_1k: 0.003, output_price_per_1k: 0.015 },
  "us.anthropic.claude-sonnet-4-20250514-v1:0": { context_window: 200000, input_price_per_1k: 0.003, output_price_per_1k: 0.015 },
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": { context_window: 200000, input_price_per_1k: 0.0008, output_price_per_1k: 0.004 },
  "us.amazon.nova-premier-v1:0": { context_window: 1000000, input_price_per_1k: 0.0025, output_price_per_1k: 0.0125 },
  "us.amazon.nova-pro-v1:0": { context_window: 300000, input_price_per_1k: 0.0008, output_price_per_1k: 0.0032 },
  // Global profiles
  "global.anthropic.claude-opus-4-6-v1": { context_window: 200000, input_price_per_1k: 0.015, output_price_per_1k: 0.075 },
  "global.anthropic.claude-sonnet-4-6": { context_window: 200000, input_price_per_1k: 0.003, output_price_per_1k: 0.015 },
};
```

**Key design decisions:**

1. **Lookup by exact inference profile ID** — the table maps provider-specific inference profile IDs to metadata. EU and APAC variants of the same model share the same pricing but must be keyed separately if needed (or strip the geographic prefix for lookup).
2. **Graceful degradation** — unknown models display `null` for context window and pricing (the UI shows "Unknown" or omits the field).
3. **Updatable without code changes** — this table should be defined as a data file (JSON or TypeScript const) that can be updated in plugin releases without changing logic.
4. **Pricing is approximate** — prices change; this is for informational display only, not billing.

### 6c. Client-Side Filtering Strategy

Each provider needs different filtering to show only chat-capable models:

| Provider | Filtering Approach |
|---|---|
| **OpenAI** | Client-side: filter by model ID prefix (`gpt-`, `o1-`, `o3-`, `o4-`, `chatgpt-`) or maintain an allowlist |
| **Anthropic** | No filtering needed — all models returned are chat-capable |
| **Bedrock** | Client-side: exclude non-chat providers by ID pattern (stability, twelvelabs, cohere.embed); filter `status === "ACTIVE"` |
| **Local** | No filtering needed — all local models are usable for chat |

### 6d. Caching Strategy

**Recommended approach:**

| Aspect | Recommendation |
|---|---|
| **Cache duration** | 5 minutes (300 seconds) |
| **Cache invalidation** | On provider credential change, on explicit user refresh, on settings tab open |
| **Cache storage** | In-memory (plugin instance variable) — no need to persist across restarts |
| **Stale-while-revalidate** | Show cached data immediately, refresh in background |

**Rationale:**
- Model lists change infrequently (new models are released every few weeks at most).
- 5-minute cache prevents excessive API calls while keeping the list reasonably fresh.
- Refreshing on settings tab open ensures users see current models when configuring.
- In-memory cache is sufficient — fetching on plugin load is fast enough.

**Implementation sketch:**

```typescript
interface ModelListCache {
  models: ModelInfo[];
  fetchedAt: number; // Date.now()
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

class CachedModelFetcher {
  private cache: ModelListCache | null = null;

  async getModels(provider: LLMProvider, forceRefresh = false): Promise<ModelInfo[]> {
    if (!forceRefresh && this.cache && (Date.now() - this.cache.fetchedAt) < CACHE_TTL_MS) {
      return this.cache.models;
    }
    try {
      const models = await provider.listModels();
      this.cache = { models, fetchedAt: Date.now() };
      return models;
    } catch (error) {
      // Return stale cache if available, otherwise throw
      if (this.cache) return this.cache.models;
      throw error;
    }
  }
}
```

### 6e. Fallback Behavior

When model list fetch fails, per FR-3:

| Scenario | UI Behavior |
|---|---|
| API key invalid / missing | Show free-text input with placeholder: `"Enter model ID (e.g., gpt-4o)"` |
| Network error / timeout | Show free-text input; display warning: "Could not fetch model list" |
| Rate limited | Show free-text input; retry after backoff |
| Empty model list | Show free-text input with provider-specific hint |
| Stale cache available | Show cached dropdown + background refresh |

**Free-text fallback details:**
- Replace the dropdown with a text input field.
- Show provider-specific placeholder text (e.g., `"gpt-4o"` for OpenAI, `"claude-sonnet-4-5-20250929"` for Anthropic, `"us.anthropic.claude-sonnet-4-20250514-v1:0"` for Bedrock).
- Validate the entered model ID is non-empty before saving.
- Optionally show a "Retry" button to re-attempt model list fetch.

### 6f. Model Switching Mid-Conversation

- **Yes, the model can be changed mid-conversation** without issues from an API perspective — each `sendMessage` call includes the `model` parameter independently.
- The conversation history format is compatible across models within the same provider.
- **Switching providers mid-conversation is also technically possible** but may produce inconsistent results since different providers have different context handling.
- The UI should allow model changes at any time; the provider implementation handles the model parameter per-request.

---

## 7. Recommendations

### Implementation Approach

1. **Use each provider's official list endpoint** for model discovery:
   - OpenAI: `GET /v1/models`
   - Anthropic: `GET /v1/models` with pagination
   - Bedrock: `ListInferenceProfilesCommand` with `typeEquals: "SYSTEM_DEFINED"` (replaces `ListFoundationModelsCommand`)
   - Local: `GET {base_url}/v1/models`

2. **Maintain a static metadata table** for context window sizes and pricing, keyed by model ID. This is the only practical way to provide this information since no provider includes it in their list API.

3. **Apply client-side filtering** per provider to show only chat-relevant models in the dropdown.

4. **Cache model lists in memory** with a 5-minute TTL and stale-while-revalidate pattern.

5. **Fall back to free-text input** when fetching fails, with provider-specific placeholder text.

### Provider-Specific Implementation Notes

| Provider | Notes |
|---|---|
| **OpenAI** | Simplest implementation. No pagination needed. Must filter aggressively (returns 100+ models including embeddings, whisper, dall-e, etc.). |
| **Anthropic** | Must implement cursor-based pagination (`after_id` / `has_more`). Provides `display_name`. Relatively small model list. |
| **Bedrock** | Uses AWS SDK (not HTTP fetch). Use `ListInferenceProfilesCommand` with `typeEquals: "SYSTEM_DEFINED"`. Returns `inferenceProfileId` as the model ID (use directly in Converse API). Must update IAM policy to include `bedrock:ListInferenceProfiles`. Client-side filter for chat models. |
| **Local** | Must handle connection failures gracefully (server not running). No pagination or auth needed. Simplest error path. |

### Risks and Limitations

1. **Metadata staleness:** The supplementary metadata table will need updating as providers release new models and change pricing. Mitigated by: graceful degradation (showing "Unknown" for missing metadata) and periodic updates via plugin releases.

2. **OpenAI model filtering:** Without capability flags, the prefix-based filter may include non-chat models or miss new chat models. Mitigated by: maintaining a regularly updated allowlist or using generous prefix matching.

3. **Bedrock model coverage with inference profiles:** `ListInferenceProfiles` returns system-defined profiles relevant to the user's configured region. A user in the EU region will see `eu.*` and `global.*` profiles but not `us.*` profiles — this is correct behavior. Users in AP regions see a smaller profile set. The static metadata table must cover all geographic variants. Mitigated by: keying metadata by the geographic-prefixed ID, and ensuring the table covers `us.`, `eu.`, `apac.`, and `global.` variants of popular models.

4. **Local server availability:** Local servers may not be running when the user opens settings. Mitigated by: connection timeout (3-5 seconds), clear error message, and free-text fallback.

---

## 8. References

- [OpenAI — List Models](https://developers.openai.com/api/reference/resources/models/methods/list/)
- [Anthropic — List Models](https://platform.claude.com/docs/en/api/models/list)
- [Anthropic — Get a Model](https://platform.claude.com/docs/en/api/models/get)
- [AWS Bedrock — ListInferenceProfiles](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListInferenceProfiles.html)
- [AWS Bedrock — Cross-region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)
- [AWS Bedrock — ListFoundationModels (deprecated for this use case)](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html)
- [Ollama — API Documentation](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [LM Studio — OpenAI Compatibility](https://lmstudio.ai/docs)
