# Data Model: Orchestration Engine

**Created:** 2026-06-27
**Specification:** [spec.md](spec.md)
**Plan:** [plan.md](plan.md)
**Contracts:** [contracts/](contracts/)

This document is the authority for the **shapes** the implementation introduces. Interface *behavior*
lives in `contracts/`; this file defines the types and persisted entities. Where a type is the single
authority of another contract file, that is noted and the type is not redefined elsewhere.

---

## Run-Loop Substrate Types (design Phase 0)

Authority: [contracts/run-loop.md](contracts/run-loop.md). Module: `src/run-loop/types.ts`.

### RunContext

Carried as an optional field `runContext?` on `ToolExecuteOptions` (`src/tools/tool.ts`), assembled
once in `ToolDispatcher.dispatch()`. Mutable, cascading, tree-scoped — deliberately **not** merged
into `ToolSessionContext` (a stable per-dispatch read-accessor).

```typescript
interface RunContext {
  depth: number;               // current nesting depth (0 = top level)
  maxDepth: number;            // 0 for sub-agents (no nesting); N or Infinity for flows
  iterationsRemaining: number; // AGGREGATE tree-wide ceiling (Infinity for sub-agents); NOT the per-run cap
  costRemainingUsd: number;    // AGGREGATE tree-wide ceiling (Infinity for sub-agents)
  abort: AbortSignal;          // cascades from parent
}
```

- A child run inherits the parent's remaining budget and `depth + 1`.
- Spawning a child is gated on `depth < maxDepth` AND `iterationsRemaining > 0` AND
  `costRemainingUsd > 0`.
- Sub-agents seed `maxDepth = 0` and both budgets to `Infinity` → today's behavior, by construction.

### RunResult (always-both)

```typescript
interface RunResult {
  text: string;                       // always present (final/wind-down output)
  structured: unknown | null;         // optional; populated only by a terminal code step
  messages: ChatMessage[];
  tokenUsage: { input: number; output: number };
  iterationCount: number;
  stopReason: "completed" | "iteration_cap" | "token_limit" | "context_window" | "cost_cap" | "depth_cap";
}
```

`SubAgentResult` (`src/chat/sub-agent-runner.ts`, today `{ text, messages, tokenUsage,
iterationCount, stopReason }`) becomes a **strict subset** — `structured` is always null and the
`stopReason` union gains `cost_cap`/`depth_cap` (unreachable for sub-agents). Non-breaking.

### RunLoopOptions / RunLoopHooks

```typescript
interface RunLoopOptions {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  toolDefinitions: ToolDefinition[];
  dispatcher: ToolDispatcher;
  mode: ConversationMode;
  iterationCap?: number;        // per-run cap; default SUB_AGENT_ITERATION_CAP (20)
  tokenLimit?: number;          // per-run; default SUB_AGENT_TOKEN_LIMIT (0 = none)
  thinkingLevel?: ThinkingLevel | null;
  runContext: RunContext;       // depth + aggregate budget + abort
  hooks?: RunLoopHooks;
  onProgress?: (status: string) => void;
}

interface RunLoopHooks {
  onTurnStart?(turn: number): void | Promise<void>;
  onTurnComplete?(turn: number, result: TurnOutcome): void | Promise<void>;
  onPersist?(messages: ChatMessage[]): void | Promise<void>;  // orchestration attaches JSONL persistence
  onProgress?(status: string): void;
}
```

