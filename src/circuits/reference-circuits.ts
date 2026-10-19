/**
 * Reference flows (POL-002 / FR-161) — three first-party example flows
 * materialized into `{notor_dir}/circuits/` when the user enables the
 * orchestration feature group. They demonstrate the three pillars of the engine —
 * **conversation steps**, **code steps**, and **composition**.
 *
 * These are first-party *examples*, not e2e fixtures (F6 §4.4, verified): no e2e
 * script uses them — all 10 `e2e/scripts/orchestration-*-test.ts` write bespoke
 * inline flows against live Bedrock. The verifiable gate on this content is the
 * unit-level flow-parse test (`reference-flows.test.ts`), which asserts each
 * `materializeReferenceCircuits` output parses + validates through
 * `CircuitDefinitionParser` with zero errors/warnings. A live-provider e2e for one
 * reference flow (a real TEST-007) remains a separate team decision — the e2e
 * harness has no provider stub today — and is deliberately out of scope here.
 *
 * Lifecycle mirrors the built-in personas: the content lives here as constants and
 * is **materialized on first enable, preserving user edits** ({@link materializeReferenceCircuits}
 * never overwrites an existing file). Each flow is authored to pass the FEAT-002
 * load-time validators (reachable completion, single-subscriber topics, no
 * published-but-unsubscribed non-terminal topic, required-events published).
 *
 *  1. `code-assist` — TDD build loop: conversation steps + a code-step verifier
 *     that routes on the test outcome. Invocable (returns a structured summary).
 *  2. `research` — multi-phase research loop ending in a **code step** that emits
 *     `CIRCUIT_COMPLETE` (≡ `FLOW_COMPLETE`) with a **structured** payload (the reliable-returns path).
 *  3. `review` — composition demo: a code step calls `code-assist` via `run_circuit`,
 *     then a conversation step composes the final review.
 *
 * Two of them also ship **evaluators** (`evals/`), so authors have a working
 * example of each evaluator mode: `research` carries an LLM judge with a rubric
 * note, `code-assist` a deterministic code evaluator over the structured return.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — POL-002
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md
 */

import { logger } from "../utils/logger";

const log = logger("ReferenceFlows");

