# Research: LLM Provider Model List APIs

**Research Task:** R-4
**Status:** Complete (2026-06-03)
**Blocks:** Phase 0 (model selection — FR-3)
**Plan:** [specs/01-mvp/plan.md](../../specs/01-mvp/plan.md)
**Contract:** [specs/01-mvp/contracts/llm-provider.md](../../specs/01-mvp/contracts/llm-provider.md)

---

## Summary

All four supported providers (OpenAI, Anthropic, AWS Bedrock, local OpenAI-compatible) expose model list APIs. However, the metadata available per model varies significantly — none of the cloud APIs return context window size or pricing in their list endpoints. Notor must maintain a supplementary metadata table for context window and pricing information, keyed by model ID.

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

## 3. AWS Bedrock

### SDK Call

```typescript
import { BedrockClient, ListFoundationModelsCommand } from "@aws-sdk/client-bedrock";

const client = new BedrockClient({ region: "us-east-1" });
const response = await client.send(new ListFoundationModelsCommand({
  byOutputModality: "TEXT",
  byInferenceType: "ON_DEMAND"
}));
```

### HTTP Equivalent

```
GET /foundation-models?byOutputModality=TEXT&byInferenceType=ON_DEMAND
```

### Authentication

- **AWS SDK credential chain:** Named profile (`fromIni({ profile })`), environment variables, direct keys (`fromCredentials({ accessKeyId, secretAccessKey })`), or instance role.
- **Required IAM permission:** `bedrock:ListFoundationModels`
- This is a **read-only** permission — separate from `bedrock:InvokeModel` which is needed to actually use models.

### Request — URI Filter Parameters

| Parameter | Type | Valid Values | Description |
|---|---|---|---|
| `byCustomizationType` | string | `FINE_TUNING`, `CONTINUED_PRE_TRAINING`, `DISTILLATION` | Filter by customization support |
| `byInferenceType` | string | `ON_DEMAND`, `PROVISIONED` | Filter by inference type |
| `byOutputModality` | string | `TEXT`, `IMAGE`, `EMBEDDING` | Filter by output type |
| `byProvider` | string | Pattern: `[A-Za-z0-9- ]{1,63}` | Filter by model provider (e.g., `"Anthropic"`, `"Amazon"`, `"Meta"`) |

### Response Format

```json
{
  "modelSummaries": [
    {
      "modelId": "anthropic.claude-sonnet-4-20250514-v1:0",
      "modelName": "Claude Sonnet 4",
      "modelArn": "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0",
      "providerName": "Anthropic",
      "inputModalities": ["TEXT", "IMAGE"],
      "outputModalities": ["TEXT"],
      "responseStreamingSupported": true,
      "customizationsSupported": [],
      "inferenceTypesSupported": ["ON_DEMAND"],
      "modelLifecycle": {
        "status": "ACTIVE"
      }
    },
    {
      "modelId": "amazon.nova-pro-v1:0",
      "modelName": "Amazon Nova Pro",
      "modelArn": "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0",
      "providerName": "Amazon",
      "inputModalities": ["TEXT", "IMAGE"],
      "outputModalities": ["TEXT"],
      "responseStreamingSupported": true,
      "customizationsSupported": ["FINE_TUNING"],
      "inferenceTypesSupported": ["ON_DEMAND"],
      "modelLifecycle": {
        "status": "ACTIVE"
      }
    }
  ]
}
```

### Response Fields (per `FoundationModelSummary`)

| Field | Type | Description |
|---|---|---|
| `modelId` | string | Model identifier for API calls (e.g., `anthropic.claude-sonnet-4-20250514-v1:0`) |
| `modelName` | string | Human-readable model name (e.g., `"Claude Sonnet 4"`) |
| `modelArn` | string | ARN for IAM policy references |
| `providerName` | string | Model provider name (e.g., `"Anthropic"`, `"Amazon"`, `"Meta"`) |
| `inputModalities` | string[] | Supported input types: `TEXT`, `IMAGE` |
| `outputModalities` | string[] | Supported output types: `TEXT`, `IMAGE`, `EMBEDDING` |
| `responseStreamingSupported` | boolean | Whether the model supports streaming responses |
| `customizationsSupported` | string[] | Supported customization types |
| `inferenceTypesSupported` | string[] | `ON_DEMAND`, `PROVISIONED` |
| `modelLifecycle.status` | string | Lifecycle status: `ACTIVE`, `LEGACY` |

### Errors

| Error | HTTP Code | Description |
|---|---|---|
| `AccessDeniedException` | 403 | Missing IAM permissions |
| `ThrottlingException` | 429 | Rate limit exceeded |
| `ValidationException` | 400 | Invalid filter parameters |
| `InternalServerException` | 500 | AWS service error |

### Region Dependency

- **Model availability varies by AWS region.** The list is region-specific.
- The query is made against the region configured on the Bedrock client.
- For Notor, we query the user's configured region. If the user wants models from multiple regions, they would need to configure separate provider entries.

### Model Access vs. Model Availability

- **`ListFoundationModels` returns all foundation models available in the region**, including models the user has NOT explicitly enabled/subscribed to.
- To check which models the user has actually enabled, a separate `ListModelAccess` or similar call would be needed. However, for the dropdown this distinction is less critical — if the user selects a model they haven't enabled, the `InvokeModel` call will fail with a clear error, which we can surface.

### Cross-Region Inference

- Cross-region inference profiles use different model IDs (inference profile ARNs).
- For MVP, we do not need to handle cross-region inference — users should configure the region where their models are accessible.

### Notable Characteristics

