import { scaffold } from "./_scaffold-helper";

/**
 * `emit_event` — the orchestration event-emission tool (FEAT-009).
 *
 * A **capture-only** tool: it writes `{ topic, payload }` to the per-step
 * `orchestrationContext.pendingEmission` slot (threaded onto `utils` from
 * `ToolExecuteOptions.orchestrationContext`) and returns a confirmation. It does
 * **not** publish — the `StepTurnExecutor` reads `pendingEmission` **after** the
 * turn completes and hands it to the engine, which routes write-before-route. No
 * mid-turn routing.
 *
 * Gated `featureGroup: "orchestration"`, so the `ExtensionManager` only
 * compiles/registers it when `orchestration_enabled` is true (ENV-002 wired the
 * `FEATURE_GROUP_TOGGLES` entry). Mode `write` (Act mode only). Built via
 * `_scaffold-helper.ts`, exactly as `capture-memory.ts`.
 *
 * Within-turn overwrite policy (Issue-13e):
 *  - **Non-terminal topics: last-write-wins** — a later non-terminal emission
 *    overwrites the pending one; the overwrite is recorded on the carriage's
 *    `emissionOverwrites` audit channel (`prev_topic` → `new_topic`), which the
 *    executor flushes to `event.emission_overwritten`.
 *  - **Terminal topics latch** — the first `FLOW_COMPLETE` / `FLOW_CANCELLED` /
 *    `FLOW_ERROR` latches; any subsequent `emit_event` returns `success: false`
 *    (the LLM sees the rejection) and the latch is recorded for audit.
 *
 * Absent `orchestrationContext` (reached outside a step turn), the tool returns
 * `success: false` rather than mutating anything.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-009
 * @see specs/ZZ-misc/orchestration/contracts/tools.md — emit_event
 */
export const EMIT_EVENT = scaffold(
	"emit_event",
	"Publish an orchestration event to advance the flow to its next step.",
	"write",
	`params:
  topic:
    type: string
    description: "Event topic name (e.g. tasks.ready, review.passed, FLOW_COMPLETE)."
  payload:
    type: string
    description: "Evidence or context handed to the next step."
required: [topic, payload]`,
	`if (!params.topic || typeof params.topic !== "string") {
  return { __toolError: true, error: "Missing required parameter: topic" };
}
if (typeof params.payload !== "string") {
  return { __toolError: true, error: "Missing required parameter: payload" };
}

const topic = (params.topic).trim();
const payload = params.payload;

// The per-step orchestration carriage is threaded onto utils from
// ToolExecuteOptions.orchestrationContext. Absent it, emit_event is being
// reached outside a step turn — capture nothing.
const ctx = utils.orchestrationContext;
if (!ctx) {
  return {
    __toolError: true,
    error: "emit_event can only be called from within an orchestration step turn.",
  };
}

const TERMINALS = ["FLOW_COMPLETE", "FLOW_CANCELLED", "FLOW_ERROR"];
const isTerminal = (t) => TERMINALS.indexOf(t) !== -1;

const prev = ctx.pendingEmission;
const overwrites = ctx.emissionOverwrites;

// Terminal latch: the first terminal emission in a turn latches. Any later
// emit is rejected (the LLM sees success: false) and recorded for audit.
if (prev && isTerminal(prev.topic)) {
  if (Array.isArray(overwrites)) {
    overwrites.push({ prev_topic: prev.topic, new_topic: topic });
  }
  return {
    __toolError: true,
    error:
      "A terminal event (" + prev.topic + ") was already emitted this turn and is latched; " +
      "the later '" + topic + "' emission is rejected. End your turn.",
  };
}

// Non-terminal last-write-wins: record the discarded intent for audit.
if (prev && prev.topic !== topic && Array.isArray(overwrites)) {
  overwrites.push({ prev_topic: prev.topic, new_topic: topic });
}

ctx.pendingEmission = { topic, payload };

return "Emission recorded: '" + topic + "'. It will route after this turn completes.";`,
	"orchestration",
);
