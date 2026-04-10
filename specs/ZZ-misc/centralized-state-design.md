# Centralized Orchestrator State — Design Spec

**Status:** Design phase (skeleton)
**Date:** 2026-04-11
**Prerequisite:** [Phase B: Orchestrator Decomposition](multi-conversation-robustness-implementation-tasks.md) must be complete before this spec can be finalized. The decomposition settles which extracted class owns which state, determining what goes into the centralized store.

---

## 1. Motivation

After Phase B decomposes `ChatOrchestrator` into focused classes (ViewRouter, SessionManager, ConversationLifecycleManager, ConfigResolver, WorkflowExecutor, CompactionManager, MessagePipeline, HookDispatcher), state synchronization between these classes and the view layer relies on ad-hoc callback wiring. The 23+ `setOn*` callbacks in `wireView()` and the 20+ imperative view method calls in the response loop create a fragile coupling surface where adding new state requires threading through multiple layers.

A centralized state pattern could replace some of this with a single source of truth per orchestrator, with reactive subscriptions for state consumers.

---

## 2. Initial Sketch

### 2.1 State Interface

```typescript
interface OrchestratorState {
    displayedConversation: Conversation | null;
    messages: Message[];
    isResponding: boolean;
    activeSessions: Map<string, ConversationSession>;
    effectiveConfig: EffectiveToolConfig | null;
    parsedConfigs: ParsedToolConfig[];
}
```

### 2.2 Store Implementation

```typescript
class StateStore {
    private state: OrchestratorState;
    private subscribers = new Set<(state: OrchestratorState) => void>();

    update(patch: Partial<OrchestratorState>): void {
        this.state = { ...this.state, ...patch };
        for (const sub of this.subscribers) sub(this.state);
    }

    subscribe(fn: (state: OrchestratorState) => void): () => void {
        this.subscribers.add(fn);
        return () => this.subscribers.delete(fn);
    }
}
```

### 2.3 Migration Path (High-Level)

1. Replace direct field mutations in extracted classes with `store.update()` calls
2. Replace callback registrations with `store.subscribe()` listeners
3. View layer subscribes to orchestrator's state store
4. Remove manual callback wiring from `wireView()`

---

## 3. Design Questions (Unresolved)

The following questions must be answered before this spec can produce implementation tasks. Most depend on Phase B outcomes.

### 3.1 Per-Session State vs. Display-Only State

The current architecture isolates mutable state into `ConversationSession` objects — each session has its own `ConversationManager`, `effectiveConfig`, `parsedConfigs`, pinned persona/provider/model. The orchestrator-level fields (`effectiveToolConfig`, `activeParsedConfigs`, `conversationManager`) are display-only copies that reflect whichever conversation is currently shown.

- Should the store track per-session state, or only the display state?
- If display-only: how do session completion events propagate to the store?
- If per-session: the store becomes a `Map<conversationId, SessionState>` plus a `displayedConversationId` — significantly more complex than a flat state object.

### 3.2 Imperative View Rendering vs. Reactive Subscriptions

The orchestrator calls ~20 distinct imperative DOM methods on `NotorChatView`:

- `createAssistantMessagePlaceholder()` — creates a DOM element for streaming
- `appendStreamChunk(contentEl, delta)` — appends text to a specific DOM element
- `finalizeAssistantMessage(contentEl, message)` — replaces placeholder with rendered markdown
- `renderToolCall(message)`, `renderToolResult(message)` — render tool UI
- `updateToolCallProgress(el, status)`, `updateToolCallStatus(el, status)` — update existing DOM elements
- `appendForkButton(el)` — adds fork button to a tool result element
- `clearMessages()` — clears the message container
- `showTruncationWarning(count)`, `showError(msg)` — display notifications
- `updateTokenFooter(input, output, cost?)` — update token display
- `updateModeDisplay(mode)`, `updatePersonaLabel(persona)` — update header displays
- `updateProviderDisplay(provider)`, `updateModelDisplay(model)` — update provider/model pickers
- `clearDisplayOverrides()` — clear per-conversation display overrides
- `setRespondingState(responding)` — toggle responding indicator
- `getMessagesContainer()` — returns DOM element for compaction UI