- **Richest metadata** of all providers: model name, provider, modalities, streaming support, lifecycle status.
- **Server-side filtering** by output modality and provider — can filter to `TEXT` output models only.
- **No context window size** in response.
- **No pricing information** in response.
- **`modelLifecycle.status`** allows filtering out `LEGACY` models.

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

## 5. Cross-Provider Analysis

### 5a. Unified Model Representation

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

| ModelInfo Field | OpenAI | Anthropic | Bedrock | Local |
|---|---|---|---|---|
| `id` | `data[].id` | `data[].id` | `modelSummaries[].modelId` | `data[].id` |
| `display_name` | `data[].id` (no display name) | `data[].display_name` | `modelSummaries[].modelName` | `data[].id` (no display name) |
| `context_window` | ❌ Not available | ❌ Not available | ❌ Not available | ❌ Not available |
| `input_price_per_1k` | ❌ Not available | ❌ Not available | ❌ Not available | N/A (free) |
| `output_price_per_1k` | ❌ Not available | ❌ Not available | ❌ Not available | N/A (free) |
| `provider` | `"openai"` (hardcoded) | `"anthropic"` (hardcoded) | `modelSummaries[].providerName` | `"local"` (hardcoded) |

### 5b. Supplementary Metadata Table

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
  "claude-sonnet-4-5-20250514": { context_window: 200000, input_price_per_1k: 0.003, output_price_per_1k: 0.015 },
  "claude-sonnet-4-20250514": { context_window: 200000, input_price_per_1k: 0.003, output_price_per_1k: 0.015 },
  "claude-haiku-3-5-20241022": { context_window: 200000, input_price_per_1k: 0.0008, output_price_per_1k: 0.004 },

  // Bedrock (Anthropic models have different IDs on Bedrock)
  "anthropic.claude-sonnet-4-20250514-v1:0": { context_window: 200000, input_price_per_1k: 0.003, output_price_per_1k: 0.015 },
  "amazon.nova-pro-v1:0": { context_window: 300000, input_price_per_1k: 0.0008, output_price_per_1k: 0.0032 },
};
```

**Key design decisions:**

1. **Lookup by exact model ID** — the table maps provider-specific model IDs to metadata.
2. **Graceful degradation** — unknown models display `null` for context window and pricing (the UI shows "Unknown" or omits the field).
3. **Updatable without code changes** — this table should be defined as a data file (JSON or TypeScript const) that can be updated in plugin releases without changing logic.
4. **Pricing is approximate** — prices change; this is for informational display only, not billing.

### 5c. Client-Side Filtering Strategy

Each provider needs different filtering to show only chat-capable models:

| Provider | Filtering Approach |
|---|---|
| **OpenAI** | Client-side: filter by model ID prefix (`gpt-`, `o1-`, `o3-`, `o4-`, `chatgpt-`) or maintain an allowlist |
| **Anthropic** | No filtering needed — all models returned are chat-capable |
| **Bedrock** | Server-side: use `byOutputModality=TEXT`; client-side: additionally filter out embedding-only models, filter `modelLifecycle.status === "ACTIVE"` |
| **Local** | No filtering needed — all local models are usable for chat |

### 5d. Caching Strategy

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

### 5e. Fallback Behavior

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
- Show provider-specific placeholder text (e.g., `"gpt-4o"` for OpenAI, `"claude-sonnet-4-5-20250514"` for Anthropic).
- Validate the entered model ID is non-empty before saving.
- Optionally show a "Retry" button to re-attempt model list fetch.

### 5f. Model Switching Mid-Conversation

- **Yes, the model can be changed mid-conversation** without issues from an API perspective — each `sendMessage` call includes the `model` parameter independently.
- The conversation history format is compatible across models within the same provider.
- **Switching providers mid-conversation is also technically possible** but may produce inconsistent results since different providers have different context handling.
- The UI should allow model changes at any time; the provider implementation handles the model parameter per-request.

---

## 6. Recommendations

### Implementation Approach

1. **Use each provider's official list endpoint** for model discovery:
   - OpenAI: `GET /v1/models`
   - Anthropic: `GET /v1/models` with pagination
   - Bedrock: `ListFoundationModelsCommand` with `byOutputModality=TEXT`
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
| **Bedrock** | Uses AWS SDK (not HTTP fetch). Server-side filtering available. Returns `providerName` which is useful for display. Must handle different model ID format. |
| **Local** | Must handle connection failures gracefully (server not running). No pagination or auth needed. Simplest error path. |

### Risks and Limitations

1. **Metadata staleness:** The supplementary metadata table will need updating as providers release new models and change pricing. Mitigated by: graceful degradation (showing "Unknown" for missing metadata) and periodic updates via plugin releases.

2. **OpenAI model filtering:** Without capability flags, the prefix-based filter may include non-chat models or miss new chat models. Mitigated by: maintaining a regularly updated allowlist or using generous prefix matching.

3. **Bedrock model access:** `ListFoundationModels` returns models the user may not have enabled. Users may select a model and get an access error on first use. Mitigated by: clear error messages directing users to enable the model in the AWS console.

4. **Local server availability:** Local servers may not be running when the user opens settings. Mitigated by: connection timeout (3-5 seconds), clear error message, and free-text fallback.

---

## 7. References

- [OpenAI — List Models](https://developers.openai.com/api/reference/resources/models/methods/list/)
- [Anthropic — List Models](https://platform.claude.com/docs/en/api/models/list)
- [Anthropic — Get a Model](https://platform.claude.com/docs/en/api/models/get)
- [AWS Bedrock — ListFoundationModels](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html)
- [Ollama — API Documentation](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [LM Studio — OpenAI Compatibility](https://lmstudio.ai/docs)