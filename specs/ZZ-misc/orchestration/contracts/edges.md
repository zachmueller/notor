# Contract: Conversation Edges & `child_run_metadata`

**Created:** 2026-06-27
**Specification:** [spec.md](../spec.md)
**Data Model:** [data-model.md](../data-model.md)
**Tasks:** [tasks.md](../tasks.md) — INT-006 (edges + hide), INT-047 (metadata), POL-003 (run-tree view)
**Status:** Draft
**Related contracts:** [contracts/run-loop.md](run-loop.md) (two-layer limit + `RunContext` aggregate budget — the source of the rollup numbers), [contracts/vault-schema.md](vault-schema.md) (the JSONL conversation header these fields extend)

---

## Authority

**This file is the single authority for `orchestration_edges` (the conversation edge model) and
`child_run_metadata` (the shared cross-run rollup block).** Every other spec doc — [spec.md](../spec.md)
(FR-126, FR-177, FR-178, FR-179), [data-model.md](../data-model.md) (Conversation Header Extensions),
[tasks.md](../tasks.md) (INT-006, INT-047, POL-003) — references these shapes by linking here and **does
not redefine them.** [data-model.md](../data-model.md) declares the `OrchestrationEdge` interface and the
conversation-header field list; this file is the behavioral authority for both and must remain
byte-consistent with that declaration. The run-tree view ([Run-tree view note], POL-003) is purely a
*consumer* of the contracts defined here.

Structure (who-links-to-whom) and rollup (cost/iterations/depth numbers) deliberately live in two
separate places, mirroring how sub-agents already work:

- **Structure → `orchestration_edges`** on the conversation header. Covers both `run_flow` invocation
  *and* chaining handoff (a chained child has no tool call, so a tool-result-only scheme could not
  represent it). This is the source the run-tree reads.
- **Rollup → `child_run_metadata`** on `ToolResult` (only where a tool call exists — `run_flow` /
  `use_subagent`). One rendering path, one token-rollup path.

---

## 1. Conversation Header Extensions

Orchestration step conversations extend the JSONL conversation header (first line of each
`*.jsonl` file; see [contracts/vault-schema.md](vault-schema.md)). These fields are **net-new** — the
`Conversation` interface at `src/types.ts:24` has **no** orchestration fields today. All are additive
and optional, so existing non-orchestration headers parse unchanged.

| Field | Type | Present on | Meaning |
|---|---|---|---|
| `_type` | `"conversation"` \| `"orchestration_step_conversation"` | every header | Marker for the hidden-from-flat-list filter (§3). Defaults to `"conversation"` when absent. |
| `orchestration_session_id` | `string` | step conversations | The owning session (`sessions/{id}/`); ties the conversation to its run for recovery + run-tree rooting. |
| `orchestration_flow_name` | `string` | step conversations | `notor-flow-name` of the running flow (for the run-tree label + title convention). |
| `orchestration_step_name` | `string` | step conversations | `notor-step-name` of the step that produced this turn. |
| `orchestration_iteration` | `number` | step conversations | The flow iteration (turn number) this conversation represents. |
| `orchestration_edges` | `OrchestrationEdge[]` | step conversations | Typed adjacency list (§2). The structural source for the run-tree. |

> Code steps (`notor-step-mode: code`) create **no** conversation and therefore no header — they
> never carry these fields. Only conversation-step turns produce a step conversation.

### Full example header

A planner step at iteration 3 of a "Code Implementation" flow, chained after its predecessor step,
having invoked a child research flow via `run_flow`:

```json
{
  "_type": "orchestration_step_conversation",
  "id": "5f2a-step-conv-uuid",
  "title": "[Code Implementation] 📋 Planner — iteration 3",
  "created": 1719500000000,
  "orchestration_session_id": "sess-abc123",
  "orchestration_flow_name": "Code Implementation",
  "orchestration_step_name": "📋 Planner",
  "orchestration_iteration": 3,
  "orchestration_edges": [
    { "kind": "prev",   "conversation_id": "step-conv-uuid-iter2" },
    { "kind": "next",   "conversation_id": "step-conv-uuid-iter4" },
    { "kind": "child",  "conversation_id": "research-entry-conv-uuid", "session_id": "sess-research-789", "via_tool_call_id": "toolu_01ABC" },
    { "kind": "parent", "conversation_id": "caller-step-conv-uuid",    "session_id": "sess-parent-000" }
  ]
}
```

Non-edge fields (`id`, `title`, `created`, plus any existing header keys) follow the standard
conversation header; the title follows the convention `[{flow_name}] {step_name} — iteration {n}`.

