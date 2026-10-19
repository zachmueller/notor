import { scaffold } from "./_scaffold-helper";

/**
 * `submit_score` — the circuit-evaluation scoring tool.
 *
 * A **capture-only** tool, the evaluator analog of `emit_event`: an LLM judge
 * (a `notor-eval-mode: conversation` evaluator) reports its per-dimension scores
 * by calling this once; the body validates the submission against the
 * evaluator's declared dimensions and writes it to the carriage's
 * `orchestrationContext.evaluation.pendingScore` slot. The judge runner reads
 * the slot **after** the turn and records `eval.scored` / `eval.failed` — the
 * tool itself persists nothing.
 *
 * Gated `featureGroup: "circuits"`, like `emit_event`. Mode `read`, not `write`:
 * judges run in Plan mode (read-only tools, no approval prompts), and the
 * dispatcher blocks write-class tools there — a `write` classification would
 * reject the one call a judge must make. It mutates nothing in the vault.
 *
 * Validation happens inline so the model sees a precise, retryable error: an
 * unknown dimension, a value of the wrong type, a numeric value outside the
 * declared range, or a missing dimension all return `success: false` naming the
 * declared dimensions. Last-write-wins within a turn.
 *
 * Absent `orchestrationContext.evaluation` (reached outside an evaluator turn),
 * the tool returns `success: false` rather than mutating anything.
 */
export const SUBMIT_SCORE = scaffold(
	"submit_score",
	"Submit the scores for a circuit evaluation: one call carrying every declared dimension plus a rationale.",
	// `read`, not `write`: capture-only control-flow primitive that must run in
	// Plan mode. See the file header for why.
	"read",
	`params:
  scores:
    type: object
    description: "Map of dimension name to score. Numeric dimensions take a number within the declared range; boolean dimensions take true or false. Every declared dimension is required."
  rationale:
    type: string
    description: "Why you gave these scores, citing evidence from the run outcome and the notes it edited."
  overall:
    type: number
    optional: true
    description: "Optional overall score on the evaluator's primary numeric scale."
required: [scores, rationale]`,
	`// The per-turn carriage is threaded onto utils from
// ToolExecuteOptions.orchestrationContext. Only an evaluator turn carries an
// evaluation slot — anywhere else, capture nothing.
const ctx = utils.orchestrationContext;
if (!ctx || !ctx.evaluation) {
  return {
    __toolError: true,
    error: "submit_score can only be called from within a circuit evaluator turn.",
  };
}
const evaluation = ctx.evaluation;

const scores = params.scores;
if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
  return {
    __toolError: true,
    error: "Missing required parameter: scores (an object mapping each dimension name to its value).",
  };
}
if (typeof params.rationale !== "string" || params.rationale.trim() === "") {
  return { __toolError: true, error: "Missing required parameter: rationale (a non-empty string)." };
}

const declared = Array.isArray(evaluation.dimensions) ? evaluation.dimensions : [];
const byName = {};
for (const d of declared) byName[d.name] = d;

const problems = [];
for (const key of Object.keys(scores)) {
  const dim = byName[key];
  const value = scores[key];
  if (!dim) {
    problems.push("unknown dimension '" + key + "'");
    continue;
  }
  if (dim.type === "boolean") {
    if (typeof value !== "boolean") problems.push("'" + key + "' must be true or false");
  } else if (typeof value !== "number" || !isFinite(value)) {
    problems.push("'" + key + "' must be a number");
  } else if (value < dim.min || value > dim.max) {
    problems.push("'" + key + "' must be within " + dim.min + ".." + dim.max);
  }
}
for (const d of declared) {
  if (!Object.prototype.hasOwnProperty.call(scores, d.name)) {
    problems.push("missing dimension '" + d.name + "'");
  }
}
const hasOverall = params.overall !== undefined && params.overall !== null;
if (hasOverall && (typeof params.overall !== "number" || !isFinite(params.overall))) {
  problems.push("'overall' must be a number when provided");
}

if (problems.length > 0) {
  const list = declared
    .map((d) => d.name + " (" + (d.type === "boolean" ? "true/false" : d.min + ".." + d.max) + ")")
    .join(", ");
  return {
    __toolError: true,
    error:
      "Invalid scores: " + problems.join("; ") + ". Declared dimensions: " + list +
      ". Call submit_score again with every dimension.",
  };
}

const submitted = { scores: scores, rationale: params.rationale };
if (hasOverall) submitted.overall = params.overall;
evaluation.pendingScore = submitted;

return "Scores recorded for evaluator '" + evaluation.evaluatorName + "'. End your turn.";`,
	"circuits",
);
