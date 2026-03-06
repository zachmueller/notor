# LLM Provider Interface Contract

**Created:** 2026-06-03
**Plan:** [specs/01-mvp/plan.md](../plan.md)

Defines the provider-agnostic interface that all LLM integrations must implement.

---

## LLMProvider Interface

```typescript
interface LLMProvider {
  /**
   * Send a message to the LLM and receive a streaming response.
   *
   * @param messages - Ordered array of conversation messages
   * @param tools - Available tool definitions for the LLM to call
   * @param options - Provider-specific and general options
   * @returns Async iterable of response chunks
   */
  sendMessage(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: SendMessageOptions
  ): AsyncIterable<StreamChunk>;

  /**
   * Fetch the list of available models from this provider.
   *
   * @returns Array of model info objects, or empty array if unavailable
   * @throws ProviderError if credentials are invalid or provider is unreachable
   */
  listModels(): Promise<ModelInfo[]>;

  /**
   * Estimate the token count for a given text string.
   * Used for context window tracking and cost estimation.
   *
   * @param text - The text to count tokens for
   * @returns Estimated token count
   */
  getTokenCount(text: string): number;

  /**
   * Whether this provider natively supports streaming responses.
   * If false, the provider implementation must use a buffering adapter
   * that simulates the streaming interface.
   */
  supportsStreaming(): boolean;

  /**
   * Validate that the provider's credentials and configuration are correct.
   * Used for settings validation and connection testing.
   *
   * @returns True if the provider is reachable and credentials are valid
   * @throws ProviderError with descriptive message on failure
   */
  validateConnection(): Promise<boolean>;
}
```

---

## Supporting Types

### ChatMessage

```typescript
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  tool_call?: {
    id: string;
    tool_name: string;
    parameters: Record<string, unknown>;
  };
  tool_result?: {
    tool_call_id: string;
    tool_name: string;
    result: string;
    is_error: boolean;
  };
}
```

### ToolDefinition

Tool definitions follow the OpenAI-style function calling schema, which is compatible across providers (with adaptation for Anthropic and Bedrock formats).

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JSONSchema;
}
```

### SendMessageOptions

```typescript
interface SendMessageOptions {
  model: string;
  max_tokens?: number;
  temperature?: number;
  stop_sequences?: string[];
  /** Signal for aborting the request (e.g., user clicks Stop) */
  abort_signal?: AbortSignal;
}
```

### StreamChunk

```typescript
type StreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; tool_name: string }
  | { type: "tool_call_delta"; id: string; partial_json: string }
  | { type: "tool_call_end"; id: string }
  | { type: "message_end"; input_tokens: number; output_tokens: number }
  | { type: "error"; error: string };
```

### ModelInfo

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

### ProviderError

```typescript
class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly code: ProviderErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

type ProviderErrorCode =
  | "AUTH_FAILED"
  | "CONNECTION_FAILED"
  | "RATE_LIMITED"
  | "MODEL_NOT_FOUND"
  | "INVALID_REQUEST"
  | "CONTEXT_LENGTH_EXCEEDED"
  | "PROVIDER_ERROR"
  | "UNKNOWN";
```

---

## Provider-Specific Mapping

### Local OpenAI-Compatible

| Interface Method | HTTP Implementation |
|---|---|
| `sendMessage` | `POST {endpoint}/chat/completions` with `stream: true` |
| `listModels` | `GET {endpoint}/models` |
| `getTokenCount` | Tiktoken estimation (bundled) or provider-reported usage |
| `supportsStreaming` | `true` |
| `validateConnection` | `GET {endpoint}/models` (checks connectivity + auth) |

**Stream format:** SSE with `data: {"choices":[{"delta":{"content":"..."}}]}` chunks.

### Anthropic API

| Interface Method | HTTP Implementation |
|---|---|
| `sendMessage` | `POST https://api.anthropic.com/v1/messages` with `stream: true` |
| `listModels` | `GET https://api.anthropic.com/v1/models` (if available; see R-4 research) |
| `getTokenCount` | Anthropic-reported usage from response |
| `supportsStreaming` | `true` |
| `validateConnection` | Lightweight `listModels` or minimal `sendMessage` call |

**Headers:** `x-api-key`, `anthropic-version`, `content-type: application/json`

**Stream format:** SSE with Anthropic event types (`message_start`, `content_block_delta`, `message_delta`, `message_stop`).

**Tool calling format:** Anthropic uses its own tool calling format in the messages API. The provider implementation must translate between Notor's `ToolDefinition` format and Anthropic's `tools` parameter format.

### OpenAI API

| Interface Method | HTTP Implementation |
|---|---|
| `sendMessage` | `POST https://api.openai.com/v1/chat/completions` with `stream: true` |
| `listModels` | `GET https://api.openai.com/v1/models` |
| `getTokenCount` | Tiktoken estimation or API-reported usage |
| `supportsStreaming` | `true` |
| `validateConnection` | `GET https://api.openai.com/v1/models` |

**Headers:** `Authorization: Bearer {api_key}`, `content-type: application/json`

**Stream format:** SSE with `data: {"choices":[{"delta":{"content":"..."}}]}` chunks.

### AWS Bedrock

| Interface Method | SDK Implementation |
|---|---|
| `sendMessage` | `InvokeModelWithResponseStream` via `@aws-sdk/client-bedrock-runtime` |
| `listModels` | `ListFoundationModels` via `@aws-sdk/client-bedrock` |
| `getTokenCount` | Model-reported usage from response |
| `supportsStreaming` | `true` |
| `validateConnection` | `ListFoundationModels` call (checks credentials + permissions) |

**Authentication:** AWS SDK credential chain — either named profile (`fromIni({ profile })`) or direct keys (`fromCredentials({ accessKeyId, secretAccessKey })`).

**Request format:** Bedrock uses the Converse API or model-specific request formats. The provider implementation must translate Notor's message format to the Bedrock request format.

---

## Error Handling Contract

All providers must follow these error handling conventions:

1. **Authentication failures** → throw `ProviderError` with code `AUTH_FAILED` and user-friendly message (e.g., "Invalid API key for Anthropic. Check your credentials in Settings → Notor.")
2. **Connection failures** → throw `ProviderError` with code `CONNECTION_FAILED` (e.g., "Could not connect to local LLM at http://localhost:11434. Is the server running?")
3. **Rate limiting** → throw `ProviderError` with code `RATE_LIMITED` including retry-after information if available
4. **Context length exceeded** → throw `ProviderError` with code `CONTEXT_LENGTH_EXCEEDED` so the chat system can trigger truncation
5. **Stream interruption** → yield a `StreamChunk` with `type: "error"` and then terminate the async iterable
6. **User cancellation** → respect `abort_signal`; terminate the stream cleanly without throwing

---

## Buffering Adapter

For providers that don't natively support streaming, a `BufferingAdapter` wraps the non-streaming response and yields it as simulated `StreamChunk` events:

```typescript
async function* bufferToStream(
  response: Promise<{ content: string; input_tokens: number; output_tokens: number }>
): AsyncIterable<StreamChunk> {
  const result = await response;
  // Yield the full content as a single text delta
  yield { type: "text_delta", text: result.content };
  yield { type: "message_end", input_tokens: result.input_tokens, output_tokens: result.output_tokens };
}
```

This ensures the chat UI always consumes the same `AsyncIterable<StreamChunk>` interface regardless of provider capabilities.