---

## 2. The `OrchestrationEdge` Interface

```typescript
interface OrchestrationEdge {
  kind: "next" | "prev" | "child" | "parent";
  conversation_id: string;       // the conversation this edge points at
  session_id?: string;           // present on child/parent edges that cross a flow-session boundary
  via_tool_call_id?: string;     // present on child edges originating from a run_flow tool call
}
```

This shape **must match [data-model.md](../data-model.md) exactly** (Conversation Header Extensions
section). `orchestration_edges` **replaces** the earlier scalar
`orchestration_previous_conversation_id` / `orchestration_next_conversation_id` design fields — a
single uniform adjacency list. Orchestration is design-only with no shipped data, so there is nothing
to migrate; the uniform structure is free to adopt now.

### Edge kinds

| `kind` | Direction | Carries | When written |
|---|---|---|---|
| `next` | this → the following step in the same flow | — | Backfilled when the next step's turn is created (the predecessor's `next` is filled in once the successor conversation id exists). |
| `prev` | this → the preceding step in the same flow | — | Written when this step's conversation is created (the predecessor id is already known). |
| `child` | a calling step → the child flow's **entry** conversation | `session_id` (child session) + `via_tool_call_id` (run_flow only) | When a step invokes `run_flow` **or** chains into a successor at the terminal event. |
| `parent` | a child flow's entry → its caller's step conversation | `session_id` (parent session) | Back-link written on the child's entry conversation when the child session starts. |

- **`next` / `prev`** chain a flow's step conversations in execution order. They **replace** the old
  scalar prev/next and are backfilled the same way the scalars were. They never cross a session
  boundary, so they omit `session_id`.
- **`child`** is the **uniform structural source for both invocation and chaining.** A `run_flow`
  call and a `notor-on-complete-flow` chaining handoff both emit a `child` edge to the child flow's
  *entry* conversation, carrying `session_id` (the child session) so the run-tree can root/descend
  across the boundary. `via_tool_call_id` is present **only** for `run_flow` (an actual tool call
  exists), letting the UI render a "descend" affordance on that exact tool-call card; a chaining
  child has no tool call and omits it. This is precisely why chaining cannot be represented by a
  tool-result-only scheme and why the structural source is the header edge, not `child_run_metadata`.
- **`parent`** is the back-link from the child entry to the caller. Ascending from a deep child to
  its caller is **one hop** up the `parent` edge.

> **Sub-agents are not on this scheme.** Sub-agent conversations keep their existing simpler
> `parent_conversation_id` scalar (written by `UseSubagentTool` at `src/tools/use-subagent.ts:430`,
> header `_type: "sub_agent_conversation"` at `src/chat/history.ts:450`). The run-tree reads *both*
> `orchestration_edges` (orchestration steps + child flows) and the sub-agent scalar (sub-agent
> children) — see §5. Generalizing the sub-agent scalar onto `orchestration_edges` is **out of scope**.

---

## 3. Tree-Constrained DAG Rules

`orchestration_edges` forms a **tree-constrained directed acyclic graph**. The engine's mechanisms
(flow-as-tool call/return + one-way chaining + intra-flow step chaining) only ever produce
hierarchy; nothing emits a non-tree edge.

**Invariants (TEST-006 asserts the no-cycle invariant; [tasks.md](../tasks.md) Phase-7 gate):**

1. **No cyclic edges.** No edge path returns to an ancestor. The graph is a rooted tree.
2. **No sibling edges.** Steps at the same level under one parent are *not* linked to each other by
   `child`/`parent`; their order is expressed only by the intra-flow `next`/`prev` chain.
3. **No `return` edge.** There is deliberately no dedicated edge for "child returned to caller."
   Returning from a deep child is **one hop via `parent`** — the run-tree already shows the parent,
   so a `return` edge would be redundant structure to keep cycle-free.

**Why this matters (load-bearing, not cosmetic):**

- **Crash-recovery replay** (FR-125 / INT-005) walks the session/edge structure; a pure DAG
  guarantees replay terminates and is idempotent.
- **Aggregate-subtree rollup** (the consumed cost/iterations summed over the subtree; sourced from the
  shared `RunContext.budget` cell — `AggregateBudget`, see [contracts/run-loop.md](run-loop.md)) sums
  over the subtree; a cycle would double-count or loop.
- **Run-tree rendering** needs no cycle-detection or infinite-expansion guards at any depth — the
  constraint is what lets a 50-node tree render cleanly.