/** A reference flow: its `definition.md` + a `{stepFileName: body}` map. */
export interface ReferenceCircuit {
	/** Directory slug under `{notor_dir}/circuits/`. */
	slug: string;
	/** Full `definition.md` content (frontmatter + documentation body). */
	definition: string;
	/** Step note contents keyed by file name (written under `steps/`). */
	steps: Record<string, string>;
	/** Evaluator / rubric note contents keyed by file name (written under `evals/`). */
	evals?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 1. code-assist — conversation steps + a code-step verifier (invocable)
// ---------------------------------------------------------------------------

const CODE_ASSIST: ReferenceCircuit = {
	slug: "code-assist",
	definition: `---
notor-type: circuit
notor-circuit-name: "Code Assist"
notor-circuit-description: "TDD-style implementation loop: plan, build, verify, review, finalize."
notor-starting-event: build.start
notor-completion-event: CIRCUIT_COMPLETE
notor-max-iterations: 100
notor-max-runtime-minutes: 120
notor-required-events:
  - review.approved
notor-steps:
  - "[[planner]]"
  - "[[builder]]"
  - "[[verify-tests]]"
  - "[[critic]]"
  - "[[finalizer]]"
notor-guardrails:
  - "Verification is mandatory — tests must pass before review."
  - "YAGNI — implement only what the task requires."
notor-circuit-invocable: true
notor-circuit-inputs: "A natural-language feature description plus the absolute path to the target repo."
notor-circuit-returns: "A summary of what was implemented and the list of files changed."
notor-handoff-isolation: isolated
notor-max-depth: 3
notor-max-cost-usd: 5.00
notor-evaluators:
  - "[[structured-summary]]"
---

# Code Assist

A TDD-style implementation loop. Provide a feature description and the target repo
path as the objective. The circuit plans the work, implements it, verifies with the
test suite (a deterministic code step), reviews, and finalizes.

Ships with one **code evaluator** (\`evals/structured-summary.md\`) that checks a
finished run completed and returned the structured summary + plan. Run it with
**Notor: Evaluate circuit sessions**.

(This body is documentation only — it is never injected into a step's prompt.)
`,
	evals: {
		"structured-summary.md": `---
notor-type: circuit-evaluator
notor-eval-name: "Structured summary"
notor-eval-description: "Deterministic shape check: the run completed and returned a summary and a plan."
notor-eval-mode: code
notor-eval-dimensions:
  - { name: completed, type: boolean, description: "The run ended in CIRCUIT_COMPLETE" }
  - { name: has_summary, type: boolean, description: "The structured return carries a non-empty summary" }
  - { name: has_plan, type: boolean, description: "The structured return carries a non-empty plan" }
---

# Structured summary

A **code evaluator**: no LLM, zero cost. It inspects the finished run's outcome
(\`input.outcome\`) and returns one boolean per dimension. Use it as the template for
any deterministic check (a file exists, tests pass, a word count is in range).

\`\`\`typescript
const structured = input.outcome.structured;
const field = (key: string): string =>
  structured && typeof structured === "object" && typeof (structured as Record<string, unknown>)[key] === "string"
    ? ((structured as Record<string, unknown>)[key] as string)
    : "";

const completed = input.outcome.status === "completed";
const summary = field("summary").trim();
const plan = field("plan").trim();

return {
  scores: {
    completed,
    has_summary: summary.length > 0,
    has_plan: plan.length > 0,
  },
  rationale:
    \`status=\${input.outcome.status}; summary=\${summary.length} chars; plan=\${plan.length} chars; \` +
    \`notes edited=\${input.notesEdited.length}\`,
};
\`\`\`
`,
	},
	steps: {
		"planner.md": `---
notor-type: circuit-step
notor-step-name: "📋 Planner"
notor-step-description: "Decomposes the objective and owns the task queue."
notor-step-triggers:
  - build.start
  - tests.failed
notor-step-publishes:
  - build.ready
notor-step-default-publishes: build.ready
notor-step-persona: null
---

## PLANNER MODE

You own decomposition and the task queue. Do **not** implement; do **not** review.

1. Read \`plan.md\` and \`progress.md\` from the session scratchpad (if present).
2. Break the objective into discrete, testable tasks with \`circuit_task_ensure\`.
3. Write the complete plan to \`plan.md\` in the scratchpad (overwrite the whole file — never append).
4. Emit \`build.ready\` with the next task and the repo path as the payload.
`,
		"builder.md": `---
notor-type: circuit-step
notor-step-name: "🛠️ Builder"
notor-step-description: "Implements the next task against the repo."
notor-step-triggers:
  - build.ready
notor-step-publishes:
  - build.done
notor-step-default-publishes: build.done
notor-step-persona: null
---

## BUILDER MODE

Implement the next task. Mark it \`circuit_task_start\` before you begin and
\`circuit_task_close\` when done.

1. Read \`plan.md\` from the scratchpad to see the planned work.
2. Implement the change in the target repo (the repo path is in the incoming event payload).
3. When the implementation is complete, emit \`build.done\` with the repo path as the payload.
`,
		"verify-tests.md": `---
notor-type: circuit-step
notor-step-name: "🔍 Verify Tests"
notor-step-description: "Runs the test suite and routes deterministically on the result."
notor-step-mode: code
notor-step-triggers:
  - build.done
notor-step-publishes:
  - tests.passed
  - tests.failed
notor-step-default-publishes: tests.failed
---

# Verify Tests

Runs the test suite and routes on the exit code — the canonical "replaces verification
steps" code step. Replaces a pass/fail verification step with arbitrary deterministic logic.

\`\`\`typescript
// The builder forwarded the repo path as the event payload.
const repoPath = event.payload;

const result = await utils.executeShellCommand("npm test", {
  cwd: repoPath,
  timeoutSeconds: 120,
});

// ShellExecuteResult.stdout is COMBINED stdout+stderr (no separate stderr field).
if (result.exitCode === 0 && !result.timedOut) {
  await circuit.scratchpad.write("last-test-run.txt", result.stdout);
  return circuit.emit("tests.passed", repoPath);
}

// Failure: forward the full context so the planner can re-plan a fix.
return circuit.emit(
  "tests.failed",
  JSON.stringify({ exitCode: result.exitCode, timedOut: result.timedOut, output: result.stdout }),
);
\`\`\`
`,
		"critic.md": `---
notor-type: circuit-step
notor-step-name: "🧐 Critic"
notor-step-description: "Adversarial review of the implementation."
notor-step-triggers:
  - tests.passed
notor-step-publishes:
  - review.approved
notor-step-default-publishes: review.approved
notor-step-persona: null
---

## CRITIC MODE

Adversarially review the implementation. Do **not** write code.

1. Inspect the changed files in the repo (the path is in the incoming event payload).
2. Check correctness, edge cases, and that the work matches the objective.
3. When satisfied, emit \`review.approved\` with a one-line verdict as the payload.
`,
		"finalizer.md": `---
notor-type: circuit-step
notor-step-name: "✅ Finalizer"
notor-step-description: "Closes remaining tasks and completes the circuit with a structured summary."
notor-step-mode: code
notor-step-triggers:
  - review.approved
notor-step-publishes:
  - CIRCUIT_COMPLETE
notor-step-default-publishes: CIRCUIT_COMPLETE
---

# Finalizer

Closes any lingering tasks and completes the circuit, returning a **structured** summary
(the reliable-returns path for a \`run_circuit\` caller).

\`\`\`typescript
// Close any still-open/running tasks so CIRCUIT_COMPLETE enforcement passes.
const open = await circuit.tasks.list({ status: "open" });
const running = await circuit.tasks.list({ status: "running" });
for (const t of [...open, ...running]) {
  await circuit.tasks.close(t.key);
}

const plan = (await circuit.scratchpad.read("plan.md")) ?? "";
const summary = "Implementation complete and reviewed.";

// Terminal code step → the 3rd arg is lifted onto the run's structured return.
return circuit.emit("CIRCUIT_COMPLETE", summary, {
  summary,
  plan,
});
\`\`\`
`,
	},
};

// ---------------------------------------------------------------------------
// 2. research — conversation steps + a structured-return terminal code step
// ---------------------------------------------------------------------------

const RESEARCH: ReferenceCircuit = {
	slug: "research",
	definition: `---
notor-type: circuit
notor-circuit-name: "Research"
notor-circuit-description: "Multi-phase research loop: explore, synthesize, verify, summarize."
notor-starting-event: research.start
notor-completion-event: CIRCUIT_COMPLETE
notor-max-iterations: 60
notor-max-runtime-minutes: 60
notor-required-events:
  - synthesize.done
notor-steps:
  - "[[explore]]"
  - "[[synthesize]]"
  - "[[verify]]"
  - "[[summarize]]"
notor-guardrails:
  - "Cite a source for every factual claim."
  - "Write findings to the scratchpad — never rely on conversation context."
notor-circuit-invocable: true
notor-circuit-inputs: "A single research question as a plain string."
notor-circuit-returns: "A short markdown report with at least one cited source per angle."
notor-handoff-isolation: isolated
notor-max-depth: 2
notor-max-cost-usd: 3.00
notor-evaluators:
  - "[[report-quality]]"
notor-eval-max-cost-usd: 1.00
---

# Research

Give it a research question as the objective. The circuit plans angles, gathers findings
into the scratchpad, verifies something was gathered, then a terminal **code step**
emits the completion event with a **structured** report (so a \`run_circuit\` caller
receives \`structured\`, not loose text).

Ships with one **LLM evaluator** (\`evals/report-quality.md\`, rubric in
\`evals/_rubric.md\`) that scores a finished run's report. Run it with **Notor: Evaluate
circuit sessions**; each pass is capped by \`notor-eval-max-cost-usd\`.

(This body is documentation only.)
`,
	evals: {
		"report-quality.md": `---
notor-type: circuit-evaluator
notor-eval-name: "Report quality"
notor-eval-description: "LLM judge: scores the final report against the rubric."
notor-eval-mode: conversation
notor-eval-persona: null
notor-eval-rubric: "[[_rubric]]"
notor-eval-dimensions:
  - accuracy
  - completeness
  - concision
  - { name: cited_sources, type: boolean, description: "Every factual claim names a source" }
---

# Report quality

An **LLM judge**. It receives the circuit objective, the run's status and closing text,
the structured return (\`report\` + \`findings\`), and the notes the run edited, then
scores each dimension by calling \`submit_score\`. Set \`notor-eval-persona\` (or
\`notor-eval-subagent\`) to pin a judge; otherwise the active provider/model is used.

Judge the **report** field of the structured return first; fall back to the closing text
when it is empty. Score \`accuracy\`, \`completeness\`, and \`concision\` from 1 (poor) to
5 (excellent). Mark \`cited_sources\` true only when every factual claim in the report
names its source.
`,
		"_rubric.md": `# Research report rubric

- **accuracy** — Claims are correct and consistent with the cited findings. 5 = no errors;
  3 = minor imprecision; 1 = a central claim is wrong or unsupported.
- **completeness** — The report answers the research question from every angle the
  objective implies. 5 = nothing material missing; 3 = one angle thin; 1 = mostly missing.
- **concision** — No padding, no repetition, no unexplained jargon. 5 = tight;
  3 = some filler; 1 = bloated or unreadable.
- **cited_sources** — true when every factual claim names its source.
`,
	},
	steps: {
		"explore.md": `---
notor-type: circuit-step
notor-step-name: "🔭 Explore"
notor-step-description: "Plans research angles and gathers initial findings."
notor-step-triggers:
  - research.start
notor-step-publishes:
  - explore.done
notor-step-default-publishes: explore.done
notor-step-persona: null
---

## EXPLORE MODE

1. Decompose the research question into 2–4 angles.
2. Use \`web_search\` / \`fetch_webpage\` to gather initial findings for each angle.
3. Write the **complete** findings set (with sources) to \`findings.md\` in the scratchpad —
   overwrite the whole file; do not append.
4. Emit \`explore.done\` with a one-line summary as the payload.
`,
		"synthesize.md": `---
notor-type: circuit-step
notor-step-name: "🧪 Synthesize"
notor-step-description: "Synthesizes findings into a coherent draft."
notor-step-triggers:
  - explore.done
notor-step-publishes:
  - synthesize.done
notor-step-default-publishes: synthesize.done
notor-step-persona: null
---

## SYNTHESIZE MODE

1. Read \`findings.md\` from the scratchpad.
2. Synthesize the findings into a coherent draft, resolving contradictions.
3. Write the draft to \`draft.md\` in the scratchpad (overwrite the whole file).
4. Emit \`synthesize.done\` with a one-line summary as the payload.
`,
		"verify.md": `---
notor-type: circuit-step
notor-step-name: "✅ Verify Findings"
notor-step-description: "Verifies findings were actually gathered before summarizing."
notor-step-mode: code
notor-step-triggers:
  - synthesize.done
notor-step-publishes:
  - verify.passed
  - CIRCUIT_CANCELLED
notor-step-default-publishes: CIRCUIT_CANCELLED
---

# Verify Findings

Routes to the summarizer only if the scratchpad actually has findings; otherwise cancels
(bypassing completion-task enforcement).

\`\`\`typescript
const findings = await circuit.scratchpad.read("findings.md");
if (!findings || findings.trim().length === 0) {
  return circuit.emit("CIRCUIT_CANCELLED", "No findings were gathered — nothing to summarize.");
}
return circuit.emit("verify.passed", JSON.stringify({ bytes: findings.length }));
\`\`\`
`,
		"summarize.md": `---
notor-type: circuit-step
notor-step-name: "📝 Summarize"
notor-step-description: "Emits the final report as a structured terminal return."
notor-step-mode: code
notor-step-triggers:
  - verify.passed
notor-step-publishes:
  - CIRCUIT_COMPLETE
notor-step-default-publishes: CIRCUIT_COMPLETE
---

# Summarize

Reads the synthesized draft and completes the circuit with a **structured** report — the
reliable-returns path a \`run_circuit\` caller prefers over loose text.

\`\`\`typescript
const draft = (await circuit.scratchpad.read("draft.md")) ?? "";
const findings = (await circuit.scratchpad.read("findings.md")) ?? "";

return circuit.emit("CIRCUIT_COMPLETE", "Research complete.", {
  report: draft,
  findings,
});
\`\`\`
`,
	},
};

// ---------------------------------------------------------------------------
// 3. review — composition demo (run_circuit caller) + a report step
// ---------------------------------------------------------------------------

const REVIEW: ReferenceCircuit = {
	slug: "review",
	definition: `---
notor-type: circuit
notor-circuit-name: "Review"
notor-circuit-description: "Composition demo: dispatch a child circuit via run_circuit, then compose a report."
notor-starting-event: review.start
notor-completion-event: CIRCUIT_COMPLETE
notor-max-iterations: 40
notor-max-runtime-minutes: 120
notor-required-events:
  - dispatch.done
notor-steps:
  - "[[dispatch]]"
  - "[[report]]"
notor-guardrails:
  - "Base the report only on the child circuit's actual returned result."
notor-circuit-invocable: false
notor-max-depth: 3
notor-max-cost-usd: 8.00
---

# Review

Demonstrates **composition** (the \`run_circuit\` caller side). A code-step \`dispatch\`
invokes the \`Code Assist\` circuit via \`run_circuit\` and writes its result to the scratchpad;
a conversation \`report\` step then composes the final review from that result.

Requires \`Code Assist\` to be invocable (it is, by default).

(This body is documentation only.)
`,
	steps: {
		"dispatch.md": `---
notor-type: circuit-step
notor-step-name: "🚚 Dispatch"
notor-step-description: "Invokes the Code Assist child circuit via run_circuit."
notor-step-mode: code
notor-step-triggers:
  - review.start
notor-step-publishes:
  - dispatch.done
notor-step-default-publishes: dispatch.done
---

# Dispatch

Invokes the \`Code Assist\` circuit as a child via \`run_circuit\` (a child session on a child
run-loop), then forwards its result to the report step via the scratchpad.

\`\`\`typescript
// run_circuit is circuit-context-only; here we are inside a circuit step, so it spawns
// a child run. The child's result (structured preferred, else text) comes back as text.
const childResult = await circuit.callTool("run_circuit", {
  circuit: "Code Assist",
  payload: event.payload, // the feature description + repo path forwarded from review.start
});

await circuit.scratchpad.write("child-result.md", childResult);
return circuit.emit("dispatch.done", "Child circuit returned.");
\`\`\`
`,
		"report.md": `---
notor-type: circuit-step
notor-step-name: "🧾 Report"
notor-step-description: "Composes the final review from the child circuit's result."
notor-step-triggers:
  - dispatch.done
notor-step-publishes:
  - CIRCUIT_COMPLETE
notor-step-default-publishes: CIRCUIT_COMPLETE
notor-step-persona: null
---

## REPORT MODE

1. Read \`child-result.md\` from the scratchpad — this is the \`Code Assist\` child circuit's
   returned result.
2. Compose a concise review of what the child circuit accomplished.
3. Emit \`CIRCUIT_COMPLETE\` with your review as the payload.
`,
	},
};

/** The three first-party reference flows (FR-161). */
export const REFERENCE_CIRCUITS: readonly ReferenceCircuit[] = [CODE_ASSIST, RESEARCH, REVIEW];

/** Minimal durable FS surface the materializer needs (vault adapter in production). */
export interface ReferenceCircuitFs {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	write(path: string, data: string): Promise<void>;
}

/** What `materializeReferenceCircuits` did, per slug. */
export interface MaterializeReferenceCircuitsResult {
	/** Slugs with at least one freshly written file under `{notorDir}/circuits/`. */
	written: string[];
	/** Slugs skipped because the user already has them under the legacy `{notorDir}/orchestrations/`. */
	skipped: string[];
}

/**
 * Materialize the reference circuits under `{notorDir}/circuits/` (POL-002).
 * **Idempotent + edit-preserving**: a file that already exists is never
 * overwritten (mirrors the built-in-persona "materialize-on-enable, preserve-user-
 * edits" lifecycle), so re-enabling the feature group is safe. Files added in a
 * later release (the `evals/` notes) are backfilled into an existing circuit dir
 * on the next enable, again without touching anything that already exists.
 *
 * A slug that already exists under the legacy `{notorDir}/orchestrations/` is
 * skipped entirely: seeding it again under `circuits/` would create a second
 * circuit with the same name. `circuits/` itself is only created when at least
 * one slug is seeded.
 */
export async function materializeReferenceCircuits(
	notorDir: string,
	fs: ReferenceCircuitFs,
): Promise<MaterializeReferenceCircuitsResult> {
	const base = notorDir.replace(/\/+$/, "");
	const root = `${base}/circuits`;
	const legacyRoot = `${base}/orchestrations`;
	const written: string[] = [];
	const skipped: string[] = [];

	for (const flow of REFERENCE_CIRCUITS) {
		const flowDir = `${root}/${flow.slug}`;
		const stepsDir = `${flowDir}/steps`;
		try {
			if (await fs.exists(`${legacyRoot}/${flow.slug}`)) {
				skipped.push(flow.slug);
				continue;
			}
			if (!(await fs.exists(root))) await fs.mkdir(root);
			if (!(await fs.exists(flowDir))) await fs.mkdir(flowDir);
			if (!(await fs.exists(stepsDir))) await fs.mkdir(stepsDir);

			const defPath = `${flowDir}/definition.md`;
			let touched = false;
			if (!(await fs.exists(defPath))) {
				await fs.write(defPath, flow.definition);
				touched = true;
			}
			for (const [fileName, body] of Object.entries(flow.steps)) {
				const stepPath = `${stepsDir}/${fileName}`;
				if (!(await fs.exists(stepPath))) {
					await fs.write(stepPath, body);
					touched = true;
				}
			}
			// Evaluator notes follow the same write-if-absent rule, so an install
			// that predates them gets `evals/` backfilled without any other file
			// being rewritten (the user still adds `notor-evaluators` to an edited
			// definition.md by hand — it is never touched).
			if (flow.evals) {
				const evalsDir = `${flowDir}/evals`;
				if (!(await fs.exists(evalsDir))) await fs.mkdir(evalsDir);
				for (const [fileName, body] of Object.entries(flow.evals)) {
					const evalPath = `${evalsDir}/${fileName}`;
					if (!(await fs.exists(evalPath))) {
						await fs.write(evalPath, body);
						touched = true;
					}
				}
			}
			if (touched) written.push(flow.slug);
		} catch (e) {
			log.warn("Failed to materialize reference circuit", { slug: flow.slug, error: String(e) });
		}
	}

	if (written.length > 0 || skipped.length > 0) {
		log.info("Materialized reference circuits", { written, skipped });
	}
	return { written, skipped };
}
