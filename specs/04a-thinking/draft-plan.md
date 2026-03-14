# LLM Extended Thinking / Reasoning Support

## Context

Many LLM providers (Anthropic Claude, OpenAI o-series, etc.) support a "thinking" or "extended reasoning" mode where the model performs internal chain-of-thought reasoning before writing its response. This can significantly improve quality on complex tasks at the cost of additional tokens and latency. Other tools like Cline expose this as a user-configurable setting. This feature adds the same capability to Notor in a way that fits the existing architecture.

## Approach

Two distinct thinking paradigms are supported:

- **Anthropic-style** (`thinking_budget_tokens`): sends `thinking: { type: "enabled", budget_tokens: N }` in the API body; the model streams back thinking content with a cryptographic `signature` that must be preserved for multi-turn correctness.
- **OpenAI-style** (`reasoning_effort`): sends `reasoning_effort: "low"|"medium"|"high"` for o-series models; reasoning is internal and not streamed.

Settings are stored **per-provider** in `LLMProviderConfig` (alongside the existing `model_id`), which is the natural fit since model selection is already per-provider. No global `NotorSettings` changes are needed.

---

## Files to Modify

### 1. `src/types.ts`

**`LLMProviderConfig`** — add two optional fields:

```typescript
/** Token budget for extended thinking (Anthropic/Bedrock Claude models). 0 or null = disabled. */
thinking_budget_tokens?: number | null;
/** Reasoning effort level for OpenAI o-series models. null = disabled. */
reasoning_effort?: "low" | "medium" | "high" | null;
```

**`Message`** — add one optional field for multi-turn thinking block preservation:

```typescript
/**
 * Thinking blocks returned by Anthropic extended reasoning.
 * Must be round-tripped back to the API verbatim (with signature) on subsequent turns.
 */
thinking_blocks?: Array<{ text: string; signature: string }> | null;
```

No `defaults.ts` changes needed — new optional fields default to `undefined` and old configs work without migration.

---

### 2. `src/providers/provider.ts`

**`SendMessageOptions`** — add two optional pass-through fields:

```typescript
thinking_budget_tokens?: number;
reasoning_effort?: "low" | "medium" | "high";
```

**`StreamChunk`** — add two new union members:

```typescript
| { type: "thinking_delta"; text: string }
| { type: "thinking_end"; signature: string }
```

**`ChatMessage`** — add thinking blocks for multi-turn round-trip:

```typescript
thinking_blocks?: Array<{ text: string; signature: string }> | null;
```

---

### 3. `src/providers/model-metadata.ts`

Add `supports_thinking`, `thinking_max_budget`, and `supports_reasoning_effort` fields to the internal `ModelMetadataEntry` type (not the exported `ModelInfo`). Mark the following Anthropic models:

| Model | `thinking_max_budget` |
|---|---|
| `claude-3-7-sonnet-20250219` | 80000 |
| `claude-sonnet-4-5-20250929` | 10000 |
| `claude-haiku-4-5-20251001` | 10000 |
| `claude-sonnet-4-6` | 16000 |
| `claude-opus-4-6` | 32000 |
| All Bedrock inference profile equivalents | same as above |

Mark `supports_reasoning_effort: true` on: `o1`, `o1-mini`, `o3`, `o3-mini`, `o4-mini`.

Export three new helper functions:

```typescript
export function supportsThinking(modelId: string): boolean
export function getThinkingMaxBudget(modelId: string): number  // returns 0 if not applicable
export function supportsReasoningEffort(modelId: string): boolean
```

These drive both the settings UI conditional rendering and the provider request logic.

---

### 4. `src/providers/anthropic-provider.ts`

**In `sendMessage()`** — add the thinking parameter to the request body (after existing optional params):

```typescript
if (options.thinking_budget_tokens) {
    body.thinking = { type: "enabled", budget_tokens: options.thinking_budget_tokens };
    body.temperature = 1;        // required by Anthropic when thinking is enabled
    body.max_tokens = Math.max(body.max_tokens ?? 4096, options.thinking_budget_tokens + 4096);
    delete body.stop_sequences;  // incompatible with thinking
}
```

**In `toAnthropicMessages()`** — handle assistant messages that carry thinking blocks (multi-turn replay):

```typescript
if (msg.thinking_blocks?.length) {
    const blocks = [
        ...msg.thinking_blocks.map(b => ({ type: "thinking", thinking: b.text, signature: b.signature })),
        { type: "text", text: msg.content },
    ];
    anthropicMessages.push({ role: "assistant", content: blocks });
} else {
    anthropicMessages.push({ role: "assistant", content: msg.content }); // existing path
}
```

**In the stream parser** — handle `thinking_delta` and `signature_delta` SSE events using local variables in the generator scope (not instance state, to be safe with concurrent background workflows):

- On `content_block_start` with `type: "thinking"`: record the block index, reset accumulators.
- On `content_block_delta` with `type: "thinking_delta"`: yield `{ type: "thinking_delta", text: delta.thinking }`.
- On `content_block_delta` with `type: "signature_delta"`: accumulate to `currentSignature`.
- On `content_block_stop` for a thinking block: yield `{ type: "thinking_end", signature: currentSignature }`.

---