**The constraint is a UX feature for large trees.** Comprehensibility scales far better with a tree: a
50-node *tree* stays navigable (collapse/expand, clear parent/child); a 50-node arbitrary graph does
not. Constraining to hierarchy costs nothing because the engine has no mechanism to execute
non-hierarchical links anyway.

---

## 4. Hidden-From-Flat-List Rule

Orchestration step conversations are **excluded from the flat conversation sidebar**, exactly as
sub-agent conversations already are. The run-tree view (§5, POL-003) is their **only** surface. This
is INT-006's second half; hiding must happen the moment step conversations are written (FEAT-007) or
the flat sidebar fills with per-turn noise ([tasks.md](../tasks.md) sequencing-risk #4).

### Generalize the existing filter

The precedent is the sub-agent filter — generalize it to also catch orchestration step conversations:

- `isSubAgentFilename(filename)` at `src/chat/sub-agent-history.ts:110` matches
  `filename.includes("_subagent_")`.
- `HistoryManager.listConversations()` at `src/chat/history.ts:629` and `searchConversations()` at
  `src/chat/history.ts:723` both `continue` (skip) when `isSubAgentFilename(fname)` is true.

The generalization keeps both surfaces excluded. Two compatible options (implementation detail for
INT-006, not fixed here):

- **By `_type` (preferred, robust):** skip any header whose `_type` is `"sub_agent_conversation"` or
  `"orchestration_step_conversation"`. This reads the marker rather than guessing from the filename
  and is the authoritative discriminator. `listConversations()` already reads the header per file, so
  the `_type` check costs nothing extra there.
- **By filename (cheap pre-read guard):** mirror `isSubAgentFilename` with an orchestration filename
  convention so the file can be skipped before its header is read.

**AC (FR-126):** step conversations never appear in `listConversations()` / `searchConversations()`;
the run-tree is their only navigational entry point.

---

## 5. `child_run_metadata` (shared rollup block)

`child_run_metadata` **generalizes the existing `ToolResult.sub_agent_metadata`** (`src/types.ts:270`)
into one block used by **both** `use_subagent` and `run_flow`. INT-047 (`→` INT-006, INT-043).

It is a **back-compat superset, not a breaking rename** ([tasks.md](../tasks.md) sequencing-risk #5):
the shared shape keeps every existing `sub_agent_metadata` field readable so already-persisted
conversations still parse.

### Field table

```typescript
interface ChildRunMetadata {
  // --- identity / structure ---
  jsonl_filename?: string;        // back-compat: sub-agent conversation filename (relative to history dir)
  entry_conversation_id?: string; // flow: the child flow's entry conversation id (pairs with the `child` edge)
  session_id?: string;            // flow: the child session id (null/absent for sub-agents)

  // --- rollup (AGGREGATE SUBTREE for flows; SINGLE-RUN for sub-agents) ---
  token_usage: { input: number; output: number };
  cost_usd?: number;              // new; from per-turn calculateCost accumulation
  iteration_count: number;
  depth?: number;                 // new; subtree max depth (sub-agents = own depth)

  // --- outcome / label ---
  stop_reason: string;            // RunResult.stopReason union (completed | iteration_cap | token_limit | context_window | cost_cap | depth_cap)
  name?: string;                  // generalized label: flow name (run_flow) OR profile name (sub-agent)

  // --- back-compat alias (kept readable for persisted sub-agent conversations) ---
  profile_name?: string;          // legacy sub-agent field; `name` is the generalized form
}
```

| Field | `use_subagent` (single-run) | `run_flow` (aggregate subtree) |
|---|---|---|
| `jsonl_filename` | the sub-agent conversation file | — (flows use `entry_conversation_id`) |
| `entry_conversation_id` | — | the child flow's entry conversation |
| `session_id` | absent | the child session id |
| `token_usage` | the single sub-agent run's tokens | **summed across the entire child flow tree** |
| `cost_usd` | the single run's cost | **aggregate subtree cost** |
| `iteration_count` | the sub-agent's turns | **aggregate turns across the subtree** |
| `depth` | the sub-agent's own depth | **max depth reached in the subtree** |
| `stop_reason` | sub-agent stop reason | child flow's terminal stop reason |
| `name` | sub-agent profile name | flow name |
| `profile_name` | profile name (also as `name`) | absent |

For **flows**, the aggregate numbers are the **consumed** cost/iterations of the *whole* child flow
tree, derived from the shared `AggregateBudget` cell the child subtree drew down (the cascading
budget; see [contracts/run-loop.md](run-loop.md)) — measured as the cell's spend over the child run
(e.g. captured-at-spawn remaining minus remaining-at-return, or an explicit per-subtree consumed
accumulator), not just the direct child. Because the cell is **shared by reference** across the
subtree, every descendant turn's decrement is already reflected in it, so the rollup is a single read
rather than a tree walk. For **sub-agents**, the subtree is the sub-agent itself (its `budget` cell is
seeded `Infinity` and unused for gating), so the same fields carry single-run totals taken from the
run's own token/iteration counts.

### Back-compat guarantee (the back-compat parse — TEST-006)

A `ToolResult` persisted today carries `{ jsonl_filename, token_usage, iteration_count, stop_reason,
profile_name }`. The reader for `child_run_metadata` **must continue to parse those five fields** for
already-persisted conversations. Concretely: `jsonl_filename`, `token_usage`, `iteration_count`, and
`stop_reason` are read as-is; `profile_name` is read as the legacy alias of `name`. New fields
(`entry_conversation_id`, `session_id`, `cost_usd`, `depth`, `name`) are all optional and simply
absent on legacy records. TEST-006 asserts a legacy `sub_agent_metadata` record parses through the
shared reader unchanged.

### One rendering path

There is exactly **one** rendering path for `child_run_metadata`: the **inline expandable
child-conversation card** in the chat panel. This is **NEW work** — today the inline card is rendered
**only** in HTML export:

- `src/export/html-exporter.ts:585` `renderSubAgentDetail()` is the existing inline child card —
  reference it for **markup/CSS only**, not as a runtime reuse.
- `src/ui/message-renderer.ts:506` `renderToolResult()` does **not** render `sub_agent_metadata` today;
  POL-003 adds the inline card here, sourced from the shared block, serving both `use_subagent` and
  `run_flow`. ([tasks.md](../tasks.md) sequencing-risk #7: this is new chat UI, not a reuse of the
  export card.) The card is a **one-level peek** (direct child summary + status + aggregate rollup +
  an "Open run tree" affordance) — it never renders the whole tree.

### One token-rollup path

There is exactly **one** token-rollup path: at tool-return time, the run-loop result's tokens roll up
into the parent conversation via `convManager.addTokens(...)`. The existing sub-agent rollup at
`src/chat/orchestrator.ts:1635` reads `toolResult.sub_agent_metadata?.token_usage` and calls
`convManager.addTokens(subAgentTokens.input, subAgentTokens.output)` (`addTokens` at
`src/chat/conversation.ts:696`). INT-047 generalizes this single site to read
`child_run_metadata.token_usage`, serving both tools through one path — no second rollup site is added.

---

## 6. Run-Tree View Consumption (informative)

The unified run-tree `ItemView` (POL-003, FR-178) is a **read-only consumer** of the contracts above;
it defines no schema of its own. Detailed view-layer UX lives in the [Run-tree view note]; here is only
what it reads:

| The view needs… | …reads from |
|---|---|
| Structure: orchestration steps + child flows | `orchestration_edges` (`next`/`prev` for the step chain; `child`/`parent` for cross-flow descent/ascent) |
| Structure: sub-agent children | the sub-agent `parent_conversation_id` scalar (`src/tools/use-subagent.ts:430`) |
| Per-node identity / label | `orchestration_*` header fields (§1) for steps; `name` / `profile_name` from `child_run_metadata` for child-flow / sub-agent nodes |
| Header aggregate rollup (root cost / iterations / max depth) | the root run's shared `RunContext.budget` cell consumption ([contracts/run-loop.md](run-loop.md)) |
| Peek-card numbers on a spawning tool-call | `child_run_metadata` (aggregate subtree for flows; single-run for sub-agents) — §5 |
| Live updates while a run is active | `WorkflowActivityTracker.onChange()` over the `session-log.jsonl` write points (`turn.start` / `turn.complete` / `event.emitted`) — see [contracts/vault-schema.md](vault-schema.md) |
| Descend affordance on a tool-call card | `via_tool_call_id` on the `child` edge (run_flow only) |
| Select-to-navigate into a node | the existing `notor-conversation://{id}` jump + `switchToConversationById` (`src/ui/message-renderer.ts:957`, `src/chat/orchestrator.ts:741`) |

Because the edges are a tree-constrained DAG (§3), the view needs no cycle-detection or
infinite-expansion guards at any depth. The run-tree cannot render until **both** INT-006 (edges +
hide) and INT-047 (`child_run_metadata`) exist — the Phase-7 long pole ([tasks.md](../tasks.md)
critical path: `INT-006 → INT-043 → INT-047 → POL-003`).