Hooks are how orchestration attaches per-step JSONL persistence, progress Notices, and navigation
**without** baking them into the engine. Keep this surface minimal (do not pull in
`ChatOrchestrator`'s compaction/context management).

---

## Orchestration Domain Types (design Phase 1)

Module: `src/orchestration/types.ts`.

### OrchestrationFlow

Parsed from `definition.md`. (Frontmatter schema: [contracts/vault-schema.md](contracts/vault-schema.md).)

```typescript
interface OrchestrationFlow {
  name: string;                 // notor-flow-name
  description: string;          // notor-flow-description
  flowDir: string;              // {notor_dir}/orchestrations/{flow-name}/
  startingEvent: string;        // notor-starting-event
  completionEvent: string;      // notor-completion-event (default FLOW_COMPLETE)
  maxIterations: number;        // notor-max-iterations
  maxRuntimeMinutes: number;    // notor-max-runtime-minutes
  requiredEvents: string[];     // notor-required-events
  steps: StepDefinition[];      // resolved from notor-steps wikilinks under steps/
  guardrails: string[];         // notor-guardrails (injected into every step prompt)
  // Composition (design Phase 7; inert unless feature group enabled):
  invocable: boolean;           // notor-flow-invocable (default false)
  flowInputs: string | null;    // notor-flow-inputs (freeform NL)
  flowReturns: string | null;   // notor-flow-returns (freeform NL)
  onCompleteFlow: string | null;// notor-on-complete-flow (chaining successor wikilink)
  handoffIsolation: "isolated" | "shared"; // notor-handoff-isolation (default isolated)
  maxDepth: number | null;      // notor-max-depth
  maxCostUsd: number | null;    // notor-max-cost-usd (aggregate)
}
```

### StepDefinition

Parsed from a step note. (Frontmatter schema: [contracts/vault-schema.md](contracts/vault-schema.md).)

```typescript
interface StepDefinition {
  name: string;                 // notor-step-name
  description: string;          // notor-step-description
  triggers: string[];           // notor-step-triggers
  publishes: string[];          // notor-step-publishes
  defaultPublishes: string | null; // notor-step-default-publishes
  persona: string | null;       // notor-step-persona
  model: string | null;         // notor-step-model (overrides persona model)
  mode: "conversation" | "code";// notor-step-mode (default conversation)
  mcpServers: string[] | null;  // notor-step-mcp-servers (null = inherit all)
  bodyContent: string;          // Markdown body (instructions) OR code fence (mode: code)
  notePath: string;
}
```

### OrchestrationEvent

```typescript
interface OrchestrationEvent {
  topic: string;
  payload: string;
  source_step: string | null;   // null for the starting event
  turn: number;
  ts: string;                    // ISO timestamp
}
```

### Terminal event constants

```typescript
const FLOW_COMPLETE = "FLOW_COMPLETE";    // terminal; subject to task enforcement (FR-123)
const FLOW_CANCELLED = "FLOW_CANCELLED";  // terminal; bypasses task enforcement (FR-132)
const FLOW_ERROR = "FLOW_ERROR";          // terminal; emitted by FallbackCoordinator on unrecoverable orphan
```

### CodeStepEvent / CodeStepResult / OrchestrationHelper

Authority: [contracts/orchestration-helper.md](contracts/orchestration-helper.md). Injected into code
steps as `event` and `orchestration`. Arg signature:
`CODE_STEP_ARG_NAMES = ["app", "obsidian", "utils", "libs", "event", "orchestration"]`.

---

## Persisted Vault Entities

Authority: [contracts/vault-schema.md](contracts/vault-schema.md). Summary of files written at runtime
under `{notor_dir}/orchestrations/sessions/{session-id}/`:

### session.json

```typescript
interface OrchestrationSessionMeta {
  session_id: string;
  flow_name: string;
  status: "active" | "interrupted" | "completed" | "cancelled" | "error";
  iteration: number;
  active_step: string | null;
  started_at: string;
  prompt: string;                       // original user objective
  parent_session_id: string | null;    // composition linkage (design Phase 7)
  origin: "user" | "run_flow" | "chaining" | null;
}
```

### session-log.jsonl (append-only; crash-recovery source)

Entry types and **enforced write order** in [contracts/vault-schema.md](contracts/vault-schema.md).
Entry `type ∈ { session.start, turn.start, turn.complete, event.emitted, session.cancelled,
session.complete, user.input.required, user.input.received }`.

### Task note (`tasks/{key}.md`)

```yaml
---
notor-type: orchestration-task
notor-task-status: open        # open | running | closed
notor-task-key: step-01-impl
notor-task-created: 2026-06-27T10:00:00Z
notor-task-started: null
notor-task-completed: null
---
```

### memories.md

A plain note at `{notor_dir}/orchestrations/memories.md` (Patterns / Decisions / Fixes / Context
sections). Free-form; not parsed structurally.

---

## Conversation Header Extensions

Authority: [contracts/edges.md](contracts/edges.md). Added to the JSONL conversation header for
orchestration step conversations (net-new — the `Conversation` type at `src/types.ts` has no
orchestration fields today):

```typescript
// Additive fields on the conversation header:
{
  _type: "conversation" | "orchestration_step_conversation";  // marker for hidden-from-list filter
  orchestration_session_id?: string;
  orchestration_flow_name?: string;
  orchestration_step_name?: string;
  orchestration_iteration?: number;
  orchestration_edges?: OrchestrationEdge[];
}

interface OrchestrationEdge {
  kind: "next" | "prev" | "child" | "parent";   // tree-constrained DAG; no cyclic/sibling/return edges
  conversation_id: string;
  session_id?: string;        // on child/parent edges crossing a flow boundary
  via_tool_call_id?: string;  // on child edges from a run_flow tool call
}
```

### child_run_metadata (shared rollup block)

Generalizes the existing `ToolResult.sub_agent_metadata` (`src/types.ts:270`). **Single authority:**
[contracts/edges.md](contracts/edges.md). Used by both `use_subagent` and `run_flow`; one rendering
path, one token-rollup path. Carries aggregate-subtree numbers for flows, single-run totals for
sub-agents. **Back-compat:** must keep `sub_agent_metadata`'s existing fields (`jsonl_filename`,
`token_usage`, `iteration_count`, `stop_reason`, `profile_name`) readable for persisted conversations.

---

## Settings

```typescript
// src/settings/types.ts — NotorSettings (additive, mirrors memory_enabled):
orchestration_enabled: boolean;   // default false (src/settings/defaults.ts)
```

Feature-group gating: add `orchestration: "orchestration_enabled"` to `FEATURE_GROUP_TOGGLES` in
`src/extensions/manager.ts`. All orchestration tool scaffolds set `featureGroup: "orchestration"`.