These are imperative DOM mutations that reference specific DOM elements (e.g., `contentEl` from `createAssistantMessagePlaceholder`). They cannot be expressed as state subscriptions without redesigning the view layer to use a virtual DOM or reconciliation approach.

- Which of these can realistically be replaced with state subscriptions?
- Which must remain imperative (streaming DOM updates, element-specific mutations)?
- Does this require a view layer rewrite, or can we incrementally adopt state subscriptions for a subset?

### 3.3 Bidirectional Callbacks

The 23 `setOn*` callbacks in `wireView()` are view-to-orchestrator event handlers (user actions like sending messages, switching conversations, toggling modes). They are not state reactions — they are command handlers.

- A reactive state store only addresses orchestrator-to-view state propagation, which is one direction
- The view-to-orchestrator direction (user actions → orchestrator methods) is a separate concern
- Should these remain as callbacks, or should there be a command/event bus?
- If callbacks remain, the store only eliminates half the wiring complexity

### 3.4 Batched Updates and Selective Subscription

A naive `update(patch)` → `notify all subscribers` pattern causes N subscriber notifications for N field changes in a single operation (e.g., `switchConversation` changes `displayedConversation`, `messages`, `effectiveConfig`, and `parsedConfigs` in quick succession).

- Should updates be batched? (e.g., `store.batch(() => { store.update({...}); store.update({...}); })` notifies once)
- Should subscriptions be selective? (e.g., `store.subscribe(['messages', 'isResponding'], fn)` only fires when those fields change)
- How do derived values work? (e.g., token count derived from messages)

### 3.5 Async State Transitions

Conversation switching involves multiple async steps (load JSONL, sync-back from session, re-render). During the transition, the state is partially updated.

- Should the store support async transitions with intermediate states?
- How should the view handle in-flight transitions? (Loading indicator? Optimistic updates?)
- How does abort/cancellation interact with state transitions?

### 3.6 Integration with Obsidian

Obsidian has its own event system (`workspace.on('active-leaf-change')`, `workspace.on('layout-change')`, etc.) and state management (`getState()`/`setState()` for view persistence).

- Should the state store integrate with Obsidian's events, or remain independent?
- How does `getState()` serialization work with the store? (Currently returns `{ conversationId }`)

---

## 4. Alternative Approaches

Before committing to a state store, consider whether a simpler pattern would suffice:

### 4.1 Event Bus

Replace the 23+ callbacks with a typed event bus:
```typescript
orchestrator.on('conversationChanged', (conv) => view.updateConversationDisplay(conv));
orchestrator.on('respondingStateChanged', (responding) => view.setRespondingState(responding));
```

This decouples without requiring full state centralization. The imperative DOM calls remain but are triggered by events rather than direct method calls.

### 4.2 Selective State + Imperative Commands

Keep imperative DOM mutations for streaming/rendering (they're inherently imperative), but use a state store for the "header" state that doesn't involve streaming:
- `displayedConversation`, `isResponding`, `activeProvider`, `activeModel`, `activePersona`, `mode`
- View subscribes to these; updates header/footer/picker UI reactively
- Streaming, tool rendering, compaction UI remain imperative

This is a smaller scope that delivers most of the benefit with less risk.

---

## 5. Next Steps

1. Complete Phase B — settle extraction boundaries and state ownership
2. Prototype the selective state approach (Section 4.2) on one or two fields
3. Evaluate whether the prototype reduces wiring complexity enough to justify full adoption
4. If yes: expand the spec with concrete implementation tasks
5. If no: consider the event bus alternative (Section 4.1)
