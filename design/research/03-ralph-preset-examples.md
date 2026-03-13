# Ralph Preset Examples: Real-World Workflows

> Source: `../ralph-orchestrator/presets/` and `../ralph-orchestrator/ralph.yml`

## code-assist.yml: The 4-Hat Implementation Loop

The most complete example. Implements an adaptive TDD implementation loop.

### Hat Roles

| Hat | Triggers | Publishes | Role |
|-----|----------|-----------|------|
| planner | `build.start`, `queue.advance` | `tasks.ready` | Breaks work into steps, manages runtime task queue |
| builder | `tasks.ready`, `review.rejected`, `finalization.failed` | `review.ready`, `build.blocked` | TDD implementation (RED→GREEN→REFACTOR) |
| critic | `review.ready` | `review.passed`, `review.rejected` | Adversarial fresh-eyes code review |
| finalizer | `review.passed` | `queue.advance`, `finalization.failed`, `LOOP_COMPLETE` | Whole-prompt completion gate |

### Event Flow

```
build.start
  → planner → tasks.ready {task_id, task_key}
    → builder → review.ready {task_id, task_key}
      → critic → review.passed {task_id}
        → finalizer →
          (more work?) → queue.advance → planner → ...
          (done?)      → LOOP_COMPLETE

  (build failure?) → build.blocked
  (review failed?) → review.rejected → builder → review.ready → ...
```

### Key Design Patterns in Instructions

**Planner:**
- Owns the "step-wave queue" strategy: only materializes current step's tasks
- Uses `ralph tools task ensure` to create runtime tasks
- Each `tasks.ready` payload must include `task_id`, `task_key`, artifact path
- Strict constraint: "You MUST NOT start implementing"

**Builder:**
- ONE task at a time — never batches
- Strict TDD: RED → GREEN → REFACTOR, in that order
- Confidence protocol: score 0-100, >80 proceed autonomously, 50-80 document in decisions.md
- Cannot use `human.interact` — must never block for input

**Critic:**
- Re-runs the build/test harness independently (doesn't trust builder's claims)
- Uses Playwright/tmux/real CLI for adversarial testing
- `default_publishes: "review.rejected"` — conservative default

**Finalizer:**
- Whole-prompt gate (not just per-task)
- Runs its own full verification
- `LOOP_COMPLETE` only when ALL planned steps are complete

---

## ralph.yml: The Project's Own Config

Ralph's development uses itself for development. Key features:
```yaml
event_loop:
  completion_promise: LOOP_COMPLETE
  max_iterations: 150
  max_runtime_seconds: 28800
  starting_event: work.start

backpressure:
  gates:
    - name: fmt
      command: cargo fmt --all -- --check
    - name: clippy
      command: cargo clippy --all-targets --all-features -- -D warnings
    - name: test
      command: cargo test --all

hats:
  planner / builder / reviewer / finalizer
```

**Backpressure gates** — shell commands that must pass before an event can be published.
This is a quality enforcement mechanism that's automatic and doesn't require the LLM
to remember to run checks.

---

## research.yml: Research Workflow

A simpler 2-hat pattern for research tasks.
(From file listing — content not fully read, but represents single-purpose presets.)

---

## review.yml: Code Review Workflow

Likely a single-hat or 2-hat pattern focused on reviewing PRs/diffs.

---

## pdd-to-code-assist.yml: Pipeline Preset

Chains PDD (Product Definition Documents) generation → code-assist implementation.
Demonstrates how presets can chain multiple phases.

---

## Minimal Presets (`presets/minimal/`)

Minimal single-backend presets for different AI backends:
- `claude.yml` — Claude-specific minimal preset
- `codex.yml` — OpenAI Codex
- `gemini.yml` — Google Gemini
- `kiro.yml` — Kiro (AWS)
- `amp.yml` — Amp
- `smoke.yml` — Smoke test preset
- `code-assist.yml` — Minimal version of code-assist

These represent the minimal viable hat configuration for each backend adapter.

---

## Planning Preset Pattern

The planning preset (used by PlanningService) enables interactive sessions:
- Ralph pauses and emits `user.prompt` events when it needs human input
- The web server polls `.ralph/current-events` to detect these
- User responses are written back to a `conversation.jsonl` file
- Ralph picks up the response and continues

This demonstrates Ralph's "human-in-the-loop" capability.

---

## Key Learnings from Presets

### 1. Hat Instructions Are the Core Value

Each hat's `instructions` field is a rich, detailed markdown prompt that:
- Defines the role's mandate ("You are the planner. You own decomposition.")
- Specifies exact input sources to read (event payload, shared docs, scratchpad)
- Defines exact output contracts (what events to emit, with what payloads)
- Includes decision protocols (confidence scoring, safe defaults)
- Prohibits out-of-scope behavior explicitly ("MUST NOT implement")

This is very different from a simple "do X" workflow instruction. It's closer to
an employee handbook for an autonomous agent role.

### 2. Shared State via Filesystem Files

Hats communicate state through files in the repo:
- `.agents/scratchpad/implementation/{task_name}/context.md`
- `.agents/scratchpad/implementation/{task_name}/plan.md`
- `.agents/scratchpad/implementation/{task_name}/progress.md`
- `.ralph/agent/decisions.md`
- `.ralph/agent/scratchpad.md`
- `ralph tools task ensure/start/close/show` — runtime task management

Each hat reads these on activation to pick up where the previous hat left off.
This is how state persists across LLM turns without relying on context window.

### 3. Event Payloads Carry Task Identity

The event system isn't just pub/sub — payloads carry structured data:
```json
{"topic": "tasks.ready", "payload": {"task_id": "xyz", "task_key": "code-assist:feature:step-01:impl"}}
```

This means the receiving hat knows exactly which task to work on, without
having to figure it out from scratch.

### 4. default_publishes: Safety Net

`default_publishes` is the event emitted if the hat doesn't emit anything explicit.
- Critic's default: `review.rejected` (conservative — reject unless explicitly passed)
- Builder's default: `review.ready` (optimistic — proceed unless explicitly blocked)

This prevents the loop from getting stuck due to a hat failing to emit.

### 5. guardrails: Universal Constraints

`core.guardrails` is a list of bullet-point rules injected into every hat's system prompt.
Used for project-wide constraints like:
- "Verification is mandatory — tests must pass"
- "Confidence protocol: >80 proceed; 50-80 document; <50 choose safe default"
- "YAGNI ruthlessly — no speculative features"

### 6. backpressure.gates: Automated Quality Gates

Shell commands that must pass before any event can be published.
Enforces quality without relying on the LLM to remember to run checks.
E.g.: "cargo fmt", "cargo clippy", "cargo test" must all pass.