### 5. `src/providers/openai-provider.ts`

**In `sendMessage()`** — add `reasoning_effort` and handle o-series incompatibilities:

```typescript
if (options.reasoning_effort) {
    body.reasoning_effort = options.reasoning_effort;
    delete body.temperature;           // o-series doesn't accept temperature
    if (body.max_tokens !== undefined) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
    }
}
```

No stream changes needed — OpenAI reasoning tokens are not surfaced in the response stream.

---

### 6. `src/providers/bedrock-provider.ts`

**In `sendMessage()`** — add thinking via `additionalModelRequestFields`:

```typescript
if (options.thinking_budget_tokens && supportsThinking(options.model)) {
    input.additionalModelRequestFields = {
        thinking: { type: "enabled", budget_tokens: options.thinking_budget_tokens },
    };
}
```

**In the stream handler** — handle `reasoningContent` blocks in `contentBlockDelta` events, yielding `thinking_delta` and `thinking_end` chunks using the same pattern as the Anthropic provider.

---

### 7. `src/chat/orchestrator.ts`

**In the response loop** (both the main loop and the background workflow loop — update both):

```typescript
const providerConfig = this.providerRegistry.getActiveConfig();
if (providerConfig?.thinking_budget_tokens) {
    options.thinking_budget_tokens = providerConfig.thinking_budget_tokens;
}
if (providerConfig?.reasoning_effort) {
    options.reasoning_effort = providerConfig.reasoning_effort;
}
```

**In `processStream()`** — accumulate thinking state and lazily create a UI element:

```typescript
let thinkingText = "";
let thinkingSignature = "";
let thinkingEl: HTMLElement | undefined;

// case "thinking_delta":
//   accumulate thinkingText
//   on first delta, create a <div class="notor-thinking-block"> on contentEl containing
//   a <details><summary>Thinking</summary><pre/></details>; update <pre> on each delta

// case "thinking_end":
//   thinkingSignature = chunk.signature
```

Return `thinkingBlocks` from `processStream()` and store on the persisted `Message`:

```typescript
thinking_blocks: thinkingSignature ? [{ text: thinkingText, signature: thinkingSignature }] : undefined
```

**In `toChatMessages()`** — propagate thinking blocks when converting `Message` → `ChatMessage`:

```typescript
// For assistant messages:
thinking_blocks: msg.thinking_blocks ?? undefined
```

---

### 8. Settings UI — `src/settings/sections/provider-anthropic.ts` (and `provider-bedrock.ts`)

After the existing model selector, conditionally render thinking controls when `provider.model_id` is set and `supportsThinking(provider.model_id)` returns `true`:

1. **Toggle** ("Extended thinking") — enables/disables; sets `thinking_budget_tokens` to `8000` (on) or `null` (off); calls `ctx.redisplay()` to show/hide the slider.
2. **Slider** (visible only when enabled) — range `1024` to `getThinkingMaxBudget(modelId)`, step `1024`, with dynamic tooltip.

When no model is selected yet, render a notice: *"Select a model to configure extended thinking."*

---

### 9. Settings UI — `src/settings/sections/provider-openai.ts` (and `provider-local.ts`)

After the existing model selector, conditionally render when `supportsReasoningEffort(provider.model_id)` returns `true`:

**Dropdown** ("Reasoning effort") — options: Disabled / Low / Medium / High. Sets `reasoning_effort` on the provider config or `null` when "Disabled".

---

### 10. `styles.css`

Add a `.notor-thinking-block` class to visually distinguish thinking from response content:

```css
.notor-thinking-block details summary {
    cursor: pointer;
    font-weight: 600;
    opacity: 0.7;
}
.notor-thinking-block pre {
    font-size: 0.8em;
    opacity: 0.6;
    white-space: pre-wrap;
}
```

---

## Key Pitfalls

1. **Temperature must be `1` when Anthropic thinking is enabled** — override any `options.temperature` value.
2. **`max_tokens` must exceed `budget_tokens`** — automatically set `max_tokens = budget_tokens + 4096`.
3. **Thinking blocks require signatures for multi-turn** — the `thinking_end` chunk carries the signature; store on `Message.thinking_blocks` and emit as content blocks in `toAnthropicMessages()` on subsequent turns.
4. **Both response loops need thinking options** — the main loop and background workflow loop both build `SendMessageOptions`; update both.
5. **`stop_sequences` is incompatible with Anthropic thinking** — remove from the request body when thinking is active.
6. **OpenAI o-series doesn't accept `temperature` or `max_tokens`** — use `max_completion_tokens` and omit `temperature` when `reasoning_effort` is set.

---

## Verification

1. Enable Anthropic provider, select a thinking-capable model (e.g. `claude-sonnet-4-6`), open settings — verify toggle and slider appear.
2. Enable thinking, send a complex message — verify a collapsed "Thinking" `<details>` block appears in the chat before the response.
3. Continue the conversation (second turn) — verify the LLM responds correctly (thinking blocks round-tripped without API error).
4. Switch to a non-thinking model — verify the thinking toggle disappears from settings.
5. Enable OpenAI provider, select `o3-mini`, open settings — verify "Reasoning effort" dropdown appears.
6. Run `npm run build` and verify no TypeScript errors.
